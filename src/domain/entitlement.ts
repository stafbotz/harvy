import type { Cohort } from "./control-plane.js";
import type {
  AiPurpose,
  UsageDeliveryScope,
  UsageTier,
} from "./telemetry.js";

export interface EntitlementDeliveryScope extends UsageDeliveryScope {
  /** Subject pseudonim; identifier platform mentah tidak masuk ledger. */
  subjectRef: string;
}

export interface EntitlementDeliveryReference {
  scope: UsageDeliveryScope;
  effectId: string;
}

export interface EntitlementEntry {
  schemaVersion: 1;
  entryId: string;
  idempotencyKey: string;
  requestId: string;
  turnId: string | null;
  subjectRef: string;
  planId: string;
  cohort: Cohort;
  tier: UsageTier;
  purpose: AiPurpose;
  modelId: string;
  type: "debit" | "included" | "safety_exempt";
  disposition: "charge" | "included_overhead" | "safety_exempt";
  measuredTokens: number;
  debitedTokens: number;
  succeeded: boolean;
  at: string;
  /** Hadir hanya setelah efek final scoped terbukti committed. */
  delivery?: EntitlementDeliveryReference;
}

export interface PendingEntitlementCandidate {
  scope: EntitlementDeliveryScope;
  entry: EntitlementEntry;
}

export type EntitlementDeliveryOutcome = "committed" | "discarded";

export interface EntitlementDeliveryDecision {
  outcome: EntitlementDeliveryOutcome;
  /** Wajib non-null untuk committed; boleh null bila belum pernah ada efek. */
  effectId: string | null;
  settledAt: string;
}

export interface EntitlementDeliverySettlement
extends EntitlementDeliveryDecision {
  scope: EntitlementDeliveryScope;
}

export type EntitlementCandidateStageResult =
  | "staged"
  | "replayed"
  | "committed"
  | "discarded";

export type EntitlementScopeSettlementResult = "settled" | "replayed";

export interface EntitlementLedgerRepository {
  append(entry: EntitlementEntry): Promise<void>;
  /** Atomik terhadap settleScope untuk mencegah late completion resurrect. */
  stageCandidate(
    candidate: PendingEntitlementCandidate,
  ): Promise<EntitlementCandidateStageResult>;
  /** Menulis keputusan terminal dan promote/drop seluruh kandidat secara atomik. */
  settleScope(
    scope: EntitlementDeliveryScope,
    decision: EntitlementDeliveryDecision,
  ): Promise<EntitlementScopeSettlementResult>;
  listPendingScopes(
    subjectRef?: string,
  ): Promise<EntitlementDeliveryScope[]>;
  pendingDebitTokens(subjectRef: string, since: Date): Promise<number>;
  list(subjectRef?: string): Promise<EntitlementEntry[]>;
  removeBefore(before: Date): Promise<void>;
  removeSubject(subjectRef: string): Promise<void>;
}
