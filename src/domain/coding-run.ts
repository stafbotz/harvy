import type {
  SandboxArtifactReference,
  SandboxExecutionPurpose,
} from "./sandbox.js";

export interface CodingEvidenceBinding {
  ownerWorkspaceKey: string;
  projectId: string;
  runId: string;
}

export interface CodingEvidenceSource {
  sandboxOperationId: string;
  sandboxRequestDigest: string;
  sandboxExecutionId: string;
}

/** Durable evidence copied out of a disposable sandbox before lease disposal. */
export interface CodingEvidenceStore {
  persist(
    binding: CodingEvidenceBinding,
    source: CodingEvidenceSource,
    artifact: SandboxArtifactReference,
    bytes: Uint8Array,
  ): Promise<string>;
  verify(
    binding: CodingEvidenceBinding,
    evidenceId: string,
    source: CodingEvidenceSource,
  ): Promise<boolean>;
  read(binding: CodingEvidenceBinding, evidenceId: string): Promise<Uint8Array>;
  removeRun(binding: CodingEvidenceBinding): Promise<void>;
  removeProject(binding: Omit<CodingEvidenceBinding, "runId">): Promise<void>;
}

export type CodingRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "partial";

export type CodingRunPhase =
  | "queued"
  | "mapping"
  | "planning"
  | "editing"
  | "testing"
  | "reviewing"
  | "waiting_input"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface CodingRunBinding {
  projectId: string;
  ownerWorkspaceKey: string;
  workspaceRevision: number;
  baseSnapshot: string;
}

export interface CodingTaskBrief {
  request: string;
  objective: string;
  acceptanceCriteria: string[];
  initialConstraints: string[];
}

/**
 * Admission provenance is code-owned and content-free. A group interaction may
 * start a CodingRun only through an idempotent effect that is already bound to
 * a durable group/workspace link. Raw group IDs, prompts, principals, and
 * approval material deliberately stay outside this record.
 */
export interface CodingRunAdmission {
  source: "group";
  effectId: string;
  audience: "group-safe";
  authorityRef: string;
  interactionDigest: string;
}

export interface CodingRunStartOptions {
  admission?: CodingRunAdmission;
}

export type CodingConstraintKind =
  | "constraint"
  | "correction"
  | "scope_change";

export interface CodingRunConstraint {
  id: string;
  sourceMessageId: string;
  kind: CodingConstraintKind;
  content: string;
  instructionRevision: number;
  receivedAt: string;
}

export interface CodingChangeSet {
  instructionRevision: number;
  sourceMessageId: string;
  kind: CodingConstraintKind;
  affectedStages: Array<"plan" | "edits" | "validators" | "publish">;
  receivedAt: string;
}

export interface CodingWriterLease {
  writerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export type CodingRunEventType =
  | "run.started"
  | "mapping.started"
  | "mapping.completed"
  | "planning.started"
  | "editing.started"
  | "patch.applied"
  | "testing.started"
  | "validator.completed"
  | "review.started"
  | "review.completed"
  | "revision.received"
  | "run.paused"
  | "run.resumed"
  | "finalizing.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface CodingRunEvent {
  id: string;
  type: CodingRunEventType;
  at: string;
  instructionRevision: number;
  summaryCode: string;
}

export type CodingValidatorKind =
  | "test"
  | "lint"
  | "typecheck"
  | "build";

export interface CodingValidatorReceipt {
  receiptId: string;
  kind: CodingValidatorKind;
  status: "passed" | "failed" | "stale" | "infrastructure_error";
  instructionRevision: number;
  workingSnapshot: string;
  commandDigest: string;
  taskContractDigest: string;
  sandboxOperationId: string;
  sandboxRequestDigest: string;
  sandboxExecutionId: string;
  exitCode: number | null;
  evidenceArtifactIds: string[];
  completedAt: string;
}

export interface CodingTaskRequirementEvidence {
  kind: "request" | "objective" | "acceptance" | "constraint";
  requirementDigest: string;
  status: "evidenced" | "not_evidenced";
  /** Opaque artifact/receipt references; never raw source or model reasoning. */
  evidenceRefs: string[];
}

export interface CodingTaskReviewReceipt {
  receiptId: string;
  status: "approved" | "changes_requested" | "stale" | "infrastructure_error";
  instructionRevision: number;
  workingSnapshot: string;
  diffDigest: string;
  taskContractDigest: string;
  policyDigest: string;
  repositoryMapDigest: string;
  planDigest: string;
  requirementEvidence: CodingTaskRequirementEvidence[];
  publicApi: "preserved" | "changed" | "not_applicable";
  unrelatedChanges: "minimized" | "not_minimized";
  completedAt: string;
}

export interface CodingRepositoryMapReceipt {
  instructionRevision: number;
  workingSnapshot: string;
  treeDigest: string;
  symbolDigest: string;
  entryCount: number;
  symbolCount: number;
  treeComplete: true;
  symbolsComplete: true;
  mapDigest: string;
  completedAt: string;
}

export interface CodingPlanStep {
  stepId: string;
  stage: "inspect" | "edit" | "test" | "review";
  description: string;
  paths: string[];
}

export interface CodingRunPlan {
  revision: number;
  instructionRevision: number;
  repositoryMapDigest: string;
  taskContractDigest: string;
  steps: CodingPlanStep[];
  planDigest: string;
  createdAt: string;
}

export interface CodingDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeSize: number | null;
  afterSize: number | null;
  binary: boolean;
}

export interface CodingDiffSummary {
  baseSnapshot: string;
  workingSnapshot: string;
  files: CodingDiffEntry[];
  addedBytes: number;
  removedBytes: number;
  generatedAt: string;
}

export interface CodingRunLimits {
  maxPatches: number;
  maxSandboxCalls: number;
  maxChangedFiles: number;
  maxChangedBytes: number;
  maxActiveMs: number;
  maxCoordinatorDecisions: number;
}

export interface CodingRunCounters {
  patches: number;
  sandboxCalls: number;
  activeElapsedMs: number;
  coordinatorDecisions: number;
}

/**
 * Human-visible question that makes `waiting_input` an explicit, targeted
 * state instead of a generic pause. Platform ingress binds the answer to the
 * mutable Run Anchor; arbitrary conversation is never copied here.
 */
export interface CodingRunPendingQuestion {
  questionId: string;
  reasonCode: string;
  prompt: string;
  instructionRevision: number;
  requestedAt: string;
}

export interface PendingCodingCommit {
  effectId: string;
  instructionRevision: number;
  sourceWorkspaceRevision: number;
  workingSnapshot: string;
  validatorEvidence: Array<{
    receiptId: string;
    kind: CodingValidatorKind;
    commandDigest: string;
    taskContractDigest: string;
    sandboxOperationId: string;
    sandboxRequestDigest: string;
    sandboxExecutionId: string;
  }>;
  taskReviewEvidence?: {
    receiptId: string;
    diffDigest: string;
    taskContractDigest: string;
    policyDigest: string;
    repositoryMapDigest: string;
    planDigest: string;
  };
  preparedAt: string;
}

export interface CodingCommitReceipt {
  effectId: string;
  status: "committed" | "unknown";
  sourceWorkspaceRevision: number;
  committedWorkspaceRevision: number | null;
  snapshotId: string;
  committedAt: string;
}

export interface CodingRunResult {
  instructionRevision: number;
  projectRevision: number;
  snapshotId: string;
  changedFiles: number;
  validators: Array<{
    kind: CodingValidatorKind;
    status: "passed";
    sandboxOperationId: string;
    sandboxRequestDigest: string;
    sandboxExecutionId: string;
  }>;
  taskReview: {
    receiptId: string;
    policyDigest: string;
    repositoryMapDigest: string;
    planDigest: string;
  } | null;
  completedAt: string;
}

export interface CodingRunError {
  stage: "workspace" | "sandbox" | "validation" | "commit" | "recovery";
  code: string;
  at: string;
}

/** Durable coding state contains references/evidence, never host paths or secrets. */
export interface CodingRun {
  /** v1 records remain readable but are terminal/read-only legacy state. */
  version: 1 | 2;
  runId: string;
  binding: CodingRunBinding;
  taskBrief: CodingTaskBrief;
  /** Optional so pre-Phase-L records remain source/read compatible. */
  admission?: CodingRunAdmission;
  status: CodingRunStatus;
  phase: CodingRunPhase;
  instructionRevision: number;
  appliedInstructionRevision: number;
  stateRevision: number;
  workingCopyId: string;
  writer: CodingWriterLease;
  constraints: CodingRunConstraint[];
  changeSets: CodingChangeSet[];
  events: CodingRunEvent[];
  validatorReceipts: CodingValidatorReceipt[];
  /** Optional only for loading pre-review local records; new runs always set it. */
  taskReviewReceipts?: CodingTaskReviewReceipt[];
  /** Optional only for loading pre-plan local records; new runs set both. */
  repositoryMap?: CodingRepositoryMapReceipt | null;
  plan?: CodingRunPlan | null;
  diff: CodingDiffSummary | null;
  limits: CodingRunLimits;
  counters: CodingRunCounters;
  /** Optional only while loading records written before targeted questions. */
  pendingQuestion?: CodingRunPendingQuestion | null;
  pendingCommit: PendingCodingCommit | null;
  commitReceipts: CodingCommitReceipt[];
  result: CodingRunResult | null;
  lastError: CodingRunError | null;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
}

export type NewCodingRun = Omit<CodingRun, "stateRevision">;

export type CodingRunSaveResult =
  | { status: "saved"; run: CodingRun }
  | { status: "conflict" | "active-run-exists" };

export interface CodingRunRepository {
  load(runId: string): Promise<CodingRun | null>;
  loadActiveByProject(projectId: string): Promise<CodingRun | null>;
  listActive(): Promise<CodingRun[]>;
  listByProject(projectId: string): Promise<CodingRun[]>;
  create(run: NewCodingRun): Promise<CodingRunSaveResult>;
  save(
    run: Omit<CodingRun, "stateRevision">,
    expectedStateRevision: number,
  ): Promise<CodingRunSaveResult>;
  remove(runId: string, expectedStateRevision: number): Promise<boolean>;
}

export interface CodingValidationCommand {
  kind: CodingValidatorKind;
  argv: readonly [string, ...string[]];
  cwd: string;
  purpose: Exclude<SandboxExecutionPurpose, "inspect">;
  timeoutMs: number;
  required: boolean;
}
