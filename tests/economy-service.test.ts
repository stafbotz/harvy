import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import {
  EconomyService,
  FundingUnavailableError,
} from "../src/core/economy-service.js";
import { LocalPaymentGateway } from "../src/core/payment-gateway.js";
import {
  EncryptedFileSecretStore,
  MemorySecretStore,
} from "../src/core/secret-store.js";
import { FileEconomyRepository } from "../src/storage/file-economy-repository.js";
import type {
  ConfiguredModel,
  ControlPlaneRepository,
  ControlPlaneState,
} from "../src/domain/control-plane.js";
import type { EconomyRepository, EconomyState } from "../src/domain/economy.js";
import type { AiUsageContext } from "../src/domain/telemetry.js";
import { selectGlobalRoute } from "../src/ai/model-policy.js";

class MemoryEconomyRepository implements EconomyRepository {
  state: EconomyState = {
    version: 2,
    subscriptions: [],
    periods: [],
    sponsoredGrants: [],
    reservations: [],
    settlements: [],
    walletTransactions: [],
    walletAccounts: [],
    payments: [],
    contributions: [],
    credentials: [],
    preferences: [],
    notifications: [],
    supportPrompts: [],
    usageProjections: [],
    ledger: [],
  };
  private queue: Promise<unknown> = Promise.resolve();

  async snapshot(): Promise<EconomyState> {
    return structuredClone(this.state);
  }

  async mutate<T>(operation: (draft: EconomyState) => T): Promise<T> {
    const run = this.queue.then(() => {
      const draft = structuredClone(this.state);
      const result = operation(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

class MemoryControlPlaneRepository implements ControlPlaneRepository {
  state: ControlPlaneState = {
    version: 1,
    installationKey: "economy-test-installation-key",
    plans: [],
    prices: [],
    enrollments: [],
    principals: [],
    audit: [],
  };
  async snapshot(): Promise<ControlPlaneState> {
    return structuredClone(this.state);
  }
  async mutate<T>(operation: (draft: ControlPlaneState) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = operation(draft);
    this.state = draft;
    return result;
  }
}

function configuredModel(): ConfiguredModel {
  return {
    providerId: "provider-uji",
    modelId: "model-uji",
    active: true,
    sources: [{
      environmentVariable: "AI_MODEL_TESTING",
      mode: "testing",
      origin: "primary",
      tiers: ["cheap", "efficient", "ambitious"],
      active: true,
    }],
  };
}

function setup(options: {
  now?: () => Date;
  secretStore?: MemorySecretStore;
  gateway?: LocalPaymentGateway;
  baseLimit?: number;
  gettingLowThresholdBps?: number;
  lowThresholdBps?: number;
} = {}) {
  const repository = new MemoryControlPlaneRepository();
  const now = options.now ?? (() => new Date("2026-08-21T00:00:00.000Z"));
  const control = new ControlPlaneService(repository, {
    fallbackRollingTokenLimit: options.baseLimit ?? 100,
    betaQuotaMultiplier: 4,
    configuredModels: [configuredModel()],
    priceBootstraps: [{
      providerId: "provider-uji",
      modelId: "model-uji",
      inputPerMillionUsd: "1",
      outputPerMillionUsd: "2",
    }],
  }, now);
  const economyRepository = new MemoryEconomyRepository();
  const economyOptions = {
    providerId: "provider-uji",
    paygComputeUnitsPerIdr: "100000",
    gettingLowThresholdBps: options.gettingLowThresholdBps ?? 5_000,
    lowThresholdBps: options.lowThresholdBps ?? 2_000,
    notificationCooldownMs: 24 * 60 * 60 * 1_000,
    supportMilestone: 2,
    ...(options.gateway ? { paymentGateway: options.gateway } : {}),
  };
  const economy = new EconomyService(
    economyRepository,
    control,
    economyOptions,
    now,
    options.secretStore ?? null,
  );
  if (options.secretStore) {
    economy.setCredentialAvailabilityProvider((ref) => economy.credentialAvailable(ref));
  }
  return { repository, economyRepository, control, economy, now };
}

function context(overrides: Partial<AiUsageContext> = {}): AiUsageContext {
  return {
    requestId: overrides.requestId ?? `request-${Math.random()}`,
    turnId: overrides.turnId === undefined ? "turn-1" : overrides.turnId,
    ownerId: overrides.ownerId ?? "owner-uji",
    tier: overrides.tier ?? "cheap",
    purpose: overrides.purpose ?? "reply",
    model: overrides.model ?? "model-uji",
    maxTokens: overrides.maxTokens ?? 10,
    inputTokenEstimate: overrides.inputTokenEstimate ?? 5,
    safetyCritical: overrides.safetyCritical ?? false,
    ...overrides,
  };
}

function setSmallAllowance(
  repository: MemoryControlPlaneRepository,
  included = "20",
): void {
  const free = repository.state.plans.find(
    (plan) => plan.planId === "personal_perkenalan",
  );
  if (!free?.computePolicy) throw new Error("Free policy test tidak tersedia.");
  free.computePolicy.includedComputeUnits = included;
  free.computePolicy.rollingComputeLimit = "100000";
}

describe("Harvy Compute economy authority", () => {
  it("memisahkan reservation, delivery settlement, dan internal failure", async () => {
    const { economy, economyRepository } = setup();
    const first = context({ requestId: "success", turnId: "turn-success" });
    const funding = await economy.reserve(first);
    assert.equal(funding.source, "included");
    await economy.completeRequest(first, {
      inputTokens: 5,
      outputTokens: 4,
      totalTokens: 9,
      estimated: false,
    }, { succeeded: true });
    const beforeDelivery = await economy.usage(first.ownerId);
    assert.equal(beforeDelivery.usedComputeUnits, "0");
    await economy.settleTurn(first.ownerId, first.turnId);
    const afterDelivery = await economy.usage(first.ownerId);
    assert.ok(BigInt(afterDelivery.usedComputeUnits) > 0n);

    const failed = context({ requestId: "failed", turnId: "turn-failed" });
    await economy.reserve(failed);
    await economy.completeRequest(failed, {
      inputTokens: 5,
      outputTokens: 4,
      totalTokens: 9,
      estimated: false,
    }, { succeeded: false });
    const state = await economyRepository.snapshot();
    const failedReservation = state.reservations.find((item) => item.requestId === "failed");
    assert.equal(failedReservation?.status, "released");
    assert.equal(
      state.settlements.filter((item) => item.requestId === "failed").length,
      1,
    );
    assert.equal((await economy.usage(first.ownerId)).usedComputeUnits, afterDelivery.usedComputeUnits);
  });

  it("memberi settlement idempoten per reservation dalam satu delivery scope", async () => {
    const setupState = setup();
    const scope = { kind: "group_agent_run_attempt" as const, runId: "run-uji", attemptId: "attempt-uji" };
    const first = context({ requestId: "scope-first", turnId: null, deliveryScope: scope });
    const second = context({ requestId: "scope-second", turnId: null, deliveryScope: scope });
    await setupState.economy.reserve(first);
    await setupState.economy.reserve(second);
    for (const request of [first, second]) {
      await setupState.economy.completeRequest(request, {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: false,
      }, { succeeded: true });
    }
    const ownerView = await setupState.economy.usage(first.ownerId);
    await setupState.economy.settleDeliveryScope(
      { subjectRef: ownerView.subjectRef, runId: scope.runId, attemptId: scope.attemptId },
      "committed",
      "effect-uji",
    );
    const settlements = (await setupState.economyRepository.snapshot()).settlements
      .filter((item) => item.requestId === first.requestId || item.requestId === second.requestId);
    assert.equal(settlements.length, 2);
    assert.notEqual(settlements[0]?.idempotencyKey, settlements[1]?.idempotencyKey);
  });

  it("membekukan snapshot harga provider pada saat reservation", async () => {
    const setupState = setup();
    const request = context({ requestId: "price-snapshot", inputTokenEstimate: 1, maxTokens: 1 });
    await setupState.economy.reserve(request);
    await setupState.repository.mutate((state) => {
      const price = state.prices[0];
      if (!price) throw new Error("Harga test tidak tersedia.");
      price.rates.inputPerMillionUsd = "100";
      price.rates.outputPerMillionUsd = "100";
    });
    await setupState.economy.completeRequest(request, {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimated: false,
    }, { succeeded: true });
    await setupState.economy.settleTurn(request.ownerId, request.turnId);
    const settlement = (await setupState.economyRepository.snapshot()).settlements.find(
      (item) => item.requestId === request.requestId,
    );
    assert.equal(settlement?.billableComputeUnits, "3000");
  });

  it("mencegah overspend saat reservation berjalan bersamaan", async () => {
    const setupState = setup();
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "30000");
    const requests = [
      context({ requestId: "race-a", inputTokenEstimate: 10, maxTokens: 10 }),
      context({ requestId: "race-b", inputTokenEstimate: 10, maxTokens: 10 }),
    ];
    const results = await Promise.allSettled(
      requests.map((request) => setupState.economy.reserve(request)),
    );
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.ok(
      (results.find((item) => item.status === "rejected") as PromiseRejectedResult).reason
        instanceof FundingUnavailableError,
    );
  });

  it("memblok inference baru pada boundary Free dan mendedupe notice exhausted", async () => {
    const setupState = setup();
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "30000");
    const request = context({
      requestId: "free-boundary",
      turnId: "free-boundary-turn",
      inputTokenEstimate: 10,
      maxTokens: 10,
    });
    await setupState.economy.reserve(request);
    await setupState.economy.completeRequest(request, {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      estimated: false,
    }, { succeeded: true });
    const notice = await setupState.economy.settleTurn(request.ownerId, request.turnId);
    assert.equal(notice?.health, "exhausted");
    assert.match(notice?.message ?? "", /Penggunaan gratis Harvy-mu/u);
    assert.doesNotMatch(notice?.message ?? "", /token/u);
    assert.match(notice?.message ?? "", /BYOK|provider/u);
    assert.equal(await setupState.economy.settleTurn(request.ownerId, request.turnId), null);
    assert.ok((await setupState.economyRepository.snapshot()).ledger.some(
      (item) => item.type === "notification_state",
    ));
    assert.equal(
      (await setupState.economy.recommendPlan(request.ownerId)).recommendedPlanId,
      "personal_toro",
    );
    await assert.rejects(
      () => setupState.economy.reserve(context({ requestId: "after-free-boundary" })),
      FundingUnavailableError,
    );
  });

  it("memakai threshold konfigurasi yang sama untuk usage view dan notifikasi", async () => {
    const setupState = setup({
      gettingLowThresholdBps: 8_000,
      lowThresholdBps: 1_000,
    });
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "10000");
    const request = context({
      requestId: "configured-health-threshold",
      turnId: "configured-health-threshold-turn",
      inputTokenEstimate: 1,
      maxTokens: 1,
    });
    await setupState.economy.reserve(request);
    await setupState.economy.completeRequest(request, {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimated: false,
    }, { succeeded: true });
    const notice = await setupState.economy.settleTurn(
      request.ownerId,
      request.turnId,
    );
    assert.equal(notice?.health, "getting_low");
    assert.equal((await setupState.economy.usage(request.ownerId)).health, "getting_low");
  });

  it("mengisi ulang periode Free berdasarkan batas ISO eksplisit setelah akun dormant", async () => {
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const setupState = setup({ now: () => new Date(clock) });
    const first = await setupState.economy.usage("owner-dormant");
    clock = new Date("2026-12-01T00:00:00.000Z");
    const current = await setupState.economy.usage("owner-dormant");
    assert.ok(Date.parse(current.periodStartsAt) <= clock.getTime());
    assert.ok(Date.parse(current.periodEndsAt) > clock.getTime());
    assert.notEqual(current.periodId, first.periodId);
    assert.equal(current.remainingIncludedComputeUnits, current.includedComputeUnits);
  });

  it("menggunakan wallet hanya setelah consent dan tidak membuat saldo negatif", async () => {
    const setupState = setup();
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "0");
    const owner = "owner-uji";
    await setupState.economy.grantWalletForTest(owner, 1, "topup-1");
    await setupState.economy.setFundingPreference(owner, { autoUseWallet: true });
    const request = context({ requestId: "wallet", inputTokenEstimate: 10, maxTokens: 10 });
    const funding = await setupState.economy.reserve(request);
    assert.equal(funding.source, "wallet");
    const pendingDebit = (await setupState.economyRepository.snapshot())
      .walletTransactions.find((item) =>
        item.relatedReservationId === funding.reservationId &&
        item.status === "pending"
      );
    assert.equal(pendingDebit?.computeUnits, "30000");
    await setupState.economy.completeRequest(request, {
      inputTokens: 5,
      outputTokens: 4,
      totalTokens: 9,
      estimated: false,
    }, { succeeded: true });
    await setupState.economy.settleTurn(owner, request.turnId);
    const state = await setupState.economyRepository.snapshot();
    const wallet = state.walletAccounts.find((item) => item.subjectRef === state.periods[0]?.subjectRef);
    assert.ok(wallet);
    assert.ok(BigInt(wallet.availableComputeUnits) >= 0n);
    const preservedPending = state.walletTransactions.find(
      (item) => item.transactionId === pendingDebit?.transactionId,
    );
    const settledDebit = state.walletTransactions.find((item) =>
      item.relatedReservationId === funding.reservationId &&
      item.status === "succeeded" &&
      item.kind === "debit"
    );
    assert.equal(preservedPending?.status, "pending");
    assert.equal(preservedPending?.computeUnits, "30000");
    assert.equal(settledDebit?.computeUnits, "13000");
    const reservation = state.reservations.find(
      (item) => item.reservationId === funding.reservationId,
    );
    const settlement = state.settlements.find(
      (item) => item.reservationId === funding.reservationId,
    );
    assert.equal(reservation?.walletComputeUnitsPerIdr, "100000");
    assert.equal(settlement?.walletDebitIdrNanos, "130000000");
    const userAccounting = await setupState.economy.userUsageAccounting(owner);
    assert.equal(userAccounting.walletDebitIdrNanos, "130000000");
    assert.equal(userAccounting.walletUsed, true);
    assert.equal(userAccounting.currentFunding?.source, "wallet");
    assert.deepEqual(userAccounting.settledRequests, [{
      requestId: request.requestId,
      fundingSource: "wallet",
    }]);
  });

  it("menolak overflow akumulasi IDR tanpa memutasi wallet", async () => {
    const setupState = setup();
    const usage = await setupState.economy.usage("owner-wallet-overflow");
    await setupState.economyRepository.mutate((state) => {
      state.walletAccounts.push({
        subjectRef: usage.subjectRef,
        availableComputeUnits: "0",
        reservedComputeUnits: "0",
        lifetimeTopupIdr: Number.MAX_SAFE_INTEGER - 10,
        updatedAt: "2026-08-21T00:00:00.000Z",
      });
    });

    await assert.rejects(
      () => setupState.economy.grantWalletForTest(
        "owner-wallet-overflow",
        100,
        "wallet-overflow",
      ),
      /integer aman/u,
    );

    const state = await setupState.economyRepository.snapshot();
    assert.equal(
      state.walletAccounts[0]?.lifetimeTopupIdr,
      Number.MAX_SAFE_INTEGER - 10,
    );
    assert.equal(state.walletAccounts[0]?.availableComputeUnits, "0");
    assert.equal(state.walletTransactions.length, 0);
  });

  it("memilih sponsored sebelum wallet secara deterministik dan mengikat idempotency", async () => {
    const setupState = setup();
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "0");
    const ownerId = "owner-uji";
    const usage = await setupState.economy.usage(ownerId);
    const grantInput = {
      idempotencyKey: "sponsor-program-grant-1",
      subjectRef: usage.subjectRef,
      source: "sponsor" as const,
      programRef: "program-literasi-1",
      unitVersion: 1 as const,
      amount: "30000",
      effectiveFrom: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-22T00:00:00.000Z",
    };
    const grant = await setupState.economy.addSponsoredGrant(grantInput);
    assert.equal(
      (await setupState.economy.addSponsoredGrant(grantInput)).grantId,
      grant.grantId,
    );
    await assert.rejects(
      () => setupState.economy.addSponsoredGrant({
        ...grantInput,
        subjectRef: "subject_other",
      }),
      /intent lain/u,
    );
    await setupState.economy.grantWalletForTest(ownerId, 1, "sponsor-wallet-topup");
    await setupState.economy.setFundingPreference(ownerId, { autoUseWallet: true });

    const sponsored = await setupState.economy.reserve(context({
      ownerId,
      requestId: "sponsor-priority-request",
      inputTokenEstimate: 10,
      maxTokens: 10,
    }));
    const wallet = await setupState.economy.reserve(context({
      ownerId,
      requestId: "wallet-after-sponsor-request",
      inputTokenEstimate: 10,
      maxTokens: 10,
    }));
    assert.equal(sponsored.source, "sponsored");
    assert.equal(wallet.source, "wallet");
  });

  it("menghitung health sponsored-only dari grant awal, bukan saldo sesaat", async () => {
    const setupState = setup();
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "0");
    const ownerId = "owner-sponsored-health";
    const subjectRef = (await setupState.economy.usage(ownerId)).subjectRef;
    await setupState.economy.addSponsoredGrant({
      idempotencyKey: "sponsor-health-grant",
      subjectRef,
      source: "sponsor",
      programRef: "program-health",
      unitVersion: 1,
      amount: "10000",
      effectiveFrom: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-22T00:00:00.000Z",
    });
    const request = context({
      ownerId,
      requestId: "sponsor-health-request",
      turnId: "sponsor-health-turn",
      inputTokenEstimate: 3,
      maxTokens: 3,
    });
    assert.equal((await setupState.economy.reserve(request)).source, "sponsored");
    await setupState.economy.completeRequest(request, {
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6,
      estimated: false,
    }, { succeeded: true });
    assert.equal(
      (await setupState.economy.settleTurn(ownerId, request.turnId))?.health,
      "low",
    );
    assert.equal((await setupState.economy.usage(ownerId)).health, "low");
  });

  it("menjaga BYOK di secret store terpisah dan menghentikan credential yang dicabut", async () => {
    const secretStore = new MemorySecretStore();
    const setupState = setup({ secretStore });
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "0");
    const ownerId = "owner-uji";
    await assert.rejects(
      () => setupState.economy.registerCredential({
        ownerId,
        providerId: "internal",
        baseUrl: "https://169.254.169.254",
        modelId: "owned-model",
        eligibleTiers: ["cheap"],
        apiKey: "secret-api-key-1234",
      }),
      /Base URL/u,
    );
    const credential = await setupState.economy.registerCredential({
      ownerId,
      providerId: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      modelId: "owned-model",
      eligibleTiers: ["cheap"],
      apiKey: "secret-api-key-1234",
    });
    await setupState.economy.setFundingPreference(ownerId, {
      mode: "byok_first",
      preferredCredentialRef: credential.credentialRef,
    });
    const request = context({ requestId: "byok", inputTokenEstimate: 10, maxTokens: 10 });
    const funding = await setupState.economy.reserve(request);
    assert.equal(funding.source, "byok");
    const resolved = await setupState.economy.credentialForReservation(funding.reservationId, ownerId);
    assert.equal(resolved?.apiKey, "secret-api-key-1234");
    const snapshot = JSON.stringify(await setupState.economy.operatorSnapshot());
    assert.equal(snapshot.includes("secret-api-key-1234"), false);
    await setupState.economy.revokeCredential(ownerId, credential.credentialRef);
    assert.equal(await setupState.economy.credentialAvailable(credential.credentialRef), false);
  });

  it("mengikat ciphertext BYOK ke credential ref dan tidak menulis raw secret", async () => {
    const folder = await mkdtemp(join(tmpdir(), "harvy-byok-secret-"));
    const file = join(folder, "byok-secrets.json");
    const rawSecret = "sk-test-secret-that-must-not-leak";
    try {
      const store = new EncryptedFileSecretStore(
        file,
        new Uint8Array(32).fill(7),
      );
      await store.put("credential_a", rawSecret);
      assert.equal(await store.get("credential_a"), rawSecret);
      const serialized = await readFile(file, "utf8");
      assert.doesNotMatch(serialized, /sk-test-secret/u);
      const tampered = JSON.parse(serialized) as Record<string, string>;
      tampered.credential_b = tampered.credential_a!;
      await writeFile(file, JSON.stringify(tampered));
      const reopened = new EncryptedFileSecretStore(
        file,
        new Uint8Array(32).fill(7),
      );
      await assert.rejects(() => reopened.get("credential_b"));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("membuat top-up dan webhook contribution idempoten", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    const ownerId = "owner-uji";
    const checkout = await setupState.economy.createTopupCheckout(ownerId, 10_000, "checkout-1");
    assert.equal(await setupState.economy.createTopupCheckout(ownerId, 10_000, "checkout-1").then((item) => item.gatewayPaymentRef), checkout.gatewayPaymentRef);
    await assert.rejects(
      () => setupState.economy.createTopupCheckout("owner-lain", 10_000, "checkout-1"),
      /intent lain/u,
    );
    const event = gateway.succeed("checkout-1");
    await setupState.economy.applyPaymentWebhook(event);
    await setupState.economy.applyPaymentWebhook(event);
    const state = await setupState.economyRepository.snapshot();
    assert.equal(state.walletTransactions.length, 1);
    assert.equal(BigInt(state.walletAccounts[0]?.availableComputeUnits ?? "0"), 1_000_000_000n);
    const contributionCheckout = await setupState.economy.createContributionCheckout(
      ownerId,
      5_000,
      "contribution-1",
    );
    assert.equal((await setupState.economyRepository.snapshot()).contributions[0]?.status, "pending");
    await setupState.economy.applyPaymentWebhook(gateway.succeed("contribution-1"));
    const contributionState = await setupState.economyRepository.snapshot();
    assert.equal(contributionState.contributions[0]?.status, "succeeded");
    assert.equal(contributionState.contributions[0]?.paymentId,
      contributionState.payments.find((item) => item.gatewayPaymentRef === contributionCheckout.gatewayPaymentRef)?.paymentId);
    assert.equal(
      contributionState.walletAccounts[0]?.availableComputeUnits,
      "1000000000",
    );
    assert.equal((await setupState.economy.usage(ownerId)).planId, "personal_perkenalan");
  });

  it("menolak webhook payment yang tidak mempunyai intent checkout lokal", async () => {
    const setupState = setup({ gateway: new LocalPaymentGateway() });
    const subjectRef = (await setupState.economy.usage("owner-uji")).subjectRef;
    await assert.rejects(
      () => setupState.economy.applyPaymentWebhook({
        gatewayPaymentRef: "forged-payment",
        idempotencyKey: "forged-event",
        status: "succeeded",
        amountIdr: 10_000,
        purpose: "wallet_topup",
        subjectRef,
        receivedAt: "2026-08-21T00:00:00.000Z",
      }),
      /checkout pending/u,
    );
    assert.equal((await setupState.economyRepository.snapshot()).payments.length, 0);
  });

  it("menerapkan payment success baru sekali dan mengabaikan terminal event lama", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    await setupState.economy.createTopupCheckout(
      "owner-uji",
      10_000,
      "out-of-order-checkout",
    );
    const base = gateway.succeed("out-of-order-checkout");
    await setupState.economy.applyPaymentWebhook({
      ...base,
      status: "failed",
      receivedAt: "2026-08-21T00:00:00.000Z",
    });
    await setupState.economy.applyPaymentWebhook({
      ...base,
      status: "succeeded",
      receivedAt: "2026-08-21T00:01:00.000Z",
    });
    await setupState.economy.applyPaymentWebhook({
      ...base,
      status: "expired",
      receivedAt: "2026-08-21T00:00:30.000Z",
    });
    const state = await setupState.economyRepository.snapshot();
    assert.equal(state.payments[0]?.status, "succeeded");
    assert.equal(state.walletTransactions.filter((item) => item.kind === "topup").length, 1);
  });

  it("memisahkan subscription state, renewal, dan cancel-at-period-end", async () => {
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const setupState = setup({ now: () => new Date(clock) });
    const ownerId = "owner-uji";
    const active = await setupState.economy.activateSubscriptionForTest({
      ownerId,
      planId: "personal_toro",
      idempotencyKey: "subscription-activate-1",
    });
    assert.equal(active.status, "active");
    const cancelled = await setupState.economy.cancelSubscription(ownerId);
    assert.equal(cancelled?.status, "cancel_at_period_end");
    assert.equal(cancelled?.cancelAtPeriodEnd, true);
    const periodEnd = cancelled!.currentPeriodEnd;
    clock = new Date(Date.parse(periodEnd) + 1_000);
    await assert.rejects(
      () => setupState.economy.renewSubscriptionForTest(ownerId, "renew-after-cancel"),
      /dibatalkan/u,
    );
    const after = await setupState.economy.usage(ownerId);
    assert.equal(after.planId, "personal_perkenalan");
    assert.equal(after.subscriptionStatus, "free");
    assert.ok(Date.parse(after.nextResetAt) > Date.parse(periodEnd));
  });

  it("tidak mengaktifkan subscription sebelum payment webhook dan memakai policy paket target", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    const ownerId = "owner-uji";
    const checkout = await setupState.economy.createSubscriptionCheckoutForPlan(
      ownerId,
      "personal_toro",
      "subscription-checkout-1",
    );
    assert.equal((await setupState.economy.usage(ownerId)).planId, "personal_perkenalan");
    const succeeded = gateway.succeed("subscription-checkout-1");
    await setupState.economy.applyPaymentWebhook(succeeded);
    const firstState = await setupState.economyRepository.snapshot();
    const firstEnd = firstState.subscriptions[0]?.currentPeriodEnd;
    const firstPeriodCount = firstState.periods.length;
    await setupState.economy.applyPaymentWebhook(succeeded);
    const after = await setupState.economy.usage(ownerId);
    assert.equal(after.planId, "personal_toro");
    assert.ok(BigInt(after.includedComputeUnits) > 0n);
    const state = await setupState.economyRepository.snapshot();
    assert.equal(state.payments.find((item) => item.gatewayPaymentRef === checkout.gatewayPaymentRef)?.status, "succeeded");
    assert.equal(state.subscriptions.filter((item) => item.subjectRef === after.subjectRef).length, 1);
    assert.equal(state.subscriptions[0]?.currentPeriodEnd, firstEnd);
    assert.equal(
      state.periods.filter((item) => item.subjectRef === after.subjectRef).length,
      firstPeriodCount,
    );
    assert.ok(state.ledger.some((item) =>
      item.idempotencyKey === `payment:${checkout.gatewayPaymentRef}:succeeded` &&
      item.source === "subscription"
    ));
  });

  it("tidak menganggap plan enrollment berbayar sebagai subscription tanpa state pembayaran", async () => {
    const setupState = setup();
    const enrollment = await setupState.control.enrollmentForOwner("operator-enrolled");
    await setupState.control.updateEnrollment(
      enrollment.subjectRef,
      enrollment.version,
      { planId: "personal_kuro" },
    );
    const view = await setupState.economy.usage("operator-enrolled");
    assert.equal(view.planId, "personal_perkenalan");
    assert.equal((await setupState.economyRepository.snapshot()).subscriptions.length, 0);
  });

  it("mengikat checkout subscription ke versi katalog yang benar-benar dibeli", async () => {
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway, now: () => new Date(clock) });
    const purchased = (await setupState.control.plans()).find(
      (item) => item.planId === "personal_toro" && item.effectiveTo === null,
    );
    assert.ok(purchased?.computePolicy);
    const checkout = await setupState.economy.createSubscriptionCheckoutForPlan(
      "owner-uji",
      "personal_toro",
      "historical-plan-checkout",
    );
    const pendingPayment = (await setupState.economyRepository.snapshot())
      .payments.find((item) => item.gatewayPaymentRef === checkout.gatewayPaymentRef);
    assert.equal(pendingPayment?.planVersionId, purchased.id);

    clock = new Date("2026-08-22T00:00:00.000Z");
    await setupState.control.createPlanVersion({
      planId: purchased.planId,
      publicName: purchased.publicName,
      audience: purchased.audience,
      monthlyPriceIdr: purchased.monthlyPriceIdr,
      rolling24hTokenLimit: purchased.rolling24hTokenLimit,
      computePolicy: {
        ...purchased.computePolicy,
        includedComputeUnits: (
          BigInt(purchased.computePolicy.includedComputeUnits) + 1_000_000n
        ).toString(),
      },
      activeMemberLimit: purchased.activeMemberLimit,
      groupMode: purchased.groupMode,
      status: purchased.status,
      effectiveFrom: clock.toISOString(),
    });
    await setupState.economy.applyPaymentWebhook(
      gateway.succeed("historical-plan-checkout"),
    );
    const state = await setupState.economyRepository.snapshot();
    const subscription = state.subscriptions[0];
    assert.equal(subscription?.planVersionId, purchased.id);
    assert.equal(
      state.periods.find((item) => item.planVersionId === purchased.id)
        ?.includedGranted,
      purchased.computePolicy.includedComputeUnits,
    );
    const usage = await setupState.economy.usage("owner-uji");
    assert.equal(usage.planId, purchased.planId);
    assert.equal(usage.includedComputeUnits, purchased.computePolicy.includedComputeUnits);
  });

  it("memperpanjang billing period hanya sekali untuk payment renewal", async () => {
    const gateway = new LocalPaymentGateway();
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const setupState = setup({ gateway, now: () => new Date(clock) });
    const firstCheckout = await setupState.economy.createSubscriptionCheckoutForPlan(
      "owner-uji",
      "personal_toro",
      "renewal-initial",
    );
    await setupState.economy.applyPaymentWebhook(gateway.succeed("renewal-initial"));
    const first = await setupState.economy.usage("owner-uji");
    const firstEnd = first.periodEndsAt;
    const secondCheckout = await setupState.economy.createSubscriptionCheckoutForPlan(
      "owner-uji",
      "personal_sora",
      "renewal-second",
    );
    assert.notEqual(firstCheckout.gatewayPaymentRef, secondCheckout.gatewayPaymentRef);
    const renewal = gateway.succeed("renewal-second");
    await setupState.economy.applyPaymentWebhook(renewal);
    await setupState.economy.applyPaymentWebhook(renewal);
    const beforeTransition = await setupState.economy.usage("owner-uji");
    let state = await setupState.economyRepository.snapshot();
    assert.equal(beforeTransition.planId, "personal_toro");
    assert.equal(state.subscriptions[0]?.planId, "personal_sora");
    assert.ok(Date.parse(state.subscriptions[0]?.currentPeriodEnd ?? "") > Date.parse(firstEnd));
    assert.equal(
      state.periods.filter((item) => item.subjectRef === beforeTransition.subjectRef).length,
      2,
    );

    clock = new Date(Date.parse(firstEnd) + 1_000);
    const afterTransition = await setupState.economy.usage("owner-uji");
    assert.equal(afterTransition.planId, "personal_sora");

    // A late replay of the older activation callback must also remain a no-op
    // after a newer renewal effect has already been recorded.
    await setupState.economy.applyPaymentWebhook(gateway.succeed("renewal-initial"));
    const after = await setupState.economy.usage("owner-uji");
    state = await setupState.economyRepository.snapshot();
    const enrollment = await setupState.control.enrollmentForOwner("owner-uji");
    assert.equal(state.subscriptions[0]?.planId, "personal_sora");
    assert.equal(after.planId, "personal_sora");
    assert.equal(enrollment.planId, "personal_sora");
    assert.equal(state.periods.filter((item) => item.subjectRef === after.subjectRef).length, 2);
  });

  it("tidak membatalkan cancel-at-period-end karena callback renewal terlambat", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    await setupState.economy.createSubscriptionCheckoutForPlan(
      "owner-uji",
      "personal_toro",
      "cancel-delayed-initial",
    );
    await setupState.economy.applyPaymentWebhook(
      gateway.succeed("cancel-delayed-initial"),
    );
    const before = await setupState.economy.usage("owner-uji");
    await setupState.economy.createSubscriptionCheckoutForPlan(
      "owner-uji",
      "personal_toro",
      "cancel-delayed-renewal",
    );
    await setupState.economy.cancelSubscription("owner-uji");

    await setupState.economy.applyPaymentWebhook(
      gateway.succeed("cancel-delayed-renewal"),
    );
    const state = await setupState.economyRepository.snapshot();
    const subscription = state.subscriptions[0];
    assert.equal(subscription?.status, "cancel_at_period_end");
    assert.equal(subscription?.cancelAtPeriodEnd, true);
    assert.ok(
      Date.parse(subscription?.currentPeriodEnd ?? "") > Date.parse(before.periodEndsAt),
    );
  });

  it("mereconcile payment/refund tanpa membuat wallet negatif", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    const checkout = await setupState.economy.createTopupCheckout("owner-uji", 10_000, "refund-checkout-1");
    await setupState.economy.reconcilePayment(checkout.gatewayPaymentRef);
    await setupState.economy.applyPaymentWebhook(gateway.succeed("refund-checkout-1"));
    await setupState.economy.refundPayment(checkout.gatewayPaymentRef, "refund-event-1");
    await setupState.economy.refundPayment(checkout.gatewayPaymentRef, "refund-event-1");
    const state = await setupState.economyRepository.snapshot();
    assert.equal(BigInt(state.walletAccounts[0]?.availableComputeUnits ?? "0"), 0n);
    assert.equal(state.walletTransactions.filter((item) => item.kind === "refund").length, 1);
  });

  it("tidak menghidupkan kembali saldo yang direfund dari reservation aktif", async () => {
    const gateway = new LocalPaymentGateway();
    const setupState = setup({ gateway });
    await setupState.control.initialize();
    setSmallAllowance(setupState.repository, "0");
    const ownerId = "owner-uji";
    const checkout = await setupState.economy.createTopupCheckout(
      ownerId,
      1,
      "refund-reserved-checkout",
    );
    await setupState.economy.applyPaymentWebhook(
      gateway.succeed("refund-reserved-checkout"),
    );
    await setupState.economy.setFundingPreference(ownerId, { autoUseWallet: true });
    const request = context({
      ownerId,
      requestId: "refund-reserved-request",
      turnId: "refund-reserved-turn",
      inputTokenEstimate: 10,
      maxTokens: 10,
    });
    const funding = await setupState.economy.reserve(request);
    assert.equal(funding.source, "wallet");

    await setupState.economy.refundPayment(
      checkout.gatewayPaymentRef,
      "refund-reserved-event",
    );
    await setupState.economy.completeRequest(request, {
      inputTokens: 5,
      outputTokens: 4,
      totalTokens: 9,
      estimated: false,
    }, { succeeded: true });
    await setupState.economy.settleTurn(ownerId, request.turnId);

    const state = await setupState.economyRepository.snapshot();
    assert.equal(state.walletAccounts[0]?.availableComputeUnits, "0");
    assert.equal(state.walletAccounts[0]?.reservedComputeUnits, "0");
    assert.equal(
      state.reservations.find((item) => item.reservationId === funding.reservationId)?.status,
      "released",
    );
    assert.equal(
      state.settlements.find((item) => item.reservationId === funding.reservationId)?.outcome,
      "released",
    );
  });

  it("mengakhiri subscription aktif yang tidak diperbarui secara fail-closed", async () => {
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const setupState = setup({ now: () => new Date(clock) });
    const ownerId = "owner-uji";
    const active = await setupState.economy.activateSubscriptionForTest({
      ownerId,
      planId: "personal_toro",
      idempotencyKey: "subscription-active-no-renewal",
    });
    clock = new Date(Date.parse(active.currentPeriodEnd) + 1_000);
    const after = await setupState.economy.usage(ownerId);
    assert.equal(after.planId, "personal_perkenalan");
    const state = await setupState.economyRepository.snapshot();
    assert.equal(state.subscriptions[0]?.status, "expired");
  });

  it("menyelesaikan downgrade setelah restart di antara expiry dan update enrollment", async () => {
    let clock = new Date("2026-08-21T00:00:00.000Z");
    const setupState = setup({ now: () => new Date(clock) });
    const active = await setupState.economy.activateSubscriptionForTest({
      ownerId: "owner-uji",
      planId: "personal_toro",
      idempotencyKey: "subscription-expiry-recovery",
    });
    clock = new Date(Date.parse(active.currentPeriodEnd) + 1_000);
    await setupState.economyRepository.mutate((state) => {
      const subscription = state.subscriptions[0];
      assert.ok(subscription);
      subscription.status = "expired";
      subscription.cancelAtPeriodEnd = false;
      subscription.updatedAt = clock.toISOString();
      subscription.lastEventAt = clock.toISOString();
    });

    const usage = await setupState.economy.usage("owner-uji");
    const enrollment = await setupState.control.enrollmentForOwner("owner-uji");
    assert.equal(usage.planId, "personal_perkenalan");
    assert.equal(enrollment.planId, "personal_perkenalan");
  });

  it("memberi support prompt setelah milestone tanpa spam dan tetap safety-exempt", async () => {
    const setupState = setup({ baseLimit: 100 });
    const ownerId = "owner-uji";
    for (const [index, turnId] of ["support-1", "support-2"].entries()) {
      const request = context({
        ownerId,
        requestId: `support-request-${index}`,
        turnId,
        inputTokenEstimate: 0,
        maxTokens: 0,
      });
      const funding = await setupState.economy.reserve(request);
      assert.equal(funding.source, "included");
      await setupState.economy.completeRequest(request, {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: false,
      }, { succeeded: true });
      await setupState.economy.settleTurn(ownerId, turnId);
    }
    const prompt = await setupState.economy.supportPrompt(ownerId);
    assert.match(prompt ?? "", /opsional/u);
    assert.equal(await setupState.economy.supportPrompt(ownerId), null);
    assert.ok((await setupState.economyRepository.snapshot()).ledger.some(
      (item) => item.type === "support_prompt_state",
    ));
    const before = await setupState.economy.usage(ownerId);
    const safety = context({
      ownerId,
      requestId: "safety-exempt",
      turnId: "safety-turn",
      safetyCritical: true,
      inputTokenEstimate: 100_000,
      maxTokens: 100_000,
    });
    assert.equal((await setupState.economy.reserve(safety)).source, "safety_exempt");
    await setupState.economy.completeRequest(safety, {
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      estimated: false,
    }, { succeeded: true });
    const after = await setupState.economy.usage(ownerId);
    assert.equal(after.usedComputeUnits, before.usedComputeUnits);
    const safetySettlement = (await setupState.economyRepository.snapshot())
      .settlements.find((item) => item.requestId === safety.requestId);
    assert.equal(safetySettlement?.outcome, "safety_exempt");
  });

  it("melakukan migrasi state ekonomi prototipe tanpa menebak ledger lama", async () => {
    const folder = await mkdtemp(join(tmpdir(), "harvy-economy-"));
    const file = join(folder, "economy.json");
    try {
      await writeFile(file, JSON.stringify({ version: 1, subjects: [{ balance: 999 }] }));
      const repository = new FileEconomyRepository(file);
      const state = await repository.snapshot();
      assert.equal(state.version, 2);
      assert.equal(state.ledger.length, 0);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).version, 2);
      await repository.mutate((draft) => draft.ledger.push({
        eventId: "event-1",
        idempotencyKey: "event-1",
        type: "period_opened",
        subjectRef: "subject-uji",
        source: "system",
        amountComputeUnits: "0",
        amountIdr: 0,
        referenceId: "period-1",
        at: "2026-08-21T00:00:00.000Z",
      }));
      assert.equal((await repository.snapshot()).ledger.length, 1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("mengisi projection v2 yang hilang secara forward-only dan idempoten", async () => {
    const folder = await mkdtemp(join(tmpdir(), "harvy-economy-v2-"));
    const file = join(folder, "economy.json");
    try {
      await writeFile(file, JSON.stringify({
        version: 2,
        subscriptions: [],
        periods: [],
        sponsoredGrants: [],
        reservations: [],
        settlements: [],
        walletTransactions: [],
        walletAccounts: [],
        payments: [],
        contributions: [],
        credentials: [],
        preferences: [],
        notifications: [],
        supportPrompts: [],
        ledger: [],
      }));
      const repository = new FileEconomyRepository(file);
      assert.deepEqual((await repository.snapshot()).usageProjections, []);
      const reopened = new FileEconomyRepository(file);
      assert.deepEqual((await reopened.snapshot()).usageProjections, []);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("tidak mengubah quality ceiling berdasarkan plan", async () => {
    const input = {
      intent: "question" as const,
      messageLength: 90,
      assessment: {
        complexity: "deep" as const,
        ambiguity: "medium" as const,
        planningRequired: true,
        emotionalNuance: "low" as const,
        executionSize: "heavy" as const,
        factualStakes: "medium" as const,
        transformationMechanical: false,
        toolNeed: "external" as const,
        confidence: 0.95,
      },
    };
    // Plans are deliberately absent from RoutingInput: changing a plan can
    // only alter funding/allowance, never the cognitive route.
    assert.equal(selectGlobalRoute(input), "orchestrate");
    assert.equal(selectGlobalRoute({ ...input }), "orchestrate");

    const setupState = setup();
    const free = await setupState.economy.usage("owner-free");
    await setupState.economy.activateSubscriptionForTest({
      ownerId: "owner-paid",
      planId: "personal_kuro",
      idempotencyKey: "quality-paid-activation",
    });
    const paid = await setupState.economy.usage("owner-paid");
    assert.equal(free.planId, "personal_perkenalan");
    assert.equal(paid.planId, "personal_kuro");
    const freeContext = context({ ownerId: "owner-free", requestId: "quality-free" });
    const paidContext = context({ ownerId: "owner-paid", requestId: "quality-paid" });
    await setupState.economy.reserve(freeContext);
    await setupState.economy.reserve(paidContext);
    const reservations = (await setupState.economyRepository.snapshot()).reservations;
    const freeReservation = reservations.find((item) => item.requestId === freeContext.requestId)!;
    const paidReservation = reservations.find((item) => item.requestId === paidContext.requestId)!;
    assert.equal(freeReservation.tier, paidReservation.tier);
    assert.equal(freeReservation.purpose, paidReservation.purpose);
    assert.deepEqual(freeReservation.quote, paidReservation.quote);
    assert.equal(freeReservation.planId === paidReservation.planId, false);
  });

  it("menjaga Free finite dan kapasitas plan berbeda saat limit token legacy nol", async () => {
    const setupState = setup({ baseLimit: 0 });
    await setupState.control.initialize();
    const plans = await setupState.control.plans();
    const capacity = (planId: string) => BigInt(
      plans.find((item) => item.planId === planId)?.computePolicy?.includedComputeUnits ?? "0",
    );
    const free = capacity("personal_perkenalan");
    const toro = capacity("personal_toro");
    const sora = capacity("personal_sora");
    const kuro = capacity("personal_kuro");
    assert.ok(free > 0n);
    assert.ok(toro > free);
    assert.ok(sora > toro);
    assert.ok(kuro > sora);

    setupState.repository.state.plans = setupState.repository.state.plans.map(
      ({ computePolicy: _legacyMissingPolicy, ...plan }) => plan,
    );
    const migratedControl = new ControlPlaneService(
      setupState.repository,
      {
        fallbackRollingTokenLimit: 0,
        betaQuotaMultiplier: 4,
        configuredModels: [configuredModel()],
        priceBootstraps: [],
      },
      setupState.now,
    );
    await migratedControl.initialize();
    const migratedPlans = await migratedControl.plans();
    const migratedCapacity = (planId: string) => BigInt(
      migratedPlans.find((item) => item.planId === planId)
        ?.computePolicy?.includedComputeUnits ?? "0",
    );
    assert.equal(migratedCapacity("personal_perkenalan"), free);
    assert.equal(migratedCapacity("personal_toro"), toro);
    assert.equal(migratedCapacity("personal_sora"), sora);
    assert.equal(migratedCapacity("personal_kuro"), kuro);
  });

  it("merekomendasikan kapasitas termurah dan dapat menyarankan downgrade", async () => {
    const freeState = setup();
    const freeView = await freeState.economy.usage("owner-uji");
    await freeState.economyRepository.mutate((state) => {
      state.settlements.push({
        settlementId: "settlement-recommend-free",
        idempotencyKey: "settlement-recommend-free",
        reservationId: "reservation-recommend-free",
        requestId: "request-recommend-free",
        subjectRef: freeView.subjectRef,
        fundingSource: "included",
        billableComputeUnits: "4000000",
        measuredComputeUnits: "4000000",
        deliveryEffectId: "effect-recommend-free",
        outcome: "charged",
        settledAt: "2026-08-21T00:00:00.000Z",
      });
    });
    const upgrade = await freeState.economy.recommendPlan("owner-uji");
    assert.equal(upgrade.recommendedPlanId, "personal_toro");
    assert.equal(upgrade.kind, "upgrade");

    let paidClock = new Date("2026-08-21T00:00:00.000Z");
    const paidState = setup({ now: () => new Date(paidClock) });
    await paidState.economy.activateSubscriptionForTest({
      ownerId: "owner-uji",
      planId: "personal_kuro",
      idempotencyKey: "recommend-kuro-activation",
    });
    const paidView = await paidState.economy.usage("owner-uji");
    await paidState.economyRepository.mutate((state) => {
      state.settlements.push({
        settlementId: "settlement-recommend-paid",
        idempotencyKey: "settlement-recommend-paid",
        reservationId: "reservation-recommend-paid",
        requestId: "request-recommend-paid",
        subjectRef: paidView.subjectRef,
        fundingSource: "included",
        billableComputeUnits: "1000000",
        measuredComputeUnits: "1000000",
        deliveryEffectId: "effect-recommend-paid",
        outcome: "charged",
        settledAt: "2026-08-21T00:00:00.000Z",
      });
    });
    assert.equal((await paidState.economy.recommendPlan("owner-uji")).kind, "none");
    paidClock = new Date("2026-09-06T00:00:00.000Z");
    const downgrade = await paidState.economy.recommendPlan("owner-uji");
    assert.equal(downgrade.recommendedPlanId, "personal_perkenalan");
    assert.equal(downgrade.kind, "downgrade");
  });
});
