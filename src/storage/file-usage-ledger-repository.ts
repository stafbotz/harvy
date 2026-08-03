import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalPlanId } from "../domain/control-plane.js";
import type {
  ProviderAttemptRecord,
  UsageLedgerFilter,
  UsageLedgerRepository,
} from "../domain/usage-ledger.js";

interface UsageLedgerDatabase {
  version: 1;
  attempts: ProviderAttemptRecord[];
}

export class FileUsageLedgerRepository implements UsageLedgerRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private database: Promise<UsageLedgerDatabase> | null = null;

  constructor(private readonly filePath: string) {}

  async startAttempt(record: ProviderAttemptRecord): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      if (database.attempts.some((attempt) => attempt.attemptId === record.attemptId)) {
        return;
      }
      database.attempts.push(normalizeRecordPlanId(record));
      await this.writeDatabase(database);
    });
  }

  async finishAttempt(record: ProviderAttemptRecord): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const normalizedRecord = normalizeRecordPlanId(record);
      const index = database.attempts.findIndex(
        (attempt) => attempt.attemptId === record.attemptId,
      );
      if (index < 0) {
        database.attempts.push(normalizedRecord);
      } else if (database.attempts[index]?.status === "started") {
        database.attempts[index] = normalizedRecord;
      } else {
        return;
      }
      await this.writeDatabase(database);
    });
  }

  async attempt(attemptId: string): Promise<ProviderAttemptRecord | null> {
    const database = await this.readDatabase();
    const found = database.attempts.find(
      (attempt) => attempt.attemptId === attemptId,
    );
    return found ? structuredClone(found) : null;
  }

  async list(filter: UsageLedgerFilter = {}): Promise<ProviderAttemptRecord[]> {
    const database = await this.readDatabase();
    const planId = filter.planId === undefined
      ? undefined
      : canonicalPlanId(filter.planId);
    const since = filter.since ? Date.parse(filter.since) : Number.NEGATIVE_INFINITY;
    const until = filter.until ? Date.parse(filter.until) : Number.POSITIVE_INFINITY;
    const limit = Math.max(
      1,
      Math.min(Number.MAX_SAFE_INTEGER, Math.floor(filter.limit ?? 1_000)),
    );
    return database.attempts
      .filter((attempt) => {
        const at = Date.parse(attempt.startedAt);
        return (
          at >= since &&
          at < until &&
          (filter.subjectRef === undefined || attempt.subjectRef === filter.subjectRef) &&
          (filter.actorRef === undefined || attempt.actorRef === filter.actorRef) &&
          (filter.providerId === undefined || attempt.providerId === filter.providerId) &&
          (filter.modelId === undefined || attempt.modelId === filter.modelId) &&
          (filter.costCenter === undefined || attempt.costCenter === filter.costCenter) &&
          (filter.environment === undefined || attempt.environment === filter.environment) &&
          (filter.cohort === undefined || attempt.cohort === filter.cohort) &&
          (planId === undefined || attempt.planId === planId)
        );
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt, "en"))
      .slice(0, limit)
      .map((attempt) => structuredClone(attempt));
  }

  async removeBefore(before: Date): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const threshold = before.getTime();
      const attempts = database.attempts.filter(
        (attempt) => Date.parse(attempt.startedAt) >= threshold,
      );
      if (attempts.length === database.attempts.length) return;
      await this.writeDatabase({ ...database, attempts });
    });
  }

  async removeSubject(subjectRef: string): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const attempts = database.attempts.filter(
        (attempt) => attempt.subjectRef !== subjectRef,
      );
      if (attempts.length === database.attempts.length) return;
      await this.writeDatabase({ ...database, attempts });
    });
  }

  async removeActors(
    subjectRef: string,
    actorRefs: readonly string[],
  ): Promise<number> {
    const targets = new Set(actorRefs);
    if (targets.size === 0) return 0;
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const attempts = database.attempts.filter(
        (attempt) =>
          attempt.subjectRef !== subjectRef ||
          attempt.actorRef === null ||
          !targets.has(attempt.actorRef),
      );
      const removed = database.attempts.length - attempts.length;
      if (removed > 0) await this.writeDatabase({ ...database, attempts });
      return removed;
    });
  }

  private async readDatabase(): Promise<UsageLedgerDatabase> {
    this.database ??= this.loadDatabase();
    return this.database;
  }

  private async loadDatabase(): Promise<UsageLedgerDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<UsageLedgerDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.attempts)) {
        throw new Error("Format usage ledger tidak dikenali.");
      }
      const database = parsed as UsageLedgerDatabase;
      if (migrateLegacyPlanIds(database)) {
        await this.persistDatabase(database);
      }
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, attempts: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: UsageLedgerDatabase): Promise<void> {
    await this.persistDatabase(database);
    this.database = Promise.resolve(database);
  }

  private async persistDatabase(database: UsageLedgerDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function migrateLegacyPlanIds(database: UsageLedgerDatabase): boolean {
  let changed = false;
  for (const attempt of database.attempts) {
    const migrated = canonicalPlanId(attempt.planId);
    if (migrated === attempt.planId) continue;
    attempt.planId = migrated;
    changed = true;
  }
  return changed;
}

function normalizeRecordPlanId(
  record: ProviderAttemptRecord,
): ProviderAttemptRecord {
  return {
    ...record,
    planId: canonicalPlanId(record.planId),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
