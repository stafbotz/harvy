import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import type {
  ControlPlaneRepository,
  ControlPlaneState,
} from "../src/domain/control-plane.js";
import type {
  ProviderAttemptRecord,
  ProviderAttemptStart,
  UsageLedgerFilter,
  UsageLedgerRepository,
} from "../src/domain/usage-ledger.js";
import type {
  EntitlementEntry,
  EntitlementLedgerRepository,
} from "../src/domain/entitlement.js";

class MemoryControl implements ControlPlaneRepository {
  state: ControlPlaneState = {
    version: 1,
    installationKey: "ledger-installation-key",
    plans: [],
    prices: [],
    enrollments: [],
    principals: [],
    audit: [],
  };
  async snapshot() { return structuredClone(this.state); }
  async mutate<T>(operation: (draft: ControlPlaneState) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = operation(draft);
    this.state = draft;
    return result;
  }
}

class MemoryLedger implements UsageLedgerRepository {
  records: ProviderAttemptRecord[] = [];
  failNextStart = false;
  failNextFinish = false;
  async startAttempt(record: ProviderAttemptRecord) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("start sementara gagal");
    }
    if (!this.records.some((item) => item.attemptId === record.attemptId)) {
      this.records.push(structuredClone(record));
    }
  }
  async finishAttempt(record: ProviderAttemptRecord) {
    if (this.failNextFinish) {
      this.failNextFinish = false;
      throw new Error("finish sementara gagal");
    }
    const index = this.records.findIndex((item) => item.attemptId === record.attemptId);
    if (index < 0) this.records.push(structuredClone(record));
    else this.records[index] = structuredClone(record);
  }
  async attempt(id: string) {
    const found = this.records.find((item) => item.attemptId === id);
    return found ? structuredClone(found) : null;
  }
  async list(filter: UsageLedgerFilter = {}) {
    return this.records.filter((item) =>
      (filter.subjectRef === undefined || item.subjectRef === filter.subjectRef) &&
      (filter.actorRef === undefined || item.actorRef === filter.actorRef) &&
      (filter.cohort === undefined || item.cohort === filter.cohort) &&
      (filter.planId === undefined || item.planId === filter.planId),
    ).slice(0, filter.limit ?? 1_000).map((item) => structuredClone(item));
  }
  async removeBefore(before: Date) {
    this.records = this.records.filter((item) => Date.parse(item.startedAt) >= before.getTime());
  }
  async removeSubject(subjectRef: string) {
    this.records = this.records.filter((item) => item.subjectRef !== subjectRef);
  }
  async removeActors(subjectRef: string, actorRefs: readonly string[]) {
    const targets = new Set(actorRefs);
    const before = this.records.length;
    this.records = this.records.filter(
      (item) =>
        item.subjectRef !== subjectRef ||
        item.actorRef === null ||
        !targets.has(item.actorRef),
    );
    return before - this.records.length;
  }
}

class MemoryEntitlement implements EntitlementLedgerRepository {
  entries: EntitlementEntry[] = [];
  failNext = false;
  async append(entry: EntitlementEntry) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("write sementara gagal");
    }
    if (!this.entries.some((item) => item.idempotencyKey === entry.idempotencyKey)) {
      this.entries.push(structuredClone(entry));
    }
  }
  async list(subjectRef?: string) {
    return this.entries.filter(
      (item) => subjectRef === undefined || item.subjectRef === subjectRef,
    );
  }
  async removeBefore(before: Date) {
    this.entries = this.entries.filter((item) => Date.parse(item.at) >= before.getTime());
  }
  async removeSubject(subjectRef: string) {
    this.entries = this.entries.filter((item) => item.subjectRef !== subjectRef);
  }
}

function runtime() {
  const controlRepository = new MemoryControl();
  const ledgerRepository = new MemoryLedger();
  const entitlementRepository = new MemoryEntitlement();
  const control = new ControlPlaneService(
    controlRepository,
    {
      fallbackRollingTokenLimit: 100,
      betaQuotaMultiplier: 4,
      configuredModels: [{
        providerId: "primary-provider",
        modelId: "primary-model",
        active: true,
        sources: [{
          environmentVariable: "AI_MODEL_TESTING",
          mode: "testing",
          origin: "primary",
          tiers: ["cheap", "efficient", "ambitious"],
          active: true,
        }],
      }],
      priceBootstraps: [{
        providerId: "primary-provider",
        modelId: "primary-model",
        inputPerMillionUsd: "1",
        outputPerMillionUsd: "2",
      }],
    },
    () => new Date("2026-08-01T00:00:00.000Z"),
  );
  return {
    control,
    ledgerRepository,
    entitlementRepository,
    ledger: new UsageLedgerService(
      ledgerRepository,
      control,
      { retentionDays: 90, entitlementRepository },
      () => new Date("2026-08-01T01:00:00.000Z"),
    ),
  };
}

function start(
  attemptId: string,
  requestId: string,
  aliases: readonly string[] = ["pn:1"],
): ProviderAttemptStart {
  return {
    attemptId,
    requestId,
    turnId: "turn-1",
    attemptNo: Number(attemptId.replace(/\D/gu, "")) || 1,
    ownerId: "whatsapp:group-1",
    subjectKind: "group",
    channel: "whatsapp",
    actorAliases: aliases,
    providerId: "primary-provider",
    origin: "primary",
    modelId: "primary-model",
    tier: "cheap",
    purpose: "group-reply",
    environment: "development",
    costCenter: "runtime",
    maxOutputTokens: 100,
    inputTokenEstimate: 50,
    safetyCritical: false,
    startedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("UsageLedgerService", () => {
  it("menyimpan reported dan katalog berdampingan dengan hitungan nano-USD", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context = start("attempt-1", "request-1");
    await ledger.startAttempt(context);
    await ledger.finishAttempt(context, {
      finishedAt: "2026-08-01T00:00:01.000Z",
      status: "completed",
      httpStatus: 200,
      responseOutcome: "accepted",
      finishReason: "stop",
      latencyMs: 1_000,
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        estimated: false,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        providerCostUsd: "0.003",
        providerGenerationId: "gen-1",
      },
    });
    const record = ledgerRepository.records[0];
    assert.equal(record?.cost.localCalculatedUsdNanos, "2000000");
    assert.equal(record?.cost.providerReportedUsdNanos, "3000000");
    assert.equal(record?.cost.effectiveUsdNanos, "3000000");
    assert.equal(record?.cost.effectiveSource, "provider");
    assert.equal(record?.cost.reconciliation, "adjusted");
  });

  it("menghitung retry sebagai attempt tetapi satu logical request", async () => {
    const { ledger } = runtime();
    const failed = start("attempt-1", "request-sama");
    const succeeded = start("attempt-2", "request-sama");
    await ledger.startAttempt(failed);
    await ledger.finishAttempt(failed, {
      finishedAt: "2026-08-01T00:00:01.000Z",
      status: "network_error",
      httpStatus: null,
      responseOutcome: "not_checked",
      finishReason: null,
      latencyMs: 10,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: true, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
    });
    await ledger.startAttempt(succeeded);
    await ledger.finishAttempt(succeeded, {
      finishedAt: "2026-08-01T00:00:02.000Z",
      status: "completed",
      httpStatus: 200,
      responseOutcome: "accepted",
      finishReason: "stop",
      latencyMs: 10,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
    });
    const summary = await ledger.summary();
    assert.equal(summary.attempts, 2);
    assert.equal(summary.logicalRequests, 1);
    assert.equal(summary.totalTokens, 15);
    assert.equal(summary.inputTokenEstimateRequested, 100);
    assert.equal(summary.maxOutputTokensRequested, 200);
  });

  it("menggabungkan PN/LID lama dan menjaga total bucket sama dengan grup", async () => {
    const { ledger } = runtime();
    for (const [id, aliases] of [
      ["attempt-1", ["pn:1"]],
      ["attempt-2", ["lid:1"]],
      ["attempt-3", ["pn:1", "lid:1"]],
    ] as const) {
      const context = start(id, `request-${id}`, aliases);
      await ledger.startAttempt(context);
      await ledger.finishAttempt(context, {
        finishedAt: "2026-08-01T00:00:01.000Z",
        status: "completed",
        httpStatus: 200,
        responseOutcome: "accepted",
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10, estimated: false, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
      });
    }
    const attempts = await ledger.attempts({ limit: 10 });
    assert.equal(new Set(attempts.map((item) => item.actorRef)).size, 1);
    assert.equal(
      attempts.reduce((sum, item) => sum + item.usage.totalTokens, 0),
      (await ledger.summary()).totalTokens,
    );
  });

  it("menandai timeout tanpa usage sebagai pending, bukan nol exact", async () => {
    const { ledger } = runtime();
    const context = start("attempt-1", "request-1");
    await ledger.startAttempt(context);
    await ledger.finishAttempt(context, {
      finishedAt: "2026-08-01T00:00:30.000Z",
      status: "timeout",
      httpStatus: null,
      responseOutcome: "not_checked",
      finishReason: null,
      latencyMs: 30_000,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: true, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
    });
    const record = (await ledger.attempts())[0];
    assert.equal(record?.cost.effectiveUsdNanos, null);
    assert.equal(record?.cost.reconciliation, "pending");
    const summary = await ledger.summary();
    assert.equal(summary.indicativeCostUsdNanos, null);
    assert.equal(summary.missingUsageAttempts, 1);
    assert.equal(summary.costCoverage, "unavailable");
    const view = (await ledger.costViews([record!])).get(record!.attemptId);
    assert.equal(view?.source, "unavailable");
    assert.equal(view?.reason, "usage_missing");
  });

  it("mengestimasi attempt lama dengan tarif aktif tanpa menulis ulang ledger", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context = {
      ...start("attempt-before-price", "request-before-price"),
      startedAt: "2026-07-31T23:59:00.000Z",
    };
    await ledger.startAttempt(context);
    await ledger.finishAttempt(context, {
      finishedAt: "2026-07-31T23:59:01.000Z",
      status: "completed",
      httpStatus: 200,
      responseOutcome: "accepted",
      finishReason: "stop",
      latencyMs: 1,
      usage: {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        estimated: false,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        providerCostUsd: null,
        providerGenerationId: null,
      },
    });

    assert.equal(ledgerRepository.records[0]?.priceSnapshot, null);
    assert.equal(ledgerRepository.records[0]?.cost.effectiveUsdNanos, null);
    const summary = await ledger.summary();
    assert.equal(summary.effectiveCostUsdNanos, null);
    assert.equal(summary.indicativeCostUsdNanos, "2000000");
    assert.equal(summary.currentPriceEstimateUsdNanos, "2000000");
    assert.equal(summary.currentPriceEstimatedAttempts, 1);
    assert.equal(summary.historicalPriceGapAttempts, 1);
    assert.equal(summary.unavailableCostAttempts, 0);
    assert.equal(summary.costCoverage, "estimated");
    const view = (await ledger.costViews(ledgerRepository.records)).get(
      "attempt-before-price",
    );
    assert.equal(view?.source, "current_catalog_estimate");
    assert.equal(view?.reason, "historical_price_missing");
    assert.equal(view?.costUsdNanos, "2000000");
    assert.equal(ledgerRepository.records[0]?.cost.effectiveUsdNanos, null);
  });

  it("memperlakukan tarif nol eksplisit sebagai biaya tercatat, bukan data hilang", async () => {
    const { ledger, control, ledgerRepository } = runtime();
    await control.createPriceVersion({
      providerId: "primary-provider",
      modelId: "primary-model",
      rates: {
        inputPerMillionUsd: "0",
        outputPerMillionUsd: "0",
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
        reasoningPerMillionUsd: null,
        perRequestUsd: null,
      },
      status: "pilot",
      effectiveFrom: "2026-08-01T00:30:00.000Z",
    });
    const context = {
      ...start("attempt-free", "request-free"),
      startedAt: "2026-08-01T00:31:00.000Z",
    };
    await ledger.startAttempt(context);
    await ledger.finishAttempt(context, {
      finishedAt: "2026-08-01T00:31:01.000Z",
      status: "completed",
      httpStatus: 200,
      responseOutcome: "accepted",
      finishReason: "stop",
      latencyMs: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimated: false,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        providerCostUsd: null,
        providerGenerationId: null,
      },
    });
    assert.equal(ledgerRepository.records[0]?.cost.effectiveUsdNanos, "0");
    const summary = await ledger.summary();
    assert.equal(summary.indicativeCostUsdNanos, "0");
    assert.equal(summary.costCoverage, "complete");
  });

  it("settlement idempoten dan keselamatan tidak mendebit kapasitas", async () => {
    const { ledger, entitlementRepository } = runtime();
    const context = {
      requestId: "logical-1",
      turnId: "turn-1",
      ownerId: "student",
      tier: "cheap" as const,
      purpose: "reply" as const,
      model: "primary-model",
      maxTokens: 100,
      inputTokenEstimate: 10,
      safetyCritical: false,
    };
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimated: false,
    };
    await ledger.settleEntitlement(context, usage, { succeeded: true });
    await ledger.settleEntitlement(context, usage, { succeeded: true });
    assert.equal(entitlementRepository.entries.length, 0);
    await ledger.markDelivered("student");
    assert.equal(
      await ledger.debitedTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      15,
    );
    await ledger.settleEntitlement(
      {
        ...context,
        requestId: "logical-safety",
        purpose: "risk-triage",
        safetyCritical: true,
      },
      usage,
      { succeeded: true },
    );
    assert.equal(entitlementRepository.entries.length, 2);
    assert.equal(entitlementRepository.entries[0]?.type, "debit");
    assert.equal(entitlementRepository.entries[0]?.debitedTokens, 15);
    assert.equal(entitlementRepository.entries[1]?.type, "safety_exempt");
    assert.equal(entitlementRepository.entries[1]?.debitedTokens, 0);
  });

  it("planner ambient adalah overhead dan tidak mendebit paket", async () => {
    const { ledger, entitlementRepository } = runtime();
    await ledger.settleEntitlement(
      {
        requestId: "ambient-plan",
        turnId: "turn-ambient",
        ownerId: "whatsapp:group-1",
        tier: "cheap",
        purpose: "group-participation",
        model: "primary-model",
        maxTokens: 100,
        inputTokenEstimate: 10,
        safetyCritical: false,
      },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true },
    );
    assert.equal(entitlementRepository.entries[0]?.disposition, "included_overhead");
    assert.equal(entitlementRepository.entries[0]?.debitedTokens, 0);
  });

  it("hapus diri anggota membersihkan seluruh alias ledger tanpa menghapus anggota lain", async () => {
    const { ledger, control, ledgerRepository } = runtime();
    const first = start("attempt-1", "request-1", ["pn:1", "lid:1"]);
    const second = start("attempt-2", "request-2", ["pn:2"]);
    for (const context of [first, second]) {
      await ledger.startAttempt(context);
      await ledger.finishAttempt(context, {
        finishedAt: "2026-08-01T00:00:01.000Z",
        status: "completed",
        httpStatus: 200,
        responseOutcome: "accepted",
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, estimated: false, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
      });
    }

    assert.equal(await ledger.forgetActor("whatsapp:group-1", ["lid:1"]), true);
    assert.equal(ledgerRepository.records.length, 1);
    assert.equal(ledgerRepository.records[0]?.attemptId, "attempt-2");
    const scopeRef = await control.subjectRef("whatsapp:group-1");
    assert.deepEqual(await control.principalRefsForAliases(scopeRef, ["pn:1"]), []);
    assert.equal(await ledger.forgetActor("whatsapp:group-1", ["pn:1"]), false);
  });

  it("penghapusan owner menang atas finish lama dan allow membuka generasi baru", async () => {
    const { ledger, ledgerRepository } = runtime();
    const oldContext = start("attempt-old", "request-old");
    await ledger.startAttempt(oldContext);
    await ledger.forgetOwner("whatsapp:group-1");
    await ledger.finishAttempt(oldContext, {
      finishedAt: "2026-08-01T00:00:02.000Z",
      status: "completed",
      httpStatus: 200,
      responseOutcome: "accepted",
      finishReason: "stop",
      latencyMs: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, estimated: false, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
    });
    assert.equal(ledgerRepository.records.length, 0);

    await ledger.allowOwner("whatsapp:group-1");
    const fresh = start("attempt-fresh", "request-fresh");
    await ledger.startAttempt(fresh);
    assert.equal(ledgerRepository.records.length, 1);
  });

  it("agregasi dan ekspor tidak terpotong batas 10.000 baris tabel", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context = start("attempt-template", "request-template", []);
    await ledger.startAttempt(context);
    const template = ledgerRepository.records[0]!;
    ledgerRepository.records = Array.from({ length: 10_005 }, (_, index) => ({
      ...structuredClone(template),
      attemptId: `attempt-${index}`,
      requestId: `request-${index}`,
      actorRef: null,
      status: "completed" as const,
      finishedAt: "2026-08-01T00:00:01.000Z",
      usage: {
        ...template.usage,
        inputTokens: 1,
        totalTokens: 1,
        estimated: false,
        source: "provider" as const,
      },
    }));

    assert.equal((await ledger.attempts({ limit: 20_000 })).length, 10_000);
    const summary = await ledger.summary({ limit: 5 });
    assert.equal(summary.attempts, 10_005);
    assert.equal(summary.logicalRequests, 10_005);
    assert.equal(summary.totalTokens, 10_005);
    assert.equal((await ledger.exportOwner("whatsapp:group-1")).length, 10_005);
  });

  it("mencoba ulang settlement entitlement yang sempat gagal saat drain", async () => {
    const { ledger, entitlementRepository } = runtime();
    await ledger.settleEntitlement(
      {
        requestId: "retry-entitlement",
        turnId: "turn-1",
        ownerId: "student",
        tier: "cheap",
        purpose: "reply",
        model: "primary-model",
        maxTokens: 10,
        inputTokenEstimate: 5,
        safetyCritical: false,
      },
      { inputTokens: 5, outputTokens: 2, totalTokens: 7, estimated: false },
      { succeeded: true },
    );
    entitlementRepository.failNext = true;
    await assert.rejects(
      ledger.markDelivered("student"),
      /write sementara gagal/u,
    );
    assert.equal(entitlementRepository.entries.length, 0);
    await ledger.drain();
    assert.equal(entitlementRepository.entries.length, 1);
    assert.equal(entitlementRepository.entries[0]?.idempotencyKey, "retry-entitlement");
  });

  it("balasan yang tidak terkirim tidak mendebit entitlement", async () => {
    const { ledger, entitlementRepository } = runtime();
    await ledger.settleEntitlement(
      {
        requestId: "undelivered",
        turnId: "turn-undelivered",
        ownerId: "student",
        tier: "cheap",
        purpose: "reply",
        model: "primary-model",
        maxTokens: 10,
        inputTokenEstimate: 5,
        safetyCritical: false,
      },
      { inputTokens: 5, outputTokens: 2, totalTokens: 7, estimated: false },
      { succeeded: true },
    );
    await ledger.discardUndelivered("student");
    await ledger.markDelivered("student");
    assert.equal(entitlementRepository.entries.length, 0);
  });

  it("memulihkan gap start/finish attempt setelah kegagalan write sementara", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context = start("attempt-retry", "request-retry");
    ledgerRepository.failNextStart = true;
    await assert.rejects(ledger.startAttempt(context), /start sementara gagal/u);
    ledgerRepository.failNextFinish = true;
    await assert.rejects(
      ledger.finishAttempt(context, {
        finishedAt: "2026-08-01T00:00:01.000Z",
        status: "completed",
        httpStatus: 200,
        responseOutcome: "accepted",
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, estimated: false, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerCostUsd: null, providerGenerationId: null },
      }),
      /finish sementara gagal/u,
    );
    await ledger.drain();
    assert.equal(ledgerRepository.records.length, 1);
    assert.equal(ledgerRepository.records[0]?.status, "completed");
    assert.equal(ledgerRepository.records[0]?.usage.totalTokens, 3);
  });
});
