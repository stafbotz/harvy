import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EconomyCommandService } from "../src/core/economy-command-service.js";
import type { EconomyUsageView } from "../src/core/economy-service.js";

function usage(overrides: Partial<EconomyUsageView> = {}): EconomyUsageView {
  return {
    subjectRef: "subject-uji",
    planId: "personal_perkenalan",
    planName: "Perkenalan",
    subscriptionStatus: "free",
    periodId: "period-uji",
    periodStartsAt: "2026-08-21T00:00:00.000Z",
    periodEndsAt: "2026-09-20T00:00:00.000Z",
    includedComputeUnits: "100",
    usedComputeUnits: "10",
    reservedComputeUnits: "0",
    remainingIncludedComputeUnits: "90",
    sponsoredGrantedComputeUnits: "0",
    sponsoredRemainingComputeUnits: "0",
    walletComputeUnits: "0",
    byokAvailable: false,
    health: "healthy",
    nextResetAt: "2026-09-20T00:00:00.000Z",
    fundingPreference: "harvy_first",
    autoUseWallet: false,
    ...overrides,
  };
}

function fakeEconomy() {
  let lastPreference: unknown = null;
  let supportDismissed = false;
  const fake = {
    usage: async () => usage(),
    recommendPlan: async () => ({
      kind: "downgrade" as const,
      currentPlanId: "personal_sora",
      recommendedPlanId: "personal_perkenalan",
      recommendedPublicName: "Perkenalan",
      monthlyPriceIdr: 0,
      reason: "lower_actual_usage" as const,
    }),
    setFundingPreference: async (_owner: string, patch: unknown) => {
      lastPreference = patch;
      return patch as never;
    },
    createTopupCheckout: async () => {
      throw new Error("Pembayaran langsung belum tersedia pada instalasi ini.");
    },
    createContributionCheckout: async () => {
      throw new Error("Pembayaran langsung belum tersedia pada instalasi ini.");
    },
    cancelSubscription: async () => null,
    dismissSupport: async () => {
      supportDismissed = true;
    },
  };
  return {
    fake,
    get lastPreference() { return lastPreference; },
    get supportDismissed() { return supportDismissed; },
  };
}

describe("economy account command UX", () => {
  it("menjawab usage dan rekomendasi tanpa token/provider jargon", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const reply = await commands.handle("owner-uji", "Berapa sisa penggunaan Harvy-ku?");
    assert.match(reply ?? "", /Penggunaan Harvy/u);
    assert.doesNotMatch(reply ?? "", /token|provider|inference/u);
    const recommendation = await commands.handle("owner-uji", "Paket mana yang paling murah buat pemakaianku?");
    assert.match(recommendation ?? "", /Perkenalan/u);
  });

  it("menghormati consent wallet dan tidak membuat dead-end payment", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const disabled = await commands.handle("owner-uji", "Jangan gunakan saldo PAYG otomatis");
    assert.match(disabled ?? "", /tidak akan digunakan otomatis/u);
    assert.deepEqual(harness.lastPreference, { autoUseWallet: false });
    const harvyFirst = await commands.handle("owner-uji", "Jangan utamakan BYOK");
    assert.match(harvyFirst ?? "", /Harvy-first/u);
    assert.deepEqual(harness.lastPreference, { mode: "harvy_first" });
    const payment = await commands.handle("owner-uji", "Aku mau tambah compute Rp10 ribu");
    assert.match(payment ?? "", /belum tersedia/u);
  });

  it("tidak meminta raw API key lewat chat dan dukungan tetap optional", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const byok = await commands.handle("owner-uji", "Aku mau pakai API OpenAI-ku sendiri");
    assert.match(byok ?? "", /secure setup|jangan kirim API key/u);
    const pasted = await commands.handle("owner-uji", "pakai key sk-proj-1234567890abcdef");
    assert.match(pasted ?? "", /jangan kirim API key/u);
    const support = await commands.handle("owner-uji", "Dukung Harvy");
    assert.match(support ?? "", /opsional/u);
    assert.doesNotMatch(support ?? "", /sayang|tetap hidup|butuh bantuanmu/u);
    const dismissed = await commands.handle(
      "owner-uji",
      "Tidak sekarang untuk kontribusi Harvy Commons",
    );
    assert.match(dismissed ?? "", /tidak akan ditampilkan lagi/u);
    assert.equal(harness.supportDismissed, true);
  });
});
