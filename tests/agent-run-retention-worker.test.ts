import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startAgentRunRetentionWorker } from "../src/agent/agent-run-retention-worker.js";
import { AgentRunService } from "../src/core/agent-run-service.js";
import type { OperationalLogger } from "../src/observability/operational-logger.js";
import { FileAgentRunRepository } from "../src/storage/file-agent-run-repository.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";

describe("agent run retention worker", () => {
  it("menghapus checkpoint kedaluwarsa walau owner tidak memuatnya lagi", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-agent-retention-"));
    const repository = new FileAgentRunRepository(join(root, "agent-runs.json"));
    let now = new Date("2026-08-04T05:00:00.000Z");
    const service = new AgentRunService(repository, () => now);
    const checkpoint = makeCheckpoint();
    await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    });

    now = new Date("2026-08-04T05:10:00.000Z");
    const worker = startAgentRunRetentionWorker(service);
    try {
      await worker.runNow();
      assert.equal(await repository.load(checkpoint.scopeKey), null);
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  it("mencatat kegagalan satu putaran lalu mencoba lagi", async () => {
    let calls = 0;
    let loggedFailures = 0;
    const service = {
      purgeExpired: async () => {
        calls += 1;
        if (calls === 1) throw new Error("storage sementara gagal");
        return 0;
      },
    } as unknown as AgentRunService;
    const logger = {
      info: () => undefined,
      error: () => {
        loggedFailures += 1;
      },
    } as unknown as OperationalLogger;
    const worker = startAgentRunRetentionWorker(service, logger);
    try {
      await worker.runNow();
      await worker.runNow();
    } finally {
      worker.stop();
      await worker.drain();
    }

    assert.equal(calls >= 2, true);
    assert.equal(loggedFailures, 1);
  });
});

function makeCheckpoint(): AgentRunCheckpoint {
  return {
    version: 1,
    runId: "run-retention",
    scopeKey: scopeKey(privateAgentScope("telegram", "alice")),
    capabilityHash: "a".repeat(16),
    callableHash: "b".repeat(64),
    request: "buat analisis",
    startedAt: "2026-08-04T05:00:00.000Z",
    deadlineAt: "2026-08-04T05:10:00.000Z",
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: { step: 0, prompt: "Rentang mana?" },
  };
}
