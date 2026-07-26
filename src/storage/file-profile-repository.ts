import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProfileRepository, UserProfile } from "../domain/profile.js";

interface ProfileDatabase {
  version: 1;
  profiles: UserProfile[];
}

/**
 * Penyimpanan status kenalan berupa satu berkas JSON.
 *
 * Pola tulisnya sama persis dengan tiga adapter lain: berkas `.tmp` lalu
 * `rename` agar atomik, dan antrian promise agar dua pembaruan tidak saling
 * menimpa. Sama pula batasnya — aman untuk satu proses, tidak untuk dua.
 */
export class FileProfileRepository implements ProfileRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async find(ownerId: string): Promise<UserProfile | null> {
    const database = await this.readDatabase();
    return (
      database.profiles.find((profile) => profile.ownerId === ownerId) ?? null
    );
  }

  async save(profile: UserProfile): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.profiles.findIndex(
        (stored) => stored.ownerId === profile.ownerId,
      );

      if (index >= 0) {
        database.profiles[index] = profile;
      } else {
        database.profiles.push(profile);
      }

      await this.writeDatabase(database);
    });
  }

  private async readDatabase(): Promise<ProfileDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ProfileDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
        throw new Error("Format basis data profil tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, profiles: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: ProfileDatabase): Promise<void> {
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
