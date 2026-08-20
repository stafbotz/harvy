import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeDurableFileAtomic } from "./durable-file.js";

export interface PrivateCodingSession {
  version: 1;
  principalKey: string;
  channel: "telegram" | "whatsapp";
  revision: number;
  workspaceKey: string | null;
  projectId: string | null;
  projectRevision: number | null;
  foregroundRunId: string | null;
  lastRunId: string | null;
  updatedAt: string;
}

interface SessionDatabase {
  version: 1;
  sessions: PrivateCodingSession[];
}

const QUEUES = new Map<string, Promise<void>>();

/** Content-free private workspace selection and foreground-run pointer. */
export class FilePrivateCodingSessionStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async load(principalKey: string): Promise<PrivateCodingSession | null> {
    validPrincipalKey(principalKey);
    const found = (await this.#read()).sessions.find(
      (candidate) => candidate.principalKey === principalKey,
    );
    return found ? structuredClone(found) : null;
  }

  async list(): Promise<PrivateCodingSession[]> {
    return (await this.#read()).sessions.map((session) => structuredClone(session));
  }

  async save(
    input: Omit<PrivateCodingSession, "revision">,
    expectedRevision: number | null,
  ): Promise<PrivateCodingSession> {
    validateSession(input);
    return this.#exclusive(async () => {
      const database = await this.#read();
      const index = database.sessions.findIndex(
        (candidate) => candidate.principalKey === input.principalKey,
      );
      const current = index < 0 ? null : database.sessions[index]!;
      if (
        (expectedRevision === null && current !== null) ||
        (expectedRevision !== null && current?.revision !== expectedRevision)
      ) throw new Error("Private coding session berubah bersamaan.");
      const saved: PrivateCodingSession = {
        ...structuredClone(input),
        revision: (current?.revision ?? 0) + 1,
      };
      if (index < 0) database.sessions.push(saved);
      else database.sessions[index] = saved;
      await writeDurableFileAtomic(
        this.#path,
        `${JSON.stringify(database, null, 2)}\n`,
      );
      return structuredClone(saved);
    });
  }

  async #read(): Promise<SessionDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as SessionDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("Format private coding session tidak dikenali.");
      }
      parsed.sessions.forEach(validateSession);
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, sessions: [] };
      }
      throw error;
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = QUEUES.get(this.#path) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    QUEUES.set(this.#path, tail);
    try {
      return await next;
    } finally {
      if (QUEUES.get(this.#path) === tail) QUEUES.delete(this.#path);
    }
  }
}

function validateSession(input: Omit<PrivateCodingSession, "revision"> | PrivateCodingSession): void {
  if (
    input.version !== 1 ||
    (input.channel !== "telegram" && input.channel !== "whatsapp") ||
    !/^[a-f0-9]{64}$/u.test(input.principalKey) ||
    !validOptionalKey(input.workspaceKey) ||
    !validOptionalKey(input.projectId) ||
    !validOptionalKey(input.foregroundRunId) ||
    !validOptionalKey(input.lastRunId) ||
    ((input.projectId === null) !== (input.projectRevision === null)) ||
    (input.projectRevision !== null &&
      (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 1)) ||
    !Number.isFinite(Date.parse(input.updatedAt)) ||
    ("revision" in input &&
      (!Number.isSafeInteger(input.revision) || input.revision < 1))
  ) throw new Error("Private coding session tidak sah.");
}

function validPrincipalKey(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("Principal session tidak sah.");
}

function validOptionalKey(value: string | null): boolean {
  return value === null || (
    typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\\/\p{Cc}]/u.test(value)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
