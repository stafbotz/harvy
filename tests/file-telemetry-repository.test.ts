import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TurnTelemetryRecord } from "../src/domain/telemetry.js";
import { FileTelemetryRepository } from "../src/storage/file-telemetry-repository.js";

describe("FileTelemetryRepository migration", () => {
  it("memigrasikan v1 tanpa mengarang provenance provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-telemetry-migration-"));
    const file = join(directory, "telemetry.json");
    try {
      await writeFile(file, JSON.stringify({
        version: 1,
        usage: [{
          id: "usage-lama",
          at: "2026-08-01T00:00:00.000Z",
          ownerId: "123",
          tier: "cheap",
          purpose: "understanding",
          model: "model-lama",
          maxTokens: 100,
          inputTokenEstimate: 20,
          safetyCritical: false,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          estimated: false,
          estimatedCostUsd: 0.001,
          succeeded: true,
          latencyMs: 25,
        }],
        events: [],
      }), "utf8");

      const repository = new FileTelemetryRepository(file);
      const records = await repository.usageSince(
        "123",
        new Date("2026-07-31T00:00:00.000Z"),
      );
      assert.equal(records.length, 1);
      assert.equal(records[0]?.requestId, "legacy_usage-lama");
      assert.equal(records[0]?.turnId, null);
      assert.equal(records[0]?.subjectKind, "private");
      assert.equal(records[0]?.channel, "telegram");
      assert.equal(records[0]?.billable, true);
      assert.equal(records[0]?.model, "model-lama");

      const persisted = JSON.parse(await readFile(file, "utf8")) as {
        version: number;
        usage: Record<string, unknown>[];
        turns: unknown[];
      };
      assert.equal(persisted.version, 3);
      assert.deepEqual(persisted.turns, []);
      assert.equal(persisted.usage[0]?.requestId, "legacy_usage-lama");
      assert.equal("providerId" in (persisted.usage[0] ?? {}), false);
      assert.equal("origin" in (persisted.usage[0] ?? {}), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("menyimpan, memfilter, dan menghapus turn telemetry bersama data owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-turn-telemetry-"));
    const file = join(directory, "telemetry.json");
    try {
      const repository = new FileTelemetryRepository(file);
      const record: TurnTelemetryRecord = {
        id: "turn-record-1",
        at: "2026-08-07T10:00:00.000Z",
        turnId: "turn-1",
        ownerId: "123",
        subjectKind: "private",
        channel: "telegram",
        outcome: "completed",
        bubbleCount: 1,
        batchWaitMs: 10,
        queueWaitMs: 2,
        handlingLatencyMs: 20,
        totalLatencyMs: 32,
        modelCallCount: 3,
        failedModelCallCount: 0,
        boundaryCallCount: 1,
        understandingCallCount: 1,
        riskTriageCallCount: 1,
        replyCallCount: 0,
        replyReviewCallCount: 0,
        agentCallCount: 0,
        deterministicFastPathCount: 0,
        riskTriageUnavailableCount: 0,
        safetyFallbackCount: 0,
        safeActionBlockedCount: 0,
        urgentAcknowledgementCount: 0,
      };
      await repository.appendTurn(record);

      const reopened = new FileTelemetryRepository(file);
      await reopened.appendTurn({ ...record, id: "turn-record-replay" });
      assert.equal(
        (await reopened.turnsSince("123", new Date("2026-08-07T00:00:00.000Z"))).length,
        1,
      );
      assert.equal(
        (await reopened.turnsSince("other", new Date(0))).length,
        0,
      );

      await reopened.removeAll("123");
      assert.equal((await reopened.turnsSince("123", new Date(0))).length, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
