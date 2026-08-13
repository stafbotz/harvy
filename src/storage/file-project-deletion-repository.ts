import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ProjectDeletionAuthority,
  ProjectDeletionRecord,
  ProjectDeletionRepository,
  ProjectDeletionSaveResult,
  ProjectDeletionStep,
} from "../domain/project-deletion.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const STEP_ORDER: readonly ProjectDeletionStep[] = [
  "runs_fenced",
  "evidence_removed",
  "runs_removed",
  "github_detached",
  "project_removed",
];

interface ProjectDeletionDatabase {
  version: 1;
  records: ProjectDeletionRecord[];
}

/** Local single-process durable deletion ledger. */
export class FileProjectDeletionRepository
  implements ProjectDeletionRepository, ProjectDeletionAuthority {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async loadByProject(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<ProjectDeletionRecord | null> {
    const owner = safeKey(ownerWorkspaceKey, "ownerWorkspaceKey");
    const project = safeKey(projectId, "projectId");
    const found = (await this.readDatabase()).records.find((candidate) =>
      candidate.ownerWorkspaceKey === owner && candidate.projectId === project
    );
    return found ? structuredClone(found) : null;
  }

  async load(deletionId: string): Promise<ProjectDeletionRecord | null> {
    const clean = safeKey(deletionId, "deletionId");
    const found = (await this.readDatabase()).records.find(
      (candidate) => candidate.deletionId === clean,
    );
    return found ? structuredClone(found) : null;
  }

  async listIncomplete(): Promise<ProjectDeletionRecord[]> {
    return structuredClone((await this.readDatabase()).records
      .filter((record) => record.status !== "completed")
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)));
  }

  async isDeletionPending(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<boolean> {
    return (await this.loadByProject(ownerWorkspaceKey, projectId)) !== null;
  }

  async cleanupBinding(
    ownerWorkspaceKey: string,
    projectId: string,
    deletionId: string,
  ): Promise<{
    expectedProjectRevision: number;
    projectCreatedAt: string;
    status: ProjectDeletionRecord["status"];
    completedSteps: ProjectDeletionStep[];
  } | null> {
    const record = await this.loadByProject(ownerWorkspaceKey, projectId);
    if (!record || record.deletionId !== safeKey(deletionId, "deletionId")) {
      return null;
    }
    return {
      expectedProjectRevision: record.expectedProjectRevision,
      projectCreatedAt: record.projectCreatedAt,
      status: record.status,
      completedSteps: structuredClone(record.completedSteps),
    };
  }

  async create(
    input: Omit<ProjectDeletionRecord, "revision">,
  ): Promise<ProjectDeletionSaveResult> {
    const record = { ...structuredClone(input), revision: 1 };
    validateRecord(record);
    if (
      record.status !== "requested" ||
      record.runIds.length !== 0 ||
      record.fencedRunCount !== 0 ||
      record.completedSteps.length !== 0 ||
      record.lastError !== null ||
      record.completedAt !== null
    ) throw new Error("State awal project deletion tidak canonical.");
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const existing = database.records.find((candidate) =>
        candidate.deletionId === record.deletionId ||
        (candidate.ownerWorkspaceKey === record.ownerWorkspaceKey &&
          candidate.projectId === record.projectId)
      );
      if (existing) return { status: "conflict" };
      database.records.push(record);
      await this.writeDatabase(database);
      return { status: "saved", record: structuredClone(record) };
    });
  }

  async save(
    input: Omit<ProjectDeletionRecord, "revision">,
    expectedRevision: number,
  ): Promise<ProjectDeletionSaveResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision deletion tidak sah.");
    }
    const record = {
      ...structuredClone(input),
      revision: expectedRevision + 1,
    };
    validateRecord(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.records.findIndex(
        (candidate) => candidate.deletionId === record.deletionId,
      );
      if (index < 0 || database.records[index]!.revision !== expectedRevision) {
        return { status: "conflict" };
      }
      validateTransition(database.records[index]!, record);
      database.records[index] = record;
      await this.writeDatabase(database);
      return { status: "saved", record: structuredClone(record) };
    });
  }

  private async readDatabase(): Promise<ProjectDeletionDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Database deletion project tidak sah.");
      }
      exactKeys(parsed, ["version", "records"], "database deletion");
      const database = parsed as ProjectDeletionDatabase;
      if (database.version !== 1 || !Array.isArray(database.records)) {
        throw new Error("Versi database deletion project tidak sah.");
      }
      for (const record of database.records) validateRecord(record);
      assertUnique(database.records);
      return structuredClone(database);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: ProjectDeletionDatabase): Promise<void> {
    assertUnique(database.records);
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

function validateRecord(value: ProjectDeletionRecord): void {
  exactKeys(value, [
    "version", "deletionId", "ownerWorkspaceKey", "projectId",
    "projectCreatedAt", "projectSource", "expectedProjectRevision", "status", "runIds", "fencedRunCount",
    "completedSteps", "lastError", "revision", "requestedAt", "updatedAt",
    "completedAt",
  ], "project deletion record");
  if (value.version !== 1) throw new Error("Versi project deletion tidak sah.");
  safeKey(value.deletionId, "deletionId");
  safeKey(value.ownerWorkspaceKey, "ownerWorkspaceKey");
  safeKey(value.projectId, "projectId");
  positive(value.expectedProjectRevision, "expectedProjectRevision");
  positive(value.revision, "revision");
  validIso(value.projectCreatedAt, "projectCreatedAt");
  if (value.projectSource !== "upload" && value.projectSource !== "github") {
    throw new Error("Source project deletion tidak sah.");
  }
  validIso(value.requestedAt, "requestedAt");
  validIso(value.updatedAt, "updatedAt");
  if (value.completedAt !== null) validIso(value.completedAt, "completedAt");
  if (!new Set(["requested", "cleanup_required", "completed"]).has(value.status)) {
    throw new Error("Status project deletion tidak sah.");
  }
  if (!Array.isArray(value.runIds) || value.runIds.length > 1_024) {
    throw new Error("Run IDs project deletion tidak sah.");
  }
  value.runIds.forEach((id) => safeKey(id, "runId"));
  if (new Set(value.runIds).size !== value.runIds.length) {
    throw new Error("Run IDs project deletion duplikat.");
  }
  if (
    !Number.isSafeInteger(value.fencedRunCount) ||
    value.fencedRunCount < 0 ||
    value.fencedRunCount < value.runIds.length
  ) throw new Error("Jumlah run project deletion tidak sah.");
  if (!Array.isArray(value.completedSteps) || value.completedSteps.length > STEP_ORDER.length) {
    throw new Error("Step project deletion tidak sah.");
  }
  value.completedSteps.forEach((step, index) => {
    if (step !== STEP_ORDER[index]) throw new Error("Step deletion tidak berurutan.");
  });
  if (value.lastError !== null) {
    exactKeys(value.lastError, ["step", "code", "at"], "deletion error");
    safeKey(value.lastError.step, "error step");
    safeKey(value.lastError.code, "error code");
    validIso(value.lastError.at, "error at");
  }
  if (
    (value.status === "completed") !== (value.completedAt !== null) ||
    (value.status === "cleanup_required") !== (value.lastError !== null) ||
    (value.status === "completed" &&
      value.completedSteps.at(-1) !== "project_removed")
  ) throw new Error("Completion project deletion tidak canonical.");
}

function validateTransition(
  current: ProjectDeletionRecord,
  next: ProjectDeletionRecord,
): void {
  const stepDelta = next.completedSteps.length - current.completedSteps.length;
  if (
    current.status === "completed" ||
    current.deletionId !== next.deletionId ||
    current.ownerWorkspaceKey !== next.ownerWorkspaceKey ||
    current.projectId !== next.projectId ||
    current.projectCreatedAt !== next.projectCreatedAt ||
    current.projectSource !== next.projectSource ||
    current.expectedProjectRevision !== next.expectedProjectRevision ||
    current.requestedAt !== next.requestedAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    stepDelta < 0 || stepDelta > 1 ||
    next.fencedRunCount < current.fencedRunCount ||
    (current.completedSteps.includes("runs_fenced") &&
      (next.fencedRunCount !== current.fencedRunCount ||
        JSON.stringify(current.runIds) !== JSON.stringify(next.runIds))) ||
    JSON.stringify(current.completedSteps) !== JSON.stringify(
      next.completedSteps.slice(0, current.completedSteps.length),
    ) ||
    JSON.stringify(current.runIds) !== JSON.stringify(
      next.runIds.slice(0, current.runIds.length),
    )
  ) throw new Error("Field immutable/append-only project deletion berubah.");
  if (
    stepDelta === 1 &&
    next.completedSteps.at(-1) === "runs_fenced" &&
    next.fencedRunCount !== next.runIds.length
  ) {
    throw new Error("Inventory run deletion belum exact saat fence disimpan.");
  }
}

function assertUnique(records: readonly ProjectDeletionRecord[]): void {
  const ids = new Set<string>();
  const projects = new Set<string>();
  for (const record of records) {
    const key = `${record.ownerWorkspaceKey}\0${record.projectId}`;
    if (ids.has(record.deletionId) || projects.has(key)) {
      throw new Error("Ledger project deletion duplikat.");
    }
    ids.add(record.deletionId);
    projects.add(key);
  }
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value || value.length > 512 ||
    /\p{Cc}/u.test(value) || containsSecretLikeValue(value)
  ) throw new Error(`${field} project deletion tidak sah.`);
  return value;
}

function positive(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} project deletion tidak sah.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} project deletion tidak sah.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
