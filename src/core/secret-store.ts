import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { writeDurableFileAtomic } from "../storage/durable-file.js";

export interface SecretStore {
  put(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

/** In-memory store hanya untuk test; tidak cocok untuk restart production. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async put(ref: string, secret: string): Promise<void> { this.values.set(ref, secret); }
  async get(ref: string): Promise<string | null> { return this.values.get(ref) ?? null; }
  async delete(ref: string): Promise<void> { this.values.delete(ref); }
}

/** AES-256-GCM file store terpisah dari state normal dan tidak pernah diekspor. */
export class EncryptedFileSecretStore implements SecretStore {
  private readonly key: Buffer;
  private cache: Record<string, string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    key: Uint8Array,
  ) {
    if (key.byteLength !== 32) throw new Error("Kunci secret store harus 32 byte.");
    this.key = Buffer.from(key);
  }

  async put(ref: string, secret: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(secretAad(ref));
      const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      state[ref] = [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
      await this.persist(state);
    });
  }

  async get(ref: string): Promise<string | null> {
    const state = await this.load();
    const encoded = state[ref];
    if (!encoded) return null;
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
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    if (versioned) decipher.setAAD(secretAad(ref));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  async delete(ref: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load();
      if (!(ref in state)) return;
      delete state[ref];
      await this.persist(state);
    });
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Format secret store tidak sah.");
      const values: Record<string, string> = {};
      for (const [ref, value] of Object.entries(parsed)) {
        if (typeof value !== "string") throw new Error("Record secret store tidak sah.");
        values[ref] = value;
      }
      this.cache = values;
      return values;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.cache = {};
        return this.cache;
      }
      throw error;
    }
  }

  private async persist(state: Record<string, string>): Promise<void> {
    this.cache = state;
    await writeDurableFileAtomic(this.filePath, `${JSON.stringify(state)}\n`);
    await chmod(this.filePath, 0o600).catch(() => undefined);
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
