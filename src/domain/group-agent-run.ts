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
  version: 1;
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
  inputs: GroupRunInput[];
  changeSets: GroupRunChangeSet[];
  questions: GroupRunQuestion[];
  events: GroupAgentRunEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
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
  removeExpired(now: Date): Promise<number>;
}

export function isTerminalGroupAgentRunStatus(
  status: GroupAgentRunStatus,
): boolean {
  return status === "completed" || status === "partial" ||
    status === "failed" || status === "cancelled";
}
