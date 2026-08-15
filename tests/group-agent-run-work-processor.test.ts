import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  GroupAgentRunExecutorInput,
  GroupAgentRunExecutorResult,
} from "../src/ai/group-agent-run-executor.js";
import { GROUP_AGENT_RUN_EXECUTOR_ENGINE } from
  "../src/ai/group-agent-run-executor.js";
import { currentUsageAttribution } from
  "../src/ai/usage-attribution.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import {
  createGroupAgentRunWorkProcessor,
  GroupAgentRunWorkProcessorAttemptUnavailableError,
  GroupAgentRunWorkProcessorEvidenceError,
  type CommitGroupRunProcessorCheckpointInput,
  type CommitGroupRunProcessorFinalInput,
  type CommitGroupRunProcessorQuestionInput,
  type GroupAgentRunWorkProcessorPorts,
  type SettleStoppedGroupRunProcessorInput,
} from "../src/core/group-agent-run-work-processor.js";
import type { GroupAgentRunWorkerLease } from
  "../src/core/group-agent-run-worker.js";
import type {
  GroupAgentRun,
  GroupRunDeliveryReceipt,
  GroupRunExecutionCheckpoint,
  GroupRunParticipant,
  GroupRunWorkAttempt,
} from "../src/domain/group-agent-run.js";
import { groupRunExecutionInputDigest } from
  "../src/domain/group-agent-run.js";

const NOW = new Date("2026-08-15T01:00:00.000Z");
const CHECKPOINT_AT = "2026-08-15T01:00:01.000Z";
const DELIVERY_AT = "2026-08-15T01:00:02.000Z";

describe("GroupAgentRun work processor", () => {
  it("final: checkpoint dahulu, receipt exact, lalu entitlement committed", async () => {
    const runtime = makeRuntime((input) => ({
      status: "final",
      reply: "Jadwal final grup.",
      nextCheckpoint: nextCheckpoint(input.run, input.attempt),
    }));

    await runtime.processor.processRun(
      runtime.initial.runId,
      new AbortController().signal,
      CURRENT_LEASE,
    );

    assert.deepEqual(runtime.calls.order, [
      "claim",
      "checkpoint",
      "final",
      "usage:committed",
    ]);
    assert.equal(runtime.calls.checkpoints.length, 1);
    assert.equal(runtime.calls.finals.length, 1);
    assert.equal(
      runtime.calls.finals[0]?.expectedStateRevision,
      runtime.initial.stateRevision + 1,
    );
    assert.deepEqual(runtime.calls.attributions[0], {
      turnId: activeAttempt(runtime.initial).attemptId,
      subjectKind: "group",
      channel: "whatsapp",
      actorAliases: ["pn:ayu", "lid:ayu"],
      deliveryScope: {
        kind: "group_agent_run_attempt",
        runId: runtime.initial.runId,
        attemptId: activeAttempt(runtime.initial).attemptId,
      },
    });
    assert.deepEqual(runtime.calls.usage, [{
      scope: {
        ownerId: runtime.initial.scopeKey,
        kind: "group_agent_run_attempt",
        runId: runtime.initial.runId,
        attemptId: activeAttempt(runtime.initial).attemptId,
      },
      settlement: { outcome: "committed", effectId: "effect-final" },
    }]);
  });

  it("need_input mengikat checkpoint durable ke question receipt exact", async () => {
    const runtime = makeRuntime((input) => ({
      status: "needs_input",
      prompt: "Apakah Sabtu sore cocok?",
      assignee: structuredClone(input.run.initiator),
      nextCheckpoint: nextCheckpoint(input.run, input.attempt),
    }));

    await runtime.processor.processRun(
      runtime.initial.runId,
      new AbortController().signal,
      CURRENT_LEASE,
    );

    assert.deepEqual(runtime.calls.order, [
      "claim",
      "checkpoint",
      "question",
      "usage:committed",
    ]);
    assert.equal(runtime.calls.questions.length, 1);
    assert.equal(
      runtime.calls.questions[0]?.checkpoint.updatedAt,
      CHECKPOINT_AT,
    );
    assert.deepEqual(runtime.calls.questions[0]?.assignee, {
      participantId: "pn:ayu",
      identityAliases: ["lid:ayu"],
      displayName: "Ayu",
    });
    assert.equal(runtime.calls.usage[0]?.settlement.effectId, "effect-question");
  });

  it("stale sebelum model tidak memanggil executor atau commit", async () => {
    const runtime = makeRuntime(() => {
      assert.fail("executor tidak boleh dipanggil");
    });
    runtime.current = false;

    await assert.rejects(
      runtime.processor.processRun(
        runtime.initial.runId,
        new AbortController().signal,
        CURRENT_LEASE,
      ),
      GroupAgentRunWorkProcessorAttemptUnavailableError,
    );

    assert.equal(runtime.calls.executions, 0);
    assert.deepEqual(runtime.calls.checkpoints, []);
    assert.deepEqual(runtime.calls.questions, []);
    assert.deepEqual(runtime.calls.finals, []);
    assert.deepEqual(runtime.calls.stopped, []);
    assert.deepEqual(runtime.calls.usage, []);
    assert.equal(
      await runtime.processor.onProcessFailure(
        runtime.initial.runId,
        "GROUP_RUN_WORKER_PROCESS_FAILED",
      ),
      "requeued",
    );
    assert.equal(activeAttemptStatus(runtime.state()), "requeued");
  });

  it("cancel/correction setelah claim tidak mengomit output dan recovery mencegah orphan", async () => {
    for (const reason of ["cancelled", "stale"] as const) {
      const controller = new AbortController();
      const runtime = makeRuntime((input) => {
        if (reason === "cancelled") controller.abort();
        return {
          status: "stopped",
          code: reason,
          nextCheckpoint: nextCheckpoint(input.run, input.attempt),
        };
      });

      await assert.rejects(
        runtime.processor.processRun(
          runtime.initial.runId,
          controller.signal,
          CURRENT_LEASE,
        ),
        (error: unknown) =>
          error instanceof GroupAgentRunWorkProcessorAttemptUnavailableError &&
          error.code === (reason === "cancelled"
            ? "GROUP_RUN_WORK_ATTEMPT_CANCELLED"
            : "GROUP_RUN_WORK_ATTEMPT_STALE"),
      );
      assert.deepEqual(runtime.calls.checkpoints, []);
      assert.deepEqual(runtime.calls.questions, []);
      assert.deepEqual(runtime.calls.finals, []);
      assert.deepEqual(runtime.calls.stopped, []);
      assert.deepEqual(runtime.calls.usage, []);

      await runtime.processor.onProcessFailure(
        runtime.initial.runId,
        "GROUP_RUN_WORKER_PROCESS_FAILED",
      );
      assert.equal(activeAttemptStatus(runtime.state()), "requeued");
    }
  });

  it("stopped non-stale mempersist budget, settle durable, lalu discard usage", async () => {
    const runtime = makeRuntime((input) => ({
      status: "stopped",
      code: "invalid_model_output",
      nextCheckpoint: nextCheckpoint(input.run, input.attempt),
    }));

    await runtime.processor.processRun(
      runtime.initial.runId,
      new AbortController().signal,
      CURRENT_LEASE,
    );

    assert.deepEqual(runtime.calls.order, [
      "claim",
      "checkpoint",
      "stopped",
      "usage:discarded",
    ]);
    assert.equal(runtime.calls.stopped[0]?.code, "invalid_model_output");
    assert.deepEqual(runtime.calls.usage[0]?.settlement, {
      outcome: "discarded",
      effectId: null,
    });
    assert.equal(activeAttemptStatus(runtime.state()), "failed");
  });

  it("delivery throw membiarkan usage pending dan recovery membaca state durable", async () => {
    const runtime = makeRuntime((input) => ({
      status: "final",
      reply: "Tidak boleh hilang.",
      nextCheckpoint: nextCheckpoint(input.run, input.attempt),
    }), { finalThrowsAfterUnknown: true });
    runtime.pendingUsage = true;

    await assert.rejects(
      runtime.processor.processRun(
        runtime.initial.runId,
        new AbortController().signal,
        CURRENT_LEASE,
      ),
      /transport ambigu/u,
    );
    assert.equal(runtime.pendingUsage, true);
    assert.deepEqual(runtime.calls.usage, []);
    assert.equal(activeAttemptStatus(runtime.state()), "failed");
    assert.equal(
      await runtime.processor.onProcessFailure(
        runtime.initial.runId,
        "GROUP_RUN_WORKER_PROCESS_FAILED",
      ),
      "terminal",
    );
    assert.equal(runtime.calls.recoveries.length, 1);
  });

  it("receipt dengan workAttempt/effect tidak exact gagal tertutup", async () => {
    for (const mismatch of ["attempt", "effect"] as const) {
      const runtime = makeRuntime((input) => ({
        status: "final",
        reply: "Hasil dengan bukti rusak.",
        nextCheckpoint: nextCheckpoint(input.run, input.attempt),
      }), { receiptMismatch: mismatch });
      runtime.pendingUsage = true;

      await assert.rejects(
        runtime.processor.processRun(
          runtime.initial.runId,
          new AbortController().signal,
          CURRENT_LEASE,
        ),
        GroupAgentRunWorkProcessorEvidenceError,
      );
      assert.equal(runtime.pendingUsage, true);
      assert.deepEqual(runtime.calls.usage, []);
    }
  });

  it("list runnable gagal tertutup ketika abort sebelum atau selama scan", async () => {
    let listCalls = 0;
    let release!: (runIds: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const runtime = makeRuntime(() => assert.fail("tidak relevan"), {
      list: () => {
        listCalls += 1;
        return pending;
      },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    assert.deepEqual(
      await runtime.processor.listRunnableRunIds(alreadyAborted.signal),
      [],
    );
    assert.equal(listCalls, 0);

    const during = new AbortController();
    const scan = runtime.processor.listRunnableRunIds(during.signal);
    during.abort();
    release([runtime.initial.runId]);
    assert.deepEqual(await scan, []);
    assert.equal(listCalls, 1);
  });
});

const CURRENT_LEASE: GroupAgentRunWorkerLease = Object.freeze({
  isCurrent: () => true,
});

interface RuntimeOptions {
  finalThrowsAfterUnknown?: boolean;
  receiptMismatch?: "attempt" | "effect";
  list?: (signal: AbortSignal) => Promise<string[]>;
}

function makeRuntime(
  decision: (
    input: GroupAgentRunExecutorInput,
  ) => GroupAgentRunExecutorResult | Promise<GroupAgentRunExecutorResult>,
  options: RuntimeOptions = {},
) {
  const initial = runningRun();
  let state = structuredClone(initial);
  const calls = {
    order: [] as string[],
    executions: 0,
    attributions: [] as unknown[],
    checkpoints: [] as CommitGroupRunProcessorCheckpointInput[],
    questions: [] as CommitGroupRunProcessorQuestionInput[],
    finals: [] as CommitGroupRunProcessorFinalInput[],
    stopped: [] as SettleStoppedGroupRunProcessorInput[],
    recoveries: [] as Array<{ runId: string; code: string }>,
    usage: [] as Array<{
      scope: {
        ownerId: string;
        kind: "group_agent_run_attempt";
        runId: string;
        attemptId: string;
      };
      settlement: {
        outcome: "committed" | "discarded";
        effectId: string | null;
      };
    }>,
  };
  const runtime = {
    current: true,
    pendingUsage: false,
  };

  const ports: GroupAgentRunWorkProcessorPorts = {
    listRunnableRunIds: options.list ?? (async () => [initial.runId]),
    claimRunnable: async (runId) => {
      calls.order.push("claim");
      if (runId !== state.runId || activeAttemptStatus(state) !== "running") {
        return null;
      }
      return {
        run: structuredClone(state),
        attempt: structuredClone(activeAttempt(state)),
      };
    },
    isAttemptCurrent: async (runId, attemptId, stateRevision) =>
      runtime.current && runId === state.runId &&
      attemptId === activeAttempt(state).attemptId &&
      stateRevision === state.stateRevision &&
      activeAttemptStatus(state) === "running",
    commitExecutionCheckpoint: async (input) => {
      calls.order.push("checkpoint");
      calls.checkpoints.push(structuredClone(input));
      assertCurrentInput(state, input);
      state = {
        ...state,
        stateRevision: state.stateRevision + 1,
        checkpoint: { ...structuredClone(input.checkpoint), updatedAt: CHECKPOINT_AT },
        updatedAt: CHECKPOINT_AT,
      };
      return structuredClone(state);
    },
    commitQuestion: async (input) => {
      calls.order.push("question");
      calls.questions.push(structuredClone(input));
      assertCurrentInput(state, input);
      state = committedQuestion(state, input);
      return structuredClone(state);
    },
    commitFinal: async (input) => {
      calls.order.push("final");
      calls.finals.push(structuredClone(input));
      assertCurrentInput(state, input);
      if (options.finalThrowsAfterUnknown) {
        state = unknownFinal(state, input);
        throw new Error("transport ambigu");
      }
      state = committedFinal(state, input, options.receiptMismatch);
      return structuredClone(state);
    },
    settleStopped: async (input) => {
      calls.order.push("stopped");
      calls.stopped.push(structuredClone(input));
      assertCurrentInput(state, input);
      state = {
        ...state,
        status: "failed",
        phase: "failed",
        stateRevision: state.stateRevision + 1,
        workAttempts: (state.workAttempts ?? []).map((attempt) =>
          attempt.attemptId === input.attemptId
            ? {
                ...attempt,
                status: "failed" as const,
                settledAt: DELIVERY_AT,
                code: input.code,
              }
            : attempt
        ),
        updatedAt: DELIVERY_AT,
      };
      return structuredClone(state);
    },
    recoverProcessFailure: async (runId, code) => {
      calls.recoveries.push({ runId, code });
      const running = state.workAttempts?.find((attempt) =>
        attempt.status === "running"
      );
      if (!running) return "terminal";
      state = {
        ...state,
        status: "queued",
        phase: "queued",
        stateRevision: state.stateRevision + 1,
        workAttempts: (state.workAttempts ?? []).map((attempt) =>
          attempt.attemptId === running.attemptId
            ? {
                ...attempt,
                status: "requeued" as const,
                settledAt: DELIVERY_AT,
                code,
              }
            : attempt
        ),
      };
      return "requeued";
    },
  };

  const processor = createGroupAgentRunWorkProcessor({
    ports,
    executor: {
      execute: async (input) => {
        calls.executions += 1;
        calls.attributions.push(structuredClone(currentUsageAttribution()));
        assert.equal(await input.isCurrent(), true);
        return decision(input);
      },
    },
    usage: {
      settleDeliveryScope: async (scope, settlement) => {
        calls.order.push(`usage:${settlement.outcome}`);
        calls.usage.push({
          scope: structuredClone(scope),
          settlement: structuredClone(settlement),
        });
        runtime.pendingUsage = false;
      },
    },
  });

  return {
    initial,
    processor,
    calls,
    state: () => structuredClone(state),
    get current() {
      return runtime.current;
    },
    set current(value: boolean) {
      runtime.current = value;
    },
    get pendingUsage() {
      return runtime.pendingUsage;
    },
    set pendingUsage(value: boolean) {
      runtime.pendingUsage = value;
    },
  };
}

function assertCurrentInput(
  state: GroupAgentRun,
  input: { runId: string; attemptId: string; expectedStateRevision: number },
): void {
  assert.equal(input.runId, state.runId);
  assert.equal(input.attemptId, activeAttempt(state).attemptId);
  assert.equal(input.expectedStateRevision, state.stateRevision);
}

function committedFinal(
  state: GroupAgentRun,
  input: CommitGroupRunProcessorFinalInput,
  mismatch: RuntimeOptions["receiptMismatch"],
): GroupAgentRun {
  const attempt = activeAttempt(state);
  const workAttemptId = mismatch === "attempt"
    ? "work-attempt-lain"
    : attempt.attemptId;
  const receipt = deliveryReceipt({
    effectId: "effect-final",
    purpose: "final_result",
    preparedStateRevision: input.expectedStateRevision,
    instructionRevision: attempt.instructionRevision,
    subjectId: attempt.attemptId,
    workAttemptId,
  });
  if (mismatch === "effect") {
    (receipt as { effect: string }).effect = "email.send";
  }
  return {
    ...state,
    status: "completed",
    phase: "completed",
    stateRevision: state.stateRevision + 1,
    receipts: [...state.receipts, receipt],
    workAttempts: (state.workAttempts ?? []).map((candidate) =>
      candidate.attemptId === attempt.attemptId
        ? {
            ...candidate,
            status: "completed" as const,
            settledAt: DELIVERY_AT,
            code: null,
          }
        : candidate
    ),
    result: {
      kind: "final",
      text: input.reply,
      contentDigest: receipt.contentDigest,
      instructionRevision: attempt.instructionRevision,
      attemptId: attempt.attemptId,
      messageId: receipt.externalMessageId!,
      committedAt: receipt.committedAt,
    },
    completedAt: DELIVERY_AT,
    updatedAt: DELIVERY_AT,
  };
}

function committedQuestion(
  state: GroupAgentRun,
  input: CommitGroupRunProcessorQuestionInput,
): GroupAgentRun {
  const attempt = activeAttempt(state);
  const questionId = "question-committed";
  const receipt = deliveryReceipt({
    effectId: "effect-question",
    purpose: "assigned_question",
    preparedStateRevision: input.expectedStateRevision,
    instructionRevision: attempt.instructionRevision,
    subjectId: questionId,
    workAttemptId: attempt.attemptId,
  });
  return {
    ...state,
    status: "waiting_input",
    phase: "waiting_input",
    stateRevision: state.stateRevision + 1,
    checkpoint: { ...structuredClone(input.checkpoint), waitingQuestionId: questionId },
    receipts: [...state.receipts, receipt],
    questions: [...state.questions, {
      questionId,
      prompt: input.prompt,
      assignee: structuredClone(input.assignee),
      messageId: receipt.externalMessageId!,
      acceptAnswersAfterIngressRevision: 7,
      status: "open",
      askedAt: DELIVERY_AT,
      expiresAt: "2026-08-15T01:10:00.000Z",
      answeredBy: null,
      answerSourceMessageId: null,
      answeredAt: null,
    }],
    workAttempts: (state.workAttempts ?? []).map((candidate) =>
      candidate.attemptId === attempt.attemptId
        ? {
            ...candidate,
            status: "requeued" as const,
            settledAt: DELIVERY_AT,
            code: "waiting_input",
          }
        : candidate
    ),
    updatedAt: DELIVERY_AT,
  };
}

function unknownFinal(
  state: GroupAgentRun,
  input: CommitGroupRunProcessorFinalInput,
): GroupAgentRun {
  const attempt = activeAttempt(state);
  return {
    ...state,
    status: "partial",
    phase: "failed",
    stateRevision: state.stateRevision + 1,
    receipts: [...state.receipts, {
      ...deliveryReceipt({
        effectId: "effect-unknown",
        purpose: "final_result",
        preparedStateRevision: input.expectedStateRevision,
        instructionRevision: attempt.instructionRevision,
        subjectId: attempt.attemptId,
        workAttemptId: attempt.attemptId,
      }),
      status: "unknown",
      externalMessageId: null,
    }],
    workAttempts: (state.workAttempts ?? []).map((candidate) =>
      candidate.attemptId === attempt.attemptId
        ? {
            ...candidate,
            status: "failed" as const,
            settledAt: DELIVERY_AT,
            code: "delivery_outcome_unknown",
          }
        : candidate
    ),
    updatedAt: DELIVERY_AT,
  };
}

function deliveryReceipt(input: {
  effectId: string;
  purpose: "assigned_question" | "final_result";
  preparedStateRevision: number;
  instructionRevision: number;
  subjectId: string;
  workAttemptId: string;
}): GroupRunDeliveryReceipt {
  return {
    receiptId: `receipt-${input.effectId}`,
    effectId: input.effectId,
    effect: "whatsapp.message.send",
    purpose: input.purpose,
    instructionRevision: input.instructionRevision,
    preparedStateRevision: input.preparedStateRevision,
    contentDigest: "a".repeat(64),
    subjectId: input.subjectId,
    workAttemptId: input.workAttemptId,
    authority: {
      initiatorRole: "member",
      assigneeRole: input.purpose === "assigned_question" ? "member" : null,
      authorityEpoch: 3,
    },
    status: "committed",
    externalMessageId: `message-${input.effectId}`,
    committedAt: DELIVERY_AT,
    reversible: false,
  };
}

function nextCheckpoint(
  run: GroupAgentRun,
  attempt: GroupRunWorkAttempt,
): GroupRunExecutionCheckpoint {
  const budget = new RunBudgetAccount({}, () => NOW.getTime());
  budget.reserveModelCall({
    tier: "efficient",
    budgetClass: "final",
    inputTokenEstimate: 10,
    maxOutputTokens: 10,
  }).settle({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    estimated: false,
  });
  return {
    version: 1,
    engine: GROUP_AGENT_RUN_EXECUTOR_ENGINE,
    attemptId: attempt.attemptId,
    sequence: 1,
    instructionRevision: attempt.instructionRevision,
    inputDigest: groupRunExecutionInputDigest(run, attempt.instructionRevision),
    waitingQuestionId: null,
    budget: budget.checkpoint(),
    updatedAt: NOW.toISOString(),
  };
}

function activeAttempt(run: GroupAgentRun): GroupRunWorkAttempt {
  const attempt = run.workAttempts?.at(-1);
  assert.ok(attempt);
  return attempt;
}

function activeAttemptStatus(run: GroupAgentRun): GroupRunWorkAttempt["status"] {
  return activeAttempt(run).status;
}

function participant(): GroupRunParticipant {
  return {
    participantId: "pn:ayu",
    identityAliases: ["lid:ayu"],
    displayName: "Ayu",
  };
}

function runningRun(): GroupAgentRun {
  const initiator = participant();
  return {
    version: 2,
    runId: "group-run-processor",
    scopeKey: "whatsapp:processor@g.us",
    scope: { channel: "whatsapp", groupId: "processor@g.us" },
    accountId: "account-processor",
    startSourceMessageId: "start-message",
    initialRequest: "Susun jadwal belajar grup.",
    title: "Jadwal belajar",
    initiator,
    startAuthority: { role: "member", authorityEpoch: 3 },
    participants: [initiator],
    audience: {
      kind: "group",
      visibility: "group-safe",
      scopeKey: "whatsapp:processor@g.us",
    },
    status: "running",
    phase: "reading_context",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 5,
    anchor: {
      platform: "whatsapp",
      messageId: "anchor-message",
      pinPolicy: "manual-only",
      updatedAt: "2026-08-15T00:58:00.000Z",
    },
    pendingEffect: null,
    receipts: [],
    inputs: [],
    changeSets: [],
    workAttempts: [{
      attemptId: "work-attempt-processor",
      claimKey: "claim-processor",
      attemptNumber: 1,
      instructionRevision: 0,
      claimedStateRevision: 4,
      status: "running",
      startedAt: "2026-08-15T00:59:00.000Z",
      settledAt: null,
      code: null,
    }],
    checkpoint: null,
    result: null,
    questions: [],
    events: [],
    createdAt: "2026-08-15T00:50:00.000Z",
    updatedAt: "2026-08-15T00:59:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-22T00:50:00.000Z",
  };
}
