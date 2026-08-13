import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GroupAgentRun,
  GroupAgentRunCreateResult,
  GroupAgentRunRepository,
  GroupAgentRunSaveResult,
  GroupAgentRunMutationGuard,
  GroupRunParticipant,
  NewGroupAgentRun,
} from "../domain/group-agent-run.js";
import { isTerminalGroupAgentRunStatus } from "../domain/group-agent-run.js";
import { groupScopeKey } from "../domain/group.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_RUNS = 4_096;
const MAX_RUNS_PER_SCOPE = 128;
const MAX_PARTICIPANTS = 64;
const MAX_INPUTS = 64;
const MAX_QUESTIONS = 32;
const MAX_EVENTS = 256;
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

interface GroupAgentRunDatabase {
  version: 1;
  runs: GroupAgentRun[];
}

/** Adapter restart-durable lokal dengan CAS dan satu foreground per grup. */
export class FileGroupAgentRunRepository implements GroupAgentRunRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(runId: string): Promise<GroupAgentRun | null> {
    const cleanRunId = safeKey(runId, "runId");
    return this.exclusive(async () => {
      const run = (await this.readDatabase()).runs.find(
        (candidate) => candidate.runId === cleanRunId,
      );
      return run ? structuredClone(run) : null;
    });
  }

  async loadLatestByScope(
    scopeKeyValue: string,
    accountIdValue: string,
  ): Promise<GroupAgentRun | null> {
    const cleanScopeKey = safeKey(scopeKeyValue, "scopeKey");
    const cleanAccountId = safeKey(accountIdValue, "accountId");
    return this.exclusive(async () => {
      const candidates = (await this.readDatabase()).runs
        .filter((run) =>
          run.scopeKey === cleanScopeKey && run.accountId === cleanAccountId
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const run = candidates.find((candidate) =>
        !isTerminalGroupAgentRunStatus(candidate.status)
      ) ?? candidates[0];
      return run ? structuredClone(run) : null;
    });
  }

  async loadForeground(
    scopeKeyValue: string,
    accountIdValue: string,
  ): Promise<GroupAgentRun | null> {
    const cleanScopeKey = safeKey(scopeKeyValue, "scopeKey");
    const cleanAccountId = safeKey(accountIdValue, "accountId");
    return this.exclusive(async () => {
      const run = (await this.readDatabase()).runs.find(
        (candidate) =>
          candidate.scopeKey === cleanScopeKey &&
          candidate.accountId === cleanAccountId &&
          !isTerminalGroupAgentRunStatus(candidate.status),
      );
      return run ? structuredClone(run) : null;
    });
  }

  async listActive(): Promise<GroupAgentRun[]> {
    return this.exclusive(async () =>
      structuredClone((await this.readDatabase()).runs
        .filter((run) => !isTerminalGroupAgentRunStatus(run.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
    );
  }

  async create(
    draft: NewGroupAgentRun,
    guard: GroupAgentRunMutationGuard,
  ): Promise<GroupAgentRunCreateResult> {
    const run: GroupAgentRun = { ...structuredClone(draft), stateRevision: 1 };
    validateRun(run);
    validateInitialRun(run);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (database.runs.some((candidate) => candidate.runId === run.runId)) {
        return { status: "conflict" };
      }
      const source = database.runs.find(
        (candidate) =>
          candidate.scopeKey === run.scopeKey &&
          candidate.accountId === run.accountId &&
          candidate.startSourceMessageId === run.startSourceMessageId,
      );
      if (source) {
        return { status: "source-exists", run: structuredClone(source) };
      }
      const foreground = database.runs.find(
        (candidate) =>
          candidate.scopeKey === run.scopeKey &&
          !isTerminalGroupAgentRunStatus(candidate.status),
      );
      if (foreground) {
        if (foreground.accountId !== run.accountId) {
          return { status: "scope-busy" };
        }
        return {
          status: "active-run-exists",
          run: structuredClone(foreground),
        };
      }
      if (
        database.runs.length >= MAX_RUNS ||
        database.runs.filter((candidate) => candidate.scopeKey === run.scopeKey)
            .length >= MAX_RUNS_PER_SCOPE
      ) {
        throw new Error("Batas histori GroupAgentRun tercapai.");
      }
      if (!(await guard())) return { status: "guard-rejected" };
      database.runs.push(run);
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(run) };
    });
  }

  async save(
    draft: Omit<GroupAgentRun, "stateRevision">,
    expectedStateRevision: number,
    guard: GroupAgentRunMutationGuard,
  ): Promise<GroupAgentRunSaveResult> {
    positiveInteger(expectedStateRevision, "expectedStateRevision");
    const run: GroupAgentRun = {
      ...structuredClone(draft),
      stateRevision: expectedStateRevision + 1,
    };
    validateRun(run);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (candidate) => candidate.runId === run.runId,
      );
      if (
        index < 0 ||
        database.runs[index]!.stateRevision !== expectedStateRevision
      ) {
        return { status: "conflict" };
      }
      const current = database.runs[index]!;
      validateTransition(current, run);
      if (!(await guard())) return { status: "guard-rejected" };
      database.runs[index] = run;
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(run) };
    });
  }

  async remove(runId: string, expectedStateRevision: number): Promise<boolean> {
    const cleanRunId = safeKey(runId, "runId");
    positiveInteger(expectedStateRevision, "expectedStateRevision");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (candidate) => candidate.runId === cleanRunId,
      );
      if (
        index < 0 ||
        database.runs[index]!.stateRevision !== expectedStateRevision
      ) return false;
      database.runs.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async removeExpired(now: Date): Promise<number> {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("Waktu purge GroupAgentRun tidak sah.");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const retained = database.runs.filter(
        (run) => Date.parse(run.expiresAt) > timestamp,
      );
      const removed = database.runs.length - retained.length;
      if (removed > 0) {
        database.runs = retained;
        await this.writeDatabase(database);
      }
      return removed;
    });
  }

  private async readDatabase(): Promise<GroupAgentRunDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<GroupAgentRunDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
        throw new Error("Format basis data GroupAgentRun tidak dikenali.");
      }
      for (const run of parsed.runs) validateRun(run);
      assertDatabaseConstraints(parsed.runs);
      return { version: 1, runs: structuredClone(parsed.runs) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, runs: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: GroupAgentRunDatabase): Promise<void> {
    assertDatabaseConstraints(database.runs);
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) {
        FILE_QUEUES.delete(this.filePath);
      }
    }
  }
}

function validateRun(value: unknown): asserts value is GroupAgentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Record GroupAgentRun tidak sah.");
  }
  assertKeys(value, [
    "version", "runId", "scopeKey", "scope", "accountId",
    "startSourceMessageId", "initialRequest", "title", "initiator",
    "startAuthority", "participants", "audience", "status", "phase",
    "instructionRevision",
    "appliedInstructionRevision", "stateRevision", "anchor", "inputs",
    "changeSets", "questions", "events", "createdAt", "updatedAt",
    "completedAt", "expiresAt",
  ], "run");
  const run = value as GroupAgentRun;
  if (run.version !== 1) throw new Error("Versi GroupAgentRun tidak sah.");
  safeKey(run.runId, "runId");
  safeKey(run.scopeKey, "scopeKey");
  safeKey(run.accountId, "accountId");
  safeKey(run.startSourceMessageId, "startSourceMessageId");
  boundedText(run.initialRequest, 8_000, "initialRequest");
  boundedText(run.title, 120, "title");
  if (
    !run.scope ||
    run.scope.channel !== "whatsapp" ||
    run.scopeKey !== groupScopeKey(run.scope)
  ) throw new Error("Scope GroupAgentRun tidak sah.");
  if (
    !run.audience || run.audience.kind !== "group" ||
    run.audience.visibility !== "group-safe" ||
    run.audience.scopeKey !== run.scopeKey
  ) throw new Error("Audience GroupAgentRun tidak sah.");

  validateParticipant(run.initiator, "initiator");
  assertKeys(run.startAuthority, ["role", "authorityEpoch"], "startAuthority");
  if (
    (run.startAuthority.role !== "member" && run.startAuthority.role !== "admin") ||
    !Number.isSafeInteger(run.startAuthority.authorityEpoch) ||
    run.startAuthority.authorityEpoch < 0
  ) throw new Error("Start authority GroupAgentRun tidak sah.");
  if (
    !Array.isArray(run.participants) || run.participants.length < 1 ||
    run.participants.length > MAX_PARTICIPANTS
  ) throw new Error("Participant GroupAgentRun tidak sah.");
  const identities = new Set<string>();
  for (const participant of run.participants) {
    validateParticipant(participant, "participant");
    for (const identity of participantIdentities(participant)) {
      if (identities.has(identity)) {
        throw new Error("Identitas participant GroupAgentRun tumpang tindih.");
      }
      identities.add(identity);
    }
  }
  if (!participantIn(run.initiator, run.participants)) {
    throw new Error("Initiator GroupAgentRun bukan participant.");
  }

  positiveInteger(run.stateRevision, "stateRevision");
  nonNegativeInteger(run.instructionRevision, "instructionRevision");
  nonNegativeInteger(
    run.appliedInstructionRevision,
    "appliedInstructionRevision",
  );
  if (run.appliedInstructionRevision > run.instructionRevision) {
    throw new Error("Applied revision GroupAgentRun melampaui instruction.");
  }
  if (!validStatusPhase(run.status, run.phase)) {
    throw new Error("Status/phase GroupAgentRun tidak sah.");
  }
  assertKeys(run.anchor, [
    "platform", "messageId", "pinPolicy", "updatedAt",
  ], "anchor");
  if (
    run.anchor.platform !== "whatsapp" ||
    run.anchor.pinPolicy !== "manual-only" ||
    (run.anchor.messageId !== null &&
      !safeOptionalKey(run.anchor.messageId, "anchor.messageId"))
  ) throw new Error("Anchor GroupAgentRun tidak sah.");
  validIso(run.anchor.updatedAt, "anchor.updatedAt");

  if (!Array.isArray(run.inputs) || run.inputs.length > MAX_INPUTS) {
    throw new Error("Input GroupAgentRun tidak sah.");
  }
  const sourceIds = new Set<string>();
  const appliedInputs = [];
  for (const input of run.inputs) {
    assertKeys(input, [
      "id", "sourceMessageId", "sourceIngressRevision", "actor",
      "quotedMessageId", "kind",
      "disposition", "content", "questionId", "assignedOverride",
      "authorityEpoch",
      "authorityRole", "instructionRevision", "receivedAt",
    ], "input");
    safeKey(input.id, "input.id");
    safeKey(input.sourceMessageId, "input.sourceMessageId");
    if (sourceIds.has(input.sourceMessageId)) {
      throw new Error("Source message GroupAgentRun duplikat.");
    }
    sourceIds.add(input.sourceMessageId);
    if (input.sourceMessageId === run.startSourceMessageId) {
      throw new Error("Source input GroupAgentRun bertabrakan dengan start.");
    }
    validateParticipant(input.actor, "input.actor");
    if (
      input.sourceIngressRevision !== null &&
      (!Number.isSafeInteger(input.sourceIngressRevision) ||
        input.sourceIngressRevision < 0)
    ) throw new Error("Ingress revision input GroupAgentRun tidak sah.");
    if (!participantIn(input.actor, run.participants)) {
      throw new Error("Aktor input GroupAgentRun bukan participant.");
    }
    if (
      input.quotedMessageId !== null &&
      !safeOptionalKey(input.quotedMessageId, "input.quotedMessageId")
    ) throw new Error("Quoted message input GroupAgentRun tidak sah.");
    if (![
      "self_info", "constraint", "correction", "scope_change", "answer",
      "cancel",
    ].includes(input.kind)) throw new Error("Jenis input GroupAgentRun tidak sah.");
    if (input.disposition !== "applied" && input.disposition !== "proposal") {
      throw new Error("Disposition input GroupAgentRun tidak sah.");
    }
    boundedText(input.content, 4_000, "input.content");
    if (input.questionId !== null) safeKey(input.questionId, "input.questionId");
    if ((input.kind === "answer") !== (input.questionId !== null)) {
      throw new Error("Binding question input GroupAgentRun tidak sah.");
    }
    if (typeof input.assignedOverride !== "boolean") {
      throw new Error("Assigned override input GroupAgentRun tidak sah.");
    }
    if (input.kind !== "answer" && input.assignedOverride) {
      throw new Error("Assigned override hanya sah untuk answer GroupAgentRun.");
    }
    if (input.authorityRole !== "member" && input.authorityRole !== "admin") {
      throw new Error("Role authority input GroupAgentRun tidak sah.");
    }
    if (input.assignedOverride && input.authorityRole !== "admin") {
      throw new Error("Assigned override GroupAgentRun membutuhkan authority admin.");
    }
    nonNegativeInteger(input.authorityEpoch, "input.authorityEpoch");
    validIso(input.receivedAt, "input.receivedAt");
    if (input.disposition === "proposal") {
      if (input.instructionRevision !== null || input.kind === "answer" ||
        input.kind === "cancel" || input.kind === "self_info") {
        throw new Error("Proposal GroupAgentRun tidak sah.");
      }
    } else {
      positiveInteger(input.instructionRevision, "input.instructionRevision");
      appliedInputs.push(input);
    }
  }

  if (
    !Array.isArray(run.changeSets) ||
    run.changeSets.length !== run.instructionRevision ||
    appliedInputs.length !== run.changeSets.length
  ) throw new Error("ChangeSet GroupAgentRun tidak cocok dengan input.");
  for (const [index, change] of run.changeSets.entries()) {
    const input = appliedInputs[index]!;
    assertKeys(change, [
      "instructionRevision", "kind", "sourceMessageId",
      "actorParticipantId", "receivedAt",
    ], "changeSet");
    const revision = index + 1;
    if (
      change.instructionRevision !== revision ||
      input.instructionRevision !== revision ||
      change.kind !== input.kind ||
      change.sourceMessageId !== input.sourceMessageId ||
      change.actorParticipantId !== input.actor.participantId ||
      change.receivedAt !== input.receivedAt
    ) throw new Error("Urutan ChangeSet GroupAgentRun tidak sah.");
  }

  if (!Array.isArray(run.questions) || run.questions.length > MAX_QUESTIONS) {
    throw new Error("Question GroupAgentRun tidak sah.");
  }
  let openQuestions = 0;
  const questionIds = new Set<string>();
  const questionMessageIds = new Set<string>();
  for (const question of run.questions) {
    assertKeys(question, [
      "questionId", "prompt", "assignee", "messageId", "status", "askedAt",
      "acceptAnswersAfterIngressRevision", "expiresAt", "answeredBy",
      "answerSourceMessageId", "answeredAt",
    ], "question");
    safeKey(question.questionId, "questionId");
    if (questionIds.has(question.questionId)) {
      throw new Error("Question ID GroupAgentRun duplikat.");
    }
    questionIds.add(question.questionId);
    boundedText(question.prompt, 2_000, "question.prompt");
    validateParticipant(question.assignee, "question.assignee");
    if (!participantIn(question.assignee, run.participants)) {
      throw new Error("Assignee GroupAgentRun bukan participant.");
    }
    safeKey(question.messageId, "question.messageId");
    nonNegativeInteger(
      question.acceptAnswersAfterIngressRevision,
      "question.acceptAnswersAfterIngressRevision",
    );
    if (
      questionMessageIds.has(question.messageId) ||
      question.messageId === run.anchor.messageId
    ) throw new Error("Message ID question GroupAgentRun duplikat.");
    questionMessageIds.add(question.messageId);
    validIso(question.askedAt, "question.askedAt");
    validIso(question.expiresAt, "question.expiresAt");
    if (Date.parse(question.expiresAt) <= Date.parse(question.askedAt)) {
      throw new Error("Horizon question GroupAgentRun tidak sah.");
    }
    if (Date.parse(question.expiresAt) > Date.parse(run.expiresAt)) {
      throw new Error("Question GroupAgentRun melampaui horizon run.");
    }
    if (question.status === "open") {
      openQuestions += 1;
      if (
        question.answeredBy !== null || question.answerSourceMessageId !== null ||
        question.answeredAt !== null
      ) throw new Error("Question open GroupAgentRun memuat jawaban.");
    } else if (question.status === "answered") {
      const answerInput = run.inputs.find((input) =>
        input.kind === "answer" &&
        input.questionId === question.questionId &&
        input.sourceMessageId === question.answerSourceMessageId
      );
      if (
        !question.answeredBy || !question.answerSourceMessageId ||
        !question.answeredAt ||
        !participantIn(question.answeredBy, run.participants) ||
        !answerInput ||
        answerInput.sourceIngressRevision === null ||
        answerInput.sourceIngressRevision <=
          question.acceptAnswersAfterIngressRevision ||
        (answerInput.quotedMessageId !== question.messageId &&
          answerInput.quotedMessageId !== run.anchor.messageId) ||
        Date.parse(question.answeredAt) < Date.parse(question.askedAt) ||
        Date.parse(question.answeredAt) >= Date.parse(question.expiresAt) ||
        Date.parse(question.answeredAt) >= Date.parse(run.expiresAt) ||
        !sameActor(question.answeredBy, answerInput.actor) ||
        question.answeredAt !== answerInput.receivedAt
      ) throw new Error("Question answered GroupAgentRun tanpa provenance.");
      const answeredByAssignee = participantOverlap(
        question.answeredBy,
        question.assignee,
      );
      if (
        !answeredByAssignee &&
        !(answerInput.authorityRole === "admin" && answerInput.assignedOverride)
      ) throw new Error("Answer GroupAgentRun tidak memiliki authority assignee.");
      validateParticipant(question.answeredBy, "question.answeredBy");
      safeKey(question.answerSourceMessageId, "question.answerSourceMessageId");
      validIso(question.answeredAt, "question.answeredAt");
    } else if (question.status === "expired" || question.status === "cancelled") {
      if (
        question.answeredBy !== null || question.answerSourceMessageId !== null ||
        question.answeredAt !== null
      ) throw new Error("Question tertutup GroupAgentRun memuat jawaban.");
    } else {
      throw new Error("Status question GroupAgentRun tidak sah.");
    }
  }
  for (const answer of run.inputs.filter((input) => input.kind === "answer")) {
    const question = run.questions.find((candidate) =>
      candidate.questionId === answer.questionId
    );
    if (
      !question || question.status !== "answered" ||
      question.answerSourceMessageId !== answer.sourceMessageId
    ) throw new Error("Answer GroupAgentRun tidak terikat ke question exact.");
  }
  if (openQuestions > 1 ||
    (run.status === "waiting_input") !== (openQuestions === 1)) {
    throw new Error("Waiting input GroupAgentRun tidak cocok dengan question.");
  }

  if (!Array.isArray(run.events) || run.events.length > MAX_EVENTS) {
    throw new Error("Event GroupAgentRun tidak sah.");
  }
  const eventIds = new Set<string>();
  for (const event of run.events) {
    assertKeys(event, [
      "id", "type", "at", "instructionRevision", "sourceMessageId",
      "participantId",
    ], "event");
    safeKey(event.id, "event.id");
    if (eventIds.has(event.id)) throw new Error("Event GroupAgentRun duplikat.");
    eventIds.add(event.id);
    if (![
      "run.started", "anchor.attached", "input.proposed", "input.applied",
      "input.required", "input.received", "input.expired", "run.expired",
      "run.cancelled",
    ].includes(event.type)) throw new Error("Jenis event GroupAgentRun tidak sah.");
    validIso(event.at, "event.at");
    nonNegativeInteger(event.instructionRevision, "event.instructionRevision");
    if (event.instructionRevision > run.instructionRevision) {
      throw new Error("Revision event GroupAgentRun terlalu baru.");
    }
    if (event.sourceMessageId !== null) safeKey(event.sourceMessageId, "event.sourceMessageId");
    if (event.participantId !== null) safeKey(event.participantId, "event.participantId");
  }
  if (run.events[0]?.type !== "run.started") {
    throw new Error("Event awal GroupAgentRun tidak canonical.");
  }

  validIso(run.createdAt, "createdAt");
  validIso(run.updatedAt, "updatedAt");
  validIso(run.expiresAt, "expiresAt");
  if (run.completedAt !== null) validIso(run.completedAt, "completedAt");
  const created = Date.parse(run.createdAt);
  if (
    Date.parse(run.updatedAt) < created ||
    Date.parse(run.expiresAt) <= created ||
    Date.parse(run.expiresAt) - created > MAX_RETENTION_MS
  ) throw new Error("Horizon GroupAgentRun tidak sah.");
  if (isTerminalGroupAgentRunStatus(run.status) !== (run.completedAt !== null)) {
    throw new Error("Completion GroupAgentRun tidak konsisten.");
  }
  if (run.status === "cancelled" && run.inputs.at(-1)?.kind !== "cancel") {
    throw new Error("Cancellation GroupAgentRun tanpa input teratribusi.");
  }
  if (
    run.status === "cancelled" &&
    (run.events.at(-1)?.type !== "run.cancelled" ||
      run.events.at(-1)?.sourceMessageId !== run.inputs.at(-1)?.sourceMessageId)
  ) throw new Error("Cancellation GroupAgentRun tanpa event exact.");
}

function validateInitialRun(run: GroupAgentRun): void {
  if (
    run.stateRevision !== 1 || run.status !== "queued" || run.phase !== "queued" ||
    run.instructionRevision !== 0 || run.appliedInstructionRevision !== 0 ||
    run.anchor.messageId !== null || run.inputs.length !== 0 ||
    run.changeSets.length !== 0 || run.questions.length !== 0 ||
    run.events.length !== 1 || run.events[0]?.type !== "run.started" ||
    run.participants.length !== 1 ||
    !sameParticipant(run.participants[0]!, run.initiator) ||
    run.completedAt !== null
  ) throw new Error("State awal GroupAgentRun tidak canonical.");
}

function validateTransition(current: GroupAgentRun, next: GroupAgentRun): void {
  if (isTerminalGroupAgentRunStatus(current.status)) {
    throw new Error("GroupAgentRun terminal tidak dapat diubah.");
  }
  if (
    current.version !== next.version || current.runId !== next.runId ||
    current.scopeKey !== next.scopeKey ||
    JSON.stringify(current.scope) !== JSON.stringify(next.scope) ||
    current.accountId !== next.accountId ||
    current.startSourceMessageId !== next.startSourceMessageId ||
    current.initialRequest !== next.initialRequest || current.title !== next.title ||
    JSON.stringify(current.initiator) !== JSON.stringify(next.initiator) ||
    JSON.stringify(current.startAuthority) !== JSON.stringify(next.startAuthority) ||
    JSON.stringify(current.audience) !== JSON.stringify(next.audience) ||
    current.createdAt !== next.createdAt || current.expiresAt !== next.expiresAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    next.instructionRevision < current.instructionRevision ||
    next.appliedInstructionRevision < current.appliedInstructionRevision ||
    !prefixEqual(current.participants, next.participants) ||
    !prefixEqual(current.inputs, next.inputs) ||
    !prefixEqual(current.changeSets, next.changeSets) ||
    !validQuestionTransition(current.questions, next.questions) ||
    !validRollingAppend(current.events, next.events, MAX_EVENTS) ||
    current.anchor.platform !== next.anchor.platform ||
    current.anchor.pinPolicy !== next.anchor.pinPolicy ||
    (current.anchor.messageId !== null &&
      current.anchor.messageId !== next.anchor.messageId) ||
    Date.parse(next.anchor.updatedAt) < Date.parse(current.anchor.updatedAt)
  ) throw new Error("Field immutable/append-only GroupAgentRun berubah.");

  const allowed: Record<GroupAgentRun["status"], readonly GroupAgentRun["status"][]> = {
    queued: ["queued", "running", "waiting_input", "cancelled", "failed"],
    running: ["running", "waiting_input", "paused", "completed", "partial", "failed", "cancelled"],
    waiting_input: ["waiting_input", "running", "cancelled", "failed"],
    paused: ["paused", "running", "cancelled", "failed"],
    completed: [], partial: [], failed: [], cancelled: [],
  };
  if (!allowed[current.status].includes(next.status)) {
    throw new Error("Transisi status GroupAgentRun tidak sah.");
  }
}

function validateParticipant(value: unknown, field: string): asserts value is GroupRunParticipant {
  assertKeys(value, ["participantId", "identityAliases", "displayName"], field);
  const participant = value as GroupRunParticipant;
  safeKey(participant.participantId, `${field}.participantId`);
  if (
    !Array.isArray(participant.identityAliases) ||
    participant.identityAliases.length > 8 ||
    new Set(participant.identityAliases).size !== participant.identityAliases.length ||
    participant.identityAliases.includes(participant.participantId)
  ) throw new Error(`Alias ${field} GroupAgentRun tidak sah.`);
  for (const alias of participant.identityAliases) safeKey(alias, `${field}.alias`);
  if (participant.displayName !== null) boundedText(participant.displayName, 120, `${field}.displayName`);
}

function validStatusPhase(
  status: GroupAgentRun["status"],
  phase: GroupAgentRun["phase"],
): boolean {
  const allowed: Record<GroupAgentRun["status"], readonly GroupAgentRun["phase"][]> = {
    queued: ["queued"],
    running: ["reading_context", "planning", "replanning", "checking", "finalizing"],
    waiting_input: ["waiting_input"],
    paused: ["queued", "planning", "replanning", "checking"],
    completed: ["completed"], partial: ["failed"], failed: ["failed"],
    cancelled: ["cancelled"],
  };
  return Object.prototype.hasOwnProperty.call(allowed, status) &&
    allowed[status].includes(phase);
}

function validQuestionTransition(
  current: readonly GroupAgentRun["questions"][number][],
  next: readonly GroupAgentRun["questions"][number][],
): boolean {
  if (next.length < current.length || next.length > current.length + 1) return false;
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = next[index]!;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (
      index !== current.length - 1 || before.status !== "open" ||
      (after.status !== "answered" && after.status !== "expired" &&
        after.status !== "cancelled") ||
      before.questionId !== after.questionId || before.prompt !== after.prompt ||
      JSON.stringify(before.assignee) !== JSON.stringify(after.assignee) ||
      before.messageId !== after.messageId || before.askedAt !== after.askedAt ||
      before.acceptAnswersAfterIngressRevision !==
        after.acceptAnswersAfterIngressRevision ||
      before.expiresAt !== after.expiresAt
    ) return false;
  }
  return true;
}

function validRollingAppend<T>(
  current: readonly T[],
  next: readonly T[],
  maximum: number,
): boolean {
  if (JSON.stringify(current) === JSON.stringify(next)) return true;
  return current.length < maximum &&
    next.length === current.length + 1 && prefixEqual(current, next);
}

function prefixEqual<T>(current: readonly T[], next: readonly T[]): boolean {
  return next.length >= current.length &&
    JSON.stringify(current) === JSON.stringify(next.slice(0, current.length));
}

function participantIn(
  target: GroupRunParticipant,
  participants: readonly GroupRunParticipant[],
): boolean {
  const targetIds = new Set(participantIdentities(target));
  return participants.some((participant) =>
    participantIdentities(participant).some((identity) => targetIds.has(identity))
  );
}

function participantOverlap(
  left: GroupRunParticipant,
  right: GroupRunParticipant,
): boolean {
  const leftIds = new Set(participantIdentities(left));
  return participantIdentities(right).some((identity) => leftIds.has(identity));
}

function participantIdentities(participant: GroupRunParticipant): string[] {
  return [participant.participantId, ...participant.identityAliases];
}

function sameParticipant(left: GroupRunParticipant, right: GroupRunParticipant): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameActor(left: GroupRunParticipant, right: GroupRunParticipant): boolean {
  return left.participantId === right.participantId &&
    JSON.stringify(left.identityAliases) === JSON.stringify(right.identityAliases) &&
    left.displayName === right.displayName;
}

function assertDatabaseConstraints(runs: readonly GroupAgentRun[]): void {
  if (runs.length > MAX_RUNS) {
    throw new Error("Batas database GroupAgentRun terlampaui.");
  }
  const scopes = new Set<string>();
  const runIds = new Set<string>();
  const sources = new Set<string>();
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (runIds.has(run.runId)) throw new Error("Run ID GroupAgentRun duplikat.");
    runIds.add(run.runId);
    const binding = `${run.scopeKey}\u0000${run.accountId}`;
    const source = `${binding}\u0000${run.startSourceMessageId}`;
    if (sources.has(source)) {
      throw new Error("Start source GroupAgentRun duplikat dalam satu scope.");
    }
    sources.add(source);
    const count = (counts.get(run.scopeKey) ?? 0) + 1;
    if (count > MAX_RUNS_PER_SCOPE) {
      throw new Error("Batas histori GroupAgentRun per scope terlampaui.");
    }
    counts.set(run.scopeKey, count);
    if (isTerminalGroupAgentRunStatus(run.status)) continue;
    if (scopes.has(run.scopeKey)) {
      throw new Error("Lebih dari satu foreground GroupAgentRun untuk satu grup.");
    }
    scopes.add(run.scopeKey);
  }
}

function assertKeys(value: unknown, required: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Schema ${label} GroupAgentRun bukan object.`);
  }
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key))
  ) throw new Error(`Schema ${label} GroupAgentRun memuat field asing atau hilang.`);
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${field} GroupAgentRun tidak sah.`);
  return value;
}

function safeOptionalKey(value: unknown, field: string): boolean {
  safeKey(value, field);
  return true;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > maximum ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) throw new Error(`${field} GroupAgentRun tidak sah.`);
  return value;
}

function positiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} GroupAgentRun tidak sah.`);
  }
}

function nonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} GroupAgentRun tidak sah.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} GroupAgentRun tidak sah.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
