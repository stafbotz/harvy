import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelPriceRates } from "../src/domain/control-plane.js";
import type { ProviderAttemptRecord } from "../src/domain/usage-ledger.js";
import type { EconomyUserUsageAccounting } from "../src/core/economy-service.js";
import {
  UserUsageSummaryService,
  type UserUsageSummary,
} from "../src/core/user-usage-summary-service.js";
import {
  formatCompactUsage,
  parseUsageDashboardCommand,
  renderUsageDashboard,
  usageProgressBar,
} from "../src/core/usage-dashboard-renderer.js";

const PERIOD_START = "2026-08-20T17:00:00.000Z";
const PERIOD_END = "2026-09-20T17:00:00.000Z";

describe("user usage summary query", () => {
  it("mengagregasi periode owner exact, memisahkan reasoning, dan memakai price snapshot cache", async () => {
    let requestedOwner = "";
    let ledgerFilter: unknown = null;
    const source = accounting({
      usage: {
        ...accounting().usage,
        planId: "personal_toro",
        planName: "Toro",
        subscriptionStatus: "active",
        includedComputeUnits: "1000",
        remainingIncludedComputeUnits: "680",
      },
      settledRequests: [
        { requestId: "request-included", fundingSource: "included" },
        { requestId: "request-byok", fundingSource: "byok" },
      ],
      walletDebitIdrNanos: "0",
      walletRelevant: true,
      currentFunding: { source: "included", providerId: null },
    });
    const attempts = [
      attempt({
        requestId: "request-included",
        fundingSource: "included",
        inputTokens: 160_000,
        cacheReadTokens: 110_000,
        outputTokens: 40_000,
        reasoningTokens: 10_000,
        effectiveCostUsdNanos: "160000000",
        effectiveSource: "provider",
      }),
      attempt({
        requestId: "request-byok",
        fundingSource: "byok",
        inputTokens: 24_000,
        cacheReadTokens: 11_000,
        outputTokens: 9_000,
        reasoningTokens: 8_000,
        effectiveCostUsdNanos: "20000000",
        effectiveSource: "catalog",
      }),
    ];
    const service = new UserUsageSummaryService(
      {
        userUsageAccounting: async (ownerId) => {
          requestedOwner = ownerId;
          return source;
        },
      },
      {
        allAttempts: async (filter) => {
          ledgerFilter = filter;
          return attempts;
        },
      },
    );

    const summary = await service.summary("owner-terautentikasi");

    assert.equal(requestedOwner, "owner-terautentikasi");
    assert.deepEqual(ledgerFilter, {
      subjectRef: "subject-owner",
      since: PERIOD_START,
      until: PERIOD_END,
    });
    assert.equal(summary.allowance.remainingPercent, 68);
    assert.deepEqual(summary.modelUsage, {
      inputTokens: 184_000,
      cachedInputTokens: 121_000,
      outputTokens: 31_000,
      reasoningTokens: 18_000,
      hasEstimatedUsage: false,
    });
    assert.equal(summary.cost.totalProviderCostUsdNanos, "180000000");
    assert.equal(summary.cost.providerReportedUsdNanos, "160000000");
    assert.equal(summary.cost.catalogCalculatedUsdNanos, "20000000");
    assert.equal(summary.funding.includedUsdNanos, "160000000");
    assert.equal(summary.funding.byokUsdNanos, "20000000");
    assert.equal(summary.efficiency.cacheHitPercent, 66);
    assert.equal(summary.efficiency.cacheSavingsUsdNanos, "108900000");
  });

  it("degrade gracefully ketika cache, reasoning, atau biaya tidak lengkap", async () => {
    const records = [attempt({
      inputTokens: 1_200,
      cacheReadTokens: null,
      outputTokens: 300,
      reasoningTokens: null,
      effectiveCostUsdNanos: null,
      priceSnapshot: null,
    })];
    const service = new UserUsageSummaryService(
      { userUsageAccounting: async () => accounting() },
      { allAttempts: async () => records },
    );

    const summary = await service.summary("owner");
    const rendered = renderUsageDashboard(summary, "plain").text;

    assert.equal(summary.modelUsage.cachedInputTokens, null);
    assert.equal(summary.modelUsage.reasoningTokens, null);
    assert.equal(summary.modelUsage.outputTokens, 300);
    assert.equal(summary.efficiency.cacheHitPercent, null);
    assert.equal(summary.efficiency.cacheSavingsUsdNanos, null);
    assert.equal(summary.cost.completeness, "unknown");
    assert.match(rendered, /Input: 1\.2k/u);
    assert.doesNotMatch(rendered, /cached|Reasoning:/u);
    assert.match(rendered, /Sebagian biaya belum dapat dihitung/u);
  });

  it("tidak membagi nol dan tidak mengarang saving tanpa snapshot historis", async () => {
    const zero = new UserUsageSummaryService(
      { userUsageAccounting: async () => accounting() },
      { allAttempts: async () => [] },
    );
    assert.equal((await zero.summary("owner")).efficiency.cacheHitPercent, null);

    const missingSnapshot = new UserUsageSummaryService(
      { userUsageAccounting: async () => accounting() },
      { allAttempts: async () => [attempt({ priceSnapshot: null })] },
    );
    const summary = await missingSnapshot.summary("owner");
    assert.equal(summary.efficiency.cacheHitPercent, 50);
    assert.equal(summary.efficiency.cacheSavingsUsdNanos, null);
    assert.match(
      renderUsageDashboard(summary, "plain").text,
      /Hemat dari cache: Belum dapat dihitung/u,
    );
  });

  it("mengatribusikan attempt gagal ke overhead, bukan debit user", async () => {
    const service = new UserUsageSummaryService(
      {
        userUsageAccounting: async () => accounting({
          settledRequests: [
            { requestId: "retry-gagal", fundingSource: "included" },
          ],
        }),
      },
      {
        allAttempts: async () => [attempt({
          requestId: "retry-gagal",
          fundingSource: "included",
          status: "network_error",
          responseOutcome: "not_checked",
          effectiveCostUsdNanos: "5000000",
        })],
      },
    );
    const summary = await service.summary("owner");
    assert.equal(summary.funding.walletProviderCostUsdNanos, "0");
    assert.equal(summary.funding.harvyOverheadUsdNanos, "5000000");
    assert.equal(summary.funding.paygUsed, false);
  });

  it("tidak merefleksikan identifier provider atau secret-like value BYOK", async () => {
    const secretLikeProviderId = "sk-rahasia-jangan-tampil";
    const service = new UserUsageSummaryService(
      {
        userUsageAccounting: async () => accounting({
          currentFunding: {
            source: "byok",
            providerId: secretLikeProviderId,
          },
        }),
      },
      { allAttempts: async () => [] },
    );

    const summary = await service.summary("owner");
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes(secretLikeProviderId), false);
    assert.deepEqual(summary.funding.current, {
      type: "byok",
      providerName: "Provider pribadi",
    });
  });

  it("gagal tertutup pada settlement source yang berkonflik", async () => {
    const service = new UserUsageSummaryService(
      {
        userUsageAccounting: async () => accounting({
          settledRequests: [
            { requestId: "request-konflik", fundingSource: "included" },
            { requestId: "request-konflik", fundingSource: "wallet" },
          ],
        }),
      },
      {
        allAttempts: async () => [attempt({
          requestId: "request-konflik",
          effectiveCostUsdNanos: "7000000",
        })],
      },
    );

    const summary = await service.summary("owner");
    assert.equal(summary.funding.includedUsdNanos, "0");
    assert.equal(summary.funding.walletProviderCostUsdNanos, "0");
    assert.equal(summary.funding.harvyOverheadUsdNanos, "7000000");
  });
});

describe("usage dashboard formatting", () => {
  it("merender acceptance UX Telegram dan WhatsApp dengan markup channel-specific", () => {
    const summary = acceptanceSummary();
    const telegram = renderUsageDashboard(summary, "telegram");
    const whatsapp = renderUsageDashboard(summary, "whatsapp");

    assert.equal(telegram.telegramParseMode, "HTML");
    assert.match(telegram.text, /^<b>Penggunaan Harvy<\/b>/u);
    assert.match(telegram.text, /<b>Paket<\/b>\nToro/u);
    assert.match(telegram.text, /21 Agu – 21 Sep/u);
    assert.match(telegram.text, /<b>Reset<\/b>\n21 September/u);
    assert.match(telegram.text, /██████████████░░░░░░ 68%/u);
    assert.match(telegram.text, /Input: 184k \(121k cached\)/u);
    assert.match(telegram.text, /Output: 31k\nReasoning: 18k/u);
    assert.match(telegram.text, /Total: \$0\.18/u);
    assert.match(telegram.text, /• Termasuk paket: \$0\.16/u);
    assert.match(telegram.text, /• API milikmu: \$0\.02/u);
    assert.match(telegram.text, /• Saldo tambahan: Rp0/u);
    assert.match(telegram.text, /Cache hit: 66%/u);
    assert.match(telegram.text, /Hemat dari cache: ≈ \$0\.11/u);
    assert.match(telegram.text, /Kuota paket Toro/u);

    assert.match(whatsapp.text, /^\*Penggunaan Harvy\*/u);
    assert.match(whatsapp.text, /\*Paket\*\nToro/u);
    assert.doesNotMatch(whatsapp.text, /<b>|<\/b>/u);
    assert.doesNotMatch(whatsapp.text, /\bcompute\b|\bPAYG\b|\bBYOK\b|funding_source|included/iu);
  });

  it("menghasilkan bold Telegram aman, bold WhatsApp aman, dan fallback plain", () => {
    const summary = acceptanceSummary({
      plan: { id: "personal_toro", publicName: "Toro <A&B> *pilot*", isFree: false },
    });
    const telegram = renderUsageDashboard(summary, "telegram").text;
    const whatsapp = renderUsageDashboard(summary, "whatsapp").text;
    const plain = renderUsageDashboard(summary, "plain").text;

    assert.match(telegram, /Toro &lt;A&amp;B&gt; \*pilot\*/u);
    assert.doesNotMatch(telegram, /Toro <A&B>/u);
    assert.match(whatsapp, /Toro <A&B> \\?\*pilot\\?\*/u);
    assert.doesNotMatch(whatsapp, /<b>/u);
    assert.match(plain, /^Penggunaan Harvy/u);
    assert.doesNotMatch(plain, /<b>|\*Penggunaan Harvy\*/u);
  });

  it("menjaga progress bar stabil pada seluruh boundary", () => {
    const filled = (percentage: number) =>
      [...usageProgressBar(percentage)].filter((cell) => cell === "█").length;
    assert.deepEqual(
      [0, 1, 49, 50, 68, 99, 100].map((value) => filled(value)),
      [0, 1, 10, 10, 14, 19, 20],
    );
  });

  it("menambahkan tahun pada reset lintas tahun", () => {
    const rendered = renderUsageDashboard(acceptanceSummary({
      period: {
        startsAt: "2026-12-20T17:00:00.000Z",
        endsAt: "2027-01-01T17:00:00.000Z",
        resetsAt: "2027-01-01T17:00:00.000Z",
      },
    }), "plain").text;
    assert.match(rendered, /Periode\n21 Des – 2 Jan/u);
    assert.match(rendered, /Reset\n2 Januari 2027/u);
  });

  it("memakai copy Free, PAYG, BYOK, dan exhausted tanpa enum internal", () => {
    const free = renderUsageDashboard(acceptanceSummary({
      plan: { id: "personal_perkenalan", publicName: "Perkenalan", isFree: true },
      allowance: { remainingPercent: 0, state: "exhausted" },
      funding: {
        ...acceptanceSummary().funding,
        includedUsdNanos: "180000000",
        byokUsdNanos: "0",
        paygRelevant: false,
        current: null,
      },
    }), "plain").text;
    assert.match(free, /Ditanggung Harvy: \$0\.18/u);
    assert.match(free, /Penggunaan gratis periode ini sudah terpakai/u);

    const payg = renderUsageDashboard(acceptanceSummary({
      funding: {
        ...acceptanceSummary().funding,
        includedUsdNanos: "0",
        byokUsdNanos: "0",
        paygIdr: "6400",
        paygUsed: true,
        current: { type: "payg" },
      },
    }), "plain").text;
    assert.match(payg, /Saldo tambahan: Rp6\.400/u);
    assert.match(payg, /Saat ini menggunakan\nSaldo tambahan/u);

    const byok = renderUsageDashboard(acceptanceSummary({
      funding: {
        ...acceptanceSummary().funding,
        includedUsdNanos: "0",
        byokUsdNanos: "180000000",
        paygRelevant: false,
        current: { type: "byok", providerName: "OpenAI" },
      },
    }), "plain").text;
    assert.match(byok, /API milikmu: \$0\.18/u);
    assert.match(byok, /API milikmu · OpenAI/u);
    assert.doesNotMatch(byok, /credential|secret|subject_/iu);
  });

  it("memberi peringatan ringan untuk seluruh state hampir habis", () => {
    for (const state of ["getting_low", "low"] as const) {
      const rendered = renderUsageDashboard(acceptanceSummary({
        allowance: { remainingPercent: 9, state },
      }), "plain").text;
      assert.match(rendered, /Penggunaanmu hampir habis untuk periode ini/u);
    }
    assert.doesNotMatch(
      renderUsageDashboard(acceptanceSummary(), "plain").text,
      /hampir habis/u,
    );
  });

  it("memformat angka compact dan menolak target akun pada grammar command", () => {
    assert.deepEqual(
      [812, 1_200, 31_000, 184_000, 1_400_000].map(formatCompactUsage),
      ["812", "1.2k", "31k", "184k", "1.4M"],
    );
    assert.equal(parseUsageDashboardCommand("/penggunaan"), "summary");
    assert.equal(parseUsageDashboardCommand("/usage@harvy_bot"), "summary");
    assert.equal(parseUsageDashboardCommand("/penggunaan user123"), "invalid");
    assert.equal(parseUsageDashboardCommand("halo"), null);
  });
});

function accounting(
  overrides: Partial<EconomyUserUsageAccounting> = {},
): EconomyUserUsageAccounting {
  return {
    usage: {
      subjectRef: "subject-owner",
      planId: "personal_perkenalan",
      planName: "Perkenalan",
      subscriptionStatus: "free",
      periodId: "period-owner",
      periodStartsAt: PERIOD_START,
      periodEndsAt: PERIOD_END,
      includedComputeUnits: "1000",
      usedComputeUnits: "500",
      reservedComputeUnits: "0",
      remainingIncludedComputeUnits: "500",
      sponsoredGrantedComputeUnits: "0",
      sponsoredRemainingComputeUnits: "0",
      walletComputeUnits: "0",
      byokAvailable: false,
      health: "healthy",
      nextResetAt: PERIOD_END,
      fundingPreference: "harvy_first",
      autoUseWallet: false,
    },
    settledRequests: [{ requestId: "request-1", fundingSource: "included" }],
    walletDebitIdrNanos: "0",
    walletUsed: false,
    walletRelevant: false,
    currentFunding: { source: "included", providerId: null },
    ...overrides,
  };
}

function attempt(options: {
  requestId?: string;
  fundingSource?: ProviderAttemptRecord["fundingSource"];
  inputTokens?: number;
  cacheReadTokens?: number | null;
  outputTokens?: number;
  reasoningTokens?: number | null;
  effectiveCostUsdNanos?: string | null;
  effectiveSource?: "provider" | "catalog";
  priceSnapshot?: ModelPriceRates | null;
  status?: ProviderAttemptRecord["status"];
  responseOutcome?: ProviderAttemptRecord["responseOutcome"];
} = {}): ProviderAttemptRecord {
  const input = options.inputTokens ?? 1_000;
  const output = options.outputTokens ?? 200;
  const cost = options.effectiveCostUsdNanos === undefined
    ? "1000000"
    : options.effectiveCostUsdNanos;
  const source = options.effectiveSource ?? "catalog";
  return {
    schemaVersion: 1,
    attemptId: `attempt-${options.requestId ?? "1"}`,
    requestId: options.requestId ?? "request-1",
    turnId: "turn-1",
    attemptNo: 1,
    startedAt: "2026-08-21T00:00:00.000Z",
    finishedAt: "2026-08-21T00:00:01.000Z",
    environment: "production",
    costCenter: "runtime",
    subjectRef: "subject-owner",
    subjectKind: "private",
    channel: "telegram",
    actorRef: "subject-owner",
    cohort: "standard",
    planId: "personal_toro",
    providerId: "openai",
    origin: "primary",
    modelId: "model-uji",
    tier: "efficient",
    purpose: "reply",
    maxOutputTokens: 1_000,
    inputTokenEstimate: input,
    safetyCritical: false,
    fundingSource: options.fundingSource ?? "included",
    status: options.status ?? "completed",
    httpStatus: 200,
    responseOutcome: options.responseOutcome ?? "accepted",
    finishReason: "stop",
    latencyMs: 1_000,
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      estimated: false,
      reasoningTokens: options.reasoningTokens === undefined ? 0 : options.reasoningTokens,
      cacheReadTokens: options.cacheReadTokens === undefined ? 500 : options.cacheReadTokens,
      cacheWriteTokens: 0,
      source: "provider",
    },
    providerGenerationId: null,
    priceVersionId: "price-historical",
    priceSnapshot: options.priceSnapshot === undefined
      ? {
          inputPerMillionUsd: "1",
          outputPerMillionUsd: "2",
          cacheReadPerMillionUsd: "0.1",
          cacheWritePerMillionUsd: null,
          reasoningPerMillionUsd: "2",
          perRequestUsd: null,
        }
      : options.priceSnapshot,
    cost: {
      providerReportedUsdNanos: source === "provider" ? cost : null,
      localCalculatedUsdNanos: source === "catalog" ? cost : null,
      effectiveUsdNanos: cost,
      effectiveSource: cost === null ? "unpriced" : source,
      reconciliation: cost === null ? "unavailable" : "matched",
    },
  };
}

function acceptanceSummary(overrides: Partial<UserUsageSummary> = {}): UserUsageSummary {
  return {
    plan: { id: "personal_toro", publicName: "Toro", isFree: false },
    period: { startsAt: PERIOD_START, endsAt: PERIOD_END, resetsAt: PERIOD_END },
    allowance: { remainingPercent: 68, state: "healthy" },
    modelUsage: {
      inputTokens: 184_000,
      cachedInputTokens: 121_000,
      outputTokens: 31_000,
      reasoningTokens: 18_000,
      hasEstimatedUsage: false,
    },
    cost: {
      totalProviderCostUsdNanos: "180000000",
      completeness: "complete",
      providerReportedUsdNanos: "160000000",
      catalogCalculatedUsdNanos: "20000000",
    },
    funding: {
      includedUsdNanos: "160000000",
      sponsoredUsdNanos: "0",
      byokUsdNanos: "20000000",
      harvyOverheadUsdNanos: "0",
      walletProviderCostUsdNanos: "0",
      paygIdr: "0",
      paygUsed: false,
      paygRelevant: true,
      current: { type: "plan", publicName: "Toro" },
    },
    efficiency: { cacheHitPercent: 66, cacheSavingsUsdNanos: "110000000" },
    ...overrides,
  };
}
