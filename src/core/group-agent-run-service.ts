import { randomUUID } from "node:crypto";
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
  GroupRunInput,
  GroupRunParticipant,
} from "../domain/group-agent-run.js";
import { isTerminalGroupAgentRunStatus } from "../domain/group-agent-run.js";
import { groupScopeKey, type GroupMessage } from "../domain/group.js";

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const QUESTION_HORIZON_MS = 10 * 60 * 1_000;
const MAX_INPUTS = 64;
const MAX_NONTERMINAL_INPUTS = MAX_INPUTS - 2;
const MAX_PARTICIPANTS = 64;
const MAX_QUESTIONS = 32;
const MAX_EVENTS = 256;
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
        | "account_mismatch"
        | "run_terminal"
        | "initiator_or_admin_required"
        | "assigned_to_other_participant"
        | "admin_override_must_be_explicit";
      run: GroupAgentRun;
    }
  | {
      status: "rejected";
      reason: "mailbox_full" | "ambiguous_batch";
      run: GroupAgentRun;
    }
  | {
      status: "applied" | "proposed" | "cancelled";
      run: GroupAgentRun;
      replayed: boolean;
    };

export interface RecordGroupRunQuestionInput {
  runId: string;
  expectedStateRevision: number;
  prompt: string;
  assignee: GroupRunParticipant;
  messageId: string;
  acceptAnswersAfterIngressRevision: number;
  expiresAt?: string;
}

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

export class GroupAgentRunMessageCollisionError extends Error {
  constructor() {
    super("sourceMessageId GroupAgentRun dipakai oleh envelope yang berbeda.");
    this.name = "GroupAgentRunMessageCollisionError";
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
    await this.expireForeground(startScopeKey, input.message.accountId);
    await this.repository.removeExpired(this.now());
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
      version: 1,
      runId,
      scopeKey: groupScopeKey(input.message.scope),
      scope: structuredClone(input.message.scope),
      accountId: safeKey(input.message.accountId, "accountId"),
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
      inputs: [],
      changeSets: [],
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
    const saved = await this.repository.create(draft, async () =>
      sameAuthority(firstAuthority, await this.resolveAuthority(input.message))
    );
    if (saved.status === "saved") return { status: "started", run: saved.run };
    if (saved.status === "guard-rejected") {
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

  async attachAnchor(
    runId: string,
    expectedStateRevision: number,
    messageId: string,
  ): Promise<GroupAgentRun> {
    const cleanMessageId = safeKey(messageId, "anchorMessageId");
    const latest = await this.repository.load(runId);
    if (
      latest?.anchor.messageId === cleanMessageId &&
      latest.stateRevision >= expectedStateRevision
    ) return latest;
    const run = await this.loadExact(runId, expectedStateRevision);
    if (run.anchor.messageId === cleanMessageId) return run;
    if (
      run.anchor.messageId !== null || isTerminalGroupAgentRunStatus(run.status) ||
      Date.parse(run.expiresAt) <= this.now().getTime()
    ) {
      throw new GroupAgentRunConflictError();
    }
    const at = this.now().toISOString();
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(run),
      anchor: { ...run.anchor, messageId: cleanMessageId, updatedAt: at },
      events: appendEvent(run.events, {
        id: `group-run-event-${this.id()}`,
        type: "anchor.attached",
        at,
        instructionRevision: run.instructionRevision,
        sourceMessageId: cleanMessageId,
        participantId: null,
      }),
      updatedAt: at,
    };
    return this.saveExact(
      next,
      expectedStateRevision,
      async () => {
        const authorized = await this.runParticipantStillAuthorized(
          run,
          run.initiator,
        );
        return authorized && Date.parse(run.expiresAt) > this.now().getTime();
      },
    );
  }

  async recordAssignedQuestion(
    input: RecordGroupRunQuestionInput,
  ): Promise<GroupAgentRun> {
    const run = await this.loadExact(input.runId, input.expectedStateRevision);
    if (
      isTerminalGroupAgentRunStatus(run.status) || run.status === "paused" ||
      Date.parse(run.expiresAt) <= this.now().getTime() ||
      run.questions.some((question) => question.status === "open") ||
      run.questions.length >= MAX_QUESTIONS ||
      run.inputs.length >= MAX_NONTERMINAL_INPUTS
    ) throw new GroupAgentRunConflictError();
    const at = this.now();
    const expiresAt = input.expiresAt ??
      new Date(at.getTime() + QUESTION_HORIZON_MS).toISOString();
    if (
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= at.getTime() ||
      Date.parse(expiresAt) > at.getTime() + QUESTION_HORIZON_MS ||
      Date.parse(expiresAt) > Date.parse(run.expiresAt)
    ) throw new Error("Horizon pertanyaan GroupAgentRun tidak sah.");
    const assignee = normalizedParticipant(input.assignee);
    const participants = addParticipant(run.participants, assignee);
    const questionId = `group-run-question-${this.id()}`;
    const timestamp = at.toISOString();
    const next: Omit<GroupAgentRun, "stateRevision"> = {
      ...withoutStateRevision(run),
      participants,
      status: "waiting_input",
      phase: "waiting_input",
      questions: [...run.questions, {
        questionId,
        prompt: boundedText(input.prompt, 2_000, "question.prompt"),
        assignee,
        messageId: safeKey(input.messageId, "question.messageId"),
        acceptAnswersAfterIngressRevision: nonNegativeInteger(
          input.acceptAnswersAfterIngressRevision,
          "acceptAnswersAfterIngressRevision",
        ),
        status: "open",
        askedAt: timestamp,
        expiresAt,
        answeredBy: null,
        answerSourceMessageId: null,
        answeredAt: null,
      }],
      events: appendEvent(run.events, {
        id: `group-run-event-${this.id()}`,
        type: "input.required",
        at: timestamp,
        instructionRevision: run.instructionRevision,
        sourceMessageId: input.messageId,
        participantId: assignee.participantId,
      }),
      updatedAt: timestamp,
    };
    return this.saveExact(
      next,
      input.expectedStateRevision,
      async () => {
        const initiatorAuthority = await this.runParticipantAuthority(
          run,
          run.initiator,
        );
        const assigneeAuthority = await this.runParticipantAuthority(
          run,
          assignee,
        );
        const confirmedInitiatorAuthority = await this.runParticipantAuthority(
          run,
          run.initiator,
        );
        const coherentAuthority = Boolean(
          initiatorAuthority && assigneeAuthority &&
            initiatorAuthority.authorityEpoch ===
              assigneeAuthority.authorityEpoch &&
            sameAuthority(
              initiatorAuthority,
              confirmedInitiatorAuthority,
            ),
        );
        const commitTime = this.now().getTime();
        return coherentAuthority && Date.parse(run.expiresAt) > commitTime &&
          Date.parse(expiresAt) > commitTime;
      },
    );
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
      const inputLimit = decision.kind === "cancel"
        ? MAX_INPUTS
        : decision.kind === "answer" ? MAX_INPUTS - 1 : MAX_NONTERMINAL_INPUTS;
      if (run.inputs.length >= inputLimit) {
        return { status: "rejected", reason: "mailbox_full", run };
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
      const saved = await this.repository.save(
        withoutStateRevision(next),
        run.stateRevision,
        async () => {
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
    } else if (decision.kind === "cancel") {
      next.questions = next.questions.map((question) =>
        question.status === "open"
          ? { ...question, status: "cancelled" as const }
          : question
      );
      next.status = "cancelled";
      next.phase = "cancelled";
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
  ): Promise<GroupAgentRun> {
    const saved = await this.repository.save(
      run,
      expectedStateRevision,
      guard,
    );
    if (saved.status !== "saved") throw new GroupAgentRunConflictError();
    return saved.run;
  }

  async purgeExpired(): Promise<number> {
    return this.repository.removeExpired(this.now());
  }

  private async runParticipantStillAuthorized(
    run: GroupAgentRun,
    participant: GroupRunParticipant,
  ): Promise<boolean> {
    return Boolean(await this.runParticipantAuthority(run, participant));
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
      return current && groupAuthorityAllows(current.role, "social.read")
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
      const runExpired = Date.parse(run.expiresAt) <= now.getTime();
      if (!questionExpired && !runExpired) return run;
      const at = now.toISOString();
      const next: Omit<GroupAgentRun, "stateRevision"> = {
        ...withoutStateRevision(run),
        status: "failed",
        phase: "failed",
        questions: run.questions.map((question) =>
          question.status === "open"
            ? { ...question, status: "expired" as const }
            : question
        ),
        events: appendEvent(run.events, {
          id: `group-run-event-${this.id()}`,
          type: questionExpired ? "input.expired" : "run.expired",
          at,
          instructionRevision: run.instructionRevision,
          sourceMessageId: run.questions.find((question) =>
            question.status === "open"
          )?.messageId ?? null,
          participantId: null,
        }),
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

function sameAuthority(
  left: GroupAuthoritySnapshot | null,
  right: GroupAuthoritySnapshot | null,
): right is GroupAuthoritySnapshot {
  return Boolean(
    left && right && left.role === right.role &&
      left.authorityEpoch === right.authorityEpoch,
  );
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
