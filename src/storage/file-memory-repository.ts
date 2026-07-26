import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryItem, MemoryRepository } from "../domain/memory.js";

interface MemoryDatabase {
  version: 1;
  memories: MemoryItem[];
}

/**
 * Penyimpanan memori berupa satu berkas JSON.
 *
 * Pola tulisnya sama persis dengan `FileTaskRepository`: berkas `.tmp` lalu
 * `rename` agar atomik, dan antrian promise agar dua pembaruan tidak saling
 * menimpa. Sama pula batasnya — aman untuk satu proses, tidak untuk dua.
 */
export class FileMemoryRepository implements MemoryRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(item: MemoryItem): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.memories.findIndex(
        (stored) => stored.ownerId === item.ownerId && stored.id === item.id,
      );

      if (index >= 0) {
        database.memories[index] = item;
      } else {
        database.memories.push(item);
      }

      await this.writeDatabase(database);
    });
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    const database = await this.readDatabase();
    return database.memories.filter((item) => item.ownerId === ownerId);
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.memories.findIndex(
        (item) => item.ownerId === ownerId && item.id === id,
      );
      if (index < 0) return false;

      database.memories.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async removeAll(ownerId: string): Promise<number> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const before = database.memories.length;
      database.memories = database.memories.filter(
        (item) => item.ownerId !== ownerId,
      );

      const removed = before - database.memories.length;
      if (removed > 0) await this.writeDatabase(database);
      return removed;
    });
  }

  private async readDatabase(): Promise<MemoryDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MemoryDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.memories)) {
        throw new Error("Format basis data memori tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, memories: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: MemoryDatabase): Promise<void> {
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
