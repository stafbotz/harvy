import { randomUUID } from "node:crypto";
import type {
  ActiveAgentRun,
  ActiveAgentRunAnswer,
  ActiveAgentRunExport,
  ActiveAgentRunQuestion,
  AgentRunContextSnapshot,
  AgentRunEffectPurpose,
  AgentRunWorkUnit,
  AgentRunRepository,
  DurableAgentIntent,
  DurableAgentMode,
  DurableAgentRun,
  DurableAgentRunExport,
  NewDurableAgentRun,
  NewActiveAgentRun,
  RunChangeSet,
  RunChangeSetKind,
  RunMailboxMessage,
  RunMailboxMessageKind,
} from "../domain/agent-run.js";
import type { StylePreference } from "../domain/profile.js";
import {
  hasRetrievedMemoryProvenance,
  isRetrievedMemorySource,
} from "../domain/memory-knowledge.js";
import {
  isValidAgentRunCheckpoint,
  type AgentRunCheckpoint,
  type AgentRunResult,
  type AgentUserInput,
} from "../harness/agent-harness.js";
import {
  privateAgentScope,
  scopeKey,
  type AgentChannel,
} from "../harness/scope.js";

const MAX_DURABLE_CHECKPOINT_CHARACTERS = 100_000;
const ACTIVE_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_REQUEST_CHARACTERS = 8_000;
const MAX_MAILBOX_CONTENT_CHARACTERS = 4_000;
const MAX_MAILBOX_MESSAGES = 64;
const MAX_PENDING_INSTRUCTION_INPUTS = 16;
const MAX_PENDING_INSTRUCTION_CHECKPOINT_CHARACTERS = 70_000;
const MAX_ACTIVE_RESULT_CHARACTERS = 8_000;

export interface StartActiveAgentRunInput {
  channel: AgentChannel;
  ownerId: string;
  request: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  timeZone: string;
  style: StylePreference | null;
  context: AgentRunContextSnapshot;
  chatId: string;
  turnId: string;
}

export type StartActiveAgentRunResult =
  | { status: "started"; run: ActiveAgentRun }
  | { status: "foreground_exists"; run: ActiveAgentRun };

export interface ActiveAgentRunAttempt {
  run: ActiveAgentRun;
  inputRevision: number;
  checkpoint?: AgentRunCheckpoint;
  answer?: string;
  initialUserInputs?: AgentUserInput[];
}

export interface RouteActiveAgentRunMessageInput {
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  kind: RunMailboxMessageKind;
  content: string;
  sourceMessageId: string;
  receivedAt?: Date;
  questionId?: string;
  ingressUpdateId?: number;
}

export type RouteActiveAgentRunMessageResult =
  | {
      status: "accepted";
      run: ActiveAgentRun;
      committedEffects: number;
    }
  | { status: "duplicate"; run: ActiveAgentRun }
  | { status: "conflict"; run: ActiveAgentRun }
  | { status: "capacity_exceeded"; run: ActiveAgentRun }
  | { status: "not_applicable"; run: ActiveAgentRun | null };

export interface ActiveAgentRunDelivery {
  /** Semua delivery ID yang menjadi receipt efek ini. */
  externalId: string;
  /** Pesan yang harus di-quote untuk mengikat jawaban, bila berbeda. */
  bindingExternalId?: string;
}

export interface CommitActiveQuestionInput {
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  inputRevision: number;
  checkpoint: AgentRunCheckpoint;
  prompt: string;
  acceptAnswersAfterUpdateId: number;
}

export interface CommitActiveFinalInput {
  channel: AgentChannel;
  ownerId: string;
  runId: string;
  inputRevision: number;
  checkpoint: AgentRunCheckpoint;
  reply: string;
}

export class ActiveAgentRunStaleError extends Error {
  constructor() {
    super("Hasil run aktif berasal dari revisi instruksi yang sudah basi.");
    this.name = "ActiveAgentRunStaleError";
  }
}

export class ActiveAgentRunUnavailableError extends Error {
  constructor() {
    super("Adapter penyimpanan active AgentRun belum tersedia.");
    this.name = "ActiveAgentRunUnavailableError";
  }
}

export interface SaveWaitingAgentRunInput {
  channel: AgentChannel;
  ownerId: string;
  request: string;
  mode: DurableAgentMode;
  intent: DurableAgentIntent;
  acceptAnswersAfterUpdateId: number;
  checkpoint: AgentRunCheckpoint;
  expectedRevision: number | null;
}

export class AgentRunConflictError extends Error {
  constructor() {
    super("Checkpoint agent sudah berubah; hasil lama tidak boleh menimpanya.");
    this.name = "AgentRunConflictError";
  }
}

export class AgentRunBlockedError extends Error {
  constructor() {
    super("Penyimpanan run agent diblokir selama penghapusan data.");
    this.name = "AgentRunBlockedError";
  }
}

/**
 * Aturan lifecycle checkpoint durable yang tetap bebas dari Telegram dan I/O
 * konkret. Record v1 hanya memegang `waiting_input`; record v2 memegang work
 * lane aktif, mailbox, freshness gate, commit barrier, dan recovery eksplisit.
 */
export class AgentRunService {
  private readonly blockedScopes = new Set<string>();
  private readonly activeQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: AgentRunRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = () => randomUUID(),
  ) {}

  async startActive(
    input: StartActiveAgentRunInput,
  ): Promise<StartActiveAgentRunResult> {
    const key = privateScopeKey(input.channel, input.ownerId);
    return this.withActiveQueue(key, async () => {
      this.assertScopeWritable(key);
      const repository = this.activeRepository();
      const existing = await repository.loadActive!(key);
      this.assertScopeWritable(key);
      if (existing && !isTerminalActiveRun(existing)) {
        return { status: "foreground_exists", run: structuredClone(existing) };
      }
      const moment = this.now();
      const legacy = await this.repository.load(key);
      if (legacy) {
        if (Date.parse(legacy.expiresAt) > moment.getTime()) {
          throw new AgentRunConflictError();
        }
        const removed = await this.repository.remove(
          key,
          legacy.runId,
          legacy.revision,
        );
        if (removed === "conflict") throw new AgentRunConflictError();
      }
      this.assertScopeWritable(key);
      const at = moment.toISOString();
      const request = boundedRequiredText(
        input.request,
        MAX_ACTIVE_REQUEST_CHARACTERS,
        "Permintaan active AgentRun tidak sah.",
      );
      const runId = boundedRequiredText(
        this.makeId(),
        200,
        "Run ID active AgentRun tidak sah.",
      );
      const draft: NewActiveAgentRun = {
        version: 2,
        scopeKey: key,
        channel: input.channel,
        ownerId: input.ownerId,
        runId,
        initialRequest: request,
        mode: input.mode,
        intent: input.intent,
        timeZone: boundedRequiredText(
          input.timeZone,
          100,
          "Zona waktu active AgentRun tidak sah.",
        ),
        style: input.style,
        status: "queued",
        phase: "queued",
        contextRevision: 1,
        instructionRevision: 1,
        appliedInstructionRevision: 1,
        context: boundedContextSnapshot(input.context),
        mailbox: [],
        changeSets: [],
        workUnits: [{
          id: `planner:${runId}:1`,
          role: "planner",
          label: "Menyusun pekerjaan",
          status: "queued",
          inputRevision: 1,
        }],
        events: [
          activeEvent(this.makeId(), "context.started", at, 1),
          activeEvent(this.makeId(), "context.completed", at, 1),
        ],
        receipts: [],
        anchor: {
          platform: input.channel,
          chatId: boundedRequiredText(
            input.chatId,
            100,
            "Chat ID Run Anchor tidak sah.",
          ),
          messageId: null,
          updatedAt: at,
        },
        checkpoint: null,
        pendingQuestion: null,
        resumeAnswer: null,
        pendingEffect: null,
        result: null,
        lastError: null,
        turnId: boundedRequiredText(
          input.turnId,
          200,
          "Turn ID active AgentRun tidak sah.",
        ),
        createdAt: at,
        startedAt: null,
        updatedAt: at,
        completedAt: null,
        expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
          .toISOString(),
      };
      const saved = await repository.saveActive!(draft, null);
      this.assertScopeWritable(key);
      if (saved.status === "conflict") throw new AgentRunConflictError();
      return { status: "started", run: structuredClone(saved.run) };
    });
  }

  async loadActive(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<ActiveAgentRun | null> {
    // Adapter v1 tetap sah untuk jalur checkpoint legacy. Pemeriksaan mailbox
    // di ingress harus memperlakukannya sebagai "tidak ada run aktif", bukan
    // menggagalkan seluruh giliran sebelum jalur legacy sempat berjalan.
    if (!hasActiveRepository(this.repository)) return null;
    const key = privateScopeKey(channel, ownerId);
    if (this.blockedScopes.has(key)) return null;
    const repository = this.activeRepository();
    let run = await repository.loadActive!(key);
    if (this.blockedScopes.has(key)) return null;
    if (run && Date.parse(run.expiresAt) <= this.now().getTime()) {
      const removed = await repository.removeActive!(
        key,
        run.runId,
        run.revision,
      );
      if (removed === "conflict") {
        run = await repository.loadActive!(key);
        if (run && Date.parse(run.expiresAt) > this.now().getTime()) {
          return structuredClone(run);
        }
      }
      return null;
    }
    return run ? structuredClone(run) : null;
  }

  async loadForegroundActive(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<ActiveAgentRun | null> {
    const run = await this.loadActive(channel, ownerId);
    return run && !isTerminalActiveRun(run) ? run : null;
  }

  /**
   * Menutup waiting state yang melewati deadline pada ingress berikutnya.
   * Return hanya berisi transisi baru agar adapter dapat menyegarkan Anchor.
   */
  async expireWaitingActive(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<ActiveAgentRun | null> {
    if (!hasActiveRepository(this.repository)) return null;
    const key = privateScopeKey(channel, ownerId);
    if (this.blockedScopes.has(key)) return null;
    return this.withActiveQueue(key, async () => {
      if (this.blockedScopes.has(key)) return null;
      const current = await this.activeRepository().loadActive!(key);
      if (
        !current ||
        current.status !== "waiting_input" ||
        !current.pendingQuestion
      ) {
        return null;
      }
      const moment = this.now();
      if (Date.parse(current.pendingQuestion.expiresAt) > moment.getTime()) {
        return null;
      }
      const at = moment.toISOString();
      return this.saveActive(withoutRevision({
        ...current,
        status: "failed",
        phase: "failed",
        checkpoint: terminalCheckpoint(current.checkpoint),
        pendingQuestion: null,
        resumeAnswer: null,
        lastError: { stage: "recovery", code: "input_expired", at },
        completedAt: at,
        updatedAt: at,
        expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
          .toISOString(),
        workUnits: current.workUnits.map((unit) =>
          unit.status === "waiting"
            ? { ...unit, status: "failed" as const }
            : unit
        ),
        events: appendBounded(
          current.events,
          activeEvent(
            this.makeId(),
            "run.failed",
            at,
            current.instructionRevision,
          ),
          160,
        ),
      }), current.revision);
    });
  }

  async attachActiveAnchor(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
    messageId: string,
  ): Promise<ActiveAgentRun> {
    const key = privateScopeKey(channel, ownerId);
    return this.mutateActive(key, runId, (run, at) => ({
      ...run,
      anchor: {
        ...run.anchor,
        messageId: boundedRequiredText(
          messageId,
          100,
          "Message ID Run Anchor tidak sah.",
        ),
        updatedAt: at,
      },
      updatedAt: at,
    }));
  }

  async beginActiveAttempt(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
  ): Promise<ActiveAgentRunAttempt | null> {
    const key = privateScopeKey(channel, ownerId);
    return this.withActiveQueue(key, async () => {
      this.assertScopeWritable(key);
      const current = await this.requireActive(key, runId);
      if (
        isTerminalActiveRun(current) ||
        current.pendingEffect ||
        (current.status === "waiting_input" && !current.resumeAnswer)
      ) {
        return null;
      }
      let checkpoint = current.checkpoint
        ? structuredClone(current.checkpoint)
        : undefined;
      let appliedInstructionRevision = current.appliedInstructionRevision;
      const answer = current.resumeAnswer?.text;
      const initialUserInputs = !checkpoint
        ? instructionInputsAfter(
            current,
            appliedInstructionRevision,
            0,
          )
        : [];
      if (
        checkpoint &&
        !answer &&
        appliedInstructionRevision < current.instructionRevision
      ) {
        checkpoint = rebaseCheckpoint(current, checkpoint);
        appliedInstructionRevision = current.instructionRevision;
      }
      const moment = this.now();
      const at = moment.toISOString();
      const firstAttempt = current.startedAt === null;
      const workUnit: AgentRunWorkUnit = {
        id: `planner:${current.runId}:${current.instructionRevision}`,
        role: "planner",
        label: firstAttempt ? "Menyusun pekerjaan" : "Menyesuaikan pekerjaan",
        status: "running",
        inputRevision: current.instructionRevision,
      };
      const next = withoutRevision({
        ...current,
        status: "running",
        phase: firstAttempt ? "planning" : "replanning",
        appliedInstructionRevision,
        checkpoint: checkpoint ?? null,
        startedAt: current.startedAt ?? at,
        updatedAt: at,
        lastError: null,
        workUnits: appendBounded(
          current.workUnits.filter((unit) => unit.id !== workUnit.id),
          workUnit,
          24,
        ),
        events: appendBounded(
          current.events,
          activeEvent(
            this.makeId(),
            firstAttempt ? "run.started" : "replanning.started",
            at,
            current.instructionRevision,
            workUnit.id,
          ),
          160,
        ),
      });
      const saved = await this.saveActive(next, current.revision);
      return {
        run: structuredClone(saved),
        inputRevision: saved.instructionRevision,
        ...(checkpoint ? { checkpoint: structuredClone(checkpoint) } : {}),
        ...(answer ? { answer } : {}),
        ...(initialUserInputs.length > 0
          ? { initialUserInputs: structuredClone(initialUserInputs) }
          : {}),
      };
    });
  }

  async isActiveAttemptCurrent(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
    inputRevision: number,
  ): Promise<boolean> {
    const key = privateScopeKey(channel, ownerId);
    if (this.blockedScopes.has(key)) return false;
    const run = await this.activeRepository().loadActiveByRunId!(runId);
    if (this.blockedScopes.has(key)) return false;
    return Boolean(
      run &&
      run.scopeKey === key &&
      run.status === "running" &&
      run.instructionRevision === inputRevision &&
      run.pendingEffect === null,
    );
  }

  async requeueStaleActive(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
    inputRevision: number,
    checkpoint: AgentRunCheckpoint,
  ): Promise<ActiveAgentRun | null> {
    const key = privateScopeKey(channel, ownerId);
    return this.withActiveQueue(key, async () => {
      const current = await this.requireActive(key, runId);
      if (isTerminalActiveRun(current)) return null;
      const at = this.now().toISOString();
      const hasNewInstruction = current.instructionRevision !== inputRevision;
      const next = withoutRevision({
        ...current,
        checkpoint: validateActiveCheckpointForRun(current, checkpoint),
        appliedInstructionRevision: Math.max(
          current.appliedInstructionRevision,
          inputRevision,
        ),
        status: hasNewInstruction ? "queued" : "paused",
        phase: hasNewInstruction ? "replanning" : "checking",
        updatedAt: at,
        lastError: hasNewInstruction
          ? null
          : { stage: "checkpoint", code: "stale_without_revision", at },
        workUnits: current.workUnits.map((unit) =>
          unit.inputRevision === inputRevision && unit.status === "running"
            ? { ...unit, status: "stale" as const }
            : unit
        ),
        events: hasNewInstruction
          ? appendBounded(
              current.events,
              activeEvent(
                this.makeId(),
                "replanning.started",
                at,
                current.instructionRevision,
              ),
              160,
            )
          : current.events,
      });
      return this.saveActive(next, current.revision);
    });
  }

  async routeActiveMessage(
    input: RouteActiveAgentRunMessageInput,
  ): Promise<RouteActiveAgentRunMessageResult> {
    const key = privateScopeKey(input.channel, input.ownerId);
    return this.withActiveQueue(key, async () => {
      this.assertScopeWritable(key);
      const current = await this.activeRepository().loadActiveByRunId!(
        input.runId,
      );
      if (!current || current.scopeKey !== key) {
        return { status: "not_applicable", run: current ?? null };
      }
      const content = boundedRequiredText(
        input.content,
        MAX_MAILBOX_CONTENT_CHARACTERS,
        "Isi RunMailbox tidak sah.",
      );
      const sourceMessageId = boundedRequiredText(
        input.sourceMessageId,
        200,
        "Source message RunMailbox tidak sah.",
      );
      const questionId = input.questionId ?? null;
      const priorMessages = current.mailbox.filter(
        (message) => message.sourceMessageId === sourceMessageId,
      );
      if (priorMessages.length > 0) {
        const replayMatches = priorMessages.every((message) =>
          message.kind === input.kind &&
          message.content === content &&
          message.questionId === questionId
        );
        return {
          status: replayMatches ? "duplicate" : "conflict",
          run: structuredClone(current),
        };
      }
      if (isTerminalActiveRun(current)) {
        return { status: "not_applicable", run: structuredClone(current) };
      }
      const moment = input.receivedAt ?? this.now();
      const at = moment.toISOString();
      if (!Number.isFinite(moment.getTime())) {
        throw new Error("Waktu RunMailbox tidak sah.");
      }
      if (input.kind === "answer") {
        if (
          current.status !== "waiting_input" ||
          !current.pendingQuestion ||
          Date.parse(current.pendingQuestion.expiresAt) <= moment.getTime() ||
          input.questionId !== current.pendingQuestion.questionId ||
          !Number.isSafeInteger(input.ingressUpdateId) ||
          input.ingressUpdateId! <=
            current.pendingQuestion.acceptAnswersAfterUpdateId
        ) {
          return { status: "not_applicable", run: structuredClone(current) };
        }
      }
      const instructionRevision = current.instructionRevision + 1;
      const changeKind = mailboxChangeKind(input.kind);
      const affectedWorkUnits = input.kind === "answer" || input.kind === "cancel"
        ? []
        : current.workUnits
          .filter((unit) =>
            unit.status === "queued" ||
            unit.status === "running" ||
            unit.status === "waiting" ||
            unit.status === "completed"
          )
          .map((unit) => unit.id);
      const message: RunMailboxMessage = {
        id: this.makeId(),
        runId: current.runId,
        kind: input.kind,
        content,
        sourceMessageId,
        receivedAt: at,
        questionId,
      };
      const changeSet: RunChangeSet = {
        revision: instructionRevision,
        kind: changeKind,
        sourceMessageId,
        affectedWorkUnits,
        receivedAt: at,
      };
      const appended = appendMailboxChange(current, message, changeSet);
      if (!appended) {
        return {
          status: "capacity_exceeded",
          run: structuredClone(current),
        };
      }
      const { mailbox, changeSets } = appended;
      const candidateRun: ActiveAgentRun = {
        ...current,
        instructionRevision,
        mailbox,
        changeSets,
      };
      if (
        input.kind !== "answer" &&
        input.kind !== "cancel" &&
        !pendingInstructionsFitCheckpoint(candidateRun)
      ) {
        return {
          status: "capacity_exceeded",
          run: structuredClone(current),
        };
      }

      let next: NewActiveAgentRun;
      if (input.kind === "cancel") {
        next = withoutRevision({
          ...current,
          instructionRevision,
          status: "cancelled",
          phase: "cancelled",
          checkpoint: terminalCheckpoint(current.checkpoint),
          mailbox,
          changeSets,
          pendingQuestion: null,
          resumeAnswer: null,
          completedAt: at,
          updatedAt: at,
          expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
            .toISOString(),
          workUnits: current.workUnits.map((unit) =>
            unit.status === "running" ||
              unit.status === "queued" ||
              unit.status === "waiting"
              ? { ...unit, status: "stale" as const }
              : unit
          ),
          events: appendBounded(
            current.events,
            activeEvent(this.makeId(), "run.cancelled", at, instructionRevision),
            160,
          ),
        });
      } else if (input.kind === "answer") {
        const question = current.pendingQuestion!;
        const resumeAnswer: ActiveAgentRunAnswer = {
          questionId: question.questionId,
          sourceMessageId,
          text: content,
          receivedAt: at,
        };
        next = withoutRevision({
          ...current,
          instructionRevision,
          status: "queued",
          phase: "replanning",
          mailbox,
          changeSets,
          resumeAnswer,
          workUnits: current.workUnits.map((unit) =>
            unit.status === "waiting"
              ? { ...unit, status: "stale" as const }
              : unit
          ),
          updatedAt: at,
          events: appendBounded(
            current.events,
            activeEvent(this.makeId(), "input.received", at, instructionRevision),
            160,
          ),
        });
      } else {
        next = withoutRevision({
          ...current,
          instructionRevision,
          status: current.status === "running" ? "running" : "queued",
          phase: "replanning",
          mailbox,
          changeSets,
          pendingQuestion: null,
          resumeAnswer: null,
          updatedAt: at,
          workUnits: current.workUnits.map((unit) =>
            affectedWorkUnits.includes(unit.id)
              ? { ...unit, status: "stale" as const }
              : unit
          ),
          events: appendBounded(
            current.events,
            activeEvent(
              this.makeId(),
              "replanning.started",
              at,
              instructionRevision,
            ),
            160,
          ),
        });
      }
      const saved = await this.saveActive(next, current.revision);
      return {
        status: "accepted",
        run: structuredClone(saved),
        committedEffects: current.receipts.filter(
          (receipt) => receipt.status === "committed",
        ).length,
      };
    });
  }

  async commitActiveQuestion(
    input: CommitActiveQuestionInput,
    deliver: () => Promise<ActiveAgentRunDelivery>,
  ): Promise<ActiveAgentRun> {
    const key = privateScopeKey(input.channel, input.ownerId);
    return this.withActiveQueue(key, async () => {
      this.assertScopeWritable(key);
      const current = await this.requireFreshActive(
        key,
        input.runId,
        input.inputRevision,
      );
      const checkpoint = validateActiveCheckpointForRun(
        current,
        input.checkpoint,
      );
      if (
        checkpoint.pendingInput === null ||
        checkpoint.pendingInput.prompt !== input.prompt ||
        !Number.isSafeInteger(input.acceptAnswersAfterUpdateId) ||
        input.acceptAnswersAfterUpdateId < 0
      ) {
        throw new Error("Pertanyaan active AgentRun tidak cocok dengan checkpoint.");
      }
      const prompt = boundedRequiredText(
        input.prompt,
        MAX_ACTIVE_RESULT_CHARACTERS,
        "Prompt active AgentRun tidak sah.",
      );
      const at = this.now().toISOString();
      const question: ActiveAgentRunQuestion = {
        questionId: this.makeId(),
        prompt,
        askedAt: at,
        expiresAt: checkpoint.deadlineAt,
        acceptAnswersAfterUpdateId: input.acceptAnswersAfterUpdateId,
        messageId: null,
      };
      const effectId = this.makeId();
      const prepared = await this.saveActive(withoutRevision({
        ...current,
        phase: "finalizing",
        checkpoint,
        pendingQuestion: question,
        pendingEffect: {
          effectId,
          purpose: "question",
          instructionRevision: input.inputRevision,
          preparedAt: at,
        },
        appliedInstructionRevision: input.inputRevision,
        updatedAt: at,
        events: appendBounded(
          current.events,
          activeEvent(
            this.makeId(),
            "planning.completed",
            at,
            input.inputRevision,
          ),
          160,
        ),
      }), current.revision);
      try {
        this.assertScopeWritable(key);
        const delivered = await deliver();
        this.assertScopeWritable(key);
        const committedAt = this.now().toISOString();
        return await this.saveActive(withoutRevision({
          ...prepared,
          status: "waiting_input",
          phase: "waiting_input",
          pendingEffect: null,
          pendingQuestion: {
            ...question,
            messageId: boundedRequiredText(
              delivered.bindingExternalId ?? delivered.externalId,
              100,
              "External message ID active AgentRun tidak sah.",
            ),
          },
          resumeAnswer: null,
          receipts: appendBounded(prepared.receipts, {
            receiptId: this.makeId(),
            effectId,
            effect: privateMessageSendEffect(prepared.channel),
            purpose: "question",
            instructionRevision: input.inputRevision,
            status: "committed",
            externalId: delivered.externalId,
            committedAt,
            reversible: false,
          }, 48),
          workUnits: markPlannerUnits(
            prepared.workUnits,
            input.inputRevision,
            "waiting",
          ),
          events: appendBounded(
            prepared.events,
            activeEvent(
              this.makeId(),
              "input.required",
              committedAt,
              input.inputRevision,
            ),
            160,
          ),
          updatedAt: committedAt,
        }), prepared.revision);
      } catch (error) {
        await this.persistUnknownDelivery(prepared, effectId, "question");
        throw error;
      }
    });
  }

  async commitActiveFinal(
    input: CommitActiveFinalInput,
    deliver: () => Promise<ActiveAgentRunDelivery>,
  ): Promise<ActiveAgentRun> {
    const key = privateScopeKey(input.channel, input.ownerId);
    return this.withActiveQueue(key, async () => {
      this.assertScopeWritable(key);
      const current = await this.requireFreshActive(
        key,
        input.runId,
        input.inputRevision,
      );
      const checkpoint = validateActiveCheckpointForRun(
        current,
        input.checkpoint,
      );
      const reply = boundedRequiredText(
        input.reply,
        MAX_ACTIVE_RESULT_CHARACTERS,
        "Hasil active AgentRun tidak sah.",
      );
      const at = this.now().toISOString();
      const effectId = this.makeId();
      const prepared = await this.saveActive(withoutRevision({
        ...current,
        phase: "finalizing",
        checkpoint,
        pendingQuestion: null,
        resumeAnswer: null,
        pendingEffect: {
          effectId,
          purpose: "final",
          instructionRevision: input.inputRevision,
          preparedAt: at,
        },
        appliedInstructionRevision: input.inputRevision,
        updatedAt: at,
        events: appendBounded(
          appendBounded(
            current.events,
            activeEvent(
              this.makeId(),
              "planning.completed",
              at,
              input.inputRevision,
            ),
            160,
          ),
          activeEvent(
            this.makeId(),
            "finalizing.started",
            at,
            input.inputRevision,
          ),
          160,
        ),
      }), current.revision);
      try {
        this.assertScopeWritable(key);
        const delivered = await deliver();
        this.assertScopeWritable(key);
        const committedAtDate = this.now();
        const committedAt = committedAtDate.toISOString();
        return await this.saveActive(withoutRevision({
          ...prepared,
          status: "completed",
          phase: "completed",
          pendingEffect: null,
          result: {
            kind: "final",
            text: reply,
            instructionRevision: input.inputRevision,
            completedAt: committedAt,
          },
          receipts: appendBounded(prepared.receipts, {
            receiptId: this.makeId(),
            effectId,
            effect: privateMessageSendEffect(prepared.channel),
            purpose: "final",
            instructionRevision: input.inputRevision,
            status: "committed",
            externalId: delivered.externalId,
            committedAt,
            reversible: false,
          }, 48),
          workUnits: markPlannerUnits(
            prepared.workUnits,
            input.inputRevision,
            "completed",
          ),
          events: appendBounded(
            prepared.events,
            activeEvent(
              this.makeId(),
              "run.completed",
              committedAt,
              input.inputRevision,
            ),
            160,
          ),
          completedAt: committedAt,
          updatedAt: committedAt,
          expiresAt: new Date(
            committedAtDate.getTime() + ACTIVE_RUN_RETENTION_MS,
          ).toISOString(),
        }), prepared.revision);
      } catch (error) {
        await this.persistUnknownDelivery(prepared, effectId, "final", reply);
        throw error;
      }
    });
  }

  async settleActiveStopped(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
    inputRevision: number,
    result: Extract<AgentRunResult, { status: "stopped" }>,
    pause = false,
  ): Promise<ActiveAgentRun | null> {
    const key = privateScopeKey(channel, ownerId);
    return this.withActiveQueue(key, async () => {
      const current = await this.requireActive(key, runId);
      if (isTerminalActiveRun(current)) return null;
      if (current.instructionRevision !== inputRevision) {
        const at = this.now().toISOString();
        return this.saveActive(withoutRevision({
          ...current,
          checkpoint: validateActiveCheckpointForRun(current, result.checkpoint),
          appliedInstructionRevision: Math.max(
            current.appliedInstructionRevision,
            inputRevision,
          ),
          status: "queued",
          phase: "replanning",
          updatedAt: at,
          workUnits: markPlannerUnits(
            current.workUnits,
            inputRevision,
            "stale",
          ),
          events: appendBounded(
            current.events,
            activeEvent(
              this.makeId(),
              "replanning.started",
              at,
              current.instructionRevision,
            ),
            160,
          ),
        }), current.revision);
      }
      const moment = this.now();
      const at = moment.toISOString();
      if (pause || result.reason === "cancelled") {
        return this.saveActive(withoutRevision({
          ...current,
          checkpoint: validateActiveCheckpointForRun(current, result.checkpoint),
          appliedInstructionRevision: inputRevision,
          status: "paused",
          phase: "checking",
          updatedAt: at,
          lastError: {
            stage: "recovery",
            code: pause ? "shutdown_pause" : "work_interrupted",
            at,
          },
          workUnits: markPlannerUnits(
            current.workUnits,
            inputRevision,
            "stale",
          ),
        }), current.revision);
      }
      return this.saveActive(withoutRevision({
        ...current,
        checkpoint: terminalCheckpoint(
          validateActiveCheckpointForRun(current, result.checkpoint),
        ),
        appliedInstructionRevision: inputRevision,
        status: "failed",
        phase: "failed",
        pendingQuestion: null,
        resumeAnswer: null,
        pendingEffect: null,
        updatedAt: at,
        completedAt: at,
        expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
          .toISOString(),
        lastError: { stage: "planning", code: result.reason, at },
        workUnits: markPlannerUnits(
          current.workUnits,
          inputRevision,
          "failed",
        ),
        events: appendBounded(
          current.events,
          activeEvent(this.makeId(), "run.failed", at, inputRevision),
          160,
        ),
      }), current.revision);
    });
  }

  async failActive(
    channel: AgentChannel,
    ownerId: string,
    runId: string,
    code: string,
  ): Promise<ActiveAgentRun | null> {
    const key = privateScopeKey(channel, ownerId);
    return this.withActiveQueue(key, async () => {
      const current = await this.requireActive(key, runId);
      if (isTerminalActiveRun(current)) return null;
      const moment = this.now();
      const at = moment.toISOString();
      if (current.pendingEffect) {
        const effect = current.pendingEffect;
        return this.saveActive(withoutRevision({
          ...current,
          status: "partial",
          phase: "failed",
          checkpoint: terminalCheckpoint(current.checkpoint),
          pendingEffect: null,
          pendingQuestion: null,
          resumeAnswer: null,
          receipts: appendBounded(current.receipts, {
            receiptId: this.makeId(),
            effectId: effect.effectId,
            effect: privateMessageSendEffect(current.channel),
            purpose: effect.purpose,
            instructionRevision: effect.instructionRevision,
            status: "unknown",
            externalId: null,
            committedAt: at,
            reversible: false,
          }, 48),
          lastError: {
            stage: "delivery",
            code: "delivery_outcome_unknown",
            at,
          },
          completedAt: at,
          updatedAt: at,
          expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
            .toISOString(),
          workUnits: current.workUnits.map((unit) =>
            unit.status === "queued" ||
              unit.status === "running" ||
              unit.status === "waiting"
              ? { ...unit, status: "failed" as const }
              : unit
          ),
          events: appendBounded(
            current.events,
            activeEvent(
              this.makeId(),
              "run.failed",
              at,
              current.instructionRevision,
            ),
            160,
          ),
        }), current.revision);
      }
      return this.saveActive(withoutRevision({
        ...current,
        status: "failed",
        phase: "failed",
        checkpoint: terminalCheckpoint(current.checkpoint),
        pendingQuestion: null,
        resumeAnswer: null,
        pendingEffect: null,
        updatedAt: at,
        completedAt: at,
        expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
          .toISOString(),
        lastError: {
          stage: "planning",
          code: boundedRequiredText(code, 120, "Kode kegagalan run tidak sah."),
          at,
        },
        workUnits: current.workUnits.map((unit) =>
          unit.status === "queued" ||
            unit.status === "running" ||
            unit.status === "waiting"
            ? { ...unit, status: "failed" as const }
            : unit
        ),
        events: appendBounded(
          current.events,
          activeEvent(
            this.makeId(),
            "run.failed",
            at,
            current.instructionRevision,
          ),
          160,
        ),
      }), current.revision);
    });
  }

  async recoverInterruptedActiveRuns(
    channel: AgentChannel,
  ): Promise<ActiveAgentRun[]> {
    if (!hasActiveRepository(this.repository)) return [];
    const repository = this.activeRepository();
    const runs = await repository.listActive!(channel);
    const recoveredRuns: ActiveAgentRun[] = [];
    for (const candidate of runs) {
      if (isTerminalActiveRun(candidate)) continue;
      const key = candidate.scopeKey;
      const recovered = await this.withActiveQueue(key, async () => {
        const current = await this.requireActive(key, candidate.runId);
        if (isTerminalActiveRun(current)) return current;
        const moment = this.now();
        const at = moment.toISOString();
        if (Date.parse(current.expiresAt) <= moment.getTime()) {
          const removed = await repository.removeActive!(
            key,
            current.runId,
            current.revision,
          );
          if (removed === "conflict") throw new AgentRunConflictError();
          return null;
        }
        if (current.pendingEffect) {
          const purpose = current.pendingEffect.purpose;
          return this.saveActive(withoutRevision({
            ...current,
            status: "partial",
            phase: "failed",
            checkpoint: terminalCheckpoint(current.checkpoint),
            receipts: appendBounded(current.receipts, {
              receiptId: this.makeId(),
              effectId: current.pendingEffect.effectId,
              effect: privateMessageSendEffect(current.channel),
              purpose,
              instructionRevision: current.pendingEffect.instructionRevision,
              status: "unknown",
              externalId: null,
              committedAt: at,
              reversible: false,
            }, 48),
            pendingEffect: null,
            pendingQuestion: null,
            resumeAnswer: null,
            lastError: {
              stage: "recovery",
              code: "delivery_outcome_unknown_after_restart",
              at,
            },
            completedAt: at,
            updatedAt: at,
            expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
              .toISOString(),
            workUnits: current.workUnits.map((unit) =>
              unit.status === "queued" ||
                unit.status === "running" ||
                unit.status === "waiting"
                ? { ...unit, status: "failed" as const }
                : unit
            ),
            events: appendBounded(
              current.events,
              activeEvent(
                this.makeId(),
                "run.failed",
                at,
                current.instructionRevision,
              ),
              160,
            ),
          }), current.revision);
        }
        if (
          current.status === "waiting_input" &&
          current.pendingQuestion &&
          Date.parse(current.pendingQuestion.expiresAt) <= moment.getTime()
        ) {
          return this.saveActive(withoutRevision({
            ...current,
            status: "failed",
            phase: "failed",
            checkpoint: terminalCheckpoint(current.checkpoint),
            lastError: { stage: "recovery", code: "input_expired", at },
            pendingQuestion: null,
            resumeAnswer: null,
            workUnits: current.workUnits.map((unit) =>
              unit.status === "waiting"
                ? { ...unit, status: "failed" as const }
                : unit
            ),
            completedAt: at,
            updatedAt: at,
            expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
              .toISOString(),
            events: appendBounded(
              current.events,
              activeEvent(
                this.makeId(),
                "run.failed",
                at,
                current.instructionRevision,
              ),
              160,
            ),
          }), current.revision);
        }
        if (current.status === "running" || current.status === "paused") {
          return this.saveActive(withoutRevision({
            ...current,
            status: "queued",
            phase: "replanning",
            lastError: {
              stage: "recovery",
              code: "process_interrupted",
              at,
            },
            updatedAt: at,
            workUnits: current.workUnits.map((unit) =>
              unit.status === "running"
                ? { ...unit, status: "stale" as const }
                : unit
            ),
            events: appendBounded(
              current.events,
              activeEvent(
                this.makeId(),
                "replanning.started",
                at,
                current.instructionRevision,
              ),
              160,
            ),
          }), current.revision);
        }
        return current;
      });
      if (recovered) recoveredRuns.push(structuredClone(recovered));
    }
    return recoveredRuns;
  }

  async loadWaitingInput(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<DurableAgentRun | null> {
    const key = privateScopeKey(channel, ownerId);
    if (this.blockedScopes.has(key)) return null;
    const run = await this.repository.load(key);
    if (this.blockedScopes.has(key)) return null;
    if (!run) return null;
    validateStoredRun(run, channel, ownerId);
    if (Date.parse(run.expiresAt) <= this.now().getTime()) {
      await this.repository.remove(key, run.runId);
      return null;
    }
    return structuredClone(run);
  }

  async saveWaitingInput(
    input: SaveWaitingAgentRunInput,
  ): Promise<DurableAgentRun> {
    const moment = this.now();
    const key = privateScopeKey(input.channel, input.ownerId);
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
    validateCheckpointForStorage(input, key, moment);
    const draft: NewDurableAgentRun = {
      version: 1,
      scopeKey: key,
      channel: input.channel,
      ownerId: input.ownerId,
      runId: input.checkpoint.runId,
      request: input.request,
      mode: input.mode,
      intent: input.intent,
      acceptAnswersAfterUpdateId: input.acceptAnswersAfterUpdateId,
      status: "waiting_input",
      checkpoint: structuredClone(input.checkpoint),
      createdAt: input.checkpoint.startedAt,
      updatedAt: moment.toISOString(),
      expiresAt: input.checkpoint.deadlineAt,
    };
    const result = await this.repository.save(draft, input.expectedRevision);
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
    if (result.status === "conflict") throw new AgentRunConflictError();
    validateStoredRun(result.run, input.channel, input.ownerId);
    return structuredClone(result.run);
  }

  /**
   * Mengambil hak resume lewat CAS sebelum model dipanggil. Record tetap
   * `waiting_input`: bila proses crash, jawaban yang sedang diproses tidak
   * dikarang sudah selesai dan run masih dapat dibatalkan/diulang pengguna.
   */
  async claimWaitingInput(
    channel: AgentChannel,
    ownerId: string,
    expectedRunId: string,
    expectedRevision: number,
  ): Promise<DurableAgentRun> {
    const key = privateScopeKey(channel, ownerId);
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
    const current = await this.repository.load(key);
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
    if (
      !current ||
      current.runId !== expectedRunId ||
      current.revision !== expectedRevision
    ) {
      throw new AgentRunConflictError();
    }
    validateStoredRun(current, channel, ownerId);
    if (Date.parse(current.expiresAt) <= this.now().getTime()) {
      await this.repository.remove(key, current.runId, current.revision);
      throw new AgentRunConflictError();
    }
    const { revision: _revision, ...draft } = current;
    const result = await this.repository.save(
      { ...draft, updatedAt: this.now().toISOString() },
      expectedRevision,
    );
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
    if (result.status === "conflict") throw new AgentRunConflictError();
    return structuredClone(result.run);
  }

  async clear(
    channel: AgentChannel,
    ownerId: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    const result = await this.repository.remove(
      privateScopeKey(channel, ownerId),
      expectedRunId,
      expectedRevision,
    );
    if (result === "conflict") throw new AgentRunConflictError();
    return result === "removed";
  }

  /** Ekspor hanya membawa progress/usage pengguna, bukan policy authority. */
  async export(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<DurableAgentRunExport | null> {
    if (hasActiveRepository(this.repository)) {
      const active = await this.loadActive(channel, ownerId);
      if (active) return activeRunExport(active);
    }
    const run = await this.loadWaitingInput(channel, ownerId);
    if (!run) return null;
    const budget = run.checkpoint.runBudget;
    return {
      version: 1,
      channel: run.channel,
      ownerId: run.ownerId,
      runId: run.runId,
      request: run.request,
      mode: run.mode,
      intent: run.intent,
      status: run.status,
      revision: run.revision,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt,
      progress: {
        step: run.checkpoint.step,
        observations: structuredClone(run.checkpoint.observations),
        userInputs: structuredClone(run.checkpoint.userInputs),
        pendingInput: structuredClone(run.checkpoint.pendingInput),
      },
      budget: budget
        ? {
            consumedTokens: budget.consumedTokens,
            consumedCostUsdNanos: budget.consumedCostUsdNanos,
            modelCalls: budget.modelCalls,
            toolCalls: budget.toolCalls,
            unknownUsageAttempts: budget.unknownUsageAttempts,
            activeElapsedMs: budget.activeElapsedMs,
          }
        : null,
    };
  }

  forget(channel: AgentChannel, ownerId: string): Promise<number> {
    const scope = canonicalPrivateScope(channel, ownerId);
    this.blockedScopes.add(scopeKey(scope));
    return this.repository.removeOwner(channel, scope.userId);
  }

  /**
   * Menghapus snapshot turunan ketika sumber memory/history berubah. Scope yang
   * sebelumnya writable dibuka lagi hanya setelah cleanup benar-benar sukses;
   * block consent/deletion yang sudah ada tidak boleh terangkat diam-diam.
   */
  async discardContextData(
    channel: AgentChannel,
    ownerId: string,
  ): Promise<number> {
    const scope = canonicalPrivateScope(channel, ownerId);
    const key = scopeKey(scope);
    const wasBlocked = this.blockedScopes.has(key);
    this.blockedScopes.add(key);
    try {
      const removed = await this.repository.removeOwner(channel, scope.userId);
      if (!wasBlocked) this.blockedScopes.delete(key);
      return removed;
    } catch (error) {
      // Gagal tertutup: salinan mungkin masih ada, jadi write/recovery tetap
      // diblokir sampai cleanup atau consent baru berhasil.
      throw error;
    }
  }

  /** Hanya penerimaan consent baru yang boleh membuka write setelah deletion. */
  allow(channel: AgentChannel, ownerId: string): void {
    this.blockedScopes.delete(privateScopeKey(channel, ownerId));
  }

  purgeExpired(): Promise<number> {
    return this.repository.removeExpired(this.now());
  }

  private activeRepository(): AgentRunRepository & Required<Pick<
    AgentRunRepository,
    | "loadActive"
    | "loadActiveByRunId"
    | "listActive"
    | "saveActive"
    | "removeActive"
  >> {
    if (!hasActiveRepository(this.repository)) {
      throw new ActiveAgentRunUnavailableError();
    }
    return this.repository;
  }

  private async requireActive(
    expectedScopeKey: string,
    runId: string,
  ): Promise<ActiveAgentRun> {
    this.assertScopeWritable(expectedScopeKey);
    const run = await this.activeRepository().loadActiveByRunId(runId);
    this.assertScopeWritable(expectedScopeKey);
    if (!run || run.scopeKey !== expectedScopeKey) {
      throw new AgentRunConflictError();
    }
    return run;
  }

  private async requireFreshActive(
    expectedScopeKey: string,
    runId: string,
    inputRevision: number,
  ): Promise<ActiveAgentRun> {
    const run = await this.requireActive(expectedScopeKey, runId);
    if (
      run.status !== "running" ||
      run.instructionRevision !== inputRevision ||
      run.pendingEffect !== null
    ) {
      throw new ActiveAgentRunStaleError();
    }
    return run;
  }

  private async saveActive(
    draft: NewActiveAgentRun,
    expectedRevision: number,
  ): Promise<ActiveAgentRun> {
    this.assertScopeWritable(draft.scopeKey);
    const result = await this.activeRepository().saveActive(
      structuredClone(draft),
      expectedRevision,
    );
    this.assertScopeWritable(draft.scopeKey);
    if (result.status === "conflict") throw new AgentRunConflictError();
    return structuredClone(result.run);
  }

  private async mutateActive(
    key: string,
    runId: string,
    update: (run: ActiveAgentRun, at: string) => NewActiveAgentRun,
  ): Promise<ActiveAgentRun> {
    return this.withActiveQueue(key, async () => {
      const current = await this.requireActive(key, runId);
      const next = update(structuredClone(current), this.now().toISOString());
      return this.saveActive(next, current.revision);
    });
  }

  private async persistUnknownDelivery(
    prepared: ActiveAgentRun,
    effectId: string,
    purpose: AgentRunEffectPurpose,
    partialText?: string,
  ): Promise<void> {
    const moment = this.now();
    const at = moment.toISOString();
    try {
      await this.saveActive(withoutRevision({
        ...prepared,
        status: "partial",
        phase: "failed",
        checkpoint: terminalCheckpoint(prepared.checkpoint),
        pendingEffect: null,
        pendingQuestion: null,
        resumeAnswer: null,
        receipts: appendBounded(prepared.receipts, {
          receiptId: this.makeId(),
          effectId,
          effect: privateMessageSendEffect(prepared.channel),
          purpose,
          instructionRevision: prepared.instructionRevision,
          status: "unknown",
          externalId: null,
          committedAt: at,
          reversible: false,
        }, 48),
        result: partialText
          ? {
              kind: "partial",
              text: partialText,
              instructionRevision: prepared.instructionRevision,
              completedAt: at,
            }
          : prepared.result,
        lastError: { stage: "delivery", code: "delivery_outcome_unknown", at },
        completedAt: at,
        updatedAt: at,
        expiresAt: new Date(moment.getTime() + ACTIVE_RUN_RETENTION_MS)
          .toISOString(),
        workUnits: markPlannerUnits(
          prepared.workUnits,
          prepared.instructionRevision,
          "failed",
        ),
        events: appendBounded(
          prepared.events,
          activeEvent(
            this.makeId(),
            "run.failed",
            at,
            prepared.instructionRevision,
          ),
          160,
        ),
      }), prepared.revision);
    } catch {
      // Efek eksternal sudah ambigu; kegagalan kedua tidak boleh menutupi error
      // delivery asli. Recovery akan melihat pendingEffect yang tertinggal.
    }
  }

  private assertScopeWritable(key: string): void {
    if (this.blockedScopes.has(key)) throw new AgentRunBlockedError();
  }

  private withActiveQueue<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.activeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.activeQueues.set(key, tail);
    void tail.finally(() => {
      if (this.activeQueues.get(key) === tail) this.activeQueues.delete(key);
    });
    return next;
  }
}

function privateScopeKey(channel: AgentChannel, ownerId: string): string {
  return scopeKey(canonicalPrivateScope(channel, ownerId));
}

function canonicalPrivateScope(channel: AgentChannel, ownerId: string) {
  const scope = privateAgentScope(channel, ownerId);
  if (scope.userId !== ownerId) {
    throw new Error("Owner ID agent harus sudah dalam bentuk kanonis.");
  }
  return scope;
}

function validateCheckpointForStorage(
  input: SaveWaitingAgentRunInput,
  expectedScopeKey: string,
  moment: Date,
): void {
  const checkpoint = input.checkpoint;
  const scope = canonicalPrivateScope(input.channel, input.ownerId);
  const startedAt = Date.parse(checkpoint.startedAt);
  if (
    !isValidAgentRunCheckpoint(checkpoint, scope, input.request) ||
    checkpoint.scopeKey !== expectedScopeKey ||
    checkpoint.pending !== null ||
    checkpoint.pendingInput === null ||
    !Number.isSafeInteger(input.acceptAnswersAfterUpdateId) ||
    input.acceptAnswersAfterUpdateId < 0 ||
    startedAt > moment.getTime() ||
    Date.parse(checkpoint.deadlineAt) <= moment.getTime()
  ) {
    throw new Error("Checkpoint agent tidak sah untuk penyimpanan durable.");
  }
  const serialized = JSON.stringify(checkpoint);
  if (serialized.length > MAX_DURABLE_CHECKPOINT_CHARACTERS) {
    throw new Error("Checkpoint agent melampaui batas penyimpanan durable.");
  }
}

function validateStoredRun(
  run: DurableAgentRun,
  channel: AgentChannel,
  ownerId: string,
): void {
  const expectedScopeKey = privateScopeKey(channel, ownerId);
  if (
    run.version !== 1 ||
    run.channel !== channel ||
    run.ownerId !== ownerId ||
    run.scopeKey !== expectedScopeKey ||
    run.status !== "waiting_input" ||
    run.runId !== run.checkpoint.runId ||
    run.request !== run.checkpoint.request ||
    run.createdAt !== run.checkpoint.startedAt ||
    run.expiresAt !== run.checkpoint.deadlineAt ||
    !Number.isSafeInteger(run.acceptAnswersAfterUpdateId) ||
    run.acceptAnswersAfterUpdateId < 0 ||
    !Number.isInteger(run.revision) ||
    run.revision <= 0 ||
    !Number.isFinite(Date.parse(run.updatedAt)) ||
    Date.parse(run.createdAt) > Date.parse(run.updatedAt) ||
    Date.parse(run.updatedAt) >= Date.parse(run.expiresAt)
  ) {
    throw new Error("Record durable agent tidak konsisten dengan scope-nya.");
  }
}

function hasActiveRepository(
  repository: AgentRunRepository,
): repository is AgentRunRepository & Required<Pick<
  AgentRunRepository,
  | "loadActive"
  | "loadActiveByRunId"
  | "listActive"
  | "saveActive"
  | "removeActive"
>> {
  return (
    typeof repository.loadActive === "function" &&
    typeof repository.loadActiveByRunId === "function" &&
    typeof repository.listActive === "function" &&
    typeof repository.saveActive === "function" &&
    typeof repository.removeActive === "function"
  );
}

function isTerminalActiveRun(run: ActiveAgentRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "partial" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

function privateMessageSendEffect(
  channel: AgentChannel,
): "telegram.message.send" | "whatsapp.message.send" {
  return channel === "whatsapp"
    ? "whatsapp.message.send"
    : "telegram.message.send";
}

function withoutRevision(run: ActiveAgentRun): NewActiveAgentRun {
  const { revision: _revision, ...draft } = run;
  return draft;
}

function boundedRequiredText(
  value: string,
  maximum: number,
  message: string,
): string {
  if (typeof value !== "string") throw new Error(message);
  const bounded = value.trim();
  if (!bounded || bounded.length > maximum) throw new Error(message);
  return bounded;
}

function boundedContextSnapshot(
  context: AgentRunContextSnapshot,
): AgentRunContextSnapshot {
  if (!context || typeof context !== "object") {
    throw new Error("Snapshot konteks active AgentRun tidak sah.");
  }
  const summary = context.summary === null
    ? null
    : typeof context.summary === "string"
      ? context.summary.slice(0, 16_000)
      : (() => {
          throw new Error("Ringkasan konteks active AgentRun tidak sah.");
        })();
  if (!Array.isArray(context.turns) || !Array.isArray(context.memories)) {
    throw new Error("Snapshot konteks active AgentRun tidak sah.");
  }
  const turns = context.turns.slice(-24).map((turn) => {
    if (
      !turn ||
      (turn.role !== "user" && turn.role !== "harvy") ||
      typeof turn.text !== "string" ||
      !Number.isFinite(Date.parse(turn.at))
    ) {
      throw new Error("Giliran konteks active AgentRun tidak sah.");
    }
    return { ...turn, text: turn.text.slice(0, 2_000) };
  });
  const memories = context.memories.slice(0, 24).map((memory) => {
    if (
      !memory ||
      typeof memory.id !== "string" ||
      !["profile", "preference", "routine", "context", "personal"]
        .includes(memory.kind) ||
      typeof memory.content !== "string"
    ) {
      throw new Error("Memori konteks active AgentRun tidak sah.");
    }
    return {
      id: memory.id.slice(0, 200),
      kind: memory.kind,
      content: memory.content.slice(0, 1_000),
    };
  });
  const retrieved = (context.retrieved ?? []).slice(0, 16).map((evidence) => {
    if (
      !evidence ||
      typeof evidence.id !== "string" ||
      !Array.isArray(evidence.sources) ||
      evidence.sources.length < 1 ||
      evidence.sources.some((source) => !isRetrievedMemorySource(source)) ||
      (evidence.sources.includes("graph") &&
        !evidence.sources.includes("semantic")) ||
      typeof evidence.text !== "string" ||
      !Number.isFinite(evidence.score) ||
      !["active", "superseded", "uncertain", "expired"]
        .includes(evidence.status) ||
      !["normal", "personal", "restricted"].includes(evidence.sensitivity) ||
      !Array.isArray(evidence.sourceEpisodeIds) ||
      !Array.isArray(evidence.sourceSequences) ||
      !Array.isArray(evidence.sourceMemoryIds) ||
      !hasRetrievedMemoryProvenance(evidence)
    ) {
      throw new Error("Evidence konteks active AgentRun tidak sah.");
    }
    return {
      ...structuredClone(evidence),
      id: evidence.id.slice(0, 300),
      text: evidence.text.slice(0, 1_000),
      sourceEpisodeIds: evidence.sourceEpisodeIds.slice(0, 64),
      sourceSequences: evidence.sourceSequences.slice(0, 256),
      sourceMemoryIds: evidence.sourceMemoryIds.slice(0, 64),
    };
  });
  return {
    summary,
    turns,
    memories,
    ...(retrieved.length > 0 ? { retrieved } : {}),
  };
}

function activeEvent(
  id: string,
  type: ActiveAgentRun["events"][number]["type"],
  at: string,
  inputRevision: number,
  workUnitId: string | null = null,
): ActiveAgentRun["events"][number] {
  return { id, type, at, inputRevision, workUnitId };
}

function appendBounded<T>(items: T[], item: T, maximum: number): T[] {
  const next = [...items, item];
  return next.length <= maximum ? next : next.slice(next.length - maximum);
}

function appendMailboxChange(
  run: ActiveAgentRun,
  message: RunMailboxMessage,
  changeSet: RunChangeSet,
): { mailbox: RunMailboxMessage[]; changeSets: RunChangeSet[] } | null {
  if (run.mailbox.length !== run.changeSets.length) return null;
  const capacity = message.kind === "answer" || message.kind === "cancel"
    ? MAX_MAILBOX_MESSAGES
    : MAX_MAILBOX_MESSAGES - 1;
  if (
    run.mailbox.length < capacity &&
    run.changeSets.length < capacity
  ) {
    return {
      mailbox: [...run.mailbox, message],
      changeSets: [...run.changeSets, changeSet],
    };
  }
  if (message.kind !== "cancel") return null;

  // Pembatalan harus selalu dapat menutup run. Bila ledger sudah penuh,
  // pasangan tertua diganti hanya setelah run menjadi terminal; update yang
  // belum diterapkan tidak pernah dikeluarkan dari run yang masih bekerja.
  return {
    mailbox: [...run.mailbox.slice(1), message],
    changeSets: [...run.changeSets.slice(1), changeSet],
  };
}

function markPlannerUnits(
  workUnits: AgentRunWorkUnit[],
  inputRevision: number,
  status: AgentRunWorkUnit["status"],
): AgentRunWorkUnit[] {
  return workUnits.map((unit) =>
    unit.inputRevision === inputRevision && unit.role === "planner"
      ? { ...unit, status }
      : unit
  );
}

function mailboxChangeKind(kind: RunMailboxMessageKind): RunChangeSetKind {
  switch (kind) {
    case "constraint":
      return "constraint";
    case "correction":
      return "correction";
    case "scope_change":
      return "scope_addition";
    case "answer":
      return "answer";
    case "cancel":
      return "cancel";
  }
}

function validateActiveCheckpointForRun(
  run: ActiveAgentRun,
  checkpoint: AgentRunCheckpoint,
): AgentRunCheckpoint {
  const scope = canonicalPrivateScope(run.channel, run.ownerId);
  const copy = structuredClone(checkpoint);
  if (
    !isValidAgentRunCheckpoint(copy, scope, run.initialRequest) ||
    copy.runId !== run.runId ||
    JSON.stringify(copy).length > MAX_DURABLE_CHECKPOINT_CHARACTERS
  ) {
    throw new Error("Checkpoint active AgentRun tidak sah.");
  }
  return copy;
}

function terminalCheckpoint(
  checkpoint: AgentRunCheckpoint | null,
): AgentRunCheckpoint | null {
  if (checkpoint === null) return null;
  return {
    ...structuredClone(checkpoint),
    pending: null,
    pendingInput: null,
  };
}

function rebaseCheckpoint(
  run: ActiveAgentRun,
  checkpoint: AgentRunCheckpoint,
): AgentRunCheckpoint {
  const copy = validateActiveCheckpointForRun(run, checkpoint);
  const inputs = instructionInputsAfter(
    run,
    run.appliedInstructionRevision,
    copy.step,
  );
  if (inputs.length === 0) return copy;
  copy.pending = null;
  copy.pendingInput = null;
  copy.seenActionDigests = [];
  copy.userInputs.push(...inputs);
  return copy;
}

function instructionInputsAfter(
  run: ActiveAgentRun,
  appliedRevision: number,
  step: number,
): AgentUserInput[] {
  const messagesBySource = new Map(
    run.mailbox.map((message) => [message.sourceMessageId, message] as const),
  );
  const pendingBySource = new Map<string, PendingInstructionChange>();
  for (const change of run.changeSets) {
    const message = messagesBySource.get(change.sourceMessageId);
    if (
      change.revision <= appliedRevision ||
      !message ||
      message.kind === "cancel" ||
      message.kind === "answer"
    ) {
      continue;
    }
    pendingBySource.set(change.sourceMessageId, {
      revision: change.revision,
      kind: message.kind,
      content: message.content,
    });
  }
  const pending = [...pendingBySource.values()].sort(
    (left, right) => left.revision - right.revision,
  );
  return compileInstructionInputs(pending, step);
}

function pendingInstructionsFitCheckpoint(run: ActiveAgentRun): boolean {
  const inputs = instructionInputsAfter(
    run,
    run.appliedInstructionRevision,
    run.checkpoint?.step ?? 0,
  );
  if (
    inputs.length > MAX_PENDING_INSTRUCTION_INPUTS ||
    JSON.stringify(inputs).length >
      MAX_PENDING_INSTRUCTION_CHECKPOINT_CHARACTERS
  ) {
    return false;
  }
  if (!run.checkpoint) return true;
  const checkpoint = structuredClone(run.checkpoint);
  checkpoint.pending = null;
  checkpoint.pendingInput = null;
  checkpoint.seenActionDigests = [];
  checkpoint.userInputs.push(...inputs);
  return JSON.stringify(checkpoint).length <= MAX_DURABLE_CHECKPOINT_CHARACTERS;
}

interface PendingInstructionChange {
  revision: number;
  kind: Exclude<RunMailboxMessageKind, "answer" | "cancel">;
  content: string;
}

function compileInstructionInputs(
  pending: readonly PendingInstructionChange[],
  step: number,
): AgentUserInput[] {
  const inputs: AgentUserInput[] = [];
  let chunk = "";
  let firstRevision = 0;
  let lastRevision = 0;
  let count = 0;

  const flush = (): void => {
    if (!chunk) return;
    inputs.push({
      step,
      prompt: instructionPrompt(firstRevision, lastRevision, count),
      text: chunk,
    });
    chunk = "";
    firstRevision = 0;
    lastRevision = 0;
    count = 0;
  };

  for (const change of pending) {
    const framed = [
      `[revision ${change.revision}; ${change.kind}]`,
      change.content,
    ].join("\n");
    if (framed.length > MAX_MAILBOX_CONTENT_CHARACTERS) {
      flush();
      inputs.push({
        step,
        prompt: instructionPrompt(change.revision, change.revision, 1, change.kind),
        text: change.content,
      });
      continue;
    }
    const candidate = chunk ? `${chunk}\n\n${framed}` : framed;
    if (candidate.length > MAX_MAILBOX_CONTENT_CHARACTERS) {
      flush();
    }
    if (!chunk) firstRevision = change.revision;
    chunk = chunk ? `${chunk}\n\n${framed}` : framed;
    lastRevision = change.revision;
    count += 1;
  }
  flush();
  return inputs;
}

function instructionPrompt(
  firstRevision: number,
  lastRevision: number,
  count: number,
  kind?: PendingInstructionChange["kind"],
): string {
  if (firstRevision === lastRevision) {
    return kind
      ? `Perubahan instruksi revision ${firstRevision} (${kind})`
      : `Perubahan instruksi revision ${firstRevision}`;
  }
  return `Perubahan instruksi revision ${firstRevision}-${lastRevision} (${count} update RunMailbox; urutan kronologis)`;
}

function activeRunExport(run: ActiveAgentRun): ActiveAgentRunExport {
  const checkpoint = run.checkpoint;
  const budget = checkpoint?.runBudget;
  return {
    version: 2,
    channel: run.channel,
    ownerId: run.ownerId,
    runId: run.runId,
    request: run.initialRequest,
    mode: run.mode,
    intent: run.intent,
    status: run.status,
    revision: run.revision,
    contextRevision: run.contextRevision,
    instructionRevision: run.instructionRevision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    expiresAt: run.expiresAt,
    progress: {
      step: checkpoint?.step ?? 0,
      observations: structuredClone(checkpoint?.observations ?? []),
      userInputs: structuredClone(checkpoint?.userInputs ?? []),
      pendingInput: structuredClone(checkpoint?.pendingInput ?? null),
    },
    budget: budget
      ? {
          consumedTokens: budget.consumedTokens,
          consumedCostUsdNanos: budget.consumedCostUsdNanos,
          modelCalls: budget.modelCalls,
          toolCalls: budget.toolCalls,
          unknownUsageAttempts: budget.unknownUsageAttempts,
          activeElapsedMs: budget.activeElapsedMs,
        }
      : null,
    mailbox: run.mailbox.map(({ id: _id, runId: _runId, questionId: _questionId, ...message }) =>
      structuredClone(message)
    ),
    changes: structuredClone(run.changeSets),
    workUnits: structuredClone(run.workUnits),
    receipts: run.receipts.map(({ effectId: _effectId, ...receipt }) =>
      structuredClone(receipt)
    ),
    result: structuredClone(run.result),
  };
}
