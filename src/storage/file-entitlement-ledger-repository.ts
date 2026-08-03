import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalPlanId } from "../domain/control-plane.js";
import type {
  EntitlementEntry,
  EntitlementLedgerRepository,
} from "../domain/entitlement.js";

interface EntitlementDatabase {
  version: 1;
  entries: EntitlementEntry[];
}

export class FileEntitlementLedgerRepository
implements EntitlementLedgerRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private database: Promise<EntitlementDatabase> | null = null;

  constructor(private readonly filePath: string) {}

  async append(entry: EntitlementEntry): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      if (
        database.entries.some(
          (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
        )
      ) {
        return;
      }
      database.entries.push({
        ...entry,
        planId: canonicalPlanId(entry.planId),
      });
      await this.writeDatabase(database);
    });
  }

  async list(subjectRef?: string): Promise<EntitlementEntry[]> {
    const database = await this.readDatabase();
    return database.entries
      .filter((entry) => subjectRef === undefined || entry.subjectRef === subjectRef)
      .map((entry) => structuredClone(entry));
  }

  async removeBefore(before: Date): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const threshold = before.getTime();
      const entries = database.entries.filter(
        (entry) => Date.parse(entry.at) >= threshold,
      );
      if (entries.length === database.entries.length) return;
      await this.writeDatabase({ ...database, entries });
    });
  }

  async removeSubject(subjectRef: string): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const entries = database.entries.filter(
        (entry) => entry.subjectRef !== subjectRef,
      );
      if (entries.length === database.entries.length) return;
      await this.writeDatabase({ ...database, entries });
    });
  }

  private async readDatabase(): Promise<EntitlementDatabase> {
    this.database ??= this.loadDatabase();
    return this.database;
  }

  private async loadDatabase(): Promise<EntitlementDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<EntitlementDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error("Format entitlement ledger tidak dikenali.");
      }
      const database = parsed as EntitlementDatabase;
      if (migrateLegacyPlanIds(database)) {
        await this.persistDatabase(database);
      }
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, entries: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: EntitlementDatabase): Promise<void> {
    await this.persistDatabase(database);
    this.database = Promise.resolve(database);
  }

  private async persistDatabase(database: EntitlementDatabase): Promise<void> {
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

function migrateLegacyPlanIds(database: EntitlementDatabase): boolean {
  let changed = false;
  for (const entry of database.entries) {
    const migrated = canonicalPlanId(entry.planId);
    if (migrated === entry.planId) continue;
    entry.planId = migrated;
    changed = true;
  }
  return changed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
