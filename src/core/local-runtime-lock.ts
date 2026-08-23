import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

interface LockPayload {
  version: 1;
  pid: number;
  token: string;
  role: "runtime" | "probe" | "evaluation" | "backup" | "setup";
  startedAt: string;
}

/**
 * Pengaman satu proses untuk repository JSON yang hanya mempunyai mutex
 * in-process. Lock dari PID yang terbukti sudah mati direklamasi secara atomik;
 * PID yang masih hidup, tidak dapat diperiksa, atau payload rusak tetap harus
 * ditangani operator agar dua writer tidak pernah berjalan bersamaan.
 */
export class LocalRuntimeLock {
  private released = false;
  private readonly exitCleanup: () => void;

  constructor(
    readonly path: string,
    private readonly token: string,
  ) {
    this.exitCleanup = () => removeOwnedLockSync(this.path, this.token);
    process.once("exit", this.exitCleanup);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    process.off("exit", this.exitCleanup);
    const payload = await readLock(this.path);
    if (payload?.token !== this.token) return;
    await unlink(this.path).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

export async function acquireLocalRuntimeLock(
  path: string,
  role: LockPayload["role"],
): Promise<LocalRuntimeLock> {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const payload: LockPayload = {
    version: 1,
    pid: process.pid,
    token,
    role,
    startedAt: new Date().toISOString(),
  };
  const stagingPath = `${path}.claim.${process.pid}.${token}`;
  const staging = await open(stagingPath, "wx", 0o600);
  try {
    await staging.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    await staging.sync();
  } finally {
    await staging.close();
  }

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // Hard-link publication is no-replace and atomic: the authority path
        // is either absent or already contains a complete, synced payload.
        await link(stagingPath, path);
        return new LocalRuntimeLock(path, token);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        const existing = await readLock(path);
        if (existing && !processIsAlive(existing.pid)) {
          const reclaimed = await reclaimDeadLock(path, existing.token);
          if (reclaimed) continue;
        }
        const owner = existing
          ? `PID ${existing.pid} (${existing.role}, sejak ${existing.startedAt})`
          : "proses lain dengan payload yang tidak dapat diverifikasi";
        throw Object.assign(
          new Error(
            `Data lokal Harvy sedang dikunci ${owner}. Hentikan runtime/probe lain lebih dulu. ` +
            `Hapus manual hanya bila kepemilikan lock sudah diverifikasi: ${path}`,
          ),
          { code: "LOCAL_DATA_LOCKED" },
        );
      }
    }
    throw Object.assign(
      new Error("Perebutan lock lokal tidak selesai; coba kembali."),
      { code: "LOCAL_DATA_LOCK_CONTENDED" },
    );
  } finally {
    // Authority sudah diputuskan oleh link atomik. Kegagalan membersihkan nama
    // staging tidak boleh membuat caller kehilangan handle lock yang sah.
    await unlink(stagingPath).catch(() => undefined);
  }
}

export function localRuntimeLockPath(controlPlaneFile: string): string {
  return `${controlPlaneFile}.runtime.lock`;
}

async function readLock(path: string): Promise<LockPayload | null> {
  try {
    return parseLock(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    return null;
  }
}

async function reclaimDeadLock(path: string, expectedToken: string): Promise<boolean> {
  const quarantine = `${path}.stale.${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    return false;
  }
  const moved = await readLock(quarantine);
  if (moved?.token !== expectedToken) {
    // Jangan menghapus file yang ternyata bukan snapshot yang diperiksa. Coba
    // kembalikan hanya bila belum ada contender baru pada path authority.
    await rename(quarantine, path).catch(() => undefined);
    return false;
  }
  await unlink(quarantine).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
  return true;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM berarti proses ada tetapi caller tidak berhak memberi sinyal.
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

function removeOwnedLockSync(path: string, token: string): void {
  try {
    const payload = parseLock(readFileSync(path, "utf8"));
    if (payload?.token === token) unlinkSync(path);
  } catch {
    // Exit cleanup hanya best effort; release normal memberi error yang terlihat.
  }
}

function parseLock(raw: string): LockPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<LockPayload>;
    return value.version === 1 &&
      Number.isSafeInteger(value.pid) && value.pid! > 0 &&
      typeof value.token === "string" &&
      (value.role === "runtime" || value.role === "probe" ||
        value.role === "evaluation" || value.role === "backup" ||
        value.role === "setup") &&
      typeof value.startedAt === "string"
      ? value as LockPayload
      : null;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
