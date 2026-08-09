import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ActiveAgentRun,
  ActiveAgentRunSaveResult,
  AgentRunRemoveResult,
  AgentRunRepository,
  AgentRunSaveResult,
  DurableAgentRun,
  NewActiveAgentRun,
  NewDurableAgentRun,
} from "../domain/agent-run.js";
import {
  isValidAgentRunCheckpoint,
} from "../harness/agent-harness.js";
import {
  privateAgentScope,
  scopeKey,
  type AgentChannel,
} from "../harness/scope.js";

const FILE_QUEUES = new Map<string, Promise<void>>();

interface AgentRunDatabase {
  version: 1;
  runs: DurableAgentRun[];
  /** Ditambahkan kompatibel pada Phase D; file lama boleh tidak memilikinya. */
  activeRuns: ActiveAgentRun[];
}

/**
 * Adapter restart-durable satu proses. CAS melindungi handler lama di dalam
 * runtime yang sama; PostgreSQL tetap diperlukan sebelum multi-instance.
 */
export class FileAgentRunRepository implements AgentRunRepository {
  constructor(private readonly filePath: string) {}

  async load(scopeKeyValue: string): Promise<DurableAgentRun | null> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const run = database.runs.find(
        (candidate) => candidate.scopeKey === scopeKeyValue,
      );
      return run ? structuredClone(run) : null;
    });
  }

  async save(
    draft: NewDurableAgentRun,
    expectedRevision: number | null,
  ): Promise<AgentRunSaveResult> {
    validateRun({ ...draft, revision: expectedRevision === null ? 1 : expectedRevision + 1 });
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (run) => run.scopeKey === draft.scopeKey,
      );
      const current = index >= 0 ? database.runs[index]! : null;
      if (
        database.activeRuns.some((run) =>
          run.scopeKey === draft.scopeKey && !isTerminalActiveStatus(run.status)
        ) ||
        (expectedRevision === null && current !== null) ||
        (expectedRevision !== null &&
          (current === null || current.revision !== expectedRevision ||
            current.runId !== draft.runId ||
            current.scopeKey !== draft.scopeKey ||
            current.channel !== draft.channel ||
            current.ownerId !== draft.ownerId))
      ) {
        return { status: "conflict" };
      }
      // Kontrak ekspor v1/v2 tetap satu record terbaru per scope. Terminal v2
      // boleh diganti lebih cepat ketika checkpoint sinkron baru dimulai.
      if (expectedRevision === null) {
        database.activeRuns = database.activeRuns.filter(
          (run) => run.scopeKey !== draft.scopeKey,
        );
      }
      const run: DurableAgentRun = structuredClone({
        ...draft,
        revision: expectedRevision === null ? 1 : expectedRevision + 1,
      });
      if (index >= 0) database.runs[index] = run;
      else database.runs.push(run);
      validateDatabase(database);
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(run) };
    });
  }

  async loadActive(scopeKeyValue: string): Promise<ActiveAgentRun | null> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const candidates = database.activeRuns
        .map((run, index) => ({ run, index }))
        .filter(({ run }) => run.scopeKey === scopeKeyValue)
        .sort((left, right) =>
          Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt) ||
          right.index - left.index
        );
      const candidate = candidates.find(({ run }) =>
        !isTerminalActiveStatus(run.status)
      ) ?? candidates[0];
      return candidate ? structuredClone(candidate.run) : null;
    });
  }

  async loadActiveByRunId(runId: string): Promise<ActiveAgentRun | null> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const run = database.activeRuns.find((candidate) =>
        candidate.runId === runId
      );
      return run ? structuredClone(run) : null;
    });
  }

  async listActive(channel?: AgentChannel): Promise<ActiveAgentRun[]> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      return database.activeRuns
        .filter((run) => channel === undefined || run.channel === channel)
        .map((run) => structuredClone(run));
    });
  }

  async saveActive(
    draft: NewActiveAgentRun,
    expectedRevision: number | null,
  ): Promise<ActiveAgentRunSaveResult> {
    validateActiveRun({
      ...draft,
      revision: expectedRevision === null ? 1 : expectedRevision + 1,
    });
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.activeRuns.findIndex((run) => run.runId === draft.runId);
      const current = index >= 0 ? database.activeRuns[index]! : null;
      if (
        database.runs.some((run) => run.scopeKey === draft.scopeKey) ||
        (expectedRevision === null &&
          (current !== null || database.activeRuns.some((run) =>
            run.scopeKey === draft.scopeKey &&
            !isTerminalActiveStatus(run.status)
          ))) ||
        (expectedRevision !== null &&
          (current === null || current.revision !== expectedRevision ||
            current.runId !== draft.runId))
      ) {
        return { status: "conflict" };
      }
      // Satu scope menyimpan foreground atau terminal terbarunya saja. Hasil
      // final tetap berada di history; receipt lama tidak menjadi data gelap
      // yang tertahan tetapi tidak ikut ekspor pengguna.
      if (expectedRevision === null) {
        database.activeRuns = database.activeRuns.filter(
          (run) => run.scopeKey !== draft.scopeKey,
        );
      }
      const run: ActiveAgentRun = structuredClone({
        ...draft,
        revision: expectedRevision === null ? 1 : expectedRevision + 1,
      });
      if (index >= 0) database.activeRuns[index] = run;
      else database.activeRuns.push(run);
      validateDatabase(database);
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(run) };
    });
  }

  async removeActive(
    scopeKeyValue: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<AgentRunRemoveResult> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const candidates = database.activeRuns
        .map((run, index) => ({ run, index }))
        .filter(({ run }) => run.scopeKey === scopeKeyValue)
        .sort((left, right) =>
          Date.parse(right.run.updatedAt) - Date.parse(left.run.updatedAt) ||
          right.index - left.index
        );
      const target = expectedRunId !== undefined
        ? candidates.find(({ run }) => run.runId === expectedRunId)
        : candidates.find(({ run }) => !isTerminalActiveStatus(run.status)) ??
          candidates[0];
      const index = target?.index ?? -1;
      if (index < 0) return "missing";
      const current = database.activeRuns[index]!;
      if (
        (expectedRunId !== undefined && current.runId !== expectedRunId) ||
        (expectedRevision !== undefined && current.revision !== expectedRevision)
      ) {
        return "conflict";
      }
      database.activeRuns.splice(index, 1);
      await this.writeDatabase(database);
      return "removed";
    });
  }

  async remove(
    scopeKeyValue: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<AgentRunRemoveResult> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (run) => run.scopeKey === scopeKeyValue,
      );
      if (index < 0) return "missing";
      if (
        (expectedRunId !== undefined &&
          database.runs[index]!.runId !== expectedRunId) ||
        (expectedRevision !== undefined &&
          database.runs[index]!.revision !== expectedRevision)
      ) {
        return "conflict";
      }
      database.runs.splice(index, 1);
      await this.writeDatabase(database);
      return "removed";
    });
  }

  async removeOwner(channel: AgentChannel, ownerId: string): Promise<number> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const retained = database.runs.filter(
        (run) => run.channel !== channel || run.ownerId !== ownerId,
      );
      const retainedActive = database.activeRuns.filter(
        (run) => run.channel !== channel || run.ownerId !== ownerId,
      );
      const removed =
        database.runs.length - retained.length +
        database.activeRuns.length - retainedActive.length;
      if (removed === 0) return 0;
      database.runs = retained;
      database.activeRuns = retainedActive;
      await this.writeDatabase(database);
      return removed;
    });
  }

  async removeExpired(now: Date): Promise<number> {
    const moment = now.getTime();
    if (!Number.isFinite(moment)) throw new Error("Waktu purge agent tidak sah.");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const retained = database.runs.filter(
        (run) => Date.parse(run.expiresAt) > moment,
      );
      const retainedActive = database.activeRuns.filter(
        (run) => Date.parse(run.expiresAt) > moment,
      );
      const removed =
        database.runs.length - retained.length +
        database.activeRuns.length - retainedActive.length;
      if (removed === 0) return 0;
      database.runs = retained;
      database.activeRuns = retainedActive;
      await this.writeDatabase(database);
      return removed;
    });
  }

  private async readDatabase(): Promise<AgentRunDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<AgentRunDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
        throw new Error("Format basis data run agent tidak dikenali.");
      }
      if (
        parsed.activeRuns !== undefined &&
        !Array.isArray(parsed.activeRuns)
      ) {
        throw new Error("Format basis data run aktif tidak dikenali.");
      }
      const database: AgentRunDatabase = {
        version: 1,
        runs: parsed.runs,
        activeRuns: (parsed.activeRuns ?? []) as ActiveAgentRun[],
      };
      validateDatabase(database);
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, runs: [], activeRuns: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: AgentRunDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const guardedOperation = async (): Promise<T> => {
      // Crash sesudah write `.tmp` tetapi sebelum rename menyisakan salinan
      // data pribadi yang tidak terlihat oleh load/export. Jangan promosikan
      // state ambigu itu; buang di bawah queue yang sama sebelum mutasi/purge.
      await this.discardOrphanTemporaryFile();
      return operation();
    };
    const next = previous.then(guardedOperation, guardedOperation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) {
        FILE_QUEUES.delete(this.filePath);
      }
    }
  }

  private async discardOrphanTemporaryFile(): Promise<void> {
    try {
      await unlink(`${this.filePath}.tmp`);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }
  }
}

function validateDatabase(database: AgentRunDatabase): void {
  const scopes = new Set<string>();
  const activeScopes = new Set<string>();
  const runIds = new Set<string>();
  for (const run of database.runs) {
    validateRun(run);
    if (scopes.has(run.scopeKey)) {
      throw new Error("Scope run agent duplikat.");
    }
    if (runIds.has(run.runId)) {
      throw new Error("Run ID agent duplikat.");
    }
    scopes.add(run.scopeKey);
    runIds.add(run.runId);
  }
  for (const run of database.activeRuns) {
    validateActiveRun(run);
    if (runIds.has(run.runId)) {
      throw new Error("Run ID agent duplikat.");
    }
    if (activeScopes.has(run.scopeKey)) {
      throw new Error("Scope run aktif duplikat.");
    }
    if (database.runs.some((candidate) => candidate.scopeKey === run.scopeKey)) {
      throw new Error("Scope checkpoint dan run aktif bertabrakan.");
    }
    activeScopes.add(run.scopeKey);
    runIds.add(run.runId);
  }
}

function validateRun(run: DurableAgentRun): void {
  if (
    !run ||
    typeof run !== "object" ||
    (run.channel !== "telegram" && run.channel !== "whatsapp") ||
    typeof run.ownerId !== "string" ||
    typeof run.request !== "string" ||
    !run.checkpoint ||
    typeof run.checkpoint !== "object"
  ) {
    throw new Error("Record run agent tidak sah.");
  }
  const checkpoint = run.checkpoint;
  const scope = privateAgentScope(run.channel, run.ownerId);
  const expectedScope = scopeKey(scope);
  if (
    run.version !== 1 ||
    run.status !== "waiting_input" ||
    (run.mode !== "tools" && run.mode !== "orchestrate") ||
    (run.intent !== "question" && run.intent !== "request") ||
    scope.userId !== run.ownerId ||
    run.scopeKey !== expectedScope ||
    !run.runId ||
    run.runId !== checkpoint?.runId ||
    run.request !== checkpoint?.request ||
    !Number.isSafeInteger(run.acceptAnswersAfterUpdateId) ||
    run.acceptAnswersAfterUpdateId < 0 ||
    !Number.isInteger(run.revision) ||
    run.revision <= 0 ||
    !isValidAgentRunCheckpoint(checkpoint, scope, run.request) ||
    checkpoint.pending !== null ||
    checkpoint.pendingInput === null ||
    checkpoint.pendingInput.step !== checkpoint.step ||
    checkpoint.pendingInput.prompt.trim().length === 0 ||
    run.createdAt !== checkpoint.startedAt ||
    run.expiresAt !== checkpoint.deadlineAt ||
    !validDate(run.createdAt) ||
    !validDate(run.updatedAt) ||
    !validDate(run.expiresAt) ||
    Date.parse(run.expiresAt) <= Date.parse(run.createdAt) ||
    Date.parse(run.createdAt) > Date.parse(run.updatedAt) ||
    Date.parse(run.updatedAt) >= Date.parse(run.expiresAt) ||
    JSON.stringify(checkpoint).length > 100_000
  ) {
    throw new Error("Record run agent tidak sah.");
  }
}

const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_input",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
const ACTIVE_PHASES = new Set([
  "queued",
  "reading_context",
  "planning",
  "replanning",
  "checking",
  "waiting_input",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_ACTIVE_STATUSES = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

function isTerminalActiveStatus(status: ActiveAgentRun["status"]): boolean {
  return TERMINAL_ACTIVE_STATUSES.has(status);
}

function validateActiveRun(run: ActiveAgentRun): void {
  if (
    !run ||
    typeof run !== "object" ||
    run.version !== 2 ||
    (run.channel !== "telegram" && run.channel !== "whatsapp") ||
    typeof run.ownerId !== "string" ||
    typeof run.initialRequest !== "string" ||
    run.initialRequest.trim().length === 0 ||
    run.initialRequest.length > 8_000 ||
    (run.mode !== "tools" && run.mode !== "orchestrate") ||
    (run.intent !== "question" && run.intent !== "request") ||
    typeof run.timeZone !== "string" ||
    run.timeZone.trim().length === 0 ||
    run.timeZone.length > 100 ||
    (run.style !== null && run.style !== "listen" && run.style !== "advice") ||
    !ACTIVE_STATUSES.has(run.status) ||
    !ACTIVE_PHASES.has(run.phase)
  ) {
    throw new Error("Record run aktif tidak sah.");
  }
  const scope = privateAgentScope(run.channel, run.ownerId);
  if (
    scope.userId !== run.ownerId ||
    run.scopeKey !== scopeKey(scope) ||
    typeof run.runId !== "string" ||
    run.runId.length < 8 ||
    !Number.isInteger(run.revision) ||
    run.revision <= 0 ||
    !Number.isInteger(run.contextRevision) ||
    run.contextRevision <= 0 ||
    !Number.isInteger(run.instructionRevision) ||
    run.instructionRevision <= 0 ||
    !Number.isInteger(run.appliedInstructionRevision) ||
    run.appliedInstructionRevision <= 0 ||
    run.appliedInstructionRevision > run.instructionRevision ||
    typeof run.turnId !== "string" ||
    run.turnId.length < 8 ||
    !validDate(run.createdAt) ||
    !validDate(run.updatedAt) ||
    !validDate(run.expiresAt) ||
    Date.parse(run.createdAt) > Date.parse(run.updatedAt) ||
    Date.parse(run.updatedAt) >= Date.parse(run.expiresAt) ||
    (run.startedAt !== null && !validDate(run.startedAt)) ||
    (run.completedAt !== null && !validDate(run.completedAt)) ||
    (TERMINAL_ACTIVE_STATUSES.has(run.status) !== (run.completedAt !== null))
  ) {
    throw new Error("Record run aktif tidak konsisten dengan scope-nya.");
  }
  validateActiveContext(run);
  validateActiveCollections(run);
  validateActiveCheckpoint(run, scope);
  if (JSON.stringify(run).length > 300_000) {
    throw new Error("Record run aktif melampaui batas penyimpanan.");
  }
}

function validateActiveContext(run: ActiveAgentRun): void {
  const context = run.context;
  if (
    !context ||
    (context.summary !== null &&
      (typeof context.summary !== "string" || context.summary.length > 16_000)) ||
    !Array.isArray(context.turns) ||
    context.turns.length > 24 ||
    context.turns.some((turn) =>
      !turn ||
      (turn.role !== "user" && turn.role !== "harvy") ||
      typeof turn.text !== "string" ||
      turn.text.length > 2_000 ||
      !validDate(turn.at)
    ) ||
    !Array.isArray(context.memories) ||
    context.memories.length > 24 ||
    context.memories.some((memory) =>
      !memory ||
      typeof memory.id !== "string" ||
      memory.id.length > 200 ||
      !["profile", "preference", "routine", "context", "personal"]
        .includes(memory.kind) ||
      typeof memory.content !== "string" ||
      memory.content.length > 1_000
    )
  ) {
    throw new Error("Snapshot konteks run aktif tidak sah.");
  }
}

function validateActiveCollections(run: ActiveAgentRun): void {
  if (
    !Array.isArray(run.mailbox) ||
    run.mailbox.length > 64 ||
    !Array.isArray(run.changeSets) ||
    run.changeSets.length > 64 ||
    run.mailbox.length !== run.changeSets.length ||
    !Array.isArray(run.workUnits) ||
    run.workUnits.length > 24 ||
    !Array.isArray(run.events) ||
    run.events.length > 160 ||
    !Array.isArray(run.receipts) ||
    run.receipts.length > 48
  ) {
    throw new Error("Koleksi run aktif tidak sah.");
  }
  const messageIds = new Set<string>();
  const sourceEnvelopes = new Map<string, string>();
  for (const message of run.mailbox) {
    const sourceEnvelope = JSON.stringify([
      message?.kind,
      message?.content,
      message?.questionId,
    ]);
    const priorEnvelope = message && typeof message.sourceMessageId === "string"
      ? sourceEnvelopes.get(message.sourceMessageId)
      : undefined;
    if (
      !message ||
      typeof message.id !== "string" ||
      messageIds.has(message.id) ||
      message.runId !== run.runId ||
      !["constraint", "correction", "scope_change", "answer", "cancel"]
        .includes(message.kind) ||
      typeof message.content !== "string" ||
      message.content.length === 0 ||
      message.content.length > 4_000 ||
      typeof message.sourceMessageId !== "string" ||
      message.sourceMessageId.length === 0 ||
      message.sourceMessageId.length > 200 ||
      (priorEnvelope !== undefined && priorEnvelope !== sourceEnvelope) ||
      !validDate(message.receivedAt) ||
      (message.questionId !== null && typeof message.questionId !== "string")
    ) {
      throw new Error("Mailbox run aktif tidak sah.");
    }
    messageIds.add(message.id);
    sourceEnvelopes.set(message.sourceMessageId, sourceEnvelope);
  }
  let previousRevision = 0;
  for (const [index, change] of run.changeSets.entries()) {
    const message = run.mailbox[index];
    if (
      !change ||
      !message ||
      !Number.isInteger(change.revision) ||
      change.revision <= previousRevision ||
      change.revision > run.instructionRevision ||
      !["constraint", "correction", "answer", "scope_addition", "cancel"]
        .includes(change.kind) ||
      typeof change.sourceMessageId !== "string" ||
      change.sourceMessageId !== message.sourceMessageId ||
      change.kind !== mailboxChangeKind(message.kind) ||
      change.receivedAt !== message.receivedAt ||
      !Array.isArray(change.affectedWorkUnits) ||
      change.affectedWorkUnits.some((id) => typeof id !== "string") ||
      !validDate(change.receivedAt)
    ) {
      throw new Error("ChangeSet run aktif tidak sah.");
    }
    previousRevision = change.revision;
  }
  const workIds = new Set<string>();
  for (const unit of run.workUnits) {
    if (
      !unit ||
      typeof unit.id !== "string" ||
      workIds.has(unit.id) ||
      !["research", "schedule_scan", "constraint_check", "planner", "critic"]
        .includes(unit.role) ||
      typeof unit.label !== "string" ||
      unit.label.length === 0 ||
      unit.label.length > 160 ||
      !["queued", "running", "waiting", "completed", "stale", "failed"]
        .includes(unit.status) ||
      !Number.isInteger(unit.inputRevision) ||
      unit.inputRevision <= 0 ||
      unit.inputRevision > run.instructionRevision ||
      (unit.resultSummary !== undefined &&
        (typeof unit.resultSummary !== "string" ||
          unit.resultSummary.length > 500))
    ) {
      throw new Error("Work unit run aktif tidak sah.");
    }
    workIds.add(unit.id);
  }
  const eventIds = new Set<string>();
  for (const event of run.events) {
    if (
      !event ||
      typeof event.id !== "string" ||
      eventIds.has(event.id) ||
      ![
        "run.started",
        "context.started",
        "context.completed",
        "planning.started",
        "planning.completed",
        "replanning.started",
        "input.required",
        "input.received",
        "finalizing.started",
        "run.completed",
        "run.cancelled",
        "run.failed",
      ].includes(event.type) ||
      !validDate(event.at) ||
      !Number.isInteger(event.inputRevision) ||
      event.inputRevision <= 0 ||
      event.inputRevision > run.instructionRevision ||
      (event.workUnitId !== null && typeof event.workUnitId !== "string")
    ) {
      throw new Error("Event run aktif tidak sah.");
    }
    eventIds.add(event.id);
  }
  const receiptIds = new Set<string>();
  for (const receipt of run.receipts) {
    if (
      !receipt ||
      typeof receipt.receiptId !== "string" ||
      receiptIds.has(receipt.receiptId) ||
      typeof receipt.effectId !== "string" ||
      receipt.effect !== "telegram.message.send" ||
      (receipt.purpose !== "question" && receipt.purpose !== "final") ||
      !Number.isInteger(receipt.instructionRevision) ||
      receipt.instructionRevision <= 0 ||
      receipt.instructionRevision > run.instructionRevision ||
      (receipt.status !== "committed" && receipt.status !== "unknown") ||
      (receipt.externalId !== null && typeof receipt.externalId !== "string") ||
      !validDate(receipt.committedAt) ||
      receipt.reversible !== false
    ) {
      throw new Error("Receipt run aktif tidak sah.");
    }
    receiptIds.add(receipt.receiptId);
  }
  if (
    !run.anchor ||
    run.anchor.platform !== "telegram" ||
    typeof run.anchor.chatId !== "string" ||
    run.anchor.chatId.length === 0 ||
    (run.anchor.messageId !== null && typeof run.anchor.messageId !== "string") ||
    !validDate(run.anchor.updatedAt)
  ) {
    throw new Error("Anchor run aktif tidak sah.");
  }
  validateActiveQuestionAndEffect(run);
}

function mailboxChangeKind(
  kind: ActiveAgentRun["mailbox"][number]["kind"],
): ActiveAgentRun["changeSets"][number]["kind"] {
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

function validateActiveQuestionAndEffect(run: ActiveAgentRun): void {
  const question = run.pendingQuestion;
  if (question !== null && (
    typeof question.questionId !== "string" ||
    typeof question.prompt !== "string" ||
    question.prompt.trim().length === 0 ||
    question.prompt.length > 8_000 ||
    !validDate(question.askedAt) ||
    !validDate(question.expiresAt) ||
    Date.parse(question.expiresAt) <= Date.parse(question.askedAt) ||
    !Number.isSafeInteger(question.acceptAnswersAfterUpdateId) ||
    question.acceptAnswersAfterUpdateId < 0 ||
    (question.messageId !== null && typeof question.messageId !== "string")
  )) {
    throw new Error("Pertanyaan run aktif tidak sah.");
  }
  if (run.resumeAnswer !== null && (
    question === null ||
    run.resumeAnswer.questionId !== question.questionId ||
    typeof run.resumeAnswer.sourceMessageId !== "string" ||
    typeof run.resumeAnswer.text !== "string" ||
    run.resumeAnswer.text.trim().length === 0 ||
    run.resumeAnswer.text.length > 4_000 ||
    !validDate(run.resumeAnswer.receivedAt)
  )) {
    throw new Error("Jawaban run aktif tidak sah.");
  }
  if (run.pendingEffect !== null && (
    typeof run.pendingEffect.effectId !== "string" ||
    (run.pendingEffect.purpose !== "question" &&
      run.pendingEffect.purpose !== "final") ||
    run.pendingEffect.instructionRevision !== run.instructionRevision ||
    !validDate(run.pendingEffect.preparedAt)
  )) {
    throw new Error("Commit barrier run aktif tidak sah.");
  }
  if (run.result !== null && (
    (run.result.kind !== "final" && run.result.kind !== "partial") ||
    typeof run.result.text !== "string" ||
    run.result.text.trim().length === 0 ||
    run.result.text.length > 8_000 ||
    !Number.isInteger(run.result.instructionRevision) ||
    run.result.instructionRevision <= 0 ||
    run.result.instructionRevision > run.instructionRevision ||
    !validDate(run.result.completedAt)
  )) {
    throw new Error("Hasil run aktif tidak sah.");
  }
  if (run.lastError !== null && (
    !["planning", "checkpoint", "delivery", "recovery"]
      .includes(run.lastError.stage) ||
    typeof run.lastError.code !== "string" ||
    run.lastError.code.length === 0 ||
    run.lastError.code.length > 120 ||
    !validDate(run.lastError.at)
  )) {
    throw new Error("Error state run aktif tidak sah.");
  }
}

function validateActiveCheckpoint(
  run: ActiveAgentRun,
  scope: ReturnType<typeof privateAgentScope>,
): void {
  if (run.checkpoint === null) {
    if (run.pendingQuestion !== null || run.resumeAnswer !== null) {
      throw new Error("Pertanyaan run aktif tidak mempunyai checkpoint.");
    }
    return;
  }
  if (
    !isValidAgentRunCheckpoint(run.checkpoint, scope, run.initialRequest) ||
    run.checkpoint.runId !== run.runId ||
    JSON.stringify(run.checkpoint).length > 100_000 ||
    (run.pendingQuestion !== null &&
      (run.checkpoint.pendingInput === null ||
        run.checkpoint.pendingInput.prompt !== run.pendingQuestion.prompt))
  ) {
    throw new Error("Checkpoint run aktif tidak sah.");
  }
}

function validDate(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
