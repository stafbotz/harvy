import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
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

interface JournalRow {
  lease_id: string;
  revision: number;
  record_json: string;
}

/**
 * Crash-durable, cross-process lease journal for live runner composition.
 * SQLite owns the platform-specific flush/locking protocol; `synchronous=FULL`
 * means a successful transaction is the write-ahead authority before Harvy
 * crosses the sandbox transport boundary.
 */
export class SqliteSandboxLeaseJournal implements SandboxLeaseJournal {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(filePath: string) {
    const file = resolve(filePath);
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sandbox_lease_journal (
        lease_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        record_json TEXT NOT NULL
      ) STRICT;
    `);
    const version = this.database.prepare("PRAGMA user_version").get() as
      | Record<string, unknown>
      | undefined;
    const current = version ? Object.values(version)[0] : undefined;
    if (current === 0) this.database.exec("PRAGMA user_version = 1");
    else if (current !== 1) {
      this.database.close();
      this.closed = true;
      throw new Error("Versi SQLite sandbox lease journal tidak dikenali.");
    }
  }

  async list(): Promise<SandboxLeaseJournalRecord[]> {
    this.assertOpen();
    const rows = this.database.prepare(
      "SELECT lease_id, revision, record_json FROM sandbox_lease_journal ORDER BY lease_id",
    ).all() as unknown as JournalRow[];
    return rows.map(parseRow);
  }

  async create(
    input: SandboxLeaseJournalRecord,
  ): Promise<SandboxLeaseJournalCreateResult> {
    this.assertOpen();
    const record = validateSandboxLeaseJournalRecord(input);
    assertInitialRecord(record);
    return this.transaction(() => {
      const existing = this.select(record.leaseId);
      if (existing) return { status: "exists", record: existing };
      this.database.prepare(`
        INSERT INTO sandbox_lease_journal (lease_id, revision, record_json)
        VALUES (?, ?, ?)
      `).run(record.leaseId, record.revision, serialize(record));
      return { status: "saved", record: structuredClone(record) };
    });
  }

  async save(
    input: SandboxLeaseJournalRecord,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalSaveResult> {
    this.assertOpen();
    const record = validateSandboxLeaseJournalRecord(input);
    validExpectedRevision(expectedRevision);
    return this.transaction(() => {
      const current = this.select(record.leaseId);
      if (!current || current.revision !== expectedRevision) {
        return {
          status: "conflict",
          record: current ? structuredClone(current) : null,
        };
      }
      validateSandboxLeaseJournalTransition(current, record);
      const changed = this.database.prepare(`
        UPDATE sandbox_lease_journal
        SET revision = ?, record_json = ?
        WHERE lease_id = ? AND revision = ?
      `).run(
        record.revision,
        serialize(record),
        record.leaseId,
        expectedRevision,
      );
      assertOneChange(changed, "save");
      return { status: "saved", record: structuredClone(record) };
    });
  }

  async remove(
    leaseId: string,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalRemoveResult> {
    this.assertOpen();
    validLeaseId(leaseId);
    validExpectedRevision(expectedRevision);
    return this.transaction(() => {
      const current = this.select(leaseId);
      if (!current || current.revision !== expectedRevision) {
        return {
          status: "conflict",
          record: current ? structuredClone(current) : null,
        };
      }
      if (current.state !== "disposing") {
        throw new Error("Sandbox journal hanya dapat menghapus record disposing.");
      }
      const changed = this.database.prepare(`
        DELETE FROM sandbox_lease_journal
        WHERE lease_id = ? AND revision = ?
      `).run(leaseId, expectedRevision);
      assertOneChange(changed, "remove");
      return { status: "removed" };
    });
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private select(leaseId: string): SandboxLeaseJournalRecord | null {
    const row = this.database.prepare(`
      SELECT lease_id, revision, record_json
      FROM sandbox_lease_journal
      WHERE lease_id = ?
    `).get(leaseId) as unknown as JournalRow | undefined;
    return row ? parseRow(row) : null;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure. A subsequent operation still goes
        // through SQLite's own transaction-state checks and fails closed.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite sandbox lease journal sudah ditutup.");
  }
}

function parseRow(row: JournalRow): SandboxLeaseJournalRecord {
  if (
    !row ||
    typeof row.lease_id !== "string" ||
    typeof row.revision !== "number" ||
    typeof row.record_json !== "string"
  ) {
    throw new Error("Row SQLite sandbox lease journal tidak sah.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json) as unknown;
  } catch {
    throw new Error("JSON SQLite sandbox lease journal rusak.");
  }
  const record = validateSandboxLeaseJournalRecord(
    parsed as SandboxLeaseJournalRecord,
  );
  if (record.leaseId !== row.lease_id || record.revision !== row.revision) {
    throw new Error("Index SQLite sandbox lease journal tidak cocok dengan payload.");
  }
  return record;
}

function serialize(record: SandboxLeaseJournalRecord): string {
  return JSON.stringify(record);
}

function validLeaseId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) {
    throw new Error("leaseId SQLite sandbox journal tidak sah.");
  }
}

function validExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected revision SQLite sandbox journal tidak sah.");
  }
}

function assertOneChange(
  result: StatementResultingChanges,
  operation: string,
): void {
  if (result.changes !== 1) {
    throw new Error(`SQLite sandbox journal ${operation} tidak atomik.`);
  }
}
