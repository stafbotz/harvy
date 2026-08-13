import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  SandboxLeaseJournal,
  SandboxLeaseJournalCreateResult,
  SandboxLeaseJournalRecord,
  SandboxLeaseJournalRemoveResult,
  SandboxLeaseJournalSaveResult,
} from "../domain/sandbox.js";
import {
  assertInitialRecord,
  validateSandboxLeaseJournalRecord,
  validateSandboxLeaseJournalTransition,
} from "../sandbox/sandbox-lease-journal.js";

interface SandboxLeaseJournalEnvelope {
  version: 1;
  records: SandboxLeaseJournalRecord[];
}

const FILE_QUEUES = new Map<string, Promise<void>>();

/**
 * Restart journal for the app-wide single-writer runtime lock. It adds CAS and
 * atomic file replace, but Windows directory metadata cannot be fsynced
 * portably; use the SQLite adapter when power-loss durability is required.
 */
export class FileSandboxLeaseJournal implements SandboxLeaseJournal {
  private readonly file: string;

  constructor(path: string) {
    this.file = resolve(path);
  }

  async list(): Promise<SandboxLeaseJournalRecord[]> {
    return this.exclusive(async () => {
      const envelope = await this.read();
      return envelope.records.map((record) => structuredClone(record));
    });
  }

  async create(
    input: SandboxLeaseJournalRecord,
  ): Promise<SandboxLeaseJournalCreateResult> {
    const record = validateSandboxLeaseJournalRecord(input);
    assertInitialRecord(record);
    return this.exclusive(async () => {
      const envelope = await this.read();
      const existing = envelope.records.find((candidate) => candidate.leaseId === record.leaseId);
      if (existing) {
        return { status: "exists", record: structuredClone(existing) };
      }
      await this.write({
        version: 1,
        records: [...envelope.records, structuredClone(record)],
      });
      return { status: "saved", record: structuredClone(record) };
    });
  }

  async save(
    input: SandboxLeaseJournalRecord,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalSaveResult> {
    const record = validateSandboxLeaseJournalRecord(input);
    return this.exclusive(async () => {
      const envelope = await this.read();
      const index = envelope.records.findIndex(
        (candidate) => candidate.leaseId === record.leaseId,
      );
      const current = index < 0 ? null : envelope.records[index]!;
      if (!current || current.revision !== expectedRevision) {
        return {
          status: "conflict",
          record: current ? structuredClone(current) : null,
        };
      }
      validateSandboxLeaseJournalTransition(current, record);
      const records = [...envelope.records];
      records[index] = structuredClone(record);
      await this.write({ version: 1, records });
      return { status: "saved", record: structuredClone(record) };
    });
  }

  async remove(
    leaseId: string,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalRemoveResult> {
    return this.exclusive(async () => {
      const envelope = await this.read();
      const index = envelope.records.findIndex((candidate) => candidate.leaseId === leaseId);
      const current = index < 0 ? null : envelope.records[index]!;
      if (!current || current.revision !== expectedRevision) {
        return {
          status: "conflict",
          record: current ? structuredClone(current) : null,
        };
      }
      if (current.state !== "disposing") {
        throw new Error("Sandbox journal hanya dapat menghapus record disposing.");
      }
      await this.write({
        version: 1,
        records: envelope.records.filter((candidate) => candidate.leaseId !== leaseId),
      });
      return { status: "removed" };
    });
  }

  private async read(): Promise<SandboxLeaseJournalEnvelope> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) return { version: 1, records: [] };
      throw error;
    }
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("File sandbox lease journal bukan object.");
    }
    const keys = Object.keys(parsed).sort();
    if (keys.length !== 2 || keys[0] !== "records" || keys[1] !== "version") {
      throw new Error("File sandbox lease journal memuat field yang tidak dikenal.");
    }
    const envelope = parsed as Partial<SandboxLeaseJournalEnvelope>;
    if (envelope.version !== 1 || !Array.isArray(envelope.records)) {
      throw new Error("Versi/bentuk file sandbox lease journal tidak sah.");
    }
    const records = envelope.records.map(validateSandboxLeaseJournalRecord);
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.leaseId)) throw new Error("Lease ID duplikat di sandbox journal.");
      ids.add(record.leaseId);
    }
    return { version: 1, records };
  }

  private async write(envelope: SandboxLeaseJournalEnvelope): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const data = `${JSON.stringify(envelope, null, 2)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.file);
      await syncDirectory(dirname(this.file));
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.file) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    FILE_QUEUES.set(this.file, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.file) === tail) FILE_QUEUES.delete(this.file);
    }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
    // Platform/filesystem tertentu tidak menyediakan fsync directory. File
    // payload sendiri tetap fsync sebelum atomic rename; error media seperti
    // EIO tidak pernah ditelan.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    code === "EINVAL" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP"
  ) return true;
  return process.platform === "win32" &&
    (code === "EISDIR" || code === "EPERM" || code === "EACCES" || code === "EBADF");
}
