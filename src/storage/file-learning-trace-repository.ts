import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  LearningTrace,
  LearningTraceRepository,
} from "../domain/learning-trace.js";
import { LEARNING_TRACE_LIMIT } from "../core/learning-trace-service.js";

interface TraceDatabase {
  version: 1;
  traces: LearningTrace[];
}

/**
 * Penyimpanan jejak belajar berupa satu berkas JSON.
 *
 * Pola tulisnya sama persis dengan adapter berkas lain: `.tmp` lalu `rename`
 * agar atomik, dan antrean promise agar dua pembaruan tidak saling menimpa.
 * Sama pula batasnya — aman untuk satu proses, tidak untuk dua.
 *
 * Plafonnya per pengguna, bukan per berkas: jejak seorang pelajar tidak boleh
 * terdorong keluar oleh pelajar lain yang lebih aktif.
 */
export class FileLearningTraceRepository implements LearningTraceRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(trace: LearningTrace): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      database.traces.push(trace);
      const mine = database.traces.filter(
        (stored) => stored.ownerId === trace.ownerId,
      );
      if (mine.length > LEARNING_TRACE_LIMIT) {
        const dropped = new Set(
          mine.slice(0, mine.length - LEARNING_TRACE_LIMIT).map((item) => item.id),
        );
        database.traces = database.traces.filter(
          (stored) => !dropped.has(stored.id),
        );
      }
      await this.writeDatabase(database);
    });
  }

  async list(ownerId: string): Promise<LearningTrace[]> {
    const database = await this.readDatabase();
    return database.traces.filter((trace) => trace.ownerId === ownerId);
  }

  async removeAll(ownerId: string): Promise<number> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const before = database.traces.length;
      database.traces = database.traces.filter(
        (trace) => trace.ownerId !== ownerId,
      );
      const removed = before - database.traces.length;
      if (removed > 0) await this.writeDatabase(database);
      return removed;
    });
  }

  private async readDatabase(): Promise<TraceDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TraceDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.traces)) {
        throw new Error("Format basis data jejak belajar tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, traces: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: TraceDatabase): Promise<void> {
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
