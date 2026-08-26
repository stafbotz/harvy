import { PERSONAL_PLAN_IDS } from "../domain/control-plane.js";
import type { FundingSource } from "../domain/economy.js";
import type {
  ProviderAttemptRecord,
  UsageLedgerFilter,
} from "../domain/usage-ledger.js";
import { tokenCostNanos } from "./money.js";
import type {
  EconomyUserUsageAccounting,
  EconomyUsageView,
} from "./economy-service.js";

export type UserUsageCurrentFunding =
  | { type: "free" }
  | { type: "plan"; publicName: string }
  | { type: "payg" }
  | { type: "byok"; providerName: string }
  | { type: "sponsored" }
  | null;

export interface UserUsageSummary {
  plan: {
    id: string;
    publicName: string;
    isFree: boolean;
  };
  period: {
    startsAt: string;
    endsAt: string;
    resetsAt: string;
  };
  allowance: {
    /** Fixed-point percentage where 10_000 means exactly 100.00%. */
    remainingBasisPoints: number;
    /** Complement of remainingBasisPoints for the same active allowance. */
    usedBasisPoints: number;
    state: EconomyUsageView["health"];
  };
  modelUsage: {
    inputTokens: number;
    cachedInputTokens: number | null;
    /** Output yang terlihat, tidak termasuk reasoning bila provider memisahkannya. */
    outputTokens: number;
    reasoningTokens: number | null;
    hasEstimatedUsage: boolean;
  };
  cost: {
    totalProviderCostUsdNanos: string | null;
    completeness: "complete" | "partial" | "unknown";
    providerReportedUsdNanos: string;
    catalogCalculatedUsdNanos: string;
  };
  funding: {
    includedUsdNanos: string;
    sponsoredUsdNanos: string;
    byokUsdNanos: string;
    harvyOverheadUsdNanos: string;
    walletProviderCostUsdNanos: string;
    paygIdr: string | null;
    paygUsed: boolean;
    paygRelevant: boolean;
    current: UserUsageCurrentFunding;
  };
  efficiency: {
    /** cache-read input / seluruh input, hanya bila seluruh provider comparable. */
    cacheHitPercent: number | null;
    cacheSavingsUsdNanos: string | null;
  };
}

export interface UserUsageEconomyQuery {
  userUsageAccounting(ownerId: string): Promise<EconomyUserUsageAccounting>;
}

export interface UserUsageLedgerQuery {
  allAttempts(
    filter?: Omit<UsageLedgerFilter, "limit">,
  ): Promise<ProviderAttemptRecord[]>;
}

/**
 * Query user-scoped dan content-free untuk usage dashboard. Tidak menerima
 * subjectRef dari command, sehingga caller tidak dapat memilih akun lain.
 */
export class UserUsageSummaryService {
  constructor(
    private readonly economy: UserUsageEconomyQuery,
    private readonly usageLedger: UserUsageLedgerQuery,
  ) {}

  async summary(ownerId: string): Promise<UserUsageSummary> {
    const accounting = await this.economy.userUsageAccounting(ownerId);
    const view = accounting.usage;
    const attempts = await this.usageLedger.allAttempts({
      subjectRef: view.subjectRef,
      since: view.periodStartsAt,
      until: view.periodEndsAt,
    });
    return summarizeUserUsage(accounting, attempts);
  }
}

function summarizeUserUsage(
  accounting: EconomyUserUsageAccounting,
  attempts: readonly ProviderAttemptRecord[],
): UserUsageSummary {
  const view = accounting.usage;
  const inputTokens = tokenSum(attempts.map((item) => item.usage.inputTokens));
  const rawOutputTokens = tokenSum(attempts.map((item) => item.usage.outputTokens));
  const inputBearing = attempts.filter((item) => item.usage.inputTokens > 0);
  const outputBearing = attempts.filter((item) => item.usage.outputTokens > 0);
  const cacheComparable = inputBearing.every(
    (item) => item.usage.cacheReadTokens !== null,
  );
  const reasoningComparable = outputBearing.length > 0 && outputBearing.every(
    (item) => item.usage.reasoningTokens !== null,
  );
  const cachedInputTokens = cacheComparable
    ? tokenSum(inputBearing.map((item) => item.usage.cacheReadTokens ?? 0))
    : null;
  const reasoningTokens = reasoningComparable
    ? tokenSum(outputBearing.map((item) => item.usage.reasoningTokens ?? 0))
    : null;
  // Normalisasi ledger menghitung reasoning sebagai subset output. Ketika
  // seluruh provider melaporkannya, pisahkan agar dashboard tidak menjumlahkan
  // token reasoning dua kali secara visual.
  const outputTokens = reasoningTokens === null
    ? rawOutputTokens
    : Math.max(0, rawOutputTokens - reasoningTokens);

  const knownCosts = attempts
    .map((item) => item.cost.effectiveUsdNanos)
    .filter((value): value is string => value !== null);
  const missingCosts = attempts.length - knownCosts.length;
  const totalProviderCostUsdNanos = attempts.length === 0 || knownCosts.length > 0
    ? sumNanos(knownCosts)
    : null;
  const completeness = missingCosts === 0
    ? "complete" as const
    : knownCosts.length === 0
      ? "unknown" as const
      : "partial" as const;

  const settledSources = new Map<string, FundingSource>();
  const ambiguousSettlements = new Set<string>();
  for (const settlement of accounting.settledRequests) {
    const existing = settledSources.get(settlement.requestId);
    if (existing && existing !== settlement.fundingSource) {
      settledSources.delete(settlement.requestId);
      ambiguousSettlements.add(settlement.requestId);
      continue;
    }
    if (!ambiguousSettlements.has(settlement.requestId)) {
      settledSources.set(settlement.requestId, settlement.fundingSource);
    }
  }
  const sourceCosts = new Map<FundingSource | "harvy_overhead", bigint>();
  for (const attempt of attempts) {
    const cost = attempt.cost.effectiveUsdNanos;
    if (cost === null) continue;
    const eligibleDeliveredAttempt = attempt.status === "completed" &&
      attempt.responseOutcome === "accepted";
    const settled = eligibleDeliveredAttempt &&
        !ambiguousSettlements.has(attempt.requestId)
      ? settledSources.get(attempt.requestId)
      : undefined;
    // Hanya attempt final yang berhasil dan tersettle yang mengikuti sumber
    // biaya pengguna. Retry/failure internal Harvy tetap overhead. BYOK tetap
    // dibayar pada akun provider pengguna secara fisik walaupun attempt gagal.
    const source = settled ??
      (attempt.fundingSource === "byok" ? "byok" : "harvy_overhead");
    const normalized = source === "safety_exempt" ? "harvy_overhead" : source;
    sourceCosts.set(normalized, (sourceCosts.get(normalized) ?? 0n) + BigInt(cost));
  }

  const cacheHitPercent = cachedInputTokens === null || inputTokens === 0
    ? null
    : roundedWholePercent(BigInt(cachedInputTokens), BigInt(inputTokens));
  const cacheSavingsUsdNanos = cacheSavings(attempts, cachedInputTokens);
  const totalAllowance = BigInt(view.includedComputeUnits) +
    BigInt(view.sponsoredGrantedComputeUnits);
  const remainingAllowance = BigInt(view.remainingIncludedComputeUnits) +
    BigInt(view.sponsoredRemainingComputeUnits);
  const remainingBasisPoints = allowanceBasisPoints(
    remainingAllowance,
    totalAllowance,
  );

  return {
    plan: {
      id: view.planId,
      publicName: view.planName,
      isFree: view.planId === PERSONAL_PLAN_IDS.free,
    },
    period: {
      startsAt: view.periodStartsAt,
      endsAt: view.periodEndsAt,
      resetsAt: view.nextResetAt,
    },
    allowance: {
      remainingBasisPoints,
      usedBasisPoints: totalAllowance <= 0n ? 0 : 10_000 - remainingBasisPoints,
      state: view.health,
    },
    modelUsage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      hasEstimatedUsage: attempts.some((item) => item.usage.source === "estimated"),
    },
    cost: {
      totalProviderCostUsdNanos,
      completeness,
      providerReportedUsdNanos: sumNanos(
        attempts.map((item) => item.cost.providerReportedUsdNanos),
      ),
      catalogCalculatedUsdNanos: sumNanos(
        attempts.map((item) => item.cost.localCalculatedUsdNanos),
      ),
    },
    funding: {
      includedUsdNanos: (sourceCosts.get("included") ?? 0n).toString(),
      sponsoredUsdNanos: (sourceCosts.get("sponsored") ?? 0n).toString(),
      byokUsdNanos: (sourceCosts.get("byok") ?? 0n).toString(),
      harvyOverheadUsdNanos: (sourceCosts.get("harvy_overhead") ?? 0n).toString(),
      walletProviderCostUsdNanos: (sourceCosts.get("wallet") ?? 0n).toString(),
      paygIdr: accounting.walletDebitIdrNanos === null
        ? null
        : roundNanoRupiah(accounting.walletDebitIdrNanos),
      paygUsed: accounting.walletUsed,
      paygRelevant: accounting.walletRelevant,
      current: currentFunding(accounting),
    },
    efficiency: {
      cacheHitPercent,
      cacheSavingsUsdNanos,
    },
  };
}

function currentFunding(
  accounting: EconomyUserUsageAccounting,
): UserUsageCurrentFunding {
  const current = accounting.currentFunding;
  if (!current) return null;
  switch (current.source) {
    case "included":
      return accounting.usage.planId === PERSONAL_PLAN_IDS.free
        ? { type: "free" }
        : { type: "plan", publicName: accounting.usage.planName };
    case "wallet":
      return { type: "payg" };
    case "byok":
      return {
        type: "byok",
        providerName: providerPublicName(current.providerId),
      };
    case "sponsored":
      return { type: "sponsored" };
    case "safety_exempt":
      return null;
  }
}

function cacheSavings(
  attempts: readonly ProviderAttemptRecord[],
  cachedInputTokens: number | null,
): string | null {
  if (cachedInputTokens === null) return null;
  if (cachedInputTokens === 0) return "0";
  let total = 0n;
  for (const attempt of attempts) {
    const cached = attempt.usage.cacheReadTokens ?? 0;
    if (cached === 0) continue;
    const rates = attempt.priceSnapshot;
    if (!rates || rates.cacheReadPerMillionUsd === null) return null;
    const normal = tokenCostNanos(cached, rates.inputPerMillionUsd);
    const actual = tokenCostNanos(cached, rates.cacheReadPerMillionUsd);
    if (normal === null || actual === null) return null;
    if (normal > actual) total += normal - actual;
  }
  return total.toString();
}

/**
 * Computes a bounded allowance ratio without converting compute amounts to a
 * JavaScript number. Rounding is conservative (toward zero): any non-zero use
 * is visible below 100%, while any non-zero remainder stays visible above 0%.
 */
function allowanceBasisPoints(remaining: bigint, total: bigint): number {
  if (total <= 0n || remaining <= 0n) return 0;
  const clamped = remaining > total ? total : remaining;
  if (clamped === total) return 10_000;
  const floored = Number((clamped * 10_000n) / total);
  return Math.max(1, Math.min(9_999, floored));
}

function roundedWholePercent(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  const clamped = numerator > denominator ? denominator : numerator;
  return Number((clamped * 100n + denominator / 2n) / denominator);
}

function roundNanoRupiah(value: string): string {
  const nanos = BigInt(value);
  return ((nanos + 500_000_000n) / 1_000_000_000n).toString();
}

function tokenSum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || sum > Number.MAX_SAFE_INTEGER - value) {
      throw new Error("Agregat usage melampaui batas integer aman.");
    }
    sum += value;
  }
  return sum;
}

function sumNanos(values: readonly (string | null)[]): string {
  return values.reduce<bigint>(
    (sum, value) => sum + (value === null ? 0n : BigInt(value)),
    0n,
  ).toString();
}

function providerPublicName(providerId: string | null): string {
  if (!providerId) return "Provider pribadi";
  const known: Readonly<Record<string, string>> = {
    openai: "OpenAI",
    "openai-compatible": "OpenAI-compatible",
    openrouter: "OpenRouter",
    xai: "xAI",
    anthropic: "Anthropic",
    // Provider retired tetap diberi label manusiawi untuk ledger historis.
    "google-ai-studio": "Google AI Studio",
    deepseek: "DeepSeek",
    moonshot: "Moonshot",
  };
  // Provider ID adalah metadata internal, bukan label yang aman direfleksikan.
  // Endpoint kompatibel/kustom tetap diberi nama generik kecuali sudah masuk
  // katalog public-name yang ditinjau.
  return known[providerId] ?? "Provider pribadi";
}
