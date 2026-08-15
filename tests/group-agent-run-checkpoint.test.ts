import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { GroupAuthorityResolver } from
  "../src/core/group-authority-policy.js";
import {
  GroupAgentRunConflictError,
  GroupAgentRunRuntimeAdmissionError,
  GroupAgentRunService,
  type GroupAgentRunRuntimeAdmissionResolver,
} from "../src/core/group-agent-run-service.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import {
  groupRunExecutionInputDigest,
  type GroupAgentRun,
  type GroupRunExecutionCheckpoint,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T10:00:00.000Z");

describe("GroupAgentRun execution checkpoint", () => {
  it("menyimpan checkpoint exact active attempt dan melanjutkan sequence/budget monotonic", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const firstCheckpoint = checkpoint(claimed.run, claimed.attempt.attemptId, 1);

    const first = await fixture.service.commitExecutionCheckpoint({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      checkpoint: firstCheckpoint,
    });
    assert.deepEqual(first.checkpoint, firstCheckpoint);
    assert.equal(first.checkpoint?.inputDigest, groupRunExecutionInputDigest(first));

    const requeued = await fixture.service.requeueWorkAttempt({
      runId: first.runId,
      expectedStateRevision: first.stateRevision,
      attemptId: claimed.attempt.attemptId,
      code: "checkpoint_resume",
    });
    const resumed = await fixture.service.claimWorkAttempt({
      runId: first.runId,
      expectedStateRevision: requeued.run.stateRevision,
      claimKey: "checkpoint:resume",
    });
    const secondCheckpoint = checkpoint(
      resumed.run,
      resumed.attempt.attemptId,
      2,
      {
        consumedTokens: 12,
        modelCalls: 1,
        activeElapsedMs: 25,
      },
    );
    const second = await fixture.service.commitExecutionCheckpoint({
      runId: resumed.run.runId,
      expectedStateRevision: resumed.run.stateRevision,
      attemptId: resumed.attempt.attemptId,
      checkpoint: secondCheckpoint,
    });
    assert.equal(second.checkpoint?.attemptId, resumed.attempt.attemptId);
    assert.equal(second.checkpoint?.sequence, 2);
    assert.equal(second.checkpoint?.budget.consumedTokens, 12);
  });

  it("digest berubah bersama applied prefix dan menolak checkpoint attempt basi", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const initialDigest = groupRunExecutionInputDigest(claimed.run);
    const applied = await fixture.service.routeMessage(message({
      messageId: "checkpoint-constraint",
      text: "Kerjakan tanpa mengubah jadwal Jumat",
      quotedMessageId: claimed.run.anchor.messageId,
      ingressRevision: 2,
    }));
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") assert.fail("constraint harus applied");
    assert.notEqual(groupRunExecutionInputDigest(applied.run), initialDigest);

    await assert.rejects(
      fixture.service.commitExecutionCheckpoint({
        runId: applied.run.runId,
        expectedStateRevision: applied.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        checkpoint: checkpoint(claimed.run, claimed.attempt.attemptId, 1),
      }),
      GroupAgentRunConflictError,
    );
    assert.equal((await fixture.repository.load(applied.run.runId))?.checkpoint, null);
  });

  it("prepare question mempersist checkpoint sebelum transport dan answer hanya melepas waiting marker", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const proposed = checkpoint(claimed.run, claimed.attempt.attemptId, 1, {
      consumedTokens: 8,
      modelCalls: 1,
      activeElapsedMs: 15,
    });
    let pendingCheckpoint: GroupRunExecutionCheckpoint | null = null;
    const waiting = await fixture.service.commitAssignedQuestion({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      prompt: "Kapan kelompok bisa berkumpul?",
      assignee: structuredClone(claimed.run.initiator),
      attemptId: claimed.attempt.attemptId,
      checkpoint: proposed,
    }, async () => {
      const prepared = await fixture.repository.load(claimed.run.runId);
      assert.equal(
        prepared?.pendingEffect?.workAttemptId,
        claimed.attempt.attemptId,
      );
      assert.equal(prepared?.pendingEffect?.purpose, "assigned_question");
      pendingCheckpoint = structuredClone(prepared?.checkpoint ?? null);
      assert.equal(
        pendingCheckpoint?.waitingQuestionId,
        prepared?.pendingEffect?.question?.questionId,
      );
      return {
        messageId: "checkpoint-question-message",
        acceptAnswersAfterIngressRevision: 10,
      };
    });
    assert.equal(waiting.status, "waiting_input");
    assert.equal(waiting.workAttempts?.at(-1)?.status, "requeued");
    assert.equal(
      waiting.receipts.at(-1)?.workAttemptId,
      claimed.attempt.attemptId,
    );
    assert.equal(
      waiting.checkpoint?.waitingQuestionId,
      waiting.questions.at(-1)?.questionId,
    );
    const waitingCheckpoint = waiting.checkpoint;
    assert.ok(waitingCheckpoint);

    const answered = await fixture.service.routeMessage(message({
      messageId: "checkpoint-answer",
      text: "Saya bisa Jumat",
      quotedMessageId: "checkpoint-question-message",
      repliesToHarvy: true,
      ingressRevision: 11,
    }));
    assert.equal(answered.status, "applied");
    if (answered.status !== "applied") assert.fail("answer harus applied");
    assert.equal(answered.run.checkpoint?.waitingQuestionId, null);
    assert.equal(answered.run.checkpoint?.attemptId, waitingCheckpoint.attemptId);
    assert.equal(answered.run.checkpoint?.sequence, waitingCheckpoint.sequence);
    assert.deepEqual(answered.run.checkpoint?.budget, waitingCheckpoint.budget);
    assert.equal(answered.run.checkpoint?.inputDigest, waitingCheckpoint.inputDigest);
  });

  it("not_committed question melepas waiting marker tanpa mereset budget", async () => {
    let questionPhase = false;
    let questionRuntimeChecks = 0;
    const fixture = await makeFixture(async () => {
      if (!questionPhase) return true;
      questionRuntimeChecks += 1;
      return questionRuntimeChecks < 3;
    });
    const claimed = await startClaimed(fixture.service);
    const proposed = checkpoint(claimed.run, claimed.attempt.attemptId, 1, {
      consumedTokens: 7,
      modelCalls: 1,
      activeElapsedMs: 9,
    });
    questionPhase = true;
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        prompt: "Apakah Jumat bisa?",
        assignee: structuredClone(claimed.run.initiator),
        attemptId: claimed.attempt.attemptId,
        checkpoint: proposed,
      }, async () => {
        deliveries += 1;
        return {
          messageId: "must-not-send-checkpoint-question",
          acceptAnswersAfterIngressRevision: 20,
        };
      }),
      GroupAgentRunRuntimeAdmissionError,
    );
    const stored = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 0);
    assert.equal(questionRuntimeChecks, 3);
    assert.equal(stored?.pendingEffect, null);
    assert.equal(stored?.checkpoint?.waitingQuestionId, null);
    assert.equal(stored?.checkpoint?.attemptId, claimed.attempt.attemptId);
    assert.deepEqual(stored?.checkpoint?.budget, proposed.budget);
    assert.equal(stored?.workAttempts?.at(-1)?.status, "running");
    assert.equal(stored?.receipts.at(-1)?.status, "not_committed");
    assert.equal(
      stored?.receipts.at(-1)?.workAttemptId,
      claimed.attempt.attemptId,
    );
  });

  it("delivery unknown gagal tertutup dan tidak menyimpan provider continuation", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const unsafeCheckpoint = {
      ...checkpoint(claimed.run, claimed.attempt.attemptId, 1),
      providerContinuation: "private-provider-token",
    } as GroupRunExecutionCheckpoint;
    await assert.rejects(
      fixture.service.commitExecutionCheckpoint({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        checkpoint: unsafeCheckpoint,
      }),
      /checkpoint/iu,
    );

    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        prompt: "Pertanyaan ambigu",
        assignee: structuredClone(claimed.run.initiator),
        attemptId: claimed.attempt.attemptId,
        checkpoint: checkpoint(claimed.run, claimed.attempt.attemptId, 1),
      }, async () => {
        throw new Error("transport outcome unknown");
      }),
      /transport outcome unknown/iu,
    );
    const stored = await fixture.repository.load(claimed.run.runId);
    assert.equal(stored?.status, "partial");
    assert.equal(stored?.checkpoint?.waitingQuestionId, null);
    assert.equal(stored?.checkpoint?.attemptId, claimed.attempt.attemptId);
    assert.equal(stored?.workAttempts?.at(-1)?.status, "failed");
    assert.equal(stored?.receipts.at(-1)?.status, "unknown");
    assert.equal(
      stored?.receipts.at(-1)?.workAttemptId,
      claimed.attempt.attemptId,
    );
    assert.doesNotMatch(JSON.stringify(stored), /private-provider-token/iu);
  });

  it("menolak sequence lompat, budget mundur, dan mutation checkpoint bersama field lain", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const first = await fixture.service.commitExecutionCheckpoint({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      checkpoint: checkpoint(claimed.run, claimed.attempt.attemptId, 1, {
        consumedTokens: 10,
        modelCalls: 1,
      }),
    });
    await assert.rejects(
      fixture.service.commitExecutionCheckpoint({
        runId: first.runId,
        expectedStateRevision: first.stateRevision,
        attemptId: claimed.attempt.attemptId,
        checkpoint: checkpoint(first, claimed.attempt.attemptId, 3, {
          consumedTokens: 11,
          modelCalls: 2,
        }),
      }),
      /checkpoint/iu,
    );
    await assert.rejects(
      fixture.service.commitExecutionCheckpoint({
        runId: first.runId,
        expectedStateRevision: first.stateRevision,
        attemptId: claimed.attempt.attemptId,
        checkpoint: checkpoint(first, claimed.attempt.attemptId, 2, {
          consumedTokens: 9,
          modelCalls: 1,
        }),
      }),
      /checkpoint/iu,
    );

    const { stateRevision, ...draft } = structuredClone(first);
    draft.title = "Mutasi checkpoint dan title";
    draft.checkpoint = checkpoint(first, claimed.attempt.attemptId, 2, {
      consumedTokens: 11,
      modelCalls: 2,
    });
    await assert.rejects(
      fixture.repository.save(draft, stateRevision, async () => true),
      /immutable|checkpoint/iu,
    );
  });

  it("memigrasikan checkpoint dan receipt attempt legacy yang belum ada", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    delete database.runs[0]!.checkpoint;
    const anchorReceipt = (database.runs[0]!.receipts as Array<
      Record<string, unknown>
    >)[0];
    delete anchorReceipt?.workAttemptId;
    await writeFile(fixture.file, `${JSON.stringify(database, null, 2)}\n`, "utf8");

    const migrated = await new FileGroupAgentRunRepository(fixture.file).load(
      claimed.run.runId,
    );
    assert.equal(migrated?.checkpoint, null);
    assert.equal(migrated?.receipts[0]?.workAttemptId, null);
  });
});

async function makeFixture(
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver = async () => true,
): Promise<{
  file: string;
  service: GroupAgentRunService;
  repository: FileGroupAgentRunRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-checkpoint-"));
  const file = join(root, "runs.json");
  const repository = new FileGroupAgentRunRepository(file);
  let sequence = 0;
  return {
    file,
    repository,
    service: new GroupAgentRunService(
      repository,
      authorityResolver(),
      () => NOW,
      () => `checkpoint-${++sequence}`,
      runtimeAdmission,
    ),
  };
}

async function startClaimed(service: GroupAgentRunService) {
  const started = await service.start({ message: message() });
  assert.equal(started.status, "started");
  const anchored = await service.commitAnchor(
    started.run.runId,
    started.run.stateRevision,
    "📌 Pekerjaan checkpoint",
    async () => ({ messageId: "checkpoint-anchor" }),
  );
  return service.claimWorkAttempt({
    runId: anchored.runId,
    expectedStateRevision: anchored.stateRevision,
    claimKey: "checkpoint:first",
  });
}

function checkpoint(
  run: GroupAgentRun,
  attemptId: string,
  sequence: number,
  counters: Partial<{
    consumedTokens: number;
    modelCalls: number;
    toolCalls: number;
    unknownUsageAttempts: number;
    activeElapsedMs: number;
  }> = {},
): GroupRunExecutionCheckpoint {
  const budget = new RunBudgetAccount({}, () => NOW.getTime()).checkpoint();
  return {
    version: 1,
    engine: "group-model-v1",
    attemptId,
    sequence,
    instructionRevision: run.instructionRevision,
    inputDigest: groupRunExecutionInputDigest(run),
    waitingQuestionId: null,
    budget: { ...budget, ...counters },
    updatedAt: NOW.toISOString(),
  };
}

function authorityResolver(): GroupAuthorityResolver {
  return {
    resolveGroupAuthority: async () => ({
      role: "member",
      authorityEpoch: 7,
    }),
  };
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "checkpoint@g.us" },
    accountId: "utama",
    messageId: "checkpoint-start",
    participantId: "p1",
    participantAliases: ["p1@lid"],
    participantName: "Ayu",
    groupName: "Grup checkpoint",
    text: "Harvy, mulai pekerjaan checkpoint",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}
