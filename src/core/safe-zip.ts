import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import type { ProjectSnapshotManifest } from "../domain/project-workspace.js";
import {
  canonicalProjectPath,
  DEFAULT_PROJECT_TREE_LIMITS,
  resolveProjectPath,
  scanProjectTree,
  type ProjectTreeLimits,
} from "./project-files.js";

export interface SafeZipLimits extends ProjectTreeLimits {
  maxArchiveBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_SAFE_ZIP_LIMITS: Readonly<SafeZipLimits> = Object.freeze({
  ...DEFAULT_PROJECT_TREE_LIMITS,
  maxFiles: 5_000,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 24,
  maxArchiveBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
});

interface ZipEntry {
  path: string;
  directory: boolean;
  executable: boolean;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  recordEnd: number;
}

interface ParsedZip {
  entries: ZipEntry[];
  archiveSha256: string;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MAX_EOCD_SEARCH = 65_557;
const NESTED_ARCHIVE = /(?:\.zip|\.7z|\.rar|\.tar|\.tgz|\.tar\.gz|\.gz|\.bz2|\.xz|\.jar|\.war)$/iu;
const inflateRawAsync = promisify(inflateRaw);

/**
 * ZIP v1 parser intentionally supports only ordinary stored/deflated entries.
 * Zip64, encryption, links, special files, nested archives and ambiguous path
 * encodings fail closed instead of being delegated to a host archive command.
 */
export async function extractSafeZip(
  archive: Buffer,
  destination: string,
  options: {
    limits?: Partial<SafeZipLimits>;
    now?: () => Date;
    makeId?: () => string;
  } = {},
): Promise<{
  archiveSha256: string;
  manifest: ProjectSnapshotManifest;
}> {
  const limits = resolveZipLimits(options.limits);
  const parsed = parseZip(archive, limits);
  const absoluteDestination = resolve(destination);
  const temporary = `${absoluteDestination}.extract-${safeTemporaryId(
    (options.makeId ?? randomUUID)(),
  )}`;
  await mkdir(dirname(absoluteDestination), { recursive: true });
  await mkdir(temporary, { recursive: false });
  let installed = false;
  try {
    for (const entry of parsed.entries) {
      const target = resolveProjectPath(temporary, entry.path);
      if (entry.directory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const compressed = archive.subarray(
        entry.dataOffset,
        entry.dataOffset + entry.compressedSize,
      );
      const bytes = await inflateEntry(entry, compressed, limits.maxFileBytes);
      if (crc32(bytes) !== entry.crc32) {
        throw new Error("Checksum file ZIP tidak cocok.");
      }
      if (looksLikeNestedArchive(bytes)) {
        throw new Error("Archive bersarang tersamar tidak diizinkan dalam project ZIP.");
      }
      await writeFile(target, bytes, {
        flag: "wx",
        mode: entry.executable ? 0o700 : 0o600,
      });
      await chmod(target, entry.executable ? 0o700 : 0o600);
    }
    const manifest = await scanProjectTree(temporary, {
      limits,
      ...(options.now ? { now: options.now } : {}),
    });
    await rename(temporary, absoluteDestination);
    installed = true;
    return {
      archiveSha256: parsed.archiveSha256,
      manifest,
    };
  } finally {
    if (!installed) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export function inspectSafeZip(
  archive: Buffer,
  limits?: Partial<SafeZipLimits>,
): {
  archiveSha256: string;
  entries: Array<{
    path: string;
    directory: boolean;
    size: number;
    executable: boolean;
  }>;
} {
  const parsed = parseZip(archive, resolveZipLimits(limits));
  return {
    archiveSha256: parsed.archiveSha256,
    entries: parsed.entries.map((entry) => ({
      path: entry.path,
      directory: entry.directory,
      size: entry.uncompressedSize,
      executable: entry.executable,
    })),
  };
}

function parseZip(archive: Buffer, limits: SafeZipLimits): ParsedZip {
  if (!Buffer.isBuffer(archive) || archive.length === 0) {
    throw new Error("Artifact ZIP kosong atau tidak sah.");
  }
  if (archive.length > limits.maxArchiveBytes) {
    throw new Error("Ukuran artifact ZIP melampaui batas.");
  }
  const eocdOffset = findEocd(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);
  const commentLength = archive.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + 22 + commentLength !== archive.length) {
    throw new Error("ZIP mempunyai trailing data atau komentar rusak.");
  }
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("Multi-disk dan Zip64 tidak didukung oleh ingestion aman.");
  }
  if (totalEntries > limits.maxFiles + limits.maxFiles) {
    throw new Error("Jumlah entry ZIP melampaui batas.");
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error("Direktori pusat ZIP tidak konsisten.");
  }

  const entries: ZipEntry[] = [];
  const collisionKinds = new Map<
    string,
    "file" | "implicit-directory" | "directory"
  >();
  let cursor = centralOffset;
  let fileCount = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    assertRange(archive, cursor, 46, "Header direktori ZIP terpotong.");
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("Signature direktori pusat ZIP tidak sah.");
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    assertRange(archive, cursor, recordLength, "Entry direktori ZIP terpotong.");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart !== 0
    ) {
      throw new Error("Entry Zip64 atau multi-disk ditolak.");
    }
    validateFlags(flags);
    if (method !== 0 && method !== 8) {
      throw new Error("Metode kompresi ZIP tidak didukung.");
    }
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const decodedName = decodeZipName(rawName);
    const directoryByName = /[\\/]$/u.test(decodedName);
    const path = canonicalArchivePath(decodedName, directoryByName);
    const unixMode = versionMadeBy >>> 8 === 3
      ? (externalAttributes >>> 16) & 0xffff
      : 0;
    const fileType = unixMode & 0o170000;
    const directoryByMode = fileType === 0o040000 ||
      ((externalAttributes & 0x10) !== 0 && fileType === 0);
    const directory = directoryByName || directoryByMode;
    const pathDepth = path.split("/").length - (directory ? 0 : 1);
    if (path.length > limits.maxPathCharacters) {
      throw new Error("Path ZIP melampaui batas panjang.");
    }
    if (pathDepth > limits.maxDepth) {
      throw new Error("Kedalaman direktori ZIP melampaui batas.");
    }
    if (
      fileType !== 0 &&
      fileType !== 0o100000 &&
      fileType !== 0o040000
    ) {
      throw new Error("Link atau special file tidak diizinkan dalam ZIP.");
    }
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new Error("Tipe entry ZIP tidak konsisten.");
    }
    registerCollision(collisionKinds, path, directory);
    if (!directory) {
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new Error("Jumlah file ZIP melampaui batas.");
      }
      if (uncompressedSize > limits.maxFileBytes) {
        throw new Error("Satu file ZIP melampaui batas ukuran terurai.");
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxTotalBytes) {
        throw new Error("Ukuran ZIP terurai melampaui batas.");
      }
      if (
        uncompressedSize > 0 &&
        (compressedSize === 0 ||
          uncompressedSize / compressedSize > limits.maxCompressionRatio)
      ) {
        throw new Error("Rasio kompresi ZIP melampaui batas.");
      }
      if (NESTED_ARCHIVE.test(path)) {
        throw new Error("Archive bersarang tidak diizinkan dalam project ZIP.");
      }
    }

    const local = parseLocalRecord(
      archive,
      centralOffset,
      {
        path,
        directory,
        // Archive permission bits are untrusted and intentionally neutralized.
        executable: false,
        flags,
        method,
        crc32: expectedCrc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      },
    );
    entries.push(local);
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error("Ukuran direktori pusat ZIP tidak cocok.");
  }
  if (fileCount === 0) {
    throw new Error("Project ZIP tidak memuat file.");
  }
  const orderedRecords = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 1; index < orderedRecords.length; index += 1) {
    if (
      orderedRecords[index]!.localHeaderOffset < orderedRecords[index - 1]!.recordEnd
    ) {
      throw new Error("Entry ZIP saling tumpang tindih.");
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    entries,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
}

function parseLocalRecord(
  archive: Buffer,
  centralOffset: number,
  entry: Omit<ZipEntry, "dataOffset" | "recordEnd">,
): ZipEntry {
  const offset = entry.localHeaderOffset;
  assertRange(archive, offset, 30, "Header lokal ZIP terpotong.");
  if (archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error("Signature header lokal ZIP tidak sah.");
  }
  const localFlags = archive.readUInt16LE(offset + 6);
  const localMethod = archive.readUInt16LE(offset + 8);
  const localCrc = archive.readUInt32LE(offset + 14);
  const localCompressed = archive.readUInt32LE(offset + 18);
  const localUncompressed = archive.readUInt32LE(offset + 22);
  const localNameLength = archive.readUInt16LE(offset + 26);
  const localExtraLength = archive.readUInt16LE(offset + 28);
  const headerLength = 30 + localNameLength + localExtraLength;
  assertRange(archive, offset, headerLength, "Header lokal ZIP terpotong.");
  const localName = decodeZipName(
    archive.subarray(offset + 30, offset + 30 + localNameLength),
  );
  if (
    canonicalArchivePath(localName, entry.directory) !== entry.path ||
    localFlags !== entry.flags ||
    localMethod !== entry.method
  ) {
    throw new Error("Header lokal dan pusat ZIP tidak cocok.");
  }
  const usesDescriptor = (entry.flags & 0x08) !== 0;
  if (
    !usesDescriptor &&
    (localCrc !== entry.crc32 ||
      localCompressed !== entry.compressedSize ||
      localUncompressed !== entry.uncompressedSize)
  ) {
    throw new Error("Ukuran atau checksum header lokal ZIP tidak cocok.");
  }
  const dataOffset = offset + headerLength;
  let recordEnd = dataOffset + entry.compressedSize;
  if (recordEnd > centralOffset) {
    throw new Error("Data entry ZIP melewati direktori pusat.");
  }
  if (usesDescriptor) {
    const hasSignature = recordEnd + 4 <= centralOffset &&
      archive.readUInt32LE(recordEnd) === DATA_DESCRIPTOR_SIGNATURE;
    const descriptorOffset = recordEnd + (hasSignature ? 4 : 0);
    assertRange(archive, descriptorOffset, 12, "Data descriptor ZIP terpotong.");
    if (
      archive.readUInt32LE(descriptorOffset) !== entry.crc32 ||
      archive.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize ||
      archive.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize
    ) {
      throw new Error("Data descriptor ZIP tidak cocok.");
    }
    recordEnd = descriptorOffset + 12;
    if (recordEnd > centralOffset) {
      throw new Error("Data descriptor ZIP melewati direktori pusat.");
    }
  }
  return { ...entry, dataOffset, recordEnd };
}

async function inflateEntry(
  entry: ZipEntry,
  compressed: Buffer,
  maxFileBytes: number,
): Promise<Buffer> {
  let bytes: Buffer;
  if (entry.method === 0) {
    bytes = Buffer.from(compressed);
  } else {
    try {
      bytes = await inflateRawAsync(compressed, {
        maxOutputLength: Math.min(maxFileBytes, entry.uncompressedSize) + 1,
      }) as Buffer;
    } catch {
      throw new Error("Data deflate ZIP tidak sah atau melampaui batas.");
    }
  }
  if (bytes.length !== entry.uncompressedSize) {
    throw new Error("Ukuran file ZIP setelah ekstraksi tidak cocok.");
  }
  return bytes;
}

function looksLikeNestedArchive(bytes: Buffer): boolean {
  if (bytes.length >= 4) {
    const prefix = bytes.subarray(0, 8);
    if (
      prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
      prefix.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
      prefix.subarray(0, 7).equals(Buffer.from("Rar!\x1a\x07", "binary")) ||
      prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))
    ) return true;
  }
  return bytes.length >= 265 && bytes.subarray(257, 262).toString("ascii") === "ustar";
}

function findEocd(archive: Buffer): number {
  const minimum = Math.max(0, archive.length - MAX_EOCD_SEARCH);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("End-of-central-directory ZIP tidak ditemukan.");
}

function validateFlags(flags: number): void {
  const forbidden = 0x0001 | 0x0020 | 0x0040 | 0x2000;
  if ((flags & forbidden) !== 0) {
    throw new Error("ZIP terenkripsi atau memakai flag yang tidak aman.");
  }
}

function decodeZipName(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("Nama entry ZIP harus UTF-8 yang sah.");
  }
}

function canonicalArchivePath(value: string, directory: boolean): string {
  let normalized = value.normalize("NFC").replace(/\\/gu, "/");
  if (directory) normalized = normalized.replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^\/{2}/u.test(normalized) ||
    /^[a-z]:/iu.test(normalized)
  ) {
    throw new Error("Path absolute di dalam ZIP ditolak.");
  }
  return canonicalProjectPath(normalized);
}

function registerCollision(
  kinds: Map<string, "file" | "implicit-directory" | "directory">,
  path: string,
  directory: boolean,
): void {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join("/").toLocaleLowerCase("en-US");
    if (kinds.get(parent) === "file") {
      throw new Error("Path ZIP bertabrakan dengan file induk.");
    }
    if (!kinds.has(parent)) kinds.set(parent, "implicit-directory");
  }
  const key = path.toLocaleLowerCase("en-US");
  const existing = kinds.get(key);
  const kind = directory ? "directory" : "file";
  if (existing === "file" || (existing === "directory" && kind === "file")) {
    throw new Error("ZIP memuat path duplikat atau bertabrakan.");
  }
  if (existing === "directory" && kind === "directory") {
    throw new Error("ZIP memuat entry direktori duplikat.");
  }
  if (existing === "implicit-directory" && kind === "file") {
    throw new Error("ZIP memuat file yang bertabrakan dengan direktori.");
  }
  kinds.set(key, kind);
}

function assertRange(
  archive: Buffer,
  offset: number,
  length: number,
  message: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > archive.length
  ) {
    throw new Error(message);
  }
}

function resolveZipLimits(input: Partial<SafeZipLimits> | undefined): SafeZipLimits {
  const limits = { ...DEFAULT_SAFE_ZIP_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Batas ZIP ${name} tidak sah.`);
    }
  }
  if (
    limits.maxFileBytes > limits.maxTotalBytes ||
    limits.maxArchiveBytes > limits.maxTotalBytes
  ) {
    throw new Error("Batas ZIP individual tidak konsisten dengan batas total.");
  }
  return limits;
}

function safeTemporaryId(value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/giu, "").slice(0, 64);
  if (!clean) throw new Error("ID temporary extraction tidak sah.");
  return clean;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
