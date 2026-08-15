import { createHash } from "node:crypto";
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
import {
  groupRunExecutionInputDigest,
  isTerminalGroupAgentRunStatus,
} from "../domain/group-agent-run.js";
import { groupScopeKey } from "../domain/group.js";
import { isValidRunBudgetCheckpoint } from "../core/run-budget.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_RUNS = 4_096;
const MAX_RUNS_PER_SCOPE = 128;
const MAX_PARTICIPANTS = 64;
const MAX_INPUTS = 64;
const MAX_QUESTIONS = 32;
const MAX_EVENTS = 256;
const MAX_RECEIPTS = 64;
const MAX_WORK_ATTEMPTS = 32;
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
    const run = canonicalizeRun({
      ...structuredClone(draft),
      stateRevision: 1,
    });
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
    const run = canonicalizeRun({
      ...structuredClone(draft),
      stateRevision: expectedStateRevision + 1,
    });
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

  async removeScope(
    scopeKeyValue: string,
    accountIdValue: string,
  ): Promise<number> {
    const cleanScopeKey = safeKey(scopeKeyValue, "scopeKey");
    const cleanAccountId = safeKey(accountIdValue, "accountId");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const retained = database.runs.filter(
        (run) =>
          run.scopeKey !== cleanScopeKey || run.accountId !== cleanAccountId,
      );
      const removed = database.runs.length - retained.length;
      if (removed > 0) {
        database.runs = retained;
        await this.writeDatabase(database);
      }
      return removed;
    });
  }

  async removeExpired(now: Date): Promise<number> {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("Waktu purge GroupAgentRun tidak sah.");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const retained = database.runs.filter(
        (run) =>
          run.pendingEffect !== null || run.status === "running" ||
          run.workAttempts?.some((attempt) => attempt.status === "running") ||
          Date.parse(run.expiresAt) > timestamp,
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
      const runs = (parsed.runs as unknown[]).map(migrateRun);
      for (const run of runs) validateRun(run);
      assertDatabaseConstraints(runs);
      return { version: 1, runs: structuredClone(runs) };
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
    "pendingEffect", "receipts", "changeSets", "workAttempts", "checkpoint",
    "result", "questions",
    "events", "createdAt", "updatedAt",
    "completedAt", "expiresAt",
  ], "run");
  const run = value as GroupAgentRun;
  if (run.version !== 2) throw new Error("Versi GroupAgentRun tidak sah.");
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

  if (run.pendingEffect !== null) {
    const pending = run.pendingEffect;
    assertKeys(pending, [
      "effectId", "purpose", "instructionRevision", "preparedStateRevision",
      "contentDigest", "question", "workAttemptId", "authority", "preparedAt",
    ], "pendingEffect");
    safeKey(pending.effectId, "pendingEffect.effectId");
    if (
      pending.purpose !== "anchor" &&
      pending.purpose !== "assigned_question" &&
      pending.purpose !== "final_result"
    ) {
      throw new Error("Purpose pending effect GroupAgentRun tidak sah.");
    }
    nonNegativeInteger(
      pending.instructionRevision,
      "pendingEffect.instructionRevision",
    );
    if (pending.instructionRevision > run.instructionRevision) {
      throw new Error("Revision pending effect GroupAgentRun terlalu baru.");
    }
    positiveInteger(
      pending.preparedStateRevision,
      "pendingEffect.preparedStateRevision",
    );
    if (pending.preparedStateRevision >= run.stateRevision) {
      throw new Error("Prepared revision pending effect GroupAgentRun tidak sah.");
    }
    sha256(pending.contentDigest, "pendingEffect.contentDigest");
    validateDeliveryAuthority(
      pending.authority,
      pending.question !== null,
      "pendingEffect.authority",
    );
    validIso(pending.preparedAt, "pendingEffect.preparedAt");
    if (pending.workAttemptId !== null) {
      safeKey(pending.workAttemptId, "pendingEffect.workAttemptId");
    }
    if (pending.purpose === "anchor") {
      if (
        pending.question !== null || pending.workAttemptId !== null ||
        run.anchor.messageId !== null
      ) {
        throw new Error("Pending anchor GroupAgentRun tidak sah.");
      }
    } else if (pending.purpose === "assigned_question") {
      if (!pending.question) {
        throw new Error("Pending question GroupAgentRun tidak sah.");
      }
      assertKeys(pending.question, [
        "questionId", "prompt", "assignee", "expiresAt",
      ], "pendingEffect.question");
      safeKey(pending.question.questionId, "pendingEffect.question.questionId");
      boundedText(pending.question.prompt, 2_000, "pendingEffect.question.prompt");
      validateParticipant(pending.question.assignee, "pendingEffect.question.assignee");
      validIso(pending.question.expiresAt, "pendingEffect.question.expiresAt");
      if (
        Date.parse(pending.question.expiresAt) <= Date.parse(pending.preparedAt) ||
        Date.parse(pending.question.expiresAt) > Date.parse(run.expiresAt)
      ) throw new Error("Pending question GroupAgentRun melewati horizon.");
    } else if (
      pending.question !== null || pending.workAttemptId === null ||
      run.anchor.messageId === null || (run.result ?? null) !== null
    ) {
      throw new Error("Pending final result GroupAgentRun tidak sah.");
    }
  }

  if (!Array.isArray(run.receipts) || run.receipts.length > MAX_RECEIPTS) {
    throw new Error("Receipt GroupAgentRun tidak sah.");
  }
  const receiptEffects = new Set<string>();
  for (const receipt of run.receipts) {
    assertKeys(receipt, [
      "receiptId", "effectId", "effect", "purpose", "instructionRevision",
      "preparedStateRevision", "contentDigest", "subjectId", "workAttemptId", "status",
      "authority", "externalMessageId", "committedAt", "reversible",
    ], "receipt");
    safeKey(receipt.receiptId, "receipt.receiptId");
    safeKey(receipt.effectId, "receipt.effectId");
    if (receiptEffects.has(receipt.effectId)) {
      throw new Error("Effect receipt GroupAgentRun duplikat.");
    }
    receiptEffects.add(receipt.effectId);
    if (
      receipt.effect !== "whatsapp.message.send" ||
      (receipt.purpose !== "anchor" &&
        receipt.purpose !== "assigned_question" &&
        receipt.purpose !== "final_result") ||
      (receipt.status !== "committed" && receipt.status !== "unknown" &&
        receipt.status !== "not_committed") ||
      receipt.reversible !== false
    ) throw new Error("Kontrak receipt GroupAgentRun tidak sah.");
    nonNegativeInteger(receipt.instructionRevision, "receipt.instructionRevision");
    if (receipt.instructionRevision > run.instructionRevision) {
      throw new Error("Revision receipt GroupAgentRun terlalu baru.");
    }
    positiveInteger(receipt.preparedStateRevision, "receipt.preparedStateRevision");
    sha256(receipt.contentDigest, "receipt.contentDigest");
    if (receipt.subjectId !== null) safeKey(receipt.subjectId, "receipt.subjectId");
    if (receipt.workAttemptId !== null) {
      safeKey(receipt.workAttemptId, "receipt.workAttemptId");
    }
    if (
      (receipt.purpose === "anchor" && receipt.workAttemptId !== null) ||
      (receipt.purpose === "final_result" &&
        (receipt.workAttemptId === null ||
          receipt.workAttemptId !== receipt.subjectId))
    ) throw new Error("Receipt work attempt GroupAgentRun tidak sah.");
    validateDeliveryAuthority(
      receipt.authority,
      receipt.purpose === "assigned_question",
      "receipt.authority",
    );
    validIso(receipt.committedAt, "receipt.committedAt");
    if (
      (receipt.status === "committed") !== (receipt.externalMessageId !== null)
    ) throw new Error("External ID receipt GroupAgentRun tidak konsisten.");
    if (receipt.externalMessageId !== null) {
      safeKey(receipt.externalMessageId, "receipt.externalMessageId");
    }
    if (
      (receipt.purpose === "anchor") !== (receipt.subjectId === null) ||
      (receipt.purpose !== "anchor" && receipt.subjectId === null)
    ) throw new Error("Subject receipt GroupAgentRun tidak sah.");
  }
  if (run.pendingEffect && receiptEffects.has(run.pendingEffect.effectId)) {
    throw new Error("Pending effect GroupAgentRun sudah mempunyai receipt.");
  }

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

  if (
    !Array.isArray(run.workAttempts) ||
    run.workAttempts.length > MAX_WORK_ATTEMPTS
  ) throw new Error("Work attempt GroupAgentRun tidak sah.");
  const workAttemptIds = new Set<string>();
  const workClaimKeys = new Set<string>();
  let runningWorkAttempts = 0;
  for (const [index, attempt] of run.workAttempts.entries()) {
    assertKeys(attempt, [
      "attemptId", "claimKey", "attemptNumber", "instructionRevision",
      "claimedStateRevision", "status", "startedAt", "settledAt", "code",
    ], "workAttempt");
    safeKey(attempt.attemptId, "workAttempt.attemptId");
    safeKey(attempt.claimKey, "workAttempt.claimKey");
    if (
      workAttemptIds.has(attempt.attemptId) ||
      workClaimKeys.has(attempt.claimKey)
    ) throw new Error("Identitas work attempt GroupAgentRun duplikat.");
    workAttemptIds.add(attempt.attemptId);
    workClaimKeys.add(attempt.claimKey);
    if (attempt.attemptNumber !== index + 1) {
      throw new Error("Nomor work attempt GroupAgentRun tidak canonical.");
    }
    nonNegativeInteger(
      attempt.instructionRevision,
      "workAttempt.instructionRevision",
    );
    positiveInteger(
      attempt.claimedStateRevision,
      "workAttempt.claimedStateRevision",
    );
    if (
      attempt.instructionRevision > run.instructionRevision ||
      attempt.claimedStateRevision >= run.stateRevision
    ) throw new Error("Revision work attempt GroupAgentRun tidak sah.");
    validIso(attempt.startedAt, "workAttempt.startedAt");
    const previousAttempt = run.workAttempts[index - 1];
    if (
      previousAttempt &&
      (previousAttempt.settledAt === null ||
        attempt.claimedStateRevision <= previousAttempt.claimedStateRevision ||
        Date.parse(attempt.startedAt) < Date.parse(previousAttempt.settledAt))
    ) throw new Error("Urutan work attempt GroupAgentRun tidak sah.");
    if (
      Date.parse(attempt.startedAt) < Date.parse(run.createdAt) ||
      Date.parse(attempt.startedAt) > Date.parse(run.updatedAt)
    ) throw new Error("Waktu mulai work attempt GroupAgentRun tidak sah.");
    if (attempt.status === "running") {
      runningWorkAttempts += 1;
      if (
        index !== run.workAttempts.length - 1 ||
        attempt.settledAt !== null || attempt.code !== null
      ) throw new Error("Work attempt running GroupAgentRun tidak canonical.");
      continue;
    }
    if (!["completed", "failed", "requeued", "cancelled"].includes(
      attempt.status,
    )) throw new Error("Status work attempt GroupAgentRun tidak sah.");
    if (attempt.settledAt === null) {
      throw new Error("Work attempt terminal GroupAgentRun tanpa waktu selesai.");
    }
    validIso(attempt.settledAt, "workAttempt.settledAt");
    if (
      Date.parse(attempt.settledAt) < Date.parse(attempt.startedAt) ||
      Date.parse(attempt.settledAt) > Date.parse(run.updatedAt)
    ) throw new Error("Waktu selesai work attempt GroupAgentRun tidak sah.");
    if (attempt.status === "completed") {
      if (attempt.code !== null) {
        throw new Error("Work attempt completed GroupAgentRun memuat kode.");
      }
    } else {
      machineCode(attempt.code, "workAttempt.code");
    }
  }
  if (
    runningWorkAttempts > 1 ||
    (runningWorkAttempts === 1 &&
      run.status !== "running" && run.status !== "paused")
  ) throw new Error("Active work attempt GroupAgentRun tidak konsisten.");
  if (run.pendingEffect?.purpose === "final_result") {
    const active = run.workAttempts.find((attempt) =>
      attempt.status === "running"
    );
    if (
      run.status !== "running" || !active ||
      active.attemptId !== run.pendingEffect.workAttemptId ||
      active.instructionRevision !== run.instructionRevision ||
      run.pendingEffect.instructionRevision !== run.instructionRevision ||
      !run.receipts.some((receipt) =>
        receipt.purpose === "anchor" && receipt.status === "committed" &&
        receipt.externalMessageId === run.anchor.messageId
      )
    ) throw new Error("Pending final result tidak mengikat work attempt exact.");
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
  for (const receipt of run.receipts) {
    if (receipt.preparedStateRevision >= run.stateRevision) {
      throw new Error("Prepared revision receipt GroupAgentRun tidak sah.");
    }
    if (receipt.status !== "committed") continue;
    if (receipt.purpose === "anchor") {
      if (run.anchor.messageId !== receipt.externalMessageId) {
        throw new Error("Receipt anchor GroupAgentRun tidak mengikat pesan exact.");
      }
      continue;
    }
    if (receipt.purpose === "final_result") continue;
    const deliveredQuestion = run.questions.find((question) =>
      question.questionId === receipt.subjectId &&
      question.messageId === receipt.externalMessageId
    );
    if (!deliveredQuestion) {
      throw new Error("Receipt question GroupAgentRun tidak mengikat pesan exact.");
    }
    if (
      receipt.workAttemptId !== null &&
      !run.workAttempts.some((attempt) =>
        attempt.attemptId === receipt.workAttemptId &&
        attempt.instructionRevision === receipt.instructionRevision
      )
    ) throw new Error("Receipt question tidak mengikat attempt exact.");
  }
  const finalReceipts = run.receipts.filter((receipt) =>
    receipt.purpose === "final_result"
  );
  for (const receipt of finalReceipts) {
    const attempt = run.workAttempts.find((candidate) =>
      candidate.attemptId === receipt.workAttemptId &&
      candidate.instructionRevision === receipt.instructionRevision
    );
    if (!attempt) {
      throw new Error("Receipt final GroupAgentRun tidak mengikat attempt exact.");
    }
    if (receipt.status === "unknown" && attempt.status !== "failed") {
      throw new Error("Receipt final unknown tidak menutup attempt.");
    }
  }
  const committedFinalReceipts = finalReceipts.filter((receipt) =>
    receipt.status === "committed"
  );
  const result = run.result ?? null;
  if (result === null) {
    if (committedFinalReceipts.length !== 0 || run.status === "completed") {
      throw new Error(
        "Final result/work attempt GroupAgentRun hilang dari completion.",
      );
    }
  } else {
    assertKeys(result, [
      "kind", "text", "contentDigest", "instructionRevision", "attemptId",
      "messageId", "committedAt",
    ], "result");
    if (result.kind !== "final") {
      throw new Error("Kind final result GroupAgentRun tidak sah.");
    }
    boundedText(result.text, 3_900, "result.text");
    sha256(result.contentDigest, "result.contentDigest");
    if (contentDigest(result.text) !== result.contentDigest) {
      throw new Error("Digest final result GroupAgentRun tidak cocok.");
    }
    nonNegativeInteger(result.instructionRevision, "result.instructionRevision");
    safeKey(result.attemptId, "result.attemptId");
    safeKey(result.messageId, "result.messageId");
    validIso(result.committedAt, "result.committedAt");
    const completedAttempt = run.workAttempts.find((attempt) =>
      attempt.attemptId === result.attemptId &&
      attempt.instructionRevision === result.instructionRevision &&
      attempt.status === "completed" && attempt.code === null &&
      attempt.settledAt === result.committedAt
    );
    const committedReceipt = committedFinalReceipts[0];
    if (
      run.status !== "completed" || run.phase !== "completed" ||
      run.completedAt !== result.committedAt ||
      run.appliedInstructionRevision !== result.instructionRevision ||
      result.instructionRevision !== run.instructionRevision ||
      !completedAttempt || committedFinalReceipts.length !== 1 ||
      committedReceipt?.subjectId !== result.attemptId ||
      committedReceipt.workAttemptId !== result.attemptId ||
      committedReceipt.instructionRevision !== result.instructionRevision ||
      committedReceipt.contentDigest !== result.contentDigest ||
      committedReceipt.externalMessageId !== result.messageId ||
      committedReceipt.committedAt !== result.committedAt ||
      run.events.at(-1)?.type !== "run.completed" ||
      run.events.at(-1)?.at !== result.committedAt ||
      run.events.at(-1)?.instructionRevision !== result.instructionRevision ||
      run.events.at(-1)?.sourceMessageId !== result.messageId
    ) throw new Error("Final result GroupAgentRun tidak canonical.");
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
      "run.started", "run.completed", "work.claimed", "work.completed", "work.failed",
      "work.requeued", "work.recovered", "anchor.attached", "input.proposed", "input.applied",
      "input.required", "input.received", "input.expired", "run.expired",
      "run.cancelled", "delivery.prepared", "delivery.unknown",
      "delivery.not_committed",
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
  validateExecutionCheckpoint(run);
  if (isTerminalGroupAgentRunStatus(run.status) !== (run.completedAt !== null)) {
    throw new Error("Completion GroupAgentRun tidak konsisten.");
  }
  if (run.pendingEffect && isTerminalGroupAgentRunStatus(run.status)) {
    throw new Error("GroupAgentRun terminal masih mempunyai pending effect.");
  }
  if (
    run.receipts.some((receipt) => receipt.status === "unknown") &&
    run.status !== "partial"
  ) throw new Error("Receipt unknown GroupAgentRun tidak gagal tertutup.");
  if (run.status === "cancelled" && run.inputs.at(-1)?.kind !== "cancel") {
    throw new Error("Cancellation GroupAgentRun tanpa input teratribusi.");
  }
  if (
    run.status === "cancelled" &&
    (run.events.at(-1)?.type !== "run.cancelled" ||
      run.events.at(-1)?.sourceMessageId !== run.inputs.at(-1)?.sourceMessageId)
  ) throw new Error("Cancellation GroupAgentRun tanpa event exact.");
}

function migrateRun(value: unknown): GroupAgentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Record GroupAgentRun tidak sah.");
  }
  const record = structuredClone(value) as Record<string, unknown>;
  const legacyVersion = record.version === 1;
  const migratedWithoutResult = !Object.prototype.hasOwnProperty.call(
    record,
    "result",
  );
  let migratedWithoutWorkLedger = false;
  if (record.version === 1) {
    const carriesWorkLedger = Object.prototype.hasOwnProperty.call(
      record,
      "workAttempts",
    );
    const carriesResult = Object.prototype.hasOwnProperty.call(
      record,
      "result",
    );
    assertKeys(record, [
      "version", "runId", "scopeKey", "scope", "accountId",
      "startSourceMessageId", "initialRequest", "title", "initiator",
      "startAuthority", "participants", "audience", "status", "phase",
      "instructionRevision", "appliedInstructionRevision", "stateRevision",
      "anchor", "inputs", "changeSets", "questions", "events", "createdAt",
      "updatedAt", "completedAt", "expiresAt",
      ...(carriesWorkLedger ? ["workAttempts"] : []),
      ...(carriesResult ? ["result"] : []),
    ], "legacy run");
    record.version = 2;
    record.pendingEffect = null;
    record.receipts = [];
    migratedWithoutWorkLedger = !carriesWorkLedger;
    record.workAttempts ??= [];
  } else if (
    record.version === 2 &&
    !Object.prototype.hasOwnProperty.call(record, "workAttempts")
  ) {
    const carriesResult = Object.prototype.hasOwnProperty.call(
      record,
      "result",
    );
    assertKeys(record, [
      "version", "runId", "scopeKey", "scope", "accountId",
      "startSourceMessageId", "initialRequest", "title", "initiator",
      "startAuthority", "participants", "audience", "status", "phase",
      "instructionRevision", "appliedInstructionRevision", "stateRevision",
      "anchor", "inputs", "pendingEffect", "receipts", "changeSets",
      "questions", "events", "createdAt", "updatedAt", "completedAt",
      "expiresAt",
      ...(carriesResult ? ["result"] : []),
    ], "legacy v2 run");
    record.workAttempts = [];
    migratedWithoutWorkLedger = true;
  }
  normalizeCurrentOptionalFields(record);
  if (
    migratedWithoutWorkLedger &&
    (record.status === "running" || record.status === "paused")
  ) {
    const hasOpenQuestion = Array.isArray(record.questions) &&
      record.questions.some((question) =>
        question !== null && typeof question === "object" &&
        !Array.isArray(question) &&
        (question as Record<string, unknown>).status === "open"
      );
    record.status = hasOpenQuestion ? "waiting_input" : "queued";
    record.phase = hasOpenQuestion ? "waiting_input" : "queued";
  }
  if (
    (legacyVersion || migratedWithoutResult) && record.status === "completed" &&
    record.result === null
  ) {
    // Schema lama tidak mempunyai final delivery receipt. Pertahankan terminal
    // horizon, tetapi jangan mengklaim hasil user-visible yang tak terbukti.
    record.status = "partial";
    record.phase = "failed";
  }
  validateRun(record);
  return structuredClone(record);
}

function canonicalizeRun(value: unknown): GroupAgentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Record GroupAgentRun tidak sah.");
  }
  const record = structuredClone(value) as Record<string, unknown>;
  normalizeCurrentOptionalFields(record);
  validateRun(record);
  return structuredClone(record);
}

function normalizeCurrentOptionalFields(record: Record<string, unknown>): void {
  record.workAttempts ??= [];
  record.checkpoint ??= null;
  record.result ??= null;
  if (Array.isArray(record.receipts)) {
    for (const value of record.receipts) {
      if (
        value && typeof value === "object" && !Array.isArray(value) &&
        !Object.prototype.hasOwnProperty.call(value, "workAttemptId")
      ) {
        const receipt = value as Record<string, unknown>;
        receipt.workAttemptId = receipt.purpose === "final_result"
          ? receipt.subjectId ?? null
          : null;
      }
    }
  }
  if (
    record.pendingEffect !== null && record.pendingEffect !== undefined &&
    typeof record.pendingEffect === "object" &&
    !Array.isArray(record.pendingEffect) &&
    !Object.prototype.hasOwnProperty.call(record.pendingEffect, "workAttemptId")
  ) {
    (record.pendingEffect as Record<string, unknown>).workAttemptId = null;
  }
}

function validateInitialRun(run: GroupAgentRun): void {
  if (
    run.stateRevision !== 1 || run.status !== "queued" || run.phase !== "queued" ||
    run.instructionRevision !== 0 || run.appliedInstructionRevision !== 0 ||
    run.anchor.messageId !== null || run.inputs.length !== 0 ||
    run.pendingEffect !== null || run.receipts.length !== 0 ||
    run.changeSets.length !== 0 || run.workAttempts?.length !== 0 ||
    (run.checkpoint ?? null) !== null ||
    (run.result ?? null) !== null ||
    run.questions.length !== 0 ||
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
    !validRollingAppend(current.receipts, next.receipts, MAX_RECEIPTS) ||
    !validQuestionTransition(current.questions, next.questions) ||
    !validEventTransition(current, next) ||
    current.anchor.platform !== next.anchor.platform ||
    current.anchor.pinPolicy !== next.anchor.pinPolicy ||
    (current.anchor.messageId !== null &&
      current.anchor.messageId !== next.anchor.messageId) ||
    Date.parse(next.anchor.updatedAt) < Date.parse(current.anchor.updatedAt)
  ) throw new Error("Field immutable/append-only GroupAgentRun berubah.");

  if (!validPendingEffectTransition(current, next)) {
    throw new Error("Transisi pending effect GroupAgentRun tidak sah.");
  }
  if (!validWorkAttemptTransition(current, next)) {
    throw new Error("Transisi work attempt GroupAgentRun tidak sah.");
  }
  if (!validResultTransition(current, next)) {
    throw new Error("Transisi final result GroupAgentRun tidak sah.");
  }
  if (!validExecutionCheckpointTransition(current, next)) {
    throw new Error("Transisi checkpoint GroupAgentRun tidak sah.");
  }
  if (
    !isTerminalGroupAgentRunStatus(next.status) &&
    next.pendingEffect === null && next.events.length >= MAX_EVENTS
  ) {
    throw new Error(
      "GroupAgentRun nonterminal harus menyisakan slot event penutupan.",
    );
  }

  const allowed: Record<GroupAgentRun["status"], readonly GroupAgentRun["status"][]> = {
    queued: ["queued", "running", "waiting_input", "partial", "cancelled", "failed"],
    running: ["queued", "running", "waiting_input", "paused", "completed", "partial", "failed", "cancelled"],
    waiting_input: ["waiting_input", "running", "cancelled", "failed"],
    paused: ["queued", "paused", "running", "cancelled", "failed"],
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

function validateExecutionCheckpoint(run: GroupAgentRun): void {
  const checkpoint = run.checkpoint ?? null;
  const pendingQuestion = run.pendingEffect?.purpose === "assigned_question"
    ? run.pendingEffect
    : null;
  if (checkpoint === null) {
    if (pendingQuestion && pendingQuestion.workAttemptId !== null) {
      throw new Error("Pending work question tanpa checkpoint exact.");
    }
    if (pendingQuestion && (run.workAttempts?.length ?? 0) > 0) {
      throw new Error("Legacy question tidak sah setelah work attempt dimulai.");
    }
    return;
  }
  assertKeys(checkpoint, [
    "version", "engine", "attemptId", "sequence", "instructionRevision",
    "inputDigest", "waitingQuestionId", "budget", "updatedAt",
  ], "checkpoint");
  if (checkpoint.version !== 1 || checkpoint.engine !== "group-model-v1") {
    throw new Error("Versi/engine checkpoint GroupAgentRun tidak sah.");
  }
  safeKey(checkpoint.attemptId, "checkpoint.attemptId");
  if (
    !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1 ||
    checkpoint.sequence > 32
  ) throw new Error("Sequence checkpoint GroupAgentRun tidak sah.");
  nonNegativeInteger(
    checkpoint.instructionRevision,
    "checkpoint.instructionRevision",
  );
  sha256(checkpoint.inputDigest, "checkpoint.inputDigest");
  if (checkpoint.waitingQuestionId !== null) {
    safeKey(checkpoint.waitingQuestionId, "checkpoint.waitingQuestionId");
  }
  if (!isValidRunBudgetCheckpoint(checkpoint.budget)) {
    throw new Error("Budget checkpoint GroupAgentRun tidak sah.");
  }
  validIso(checkpoint.updatedAt, "checkpoint.updatedAt");
  if (
    Date.parse(checkpoint.updatedAt) < Date.parse(run.createdAt) ||
    Date.parse(checkpoint.updatedAt) > Date.parse(run.updatedAt)
  ) throw new Error("Waktu checkpoint GroupAgentRun tidak sah.");
  const attempt = run.workAttempts?.find((candidate) =>
    candidate.attemptId === checkpoint.attemptId
  );
  if (
    !attempt || attempt.instructionRevision !== checkpoint.instructionRevision ||
    checkpoint.inputDigest !== groupRunExecutionInputDigest(
      run,
      checkpoint.instructionRevision,
    )
  ) throw new Error("Checkpoint tidak mengikat attempt/input exact.");

  if (pendingQuestion) {
    if (
      pendingQuestion.workAttemptId !== checkpoint.attemptId ||
      pendingQuestion.instructionRevision !== checkpoint.instructionRevision ||
      checkpoint.waitingQuestionId !== pendingQuestion.question?.questionId ||
      attempt.status !== "running"
    ) throw new Error("Pending question tidak mengikat checkpoint exact.");
    return;
  }
  if (checkpoint.waitingQuestionId === null) return;
  const openQuestion = run.questions.find((question) =>
    question.questionId === checkpoint.waitingQuestionId &&
    question.status === "open"
  );
  if (
    run.status !== "waiting_input" || !openQuestion ||
    attempt !== run.workAttempts?.at(-1) || attempt.status !== "requeued" ||
    attempt.code !== "waiting_input"
  ) throw new Error("Checkpoint waiting question GroupAgentRun tidak sah.");
}

function validateDeliveryAuthority(
  value: unknown,
  assigned: boolean,
  field: string,
): void {
  assertKeys(value, [
    "initiatorRole", "assigneeRole", "authorityEpoch",
  ], field);
  const authority = value as {
    initiatorRole: unknown;
    assigneeRole: unknown;
    authorityEpoch: unknown;
  };
  if (
    (authority.initiatorRole !== "member" &&
      authority.initiatorRole !== "admin") ||
    (assigned
      ? authority.assigneeRole !== "member" && authority.assigneeRole !== "admin"
      : authority.assigneeRole !== null)
  ) throw new Error(`${field} GroupAgentRun tidak sah.`);
  nonNegativeInteger(authority.authorityEpoch, `${field}.authorityEpoch`);
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

function validPendingEffectTransition(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  if (current.pendingEffect === null && next.pendingEffect !== null) {
    const activeAttempt = current.workAttempts?.some((attempt) =>
      attempt.status === "running"
    ) ?? false;
    const maximumPreparedEvents =
      next.pendingEffect.purpose === "assigned_question"
        ? MAX_EVENTS - 3
        : MAX_EVENTS - 2;
    return current.receipts.length < MAX_RECEIPTS &&
      next.receipts.length === current.receipts.length &&
      next.pendingEffect.preparedStateRevision === current.stateRevision &&
      next.anchor.messageId === current.anchor.messageId &&
      next.questions.length === current.questions.length &&
      next.events.length <= maximumPreparedEvents &&
      (!activeAttempt || next.events.length <= MAX_EVENTS - 2) &&
      JSON.stringify(next.result ?? null) ===
        JSON.stringify(current.result ?? null);
  }
  if (current.pendingEffect !== null && next.pendingEffect === null) {
    const receipt = next.receipts.at(-1);
    if (!(next.receipts.length === current.receipts.length + 1 &&
      receipt?.effectId === current.pendingEffect.effectId &&
      receipt.purpose === current.pendingEffect.purpose &&
      receipt.instructionRevision === current.pendingEffect.instructionRevision &&
      receipt.preparedStateRevision === current.pendingEffect.preparedStateRevision &&
      receipt.contentDigest === current.pendingEffect.contentDigest &&
      receipt.subjectId === pendingDeliverySubjectId(current.pendingEffect) &&
      receipt.workAttemptId === current.pendingEffect.workAttemptId &&
      JSON.stringify(receipt.authority) ===
        JSON.stringify(current.pendingEffect.authority))) return false;
    if (receipt.status !== "committed") {
      return next.anchor.messageId === current.anchor.messageId &&
        next.questions.length === current.questions.length;
    }
    if (receipt.purpose === "anchor") {
      return current.anchor.messageId === null &&
        next.anchor.messageId === receipt.externalMessageId &&
        next.questions.length === current.questions.length;
    }
    if (receipt.purpose === "final_result") {
      return next.anchor.messageId === current.anchor.messageId &&
        next.questions.length === current.questions.length &&
        receipt.status === "committed" && next.result !== null;
    }
    const question = next.questions.at(-1);
    return next.anchor.messageId === current.anchor.messageId &&
      next.questions.length === current.questions.length + 1 &&
      question?.questionId === receipt.subjectId &&
      question.messageId === receipt.externalMessageId;
  }
  return current.pendingEffect === null && next.pendingEffect === null &&
    next.receipts.length === current.receipts.length &&
    next.anchor.messageId === current.anchor.messageId &&
    next.questions.length === current.questions.length &&
    JSON.stringify(next.result ?? null) ===
      JSON.stringify(current.result ?? null);
}

function validResultTransition(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  const before = current.result ?? null;
  const after = next.result ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  if (before !== null || after === null) return false;
  const pending = current.pendingEffect;
  const receipt = next.receipts.at(-1);
  return Boolean(
    pending?.purpose === "final_result" && pending.workAttemptId !== null &&
    next.pendingEffect === null && receipt?.purpose === "final_result" &&
    receipt.status === "committed" &&
    receipt.effectId === pending.effectId &&
    receipt.subjectId === pending.workAttemptId &&
    receipt.workAttemptId === pending.workAttemptId &&
    after.kind === "final" && after.attemptId === pending.workAttemptId &&
    after.text.length > 0 && after.contentDigest === pending.contentDigest &&
    after.instructionRevision === pending.instructionRevision &&
    after.messageId === receipt.externalMessageId &&
    after.committedAt === receipt.committedAt
  );
}

function validExecutionCheckpointTransition(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  const before = current.checkpoint ?? null;
  const after = next.checkpoint ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  if (after === null) {
    const deliveryClosed = current.pendingEffect?.purpose ===
        "assigned_question" && next.pendingEffect === null &&
      next.receipts.at(-1)?.effectId === current.pendingEffect.effectId &&
      next.receipts.at(-1)?.status !== "committed";
    const waitingClosed = current.status === "waiting_input" &&
      next.status !== "waiting_input" &&
      ["input.received", "input.expired", "run.cancelled"].includes(
        next.events.at(-1)?.type ?? "",
      );
    return before !== null && (deliveryClosed || waitingClosed);
  }
  if (
    before !== null && before.waitingQuestionId !== null &&
    after.waitingQuestionId === null &&
    after.updatedAt === next.updatedAt &&
    (current.status === "waiting_input" ||
      (current.pendingEffect?.purpose === "assigned_question" &&
        next.pendingEffect === null &&
        next.receipts.at(-1)?.effectId === current.pendingEffect.effectId &&
        next.receipts.at(-1)?.status !== "committed")) &&
    [
      "input.received", "input.expired", "run.cancelled",
      "delivery.not_committed", "delivery.unknown",
    ].includes(
      next.events.at(-1)?.type ?? "",
    ) && sameCheckpointExceptWaitingAndUpdatedAt(before, after)
  ) return true;

  // Work processor mempersist hasil sampling lebih dulu, lalu menambahkan
  // questionId pada checkpoint yang sama tepat sebelum delivery. Ini bukan
  // sampling/model step baru, jadi sequence dan budget wajib tetap identik.
  const bindsPreparedQuestion = before !== null &&
    before.waitingQuestionId === null && after.waitingQuestionId !== null &&
    after.updatedAt === next.updatedAt &&
    current.pendingEffect === null &&
    next.pendingEffect?.purpose === "assigned_question" &&
    next.pendingEffect.workAttemptId === before.attemptId &&
    next.pendingEffect.question?.questionId === after.waitingQuestionId &&
    sameCheckpointExceptWaitingAndUpdatedAt(before, after);
  if (bindsPreparedQuestion) return true;

  const active = current.workAttempts?.find((attempt) =>
    attempt.status === "running"
  );
  if (
    !active || active.attemptId !== after.attemptId ||
    active.instructionRevision !== after.instructionRevision ||
    current.instructionRevision !== after.instructionRevision ||
    after.updatedAt !== next.updatedAt ||
    (before === null
      ? after.sequence !== 1
      : after.sequence !== before.sequence + 1 ||
        !monotonicBudgetCheckpoint(before.budget, after.budget))
  ) return false;

  const standalone = sameRunExceptCheckpointAndUpdatedAt(current, next);
  const preparesQuestion = current.pendingEffect === null &&
    next.pendingEffect?.purpose === "assigned_question" &&
    next.pendingEffect.workAttemptId === active.attemptId &&
    next.pendingEffect.question?.questionId === after.waitingQuestionId;
  return standalone || preparesQuestion;
}

function sameCheckpointExceptWaitingAndUpdatedAt(
  before: NonNullable<GroupAgentRun["checkpoint"]>,
  after: NonNullable<GroupAgentRun["checkpoint"]>,
): boolean {
  return before.version === after.version && before.engine === after.engine &&
    before.attemptId === after.attemptId &&
    before.sequence === after.sequence &&
    before.instructionRevision === after.instructionRevision &&
    before.inputDigest === after.inputDigest &&
    JSON.stringify(before.budget) === JSON.stringify(after.budget);
}

function sameRunExceptCheckpointAndUpdatedAt(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  const left = structuredClone(current) as GroupAgentRun & {
    checkpoint?: unknown;
  };
  const right = structuredClone(next) as GroupAgentRun & {
    checkpoint?: unknown;
  };
  delete left.checkpoint;
  delete right.checkpoint;
  left.updatedAt = right.updatedAt;
  left.stateRevision = right.stateRevision;
  return JSON.stringify(left) === JSON.stringify(right);
}

function monotonicBudgetCheckpoint(
  before: NonNullable<GroupAgentRun["checkpoint"]>["budget"],
  after: NonNullable<GroupAgentRun["checkpoint"]>["budget"],
): boolean {
  if (
    !isValidRunBudgetCheckpoint(before) ||
    !isValidRunBudgetCheckpoint(after) ||
    JSON.stringify(before.limits) !== JSON.stringify(after.limits) ||
    JSON.stringify(before.prices) !== JSON.stringify(after.prices)
  ) return false;
  return after.consumedTokens >= before.consumedTokens &&
    BigInt(after.consumedCostUsdNanos) >=
      BigInt(before.consumedCostUsdNanos) &&
    after.modelCalls >= before.modelCalls &&
    after.toolCalls >= before.toolCalls &&
    after.unknownUsageAttempts >= before.unknownUsageAttempts &&
    after.activeElapsedMs >= before.activeElapsedMs;
}

function validWorkAttemptTransition(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  const before = current.workAttempts ?? [];
  const after = next.workAttempts ?? [];
  if (JSON.stringify(before) === JSON.stringify(after)) {
    const finalizingRecovery = current.status === "running" &&
      current.phase === "finalizing" && next.status === "queued" &&
      next.phase === "queued" && before.at(-1)?.status === "completed" &&
      next.events.at(-1)?.type === "work.recovered" &&
      next.events.length <= MAX_EVENTS - 1;
    if (finalizingRecovery) return true;
    const activeContinues = before.some((attempt) =>
      attempt.status === "running"
    );
    const activeNotCommitted = current.pendingEffect !== null &&
      next.pendingEffect === null &&
      next.receipts.at(-1)?.effectId === current.pendingEffect.effectId &&
      next.receipts.at(-1)?.status === "not_committed";
    return !(
      before.some((attempt) => attempt.status === "running") &&
      isTerminalGroupAgentRunStatus(next.status)
    ) && next.status !== "completed" &&
      (!activeContinues || next.events.length <= MAX_EVENTS - 2 ||
        (activeNotCommitted && next.events.length <= MAX_EVENTS - 1)) &&
      !((current.status === "queued" || current.status === "paused") &&
        next.status === "running") &&
      !(current.status !== "queued" && next.status === "queued");
  }
  if (after.length === before.length + 1 && prefixEqual(before, after)) {
    const claimed = after.at(-1);
    return Boolean(
      claimed && before.length < MAX_WORK_ATTEMPTS &&
      !before.some((attempt) => attempt.status === "running") &&
      claimed.status === "running" &&
      claimed.attemptNumber === after.length &&
      claimed.instructionRevision === current.instructionRevision &&
      next.instructionRevision === current.instructionRevision &&
      claimed.claimedStateRevision === current.stateRevision &&
      claimed.startedAt === next.updatedAt &&
      current.anchor.messageId !== null && current.pendingEffect === null &&
      next.events.length <= MAX_EVENTS - 3 &&
      next.status === "running" &&
      (next.phase === "reading_context" || next.phase === "replanning") &&
      next.events.at(-1)?.type === "work.claimed"
    );
  }
  if (after.length !== before.length || before.length === 0) return false;
  const prior = before.at(-1)!;
  const settled = after.at(-1)!;
  if (
    !prefixEqual(before.slice(0, -1), after.slice(0, -1)) ||
    prior.status !== "running" || settled.status === "running" ||
    prior.attemptId !== settled.attemptId ||
    prior.claimKey !== settled.claimKey ||
    prior.attemptNumber !== settled.attemptNumber ||
    prior.instructionRevision !== settled.instructionRevision ||
    prior.claimedStateRevision !== settled.claimedStateRevision ||
    prior.startedAt !== settled.startedAt || settled.settledAt === null ||
    settled.settledAt !== next.updatedAt
  ) return false;
  const event = next.events.at(-1)?.type;
  if (settled.status === "completed") {
    const ledgerOnlyCompletion = next.status === "running" &&
      next.phase === "finalizing" && next.pendingEffect === null &&
      next.completedAt === null && event === "work.completed" &&
      (next.result ?? null) === null && next.events.length <= MAX_EVENTS - 2;
    const finalCompletion = current.pendingEffect?.purpose === "final_result" &&
      current.pendingEffect.workAttemptId === settled.attemptId &&
      next.status === "completed" && next.phase === "completed" &&
      next.pendingEffect === null && next.completedAt === settled.settledAt &&
      next.result?.attemptId === settled.attemptId &&
      next.result.committedAt === settled.settledAt &&
      event === "run.completed";
    return settled.code === null &&
      next.instructionRevision === settled.instructionRevision &&
      next.appliedInstructionRevision === settled.instructionRevision &&
      (ledgerOnlyCompletion || finalCompletion);
  }
  if (settled.status === "failed") {
    return (next.status === "failed" || next.status === "partial") &&
      next.phase === "failed" &&
      next.completedAt === settled.settledAt &&
      (event !== "work.failed" ||
        next.instructionRevision === settled.instructionRevision ||
        settled.code === "work_attempt_event_limit") &&
      (event === "work.failed" || event === "delivery.unknown" ||
        event === "input.expired" || event === "run.expired");
  }
  if (settled.status === "requeued") {
    return (next.status === "queued" || next.status === "waiting_input") &&
      (next.phase === "queued" || next.phase === "waiting_input") &&
      next.pendingEffect === null && next.completedAt === null &&
      next.events.length <= MAX_EVENTS - 1 &&
      (event === "work.requeued" || event === "work.recovered" ||
        (event === "input.required" && next.status === "waiting_input" &&
          settled.code === "waiting_input"));
  }
  return settled.status === "cancelled" && next.status === "cancelled" &&
    next.phase === "cancelled" && next.completedAt === settled.settledAt &&
    event === "run.cancelled";
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

function validEventTransition(
  current: GroupAgentRun,
  next: GroupAgentRun,
): boolean {
  if (validRollingAppend(current.events, next.events, MAX_EVENTS)) return true;
  const pending = current.pendingEffect;
  const receipt = next.receipts.at(-1);
  const outcome = next.events.at(-1);
  const replacesLastAtCapacity = current.events.length === MAX_EVENTS &&
    next.events.length === MAX_EVENTS &&
    JSON.stringify(current.events.slice(0, -1)) ===
      JSON.stringify(next.events.slice(0, -1)) && outcome?.at === next.updatedAt;
  if (!replacesLastAtCapacity) return false;
  if (
    pending && current.events.at(-1)?.type === "delivery.prepared" &&
    next.pendingEffect === null && next.status === "partial" &&
    outcome?.type === "delivery.unknown" &&
    outcome.instructionRevision === pending.instructionRevision &&
    receipt?.effectId === pending.effectId && receipt.status === "unknown" &&
    receipt.committedAt === next.updatedAt
  ) return true;
  const activeAttempt = current.workAttempts?.find((attempt) =>
    attempt.status === "running"
  );
  return Boolean(
    activeAttempt && current.events.at(-1)?.type === "work.claimed" &&
    next.pendingEffect === null &&
    (outcome?.type === "work.failed" || outcome?.type === "work.requeued" ||
      outcome?.type === "work.recovered" || outcome?.type === "run.expired") &&
    outcome.instructionRevision === current.instructionRevision
  );
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

function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} GroupAgentRun tidak sah.`);
  }
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

function machineCode(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length > 120 ||
    !/^[a-z0-9][a-z0-9._-]*$/u.test(value)
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
