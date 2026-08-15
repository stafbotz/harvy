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
  EntitlementDeliveryDecision,
  EntitlementDeliveryScope,
  EntitlementDeliverySettlement,
  EntitlementEntry,
  EntitlementLedgerRepository,
  PendingEntitlementCandidate,
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
  candidates: PendingEntitlementCandidate[] = [];
  settlements: EntitlementDeliverySettlement[] = [];
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
  async stageCandidate(candidate: PendingEntitlementCandidate) {
    const existing = this.entries.find(
      (entry) => entry.idempotencyKey === candidate.entry.idempotencyKey,
    );
    if (existing) return "committed" as const;
    const staged = this.candidates.find(
      (item) => item.entry.idempotencyKey === candidate.entry.idempotencyKey,
    );
    if (staged) return "replayed" as const;
    const terminal = this.settlements.find((item) => sameScope(item.scope, candidate.scope));
    if (terminal?.outcome === "discarded") return "discarded" as const;
    if (terminal?.outcome === "committed") {
      this.entries.push(promote(candidate, terminal.effectId!));
      return "committed" as const;
    }
    this.candidates.push(structuredClone(candidate));
    return "staged" as const;
  }
  async settleScope(
    scope: EntitlementDeliveryScope,
    decision: EntitlementDeliveryDecision,
  ) {
    const terminal = this.settlements.find((item) => sameScope(item.scope, scope));
    if (terminal) {
      if (
        terminal.outcome === decision.outcome &&
        terminal.effectId === decision.effectId
      ) return "replayed" as const;
      throw new Error("settlement bertabrakan");
    }
    const matching = this.candidates.filter((item) => sameScope(item.scope, scope));
    if (decision.outcome === "committed") {
      for (const candidate of matching) {
        this.entries.push(promote(candidate, decision.effectId!));
      }
    }
    this.candidates = this.candidates.filter((item) => !sameScope(item.scope, scope));
    this.settlements.push(structuredClone({ scope, ...decision }));
    return "settled" as const;
  }
  async listPendingScopes(subjectRef?: string) {
    const unique = new Map<string, EntitlementDeliveryScope>();
    for (const candidate of this.candidates) {
      if (subjectRef !== undefined && candidate.scope.subjectRef !== subjectRef) continue;
      unique.set(JSON.stringify(candidate.scope), candidate.scope);
    }
    return [...unique.values()].map((scope) => structuredClone(scope));
  }
  async pendingDebitTokens(subjectRef: string, since: Date) {
    return this.candidates
      .filter(
        (candidate) =>
          candidate.scope.subjectRef === subjectRef &&
          Date.parse(candidate.entry.at) >= since.getTime(),
      )
      .reduce((sum, candidate) => sum + candidate.entry.debitedTokens, 0);
  }
  async list(subjectRef?: string) {
    return this.entries.filter(
      (item) => subjectRef === undefined || item.subjectRef === subjectRef,
    );
  }
  async removeBefore(before: Date) {
    this.entries = this.entries.filter((item) => Date.parse(item.at) >= before.getTime());
    this.candidates = this.candidates.filter(
      (item) => Date.parse(item.entry.at) >= before.getTime(),
    );
    this.settlements = this.settlements.filter(
      (item) => Date.parse(item.settledAt) >= before.getTime(),
    );
  }
  async removeSubject(subjectRef: string) {
    this.entries = this.entries.filter((item) => item.subjectRef !== subjectRef);
    this.candidates = this.candidates.filter(
      (item) => item.scope.subjectRef !== subjectRef,
    );
    this.settlements = this.settlements.filter(
      (item) => item.scope.subjectRef !== subjectRef,
    );
  }
}

function sameScope(
  left: EntitlementDeliveryScope,
  right: EntitlementDeliveryScope,
) {
  return left.kind === right.kind &&
    left.subjectRef === right.subjectRef &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId;
}

function promote(
  candidate: PendingEntitlementCandidate,
  effectId: string,
): EntitlementEntry {
  return {
    ...structuredClone(candidate.entry),
    delivery: {
      scope: {
        kind: candidate.scope.kind,
        runId: candidate.scope.runId,
        attemptId: candidate.scope.attemptId,
      },
      effectId,
    },
  };
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
  it("menyimpan metadata execution content-free dan menolak bentuk parsial", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context: ProviderAttemptStart = {
      ...start("attempt-1", "request-1"),
      modelRole: "planner",
      requestedEffort: "medium",
      effectiveEffort: "low",
      verbosity: "low",
    };
    await ledger.startAttempt(context);
    assert.deepEqual(
      {
        modelRole: ledgerRepository.records[0]?.modelRole,
        requestedEffort: ledgerRepository.records[0]?.requestedEffort,
        effectiveEffort: ledgerRepository.records[0]?.effectiveEffort,
        verbosity: ledgerRepository.records[0]?.verbosity,
      },
      {
        modelRole: "planner",
        requestedEffort: "medium",
        effectiveEffort: "low",
        verbosity: "low",
      },
    );

    await assert.rejects(
      () => ledger.startAttempt({
        ...start("attempt-2", "request-2"),
        modelRole: "planner",
      }),
      /tidak sah atau tidak lengkap/u,
    );
  });

  it("mencatat route toughest dan privacy domain tanpa payload", async () => {
    const { ledger, ledgerRepository } = runtime();
    const context: ProviderAttemptStart = {
      ...start("attempt-1", "request-1"),
      tier: "ambitious",
      modelRole: "critic",
      requestedEffort: "high",
      effectiveEffort: "high",
      verbosity: "low",
      routeTier: "toughest",
      routeReason: "validator_escalation",
      escalationReason: "observation_contradiction",
      promptMaterial: "structured-brief+candidate",
      sourcePrivacyDomain: "workspace.private",
      targetPrivacyDomain: "provider.approved",
    };
    await ledger.startAttempt(context);
    assert.deepEqual(
      {
        routeTier: ledgerRepository.records[0]?.routeTier,
        routeReason: ledgerRepository.records[0]?.routeReason,
        escalationReason: ledgerRepository.records[0]?.escalationReason,
        promptMaterial: ledgerRepository.records[0]?.promptMaterial,
        sourcePrivacyDomain: ledgerRepository.records[0]?.sourcePrivacyDomain,
        targetPrivacyDomain: ledgerRepository.records[0]?.targetPrivacyDomain,
      },
      {
        routeTier: "toughest",
        routeReason: "validator_escalation",
        escalationReason: "observation_contradiction",
        promptMaterial: "structured-brief+candidate",
        sourcePrivacyDomain: "workspace.private",
        targetPrivacyDomain: "provider.approved",
      },
    );

    const { targetPrivacyDomain: _targetDomain, ...missingTargetDomain } = context;
    await assert.rejects(
      () => ledger.startAttempt({
        ...missingTargetDomain,
        attemptId: "attempt-2",
        requestId: "request-2",
      }),
      /route toughest/u,
    );

    await ledger.startAttempt({
      ...start("attempt-3", "request-3"),
      tier: "ambitious",
      modelRole: "synthesizer",
      requestedEffort: "high",
      effectiveEffort: "high",
      verbosity: "high",
      promptMaterial: "raw+structured-brief+candidate",
    });
    assert.equal(
      ledgerRepository.records[1]?.promptMaterial,
      "raw+structured-brief+candidate",
    );
  });

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
    await ledger.markDelivered("student", "turn-1");
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

  it("men-stage debit attempt secara durable lalu mengikat exact delivery effect", async () => {
    const { ledger, entitlementRepository } = runtime();
    const deliveryScope = {
      kind: "group_agent_run_attempt" as const,
      runId: "run-usage-1",
      attemptId: "attempt-usage-1",
    };
    await ledger.settleEntitlement(
      {
        requestId: "scoped-logical-1",
        turnId: "attempt-usage-1",
        ownerId: "whatsapp:group-1",
        subjectKind: "group",
        channel: "whatsapp",
        deliveryScope,
        tier: "cheap",
        purpose: "agent",
        model: "primary-model",
        maxTokens: 100,
        inputTokenEstimate: 10,
        safetyCritical: false,
      },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true },
    );

    assert.equal(entitlementRepository.entries.length, 0);
    assert.equal(entitlementRepository.candidates.length, 1);
    assert.deepEqual(
      (await ledger.pendingDeliveryScopes()).map(({ kind, runId, attemptId }) => ({
        kind,
        runId,
        attemptId,
      })),
      [deliveryScope],
    );
    assert.equal(
      await ledger.pendingDebitTokens(
        "whatsapp:group-1",
        new Date("2026-07-31T00:00:00.000Z"),
      ),
      15,
    );

    const scope = { ...deliveryScope, ownerId: "whatsapp:group-1" };
    assert.equal(
      await ledger.settleDeliveryScope(scope, {
        outcome: "committed",
        effectId: "effect-final-1",
      }),
      "settled",
    );
    assert.equal(
      await ledger.settleDeliveryScope(scope, {
        outcome: "committed",
        effectId: "effect-final-1",
      }),
      "replayed",
    );
    await assert.rejects(
      ledger.settleDeliveryScope(scope, {
        outcome: "committed",
        effectId: "effect-final-lain",
      }),
      /bert[a-z]+kan|bertabrakan/u,
    );
    assert.equal(entitlementRepository.candidates.length, 0);
    assert.equal(entitlementRepository.entries.length, 1);
    assert.deepEqual(entitlementRepository.entries[0]?.delivery, {
      scope: deliveryScope,
      effectId: "effect-final-1",
    });
  });

  it("delivery hanya menyelesaikan kandidat milik turn yang benar", async () => {
    const { ledger, entitlementRepository } = runtime();
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimated: false,
    };
    const base = {
      ownerId: "student",
      tier: "cheap" as const,
      purpose: "agent" as const,
      model: "primary-model",
      maxTokens: 100,
      inputTokenEstimate: 10,
      safetyCritical: false,
    };
    await ledger.settleEntitlement(
      { ...base, requestId: "agent-1", turnId: "turn-1" },
      usage,
      { succeeded: true },
    );
    await ledger.settleEntitlement(
      { ...base, requestId: "agent-2", turnId: "turn-2" },
      usage,
      { succeeded: true },
    );

    assert.equal(
      await ledger.pendingDebitTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      30,
    );

    await ledger.markDelivered("student", "turn-1");
    assert.equal(
      await ledger.pendingDebitTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      15,
    );
    assert.deepEqual(
      entitlementRepository.entries.map((entry) => entry.turnId),
      ["turn-1"],
    );
    await ledger.discardUndelivered("student", "turn-2");
    await ledger.markDelivered("student", "turn-2");
    assert.equal(
      await ledger.pendingDebitTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      0,
    );
    assert.deepEqual(
      entitlementRepository.entries.map((entry) => entry.turnId),
      ["turn-1"],
    );
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

  it("classifier privasi memori adalah overhead dan tidak mendebit paket", async () => {
    const { ledger, entitlementRepository } = runtime();
    await ledger.settleEntitlement(
      {
        requestId: "memory-privacy",
        turnId: "turn-memory",
        ownerId: "student",
        tier: "cheap",
        purpose: "memory-privacy",
        model: "primary-model",
        maxTokens: 100,
        inputTokenEstimate: 10,
        safetyCritical: false,
      },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true },
    );
    assert.equal(
      entitlementRepository.entries[0]?.disposition,
      "included_overhead",
    );
    assert.equal(entitlementRepository.entries[0]?.debitedTokens, 0);
  });

  it("compiler ingress grup adalah overhead dan tidak mendebit paket", async () => {
    const { ledger, entitlementRepository } = runtime();
    await ledger.settleEntitlement(
      {
        requestId: "group-ingress",
        turnId: "turn-group-ingress",
        ownerId: "whatsapp:group-1",
        tier: "cheap",
        purpose: "group-ingress",
        model: "primary-model",
        maxTokens: 192,
        inputTokenEstimate: 20,
        safetyCritical: false,
      },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true },
    );
    assert.equal(
      entitlementRepository.entries[0]?.disposition,
      "included_overhead",
    );
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
      ledger.markDelivered("student", "turn-1"),
      /write sementara gagal/u,
    );
    assert.equal(entitlementRepository.entries.length, 0);
    assert.equal(
      await ledger.pendingDebitTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      7,
    );
    assert.equal(
      await ledger.debitedTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      7,
    );
    assert.equal(entitlementRepository.entries.length, 1);
    assert.equal(entitlementRepository.entries[0]?.idempotencyKey, "retry-entitlement");
    assert.equal(
      await ledger.pendingDebitTokens("student", new Date("2026-07-31T00:00:00.000Z")),
      0,
    );
  });

  it("mengingat settlement terminal ketika usage selesai terlambat", async () => {
    const { ledger, entitlementRepository } = runtime();
    const base = {
      ownerId: "student",
      tier: "cheap" as const,
      purpose: "agent" as const,
      model: "primary-model",
      maxTokens: 10,
      inputTokenEstimate: 5,
      safetyCritical: false,
    };
    const usage = {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      estimated: false,
    };

    await ledger.discardUndelivered("student", "turn-batal");
    await ledger.settleEntitlement(
      { ...base, requestId: "late-discard", turnId: "turn-batal" },
      usage,
      { succeeded: true },
    );
    await ledger.markDelivered("student", "turn-terkirim");
    await ledger.settleEntitlement(
      { ...base, requestId: "late-deliver", turnId: "turn-terkirim" },
      usage,
      { succeeded: true },
    );

    assert.deepEqual(
      entitlementRepository.entries.map((entry) => entry.requestId),
      ["late-deliver"],
    );
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
    await ledger.discardUndelivered("student", "turn-undelivered");
    await ledger.markDelivered("student", "turn-undelivered");
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
