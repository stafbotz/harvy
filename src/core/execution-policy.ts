import type {
  ModelExecutionMetadata,
  ModelRole,
  ReasoningEffort,
  Verbosity,
} from "../domain/model-execution.js";
import type { ModelProfile } from "../ai/model-profile.js";
import type { ModelTier } from "../ai/model-policy.js";

export type ExecutionWorkClass =
  | "mechanical"
  | "conversation"
  | "agent"
  | "delegated-worker"
  | "safety";

export interface ExecutionPlan extends ModelExecutionMetadata {
  tier: ModelTier;
  workClass: ExecutionWorkClass;
  maxOutputTokens: number;
  deadlineMs: number;
  maxSteps: number;
  allowTools: boolean;
  allowDelegation: boolean;
  allowEscalation: boolean;
  escalationReason?: string;
}

export interface ExecutionPolicyInput {
  tier: ModelTier;
  role: ModelRole;
  workClass: ExecutionWorkClass;
  profile: ModelProfile | null;
  maxOutputTokens: number;
  deadlineMs: number;
  maxSteps?: number;
  allowTools?: boolean;
  allowDelegation?: boolean;
  allowEscalation?: boolean;
  escalationReason?: string;
}

const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Authority murni untuk effort/verbosity/batas tahap; tidak membaca prompt. */
export class ExecutionPolicy {
  decide(input: ExecutionPolicyInput): ExecutionPlan {
    validatePositiveInteger(input.maxOutputTokens, "maxOutputTokens");
    validatePositiveInteger(input.deadlineMs, "deadlineMs");
    const maxSteps = input.maxSteps ?? 1;
    validatePositiveInteger(maxSteps, "maxSteps");

    const allowTools = input.allowTools ?? false;
    const allowDelegation = input.allowDelegation ?? false;
    const allowEscalation = input.allowEscalation ?? false;
    if (allowDelegation && (!allowTools || input.role !== "planner")) {
      throw new Error("Delegasi hanya boleh dimiliki planner yang memakai tool.");
    }
    if (input.workClass === "safety" && (allowTools || allowDelegation)) {
      throw new Error("Tahap safety tidak boleh memperoleh tool atau delegasi.");
    }
    if (input.role === "recovery" && !allowEscalation) {
      throw new Error("Role recovery harus terikat kebijakan eskalasi.");
    }
    if (allowEscalation !== Boolean(input.escalationReason)) {
      throw new Error("Eskalasi harus mempunyai alasan tertutup dan eksplisit.");
    }
    if (
      input.profile?.maxOutputTokens !== null &&
      input.profile?.maxOutputTokens !== undefined &&
      input.maxOutputTokens > input.profile.maxOutputTokens
    ) {
      throw new Error("Ceiling output tahap melampaui profile model.");
    }
    if (allowTools && input.profile && !input.profile.supports.tools) {
      throw new Error("Profile model tidak mendukung tool.");
    }

    const requestedEffort = requestedEffortFor(input.role, input.tier);
    const effectiveEffort = input.profile
      ? supportedEffort(requestedEffort, input.profile)
      : null;
    const verbosity = verbosityFor(input.role);

    return Object.freeze({
      tier: input.tier,
      role: input.role,
      workClass: input.workClass,
      requestedEffort,
      effectiveEffort,
      verbosity,
      maxOutputTokens: input.maxOutputTokens,
      deadlineMs: input.deadlineMs,
      maxSteps,
      allowTools,
      allowDelegation,
      allowEscalation,
      ...(input.escalationReason
        ? { escalationReason: input.escalationReason }
        : {}),
    });
  }
}

export const DEFAULT_EXECUTION_POLICY = new ExecutionPolicy();

function requestedEffortFor(
  role: ModelRole,
  tier: ModelTier,
): ReasoningEffort {
  switch (role) {
    case "extractor":
    case "classifier":
      return "low";
    case "critic":
      return tier === "cheap" ? "low" : "medium";
    case "conversationalist":
      return tier === "ambitious" ? "high" : tier === "efficient" ? "medium" : "low";
    case "planner":
      return tier === "ambitious" ? "medium" : "low";
    case "worker":
      return tier === "efficient" ? "medium" : "low";
    case "synthesizer":
      return tier === "ambitious" ? "high" : "medium";
    case "recovery":
      return "high";
  }
}

function verbosityFor(role: ModelRole): Verbosity {
  switch (role) {
    case "extractor":
    case "classifier":
    case "critic":
    case "planner":
    case "recovery":
      return "low";
    case "conversationalist":
    case "worker":
      return "medium";
    case "synthesizer":
      return "high";
  }
}

function supportedEffort(
  requested: ReasoningEffort,
  profile: ModelProfile,
): ReasoningEffort | null {
  const supported = profile.reasoning.supportedEfforts;
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;

  const requestedIndex = EFFORT_ORDER.indexOf(requested);
  const lowerOrEqual = supported
    .filter((effort) => EFFORT_ORDER.indexOf(effort) <= requestedIndex)
    .sort(
      (left, right) => EFFORT_ORDER.indexOf(right) - EFFORT_ORDER.indexOf(left),
    )[0];
  if (lowerOrEqual && !(profile.reasoning.mandatory && lowerOrEqual === "none")) {
    return lowerOrEqual;
  }
  throw new Error(
    "Profile tidak menyediakan reasoning effort yang sama atau lebih rendah.",
  );
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} execution plan tidak sah.`);
  }
}
