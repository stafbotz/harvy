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
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
} from "../src/domain/telemetry.js";

class MemoryTelemetryRepository implements TelemetryRepository {
  usage: AiUsageRecord[] = [];
  events: ProductEvent[] = [];

  async appendUsage(record: AiUsageRecord): Promise<void> {
    this.usage.push(structuredClone(record));
  }

  async appendEvent(event: ProductEvent): Promise<void> {
    this.events.push(structuredClone(event));
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

  async removeBefore(before: Date): Promise<void> {
    this.usage = this.usage.filter(
      (record) => new Date(record.at).getTime() >= before.getTime(),
    );
    this.events = this.events.filter(
      (event) => new Date(event.at).getTime() >= before.getTime(),
    );
  }

  async removeAll(ownerId: string): Promise<void> {
    this.usage = this.usage.filter((record) => record.ownerId !== ownerId);
    this.events = this.events.filter((event) => event.ownerId !== ownerId);
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
    const old = usageContext("student");

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

    assert.equal(repository.usage.length, 0);
    assert.equal(repository.events.length, 0);

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
    assert.doesNotMatch(
      JSON.stringify(exported),
      /"(?:message|prompt|reply)"\s*:/u,
    );
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
