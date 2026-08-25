import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { AppConfig } from "../config.js";
import type { CodingRuntimeDeploymentConfig } from
  "../core/coding-runtime-composition.js";
import {
  acquireLocalRuntimeLock,
  localRuntimeLockPath,
} from "../core/local-runtime-lock.js";
import {
  primaryChannelCredentialPaths,
  type PrimaryChannelCredentialPaths,
} from "./primary-channel-credentials.js";

const ARCHIVE_MAGIC = Buffer.from("HARVY-BACKUP-V1\n", "ascii");
const AUTH_TAG_BYTES = 16;
const MAX_HEADER_BYTES = 4_096;
const MAX_ARCHIVE_ENTRIES = 100_000;
const CHUNK_BYTES = 64 * 1_024;
const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type LocalBackupTargetKind = "file" | "directory" | "sqlite";
export type LocalBackupClassification =
  | "user-data"
  | "operational-state"
  | "credentials"
  | "coding-state"
  | "deployment-evidence";

export interface LocalBackupTarget {
  id: string;
  kind: LocalBackupTargetKind;
  sourcePath: string;
  environmentVariable: string | null;
  classification: LocalBackupClassification;
}

export interface LocalBackupPlan {
  lockPath: string;
  targets: LocalBackupTarget[];
  /** Exact files that must never enter the archive, especially its own key. */
  excludedPaths?: readonly string[];
}

export interface LocalBackupSummary {
  protocol: "harvy-local-backup/1";
  createdAt: string;
  targetCount: number;
  presentTargetCount: number;
  entryCount: number;
  plaintextBytes: number;
  encrypted: true;
}

interface ArchiveTarget {
  id: string;
  kind: LocalBackupTargetKind;
  environmentVariable: string | null;
  classification: LocalBackupClassification;
  present: boolean;
}

interface ArchiveEntry {
  targetId: string;
  relativePath: string;
  size: number;
  sha256: string;
  mode: number;
}

interface ArchiveManifest {
  protocol: "harvy-local-backup/1";
  createdAt: string;
  targets: ArchiveTarget[];
  entries: ArchiveEntry[];
  omissions: string[];
}

interface InventoryEntry extends ArchiveEntry {
  sourcePath: string;
}

interface ParsedArchive {
  manifest: ArchiveManifest;
  plaintextBytes: number;
}

export interface BackupKeyMaterial {
  key: Buffer;
  /** Present only when the key came from a file. */
  sourcePath: string | null;
}

/**
 * Durable state inventory for the current single-node deployment. Paths are
 * never serialized into the backup; only stable logical slots enter it so a
 * recovery can be inspected or remapped on another host.
 */
export function createRuntimeBackupPlan(
  config: AppConfig,
  coding: CodingRuntimeDeploymentConfig,
  options: {
    environmentFile?: string | null;
    excludedPaths?: readonly string[];
    primaryCredentialPaths?: PrimaryChannelCredentialPaths;
  } = {},
): LocalBackupPlan {
  const economy = config.controlPlane.economy;
  const primaryCredentials = options.primaryCredentialPaths ??
    primaryChannelCredentialPaths();
  const targets: LocalBackupTarget[] = [
    fileTarget("tasks", config.dataFile, "DATA_FILE", "user-data"),
    fileTarget("legacy-memories", config.memoryFile, "MEMORY_FILE", "user-data"),
    directoryTarget("memories", config.memoryFolder, "MEMORY_FOLDER", "user-data"),
    fileTarget("history", config.historyFile, "HISTORY_FILE", "user-data"),
    sqliteTarget(
      "long-term-memory",
      config.longTermMemoryFile,
      "LONG_TERM_MEMORY_FILE",
      "user-data",
    ),
    fileTarget("profiles", config.profileFile, "PROFILE_FILE", "user-data"),
    fileTarget("sessions", config.sessionFile, "SESSION_FILE", "user-data"),
    fileTarget("agent-runs", config.agentRunFile, "AGENT_RUN_FILE", "user-data"),
    fileTarget(
      "telemetry",
      config.telemetryFile,
      "TELEMETRY_FILE",
      "operational-state",
    ),
    fileTarget(
      "control-plane",
      config.controlPlane.file,
      "CONTROL_PLANE_FILE",
      "operational-state",
    ),
    fileTarget(
      "usage-ledger",
      config.controlPlane.usageLedgerFile,
      "USAGE_LEDGER_FILE",
      "operational-state",
    ),
    fileTarget(
      "entitlement-ledger",
      config.controlPlane.entitlementLedgerFile,
      "ENTITLEMENT_LEDGER_FILE",
      "operational-state",
    ),
    directoryTarget(
      "whatsapp-auth",
      config.whatsapp.authFolder,
      "WHATSAPP_AUTH_FOLDER",
      "credentials",
    ),
    fileTarget(
      "whatsapp-groups",
      config.whatsapp.groupFile,
      "WHATSAPP_GROUP_FILE",
      "user-data",
    ),
    fileTarget(
      "primary-channel-credential-key",
      primaryCredentials.keyFile,
      null,
      "credentials",
    ),
    fileTarget(
      "primary-channel-credentials",
      primaryCredentials.secretFile,
      null,
      "credentials",
    ),
  ];

  const groupRunFile = "groupAgentRunFile" in config
    ? config.groupAgentRunFile
    : null;
  const groupCleanupFile = "groupAgentRunCleanupFile" in config
    ? config.groupAgentRunCleanupFile
    : null;
  if (typeof groupRunFile === "string") {
    targets.push(fileTarget(
      "whatsapp-group-agent-runs",
      groupRunFile,
      "WHATSAPP_GROUP_AGENT_RUN_FILE",
      "user-data",
    ));
  }
  if (typeof groupCleanupFile === "string") {
    targets.push(fileTarget(
      "whatsapp-group-agent-run-cleanup",
      groupCleanupFile,
      "WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE",
      "operational-state",
    ));
  }
  if (economy) {
    targets.push(
      fileTarget(
        "economy",
        economy.file,
        "HARVY_ECONOMY_FILE",
        "operational-state",
      ),
      fileTarget(
        "byok-secrets",
        economy.byokSecretFile,
        "HARVY_BYOK_SECRET_FILE",
        "credentials",
      ),
    );
  }

  if (coding.enabled && coding.stateRoot) {
    targets.push(directoryTarget(
      "coding-state",
      coding.stateRoot,
      "HARVY_CODING_STATE_ROOT",
      "coding-state",
    ));
    pushOptionalFile(
      targets,
      "workspace-principal-secret",
      coding.principalSecretFile,
      "HARVY_WORKSPACE_PRINCIPAL_SECRET_FILE",
      "credentials",
    );
    pushOptionalFile(
      targets,
      "coding-conformance-receipt",
      coding.conformanceReceiptFile,
      "HARVY_CODING_CONFORMANCE_RECEIPT_FILE",
      "deployment-evidence",
    );
    pushTrustSecret(targets, "sandbox-proof-secret", "SANDBOX_TRUST_SECRET_FILE", coding.sandbox);
    pushTrustSecret(targets, "local-git-proof-secret", "LOCAL_GIT_TRUST_SECRET_FILE", coding.localGit);
    pushTrustSecret(targets, "github-proof-secret", "GITHUB_BROKER_TRUST_SECRET_FILE", coding.github);
  }

  if (options.environmentFile) {
    targets.push(fileTarget(
      "environment",
      options.environmentFile,
      null,
      "credentials",
    ));
  }

  return {
    lockPath: localRuntimeLockPath(config.controlPlane.file),
    targets,
    ...(options.excludedPaths
      ? { excludedPaths: [...options.excludedPaths] }
      : {}),
  };
}

export async function loadBackupKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BackupKeyMaterial> {
  const inline = env.HARVY_BACKUP_KEY_B64?.trim() ?? "";
  const configuredFile = env.HARVY_BACKUP_KEY_FILE?.trim() ?? "";
  if (Boolean(inline) === Boolean(configuredFile)) {
    throw codedError(
      "BACKUP_KEY_CONFIGURATION_INVALID",
      "Isi tepat satu dari HARVY_BACKUP_KEY_B64 atau HARVY_BACKUP_KEY_FILE.",
    );
  }
  if (inline) return { key: parseBackupKey(inline), sourcePath: null };

  const sourcePath = resolve(configuredFile);
  const metadata = await lstat(sourcePath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024) {
    throw codedError(
      "BACKUP_KEY_FILE_INVALID",
      "Berkas kunci backup harus berupa file biasa kecil dan bukan symlink.",
    );
  }
  return {
    key: parseBackupKey((await readFile(sourcePath, "utf8")).trim()),
    sourcePath,
  };
}

export function parseBackupKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) {
    throw codedError("BACKUP_KEY_INVALID", "Kunci backup bukan base64 yang sah.");
  }
  const key = Buffer.from(value, value.includes("-") || value.includes("_")
    ? "base64url"
    : "base64");
  if (key.length !== 32) {
    key.fill(0);
    throw codedError("BACKUP_KEY_INVALID", "Kunci backup harus tepat 32 byte.");
  }
  return key;
}

export async function environmentFileContainsBackupKey(
  path: string,
): Promise<boolean> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw codedError(
      "BACKUP_ENVIRONMENT_FILE_INVALID",
      "Berkas environment harus berupa file biasa bounded dan bukan symlink.",
    );
  }
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/u).some((line) => {
    const match = line.match(
      /^\s*(?:export\s+)?HARVY_BACKUP_KEY_B64\s*=\s*(.*?)\s*(?:#.*)?$/u,
    );
    if (!match) return false;
    const assigned = (match[1] ?? "").trim();
    return assigned !== "" && assigned !== "\"\"" && assigned !== "''";
  });
}

/** Creates one encrypted snapshot while the application runtime is offline. */
export async function createLocalBackup(input: {
  plan: LocalBackupPlan;
  destination: string;
  key: Uint8Array;
  now?: Date;
}): Promise<LocalBackupSummary> {
  assertKey(input.key);
  const destination = safeFilePath(input.destination, "BACKUP_DESTINATION_INVALID");
  validatePlan(input.plan, destination);
  const lock = await acquireLocalRuntimeLock(input.plan.lockPath, "backup");
  try {
    const inventory = await buildInventory(input.plan);
    const manifest: ArchiveManifest = {
      protocol: "harvy-local-backup/1",
      createdAt: (input.now ?? new Date()).toISOString(),
      targets: inventory.targets,
      entries: inventory.entries.map(({ sourcePath: _sourcePath, ...entry }) => entry),
      omissions: [
        "operational-logs",
        "runtime-lock",
        "backup-encryption-key",
      ],
    };
    await writeEncryptedArchive(destination, input.key, manifest, inventory.entries);
    return summaryOf(manifest);
  } finally {
    await lock.release();
  }
}

export async function verifyLocalBackup(input: {
  archive: string;
  key: Uint8Array;
}): Promise<LocalBackupSummary> {
  assertKey(input.key);
  return withDecryptedArchive(input.archive, input.key, async (decrypted) => {
    const parsed = await parseDecryptedArchive(decrypted);
    return summaryOf(parsed.manifest, parsed.plaintextBytes);
  });
}

/**
 * Recovers plaintext into a new directory. It never overwrites live state;
 * operators can inspect the map and point a replacement deployment at it.
 */
export async function restoreLocalBackup(input: {
  archive: string;
  destinationDirectory: string;
  key: Uint8Array;
}): Promise<LocalBackupSummary> {
  assertKey(input.key);
  const destination = safeDirectoryPath(
    input.destinationDirectory,
    "BACKUP_RESTORE_DESTINATION_INVALID",
  );
  if (await exists(destination)) {
    throw codedError(
      "BACKUP_RESTORE_DESTINATION_EXISTS",
      "Direktori pemulihan harus belum ada agar data tidak tertimpa.",
    );
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700).catch(() => undefined);
  try {
    return await withDecryptedArchive(input.archive, input.key, async (decrypted) => {
      const parsed = await parseDecryptedArchive(decrypted, destination);
      await writeRestoreMap(destination, parsed.manifest);
      return summaryOf(parsed.manifest, parsed.plaintextBytes);
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function fileTarget(
  id: string,
  sourcePath: string,
  environmentVariable: string | null,
  classification: LocalBackupClassification,
): LocalBackupTarget {
  return { id, kind: "file", sourcePath, environmentVariable, classification };
}

function directoryTarget(
  id: string,
  sourcePath: string,
  environmentVariable: string | null,
  classification: LocalBackupClassification,
): LocalBackupTarget {
  return { id, kind: "directory", sourcePath, environmentVariable, classification };
}

function sqliteTarget(
  id: string,
  sourcePath: string,
  environmentVariable: string | null,
  classification: LocalBackupClassification,
): LocalBackupTarget {
  return { id, kind: "sqlite", sourcePath, environmentVariable, classification };
}

function pushOptionalFile(
  targets: LocalBackupTarget[],
  id: string,
  sourcePath: string | null,
  environmentVariable: string,
  classification: LocalBackupClassification,
): void {
  if (sourcePath) {
    targets.push(fileTarget(id, sourcePath, environmentVariable, classification));
  }
}

function pushTrustSecret(
  targets: LocalBackupTarget[],
  id: string,
  environmentVariable: string,
  deployment: { secretFile: string } | null,
): void {
  if (deployment) {
    targets.push(fileTarget(
      id,
      deployment.secretFile,
      environmentVariable,
      "credentials",
    ));
  }
}

function validatePlan(plan: LocalBackupPlan, destination: string): void {
  safeFilePath(plan.lockPath, "BACKUP_LOCK_PATH_INVALID");
  const ids = new Set<string>();
  for (const target of plan.targets) {
    if (!TARGET_ID.test(target.id) || ids.has(target.id)) {
      throw codedError("BACKUP_TARGET_INVALID", "ID target backup tidak sah atau duplikat.");
    }
    ids.add(target.id);
    const source = safeSourcePath(target.sourcePath);
    if (
      source === destination ||
      (target.kind === "directory" && pathContains(source, destination))
    ) {
      throw codedError(
        "BACKUP_DESTINATION_INSIDE_SOURCE",
        `Destination backup berada di dalam target ${target.id}.`,
      );
    }
  }
}

async function buildInventory(plan: LocalBackupPlan): Promise<{
  targets: ArchiveTarget[];
  entries: InventoryEntry[];
}> {
  const exclusions = new Set(
    (plan.excludedPaths ?? []).map((path) => resolve(path).toLocaleLowerCase("en-US")),
  );
  const targets: ArchiveTarget[] = [];
  const entries: InventoryEntry[] = [];
  for (const target of plan.targets) {
    const sourcePath = safeSourcePath(target.sourcePath);
    const metadata = await lstat(sourcePath).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    const descriptor: ArchiveTarget = {
      id: target.id,
      kind: target.kind,
      environmentVariable: target.environmentVariable,
      classification: target.classification,
      present: metadata !== null,
    };
    targets.push(descriptor);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) throw unsafeSource(target.id);

    if (target.kind === "directory") {
      if (!metadata.isDirectory()) throw wrongSourceKind(target.id);
      await walkDirectory(sourcePath, "", target.id, exclusions, entries);
      continue;
    }
    if (!metadata.isFile()) throw wrongSourceKind(target.id);
    assertNotExcluded(sourcePath, target.id, exclusions);
    entries.push(await describeFile(target.id, "", sourcePath, metadata.mode));
    if (target.kind === "sqlite") {
      for (const suffix of ["-wal", "-shm"] as const) {
        const sidecar = `${sourcePath}${suffix}`;
        const sidecarMetadata = await lstat(sidecar).catch((error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (!sidecarMetadata) continue;
        if (!sidecarMetadata.isFile() || sidecarMetadata.isSymbolicLink()) {
          throw unsafeSource(target.id);
        }
        assertNotExcluded(sidecar, target.id, exclusions);
        entries.push(await describeFile(
          target.id,
          suffix,
          sidecar,
          sidecarMetadata.mode,
        ));
      }
    }
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw codedError("BACKUP_TOO_MANY_ENTRIES", "Jumlah file backup melampaui batas.");
  }
  return { targets, entries };
}

async function walkDirectory(
  root: string,
  currentRelative: string,
  targetId: string,
  exclusions: ReadonlySet<string>,
  entries: InventoryEntry[],
): Promise<void> {
  const current = currentRelative ? join(root, ...currentRelative.split("/")) : root;
  const children = (await readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const sourcePath = join(current, child.name);
    if (exclusions.has(resolve(sourcePath).toLocaleLowerCase("en-US"))) continue;
    const relativePath = currentRelative
      ? `${currentRelative}/${child.name}`
      : child.name;
    validateRelativePath(relativePath);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw unsafeSource(targetId);
    if (metadata.isDirectory()) {
      await walkDirectory(root, relativePath, targetId, exclusions, entries);
    } else if (metadata.isFile()) {
      entries.push(await describeFile(
        targetId,
        relativePath,
        sourcePath,
        metadata.mode,
      ));
    } else {
      throw unsafeSource(targetId);
    }
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      throw codedError("BACKUP_TOO_MANY_ENTRIES", "Jumlah file backup melampaui batas.");
    }
  }
}

async function describeFile(
  targetId: string,
  relativePath: string,
  sourcePath: string,
  mode: number,
): Promise<InventoryEntry> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const raw of createReadStream(sourcePath, { highWaterMark: CHUNK_BYTES })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (!Number.isSafeInteger(size)) {
      throw codedError("BACKUP_FILE_TOO_LARGE", "Ukuran file backup tidak sah.");
    }
    hash.update(chunk);
  }
  return {
    targetId,
    relativePath,
    size,
    sha256: hash.digest("hex"),
    mode: mode & 0o777,
    sourcePath,
  };
}

async function writeEncryptedArchive(
  destination: string,
  key: Uint8Array,
  manifest: ArchiveManifest,
  entries: readonly InventoryEntry[],
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  let handle: FileHandle | null = null;
  let created = false;
  try {
    handle = await open(destination, "wx", 0o600);
    created = true;
    const iv = randomBytes(12);
    const header = Buffer.from(JSON.stringify({
      format: "harvy-local-backup",
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
    }), "utf8");
    if (header.length > MAX_HEADER_BYTES) throw new Error("Header backup terlalu besar.");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length);
    const associatedData = Buffer.concat([ARCHIVE_MAGIC, headerLength, header]);
    let position = await writeAll(handle, associatedData, 0);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(associatedData);
    const emit = async (record: unknown): Promise<void> => {
      const encrypted = cipher.update(`${JSON.stringify(record)}\n`, "utf8");
      position = await writeAll(handle!, encrypted, position);
    };
    await emit({ type: "manifest", manifest });
    for (const entry of entries) {
      await emit({
        type: "file",
        targetId: entry.targetId,
        relativePath: entry.relativePath,
      });
      const hash = createHash("sha256");
      let observedSize = 0;
      for await (const raw of createReadStream(entry.sourcePath, {
        highWaterMark: CHUNK_BYTES,
      })) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        observedSize += chunk.length;
        hash.update(chunk);
        await emit({ type: "chunk", data: chunk.toString("base64") });
      }
      if (observedSize !== entry.size || hash.digest("hex") !== entry.sha256) {
        throw codedError(
          "BACKUP_SOURCE_CHANGED",
          `Target ${entry.targetId} berubah ketika backup dibuat.`,
        );
      }
      await emit({ type: "file-end" });
    }
    await emit({ type: "archive-end", entryCount: entries.length });
    position = await writeAll(handle, cipher.final(), position);
    await writeAll(handle, cipher.getAuthTag(), position);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(destination, 0o600).catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function withDecryptedArchive<T>(
  archivePath: string,
  key: Uint8Array,
  operation: (decrypted: Readable) => Promise<T>,
): Promise<T> {
  const archive = safeFilePath(archivePath, "BACKUP_ARCHIVE_PATH_INVALID");
  const decrypted = await openDecryptedArchive(archive, key);
  try {
    const result = await operation(decrypted.input).catch(async (error: unknown) => {
      if (decrypted.streamError() !== null) throw backupAuthenticationFailed();
      if (isCoded(error) && codedValue(error) === "BACKUP_ARCHIVE_INVALID") {
        // AES-GCM authenticates only at stream finalization. Drain ciphertext
        // before classifying an early parser failure so a wrong key cannot be
        // mislabeled as a merely malformed archive.
        decrypted.input.resume();
        try {
          await decrypted.authentication;
        } catch {
          throw backupAuthenticationFailed();
        }
      }
      throw error;
    });
    await decrypted.authentication.catch(() => {
      throw backupAuthenticationFailed();
    });
    return result;
  } finally {
    decrypted.close();
  }
}

async function openDecryptedArchive(
  archive: string,
  key: Uint8Array,
): Promise<{
  input: Readable;
  authentication: Promise<void>;
  streamError: () => unknown | null;
  close: () => void;
}> {
  const metadata = await stat(archive);
  const minimum = ARCHIVE_MAGIC.length + 4 + 2 + AUTH_TAG_BYTES;
  if (!metadata.isFile() || metadata.size < minimum) throw invalidArchive();
  const handle = await open(archive, "r");
  try {
    const magic = await readExactly(handle, ARCHIVE_MAGIC.length, 0);
    if (!magic.equals(ARCHIVE_MAGIC)) throw invalidArchive();
    const lengthBytes = await readExactly(handle, 4, ARCHIVE_MAGIC.length);
    const headerLength = lengthBytes.readUInt32BE();
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw invalidArchive();
    const headerOffset = ARCHIVE_MAGIC.length + 4;
    const headerBytes = await readExactly(handle, headerLength, headerOffset);
    const header = parseEncryptionHeader(headerBytes.toString("utf8"));
    const associatedData = Buffer.concat([magic, lengthBytes, headerBytes]);
    const ciphertextStart = headerOffset + headerLength;
    const tagStart = metadata.size - AUTH_TAG_BYTES;
    if (tagStart <= ciphertextStart) throw invalidArchive();
    const tag = await readExactly(handle, AUTH_TAG_BYTES, tagStart);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(header.iv, "base64url"),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const source = createReadStream(archive, {
      start: ciphertextStart,
      end: tagStart - 1,
    });
    let failure: unknown | null = null;
    const authentication = new Promise<void>((resolvePromise, reject) => {
      decipher.once("end", resolvePromise);
      decipher.once("error", (error) => {
        failure = error;
        reject(error);
      });
    });
    // A caller may fail on its output sink before awaiting authentication.
    // Registering a rejection handler prevents an orphaned stream rejection.
    void authentication.catch(() => undefined);
    source.once("error", (error) => {
      failure = error;
      decipher.destroy(error);
    });
    decipher.once("close", () => source.destroy());
    source.pipe(decipher);
    return {
      input: decipher,
      authentication,
      streamError: () => failure,
      close: () => {
        source.destroy();
        decipher.destroy();
      },
    };
  } catch (error) {
    if (isCoded(error)) throw error;
    throw backupAuthenticationFailed();
  } finally {
    await handle.close();
  }
}

async function parseDecryptedArchive(
  input: Readable,
  restoreRoot?: string,
): Promise<ParsedArchive> {
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  let manifest: ArchiveManifest | null = null;
  let expected = new Map<string, ArchiveEntry>();
  const seen = new Set<string>();
  let current: {
    entry: ArchiveEntry;
    hash: ReturnType<typeof createHash>;
    size: number;
    handle: FileHandle | null;
    position: number;
  } | null = null;
  let ended = false;
  let plaintextBytes = 0;
  try {
    for await (const line of reader) {
      plaintextBytes += Buffer.byteLength(line, "utf8") + 1;
      if (!line) throw invalidArchive();
      const record = parseRecord(line);
      if (!manifest) {
        if (record.type !== "manifest") throw invalidArchive();
        manifest = validateManifest(record.manifest);
        expected = new Map(manifest.entries.map((entry) => [entryKey(entry), entry]));
        if (restoreRoot) await prepareRestoreTargets(restoreRoot, manifest);
        continue;
      }
      if (ended) throw invalidArchive();
      if (current) {
        if (record.type === "chunk") {
          const chunk = decodeChunk(record.data);
          current.size += chunk.length;
          if (current.size > current.entry.size) throw invalidArchive();
          current.hash.update(chunk);
          if (current.handle) {
            current.position = await writeAll(current.handle, chunk, current.position);
          }
          continue;
        }
        if (record.type !== "file-end") throw invalidArchive();
        const digest = current.hash.digest("hex");
        if (current.size !== current.entry.size || digest !== current.entry.sha256) {
          throw invalidArchive();
        }
        if (current.handle) {
          await current.handle.sync();
          await current.handle.close();
          await chmod(
            restoreEntryPath(restoreRoot!, manifest, current.entry),
            current.entry.mode,
          ).catch(() => undefined);
        }
        seen.add(entryKey(current.entry));
        current = null;
        continue;
      }
      if (record.type === "file") {
        const key = `${record.targetId}\u0000${record.relativePath}`;
        const entry = expected.get(key);
        if (!entry || seen.has(key)) throw invalidArchive();
        let output: FileHandle | null = null;
        if (restoreRoot) {
          const outputPath = restoreEntryPath(restoreRoot, manifest, entry);
          await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
          output = await open(outputPath, "wx", entry.mode || 0o600);
        }
        current = {
          entry,
          hash: createHash("sha256"),
          size: 0,
          handle: output,
          position: 0,
        };
        continue;
      }
      if (record.type === "archive-end") {
        if (
          !Number.isSafeInteger(record.entryCount) ||
          record.entryCount !== expected.size ||
          seen.size !== expected.size
        ) throw invalidArchive();
        ended = true;
        continue;
      }
      throw invalidArchive();
    }
    if (!manifest || current || !ended || seen.size !== expected.size) throw invalidArchive();
    return { manifest, plaintextBytes };
  } finally {
    reader.close();
    await current?.handle?.close().catch(() => undefined);
  }
}

function parseRecord(line: string): Record<string, unknown> & { type: string } {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArchive();
    const type = (value as Record<string, unknown>)["type"];
    if (typeof type !== "string") throw invalidArchive();
    return value as Record<string, unknown> & { type: string };
  } catch (error) {
    if (isCoded(error)) throw error;
    throw invalidArchive();
  }
}

function validateManifest(value: unknown): ArchiveManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArchive();
  const record = value as Partial<ArchiveManifest>;
  if (
    record.protocol !== "harvy-local-backup/1" ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.targets) ||
    !Array.isArray(record.entries) ||
    !Array.isArray(record.omissions) ||
    record.entries.length > MAX_ARCHIVE_ENTRIES
  ) throw invalidArchive();
  const targetIds = new Set<string>();
  const targets = record.targets.map((raw) => validateArchiveTarget(raw, targetIds));
  const targetMap = new Map(targets.map((target) => [target.id, target]));
  const entryIds = new Set<string>();
  const entries = record.entries.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidArchive();
    const entry = raw as Partial<ArchiveEntry>;
    const target = typeof entry.targetId === "string"
      ? targetMap.get(entry.targetId)
      : null;
    if (
      !target ||
      typeof entry.relativePath !== "string" ||
      !Number.isSafeInteger(entry.size) || entry.size! < 0 ||
      typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) ||
      !Number.isSafeInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777
    ) throw invalidArchive();
    validateEntryPath(target.kind, entry.relativePath);
    const valid = entry as ArchiveEntry;
    const key = entryKey(valid);
    if (entryIds.has(key)) throw invalidArchive();
    entryIds.add(key);
    return valid;
  });
  for (const target of targets) {
    const count = entries.filter((entry) => entry.targetId === target.id).length;
    if (!target.present && count !== 0) throw invalidArchive();
    if (target.present && target.kind === "file" && count !== 1) throw invalidArchive();
    if (target.present && target.kind === "sqlite" &&
      !entries.some((entry) => entry.targetId === target.id && entry.relativePath === "")) {
      throw invalidArchive();
    }
  }
  if (!record.omissions.every((item) => typeof item === "string" && item.length <= 128)) {
    throw invalidArchive();
  }
  return {
    protocol: "harvy-local-backup/1",
    createdAt: record.createdAt,
    targets,
    entries,
    omissions: [...record.omissions] as string[],
  };
}

function validateArchiveTarget(
  value: unknown,
  ids: Set<string>,
): ArchiveTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArchive();
  const target = value as Partial<ArchiveTarget>;
  const kinds: LocalBackupTargetKind[] = ["file", "directory", "sqlite"];
  const classifications: LocalBackupClassification[] = [
    "user-data",
    "operational-state",
    "credentials",
    "coding-state",
    "deployment-evidence",
  ];
  if (
    typeof target.id !== "string" || !TARGET_ID.test(target.id) || ids.has(target.id) ||
    !kinds.includes(target.kind as LocalBackupTargetKind) ||
    !(target.environmentVariable === null ||
      (typeof target.environmentVariable === "string" &&
        /^[A-Z][A-Z0-9_]{0,95}$/u.test(target.environmentVariable))) ||
    !classifications.includes(target.classification as LocalBackupClassification) ||
    typeof target.present !== "boolean"
  ) throw invalidArchive();
  ids.add(target.id);
  return target as ArchiveTarget;
}

function parseEncryptionHeader(raw: string): { iv: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArchive();
    const record = value as Record<string, unknown>;
    if (
      record["format"] !== "harvy-local-backup" ||
      record["version"] !== 1 ||
      record["algorithm"] !== "aes-256-gcm" ||
      typeof record["iv"] !== "string" ||
      Buffer.from(record["iv"], "base64url").length !== 12
    ) throw invalidArchive();
    return { iv: record["iv"] };
  } catch (error) {
    if (isCoded(error)) throw error;
    throw invalidArchive();
  }
}

async function prepareRestoreTargets(
  root: string,
  manifest: ArchiveManifest,
): Promise<void> {
  const targetRoot = join(root, "targets");
  await mkdir(targetRoot, { recursive: false, mode: 0o700 });
  for (const target of manifest.targets) {
    if (!target.present) continue;
    await mkdir(join(targetRoot, target.id), { recursive: false, mode: 0o700 });
  }
}

function restoreEntryPath(
  root: string,
  manifest: ArchiveManifest,
  entry: ArchiveEntry,
): string {
  const target = manifest.targets.find((item) => item.id === entry.targetId);
  if (!target) throw invalidArchive();
  const base = join(root, "targets", target.id);
  if (target.kind === "file") return join(base, "data");
  if (target.kind === "sqlite") return join(base, `data${entry.relativePath}`);
  validateRelativePath(entry.relativePath);
  const candidate = resolve(base, ...entry.relativePath.split("/"));
  if (!pathContains(base, candidate) || candidate === resolve(base)) throw invalidArchive();
  return candidate;
}

async function writeRestoreMap(root: string, manifest: ArchiveManifest): Promise<void> {
  const targetMap = manifest.targets.map((target) => ({
    id: target.id,
    kind: target.kind,
    classification: target.classification,
    environmentVariable: target.environmentVariable,
    present: target.present,
    recoveredPath: !target.present
      ? null
      : target.kind === "file"
        ? `targets/${target.id}/data`
        : target.kind === "sqlite"
          ? `targets/${target.id}/data`
          : `targets/${target.id}`,
  }));
  const path = join(root, "RESTORE-MAP.json");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      protocol: manifest.protocol,
      createdAt: manifest.createdAt,
      note: "Point a stopped replacement deployment at these recovered paths; never merge them into a running data directory.",
      targets: targetMap,
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateEntryPath(kind: LocalBackupTargetKind, value: string): void {
  if (kind === "file" && value !== "") throw invalidArchive();
  if (kind === "sqlite" && value !== "" && value !== "-wal" && value !== "-shm") {
    throw invalidArchive();
  }
  if (kind === "directory") validateRelativePath(value);
}

function validateRelativePath(value: string): void {
  if (
    !value || value.includes("\\") || value.includes("\u0000") ||
    value.startsWith("/") || value.endsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) throw invalidArchive();
}

function decodeChunk(value: unknown): Buffer {
  if (
    typeof value !== "string" || value.length > Math.ceil(CHUNK_BYTES / 3) * 4 + 4 ||
    value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw invalidArchive();
  return Buffer.from(value, "base64");
}

function entryKey(entry: Pick<ArchiveEntry, "targetId" | "relativePath">): string {
  return `${entry.targetId}\u0000${entry.relativePath}`;
}

function summaryOf(
  manifest: ArchiveManifest,
  _observedPlaintextBytes?: number,
): LocalBackupSummary {
  const entryBytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
  return {
    protocol: "harvy-local-backup/1",
    createdAt: manifest.createdAt,
    targetCount: manifest.targets.length,
    presentTargetCount: manifest.targets.filter((target) => target.present).length,
    entryCount: manifest.entries.length,
    plaintextBytes: entryBytes,
    encrypted: true,
  };
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw invalidArchive();
    offset += result.bytesRead;
  }
  return buffer;
}

async function writeAll(
  handle: FileHandle,
  value: Uint8Array,
  position: number,
): Promise<number> {
  const buffer = Buffer.from(value);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (result.bytesWritten === 0) throw new Error("Write backup tidak maju.");
    offset += result.bytesWritten;
  }
  return position + buffer.length;
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw codedError("BACKUP_KEY_INVALID", "Kunci backup harus tepat 32 byte.");
  }
}

function assertNotExcluded(
  path: string,
  targetId: string,
  exclusions: ReadonlySet<string>,
): void {
  if (exclusions.has(resolve(path).toLocaleLowerCase("en-US"))) {
    throw codedError(
      "BACKUP_KEY_OVERLAPS_TARGET",
      `Target ${targetId} sama dengan file yang wajib dikecualikan.`,
    );
  }
}

function safeSourcePath(value: string): string {
  return safeFilePath(value, "BACKUP_SOURCE_PATH_INVALID");
}

function safeFilePath(value: string, code: string): string {
  if (!value || value.includes("\u0000")) throw codedError(code, "Path backup tidak sah.");
  const path = resolve(value);
  if (parsePath(path).root === path) throw codedError(code, "Path backup terlalu luas.");
  return path;
}

function safeDirectoryPath(value: string, code: string): string {
  return safeFilePath(value, code);
}

function pathContains(parent: string, child: string): boolean {
  const remainder = relative(resolve(parent), resolve(child));
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function wrongSourceKind(targetId: string): Error {
  return codedError(
    "BACKUP_TARGET_KIND_MISMATCH",
    `Jenis filesystem target ${targetId} tidak cocok dengan rencana backup.`,
  );
}

function unsafeSource(targetId: string): Error {
  return codedError(
    "BACKUP_UNSAFE_SOURCE",
    `Target ${targetId} memuat symlink atau node filesystem non-reguler.`,
  );
}

function invalidArchive(): Error {
  return codedError("BACKUP_ARCHIVE_INVALID", "Struktur backup tidak sah.");
}

function backupAuthenticationFailed(): Error {
  return codedError(
    "BACKUP_AUTHENTICATION_FAILED",
    "Backup rusak atau kunci enkripsinya tidak cocok.",
  );
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isCoded(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    String((error as Error & { code?: unknown }).code).startsWith("BACKUP_");
}

function codedValue(error: unknown): string | null {
  return isCoded(error)
    ? String((error as Error & { code: string }).code)
    : null;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
