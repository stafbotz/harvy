import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../domain/session.js";

interface SessionDatabase {
  version: 1;
  sessions: ActiveSession[];
}

/**
 * Penyimpanan satu sesi aktif per pengguna.
 *
 * Sama seperti adapter berkas lain: tulis atomik dan serialkan perubahan.
 * Aman untuk satu proses, bukan untuk beberapa replika.
 */
export class FileSessionRepository
  implements SessionRepository, DueCheckInSource
{
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(ownerId: string): Promise<ActiveSession | null> {
    const database = await this.readDatabase();
    return (
      database.sessions.find((session) => session.ownerId === ownerId) ?? null
    );
  }

  async save(session: ActiveSession): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.sessions.findIndex(
        (stored) => stored.ownerId === session.ownerId,
      );

      if (index >= 0) database.sessions[index] = session;
      else database.sessions.push(session);

      await this.writeDatabase(database);
    });
  }

  async remove(ownerId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.sessions.findIndex(
        (session) => session.ownerId === ownerId,
      );
      if (index < 0) return false;

      database.sessions.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async listDueCheckIns(now: Date): Promise<ActiveSession[]> {
    const database = await this.readDatabase();
    const moment = now.getTime();

    return database.sessions.filter(
      (session) =>
        new Date(session.expiresAt).getTime() > moment &&
        session.checkIn !== null &&
        session.checkIn.sentAt === null &&
        new Date(session.checkIn.at).getTime() <= moment,
    );
  }

  private async readDatabase(): Promise<SessionDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("Format basis data sesi tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, sessions: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: SessionDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, this.filePath);
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
