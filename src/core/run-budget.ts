import type { TokenUsage, UsageTier } from "../domain/telemetry.js";
import {
  nanosToUsdDecimal,
  tokenCostNanos,
  usdDecimalToNanos,
  validNanoUsd,
} from "./money.js";
import type { TierPrice } from "./telemetry-service.js";

/**
 * Batas kumulatif satu logical AgentRun dan seluruh turunannya.
 *
 * `maxTotalTokens` menghitung input+output setiap attempt provider, termasuk
 * retry/fallback. `deadlineMs` adalah waktu kerja aktif; waktu saat run menunggu
 * jawaban manusia tidak ikut terhitung.
 */
export interface RunBudget {
  maxTotalTokens: number;
  maxCostUsd: number;
  maxSteps: number;
  maxToolCalls: number;
  maxModelCalls: number;
  deadlineMs: number;
  compactAtContextRatio: number;
  maxConcurrentWorkers: number;
}

export interface RunBudgetPolicy {
  limits?: Partial<RunBudget>;
  prices?: Partial<Record<UsageTier, TierPrice>>;
}

export interface RunBudgetCheckpoint {
  version: 1;
  limits: RunBudget;
  prices: Record<UsageTier, TierPrice>;
  consumedTokens: number;
  consumedCostUsdNanos: string;
  modelCalls: number;
  toolCalls: number;
  unknownUsageAttempts: number;
  activeElapsedMs: number;
}

/** Hanya angka/enum bebas isi yang boleh diberikan kepada planner. */
export interface RunBudgetView {
  maxTotalTokens: number;
  remainingTokens: number;
  /** Work non-final tidak boleh memakai bagian yang dilindungi untuk sintesis. */
  remainingWorkTokens: number;
  protectedFinalTokens: number;
  maxCostUsd: number;
  remainingCostUsd: string;
  remainingWorkCostUsd: string;
  protectedFinalCostUsd: string;
  remainingSteps: number;
  remainingToolCalls: number;
  remainingModelCalls: number;
  remainingActiveMs: number;
  compactAtContextRatio: number;
  maxConcurrentWorkers: number;
  unknownUsageAttempts: number;
}

export type RunBudgetExhaustionReason =
  | "budget_tokens"
  | "budget_cost"
  | "budget_steps"
  | "budget_tool_calls"
  | "budget_model_calls"
  | "budget_deadline";

export class RunBudgetExceededError extends Error {
  constructor(readonly reason: RunBudgetExhaustionReason) {
    super(runBudgetErrorMessage(reason));
    this.name = "RunBudgetExceededError";
  }
}

export interface RunBudgetModelReservation {
  /** Usage provider/estimasi aktual selalu mengalahkan reservation kasar. */
  settle(usage: TokenUsage, providerCostUsd?: string | null): void;
  /** Penolakan HTTP yang diketahui pra-inference melepas token/cost; call tetap dihitung. */
  release(): void;
  /** Timeout/network/JSON rusak memakai reservation penuh karena usage tidak diketahui. */
  consumeUnknown(providerCostUsd?: string | null): void;
}

export type RunBudgetModelCallClass = "work" | "final";

export const DEFAULT_AGENT_RUN_BUDGET: RunBudget = Object.freeze({
  maxTotalTokens: 96_000,
  maxCostUsd: 1,
  maxSteps: 6,
  maxToolCalls: 5,
  maxModelCalls: 12,
  deadlineMs: 45_000,
  compactAtContextRatio: 0.82,
  maxConcurrentWorkers: 3,
});

const ZERO_PRICES: Record<UsageTier, TierPrice> = Object.freeze({
  cheap: Object.freeze({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 }),
  efficient: Object.freeze({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 }),
  ambitious: Object.freeze({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 }),
});

interface BudgetCounters {
  consumedTokens: number;
  consumedCostUsdNanos: bigint;
  modelCalls: number;
  toolCalls: number;
  unknownUsageAttempts: number;
  activeElapsedMs: number;
}

interface ActiveReservation {
  tokens: number;
  costUsdNanos: bigint;
  tier: UsageTier;
  inputTokenEstimate: number;
  maxOutputTokens: number;
}

// Cap: 32.768 output + 16.384 input; budget default 96.000 mereservasi 48.000.
const MAX_FINAL_SYNTHESIS_RESERVE_TOKENS = 49_152;
const FINAL_SYNTHESIS_RESERVE_DIVISOR = 2;

/**
 * Waktu yang dilindungi untuk sintesis akhir.
 *
 * Token dan biaya sudah lama menyisakan bagian khusus untuk balasan final;
 * waktu tidak, padahal waktu yang habis membuat sisa anggaran lain tidak ada
 * artinya. Angkanya diukur: empat belas sintesis yang selesai pada model
 * sungguhan 5-6 September 2026 memakan 4,3-17,6 detik, p50 12,0 detik, dan 13
 * dari 14 di atas 9,5 detik.
 *
 * Dipakai hanya untuk menahan **pekerjaan baru yang bersifat pengulangan**,
 * bukan untuk memotong pekerjaan yang sedang berjalan. Memotong worker yang
 * masih hidup akan menukar jawaban baik dengan jawaban tipis; menahan
 * percobaan ulang yang tidak menyisakan waktu untuk menjawab tidak menukar
 * apa pun.
 */
const FINAL_SYNTHESIS_RESERVE_MS = 18_000;

/**
 * Akun budget mutable satu run. Seluruh mutasi reservation sinkron sehingga
 * beberapa worker paralel tidak dapat melewati check lalu reserve bersamaan.
 */
export class RunBudgetAccount {
  private limitsValue: RunBudget;
  private pricesValue: Record<UsageTier, TierPrice>;
  private counters: BudgetCounters;
  private readonly reservations = new Map<number, ActiveReservation>();
  private nextReservationId = 1;
  private activeStartedAt: number;

  constructor(
    policy: RunBudgetPolicy = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limitsValue = resolvedLimits(policy.limits);
    this.pricesValue = resolvedPrices(policy.prices);
    this.counters = emptyCounters();
    this.activeStartedAt = safeNow(now());
  }

  get maxConcurrentWorkers(): number {
    return this.limitsValue.maxConcurrentWorkers;
  }

  get deadlineMs(): number {
    return this.limitsValue.deadlineMs;
  }

  /** Remaining active deadline untuk dipadukan dengan deadline invocation. */
  remainingActiveMs(): number {
    return Math.max(0, this.limitsValue.deadlineMs - this.activeElapsedMs());
  }

  isTimeExhausted(): boolean {
    return this.remainingActiveMs() <= 0;
  }

  /**
   * Sisa waktu yang masih boleh dipakai pekerjaan non-final.
   *
   * Nol berarti yang tersisa hanya cukup—kalau cukup—untuk menyusun jawaban,
   * jadi tidak ada gunanya memulai percobaan baru yang harus dijawab lagi
   * sesudahnya.
   */
  remainingWorkMs(): number {
    return Math.max(0, this.remainingActiveMs() - FINAL_SYNTHESIS_RESERVE_MS);
  }

  assertStep(step: number): void {
    this.assertTime();
    this.assertNotOverdrawn();
    if (!Number.isSafeInteger(step) || step < 0 || step >= this.limitsValue.maxSteps) {
      throw new RunBudgetExceededError("budget_steps");
    }
  }

  consumeToolCall(): void {
    this.assertTime();
    this.assertWorkAvailable();
    if (this.counters.toolCalls >= this.limitsValue.maxToolCalls) {
      throw new RunBudgetExceededError("budget_tool_calls");
    }
    this.counters.toolCalls += 1;
  }

  /** Overage aktual baru dapat diketahui setelah provider mengembalikan usage. */
  overageReason(): Extract<
    RunBudgetExhaustionReason,
    "budget_tokens" | "budget_cost"
  > | null {
    if (this.counters.consumedTokens > this.limitsValue.maxTotalTokens) {
      return "budget_tokens";
    }
    if (
      this.counters.consumedCostUsdNanos >
        maxCostNanos(this.limitsValue.maxCostUsd)
    ) {
      return "budget_cost";
    }
    return null;
  }

  /** Overage ini menahan tool/work baru tetapi menyisakan final synthesis. */
  workOverageReason(): Extract<
    RunBudgetExhaustionReason,
    "budget_tokens" | "budget_cost"
  > | null {
    const hardLimit = this.overageReason();
    if (hardLimit) return hardLimit;
    if (
      this.counters.consumedTokens >
        this.limitsValue.maxTotalTokens - finalTokenReserve(
          this.limitsValue.maxTotalTokens,
        )
    ) {
      return "budget_tokens";
    }
    const totalCostLimit = maxCostNanos(this.limitsValue.maxCostUsd);
    if (
      this.counters.consumedCostUsdNanos >
        totalCostLimit - finalCostReserve(totalCostLimit)
    ) {
      return "budget_cost";
    }
    return null;
  }

  reserveModelCall(input: {
    tier: UsageTier;
    /** Default fail-closed adalah work; client production selalu eksplisit. */
    budgetClass?: RunBudgetModelCallClass;
    inputTokenEstimate: number;
    maxOutputTokens: number;
  }): RunBudgetModelReservation {
    this.assertTime();
    validateTier(input.tier);
    const budgetClass = input.budgetClass ?? "work";
    validateModelCallClass(budgetClass);
    validateNonNegativeInteger(input.inputTokenEstimate, "inputTokenEstimate");
    validatePositiveInteger(input.maxOutputTokens, "maxOutputTokens");
    if (this.counters.modelCalls >= this.limitsValue.maxModelCalls) {
      throw new RunBudgetExceededError("budget_model_calls");
    }

    const tokens = safeAdd(input.inputTokenEstimate, input.maxOutputTokens);
    const costUsdNanos = this.estimatedCost(
      input.tier,
      input.inputTokenEstimate,
      input.maxOutputTokens,
    );
    const reservedTokens = [...this.reservations.values()].reduce(
      (sum, reservation) => safeAdd(sum, reservation.tokens),
      0,
    );
    const reservedCost = [...this.reservations.values()].reduce(
      (sum, reservation) => sum + reservation.costUsdNanos,
      0n,
    );
    const tokenLimit = budgetClass === "work"
      ? this.limitsValue.maxTotalTokens - finalTokenReserve(
          this.limitsValue.maxTotalTokens,
        )
      : this.limitsValue.maxTotalTokens;
    if (
      safeAdd(this.counters.consumedTokens, reservedTokens, tokens) > tokenLimit
    ) {
      throw new RunBudgetExceededError("budget_tokens");
    }
    const totalCostLimit = maxCostNanos(this.limitsValue.maxCostUsd);
    const costLimit = budgetClass === "work"
      ? totalCostLimit - finalCostReserve(totalCostLimit)
      : totalCostLimit;
    if (
      this.counters.consumedCostUsdNanos + reservedCost + costUsdNanos >
        costLimit
    ) {
      throw new RunBudgetExceededError("budget_cost");
    }

    const id = this.nextReservationId;
    this.nextReservationId += 1;
    this.counters.modelCalls += 1;
    this.reservations.set(id, {
      tokens,
      costUsdNanos,
      tier: input.tier,
      inputTokenEstimate: input.inputTokenEstimate,
      maxOutputTokens: input.maxOutputTokens,
    });
    let finished = false;
    const finish = (
      mode: "settle" | "release" | "unknown",
      usage?: TokenUsage,
      providerCostUsd?: string | null,
    ): void => {
      if (finished) return;
      const reservation = this.reservations.get(id);
      let normalized: TokenUsage | null = null;
      let providerCost: bigint | null = null;
      if (mode === "settle") {
        try {
          providerCost = safeProviderCostNanos(providerCostUsd);
          normalized = normalizedUsage(usage);
        } catch {
          mode = "unknown";
        }
      } else if (mode === "unknown") {
        providerCost = safeProviderCostNanos(providerCostUsd);
      }
      finished = true;
      this.reservations.delete(id);
      if (!reservation || mode === "release") return;
      if (mode === "unknown") {
        this.counters.consumedTokens = saturatingAdd(
          this.counters.consumedTokens,
          reservation.tokens,
        );
        this.counters.consumedCostUsdNanos +=
          providerCost !== null && providerCost > reservation.costUsdNanos
            ? providerCost
            : reservation.costUsdNanos;
        this.counters.unknownUsageAttempts += 1;
        return;
      }
      if (!normalized) return;
      const actualCost = this.estimatedCost(
        reservation.tier,
        normalized.inputTokens,
        normalized.outputTokens,
      );
      this.counters.consumedTokens = saturatingAdd(
        this.counters.consumedTokens,
        normalized.totalTokens,
      );
      this.counters.consumedCostUsdNanos +=
        providerCost !== null && providerCost > actualCost
          ? providerCost
          : actualCost;
    };
    return Object.freeze({
      settle: (usage: TokenUsage, providerCostUsd?: string | null) =>
        finish("settle", usage, providerCostUsd),
      release: () => finish("release"),
      consumeUnknown: (providerCostUsd?: string | null) =>
        finish("unknown", undefined, providerCostUsd),
    });
  }

  /**
   * Checkpoint lama tidak membawa angka token. Charge konservatif mencegah
   * resume memperoleh budget kosong, lalu checkpoint berikutnya memakai codec
   * baru yang lengkap.
   */
  seedLegacy(input: { modelCalls: number; toolCalls: number }): void {
    if (
      this.counters.modelCalls !== 0 ||
      this.counters.toolCalls !== 0 ||
      this.counters.consumedTokens !== 0 ||
      this.reservations.size !== 0
    ) {
      throw new Error("RunBudget yang sudah dipakai tidak dapat di-seed ulang.");
    }
    validateNonNegativeInteger(input.modelCalls, "legacy modelCalls");
    validateNonNegativeInteger(input.toolCalls, "legacy toolCalls");
    const conservativeTokens = Math.min(
      this.limitsValue.maxTotalTokens,
      safeMultiply(input.modelCalls, 8_192),
    );
    const highestRate = Math.max(
      ...Object.values(this.pricesValue).flatMap((price) => [
        price.inputPerMillionUsd,
        price.outputPerMillionUsd,
      ]),
    );
    this.counters = {
      ...this.counters,
      consumedTokens: conservativeTokens,
      consumedCostUsdNanos:
        tokenCostNanos(
          conservativeTokens,
          usdNumberToDecimal(highestRate) ?? "0",
        ) ?? 0n,
      modelCalls: input.modelCalls,
      toolCalls: input.toolCalls,
      unknownUsageAttempts: input.modelCalls,
    };
  }

  restore(checkpoint: RunBudgetCheckpoint): void {
    if (!isValidRunBudgetCheckpoint(checkpoint)) {
      throw new Error("Checkpoint RunBudget tidak sah.");
    }
    if (this.reservations.size > 0) {
      throw new Error("RunBudget aktif tidak dapat dipulihkan ulang.");
    }
    this.limitsValue = cloneLimits(checkpoint.limits);
    this.pricesValue = clonePrices(checkpoint.prices);
    this.counters = {
      consumedTokens: checkpoint.consumedTokens,
      consumedCostUsdNanos: BigInt(checkpoint.consumedCostUsdNanos),
      modelCalls: checkpoint.modelCalls,
      toolCalls: checkpoint.toolCalls,
      unknownUsageAttempts: checkpoint.unknownUsageAttempts,
      activeElapsedMs: checkpoint.activeElapsedMs,
    };
    // Jeda sejak checkpoint tidak mengurangi budget aktif.
    this.activeStartedAt = safeNow(this.now());
  }

  checkpoint(): RunBudgetCheckpoint {
    // BoundedCall dapat berhenti lebih cepat daripada cleanup fetch. Snapshot
    // menahan reservation live secara konservatif agar resume tidak memperoleh
    // kembali work/cost yang status provider-nya belum pasti.
    const pending = [...this.reservations.values()];
    const pendingTokens = pending.reduce(
      (sum, reservation) => saturatingAdd(sum, reservation.tokens),
      0,
    );
    const pendingCost = pending.reduce(
      (sum, reservation) => sum + reservation.costUsdNanos,
      0n,
    );
    return {
      version: 1,
      limits: cloneLimits(this.limitsValue),
      prices: clonePrices(this.pricesValue),
      consumedTokens: saturatingAdd(
        this.counters.consumedTokens,
        pendingTokens,
      ),
      consumedCostUsdNanos:
        (this.counters.consumedCostUsdNanos + pendingCost).toString(),
      modelCalls: this.counters.modelCalls,
      toolCalls: this.counters.toolCalls,
      unknownUsageAttempts:
        this.counters.unknownUsageAttempts + pending.length,
      activeElapsedMs: this.activeElapsedMs(),
    };
  }

  view(currentStep: number): RunBudgetView {
    const reservedTokens = [...this.reservations.values()].reduce(
      (sum, reservation) => safeAdd(sum, reservation.tokens),
      0,
    );
    const reservedCost = [...this.reservations.values()].reduce(
      (sum, reservation) => sum + reservation.costUsdNanos,
      0n,
    );
    const totalCostLimit = maxCostNanos(this.limitsValue.maxCostUsd);
    const remainingCost = totalCostLimit -
      this.counters.consumedCostUsdNanos - reservedCost;
    const remainingTokens = Math.max(
      0,
      this.limitsValue.maxTotalTokens -
        this.counters.consumedTokens -
        reservedTokens,
    );
    const protectedFinalTokens = Math.min(
      remainingTokens,
      finalTokenReserve(this.limitsValue.maxTotalTokens),
    );
    const remainingWorkTokens = Math.max(
      0,
      remainingTokens - protectedFinalTokens,
    );
    const protectedFinalCost = minBigInt(
      remainingCost > 0n ? remainingCost : 0n,
      finalCostReserve(totalCostLimit),
    );
    const remainingWorkCost = remainingCost - protectedFinalCost;
    return Object.freeze({
      maxTotalTokens: this.limitsValue.maxTotalTokens,
      remainingTokens,
      remainingWorkTokens,
      protectedFinalTokens,
      maxCostUsd: this.limitsValue.maxCostUsd,
      remainingCostUsd: nanosToUsdDecimal(
        remainingCost > 0n ? remainingCost : 0n,
      ),
      remainingWorkCostUsd: nanosToUsdDecimal(
        remainingWorkCost > 0n ? remainingWorkCost : 0n,
      ),
      protectedFinalCostUsd: nanosToUsdDecimal(protectedFinalCost),
      remainingSteps: Math.max(0, this.limitsValue.maxSteps - currentStep),
      remainingToolCalls: Math.max(
        0,
        this.limitsValue.maxToolCalls - this.counters.toolCalls,
      ),
      remainingModelCalls: Math.max(
        0,
        this.limitsValue.maxModelCalls - this.counters.modelCalls,
      ),
      remainingActiveMs: this.remainingActiveMs(),
      compactAtContextRatio: this.limitsValue.compactAtContextRatio,
      maxConcurrentWorkers: this.limitsValue.maxConcurrentWorkers,
      unknownUsageAttempts: this.counters.unknownUsageAttempts,
    });
  }

  private activeElapsedMs(): number {
    return Math.min(
      Number.MAX_SAFE_INTEGER,
      safeAdd(
        this.counters.activeElapsedMs,
        Math.max(0, safeNow(this.now()) - this.activeStartedAt),
      ),
    );
  }

  private assertTime(): void {
    if (this.isTimeExhausted()) {
      throw new RunBudgetExceededError("budget_deadline");
    }
  }

  private assertNotOverdrawn(): void {
    const reason = this.overageReason();
    if (reason) throw new RunBudgetExceededError(reason);
  }

  private assertWorkAvailable(): void {
    const reason = this.workOverageReason();
    if (reason) throw new RunBudgetExceededError(reason);
  }

  private estimatedCost(
    tier: UsageTier,
    inputTokens: number,
    outputTokens: number,
  ): bigint {
    const price = this.pricesValue[tier];
    return (
      (tokenCostNanos(
        inputTokens,
        usdNumberToDecimal(price.inputPerMillionUsd) ?? "0",
      ) ?? 0n) +
      (tokenCostNanos(
        outputTokens,
        usdNumberToDecimal(price.outputPerMillionUsd) ?? "0",
      ) ?? 0n)
    );
  }
}

export function isValidRunBudgetCheckpoint(
  value: unknown,
): value is RunBudgetCheckpoint {
  if (!exactRecord(value, [
    "version",
    "limits",
    "prices",
    "consumedTokens",
    "consumedCostUsdNanos",
    "modelCalls",
    "toolCalls",
    "unknownUsageAttempts",
    "activeElapsedMs",
  ])) {
    return false;
  }
  return (
    value.version === 1 &&
    validLimits(value.limits) &&
    validPrices(value.prices) &&
    isNonNegativeInteger(value.consumedTokens) &&
    validNanoUsd(value.consumedCostUsdNanos) &&
    value.consumedCostUsdNanos.length <= 80 &&
    isNonNegativeInteger(value.modelCalls) &&
    isNonNegativeInteger(value.toolCalls) &&
    isNonNegativeInteger(value.unknownUsageAttempts) &&
    value.unknownUsageAttempts <= value.modelCalls &&
    isNonNegativeInteger(value.activeElapsedMs)
  );
}

export function runBudgetReason(
  error: unknown,
): RunBudgetExhaustionReason | null {
  return error instanceof RunBudgetExceededError ? error.reason : null;
}

function resolvedLimits(overrides: Partial<RunBudget> | undefined): RunBudget {
  const limits = { ...DEFAULT_AGENT_RUN_BUDGET, ...overrides };
  if (!validLimits(limits)) throw new Error("Kebijakan RunBudget tidak sah.");
  return cloneLimits(limits);
}

function resolvedPrices(
  overrides: Partial<Record<UsageTier, TierPrice>> | undefined,
): Record<UsageTier, TierPrice> {
  const prices = {
    cheap: { ...ZERO_PRICES.cheap, ...overrides?.cheap },
    efficient: { ...ZERO_PRICES.efficient, ...overrides?.efficient },
    ambitious: { ...ZERO_PRICES.ambitious, ...overrides?.ambitious },
  };
  if (!validPrices(prices)) throw new Error("Harga RunBudget tidak sah.");
  return clonePrices(prices);
}

function validLimits(value: unknown): value is RunBudget {
  if (!exactRecord(value, [
    "maxTotalTokens",
    "maxCostUsd",
    "maxSteps",
    "maxToolCalls",
    "maxModelCalls",
    "deadlineMs",
    "compactAtContextRatio",
    "maxConcurrentWorkers",
  ])) {
    return false;
  }
  return (
    isPositiveInteger(value.maxTotalTokens) &&
    value.maxTotalTokens <= 1_000_000_000 &&
    usdNumberToDecimal(value.maxCostUsd) !== null &&
    isPositiveInteger(value.maxSteps) &&
    value.maxSteps <= 10_000 &&
    isNonNegativeInteger(value.maxToolCalls) &&
    value.maxToolCalls <= 100_000 &&
    isPositiveInteger(value.maxModelCalls) &&
    value.maxModelCalls <= 100_000 &&
    isPositiveInteger(value.deadlineMs) &&
    value.deadlineMs <= 7 * 24 * 60 * 60 * 1_000 &&
    typeof value.compactAtContextRatio === "number" &&
    Number.isFinite(value.compactAtContextRatio) &&
    value.compactAtContextRatio > 0 &&
    value.compactAtContextRatio < 1 &&
    isPositiveInteger(value.maxConcurrentWorkers) &&
    value.maxConcurrentWorkers <= 32
  );
}

function validPrices(
  value: unknown,
): value is Record<UsageTier, TierPrice> {
  if (!exactRecord(value, ["cheap", "efficient", "ambitious"])) return false;
  return (["cheap", "efficient", "ambitious"] as const).every((tier) => {
    const price = value[tier];
    return exactRecord(price, ["inputPerMillionUsd", "outputPerMillionUsd"]) &&
      validPrice(price.inputPerMillionUsd) &&
      validPrice(price.outputPerMillionUsd);
  });
}

function validPrice(value: unknown): value is number {
  return usdNumberToDecimal(value) !== null;
}

function normalizedUsage(value: TokenUsage | undefined): TokenUsage {
  if (
    !isNonNegativeInteger(value?.inputTokens) ||
    !isNonNegativeInteger(value?.outputTokens) ||
    !isNonNegativeInteger(value?.totalTokens)
  ) {
    throw new Error("Usage token provider tidak sah.");
  }
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = Math.max(
    value.totalTokens,
    saturatingAdd(inputTokens, outputTokens),
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: value?.estimated === true,
  };
}

function maxCostNanos(value: number): bigint {
  const decimal = usdNumberToDecimal(value);
  const parsed = decimal === null ? null : usdDecimalToNanos(decimal);
  if (parsed === null) throw new Error("Batas biaya RunBudget tidak sah.");
  return parsed;
}

function usdNumberToDecimal(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000
  ) {
    return null;
  }
  const decimal = value.toFixed(9).replace(/\.?0+$/u, "");
  const parsed = usdDecimalToNanos(decimal);
  if (parsed === null || (value > 0 && parsed === 0n)) return null;
  return decimal;
}

function emptyCounters(): BudgetCounters {
  return {
    consumedTokens: 0,
    consumedCostUsdNanos: 0n,
    modelCalls: 0,
    toolCalls: 0,
    unknownUsageAttempts: 0,
    activeElapsedMs: 0,
  };
}

function cloneLimits(limits: RunBudget): RunBudget {
  return { ...limits };
}

function clonePrices(
  prices: Record<UsageTier, TierPrice>,
): Record<UsageTier, TierPrice> {
  return {
    cheap: { ...prices.cheap },
    efficient: { ...prices.efficient },
    ambitious: { ...prices.ambitious },
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length &&
    present.every((key) => keys.includes(key));
}

function validateTier(value: UsageTier): void {
  if (value !== "cheap" && value !== "efficient" && value !== "ambitious") {
    throw new Error("Tier reservation RunBudget tidak sah.");
  }
}

function validateModelCallClass(value: RunBudgetModelCallClass): void {
  if (value !== "work" && value !== "final") {
    throw new Error("Kelas model call RunBudget tidak sah.");
  }
}

function finalTokenReserve(maxTotalTokens: number): number {
  return Math.min(
    MAX_FINAL_SYNTHESIS_RESERVE_TOKENS,
    Math.max(1, Math.floor(maxTotalTokens / FINAL_SYNTHESIS_RESERVE_DIVISOR)),
  );
}

function finalCostReserve(maxCost: bigint): bigint {
  return maxCost / BigInt(FINAL_SYNTHESIS_RESERVE_DIVISOR);
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!isPositiveInteger(value)) throw new Error(`${label} RunBudget tidak sah.`);
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`${label} RunBudget tidak sah.`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeProviderCostNanos(value: string | null | undefined): bigint | null {
  if (!value || value.length > 64 || !/^\d+(?:\.\d+)?$/u.test(value)) {
    return null;
  }
  return usdDecimalToNanos(value);
}

function safeAdd(...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Akumulasi RunBudget melampaui integer aman.");
  }
  return result;
}

function saturatingAdd(...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : Number.MAX_SAFE_INTEGER;
}

function safeMultiply(left: number, right: number): number {
  const result = left * right;
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : Number.MAX_SAFE_INTEGER;
}

function safeNow(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Clock RunBudget tidak sah.");
  return Math.floor(value);
}

function runBudgetErrorMessage(reason: RunBudgetExhaustionReason): string {
  switch (reason) {
    case "budget_tokens":
      return "RunBudget tidak mempunyai sisa token yang cukup.";
    case "budget_cost":
      return "RunBudget tidak mempunyai sisa biaya yang cukup.";
    case "budget_steps":
      return "RunBudget mencapai batas langkah.";
    case "budget_tool_calls":
      return "RunBudget mencapai batas tool call.";
    case "budget_model_calls":
      return "RunBudget mencapai batas model call.";
    case "budget_deadline":
      return "RunBudget mencapai batas waktu kerja aktif.";
  }
}
