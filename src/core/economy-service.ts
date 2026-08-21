import { randomUUID } from "node:crypto";
import type {
  AiUsageContext,
  TokenUsage,
  UsageTier,
} from "../domain/telemetry.js";
import type { ControlPlaneService } from "./control-plane-service.js";
import type {
  ComputeAmount,
  ComputeQuoteSnapshot,
  ComputeReservation,
  EconomyRepository,
  EconomyState,
  FundingPreference,
  FundingPreferenceMode,
  FundingSource,
  Payment,
  ProviderCredentialRef,
  ResolvedFundingContext,
  Subscription,
  SubscriptionPaymentAction,
  SponsoredComputeGrant,
  SubscriptionStatus,
  SubjectUsageProjection,
  UsageHealth,
  UsageSettlement,
  WalletAccountProjection,
} from "../domain/economy.js";
import { PERSONAL_PLAN_IDS } from "../domain/control-plane.js";
import { usdDecimalToNanos, tokenCostNanos } from "./money.js";
import type {
  PaymentGateway,
  PaymentCheckout,
  VerifiedPaymentWebhook,
} from "./payment-gateway.js";
import type { SecretStore } from "./secret-store.js";

const FALLBACK_UNPRICED_UNITS_PER_TOKEN = 1_000n;
const MAX_IDR = 2_000_000_000n;
const DEFAULT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_GETTING_LOW_BPS = 5_000;
const DEFAULT_LOW_BPS = 2_000;
const DEFAULT_NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SUPPORT_MILESTONE = 8;
const MIN_DOWNGRADE_OBSERVATION_BPS = 5_000;
const MAX_ACCOUNTED_TOKENS = 1_000_000_000;
const BILLABLE_PURPOSES = new Set<AiUsageContext["purpose"]>([
  "reply", "agent", "research", "group-reply",
]);

export interface EconomyOptions {
  providerId: string;
  reservationTtlMs?: number;
  paygComputeUnitsPerIdr?: ComputeAmount;
  gettingLowThresholdBps?: number;
  lowThresholdBps?: number;
  notificationCooldownMs?: number;
  supportMilestone?: number;
  paymentGateway?: PaymentGateway;
}

export interface EconomyUsageView {
  subjectRef: string;
  planId: string;
  planName: string;
  subscriptionStatus: SubscriptionStatus;
  periodId: string;
  periodStartsAt: string;
  periodEndsAt: string;
  includedComputeUnits: ComputeAmount;
  usedComputeUnits: ComputeAmount;
  reservedComputeUnits: ComputeAmount;
  remainingIncludedComputeUnits: ComputeAmount;
  sponsoredGrantedComputeUnits: ComputeAmount;
  sponsoredRemainingComputeUnits: ComputeAmount;
  walletComputeUnits: ComputeAmount;
  byokAvailable: boolean;
  health: UsageHealth;
  nextResetAt: string;
  fundingPreference: FundingPreferenceMode;
  autoUseWallet: boolean;
}

export interface EconomyUserUsageAccounting {
  usage: EconomyUsageView;
  settledRequests: {
    requestId: string;
    fundingSource: FundingSource;
  }[];
  /** Fixed-point nano-rupiah; null means a legacy wallet debit lacks a rate snapshot. */
  walletDebitIdrNanos: string | null;
  walletUsed: boolean;
  walletRelevant: boolean;
  currentFunding: {
    source: FundingSource;
    providerId: string | null;
  } | null;
}

export interface UsageNotice {
  health: Exclude<UsageHealth, "healthy">;
  message: string;
  periodEndsAt: string;
}

export interface PlanRecommendation {
  kind: "upgrade" | "downgrade" | "none";
  currentPlanId: string;
  recommendedPlanId: string | null;
  recommendedPublicName: string | null;
  monthlyPriceIdr: number | null;
  reason: "cheapest_suitable" | "lower_actual_usage" | "already_suitable";
}

export interface FundingCredential {
  credentialRef: string;
  providerId: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class FundingUnavailableError extends Error {
  readonly code = "FUNDING_UNAVAILABLE";
  constructor(
    readonly reason:
      | "allowance_exhausted"
      | "wallet_disabled"
      | "wallet_empty"
      | "byok_unavailable"
      | "anti_abuse",
    message = "Tidak ada sumber compute yang tersedia.",
  ) {
    super(message);
    this.name = "FundingUnavailableError";
  }
}

export interface EconomyFundingAuthority {
  reserve(context: AiUsageContext): Promise<ResolvedFundingContext>;
  completeRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean },
  ): Promise<void>;
  settleTurn(ownerId: string, turnId: string | null): Promise<UsageNotice | null>;
  discardTurn(ownerId: string, turnId: string | null): Promise<void>;
  settleDeliveryScope(
    scope: { subjectRef: string; runId: string; attemptId: string },
    outcome: "committed" | "discarded",
    effectId: string | null,
  ): Promise<void>;
  usage(ownerId: string): Promise<EconomyUsageView>;
  forgetOwner(ownerId: string): Promise<void>;
  allowOwner(ownerId: string): Promise<void>;
  drain(): Promise<void>;
}

export class EconomyService implements EconomyFundingAuthority {
  private readonly reservationTtlMs: number;
  private readonly paygComputeUnitsPerIdr: bigint;
  readonly gettingLowThresholdBps: number;
  readonly lowThresholdBps: number;
  private readonly notificationCooldownMs: number;
  private readonly supportMilestone: number;
  private readonly gateway: PaymentGateway | null;
  private legacyTokenUsageProvider:
    ((ownerId: string, since: Date, until?: Date) => Promise<number>) | null = null;
  private credentialAvailabilityProvider:
    ((credentialRef: string) => Promise<boolean>) | null = null;

  get secureByokSetupAvailable(): boolean {
    return this.secretStore !== null;
  }

  constructor(
    private readonly repository: EconomyRepository,
    private readonly controlPlane: ControlPlaneService,
    private readonly options: EconomyOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly secretStore: SecretStore | null = null,
  ) {
    this.reservationTtlMs = positiveInt(
      options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
      "reservationTtlMs",
    );
    this.paygComputeUnitsPerIdr = positiveBigInt(
      options.paygComputeUnitsPerIdr ?? "1000000",
      "paygComputeUnitsPerIdr",
    );
    this.gettingLowThresholdBps = boundedBps(
      options.gettingLowThresholdBps ?? DEFAULT_GETTING_LOW_BPS,
    );
    this.lowThresholdBps = boundedBps(options.lowThresholdBps ?? DEFAULT_LOW_BPS);
    if (this.lowThresholdBps > this.gettingLowThresholdBps) {
      throw new Error("Threshold usage rendah tidak boleh melebihi getting-low.");
    }
    this.notificationCooldownMs = positiveInt(
      options.notificationCooldownMs ?? DEFAULT_NOTIFICATION_COOLDOWN_MS,
      "notificationCooldownMs",
    );
    this.supportMilestone = positiveInt(
      options.supportMilestone ?? DEFAULT_SUPPORT_MILESTONE,
      "supportMilestone",
    );
    this.gateway = options.paymentGateway ?? null;
    if (secretStore) {
      this.credentialAvailabilityProvider = (credentialRef) =>
        this.credentialAvailable(credentialRef);
    }
  }

  setLegacyTokenUsageProvider(
    provider: (ownerId: string, since: Date, until?: Date) => Promise<number>,
  ): void {
    this.legacyTokenUsageProvider = provider;
  }

  setCredentialAvailabilityProvider(
    provider: (credentialRef: string) => Promise<boolean>,
  ): void {
    this.credentialAvailabilityProvider = provider;
  }

  async reserve(context: AiUsageContext): Promise<ResolvedFundingContext> {
    validateOpaqueId(context.requestId, "requestId");
    const owner = await this.ownerContext(context.ownerId);
    const quote = await this.quote(context, owner.at);
    const estimated = estimateQuote(
      quote,
      boundedTokenCount(context.inputTokenEstimate, "inputTokenEstimate"),
      boundedTokenCount(context.maxTokens, "maxTokens"),
    );
    const usableByok = await this.usableCredentials(owner.subjectRef, context.tier);
    const anyByokAvailable = usableByok.length > 0
      ? true
      : await this.hasUsableCredential(owner.subjectRef);
    const legacyCutoff = await this.ensureLegacyOverlayCutoff(owner.at);
    const legacySince = new Date(
      owner.at.getTime() - owner.policy.rollingWindowHours * 60 * 60 * 1_000,
    );
    // The overlay is only needed while records written before economy v1 can
    // still fall inside the rolling anti-abuse window. Once that cutoff has
    // aged out, normal requests avoid scanning the legacy ledger entirely.
    const legacyTokens = this.legacyTokenUsageProvider &&
      legacyCutoff !== undefined && legacyCutoff.getTime() > legacySince.getTime()
      ? await this.legacyTokenUsageProvider(context.ownerId, legacySince, legacyCutoff)
      : 0;

    return this.repository.mutate((state) => {
      recoverExpiredReservations(state, owner.at);
      const period = ensurePeriod(state, owner, this.now);
      const preference = ensurePreference(state, owner.subjectRef, owner.at);
      const projection = ensureUsageProjection(state, owner.subjectRef, owner.at);
      pruneRolling(projection, owner.policy.rollingWindowHours, owner.at);
      const existing = state.reservations.find(
        (item) => item.idempotencyKey === context.requestId,
      );
      if (existing) {
        if (existing.subjectRef !== owner.subjectRef) {
          throw new Error("Idempotency request ekonomi bertabrakan dengan subject lain.");
        }
        if (existing.status === "reserved" || existing.status === "awaiting_delivery") {
          return {
            reservationId: existing.reservationId,
            source: existing.fundingSource,
            providerCredentialRef: existing.providerCredentialRef,
          };
        }
        if (existing.status === "settled") {
          return {
            reservationId: existing.reservationId,
            source: existing.fundingSource,
            providerCredentialRef: existing.providerCredentialRef,
          };
        }
        throw new FundingUnavailableError("allowance_exhausted");
      }

      const legacyOverlay = BigInt(Math.max(0, Math.floor(legacyTokens))) *
        BigInt(owner.policy.legacyTokenOverlay.computeUnitsPerToken);
      const rollingUsed = sumAmounts(
        projection.rollingCharges.map((item) => item.computeUnits),
      ) + BigInt(projection.rollingReserved) + legacyOverlay;
      const estimatedBig = BigInt(estimated);
      if (
        !context.safetyCritical &&
        BigInt(owner.policy.rollingComputeLimit) > 0n &&
        rollingUsed + estimatedBig > BigInt(owner.policy.rollingComputeLimit)
      ) {
        throw new FundingUnavailableError("anti_abuse", "Batas pemakaian singkat Harvy tercapai.");
      }

      let source: FundingSource | null = context.safetyCritical ? "safety_exempt" : null;
      let sourceRef = "safety";
      let credentialRef: string | null = null;
      const byokFirst = preference.mode === "byok_first";
      const selectByok = (): boolean => {
        const candidate = usableByok
          .filter((item) => item.credentialRef === preference.preferredCredentialRef)
          .concat(usableByok.filter((item) => item.credentialRef !== preference.preferredCredentialRef));
        const selected = candidate[0];
        if (!selected) return false;
        source = "byok";
        sourceRef = selected.credentialRef;
        credentialRef = selected.credentialRef;
        return true;
      };
      const includedAvailable = BigInt(period.includedGranted) -
        BigInt(period.includedUsed) - BigInt(period.includedReserved);
      const sponsored = availableSponsored(state, owner.subjectRef, owner.at);
      const wallet = state.walletAccounts.find((item) => item.subjectRef === owner.subjectRef);
      const walletAvailable = BigInt(wallet?.availableComputeUnits ?? "0");
      const chooseIncluded = (): boolean => {
        if (includedAvailable < estimatedBig) return false;
        source = "included";
        sourceRef = period.periodId;
        return true;
      };
      const chooseSponsored = (): boolean => {
        const grant = sponsored.find((item) => BigInt(item.amount) - BigInt(item.used) - BigInt(item.reserved) >= estimatedBig);
        if (!grant) return false;
        source = "sponsored";
        sourceRef = grant.grantId;
        return true;
      };
      const chooseWallet = (): boolean => {
        if (!preference.autoUseWallet || walletAvailable < estimatedBig) return false;
        source = "wallet";
        sourceRef = owner.subjectRef;
        return true;
      };

      if (byokFirst) selectByok();
      if (source === null) chooseIncluded();
      if (source === null) chooseSponsored();
      if (source === null) chooseWallet();
      if (source === null && !byokFirst) selectByok();
      if (source === null) {
        if (!preference.autoUseWallet && walletAvailable >= estimatedBig) {
          throw new FundingUnavailableError("wallet_disabled", "Saldo PAYG tersedia, tetapi penggunaan otomatis belum diizinkan.");
        }
        if (!anyByokAvailable) {
          throw new FundingUnavailableError("allowance_exhausted");
        }
        throw new FundingUnavailableError("byok_unavailable");
      }

      // Selection helpers mutate `source`; capture the proven non-null value
      // once so TypeScript does not retain the initial safety-only narrowing.
      const selectedSource = source as FundingSource;
      const reservation: ComputeReservation = {
        reservationId: `reservation_${shortId()}`,
        idempotencyKey: context.requestId,
        requestId: context.requestId,
        turnId: context.turnId,
        deliveryScope: context.deliveryScope ?? null,
        subjectRef: owner.subjectRef,
        planId: owner.plan.planId,
        planVersionId: owner.plan.id,
        cohort: owner.effectiveCohort,
        fundingSource: selectedSource,
        sourceRef,
        providerCredentialRef: credentialRef,
        walletComputeUnitsPerIdr: selectedSource === "wallet"
          ? this.paygComputeUnitsPerIdr.toString()
          : null,
        tier: context.tier,
        purpose: context.purpose,
        estimatedComputeUnits: estimated,
        actualComputeUnits: null,
        status: "reserved",
        quote,
        reservedAt: owner.at.toISOString(),
        expiresAt: new Date(owner.at.getTime() + this.reservationTtlMs).toISOString(),
        completedAt: null,
        settledAt: null,
      };
      applyReservation(state, reservation, period, sponsored, wallet);
      state.reservations.push(reservation);
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `reservation:${reservation.reservationId}`,
        type: "reservation_created",
        subjectRef: owner.subjectRef,
        source: selectedSource,
        amountComputeUnits: estimated,
        amountIdr: 0,
        referenceId: reservation.reservationId,
        at: owner.at.toISOString(),
      });
      return {
        reservationId: reservation.reservationId,
        source: selectedSource,
        providerCredentialRef: credentialRef,
      };
    });
  }

  async completeRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean },
  ): Promise<void> {
    const owner = await this.ownerContext(context.ownerId);
    const at = owner.at;
    await this.repository.mutate((state) => {
      const reservation = state.reservations.find(
        (item) => item.idempotencyKey === context.requestId,
      );
      if (!reservation || reservation.status !== "reserved") return;
      const actual = usageUnknown(usage)
        ? reservation.estimatedComputeUnits
        : actualCompute(reservation.quote, usage);
      const billable = !context.safetyCritical &&
        outcome.succeeded && isBillablePurpose(context.purpose);
      reservation.actualComputeUnits = actual;
      reservation.completedAt = at.toISOString();
      if (!billable) {
        reservation.status = "released";
        releaseReservation(state, reservation, at);
        appendSettlement(
          state,
          reservation,
          context.safetyCritical ? "safety_exempt" : "released",
          "0",
          actual,
          null,
          at,
        );
        return;
      }
      reservation.status = "awaiting_delivery";
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `completion:${reservation.reservationId}`,
        type: "reservation_completed",
        subjectRef: reservation.subjectRef,
        source: reservation.fundingSource,
        amountComputeUnits: actual,
        amountIdr: 0,
        referenceId: reservation.reservationId,
        at: at.toISOString(),
      });
    });
  }

  async settleTurn(ownerId: string, turnId: string | null): Promise<UsageNotice | null> {
    const owner = await this.ownerContext(ownerId);
    return this.repository.mutate((state) => {
      recoverExpiredReservations(state, owner.at);
      const reservations = state.reservations.filter(
        (item) =>
          item.subjectRef === owner.subjectRef &&
          item.turnId === turnId &&
          item.status === "awaiting_delivery",
      );
      if (reservations.length === 0) return null;
      const period = ensurePeriod(state, owner, this.now);
      const before = usageHealthExcludingReservations(
        state,
        owner.subjectRef,
        period,
        owner.at,
        this,
        reservations,
      );
      let effectIndex = 0;
      for (const reservation of reservations) {
        settleReservation(
          state,
          reservation,
          `turn:${owner.subjectRef}:${turnId ?? "none"}:${effectIndex++}`,
          `telegram:${turnId ?? reservation.requestId}`,
          owner.at,
        );
      }
      const projection = ensureUsageProjection(state, owner.subjectRef, owner.at);
      projection.successfulDeliveredRequests += 1;
      projection.lastDeliveredAt = owner.at.toISOString();
      const day = owner.at.toISOString().slice(0, 10);
      const support = ensureSupportPrompt(state, owner.subjectRef);
      support.deliveredRequests += 1;
      if (!support.activeDays.includes(day)) support.activeDays.push(day);
      const after = usageHealth(state, owner.subjectRef, period, owner.at, this);
      return this.noticeForTransition(state, owner.subjectRef, period.periodId, before, after, period.endsAt, owner.at);
    });
  }

  async discardTurn(ownerId: string, turnId: string | null): Promise<void> {
    const owner = await this.ownerContext(ownerId);
    await this.repository.mutate((state) => {
      for (const reservation of state.reservations) {
        if (
          reservation.subjectRef === owner.subjectRef &&
          reservation.turnId === turnId &&
          (reservation.status === "reserved" || reservation.status === "awaiting_delivery")
        ) {
          reservation.status = "released";
          releaseReservation(state, reservation, owner.at);
          appendSettlement(state, reservation, "released", "0", reservation.actualComputeUnits ?? "0", null, owner.at);
        }
      }
    });
  }

  async settleDeliveryScope(
    scope: { subjectRef: string; runId: string; attemptId: string },
    outcome: "committed" | "discarded",
    effectId: string | null,
  ): Promise<void> {
    const ownerAt = this.now();
    await this.repository.mutate((state) => {
      const reservations = state.reservations.filter((item) =>
        item.subjectRef === scope.subjectRef &&
        item.deliveryScope?.runId === scope.runId &&
        item.deliveryScope?.attemptId === scope.attemptId &&
        (item.status === "awaiting_delivery" || item.status === "reserved")
      );
      for (const reservation of reservations) {
        if (outcome === "committed") {
          settleReservation(state, reservation, `scope:${scope.runId}:${scope.attemptId}`, effectId, ownerAt);
        } else {
          reservation.status = "released";
          releaseReservation(state, reservation, ownerAt);
          appendSettlement(state, reservation, "released", "0", reservation.actualComputeUnits ?? "0", effectId, ownerAt);
        }
      }
    });
  }

  async usage(ownerId: string): Promise<EconomyUsageView> {
    const owner = await this.ownerContext(ownerId);
    const byokAvailable = await this.hasUsableCredential(owner.subjectRef);
    return this.repository.mutate((state) => {
      recoverExpiredReservations(state, owner.at);
      const period = ensurePeriod(state, owner, this.now);
      const preference = ensurePreference(state, owner.subjectRef, owner.at);
      const wallet = state.walletAccounts.find((item) => item.subjectRef === owner.subjectRef);
      const sponsored = availableSponsored(state, owner.subjectRef, owner.at);
      const subscription = state.subscriptions.find(
        (item) => item.subjectRef === owner.subjectRef,
      );
      const remaining = BigInt(period.includedGranted) - BigInt(period.includedUsed) - BigInt(period.includedReserved);
      const sponsoredRemaining = sponsored.reduce(
        (sum, grant) => sum + BigInt(grant.amount) - BigInt(grant.used) - BigInt(grant.reserved),
        0n,
      );
      const sponsoredGranted = sponsored.reduce(
        (sum, grant) => sum + BigInt(grant.amount),
        0n,
      );
      return {
        subjectRef: owner.subjectRef,
        planId: owner.plan.planId,
        planName: owner.plan.publicName,
        subscriptionStatus: owner.plan.planId === PERSONAL_PLAN_IDS.free
          ? "free"
          : subscription?.status ?? "active",
        periodId: period.periodId,
        periodStartsAt: period.startsAt,
        periodEndsAt: period.endsAt,
        includedComputeUnits: period.includedGranted,
        usedComputeUnits: period.includedUsed,
        reservedComputeUnits: period.includedReserved,
        remainingIncludedComputeUnits: nonNegative(remaining),
        sponsoredGrantedComputeUnits: sponsoredGranted.toString(),
        sponsoredRemainingComputeUnits: nonNegative(sponsoredRemaining),
        walletComputeUnits: wallet?.availableComputeUnits ?? "0",
        byokAvailable,
        health: healthFromRemaining(
          remaining + sponsoredRemaining,
          BigInt(period.includedGranted) + sponsoredGranted,
          this,
        ),
        nextResetAt: period.endsAt,
        fundingPreference: preference.mode,
        autoUseWallet: preference.autoUseWallet,
      };
    });
  }

  /**
   * Projection content-free untuk dashboard milik pengguna sendiri. Caller
   * hanya memberi ownerId terautentikasi; subjectRef dan request attribution
   * tidak pernah diteruskan ke renderer atau response channel.
   */
  async userUsageAccounting(ownerId: string): Promise<EconomyUserUsageAccounting> {
    const usage = await this.usage(ownerId);
    const credentials = await this.availableCredentials(usage.subjectRef);
    const state = await this.repository.snapshot();
    const periodStart = Date.parse(usage.periodStartsAt);
    const periodEnd = Date.parse(usage.periodEndsAt);
    const settlements = state.settlements.filter((item) => {
      const settledAt = Date.parse(item.settledAt);
      return item.subjectRef === usage.subjectRef &&
        settledAt >= periodStart && settledAt < periodEnd &&
        (item.outcome === "charged" || item.outcome === "safety_exempt");
    });
    // Pertahankan seluruh pasangan agar query consumer dapat gagal tertutup
    // bila state legacy/corrupt mempunyai source berbeda untuk request sama.
    const settledRequests = settlements.map((item) => ({
      requestId: item.requestId,
      fundingSource: item.fundingSource,
    }));
    const walletSettlements = settlements.filter(
      (item) => item.fundingSource === "wallet" && BigInt(item.billableComputeUnits) > 0n,
    );
    const walletDebitIdrNanos = walletSettlements.some(
        (item) => item.walletDebitIdrNanos === undefined || item.walletDebitIdrNanos === null,
      )
      ? null
      : walletSettlements.reduce(
          (sum, item) => sum + BigInt(item.walletDebitIdrNanos ?? "0"),
          0n,
        ).toString();
    const preference = state.preferences.find(
      (item) => item.subjectRef === usage.subjectRef,
    );
    const preferred = credentials.find(
      (item) => item.credentialRef === preference?.preferredCredentialRef,
    ) ?? credentials[0] ?? null;
    const includedAvailable = BigInt(usage.remainingIncludedComputeUnits) > 0n;
    const sponsoredAvailable = BigInt(usage.sponsoredRemainingComputeUnits) > 0n;
    const walletAvailable = BigInt(usage.walletComputeUnits) > 0n;
    const byokFirst = usage.fundingPreference === "byok_first";
    let currentFunding: EconomyUserUsageAccounting["currentFunding"] = null;
    if (byokFirst && preferred) {
      currentFunding = { source: "byok", providerId: preferred.providerId };
    } else if (includedAvailable) {
      currentFunding = { source: "included", providerId: null };
    } else if (sponsoredAvailable) {
      currentFunding = { source: "sponsored", providerId: null };
    } else if (usage.autoUseWallet && walletAvailable) {
      currentFunding = { source: "wallet", providerId: null };
    } else if (preferred) {
      currentFunding = { source: "byok", providerId: preferred.providerId };
    }
    return {
      usage,
      settledRequests,
      walletDebitIdrNanos,
      walletUsed: walletSettlements.length > 0,
      walletRelevant: walletSettlements.length > 0 || walletAvailable || usage.autoUseWallet,
      currentFunding,
    };
  }

  /**
   * Content-free operator view. The normal economy state never contains raw
   * BYOK secrets, but this projection still deliberately exposes only the
   * metadata/ledger fields needed for reconciliation and avoids provider
   * payloads or conversation identifiers.
   */
  async operatorSnapshot(): Promise<{
    version: EconomyState["version"];
    secureByokSetupAvailable: boolean;
    subscriptions: EconomyState["subscriptions"];
    periods: EconomyState["periods"];
    sponsoredGrants: EconomyState["sponsoredGrants"];
    reservations: EconomyState["reservations"];
    settlements: EconomyState["settlements"];
    walletTransactions: EconomyState["walletTransactions"];
    walletAccounts: EconomyState["walletAccounts"];
    payments: (Omit<Payment, "checkoutUrl"> & { checkoutAvailable: boolean })[];
    contributions: EconomyState["contributions"];
    credentials: EconomyState["credentials"];
    preferences: EconomyState["preferences"];
    notifications: EconomyState["notifications"];
    supportPrompts: EconomyState["supportPrompts"];
    usageProjections: EconomyState["usageProjections"];
    ledger: EconomyState["ledger"];
  }> {
    const state = await this.repository.snapshot();
    return {
      version: state.version,
      secureByokSetupAvailable: this.secureByokSetupAvailable,
      subscriptions: structuredClone(state.subscriptions),
      periods: structuredClone(state.periods),
      sponsoredGrants: structuredClone(state.sponsoredGrants),
      reservations: structuredClone(state.reservations),
      settlements: structuredClone(state.settlements),
      walletTransactions: structuredClone(state.walletTransactions),
      walletAccounts: structuredClone(state.walletAccounts),
      payments: state.payments.map(({ checkoutUrl, ...payment }) => ({
        ...structuredClone(payment),
        checkoutAvailable: checkoutUrl !== null,
      })),
      contributions: structuredClone(state.contributions),
      credentials: structuredClone(state.credentials),
      preferences: structuredClone(state.preferences),
      notifications: structuredClone(state.notifications),
      supportPrompts: structuredClone(state.supportPrompts),
      usageProjections: structuredClone(state.usageProjections),
      ledger: structuredClone(state.ledger),
    };
  }

  async recommendPlan(ownerId: string): Promise<PlanRecommendation> {
    const owner = await this.ownerContext(ownerId);
    const view = await this.usage(ownerId);
    const catalogPlans = (await this.controlPlane.plans())
      .filter((plan) =>
        plan.audience === "personal" &&
        plan.status !== "retired" &&
        Date.parse(plan.effectiveFrom) <= owner.at.getTime() &&
        (plan.effectiveTo === null || Date.parse(plan.effectiveTo) > owner.at.getTime())
      )
      .sort((left, right) => left.monthlyPriceIdr - right.monthlyPriceIdr || left.version - right.version);
    const plans = await Promise.all(catalogPlans.map(async (plan) => ({
      plan,
      policy: await this.controlPlane.computePolicyForPlan(
        plan,
        owner.effectiveCohort,
      ),
    })));
    const state = await this.repository.snapshot();
    const used = state.settlements
      .filter((settlement) =>
        settlement.subjectRef === owner.subjectRef &&
        settlement.outcome === "charged" &&
        settlement.fundingSource !== "byok" &&
        settlement.fundingSource !== "safety_exempt" &&
        Date.parse(settlement.settledAt) >= Date.parse(view.periodStartsAt) &&
        Date.parse(settlement.settledAt) < Date.parse(view.periodEndsAt),
      )
      .reduce((sum, settlement) => sum + BigInt(settlement.billableComputeUnits), 0n);
    let suitableEntry = plans.find(({ policy }) =>
      BigInt(policy.includedComputeUnits) >= used
    );
    if (
      suitableEntry?.plan.planId === owner.plan.planId &&
      (view.health === "low" || view.health === "exhausted")
    ) {
      suitableEntry = plans.find(({ policy }) =>
        BigInt(policy.includedComputeUnits) > BigInt(owner.policy.includedComputeUnits)
      );
    }
    const suitable = suitableEntry?.plan;
    if (!suitable || suitable.planId === owner.plan.planId) {
      return {
        kind: "none",
        currentPlanId: owner.plan.planId,
        recommendedPlanId: null,
        recommendedPublicName: null,
        monthlyPriceIdr: null,
        reason: "already_suitable",
      };
    }
    const currentPrice = owner.plan.monthlyPriceIdr;
    if (suitable.monthlyPriceIdr < currentPrice) {
      const periodStart = Date.parse(view.periodStartsAt);
      const periodEnd = Date.parse(view.periodEndsAt);
      const duration = periodEnd - periodStart;
      const observed = Math.max(0, Math.min(duration, owner.at.getTime() - periodStart));
      // A brand-new period with little usage is not evidence of sustained low
      // demand. Wait for a meaningful portion of the period before suggesting
      // a downgrade; upgrade guidance may still react immediately near a cap.
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        observed * 10_000 < duration * MIN_DOWNGRADE_OBSERVATION_BPS
      ) {
        return {
          kind: "none",
          currentPlanId: owner.plan.planId,
          recommendedPlanId: null,
          recommendedPublicName: null,
          monthlyPriceIdr: null,
          reason: "already_suitable",
        };
      }
    }
    return {
      kind: suitable.monthlyPriceIdr < currentPrice ? "downgrade" : "upgrade",
      currentPlanId: owner.plan.planId,
      recommendedPlanId: suitable.planId,
      recommendedPublicName: suitable.publicName,
      monthlyPriceIdr: suitable.monthlyPriceIdr,
      reason: suitable.monthlyPriceIdr < currentPrice ? "lower_actual_usage" : "cheapest_suitable",
    };
  }

  /** Prompt sukarela hanya setelah milestone telemetry non-sensitif tercapai. */
  async supportPrompt(ownerId: string): Promise<string | null> {
    const owner = await this.ownerContext(ownerId);
    return this.repository.mutate((state) => {
      const support = ensureSupportPrompt(state, owner.subjectRef);
      if (
        support.contributed ||
        support.deliveredRequests < this.supportMilestone ||
        (support.dismissedUntil !== null && Date.parse(support.dismissedUntil) > owner.at.getTime())
      ) return null;
      if (support.lastPromptedAt !== null && Date.parse(support.lastPromptedAt) + this.notificationCooldownMs > owner.at.getTime()) return null;
      support.lastPromptedAt = owner.at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `support-prompt:${owner.subjectRef}:${support.lastPromptedAt}`,
        type: "support_prompt_state",
        subjectRef: owner.subjectRef,
        source: "system",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: owner.subjectRef,
        at: support.lastPromptedAt,
      });
      return "Harvy bisa digunakan gratis. Jika kamu mampu dan ingin membantu menjaga akses gratis bagi pengguna lain, kamu dapat memberikan kontribusi sukarela. Kontribusi ini opsional dan tidak memengaruhi kualitas jawaban atau akses Free.";
    });
  }

  async dismissSupport(ownerId: string, cooldownMs = 30 * 24 * 60 * 60 * 1_000): Promise<void> {
    const owner = await this.ownerContext(ownerId);
    await this.repository.mutate((state) => {
      const support = ensureSupportPrompt(state, owner.subjectRef);
      support.dismissedUntil = new Date(owner.at.getTime() + positiveInt(cooldownMs, "support cooldown")).toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `support-dismiss:${owner.subjectRef}:${support.dismissedUntil}`,
        type: "support_prompt_state",
        subjectRef: owner.subjectRef,
        source: "system",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: owner.subjectRef,
        at: owner.at.toISOString(),
      });
    });
  }

  async setFundingPreference(
    ownerId: string,
    patch: { mode?: FundingPreferenceMode; autoUseWallet?: boolean; preferredCredentialRef?: string | null },
  ): Promise<FundingPreference> {
    const owner = await this.ownerContext(ownerId);
    return this.repository.mutate((state) => {
      const preference = ensurePreference(state, owner.subjectRef, owner.at);
      if (patch.mode !== undefined) preference.mode = patch.mode;
      if (patch.autoUseWallet !== undefined) preference.autoUseWallet = patch.autoUseWallet;
      if (patch.preferredCredentialRef !== undefined) preference.preferredCredentialRef = patch.preferredCredentialRef;
      preference.updatedAt = owner.at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `preference:${owner.subjectRef}:${preference.updatedAt}`,
        type: "preference_state",
        subjectRef: owner.subjectRef,
        source: "system",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: owner.subjectRef,
        at: preference.updatedAt,
      });
      return structuredClone(preference);
    });
  }

  async addSponsoredGrant(input: Omit<SponsoredComputeGrant, "grantId" | "used" | "reserved" | "createdAt">): Promise<SponsoredComputeGrant> {
    if (!/^\d+$/u.test(input.amount) || BigInt(input.amount) <= 0n) throw new Error("Grant sponsor harus positif.");
    validateOpaqueId(input.subjectRef, "subjectRef grant sponsor");
    validateOpaqueId(input.idempotencyKey, "idempotency grant sponsor");
    validateOpaqueId(input.programRef, "programRef grant sponsor");
    validateIsoWindow(input.effectiveFrom, input.expiresAt);
    return this.repository.mutate((state) => {
      const existing = state.sponsoredGrants.find((grant) => grant.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (
          existing.subjectRef !== input.subjectRef ||
          existing.source !== input.source ||
          existing.programRef !== input.programRef ||
          existing.unitVersion !== input.unitVersion ||
          existing.amount !== input.amount ||
          existing.effectiveFrom !== input.effectiveFrom ||
          existing.expiresAt !== input.expiresAt
        ) {
          throw new Error("Idempotency grant sponsor sudah terikat pada intent lain.");
        }
        return structuredClone(existing);
      }
      const grant: SponsoredComputeGrant = {
        ...structuredClone(input),
        grantId: `grant_${shortId()}`,
        used: "0",
        reserved: "0",
        createdAt: this.now().toISOString(),
      };
      state.sponsoredGrants.push(grant);
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `grant:${grant.idempotencyKey}`,
        type: "sponsored_grant",
        subjectRef: grant.subjectRef,
        source: "sponsored",
        amountComputeUnits: grant.amount,
        amountIdr: 0,
        referenceId: grant.grantId,
        at: grant.createdAt,
      });
      return structuredClone(grant);
    });
  }

  /** Mark cancellation without removing the current period entitlement. */
  async cancelSubscription(ownerId: string): Promise<Subscription | null> {
    const owner = await this.ownerContext(ownerId);
    return this.repository.mutate((state) => {
      const period = ensurePeriod(state, owner, this.now);
      let subscription = state.subscriptions.find(
        (item) => item.subjectRef === owner.subjectRef,
      );
      if (!subscription) {
        if (owner.plan.planId === "personal_perkenalan") return null;
        subscription = {
          subscriptionId: `subscription_${shortId()}`,
          subjectRef: owner.subjectRef,
          planId: owner.plan.planId,
          planVersionId: owner.plan.id,
          status: "active",
          currentPeriodStart: period.startsAt,
          currentPeriodEnd: period.endsAt,
          cancelAtPeriodEnd: false,
          lastEventAt: owner.at.toISOString(),
          createdAt: owner.at.toISOString(),
          updatedAt: owner.at.toISOString(),
        };
        state.subscriptions.push(subscription);
      }
      if (subscription.status === "cancelled" || subscription.status === "expired") {
        return structuredClone(subscription);
      }
      subscription.cancelAtPeriodEnd = true;
      subscription.status = "cancel_at_period_end";
      subscription.lastEventAt = owner.at.toISOString();
      subscription.updatedAt = owner.at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `subscription-cancel:${subscription.subscriptionId}:${subscription.updatedAt}`,
        type: "subscription_state",
        subjectRef: owner.subjectRef,
        source: "subscription",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: subscription.subscriptionId,
        at: subscription.updatedAt,
      });
      return structuredClone(subscription);
    });
  }

  async activateSubscriptionForTest(input: {
    ownerId: string;
    planId: string;
    idempotencyKey: string;
  }): Promise<Subscription> {
    const owner = await this.ownerContext(input.ownerId);
    const enrollment = await this.controlPlane.enrollmentForOwner(input.ownerId);
    if (enrollment.planId !== input.planId) {
      await this.controlPlane.updateEnrollment(
        enrollment.subjectRef,
        enrollment.version,
        { planId: input.planId },
      );
    }
    const plan = (await this.controlPlane.plans()).find(
      (item) => item.planId === input.planId &&
        item.audience === "personal" &&
        planActiveAt(item, owner.at),
    );
    if (!plan) throw new Error("Paket subscription tidak tersedia.");
    const planPolicy = await this.controlPlane.computePolicyForPlan(
      plan,
      owner.effectiveCohort,
    );
    return this.activateSubscriptionResolved(
      { ...owner, plan, policy: planPolicy },
      input.idempotencyKey,
    );
  }

  /** Same activation primitive for a verified webhook carrying subjectRef. */
  private async activateSubscriptionForSubject(
    subjectRef: string,
    planId: string,
    idempotencyKey: string,
    planVersionId: string | null = null,
  ): Promise<Subscription> {
    const ledgerKey = `subscription-activate:${idempotencyKey}`;
    const existingState = await this.repository.snapshot();
    if (existingState.ledger.some((item) => item.idempotencyKey === ledgerKey)) {
      const existing = existingState.subscriptions.find(
        (item) => item.subjectRef === subjectRef,
      );
      if (!existing) {
        throw new Error("Ledger activation subscription kehilangan projection.");
      }
      return existing;
    }
    const enrollment = await this.controlPlane.enrollmentForSubjectRef(subjectRef);
    const at = this.now();
    const plans = await this.controlPlane.plans();
    const plan = planVersionId
      ? plans.find((item) =>
          item.id === planVersionId &&
          item.planId === planId &&
          item.audience === "personal"
        )
      : plans.find(
          (item) => item.planId === planId &&
            item.audience === "personal" &&
            planActiveAt(item, at),
        );
    if (!plan) throw new Error("Paket subscription tidak tersedia.");
    const effectiveCohort = enrollment.cohort === "beta" &&
      (enrollment.betaExpiresAt === null || enrollment.betaExpiresAt > at.toISOString())
      ? "beta"
      : "standard";
    if (enrollment.planId !== plan.planId) {
      await this.controlPlane.updateEnrollment(
        subjectRef,
        enrollment.version,
        { planId: plan.planId },
      );
    }
    const planPolicy = await this.controlPlane.computePolicyForPlan(plan, effectiveCohort);
    return this.activateSubscriptionResolved(
      {
        ownerId: subjectRef,
        subjectRef,
        effectiveCohort,
        plan,
        policy: planPolicy,
        at,
      },
      idempotencyKey,
    );
  }

  private async activateSubscriptionResolved(
    owner: OwnerContext,
    idempotencyKey: string,
  ): Promise<Subscription> {
    return this.repository.mutate((state) => {
      const ledgerKey = `subscription-activate:${idempotencyKey}`;
      const current = state.subscriptions.find(
        (item) => item.subjectRef === owner.subjectRef,
      );
      if (state.ledger.some((item) => item.idempotencyKey === ledgerKey)) {
        if (!current) {
          throw new Error("Ledger activation subscription kehilangan projection.");
        }
        return structuredClone(current);
      }
      const period = ensurePeriod(
        state,
        owner,
        this.now,
      );
      const subscription: Subscription = current ?? {
        subscriptionId: `subscription_${shortId()}`,
        subjectRef: owner.subjectRef,
        planId: owner.plan.planId,
        planVersionId: owner.plan.id,
        status: "active",
        currentPeriodStart: period.startsAt,
        currentPeriodEnd: period.endsAt,
        cancelAtPeriodEnd: false,
        lastEventAt: owner.at.toISOString(),
        createdAt: owner.at.toISOString(),
        updatedAt: owner.at.toISOString(),
      };
      subscription.planId = owner.plan.planId;
      subscription.planVersionId = owner.plan.id;
      subscription.currentPeriodStart = period.startsAt;
      subscription.currentPeriodEnd = period.endsAt;
      subscription.status = "active";
      subscription.cancelAtPeriodEnd = false;
      subscription.lastEventAt = owner.at.toISOString();
      subscription.updatedAt = owner.at.toISOString();
      if (!current) state.subscriptions.push(subscription);
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: ledgerKey,
        type: "subscription_state",
        subjectRef: owner.subjectRef,
        source: "subscription",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: subscription.subscriptionId,
        at: subscription.updatedAt,
      });
      return structuredClone(subscription);
    });
  }

  /** Production adapter primitive: only a durable successful payment may activate. */
  async activateSubscriptionAfterVerifiedPayment(input: {
    ownerId: string;
    planId: string;
    paymentId: string;
  }): Promise<Subscription> {
    const enrollment = await this.controlPlane.enrollmentForOwner(input.ownerId);
    const payment = (await this.repository.snapshot()).payments.find(
      (item) => item.paymentId === input.paymentId &&
        item.subjectRef === enrollment.subjectRef,
    );
    if (!payment || payment.status !== "succeeded" || payment.purpose !== "subscription" || payment.planId !== input.planId) {
      throw new Error("Subscription hanya dapat diaktifkan dari payment sukses yang cocok.");
    }
    return this.activateSubscriptionForSubject(
      enrollment.subjectRef,
      input.planId,
      `payment-subscription:${payment.gatewayPaymentRef ?? payment.paymentId}`,
      payment.planVersionId ?? null,
    );
  }

  /** Test/local primitive; production callers must present a successful payment. */
  async renewSubscriptionForTest(
    ownerId: string,
    idempotencyKey: string,
  ): Promise<Subscription> {
    const owner = await this.ownerContext(ownerId);
    const currentState = await this.repository.snapshot();
    const currentSubscription = currentState.subscriptions.find(
      (item) => item.subjectRef === owner.subjectRef,
    );
    if (!currentSubscription) throw new Error("Subscription tidak ditemukan.");
    if (currentSubscription.cancelAtPeriodEnd || currentSubscription.status === "cancelled") {
      throw new Error("Subscription sudah dibatalkan pada akhir periode.");
    }
    const catalogPlans = await this.controlPlane.plans();
    const plan = catalogPlans.find(
      (item) => item.id === currentSubscription.planVersionId,
    ) ?? catalogPlans.find(
      (item) => item.planId === currentSubscription.planId && item.status !== "retired",
    );
    if (!plan) throw new Error("Versi paket subscription tidak tersedia.");
    const planPolicy = await this.controlPlane.computePolicyForPlan(
      plan,
      owner.effectiveCohort,
    );
    const enrollment = await this.controlPlane.enrollmentForOwner(ownerId);
    if (enrollment.planId !== currentSubscription.planId) {
      await this.controlPlane.updateEnrollment(
        enrollment.subjectRef,
        enrollment.version,
        { planId: currentSubscription.planId },
      );
    }
    return this.repository.mutate((state) => {
      const subscription = state.subscriptions.find(
        (item) => item.subjectRef === owner.subjectRef,
      );
      if (!subscription) throw new Error("Subscription tidak ditemukan.");
      const ledgerKey = `subscription-renew:${idempotencyKey}`;
      if (state.ledger.some((item) => item.idempotencyKey === ledgerKey)) {
        return structuredClone(subscription);
      }
      if (subscription.cancelAtPeriodEnd || subscription.status === "cancelled") {
        throw new Error("Subscription sudah dibatalkan pada akhir periode.");
      }
      const currentEnd = Date.parse(subscription.currentPeriodEnd);
      const start = Number.isFinite(currentEnd) && currentEnd > owner.at.getTime()
        ? new Date(currentEnd)
        : owner.at;
      const end = new Date(
        start.getTime() + planPolicy.billingPeriodDays * 24 * 60 * 60 * 1_000,
      );
      const period = {
        periodId: `period_${shortId()}`,
        subjectRef: owner.subjectRef,
        planId: subscription.planId,
        planVersionId: subscription.planVersionId,
        unitVersion: planPolicy.unitVersion,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        includedGranted: planPolicy.includedComputeUnits,
        includedUsed: "0",
        includedReserved: "0",
        createdAt: owner.at.toISOString(),
      };
      state.periods.push(period);
      subscription.currentPeriodStart = period.startsAt;
      subscription.currentPeriodEnd = period.endsAt;
      subscription.status = "active";
      subscription.lastEventAt = owner.at.toISOString();
      subscription.updatedAt = owner.at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: ledgerKey,
        type: "subscription_state",
        subjectRef: owner.subjectRef,
        source: "subscription",
        amountComputeUnits: period.includedGranted,
        amountIdr: 0,
        referenceId: subscription.subscriptionId,
        at: subscription.updatedAt,
      });
      return structuredClone(subscription);
    });
  }

  async renewSubscriptionAfterVerifiedPayment(input: {
    ownerId: string;
    paymentId: string;
  }): Promise<Subscription> {
    const enrollment = await this.controlPlane.enrollmentForOwner(input.ownerId);
    const payment = (await this.repository.snapshot()).payments.find(
      (item) => item.paymentId === input.paymentId &&
        item.subjectRef === enrollment.subjectRef,
    );
    if (!payment || payment.status !== "succeeded" || payment.purpose !== "subscription") {
      throw new Error("Subscription hanya dapat diperbarui dari payment sukses.");
    }
    return this.renewSubscriptionForSubject(
      enrollment.subjectRef,
      payment.planId ?? enrollment.planId,
      `payment-renewal:${payment.gatewayPaymentRef ?? payment.paymentId}`,
      payment.planVersionId ?? null,
    );
  }

  private async renewSubscriptionForSubject(
    subjectRef: string,
    planId: string,
    idempotencyKey: string,
    planVersionId: string | null = null,
  ): Promise<Subscription> {
    const ledgerKey = `subscription-renew:${idempotencyKey}`;
    const existingState = await this.repository.snapshot();
    if (existingState.ledger.some((item) => item.idempotencyKey === ledgerKey)) {
      const existing = existingState.subscriptions.find(
        (item) => item.subjectRef === subjectRef,
      );
      if (!existing) {
        throw new Error("Ledger renewal subscription kehilangan projection.");
      }
      return existing;
    }
    const enrollment = await this.controlPlane.enrollmentForSubjectRef(subjectRef);
    const at = this.now();
    const currentState = await this.repository.snapshot();
    const currentSubscription = currentState.subscriptions.find(
      (item) => item.subjectRef === subjectRef,
    );
    if (!currentSubscription) {
      return this.activateSubscriptionForSubject(
        subjectRef,
        planId,
        idempotencyKey,
        planVersionId,
      );
    }
    const catalogPlans = await this.controlPlane.plans();
    const plan = planVersionId
      ? catalogPlans.find((item) =>
          item.id === planVersionId &&
          item.planId === planId &&
          item.audience === "personal"
        )
      : catalogPlans.find(
          (item) => item.planId === planId &&
            item.audience === "personal" &&
            planActiveAt(item, at),
        );
    if (!plan) throw new Error("Versi paket subscription tidak tersedia.");
    const effectiveCohort = enrollment.cohort === "beta" &&
      (enrollment.betaExpiresAt === null || enrollment.betaExpiresAt > at.toISOString())
      ? "beta"
      : "standard";
    const planPolicy = await this.controlPlane.computePolicyForPlan(plan, effectiveCohort);
    return this.repository.mutate((state) => {
      const subscription = state.subscriptions.find((item) => item.subjectRef === subjectRef);
      if (!subscription) throw new Error("Subscription tidak ditemukan.");
      const ledgerKey = `subscription-renew:${idempotencyKey}`;
      if (state.ledger.some((item) => item.idempotencyKey === ledgerKey)) {
        return structuredClone(subscription);
      }
      const preserveCancellation = subscription.cancelAtPeriodEnd ||
        subscription.status === "cancel_at_period_end";
      const currentEnd = Date.parse(subscription.currentPeriodEnd);
      const start = Number.isFinite(currentEnd) && currentEnd > at.getTime()
        ? new Date(currentEnd)
        : at;
      const end = new Date(start.getTime() + planPolicy.billingPeriodDays * 24 * 60 * 60 * 1_000);
      const period = {
        periodId: `period_${shortId()}`,
        subjectRef,
        planId: plan.planId,
        planVersionId: plan.id,
        unitVersion: planPolicy.unitVersion,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        includedGranted: planPolicy.includedComputeUnits,
        includedUsed: "0",
        includedReserved: "0",
        createdAt: at.toISOString(),
      };
      state.periods.push(period);
      subscription.planId = plan.planId;
      subscription.planVersionId = plan.id;
      subscription.currentPeriodStart = period.startsAt;
      subscription.currentPeriodEnd = period.endsAt;
      // A delayed payment callback must not silently undo a cancellation
      // preference recorded while that checkout was pending. The paid period
      // is granted, but renewal remains cancelled at its new period end.
      subscription.status = preserveCancellation ? "cancel_at_period_end" : "active";
      subscription.cancelAtPeriodEnd = preserveCancellation;
      subscription.lastEventAt = at.toISOString();
      subscription.updatedAt = at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: ledgerKey,
        type: "subscription_state",
        subjectRef,
        source: "subscription",
        amountComputeUnits: period.includedGranted,
        amountIdr: 0,
        referenceId: subscription.subscriptionId,
        at: subscription.updatedAt,
      });
      return structuredClone(subscription);
    });
  }

  async createTopupCheckout(
    ownerId: string,
    amountIdr: number,
    idempotencyKey: string,
    returnUrl: string | null = null,
  ): Promise<PaymentCheckout> {
    validateIdr(amountIdr);
    validateOpaqueId(idempotencyKey, "payment idempotency key");
    const safeReturnUrl = cleanReturnUrl(returnUrl);
    if (!this.gateway?.available) throw new FundingUnavailableError("wallet_empty", "Pembayaran langsung belum tersedia pada instalasi ini.");
    const owner = await this.ownerContext(ownerId);
    const existing = (await this.repository.snapshot()).payments.find((payment) => payment.idempotencyKey === idempotencyKey);
    if (existing) assertPaymentIntent(existing, owner.subjectRef, "wallet_topup", amountIdr, null);
    if (existing?.gatewayPaymentRef) {
      return {
        gatewayId: existing.gatewayId,
        gatewayPaymentRef: existing.gatewayPaymentRef,
        checkoutUrl: existing.checkoutUrl,
        status: existing.status === "succeeded" ? "succeeded" : "pending",
      };
    }
    await this.repository.mutate((state) => {
      if (state.payments.some((payment) => payment.idempotencyKey === idempotencyKey)) return;
      const payment: Payment = {
        paymentId: `payment_${shortId()}`,
        idempotencyKey,
        subjectRef: owner.subjectRef,
        gatewayId: this.gateway!.id,
        gatewayPaymentRef: null,
        purpose: "wallet_topup",
        planId: null,
        status: "pending",
        amountIdr,
        currency: "IDR",
        checkoutUrl: null,
        createdAt: owner.at.toISOString(),
        updatedAt: owner.at.toISOString(),
      };
      state.payments.push(payment);
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `payment:${idempotencyKey}:pending`,
        type: "payment_state",
        subjectRef: owner.subjectRef,
        source: "payg",
        amountComputeUnits: "0",
        amountIdr,
        referenceId: payment.paymentId,
        at: payment.createdAt,
      });
    });
    const checkout = await this.gateway.createCheckout({
      idempotencyKey,
      subjectRef: owner.subjectRef,
      purpose: "wallet_topup",
      amountIdr,
      description: "Harvy Compute top-up",
      returnUrl: safeReturnUrl,
      planId: null,
    });
    await this.repository.mutate((state) => {
      const payment = state.payments.find((item) => item.idempotencyKey === idempotencyKey);
      if (!payment) throw new Error("Payment pending hilang.");
      payment.gatewayId = checkout.gatewayId;
      payment.gatewayPaymentRef = checkout.gatewayPaymentRef;
      payment.checkoutUrl = checkout.checkoutUrl;
      payment.status = checkout.status;
      payment.updatedAt = this.now().toISOString();
    });
    return checkout;
  }

  async createContributionCheckout(
    ownerId: string,
    amountIdr: number,
    idempotencyKey: string,
    returnUrl: string | null = null,
  ): Promise<PaymentCheckout> {
    validateIdr(amountIdr);
    validateOpaqueId(idempotencyKey, "payment idempotency key");
    const safeReturnUrl = cleanReturnUrl(returnUrl);
    if (!this.gateway?.available) {
      throw new FundingUnavailableError(
        "wallet_empty",
        "Pembayaran langsung belum tersedia pada instalasi ini.",
      );
    }
    const owner = await this.ownerContext(ownerId);
    const existing = (await this.repository.snapshot()).payments.find(
      (payment) => payment.idempotencyKey === idempotencyKey,
    );
    if (existing) assertPaymentIntent(existing, owner.subjectRef, "contribution", amountIdr, null);
    if (existing?.gatewayPaymentRef) {
      return {
        gatewayId: existing.gatewayId,
        gatewayPaymentRef: existing.gatewayPaymentRef,
        checkoutUrl: existing.checkoutUrl,
        status: existing.status === "succeeded" ? "succeeded" : "pending",
      };
    }
    await this.repository.mutate((state) => {
      if (state.payments.some((payment) => payment.idempotencyKey === idempotencyKey)) return;
      const paymentId = `payment_${shortId()}`;
      state.payments.push({
        paymentId,
        idempotencyKey,
        subjectRef: owner.subjectRef,
        gatewayId: this.gateway!.id,
        gatewayPaymentRef: null,
        purpose: "contribution",
        planId: null,
        status: "pending",
        amountIdr,
        currency: "IDR",
        checkoutUrl: null,
        createdAt: owner.at.toISOString(),
        updatedAt: owner.at.toISOString(),
      });
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `payment:${idempotencyKey}:pending`,
        type: "payment_state",
        subjectRef: owner.subjectRef,
        source: "contribution",
        amountComputeUnits: "0",
        amountIdr,
        referenceId: idempotencyKey,
        at: owner.at.toISOString(),
      });
      state.contributions.push({
        contributionId: `contribution_${shortId()}`,
        idempotencyKey: `contribution:${idempotencyKey}`,
        subjectRef: owner.subjectRef,
        paymentId,
        amountIdr,
        status: "pending",
        fund: "harvy_commons",
        createdAt: owner.at.toISOString(),
        updatedAt: owner.at.toISOString(),
      });
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `contribution:${idempotencyKey}:pending`,
        type: "contribution_state",
        subjectRef: owner.subjectRef,
        source: "contribution",
        amountComputeUnits: "0",
        amountIdr,
        referenceId: paymentId,
        at: owner.at.toISOString(),
      });
    });
    const checkout = await this.gateway.createCheckout({
      idempotencyKey,
      subjectRef: owner.subjectRef,
      purpose: "contribution",
      amountIdr,
      description: "Dukung Harvy / Harvy Commons",
      returnUrl: safeReturnUrl,
      planId: null,
    });
    await this.repository.mutate((state) => {
      const payment = state.payments.find((item) => item.idempotencyKey === idempotencyKey);
      if (!payment) throw new Error("Contribution payment pending hilang.");
      payment.gatewayId = checkout.gatewayId;
      payment.gatewayPaymentRef = checkout.gatewayPaymentRef;
      payment.checkoutUrl = checkout.checkoutUrl;
      payment.status = checkout.status;
      payment.updatedAt = this.now().toISOString();
    });
    return checkout;
  }

  /** Creates a catalog-priced subscription checkout without activating access. */
  async createSubscriptionCheckout(
    ownerId: string,
    planId: string,
    amountIdr: number,
    idempotencyKey: string,
    returnUrl: string | null = null,
  ): Promise<PaymentCheckout> {
    validateIdr(amountIdr);
    validateOpaqueId(idempotencyKey, "payment idempotency key");
    const safeReturnUrl = cleanReturnUrl(returnUrl);
    if (!this.gateway?.available) {
      throw new FundingUnavailableError(
        "wallet_empty",
        "Pembayaran langsung belum tersedia pada instalasi ini.",
      );
    }
    const owner = await this.ownerContext(ownerId);
    const plan = (await this.controlPlane.plans()).find(
      (item) => item.planId === planId &&
        item.audience === "personal" &&
        planActiveAt(item, owner.at),
    );
    if (!plan || plan.monthlyPriceIdr <= 0) {
      throw new Error("Paket subscription tidak tersedia untuk checkout.");
    }
    if (amountIdr !== plan.monthlyPriceIdr) {
      throw new Error("Nilai checkout tidak cocok dengan katalog paket aktif.");
    }
    const economyState = await this.repository.snapshot();
    const existing = economyState.payments.find(
      (payment) => payment.idempotencyKey === idempotencyKey,
    );
    if (existing) assertPaymentIntent(existing, owner.subjectRef, "subscription", amountIdr, plan.planId);
    if (existing?.gatewayPaymentRef) {
      return {
        gatewayId: existing.gatewayId,
        gatewayPaymentRef: existing.gatewayPaymentRef,
        checkoutUrl: existing.checkoutUrl,
        status: existing.status === "succeeded" ? "succeeded" : "pending",
      };
    }
    const subscriptionAction = inferSubscriptionPaymentAction(
      economyState,
      owner.subjectRef,
      owner.at,
    );
    await this.repository.mutate((state) => {
      if (state.payments.some((payment) => payment.idempotencyKey === idempotencyKey)) return;
      state.payments.push({
        paymentId: `payment_${shortId()}`,
        idempotencyKey,
        subjectRef: owner.subjectRef,
        gatewayId: this.gateway!.id,
        gatewayPaymentRef: null,
        purpose: "subscription",
        planId: plan.planId,
        planVersionId: plan.id,
        subscriptionAction,
        status: "pending",
        amountIdr,
        currency: "IDR",
        checkoutUrl: null,
        createdAt: owner.at.toISOString(),
        updatedAt: owner.at.toISOString(),
      });
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `payment:${idempotencyKey}:pending`,
        type: "payment_state",
        subjectRef: owner.subjectRef,
        source: "subscription",
        amountComputeUnits: "0",
        amountIdr,
        referenceId: idempotencyKey,
        at: owner.at.toISOString(),
      });
    });
    const checkout = await this.gateway.createCheckout({
      idempotencyKey,
      subjectRef: owner.subjectRef,
      purpose: "subscription",
      planId: plan.planId,
      amountIdr,
      description: `Harvy ${plan.publicName}`,
      returnUrl: safeReturnUrl,
    });
    await this.repository.mutate((state) => {
      const payment = state.payments.find((item) => item.idempotencyKey === idempotencyKey);
      if (!payment) throw new Error("Payment subscription pending hilang.");
      payment.gatewayId = checkout.gatewayId;
      payment.gatewayPaymentRef = checkout.gatewayPaymentRef;
      payment.checkoutUrl = checkout.checkoutUrl;
      payment.status = checkout.status;
      payment.updatedAt = this.now().toISOString();
    });
    return checkout;
  }

  async createSubscriptionCheckoutForPlan(
    ownerId: string,
    planId: string,
    idempotencyKey: string,
    returnUrl: string | null = null,
  ): Promise<PaymentCheckout> {
    const at = this.now();
    const plan = (await this.controlPlane.plans()).find(
      (item) => item.planId === planId &&
        item.audience === "personal" &&
        planActiveAt(item, at),
    );
    if (!plan) throw new Error("Paket subscription tidak tersedia.");
    return this.createSubscriptionCheckout(
      ownerId,
      plan.planId,
      plan.monthlyPriceIdr,
      idempotencyKey,
      returnUrl,
    );
  }

  async applyPaymentWebhook(event: VerifiedPaymentWebhook): Promise<Payment> {
    validatePaymentEvent(event);
    const knownPayment = (await this.repository.snapshot()).payments.some(
      (payment) => payment.gatewayPaymentRef === event.gatewayPaymentRef ||
        payment.idempotencyKey === event.idempotencyKey,
    );
    // A late refund/reconciliation for a previously persisted checkout may be
    // recorded even after an account enrollment was deleted. Unknown payment
    // events still require a live pseudonymous enrollment and are rejected.
    if (!knownPayment) await this.controlPlane.enrollmentForSubjectRef(event.subjectRef);
    const payment = await this.repository.mutate((state) =>
      applyPaymentEvent(state, event, this.paygComputeUnitsPerIdr));
    if (payment.status === "succeeded" && payment.purpose === "subscription") {
      const planId = payment.planId ?? event.planId ?? null;
      if (!planId) throw new Error("Payment subscription tidak mempunyai plan.");
      // Payment state is durable before entitlement activation. A retry after
      // a crash therefore replays this idempotently instead of granting twice.
      const subscriptionAction = await this.resolveSubscriptionPaymentAction(
        payment.paymentId,
        event.receivedAt,
      );
      payment.subscriptionAction = subscriptionAction;
      if (subscriptionAction === "renew") {
        await this.renewSubscriptionForSubject(
          event.subjectRef,
          planId,
          `payment-renewal:${event.gatewayPaymentRef}`,
          payment.planVersionId ?? null,
        );
      } else {
        await this.activateSubscriptionForSubject(
          event.subjectRef,
          planId,
          `payment-subscription:${event.gatewayPaymentRef}`,
          payment.planVersionId ?? null,
        );
      }
    } else if (payment.status === "refunded" && payment.purpose === "subscription") {
      await this.repository.mutate((state) => {
        const subscription = state.subscriptions.find(
          (item) => item.subjectRef === event.subjectRef,
        );
        if (!subscription || subscription.status === "cancelled" || subscription.status === "expired") return;
        subscription.status = "past_due";
        subscription.updatedAt = event.receivedAt;
        subscription.lastEventAt = event.receivedAt;
        appendLedger(state, {
          eventId: `economy_${shortId()}`,
          idempotencyKey: `subscription-refund:${event.gatewayPaymentRef}`,
          type: "subscription_state",
          subjectRef: event.subjectRef,
          source: "subscription",
          amountComputeUnits: "0",
          amountIdr: 0,
          referenceId: subscription.subscriptionId,
          at: event.receivedAt,
        });
      });
    }
    return payment;
  }

  private async resolveSubscriptionPaymentAction(
    paymentId: string,
    receivedAt: string,
  ): Promise<SubscriptionPaymentAction> {
    return this.repository.mutate((state) => {
      const payment = state.payments.find((item) => item.paymentId === paymentId);
      if (!payment || payment.purpose !== "subscription") {
        throw new Error("Payment subscription tidak ditemukan.");
      }
      if (payment.subscriptionAction) return payment.subscriptionAction;
      const activationKey = payment.gatewayPaymentRef
        ? `subscription-activate:payment-subscription:${payment.gatewayPaymentRef}`
        : null;
      const renewalKey = payment.gatewayPaymentRef
        ? `subscription-renew:payment-renewal:${payment.gatewayPaymentRef}`
        : null;
      const priorAction = activationKey && state.ledger.some(
        (entry) => entry.idempotencyKey === activationKey,
      )
        ? "activate"
        : renewalKey && state.ledger.some(
            (entry) => entry.idempotencyKey === renewalKey,
          )
          ? "renew"
          : null;
      const action = priorAction ?? inferSubscriptionPaymentAction(
        state,
        payment.subjectRef,
        new Date(receivedAt),
      );
      payment.subscriptionAction = action;
      return action;
    });
  }

  /** Verifies the gateway boundary before applying any financial mutation. */
  async processPaymentWebhook(
    payload: Uint8Array,
    signature: string,
  ): Promise<Payment> {
    if (!this.gateway?.available) throw new Error("Payment gateway belum dikonfigurasi.");
    const event = await this.gateway.verifyWebhook(payload, signature);
    return this.applyPaymentWebhook(event);
  }

  /** Reconciles a late callback using the gateway's authenticated lookup API. */
  async reconcilePayment(gatewayPaymentRef: string): Promise<Payment | null> {
    if (!this.gateway?.available) return null;
    const event = await this.gateway.lookupPayment(gatewayPaymentRef);
    return event ? this.applyPaymentWebhook(event) : null;
  }

  async refundPayment(
    gatewayPaymentRef: string,
    idempotencyKey: string,
  ): Promise<Payment> {
    if (!this.gateway?.available) throw new Error("Payment gateway belum dikonfigurasi.");
    const event = await this.gateway.refund(gatewayPaymentRef, idempotencyKey);
    return this.applyPaymentWebhook(event);
  }

  async grantWalletForTest(
    ownerId: string,
    amountIdr: number,
    idempotencyKey: string,
    referenceId = idempotencyKey,
  ): Promise<WalletAccountProjection> {
    validateIdr(amountIdr);
    const owner = await this.ownerContext(ownerId);
    return this.repository.mutate((state) => {
      const existing = state.walletTransactions.find((item) => item.idempotencyKey === idempotencyKey);
      const wallet = ensureWallet(state, owner.subjectRef, owner.at);
      if (existing) return structuredClone(wallet);
      const units = (BigInt(amountIdr) * this.paygComputeUnitsPerIdr).toString();
      state.walletTransactions.push({
        transactionId: `wallet_${shortId()}`,
        idempotencyKey,
        subjectRef: owner.subjectRef,
        kind: "topup",
        status: "succeeded",
        amountIdr,
        computeUnits: units,
        referenceId,
        relatedReservationId: null,
        createdAt: owner.at.toISOString(),
      });
      wallet.availableComputeUnits = (BigInt(wallet.availableComputeUnits) + BigInt(units)).toString();
      wallet.lifetimeTopupIdr = addIdrTotal(wallet.lifetimeTopupIdr, amountIdr);
      wallet.updatedAt = owner.at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `wallet:${idempotencyKey}`,
        type: "wallet_transaction",
        subjectRef: owner.subjectRef,
        source: "payg",
        amountComputeUnits: units,
        amountIdr,
        referenceId,
        at: owner.at.toISOString(),
      });
      return structuredClone(wallet);
    });
  }

  async registerCredential(input: {
    ownerId: string;
    providerId: string;
    baseUrl: string;
    modelId: string;
    eligibleTiers: UsageTier[];
    apiKey: string;
  }): Promise<ProviderCredentialRef> {
    const owner = await this.ownerContext(input.ownerId);
    return this.registerCredentialForSubjectResolved({
      ...input,
      subjectRef: owner.subjectRef,
      at: owner.at,
    });
  }

  async registerCredentialForSubject(input: {
    subjectRef: string;
    providerId: string;
    baseUrl: string;
    modelId: string;
    eligibleTiers: UsageTier[];
    apiKey: string;
  }): Promise<ProviderCredentialRef> {
    await this.controlPlane.enrollmentForSubjectRef(input.subjectRef);
    return this.registerCredentialForSubjectResolved({
      ...input,
      at: this.now(),
    });
  }

  private async registerCredentialForSubjectResolved(input: {
    subjectRef: string;
    providerId: string;
    baseUrl: string;
    modelId: string;
    eligibleTiers: UsageTier[];
    apiKey: string;
    at: Date;
  }): Promise<ProviderCredentialRef> {
    if (!this.secretStore) throw new Error("Secure BYOK secret store belum tersedia pada instalasi ini.");
    validateSecret(input.apiKey);
    validateEligibleTiers(input.eligibleTiers);
    const credentialRef = `credential_${shortId()}`;
    await this.secretStore.put(credentialRef, input.apiKey);
    try {
      return await this.repository.mutate((state) => {
        const credential: ProviderCredentialRef = {
          credentialRef,
          subjectRef: input.subjectRef,
          providerId: cleanLabel(input.providerId),
          baseUrl: cleanBaseUrl(input.baseUrl),
          modelId: cleanLabel(input.modelId),
          eligibleTiers: [...new Set(input.eligibleTiers)],
          status: "active",
          maskedMetadata: `••••${input.apiKey.slice(-4)}`,
          createdAt: input.at.toISOString(),
          lastValidatedAt: null,
          revokedAt: null,
        };
        state.credentials.push(credential);
        appendLedger(state, {
          eventId: `economy_${shortId()}`,
          idempotencyKey: `credential:${credentialRef}`,
          type: "credential_state",
          subjectRef: input.subjectRef,
          source: "system",
          amountComputeUnits: "0",
          amountIdr: 0,
          referenceId: credentialRef,
          at: credential.createdAt,
        });
        return structuredClone(credential);
      });
    } catch (error) {
      await this.secretStore.delete(credentialRef).catch(() => undefined);
      throw error;
    }
  }

  async revokeCredential(ownerId: string, credentialRef: string): Promise<void> {
    const owner = await this.ownerContext(ownerId);
    await this.revokeCredentialForSubjectResolved(owner.subjectRef, credentialRef, owner.at);
  }

  async revokeCredentialForSubject(
    subjectRef: string,
    credentialRef: string,
  ): Promise<void> {
    await this.controlPlane.enrollmentForSubjectRef(subjectRef);
    await this.revokeCredentialForSubjectResolved(
      subjectRef,
      credentialRef,
      this.now(),
    );
  }

  private async revokeCredentialForSubjectResolved(
    subjectRef: string,
    credentialRef: string,
    at: Date,
  ): Promise<void> {
    await this.repository.mutate((state) => {
      const credential = state.credentials.find(
        (item) => item.credentialRef === credentialRef && item.subjectRef === subjectRef,
      );
      if (!credential) return;
      credential.status = "revoked";
      credential.revokedAt = at.toISOString();
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `credential-revoke:${credentialRef}`,
        type: "credential_state",
        subjectRef,
        source: "system",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: credentialRef,
        at: at.toISOString(),
      });
    });
    await this.secretStore?.delete(credentialRef);
  }

  async credentialAvailable(credentialRef: string): Promise<boolean> {
    return this.secretStore?.get(credentialRef).then((value) => value !== null) ?? false;
  }

  async credentialForReservation(reservationId: string, ownerId: string): Promise<FundingCredential | null> {
    if (!this.secretStore) return null;
    const owner = await this.ownerContext(ownerId);
    const state = await this.repository.snapshot();
    const reservation = state.reservations.find(
      (item) => item.reservationId === reservationId && item.subjectRef === owner.subjectRef,
    );
    if (
      !reservation?.providerCredentialRef ||
      (reservation.status !== "reserved" && reservation.status !== "awaiting_delivery") ||
      Date.parse(reservation.expiresAt) <= owner.at.getTime()
    ) return null;
    const credential = state.credentials.find(
      (item) => item.credentialRef === reservation.providerCredentialRef && item.subjectRef === owner.subjectRef && item.status === "active",
    );
    if (!credential) return null;
    const apiKey = await this.secretStore.get(credential.credentialRef);
    if (!apiKey) return null;
    return {
      credentialRef: credential.credentialRef,
      providerId: credential.providerId,
      baseUrl: credential.baseUrl,
      modelId: credential.modelId,
      apiKey,
    };
  }

  async forgetOwner(ownerId: string): Promise<void> {
    const subjectRef = await this.controlPlane.subjectRef(ownerId);
    const state = await this.repository.snapshot();
    const refs = state.credentials.filter((item) => item.subjectRef === subjectRef).map((item) => item.credentialRef);
    await this.repository.mutate((draft) => {
      draft.subscriptions = draft.subscriptions.filter((item) => item.subjectRef !== subjectRef);
      draft.periods = draft.periods.filter((item) => item.subjectRef !== subjectRef);
      draft.sponsoredGrants = draft.sponsoredGrants.filter((item) => item.subjectRef !== subjectRef);
      draft.reservations = draft.reservations.filter((item) => item.subjectRef !== subjectRef);
      draft.settlements = draft.settlements.filter((item) => item.subjectRef !== subjectRef);
      draft.walletTransactions = draft.walletTransactions.filter((item) => item.subjectRef !== subjectRef);
      draft.walletAccounts = draft.walletAccounts.filter((item) => item.subjectRef !== subjectRef);
      draft.payments = draft.payments.filter((item) => item.subjectRef !== subjectRef);
      draft.contributions = draft.contributions.filter((item) => item.subjectRef !== subjectRef);
      draft.credentials = draft.credentials.filter((item) => item.subjectRef !== subjectRef);
      draft.preferences = draft.preferences.filter((item) => item.subjectRef !== subjectRef);
      draft.notifications = draft.notifications.filter((item) => item.subjectRef !== subjectRef);
      draft.supportPrompts = draft.supportPrompts.filter((item) => item.subjectRef !== subjectRef);
      draft.usageProjections = draft.usageProjections.filter((item) => item.subjectRef !== subjectRef);
      draft.ledger = draft.ledger.filter((item) => item.subjectRef !== subjectRef);
    });
    for (const ref of refs) await this.secretStore?.delete(ref);
  }

  async allowOwner(_ownerId: string): Promise<void> {
    // Economy data is opened by the next explicit consent/runtime request.
  }

  async drain(): Promise<void> {
    // File repository commits synchronously before each method resolves.
  }

  private async ensureLegacyOverlayCutoff(at: Date): Promise<Date | undefined> {
    if (!this.legacyTokenUsageProvider) return undefined;
    const cutoff = await this.repository.mutate((state) => {
      if (state.legacyOverlayCutoffAt === undefined || state.legacyOverlayCutoffAt === null) {
        state.legacyOverlayCutoffAt = at.toISOString();
      }
      return state.legacyOverlayCutoffAt;
    });
    return cutoff ? new Date(cutoff) : undefined;
  }

  private async ownerContext(ownerId: string): Promise<OwnerContext> {
    let effective = await this.controlPlane.effectiveEnrollment(ownerId);
    await this.reconcileExpiredSubscription(effective.enrollment.subjectRef, effective.enrollment, this.now());
    effective = await this.controlPlane.effectiveEnrollment(ownerId);
    const at = this.now();
    let plan = await this.controlPlane.planVersionForEnrollment(effective.enrollment);
    let policy = await this.controlPlane.computePolicyForEnrollment(
      effective.enrollment,
      effective.effectiveCohort,
      plan,
    );
    if (plan.audience === "personal") {
      const state = await this.repository.snapshot();
      const subscription = state.subscriptions.find(
        (item) => item.subjectRef === effective.enrollment.subjectRef,
      );
      const subscriptionStillEntitled = subscription !== undefined &&
        (subscription.status === "trial" ||
          subscription.status === "active" ||
          subscription.status === "past_due" ||
          subscription.status === "cancel_at_period_end") &&
        Date.parse(subscription.currentPeriodEnd) > at.getTime();
      const catalog = await this.controlPlane.plans();
      if (subscriptionStillEntitled) {
        const activePaidPeriod = state.periods
          .filter((period) =>
            period.subjectRef === effective.enrollment.subjectRef &&
            period.planId !== PERSONAL_PLAN_IDS.free &&
            period.startsAt <= at.toISOString() &&
            period.endsAt > at.toISOString()
          )
          .sort((left, right) =>
            right.startsAt.localeCompare(left.startsAt, "en") ||
            right.createdAt.localeCompare(left.createdAt, "en")
          )[0];
        const entitledVersionId = activePaidPeriod?.planVersionId ??
          subscription.planVersionId;
        const entitledPlanId = activePaidPeriod?.planId ?? subscription.planId;
        const purchasedPlan = catalog.find((candidate) =>
          candidate.id === entitledVersionId &&
          candidate.planId === entitledPlanId &&
          candidate.audience === "personal"
        );
        if (purchasedPlan) {
          plan = purchasedPlan;
          policy = await this.controlPlane.computePolicyForEnrollment(
            effective.enrollment,
            effective.effectiveCohort,
            purchasedPlan,
          );
          if (effective.enrollment.planId !== purchasedPlan.planId) {
            await this.controlPlane.updateEnrollment(
              effective.enrollment.subjectRef,
              effective.enrollment.version,
              { planId: purchasedPlan.planId },
            ).catch(() => undefined);
          }
        }
      } else if (plan.planId !== PERSONAL_PLAN_IDS.free) {
        const freePlan = catalog.find(
          (candidate) => candidate.planId === PERSONAL_PLAN_IDS.free &&
            candidate.audience === "personal" &&
            planActiveAt(candidate, at),
        );
        if (!freePlan) throw new Error("Versi paket Free aktif tidak tersedia.");
        plan = freePlan;
        policy = await this.controlPlane.computePolicyForEnrollment(
          effective.enrollment,
          effective.effectiveCohort,
          freePlan,
        );
      }
    }
    return {
      ownerId,
      subjectRef: effective.enrollment.subjectRef,
      effectiveCohort: effective.effectiveCohort,
      plan,
      policy,
      at,
    };
  }

  private async reconcileExpiredSubscription(
    subjectRef: string,
    enrollment: Awaited<ReturnType<ControlPlaneService["effectiveEnrollment"]>>["enrollment"],
    at: Date,
  ): Promise<void> {
    const state = await this.repository.snapshot();
    const subscription = state.subscriptions.find((item) => item.subjectRef === subjectRef);
    if (!subscription || Date.parse(subscription.currentPeriodEnd) > at.getTime()) return;
    if (subscription.status !== "cancelled" && subscription.status !== "expired") {
      await this.repository.mutate((draft) => {
        const current = draft.subscriptions.find((item) => item.subscriptionId === subscription.subscriptionId);
        if (!current || current.status === "cancelled" || current.status === "expired") return;
        current.status = current.cancelAtPeriodEnd ? "cancelled" : "expired";
        current.cancelAtPeriodEnd = false;
        current.updatedAt = at.toISOString();
        current.lastEventAt = at.toISOString();
        appendLedger(draft, {
          eventId: `economy_${shortId()}`,
          idempotencyKey: `subscription-expired:${current.subscriptionId}:${current.currentPeriodEnd}`,
          type: "subscription_state",
          subjectRef,
          source: "subscription",
          amountComputeUnits: "0",
          amountIdr: 0,
          referenceId: current.subscriptionId,
          at: current.updatedAt,
        });
      });
    }
    // Only downgrade the enrollment that this subscription actually owns. An
    // operator may have changed the plan independently while a webhook was
    // delayed; never overwrite that newer decision.
    const subscriptionPlanIds = new Set([
      subscription.planId,
      ...state.periods
        .filter((period) => period.subjectRef === subjectRef)
        .map((period) => period.planId),
    ]);
    if (
      subscriptionPlanIds.has(enrollment.planId) &&
      enrollment.planId !== PERSONAL_PLAN_IDS.free
    ) {
      try {
        await this.controlPlane.updateEnrollment(
          subjectRef,
          enrollment.version,
          { planId: PERSONAL_PLAN_IDS.free },
        );
      } catch {
        // Another control-plane writer may have already moved the subject;
        // the next request retries reconciliation with the new version.
      }
    }
  }

  private async quote(context: AiUsageContext, at: Date): Promise<ComputeQuoteSnapshot> {
    const price = await this.controlPlane.priceAt(this.options.providerId, context.model, at.toISOString());
    return {
      estimatorVersion: 1,
      providerId: this.options.providerId,
      modelId: context.model,
      priceVersionId: price?.id ?? null,
      priceRates: price?.rates ?? null,
      unpricedComputeUnitsPerToken: FALLBACK_UNPRICED_UNITS_PER_TOKEN.toString(),
    };
  }

  private async availableCredentials(subjectRef: string): Promise<ProviderCredentialRef[]> {
    const state = await this.repository.snapshot();
    const candidates = state.credentials
      .filter((item) => item.subjectRef === subjectRef && item.status === "active")
      .sort((left, right) => left.credentialRef.localeCompare(right.credentialRef, "en"));
    if (!this.credentialAvailabilityProvider) return [];
    const checks = await Promise.all(candidates.map(async (item) => ({
      item,
      available: await this.credentialAvailabilityProvider!(item.credentialRef).catch(() => false),
    })));
    return checks.filter((item) => item.available).map((item) => item.item);
  }

  private async usableCredentials(subjectRef: string, tier: UsageTier): Promise<ProviderCredentialRef[]> {
    return (await this.availableCredentials(subjectRef)).filter(
      (item) => item.eligibleTiers.includes(tier),
    );
  }

  private async hasUsableCredential(subjectRef: string): Promise<boolean> {
    return (await this.availableCredentials(subjectRef)).length > 0;
  }

  private noticeForTransition(
    state: EconomyState,
    subjectRef: string,
    periodId: string,
    before: UsageHealth,
    after: UsageHealth,
    periodEndsAt: string,
    at: Date,
  ): UsageNotice | null {
    const notification = state.notifications.find(
      (item) => item.subjectRef === subjectRef && item.periodId === periodId,
    ) ?? createNotification(state, subjectRef, periodId, before, at);
    notification.lastHealth = after;
    // Notifications describe a worsening capacity transition. Recovery is
    // visible in the usage command but must not create a second unsolicited
    // message or reset the same-cycle cooldown.
    if (after === "healthy" || after === before || healthRank(after) <= healthRank(before)) return null;
    const recentlyNotified = notification.lastNotifiedAt !== null &&
      at.getTime() - Date.parse(notification.lastNotifiedAt) < this.notificationCooldownMs;
    if (recentlyNotified && notification.lastNotifiedHealth === after) return null;
    notification.lastNotifiedHealth = after;
    notification.lastNotifiedAt = at.toISOString();
    appendLedger(state, {
      eventId: `economy_${shortId()}`,
      idempotencyKey: `notification:${subjectRef}:${periodId}:${after}:${notification.lastNotifiedAt}`,
      type: "notification_state",
      subjectRef,
      source: "system",
      amountComputeUnits: "0",
      amountIdr: 0,
      referenceId: periodId,
      at: notification.lastNotifiedAt,
    });
    const isFree = state.periods.find((item) => item.periodId === periodId)?.planId ===
      PERSONAL_PLAN_IDS.free;
    return {
      health: after,
      periodEndsAt,
      message: after === "exhausted"
        ? `${isFree
            ? "Penggunaan gratis Harvy-mu sudah terpakai untuk periode ini."
            : "Kapasitas yang termasuk dalam paketmu sudah terpakai untuk periode ini."}\n\nHarvy membutuhkan compute berbayar untuk melanjutkan pekerjaan baru. Kamu dapat memilih paket yang sesuai, menambah compute, menggunakan akun API/provider milikmu, atau menunggu kapasitas diperbarui. Memory, percakapan, dan pekerjaanmu tetap tersimpan.`
        : after === "low"
          ? `${isFree ? "Penggunaan gratis Harvy-mu" : "Kapasitas paket Harvy-mu"} hampir habis untuk periode ini. Kamu masih bisa menggunakan Harvy seperti biasa; bila penggunaan meningkat, paket, top-up, BYOK, atau reset tersedia.`
          : "Kapasitas Harvy-mu mulai menipis untuk periode ini.",
    };
  }
}

function healthRank(value: UsageHealth): number {
  return value === "healthy" ? 0 : value === "getting_low" ? 1 : value === "low" ? 2 : 3;
}

interface OwnerContext {
  ownerId: string;
  subjectRef: string;
  effectiveCohort: "standard" | "beta";
  plan: Awaited<ReturnType<ControlPlaneService["effectivePlanVersion"]>>;
  policy: Awaited<ReturnType<ControlPlaneService["effectiveComputePolicy"]>>;
  at: Date;
}

function ensurePeriod(state: EconomyState, owner: OwnerContext, now: () => Date): import("../domain/economy.js").BillingPeriod {
  const at = owner.at;
  const current = state.periods.find(
    (period) => period.subjectRef === owner.subjectRef &&
      period.planVersionId === owner.plan.id &&
      period.startsAt <= at.toISOString() && period.endsAt > at.toISOString(),
  );
  if (current) return current;
  const previous = state.periods
    .filter((period) => period.subjectRef === owner.subjectRef)
    .sort((left, right) => right.startsAt.localeCompare(left.startsAt, "en"))[0];
  const periodLengthMs = owner.policy.billingPeriodDays * 24 * 60 * 60 * 1_000;
  let start = at.getTime();
  if (previous && previous.planVersionId === owner.plan.id) {
    const previousEnd = Date.parse(previous.endsAt);
    if (Number.isFinite(previousEnd) && previousEnd <= at.getTime()) {
      // Skip missed periods deterministically. A dormant account receives the
      // current period, not a stale allowance for every period it missed.
      const elapsedPeriods = Math.floor((at.getTime() - previousEnd) / periodLengthMs);
      start = previousEnd + Math.max(0, elapsedPeriods) * periodLengthMs;
    }
  }
  const startIso = new Date(start).toISOString();
  const end = new Date(start + periodLengthMs).toISOString();
  const period = {
    periodId: `period_${shortId()}`,
    subjectRef: owner.subjectRef,
    planId: owner.plan.planId,
    planVersionId: owner.plan.id,
    unitVersion: owner.policy.unitVersion,
    startsAt: startIso,
    endsAt: end,
    includedGranted: owner.policy.includedComputeUnits,
    includedUsed: "0",
    includedReserved: "0",
    createdAt: now().toISOString(),
  };
  state.periods.push(period);
  appendLedger(state, {
    eventId: `economy_${shortId()}`,
    idempotencyKey: `period:${period.periodId}`,
    type: "period_opened",
    subjectRef: owner.subjectRef,
    source: "system",
    amountComputeUnits: period.includedGranted,
    amountIdr: 0,
    referenceId: period.periodId,
    at: period.createdAt,
  });
  return period;
}

function ensurePreference(state: EconomyState, subjectRef: string, at: Date): FundingPreference {
  const current = state.preferences.find((item) => item.subjectRef === subjectRef);
  if (current) return current;
  const created = {
    subjectRef,
    mode: "harvy_first" as const,
    autoUseWallet: false,
    preferredCredentialRef: null,
    updatedAt: at.toISOString(),
  };
  state.preferences.push(created);
  return created;
}

function ensureWallet(state: EconomyState, subjectRef: string, at: Date): WalletAccountProjection {
  const current = state.walletAccounts.find((item) => item.subjectRef === subjectRef);
  if (current) return current;
  const created = {
    subjectRef,
    availableComputeUnits: "0",
    reservedComputeUnits: "0",
    lifetimeTopupIdr: 0,
    updatedAt: at.toISOString(),
  };
  state.walletAccounts.push(created);
  return created;
}

function ensureUsageProjection(state: EconomyState, subjectRef: string, at: Date): SubjectUsageProjection {
  const current = state.usageProjections.find((item) => item.subjectRef === subjectRef);
  if (current) return current;
  const created = {
    subjectRef,
    rollingCharges: [],
    rollingReserved: "0",
    successfulDeliveredRequests: 0,
    lastDeliveredAt: null,
    updatedAt: at.toISOString(),
  };
  state.usageProjections.push(created);
  return created;
}

function ensureSupportPrompt(state: EconomyState, subjectRef: string) {
  const current = state.supportPrompts.find((item) => item.subjectRef === subjectRef);
  if (current) return current;
  const created = {
    subjectRef,
    deliveredRequests: 0,
    activeDays: [],
    lastPromptedAt: null,
    dismissedUntil: null,
    contributed: false,
  };
  state.supportPrompts.push(created);
  return created;
}

function availableSponsored(state: EconomyState, subjectRef: string, at: Date): SponsoredComputeGrant[] {
  return state.sponsoredGrants
    .filter((grant) =>
      grant.subjectRef === subjectRef &&
      grant.effectiveFrom <= at.toISOString() &&
      (grant.expiresAt === null || grant.expiresAt > at.toISOString()) &&
      BigInt(grant.amount) > BigInt(grant.used) + BigInt(grant.reserved),
    )
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom, "en") || left.grantId.localeCompare(right.grantId, "en"));
}

function applyReservation(
  state: EconomyState,
  reservation: ComputeReservation,
  period: import("../domain/economy.js").BillingPeriod,
  sponsored: SponsoredComputeGrant[],
  wallet: WalletAccountProjection | undefined,
): void {
  const amount = BigInt(reservation.estimatedComputeUnits);
  switch (reservation.fundingSource) {
    case "included":
      period.includedReserved = (BigInt(period.includedReserved) + amount).toString();
      break;
    case "sponsored": {
      const grant = sponsored.find((item) => item.grantId === reservation.sourceRef);
      if (!grant) throw new FundingUnavailableError("allowance_exhausted");
      grant.reserved = (BigInt(grant.reserved) + amount).toString();
      break;
    }
    case "wallet": {
      if (!wallet) throw new FundingUnavailableError("wallet_empty");
      wallet.availableComputeUnits = (BigInt(wallet.availableComputeUnits) - amount).toString();
      wallet.reservedComputeUnits = (BigInt(wallet.reservedComputeUnits) + amount).toString();
      wallet.updatedAt = reservation.reservedAt;
      if (!state.walletTransactions.some((item) => item.relatedReservationId === reservation.reservationId && item.kind === "debit")) {
        state.walletTransactions.push({
          transactionId: `wallet_${shortId()}`,
          idempotencyKey: `reservation-debit:${reservation.reservationId}`,
          subjectRef: reservation.subjectRef,
          kind: "debit",
          status: "pending",
          amountIdr: 0,
          computeUnits: reservation.estimatedComputeUnits,
          referenceId: reservation.reservationId,
          relatedReservationId: reservation.reservationId,
          createdAt: reservation.reservedAt,
        });
      }
      break;
    }
    case "byok":
    case "safety_exempt":
      break;
  }
  if (reservation.fundingSource !== "byok" && reservation.fundingSource !== "safety_exempt") {
    const projection = ensureUsageProjection(state, reservation.subjectRef, new Date(reservation.reservedAt));
    projection.rollingReserved = (BigInt(projection.rollingReserved) + amount).toString();
    projection.updatedAt = reservation.reservedAt;
  }
}

function releaseReservation(
  state: EconomyState,
  reservation: ComputeReservation,
  at: Date,
): void {
  const amount = BigInt(reservation.estimatedComputeUnits);
  const period = state.periods.find((item) => item.periodId === reservation.sourceRef);
  const wallet = state.walletAccounts.find((item) => item.subjectRef === reservation.subjectRef);
  const projection = ensureUsageProjection(state, reservation.subjectRef, new Date(reservation.reservedAt));
  if (reservation.fundingSource === "included" && period) {
    period.includedReserved = nonNegative(BigInt(period.includedReserved) - amount);
  } else if (reservation.fundingSource === "sponsored") {
    const grant = state.sponsoredGrants.find((item) => item.grantId === reservation.sourceRef);
    if (grant) grant.reserved = nonNegative(BigInt(grant.reserved) - amount);
  } else if (reservation.fundingSource === "wallet" && wallet) {
    wallet.availableComputeUnits = (BigInt(wallet.availableComputeUnits) + amount).toString();
    wallet.reservedComputeUnits = nonNegative(BigInt(wallet.reservedComputeUnits) - amount);
    wallet.updatedAt = at.toISOString();
    appendWalletLifecycle(state, reservation, "release", amount, "succeeded", at.toISOString());
  }
  if (reservation.fundingSource !== "byok" && reservation.fundingSource !== "safety_exempt") {
    projection.rollingReserved = nonNegative(BigInt(projection.rollingReserved) - amount);
  }
}

function settleReservation(
  state: EconomyState,
  reservation: ComputeReservation,
  idempotencyKey: string,
  effectId: string | null,
  at: Date,
): void {
  if (reservation.status === "settled") return;
  const actual = BigInt(reservation.actualComputeUnits ?? "0");
  const estimated = BigInt(reservation.estimatedComputeUnits);
  const billable = reservation.fundingSource === "byok" || reservation.fundingSource === "safety_exempt"
    ? 0n
    : actual > estimated ? estimated : actual;
  const period = state.periods.find((item) => item.periodId === reservation.sourceRef);
  const wallet = state.walletAccounts.find((item) => item.subjectRef === reservation.subjectRef);
  const projection = ensureUsageProjection(state, reservation.subjectRef, at);
  if (reservation.fundingSource === "included" && period) {
    period.includedReserved = nonNegative(BigInt(period.includedReserved) - estimated);
    period.includedUsed = (BigInt(period.includedUsed) + billable).toString();
  } else if (reservation.fundingSource === "sponsored") {
    const grant = state.sponsoredGrants.find((item) => item.grantId === reservation.sourceRef);
    if (grant) {
      grant.reserved = nonNegative(BigInt(grant.reserved) - estimated);
      grant.used = (BigInt(grant.used) + billable).toString();
    }
  } else if (reservation.fundingSource === "wallet" && wallet) {
    wallet.reservedComputeUnits = nonNegative(BigInt(wallet.reservedComputeUnits) - estimated);
    wallet.availableComputeUnits = (BigInt(wallet.availableComputeUnits) + (estimated - billable)).toString();
    wallet.updatedAt = at.toISOString();
    const settledDebitKey = `settlement-debit:${reservation.reservationId}`;
    if (!state.walletTransactions.some((item) => item.idempotencyKey === settledDebitKey)) {
      state.walletTransactions.push({
        transactionId: `wallet_${shortId()}`,
        idempotencyKey: settledDebitKey,
        subjectRef: reservation.subjectRef,
        kind: "debit",
        status: "succeeded",
        amountIdr: 0,
        computeUnits: billable.toString(),
        referenceId: reservation.reservationId,
        relatedReservationId: reservation.reservationId,
        createdAt: at.toISOString(),
      });
    }
    if (estimated > billable) {
      appendWalletLifecycle(state, reservation, "release", estimated - billable, "succeeded", at.toISOString());
    }
  }
  if (reservation.fundingSource !== "byok" && reservation.fundingSource !== "safety_exempt") {
    projection.rollingReserved = nonNegative(BigInt(projection.rollingReserved) - estimated);
    if (billable > 0n) projection.rollingCharges.push({ at: at.toISOString(), computeUnits: billable.toString() });
  }
  reservation.status = "settled";
  reservation.settledAt = at.toISOString();
  appendSettlement(
    state,
    reservation,
    reservation.fundingSource === "safety_exempt" ? "safety_exempt" : "charged",
    billable.toString(),
    actual.toString(),
    effectId,
    at,
    `${idempotencyKey}:${reservation.reservationId}`,
  );
}

function appendSettlement(
  state: EconomyState,
  reservation: ComputeReservation,
  outcome: "charged" | "released" | "safety_exempt",
  billable: ComputeAmount,
  measured: ComputeAmount,
  effectId: string | null,
  at: Date,
  idempotencyKey = `settlement:${reservation.reservationId}:${outcome}`,
): UsageSettlement {
  const settlementKey = idempotencyKey.includes(reservation.reservationId)
    ? idempotencyKey
    : `${idempotencyKey}:${reservation.reservationId}`;
  const existing = state.settlements.find((item) => item.idempotencyKey === settlementKey);
  if (existing) return existing;
  const settlement: UsageSettlement = {
    settlementId: `settlement_${shortId()}`,
    idempotencyKey: settlementKey,
    reservationId: reservation.reservationId,
    requestId: reservation.requestId,
    subjectRef: reservation.subjectRef,
    fundingSource: reservation.fundingSource,
    billableComputeUnits: billable,
    measuredComputeUnits: measured,
    walletDebitIdrNanos: walletDebitNanos(reservation, billable),
    deliveryEffectId: effectId,
    outcome,
    settledAt: at.toISOString(),
  };
  state.settlements.push(settlement);
  appendLedger(state, {
    eventId: `economy_${shortId()}`,
    idempotencyKey: `ledger:${settlementKey}`,
    type: "usage_settled",
    subjectRef: reservation.subjectRef,
    source: reservation.fundingSource,
    amountComputeUnits: billable,
    amountIdr: 0,
    referenceId: reservation.reservationId,
    at: settlement.settledAt,
  });
  return settlement;
}

function walletDebitNanos(
  reservation: ComputeReservation,
  billable: ComputeAmount,
): ComputeAmount | null {
  if (reservation.fundingSource !== "wallet") return null;
  const rawRate = reservation.walletComputeUnitsPerIdr;
  if (!rawRate || !/^\d+$/u.test(rawRate) || BigInt(rawRate) <= 0n) return null;
  const rate = BigInt(rawRate);
  const nanoRupiah = 1_000_000_000n;
  return ((BigInt(billable) * nanoRupiah + rate / 2n) / rate).toString();
}

function appendLedger(state: EconomyState, entry: import("../domain/economy.js").EconomyLedgerEntry): void {
  if (state.ledger.some((item) => item.idempotencyKey === entry.idempotencyKey)) return;
  state.ledger.push(entry);
}

function appendWalletLifecycle(
  state: EconomyState,
  reservation: ComputeReservation,
  kind: "release" | "refund",
  computeUnits: bigint,
  status: "succeeded" | "pending" | "refunded",
  at: string,
): void {
  const idempotencyKey = `${kind}:${reservation.reservationId}:${computeUnits.toString()}`;
  if (state.walletTransactions.some((item) => item.idempotencyKey === idempotencyKey)) return;
  state.walletTransactions.push({
    transactionId: `wallet_${shortId()}`,
    idempotencyKey,
    subjectRef: reservation.subjectRef,
    kind,
    status,
    amountIdr: 0,
    computeUnits: computeUnits.toString(),
    referenceId: reservation.reservationId,
    relatedReservationId: reservation.reservationId,
    createdAt: at,
  });
  appendLedger(state, {
    eventId: `economy_${shortId()}`,
    idempotencyKey: `wallet-lifecycle:${idempotencyKey}`,
    type: "wallet_transaction",
    subjectRef: reservation.subjectRef,
    source: "payg",
    amountComputeUnits: kind === "refund" ? `-${computeUnits.toString()}` : computeUnits.toString(),
    amountIdr: 0,
    referenceId: reservation.reservationId,
    at,
  });
}

function recoverExpiredReservations(state: EconomyState, at: Date): void {
  for (const reservation of state.reservations) {
    if (
      (reservation.status === "reserved" || reservation.status === "awaiting_delivery") &&
      Date.parse(reservation.expiresAt) <= at.getTime()
    ) {
      reservation.status = "expired";
      releaseReservation(state, reservation, at);
      appendSettlement(state, reservation, "released", "0", reservation.actualComputeUnits ?? "0", null, at, `expired:${reservation.reservationId}`);
    }
  }
}

function usageHealth(
  state: EconomyState,
  subjectRef: string,
  period: import("../domain/economy.js").BillingPeriod,
  at: Date,
  service: EconomyService,
): UsageHealth {
  const grants = availableSponsored(state, subjectRef, at);
  const sponsored = grants.reduce(
    (sum, grant) => sum + BigInt(grant.amount) - BigInt(grant.used) - BigInt(grant.reserved),
    0n,
  );
  const remaining = BigInt(period.includedGranted) - BigInt(period.includedUsed) - BigInt(period.includedReserved) + sponsored;
  const granted = BigInt(period.includedGranted) + grants.reduce(
    (sum, grant) => sum + BigInt(grant.amount),
    0n,
  );
  return healthFromRemaining(remaining, granted, service);
}

function usageHealthExcludingReservations(
  state: EconomyState,
  subjectRef: string,
  period: import("../domain/economy.js").BillingPeriod,
  at: Date,
  service: EconomyService,
  excluded: readonly ComputeReservation[],
): UsageHealth {
  const includedExcluded = excluded
    .filter((item) => item.fundingSource === "included" && item.sourceRef === period.periodId)
    .reduce((sum, item) => sum + BigInt(item.estimatedComputeUnits), 0n);
  const grants = state.sponsoredGrants.filter((grant) =>
    grant.subjectRef === subjectRef &&
    grant.effectiveFrom <= at.toISOString() &&
    (grant.expiresAt === null || grant.expiresAt > at.toISOString())
  );
  let sponsored = grants.reduce(
    (sum, grant) => sum + BigInt(grant.amount) - BigInt(grant.used) - BigInt(grant.reserved),
    0n,
  );
  for (const reservation of excluded) {
    if (reservation.fundingSource === "sponsored" && grants.some((grant) => grant.grantId === reservation.sourceRef)) {
      sponsored += BigInt(reservation.estimatedComputeUnits);
    }
  }
  const remaining = BigInt(period.includedGranted) - BigInt(period.includedUsed) -
    BigInt(period.includedReserved) + includedExcluded + sponsored;
  const granted = BigInt(period.includedGranted) + grants.reduce(
    (sum, grant) => sum + BigInt(grant.amount),
    0n,
  );
  return healthFromRemaining(remaining, granted, service);
}

function healthFromRemaining(
  remaining: bigint,
  granted: bigint,
  service?: EconomyService,
): UsageHealth {
  if (remaining <= 0n) return "exhausted";
  // Sponsored grants are part of the usable compute pool. Callers pass their
  // combined remaining amount, so a zero included grant must not hide a
  // still-valid sponsored allowance.
  const low = BigInt(Math.max(0, service?.lowThresholdBps ?? DEFAULT_LOW_BPS));
  const getting = BigInt(Math.max(0, service?.gettingLowThresholdBps ?? DEFAULT_GETTING_LOW_BPS));
  const denominator = granted > 0n ? granted : remaining;
  const ratioBps = remaining * 10_000n / denominator;
  if (ratioBps <= low) return "low";
  if (ratioBps <= getting) return "getting_low";
  return "healthy";
}

function createNotification(
  state: EconomyState,
  subjectRef: string,
  periodId: string,
  health: UsageHealth,
  at: Date,
) {
  const created = {
    subjectRef,
    periodId,
    lastHealth: health,
    lastNotifiedHealth: null,
    lastNotifiedAt: null,
  };
  state.notifications.push(created);
  return created;
}

function pruneRolling(projection: SubjectUsageProjection, windowHours: number, at: Date): void {
  const threshold = at.getTime() - windowHours * 60 * 60 * 1_000;
  projection.rollingCharges = projection.rollingCharges.filter((item) => Date.parse(item.at) >= threshold);
  projection.updatedAt = at.toISOString();
}

function estimateQuote(quote: ComputeQuoteSnapshot, inputTokens: number, outputTokens: number): ComputeAmount {
  const total = Math.max(0, Math.floor(inputTokens)) + Math.max(0, Math.floor(outputTokens));
  return calculateQuote(quote, Math.max(0, Math.floor(inputTokens)), Math.max(0, Math.floor(outputTokens)), total).toString();
}

function boundedTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ACCOUNTED_TOKENS) {
    throw new Error(`${label} token count tidak sah.`);
  }
  return value;
}

function actualCompute(quote: ComputeQuoteSnapshot, usage: TokenUsage): ComputeAmount {
  const input = boundedTokenCount(usage.inputTokens, "input");
  const output = boundedTokenCount(usage.outputTokens, "output");
  const total = Math.max(input + output, boundedTokenCount(usage.totalTokens, "total"));
  const providerReported = usage.providerCostUsd
    ? usdDecimalToNanos(usage.providerCostUsd)
    : null;
  return calculateQuote(
    quote,
    input,
    output,
    total,
    usage,
    providerReported,
  ).toString();
}

function usageUnknown(usage: TokenUsage): boolean {
  return usage.estimated === true &&
    usage.providerCostUsd == null &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.totalTokens === 0;
}

function calculateQuote(
  quote: ComputeQuoteSnapshot,
  input: number,
  output: number,
  total: number,
  usage: TokenUsage | null = null,
  providerReported: bigint | null = null,
): bigint {
  if (providerReported !== null) return providerReported;
  if (!quote.priceRates) return BigInt(total) * BigInt(quote.unpricedComputeUnitsPerToken);
  const cacheRead = Math.min(input, Math.max(0, Math.floor(usage?.cacheReadTokens ?? 0)));
  const cacheWrite = Math.min(
    input - cacheRead,
    Math.max(0, Math.floor(usage?.cacheWriteTokens ?? 0)),
  );
  const uncachedInput = input - cacheRead - cacheWrite;
  const reasoning = Math.min(output, Math.max(0, Math.floor(usage?.reasoningTokens ?? 0)));
  const regularOutput = output - reasoning;
  const inputCost = tokenCostNanos(uncachedInput, quote.priceRates.inputPerMillionUsd) ?? 0n;
  const cacheReadCost = tokenCostNanos(
    cacheRead,
    quote.priceRates.cacheReadPerMillionUsd ?? quote.priceRates.inputPerMillionUsd,
  ) ?? 0n;
  const cacheWriteCost = tokenCostNanos(
    cacheWrite,
    quote.priceRates.cacheWritePerMillionUsd ?? quote.priceRates.inputPerMillionUsd,
  ) ?? 0n;
  const outputCost = tokenCostNanos(regularOutput, quote.priceRates.outputPerMillionUsd) ?? 0n;
  const reasoningCost = tokenCostNanos(
    reasoning,
    quote.priceRates.reasoningPerMillionUsd ?? quote.priceRates.outputPerMillionUsd,
  ) ?? 0n;
  const requestCost = quote.priceRates.perRequestUsd
    ? usdDecimalToNanos(quote.priceRates.perRequestUsd) ?? 0n
    : 0n;
  return inputCost + cacheReadCost + cacheWriteCost + outputCost + reasoningCost + requestCost;
}

function applyPaymentEvent(state: EconomyState, event: VerifiedPaymentWebhook, unitsPerIdr: bigint): Payment {
  let payment = state.payments.find(
    (item) => item.gatewayPaymentRef === event.gatewayPaymentRef || item.idempotencyKey === event.idempotencyKey,
  );
  if (!payment) {
    // A signed callback is not itself authorization to mint a wallet or plan.
    // The local pending checkout is the intent/amount/subject binding. This
    // also closes forged-webhook and arbitrary-plan enrollment paths.
    throw new Error("Webhook payment tidak mempunyai checkout pending yang cocok.");
  }
  if (
    payment.subjectRef !== event.subjectRef ||
    payment.amountIdr !== event.amountIdr ||
    payment.purpose !== event.purpose ||
    (payment.planId !== undefined &&
      event.planId !== undefined &&
      payment.planId !== event.planId)
  ) {
    throw new Error("Webhook payment tidak cocok dengan payment state.");
  }
  if (payment.gatewayPaymentRef !== null && payment.gatewayPaymentRef !== event.gatewayPaymentRef) {
    throw new Error("Reference gateway payment tidak cocok dengan payment state.");
  }
  if (payment.gatewayPaymentRef === null) payment.gatewayPaymentRef = event.gatewayPaymentRef;
  if (payment.planId === undefined && event.planId !== undefined) {
    payment.planId = event.planId;
  }
  if (
    isTerminalPayment(payment.status) &&
    payment.status !== event.status &&
    !(payment.status === "succeeded" && event.status === "refunded")
  ) {
    const currentAt = Date.parse(payment.updatedAt);
    const eventAt = Date.parse(event.receivedAt);
    // A provider may emit failed/expired before a later successful retry. A
    // newer success is admissible; stale terminal events remain no-ops.
    if (!(event.status === "succeeded" &&
      (payment.status === "failed" || payment.status === "expired") &&
      Number.isFinite(currentAt) && Number.isFinite(eventAt) && eventAt >= currentAt)) {
      return structuredClone(payment);
    }
  }
  payment.status = event.status;
  payment.updatedAt = event.receivedAt;
  if (event.status === "succeeded" && event.purpose === "wallet_topup") {
    const key = `payment-success:${event.gatewayPaymentRef}`;
    if (!state.walletTransactions.some((item) => item.idempotencyKey === key)) {
      const wallet = ensureWallet(state, event.subjectRef, new Date(event.receivedAt));
      const units = (BigInt(event.amountIdr) * unitsPerIdr).toString();
      state.walletTransactions.push({
        transactionId: `wallet_${shortId()}`,
        idempotencyKey: key,
        subjectRef: event.subjectRef,
        kind: "topup",
        status: "succeeded",
        amountIdr: event.amountIdr,
        computeUnits: units,
        referenceId: event.gatewayPaymentRef,
        relatedReservationId: null,
        createdAt: event.receivedAt,
      });
      wallet.availableComputeUnits = (BigInt(wallet.availableComputeUnits) + BigInt(units)).toString();
      wallet.lifetimeTopupIdr = addIdrTotal(
        wallet.lifetimeTopupIdr,
        event.amountIdr,
      );
      wallet.updatedAt = event.receivedAt;
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `wallet-topup:${event.gatewayPaymentRef}`,
        type: "wallet_transaction",
        subjectRef: event.subjectRef,
        source: "payg",
        amountComputeUnits: units,
        amountIdr: event.amountIdr,
        referenceId: event.gatewayPaymentRef,
        at: event.receivedAt,
      });
    }
  }
  if (event.status === "succeeded" && event.purpose === "contribution") {
    const contributionKey = `contribution:${event.gatewayPaymentRef}`;
    let contribution = state.contributions.find((item) => item.paymentId === payment.paymentId) ??
      state.contributions.find((item) => item.idempotencyKey === contributionKey);
    if (contribution) {
      contribution.status = "succeeded";
      contribution.updatedAt = event.receivedAt;
    } else {
      contribution = {
        contributionId: `contribution_${shortId()}`,
        idempotencyKey: contributionKey,
        subjectRef: event.subjectRef,
        paymentId: payment.paymentId,
        amountIdr: event.amountIdr,
        status: "succeeded",
        fund: "harvy_commons",
        createdAt: event.receivedAt,
        updatedAt: event.receivedAt,
      };
      state.contributions.push(contribution);
    }
    const support = ensureSupportPrompt(state, event.subjectRef);
    support.contributed = true;
    appendLedger(state, {
      eventId: `economy_${shortId()}`,
      idempotencyKey: `contribution:${event.gatewayPaymentRef}:succeeded`,
      type: "contribution_state",
      subjectRef: event.subjectRef,
      source: "contribution",
      amountComputeUnits: "0",
      amountIdr: event.amountIdr,
      referenceId: contribution.contributionId,
      at: event.receivedAt,
    });
  }
  if (event.status === "refunded") {
    const originalTopup = state.walletTransactions.find(
      (item) => item.referenceId === event.gatewayPaymentRef && item.kind === "topup",
    );
    if (originalTopup) {
      const refundKey = `refund:${event.gatewayPaymentRef}`;
      if (!state.walletTransactions.some((item) => item.idempotencyKey === refundKey)) {
        const wallet = ensureWallet(state, event.subjectRef, new Date(event.receivedAt));
        const originalUnits = BigInt(originalTopup.computeUnits);
        // Refund/chargeback can race an in-flight wallet-funded request. Free
        // enough reservations to revoke the refunded credit now; otherwise a
        // later failure would release already-refunded compute back to the
        // wallet. The physical provider attempt remains Harvy overhead.
        for (const reservation of state.reservations
          .filter((item) =>
            item.subjectRef === event.subjectRef &&
            item.fundingSource === "wallet" &&
            (item.status === "reserved" || item.status === "awaiting_delivery")
          )
          .sort((left, right) =>
            left.reservedAt.localeCompare(right.reservedAt, "en") ||
            left.reservationId.localeCompare(right.reservationId, "en")
          )) {
          if (BigInt(wallet.availableComputeUnits) >= originalUnits) break;
          reservation.status = "released";
          releaseReservation(state, reservation, new Date(event.receivedAt));
          appendSettlement(
            state,
            reservation,
            "released",
            "0",
            reservation.actualComputeUnits ?? "0",
            null,
            new Date(event.receivedAt),
            `payment-refund:${event.gatewayPaymentRef}:${reservation.reservationId}`,
          );
        }
        const available = BigInt(wallet.availableComputeUnits);
        const revoked = available < BigInt(originalTopup.computeUnits)
          ? available
          : originalUnits;
        // A refund may arrive after part of the prepaid compute was used. Do
        // not manufacture a negative wallet; revoke only the still-available
        // projection and leave already-consumed logical work auditable.
        wallet.availableComputeUnits = nonNegative(available - revoked);
        wallet.updatedAt = event.receivedAt;
        state.walletTransactions.push({
          transactionId: `wallet_${shortId()}`,
          idempotencyKey: refundKey,
          subjectRef: event.subjectRef,
          kind: "refund",
          status: "refunded",
          amountIdr: -originalTopup.amountIdr,
          computeUnits: revoked.toString(),
          referenceId: event.gatewayPaymentRef,
          relatedReservationId: null,
          createdAt: event.receivedAt,
        });
        appendLedger(state, {
          eventId: `economy_${shortId()}`,
          idempotencyKey: `wallet-refund:${event.gatewayPaymentRef}`,
          type: "wallet_transaction",
          subjectRef: event.subjectRef,
          source: "payg",
          amountComputeUnits: `-${revoked.toString()}`,
          amountIdr: -originalTopup.amountIdr,
          referenceId: event.gatewayPaymentRef,
          at: event.receivedAt,
        });
      }
    }
    for (const contribution of state.contributions) {
      if (contribution.paymentId === payment.paymentId) {
        contribution.status = "refunded";
        contribution.updatedAt = event.receivedAt;
        appendLedger(state, {
          eventId: `economy_${shortId()}`,
          idempotencyKey: `contribution:${event.gatewayPaymentRef}:refunded`,
          type: "contribution_state",
          subjectRef: event.subjectRef,
          source: "contribution",
          amountComputeUnits: "0",
          amountIdr: -event.amountIdr,
          referenceId: contribution.contributionId,
          at: event.receivedAt,
        });
      }
    }
  }
  if (
    event.purpose === "contribution" &&
    event.status !== "succeeded" &&
    event.status !== "refunded"
  ) {
    const contribution = state.contributions.find((item) => item.paymentId === payment.paymentId);
    if (contribution) {
      contribution.status = event.status;
      contribution.updatedAt = event.receivedAt;
      appendLedger(state, {
        eventId: `economy_${shortId()}`,
        idempotencyKey: `contribution:${event.gatewayPaymentRef}:${event.status}`,
        type: "contribution_state",
        subjectRef: event.subjectRef,
        source: "contribution",
        amountComputeUnits: "0",
        amountIdr: event.status === "failed" || event.status === "expired" ? 0 : event.amountIdr,
        referenceId: contribution.contributionId,
        at: event.receivedAt,
      });
    }
  }
  appendLedger(state, {
    eventId: `economy_${shortId()}`,
    idempotencyKey: `payment:${event.gatewayPaymentRef}:${event.status}`,
    type: "payment_state",
    subjectRef: event.subjectRef,
    source: event.purpose === "contribution"
      ? "contribution"
      : event.purpose === "subscription"
        ? "subscription"
        : "payg",
    amountComputeUnits: "0",
    amountIdr: event.status === "refunded" ? -event.amountIdr : event.amountIdr,
    referenceId: event.gatewayPaymentRef,
    at: event.receivedAt,
  });
  return structuredClone(payment);
}

function validatePaymentEvent(event: VerifiedPaymentWebhook): void {
  validateIdr(event.amountIdr);
  validateOpaqueId(event.gatewayPaymentRef, "gatewayPaymentRef");
  validateOpaqueId(event.idempotencyKey, "payment idempotency key");
  validateOpaqueId(event.subjectRef, "subjectRef");
  if (!Number.isFinite(Date.parse(event.receivedAt))) {
    throw new Error("Waktu webhook payment tidak sah.");
  }
  if (
    event.status !== "pending" &&
    event.status !== "succeeded" &&
    event.status !== "failed" &&
    event.status !== "refunded" &&
    event.status !== "expired"
  ) {
    throw new Error("Status webhook payment tidak sah.");
  }
  if (event.planId !== undefined && event.planId !== null) {
    validateOpaqueId(event.planId, "planId payment");
  }
}

function assertPaymentIntent(
  payment: Payment,
  subjectRef: string,
  purpose: Payment["purpose"],
  amountIdr: number,
  planId: string | null,
): void {
  if (
    payment.subjectRef !== subjectRef ||
    payment.purpose !== purpose ||
    payment.amountIdr !== amountIdr ||
    (payment.planId ?? null) !== planId
  ) {
    throw new Error("Idempotency payment sudah terikat pada intent lain.");
  }
}

function isTerminalPayment(status: Payment["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "refunded" || status === "expired";
}

function isBillablePurpose(purpose: AiUsageContext["purpose"]): boolean {
  return BILLABLE_PURPOSES.has(purpose);
}

function sumAmounts(values: readonly string[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

function nonNegative(value: bigint): string { return value < 0n ? "0" : value.toString(); }

function positiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} tidak sah.`);
  return value;
}

function positiveBigInt(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value) || BigInt(value) <= 0n) throw new Error(`${label} tidak sah.`);
  return BigInt(value);
}

function boundedBps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error("Threshold bps tidak sah.");
  return value;
}

function validateIdr(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || BigInt(value) > MAX_IDR) throw new Error("Nilai IDR tidak sah.");
}

function addIdrTotal(current: number, amount: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    current > Number.MAX_SAFE_INTEGER - amount
  ) {
    throw new Error("Akumulasi IDR melampaui batas integer aman.");
  }
  return current + amount;
}

function validateSecret(value: string): void {
  if (value.length < 8 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Credential BYOK tidak sah.");
}

function cleanLabel(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 160 || /[\u0000-\u001f<>]/u.test(clean)) throw new Error("Label provider tidak sah.");
  return clean;
}

function validateOpaqueId(value: string, label: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} tidak sah.`);
  }
}

function cleanBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Base URL provider tidak sah."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const loopbackHttp = url.protocol === "http:" && loopback;
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username || url.password || url.search || url.hash ||
    /\/chat\/completions\/?$/u.test(url.pathname) ||
    isPrivateEndpoint(hostname) && !loopback
  ) {
    throw new Error("Base URL provider BYOK tidak sah.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function isPrivateEndpoint(hostname: string): boolean {
  if (hostname === "metadata.google.internal" || hostname === "instance-data.ec2.internal") return true;
  if (/^(?:0|10|127|169\.254|192\.168)\./u.test(hostname)) return true;
  const private172 = /^(172)\.(1[6-9]|2\d|3[01])\./u.test(hostname);
  if (private172 || /^100\.(6[4-9]|[7-9]\d)\./u.test(hostname)) return true;
  return /^(?:fc|fd|fe[89ab])(?::|$)/u.test(hostname);
}

function cleanReturnUrl(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.trim();
  if (!clean || clean.length > 2_048) throw new Error("Return URL payment tidak sah.");
  let url: URL;
  try { url = new URL(clean); } catch { throw new Error("Return URL payment tidak sah."); }
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) {
    throw new Error("Return URL payment tidak sah.");
  }
  return url.toString();
}

function validateEligibleTiers(tiers: readonly UsageTier[]): void {
  if (tiers.length === 0 || tiers.length > 3 || tiers.some((tier) =>
    tier !== "cheap" && tier !== "efficient" && tier !== "ambitious"
  )) {
    throw new Error("Tier credential BYOK tidak sah.");
  }
}

function validateIsoWindow(effectiveFrom: string, expiresAt: string | null): void {
  const start = Date.parse(effectiveFrom);
  if (!Number.isFinite(start)) throw new Error("Waktu grant sponsor tidak sah.");
  if (expiresAt !== null) {
    const end = Date.parse(expiresAt);
    if (!Number.isFinite(end) || end <= start) throw new Error("Masa grant sponsor tidak sah.");
  }
}

function planActiveAt(
  plan: Awaited<ReturnType<ControlPlaneService["plans"]>>[number],
  at: Date,
): boolean {
  return plan.status !== "retired" &&
    Date.parse(plan.effectiveFrom) <= at.getTime() &&
    (plan.effectiveTo === null || Date.parse(plan.effectiveTo) > at.getTime());
}

function inferSubscriptionPaymentAction(
  state: EconomyState,
  subjectRef: string,
  at: Date,
): SubscriptionPaymentAction {
  const current = state.subscriptions.find((item) => item.subjectRef === subjectRef);
  return current &&
      current.status !== "cancelled" &&
      current.status !== "expired" &&
      Date.parse(current.currentPeriodEnd) > at.getTime()
    ? "renew"
    : "activate";
}

function shortId(): string { return randomUUID().replaceAll("-", "").slice(0, 16); }
