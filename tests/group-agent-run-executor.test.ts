import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AiClient,
  ChatRequest,
  ChatToolCall,
} from "../src/ai/client.js";
import {
  GroupAgentRunExecutor,
  GroupAgentRunExecutorInputError,
  GROUP_AGENT_RUN_EXECUTOR_ENGINE,
  isValidGroupRunExecutionCheckpoint,
} from "../src/ai/group-agent-run-executor.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { withUsageAttribution } from "../src/ai/usage-attribution.js";
import type {
  GroupAgentRun,
  GroupRunInput,
  GroupRunParticipant,
  GroupRunQuestion,
  GroupRunExecutionCheckpoint,
  GroupRunWorkAttempt,
} from "../src/domain/group-agent-run.js";
import { groupRunExecutionInputDigest } from
  "../src/domain/group-agent-run.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const ROUTING = {
  mode: "testing" as const,
  testingModel: "group-executor-test",
  models: { cheap: "", efficient: "", ambitious: "" },
};

describe("GroupAgentRun group-safe executor", () => {
  it("menghasilkan final dengan checkpoint content-free dan budget maju", async () => {
    const requests: ChatRequest[] = [];
    const run = runningRun();
    const executor = executorFor(requests, () => [
      toolCall("harvy_final_v1", {
        reply: "Kelompok sepakat bertemu Jumat pukul 15.00.",
      }),
    ]);

    const result = await executor.execute(executionInput(run));

    assert.equal(result.status, "final");
    if (result.status !== "final") assert.fail("hasil harus final");
    assert.equal(result.reply, "Kelompok sepakat bertemu Jumat pukul 15.00.");
    assert.equal(result.nextCheckpoint.engine, GROUP_AGENT_RUN_EXECUTOR_ENGINE);
    assert.equal(result.nextCheckpoint.attemptId, activeAttempt(run).attemptId);
    assert.equal(result.nextCheckpoint.sequence, 1);
    assert.equal(result.nextCheckpoint.instructionRevision, 0);
    assert.equal(
      result.nextCheckpoint.inputDigest,
      groupRunExecutionInputDigest(run, 0),
    );
    assert.equal(result.nextCheckpoint.waitingQuestionId, null);
    assert.equal(result.nextCheckpoint.budget.modelCalls, 1);
    assert.equal(
      isValidGroupRunExecutionCheckpoint(result.nextCheckpoint, run),
      true,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.usage?.turnId, activeAttempt(run).attemptId);
    assert.equal(requests[0]?.usage?.subjectKind, "group");
    assert.deepEqual(
      requests[0]?.tools?.map((tool) => tool.function.name),
      ["harvy_final_v1", "harvy_need_input_v1"],
    );
    assert.doesNotMatch(
      requests[0]?.messages[0]?.role === "system"
        ? requests[0].messages[0].content ?? ""
        : "",
      /planner agent privat/iu,
    );
  });

  it("model hanya menulis pertanyaan; assignee selalu initiator code-owned", async () => {
    const run = runningRun();
    const executor = executorFor([], () => [
      toolCall("harvy_need_input_v1", {
        prompt: "Hari apa yang bisa dipakai seluruh anggota?",
      }),
    ]);

    const result = await executor.execute(executionInput(run));

    assert.equal(result.status, "needs_input");
    if (result.status !== "needs_input") assert.fail("harus meminta input");
    assert.equal(result.prompt, "Hari apa yang bisa dipakai seluruh anggota?");
    assert.deepEqual(result.assignee, run.initiator);
    assert.notEqual(result.assignee, run.initiator);
    assert.equal(result.nextCheckpoint.waitingQuestionId, null);
  });

  it("mengirim hanya applied prefix tanpa proposal, ambient, memori, atau ID mentah", async () => {
    const requests: ChatRequest[] = [];
    const run = runningRunWithInputs();
    const executor = executorFor(requests, () => [
      toolCall("harvy_final_v1", { reply: "Jumat sore menjadi pilihan." }),
    ]);

    await executor.execute(executionInput(run));

    const messages = JSON.stringify(requests[0]?.messages);
    assert.match(messages, /hindari Jumat pagi/u);
    assert.match(messages, /Jumat sore/u);
    assert.match(messages, /Kapan kamu tersedia\?/u);
    assert.match(messages, /Bima/u);
    assert.doesNotMatch(messages, /PROPOSAL_PRIVATE_SENTINEL/u);
    assert.doesNotMatch(messages, /AMBIENT_HISTORY_SENTINEL/u);
    assert.doesNotMatch(messages, /PRIVATE_MEMORY_SENTINEL/u);
    assert.doesNotMatch(messages, /member-raw@s\.whatsapp\.net/u);
    assert.doesNotMatch(messages, /group-executor@g\.us/u);
    assert.doesNotMatch(messages, /account-secret/u);
  });

  it("menolak call ekstra, field assignee buatan model, dan output terlalu panjang", async () => {
    const cases: readonly ChatToolCall[][] = [
      [
        toolCall("harvy_final_v1", { reply: "satu" }),
        toolCall("harvy_final_v1", { reply: "dua" }),
      ],
      [toolCall("harvy_need_input_v1", {
        prompt: "Kapan?",
        participantId: "admin-palsu",
      })],
      [toolCall("harvy_final_v1", { reply: "x".repeat(3_901) })],
      [toolCall("tool_tidak_dikenal", { reply: "hasil" })],
    ];

    for (const calls of cases) {
      const result = await executorFor([], () => calls).execute(
        executionInput(runningRun()),
      );
      assert.equal(result.status, "stopped");
      if (result.status !== "stopped") assert.fail("output harus ditolak");
      assert.equal(result.code, "invalid_model_output");
      assert.equal(result.nextCheckpoint?.budget.modelCalls, 1);
    }
  });

  it("stale sebelum call tidak mengaktifkan model", async () => {
    const requests: ChatRequest[] = [];
    const result = await executorFor(requests, () => [
      toolCall("harvy_final_v1", { reply: "tidak boleh dipakai" }),
    ]).execute({
      ...executionInput(runningRun()),
      isCurrent: () => false,
    });

    assert.deepEqual(result, {
      status: "stopped",
      code: "stale",
      nextCheckpoint: null,
    });
    assert.equal(requests.length, 0);
  });

  it("revocation setelah response membuang kandidat tetapi mempertahankan budget", async () => {
    let current = true;
    const run = runningRun();
    const executor = executorFor([], () => {
      current = false;
      return [toolCall("harvy_final_v1", { reply: "hasil basi" })];
    });

    const result = await executor.execute({
      ...executionInput(run),
      isCurrent: () => current,
    });

    assert.equal(result.status, "stopped");
    if (result.status !== "stopped") assert.fail("hasil harus stale");
    assert.equal(result.code, "stale");
    assert.equal(result.nextCheckpoint?.budget.modelCalls, 1);
    assert.equal("reply" in result, false);
  });

  it("abort setelah provider dipanggil gagal tertutup tanpa kandidat", async () => {
    const controller = new AbortController();
    const run = runningRun();
    const executor = executorFor([], () => {
      controller.abort();
      return [toolCall("harvy_final_v1", { reply: "hasil terlambat" })];
    });

    const result = await executor.execute({
      ...executionInput(run),
      signal: controller.signal,
    });

    assert.equal(result.status, "stopped");
    if (result.status !== "stopped") assert.fail("hasil harus cancelled");
    assert.equal(result.code, "cancelled");
    assert.equal(result.nextCheckpoint?.budget.modelCalls, 1);
  });

  it("checkpoint dengan step budget habis menolak sebelum model", async () => {
    const requests: ChatRequest[] = [];
    const run = runningRun();
    const checkpoint = exhaustedCheckpoint(run);
    const executor = executorFor(requests, () => [
      toolCall("harvy_final_v1", { reply: "tidak boleh dipanggil" }),
    ]);

    const result = await executor.execute({
      ...executionInput(run),
      checkpoint,
    });

    assert.equal(result.status, "stopped");
    if (result.status !== "stopped") assert.fail("budget harus menghentikan");
    assert.equal(result.code, "budget_steps");
    assert.equal(result.nextCheckpoint, checkpoint);
    assert.equal(requests.length, 0);
  });

  it("checkpoint digest salah ditolak sebelum provider call", async () => {
    const requests: ChatRequest[] = [];
    const run = runningRun();
    const checkpoint = {
      ...exhaustedCheckpoint(run),
      inputDigest: "0".repeat(64),
    };

    await assert.rejects(
      executorFor(requests, () => []).execute({
        ...executionInput(run),
        checkpoint,
      }),
      GroupAgentRunExecutorInputError,
    );
    assert.equal(requests.length, 0);
  });

  it("thought signature/continuation provider tidak masuk hasil atau checkpoint", async () => {
    const sentinel = "PROVIDER_REASONING_SENTINEL";
    const result = await executorFor([], () => [
      {
        ...toolCall("harvy_final_v1", { reply: "Hasil aman." }),
        extra_content: { google: { thought_signature: sentinel } },
      },
    ]).execute(executionInput(runningRun()));

    assert.equal(result.status, "final");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel, "u"));
  });

  it("meneruskan delivery scope ALS sebagai metadata lokal tanpa masuk prompt", async () => {
    const requests: ChatRequest[] = [];
    const run = runningRun();
    const attempt = activeAttempt(run);
    const deliveryScope = {
      kind: "group_agent_run_attempt" as const,
      runId: run.runId,
      attemptId: attempt.attemptId,
    };
    const result = await withUsageAttribution(
      {
        turnId: "group-run-usage-turn",
        subjectKind: "group",
        channel: "whatsapp",
        actorAliases: [run.initiator.participantId],
        deliveryScope,
      },
      () => executorFor(requests, () => [
        toolCall("harvy_final_v1", { reply: "Hasil aman." }),
      ]).execute(executionInput(run)),
    );

    assert.equal(result.status, "final");
    assert.deepEqual(requests[0]?.usage?.deliveryScope, deliveryScope);
    assert.equal(requests[0]?.usage?.turnId, "group-run-usage-turn");
    const providerMessages = JSON.stringify(requests[0]?.messages);
    assert.doesNotMatch(providerMessages, new RegExp(run.runId, "u"));
    assert.doesNotMatch(providerMessages, new RegExp(attempt.attemptId, "u"));
  });

  it("codec checkpoint menolak unknown key dan question ID tanpa ledger", () => {
    const run = runningRun();
    const checkpoint = exhaustedCheckpoint(run);
    assert.equal(isValidGroupRunExecutionCheckpoint(checkpoint, run), true);
    assert.equal(
      isValidGroupRunExecutionCheckpoint(
        { ...checkpoint, providerResponseId: "provider-secret" },
        run,
      ),
      false,
    );
    assert.equal(
      isValidGroupRunExecutionCheckpoint(
        { ...checkpoint, waitingQuestionId: "question-missing" },
        run,
      ),
      false,
    );
  });
});

function executorFor(
  requests: ChatRequest[],
  response: (request: ChatRequest) => readonly ChatToolCall[],
): GroupAgentRunExecutor {
  const client = {
    completeToolCalls: async (
      request: ChatRequest & { tools: NonNullable<ChatRequest["tools"]> },
    ) => {
      requests.push(request);
      const reservation = request.runBudget?.reserveModelCall({
        tier: request.execution?.tier ?? "efficient",
        budgetClass: request.execution?.budgetClass ?? "work",
        inputTokenEstimate: 64,
        maxOutputTokens: 64,
      });
      reservation?.settle({
        inputTokens: 32,
        outputTokens: 16,
        totalTokens: 48,
        estimated: false,
      });
      return response(request);
    },
  } as Pick<AiClient, "completeToolCalls">;
  return new GroupAgentRunExecutor(client, ROUTING, () => NOW);
}

function executionInput(run: GroupAgentRun) {
  return {
    run,
    attempt: activeAttempt(run),
    checkpoint: null,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

function toolCall(
  name: string,
  input: Record<string, unknown>,
): ChatToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

function exhaustedCheckpoint(run: GroupAgentRun): GroupRunExecutionCheckpoint {
  const budget = new RunBudgetAccount({
    limits: {
      maxTotalTokens: 10_000,
      maxCostUsd: 1,
      maxSteps: 1,
      maxToolCalls: 0,
      maxModelCalls: 1,
      deadlineMs: 45_000,
      compactAtContextRatio: 0.8,
      maxConcurrentWorkers: 1,
    },
  }, () => NOW.getTime());
  budget.reserveModelCall({
    tier: "efficient",
    budgetClass: "final",
    inputTokenEstimate: 1,
    maxOutputTokens: 1,
  }).settle({
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    estimated: false,
  });
  const attempt = activeAttempt(run);
  return {
    version: 1,
    engine: GROUP_AGENT_RUN_EXECUTOR_ENGINE,
    attemptId: attempt.attemptId,
    sequence: 1,
    instructionRevision: attempt.instructionRevision,
    inputDigest: groupRunExecutionInputDigest(
      run,
      attempt.instructionRevision,
    ),
    waitingQuestionId: null,
    budget: budget.checkpoint(),
    updatedAt: NOW.toISOString(),
  };
}

function activeAttempt(run: GroupAgentRun): GroupRunWorkAttempt {
  const attempt = run.workAttempts?.find((candidate) =>
    candidate.status === "running"
  );
  assert.ok(attempt);
  return attempt;
}

function runningRunWithInputs(): GroupAgentRun {
  const question: GroupRunQuestion = {
    questionId: "question-visible",
    prompt: "Kapan kamu tersedia?",
    assignee: participant("member-raw@s.whatsapp.net", "Bima"),
    messageId: "question-message-secret",
    acceptAnswersAfterIngressRevision: 1,
    status: "answered",
    askedAt: "2026-08-14T11:30:00.000Z",
    expiresAt: "2026-08-14T12:30:00.000Z",
    answeredBy: participant("member-raw@s.whatsapp.net", "Bima"),
    answerSourceMessageId: "answer-message-secret",
    answeredAt: "2026-08-14T11:40:00.000Z",
  };
  const inputs: GroupRunInput[] = [
    appliedInput({
      id: "input-1",
      sourceMessageId: "source-secret-1",
      kind: "constraint",
      content: "hindari Jumat pagi",
      instructionRevision: 1,
      actor: participant("member-raw@s.whatsapp.net", "Bima"),
    }),
    {
      ...appliedInput({
        id: "input-proposal",
        sourceMessageId: "source-secret-proposal",
        kind: "constraint",
        content: "PROPOSAL_PRIVATE_SENTINEL",
        instructionRevision: 1,
        actor: participant("proposal-raw@s.whatsapp.net", "Pengusul"),
      }),
      disposition: "proposal",
      instructionRevision: null,
    },
    {
      ...appliedInput({
        id: "input-2",
        sourceMessageId: "answer-message-secret",
        kind: "answer",
        content: "Jumat sore",
        instructionRevision: 2,
        actor: participant("member-raw@s.whatsapp.net", "Bima"),
      }),
      questionId: question.questionId,
    },
  ];
  const run = runningRun();
  return {
    ...run,
    initialRequest: "Susun jadwal rapat kelompok.",
    instructionRevision: 2,
    inputs,
    changeSets: inputs.filter((input) => input.disposition === "applied")
      .map((input) => ({
        instructionRevision: input.instructionRevision!,
        kind: input.kind,
        sourceMessageId: input.sourceMessageId,
        actorParticipantId: input.actor.participantId,
        receivedAt: input.receivedAt,
      })),
    questions: [question],
    workAttempts: [{
      ...activeAttempt(run),
      instructionRevision: 2,
    }],
  };
}

function appliedInput(input: {
  id: string;
  sourceMessageId: string;
  kind: GroupRunInput["kind"];
  content: string;
  instructionRevision: number;
  actor: GroupRunParticipant;
}): GroupRunInput {
  return {
    id: input.id,
    sourceMessageId: input.sourceMessageId,
    sourceIngressRevision: input.instructionRevision,
    actor: input.actor,
    quotedMessageId: "anchor-secret",
    kind: input.kind,
    disposition: "applied",
    content: input.content,
    questionId: null,
    assignedOverride: false,
    authorityRole: "member",
    authorityEpoch: 7,
    instructionRevision: input.instructionRevision,
    receivedAt: `2026-08-14T11:${40 + input.instructionRevision}:00.000Z`,
  };
}

function runningRun(): GroupAgentRun {
  const initiator = participant("initiator-raw@s.whatsapp.net", "Ayu");
  return {
    version: 2,
    runId: "group-run-executor",
    scopeKey: "whatsapp:group-executor@g.us",
    scope: { channel: "whatsapp", groupId: "group-executor@g.us" },
    accountId: "account-secret",
    startSourceMessageId: "start-message-secret",
    initialRequest: "Susun jadwal belajar kelompok minggu ini.",
    title: "Jadwal belajar kelompok",
    initiator,
    startAuthority: { role: "member", authorityEpoch: 7 },
    participants: [initiator],
    audience: {
      kind: "group",
      visibility: "group-safe",
      scopeKey: "whatsapp:group-executor@g.us",
    },
    status: "running",
    phase: "reading_context",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 4,
    anchor: {
      platform: "whatsapp",
      messageId: "anchor-message-secret",
      pinPolicy: "manual-only",
      updatedAt: "2026-08-14T11:50:00.000Z",
    },
    pendingEffect: null,
    receipts: [],
    inputs: [],
    changeSets: [],
    workAttempts: [{
      attemptId: "work-attempt-executor",
      claimKey: "claim-executor",
      attemptNumber: 1,
      instructionRevision: 0,
      claimedStateRevision: 3,
      status: "running",
      startedAt: "2026-08-14T11:59:00.000Z",
      settledAt: null,
      code: null,
    }],
    result: null,
    questions: [],
    events: [{
      id: "event-start",
      type: "run.started",
      at: "2026-08-14T11:00:00.000Z",
      instructionRevision: 0,
      sourceMessageId: "start-message-secret",
      participantId: initiator.participantId,
    }],
    createdAt: "2026-08-14T11:00:00.000Z",
    updatedAt: "2026-08-14T11:59:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-21T11:00:00.000Z",
  };
}

function participant(
  participantId: string,
  displayName: string,
): GroupRunParticipant {
  return { participantId, identityAliases: [], displayName };
}
