import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ProjectSnapshotManifest } from "../domain/project-workspace.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import { canonicalProjectPath } from "../core/project-files.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";

const MAGIC = "HARVY_SNAPSHOT_BUNDLE_V1";
const MAX_MANIFEST_BYTES = 8 * 1_024 * 1_024;
const MAX_HEADER_BYTES = 4 * 1_024;
const MAX_FILES = 10_000;
const COPY_CHUNK_BYTES = 64 * 1_024;

/**
 * Extracts the deterministic Harvy bundle into a service-owned fresh root.
 * Only manifest-declared regular files are created; symlinks, devices, path
 * traversal, sparse expansion, and trailing bytes are rejected.
 */
export async function extractProjectSnapshotBundle(
  bundlePath: string,
  targetRoot: string,
  descriptor: ProjectSnapshotBundleDescriptor,
  options: { maxExtractedBytes: number },
): Promise<ProjectSnapshotManifest> {
  validateDescriptor(descriptor);
  if (!Number.isSafeInteger(options.maxExtractedBytes) ||
    options.maxExtractedBytes < 1 || options.maxExtractedBytes > 2 * 1_024 * 1_024 * 1_024) {
    throw codecError("Batas ekstraksi snapshot tidak sah.");
  }
  const root = resolve(targetRoot);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw codecError("Root ekstraksi snapshot bukan direktori nyata.");
  }

  const handle = await open(bundlePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const reader = new BufferedBundleReader(handle);
    const magic = await reader.readLine(128);
    if (magic !== MAGIC) throw codecError("Magic snapshot bundle tidak sah.");
    const manifestLine = await reader.readLine(MAX_MANIFEST_BYTES);
    const manifestBytes = Buffer.from(manifestLine, "utf8");
    if (sha256(manifestBytes) !== descriptor.manifestSha256) {
      throw codecError("Manifest snapshot bundle tidak cocok descriptor.");
    }
    const manifest = parseManifest(manifestLine, descriptor, options.maxExtractedBytes);
    const seen = new Set<string>();
    for (const declared of manifest.files) {
      const headerLine = await reader.readLine(MAX_HEADER_BYTES);
      const header = parseHeader(headerLine);
      if (JSON.stringify(header) !== JSON.stringify({
        path: declared.path,
        size: declared.size,
        sha256: declared.sha256,
        executable: declared.executable,
      })) {
        throw codecError("Header file snapshot tidak cocok manifest.");
      }
      if (seen.has(header.path)) throw codecError("Path snapshot bundle duplikat.");
      seen.add(header.path);
      const absolute = containedPath(root, header.path);
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
      const destination = await open(
        absolute,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        header.executable ? 0o700 : 0o600,
      );
      const hash = createHash("sha256");
      try {
        await reader.copyExact(destination, header.size, hash);
      } finally {
        await destination.close();
      }
      if (hash.digest("hex") !== header.sha256) {
        throw codecError("Isi file snapshot tidak cocok manifest.");
      }
      const separator = await reader.readExactBytes(1);
      if (separator[0] !== 0x0a) throw codecError("Separator file snapshot tidak sah.");
      await chmod(absolute, header.executable ? 0o700 : 0o600);
    }
    if (!(await reader.eof())) throw codecError("Snapshot bundle memuat trailing bytes.");
    return Object.freeze({
      ...manifest,
      files: manifest.files.map((file) => Object.freeze({ ...file })),
    });
  } finally {
    await handle.close();
  }
}

interface BundleManifestWire {
  version: 1;
  snapshotId: string;
  totalBytes: number;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    executable: boolean;
  }>;
}

function parseManifest(
  text: string,
  descriptor: ProjectSnapshotBundleDescriptor,
  maxExtractedBytes: number,
): ProjectSnapshotManifest {
  const parsed = parseObject(text, "manifest snapshot") as Partial<BundleManifestWire>;
  exactKeys(parsed, ["version", "snapshotId", "totalBytes", "files"], "manifest snapshot");
  if (parsed.version !== 1 || parsed.snapshotId !== descriptor.snapshotId ||
    !Number.isSafeInteger(parsed.totalBytes) || parsed.totalBytes! < 0 ||
    parsed.totalBytes! > maxExtractedBytes || !Array.isArray(parsed.files) ||
    parsed.files.length !== descriptor.fileCount || parsed.files.length > MAX_FILES) {
    throw codecError("Manifest snapshot tidak cocok descriptor atau quota.");
  }
  let total = 0;
  const files = parsed.files.map((value) => {
    exactKeys(value, ["path", "size", "sha256", "executable"], "file manifest snapshot");
    const path = safeProjectPath(value.path);
    if (!Number.isSafeInteger(value.size) || value.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(value.sha256) || typeof value.executable !== "boolean") {
      throw codecError("File manifest snapshot tidak sah.");
    }
    total += value.size;
    if (!Number.isSafeInteger(total) || total > maxExtractedBytes) {
      throw codecError("Byte ekstraksi snapshot melampaui quota.");
    }
    return { path, size: value.size, sha256: value.sha256, executable: value.executable };
  });
  if (total !== parsed.totalBytes || new Set(files.map((file) => file.path)).size !== files.length) {
    throw codecError("Total byte atau path manifest snapshot tidak konsisten.");
  }
  return {
    version: 1,
    snapshotId: descriptor.snapshotId,
    files,
    totalBytes: total,
    createdAt: new Date(0).toISOString(),
  };
}

function parseHeader(text: string): BundleManifestWire["files"][number] {
  const value = parseObject(text, "header snapshot") as Partial<
    BundleManifestWire["files"][number]
  >;
  exactKeys(value, ["path", "size", "sha256", "executable"], "header snapshot");
  const path = safeProjectPath(value.path);
  if (!Number.isSafeInteger(value.size) || value.size! < 0 ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.executable !== "boolean") {
    throw codecError("Header snapshot tidak sah.");
  }
  return {
    path,
    size: value.size!,
    sha256: value.sha256,
    executable: value.executable,
  };
}

class BufferedBundleReader {
  #buffer = Buffer.alloc(0);
  #offset = 0;
  #position = 0;
  #ended = false;

  constructor(private readonly handle: FileHandle) {}

  async readLine(maxBytes: number): Promise<string> {
    const parts: Buffer[] = [];
    let size = 0;
    while (true) {
      await this.#fill();
      if (this.#offset >= this.#buffer.byteLength) {
        throw codecError("Snapshot bundle terpotong sebelum newline.");
      }
      const newline = this.#buffer.indexOf(0x0a, this.#offset);
      const end = newline === -1 ? this.#buffer.byteLength : newline;
      const part = this.#buffer.subarray(this.#offset, end);
      size += part.byteLength;
      if (size > maxBytes) throw codecError("Line snapshot bundle melampaui batas.");
      parts.push(part);
      this.#offset = end;
      if (newline !== -1) {
        this.#offset += 1;
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, size));
      }
    }
  }

  async copyExact(destination: FileHandle, size: number, hash: ReturnType<typeof createHash>): Promise<void> {
    let remaining = size;
    let written = 0;
    while (remaining > 0) {
      await this.#fill();
      const available = this.#buffer.byteLength - this.#offset;
      if (available < 1) throw codecError("Isi file snapshot terpotong.");
      const length = Math.min(available, remaining, COPY_CHUNK_BYTES);
      const chunk = this.#buffer.subarray(this.#offset, this.#offset + length);
      await destination.write(chunk, 0, chunk.byteLength, written);
      hash.update(chunk);
      written += chunk.byteLength;
      remaining -= chunk.byteLength;
      this.#offset += chunk.byteLength;
    }
  }

  async readExactBytes(size: number): Promise<Buffer> {
    const output = Buffer.allocUnsafe(size);
    let copied = 0;
    while (copied < size) {
      await this.#fill();
      const available = this.#buffer.byteLength - this.#offset;
      if (available < 1) throw codecError("Snapshot bundle terpotong.");
      const length = Math.min(available, size - copied);
      this.#buffer.copy(output, copied, this.#offset, this.#offset + length);
      copied += length;
      this.#offset += length;
    }
    return output;
  }

  async eof(): Promise<boolean> {
    await this.#fill();
    return this.#ended && this.#offset >= this.#buffer.byteLength;
  }

  async #fill(): Promise<void> {
    if (this.#offset < this.#buffer.byteLength || this.#ended) return;
    const next = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const read = await this.handle.read(next, 0, next.byteLength, this.#position);
    if (read.bytesRead < 1) {
      this.#buffer = Buffer.alloc(0);
      this.#offset = 0;
      this.#ended = true;
      return;
    }
    this.#position += read.bytesRead;
    this.#buffer = next.subarray(0, read.bytesRead);
    this.#offset = 0;
  }
}

function validateDescriptor(value: ProjectSnapshotBundleDescriptor): void {
  exactKeys(value, [
    "version",
    "snapshotId",
    "bundleSha256",
    "manifestSha256",
    "size",
    "fileCount",
    "mediaType",
  ], "descriptor snapshot");
  if (value.version !== 1 || value.mediaType !== "application/vnd.harvy.snapshot-bundle.v1" ||
    !/^[a-f0-9]{64}$/u.test(value.snapshotId) ||
    !/^[a-f0-9]{64}$/u.test(value.bundleSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.manifestSha256) ||
    !Number.isSafeInteger(value.size) || value.size < 1 ||
    !Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || value.fileCount > MAX_FILES) {
    throw codecError("Descriptor snapshot bundle tidak sah.");
  }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw codecError(`${label} bukan JSON sah.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codecError(`${label} bukan object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw codecError(`${label} memuat field asing atau hilang.`);
  }
}

function safeProjectPath(value: unknown): string {
  if (typeof value !== "string") throw codecError("Path snapshot bukan teks.");
  const path = canonicalProjectPath(value);
  if (isSensitiveProjectPath(path) || containsSecretLikeValue(path)) {
    throw codecError("Path sensitif tidak boleh diekstrak dari snapshot.");
  }
  return path;
}

function containedPath(root: string, projectPath: string): string {
  const absolute = resolve(root, ...projectPath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw codecError("Path snapshot keluar dari root ekstraksi.");
  }
  return absolute;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function codecError(message: string): Error {
  const error = new Error(message);
  error.name = "SnapshotBundleCodecError";
  return error;
}
