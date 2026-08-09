import type {
  AgentRunRepository,
  DurableAgentIntent,
  DurableAgentMode,
  DurableAgentRun,
  DurableAgentRunExport,
  NewDurableAgentRun,
} from "../domain/agent-run.js";
import {
  isValidAgentRunCheckpoint,
  type AgentRunCheckpoint,
} from "../harness/agent-harness.js";
import {
  privateAgentScope,
  scopeKey,
  type AgentChannel,
} from "../harness/scope.js";

const MAX_DURABLE_CHECKPOINT_CHARACTERS = 100_000;

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
 * konkret. Store hanya memegang keadaan `waiting_input`; eksekusi aktif masih
 * sinkron dan tidak dipulihkan diam-diam sesudah crash.
 */
export class AgentRunService {
  private readonly blockedScopes = new Set<string>();

  constructor(
    private readonly repository: AgentRunRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  /** Hanya penerimaan consent baru yang boleh membuka write setelah deletion. */
  allow(channel: AgentChannel, ownerId: string): void {
    this.blockedScopes.delete(privateScopeKey(channel, ownerId));
  }

  purgeExpired(): Promise<number> {
    return this.repository.removeExpired(this.now());
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
