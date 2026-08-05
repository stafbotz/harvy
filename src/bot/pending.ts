/**
 * Menyimpan satu langkah percakapan yang sedang menunggu jawaban pengguna.
 *
 * Dipakai untuk jawaban pendek yang sudah dipilih lewat tombol: konfirmasi,
 * waktu baru, edit memori, dan pengaturan satu check-in.
 *
 * Store ini tetap hanya di memori. Sebagian besar niat sesaat memang sengaja
 * hilang saat restart. Pengecualiannya adalah `agent-input`: adapter memuat
 * ulang mirror ini dari AgentRunService yang mempunyai TTL absolut, ekspor,
 * dan penghapusan sendiri.
 */
import { randomUUID } from "node:crypto";
import type { ExtractedMemory, ExtractedTask } from "../ai/understand.js";
import type { AgentMode } from "../ai/agent.js";
import type { AgentRunCheckpoint } from "../harness/agent-harness.js";

export type Pending =
  | { kind: "confirm-task"; task: ExtractedTask }
  | { kind: "confirm-memory"; memory: ExtractedMemory }
  | { kind: "confirm-memory-wipe" }
  | { kind: "confirm-consent-withdrawal" }
  | { kind: "confirm-full-deletion" }
  | { kind: "edit-due"; taskId: string }
  | { kind: "edit-memory"; memoryId: string }
  | { kind: "set-task-reminder"; taskId: string }
  | { kind: "schedule-checkin"; sessionId: string }
  | {
      kind: "checkin-settings";
      sessionId: string;
      step: "timezone" | "quiet-hours";
    }
  | { kind: "custom-quiet-hours"; sessionId: string | null }
  | {
      kind: "agent-input";
      request: string;
      mode: AgentMode;
      intent: "question" | "request";
      checkpoint: AgentRunCheckpoint;
      /** `null` sebelum record durable pertama dibuat. */
      revision: number | null;
      /** Hanya update Telegram yang masuk sesudah prompt boleh menjawabnya. */
      acceptAnswersAfterUpdateId: number;
    };

interface Entry {
  value: Pending;
  token: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PendingStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  set(ownerId: string, value: Pending): string {
    return this.restore(ownerId, value, this.now() + this.ttlMs)!;
  }

  /** Memulihkan entry dengan expiry absolut tanpa memperpanjang horizon run. */
  restore(ownerId: string, value: Pending, expiresAt: number): string | null {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return null;
    }
    const token = randomUUID().replaceAll("-", "").slice(0, 8);
    this.entries.set(ownerId, {
      value,
      token,
      expiresAt,
    });
    return token;
  }

  /** Membaca tanpa menghapus, agar pengguna boleh mencoba menjawab lagi. */
  peek(ownerId: string): Pending | null {
    const entry = this.entries.get(ownerId);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return null;
    }

    return entry.value;
  }

  /** Mengambil langkah hanya bila tombolnya milik proposal yang masih aktif. */
  take(ownerId: string, token: string): Pending | null {
    const entry = this.entries.get(ownerId);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return null;
    }
    if (entry.token !== token) return null;
    this.entries.delete(ownerId);
    return entry.value;
  }

  clear(ownerId: string): void {
    this.entries.delete(ownerId);
  }
}
