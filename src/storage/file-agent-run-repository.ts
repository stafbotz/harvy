import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentRunRemoveResult,
  AgentRunRepository,
  AgentRunSaveResult,
  DurableAgentRun,
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
}

/**
 * Adapter restart-durable satu proses. CAS melindungi handler lama di dalam
 * runtime yang sama; PostgreSQL tetap diperlukan sebelum multi-instance.
 */
export class FileAgentRunRepository implements AgentRunRepository {
  constructor(private readonly filePath: string) {}

  async load(scopeKeyValue: string): Promise<DurableAgentRun | null> {
    const database = await this.readDatabase();
    const run = database.runs.find(
      (candidate) => candidate.scopeKey === scopeKeyValue,
    );
    return run ? structuredClone(run) : null;
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
        (expectedRevision === null && current !== null) ||
        (expectedRevision !== null &&
          (current === null || current.revision !== expectedRevision ||
            current.runId !== draft.runId))
      ) {
        return { status: "conflict" };
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
      const removed = database.runs.length - retained.length;
      if (removed === 0) return 0;
      database.runs = retained;
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
      const removed = database.runs.length - retained.length;
      if (removed === 0) return 0;
      database.runs = retained;
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
      const database: AgentRunDatabase = { version: 1, runs: parsed.runs };
      validateDatabase(database);
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, runs: [] };
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

function validDate(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
