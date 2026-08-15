import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cleanupTimestamp,
  type GroupAgentRunCleanupIntent,
  type GroupAgentRunCleanupIntentRepository,
  validateGroupAgentRunCleanupIntent,
  validateGroupAgentRunCleanupIntentId,
  validateGroupAgentRunCleanupTarget,
} from "../domain/group-agent-run-cleanup.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_PENDING_INTENTS = 4_096;

interface GroupAgentRunCleanupDatabase {
  version: 1;
  intents: GroupAgentRunCleanupIntent[];
}

/** Penyimpanan lokal atomik untuk retry penghapusan scope setelah restart. */
export class FileGroupAgentRunCleanupIntentRepository
  implements GroupAgentRunCleanupIntentRepository {
  private readonly filePath: string;

  constructor(
    filePath: string,
    private readonly makeIntentId: () => string = () => randomUUID(),
  ) {
    this.filePath = resolve(filePath);
  }

  async enqueue(
    scopeKeyValue: string,
    accountIdValue: string,
    requestedAtValue: string,
  ): Promise<GroupAgentRunCleanupIntent> {
    const { scopeKey, accountId } = validateGroupAgentRunCleanupTarget(
      scopeKeyValue,
      accountIdValue,
    );
    const requestedAt = cleanupTimestamp(requestedAtValue);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.intents.findIndex(
        (intent) =>
          intent.scopeKey === scopeKey && intent.accountId === accountId,
      );
      const previous = index >= 0 ? database.intents[index] : undefined;
      if (!previous && database.intents.length >= MAX_PENDING_INTENTS) {
        throw new Error("Batas intent cleanup GroupAgentRun tercapai.");
      }
      if (previous?.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("Revision intent cleanup GroupAgentRun penuh.");
      }
      const intent: GroupAgentRunCleanupIntent = {
        version: 1,
        intentId: this.makeIntentId(),
        scopeKey,
        accountId,
        revision: (previous?.revision ?? 0) + 1,
        requestedAt,
      };
      if (index >= 0) database.intents[index] = intent;
      else database.intents.push(intent);
      await this.writeDatabase(database);
      return structuredClone(intent);
    });
  }

  async listPending(): Promise<GroupAgentRunCleanupIntent[]> {
    return this.exclusive(async () =>
      structuredClone((await this.readDatabase()).intents.sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.scopeKey.localeCompare(right.scopeKey) ||
          left.accountId.localeCompare(right.accountId),
      ))
    );
  }

  async hasPending(
    scopeKeyValue: string,
    accountIdValue: string,
  ): Promise<boolean> {
    const { scopeKey, accountId } = validateGroupAgentRunCleanupTarget(
      scopeKeyValue,
      accountIdValue,
    );
    return this.exclusive(async () =>
      (await this.readDatabase()).intents.some(
        (intent) =>
          intent.scopeKey === scopeKey && intent.accountId === accountId,
      )
    );
  }

  async matchesPending(
    scopeKeyValue: string,
    accountIdValue: string,
    expectedRevision: number,
    expectedIntentIdValue: string,
  ): Promise<boolean> {
    const { scopeKey, accountId } = validateGroupAgentRunCleanupTarget(
      scopeKeyValue,
      accountIdValue,
    );
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision cleanup GroupAgentRun tidak sah.");
    }
    const expectedIntentId = validateGroupAgentRunCleanupIntentId(
      expectedIntentIdValue,
    );
    return this.exclusive(async () =>
      (await this.readDatabase()).intents.some(
        (intent) =>
          intent.scopeKey === scopeKey &&
          intent.accountId === accountId &&
          intent.revision === expectedRevision &&
          intent.intentId === expectedIntentId,
      )
    );
  }

  async complete(
    scopeKeyValue: string,
    accountIdValue: string,
    expectedRevision: number,
    expectedIntentIdValue: string,
  ): Promise<boolean> {
    const { scopeKey, accountId } = validateGroupAgentRunCleanupTarget(
      scopeKeyValue,
      accountIdValue,
    );
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision cleanup GroupAgentRun tidak sah.");
    }
    const expectedIntentId = validateGroupAgentRunCleanupIntentId(
      expectedIntentIdValue,
    );
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.intents.findIndex(
        (intent) =>
          intent.scopeKey === scopeKey &&
          intent.accountId === accountId &&
          intent.revision === expectedRevision &&
          intent.intentId === expectedIntentId,
      );
      if (index < 0) return false;
      database.intents.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  private async readDatabase(): Promise<GroupAgentRunCleanupDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
        version?: unknown;
        intents?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.intents)) {
        throw new Error("Format basis data cleanup GroupAgentRun tidak dikenali.");
      }
      const intents: GroupAgentRunCleanupIntent[] = [];
      for (const candidate of parsed.intents) {
        validateGroupAgentRunCleanupIntent(candidate);
        intents.push(candidate);
      }
      assertUnique(intents);
      if (intents.length > MAX_PENDING_INTENTS) {
        throw new Error("Batas intent cleanup GroupAgentRun terlampaui.");
      }
      return { version: 1, intents: structuredClone(intents) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, intents: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(
    database: GroupAgentRunCleanupDatabase,
  ): Promise<void> {
    assertUnique(database.intents);
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

function assertUnique(intents: readonly GroupAgentRunCleanupIntent[]): void {
  const seen = new Set<string>();
  for (const intent of intents) {
    validateGroupAgentRunCleanupIntent(intent);
    const key = `${intent.scopeKey}\u0000${intent.accountId}`;
    if (seen.has(key)) {
      throw new Error("Binding intent cleanup GroupAgentRun duplikat.");
    }
    seen.add(key);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
