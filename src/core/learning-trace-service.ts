import { randomUUID } from "node:crypto";
import type {
  LearningTrace,
  LearningTraceRepository,
  ScaffoldDepth,
} from "../domain/learning-trace.js";
import type { ActiveSession, SessionStage } from "../domain/session.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/** Berapa banyak jejak yang disimpan per pengguna sebelum yang terlama dibuang. */
export const LEARNING_TRACE_LIMIT = 60;

/** Panjang maksimum topik yang disimpan. */
export const LEARNING_TRACE_TOPIC_MAX_CHARACTERS = 160;

/**
 * Kedalaman bantuan dari tahap terdalam yang dicapai sesi.
 *
 * Tangga tutor bergerak satu arah—`assess → attempt → hint → explain → retry`,
 * dan `stuck` hanya melompat lebih dalam—sehingga tahap saat sesi selesai
 * memang tahap terdalamnya. Tidak ada state tambahan yang perlu disimpan
 * sepanjang sesi berjalan.
 */
export function scaffoldDepthOf(stage: SessionStage): ScaffoldDepth {
  switch (stage) {
    case "assess":
    case "attempt":
      return "mandiri";
    case "hint":
      return "berpetunjuk";
    default:
      return "dijelaskan";
  }
}

/**
 * Mencatat apa yang sudah pernah diselesaikan seorang pelajar.
 *
 * Hanya sesi `tutor`. Kind lain—`clarify`, `prioritize`, `focus`, `plan`,
 * `human-bridge`—bukan pemerolehan kemampuan, dan tahapnya bukan tangga
 * kedalaman: mencatatnya akan menghasilkan angka yang terlihat berarti padahal
 * tidak. Pasal 4 konstitusi berbicara tentang pola bantuan **belajar**, dan
 * itulah batas berkas ini.
 *
 * Best-effort: kegagalan mencatat tidak boleh menahan penutupan sesi. Yang
 * hilang hanya satu titik data, bukan giliran penggunanya.
 */
export class LearningTraceService {
  constructor(
    private readonly repository: LearningTraceRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.learning-trace"),
  ) {}

  /**
   * Mencatat satu sesi tutor yang benar-benar selesai.
   *
   * Dipanggil hanya untuk sinyal `done`. Sesi yang dibatalkan tidak dicatat:
   * membatalkan bukan menyelesaikan, dan menghitungnya sebagai kemajuan akan
   * membuat Harvy mundur dari bantuan justru ketika pelajarnya menyerah.
   */
  async recordCompleted(session: ActiveSession): Promise<void> {
    if (session.kind !== "tutor") return;
    const topic = session.goal.trim().replaceAll(/\s+/gu, " ");
    if (!topic) return;

    const trace: LearningTrace = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      ownerId: session.ownerId,
      kind: session.kind,
      topic: topic.length > LEARNING_TRACE_TOPIC_MAX_CHARACTERS
        ? topic.slice(0, LEARNING_TRACE_TOPIC_MAX_CHARACTERS)
        : topic,
      depth: scaffoldDepthOf(session.stage),
      deepestStage: session.stage,
      completedAt: this.now().toISOString(),
    };
    try {
      await this.repository.save(trace);
    } catch (error) {
      this.logger.warn(
        "learning_trace_record_failed",
        "Jejak sesi belajar gagal dicatat.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  async list(ownerId: string): Promise<LearningTrace[]> {
    try {
      return await this.repository.list(ownerId);
    } catch {
      return [];
    }
  }

  async forgetOwner(ownerId: string): Promise<number> {
    try {
      return await this.repository.removeAll(ownerId);
    } catch (error) {
      this.logger.warn(
        "learning_trace_delete_failed",
        "Jejak sesi belajar gagal dihapus bersama data pengguna.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return 0;
    }
  }
}
