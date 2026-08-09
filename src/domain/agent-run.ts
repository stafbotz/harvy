import type {
  AgentObservation,
  AgentRunCheckpoint,
  AgentUserInput,
} from "../harness/agent-harness.js";
import type { AgentChannel } from "../harness/scope.js";
import type { MemoryKind } from "./memory.js";
import type { TurnRole } from "./history.js";
import type { StylePreference } from "./profile.js";

/** Planner profile yang wajib tetap sama ketika checkpoint dilanjutkan. */
export type DurableAgentMode = "tools" | "orchestrate";

/** Intent operasional yang membentuk prompt root agent. */
export type DurableAgentIntent = "question" | "request";

/**
 * Bentuk v1 dipertahankan untuk checkpoint waiting_input yang ditulis sebelum
 * work lane v2. Run aktif baru memakai ActiveAgentRun di bawah.
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
export interface WaitingAgentRunExport {
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

/** Lifecycle durable untuk work lane; checkpoint v1 di atas tetap dibaca. */
export type ActiveAgentRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

/** Fase user-facing berasal dari event runtime, bukan tebakan model. */
export type ActiveAgentRunPhase =
  | "queued"
  | "reading_context"
  | "planning"
  | "replanning"
  | "checking"
  | "waiting_input"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunContextSnapshot {
  summary: string | null;
  turns: Array<{ role: TurnRole; text: string; at: string }>;
  memories: Array<{ id: string; kind: MemoryKind; content: string }>;
}

export type RunMailboxMessageKind =
  | "constraint"
  | "correction"
  | "scope_change"
  | "answer"
  | "cancel";

export interface RunMailboxMessage {
  id: string;
  runId: string;
  kind: RunMailboxMessageKind;
  content: string;
  sourceMessageId: string;
  receivedAt: string;
  questionId: string | null;
}

export type RunChangeSetKind =
  | "constraint"
  | "correction"
  | "answer"
  | "scope_addition"
  | "cancel";

export interface RunChangeSet {
  revision: number;
  kind: RunChangeSetKind;
  sourceMessageId: string;
  affectedWorkUnits: string[];
  receivedAt: string;
}

export interface AgentRunWorkUnit {
  id: string;
  role:
    | "research"
    | "schedule_scan"
    | "constraint_check"
    | "planner"
    | "critic";
  label: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "completed"
    | "stale"
    | "failed";
  inputRevision: number;
  resultSummary?: string;
}

export type ActiveAgentRunEventType =
  | "run.started"
  | "context.started"
  | "context.completed"
  | "planning.started"
  | "planning.completed"
  | "replanning.started"
  | "input.required"
  | "input.received"
  | "finalizing.started"
  | "run.completed"
  | "run.cancelled"
  | "run.failed";

export interface ActiveAgentRunEvent {
  id: string;
  type: ActiveAgentRunEventType;
  at: string;
  inputRevision: number;
  workUnitId: string | null;
}

export interface AgentRunAnchor {
  platform: "telegram";
  chatId: string;
  messageId: string | null;
  updatedAt: string;
}

export interface ActiveAgentRunQuestion {
  questionId: string;
  prompt: string;
  askedAt: string;
  expiresAt: string;
  acceptAnswersAfterUpdateId: number;
  messageId: string | null;
}

export interface ActiveAgentRunAnswer {
  questionId: string;
  sourceMessageId: string;
  text: string;
  receivedAt: string;
}

export type AgentRunEffectPurpose = "question" | "final";

/** Intent efek yang dipersistenkan sebelum I/O eksternal. */
export interface PendingAgentRunEffect {
  effectId: string;
  purpose: AgentRunEffectPurpose;
  instructionRevision: number;
  preparedAt: string;
}

/** Bukti efek eksternal; idempotency secret internal tidak diekspor. */
export interface AgentRunEffectReceipt {
  receiptId: string;
  effectId: string;
  effect: "telegram.message.send";
  purpose: AgentRunEffectPurpose;
  instructionRevision: number;
  status: "committed" | "unknown";
  externalId: string | null;
  committedAt: string;
  reversible: false;
}

export interface ActiveAgentRunResultSnapshot {
  kind: "final" | "partial";
  text: string;
  instructionRevision: number;
  completedAt: string;
}

export interface ActiveAgentRunError {
  stage: "planning" | "checkpoint" | "delivery" | "recovery";
  code: string;
  at: string;
}

/**
 * Active run v2 menyimpan snapshot transaksi dan mailbox eksplisit. Provider
 * transcript/reasoning tidak pernah masuk record ini.
 */
export interface ActiveAgentRun {
  version: 2;
  scopeKey: string;
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  initialRequest: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  timeZone: string;
  style: StylePreference | null;
  status: ActiveAgentRunStatus;
  phase: ActiveAgentRunPhase;
  contextRevision: number;
  instructionRevision: number;
  appliedInstructionRevision: number;
  /** CAS record; progress event tidak mengubah instructionRevision. */
  revision: number;
  context: AgentRunContextSnapshot;
  mailbox: RunMailboxMessage[];
  changeSets: RunChangeSet[];
  workUnits: AgentRunWorkUnit[];
  events: ActiveAgentRunEvent[];
  receipts: AgentRunEffectReceipt[];
  anchor: AgentRunAnchor;
  checkpoint: AgentRunCheckpoint | null;
  pendingQuestion: ActiveAgentRunQuestion | null;
  resumeAnswer: ActiveAgentRunAnswer | null;
  pendingEffect: PendingAgentRunEffect | null;
  result: ActiveAgentRunResultSnapshot | null;
  lastError: ActiveAgentRunError | null;
  turnId: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
}

export type NewActiveAgentRun = Omit<ActiveAgentRun, "revision">;

export type ActiveAgentRunSaveResult =
  | { status: "saved"; run: ActiveAgentRun }
  | { status: "conflict" };

export interface ActiveAgentRunExport {
  version: 2;
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  request: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  status: ActiveAgentRunStatus;
  revision: number;
  contextRevision: number;
  instructionRevision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  progress: {
    step: number;
    observations: AgentObservation[];
    userInputs: AgentUserInput[];
    pendingInput: { step: number; prompt: string } | null;
  };
  budget: WaitingAgentRunExport["budget"];
  mailbox: Array<Omit<RunMailboxMessage, "id" | "runId" | "questionId">>;
  changes: RunChangeSet[];
  workUnits: AgentRunWorkUnit[];
  receipts: Array<Omit<AgentRunEffectReceipt, "effectId">>;
  result: ActiveAgentRunResultSnapshot | null;
}

export type DurableAgentRunExport =
  | WaitingAgentRunExport
  | ActiveAgentRunExport;

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
  /** Optional agar adapter/stub checkpoint v1 lama tetap kompatibel. */
  loadActive?(scopeKey: string): Promise<ActiveAgentRun | null>;
  loadActiveByRunId?(runId: string): Promise<ActiveAgentRun | null>;
  listActive?(channel?: AgentChannel): Promise<ActiveAgentRun[]>;
  saveActive?(
    run: NewActiveAgentRun,
    expectedRevision: number | null,
  ): Promise<ActiveAgentRunSaveResult>;
  removeActive?(
    scopeKey: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<AgentRunRemoveResult>;
}
