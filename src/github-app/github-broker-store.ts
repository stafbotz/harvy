import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  GitHubBrokerEffect,
  GitHubRepositoryArchiveReference,
} from "../domain/github.js";
import { writeDurableBytesAtomic } from "../storage/durable-file.js";

export type BrokerInstallationSessionStatus = "pending" | "ready" | "expired" | "revoked";

export interface BrokerInstallationSessionRecord {
  version: 1;
  sessionId: string;
  ownerWorkspaceKey: string;
  callbackStateHash: string;
  status: BrokerInstallationSessionStatus;
  installationId: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export type BrokerEffectPhase =
  | "admitted"
  | "objects_uploading"
  | "repository_bootstrap_sending"
  | "ref_update_sending"
  | "pr_create_sending"
  | "terminal";

export interface BrokerEffectRecord {
  version: 1;
  effectId: string;
  effectDigest: string;
  effect: GitHubBrokerEffect;
  phase: BrokerEffectPhase;
  status: "pending" | "committed" | "not_committed" | "unknown";
  externalId: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerArchiveRecord {
  version: 1;
  requestDigest: string;
  reference: GitHubRepositoryArchiveReference;
  relativePath: string;
}

/** File-backed broker ledger. The service must have a private, dedicated root. */
export class GitHubBrokerStore {
  readonly #root: string;
  readonly #sessions: string;
  readonly #effects: string;
  readonly #archives: string;

  constructor(root: string) {
    this.#root = resolve(safeRoot(root));
    this.#sessions = join(this.#root, "sessions");
    this.#effects = join(this.#root, "effects");
    this.#archives = join(this.#root, "archives");
  }

  get root(): string {
    return this.#root;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#sessions, { recursive: true, mode: 0o700 });
    await mkdir(this.#effects, { recursive: true, mode: 0o700 });
    await mkdir(this.#archives, { recursive: true, mode: 0o700 });
  }

  loadSession(sessionId: string): Promise<BrokerInstallationSessionRecord | null> {
    return readJson(this.#sessionPath(sessionId), parseSession);
  }

  async findSessionByStateHash(stateHash: string): Promise<BrokerInstallationSessionRecord | null> {
    const expected = sha256(stateHash, "callback state hash");
    for (const name of await readdir(this.#sessions)) {
      if (!name.endsWith(".json")) continue;
      const session = await readJson(join(this.#sessions, name), parseSession);
      if (session?.callbackStateHash === expected) return session;
    }
    return null;
  }

  async listSessions(): Promise<BrokerInstallationSessionRecord[]> {
    const result: BrokerInstallationSessionRecord[] = [];
    for (const name of await readdir(this.#sessions)) {
      if (!name.endsWith(".json")) continue;
      const session = await readJson(join(this.#sessions, name), parseSession);
      if (session) result.push(session);
    }
    return result;
  }

  saveSession(record: BrokerInstallationSessionRecord): Promise<void> {
    return atomicJson(this.#sessionPath(record.sessionId), parseSession(record));
  }

  loadEffect(effectId: string): Promise<BrokerEffectRecord | null> {
    return readJson(this.#effectPath(effectId), parseEffect);
  }

  async listEffects(): Promise<BrokerEffectRecord[]> {
    const result: BrokerEffectRecord[] = [];
    for (const name of await readdir(this.#effects)) {
      if (!name.endsWith(".json")) continue;
      const effect = await readJson(join(this.#effects, name), parseEffect);
      if (effect) result.push(effect);
    }
    return result;
  }

  saveEffect(record: BrokerEffectRecord): Promise<void> {
    return atomicJson(this.#effectPath(record.effectId), parseEffect(record));
  }

  loadArchive(operationId: string): Promise<BrokerArchiveRecord | null> {
    return readJson(this.#archiveRecordPath(operationId), parseArchive);
  }

  async saveArchive(record: BrokerArchiveRecord, bytes: Buffer): Promise<void> {
    const parsed = parseArchive(record);
    const path = this.archivePath(parsed.relativePath);
    if (bytes.byteLength !== parsed.reference.size || digest(bytes) !== parsed.reference.sha256) {
      throw new Error("Byte archive broker tidak cocok descriptor.");
    }
    try {
      const current = await stat(path);
      if (!current.isFile() || current.size !== bytes.byteLength ||
        digest(await readFile(path)) !== parsed.reference.sha256) {
        throw new Error("Artifact archive broker bertabrakan.");
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await atomicBytes(path, bytes);
    }
    await atomicJson(this.#archiveRecordPath(parsed.reference.operationId), parsed);
  }

  archivePath(relativePath: string): string {
    if (!/^archive-[a-f0-9]{64}\.zip$/u.test(relativePath)) {
      throw new Error("Path archive broker tidak sah.");
    }
    return join(this.#archives, relativePath);
  }

  #sessionPath(sessionId: string): string {
    return join(this.#sessions, `${keyHash(sessionId)}.json`);
  }

  #effectPath(effectId: string): string {
    return join(this.#effects, `${keyHash(effectId)}.json`);
  }

  #archiveRecordPath(operationId: string): string {
    return join(this.#archives, `${keyHash(operationId)}.json`);
  }
}

async function readJson<T>(path: string, parse: (value: unknown) => T): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  return atomicBytes(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function atomicBytes(path: string, bytes: Buffer): Promise<void> {
  await writeDurableBytesAtomic(path, bytes);
}

function parseSession(value: unknown): BrokerInstallationSessionRecord {
  const record = object(value) as Partial<BrokerInstallationSessionRecord>;
  exactKeys(record, [
    "version", "sessionId", "ownerWorkspaceKey", "callbackStateHash", "status",
    "installationId", "createdAt", "expiresAt", "completedAt", "updatedAt",
  ], "session broker");
  if (record.version !== 1 ||
    !safeText(record.sessionId, 512) || !safeText(record.ownerWorkspaceKey, 512) ||
    typeof record.callbackStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(record.callbackStateHash) ||
    !["pending", "ready", "expired", "revoked"].includes(record.status ?? "") ||
    (record.installationId !== null && !numericId(record.installationId)) ||
    !validIso(record.createdAt) || !validIso(record.expiresAt) ||
    (record.completedAt !== null && !validIso(record.completedAt)) || !validIso(record.updatedAt)) {
    throw new Error("Record session broker GitHub tidak sah.");
  }
  return structuredClone(record as BrokerInstallationSessionRecord);
}

function parseEffect(value: unknown): BrokerEffectRecord {
  const record = object(value) as Partial<BrokerEffectRecord>;
  exactKeys(record, [
    "version", "effectId", "effectDigest", "effect", "phase", "status", "externalId",
    "url", "createdAt", "updatedAt",
  ], "effect broker");
  if (record.version !== 1 || !safeText(record.effectId, 512) ||
    typeof record.effectDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.effectDigest) ||
    ![
      "admitted",
      "objects_uploading",
      "repository_bootstrap_sending",
      "ref_update_sending",
      "pr_create_sending",
      "terminal",
    ]
      .includes(record.phase ?? "") ||
    !["pending", "committed", "not_committed", "unknown"].includes(record.status ?? "") ||
    (record.externalId !== null && !safeText(record.externalId, 512)) ||
    (record.url !== null && !safeText(record.url, 4_096)) ||
    !validIso(record.createdAt) || !validIso(record.updatedAt) ||
    !record.effect || record.effect.effectId !== record.effectId ||
    digestCanonical(record.effect) !== record.effectDigest) {
    throw new Error("Record effect broker GitHub tidak sah.");
  }
  return structuredClone(record as BrokerEffectRecord);
}

function parseArchive(value: unknown): BrokerArchiveRecord {
  const record = object(value) as Partial<BrokerArchiveRecord>;
  exactKeys(record, ["version", "requestDigest", "reference", "relativePath"], "archive broker");
  if (record.version !== 1 || typeof record.requestDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.requestDigest) || !record.reference ||
    record.relativePath !== `archive-${record.reference.sha256}.zip`) {
    throw new Error("Record archive broker GitHub tidak sah.");
  }
  return structuredClone(record as BrokerArchiveRecord);
}

export function digestCanonical(value: unknown): string {
  return digest(Buffer.from(JSON.stringify(value), "utf8"));
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyHash(value: string): string {
  if (!safeText(value, 512)) throw new Error("Key broker GitHub tidak sah.");
  return digest(Buffer.from(value, "utf8"));
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  return value;
}

function numericId(value: unknown): boolean {
  return (typeof value === "string" || typeof value === "number") &&
    /^\d{1,20}$/u.test(String(value)) && BigInt(String(value)) > 0n;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\r\n\0]/u.test(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Object broker GitHub tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

function safeRoot(value: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) {
    throw new Error("Root broker GitHub tidak sah.");
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
