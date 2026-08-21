import type { Cohort, ModelPriceRates } from "./control-plane.js";
import type { AiPurpose, UsageDeliveryScope, UsageTier } from "./telemetry.js";

/**
 * Harvy Compute v1 memakai nano-USD sebagai unit fixed-point internal.
 * Unit ini bukan uang pengguna dan tidak ditampilkan sebagai saldo imajiner.
 */
export type ComputeUnitVersion = 1;
export type ComputeAmount = string;

export type FundingSource =
  | "included"
  | "sponsored"
  | "wallet"
  | "byok"
  | "safety_exempt";

export type RevenueSource =
  | "subscription"
  | "payg"
  | "contribution"
  | "service_fee"
  | "marketplace_fee"
  | "enterprise"
  | "sponsor";

export interface PlanComputePolicy {
  unitVersion: ComputeUnitVersion;
  /** Allowance per periode. String decimal menjaga integer di JSON. */
  includedComputeUnits: ComputeAmount;
  billingPeriodDays: number;
  /** Ceiling anti-abuse pendek yang terpisah dari allowance periode. */
  rollingWindowHours: number;
  rollingComputeLimit: ComputeAmount;
  /** Menjelaskan interpretasi record lama tanpa mengubah record tersebut. */
  legacyTokenOverlay: {
    schemaVersion: 1;
    computeUnitsPerToken: ComputeAmount;
  };
}

export type SubscriptionStatus =
  | "none"
  | "trial"
  | "free"
  | "active"
  | "past_due"
  | "cancel_at_period_end"
  | "cancelled"
  | "expired";

export interface Subscription {
  subscriptionId: string;
  subjectRef: string;
  planId: string;
  planVersionId: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  lastEventAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingPeriod {
  periodId: string;
  subjectRef: string;
  planId: string;
  planVersionId: string;
  unitVersion: ComputeUnitVersion;
  startsAt: string;
  endsAt: string;
  includedGranted: ComputeAmount;
  includedUsed: ComputeAmount;
  includedReserved: ComputeAmount;
  createdAt: string;
}

/** Domain vocabulary alias: an allowance is the included portion of a period. */
export type ComputeAllowance = BillingPeriod;

export interface SponsoredComputeGrant {
  grantId: string;
  idempotencyKey: string;
  subjectRef: string;
  source: "sponsor" | "commons" | "institution" | "promotion";
  programRef: string;
  unitVersion: ComputeUnitVersion;
  amount: ComputeAmount;
  used: ComputeAmount;
  reserved: ComputeAmount;
  effectiveFrom: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface ComputeQuoteSnapshot {
  estimatorVersion: 1;
  providerId: string;
  modelId: string;
  priceVersionId: string | null;
  priceRates: ModelPriceRates | null;
  /** Digunakan hanya bila katalog harga belum tersedia. */
  unpricedComputeUnitsPerToken: ComputeAmount;
}

export type ReservationStatus =
  | "reserved"
  | "awaiting_delivery"
  | "settled"
  | "released"
  | "expired";

export interface ComputeReservation {
  reservationId: string;
  idempotencyKey: string;
  requestId: string;
  turnId: string | null;
  deliveryScope: UsageDeliveryScope | null;
  subjectRef: string;
  planId: string;
  planVersionId: string;
  cohort: Cohort;
  fundingSource: FundingSource;
  sourceRef: string;
  providerCredentialRef: string | null;
  /**
   * Snapshot kurs internal wallet ketika reservation dibuat. Optional agar
   * record v2 lama tetap terbaca dan nilai rupiah historis tidak bergantung
   * pada konfigurasi deployment yang mungkin berubah kemudian.
   */
  walletComputeUnitsPerIdr?: ComputeAmount | null;
  tier: UsageTier;
  purpose: AiPurpose;
  estimatedComputeUnits: ComputeAmount;
  actualComputeUnits: ComputeAmount | null;
  status: ReservationStatus;
  quote: ComputeQuoteSnapshot;
  reservedAt: string;
  expiresAt: string;
  completedAt: string | null;
  settledAt: string | null;
}

export interface UsageSettlement {
  settlementId: string;
  idempotencyKey: string;
  reservationId: string;
  requestId: string;
  subjectRef: string;
  fundingSource: FundingSource;
  billableComputeUnits: ComputeAmount;
  measuredComputeUnits: ComputeAmount;
  /** Fixed-point nano-rupiah; null pada funding selain wallet atau record lama. */
  walletDebitIdrNanos?: ComputeAmount | null;
  deliveryEffectId: string | null;
  outcome: "charged" | "released" | "safety_exempt";
  settledAt: string;
}

export type WalletTransactionKind = "topup" | "debit" | "release" | "refund";
export type FinancialTransactionStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "refunded"
  | "expired";

export interface WalletTransaction {
  transactionId: string;
  idempotencyKey: string;
  subjectRef: string;
  kind: WalletTransactionKind;
  status: FinancialTransactionStatus;
  /** Signed only for a recorded refund; top-up/debit entries are positive/zero. */
  amountIdr: number;
  computeUnits: ComputeAmount;
  referenceId: string;
  relatedReservationId: string | null;
  createdAt: string;
}

export interface WalletAccountProjection {
  subjectRef: string;
  availableComputeUnits: ComputeAmount;
  reservedComputeUnits: ComputeAmount;
  lifetimeTopupIdr: number;
  updatedAt: string;
}

export type PaymentPurpose = "wallet_topup" | "subscription" | "contribution";
export type SubscriptionPaymentAction = "activate" | "renew";

export interface Payment {
  paymentId: string;
  idempotencyKey: string;
  subjectRef: string;
  gatewayId: string;
  gatewayPaymentRef: string | null;
  purpose: PaymentPurpose;
  /** Hanya terisi untuk subscription checkout; null untuk wallet/contribution. */
  planId?: string | null;
  /** Snapshot katalog yang dibeli; optional hanya untuk membaca record v2 awal. */
  planVersionId?: string | null;
  /**
   * Efek entitlement dibekukan saat checkout dibuat. Field optional menjaga
   * state v2 awal tetap readable; reconciliation pertama akan mengisinya.
   */
  subscriptionAction?: SubscriptionPaymentAction | null;
  status: FinancialTransactionStatus;
  amountIdr: number;
  currency: "IDR";
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contribution {
  contributionId: string;
  idempotencyKey: string;
  subjectRef: string;
  paymentId: string;
  amountIdr: number;
  status: FinancialTransactionStatus;
  fund: "harvy_commons";
  createdAt: string;
  updatedAt: string;
}

export type ProviderCredentialStatus = "active" | "revoked" | "invalid";

/** Metadata saja. Raw secret wajib hidup di SecretStore terpisah. */
export interface ProviderCredentialRef {
  credentialRef: string;
  subjectRef: string;
  providerId: string;
  baseUrl: string;
  modelId: string;
  eligibleTiers: UsageTier[];
  status: ProviderCredentialStatus;
  maskedMetadata: string;
  createdAt: string;
  lastValidatedAt: string | null;
  revokedAt: string | null;
}

export type FundingPreferenceMode = "harvy_first" | "byok_first";

export interface FundingPreference {
  subjectRef: string;
  mode: FundingPreferenceMode;
  autoUseWallet: boolean;
  preferredCredentialRef: string | null;
  updatedAt: string;
}

export type UsageHealth = "healthy" | "getting_low" | "low" | "exhausted";

export interface UsageNotificationState {
  subjectRef: string;
  periodId: string;
  lastHealth: UsageHealth;
  lastNotifiedHealth: UsageHealth | null;
  lastNotifiedAt: string | null;
}

export interface SupportPromptState {
  subjectRef: string;
  deliveredRequests: number;
  activeDays: string[];
  lastPromptedAt: string | null;
  dismissedUntil: string | null;
  contributed: boolean;
}

export interface SubjectUsageProjection {
  subjectRef: string;
  rollingCharges: { at: string; computeUnits: ComputeAmount }[];
  rollingReserved: ComputeAmount;
  successfulDeliveredRequests: number;
  lastDeliveredAt: string | null;
  updatedAt: string;
}

export type EconomyLedgerType =
  | "period_opened"
  | "allowance_granted"
  | "sponsored_grant"
  | "reservation_created"
  | "reservation_completed"
  | "reservation_released"
  | "usage_settled"
  | "wallet_transaction"
  | "payment_state"
  | "subscription_state"
  | "contribution_state"
  | "credential_state"
  | "preference_state"
  | "notification_state"
  | "support_prompt_state"
  | "legacy_overlay_observed";

/** Ledger content-free append-only; projection di atas hanya cache terindeks. */
export interface EconomyLedgerEntry {
  eventId: string;
  idempotencyKey: string;
  type: EconomyLedgerType;
  subjectRef: string;
  source: FundingSource | RevenueSource | "system";
  amountComputeUnits: ComputeAmount;
  amountIdr: number;
  referenceId: string;
  at: string;
}

export interface EconomyState {
  version: 2;
  /** Cutoff captured once when compute v1 is first activated. */
  legacyOverlayCutoffAt?: string | null;
  subscriptions: Subscription[];
  periods: BillingPeriod[];
  sponsoredGrants: SponsoredComputeGrant[];
  reservations: ComputeReservation[];
  settlements: UsageSettlement[];
  walletTransactions: WalletTransaction[];
  walletAccounts: WalletAccountProjection[];
  payments: Payment[];
  contributions: Contribution[];
  credentials: ProviderCredentialRef[];
  preferences: FundingPreference[];
  notifications: UsageNotificationState[];
  supportPrompts: SupportPromptState[];
  usageProjections: SubjectUsageProjection[];
  ledger: EconomyLedgerEntry[];
}

export interface EconomyRepository {
  snapshot(): Promise<EconomyState>;
  mutate<T>(operation: (draft: EconomyState) => T): Promise<T>;
}

export interface ResolvedFundingContext {
  reservationId: string;
  source: FundingSource;
  providerCredentialRef: string | null;
}
