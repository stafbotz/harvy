import { randomUUID } from "node:crypto";
import type {
  ActiveSession,
  DueCheckInSource,
  NewSession,
  SessionRepository,
  SessionSignal,
  SessionStage,
} from "../domain/session.js";

export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GOAL_MAX_CHARS = 240;

export class ActiveSessionError extends Error {
  constructor(readonly session: ActiveSession) {
    super("Masih ada sesi aktif.");
    this.name = "ActiveSessionError";
  }
}

/**
 * Membawa satu tujuan lintas giliran tanpa menyimpan salinan percakapannya.
 *
 * Kata-kata mentah tetap menjadi tanggung jawab `HistoryService`. Sesi hanya
 * menyimpan keadaan operasional yang perlu untuk melanjutkan bantuan.
 */
export class SessionService {
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: SessionRepository,
    private readonly dueCheckInSource: DueCheckInSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: NewSession): Promise<ActiveSession> {
    return this.exclusiveOwner(input.ownerId, async () => {
      const session = await this.prepareStart(input);
      await this.repository.save(session);
      return session;
    });
  }

  /**
   * Membuat sesi hanya sesudah giliran pertamanya benar-benar terkirim.
   *
   * Bila model atau Telegram gagal, tidak ada sesi hantu yang menghalangi
   * percobaan berikutnya.
   */
  async startAfterDelivery(
    input: NewSession,
    deliver: (session: ActiveSession) => Promise<void>,
    compensate?: (session: ActiveSession) => Promise<void>,
  ): Promise<ActiveSession> {
    return this.exclusiveOwner(input.ownerId, async () => {
      const session = await this.prepareStart(input);
      try {
        await deliver(session);
      } catch (deliverError) {
        try {
          await compensate?.(session);
        } catch (compensationError) {
          throw new AggregateError(
            [deliverError, compensationError],
            "Giliran awal sesi gagal dan kompensasinya tidak lengkap.",
          );
        }
        throw deliverError;
      }
      try {
        await this.repository.save(session);
      } catch (saveError) {
        const cleanupErrors: unknown[] = [];
        try {
          // Adapter atomik seharusnya tidak meninggalkan state parsial, tetapi
          // port tidak menjanjikannya. Bersihkan best-effort sebelum UI lama
          // dapat dipakai.
          await this.repository.remove(input.ownerId);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await compensate?.(session);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [saveError, ...cleanupErrors],
            "Sesi gagal disimpan dan kompensasinya tidak lengkap.",
          );
        }
        throw saveError;
      }
      return session;
    });
  }

  async active(ownerId: string): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, () => this.loadActive(ownerId));
  }

  async setStage(
    ownerId: string,
    stage: SessionStage,
    expectedSessionId?: string,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.loadActive(ownerId);
      if (
        !session ||
        (expectedSessionId !== undefined && session.id !== expectedSessionId) ||
        !isStageForKind(session.kind, stage)
      ) {
        return null;
      }

      const updated = this.touch({ ...session, stage });
      await this.repository.save(updated);
      return updated;
    });
  }

  async setStageAfterDelivery(
    ownerId: string,
    stage: SessionStage,
    expectedSessionId: string,
    deliver: (next: ActiveSession) => Promise<void>,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.loadActive(ownerId);
      if (
        !session ||
        session.id !== expectedSessionId ||
        !isStageForKind(session.kind, stage)
      ) {
        return null;
      }

      const updated = this.touch({ ...session, stage });
      await deliver(updated);
      await this.repository.save(updated);
      return updated;
    });
  }

  /**
   * Memajukan alur setelah satu balasan selesai.
   *
   * Sinyal berasal dari keluaran model yang sudah dibaca ketat. `done` dan
   * `cancel` tidak disimpan sebagai status baru: keadaan aktifnya langsung
   * dihapus, sesuai prinsip minimisasi data.
   */
  async progress(
    ownerId: string,
    signal: SessionSignal | null,
    expectedSessionId?: string,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.loadActive(ownerId);
      if (
        !session ||
        (expectedSessionId !== undefined && session.id !== expectedSessionId)
      ) {
        return null;
      }
      if (signal === null) return session;

      if (signal === "done" || signal === "cancel") {
        await this.repository.remove(ownerId);
        return null;
      }

      const stage = nextStage(session, signal);
      const updated = this.touch({ ...session, stage });
      await this.repository.save(updated);
      return updated;
    });
  }

  /**
   * Mengirim tampilan tahap berikutnya sebelum transisinya dikomit.
   *
   * Bila Telegram gagal, sesi tetap pada tahap lama. Ini menghindari keadaan
   * persisten yang melompat sementara pengguna tidak pernah melihat balasannya.
   */
  async progressAfterDelivery(
    ownerId: string,
    signal: SessionSignal | null,
    expectedSessionId: string,
    deliver: (next: ActiveSession | null) => Promise<void>,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.loadActive(ownerId);
      if (!session || session.id !== expectedSessionId) return null;

      if (signal === "done" || signal === "cancel") {
        await deliver(null);
        await this.repository.remove(ownerId);
        return null;
      }

      if (signal === null) {
        await deliver(session);
        return session;
      }

      const updated = this.touch({
        ...session,
        stage: nextStage(session, signal),
      });
      await deliver(updated);
      await this.repository.save(updated);
      return updated;
    });
  }

  async scheduleCheckIn(
    ownerId: string,
    at: Date,
    expectedSessionId?: string,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.loadActive(ownerId);
      if (
        !session ||
        (expectedSessionId !== undefined && session.id !== expectedSessionId) ||
        !Number.isFinite(at.getTime()) ||
        at.getTime() <= this.now().getTime()
      ) {
        return null;
      }

      const expiresAt = new Date(
        Math.max(
          new Date(session.expiresAt).getTime(),
          at.getTime() + 24 * 60 * 60 * 1000,
        ),
      ).toISOString();
      const updated = this.touch(
        {
          ...session,
          checkIn: { at: at.toISOString(), sentAt: null },
          expiresAt,
        },
        false,
      );
      await this.repository.save(updated);
      return updated;
    });
  }

  async dueCheckIns(now = this.now()): Promise<ActiveSession[]> {
    return this.dueCheckInSource.listDueCheckIns(now);
  }

  async markCheckInSent(
    session: ActiveSession,
  ): Promise<ActiveSession | null> {
    return this.exclusiveOwner(session.ownerId, async () => {
      const current = await this.loadActive(session.ownerId);
      if (
        !current ||
        current.id !== session.id ||
        !current.checkIn ||
        current.checkIn.sentAt
      ) {
        return null;
      }

      const updated = this.touch({
        ...current,
        checkIn: {
          ...current.checkIn,
          sentAt: this.now().toISOString(),
        },
      });
      await this.repository.save(updated);
      return updated;
    });
  }

  async deliverCheckIn(
    candidate: ActiveSession,
    deliver: (current: ActiveSession) => Promise<void>,
  ): Promise<boolean> {
    return this.exclusiveOwner(candidate.ownerId, async () => {
      const current = await this.repository.load(candidate.ownerId);
      if (
        !current ||
        !isFuture(new Date(current.expiresAt), this.now()) ||
        current.id !== candidate.id ||
        !current.checkIn ||
        current.checkIn.sentAt !== null ||
        current.checkIn.at !== candidate.checkIn?.at
      ) {
        return false;
      }

      await deliver(current);
      await this.repository.save({
        ...current,
        checkIn: {
          ...current.checkIn,
          sentAt: this.now().toISOString(),
        },
      });
      return true;
    });
  }

  async stop(ownerId: string): Promise<ActiveSession | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const session = await this.repository.load(ownerId);
      if (!session) return null;
      return (await this.repository.remove(ownerId)) ? session : null;
    });
  }

  async forget(ownerId: string): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      await this.repository.remove(ownerId);
    });
  }

  private async prepareStart(input: NewSession): Promise<ActiveSession> {
    const goal = cleanGoal(input.goal);
    if (!goal) throw new Error("Tujuan sesi tidak boleh kosong.");

    const existing = await this.loadActive(input.ownerId);
    if (existing) throw new ActiveSessionError(existing);

    const now = this.now();
    return {
      id: randomUUID().replaceAll("-", "").slice(0, 10),
      ownerId: input.ownerId,
      chatId: input.chatId,
      kind: input.kind,
      goal,
      stage: firstStage(input.kind),
      taskId: input.taskId ?? null,
      checkIn: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString(),
    };
  }

  private touch(
    session: ActiveSession,
    renewExpiry = true,
  ): ActiveSession {
    const now = this.now();
    return {
      ...session,
      updatedAt: now.toISOString(),
      expiresAt: renewExpiry
        ? new Date(now.getTime() + SESSION_IDLE_TTL_MS).toISOString()
        : session.expiresAt,
    };
  }

  private async loadActive(ownerId: string): Promise<ActiveSession | null> {
    const session = await this.repository.load(ownerId);
    if (!session) return null;

    if (!isFuture(new Date(session.expiresAt), this.now())) {
      await this.repository.remove(ownerId);
      return null;
    }
    return session;
  }

  private async exclusiveOwner<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerQueues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.ownerQueues.get(ownerId) === settled) {
        this.ownerQueues.delete(ownerId);
      }
    }
  }
}

function isFuture(value: Date, now: Date): boolean {
  return Number.isFinite(value.getTime()) && value.getTime() > now.getTime();
}

function cleanGoal(goal: string): string {
  return goal.trim().replaceAll(/\s+/g, " ").slice(0, GOAL_MAX_CHARS);
}

function firstStage(kind: ActiveSession["kind"]): SessionStage {
  switch (kind) {
    case "tutor":
      return "assess";
    case "clarify":
      return "collect";
    case "prioritize":
    case "plan":
      return "choose";
    case "focus":
      return "act";
    case "human-bridge":
      return "draft";
  }
}

function nextStage(
  session: ActiveSession,
  signal: SessionSignal | null,
): SessionStage {
  if (session.kind === "tutor") {
    if (signal === "stuck") {
      if (session.stage === "hint") return "explain";
      if (session.stage === "explain" || session.stage === "retry") {
        return "retry";
      }
      return "hint";
    }

    switch (session.stage) {
      case "assess":
        return "attempt";
      case "attempt":
        return "hint";
      case "hint":
        return "explain";
      case "explain":
        return "retry";
      case "retry":
        return "retry";
      default:
        return "assess";
    }
  }

  if (signal === "stuck") return "reflect";

  switch (session.kind) {
    case "clarify":
      return session.stage === "collect" ? "choose" : "act";
    case "prioritize":
    case "plan":
      return session.stage === "choose" ? "act" : "reflect";
    case "focus":
      return session.stage === "act" ? "reflect" : "act";
    case "human-bridge":
      return "draft";
  }
}

function isStageForKind(
  kind: ActiveSession["kind"],
  stage: SessionStage,
): boolean {
  switch (kind) {
    case "tutor":
      return (
        stage === "assess" ||
        stage === "attempt" ||
        stage === "hint" ||
        stage === "explain" ||
        stage === "retry"
      );
    case "clarify":
      return stage === "collect" || stage === "choose" || stage === "act";
    case "prioritize":
    case "plan":
      return stage === "choose" || stage === "act" || stage === "reflect";
    case "focus":
      return stage === "act" || stage === "reflect";
    case "human-bridge":
      return stage === "draft";
  }
}
