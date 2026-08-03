import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import {
  PERSONAL_PLAN_IDS,
  type ControlPlaneState,
} from "../src/domain/control-plane.js";
import type { EntitlementEntry } from "../src/domain/entitlement.js";
import type { ProviderAttemptRecord } from "../src/domain/usage-ledger.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileEntitlementLedgerRepository } from "../src/storage/file-entitlement-ledger-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";

const LEGACY_IDS = [
  "personal_free",
  "personal_sprout",
  "personal_bloom",
  "personal_canopy",
] as const;

const CURRENT_IDS = [
  PERSONAL_PLAN_IDS.free,
  PERSONAL_PLAN_IDS.plus,
  PERSONAL_PLAN_IDS.pro,
  PERSONAL_PLAN_IDS.max,
] as const;

describe("migrasi ID paket individu", () => {
  it("memigrasikan katalog, enrollment, dan audit pada berkas control plane", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-plan-control-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "control-plane.json");
    await writeFile(file, `${JSON.stringify(legacyControlState(), null, 2)}\n`);

    const repository = new FileControlPlaneRepository(file);
    const control = new ControlPlaneService(
      repository,
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [{
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
        }],
      },
      () => new Date("2026-08-02T00:00:00.000Z"),
    );
    await control.initialize();

    const migrated = JSON.parse(await readFile(file, "utf8")) as ControlPlaneState;
    assert.deepEqual(
      new Set(migrated.plans.map((plan) => plan.planId)),
      new Set(CURRENT_IDS),
    );
    assert.equal(migrated.enrollments[0]?.planId, PERSONAL_PLAN_IDS.pro);
    assert.equal(migrated.audit[0]?.targetRef, PERSONAL_PLAN_IDS.pro);
    assert.deepEqual(
      migrated.plans
        .filter((plan) => plan.effectiveTo === null)
        .sort((left, right) => left.planId.localeCompare(right.planId, "en"))
        .map((plan) => [plan.planId, plan.publicName]),
      [
        [PERSONAL_PLAN_IDS.max, "Kuro"],
        [PERSONAL_PLAN_IDS.free, "Perkenalan"],
        [PERSONAL_PLAN_IDS.pro, "Sora"],
        [PERSONAL_PLAN_IDS.plus, "Toro"],
      ].sort((left, right) => left[0]!.localeCompare(right[0]!, "en")),
    );
    assert.equal(
      migrated.plans.some((plan) => LEGACY_IDS.includes(plan.planId as never)),
      false,
    );
  });

  it("menulis ulang ID historis pada provider dan entitlement ledger", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-plan-ledger-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const usageFile = join(directory, "usage-ledger.json");
    const entitlementFile = join(directory, "entitlement-ledger.json");
    await writeFile(usageFile, `${JSON.stringify({
      version: 1,
      attempts: LEGACY_IDS.map((planId, index) => usageAttempt(planId, index)),
    }, null, 2)}\n`);
    await writeFile(entitlementFile, `${JSON.stringify({
      version: 1,
      entries: LEGACY_IDS.map((planId, index) => entitlementEntry(planId, index)),
    }, null, 2)}\n`);

    const usage = new FileUsageLedgerRepository(usageFile);
    const entitlement = new FileEntitlementLedgerRepository(entitlementFile);
    assert.deepEqual(
      new Set((await usage.list({ limit: 10 })).map((attempt) => attempt.planId)),
      new Set(CURRENT_IDS),
    );
    assert.deepEqual(
      new Set((await entitlement.list()).map((entry) => entry.planId)),
      new Set(CURRENT_IDS),
    );

    await usage.startAttempt(usageAttempt("personal_free", 9));
    await entitlement.append(entitlementEntry("personal_bloom", 9));
    assert.deepEqual(
      new Set((await usage.list({ planId: "personal_free", limit: 10 })).map(
        (attempt) => attempt.planId,
      )),
      new Set([PERSONAL_PLAN_IDS.free]),
    );
    assert.equal(
      (await entitlement.list()).find((entry) => entry.entryId === "entry-9")
        ?.planId,
      PERSONAL_PLAN_IDS.pro,
    );

    const usageOnDisk = await readFile(usageFile, "utf8");
    const entitlementOnDisk = await readFile(entitlementFile, "utf8");
    for (const legacyId of LEGACY_IDS) {
      assert.doesNotMatch(usageOnDisk, new RegExp(`"${legacyId}"`, "u"));
      assert.doesNotMatch(entitlementOnDisk, new RegExp(`"${legacyId}"`, "u"));
    }

    const usageAfterRestart = new FileUsageLedgerRepository(usageFile);
    const entitlementAfterRestart = new FileEntitlementLedgerRepository(
      entitlementFile,
    );
    await usageAfterRestart.list({ limit: 10 });
    await entitlementAfterRestart.list();
    assert.equal(await readFile(usageFile, "utf8"), usageOnDisk);
    assert.equal(await readFile(entitlementFile, "utf8"), entitlementOnDisk);
  });
});

function legacyControlState(): ControlPlaneState {
  const at = "2026-08-01T00:00:00.000Z";
  const names = ["Gratis", "Tunas", "Mekar", "Rimbun"] as const;
  return {
    version: 1,
    installationKey: "kunci-instalasi-uji-yang-stabil",
    plans: LEGACY_IDS.map((planId, index) => ({
      id: `plan-${index}`,
      planId,
      version: 1,
      publicName: names[index]!,
      audience: "personal",
      monthlyPriceIdr: [0, 19_000, 39_000, 69_000][index]!,
      rolling24hTokenLimit: [100, 200, 500, 1_000][index]!,
      activeMemberLimit: null,
      groupMode: "none",
      status: "pilot",
      effectiveFrom: at,
      effectiveTo: null,
      createdAt: at,
    })),
    prices: [],
    enrollments: [{
      subjectRef: "subject-uji",
      operatorLabel: null,
      kind: "private",
      channel: "telegram",
      cohort: "standard",
      planId: "personal_bloom",
      quotaOverride: null,
      betaExpiresAt: null,
      groupRuntimeMode: null,
      evaluationConsent: {
        status: "not_invited",
        invitedAt: null,
        grantedAt: null,
        withdrawnAt: null,
        expiresAt: null,
      },
      version: 1,
      createdAt: at,
      updatedAt: at,
    }],
    principals: [],
    audit: [{
      id: "audit-uji",
      at,
      sessionRef: "session-uji",
      action: "plan_version_create",
      targetRef: "personal_bloom",
      outcome: "succeeded",
      reasonCode: null,
    }],
  };
}

function usageAttempt(
  planId: string,
  index: number,
): ProviderAttemptRecord {
  return {
    schemaVersion: 1,
    attemptId: `attempt-${index}`,
    requestId: `request-${index}`,
    turnId: null,
    attemptNo: 1,
    startedAt: `2026-08-01T00:00:0${index}.000Z`,
    finishedAt: `2026-08-01T00:00:0${index}.500Z`,
    environment: "development",
    costCenter: "runtime",
    subjectRef: "subject-uji",
    subjectKind: "private",
    channel: "telegram",
    actorRef: null,
    cohort: "standard",
    planId,
    providerId: "provider-uji",
    origin: "primary",
    modelId: "model-uji",
    tier: "cheap",
    purpose: "reply",
    maxOutputTokens: 100,
    inputTokenEstimate: 10,
    safetyCritical: false,
    status: "completed",
    httpStatus: 200,
    responseOutcome: "accepted",
    finishReason: "stop",
    latencyMs: 500,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimated: false,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      source: "provider",
    },
    providerGenerationId: null,
    priceVersionId: null,
    priceSnapshot: null,
    cost: {
      providerReportedUsdNanos: null,
      localCalculatedUsdNanos: null,
      effectiveUsdNanos: null,
      effectiveSource: "unpriced",
      reconciliation: "unavailable",
    },
  };
}

function entitlementEntry(planId: string, index: number): EntitlementEntry {
  return {
    schemaVersion: 1,
    entryId: `entry-${index}`,
    idempotencyKey: `idempotency-${index}`,
    requestId: `request-${index}`,
    turnId: null,
    subjectRef: "subject-uji",
    planId,
    cohort: "standard",
    tier: "cheap",
    purpose: "reply",
    modelId: "model-uji",
    type: "debit",
    disposition: "charge",
    measuredTokens: 15,
    debitedTokens: 15,
    succeeded: true,
    at: `2026-08-01T00:00:0${index}.500Z`,
  };
}
