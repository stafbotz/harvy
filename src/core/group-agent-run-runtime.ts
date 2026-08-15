import { createHash } from "node:crypto";
import type {
  GroupAgentRun,
  GroupAgentRunRepository,
  GroupRunWorkAttempt,
} from "../domain/group-agent-run.js";
import { isTerminalGroupAgentRunStatus } from
  "../domain/group-agent-run.js";
import {
  GroupAgentRunAuthorityError,
  GroupAgentRunConflictError,
  GroupAgentRunRuntimeAdmissionError,
  GroupAgentRunWorkAttemptLimitError,
  type GroupAgentRunRuntimeAdmissionResolver,
  type GroupAgentRunService,
  type GroupRunDelivery,
  type GroupRunDeliveryAuthorityExpectation,
  type GroupRunQuestionDelivery,
} from "./group-agent-run-service.js";
import type {
  GroupAgentRunWorkProcessorPorts,
  SettleStoppedGroupRunProcessorInput,
} from "./group-agent-run-work-processor.js";

type RuntimeService = Pick<
  GroupAgentRunService,
  | "claimWorkAttempt"
  | "commitExecutionCheckpoint"
  | "commitAssignedQuestion"
  | "commitFinalResult"
  | "failWorkAttempt"
  | "requeueWorkAttempt"
>;

export interface GroupAgentRunRuntimeTransport {
  sendGroupRunMessage(
    target: { scope: GroupAgentRun["scope"]; accountId: string },
    text: string,
    quoteMessageId: string | undefined,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: () => Promise<boolean>,
  ): Promise<GroupRunDelivery>;
}

export interface GroupAgentRunIngressWatermark {
  currentIngressRevision(scopeKey: string, accountId: string): number;
}

export interface GroupAgentRunRuntimeDependencies {
  repository: GroupAgentRunRepository;
  service: RuntimeService;
  transport: GroupAgentRunRuntimeTransport;
  watermark: GroupAgentRunIngressWatermark;
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver;
}

/**
 * Adapter composition untuk primitive work processor. Model/executor hanya
 * melihat aggregate group-safe; repository, authority, transport, dan commit
 * barrier tetap berada di port code-owned ini.
 */
export function createGroupAgentRunRuntimePorts(
  dependencies: GroupAgentRunRuntimeDependencies,
): GroupAgentRunWorkProcessorPorts {
  const {
    repository,
    service,
    transport,
    watermark,
    runtimeAdmission,
  } = dependencies;

  const runtimeFence = (
    run: Pick<GroupAgentRun, "scopeKey" | "accountId">,
  ): (() => Promise<boolean>) => async () => {
    try {
      return await runtimeAdmission({
        scopeKey: run.scopeKey,
        accountId: run.accountId,
      }) === true;
    } catch {
      return false;
    }
  };

  const deliveryRun = async (
    runId: string,
    expectedStateRevision: number,
  ): Promise<GroupAgentRun> => {
    const run = await repository.load(runId);
    if (!run || run.stateRevision !== expectedStateRevision) {
      throw new GroupAgentRunConflictError();
    }
    return run;
  };

  const ports: GroupAgentRunWorkProcessorPorts = {
    async listRunnableRunIds(signal: AbortSignal): Promise<string[]> {
      if (signal.aborted) return [];
      const active = await repository.listActive();
      if (signal.aborted) return [];
      return active.filter(isRunnable).map((run) => run.runId);
    },

    async claimRunnable(runId) {
      const run = await repository.load(runId);
      if (!run || !isRunnable(run)) return null;
      try {
        const claimed = await service.claimWorkAttempt({
          runId: run.runId,
          expectedStateRevision: run.stateRevision,
          claimKey: workClaimKey(run),
        });
        return {
          run: claimed.run,
          attempt: claimed.attempt,
        };
      } catch (error) {
        if (isExpectedClaimRejection(error)) return null;
        throw error;
      }
    },

    async isAttemptCurrent(runId, attemptId, stateRevision) {
      const run = await repository.load(runId);
      return Boolean(
        run && run.stateRevision === stateRevision &&
          run.status === "running" && run.pendingEffect === null &&
          activeAttempt(run)?.attemptId === attemptId &&
          activeAttempt(run)?.status === "running",
      );
    },

    commitExecutionCheckpoint: (input) =>
      service.commitExecutionCheckpoint(input),

    async commitQuestion(input) {
      const run = await deliveryRun(input.runId, input.expectedStateRevision);
      return service.commitAssignedQuestion(input, async (request) => {
        const delivery = await transport.sendGroupRunMessage(
          { scope: structuredClone(run.scope), accountId: run.accountId },
          request.content,
          request.quoteMessageId ?? undefined,
          request.effectId,
          request.authorityExpectation,
          runtimeFence(run),
        );
        const revision = watermark.currentIngressRevision(
          run.scopeKey,
          run.accountId,
        );
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new Error("Watermark ingress GroupAgentRun tidak sah.");
        }
        return {
          ...delivery,
          acceptAnswersAfterIngressRevision: revision,
        } satisfies GroupRunQuestionDelivery;
      });
    },

    async commitFinal(input) {
      const run = await deliveryRun(input.runId, input.expectedStateRevision);
      return service.commitFinalResult(input, (request) =>
        transport.sendGroupRunMessage(
          { scope: structuredClone(run.scope), accountId: run.accountId },
          request.content,
          request.quoteMessageId ?? undefined,
          request.effectId,
          request.authorityExpectation,
          runtimeFence(run),
        ));
    },

    async settleStopped(input: SettleStoppedGroupRunProcessorInput) {
      const settled = await service.failWorkAttempt({
        runId: input.runId,
        expectedStateRevision: input.expectedStateRevision,
        attemptId: input.attemptId,
        code: input.code,
      });
      return settled.run;
    },

    async recoverProcessFailure(runId, code) {
      const run = await repository.load(runId);
      if (!run || isTerminalGroupAgentRunStatus(run.status)) return "terminal";
      const attempt = activeAttempt(run);
      if (!attempt || attempt.status !== "running") {
        return run.status === "queued" || run.status === "paused"
          ? "requeued"
          : "terminal";
      }
      try {
        const settled = await service.requeueWorkAttempt({
          runId,
          expectedStateRevision: run.stateRevision,
          attemptId: attempt.attemptId,
          code,
        });
        return settled.run.status === "queued" ? "requeued" : "terminal";
      } catch (error) {
        if (!(error instanceof GroupAgentRunConflictError)) throw error;
        const latest = await repository.load(runId);
        if (!latest || isTerminalGroupAgentRunStatus(latest.status)) {
          return "terminal";
        }
        return latest.status === "queued" || latest.status === "paused"
          ? "requeued"
          : "terminal";
      }
    },
  };
  return Object.freeze(ports);
}

function isRunnable(run: GroupAgentRun): boolean {
  return (
    (run.status === "queued" || run.status === "paused") &&
    run.anchor.messageId !== null && run.pendingEffect === null &&
    !run.questions.some((question) => question.status === "open") &&
    !run.workAttempts?.some((attempt) => attempt.status === "running")
  );
}

function activeAttempt(run: GroupAgentRun): GroupRunWorkAttempt | null {
  const running = (run.workAttempts ?? []).filter(
    (attempt) => attempt.status === "running",
  );
  return running.length === 1 ? running[0]! : null;
}

function workClaimKey(run: GroupAgentRun): string {
  const digest = createHash("sha256")
    .update(run.runId, "utf8")
    .update("\u0000", "utf8")
    .update(String(run.stateRevision), "utf8")
    .update("\u0000", "utf8")
    .update(String(run.instructionRevision), "utf8")
    .update("\u0000", "utf8")
    .update(String(run.workAttempts?.length ?? 0), "utf8")
    .digest("hex");
  return `group-run-claim-${digest}`;
}

function isExpectedClaimRejection(error: unknown): boolean {
  return error instanceof GroupAgentRunConflictError ||
    error instanceof GroupAgentRunAuthorityError ||
    error instanceof GroupAgentRunRuntimeAdmissionError ||
    error instanceof GroupAgentRunWorkAttemptLimitError;
}
