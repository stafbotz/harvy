import type { ModelProfile } from "../ai/model-profile.js";
import type { ReasoningEffort } from "../domain/model-execution.js";

export type ResourceRequestKind =
  | "more_reasoning"
  | "more_steps"
  | "more_context"
  | "specialist"
  | "capability"
  | "more_tools";

export type ResourceRequestReason =
  | "unresolved_constraints"
  | "progress_evidence"
  | "validator_failure"
  | "required_capability"
  | "high_consequence_uncertainty"
  | "incomplete_evidence";

export type ProgressMarker =
  | "new_evidence"
  | "validator_state_changed"
  | "unresolved_set_reduced"
  | "artifact_revision_changed"
  | "error_signature_changed"
  | "test_pass_count_improved"
  | "plan_revision_changed";

/** Provider-neutral proposal. It never carries prompt text or private reasoning. */
export interface ResourceRequest {
  kind: ResourceRequestKind;
  reason: ResourceRequestReason;
  requestedAmount?: number;
  requiredCapability?: string;
  progress?: readonly ProgressMarker[];
}

export interface ResourcePolicyInput {
  request: ResourceRequest;
  difficulty: "mechanical" | "normal" | "deep";
  stakes: "low" | "medium" | "high";
  uncertainty: "low" | "medium" | "high";
  currentEffort: ReasoningEffort;
  profile: ModelProfile | null;
  /** Hard remainder comes from code-owned RunBudget, never from the model. */
  hardRemaining: {
    steps: number;
    contextTokens: number;
    toolCalls: number;
  };
  /** Adaptive reserve is configured by Harvy and cannot exceed hard remainder. */
  adaptiveReserve: {
    steps: number;
    contextTokens: number;
    toolCalls: number;
  };
  capabilityDiscoverable?: boolean;
  specialistEligible?: boolean;
}

export type ResourcePolicyDecision =
  | {
      decision: "deny";
      code:
        | "unsupported"
        | "insufficient_need"
        | "no_progress"
        | "reserve_exhausted"
        | "capability_ineligible"
        | "specialist_ineligible";
    }
  | {
      decision: "grant";
      kind: ResourceRequestKind;
      amount: number;
      reasoningEffort?: ReasoningEffort;
    };

const KINDS = new Set<ResourceRequestKind>([
  "more_reasoning",
  "more_steps",
  "more_context",
  "specialist",
  "capability",
  "more_tools",
]);
const REASONS = new Set<ResourceRequestReason>([
  "unresolved_constraints",
  "progress_evidence",
  "validator_failure",
  "required_capability",
  "high_consequence_uncertainty",
  "incomplete_evidence",
]);
const PROGRESS = new Set<ProgressMarker>([
  "new_evidence",
  "validator_state_changed",
  "unresolved_set_reduced",
  "artifact_revision_changed",
  "error_signature_changed",
  "test_pass_count_improved",
  "plan_revision_changed",
]);
const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const REQUEST_KEYS = new Set([
  "kind",
  "reason",
  "requestedAmount",
  "requiredCapability",
  "progress",
]);
const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Parse untrusted structured output into a bounded closed-set proposal. */
export function parseResourceRequest(value: unknown): ResourceRequest | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !REQUEST_KEYS.has(key)) ||
    typeof value.kind !== "string" || !KINDS.has(value.kind as ResourceRequestKind) ||
    typeof value.reason !== "string" ||
    !REASONS.has(value.reason as ResourceRequestReason)
  ) return null;

  const requestedAmount = value.requestedAmount;
  if (
    requestedAmount !== undefined &&
    (typeof requestedAmount !== "number" ||
      !Number.isSafeInteger(requestedAmount) || requestedAmount < 1 ||
      requestedAmount > 1_000_000)
  ) return null;
  const requiredCapability = value.requiredCapability;
  if (
    requiredCapability !== undefined &&
    (typeof requiredCapability !== "string" ||
      !CAPABILITY_ID.test(requiredCapability))
  ) return null;
  const progress = value.progress;
  if (
    progress !== undefined &&
    (!Array.isArray(progress) || progress.length > 4 ||
      new Set(progress).size !== progress.length ||
      progress.some((marker) =>
        typeof marker !== "string" || !PROGRESS.has(marker as ProgressMarker)
      ))
  ) return null;

  return Object.freeze({
    kind: value.kind as ResourceRequestKind,
    reason: value.reason as ResourceRequestReason,
    ...(requestedAmount !== undefined ? { requestedAmount } : {}),
    ...(requiredCapability !== undefined ? { requiredCapability } : {}),
    ...(progress !== undefined
      ? { progress: Object.freeze([...(progress as ProgressMarker[])]) }
      : {}),
  });
}

/**
 * Code-owned disposal for model resource proposals. This policy grants from an
 * already configured reserve; it never changes the hard circuit breaker.
 */
export class ResourceRequestPolicy {
  decide(input: ResourcePolicyInput): ResourcePolicyDecision {
    validateCounters(input.hardRemaining);
    validateCounters(input.adaptiveReserve);
    switch (input.request.kind) {
      case "more_reasoning":
        return this.reasoning(input);
      case "more_steps":
        if ((input.request.progress?.length ?? 0) === 0) {
          return { decision: "deny", code: "no_progress" };
        }
        return boundedGrant(
          "more_steps",
          input.request.requestedAmount,
          input.hardRemaining.steps,
          input.adaptiveReserve.steps,
        );
      case "more_context":
        if (
          input.request.reason !== "incomplete_evidence" &&
          input.request.reason !== "required_capability"
        ) return { decision: "deny", code: "insufficient_need" };
        return boundedGrant(
          "more_context",
          input.request.requestedAmount,
          input.hardRemaining.contextTokens,
          input.adaptiveReserve.contextTokens,
        );
      case "more_tools":
        if (!input.capabilityDiscoverable || !input.request.requiredCapability) {
          return { decision: "deny", code: "capability_ineligible" };
        }
        return boundedGrant(
          "more_tools",
          input.request.requestedAmount,
          input.hardRemaining.toolCalls,
          input.adaptiveReserve.toolCalls,
        );
      case "capability":
        return input.capabilityDiscoverable && input.request.requiredCapability
          ? { decision: "grant", kind: "capability", amount: 1 }
          : { decision: "deny", code: "capability_ineligible" };
      case "specialist":
        if (!input.specialistEligible) {
          return { decision: "deny", code: "specialist_ineligible" };
        }
        if (
          input.request.reason !== "validator_failure" &&
          input.request.reason !== "high_consequence_uncertainty" &&
          input.request.reason !== "unresolved_constraints" &&
          input.request.reason !== "incomplete_evidence"
        ) return { decision: "deny", code: "insufficient_need" };
        return { decision: "grant", kind: "specialist", amount: 1 };
    }
  }

  private reasoning(input: ResourcePolicyInput): ResourcePolicyDecision {
    if (
      input.difficulty !== "deep" && input.stakes !== "high" &&
      input.uncertainty !== "high"
    ) return { decision: "deny", code: "insufficient_need" };
    const supported = input.profile?.reasoning.supportedEfforts ?? [];
    if (supported.length === 0) return { decision: "deny", code: "unsupported" };
    const current = EFFORT_ORDER.indexOf(input.currentEffort);
    const next = supported
      .filter((effort) => EFFORT_ORDER.indexOf(effort) > current)
      .sort(
        (left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right),
      )[0];
    return next
      ? {
          decision: "grant",
          kind: "more_reasoning",
          amount: 1,
          reasoningEffort: next,
        }
      : { decision: "deny", code: "unsupported" };
  }
}

function boundedGrant(
  kind: Extract<ResourceRequestKind, "more_steps" | "more_context" | "more_tools">,
  requested: number | undefined,
  hardRemaining: number,
  reserve: number,
): ResourcePolicyDecision {
  const amount = Math.min(requested ?? 1, hardRemaining, reserve);
  return amount > 0
    ? { decision: "grant", kind, amount }
    : { decision: "deny", code: "reserve_exhausted" };
}

function validateCounters(value: ResourcePolicyInput["hardRemaining"]): void {
  if (
    !Number.isSafeInteger(value.steps) || value.steps < 0 ||
    !Number.isSafeInteger(value.contextTokens) || value.contextTokens < 0 ||
    !Number.isSafeInteger(value.toolCalls) || value.toolCalls < 0
  ) throw new Error("Envelope resource code-owned tidak sah.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
