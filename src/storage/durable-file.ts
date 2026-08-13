import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Atomic JSON/text replacement with payload durability before rename. Directory
 * fsync is required where the platform exposes it; Windows filesystems that do
 * not expose directory handles remain a documented local-adapter limitation.
 */
export async function writeDurableFileAtomic(
  filePathInput: string,
  payload: string,
): Promise<void> {
  return writeDurableBytesAtomic(filePathInput, Buffer.from(payload, "utf8"));
}

export async function writeDurableBytesAtomic(
  filePathInput: string,
  payload: Uint8Array,
): Promise<void> {
  const filePath = resolve(filePathInput);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } catch (error) {
    // A successful read after rename only proves cache visibility, not crash
    // durability. Real fsync/media errors therefore remain ambiguous and must
    // propagate; only explicitly unsupported directory-sync APIs are ignored
    // inside syncDirectory().
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP" ||
    code === "EOPNOTSUPP"
  ) return true;
  return process.platform === "win32" &&
    (code === "EISDIR" || code === "EPERM" || code === "EACCES" ||
      code === "EBADF");
}
