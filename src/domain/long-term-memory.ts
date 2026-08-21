import type {
  ConversationEpisode,
  HistoricalEpisodeMatch,
} from "./history.js";
import type {
  MemoryKnowledgeNamespace,
  MemoryProvenance,
  RetrievedMemoryEvidence,
  TextEmbeddingProvider,
} from "./memory-knowledge.js";

/** Canonical evidence kinds; raw binary and private reasoning are never stored. */
export type LearningEvidenceKind =
  | "conversation_message"
  | "conversation_episode"
  | "tool_result"
  | "validator_result"
  | "coding_evidence"
  | "connector_object"
  | "document_chunk"
  | "web_resource"
  | "audio_transcript"
  | "image_analysis"
  | "video_segment";

export interface LearningEvidenceReference {
  kind: LearningEvidenceKind;
  sourceId: string;
  contentHash: string;
  occurredAt: string;
  sourceEpisodeId: string | null;
  sourceSequences: number[];
  /** Optional artifact/connector locator; never a credential-bearing URL. */
  locator: string | null;
}

export interface DurableEpisodeArchive {
  archive(
    namespace: MemoryKnowledgeNamespace,
    episode: ConversationEpisode,
  ): Promise<void>;
  search(
    namespace: MemoryKnowledgeNamespace,
    query: string,
    options?: { limit?: number },
  ): Promise<HistoricalEpisodeMatch[]>;
  list(namespace: MemoryKnowledgeNamespace): Promise<ConversationEpisode[]>;
  remove(namespace: MemoryKnowledgeNamespace): Promise<boolean>;
  suspend(namespace: MemoryKnowledgeNamespace): void;
  allow(namespace: MemoryKnowledgeNamespace): void;
}

export type UserModelCategory =
  | "identity"
  | "stable_preference"
  | "communication_preference"
  | "working_style"
  | "goal"
  | "project"
  | "expertise"
  | "habit"
  | "routine"
  | "constraint"
  | "relationship"
  | "hypothesis";

export type UserModelStability = "transient" | "evolving" | "stable";

export interface UserModelFact {
  id: string;
  namespace: MemoryKnowledgeNamespace;
  category: UserModelCategory;
  subject: string;
  predicate: string;
  value: string;
  displayText: string;
  provenance: MemoryProvenance;
  confidence: number;
  stability: UserModelStability;
  status: "active" | "superseded" | "uncertain" | "expired";
  learnedAt: string;
  lastObservedAt: string;
  lastConfirmedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  supersedesId: string | null;
  evidence: LearningEvidenceReference[];
  sourceMemoryIds: string[];
}

export interface ProcedureStep {
  order: number;
  action: string;
  tool: string | null;
  expectedOutcome: string | null;
}

export interface ProcedureDraft {
  logicalKey: string;
  name: string;
  description: string;
  triggerSignatures: string[];
  preconditions: string[];
  toolRequirements: string[];
  environmentConstraints: string[];
  steps: ProcedureStep[];
  pitfalls: string[];
  recoveryStrategies: string[];
  verification: string[];
}

export type ProcedureStatus =
  | "candidate"
  | "active"
  | "uncertain"
  | "degraded"
  | "quarantined"
  | "superseded"
  | "retired";

export interface ProcedureMemory extends ProcedureDraft {
  procedureId: string;
  namespace: MemoryKnowledgeNamespace;
  version: number;
  confidence: number;
  status: ProcedureStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  successCount: number;
  verifiedSuccessCount: number;
  failureCount: number;
  recentOutcomes: Array<"success" | "failure">;
  sourceEpisodeIds: string[];
  sourceRunIds: string[];
  sourceMemoryIds: string[];
  sourceEventIds: string[];
  supersedesVersion: number | null;
  evidence: LearningEvidenceReference[];
}

export interface FailureSignature {
  fingerprint: string;
  tool: string;
  operation: string;
  errorCode: string | null;
  exceptionType: string | null;
  normalizedMessage: string;
  environmentFingerprint: string;
  httpStatus: number | null;
  providerVersion: string | null;
}

export interface ErrorLesson {
  lessonId: string;
  namespace: MemoryKnowledgeNamespace;
  signature: FailureSignature;
  rootCause: string | null;
  rootCauseStatus: "unknown" | "hypothesis" | "verified";
  successfulRecovery: string[];
  unsuccessfulRecoveries: string[];
  confidence: number;
  status: "candidate" | "active" | "uncertain" | "superseded";
  firstSeenAt: string;
  lastSeenAt: string;
  successCount: number;
  failureCount: number;
  sourceEventIds: string[];
  sourceMemoryIds: string[];
  evidence: LearningEvidenceReference[];
}

export type LearningEventKind =
  | "user_correction"
  | "explicit_remember_request"
  | "durable_preference_discovered"
  | "task_completed"
  | "task_failed"
  | "tool_failed"
  | "tool_recovered"
  | "validator_failed"
  | "validator_passed"
  | "workflow_repeated"
  | "procedure_used"
  | "procedure_success"
  | "procedure_failure"
  | "user_acceptance"
  | "user_rejection"
  | "environment_changed";

export interface LearningOutcome {
  technical: "success" | "failure" | "unknown";
  task: "success" | "failure" | "unknown";
  user: "accepted" | "rejected" | "unknown";
  verified: boolean;
}

export interface LearningEventPayload {
  userFact?: Omit<
    UserModelFact,
    "id" | "namespace" | "learnedAt" | "lastObservedAt" | "status" |
      "supersedesId"
  >;
  procedure?: ProcedureDraft;
  failure?: FailureSignature;
  recovery?: string[];
  rootCause?: string | null;
  outcome?: LearningOutcome;
  sourceRunId?: string | null;
  sourceEpisodeIds?: string[];
  sourceMemoryIds?: string[];
  evidence?: LearningEvidenceReference[];
}

export interface LearningEvent {
  eventId: string;
  idempotencyKey: string;
  namespace: MemoryKnowledgeNamespace;
  generation: number;
  kind: LearningEventKind;
  occurredAt: string;
  createdAt: string;
  status: "pending" | "processing" | "processed";
  attempts: number;
  payload: LearningEventPayload;
}

export interface LearningCandidate {
  candidateId: string;
  namespace: MemoryKnowledgeNamespace;
  kind: "user_model" | "procedure" | "error_lesson";
  fingerprint: string;
  status: "candidate" | "promoted" | "rejected";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  sourceEventIds: string[];
}

export interface LearningPromotionPolicy {
  procedureSuccesses: number;
  procedureVerifiedSuccesses: number;
  procedureFailuresToDegrade: number;
  recentOutcomeWindow: number;
}

export interface LongTermMemorySnapshot {
  userModel: UserModelFact[];
  procedures: ProcedureMemory[];
  errorLessons: ErrorLesson[];
  candidates: LearningCandidate[];
  learningEvents: Array<Pick<
    LearningEvent,
    "eventId" | "kind" | "occurredAt" | "status" | "attempts"
  >>;
}

export interface EmbeddingDocument {
  sourceId: string;
  contentHash: string;
  text: string;
}

/** Derived cache. Canonical content always stays in its owning repository. */
export interface PersistentEmbeddingIndex {
  load(
    namespace: MemoryKnowledgeNamespace,
    provider: TextEmbeddingProvider,
    documents: readonly EmbeddingDocument[],
  ): Promise<Map<string, number[]>>;
  store(
    namespace: MemoryKnowledgeNamespace,
    provider: TextEmbeddingProvider,
    documents: readonly EmbeddingDocument[],
    vectors: readonly number[][],
  ): Promise<void>;
  removeSources(
    namespace: MemoryKnowledgeNamespace,
    sourceIds: readonly string[],
  ): Promise<void>;
  removeEpisodeSources(
    namespace: MemoryKnowledgeNamespace,
    episodeIds: readonly string[],
  ): Promise<void>;
  removeScope(namespace: MemoryKnowledgeNamespace): Promise<void>;
}

export interface LongTermMemoryRetriever {
  searchUserModel(
    namespace: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<RetrievedMemoryEvidence[]>;
  searchProcedures(
    namespace: MemoryKnowledgeNamespace,
    query: string,
    options: { limit: number; environment?: readonly string[] },
  ): Promise<RetrievedMemoryEvidence[]>;
  searchErrorLessons(
    namespace: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<RetrievedMemoryEvidence[]>;
}
