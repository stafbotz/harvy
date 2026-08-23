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
import type { DurableAgentRunExport } from "../domain/agent-run.js";
import type { AgentRunService } from "./agent-run-service.js";
import type { MemoryKnowledgeState } from "../domain/memory-knowledge.js";
import type { MemoryKnowledgeService } from "./memory-knowledge-service.js";
import type { LongTermMemorySnapshot } from "../domain/long-term-memory.js";
import type { LongTermMemoryService } from "./long-term-memory-service.js";

export interface UserDataExport {
  version: 4;
  exportedAt: string;
  ownerId: string;
  profile: UserProfile;
  tasks: StudentTask[];
  memories: MemoryItem[];
  /** Index semantic/graph turunan beserta provenance dan suppression hashes. */
  derivedMemory: MemoryKnowledgeState | null;
  history: ConversationHistory | null;
  /** Cold archive terpisah dari hot history; tidak otomatis masuk context. */
  archivedHistory: import("../domain/history.js").ConversationEpisode[];
  /** User model, procedures, lessons, candidates, dan metadata outbox. */
  learnedMemory: LongTermMemorySnapshot | null;
  activeSession: ActiveSession | null;
  /** Record run terbaru yang masih diretensi; null bila tidak ada/expired. */
  activeAgentRun: DurableAgentRunExport | null;
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
    private readonly agentRuns: AgentRunService | null = null,
    private readonly knowledge: MemoryKnowledgeService | null = null,
    private readonly longTerm: LongTermMemoryService | null = null,
  ) {}

  async export(ownerId: string): Promise<UserDataExport> {
    const [
      profile,
      tasks,
      memories,
      derivedMemory,
      history,
      archivedHistory,
      learnedMemory,
      activeSession,
      activeAgentRun,
      aiUsageLast24Hours,
      aiTelemetryRetained,
    ] = await Promise.all([
      this.profiles.load(ownerId),
      this.tasks.listAll(ownerId),
      this.memories.list(ownerId),
      this.knowledge?.snapshotPrivateOwner(ownerId) ?? Promise.resolve(null),
      this.history.snapshot(ownerId),
      this.history.archiveSnapshot(ownerId),
      this.longTerm?.snapshotPrivateOwner(ownerId) ?? Promise.resolve(null),
      this.sessions.active(ownerId),
      this.agentRuns?.export(privateOwnerChannel(ownerId), ownerId) ??
        Promise.resolve(null),
      this.telemetry.summary(ownerId),
      this.telemetry.export(ownerId),
    ]);

    return {
      version: 4,
      exportedAt: this.now().toISOString(),
      ownerId,
      profile,
      tasks,
      memories,
      derivedMemory,
      history,
      archivedHistory,
      learnedMemory,
      activeSession,
      activeAgentRun,
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

    // Derived semantic/graph work harus tertutup sebelum store sumber mulai
    // dibersihkan. Tombstone profil tetap authority lintas restart; block ini
    // menutup completion lokal yang sudah terlanjur berjalan.
    this.memories.suspend(ownerId);
    this.history.suspend(ownerId);
    this.longTerm?.suspendPrivateOwner(ownerId);

    // Urutan ini idempoten. Profil/tombstone sengaja terakhir.
    // Telemetry diblokir lebih dulu karena ia juga menjadi gerbang tepat
    // sebelum panggilan model. Dengan begitu pekerjaan latar yang terlambat
    // tidak dapat mengirim data lagi sesudah penghapusan dimulai.
    await this.telemetry.forget(ownerId);
    await this.agentRuns?.forget(privateOwnerChannel(ownerId), ownerId);
    await this.sessions.forget(ownerId);
    await this.tasks.removeAll(ownerId);
    await this.history.forget(ownerId, true);
    await this.longTerm?.forgetPrivateOwner(ownerId);
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

function privateOwnerChannel(ownerId: string): "telegram" | "whatsapp" {
  return ownerId.startsWith("whatsapp-user:") ? "whatsapp" : "telegram";
}
