import type {
  AgentObservation,
  AgentRunCheckpoint,
  AgentUserInput,
} from "../harness/agent-harness.js";
import type { AgentChannel } from "../harness/scope.js";

/** Planner profile yang wajib tetap sama ketika checkpoint dilanjutkan. */
export type DurableAgentMode = "tools" | "orchestrate";

/** Intent operasional yang membentuk prompt root agent. */
export type DurableAgentIntent = "question" | "request";

/**
 * Vertical slice durable pertama hanya menyimpan run yang menunggu jawaban.
 * Run aktif tetap sinkron dan seluruh tool yang dapat dipanggil masih read-only.
 */
export interface DurableAgentRun {
  version: 1;
  scopeKey: string;
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  request: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  /** Update Telegram terbaru yang sudah masuk ketika prompt berhasil dikirim. */
  acceptAnswersAfterUpdateId: number;
  status: "waiting_input";
  checkpoint: AgentRunCheckpoint;
  /** CAS per scope; handler lama tidak boleh menimpa checkpoint lebih baru. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Sama dengan horizon absolut checkpoint, bukan TTL baru saat restart. */
  expiresAt: string;
}

/**
 * Bentuk user-facing untuk ekspor data. Snapshot authority, capability hash,
 * harga provider, dan limit anti-abuse sengaja tidak keluar dari trust domain.
 */
export interface DurableAgentRunExport {
  version: 1;
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  request: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  status: "waiting_input";
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  progress: {
    step: number;
    observations: AgentObservation[];
    userInputs: AgentUserInput[];
    pendingInput: { step: number; prompt: string } | null;
  };
  budget: {
    consumedTokens: number;
    consumedCostUsdNanos: string;
    modelCalls: number;
    toolCalls: number;
    unknownUsageAttempts: number;
    activeElapsedMs: number;
  } | null;
}

export type NewDurableAgentRun = Omit<DurableAgentRun, "revision">;

export type AgentRunSaveResult =
  | { status: "saved"; run: DurableAgentRun }
  | { status: "conflict" };

export type AgentRunRemoveResult = "removed" | "missing" | "conflict";

/** Port penyimpanan checkpoint; adapter file saat ini tetap satu proses. */
export interface AgentRunRepository {
  load(scopeKey: string): Promise<DurableAgentRun | null>;
  save(
    run: NewDurableAgentRun,
    expectedRevision: number | null,
  ): Promise<AgentRunSaveResult>;
  remove(
    scopeKey: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<AgentRunRemoveResult>;
  removeOwner(channel: AgentChannel, ownerId: string): Promise<number>;
  removeExpired(now: Date): Promise<number>;
}
