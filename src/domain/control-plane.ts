export type SubjectKind = "private" | "group";
export type SubjectChannel = "telegram" | "whatsapp" | "system";
export type Cohort = "standard" | "beta";
export type PlanAudience = "personal" | "group" | "workspace";
export type PlanStatus = "pilot" | "active" | "retired";
export type GroupRuntimeMode =
  | "direct_only"
  | "ambient"
  | "paused"
  | "disabled";
export type EvaluationConsentStatus =
  | "not_invited"
  | "invited"
  | "granted"
  | "withdrawn"
  | "expired";

export const PERSONAL_PLAN_IDS = {
  free: "personal_perkenalan",
  plus: "personal_toro",
  pro: "personal_sora",
  max: "personal_kuro",
} as const;

const LEGACY_PERSONAL_PLAN_IDS: Readonly<Record<string, string>> = {
  personal_free: PERSONAL_PLAN_IDS.free,
  personal_sprout: PERSONAL_PLAN_IDS.plus,
  personal_bloom: PERSONAL_PLAN_IDS.pro,
  personal_canopy: PERSONAL_PLAN_IDS.max,
};

/** Menyatukan ID katalog sebelum nama publik paket individu diganti. */
export function canonicalPlanId(planId: string): string {
  return LEGACY_PERSONAL_PLAN_IDS[planId] ?? planId;
}

export type ConfiguredModelMode = "testing" | "production";
export type ConfiguredModelOrigin = "primary" | "fallback";
export type ConfiguredModelTier =
  | "cheap"
  | "efficient"
  | "ambitious"
  | "toughest";

/** Inventaris konfigurasi model yang aman ditampilkan tanpa credential. */
export interface ConfiguredModelSource {
  environmentVariable: string;
  mode: ConfiguredModelMode;
  origin: ConfiguredModelOrigin;
  tiers: ConfiguredModelTier[];
  active: boolean;
}

export interface ConfiguredModel {
  providerId: string;
  modelId: string;
  active: boolean;
  sources: ConfiguredModelSource[];
}

export interface PlanVersion {
  id: string;
  planId: string;
  version: number;
  publicName: string;
  audience: PlanAudience;
  monthlyPriceIdr: number;
  rolling24hTokenLimit: number;
  activeMemberLimit: number | null;
  groupMode: "none" | "direct_only" | "ambient" | "workspace";
  status: PlanStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface EvaluationConsent {
  status: EvaluationConsentStatus;
  invitedAt: string | null;
  grantedAt: string | null;
  withdrawnAt: string | null;
  expiresAt: string | null;
}

export interface Enrollment {
  subjectRef: string;
  /** Label pseudonim pilihan operator; tidak pernah diisi otomatis dari platform. */
  operatorLabel: string | null;
  kind: SubjectKind;
  channel: SubjectChannel;
  cohort: Cohort;
  planId: string;
  quotaOverride: number | null;
  betaExpiresAt: string | null;
  groupRuntimeMode: GroupRuntimeMode | null;
  evaluationConsent: EvaluationConsent;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelPriceRates {
  inputPerMillionUsd: string;
  outputPerMillionUsd: string;
  cacheReadPerMillionUsd: string | null;
  cacheWritePerMillionUsd: string | null;
  reasoningPerMillionUsd: string | null;
  perRequestUsd: string | null;
}

export interface ModelPriceVersion {
  id: string;
  providerId: string;
  modelId: string;
  version: number;
  currency: "USD";
  rates: ModelPriceRates;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "pilot" | "active" | "retired";
  createdAt: string;
}

export interface ScopedPrincipal {
  scopeRef: string;
  principalRef: string;
  aliasHashes: string[];
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConsoleAuditAction =
  | "session_login"
  | "session_logout"
  | "enrollment_create"
  | "enrollment_update"
  | "evaluation_invite"
  | "evaluation_revoke"
  | "plan_version_create"
  | "price_version_create"
  | "runtime_mode_update"
  | "unknown_mutation";

export interface ConsoleAuditRecord {
  id: string;
  at: string;
  sessionRef: string;
  action: ConsoleAuditAction;
  targetRef: string | null;
  outcome: "succeeded" | "rejected" | "failed";
  reasonCode: string | null;
}

export interface ControlPlaneState {
  version: 1;
  installationKey: string;
  plans: PlanVersion[];
  prices: ModelPriceVersion[];
  enrollments: Enrollment[];
  principals: ScopedPrincipal[];
  audit: ConsoleAuditRecord[];
}

export interface ControlPlaneRepository {
  snapshot(): Promise<ControlPlaneState>;
  mutate<T>(operation: (draft: ControlPlaneState) => T): Promise<T>;
}
