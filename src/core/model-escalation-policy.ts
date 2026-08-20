import { randomUUID } from "node:crypto";
import type { ModelProfile } from "../ai/model-profile.js";
import type {
  ModelEscalationFailureCode,
  ModelEscalationRecord,
  ModelEscalationRepository,
  ModelEscalationOutcomeCode,
} from "../domain/model-escalation.js";
import { MODEL_ESCALATION_FAILURE_CODES } from "../domain/model-escalation.js";
import type { ModelRole } from "../domain/model-execution.js";
import {
  ExecutionPolicy,
  type ExecutionPlan,
} from "./execution-policy.js";

export interface ToughestModelTarget {
  providerId: string;
  modelId: string;
  /** Explicit trust/privacy domain, not inferred from a model-name substring. */
  privacyDomain: string;
  profile: ModelProfile;
}

export interface ModelEscalationPolicyInput {
  role: Extract<ModelRole, "critic" | "recovery" | "synthesizer">;
  validationFailures: readonly ModelEscalationFailureCode[];
  /** Provider/network failure is a retry/fallback concern, never intelligence. */
  providerFailure: boolean;
  sensitivity: "ordinary" | "sensitive";
  sourcePrivacyDomain: string;
  crossProviderApproved: boolean;
  remainingModelCalls: number;
  remainingOutputTokens: number;
  maxOutputTokens: number;
  deadlineMs: number;
  target: ToughestModelTarget | null;
}

export type ModelEscalationPolicyDecision =
  | {
      decision: "none";
      code:
        | "provider_retry_or_fallback"
        | "no_validator_failure"
        | "toughest_unavailable"
        | "privacy_path_denied"
        | "budget_exhausted"
        | "target_profile_unverified";
    }
  | {
      decision: "escalate";
      reason: ModelEscalationFailureCode;
      target: ToughestModelTarget;
      execution: ExecutionPlan;
      promptMaterial: "structured-brief+candidate";
    };

const FAILURE_PRIORITY: readonly ModelEscalationFailureCode[] = [
  "low_confidence_high_consequence",
  "observation_contradiction",
  "internal_contradiction",
  "repeated_test_failure",
  "missing_constraint",
  "unanswered_question",
  "wrong_tool_call",
  "invalid_schema",
  "deadline_missed",
];

/** Pure, prompt-blind authority for K3/toughest adoption. */
export class ModelEscalationPolicy {
  constructor(private readonly executionPolicy = new ExecutionPolicy()) {}

  decide(input: ModelEscalationPolicyInput): ModelEscalationPolicyDecision {
    if (input.providerFailure) {
      return { decision: "none", code: "provider_retry_or_fallback" };
    }
    const failures = new Set(input.validationFailures);
    if (
      failures.size !== input.validationFailures.length ||
      [...failures].some((failure) => !MODEL_ESCALATION_FAILURE_CODES.has(failure))
    ) throw new Error("Kode validator untuk eskalasi model tidak sah atau duplikat.");
    const reason = FAILURE_PRIORITY.find((failure) => failures.has(failure));
    if (!reason) return { decision: "none", code: "no_validator_failure" };
    if (!input.target) return { decision: "none", code: "toughest_unavailable" };
    validateTarget(input.target);
    if (input.target.profile.verification !== "explicit") {
      return { decision: "none", code: "target_profile_unverified" };
    }
    validatePrivacyDomain(input.sourcePrivacyDomain, "sourcePrivacyDomain");
    if (
      input.sensitivity === "sensitive" &&
      input.sourcePrivacyDomain !== input.target.privacyDomain &&
      !input.crossProviderApproved
    ) return { decision: "none", code: "privacy_path_denied" };
    if (
      !Number.isSafeInteger(input.remainingModelCalls) ||
      !Number.isSafeInteger(input.remainingOutputTokens) ||
      !Number.isSafeInteger(input.maxOutputTokens) ||
      !Number.isSafeInteger(input.deadlineMs) ||
      input.remainingModelCalls < 1 || input.remainingOutputTokens < 1 ||
      input.maxOutputTokens < 1 || input.deadlineMs < 1 ||
      input.maxOutputTokens > input.remainingOutputTokens
    ) return { decision: "none", code: "budget_exhausted" };
    const execution = this.executionPolicy.decide({
      tier: "toughest",
      role: input.role,
      workClass: "agent",
      profile: input.target.profile,
      maxOutputTokens: input.maxOutputTokens,
      deadlineMs: input.deadlineMs,
      maxSteps: 1,
      allowTools: false,
      allowDelegation: false,
      allowEscalation: true,
      escalationReason: reason,
      routeReason: "validator_escalation",
      promptMaterial: "structured-brief+candidate",
      sourcePrivacyDomain: input.sourcePrivacyDomain,
      targetPrivacyDomain: input.target.privacyDomain,
    });
    return {
      decision: "escalate",
      reason,
      target: input.target,
      execution,
      promptMaterial: "structured-brief+candidate",
    };
  }
}

export interface ExecuteModelEscalationInput extends ModelEscalationPolicyInput {
  stageKey: string;
  /** SHA-256 over the code-owned structured brief/candidate envelope. */
  requestDigest: string;
}

export interface ModelEscalationInvocationResult<T> {
  value: T;
  outputDigest: string;
}

export type ExecuteModelEscalationResult<T> =
  | {
      status: "not_escalated";
      code: Extract<
        ModelEscalationPolicyDecision,
        { decision: "none" }
      >["code"];
    }
  | { status: "already_used"; record: ModelEscalationRecord }
  | { status: "accepted"; value: T; record: ModelEscalationRecord }
  | {
      status: "failed";
      code: Exclude<ModelEscalationOutcomeCode, "accepted" | "outcome_unknown">;
      record: ModelEscalationRecord;
    };

/**
 * Reserves a stage before the provider call. Reserved/failed stages are never
 * retried, including after restart or ambiguous settlement.
 */
export class OneShotModelEscalationService {
  constructor(
    private readonly repository: ModelEscalationRepository,
    private readonly policy = new ModelEscalationPolicy(),
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async execute<T>(
    input: ExecuteModelEscalationInput,
    invoke: (
      route: Extract<ModelEscalationPolicyDecision, { decision: "escalate" }>,
    ) => Promise<ModelEscalationInvocationResult<T>>,
    validate: (value: T) => boolean | Promise<boolean>,
  ): Promise<ExecuteModelEscalationResult<T>> {
    const decision = this.policy.decide(input);
    if (decision.decision === "none") {
      return { status: "not_escalated", code: decision.code };
    }
    if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) {
      throw new Error("requestDigest eskalasi model tidak sah.");
    }
    const createdAt = this.now().toISOString();
    const reserved = await this.repository.reserve({
      version: 1,
      stageKey: input.stageKey,
      reservationId: `model-escalation-${this.makeId()}`,
      requestDigest: input.requestDigest,
      reason: decision.reason,
      role: input.role,
      sourcePrivacyDomain: input.sourcePrivacyDomain,
      targetPrivacyDomain: decision.target.privacyDomain,
      targetProviderId: decision.target.providerId,
      targetModelId: decision.target.modelId,
      promptMaterial: decision.promptMaterial,
      status: "reserved",
      outcomeCode: null,
      outputDigest: null,
      createdAt,
      settledAt: null,
    });
    if (reserved.status === "collision") {
      throw new Error("Stage eskalasi model bertabrakan dengan request lain.");
    }
    if (reserved.status === "replay") {
      return { status: "already_used", record: reserved.record };
    }
    try {
      const result = await invoke(decision);
      if (!/^[a-f0-9]{64}$/u.test(result.outputDigest)) {
        return await this.settleFailure(reserved.record, "candidate_rejected");
      }
      const accepted = await validate(result.value);
      if (!accepted) {
        return await this.settleFailure(reserved.record, "candidate_rejected");
      }
      const record = await this.settle(
        reserved.record,
        "completed",
        "accepted",
        result.outputDigest,
      );
      return { status: "accepted", value: result.value, record };
    } catch (error) {
      if (error instanceof ModelEscalationOutcomeUnknownError) throw error;
      const outcome = error instanceof ModelEscalationProviderError
        ? "provider_failure"
        : "execution_failure";
      return this.settleFailure(reserved.record, outcome);
    }
  }

  /** Startup recovery closes an ambiguous reservation without another call. */
  async markReservedUnknown(stageKey: string): Promise<ModelEscalationRecord | null> {
    const record = await this.repository.load(stageKey);
    if (!record || record.status !== "reserved") return record;
    return this.settle(record, "unknown", "outcome_unknown", null);
  }

  /** A process restart never replays an invocation whose settlement is unknown. */
  async recoverReserved(): Promise<number> {
    const reserved = await this.repository.listReserved();
    let recovered = 0;
    for (const record of reserved) {
      const settled = await this.markReservedUnknown(record.stageKey);
      if (settled?.status === "unknown") recovered += 1;
    }
    return recovered;
  }

  private async settleFailure(
    record: ModelEscalationRecord,
    outcome: "candidate_rejected" | "provider_failure" | "execution_failure",
  ): Promise<Extract<ExecuteModelEscalationResult<never>, { status: "failed" }>> {
    const settled = await this.settle(record, "failed", outcome, null);
    return { status: "failed", code: outcome, record: settled };
  }

  private async settle(
    record: ModelEscalationRecord,
    status: "completed" | "failed" | "unknown",
    outcomeCode: ModelEscalationOutcomeCode,
    outputDigest: string | null,
  ): Promise<ModelEscalationRecord> {
    const saved = await this.repository.save({
      ...withoutStateRevision(record),
      status,
      outcomeCode,
      outputDigest,
      settledAt: this.now().toISOString(),
    }, record.stateRevision);
    if (saved.status !== "saved") {
      throw new ModelEscalationOutcomeUnknownError();
    }
    return saved.record;
  }
}

export class ModelEscalationProviderError extends Error {
  constructor(message = "Provider toughest gagal.") {
    super(message);
    this.name = "ModelEscalationProviderError";
  }
}

export class ModelEscalationOutcomeUnknownError extends Error {
  constructor() {
    super("Outcome eskalasi model ambigu; stage tidak boleh dipanggil ulang.");
    this.name = "ModelEscalationOutcomeUnknownError";
  }
}

function validateTarget(target: ToughestModelTarget): void {
  validatePrivacyDomain(target.providerId, "target.providerId");
  validatePrivacyDomain(target.privacyDomain, "target.privacyDomain");
  if (
    !target.modelId || target.modelId.length > 160 || /[\p{Cc}<>]/u.test(target.modelId) ||
    target.profile.provider !== target.providerId || target.profile.id !== target.modelId
  ) throw new Error("Target toughest tidak cocok dengan profile exact.");
}

function validatePrivacyDomain(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(value)) {
    throw new Error(`${field} eskalasi model tidak sah.`);
  }
}

function withoutStateRevision(
  record: ModelEscalationRecord,
): Omit<ModelEscalationRecord, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = record;
  return rest;
}
