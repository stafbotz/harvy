import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { GroupAuthorityResolver } from
  "../src/core/group-authority-policy.js";
import { createGroupAgentRunRuntimePorts } from
  "../src/core/group-agent-run-runtime.js";
import { GroupAgentRunService } from
  "../src/core/group-agent-run-service.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import {
  groupRunExecutionInputDigest,
  type GroupAgentRun,
  type GroupRunExecutionCheckpoint,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-15T08:00:00.000Z");

describe("GroupAgentRun runtime composition", () => {
  it("claim sampai final selalu melewati transport fenced dan receipt durable", async () => {
    const fixture = await makeFixture();
    try {
      const anchored = await startAnchored(fixture.service);
      assert.deepEqual(
        await fixture.ports.listRunnableRunIds(new AbortController().signal),
        [anchored.runId],
      );

      const claim = await fixture.ports.claimRunnable(anchored.runId);
      assert.ok(claim);
      const checkpointed = await fixture.ports.commitExecutionCheckpoint({
        runId: claim.run.runId,
        attemptId: claim.attempt.attemptId,
        expectedStateRevision: claim.run.stateRevision,
        checkpoint: checkpoint(claim.run, claim.attempt.attemptId),
      });
      const completed = await fixture.ports.commitFinal({
        runId: checkpointed.runId,
        attemptId: claim.attempt.attemptId,
        expectedStateRevision: checkpointed.stateRevision,
        reply: "Jadwal grup sudah tersusun.",
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.result?.text, "Jadwal grup sudah tersusun.");
      assert.equal(completed.receipts.at(-1)?.status, "committed");
      assert.equal(fixture.deliveries.length, 1);
      assert.equal(fixture.deliveries[0]?.quoteMessageId, "anchor-runtime");
      assert.equal(fixture.deliveries[0]?.runtimeAllowed, true);
      assert.equal(
        (await fixture.repository.load(anchored.runId))?.status,
        "completed",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("pertanyaan mengikat watermark yang dibaca sesudah delivery", async () => {
    const fixture = await makeFixture(17);
    try {
      const anchored = await startAnchored(fixture.service);
      const claim = await fixture.ports.claimRunnable(anchored.runId);
      assert.ok(claim);
      const requestedCheckpoint = checkpoint(
        claim.run,
        claim.attempt.attemptId,
      );
      const checkpointed = await fixture.ports.commitExecutionCheckpoint({
        runId: claim.run.runId,
        attemptId: claim.attempt.attemptId,
        expectedStateRevision: claim.run.stateRevision,
        checkpoint: requestedCheckpoint,
      });
      const waiting = await fixture.ports.commitQuestion({
        runId: checkpointed.runId,
        attemptId: claim.attempt.attemptId,
        expectedStateRevision: checkpointed.stateRevision,
        checkpoint: checkpointed.checkpoint!,
        prompt: "Rani, Sabtu pagi bisa?",
        assignee: structuredClone(checkpointed.initiator),
      });

      assert.equal(waiting.status, "waiting_input");
      assert.equal(waiting.questions.at(-1)?.acceptAnswersAfterIngressRevision, 17);
      assert.equal(waiting.checkpoint?.waitingQuestionId, waiting.questions.at(-1)?.questionId);
      assert.equal(waiting.workAttempts?.at(-1)?.status, "requeued");
      assert.equal(fixture.deliveries[0]?.runtimeAllowed, true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function makeFixture(watermark = 0) {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-runtime-"));
  const repository = new FileGroupAgentRunRepository(join(root, "runs.json"));
  let sequence = 0;
  const authority: GroupAuthorityResolver = {
    resolveGroupAuthority: async () => ({ role: "member", authorityEpoch: 4 }),
  };
  const runtimeAdmission = async () => true;
  const service = new GroupAgentRunService(
    repository,
    authority,
    () => NOW,
    () => `runtime-${++sequence}`,
    runtimeAdmission,
  );
  const deliveries: Array<{
    text: string;
    quoteMessageId: string | undefined;
    runtimeAllowed: boolean;
  }> = [];
  const ports = createGroupAgentRunRuntimePorts({
    repository,
    service,
    runtimeAdmission,
    watermark: { currentIngressRevision: () => watermark },
    transport: {
      sendGroupRunMessage: async (
        _target,
        text,
        quoteMessageId,
        idempotencyKey,
        _authority,
        runtimeFence,
      ) => {
        deliveries.push({
          text,
          quoteMessageId,
          runtimeAllowed: await runtimeFence(),
        });
        return { messageId: `message-${idempotencyKey.slice(-20)}` };
      },
    },
  });
  return { root, repository, service, ports, deliveries };
}

async function startAnchored(service: GroupAgentRunService) {
  const started = await service.start({ message: message() });
  assert.equal(started.status, "started");
  return service.commitAnchor(
    started.run.runId,
    started.run.stateRevision,
    "📌 Pekerjaan grup",
    async () => ({ messageId: "anchor-runtime" }),
  );
}

function message(): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "runtime@g.us" },
    accountId: "utama",
    messageId: "start-runtime",
    participantId: "pn:ayu",
    participantAliases: ["lid:ayu"],
    participantName: "Ayu",
    groupName: "Grup runtime",
    text: "Harvy, mulai pekerjaan: susun jadwal belajar grup",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 4,
    ingressRevision: 1,
  };
}

function checkpoint(
  run: GroupAgentRun,
  attemptId: string,
): GroupRunExecutionCheckpoint {
  return {
    version: 1,
    engine: "group-model-v1",
    attemptId,
    sequence: 1,
    instructionRevision: run.instructionRevision,
    inputDigest: groupRunExecutionInputDigest(run),
    waitingQuestionId: null,
    budget: new RunBudgetAccount({}, () => NOW.getTime()).checkpoint(),
    updatedAt: NOW.toISOString(),
  };
}
