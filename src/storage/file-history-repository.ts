import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ConversationHistory,
  HistoryRepository,
} from "../domain/history.js";

interface HistoryDatabase {
  version: 1;
  histories: ConversationHistory[];
}

/**
 * Penyimpanan riwayat percakapan berupa satu berkas JSON.
 *
 * Berkas ini berisi kata-kata pengguna apa adanya, bukan sekadar judul tugas.
 * Nilainya bagi orang lain jauh lebih tinggi daripada `tasks.json`, dan itulah
 * alasan pemadatan pada `HistoryService` bukan sekadar penghematan tempat.
 */
export class FileHistoryRepository implements HistoryRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(ownerId: string): Promise<ConversationHistory | null> {
    const database = await this.readDatabase();
    return (
      database.histories.find((history) => history.ownerId === ownerId) ?? null
    );
  }

  async save(history: ConversationHistory): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.histories.findIndex(
        (stored) => stored.ownerId === history.ownerId,
      );

      if (index >= 0) {
        database.histories[index] = history;
      } else {
        database.histories.push(history);
      }

      await this.writeDatabase(database);
    });
  }

  async remove(ownerId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.histories.findIndex(
        (history) => history.ownerId === ownerId,
      );
      if (index < 0) return false;

      database.histories.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  private async readDatabase(): Promise<HistoryDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as HistoryDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.histories)) {
        throw new Error("Format basis data riwayat tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, histories: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: HistoryDatabase): Promise<void> {
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
