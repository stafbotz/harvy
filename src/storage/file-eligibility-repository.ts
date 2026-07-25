import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  EligibilityRecord,
  EligibilityRepository,
} from "../domain/user-profile.js";

interface EligibilityDatabase {
  version: 1;
  records: EligibilityRecord[];
}

export class FileEligibilityRepository implements EligibilityRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async find(ownerId: string): Promise<EligibilityRecord | null> {
    const database = await this.readDatabase();
    return database.records.find((record) => record.ownerId === ownerId) ?? null;
  }

  async save(record: EligibilityRecord): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.records.findIndex(
        (item) => item.ownerId === record.ownerId,
      );

      if (index >= 0) {
        database.records[index] = record;
      } else {
        database.records.push(record);
      }

      await this.writeDatabase(database);
    });
  }

  async delete(ownerId: string): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const records = database.records.filter(
        (record) => record.ownerId !== ownerId,
      );

      if (records.length === database.records.length) return;
      await this.writeDatabase({ ...database, records });
    });
  }

  private async readDatabase(): Promise<EligibilityDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as EligibilityDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error("Format basis data kelayakan tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: EligibilityDatabase): Promise<void> {
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
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
