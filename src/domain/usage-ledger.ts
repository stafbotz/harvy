import type {
  SubjectChannel,
  SubjectKind,
  ModelPriceRates,
} from "./control-plane.js";
import type {
  AiPurpose,
  TokenUsage,
  UsageTier,
} from "./telemetry.js";

export type RuntimeEnvironment = "development" | "staging" | "production";
export type UsageCostCenter = "runtime" | "evaluation" | "probe" | "migration";
export type ProviderOrigin = "primary" | "fallback";

export interface ProviderTokenUsage extends TokenUsage {
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  providerCostUsd: string | null;
  providerGenerationId: string | null;
}

export interface ProviderAttemptStart {
  attemptId: string;
  requestId: string;
  turnId: string | null;
  attemptNo: number;
  ownerId: string;
  subjectKind: SubjectKind;
  channel: SubjectChannel;
  actorAliases: readonly string[];
  providerId: string;
  origin: ProviderOrigin;
  modelId: string;
  tier: UsageTier;
  purpose: AiPurpose;
  environment: RuntimeEnvironment;
  costCenter: UsageCostCenter;
  maxOutputTokens: number;
  inputTokenEstimate: number;
  safetyCritical: boolean;
  startedAt: string;
}

export interface ProviderAttemptFinish {
  finishedAt: string;
  status:
    | "completed"
    | "http_error"
    | "network_error"
    | "timeout"
    | "cancelled"
    | "response_rejected"
    | "unknown";
  httpStatus: number | null;
  responseOutcome:
    | "accepted"
    | "truncated"
    | "empty"
    | "schema_rejected"
    | "not_checked";
  finishReason: string | null;
  latencyMs: number;
  usage: ProviderTokenUsage;
}

export interface ProviderAttemptRecord {
  schemaVersion: 1;
  attemptId: string;
  requestId: string;
  turnId: string | null;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  environment: RuntimeEnvironment;
  costCenter: UsageCostCenter;
  subjectRef: string;
  subjectKind: SubjectKind;
  channel: SubjectChannel;
  actorRef: string | null;
  cohort: "standard" | "beta";
  planId: string;
  providerId: string;
  origin: ProviderOrigin;
  modelId: string;
  tier: UsageTier;
  purpose: AiPurpose;
  maxOutputTokens: number;
  inputTokenEstimate: number;
  safetyCritical: boolean;
  status: "started" | ProviderAttemptFinish["status"];
  httpStatus: number | null;
  responseOutcome: ProviderAttemptFinish["responseOutcome"];
  finishReason: string | null;
  latencyMs: number | null;
  usage: Omit<ProviderTokenUsage, "providerCostUsd" | "providerGenerationId"> & {
    source: "provider" | "estimated" | "none";
  };
  providerGenerationId: string | null;
  priceVersionId: string | null;
  priceSnapshot: ModelPriceRates | null;
  cost: {
    providerReportedUsdNanos: string | null;
    localCalculatedUsdNanos: string | null;
    effectiveUsdNanos: string | null;
    effectiveSource: "provider" | "catalog" | "unpriced";
    reconciliation: "pending" | "matched" | "adjusted" | "unavailable";
  };
}

export interface UsageLedgerFilter {
  since?: string;
  until?: string;
  subjectRef?: string;
  actorRef?: string;
  providerId?: string;
  modelId?: string;
  costCenter?: UsageCostCenter;
  environment?: RuntimeEnvironment;
  cohort?: "standard" | "beta";
  planId?: string;
  limit?: number;
}

export interface UsageLedgerRepository {
  startAttempt(record: ProviderAttemptRecord): Promise<void>;
  finishAttempt(record: ProviderAttemptRecord): Promise<void>;
  attempt(attemptId: string): Promise<ProviderAttemptRecord | null>;
  list(filter?: UsageLedgerFilter): Promise<ProviderAttemptRecord[]>;
  removeBefore(before: Date): Promise<void>;
  removeSubject(subjectRef: string): Promise<void>;
  removeActors(subjectRef: string, actorRefs: readonly string[]): Promise<number>;
}

export interface ProviderAttemptObserver {
  startAttempt(context: ProviderAttemptStart): Promise<void>;
  finishAttempt(
    context: ProviderAttemptStart,
    result: ProviderAttemptFinish,
  ): Promise<void>;
}
