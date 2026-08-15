import { createHash, randomUUID } from "node:crypto";
import {
  decideGroupRunInput,
  groupRunTarget,
  type GroupRunPolicyDecision,
} from "./group-agent-run-policy.js";
import {
  DENY_GROUP_AUTHORITY_RESOLVER,
  groupAuthorityAllows,
  type GroupAuthorityResolver,
  type GroupAuthoritySnapshot,
} from "./group-authority-policy.js";
import type {
  GroupAgentRun,
  GroupAgentRunRepository,
  GroupRunDeliveryPurpose,
  GroupRunInput,
  GroupRunParticipant,
  GroupRunExecutionCheckpoint,
  GroupRunWorkAttempt,
  GroupRunWorkAttemptStatus,
} from "../domain/group-agent-run.js";
import {
  groupRunExecutionInputDigest,
  isTerminalGroupAgentRunStatus,
} from "../domain/group-agent-run.js";
import { groupScopeKey, type GroupMessage } from "../domain/group.js";

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const QUESTION_HORIZON_MS = 10 * 60 * 1_000;
const MAX_INPUTS = 64;
const MAX_NONTERMINAL_INPUTS = MAX_INPUTS - 2;
const MAX_PARTICIPANTS = 64;
const MAX_QUESTIONS = 32;
const MAX_EVENTS = 256;
const MAX_RECEIPTS = 64;
const MAX_WORK_ATTEMPTS = 32;
const MAX_CAS_ATTEMPTS = 4;

export interface StartGroupAgentRunInput {
  message: GroupMessage;
  request?: string;
  title?: string;
}

export type StartGroupAgentRunResult =
  | { status: "started"; run: GroupAgentRun }
  | { status: "replayed"; run: GroupAgentRun }
  | { status: "active-run-exists"; run: GroupAgentRun };

export type RouteGroupAgentRunResult =
  | { status: "independent" }
  | { status: "status"; run: GroupAgentRun }
  | {
      status: "forbidden";
      reason:
        | "authority_unavailable"
        | "authority_changed"
        | "runtime_inactive"
        | "account_mismatch"
        | "run_terminal"
        | "initiator_or_admin_required"
        | "assigned_to_other_participant"
        | "admin_override_must_be_explicit";
      run: GroupAgentRun;
    }
  | {
      status: "rejected";
      reason: "mailbox_full" | "ambiguous_batch" | "delivery_in_progress";
      run: GroupAgentRun;
    }
  | {
      status: "applied" | "proposed" | "cancelled";
      run: GroupAgentRun;
      replayed: boolean;
    };

interface CommitGroupRunQuestionBaseInput {
  runId: string;
  expectedStateRevision: number;
  prompt: string;
  assignee: GroupRunParticipant;
  expiresAt?: string;
}

export interface CommitLegacyGroupRunQuestionInput
  extends CommitGroupRunQuestionBaseInput {
  attemptId?: never;
  checkpoint?: never;
}

export interface CommitGroupRunWorkQuestionInput
  extends CommitGroupRunQuestionBaseInput {
  attemptId: string;
  checkpoint: GroupRunExecutionCheckpoint;
}

export type CommitGroupRunQuestionInput =
  | CommitLegacyGroupRunQuestionInput
  | CommitGroupRunWorkQuestionInput;

export interface CommitGroupRunExecutionCheckpointInput {
  runId: string;
  expectedStateRevision: number;
  attemptId: string;
  checkpoint: GroupRunExecutionCheckpoint;
}

export interface CommitGroupRunFinalResultInput {
  runId: string;
  expectedStateRevision: number;
  attemptId: string;
  reply: string;
}

export interface GroupRunDelivery {
  messageId: string;
}

export interface GroupRunQuestionDelivery extends GroupRunDelivery {
  /** Watermark diambil sesudah transport mengonfirmasi delivery. */
  acceptAnswersAfterIngressRevision: number;
}

export interface GroupRunDeliveryActorExpectation {
  participantIds: readonly string[];
  expectedRole: "member" | "admin";
}

export interface GroupRunDeliveryAuthorityExpectation {
  expectedAuthorityEpoch: number;
  actors: readonly GroupRunDeliveryActorExpectation[];
}

export interface GroupRunDeliveryRequest {
  effectId: string;
  content: string;
  quoteMessageId: string | null;
  /** Fence transport dibentuk hanya dari snapshot authority yang durable. */
  authorityExpectation: GroupRunDeliveryAuthorityExpectation;
}

/**
 * Admission runtime sengaja hanya menerima identitas binding. Isi bubble tidak
 * boleh keluar dari ingress policy hanya untuk memutuskan apakah aggregate
 * GroupAgentRun masih boleh dimutasi.
 */
export interface GroupAgentRunRuntimeAdmissionRequest {
  scopeKey: string;
  accountId: string;
}

export interface ClaimGroupAgentRunWorkInput {
  runId: string;
  expectedStateRevision: number;
  /** Token idempotensi code-owned; tidak berasal dari output model. */
  claimKey: string;
}

export interface SettleGroupAgentRunWorkInput {
  runId: string;
  expectedStateRevision: number;
  attemptId: string;
}

export interface RequeueGroupAgentRunWorkInput
  extends SettleGroupAgentRunWorkInput {
  code: string;
}

export interface FailGroupAgentRunWorkInput
  extends SettleGroupAgentRunWorkInput {
  code: string;
}

export type ClaimGroupAgentRunWorkResult = {
  status: "claimed" | "replayed";
  run: GroupAgentRun;
  attempt: GroupRunWorkAttempt;
};

export type SettleGroupAgentRunWorkResult = {
  status: "settled" | "replayed";
  run: GroupAgentRun;
  attempt: GroupRunWorkAttempt;
};

export type GroupAgentRunRuntimeAdmissionResolver = (
  request: GroupAgentRunRuntimeAdmissionRequest,
) => Promise<boolean>;

const ALLOW_GROUP_AGENT_RUN_RUNTIME_ADMISSION:
  GroupAgentRunRuntimeAdmissionResolver = async () => true;

export class GroupAgentRunConflictError extends Error {
  constructor() {
    super("GroupAgentRun berubah bersamaan; operasi ditolak.");
    this.name = "GroupAgentRunConflictError";
  }
}

export class GroupAgentRunAuthorityError extends Error {
  constructor(message = "Otoritas GroupAgentRun tidak tersedia atau berubah.") {
    super(message);
    this.name = "GroupAgentRunAuthorityError";
  }
}

export class GroupAgentRunRuntimeAdmissionError extends Error {
  readonly code = "runtime_inactive" as const;

  constructor() {
    super("Runtime GroupAgentRun tidak aktif; mutasi ditolak.");
    this.name = "GroupAgentRunRuntimeAdmissionError";
  }
}

export class GroupAgentRunWorkAttemptLimitError extends Error {
  readonly code = "work_attempt_limit" as const;

  constructor(readonly run: GroupAgentRun) {
    super("Batas work attempt GroupAgentRun tercapai.");
    this.name = "GroupAgentRunWorkAttemptLimitError";
  }
}

export class GroupAgentRunMessageCollisionError extends Error {
  constructor() {
    super("sourceMessageId GroupAgentRun dipakai oleh envelope yang berbeda.");
    this.name = "GroupAgentRunMessageCollisionError";
  }
}

export class GroupAgentRunDeliveryError extends Error {
  constructor(message = "Delivery GroupAgentRun gagal atau hasilnya ambigu.") {
    super(message);
    this.name = "GroupAgentRunDeliveryError";
  }
}

/**
 * Outcome transport code-owned yang membuktikan socket send belum dipanggil.
 * Hanya error ini yang aman ditutup sebagai `not_committed`.
 */
export class GroupAgentRunDeliveryNotCommittedError extends Error {
  readonly code = "delivery_not_committed" as const;

  constructor(message = "Delivery GroupAgentRun ditolak sebelum socket send.") {
    super(message);
    this.name = "GroupAgentRunDeliveryNotCommittedError";
  }
}

/**
 * Admission/persistence Phase K. Service ini belum menjalankan model atau efek
 * transport; caller harus memasang anchor/question yang benar-benar terkirim.
 */
export class GroupAgentRunService {
  constructor(
    private readonly repository: GroupAgentRunRepository,
    private readonly authority: GroupAuthorityResolver =
      DENY_GROUP_AUTHORITY_RESOLVER,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = () => randomUUID(),
    private readonly runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver =
      ALLOW_GROUP_AGENT_RUN_RUNTIME_ADMISSION,
  ) {}

  async start(
    input: StartGroupAgentRunInput,
  ): Promise<StartGroupAgentRunResult> {
    if (input.message.scope.channel !== "whatsapp") {
      throw new Error("GroupAgentRun Phase K awal hanya mendukung WhatsApp.");
    }
    if (!input.message.mentionsHarvy && !input.message.repliesToHarvy) {
      throw new Error("GroupAgentRun hanya dapat dimulai dari panggilan eksplisit.");
    }
    if ((input.message.parts?.length ?? 0) > 1) {
      throw new Error("Start GroupAgentRun dari batch multi-bubble harus dipisahkan.");
    }
    const startScopeKey = groupScopeKey(input.message.scope);
    const startAccountId = safeKey(input.message.accountId, "accountId");
    if (!await this.runtimeMutationAllowed(startScopeKey, startAccountId)) {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    await this.expireForeground(startScopeKey, startAccountId);
    const firstAuthority = await this.resolveAuthority(input.message);
    if (!firstAuthority ||
      !groupAuthorityAllows(firstAuthority.role, "social.read")) {
      throw new GroupAgentRunAuthorityError();
    }
    const at = this.now();
    const createdAt = at.toISOString();
    const request = boundedText(
      input.request ?? input.message.text,
      8_000,
      "request",
    );
    const initiator = participantFromMessage(input.message);
    const runId = `group-run-${this.id()}`;
    const draft: Omit<GroupAgentRun, "stateRevision"> = {
      version: 2,
      runId,
      scopeKey: groupScopeKey(input.message.scope),
      scope: structuredClone(input.message.scope),
      accountId: startAccountId,
      startSourceMessageId: safeKey(
        input.message.messageId,
        "sourceMessageId",
      ),
      initialRequest: request,
      title: titleFor(input.title ?? request),
      initiator,
      startAuthority: {
        role: firstAuthority.role,
        authorityEpoch: firstAuthority.authorityEpoch,
      },
      participants: [structuredClone(initiator)],
      audience: {
        kind: "group",
        visibility: "group-safe",
        scopeKey: groupScopeKey(input.message.scope),
      },
      status: "queued",
      phase: "queued",
      instructionRevision: 0,
      appliedInstructionRevision: 0,
      anchor: {
        platform: "whatsapp",
        messageId: null,
        pinPolicy: "manual-only",
        updatedAt: createdAt,
      },
      pendingEffect: null,
      receipts: [],
      inputs: [],
      changeSets: [],
      workAttempts: [],
      checkpoint: null,
      result: null,
      questions: [],
      events: [{
        id: `group-run-event-${this.id()}`,
        type: "run.started",
        at: createdAt,
        instructionRevision: 0,
        sourceMessageId: input.message.messageId,
        participantId: initiator.participantId,
      }],
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      expiresAt: new Date(at.getTime() + RUN_RETENTION_MS).toISOString(),
    };
    let runtimeInactiveAtCommit = false;
    const saved = await this.repository.create(draft, async () => {
      if (!await this.runtimeMutationAllowed(startScopeKey, startAccountId)) {
        runtimeInactiveAtCommit = true;
        return false;
      }
      return sameAuthority(
        firstAuthority,
        await this.resolveAuthority(input.message),
      );
    });
    if (saved.status === "saved") return { status: "started", run: saved.run };
    if (saved.status === "guard-rejected") {
      if (runtimeInactiveAtCommit) {
        throw new GroupAgentRunRuntimeAdmissionError();
      }
      throw new GroupAgentRunAuthorityError();
    }
    if (saved.status === "source-exists") {
      if (sameStartEnvelope(saved.run, input.message, request)) {
        return { status: "replayed", run: saved.run };
      }
      throw new GroupAgentRunMessageCollisionError();
    }
    if (saved.status === "active-run-exists") {
      if (sameStartEnvelope(saved.run, input.message, request)) {
        return { status: "replayed", run: saved.run };
      }
      return { status: "active-run-exists", run: saved.run };
    }
    if (saved.status === "scope-busy") {
      throw new GroupAgentRunAuthorityError(
        "GroupAgentRun aktif terikat ke account Harvy lain.",
      );
    }
    const existing = await this.repository.loadLatestByScope(
      draft.scopeKey,
      draft.accountId,
    );
    if (existing && sameStartEnvelope(existing, input.message, request)) {
      return { status: "replayed", run: existing };
    }
    throw new GroupAgentRunConflictError();
  }

  /**
   * Claim sekaligus memulai satu work attempt. Service ini hanya mengubah
   * lifecycle durable; eksekusi model/tool tetap milik lane lain.
   */
  async claimWorkAttempt(
    input: ClaimGroupAgentRunWorkInput,
  ): Promise<ClaimGroupAgentRunWorkResult> {
    const runId = safeKey(input.runId, "runId");
    const claimKey = safeKey(input.claimKey, "work.claimKey");
    const expectedStateRevision = positiveStateRevision(
      input.expectedStateRevision,
    );
    const current = await this.repository.load(runId);
    if (!current) throw new GroupAgentRunConflictError();
    if (!await this.runtimeMutationAllowed(current.scopeKey, current.accountId)) {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    const claimAuthority = await this.runParticipantAuthority(
      current,
      current.initiator,
    );
    if (!claimAuthority) throw new GroupAgentRunAuthorityError();
    const replay = groupRunWorkAttempts(current).find(
      (attempt) => attempt.claimKey === claimKey,
    );
    if (replay) {
      if (replay.claimedStateRevision !== expectedStateRevision) {
        throw new GroupAgentRunConflictError();
      }
      await this.assertClaimFence(current, claimAuthority);
      return {
        status: "replayed",
        run: current,
        attempt: structuredClone(replay),
      };
    }
    if (
      current.stateRevision !== expectedStateRevision ||
      isTerminalGroupAgentRunStatus(current.status) ||
      current.pendingEffect !== null ||
      current.anchor.messageId === null ||
      Date.parse(current.expiresAt) <= this.now().getTime() ||
      current.status === "waiting_input" ||
      current.questions.some((question) => question.status === "open") ||
      // Claim, outcome/recovery, dan satu terminal/control event harus selalu
      // mempunyai slot. Attempt yang hanya bisa dibuka tetapi tidak bisa
      // ditutup adalah state yatim durable.
      current.events.length > MAX_EVENTS - 4
    ) throw new GroupAgentRunConflictError();
    const attempts = groupRunWorkAttempts(current);
    if (attempts.length >= MAX_WORK_ATTEMPTS) {
      throw new GroupAgentRunWorkAttemptLimitError(
        await this.terminalizeWorkAttemptLimit(current, claimAuthority),
      );
    }
    if (
      attempts.some((attempt) => attempt.status === "running") ||
      !(
        current.status === "queued" || current.status === "paused" ||
        (current.status === "running" && current.phase === "replanning")
      )
    ) throw new GroupAgentRunConflictError();
    const at = this.now().toISOString();
    const attempt: GroupRunWorkAttempt = {
      attemptId: safeKey(`group-run-work-${this.id()}`, "work.attemptId"),
      claimKey,
      attemptNumber: attempts.length + 1,
      instructionRevision: current.instructionRevision,
      claimedStateRevision: current.stateRevision,
      status: "running",
      startedAt: at,
      settledAt: null,
      code: null,
    };
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(current),
      status: "running",
      phase: attempts.length === 0 ? "reading_context" : "replanning",
      workAttempts: [...attempts, attempt],
      events: appendEvent(current.events, {
        id: `group-run-event-${this.id()}`,
        type: "work.claimed",
        at,
        instructionRevision: current.instructionRevision,
        sourceMessageId: null,
        participantId: null,
      }),
      updatedAt: at,
    };
    let claimFenceRejection:
      | "runtime_inactive"
      | "authority_invalid"
      | null = null;
    try {
      const saved = await this.saveExact(
        next,
        current.stateRevision,
        async () => {
          claimFenceRejection = await this.claimFenceStatus(
            current,
            claimAuthority,
          );
          return claimFenceRejection === null &&
            Date.parse(current.expiresAt) > this.now().getTime();
        },
        () => claimFenceRejection === "runtime_inactive"
          ? new GroupAgentRunRuntimeAdmissionError()
          : claimFenceRejection === "authority_invalid"
          ? new GroupAgentRunAuthorityError()
          : new GroupAgentRunConflictError(),
      );
      return {
        status: "claimed",
        run: saved,
        attempt: structuredClone(attempt),
      };
    } catch (error) {
      if (!(error instanceof GroupAgentRunConflictError)) throw error;
      const latest = await this.repository.load(runId);
      const concurrentReplay = latest && groupRunWorkAttempts(latest).find(
        (candidate) =>
          candidate.claimKey === claimKey &&
          candidate.claimedStateRevision === expectedStateRevision,
      );
      if (!latest || !concurrentReplay) throw error;
      await this.assertClaimFence(latest, claimAuthority);
      return {
        status: "replayed",
        run: latest,
        attempt: structuredClone(concurrentReplay),
      };
    }
  }

  async commitExecutionCheckpoint(
    input: CommitGroupRunExecutionCheckpointInput,
  ): Promise<GroupAgentRun> {
    const runId = safeKey(input.runId, "runId");
    const attemptId = safeKey(input.attemptId, "checkpoint.attemptId");
    const expectedStateRevision = positiveStateRevision(
      input.expectedStateRevision,
    );
    const current = await this.loadExact(runId, expectedStateRevision);
    if (!await this.runtimeMutationAllowed(current.scopeKey, current.accountId)) {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    const checkpoint = this.checkpointForActiveAttempt(
      current,
      attemptId,
      input.checkpoint,
      null,
    );
    const at = this.now().toISOString();
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(current),
      checkpoint: { ...checkpoint, updatedAt: at },
      updatedAt: at,
    };
    return this.saveExact(
      next,
      current.stateRevision,
      async () =>
        await this.runtimeMutationAllowed(current.scopeKey, current.accountId),
      () => new GroupAgentRunRuntimeAdmissionError(),
    );
  }

  async completeWorkAttempt(
    input: SettleGroupAgentRunWorkInput,
  ): Promise<SettleGroupAgentRunWorkResult> {
    return this.settleWorkAttempt(input, "completed", null, "work.completed");
  }

  async failWorkAttempt(
    input: FailGroupAgentRunWorkInput,
  ): Promise<SettleGroupAgentRunWorkResult> {
    return this.settleWorkAttempt(
      input,
      "failed",
      workAttemptCode(input.code),
      "work.failed",
    );
  }

  async requeueWorkAttempt(
    input: RequeueGroupAgentRunWorkInput,
  ): Promise<SettleGroupAgentRunWorkResult> {
    return this.settleWorkAttempt(
      input,
      "requeued",
      workAttemptCode(input.code),
      "work.requeued",
    );
  }

  async commitAnchor(
    runId: string,
    expectedStateRevision: number,
    content: string,
    deliver: (request: GroupRunDeliveryRequest) => Promise<GroupRunDelivery>,
  ): Promise<GroupAgentRun> {
    const latest = await this.repository.load(runId);
    const replayDigest = contentDigest(
      boundedText(content, 3_900, "delivery.content"),
    );
    const replayReceipt = latest?.receipts.find((receipt) =>
      receipt.purpose === "anchor" &&
      receipt.preparedStateRevision === expectedStateRevision
    );
    if (replayReceipt && replayReceipt.contentDigest !== replayDigest) {
      throw new GroupAgentRunMessageCollisionError();
    }
    if (
      latest && latest.anchor.messageId !== null &&
      latest.stateRevision >= expectedStateRevision &&
      replayReceipt?.status === "committed"
    ) return latest;
    const prepared = await this.prepareDelivery({
      runId,
      expectedStateRevision,
      purpose: "anchor",
      content,
      question: null,
      workAttemptId: null,
      checkpoint: null,
    });
    const deliveryFence = await this.deliveryFenceStatus(prepared);
    if (deliveryFence !== "valid") {
      await this.persistNotCommittedDelivery(prepared);
      if (deliveryFence === "runtime_inactive") {
        throw new GroupAgentRunRuntimeAdmissionError();
      }
      throw new GroupAgentRunAuthorityError();
    }
    try {
      const delivery = await deliver({
        effectId: prepared.pendingEffect!.effectId,
        content: boundedText(content, 3_900, "delivery.content"),
        quoteMessageId: null,
        authorityExpectation: deliveryAuthorityExpectation(prepared),
      });
      return await this.commitPreparedDelivery(prepared, delivery, null);
    } catch (error) {
      if (error instanceof GroupAgentRunDeliveryNotCommittedError) {
        await this.persistNotCommittedDelivery(prepared);
      } else {
        await this.persistUnknownDelivery(prepared);
      }
      throw error;
    }
  }

  async commitAssignedQuestion(
    input: CommitGroupRunQuestionInput,
    deliver: (
      request: GroupRunDeliveryRequest,
    ) => Promise<GroupRunQuestionDelivery>,
  ): Promise<GroupAgentRun> {
    const latest = await this.repository.load(input.runId);
    const workAttemptId = input.attemptId === undefined
      ? null
      : safeKey(input.attemptId, "question.attemptId");
    const requestedCheckpoint = input.checkpoint === undefined
      ? null
      : structuredClone(input.checkpoint);
    if ((workAttemptId === null) !== (requestedCheckpoint === null)) {
      throw new GroupAgentRunConflictError();
    }
    const replayPrompt = boundedText(input.prompt, 2_000, "question.prompt");
    const replayAssignee = normalizedParticipant(input.assignee);
    const replayReceipt = latest?.receipts.find((receipt) =>
      receipt.purpose === "assigned_question" &&
      receipt.preparedStateRevision === input.expectedStateRevision
    );
    if (
      replayReceipt && replayReceipt.contentDigest !== contentDigest(replayPrompt)
    ) throw new GroupAgentRunMessageCollisionError();
    const replayQuestion = replayReceipt?.subjectId
      ? latest?.questions.find((question) =>
          question.questionId === replayReceipt.subjectId &&
          question.prompt === replayPrompt &&
          JSON.stringify(question.assignee) === JSON.stringify(replayAssignee) &&
          (input.expiresAt === undefined || question.expiresAt === input.expiresAt)
        )
      : null;
    if (latest && replayReceipt?.status === "committed") {
      if (
        !replayQuestion ||
        (workAttemptId === null
          ? (latest.checkpoint ?? null) !== null
          : !checkpointMatchesQuestionReplay(
            latest.checkpoint ?? null,
            requestedCheckpoint!,
            workAttemptId,
            replayQuestion.questionId,
          ))
      ) throw new GroupAgentRunMessageCollisionError();
      return latest;
    }
    const run = await this.loadExact(input.runId, input.expectedStateRevision);
    this.assertQuestionCanBePrepared(
      run,
      workAttemptId,
      requestedCheckpoint,
    );
    const at = this.now();
    const expiresAt = this.questionExpiry(run, at, input.expiresAt);
    const assignee = replayAssignee;
    const prompt = replayPrompt;
    const questionId = `group-run-question-${this.id()}`;
    const prepared = await this.prepareDelivery({
      runId: run.runId,
      expectedStateRevision: run.stateRevision,
      purpose: "assigned_question",
      content: prompt,
      question: { questionId, prompt, assignee, expiresAt },
      workAttemptId,
      checkpoint: requestedCheckpoint
        ? { ...requestedCheckpoint, waitingQuestionId: questionId }
        : null,
    });
    const deliveryFence = await this.deliveryFenceStatus(prepared);
    if (deliveryFence !== "valid") {
      await this.persistNotCommittedDelivery(prepared);
      if (deliveryFence === "runtime_inactive") {
        throw new GroupAgentRunRuntimeAdmissionError();
      }
      throw new GroupAgentRunAuthorityError();
    }
    try {
      const delivery = await deliver({
        effectId: prepared.pendingEffect!.effectId,
        content: prompt,
        quoteMessageId: prepared.anchor.messageId,
        authorityExpectation: deliveryAuthorityExpectation(prepared),
      });
      return await this.commitPreparedDelivery(
        prepared,
        delivery,
        nonNegativeIntegerValue(
          delivery.acceptAnswersAfterIngressRevision,
          "acceptAnswersAfterIngressRevision",
        ),
      );
    } catch (error) {
      if (error instanceof GroupAgentRunDeliveryNotCommittedError) {
        await this.persistNotCommittedDelivery(prepared);
      } else {
        await this.persistUnknownDelivery(prepared);
      }
      throw error;
    }
  }

  /**
   * Commit barrier final: intent dikunci durable sebelum send, lalu receipt,
   * result, work attempt, dan terminal run dikomit dalam satu CAS.
   */
  async commitFinalResult(
    input: CommitGroupRunFinalResultInput,
    deliver: (request: GroupRunDeliveryRequest) => Promise<GroupRunDelivery>,
  ): Promise<GroupAgentRun> {
    const runId = safeKey(input.runId, "runId");
    const expectedStateRevision = positiveStateRevision(
      input.expectedStateRevision,
    );
    const attemptId = safeKey(input.attemptId, "work.attemptId");
    const reply = boundedText(input.reply, 3_900, "delivery.content");
    const digest = contentDigest(reply);
    const latest = await this.repository.load(runId);
    if (!latest) throw new GroupAgentRunConflictError();

    const finalReceipts = latest.receipts.filter((receipt) =>
      receipt.purpose === "final_result"
    );
    const replayReceipt = finalReceipts.find((receipt) =>
      receipt.preparedStateRevision === expectedStateRevision
    ) ?? finalReceipts.find((receipt) =>
      receipt.status === "committed" && receipt.subjectId === attemptId
    ) ?? finalReceipts.find((receipt) => receipt.subjectId === attemptId);
    const replayResult = latest.result ?? null;
    if (replayReceipt || replayResult) {
      const exact = replayReceipt?.status === "committed" &&
        replayReceipt.preparedStateRevision === expectedStateRevision &&
        replayReceipt.subjectId === attemptId &&
        replayReceipt.contentDigest === digest &&
        replayResult?.kind === "final" &&
        replayResult.text === reply &&
        replayResult.contentDigest === digest &&
        replayResult.instructionRevision === replayReceipt.instructionRevision &&
        replayResult.attemptId === attemptId &&
        replayResult.messageId === replayReceipt.externalMessageId &&
        replayResult.committedAt === replayReceipt.committedAt;
      if (exact) return latest;
      if (
        replayReceipt?.contentDigest !== digest || replayResult !== null ||
        replayReceipt?.status === "committed"
      ) throw new GroupAgentRunMessageCollisionError();
    }

    const run = await this.loadExact(runId, expectedStateRevision);
    this.assertFinalResultCanBePrepared(run, attemptId);
    const attempt = activeGroupRunWorkAttempt(run)!;
    if (attempt.instructionRevision !== run.instructionRevision) {
      throw new GroupAgentRunConflictError();
    }
    const prepared = await this.prepareDelivery({
      runId,
      expectedStateRevision,
      purpose: "final_result",
      content: reply,
      question: null,
      workAttemptId: attemptId,
      checkpoint: null,
    });
    const deliveryFence = await this.deliveryFenceStatus(prepared);
    if (deliveryFence !== "valid") {
      await this.persistNotCommittedDelivery(prepared);
      if (deliveryFence === "runtime_inactive") {
        throw new GroupAgentRunRuntimeAdmissionError();
      }
      throw new GroupAgentRunAuthorityError();
    }
    try {
      const delivery = await deliver({
        effectId: prepared.pendingEffect!.effectId,
        content: reply,
        quoteMessageId: prepared.anchor.messageId,
        authorityExpectation: deliveryAuthorityExpectation(prepared),
      });
      return await this.commitPreparedFinalDelivery(prepared, delivery, reply);
    } catch (error) {
      if (error instanceof GroupAgentRunDeliveryNotCommittedError) {
        await this.persistNotCommittedDelivery(prepared);
      } else {
        await this.persistUnknownDelivery(prepared);
      }
      throw error;
    }
  }

  async routeMessage(
    message: GroupMessage,
  ): Promise<RouteGroupAgentRunResult> {
    const scopeKey = groupScopeKey(message.scope);
    await this.expireForeground(scopeKey, message.accountId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const run = await this.repository.loadLatestByScope(
        scopeKey,
        message.accountId,
      );
      if (!run) return { status: "independent" };
      const routed = singleRoutedMessage(message, run);
      if (routed.status === "none") return { status: "independent" };
      if (routed.status === "ambiguous") {
        return { status: "rejected", reason: "ambiguous_batch", run };
      }
      const routedMessage = routed.message;
      // Bentuk target diperiksa tanpa model/authority call. `true` hanya
      // membuka grammar command; policy tetap memeriksa initiator/admin.
      if (groupRunTarget(routedMessage, run, true) === "none") {
        return { status: "independent" };
      }
      if (run.pendingEffect) {
        return { status: "rejected", reason: "delivery_in_progress", run };
      }
      if (run.accountId !== routedMessage.accountId) {
        return { status: "forbidden", reason: "account_mismatch", run };
      }
      const authority = await this.resolveAuthority(routedMessage);
      if (!authority || !groupAuthorityAllows(authority.role, "social.read")) {
        return { status: "forbidden", reason: "authority_unavailable", run };
      }

      const replay = run.inputs.find(
        (candidate) => candidate.sourceMessageId === routedMessage.messageId,
      );
      if (replay) return replayResult(run, replay, routedMessage);

      const decision = decideGroupRunInput({
        message: routedMessage,
        run,
        role: authority.role,
      });
      if (decision.relation === "independent_chat") {
        return { status: "independent" };
      }
      if (decision.relation === "status_query") {
        return { status: "status", run };
      }
      if (decision.relation === "forbidden") {
        return { status: "forbidden", reason: decision.reason, run };
      }
      if (!await this.runtimeMutationAllowed(run.scopeKey, run.accountId)) {
        return { status: "forbidden", reason: "runtime_inactive", run };
      }
      const inputLimit = decision.kind === "cancel"
        ? MAX_INPUTS
        : decision.kind === "answer" ? MAX_INPUTS - 1 : MAX_NONTERMINAL_INPUTS;
      if (run.inputs.length >= inputLimit) {
        return { status: "rejected", reason: "mailbox_full", run };
      }
      if (decision.kind !== "cancel") {
        const activeAttempt = activeGroupRunWorkAttempt(run);
        if (
          run.events.length >= MAX_EVENTS - 1 ||
          (activeAttempt !== null && run.events.length >= MAX_EVENTS - 2)
        ) return { status: "rejected", reason: "mailbox_full", run };
      }
      if (
        decision.kind === "answer" && decision.questionId &&
        !answerPassesIngressWatermark(run, decision.questionId, routedMessage)
      ) {
        return { status: "independent" };
      }

      const acceptedAt = this.now();
      if (!mutationWindowOpen(run, decision, acceptedAt)) {
        const expired = await this.expireForeground(scopeKey, message.accountId);
        return {
          status: "forbidden",
          reason: "run_terminal",
          run: expired ?? run,
        };
      }
      const next = this.applyMessage(
        run,
        routedMessage,
        authority,
        decision,
        acceptedAt,
      );
      let expiredAtCommit = false;
      let runtimeInactiveAtCommit = false;
      const saved = await this.repository.save(
        withoutStateRevision(next),
        run.stateRevision,
        async () => {
          if (!await this.runtimeMutationAllowed(run.scopeKey, run.accountId)) {
            runtimeInactiveAtCommit = true;
            return false;
          }
          const current = await this.resolveAuthority(routedMessage);
          expiredAtCommit = !mutationWindowOpen(run, decision, this.now());
          return !expiredAtCommit && sameAuthority(authority, current) &&
            sameDecision(
              decision,
              decideGroupRunInput({
                message: routedMessage,
                run,
                role: current.role,
              }),
            );
        },
      );
      if (saved.status === "conflict") continue;
      if (saved.status === "guard-rejected") {
        if (runtimeInactiveAtCommit) {
          return { status: "forbidden", reason: "runtime_inactive", run };
        }
        if (expiredAtCommit) {
          const expired = await this.expireForeground(
            scopeKey,
            message.accountId,
          );
          return {
            status: "forbidden",
            reason: "run_terminal",
            run: expired ?? run,
          };
        }
        return { status: "forbidden", reason: "authority_changed", run };
      }
      return {
        status: decision.kind === "cancel"
          ? "cancelled"
          : decision.disposition === "proposal" ? "proposed" : "applied",
        run: saved.run,
        replayed: false,
      };
    }
    throw new GroupAgentRunConflictError();
  }

  /**
   * Startup recovery hanya merekonsiliasi ledger: delivery in-flight menjadi
   * unknown, run expired menjadi failed, work running menjadi requeued, dan
   * finalizing tanpa final receipt kembali queued. Ia tidak claim, model,
   * tool, transport, maupun efek eksternal apa pun.
   */
  async recoverInterruptedRuns(): Promise<GroupAgentRun[]> {
    const recovered: GroupAgentRun[] = [];
    for (const candidate of await this.repository.listActive()) {
      for (let retry = 0; retry < MAX_CAS_ATTEMPTS; retry += 1) {
        const current = await this.repository.load(candidate.runId);
        if (!current || isTerminalGroupAgentRunStatus(current.status)) break;
        const activeAttempt = activeGroupRunWorkAttempt(current);
        const at = this.now().toISOString();
        if (current.pendingEffect) {
          const pending = current.pendingEffect;
          const next: Omit<GroupAgentRun, "stateRevision"> = {
            ...withoutStateRevision(current),
            status: "partial",
            phase: "failed",
            pendingEffect: null,
            workAttempts: activeAttempt
              ? settleRunningGroupRunWorkAttempt(
                  current,
                  "failed",
                  at,
                  "delivery_outcome_unknown_after_restart",
                )
              : groupRunWorkAttempts(current),
            receipts: appendReceipt(current.receipts, {
              receiptId: `group-run-receipt-${this.id()}`,
              effectId: pending.effectId,
              effect: "whatsapp.message.send",
              purpose: pending.purpose,
              instructionRevision: pending.instructionRevision,
              preparedStateRevision: pending.preparedStateRevision,
              contentDigest: pending.contentDigest,
              subjectId: pendingDeliverySubjectId(pending),
              workAttemptId: pending.workAttemptId ?? null,
              authority: structuredClone(pending.authority),
              status: "unknown",
              externalMessageId: null,
              committedAt: at,
              reversible: false,
            }),
            events: appendDeliveryOutcomeEvent(current.events, {
              id: `group-run-event-${this.id()}`,
              type: "delivery.unknown",
              at,
              instructionRevision: pending.instructionRevision,
              sourceMessageId: null,
              participantId: null,
            }),
            updatedAt: at,
            completedAt: at,
          };
          const saved = await this.repository.save(
            next,
            current.stateRevision,
            async () => true,
          );
          if (saved.status === "conflict") continue;
          if (saved.status !== "saved") throw new GroupAgentRunConflictError();
          recovered.push(saved.run);
          break;
        }

        if (Date.parse(current.expiresAt) <= this.now().getTime()) {
          const next: Omit<GroupAgentRun, "stateRevision"> = {
            ...withoutStateRevision(current),
            status: "failed",
            phase: "failed",
            workAttempts: activeAttempt
              ? settleRunningGroupRunWorkAttempt(
                  current,
                  "failed",
                  at,
                  "run_expired",
                )
              : groupRunWorkAttempts(current),
            questions: current.questions.map((question) =>
              question.status === "open"
                ? { ...question, status: "expired" as const }
                : question
            ),
            events: activeAttempt
              ? appendWorkOutcomeEvent(current.events, {
                  id: `group-run-event-${this.id()}`,
                  type: "run.expired",
                  at,
                  instructionRevision: current.instructionRevision,
                  sourceMessageId: null,
                  participantId: null,
                })
              : appendEvent(current.events, {
              id: `group-run-event-${this.id()}`,
              type: "run.expired",
              at,
              instructionRevision: current.instructionRevision,
              sourceMessageId: null,
              participantId: null,
              }),
            updatedAt: at,
            completedAt: at,
          };
          const saved = await this.repository.save(
            next,
            current.stateRevision,
            async () => true,
          );
          if (saved.status === "conflict") continue;
          if (saved.status !== "saved") throw new GroupAgentRunConflictError();
          recovered.push(saved.run);
          break;
        }

        const latestAttempt = groupRunWorkAttempts(current).at(-1);
        if (
          !activeAttempt && current.status === "running" &&
          current.phase === "finalizing" &&
          latestAttempt?.status === "completed"
        ) {
          if (!await this.runtimeMutationAllowed(current.scopeKey, current.accountId)) {
            break;
          }
          const next: Omit<GroupAgentRun, "stateRevision"> = {
            ...withoutStateRevision(current),
            status: "queued",
            phase: "queued",
            events: appendEvent(current.events, {
              id: `group-run-event-${this.id()}`,
              type: "work.recovered",
              at,
              instructionRevision: current.instructionRevision,
              sourceMessageId: null,
              participantId: null,
            }),
            updatedAt: at,
          };
          const saved = await this.repository.save(
            next,
            current.stateRevision,
            async () =>
              await this.runtimeMutationAllowed(
                current.scopeKey,
                current.accountId,
              ),
          );
          if (saved.status === "conflict") continue;
          if (saved.status === "saved") recovered.push(saved.run);
          break;
        }

        if (!activeAttempt) break;

        if (!await this.runtimeMutationAllowed(current.scopeKey, current.accountId)) {
          break;
        }
        const hasOpenQuestion = current.questions.some(
          (question) => question.status === "open",
        );
        const eventCapacityExhausted =
          current.events.length >= MAX_EVENTS - 1;
        const next: Omit<GroupAgentRun, "stateRevision"> = {
          ...withoutStateRevision(current),
          status: eventCapacityExhausted
            ? "failed"
            : hasOpenQuestion ? "waiting_input" : "queued",
          phase: eventCapacityExhausted
            ? "failed"
            : hasOpenQuestion ? "waiting_input" : "queued",
          workAttempts: settleRunningGroupRunWorkAttempt(
            current,
            eventCapacityExhausted ? "failed" : "requeued",
            at,
            eventCapacityExhausted
              ? "work_attempt_event_limit"
              : "process_interrupted",
          ),
          events: appendWorkOutcomeEvent(current.events, {
            id: `group-run-event-${this.id()}`,
            type: eventCapacityExhausted ? "work.failed" : "work.recovered",
            at,
            instructionRevision: current.instructionRevision,
            sourceMessageId: null,
            participantId: null,
          }),
          updatedAt: at,
          completedAt: eventCapacityExhausted ? at : null,
        };
        const saved = await this.repository.save(
          next,
          current.stateRevision,
          async () =>
            await this.runtimeMutationAllowed(current.scopeKey, current.accountId),
        );
        if (saved.status === "conflict") continue;
        if (saved.status === "saved") recovered.push(saved.run);
        // Guard-rejected sengaja dibiarkan durable untuk recovery berikutnya.
        break;
      }
    }
    return recovered;
  }

  private async terminalizeWorkAttemptLimit(
    current: GroupAgentRun,
    claimAuthority: GroupAuthoritySnapshot,
  ): Promise<GroupAgentRun> {
    const at = this.now().toISOString();
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(current),
      status: "failed",
      phase: "failed",
      events: current.events.length >= MAX_EVENTS
        ? current.events
        : appendEvent(current.events, {
            id: `group-run-event-${this.id()}`,
            type: "work.failed",
            at,
            instructionRevision: current.instructionRevision,
            sourceMessageId: null,
            participantId: null,
          }),
      updatedAt: at,
      completedAt: at,
    };
    let claimFenceRejection:
      | "runtime_inactive"
      | "authority_invalid"
      | null = null;
    try {
      return await this.saveExact(
        next,
        current.stateRevision,
        async () => {
          claimFenceRejection = await this.claimFenceStatus(
            current,
            claimAuthority,
          );
          return claimFenceRejection === null;
        },
        () => claimFenceRejection === "runtime_inactive"
          ? new GroupAgentRunRuntimeAdmissionError()
          : claimFenceRejection === "authority_invalid"
          ? new GroupAgentRunAuthorityError()
          : new GroupAgentRunConflictError(),
      );
    } catch (error) {
      if (!(error instanceof GroupAgentRunConflictError)) throw error;
      const latest = await this.repository.load(current.runId);
      if (
        latest?.status === "failed" &&
        groupRunWorkAttempts(latest).length >= MAX_WORK_ATTEMPTS
      ) return latest;
      throw error;
    }
  }

  private async settleWorkAttempt(
    input: SettleGroupAgentRunWorkInput,
    targetStatus: Extract<
      GroupRunWorkAttemptStatus,
      "completed" | "failed" | "requeued"
    >,
    code: string | null,
    eventType: Extract<
      GroupAgentRun["events"][number]["type"],
      "work.completed" | "work.failed" | "work.requeued"
    >,
  ): Promise<SettleGroupAgentRunWorkResult> {
    const runId = safeKey(input.runId, "runId");
    const attemptId = safeKey(input.attemptId, "work.attemptId");
    const expectedStateRevision = positiveStateRevision(
      input.expectedStateRevision,
    );
    const current = await this.repository.load(runId);
    if (!current) throw new GroupAgentRunConflictError();
    if (!await this.runtimeMutationAllowed(current.scopeKey, current.accountId)) {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    const attempts = groupRunWorkAttempts(current);
    const index = attempts.findIndex(
      (attempt) => attempt.attemptId === attemptId,
    );
    const existing = index < 0 ? null : attempts[index]!;
    if (
      existing?.status === targetStatus && existing.code === code &&
      existing.settledAt !== null
    ) {
      return {
        status: "replayed",
        run: current,
        attempt: structuredClone(existing),
      };
    }
    if (
      current.stateRevision !== expectedStateRevision || !existing ||
      existing.status !== "running" ||
      isTerminalGroupAgentRunStatus(current.status) ||
      current.pendingEffect !== null ||
      Date.parse(current.expiresAt) <= this.now().getTime() ||
      (targetStatus !== "requeued" &&
        existing.instructionRevision !== current.instructionRevision) ||
      (targetStatus === "completed" &&
        current.questions.some((question) => question.status === "open")) ||
      (targetStatus === "completed" &&
        current.events.length > MAX_EVENTS - 3) ||
      (targetStatus === "requeued" &&
        current.events.length > MAX_EVENTS - 2)
    ) throw new GroupAgentRunConflictError();

    const at = this.now().toISOString();
    const settledAttempt: GroupRunWorkAttempt = {
      ...existing,
      status: targetStatus,
      settledAt: at,
      code,
    };
    const workAttempts = attempts.map((attempt, attemptIndex) =>
      attemptIndex === index ? settledAttempt : attempt
    );
    const hasOpenQuestion = current.questions.some(
      (question) => question.status === "open",
    );
    const nextStatus: GroupAgentRun["status"] = targetStatus === "completed"
      ? "running"
      : targetStatus === "failed"
      ? "failed"
      : hasOpenQuestion ? "waiting_input" : "queued";
    const nextPhase: GroupAgentRun["phase"] = targetStatus === "completed"
      ? "finalizing"
      : targetStatus === "failed"
      ? "failed"
      : hasOpenQuestion ? "waiting_input" : "queued";
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(current),
      status: nextStatus,
      phase: nextPhase,
      appliedInstructionRevision: targetStatus === "completed"
        ? existing.instructionRevision
        : current.appliedInstructionRevision,
      workAttempts,
      questions: targetStatus === "failed"
        ? current.questions.map((question) =>
            question.status === "open"
              ? { ...question, status: "cancelled" as const }
              : question
          )
        : current.questions,
      events: appendWorkOutcomeEvent(current.events, {
        id: `group-run-event-${this.id()}`,
        type: eventType,
        at,
        instructionRevision: current.instructionRevision,
        sourceMessageId: null,
        participantId: null,
      }),
      updatedAt: at,
      completedAt: targetStatus === "failed" ? at : null,
    };
    try {
      const saved = await this.saveExact(
        next,
        current.stateRevision,
        async () =>
          await this.runtimeMutationAllowed(current.scopeKey, current.accountId),
        () => new GroupAgentRunRuntimeAdmissionError(),
      );
      return {
        status: "settled",
        run: saved,
        attempt: structuredClone(settledAttempt),
      };
    } catch (error) {
      if (!(error instanceof GroupAgentRunConflictError)) throw error;
      const latest = await this.repository.load(runId);
      const concurrentReplay = latest && groupRunWorkAttempts(latest).find(
        (attempt) =>
          attempt.attemptId === attemptId && attempt.status === targetStatus &&
          attempt.code === code && attempt.settledAt !== null
      );
      if (!latest || !concurrentReplay) throw error;
      return {
        status: "replayed",
        run: latest,
        attempt: structuredClone(concurrentReplay),
      };
    }
  }

  private async prepareDelivery(input: {
    runId: string;
    expectedStateRevision: number;
    purpose: GroupRunDeliveryPurpose;
    content: string;
    question: {
      questionId: string;
      prompt: string;
      assignee: GroupRunParticipant;
      expiresAt: string;
    } | null;
    workAttemptId: string | null;
    checkpoint: GroupRunExecutionCheckpoint | null;
  }): Promise<GroupAgentRun> {
    const run = await this.loadExact(input.runId, input.expectedStateRevision);
    if (!await this.runtimeMutationAllowed(run.scopeKey, run.accountId)) {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    const maximumEventsBeforeDelivery = input.purpose === "assigned_question"
      ? MAX_EVENTS - 4
      : MAX_EVENTS - 3;
    if (
      isTerminalGroupAgentRunStatus(run.status) || run.pendingEffect ||
      run.receipts.length >= MAX_RECEIPTS ||
      run.events.length > maximumEventsBeforeDelivery ||
      Date.parse(run.expiresAt) <= this.now().getTime() ||
      (input.purpose === "anchor" && run.anchor.messageId !== null)
    ) throw new GroupAgentRunConflictError();
    if (input.purpose === "assigned_question") {
      if (!input.question) {
        throw new GroupAgentRunConflictError();
      }
      this.assertQuestionCanBePrepared(
        run,
        input.workAttemptId,
        input.checkpoint,
        input.question.questionId,
      );
    } else if (input.purpose === "final_result") {
      if (
        input.question !== null || input.workAttemptId === null ||
        input.checkpoint !== null
      ) {
        throw new GroupAgentRunConflictError();
      }
      this.assertFinalResultCanBePrepared(run, input.workAttemptId);
    } else if (
      input.question !== null || input.workAttemptId !== null ||
      input.checkpoint !== null
    ) {
      throw new GroupAgentRunConflictError();
    }
    const content = boundedText(input.content, 3_900, "delivery.content");
    const at = this.now().toISOString();
    const effectId = `group-run-effect-${this.id()}`;
    const pendingQuestion = input.question
      ? {
          ...input.question,
          assignee: normalizedParticipant(input.question.assignee),
        }
      : null;
    const initiatorAuthority = await this.runParticipantAuthority(
      run,
      run.initiator,
    );
    const assigneeAuthority = pendingQuestion
      ? await this.runParticipantAuthority(run, pendingQuestion.assignee)
      : null;
    if (
      !initiatorAuthority ||
      (pendingQuestion &&
        (!assigneeAuthority || assigneeAuthority.authorityEpoch !==
          initiatorAuthority.authorityEpoch))
    ) throw new GroupAgentRunAuthorityError();
    const authority = {
      initiatorRole: initiatorAuthority.role,
      assigneeRole: assigneeAuthority?.role ?? null,
      authorityEpoch: initiatorAuthority.authorityEpoch,
    };
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(run),
      phase: input.purpose === "final_result"
        ? "finalizing"
        : run.status === "queued" ? run.phase : "finalizing",
      pendingEffect: {
        effectId,
        purpose: input.purpose,
        instructionRevision: run.instructionRevision,
        preparedStateRevision: run.stateRevision,
        contentDigest: contentDigest(content),
        question: pendingQuestion,
        workAttemptId: input.workAttemptId,
        authority,
        preparedAt: at,
      },
      checkpoint: input.checkpoint
        ? { ...structuredClone(input.checkpoint), updatedAt: at }
        : run.checkpoint ?? null,
      events: appendEvent(run.events, {
        id: `group-run-event-${this.id()}`,
        type: "delivery.prepared",
        at,
        instructionRevision: run.instructionRevision,
        sourceMessageId: null,
        participantId: pendingQuestion?.assignee.participantId ?? null,
      }),
      updatedAt: at,
    };
    let runtimeInactiveAtCommit = false;
    return this.saveExact(
      next,
      run.stateRevision,
      async () => {
        if (!await this.runtimeMutationAllowed(run.scopeKey, run.accountId)) {
          runtimeInactiveAtCommit = true;
          return false;
        }
        const initiator = await this.runParticipantAuthority(
          run,
          run.initiator,
        );
        if (
          !sameAuthority(initiatorAuthority, initiator) ||
          Date.parse(run.expiresAt) <= this.now().getTime()
        ) return false;
        if (!pendingQuestion || !assigneeAuthority) return !pendingQuestion;
        const assignee = await this.runParticipantAuthority(
          run,
          pendingQuestion.assignee,
        );
        return sameAuthority(assigneeAuthority, assignee) &&
          assignee.authorityEpoch === initiator.authorityEpoch &&
          Date.parse(pendingQuestion.expiresAt) > this.now().getTime();
      },
      () => runtimeInactiveAtCommit
        ? new GroupAgentRunRuntimeAdmissionError()
        : new GroupAgentRunConflictError(),
    );
  }

  private assertFinalResultCanBePrepared(
    run: GroupAgentRun,
    attemptId: string,
  ): void {
    const active = activeGroupRunWorkAttempt(run);
    const anchorReceipt = run.receipts.find((receipt) =>
      receipt.purpose === "anchor" && receipt.status === "committed" &&
      receipt.externalMessageId === run.anchor.messageId
    );
    if (
      run.status !== "running" || run.pendingEffect !== null ||
      (run.result ?? null) !== null || run.anchor.messageId === null ||
      !anchorReceipt || run.questions.some((question) => question.status === "open") ||
      !active || active.attemptId !== attemptId ||
      active.instructionRevision !== run.instructionRevision ||
      Date.parse(run.expiresAt) <= this.now().getTime()
    ) throw new GroupAgentRunConflictError();
  }

  private async commitPreparedDelivery(
    prepared: GroupAgentRun,
    delivery: GroupRunDelivery,
    acceptAnswersAfterIngressRevision: number | null,
  ): Promise<GroupAgentRun> {
    const pending = prepared.pendingEffect;
    if (!pending || pending.purpose === "final_result") {
      throw new GroupAgentRunConflictError();
    }
    if (pending.purpose === "assigned_question") {
      const active = activeGroupRunWorkAttempt(prepared);
      const checkpoint = prepared.checkpoint ?? null;
      if (
        !pending.question ||
        (pending.workAttemptId === null
          ? groupRunWorkAttempts(prepared).length > 0 ||
            checkpoint !== null
          : !active || !checkpoint ||
            active.attemptId !== pending.workAttemptId ||
            checkpoint.attemptId !== pending.workAttemptId ||
            checkpoint.waitingQuestionId !==
              pending.question.questionId)
      ) throw new GroupAgentRunConflictError();
    }
    const messageId = safeKey(delivery.messageId, "delivery.messageId");
    const at = this.now().toISOString();
    const participants = pending.question
      ? addParticipant(prepared.participants, pending.question.assignee)
      : prepared.participants;
    const question = pending.question
      ? {
          questionId: pending.question.questionId,
          prompt: pending.question.prompt,
          assignee: pending.question.assignee,
          messageId,
          acceptAnswersAfterIngressRevision:
            acceptAnswersAfterIngressRevision ?? 0,
          status: "open" as const,
          askedAt: at,
          expiresAt: pending.question.expiresAt,
          answeredBy: null,
          answerSourceMessageId: null,
          answeredAt: null,
        }
      : null;
    const receipt = {
      receiptId: `group-run-receipt-${this.id()}`,
      effectId: pending.effectId,
      effect: "whatsapp.message.send" as const,
      purpose: pending.purpose,
      instructionRevision: pending.instructionRevision,
      preparedStateRevision: pending.preparedStateRevision,
      contentDigest: pending.contentDigest,
      subjectId: question?.questionId ?? null,
      workAttemptId: pending.workAttemptId ?? null,
      authority: structuredClone(pending.authority),
      status: "committed" as const,
      externalMessageId: messageId,
      committedAt: at,
      reversible: false as const,
    };
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(prepared),
      participants,
      status: question ? "waiting_input" : prepared.status,
      phase: question ? "waiting_input" : prepared.phase,
      workAttempts: question && activeGroupRunWorkAttempt(prepared)
        ? settleRunningGroupRunWorkAttempt(
            prepared,
            "requeued",
            at,
            "waiting_input",
          )
        : groupRunWorkAttempts(prepared),
      anchor: pending.purpose === "anchor"
        ? { ...prepared.anchor, messageId, updatedAt: at }
        : prepared.anchor,
      pendingEffect: null,
      receipts: appendReceipt(prepared.receipts, receipt),
      questions: question ? [...prepared.questions, question] : prepared.questions,
      events: appendEvent(prepared.events, {
        id: `group-run-event-${this.id()}`,
        type: pending.purpose === "anchor" ? "anchor.attached" : "input.required",
        at,
        instructionRevision: pending.instructionRevision,
        sourceMessageId: messageId,
        participantId: question?.assignee.participantId ?? null,
      }),
      updatedAt: at,
    };
    try {
      return await this.saveExact(next, prepared.stateRevision, async () => true);
    } catch (error) {
      throw new GroupAgentRunDeliveryError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private async commitPreparedFinalDelivery(
    prepared: GroupAgentRun,
    delivery: GroupRunDelivery,
    reply: string,
  ): Promise<GroupAgentRun> {
    const pending = prepared.pendingEffect;
    const attemptId = pending?.workAttemptId ?? null;
    const active = activeGroupRunWorkAttempt(prepared);
    if (
      !pending || pending.purpose !== "final_result" || !attemptId ||
      pending.question !== null || pending.contentDigest !== contentDigest(reply) ||
      prepared.status !== "running" || (prepared.result ?? null) !== null ||
      active?.attemptId !== attemptId ||
      active.instructionRevision !== pending.instructionRevision ||
      pending.instructionRevision !== prepared.instructionRevision ||
      prepared.anchor.messageId === null ||
      prepared.questions.some((question) => question.status === "open")
    ) throw new GroupAgentRunConflictError();
    const messageId = safeKey(delivery.messageId, "delivery.messageId");
    const at = this.now().toISOString();
    const workAttempts = groupRunWorkAttempts(prepared).map((attempt) =>
      attempt.attemptId === attemptId
        ? {
            ...attempt,
            status: "completed" as const,
            settledAt: at,
            code: null,
          }
        : attempt
    );
    const receipt = {
      receiptId: `group-run-receipt-${this.id()}`,
      effectId: pending.effectId,
      effect: "whatsapp.message.send" as const,
      purpose: "final_result" as const,
      instructionRevision: pending.instructionRevision,
      preparedStateRevision: pending.preparedStateRevision,
      contentDigest: pending.contentDigest,
      subjectId: attemptId,
      workAttemptId: attemptId,
      authority: structuredClone(pending.authority),
      status: "committed" as const,
      externalMessageId: messageId,
      committedAt: at,
      reversible: false as const,
    };
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(prepared),
      status: "completed",
      phase: "completed",
      appliedInstructionRevision: pending.instructionRevision,
      pendingEffect: null,
      receipts: appendReceipt(prepared.receipts, receipt),
      workAttempts,
      result: {
        kind: "final",
        text: reply,
        contentDigest: pending.contentDigest,
        instructionRevision: pending.instructionRevision,
        attemptId,
        messageId,
        committedAt: at,
      },
      events: appendEvent(prepared.events, {
        id: `group-run-event-${this.id()}`,
        type: "run.completed",
        at,
        instructionRevision: pending.instructionRevision,
        sourceMessageId: messageId,
        participantId: null,
      }),
      updatedAt: at,
      completedAt: at,
    };
    try {
      return await this.saveExact(next, prepared.stateRevision, async () => true);
    } catch (error) {
      throw new GroupAgentRunDeliveryError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private async persistUnknownDelivery(prepared: GroupAgentRun): Promise<void> {
    const pending = prepared.pendingEffect;
    if (!pending) return;
    const at = this.now().toISOString();
    try {
      await this.saveExact({
        ...withoutStateRevision(prepared),
        status: "partial",
        phase: "failed",
        pendingEffect: null,
        checkpoint: pending.purpose === "assigned_question" &&
            prepared.checkpoint
          ? {
              ...structuredClone(prepared.checkpoint),
              waitingQuestionId: null,
              updatedAt: at,
            }
          : prepared.checkpoint ?? null,
        workAttempts: activeGroupRunWorkAttempt(prepared)
          ? settleRunningGroupRunWorkAttempt(
              prepared,
              "failed",
              at,
              "delivery_outcome_unknown",
            )
          : groupRunWorkAttempts(prepared),
        receipts: appendReceipt(prepared.receipts, {
          receiptId: `group-run-receipt-${this.id()}`,
          effectId: pending.effectId,
          effect: "whatsapp.message.send",
          purpose: pending.purpose,
          instructionRevision: pending.instructionRevision,
          preparedStateRevision: pending.preparedStateRevision,
          contentDigest: pending.contentDigest,
          subjectId: pendingDeliverySubjectId(pending),
          workAttemptId: pending.workAttemptId ?? null,
          authority: structuredClone(pending.authority),
          status: "unknown",
          externalMessageId: null,
          committedAt: at,
          reversible: false,
        }),
        events: appendDeliveryOutcomeEvent(prepared.events, {
          id: `group-run-event-${this.id()}`,
          type: "delivery.unknown",
          at,
          instructionRevision: pending.instructionRevision,
          sourceMessageId: null,
          participantId: pending.question?.assignee.participantId ?? null,
        }),
        updatedAt: at,
        completedAt: at,
      }, prepared.stateRevision, async () => true);
    } catch {
      // Pending effect tetap durable agar startup recovery menandainya ambigu.
    }
  }

  private async persistNotCommittedDelivery(
    prepared: GroupAgentRun,
  ): Promise<void> {
    const pending = prepared.pendingEffect;
    if (!pending) return;
    const at = this.now().toISOString();
    try {
      await this.saveExact({
        ...withoutStateRevision(prepared),
        phase: prepared.status === "queued" ? "queued" : "replanning",
        pendingEffect: null,
        checkpoint: pending.purpose === "assigned_question" &&
            prepared.checkpoint
          ? {
              ...structuredClone(prepared.checkpoint),
              waitingQuestionId: null,
              updatedAt: at,
            }
          : prepared.checkpoint ?? null,
        receipts: appendReceipt(prepared.receipts, {
          receiptId: `group-run-receipt-${this.id()}`,
          effectId: pending.effectId,
          effect: "whatsapp.message.send",
          purpose: pending.purpose,
          instructionRevision: pending.instructionRevision,
          preparedStateRevision: pending.preparedStateRevision,
          contentDigest: pending.contentDigest,
          subjectId: pendingDeliverySubjectId(pending),
          workAttemptId: pending.workAttemptId ?? null,
          authority: structuredClone(pending.authority),
          status: "not_committed",
          externalMessageId: null,
          committedAt: at,
          reversible: false,
        }),
        events: appendEvent(prepared.events, {
          id: `group-run-event-${this.id()}`,
          type: "delivery.not_committed",
          at,
          instructionRevision: pending.instructionRevision,
          sourceMessageId: null,
          participantId: pending.question?.assignee.participantId ?? null,
        }),
        updatedAt: at,
      }, prepared.stateRevision, async () => true);
    } catch {
      // Tidak ada efek eksternal; state yang berubah bersamaan tetap menang.
    }
  }

  private async deliveryFenceStatus(
    prepared: GroupAgentRun,
  ): Promise<"valid" | "authority_invalid" | "runtime_inactive"> {
    const pending = prepared.pendingEffect;
    if (!pending) return "authority_invalid";
    const current = await this.repository.load(prepared.runId);
    if (
      !current || current.stateRevision !== prepared.stateRevision ||
      JSON.stringify(current.pendingEffect) !== JSON.stringify(pending) ||
      Date.parse(current.expiresAt) <= this.now().getTime()
    ) return "authority_invalid";
    const activeAttempt = activeGroupRunWorkAttempt(current);
    if (pending.purpose === "final_result") {
      if (
        !pending.workAttemptId || pending.question !== null ||
        activeAttempt?.attemptId !== pending.workAttemptId ||
        activeAttempt.instructionRevision !== current.instructionRevision ||
        (current.result ?? null) !== null || current.anchor.messageId === null ||
        current.questions.some((question) => question.status === "open")
      ) return "authority_invalid";
    } else if (pending.purpose === "assigned_question") {
      if (!pending.question) return "authority_invalid";
      const checkpoint = current.checkpoint ?? null;
      if (pending.workAttemptId === null) {
        if (
          groupRunWorkAttempts(current).length > 0 ||
          checkpoint !== null
        ) return "authority_invalid";
      } else if (
        !activeAttempt || !checkpoint ||
        activeAttempt.attemptId !== pending.workAttemptId ||
        activeAttempt.instructionRevision !== current.instructionRevision ||
        checkpoint.attemptId !== pending.workAttemptId ||
        checkpoint.instructionRevision !== current.instructionRevision ||
        checkpoint.waitingQuestionId !== pending.question.questionId
      ) return "authority_invalid";
    } else if (pending.workAttemptId !== null) {
      return "authority_invalid";
    }
    const initiator = await this.runParticipantAuthority(
      current,
      current.initiator,
    );
    if (
      !initiator || initiator.role !== pending.authority.initiatorRole ||
      initiator.authorityEpoch !== pending.authority.authorityEpoch
    ) return "authority_invalid";
    if (!pending.question && pending.authority.assigneeRole !== null) {
      return "authority_invalid";
    }
    if (
      pending.question &&
      Date.parse(pending.question.expiresAt) <= this.now().getTime()
    ) {
      return "authority_invalid";
    }
    if (pending.question) {
      const assignee = await this.runParticipantAuthority(
        current,
        pending.question.assignee,
      );
      if (
        !assignee || assignee.role !== pending.authority.assigneeRole ||
        assignee.authorityEpoch !== pending.authority.authorityEpoch
      ) return "authority_invalid";
    }
    return await this.runtimeMutationAllowed(current.scopeKey, current.accountId)
      ? "valid"
      : "runtime_inactive";
  }

  private assertQuestionCanBePrepared(
    run: GroupAgentRun,
    attemptId: string | null,
    checkpoint: GroupRunExecutionCheckpoint | null,
    waitingQuestionId: string | null = null,
  ): void {
    const attempts = groupRunWorkAttempts(run);
    const activeAttempt = activeGroupRunWorkAttempt(run);
    if (
      isTerminalGroupAgentRunStatus(run.status) || run.status === "paused" ||
      run.pendingEffect || Date.parse(run.expiresAt) <= this.now().getTime() ||
      run.questions.some((question) => question.status === "open") ||
      run.questions.length >= MAX_QUESTIONS ||
      run.inputs.length >= MAX_NONTERMINAL_INPUTS
    ) throw new GroupAgentRunConflictError();
    if (attempts.length === 0) {
      if (
        attemptId !== null || checkpoint !== null ||
        (run.checkpoint ?? null) !== null
      ) throw new GroupAgentRunConflictError();
      return;
    }
    if (
      attemptId === null || checkpoint === null || activeAttempt === null ||
      activeAttempt.attemptId !== attemptId ||
      activeAttempt.instructionRevision !== run.instructionRevision
    ) throw new GroupAgentRunConflictError();
    this.checkpointForActiveAttempt(
      run,
      attemptId,
      checkpoint,
      waitingQuestionId,
    );
  }

  private checkpointForActiveAttempt(
    run: GroupAgentRun,
    attemptId: string,
    checkpoint: GroupRunExecutionCheckpoint,
    waitingQuestionId: string | null,
  ): GroupRunExecutionCheckpoint {
    const active = activeGroupRunWorkAttempt(run);
    if (
      run.status !== "running" || run.pendingEffect !== null ||
      run.questions.some((question) => question.status === "open") ||
      Date.parse(run.expiresAt) <= this.now().getTime() ||
      !active || active.attemptId !== attemptId ||
      active.instructionRevision !== run.instructionRevision ||
      checkpoint.version !== 1 || checkpoint.engine !== "group-model-v1" ||
      checkpoint.attemptId !== attemptId ||
      checkpoint.instructionRevision !== run.instructionRevision ||
      checkpoint.waitingQuestionId !== waitingQuestionId ||
      checkpoint.inputDigest !== groupRunExecutionInputDigest(run)
    ) throw new GroupAgentRunConflictError();
    return structuredClone(checkpoint);
  }

  private questionExpiry(
    run: GroupAgentRun,
    at: Date,
    requested: string | undefined,
  ): string {
    const expiresAt = requested ??
      new Date(at.getTime() + QUESTION_HORIZON_MS).toISOString();
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= at.getTime() ||
      Date.parse(expiresAt) > at.getTime() + QUESTION_HORIZON_MS ||
      Date.parse(expiresAt) > Date.parse(run.expiresAt)
    ) throw new Error("Horizon pertanyaan GroupAgentRun tidak sah.");
    return expiresAt;
  }

  private applyMessage(
    run: GroupAgentRun,
    message: GroupMessage,
    authority: GroupAuthoritySnapshot,
    decision: Extract<GroupRunPolicyDecision, { relation: "mutation" }>,
    acceptedAt: Date,
  ): GroupAgentRun {
    const at = acceptedAt.toISOString();
    const actor = participantFromMessage(message);
    const participants = addParticipant(run.participants, actor);
    const instructionRevision = decision.disposition === "applied"
      ? run.instructionRevision + 1
      : null;
    const input: GroupRunInput = {
      id: `group-run-input-${this.id()}`,
      sourceMessageId: safeKey(message.messageId, "sourceMessageId"),
      sourceIngressRevision: Number.isSafeInteger(message.ingressRevision)
        ? message.ingressRevision ?? null
        : null,
      actor,
      quotedMessageId: message.quotedMessageId ?? null,
      kind: decision.kind,
      disposition: decision.disposition,
      content: boundedText(message.text, 4_000, "input.content"),
      questionId: decision.questionId,
      assignedOverride: decision.assignedOverride,
      authorityRole: authority.role,
      authorityEpoch: authority.authorityEpoch,
      instructionRevision,
      receivedAt: at,
    };
    const next: GroupAgentRun = {
      ...structuredClone(run),
      stateRevision: run.stateRevision + 1,
      participants,
      inputs: [...run.inputs, input],
      updatedAt: at,
    };

    if (instructionRevision !== null) {
      next.instructionRevision = instructionRevision;
      next.changeSets = [...run.changeSets, {
        instructionRevision,
        kind: decision.kind,
        sourceMessageId: message.messageId,
        actorParticipantId: actor.participantId,
        receivedAt: at,
      }];
    }

    if (decision.kind === "answer" && decision.questionId) {
      const index = next.questions.findIndex(
        (question) =>
          question.questionId === decision.questionId && question.status === "open",
      );
      if (index < 0) throw new GroupAgentRunConflictError();
      next.questions[index] = {
        ...next.questions[index]!,
        status: "answered",
        answeredBy: actor,
        answerSourceMessageId: message.messageId,
        answeredAt: at,
      };
      next.status = "running";
      next.phase = "replanning";
      if (run.checkpoint?.waitingQuestionId === decision.questionId) {
        next.checkpoint = {
          ...structuredClone(run.checkpoint),
          waitingQuestionId: null,
          updatedAt: at,
        };
      }
    } else if (decision.kind === "cancel") {
      next.questions = next.questions.map((question) =>
        question.status === "open"
          ? { ...question, status: "cancelled" as const }
          : question
      );
      next.status = "cancelled";
      next.phase = "cancelled";
      next.workAttempts = activeGroupRunWorkAttempt(run)
        ? settleRunningGroupRunWorkAttempt(
            run,
            "cancelled",
            at,
            "run_cancelled",
          )
        : groupRunWorkAttempts(run);
      if (run.checkpoint && run.checkpoint.waitingQuestionId !== null) {
        next.checkpoint = {
          ...structuredClone(run.checkpoint),
          waitingQuestionId: null,
          updatedAt: at,
        };
      }
      next.completedAt = at;
    } else if (decision.disposition === "applied" && run.status === "running") {
      next.phase = "replanning";
    }

    next.events = appendEvent(run.events, {
      id: `group-run-event-${this.id()}`,
      type: decision.kind === "cancel"
        ? "run.cancelled"
        : decision.kind === "answer"
        ? "input.received"
        : decision.disposition === "proposal"
        ? "input.proposed"
        : "input.applied",
      at,
      instructionRevision: next.instructionRevision,
      sourceMessageId: message.messageId,
      participantId: actor.participantId,
    });
    return next;
  }

  private async resolveAuthority(
    message: GroupMessage,
  ): Promise<GroupAuthoritySnapshot | null> {
    try {
      return await this.authority.resolveGroupAuthority({
        scope: message.scope,
        accountId: message.accountId,
        participantIds: [
          ...new Set([message.participantId, ...message.participantAliases]),
        ],
        claimedAdmin: message.isAdmin,
        claimedAuthorityEpoch: message.authorityEpoch ?? 0,
      });
    } catch {
      return null;
    }
  }

  private async runtimeMutationAllowed(
    scopeKey: string,
    accountId: string,
  ): Promise<boolean> {
    try {
      return await this.runtimeAdmission({ scopeKey, accountId }) === true;
    } catch {
      return false;
    }
  }

  /**
   * Fence claim mengikat runtime exact binding dan authority live initiator
   * pada satu snapshot. Keduanya sengaja selalu direvalidasi agar resolver
   * failure/removal maupun perubahan epoch di dalam jendela CAS gagal tertutup.
   */
  private async claimFenceStatus(
    run: GroupAgentRun,
    expectedAuthority: GroupAuthoritySnapshot,
  ): Promise<"runtime_inactive" | "authority_invalid" | null> {
    const runtimeAllowed = await this.runtimeMutationAllowed(
      run.scopeKey,
      run.accountId,
    );
    const currentAuthority = await this.runParticipantAuthority(
      run,
      run.initiator,
    );
    if (!runtimeAllowed) return "runtime_inactive";
    return sameAuthority(expectedAuthority, currentAuthority)
      ? null
      : "authority_invalid";
  }

  private async assertClaimFence(
    run: GroupAgentRun,
    expectedAuthority: GroupAuthoritySnapshot,
  ): Promise<void> {
    const status = await this.claimFenceStatus(run, expectedAuthority);
    if (status === "runtime_inactive") {
      throw new GroupAgentRunRuntimeAdmissionError();
    }
    if (status === "authority_invalid") {
      throw new GroupAgentRunAuthorityError();
    }
  }

  private async loadExact(
    runId: string,
    expectedStateRevision: number,
  ): Promise<GroupAgentRun> {
    const run = await this.repository.load(runId);
    if (!run || run.stateRevision !== expectedStateRevision) {
      throw new GroupAgentRunConflictError();
    }
    return run;
  }

  private async saveExact(
    run: Omit<GroupAgentRun, "stateRevision">,
    expectedStateRevision: number,
    guard: () => Promise<boolean>,
    guardRejectedError?: () => Error,
  ): Promise<GroupAgentRun> {
    const saved = await this.repository.save(
      run,
      expectedStateRevision,
      guard,
    );
    if (saved.status === "guard-rejected" && guardRejectedError) {
      throw guardRejectedError();
    }
    if (saved.status !== "saved") throw new GroupAgentRunConflictError();
    return saved.run;
  }

  async purgeExpired(): Promise<number> {
    return this.repository.removeExpired(this.now());
  }

  /**
   * Menghapus semua state GroupAgentRun milik satu binding grup. Repository
   * memakai exact scope+account agar akun lain atau grup lain tidak terseret.
   */
  async forgetScope(scopeKey: string, accountId: string): Promise<number> {
    return this.repository.removeScope(scopeKey, accountId);
  }

  private async runParticipantAuthority(
    run: GroupAgentRun,
    participant: GroupRunParticipant,
  ): Promise<GroupAuthoritySnapshot | null> {
    try {
      const current = await this.authority.resolveGroupAuthority({
        scope: run.scope,
        accountId: run.accountId,
        participantIds: [
          participant.participantId,
          ...participant.identityAliases,
        ],
        claimedAdmin: false,
        claimedAuthorityEpoch: 0,
      });
      return current && validGroupAuthoritySnapshot(current) &&
          groupAuthorityAllows(current.role, "social.read")
        ? current
        : null;
    } catch {
      return null;
    }
  }

  private async expireForeground(
    scopeKey: string,
    accountId: string,
  ): Promise<GroupAgentRun | null> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const run = await this.repository.loadForeground(scopeKey, accountId);
      if (!run) return null;
      const now = this.now();
      const questionExpired = run.questions.some(
        (question) =>
          question.status === "open" && Date.parse(question.expiresAt) <= now.getTime(),
      );
      const pendingQuestionExpired = Boolean(
        run.pendingEffect?.question &&
          Date.parse(run.pendingEffect.question.expiresAt) <= now.getTime(),
      );
      const runExpired = Date.parse(run.expiresAt) <= now.getTime();
      if (!questionExpired && !pendingQuestionExpired && !runExpired) return run;
      const at = now.toISOString();
      const pending = run.pendingEffect;
      const activeAttempt = activeGroupRunWorkAttempt(run);
      const terminalEvent: GroupAgentRun["events"][number] = {
        id: `group-run-event-${this.id()}`,
        type: pending
          ? "delivery.unknown"
          : questionExpired ? "input.expired" : "run.expired",
        at,
        instructionRevision: run.instructionRevision,
        sourceMessageId: run.questions.find((question) =>
          question.status === "open"
        )?.messageId ?? null,
        participantId: null,
      };
      const next: Omit<GroupAgentRun, "stateRevision"> = {
        ...withoutStateRevision(run),
        status: pending ? "partial" : "failed",
        phase: "failed",
        pendingEffect: null,
        checkpoint: pending?.purpose === "assigned_question" && run.checkpoint
          ? {
              ...structuredClone(run.checkpoint),
              waitingQuestionId: null,
              updatedAt: at,
            }
          : questionExpired && run.checkpoint &&
              run.checkpoint.waitingQuestionId !== null
          ? {
              ...structuredClone(run.checkpoint),
              waitingQuestionId: null,
              updatedAt: at,
            }
          : run.checkpoint ?? null,
        workAttempts: activeAttempt
          ? settleRunningGroupRunWorkAttempt(
              run,
              "failed",
              at,
              pending
                ? "delivery_outcome_unknown"
                : questionExpired ? "input_expired" : "run_expired",
            )
          : groupRunWorkAttempts(run),
        receipts: pending
          ? appendReceipt(run.receipts, {
              receiptId: `group-run-receipt-${this.id()}`,
              effectId: pending.effectId,
              effect: "whatsapp.message.send",
              purpose: pending.purpose,
              instructionRevision: pending.instructionRevision,
              preparedStateRevision: pending.preparedStateRevision,
              contentDigest: pending.contentDigest,
              subjectId: pendingDeliverySubjectId(pending),
              workAttemptId: pending.workAttemptId ?? null,
              authority: structuredClone(pending.authority),
              status: "unknown",
              externalMessageId: null,
              committedAt: at,
              reversible: false,
            })
          : run.receipts,
        questions: run.questions.map((question) =>
          question.status === "open"
            ? { ...question, status: "expired" as const }
            : question
        ),
        events: pending
          ? appendDeliveryOutcomeEvent(run.events, terminalEvent)
          : activeAttempt
          ? appendWorkOutcomeEvent(run.events, terminalEvent)
          : appendEvent(run.events, terminalEvent),
        updatedAt: at,
        completedAt: at,
      };
      const saved = await this.repository.save(
        next,
        run.stateRevision,
        async () => true,
      );
      if (saved.status === "conflict") continue;
      if (saved.status === "saved") return saved.run;
      throw new GroupAgentRunConflictError();
    }
    throw new GroupAgentRunConflictError();
  }
}

function replayResult(
  run: GroupAgentRun,
  input: GroupRunInput,
  message: GroupMessage,
): RouteGroupAgentRunResult {
  if (
    !participantMatchesMessage(input.actor, message) ||
    input.content !== message.text.trim() ||
    input.quotedMessageId !== (message.quotedMessageId ?? null)
  ) throw new GroupAgentRunMessageCollisionError();
  return {
    status: input.kind === "cancel"
      ? "cancelled"
      : input.disposition === "proposal" ? "proposed" : "applied",
    run,
    replayed: true,
  };
}

function answerPassesIngressWatermark(
  run: GroupAgentRun,
  questionId: string,
  message: GroupMessage,
): boolean {
  const question = run.questions.find(
    (candidate) => candidate.questionId === questionId && candidate.status === "open",
  );
  return Boolean(
    question && Number.isSafeInteger(message.ingressRevision) &&
      (message.ingressRevision ?? 0) > question.acceptAnswersAfterIngressRevision,
  );
}

function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function checkpointMatchesQuestionReplay(
  stored: GroupRunExecutionCheckpoint | null,
  requested: GroupRunExecutionCheckpoint,
  attemptId: string,
  questionId: string,
): boolean {
  return Boolean(
    stored && stored.attemptId === attemptId &&
      stored.waitingQuestionId === questionId &&
      requested.attemptId === attemptId &&
      requested.waitingQuestionId === null &&
      stored.version === requested.version &&
      stored.engine === requested.engine &&
      stored.sequence === requested.sequence &&
      stored.instructionRevision === requested.instructionRevision &&
      stored.inputDigest === requested.inputDigest &&
      JSON.stringify(stored.budget) === JSON.stringify(requested.budget),
  );
}

function appendReceipt(
  receipts: GroupAgentRun["receipts"],
  receipt: GroupAgentRun["receipts"][number],
): GroupAgentRun["receipts"] {
  if (receipts.length >= MAX_RECEIPTS) {
    throw new GroupAgentRunConflictError();
  }
  return [...receipts, receipt];
}

function groupRunWorkAttempts(run: GroupAgentRun): GroupRunWorkAttempt[] {
  return structuredClone(run.workAttempts ?? []);
}

function activeGroupRunWorkAttempt(
  run: GroupAgentRun,
): GroupRunWorkAttempt | null {
  return groupRunWorkAttempts(run).find(
    (attempt) => attempt.status === "running",
  ) ?? null;
}

function settleRunningGroupRunWorkAttempt(
  run: GroupAgentRun,
  status: Extract<
    GroupRunWorkAttemptStatus,
    "failed" | "requeued" | "cancelled"
  >,
  settledAt: string,
  code: string,
): GroupRunWorkAttempt[] {
  const attempts = groupRunWorkAttempts(run);
  const active = attempts.filter((attempt) => attempt.status === "running");
  if (active.length !== 1) throw new GroupAgentRunConflictError();
  return attempts.map((attempt) =>
    attempt.attemptId === active[0]!.attemptId
      ? { ...attempt, status, settledAt, code: workAttemptCode(code) }
      : attempt
  );
}

function positiveStateRevision(value: unknown): number {
  const revision = nonNegativeIntegerValue(value, "expectedStateRevision");
  if (revision < 1) throw new Error("expectedStateRevision tidak sah.");
  return revision;
}

function workAttemptCode(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 120 ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(value)
  ) throw new Error("work.code tidak sah.");
  return value;
}

function nonNegativeIntegerValue(value: unknown, field: string): number {
  nonNegativeInteger(value, field);
  return value as number;
}

function mutationWindowOpen(
  run: GroupAgentRun,
  decision: Extract<GroupRunPolicyDecision, { relation: "mutation" }>,
  now: Date,
): boolean {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp) || Date.parse(run.expiresAt) <= timestamp) {
    return false;
  }
  const open = run.questions.find((question) => question.status === "open") ?? null;
  if (open && Date.parse(open.expiresAt) <= timestamp) return false;
  if (decision.kind !== "answer") return true;
  const question = run.questions.find((candidate) =>
    candidate.questionId === decision.questionId && candidate.status === "open"
  );
  return Boolean(question && Date.parse(question.expiresAt) > timestamp);
}

function singleRoutedMessage(
  message: GroupMessage,
  run: GroupAgentRun,
):
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "message"; message: GroupMessage } {
  const parts = message.parts ?? [];
  if (parts.length === 0) {
    return groupRunTarget(message, run, true) === "none"
      ? { status: "none" }
      : { status: "message", message };
  }
  const envelopes = parts.map((part): GroupMessage => ({
    ...message,
    messageId: part.messageId,
    text: part.text,
    at: part.at,
    mentionsHarvy: part.mentionsHarvy,
    repliesToHarvy: part.repliesToHarvy,
    quotedMessageId: part.quotedMessageId ?? null,
    quotedParticipantId: part.quotedParticipantId ?? null,
    parts: [structuredClone(part)],
    ...(part.ingressRevision === undefined
      ? {}
      : { ingressRevision: part.ingressRevision }),
  }));
  const targeted = envelopes.filter(
    (candidate) => groupRunTarget(candidate, run, true) !== "none",
  );
  if (targeted.length === 0) return { status: "none" };
  // Batcher tidak boleh mengubah beberapa bubble menjadi satu authority
  // envelope. Integrasi Phase K kelak merutekan bubble target sebelum merge.
  if (parts.length > 1) return { status: "ambiguous" };
  return { status: "message", message: targeted[0]! };
}

function sameStartEnvelope(
  run: GroupAgentRun,
  message: GroupMessage,
  request: string,
): boolean {
  return run.startSourceMessageId === message.messageId &&
    run.accountId === message.accountId &&
    run.initialRequest === request &&
    participantMatchesMessage(run.initiator, message);
}

function participantMatchesMessage(
  participant: GroupRunParticipant,
  message: GroupMessage,
): boolean {
  const source = new Set([message.participantId, ...message.participantAliases]);
  return [participant.participantId, ...participant.identityAliases].some(
    (identity) => source.has(identity),
  );
}

function participantFromMessage(message: GroupMessage): GroupRunParticipant {
  return normalizedParticipant({
    participantId: message.participantId,
    identityAliases: message.participantAliases,
    displayName: message.participantName,
  });
}

function normalizedParticipant(
  participant: GroupRunParticipant,
): GroupRunParticipant {
  const participantId = safeKey(participant.participantId, "participantId");
  const identityAliases = [...new Set(participant.identityAliases)]
    .filter((alias) => alias !== participantId)
    .map((alias) => safeKey(alias, "participantAlias"));
  if (identityAliases.length > 8) {
    throw new Error("Terlalu banyak alias participant GroupAgentRun.");
  }
  const displayName = participant.displayName?.replace(/\s+/gu, " ").trim() ||
    null;
  return {
    participantId,
    identityAliases,
    displayName: displayName ? displayName.slice(0, 120) : null,
  };
}

function addParticipant(
  current: readonly GroupRunParticipant[],
  candidate: GroupRunParticipant,
): GroupRunParticipant[] {
  const candidateIds = new Set([
    candidate.participantId,
    ...candidate.identityAliases,
  ]);
  if (current.some((participant) =>
    [participant.participantId, ...participant.identityAliases].some(
      (identity) => candidateIds.has(identity),
    )
  )) return structuredClone([...current]);
  if (current.length >= MAX_PARTICIPANTS) {
    throw new Error("Batas participant GroupAgentRun tercapai.");
  }
  return [...structuredClone([...current]), structuredClone(candidate)];
}

function deliveryAuthorityExpectation(
  run: GroupAgentRun,
): GroupRunDeliveryAuthorityExpectation {
  const pending = run.pendingEffect;
  if (!pending) throw new GroupAgentRunConflictError();
  const actors: GroupRunDeliveryActorExpectation[] = [{
    participantIds: participantAuthorityIds(run.initiator),
    expectedRole: pending.authority.initiatorRole,
  }];
  if (pending.question) {
    if (!pending.authority.assigneeRole) {
      throw new GroupAgentRunAuthorityError();
    }
    actors.push({
      participantIds: participantAuthorityIds(pending.question.assignee),
      expectedRole: pending.authority.assigneeRole,
    });
  } else if (pending.authority.assigneeRole !== null) {
    throw new GroupAgentRunAuthorityError();
  }
  return {
    expectedAuthorityEpoch: pending.authority.authorityEpoch,
    actors,
  };
}

function pendingDeliverySubjectId(
  pending: NonNullable<GroupAgentRun["pendingEffect"]>,
): string | null {
  if (pending.purpose === "assigned_question") {
    return pending.question?.questionId ?? null;
  }
  if (pending.purpose === "final_result") {
    return pending.workAttemptId ?? null;
  }
  return null;
}

function participantAuthorityIds(
  participant: GroupRunParticipant,
): readonly string[] {
  return [participant.participantId, ...participant.identityAliases];
}

function sameAuthority(
  left: GroupAuthoritySnapshot | null,
  right: GroupAuthoritySnapshot | null,
): right is GroupAuthoritySnapshot {
  return Boolean(
    left && right && left.role === right.role &&
      left.authorityEpoch === right.authorityEpoch,
  );
}

function validGroupAuthoritySnapshot(
  authority: GroupAuthoritySnapshot,
): boolean {
  return (authority.role === "member" || authority.role === "admin") &&
    Number.isSafeInteger(authority.authorityEpoch) &&
    authority.authorityEpoch >= 0;
}

function sameDecision(
  left: GroupRunPolicyDecision,
  right: GroupRunPolicyDecision,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendEvent(
  events: GroupAgentRun["events"],
  event: GroupAgentRun["events"][number],
): GroupAgentRun["events"] {
  if (events.length >= MAX_EVENTS) {
    throw new Error("Batas event GroupAgentRun tercapai.");
  }
  return [...events, event];
}

/**
 * Recovery harus tetap bisa menutup intent legacy yang sudah memenuhi ledger.
 * Pada cap exact, event prepared terakhir diganti outcome unknown; run baru
 * mereservasi dua slot sehingga jalur emergency ini tidak dipakai pre-send.
 */
function appendDeliveryOutcomeEvent(
  events: GroupAgentRun["events"],
  event: GroupAgentRun["events"][number],
): GroupAgentRun["events"] {
  if (events.length < MAX_EVENTS) return [...events, event];
  if (
    events.length === MAX_EVENTS && event.type === "delivery.unknown" &&
    events.at(-1)?.type === "delivery.prepared"
  ) return [...events.slice(0, -1), event];
  throw new Error("Batas event GroupAgentRun tercapai.");
}

function appendWorkOutcomeEvent(
  events: GroupAgentRun["events"],
  event: GroupAgentRun["events"][number],
): GroupAgentRun["events"] {
  if (events.length < MAX_EVENTS) return [...events, event];
  if (
    events.length === MAX_EVENTS && events.at(-1)?.type === "work.claimed" &&
    (event.type === "work.failed" || event.type === "work.requeued" ||
      event.type === "work.recovered" || event.type === "run.expired")
  ) return [...events.slice(0, -1), event];
  throw new Error("Batas event GroupAgentRun tercapai.");
}

function withoutStateRevision(
  run: GroupAgentRun,
): Omit<GroupAgentRun, "stateRevision"> {
  const { stateRevision: _stateRevision, ...draft } = structuredClone(run);
  return draft;
}

function titleFor(value: string): string {
  const clean = boundedText(value, 8_000, "title").replace(/\s+/gu, " ").trim();
  return clean.length <= 80 ? clean : `${clean.slice(0, 77).trimEnd()}…`;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} tidak sah.`);
  const clean = value.trim();
  if (
    !clean || clean.length > maximum ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(clean)
  ) throw new Error(`${field} tidak sah.`);
  return clean;
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${field} tidak sah.`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} tidak sah.`);
  }
  return value as number;
}
