import type {
  GroupAgentRunExecutorInput,
  GroupAgentRunExecutorResult,
  GroupAgentRunExecutorStoppedCode,
} from "../ai/group-agent-run-executor.js";
import { isValidGroupRunExecutionCheckpoint } from
  "../ai/group-agent-run-executor.js";
import { withUsageAttribution } from "../ai/usage-attribution.js";
import type {
  GroupAgentRun,
  GroupRunDeliveryPurpose,
  GroupRunDeliveryReceipt,
  GroupRunExecutionCheckpoint,
  GroupRunParticipant,
  GroupRunWorkAttempt,
} from "../domain/group-agent-run.js";
import type {
  GroupAgentRunWorkerFailureCode,
  GroupAgentRunWorkerLease,
  GroupAgentRunWorkerPorts,
} from "./group-agent-run-worker.js";

export interface GroupAgentRunWorkClaim {
  run: GroupAgentRun;
  attempt: GroupRunWorkAttempt;
}

export interface CommitGroupRunProcessorCheckpointInput {
  runId: string;
  attemptId: string;
  expectedStateRevision: number;
  checkpoint: GroupRunExecutionCheckpoint;
}

export interface CommitGroupRunProcessorQuestionInput
  extends CommitGroupRunProcessorCheckpointInput {
  prompt: string;
  assignee: GroupRunParticipant;
}

export interface CommitGroupRunProcessorFinalInput {
  runId: string;
  attemptId: string;
  expectedStateRevision: number;
  reply: string;
}

export interface SettleStoppedGroupRunProcessorInput {
  runId: string;
  attemptId: string;
  expectedStateRevision: number;
  code: GroupAgentRunExecutorStoppedCode;
}

/**
 * Adapter tipis di composition root dapat memetakan kontrak ini ke
 * GroupAgentRunService tanpa memberi executor akses ke repository/transport.
 */
export interface GroupAgentRunWorkProcessorPorts {
  listRunnableRunIds(signal: AbortSignal): Promise<string[]>;
  claimRunnable(runId: string): Promise<GroupAgentRunWorkClaim | null>;
  isAttemptCurrent(
    runId: string,
    attemptId: string,
    stateRevision: number,
  ): Promise<boolean>;
  commitExecutionCheckpoint(
    input: CommitGroupRunProcessorCheckpointInput,
  ): Promise<GroupAgentRun>;
  commitQuestion(
    input: CommitGroupRunProcessorQuestionInput,
  ): Promise<GroupAgentRun>;
  commitFinal(input: CommitGroupRunProcessorFinalInput): Promise<GroupAgentRun>;
  settleStopped(
    input: SettleStoppedGroupRunProcessorInput,
  ): Promise<GroupAgentRun>;
  recoverProcessFailure(
    runId: string,
    code: GroupAgentRunWorkerFailureCode,
  ): Promise<"requeued" | "terminal">;
}

export interface GroupAgentRunWorkExecutorPort {
  execute(
    input: GroupAgentRunExecutorInput,
  ): Promise<GroupAgentRunExecutorResult>;
}

export interface GroupAgentRunWorkUsagePort {
  settleDeliveryScope(
    scope: {
      ownerId: string;
      kind: "group_agent_run_attempt";
      runId: string;
      attemptId: string;
    },
    settlement: {
      outcome: "committed" | "discarded";
      effectId: string | null;
    },
  ): Promise<unknown>;
}

export interface GroupAgentRunWorkProcessorDependencies {
  ports: GroupAgentRunWorkProcessorPorts;
  executor: GroupAgentRunWorkExecutorPort;
  usage: GroupAgentRunWorkUsagePort;
}

export interface GroupAgentRunWorkProcessor extends GroupAgentRunWorkerPorts {}

export class GroupAgentRunWorkProcessorEvidenceError extends Error {
  readonly code = "GROUP_RUN_WORK_EVIDENCE_INVALID" as const;

  constructor() {
    super("Bukti commit GroupAgentRun tidak exact; settlement ditolak.");
    this.name = "GroupAgentRunWorkProcessorEvidenceError";
  }
}

export class GroupAgentRunWorkProcessorAttemptUnavailableError extends Error {
  readonly code:
    | "GROUP_RUN_WORK_ATTEMPT_STALE"
    | "GROUP_RUN_WORK_ATTEMPT_CANCELLED";

  constructor(reason: "stale" | "cancelled") {
    super("Attempt GroupAgentRun tidak lagi memegang lease commit.");
    this.name = "GroupAgentRunWorkProcessorAttemptUnavailableError";
    this.code = reason === "cancelled"
      ? "GROUP_RUN_WORK_ATTEMPT_CANCELLED"
      : "GROUP_RUN_WORK_ATTEMPT_STALE";
  }
}

/**
 * Menghasilkan port worker lengkap. Semua model usage satu attempt dibungkus
 * delivery scope code-owned dan baru diselesaikan setelah bukti durable exact.
 */
export function createGroupAgentRunWorkProcessor(
  dependencies: GroupAgentRunWorkProcessorDependencies,
): GroupAgentRunWorkProcessor {
  const { ports, executor, usage } = dependencies;

  const listRunnableRunIds = async (signal: AbortSignal): Promise<string[]> => {
    if (signal.aborted) return [];
    try {
      const runIds = await ports.listRunnableRunIds(signal);
      return signal.aborted ? [] : [...runIds];
    } catch (error) {
      if (signal.aborted) return [];
      throw error;
    }
  };

  const processRun = async (
    requestedRunId: string,
    signal: AbortSignal,
    lease: GroupAgentRunWorkerLease,
  ): Promise<void> => {
    // Belum ada durable claim, jadi pembatalan di sini tidak meninggalkan work.
    if (signal.aborted || !lease.isCurrent()) return;
    const claim = await ports.claimRunnable(requestedRunId);
    if (!claim) return;
    assertClaim(requestedRunId, claim);

    const { run, attempt } = claim;
    const isCurrentAt = (stateRevision: number): Promise<boolean> =>
      attemptIsCurrent(
        ports,
        run.runId,
        attempt.attemptId,
        stateRevision,
        signal,
        lease,
      );
    if (!await isCurrentAt(run.stateRevision)) {
      throw unavailable(signal, lease);
    }

    const actorAliases = [...new Set([
      run.initiator.participantId,
      ...run.initiator.identityAliases,
    ])];
    const deliveryScope = {
      kind: "group_agent_run_attempt" as const,
      runId: run.runId,
      attemptId: attempt.attemptId,
    };

    await withUsageAttribution(
      {
        turnId: attempt.attemptId,
        subjectKind: "group",
        channel: "whatsapp",
        actorAliases,
        deliveryScope,
      },
      async () => {
        const result = await executor.execute({
          run,
          attempt,
          checkpoint: run.checkpoint ?? null,
          signal,
          isCurrent: () => isCurrentAt(run.stateRevision),
        });
        if (result.status === "stopped") {
          await settleStoppedResult(
            result,
            claim,
            signal,
            lease,
            ports,
            usage,
            deliveryScope,
          );
          return;
        }

        await requireCurrent(
          ports,
          run.runId,
          attempt.attemptId,
          run.stateRevision,
          signal,
          lease,
        );
        const checkpointed = await ports.commitExecutionCheckpoint({
          runId: run.runId,
          attemptId: attempt.attemptId,
          expectedStateRevision: run.stateRevision,
          checkpoint: result.nextCheckpoint,
        });
        const durableCheckpoint = requireDurableCheckpoint(
          checkpointed,
          run,
          attempt,
          result.nextCheckpoint,
        );
        await requireCurrent(
          ports,
          run.runId,
          attempt.attemptId,
          checkpointed.stateRevision,
          signal,
          lease,
        );

        const delivered = result.status === "needs_input"
          ? await ports.commitQuestion({
              runId: run.runId,
              attemptId: attempt.attemptId,
              expectedStateRevision: checkpointed.stateRevision,
              checkpoint: durableCheckpoint,
              prompt: result.prompt,
              assignee: structuredClone(result.assignee),
            })
          : await ports.commitFinal({
              runId: run.runId,
              attemptId: attempt.attemptId,
              expectedStateRevision: checkpointed.stateRevision,
              reply: result.reply,
            });
        const receipt = requireCommittedReceipt(
          delivered,
          checkpointed,
          attempt,
          result.status === "needs_input"
            ? "assigned_question"
            : "final_result",
          result.status === "final" ? result.reply : null,
        );
        await usage.settleDeliveryScope(
          { ownerId: run.scopeKey, ...deliveryScope },
          { outcome: "committed", effectId: receipt.effectId },
        );
      },
    );
  };

  const onProcessFailure = async (
    runId: string,
    code: GroupAgentRunWorkerFailureCode,
  ): Promise<"requeued" | "terminal"> => {
    const outcome = await ports.recoverProcessFailure(runId, code);
    if (outcome !== "requeued" && outcome !== "terminal") {
      throw new GroupAgentRunWorkProcessorEvidenceError();
    }
    return outcome;
  };

  return Object.freeze({
    listRunnableRunIds,
    processRun,
    onProcessFailure,
  });
}

async function settleStoppedResult(
  result: Extract<GroupAgentRunExecutorResult, { status: "stopped" }>,
  claim: GroupAgentRunWorkClaim,
  signal: AbortSignal,
  lease: GroupAgentRunWorkerLease,
  ports: GroupAgentRunWorkProcessorPorts,
  usage: GroupAgentRunWorkUsagePort,
  deliveryScope: {
    kind: "group_agent_run_attempt";
    runId: string;
    attemptId: string;
  },
): Promise<void> {
  const { run, attempt } = claim;
  if (result.code === "stale" || result.code === "cancelled") {
    // Primitive worker akan memanggil recovery; output/checkpoint basi dibuang.
    throw new GroupAgentRunWorkProcessorAttemptUnavailableError(result.code);
  }
  await requireCurrent(
    ports,
    run.runId,
    attempt.attemptId,
    run.stateRevision,
    signal,
    lease,
  );
  let current = run;
  if (result.nextCheckpoint) {
    current = await ports.commitExecutionCheckpoint({
      runId: run.runId,
      attemptId: attempt.attemptId,
      expectedStateRevision: run.stateRevision,
      checkpoint: result.nextCheckpoint,
    });
    requireDurableCheckpoint(current, run, attempt, result.nextCheckpoint);
  }
  await requireCurrent(
    ports,
    run.runId,
    attempt.attemptId,
    current.stateRevision,
    signal,
    lease,
  );
  const settled = await ports.settleStopped({
    runId: run.runId,
    attemptId: attempt.attemptId,
    expectedStateRevision: current.stateRevision,
    code: result.code,
  });
  requireStoppedSettlement(settled, current, attempt);
  await usage.settleDeliveryScope(
    { ownerId: run.scopeKey, ...deliveryScope },
    { outcome: "discarded", effectId: null },
  );
}

async function attemptIsCurrent(
  ports: GroupAgentRunWorkProcessorPorts,
  runId: string,
  attemptId: string,
  stateRevision: number,
  signal: AbortSignal,
  lease: GroupAgentRunWorkerLease,
): Promise<boolean> {
  if (signal.aborted || !lease.isCurrent()) return false;
  try {
    return await ports.isAttemptCurrent(runId, attemptId, stateRevision) ===
        true && !signal.aborted && lease.isCurrent();
  } catch {
    return false;
  }
}

async function requireCurrent(
  ports: GroupAgentRunWorkProcessorPorts,
  runId: string,
  attemptId: string,
  stateRevision: number,
  signal: AbortSignal,
  lease: GroupAgentRunWorkerLease,
): Promise<void> {
  if (
    !await attemptIsCurrent(
      ports,
      runId,
      attemptId,
      stateRevision,
      signal,
      lease,
    )
  ) throw unavailable(signal, lease);
}

function unavailable(
  signal: AbortSignal,
  lease: GroupAgentRunWorkerLease,
): GroupAgentRunWorkProcessorAttemptUnavailableError {
  return new GroupAgentRunWorkProcessorAttemptUnavailableError(
    signal.aborted || !lease.isCurrent() ? "cancelled" : "stale",
  );
}

function assertClaim(
  requestedRunId: string,
  claim: GroupAgentRunWorkClaim,
): void {
  const attempts = claim.run.workAttempts ?? [];
  if (
    claim.run.runId !== requestedRunId || claim.run.scope.channel !== "whatsapp" ||
    claim.run.audience.kind !== "group" ||
    claim.run.audience.visibility !== "group-safe" ||
    claim.run.status !== "running" || claim.run.pendingEffect !== null ||
    claim.attempt.status !== "running" ||
    attempts.at(-1)?.attemptId !== claim.attempt.attemptId ||
    attempts.filter((attempt) => attempt.status === "running").length !== 1 ||
    claim.attempt.instructionRevision !== claim.run.instructionRevision ||
    !Number.isSafeInteger(claim.run.stateRevision) ||
    claim.run.stateRevision < 1
  ) throw new GroupAgentRunWorkProcessorEvidenceError();
}

function requireDurableCheckpoint(
  committed: GroupAgentRun,
  previous: GroupAgentRun,
  attempt: GroupRunWorkAttempt,
  requested: GroupRunExecutionCheckpoint,
): GroupRunExecutionCheckpoint {
  const checkpoint = committed.checkpoint ?? null;
  if (
    committed.runId !== previous.runId ||
    committed.scopeKey !== previous.scopeKey ||
    committed.stateRevision <= previous.stateRevision ||
    committed.pendingEffect !== null || committed.status !== "running" ||
    committed.workAttempts?.at(-1)?.attemptId !== attempt.attemptId ||
    committed.workAttempts?.at(-1)?.status !== "running" ||
    !checkpoint || !isValidGroupRunExecutionCheckpoint(checkpoint, committed) ||
    checkpoint.attemptId !== requested.attemptId ||
    checkpoint.sequence !== requested.sequence ||
    checkpoint.instructionRevision !== requested.instructionRevision ||
    checkpoint.inputDigest !== requested.inputDigest ||
    checkpoint.waitingQuestionId !== null ||
    JSON.stringify(checkpoint.budget) !== JSON.stringify(requested.budget)
  ) throw new GroupAgentRunWorkProcessorEvidenceError();
  return structuredClone(checkpoint);
}

function requireCommittedReceipt(
  delivered: GroupAgentRun,
  checkpointed: GroupAgentRun,
  attempt: GroupRunWorkAttempt,
  purpose: Extract<
    GroupRunDeliveryPurpose,
    "assigned_question" | "final_result"
  >,
  finalReply: string | null,
): GroupRunDeliveryReceipt {
  const matches = delivered.receipts.filter((receipt) =>
    receipt.status === "committed" && receipt.purpose === purpose &&
    receipt.workAttemptId === attempt.attemptId
  );
  const receipt = matches.length === 1 ? matches[0] : null;
  if (
    delivered.runId !== checkpointed.runId ||
    delivered.scopeKey !== checkpointed.scopeKey ||
    delivered.stateRevision <= checkpointed.stateRevision ||
    delivered.pendingEffect !== null || !receipt ||
    receipt.effect !== "whatsapp.message.send" ||
    receipt.preparedStateRevision !== checkpointed.stateRevision ||
    receipt.instructionRevision !== attempt.instructionRevision ||
    !safeKey(receipt.effectId) || !safeKey(receipt.externalMessageId)
  ) throw new GroupAgentRunWorkProcessorEvidenceError();

  if (purpose === "final_result") {
    const result = delivered.result ?? null;
    const settledAttempt = delivered.workAttempts?.find((candidate) =>
      candidate.attemptId === attempt.attemptId
    );
    if (
      delivered.status !== "completed" || receipt.subjectId !== attempt.attemptId ||
      settledAttempt?.status !== "completed" || !settledAttempt.settledAt ||
      !result || result.kind !== "final" || result.text !== finalReply ||
      result.attemptId !== attempt.attemptId ||
      result.instructionRevision !== attempt.instructionRevision ||
      result.messageId !== receipt.externalMessageId ||
      result.contentDigest !== receipt.contentDigest ||
      result.committedAt !== receipt.committedAt
    ) throw new GroupAgentRunWorkProcessorEvidenceError();
    return receipt;
  }

  const question = delivered.questions.find((candidate) =>
    candidate.questionId === receipt.subjectId
  );
  const settledAttempt = delivered.workAttempts?.find((candidate) =>
    candidate.attemptId === attempt.attemptId
  );
  if (
    delivered.status !== "waiting_input" || !question ||
    question.status !== "open" ||
    question.messageId !== receipt.externalMessageId ||
    delivered.checkpoint?.waitingQuestionId !== question.questionId ||
    settledAttempt?.status !== "requeued" ||
    settledAttempt.code !== "waiting_input" || !settledAttempt.settledAt
  ) throw new GroupAgentRunWorkProcessorEvidenceError();
  return receipt;
}

function requireStoppedSettlement(
  settled: GroupAgentRun,
  previous: GroupAgentRun,
  attempt: GroupRunWorkAttempt,
): void {
  const settledAttempt = settled.workAttempts?.find((candidate) =>
    candidate.attemptId === attempt.attemptId
  );
  if (
    settled.runId !== previous.runId || settled.scopeKey !== previous.scopeKey ||
    settled.stateRevision <= previous.stateRevision ||
    settled.pendingEffect !== null || !settledAttempt?.settledAt ||
    settledAttempt.status === "running" ||
    settledAttempt.status === "completed"
  ) throw new GroupAgentRunWorkProcessorEvidenceError();
}

function safeKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
