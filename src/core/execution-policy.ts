import type {
  ModelExecutionMetadata,
  ModelRole,
  ReasoningEffort,
  Verbosity,
} from "../domain/model-execution.js";
import type { ModelProfile } from "../ai/model-profile.js";
import type {
  ExecutionModelTier,
  ModelTier,
} from "../ai/model-policy.js";
import {
  MODEL_ESCALATION_FAILURE_CODES,
  type ModelEscalationFailureCode,
} from "../domain/model-escalation.js";
import {
  PROVIDER_PROMPT_MATERIALS,
  type ProviderPromptMaterial,
} from "../domain/usage-ledger.js";

export type ExecutionWorkClass =
  | "mechanical"
  | "conversation"
  | "agent"
  | "delegated-worker"
  | "safety";

/** Kelas reservasi cumulative budget; model/prompt tidak boleh memilihnya. */
export type ExecutionBudgetClass = "work" | "final";

export interface ExecutionPlan extends ModelExecutionMetadata {
  tier: ModelTier;
  /** Hanya hadir untuk slot eskalasi; accounting tetap memakai ambitious. */
  routeTier?: "toughest";
  workClass: ExecutionWorkClass;
  budgetClass: ExecutionBudgetClass;
  maxOutputTokens: number;
  deadlineMs: number;
  maxSteps: number;
  allowTools: boolean;
  allowDelegation: boolean;
  allowEscalation: boolean;
  escalationReason?: ExecutionEscalationReason;
  routeReason?: "truncation_recovery" | "validator_escalation";
  promptMaterial?: ProviderPromptMaterial;
  sourcePrivacyDomain?: string;
  targetPrivacyDomain?: string;
}

export type ExecutionEscalationReason =
  | "validator_failed"
  | "output_truncated"
  | ModelEscalationFailureCode;

export interface ExecutionPolicyInput {
  tier: ExecutionModelTier;
  role: ModelRole;
  workClass: ExecutionWorkClass;
  profile: ModelProfile | null;
  /** Mechanical call biasanya memasang ceiling sempit secara eksplisit. */
  maxOutputTokens?: number;
  deadlineMs: number;
  maxSteps?: number;
  allowTools?: boolean;
  allowDelegation?: boolean;
  allowEscalation?: boolean;
  escalationReason?: ExecutionEscalationReason;
  routeReason?: "truncation_recovery" | "validator_escalation";
  promptMaterial?: ProviderPromptMaterial;
  sourcePrivacyDomain?: string;
  targetPrivacyDomain?: string;
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
    const maxOutputTokens = outputCeiling(input);
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
    if (input.tier === "toughest") {
      if (
        !allowEscalation || !input.escalationReason ||
        !MODEL_ESCALATION_FAILURE_CODES.has(
          input.escalationReason as ModelEscalationFailureCode,
        ) ||
        (input.role !== "critic" && input.role !== "recovery" &&
          input.role !== "synthesizer") ||
        allowTools || allowDelegation || maxSteps !== 1 ||
        input.routeReason !== "validator_escalation" ||
        input.promptMaterial !== "structured-brief+candidate"
      ) {
        throw new Error(
          "Tier toughest hanya sah untuk eskalasi validator one-shot tanpa tool.",
        );
      }
      validatePrivacyDomain(input.sourcePrivacyDomain, "sourcePrivacyDomain");
      validatePrivacyDomain(input.targetPrivacyDomain, "targetPrivacyDomain");
    } else {
      if (
        input.promptMaterial !== undefined &&
        !(PROVIDER_PROMPT_MATERIALS as ReadonlySet<string>).has(
          input.promptMaterial,
        )
      ) throw new Error("Kelas material prompt execution tidak sah.");
      if (
        input.sourcePrivacyDomain !== undefined ||
        input.targetPrivacyDomain !== undefined ||
        (input.routeReason !== undefined && (
          input.routeReason !== "truncation_recovery" ||
          input.escalationReason !== "output_truncated" ||
          (input.promptMaterial !== "raw" &&
            input.promptMaterial !== "structured-brief")
        ))
      ) throw new Error("Metadata route execution tidak cocok dengan tier biasa.");
    }
    if (
      input.profile?.maxOutputTokens !== null &&
      input.profile?.maxOutputTokens !== undefined &&
      input.maxOutputTokens !== undefined &&
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
      tier: input.tier === "toughest" ? "ambitious" : input.tier,
      ...(input.tier === "toughest" ? { routeTier: "toughest" as const } : {}),
      role: input.role,
      workClass: input.workClass,
      budgetClass: budgetClassFor(input.role),
      requestedEffort,
      effectiveEffort,
      verbosity,
      maxOutputTokens,
      deadlineMs: input.deadlineMs,
      maxSteps,
      allowTools,
      allowDelegation,
      allowEscalation,
      ...(input.escalationReason
        ? { escalationReason: input.escalationReason }
        : {}),
      ...(input.routeReason ? { routeReason: input.routeReason } : {}),
      ...(input.promptMaterial ? { promptMaterial: input.promptMaterial } : {}),
      ...(input.sourcePrivacyDomain
        ? { sourcePrivacyDomain: input.sourcePrivacyDomain }
        : {}),
      ...(input.targetPrivacyDomain
        ? { targetPrivacyDomain: input.targetPrivacyDomain }
        : {}),
    });
  }
}

export const DEFAULT_EXECUTION_POLICY = new ExecutionPolicy();

const GENERAL_OUTPUT_CEILINGS: Readonly<Record<ModelRole, number>> =
  Object.freeze({
    extractor: 2_048,
    classifier: 2_048,
    conversationalist: 8_192,
    planner: 32_768,
    worker: 8_192,
    critic: 4_096,
    synthesizer: 32_768,
    recovery: 32_768,
  });

function outputCeiling(input: ExecutionPolicyInput): number {
  if (input.maxOutputTokens !== undefined) {
    validatePositiveInteger(input.maxOutputTokens, "maxOutputTokens");
    return input.maxOutputTokens;
  }
  const emergencyCeiling = GENERAL_OUTPUT_CEILINGS[input.role];
  const profileCeiling = input.profile?.maxOutputTokens;
  return profileCeiling === null || profileCeiling === undefined
    ? emergencyCeiling
    : Math.min(emergencyCeiling, profileCeiling);
}

function budgetClassFor(role: ModelRole): ExecutionBudgetClass {
  switch (role) {
    case "conversationalist":
    case "synthesizer":
    case "recovery":
      return "final";
    case "extractor":
    case "classifier":
    case "planner":
    case "worker":
    case "critic":
      return "work";
  }
}

function requestedEffortFor(
  role: ModelRole,
  tier: ExecutionModelTier,
): ReasoningEffort {
  switch (role) {
    case "extractor":
    case "classifier":
      return "low";
    case "critic":
      return tier === "toughest" ? "high" : tier === "cheap" ? "low" : "medium";
    case "conversationalist":
      return tier === "ambitious" ? "high" : tier === "efficient" ? "medium" : "low";
    case "planner":
      return tier === "ambitious" ? "medium" : "low";
    case "worker":
      return tier === "efficient" ? "medium" : "low";
    case "synthesizer":
      return tier === "toughest"
        ? "max"
        : tier === "ambitious" ? "high" : "medium";
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

function validatePrivacyDomain(value: string | undefined, label: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(value)
  ) throw new Error(`${label} execution plan tidak sah.`);
}
