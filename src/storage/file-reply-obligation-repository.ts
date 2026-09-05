import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ReplyObligation,
  ReplyObligationRepository,
} from "../domain/reply-obligation.js";
import { REPLY_OBLIGATION_LIMIT } from "../core/reply-obligation-service.js";

interface ObligationDatabase {
  version: 1;
  obligations: ReplyObligation[];
}

/**
 * Penyimpanan janji balasan berupa satu berkas JSON.
 *
 * Pola tulisnya sama persis dengan adapter berkas lain: `.tmp` lalu `rename`
 * agar atomik, dan antrean promise agar dua pembaruan tidak saling menimpa.
 * Sama pula batasnya — aman untuk satu proses, tidak untuk dua.
 *
 * Berkas ini hampir selalu kosong, dan itu memang bentuk sehatnya: sebuah
 * baris hidup hanya selama satu balasan berada di udara. Yang tersisa sesudah
 * shutdown bersih adalah nol baris; yang tersisa sesudah crash adalah satu.
 */
export class FileReplyObligationRepository
implements ReplyObligationRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(obligation: ReplyObligation): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.obligations.findIndex(
        (stored) => stored.id === obligation.id,
      );
      if (index >= 0) {
        database.obligations[index] = obligation;
      } else {
        database.obligations.push(obligation);
      }
      // Plafon dijaga dari sisi terlama. Berkas yang membengkak berarti ada
      // yang salah di tempat lain, dan membiarkannya tumbuh hanya menambah
      // tempat isi percakapan tertinggal.
      if (database.obligations.length > REPLY_OBLIGATION_LIMIT) {
        database.obligations = database.obligations
          .slice(-REPLY_OBLIGATION_LIMIT);
      }
      await this.writeDatabase(database);
    });
  }

  async listUnsettled(): Promise<ReplyObligation[]> {
    const database = await this.readDatabase();
    return database.obligations.filter(
      (obligation) =>
        obligation.state === "pending" || obligation.state === "attempting",
    );
  }

  async list(ownerId: string): Promise<ReplyObligation[]> {
    const database = await this.readDatabase();
    return database.obligations.filter(
      (obligation) => obligation.ownerId === ownerId,
    );
  }

  async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.obligations.findIndex(
        (obligation) => obligation.id === id,
      );
      if (index < 0) return false;
      database.obligations.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async removeAll(ownerId: string): Promise<number> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const before = database.obligations.length;
      database.obligations = database.obligations.filter(
        (obligation) => obligation.ownerId !== ownerId,
      );
      const removed = before - database.obligations.length;
      if (removed > 0) await this.writeDatabase(database);
      return removed;
    });
  }

  private async readDatabase(): Promise<ObligationDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ObligationDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.obligations)) {
        throw new Error("Format basis data janji balasan tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, obligations: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: ObligationDatabase): Promise<void> {
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
