import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EconomyCommandService,
  type EconomySemanticRequest,
} from "../src/core/economy-command-service.js";
import type { EconomyUsageView } from "../src/core/economy-service.js";
import type {
  SemanticDomain,
  SemanticExplicitness,
  SemanticOperationName,
  SemanticReference,
} from "../src/domain/semantic-operation.js";

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
  let usageReads = 0;
  let lastPreference: unknown = null;
  let supportDismissed = false;
  const fake = {
    usage: async () => {
      usageReads += 1;
      return usage({ usedComputeUnits: String(usageReads * 10) });
    },
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
    secureByokSetupAvailable: true,
  };
  return {
    fake,
    get usageReads() { return usageReads; },
    get lastPreference() { return lastPreference; },
    get supportDismissed() { return supportDismissed; },
  };
}

describe("economy semantic command UX", () => {
  it("menerima meaning lintas bahasa tanpa synonym parser lokal", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    for (const message of [
      "Berapa sisa penggunaan Harvy-ku?",
      "How much Harvy usage do I have left?",
      "sésa pamakean abdi sabaraha?",
      "sisa usage-ku piro, Harvy?",
    ]) {
      const reply = await commands.handle(
        "owner-uji",
        request(message, "usage", "show-summary"),
      );
      assert.match(reply ?? "", /Penggunaan Harvy/u);
      assert.doesNotMatch(reply ?? "", /token|provider|inference/u);
    }
    assert.equal(harness.usageReads, 4, "setiap follow-up membaca state baru");

    for (const message of [
      "harvy detail penggunaan ku",
      "harvy detail usage",
      "show my usage details",
      "detail usage gw dong",
    ]) {
      const reply = await commands.handle(
        "owner-uji",
        request(message, "usage", "show-details"),
      );
      assert.match(reply ?? "", /Penggunaan Harvy/u, message);
    }
    assert.equal(harness.usageReads, 8);

    const recommendation = await commands.handle(
      "owner-uji",
      request("Which plan fits me?", "billing", "recommend-plan"),
    );
    assert.match(recommendation ?? "", /Perkenalan/u);
  });

  it("mengizinkan contextual details tetapi menolak subject orang lain", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const details = await commands.handle(
      "owner-uji",
      request(
        "detailnya",
        "usage",
        "show-details",
        null,
        "contextual",
        "recent",
      ),
    );
    assert.match(details ?? "", /Penggunaan Harvy/u);

    const other = request("show their usage", "usage", "show-summary");
    other.semanticOperation!.subject = "other";
    assert.equal(await commands.handle("owner-uji", other), null);

    assert.equal(
      await commands.handle(
        "owner-uji",
        request("what do you remember about me?", "memory", "recall"),
      ),
      null,
    );
  });

  it("mengubah funding hanya dari target closed-set dan explicit evidence", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const disabled = await commands.handle(
      "owner-uji",
      request("disable automatic wallet", "billing", "set-funding", "wallet-off"),
    );
    assert.match(disabled ?? "", /tidak akan digunakan otomatis/u);
    assert.deepEqual(harness.lastPreference, { autoUseWallet: false });

    const implicit = await commands.handle(
      "owner-uji",
      request(
        "maybe I prefer Harvy first",
        "billing",
        "set-funding",
        "harvy-first",
        "implicit",
      ),
    );
    assert.equal(implicit, null);

    assert.equal(
      await commands.handle(
        "owner-uji",
        request(
          "I might cancel my subscription someday",
          "billing",
          "cancel-subscription",
          null,
          "implicit",
        ),
      ),
      null,
    );

    const payment = await commands.handle(
      "owner-uji",
      request("top up compute Rp10 ribu", "billing", "top-up"),
    );
    assert.match(payment ?? "", /belum tersedia/u);
  });

  it("menolak credential sebelum semantic routing dan menjaga dukungan opsional", async () => {
    const harness = fakeEconomy();
    const commands = new EconomyCommandService(harness.fake as never);
    const pasted = await commands.handle("owner-uji", {
      rawText: "pakai key sk-proj-1234567890abcdef",
      semanticOperation: null,
    });
    assert.match(pasted ?? "", /jangan kirim API key/u);

    const byok = await commands.handle(
      "owner-uji",
      request("set up BYOK", "billing", "setup-byok"),
    );
    assert.match(byok ?? "", /secure setup|jangan kirim API key/iu);
    const support = await commands.handle(
      "owner-uji",
      request("Support Harvy", "billing", "show-support"),
    );
    assert.match(support ?? "", /opsional/u);
    assert.doesNotMatch(support ?? "", /sayang|tetap hidup|butuh bantuanmu/u);
    const dismissed = await commands.handle(
      "owner-uji",
      request("Don't show contribution reminders", "billing", "dismiss-support"),
    );
    assert.match(dismissed ?? "", /tidak akan ditampilkan lagi/u);
    assert.equal(harness.supportDismissed, true);
  });
});

function request(
  rawText: string,
  domain: SemanticDomain,
  operation: SemanticOperationName,
  target: string | null = null,
  explicitness: SemanticExplicitness = "explicit",
  reference: SemanticReference = "none",
): EconomySemanticRequest {
  return {
    rawText,
    semanticOperation: {
      version: 1,
      domain,
      operation,
      target,
      subject: "self",
      reference,
      explicitness,
      evidence: rawText,
      confidence: 0.95,
    },
  };
}
