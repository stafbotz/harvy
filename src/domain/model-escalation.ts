import type { ModelRole } from "./model-execution.js";

export type ModelEscalationFailureCode =
  | "missing_constraint"
  | "invalid_schema"
  | "wrong_tool_call"
  | "observation_contradiction"
  | "deadline_missed"
  | "unanswered_question"
  | "internal_contradiction"
  | "repeated_test_failure"
  | "low_confidence_high_consequence";

export const MODEL_ESCALATION_FAILURE_CODES: ReadonlySet<
  ModelEscalationFailureCode
> = new Set([
  "missing_constraint",
  "invalid_schema",
  "wrong_tool_call",
  "observation_contradiction",
  "deadline_missed",
  "unanswered_question",
  "internal_contradiction",
  "repeated_test_failure",
  "low_confidence_high_consequence",
]);

export type ModelEscalationOutcomeCode =
  | "accepted"
  | "candidate_rejected"
  | "provider_failure"
  | "execution_failure"
  | "outcome_unknown";

export const MODEL_ESCALATION_OUTCOME_CODES: ReadonlySet<
  ModelEscalationOutcomeCode
> = new Set([
  "accepted",
  "candidate_rejected",
  "provider_failure",
  "execution_failure",
  "outcome_unknown",
]);

/** Content-free one-shot reservation; prompt, candidate, and output stay out. */
export interface ModelEscalationRecord {
  version: 1;
  stageKey: string;
  reservationId: string;
  requestDigest: string;
  reason: ModelEscalationFailureCode;
  role: Extract<ModelRole, "critic" | "recovery" | "synthesizer">;
  sourcePrivacyDomain: string;
  targetPrivacyDomain: string;
  targetProviderId: string;
  targetModelId: string;
  promptMaterial: "structured-brief+candidate";
  status: "reserved" | "completed" | "failed" | "unknown";
  outcomeCode: ModelEscalationOutcomeCode | null;
  outputDigest: string | null;
  stateRevision: number;
  createdAt: string;
  settledAt: string | null;
}

export type ModelEscalationReserveResult =
  | { status: "reserved"; record: ModelEscalationRecord }
  | { status: "replay"; record: ModelEscalationRecord }
  | { status: "collision" };

export type ModelEscalationSaveResult =
  | { status: "saved"; record: ModelEscalationRecord }
  | { status: "conflict" };

export interface ModelEscalationRepository {
  reserve(
    record: Omit<ModelEscalationRecord, "stateRevision">,
  ): Promise<ModelEscalationReserveResult>;
  load(stageKey: string): Promise<ModelEscalationRecord | null>;
  save(
    record: Omit<ModelEscalationRecord, "stateRevision">,
    expectedStateRevision: number,
  ): Promise<ModelEscalationSaveResult>;
}
