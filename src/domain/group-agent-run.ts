import { createHash } from "node:crypto";
import type { RunBudgetCheckpoint } from "../core/run-budget.js";
import type { GroupScope } from "./group.js";

export type GroupAgentRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "paused"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type GroupAgentRunPhase =
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

/** Identitas tetap lokal pada satu ruang; bukan principal lintas kanal/grup. */
export interface GroupRunParticipant {
  participantId: string;
  identityAliases: string[];
  displayName: string | null;
}

export interface GroupRunAudience {
  kind: "group";
  visibility: "group-safe";
  scopeKey: string;
}

export interface GroupRunAnchor {
  platform: "whatsapp";
  messageId: string | null;
  /** V1 tidak pernah memakai shared pin tanpa pilihan eksplisit grup/admin. */
  pinPolicy: "manual-only";
  updatedAt: string;
}

export type GroupRunDeliveryPurpose =
  | "anchor"
  | "assigned_question"
  | "final_result";

export interface PendingGroupRunQuestion {
  questionId: string;
  prompt: string;
  assignee: GroupRunParticipant;
  expiresAt: string;
}

export interface GroupRunDeliveryAuthority {
  initiatorRole: "member" | "admin";
  assigneeRole: "member" | "admin" | null;
  authorityEpoch: number;
}

/** Intent efek yang wajib durable sebelum transport WhatsApp dipanggil. */
export interface PendingGroupRunDelivery {
  effectId: string;
  purpose: GroupRunDeliveryPurpose;
  instructionRevision: number;
  preparedStateRevision: number;
  contentDigest: string;
  question: PendingGroupRunQuestion | null;
  /** Exact attempt untuk work-question/final; null untuk anchor/legacy question. */
  workAttemptId?: string | null;
  authority: GroupRunDeliveryAuthority;
  preparedAt: string;
}

/** Receipt append-only; `unknown` tidak pernah aman untuk dikirim ulang. */
export interface GroupRunDeliveryReceipt {
  receiptId: string;
  effectId: string;
  effect: "whatsapp.message.send";
  purpose: GroupRunDeliveryPurpose;
  instructionRevision: number;
  preparedStateRevision: number;
  contentDigest: string;
  subjectId: string | null;
  /** Attempt exact untuk work-question/final; null untuk anchor/legacy question. */
  workAttemptId?: string | null;
  authority: GroupRunDeliveryAuthority;
  status: "committed" | "unknown" | "not_committed";
  externalMessageId: string | null;
  committedAt: string;
  reversible: false;
}

export type GroupRunInputKind =
  | "self_info"
  | "constraint"
  | "correction"
  | "scope_change"
  | "answer"
  | "cancel";

export type GroupRunInputDisposition = "applied" | "proposal";

/**
 * Semua input menyimpan sumber dan aktor. Proposal anggota tetap terlihat pada
 * ledger, tetapi tidak menaikkan instruction revision sampai diotorisasi.
 */
export interface GroupRunInput {
  id: string;
  sourceMessageId: string;
  sourceIngressRevision: number | null;
  actor: GroupRunParticipant;
  quotedMessageId: string | null;
  kind: GroupRunInputKind;
  disposition: GroupRunInputDisposition;
  content: string;
  questionId: string | null;
  assignedOverride: boolean;
  authorityRole: "member" | "admin";
  authorityEpoch: number;
  instructionRevision: number | null;
  receivedAt: string;
}

export interface GroupRunChangeSet {
  instructionRevision: number;
  kind: Exclude<GroupRunInputKind, "self_info"> | "self_info";
  sourceMessageId: string;
  actorParticipantId: string;
  receivedAt: string;
}

export type GroupRunWorkAttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "requeued"
  | "cancelled";

/**
 * Ledger eksekusi code-owned. Ia sengaja tidak menyimpan prompt, output model,
 * progress bebas, atau ETA; hanya claim dan hasil lifecycle yang dapat diaudit.
 */
export interface GroupRunWorkAttempt {
  attemptId: string;
  claimKey: string;
  attemptNumber: number;
  instructionRevision: number;
  claimedStateRevision: number;
  status: GroupRunWorkAttemptStatus;
  startedAt: string;
  settledAt: string | null;
  code: string | null;
}

/**
 * Checkpoint group-safe tidak menyimpan prompt provider, transcript, output
 * model, atau final reply. Digest mengikatnya ke prefix input durable grup.
 */
export interface GroupRunExecutionCheckpoint {
  version: 1;
  engine: "group-model-v1";
  attemptId: string;
  sequence: number;
  instructionRevision: number;
  inputDigest: string;
  waitingQuestionId: string | null;
  budget: RunBudgetCheckpoint;
  updatedAt: string;
}

/** Hasil canonical yang hanya lahir bersama receipt final committed. */
export interface GroupRunFinalResult {
  kind: "final";
  text: string;
  contentDigest: string;
  instructionRevision: number;
  attemptId: string;
  messageId: string;
  committedAt: string;
}

export interface GroupRunQuestion {
  questionId: string;
  prompt: string;
  assignee: GroupRunParticipant;
  messageId: string;
  acceptAnswersAfterIngressRevision: number;
  status: "open" | "answered" | "expired" | "cancelled";
  askedAt: string;
  expiresAt: string;
  answeredBy: GroupRunParticipant | null;
  answerSourceMessageId: string | null;
  answeredAt: string | null;
}

export type GroupAgentRunEventType =
  | "run.started"
  | "run.completed"
  | "work.claimed"
  | "work.completed"
  | "work.failed"
  | "work.requeued"
  | "work.recovered"
  | "delivery.prepared"
  | "delivery.unknown"
  | "delivery.not_committed"
  | "anchor.attached"
  | "input.proposed"
  | "input.applied"
  | "input.required"
  | "input.received"
  | "input.expired"
  | "run.expired"
  | "run.cancelled";

export interface GroupAgentRunEvent {
  id: string;
  type: GroupAgentRunEventType;
  at: string;
  instructionRevision: number;
  sourceMessageId: string | null;
  participantId: string | null;
}

/**
 * Aggregate Phase K awal. Tidak ada private memory/context snapshot pada
 * bentuk ini; audience dan provenance selalu terikat ke satu ruang grup.
 */
export interface GroupAgentRun {
  version: 2;
  runId: string;
  scopeKey: string;
  scope: GroupScope;
  accountId: string;
  startSourceMessageId: string;
  initialRequest: string;
  title: string;
  initiator: GroupRunParticipant;
  startAuthority: {
    role: "member" | "admin";
    authorityEpoch: number;
  };
  participants: GroupRunParticipant[];
  audience: GroupRunAudience;
  status: GroupAgentRunStatus;
  phase: GroupAgentRunPhase;
  instructionRevision: number;
  appliedInstructionRevision: number;
  stateRevision: number;
  anchor: GroupRunAnchor;
  pendingEffect: PendingGroupRunDelivery | null;
  receipts: GroupRunDeliveryReceipt[];
  inputs: GroupRunInput[];
  changeSets: GroupRunChangeSet[];
  /**
   * Optional hanya agar object v2 lama dapat dibaca/dibentuk secara source
   * compatible. Repository selalu menormalisasikannya menjadi array canonical.
   */
  workAttempts?: GroupRunWorkAttempt[];
  /** Optional hanya untuk migrasi record v2 sebelum checkpoint Phase K. */
  checkpoint?: GroupRunExecutionCheckpoint | null;
  /** Optional untuk source compatibility; repository menormalisasi null. */
  result?: GroupRunFinalResult | null;
  questions: GroupRunQuestion[];
  events: GroupAgentRunEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
}

/**
 * Digest canonical untuk request awal dan prefix input applied 1..revision.
 * Seluruh provenance berasal dari ledger durable; proposal tidak ikut sampai
 * benar-benar diterapkan sebagai instruction revision.
 */
export function groupRunExecutionInputDigest(
  run: Pick<
    GroupAgentRun,
    | "startSourceMessageId"
    | "initialRequest"
    | "initiator"
    | "instructionRevision"
    | "inputs"
    | "changeSets"
  >,
  instructionRevision: number = run.instructionRevision,
): string {
  if (
    !Number.isSafeInteger(instructionRevision) || instructionRevision < 0 ||
    instructionRevision > run.instructionRevision
  ) throw new Error("Revision digest input GroupAgentRun tidak sah.");
  const applied = run.inputs
    .filter((input) =>
      input.disposition === "applied" && input.instructionRevision !== null &&
      input.instructionRevision <= instructionRevision
    )
    .sort((left, right) =>
      (left.instructionRevision ?? 0) - (right.instructionRevision ?? 0)
    );
  if (applied.length !== instructionRevision) {
    throw new Error("Prefix input applied GroupAgentRun tidak lengkap.");
  }
  const canonicalApplied = applied.map((input, index) => {
    const revision = index + 1;
    const change = run.changeSets[index];
    if (
      input.instructionRevision !== revision ||
      change?.instructionRevision !== revision ||
      change.sourceMessageId !== input.sourceMessageId ||
      change.actorParticipantId !== input.actor.participantId ||
      change.kind !== input.kind || change.receivedAt !== input.receivedAt
    ) throw new Error("Provenance input applied GroupAgentRun tidak canonical.");
    return {
      instructionRevision: revision,
      sourceMessageId: input.sourceMessageId,
      sourceIngressRevision: input.sourceIngressRevision,
      actorParticipantId: input.actor.participantId,
      actorIdentityAliases: [...input.actor.identityAliases],
      kind: input.kind,
      content: input.content,
      questionId: input.questionId,
      assignedOverride: input.assignedOverride,
      authorityRole: input.authorityRole,
      authorityEpoch: input.authorityEpoch,
      receivedAt: input.receivedAt,
    };
  });
  const canonical = JSON.stringify({
    version: 1,
    initial: {
      sourceMessageId: run.startSourceMessageId,
      actorParticipantId: run.initiator.participantId,
      actorIdentityAliases: [...run.initiator.identityAliases],
      content: run.initialRequest,
    },
    applied: canonicalApplied,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type NewGroupAgentRun = Omit<GroupAgentRun, "stateRevision">;

export type GroupAgentRunCreateResult =
  | { status: "saved"; run: GroupAgentRun }
  | { status: "source-exists"; run: GroupAgentRun }
  | { status: "guard-rejected" }
  | { status: "conflict" }
  | { status: "scope-busy" }
  | { status: "active-run-exists"; run: GroupAgentRun };

export type GroupAgentRunSaveResult =
  | { status: "saved"; run: GroupAgentRun }
  | { status: "guard-rejected" }
  | { status: "conflict" };

export type GroupAgentRunMutationGuard = () => Promise<boolean>;

export interface GroupAgentRunRepository {
  load(runId: string): Promise<GroupAgentRun | null>;
  loadLatestByScope(
    scopeKey: string,
    accountId: string,
  ): Promise<GroupAgentRun | null>;
  loadForeground(
    scopeKey: string,
    accountId: string,
  ): Promise<GroupAgentRun | null>;
  listActive(): Promise<GroupAgentRun[]>;
  create(
    run: NewGroupAgentRun,
    guard: GroupAgentRunMutationGuard,
  ): Promise<GroupAgentRunCreateResult>;
  save(
    run: Omit<GroupAgentRun, "stateRevision">,
    expectedStateRevision: number,
    guard: GroupAgentRunMutationGuard,
  ): Promise<GroupAgentRunSaveResult>;
  remove(runId: string, expectedStateRevision: number): Promise<boolean>;
  /**
   * Menghapus seluruh histori satu binding grup secara atomik, termasuk run
   * terminal dan pending delivery. Operasi ini idempotent untuk penghapusan
   * privasi ketika binding dinonaktifkan.
   */
  removeScope(scopeKey: string, accountId: string): Promise<number>;
  removeExpired(now: Date): Promise<number>;
}

export function isTerminalGroupAgentRunStatus(
  status: GroupAgentRunStatus,
): boolean {
  return status === "completed" || status === "partial" ||
    status === "failed" || status === "cancelled";
}
