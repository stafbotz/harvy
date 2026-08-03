import type { HistoryService } from "./history-service.js";
import type { InsightService } from "./insight-service.js";
import type { MemoryService } from "./memory-service.js";
import type { ProfileService } from "./profile-service.js";
import type { SessionService } from "./session-service.js";
import type { TaskService } from "./task-service.js";
import type {
  TelemetryService,
  TelemetryExport,
  UsageSummary,
} from "./telemetry-service.js";
import type { ActiveSession } from "../domain/session.js";
import type { ConversationHistory } from "../domain/history.js";
import type { MemoryItem } from "../domain/memory.js";
import type { UserProfile } from "../domain/profile.js";
import type { StudentTask } from "../domain/task.js";

export interface UserDataExport {
  version: 1;
  exportedAt: string;
  ownerId: string;
  profile: UserProfile;
  tasks: StudentTask[];
  memories: MemoryItem[];
  history: ConversationHistory | null;
  activeSession: ActiveSession | null;
  aiUsageLast24Hours: UsageSummary;
  aiTelemetryRetained: TelemetryExport;
  hiddenSafetyData: {
    included: false;
    reason: string;
  };
}

/**
 * Satu pintu untuk hak ekspor dan penghapusan seluruh data.
 *
 * Penghapusan lintas beberapa berkas tidak dapat menjadi transaksi sungguhan.
 * Karena itu profil diberi tombstone lebih dulu dan dihapus paling akhir.
 * Kalau proses mati di tengah, composition root dapat melanjutkan permintaan
 * yang tersisa saat start berikutnya.
 */
export class DataControlService {
  constructor(
    private readonly tasks: TaskService,
    private readonly memories: MemoryService,
    private readonly history: HistoryService,
    private readonly profiles: ProfileService,
    private readonly insights: InsightService,
    private readonly sessions: SessionService,
    private readonly telemetry: TelemetryService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async export(ownerId: string): Promise<UserDataExport> {
    const [
      profile,
      tasks,
      memories,
      history,
      activeSession,
      aiUsageLast24Hours,
      aiTelemetryRetained,
    ] = await Promise.all([
      this.profiles.load(ownerId),
      this.tasks.listAll(ownerId),
      this.memories.list(ownerId),
      this.history.snapshot(ownerId),
      this.sessions.active(ownerId),
      this.telemetry.summary(ownerId),
      this.telemetry.export(ownerId),
    ]);

    return {
      version: 1,
      exportedAt: this.now().toISOString(),
      ownerId,
      profile,
      tasks,
      memories,
      history,
      activeSession,
      aiUsageLast24Hours,
      aiTelemetryRetained,
      hiddenSafetyData: {
        included: false,
        reason:
          "Catatan keselamatan tersembunyi tidak ditampilkan menurut Konstitusi Harvy v0.3 Pasal 4 nomor 6, tetapi tetap ikut dihapus bila seluruh data dihapus.",
      },
    };
  }

  async deleteAll(ownerId: string): Promise<void> {
    await this.profiles.markDeletionRequested(ownerId);

    // Urutan ini idempoten. Profil/tombstone sengaja terakhir.
    // Telemetry diblokir lebih dulu karena ia juga menjadi gerbang tepat
    // sebelum panggilan model. Dengan begitu pekerjaan latar yang terlambat
    // tidak dapat mengirim data lagi sesudah penghapusan dimulai.
    await this.telemetry.forget(ownerId);
    await this.sessions.forget(ownerId);
    await this.tasks.removeAll(ownerId);
    await this.history.forget(ownerId, true);
    await this.insights.forget(ownerId);
    await this.memories.forgetAll(ownerId);
    await this.profiles.remove(ownerId);
  }

  async resumePendingDeletions(): Promise<void> {
    const pending = await this.profiles.deletionRequests();
    const failures: unknown[] = [];
    for (const profile of pending) {
      try {
        await this.deleteAll(profile.ownerId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} penghapusan data belum dapat diselesaikan.`,
      );
    }
  }
}
