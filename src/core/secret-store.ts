import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { writeDurableFileAtomic } from "../storage/durable-file.js";

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_ENCODED_SECRET_CHARACTERS = 24 * 1024;

export interface SecretStore {
  put(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

/** In-memory store hanya untuk test; tidak cocok untuk restart production. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async put(ref: string, secret: string): Promise<void> {
    this.values.set(secretRef(ref), secretValue(secret));
  }
  async get(ref: string): Promise<string | null> {
    return this.values.get(secretRef(ref)) ?? null;
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(secretRef(ref));
  }
}

/** AES-256-GCM file store terpisah dari state normal dan tidak pernah diekspor. */
export class EncryptedFileSecretStore implements SecretStore {
  private readonly key: Buffer;
  private cache: Record<string, string> | null = null;
  private loading: Promise<Record<string, string>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    key: Uint8Array,
  ) {
    if (key.byteLength !== 32) throw new Error("Kunci secret store harus 32 byte.");
    this.key = Buffer.from(key);
  }

  async put(ref: string, secret: string): Promise<void> {
    const safeRef = secretRef(ref);
    const safeSecret = secretValue(secret);
    await this.exclusive(async () => {
      const state = cloneSecretState(await this.load());
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(secretAad(safeRef));
      const encrypted = Buffer.concat([
        cipher.update(safeSecret, "utf8"),
        cipher.final(),
      ]);
      state[safeRef] = [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
      await this.persist(state);
    });
  }

  async get(ref: string): Promise<string | null> {
    const safeRef = secretRef(ref);
    const state = await this.load();
    const encoded = Object.hasOwn(state, safeRef) ? state[safeRef] : null;
    if (!encoded) return null;
    return decryptSecret(encoded, safeRef, this.key);
  }

  async delete(ref: string): Promise<void> {
    const safeRef = secretRef(ref);
    await this.exclusive(async () => {
      const current = await this.load();
      if (!Object.hasOwn(current, safeRef)) return;
      const state = cloneSecretState(current);
      delete state[safeRef];
      await this.persist(state);
    });
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    const pending = this.loading ??= this.loadFromDisk();
    try {
      const loaded = await pending;
      // A concurrent durable mutation may have published a newer immutable
      // snapshot while the initial disk read was in flight. Never replace it
      // with the older snapshot.
      this.cache ??= loaded;
      return this.cache;
    } finally {
      if (this.loading === pending) this.loading = null;
    }
  }

  private async loadFromDisk(): Promise<Record<string, string>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptySecretState();
      }
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Format secret store tidak sah.");
    }
    const values = emptySecretState();
    for (const [ref, value] of Object.entries(parsed)) {
      const safeRef = secretRef(ref);
      if (
        typeof value !== "string" ||
        value.length < 3 ||
        value.length > MAX_ENCODED_SECRET_CHARACTERS
      ) {
        throw new Error("Record secret store tidak sah.");
      }
      values[safeRef] = value;
    }
    return values;
  }

  private async persist(state: Record<string, string>): Promise<void> {
    await writeDurableFileAtomic(this.filePath, `${JSON.stringify(state)}\n`);
    await chmod(this.filePath, 0o600).catch(() => undefined);
    this.cache = state;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function secretAad(ref: string): Buffer {
  return Buffer.from(`harvy-byok\0${ref}`, "utf8");
}

function decryptSecret(encoded: string, ref: string, key: Buffer): string {
  if (encoded.length > MAX_ENCODED_SECRET_CHARACTERS) {
    throw new Error("Format secret store tidak sah.");
  }
  const parts = encoded.split(".");
  const versioned = parts[0] === "v1";
  // Three-part records are readable for the prototype migration only. New
  // writes bind ciphertext to its credential ref via authenticated data so
  // swapping two records cannot cross an owner/credential boundary.
  if ((!versioned && parts.length !== 3) || (versioned && parts.length !== 4)) {
    throw new Error("Format secret store tidak sah.");
  }
  const offset = versioned ? 1 : 0;
  const iv = Buffer.from(parts[offset]!, "base64url");
  const tag = Buffer.from(parts[offset + 1]!, "base64url");
  const encrypted = Buffer.from(parts[offset + 2]!, "base64url");
  if (
    iv.byteLength !== 12 ||
    tag.byteLength !== 16 ||
    encrypted.byteLength < 1 ||
    encrypted.byteLength > MAX_SECRET_BYTES
  ) {
    throw new Error("Format secret store tidak sah.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (versioned) decipher.setAAD(secretAad(ref));
  decipher.setAuthTag(tag);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]));
  } catch {
    throw new Error("Format secret store tidak sah.");
  }
  return secretValue(decoded);
}

function secretRef(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/u.test(value) ||
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor"
  ) {
    throw new Error("Reference secret store tidak sah.");
  }
  return value;
}

function secretValue(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Nilai secret store tidak sah.");
  }
  return value;
}

function emptySecretState(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function cloneSecretState(
  state: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.assign(emptySecretState(), state);
}
