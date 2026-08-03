import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

interface LockPayload {
  version: 1;
  pid: number;
  token: string;
  role: "runtime" | "probe" | "evaluation";
  startedAt: string;
}

/**
 * Pengaman satu proses untuk repository JSON yang hanya mempunyai mutex
 * in-process. Berkas sengaja tidak dibersihkan otomatis bila proses mati paksa:
 * operator harus memastikan PID sudah mati sebelum menghapus lock stale.
 */
export class LocalRuntimeLock {
  private released = false;
  private readonly exitCleanup: () => void;

  constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly token: string,
  ) {
    this.exitCleanup = () => removeOwnedLockSync(this.path, this.token);
    process.once("exit", this.exitCleanup);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    process.off("exit", this.exitCleanup);
    await this.handle.close().catch(() => undefined);
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
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const existing = await readLock(path);
    const owner = existing
      ? `PID ${existing.pid} (${existing.role}, sejak ${existing.startedAt})`
      : "proses lain";
    throw Object.assign(
      new Error(
        `Data lokal Harvy sedang dikunci ${owner}. Hentikan runtime/probe lain lebih dulu. ` +
        `Jika proses dipastikan sudah mati paksa, hapus lock stale secara manual: ${path}`,
      ),
      { code: "LOCAL_DATA_LOCKED" },
    );
  }
  const payload: LockPayload = {
    version: 1,
    pid: process.pid,
    token,
    role,
    startedAt: new Date().toISOString(),
  };
  await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
  await handle.sync();
  return new LocalRuntimeLock(path, handle, token);
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
      Number.isSafeInteger(value.pid) &&
      typeof value.token === "string" &&
      (value.role === "runtime" || value.role === "probe" || value.role === "evaluation") &&
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
