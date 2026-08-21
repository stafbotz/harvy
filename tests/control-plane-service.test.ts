import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ControlPlaneService,
} from "../src/core/control-plane-service.js";
import { PERSONAL_PLAN_IDS } from "../src/domain/control-plane.js";
import type {
  ConfiguredModel,
  ControlPlaneRepository,
  ControlPlaneState,
  PlanVersion,
} from "../src/domain/control-plane.js";

function configuredModel(
  providerId: string,
  modelId: string,
  active = true,
): ConfiguredModel {
  return {
    providerId,
    modelId,
    active,
    sources: [{
      environmentVariable: "AI_MODEL_TESTING",
      mode: "testing",
      origin: "primary",
      tiers: ["cheap", "efficient", "ambitious"],
      active,
    }],
  };
}

class MemoryControlPlaneRepository implements ControlPlaneRepository {
  state: ControlPlaneState = {
    version: 1,
    installationKey: "kunci-instalasi-uji-yang-stabil",
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

function service(
  repository = new MemoryControlPlaneRepository(),
  now: () => Date = () => new Date("2026-08-01T00:00:00.000Z"),
) {
  return {
    repository,
    control: new ControlPlaneService(
      repository,
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [configuredModel("provider-uji", "model-uji")],
        priceBootstraps: [{
          providerId: "provider-uji",
          modelId: "model-uji",
          inputPerMillionUsd: "1",
          outputPerMillionUsd: "2",
        }],
      },
      now,
    ),
  };
}

function latestPlans(plans: PlanVersion[]): Map<string, PlanVersion> {
  const latest = new Map<string, PlanVersion>();
  for (const plan of plans) {
    if (!latest.has(plan.planId)) latest.set(plan.planId, plan);
  }
  return latest;
}

describe("ControlPlaneService", () => {
  it("memisahkan paket, beta, kuota, dan consent evaluasi", async () => {
    const { control } = service();
    const enrollment = await control.enrollmentForOwner("123");
    assert.equal(enrollment.planId, "personal_perkenalan");
    assert.equal(enrollment.cohort, "standard");
    assert.equal(enrollment.evaluationConsent.status, "not_invited");
    assert.equal(await control.effectiveLimit("123"), 100);

    const beta = await control.updateEnrollment(
      enrollment.subjectRef,
      enrollment.version,
      { cohort: "beta", planId: "personal_bloom" },
    );
    assert.equal(beta.planId, PERSONAL_PLAN_IDS.pro);
    assert.equal(beta.evaluationConsent.status, "not_invited");
    assert.equal(await control.effectiveLimit("123"), 2_000);

    const invited = await control.inviteEvaluation(
      beta.subjectRef,
      beta.version,
    );
    assert.equal(invited.evaluationConsent.status, "invited");
    assert.equal(invited.evaluationConsent.grantedAt, null);
  });

  it("memetakan owner WhatsApp private ke subject personal pseudonymous", async () => {
    const { control } = service();
    const enrollment = await control.enrollmentForOwner(
      "whatsapp-user:628777777777@s.whatsapp.net",
    );

    assert.equal(enrollment.kind, "private");
    assert.equal(enrollment.channel, "whatsapp");
    assert.equal(enrollment.planId, PERSONAL_PLAN_IDS.free);
    assert.equal(
      enrollment.subjectRef.includes("628777777777"),
      false,
    );
  });

  it("memberi nama paket pilot yang disahkan tanpa mengaktifkan checkout", async () => {
    const { control } = service();
    const latest = latestPlans(await control.plans());
    assert.equal(latest.get("personal_perkenalan")?.publicName, "Perkenalan");
    assert.equal(latest.get("personal_toro")?.publicName, "Toro");
    assert.equal(latest.get("personal_sora")?.publicName, "Sora");
    assert.equal(latest.get("personal_kuro")?.publicName, "Kuro");
    assert.equal(latest.get("group_direct")?.publicName, "Sapa");
    assert.equal(latest.get("group_ambient")?.publicName, "Nimbrung");
    assert.equal(latest.get("workspace")?.publicName, "Ruang");
    assert.ok([...latest.values()].every((plan) => plan.status === "pilot"));
  });

  it("memigrasikan ID dan nama paket pribadi lama tanpa memutus referensi", async () => {
    const repository = new MemoryControlPlaneRepository();
    const initial = service(repository).control;
    await initial.initialize();
    await initial.enrollmentForOwner("123");
    const legacyPlans = new Map<string, { planId: string; publicName: string }>([
      [PERSONAL_PLAN_IDS.free, { planId: "personal_free", publicName: "Gratis" }],
      [PERSONAL_PLAN_IDS.plus, { planId: "personal_sprout", publicName: "Tunas" }],
      [PERSONAL_PLAN_IDS.pro, { planId: "personal_bloom", publicName: "Mekar" }],
      [PERSONAL_PLAN_IDS.max, { planId: "personal_canopy", publicName: "Rimbun" }],
    ]);
    for (const plan of repository.state.plans) {
      const legacy = legacyPlans.get(plan.planId);
      if (!legacy) continue;
      plan.planId = legacy.planId;
      plan.publicName = legacy.publicName;
    }
    repository.state.enrollments[0]!.planId = "personal_bloom";
    repository.state.audit.push({
      id: "audit-plan-lama",
      at: "2026-08-01T12:00:00.000Z",
      sessionRef: "session-uji",
      action: "plan_version_create",
      targetRef: "personal_bloom",
      outcome: "succeeded",
      reasonCode: null,
    });

    const migrated = service(
      repository,
      () => new Date("2026-08-02T00:00:00.000Z"),
    ).control;
    const latest = latestPlans(await migrated.plans());
    assert.equal(latest.get(PERSONAL_PLAN_IDS.free)?.publicName, "Perkenalan");
    assert.equal(latest.get(PERSONAL_PLAN_IDS.plus)?.publicName, "Toro");
    assert.equal(latest.get(PERSONAL_PLAN_IDS.pro)?.publicName, "Sora");
    assert.equal(latest.get(PERSONAL_PLAN_IDS.max)?.publicName, "Kuro");
    assert.equal(repository.state.enrollments[0]?.planId, PERSONAL_PLAN_IDS.pro);
    assert.equal(repository.state.audit[0]?.targetRef, PERSONAL_PLAN_IDS.pro);

    for (const planId of legacyPlans.keys()) {
      const versions = repository.state.plans
        .filter((plan) => plan.planId === planId)
        .sort((left, right) => left.version - right.version);
      assert.equal(versions.length, 2);
      assert.equal(versions[0]?.effectiveTo, "2026-08-02T00:00:00.000Z");
      assert.equal(versions[1]?.version, 2);
      assert.equal(versions[1]?.planId, planId);
      assert.equal(versions[1]?.monthlyPriceIdr, versions[0]?.monthlyPriceIdr);
      assert.equal(
        versions[1]?.rolling24hTokenLimit,
        versions[0]?.rolling24hTokenLimit,
      );
    }
    assert.equal(
      repository.state.plans.filter((plan) => plan.planId === "group_direct").length,
      1,
    );

    const restarted = service(
      repository,
      () => new Date("2026-08-03T00:00:00.000Z"),
    ).control;
    await restarted.initialize();
    assert.equal(repository.state.plans.length, 11);
    assert.equal(
      repository.state.plans.some((plan) =>
        [...legacyPlans.values()].some((legacy) => legacy.planId === plan.planId)
      ),
      false,
    );
  });

  it("membuat versi harga baru tanpa mengubah harga historis", async () => {
    const { control } = service();
    await control.initialize();
    const original = await control.priceAt(
      "provider-uji",
      "model-uji",
      "2026-08-01T12:00:00.000Z",
    );
    assert.equal(original?.rates.inputPerMillionUsd, "1");

    const next = await control.createPriceVersion({
      providerId: "provider-uji",
      modelId: "model-uji",
      rates: {
        inputPerMillionUsd: "3.5",
        outputPerMillionUsd: "7",
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
        reasoningPerMillionUsd: null,
        perRequestUsd: null,
      },
      status: "pilot",
      effectiveFrom: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(next.version, 2);
    assert.equal(
      (await control.priceAt(
        "provider-uji",
        "model-uji",
        "2026-08-01T12:00:00.000Z",
      ))?.id,
      original?.id,
    );
    assert.equal(
      (await control.priceAt(
        "provider-uji",
        "model-uji",
        "2026-08-02T12:00:00.000Z",
      ))?.id,
      next.id,
    );
  });

  it("hanya menerima harga untuk pasangan model dari environment", async () => {
    const { control } = service();
    const dashboard = await control.dashboardState();
    assert.deepEqual(
      dashboard.configuredModels.map((model) => [
        model.providerId,
        model.modelId,
      ]),
      [["provider-uji", "model-uji"]],
    );
    await assert.rejects(
      control.createPriceVersion({
        providerId: "provider-buatan",
        modelId: "model-buatan",
        rates: {
          inputPerMillionUsd: "1",
          outputPerMillionUsd: "2",
          cacheReadPerMillionUsd: null,
          cacheWritePerMillionUsd: null,
          reasoningPerMillionUsd: null,
          perRequestUsd: null,
        },
        status: "pilot",
        effectiveFrom: "2026-08-02T00:00:00.000Z",
      }),
      /tidak tersedia di konfigurasi environment/u,
    );
  });

  it("mempertahankan histori harga ketika model hilang dari environment", async () => {
    const repository = new MemoryControlPlaneRepository();
    const first = new ControlPlaneService(
      repository,
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [configuredModel("provider-lama", "model-lama")],
        priceBootstraps: [{
          providerId: "provider-lama",
          modelId: "model-lama",
          inputPerMillionUsd: "1",
          outputPerMillionUsd: "2",
        }],
      },
      () => new Date("2026-08-01T00:00:00.000Z"),
    );
    await first.initialize();

    const afterRestart = new ControlPlaneService(
      repository,
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [configuredModel("provider-baru", "model-baru")],
        priceBootstraps: [],
      },
      () => new Date("2026-08-02T00:00:00.000Z"),
    );
    const dashboard = await afterRestart.dashboardState();
    assert.deepEqual(
      dashboard.configuredModels.map((model) => model.modelId),
      ["model-baru"],
    );
    assert.equal(dashboard.prices[0]?.modelId, "model-lama");
    assert.equal(
      (await afterRestart.priceAt(
        "provider-lama",
        "model-lama",
        "2026-08-01T12:00:00.000Z",
      ))?.rates.inputPerMillionUsd,
      "1",
    );
  });

  it("bootstrap harga 0/0 berarti token-only, bukan model gratis", async () => {
    const repository = new MemoryControlPlaneRepository();
    const control = new ControlPlaneService(
      repository,
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [
          configuredModel("provider-belum-dihargai", "model-belum-dihargai"),
          configuredModel("provider-gratis", "model-gratis"),
        ],
        priceBootstraps: [{
          providerId: "provider-belum-dihargai",
          modelId: "model-belum-dihargai",
          inputPerMillionUsd: "0",
          outputPerMillionUsd: "0.000000000",
        }],
      },
      () => new Date("2026-08-01T00:00:00.000Z"),
    );
    await control.initialize();
    assert.deepEqual(await control.prices(), []);

    const explicitFree = await control.createPriceVersion({
      providerId: "provider-gratis",
      modelId: "model-gratis",
      rates: {
        inputPerMillionUsd: "0",
        outputPerMillionUsd: "0",
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
        reasoningPerMillionUsd: null,
        perRequestUsd: null,
      },
      status: "pilot",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(explicitFree.rates.outputPerMillionUsd, "0");
  });

  it("menyatukan alias PN/LID hanya di scope asal", async () => {
    const { control } = service();
    const first = await control.resolvePrincipal("scope-a", ["pn:1"]);
    const second = await control.resolvePrincipal("scope-a", ["lid:1"]);
    assert.notEqual(first, second);
    const bridge = await control.resolvePrincipal("scope-a", ["pn:1", "lid:1"]);
    assert.equal(bridge, first);
    assert.equal(await control.canonicalPrincipalRef(second!), first);

    const otherScope = await control.resolvePrincipal("scope-b", ["pn:1"]);
    assert.notEqual(otherScope, first);
  });

  it("menyelaraskan mode runtime ketika paket grup berubah", async () => {
    const { control } = service();
    const original = await control.enrollmentForOwner(
      "whatsapp:grup-uji",
      { kind: "group", channel: "whatsapp" },
    );
    assert.equal(original.groupRuntimeMode, "direct_only");

    const ambient = await control.updateEnrollment(
      original.subjectRef,
      original.version,
      { planId: "group_ambient" },
    );
    assert.equal(ambient.groupRuntimeMode, "ambient");

    const paused = await control.updateEnrollment(
      ambient.subjectRef,
      ambient.version,
      { groupRuntimeMode: "paused" },
    );
    assert.equal(paused.groupRuntimeMode, "paused");

    const direct = await control.updateEnrollment(
      paused.subjectRef,
      paused.version,
      { planId: "group_direct" },
    );
    assert.equal(direct.groupRuntimeMode, "direct_only");
  });

  it("menyamakan ID grup dari Console dengan scope runtime berprefiks kanal", async () => {
    const { control } = service();
    const fromConsole = await control.createEnrollmentFromExternal(
      "120363000000@g.us",
      { kind: "group", channel: "whatsapp" },
      "Grup A",
    );
    const fromRuntime = await control.enrollmentForOwner(
      "whatsapp:120363000000@g.us",
      { kind: "group", channel: "whatsapp" },
    );
    assert.equal(fromConsole.subjectRef, fromRuntime.subjectRef);
    assert.equal(fromRuntime.operatorLabel, "Grup A");
    assert.equal((await control.enrollments()).length, 1);
  });

  it("menolak versi paket dengan audiens dan mode yang bertentangan", async () => {
    const { control } = service();
    await assert.rejects(
      control.createPlanVersion({
        planId: "personal-rusak",
        publicName: "Rusak",
        audience: "personal",
        monthlyPriceIdr: 1,
        rolling24hTokenLimit: 1,
        activeMemberLimit: null,
        groupMode: "ambient",
        status: "pilot",
        effectiveFrom: "2026-08-02T00:00:00.000Z",
      }),
      /Versi paket tidak sah/u,
    );
  });
});
