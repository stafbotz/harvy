import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MODEL_ESCALATION_FAILURE_CODES,
  MODEL_ESCALATION_OUTCOME_CODES,
  type ModelEscalationRecord,
  type ModelEscalationRepository,
  type ModelEscalationReserveResult,
  type ModelEscalationSaveResult,
} from "../domain/model-escalation.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_RECORDS = 32_768;

interface EscalationDatabase {
  version: 1;
  records: ModelEscalationRecord[];
}

/** Durable one-shot gate. A reserved record is never replayed after a crash. */
export class FileModelEscalationRepository implements ModelEscalationRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async reserve(
    input: Omit<ModelEscalationRecord, "stateRevision">,
  ): Promise<ModelEscalationReserveResult> {
    const record: ModelEscalationRecord = {
      ...structuredClone(input),
      stateRevision: 1,
    };
    validateRecord(record);
    if (record.status !== "reserved") {
      throw new Error("Reservation eskalasi model harus berstatus reserved.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const existing = database.records.find((candidate) =>
        candidate.stageKey === record.stageKey
      );
      if (existing) {
        return sameReservation(existing, record)
          ? { status: "replay", record: structuredClone(existing) }
          : { status: "collision" };
      }
      if (database.records.length >= MAX_RECORDS) {
        throw new Error("Batas reservation eskalasi model tercapai.");
      }
      database.records.push(record);
      await this.writeDatabase(database);
      return { status: "reserved", record: structuredClone(record) };
    });
  }

  async load(stageKeyInput: string): Promise<ModelEscalationRecord | null> {
    const stageKey = safeOpaque(stageKeyInput, "stageKey");
    return this.exclusive(async () => {
      const record = (await this.readDatabase()).records.find(
        (candidate) => candidate.stageKey === stageKey,
      );
      return record ? structuredClone(record) : null;
    });
  }

  async listReserved(): Promise<ModelEscalationRecord[]> {
    return this.exclusive(async () =>
      (await this.readDatabase()).records
        .filter((record) => record.status === "reserved")
        .map((record) => structuredClone(record))
    );
  }

  async save(
    input: Omit<ModelEscalationRecord, "stateRevision">,
    expectedStateRevision: number,
  ): Promise<ModelEscalationSaveResult> {
    if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1) {
      throw new Error("Expected revision eskalasi model tidak sah.");
    }
    const record: ModelEscalationRecord = {
      ...structuredClone(input),
      stateRevision: expectedStateRevision + 1,
    };
    validateRecord(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.records.findIndex(
        (candidate) => candidate.stageKey === record.stageKey,
      );
      if (
        index < 0 ||
        database.records[index]!.stateRevision !== expectedStateRevision
      ) return { status: "conflict" };
      assertTransition(database.records[index]!, record);
      database.records[index] = record;
      await this.writeDatabase(database);
      return { status: "saved", record: structuredClone(record) };
    });
  }

  private async readDatabase(): Promise<EscalationDatabase> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      assertExactKeys(value, ["version", "records"], "database");
      const database = value as EscalationDatabase;
      if (
        database.version !== 1 || !Array.isArray(database.records) ||
        database.records.length > MAX_RECORDS
      ) throw new Error("Format basis data eskalasi model tidak dikenali.");
      const stages = new Set<string>();
      for (const record of database.records) {
        validateRecord(record);
        if (stages.has(record.stageKey)) {
          throw new Error("Stage eskalasi model duplikat.");
        }
        stages.add(record.stageKey);
      }
      return structuredClone(database);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: EscalationDatabase): Promise<void> {
    database.records.forEach(validateRecord);
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) FILE_QUEUES.delete(this.filePath);
    }
  }
}

function validateRecord(value: unknown): asserts value is ModelEscalationRecord {
  assertExactKeys(value, [
    "version", "stageKey", "reservationId", "requestDigest", "reason", "role",
    "sourcePrivacyDomain", "targetPrivacyDomain", "targetProviderId",
    "targetModelId", "promptMaterial", "status", "outcomeCode", "outputDigest",
    "stateRevision", "createdAt", "settledAt",
  ], "record");
  const record = value as ModelEscalationRecord;
  if (
    record.version !== 1 ||
    !MODEL_ESCALATION_FAILURE_CODES.has(record.reason) ||
    (record.role !== "critic" && record.role !== "recovery" &&
      record.role !== "synthesizer") ||
    record.promptMaterial !== "structured-brief+candidate" ||
    !["reserved", "completed", "failed", "unknown"].includes(record.status) ||
    (record.outcomeCode !== null &&
      !MODEL_ESCALATION_OUTCOME_CODES.has(record.outcomeCode)) ||
    !Number.isSafeInteger(record.stateRevision) || record.stateRevision < 1
  ) throw new Error("Record eskalasi model tidak sah.");
  safeOpaque(record.stageKey, "stageKey");
  safeOpaque(record.reservationId, "reservationId");
  safeOpaque(record.targetModelId, "targetModelId");
  privacyDomain(record.sourcePrivacyDomain, "sourcePrivacyDomain");
  privacyDomain(record.targetPrivacyDomain, "targetPrivacyDomain");
  privacyDomain(record.targetProviderId, "targetProviderId");
  digest(record.requestDigest, "requestDigest");
  validIso(record.createdAt, "createdAt");
  if (record.settledAt !== null) validIso(record.settledAt, "settledAt");
  if (record.outputDigest !== null) digest(record.outputDigest, "outputDigest");
  if (record.status === "reserved") {
    if (
      record.outcomeCode !== null || record.outputDigest !== null ||
      record.settledAt !== null
    ) throw new Error("Reservation eskalasi model memuat outcome prematur.");
  } else {
    if (record.outcomeCode === null || record.settledAt === null) {
      throw new Error("Outcome eskalasi model tidak lengkap.");
    }
    const completed = record.status === "completed" &&
      record.outcomeCode === "accepted" && record.outputDigest !== null;
    const failed = record.status === "failed" &&
      (record.outcomeCode === "candidate_rejected" ||
        record.outcomeCode === "provider_failure" ||
        record.outcomeCode === "execution_failure") &&
      record.outputDigest === null;
    const unknown = record.status === "unknown" &&
      record.outcomeCode === "outcome_unknown" && record.outputDigest === null;
    if (!completed && !failed && !unknown) {
      throw new Error("Outcome eskalasi model tidak konsisten.");
    }
  }
}

function assertTransition(
  current: ModelEscalationRecord,
  next: ModelEscalationRecord,
): void {
  if (current.status !== "reserved" || next.status === "reserved") {
    throw new Error("Record eskalasi model hanya dapat disettle sekali.");
  }
  const immutable = [
    "version", "stageKey", "reservationId", "requestDigest", "reason", "role",
    "sourcePrivacyDomain", "targetPrivacyDomain", "targetProviderId",
    "targetModelId", "promptMaterial", "createdAt",
  ] as const;
  if (immutable.some((field) => current[field] !== next[field])) {
    throw new Error("Field immutable eskalasi model berubah.");
  }
}

function sameReservation(
  current: ModelEscalationRecord,
  candidate: ModelEscalationRecord,
): boolean {
  return current.requestDigest === candidate.requestDigest &&
    current.reason === candidate.reason && current.role === candidate.role &&
    current.sourcePrivacyDomain === candidate.sourcePrivacyDomain &&
    current.targetPrivacyDomain === candidate.targetPrivacyDomain &&
    current.targetProviderId === candidate.targetProviderId &&
    current.targetModelId === candidate.targetModelId &&
    current.promptMaterial === candidate.promptMaterial;
}

function safeOpaque(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw new Error(`${field} eskalasi model tidak sah.`);
  return value;
}

function privacyDomain(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(value)
  ) throw new Error(`${field} eskalasi model tidak sah.`);
}

function digest(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} eskalasi model bukan SHA-256.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} eskalasi model bukan timestamp ISO.`);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) throw new Error(`Schema ${label} eskalasi model memuat field asing/hilang.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
