import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type RelatedUsageLedger,
  TelemetryOwnerBlockedError,
  TelemetryService,
  UsageLimitError,
} from "../src/core/telemetry-service.js";
import type {
  AiUsageContext,
  AiPurpose,
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
  TurnTelemetryRecord,
} from "../src/domain/telemetry.js";

class MemoryTelemetryRepository implements TelemetryRepository {
  usage: AiUsageRecord[] = [];
  events: ProductEvent[] = [];
  turns: TurnTelemetryRecord[] = [];

  async appendUsage(record: AiUsageRecord): Promise<void> {
    this.usage.push(structuredClone(record));
  }

  async appendEvent(event: ProductEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async appendTurn(record: TurnTelemetryRecord): Promise<void> {
    if (
      this.turns.some(
        (stored) =>
          stored.ownerId === record.ownerId &&
          stored.turnId === record.turnId,
      )
    ) {
      return;
    }
    this.turns.push(structuredClone(record));
  }

  async usageSince(
    ownerId: string,
    since: Date,
  ): Promise<AiUsageRecord[]> {
    return this.usage.filter(
      (record) =>
        record.ownerId === ownerId &&
        new Date(record.at).getTime() >= since.getTime(),
    );
  }

  async eventsSince(
    ownerId: string,
    since: Date,
  ): Promise<ProductEvent[]> {
    return this.events.filter(
      (event) =>
        event.ownerId === ownerId &&
        new Date(event.at).getTime() >= since.getTime(),
    );
  }

  async turnsSince(
    ownerId: string,
    since: Date,
  ): Promise<TurnTelemetryRecord[]> {
    return this.turns.filter(
      (record) =>
        record.ownerId === ownerId &&
        new Date(record.at).getTime() >= since.getTime(),
    );
  }

  async removeBefore(before: Date): Promise<void> {
    this.usage = this.usage.filter(
      (record) => new Date(record.at).getTime() >= before.getTime(),
    );
    this.events = this.events.filter(
      (event) => new Date(event.at).getTime() >= before.getTime(),
    );
    this.turns = this.turns.filter(
      (record) => new Date(record.at).getTime() >= before.getTime(),
    );
  }

  async removeAll(ownerId: string): Promise<void> {
    this.usage = this.usage.filter((record) => record.ownerId !== ownerId);
    this.events = this.events.filter((event) => event.ownerId !== ownerId);
    this.turns = this.turns.filter((record) => record.ownerId !== ownerId);
  }
}

function options(limit = 1_000) {
  return {
    rollingTokenLimit: limit,
    retentionDays: 30,
    prices: {
      cheap: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      efficient: { inputPerMillionUsd: 3, outputPerMillionUsd: 4 },
      ambitious: { inputPerMillionUsd: 5, outputPerMillionUsd: 6 },
    },
  };
}

function usageContext(
  ownerId: string,
  overrides: Partial<AiUsageContext> = {},
): AiUsageContext {
  return {
    ownerId,
    tier: "cheap",
    purpose: "reply",
    model: "model-uji",
    maxTokens: 50,
    inputTokenEstimate: 10,
    safetyCritical: false,
    ...overrides,
    requestId: overrides.requestId ?? "request-uji",
    turnId: overrides.turnId ?? null,
  };
}

async function observeModelCall(
  telemetry: TelemetryService,
  ownerId: string,
  turnId: string,
  purpose: AiPurpose,
  requestId: string,
  succeeded = true,
): Promise<void> {
  const context = usageContext(ownerId, {
    requestId,
    turnId,
    purpose,
    maxTokens: 10,
    inputTokenEstimate: 1,
    safetyCritical:
      purpose === "risk-triage" || purpose === "reply-review",
  });
  await telemetry.beforeRequest(context);
  await telemetry.afterRequest(
    context,
    {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimated: false,
    },
    { succeeded, latencyMs: 5 },
  );
}

function relatedLedger(
  debitedTokens: () => number,
): RelatedUsageLedger {
  return {
    exportOwner: async () => [],
    exportEntitlements: async () => [],
    settleEntitlement: async () => undefined,
    debitedTokens: async () => debitedTokens(),
    forgetOwner: async () => undefined,
    purgeExpired: async () => undefined,
    drain: async () => undefined,
  };
}

describe("TelemetryService", () => {
  it("tidak menahan hasil model saat penulisan repository lambat", async () => {
    let releaseWrite: (() => void) | undefined;
    const repository = new MemoryTelemetryRepository();
    repository.appendUsage = async (record) => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      repository.usage.push(structuredClone(record));
    };
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("student");

    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimated: false,
      },
      { succeeded: true, latencyMs: 20 },
    );

    assert.equal(typeof releaseWrite, "function");
    assert.equal((await telemetry.summary("student")).totalTokens, 15);
    releaseWrite?.();
    await telemetry.drain();
    assert.equal(repository.usage.length, 1);
  });

  it("drain menunggu event yang masih berada di antrean eksklusif", async () => {
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const repository = new MemoryTelemetryRepository();
    repository.usageSince = async () => {
      markReadStarted?.();
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return [];
    };
    const telemetry = new TelemetryService(repository, options());

    const reservation = telemetry.beforeRequest(usageContext("student"));
    await readStarted;
    const event = telemetry.event("student", "session_started");
    const draining = telemetry.drain();
    releaseRead?.();

    await draining;
    await Promise.all([reservation, event]);
    assert.equal(repository.events.length, 1);
  });

  it("mereservasi input dan output sehingga request serentak tidak melewati cap", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options(100));
    const first = usageContext("student");
    const second = usageContext("student");

    const results = await Promise.allSettled([
      telemetry.beforeRequest(first),
      telemetry.beforeRequest(second),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    assert.ok(rejected?.reason instanceof UsageLimitError);
  });

  it("memakai debit delivery sebagai sumber kuota, bukan provider success", async () => {
    const repository = new MemoryTelemetryRepository();
    let deliveredDebit = 0;
    const telemetry = new TelemetryService(
      repository,
      options(100),
      undefined,
      undefined,
      relatedLedger(() => deliveredDebit),
    );
    const first = usageContext("student", { requestId: "first" });

    await telemetry.beforeRequest(first);
    await telemetry.afterRequest(
      first,
      {
        inputTokens: 40,
        outputTokens: 20,
        totalTokens: 60,
        estimated: false,
      },
      { succeeded: true, latencyMs: 10 },
    );

    const beforeDelivery = await telemetry.summary("student");
    assert.equal(beforeDelivery.totalTokens, 60);
    assert.equal(beforeDelivery.capacityUsedTokens, 0);

    const second = usageContext("student", { requestId: "second" });
    await telemetry.beforeRequest(second);
    await telemetry.afterRequest(
      second,
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: true },
      { succeeded: false, latencyMs: 1 },
    );

    deliveredDebit = 60;
    assert.equal((await telemetry.summary("student")).capacityUsedTokens, 60);
    await assert.rejects(
      telemetry.beforeRequest(usageContext("student", { requestId: "third" })),
      UsageLimitError,
    );
  });

  it("menghitung kandidat delivery sebelum mengizinkan langkah agent berikutnya", async () => {
    const repository = new MemoryTelemetryRepository();
    let pendingDebit = 0;
    const ledger: RelatedUsageLedger = {
      ...relatedLedger(() => 0),
      settleEntitlement: async (_context, usage, outcome) => {
        if (outcome.succeeded) pendingDebit += usage.totalTokens;
      },
      pendingDebitTokens: async () => pendingDebit,
    };
    const telemetry = new TelemetryService(
      repository,
      options(100),
      undefined,
      undefined,
      ledger,
    );
    const first = usageContext("student", {
      requestId: "agent-step-1",
      turnId: "turn-agent",
    });
    await telemetry.beforeRequest(first);
    await telemetry.afterRequest(
      first,
      { inputTokens: 40, outputTokens: 20, totalTokens: 60, estimated: false },
      { succeeded: true, latencyMs: 10 },
    );

    await assert.rejects(
      telemetry.beforeRequest(usageContext("student", {
        requestId: "agent-step-2",
        turnId: "turn-agent",
      })),
      UsageLimitError,
    );
  });

  it("menganggap pembacaan tenggat sebagai overhead, bukan kapasitas", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("student", { purpose: "due-date" });
    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true, latencyMs: 2 },
    );

    const summary = await telemetry.summary("student");
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.capacityUsedTokens, 0);
    assert.equal(repository.usage[0]?.billable, false);
  });

  it("menganggap classifier privasi memori sebagai overhead", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("student", { purpose: "memory-privacy" });
    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true, latencyMs: 2 },
    );

    const summary = await telemetry.summary("student");
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.capacityUsedTokens, 0);
    assert.equal(repository.usage[0]?.billable, false);
  });

  it("menganggap compiler ingress grup sebagai overhead", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("whatsapp:group-1", {
      purpose: "group-ingress",
    });
    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { succeeded: true, latencyMs: 2 },
    );

    const summary = await telemetry.summary("whatsapp:group-1");
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.capacityUsedTokens, 0);
    assert.equal(repository.usage[0]?.billable, false);
  });

  it("tetap melewatkan dan mencatat panggilan keselamatan saat cap habis", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options(1));
    const context = usageContext("student", {
      purpose: "risk-triage",
      safetyCritical: true,
      maxTokens: 500,
      inputTokenEstimate: 500,
    });

    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        estimated: false,
      },
      { succeeded: true, latencyMs: 12 },
    );
    assert.equal((await telemetry.summary("student")).totalTokens, 0);
    assert.equal(repository.usage[0]?.totalTokens, 30);
    assert.equal(repository.usage[0]?.billable, false);
  });

  it("menghitung biaya dan menormalkan total provider yang terlalu kecil", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("student");
    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 2,
        estimated: false,
      },
      { succeeded: true, latencyMs: -4 },
    );

    const summary = await telemetry.summary("student");
    assert.equal(summary.totalTokens, 1_500);
    assert.equal(summary.estimatedCostUsd, 0.002);
    assert.equal(repository.usage[0]?.latencyMs, 0);
  });

  it("forget mencegah request lama menghidupkan telemetry kembali", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const old = usageContext("student", { turnId: "turn-lama" });

    await telemetry.beginTurn("student", "turn-lama");
    await telemetry.beforeRequest(old);
    await telemetry.event("student", "session_started");
    await telemetry.forget("student");
    await telemetry.afterRequest(
      old,
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        estimated: false,
      },
      { succeeded: true, latencyMs: 10 },
    );
    await telemetry.event("student", "session_stopped");
    await telemetry.recordTurn({
      ownerId: "student",
      turnId: "turn-lama",
      subjectKind: "private",
      channel: "telegram",
      outcome: "completed",
      bubbleCount: 1,
      batchWaitMs: 1,
      queueWaitMs: 1,
      handlingLatencyMs: 1,
      totalLatencyMs: 3,
    });

    assert.equal(repository.usage.length, 0);
    assert.equal(repository.events.length, 0);
    assert.equal(repository.turns.length, 0);

    const fresh = usageContext("student");
    await assert.rejects(
      telemetry.beforeRequest(fresh),
      TelemetryOwnerBlockedError,
    );
    await telemetry.allow("student");
    await telemetry.beforeRequest(fresh);
    await telemetry.afterRequest(
      fresh,
      {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        estimated: false,
      },
      { succeeded: true, latencyMs: 1 },
    );
    assert.equal(repository.usage.length, 1);
  });

  it("menahan allow sampai seluruh penghapusan owner selesai", async () => {
    const repository = new MemoryTelemetryRepository();
    const removeAll = repository.removeAll.bind(repository);
    let deletionStarted!: () => void;
    let releaseDeletion!: () => void;
    const started = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    repository.removeAll = async (ownerId) => {
      deletionStarted();
      await blocked;
      await removeAll(ownerId);
    };
    const telemetry = new TelemetryService(repository, options());

    const forgetting = telemetry.forget("student");
    await started;
    let allowed = false;
    const allowing = telemetry.allow("student").then(() => {
      allowed = true;
    });
    await Promise.resolve();

    assert.equal(allowed, false);
    await assert.rejects(
      telemetry.beforeRequest(usageContext("student")),
      TelemetryOwnerBlockedError,
    );

    releaseDeletion();
    await Promise.all([forgetting, allowing]);
    assert.equal(allowed, true);
    const fresh = usageContext("student", { requestId: "request-baru" });
    await telemetry.beforeRequest(fresh);
    await telemetry.afterRequest(
      fresh,
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: false,
      },
      { succeeded: true, latencyMs: 1 },
    );
    await telemetry.drain();
    assert.equal(repository.usage.length, 1);
  });

  it("memakai ID turn durable yang sama setelah service dibuat ulang", async () => {
    const repository = new MemoryTelemetryRepository();
    const completion = {
      ownerId: "student",
      turnId: "turn-replay",
      subjectKind: "private" as const,
      channel: "telegram" as const,
      outcome: "completed" as const,
      bubbleCount: 1,
      batchWaitMs: 1,
      queueWaitMs: 1,
      handlingLatencyMs: 1,
      totalLatencyMs: 3,
    };
    const first = new TelemetryService(repository, options());
    await first.recordTurn(completion);
    await first.drain();
    const firstId = repository.turns[0]?.id;

    const restarted = new TelemetryService(repository, options());
    await restarted.recordTurn(completion);
    await restarted.drain();

    assert.ok(firstId);
    assert.equal(repository.turns.length, 1);
    assert.equal(repository.turns[0]?.id, firstId);
  });

  it("mengekspor usage dan event tanpa field isi percakapan", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const context = usageContext("student");
    await telemetry.beforeRequest(context);
    await telemetry.afterRequest(
      context,
      {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        estimated: true,
      },
      { succeeded: false, latencyMs: 3 },
    );
    await telemetry.event("student", "adaptive_action_chosen");

    const exported = await telemetry.export("student");
    assert.equal(exported.usage.length, 1);
    assert.equal(exported.events.length, 1);
    assert.deepEqual(exported.turns, []);
    assert.doesNotMatch(
      JSON.stringify(exported),
      /"(?:message|prompt|reply)"\s*:/u,
    );
  });

  it("mengagregasi seluruh model dan sinyal dalam satu turnId tanpa isi", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    await telemetry.beginTurn("student", "turn-1");
    await observeModelCall(telemetry, "student", "turn-1", "turn-boundary", "boundary-1");
    await observeModelCall(telemetry, "student", "turn-1", "understanding", "understanding-1");
    await observeModelCall(telemetry, "student", "turn-1", "risk-triage", "triage-1", false);
    await observeModelCall(telemetry, "student", "turn-1", "reply", "reply-1");
    await observeModelCall(telemetry, "student", "turn-1", "reply-review", "review-1");
    await telemetry.noteTurnSignal("student", "turn-1", "risk-triage-unavailable");
    await telemetry.noteTurnSignal("student", "turn-1", "safety-fallback");
    await telemetry.noteTurnSignal("student", "turn-1", "safe-action-blocked");
    await telemetry.recordTurn({
      ownerId: "student",
      turnId: "turn-1",
      subjectKind: "private",
      channel: "telegram",
      outcome: "completed",
      bubbleCount: 2,
      batchWaitMs: 10,
      queueWaitMs: 5,
      handlingLatencyMs: 20,
      totalLatencyMs: 30,
    });
    await telemetry.drain();

    assert.equal(repository.turns.length, 1);
    assert.deepEqual(
      { ...repository.turns[0], id: "[id]", at: "[at]" },
      {
        id: "[id]",
        at: "[at]",
        ownerId: "student",
        turnId: "turn-1",
        subjectKind: "private",
        channel: "telegram",
        outcome: "completed",
        bubbleCount: 2,
        batchWaitMs: 10,
        queueWaitMs: 5,
        handlingLatencyMs: 20,
        totalLatencyMs: 35,
        timeToFirstResponseMs: null,
        timeToFinalResponseMs: null,
        modelCallCount: 5,
        failedModelCallCount: 1,
        boundaryCallCount: 1,
        understandingCallCount: 1,
        riskTriageCallCount: 1,
        replyCallCount: 1,
        replyReviewCallCount: 1,
        agentCallCount: 0,
        deterministicFastPathCount: 0,
        riskTriageUnavailableCount: 1,
        safetyFallbackCount: 1,
        safeActionBlockedCount: 1,
        urgentAcknowledgementCount: 0,
      },
    );
    assert.doesNotMatch(
      JSON.stringify(repository.turns[0]),
      /"(?:message|prompt|reply|reasoning|content|toolOutput)"\s*:/iu,
    );
  });

  it("mempertahankan sinyal urgent yang mendahului span handler", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    const signal = telemetry.noteTurnSignal(
      "student",
      "turn-urgent",
      "urgent-acknowledgement",
    );
    const begin = telemetry.beginTurn("student", "turn-urgent");
    const record = telemetry.recordTurn({
      ownerId: "student",
      turnId: "turn-urgent",
      subjectKind: "private",
      channel: "telegram",
      outcome: "completed",
      bubbleCount: 1,
      batchWaitMs: 0,
      queueWaitMs: 0,
      handlingLatencyMs: 1,
      totalLatencyMs: 1,
    });

    await Promise.all([signal, begin, record]);
    await telemetry.drain();

    assert.equal(repository.turns.length, 1);
    assert.equal(repository.turns[0]?.urgentAcknowledgementCount, 1);
  });

  it("mengukur TTFR dan final response dari delivery aktual secara terpisah", async () => {
    const repository = new MemoryTelemetryRepository();
    let nowMs = Date.parse("2026-08-15T00:00:00.000Z");
    const telemetry = new TelemetryService(
      repository,
      options(),
      () => new Date(nowMs),
    );
    await telemetry.beginTurn("student", "turn-response");
    nowMs += 250;
    await telemetry.noteTurnResponse("student", "turn-response");
    nowMs += 750;
    await telemetry.noteTurnResponse("student", "turn-response");
    nowMs += 500;
    await telemetry.recordTurn({
      ownerId: "student",
      turnId: "turn-response",
      subjectKind: "private",
      channel: "telegram",
      outcome: "completed",
      bubbleCount: 2,
      batchWaitMs: 0,
      queueWaitMs: 0,
      handlingLatencyMs: 1_500,
      totalLatencyMs: 1_500,
    });
    await telemetry.drain();

    assert.equal(repository.turns[0]?.timeToFirstResponseMs, 250);
    assert.equal(repository.turns[0]?.timeToFinalResponseMs, 1_000);
    const summary = await telemetry.performanceSummary("student", new Date(0));
    assert.deepEqual(summary.timeToFirstResponseMs, { p50: 250, p95: 250 });
    assert.deepEqual(summary.timeToFinalResponseMs, { p50: 1_000, p95: 1_000 });
  });

  it("menghitung p50/p95 dan rate dengan turn tanpa model sebagai denominator", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());

    await telemetry.beginTurn("student", "turn-a");
    await observeModelCall(telemetry, "student", "turn-a", "turn-boundary", "a-boundary");
    await observeModelCall(telemetry, "student", "turn-a", "risk-triage", "a-triage");
    await observeModelCall(telemetry, "student", "turn-a", "reply-review", "a-review");
    await telemetry.recordTurn({
      ownerId: "student",
      turnId: "turn-a",
      subjectKind: "private",
      channel: "telegram",
      outcome: "completed",
      bubbleCount: 1,
      batchWaitMs: 2,
      queueWaitMs: 3,
      handlingLatencyMs: 5,
      totalLatencyMs: 10,
    });

    await telemetry.beginTurn("student", "turn-b");
    await telemetry.noteTurnSignal("student", "turn-b", "deterministic-fast-path");
    await telemetry.noteTurnSignal("student", "turn-b", "safe-action-blocked");
    for (const [turnId, outcome, totalLatencyMs] of [
      ["turn-b", "completed", 20],
      ["turn-c", "failed", 30],
      ["turn-d", "cancelled", 40],
    ] as const) {
      await telemetry.recordTurn({
        ownerId: "student",
        turnId,
        subjectKind: "private",
        channel: "telegram",
        outcome,
        bubbleCount: 1,
        batchWaitMs: 0,
        queueWaitMs: 0,
        handlingLatencyMs: totalLatencyMs,
        totalLatencyMs,
      });
    }
    await telemetry.drain();

    const summary = await telemetry.performanceSummary("student", new Date(0));
    assert.equal(summary.turnCount, 4);
    assert.equal(summary.completedCount, 2);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.cancelledCount, 1);
    assert.deepEqual(summary.totalLatencyMs, { p50: 20, p95: 40 });
    assert.equal(summary.averageModelCalls, 0.75);
    assert.equal(summary.boundaryClassifierRate, 0.25);
    assert.equal(summary.riskTriageRate, 0.25);
    assert.equal(summary.replyReviewRate, 0.25);
    assert.equal(summary.deterministicFastPathRate, 0.25);
    assert.equal(summary.safeActionBlockedRate, 0.25);
  });

  it("tidak mencampur accumulator dua turn concurrent milik owner yang sama", async () => {
    const repository = new MemoryTelemetryRepository();
    const telemetry = new TelemetryService(repository, options());
    await Promise.all([
      telemetry.beginTurn("student", "turn-one"),
      telemetry.beginTurn("student", "turn-two"),
    ]);
    await Promise.all([
      observeModelCall(telemetry, "student", "turn-one", "reply", "one-reply"),
      observeModelCall(telemetry, "student", "turn-two", "turn-boundary", "two-boundary"),
    ]);
    await Promise.all([
      telemetry.recordTurn({
        ownerId: "student",
        turnId: "turn-one",
        subjectKind: "private",
        channel: "telegram",
        outcome: "completed",
        bubbleCount: 1,
        batchWaitMs: 1,
        queueWaitMs: 1,
        handlingLatencyMs: 1,
        totalLatencyMs: 3,
      }),
      telemetry.recordTurn({
        ownerId: "student",
        turnId: "turn-two",
        subjectKind: "private",
        channel: "telegram",
        outcome: "completed",
        bubbleCount: 1,
        batchWaitMs: 1,
        queueWaitMs: 1,
        handlingLatencyMs: 1,
        totalLatencyMs: 3,
      }),
    ]);
    await telemetry.drain();

    const turns = new Map(repository.turns.map((turn) => [turn.turnId, turn]));
    assert.equal(turns.get("turn-one")?.replyCallCount, 1);
    assert.equal(turns.get("turn-one")?.boundaryCallCount, 0);
    assert.equal(turns.get("turn-two")?.replyCallCount, 0);
    assert.equal(turns.get("turn-two")?.boundaryCallCount, 1);
  });

  it("menolak konfigurasi harga atau retensi yang tidak sah", () => {
    assert.throws(
      () =>
        new TelemetryService(new MemoryTelemetryRepository(), {
          ...options(),
          retentionDays: 0,
        }),
    );
    assert.throws(
      () =>
        new TelemetryService(new MemoryTelemetryRepository(), {
          ...options(),
          prices: {
            ...options().prices,
            cheap: {
              inputPerMillionUsd: -1,
              outputPerMillionUsd: 0,
            },
          },
        }),
    );
  });
});
