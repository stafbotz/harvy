import type { ScheduledDeliveryAttempt } from "./scheduled-delivery.js";

/**
 * Satu pekerjaan yang sedang dibawa Harvy lintas giliran.
 *
 * Hanya satu sesi boleh aktif per pengguna. Daftar tugas tetap dapat berisi
 * banyak hal, tetapi Harvy tidak ikut menambah keruwetan dengan mendorong
 * beberapa proses sekaligus.
 */
export type SessionKind =
  | "clarify"
  | "prioritize"
  | "focus"
  | "tutor"
  | "plan"
  | "human-bridge";

export type TutorStage =
  | "assess"
  | "attempt"
  | "hint"
  | "explain"
  | "retry";

export type SessionStage =
  | TutorStage
  | "collect"
  | "choose"
  | "act"
  | "reflect"
  | "draft";

export type SessionSignal = "continue" | "stuck" | "done" | "cancel";

export interface SessionCheckIn {
  /** Waktu yang dipilih pengguna, ISO UTC. */
  at: string;
  /** Terisi setelah pesan benar-benar dikirim. */
  sentAt: string | null;
  /** Fence durable agar crash pada batas send tidak membuat check-in ganda. */
  delivery?: ScheduledDeliveryAttempt | null;
}

export interface ActiveSession {
  id: string;
  ownerId: string;
  chatId: string;
  kind: SessionKind;
  /** Tujuan pendek yang dapat dilihat dan dikoreksi pengguna. */
  goal: string;
  stage: SessionStage;
  /** Tugas yang sedang dikerjakan, bila sesi dimulai dari kartu tugas. */
  taskId: string | null;
  checkIn: SessionCheckIn | null;
  createdAt: string;
  updatedAt: string;
  /** Sesi yang lama tidak disentuh ditutup agar keadaan tidak menggantung. */
  expiresAt: string;
}

export interface NewSession {
  ownerId: string;
  chatId: string;
  kind: SessionKind;
  goal: string;
  taskId?: string | null;
}

export interface SessionRepository {
  load(ownerId: string): Promise<ActiveSession | null>;
  save(session: ActiveSession): Promise<void>;
  remove(ownerId: string): Promise<boolean>;
}

/** Port sistem yang hanya dipakai composition root dan worker check-in. */
export interface DueCheckInSource {
  listDueCheckIns(now: Date): Promise<ActiveSession[]>;
}
