import type { Cohort } from "./control-plane.js";
import type { AiPurpose, UsageTier } from "./telemetry.js";

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
}

export interface EntitlementLedgerRepository {
  append(entry: EntitlementEntry): Promise<void>;
  list(subjectRef?: string): Promise<EntitlementEntry[]>;
  removeBefore(before: Date): Promise<void>;
  removeSubject(subjectRef: string): Promise<void>;
}
