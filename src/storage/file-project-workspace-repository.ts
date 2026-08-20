import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  NewProjectWorkspace,
  ProjectWorkspace,
  ProjectWorkspaceRemoveResult,
  ProjectWorkspaceRepository,
  ProjectWorkspaceSaveResult,
} from "../domain/project-workspace.js";
import {
  createLocalGitCommitRequest,
  validateLocalGitObjectBundleReference,
} from "../domain/local-git.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();

interface ProjectWorkspaceDatabase {
  version: 1;
  projects: ProjectWorkspace[];
}

/** Local single-process adapter. It stores metadata only, never project bytes. */
export class FileProjectWorkspaceRepository
  implements ProjectWorkspaceRepository
{
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(projectId: string): Promise<ProjectWorkspace | null> {
    const cleanId = safeKey(projectId, "projectId");
    const database = await this.readDatabase();
    const project = database.projects.find((candidate) => candidate.id === cleanId);
    return project ? structuredClone(project) : null;
  }

  async listByOwner(ownerWorkspaceKey: string): Promise<ProjectWorkspace[]> {
    const cleanOwner = safeKey(ownerWorkspaceKey, "ownerWorkspaceKey");
    const database = await this.readDatabase();
    return structuredClone(
      database.projects
        .filter((project) => project.ownerWorkspaceKey === cleanOwner)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async create(
    workspace: NewProjectWorkspace,
  ): Promise<ProjectWorkspaceSaveResult> {
    const record: ProjectWorkspace = {
      ...structuredClone(workspace),
      revision: 1,
    };
    validateProject(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (database.projects.some((candidate) => candidate.id === record.id)) {
        return { status: "conflict" };
      }
      database.projects.push(record);
      await this.writeDatabase(database);
      return { status: "saved", workspace: structuredClone(record) };
    });
  }

  async save(
    workspace: Omit<ProjectWorkspace, "revision">,
    expectedRevision: number,
  ): Promise<ProjectWorkspaceSaveResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision project tidak sah.");
    }
    const record: ProjectWorkspace = {
      ...structuredClone(workspace),
      revision: expectedRevision + 1,
    };
    validateProject(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.projects.findIndex(
        (candidate) => candidate.id === record.id,
      );
      if (
        index < 0 ||
        database.projects[index]!.revision !== expectedRevision
      ) {
        return { status: "conflict" };
      }
      validateTransition(database.projects[index]!, record);
      database.projects[index] = record;
      await this.writeDatabase(database);
      return { status: "saved", workspace: structuredClone(record) };
    });
  }

  async remove(
    projectId: string,
    expectedRevision: number,
  ): Promise<ProjectWorkspaceRemoveResult> {
    const cleanId = safeKey(projectId, "projectId");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision project tidak sah.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.projects.findIndex(
        (candidate) => candidate.id === cleanId,
      );
      if (index < 0) return "missing";
      if (database.projects[index]!.revision !== expectedRevision) {
        return "conflict";
      }
      database.projects.splice(index, 1);
      await this.writeDatabase(database);
      return "removed";
    });
  }

  private async readDatabase(): Promise<ProjectWorkspaceDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<ProjectWorkspaceDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
        throw new Error("Format basis data ProjectWorkspace tidak dikenali.");
      }
      for (const project of parsed.projects) validateProject(project);
      return { version: 1, projects: structuredClone(parsed.projects) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, projects: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: ProjectWorkspaceDatabase): Promise<void> {
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) {
        FILE_QUEUES.delete(this.filePath);
      }
    }
  }
}

function validateProject(value: unknown): asserts value is ProjectWorkspace {
  if (!value || typeof value !== "object") {
    throw new Error("Record ProjectWorkspace tidak sah.");
  }
  const project = value as ProjectWorkspace;
  safeKey(project.id, "projectId");
  safeKey(project.ownerWorkspaceKey, "ownerWorkspaceKey");
  if (!Number.isSafeInteger(project.revision) || project.revision < 1) {
    throw new Error("Revision ProjectWorkspace tidak sah.");
  }
  sha256(project.baseSnapshot, "baseSnapshot");
  if (
    !project.storageUsage ||
    !Number.isSafeInteger(project.storageUsage.artifactBytes) ||
    project.storageUsage.artifactBytes < 0 ||
    !Number.isSafeInteger(project.storageUsage.snapshotBytes) ||
    project.storageUsage.snapshotBytes < 0
  ) {
    throw new Error("Accounting storage ProjectWorkspace tidak sah.");
  }
  validIso(project.createdAt, "createdAt");
  validIso(project.updatedAt, "updatedAt");
  if (project.source?.type === "upload") {
    safeKey(project.source.artifactId, "artifactId");
    sha256(project.source.sha256, "artifact sha256");
  } else if (project.source?.type === "github") {
    safeKey(project.source.repositoryId, "repositoryId");
    safeKey(project.source.installationId, "installationId");
    if (
      (project.source.installationConnectionId === undefined) !==
        (project.source.repositorySelectionId === undefined)
    ) {
      throw new Error("Source GitHub provisioning harus lengkap atau legacy.");
    }
    if (project.source.installationConnectionId !== undefined) {
      safeKey(
        project.source.installationConnectionId,
        "installationConnectionId",
      );
      safeKey(project.source.repositorySelectionId, "repositorySelectionId");
      if (
        project.source.provisioningStatus !== undefined &&
        project.source.provisioningStatus !== "pending" &&
        project.source.provisioningStatus !== "bound"
      ) {
        throw new Error("Status provisioning source GitHub tidak sah.");
      }
      if (project.source.provisioningStatus === "bound") {
        safeKey(project.source.repositoryBindingId, "repositoryBindingId");
      } else if (project.source.repositoryBindingId !== undefined) {
        throw new Error("Binding project GitHub hanya boleh ada setelah bound.");
      }
    } else if (
      project.source.provisioningStatus !== undefined ||
      project.source.repositoryBindingId !== undefined
    ) {
      throw new Error("Status provisioning tidak boleh ada pada source GitHub legacy.");
    }
  } else {
    throw new Error("Source ProjectWorkspace tidak sah.");
  }
  if (!Array.isArray(project.snapshotHistory) || project.snapshotHistory.length < 1) {
    throw new Error("Riwayat snapshot ProjectWorkspace kosong.");
  }
  let expected = 1;
  const effectIds = new Set<string>();
  for (const snapshot of project.snapshotHistory) {
    if (snapshot.revision !== expected) {
      throw new Error("Revision riwayat snapshot tidak berurutan.");
    }
    expected += 1;
    sha256(snapshot.snapshotId, "snapshotId");
    if (snapshot.parentSnapshotId !== null) {
      sha256(snapshot.parentSnapshotId, "parentSnapshotId");
    }
    if (
      snapshot.reason !== "import" &&
      snapshot.reason !== "provisioning" &&
      snapshot.reason !== "coding" &&
      snapshot.reason !== "replacement" &&
      snapshot.reason !== "rollback"
    ) {
      throw new Error("Alasan revision ProjectWorkspace tidak sah.");
    }
    if (snapshot.effectId !== undefined) {
      safeKey(snapshot.effectId, "snapshot effectId");
      if (snapshot.reason !== "coding" || effectIds.has(snapshot.effectId)) {
        throw new Error("Effect id revision ProjectWorkspace tidak sah atau duplikat.");
      }
      effectIds.add(snapshot.effectId);
    }
    if (snapshot.git) {
      gitCommit(snapshot.git.baseCommit, "snapshot.baseCommit");
      gitCommit(snapshot.git.headCommit, "snapshot.headCommit");
      validBranch(snapshot.git.branch);
    }
    validIso(snapshot.createdAt, "snapshot.createdAt");
  }
  const latest = project.snapshotHistory.at(-1)!;
  if (
    latest.revision !== project.revision ||
    latest.snapshotId !== project.baseSnapshot ||
    project.snapshotHistory.length !== project.revision
  ) {
    throw new Error("Base snapshot dan revision ProjectWorkspace tidak sinkron.");
  }
  if (project.git) {
    gitCommit(project.git.baseCommit, "baseCommit");
    gitCommit(project.git.headCommit, "headCommit");
    validBranch(project.git.branch);
  }
  if (project.pendingGitCommit !== undefined) {
    const pending = project.pendingGitCommit;
    if (
      !project.git ||
      pending.snapshotId !== project.baseSnapshot ||
      pending.sourceRevision !== project.revision ||
      pending.baseCommit !== project.git.baseCommit ||
      pending.parentCommit !== project.git.headCommit
    ) {
      throw new Error("Reservation local git ProjectWorkspace tidak sinkron.");
    }
    sha256(pending.snapshotId, "pendingGitCommit.snapshotId");
    if (!Number.isSafeInteger(pending.sourceRevision) || pending.sourceRevision < 2) {
      throw new Error("Revision reservation local git tidak sah.");
    }
    gitCommit(pending.baseCommit, "pendingGitCommit.baseCommit");
    gitCommit(pending.parentCommit, "pendingGitCommit.parentCommit");
    safeKey(pending.operationId, "pendingGitCommit.operationId");
    validBranch(pending.targetBranch);
    safeCommitMessage(pending.message);
    validIso(pending.preparedAt, "pendingGitCommit.preparedAt");
    const expectedRequest = createLocalGitCommitRequest({
      projectId: project.id,
      snapshotId: pending.snapshotId,
      workspaceRevision: pending.sourceRevision,
      baseCommit: pending.baseCommit,
      headCommit: pending.parentCommit,
      branch: project.git.branch,
    });
    if (
      pending.operationId !== expectedRequest.operationId ||
      pending.targetBranch !== expectedRequest.targetBranch ||
      pending.message !== expectedRequest.message
    ) throw new Error("Intent pending local git tidak deterministik.");
  }
  if (
    project.localGitCommitReceipts !== undefined &&
    !Array.isArray(project.localGitCommitReceipts)
  ) throw new Error("Ledger receipt local git tidak sah.");
  const receiptOperations = new Set<string>();
  for (const receipt of project.localGitCommitReceipts ?? []) {
    assertExactKeys(receipt, [
      "operationId",
      "snapshotId",
      "sourceRevision",
      "baseCommit",
      "branch",
      "parentCommit",
      "commit",
      "treeHash",
      "objectBundle",
      "authorName",
      "authorEmail",
      "committedAt",
    ], "localGitReceipt");
    safeKey(receipt.operationId, "localGitReceipt.operationId");
    sha256(receipt.snapshotId, "localGitReceipt.snapshotId");
    if (!Number.isSafeInteger(receipt.sourceRevision) || receipt.sourceRevision < 2) {
      throw new Error("Source revision receipt local git tidak sah.");
    }
    gitCommit(receipt.baseCommit, "localGitReceipt.baseCommit");
    validBranch(receipt.branch);
    gitCommit(receipt.parentCommit, "localGitReceipt.parentCommit");
    gitCommit(receipt.commit, "localGitReceipt.commit");
    gitCommit(receipt.treeHash, "localGitReceipt.treeHash");
    const bundle = validateLocalGitObjectBundleReference(receipt.objectBundle);
    if (
      receipt.commit === receipt.parentCommit ||
      bundle.commit !== receipt.commit ||
      bundle.parentCommit !== receipt.parentCommit ||
      bundle.treeHash !== receipt.treeHash ||
      receipt.authorName !== "Harvy Bot" ||
      receipt.authorEmail !== "bot@harvy.local" ||
      receiptOperations.has(receipt.operationId) ||
      project.snapshotHistory[receipt.sourceRevision - 1]?.snapshotId !== receipt.snapshotId
    ) throw new Error("Receipt local git tidak sah, duplikat, atau tidak terikat snapshot.");
    validIso(receipt.committedAt, "localGitReceipt.committedAt");
    receiptOperations.add(receipt.operationId);
  }
  if (
    project.pendingGitCommit &&
    receiptOperations.has(project.pendingGitCommit.operationId)
  ) throw new Error("Local git effect tidak boleh pending dan committed sekaligus.");
}

function validateTransition(
  current: ProjectWorkspace,
  next: ProjectWorkspace,
): void {
  validateProvisioningTransition(current, next);
  validateLocalGitTransition(current, next);
  if (
    current.id !== next.id ||
    current.ownerWorkspaceKey !== next.ownerWorkspaceKey ||
    current.createdAt !== next.createdAt ||
    next.snapshotHistory.length !== current.snapshotHistory.length + 1 ||
    JSON.stringify(current.snapshotHistory) !== JSON.stringify(
      next.snapshotHistory.slice(0, current.snapshotHistory.length),
    ) ||
    next.storageUsage.artifactBytes < current.storageUsage.artifactBytes ||
    next.storageUsage.snapshotBytes < current.storageUsage.snapshotBytes ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new Error("Field immutable/append-only ProjectWorkspace berubah.");
  }
}

function validateProvisioningTransition(
  current: ProjectWorkspace,
  next: ProjectWorkspace,
): void {
  const latest = next.snapshotHistory.at(-1);
  if (
    current.source.type !== "github" ||
    current.source.installationConnectionId === undefined ||
    current.source.repositorySelectionId === undefined
  ) {
    if (latest?.reason === "provisioning") {
      throw new Error("Revision provisioning hanya boleh mengaktifkan project pending.");
    }
    return;
  }
  const currentSource = current.source;
  const currentPending = currentSource.provisioningStatus === "pending" ||
    currentSource.provisioningStatus === undefined;
  if (!currentPending) {
    if (latest?.reason === "provisioning") {
      throw new Error("Revision provisioning hanya boleh mengaktifkan project pending.");
    }
    return;
  }
  if (
    next.source.type !== "github" ||
    next.source.repositoryId !== currentSource.repositoryId ||
    next.source.installationId !== currentSource.installationId ||
    next.source.installationConnectionId !==
      currentSource.installationConnectionId ||
    next.source.repositorySelectionId !== currentSource.repositorySelectionId ||
    next.source.provisioningStatus !== "bound" ||
    !next.source.repositoryBindingId ||
    latest?.reason !== "provisioning" ||
    latest.snapshotId !== current.baseSnapshot ||
    latest.parentSnapshotId !== current.baseSnapshot ||
    next.baseSnapshot !== current.baseSnapshot ||
    JSON.stringify(next.storageUsage) !== JSON.stringify(current.storageUsage) ||
    JSON.stringify(next.git) !== JSON.stringify(current.git) ||
    next.pendingGitCommit !== undefined ||
    JSON.stringify(next.localGitCommitReceipts ?? []) !==
      JSON.stringify(current.localGitCommitReceipts ?? [])
  ) {
    throw new Error(
      "Project GitHub pending hanya boleh berubah menjadi exact bound provisioning.",
    );
  }
}

function validateLocalGitTransition(
  current: ProjectWorkspace,
  next: ProjectWorkspace,
): void {
  const currentReceipts = current.localGitCommitReceipts ?? [];
  const nextReceipts = next.localGitCommitReceipts ?? [];
  if (
    nextReceipts.length < currentReceipts.length ||
    JSON.stringify(currentReceipts) !== JSON.stringify(
      nextReceipts.slice(0, currentReceipts.length),
    )
  ) throw new Error("Ledger receipt local git harus append-only.");
  const latest = next.snapshotHistory.at(-1)!;
  if (current.pendingGitCommit) {
    const pending = current.pendingGitCommit;
    const receipt = nextReceipts.at(-1);
    if (
      next.pendingGitCommit !== undefined ||
      nextReceipts.length !== currentReceipts.length + 1 ||
      !receipt ||
      receipt.operationId !== pending.operationId ||
      receipt.snapshotId !== pending.snapshotId ||
      receipt.sourceRevision !== pending.sourceRevision ||
      receipt.baseCommit !== pending.baseCommit ||
      receipt.branch !== pending.targetBranch ||
      receipt.parentCommit !== pending.parentCommit ||
      JSON.stringify(current.source) !== JSON.stringify(next.source) ||
      next.baseSnapshot !== current.baseSnapshot ||
      JSON.stringify(next.storageUsage) !== JSON.stringify(current.storageUsage) ||
      !next.git ||
      next.git.baseCommit !== receipt.baseCommit ||
      next.git.branch !== receipt.branch ||
      next.git.headCommit !== receipt.commit ||
      latest.reason !== "coding" ||
      latest.snapshotId !== current.baseSnapshot ||
      latest.parentSnapshotId !== current.baseSnapshot ||
      JSON.stringify(latest.git) !== JSON.stringify(next.git)
    ) throw new Error("Pending local git hanya boleh berubah menjadi exact committed receipt.");
    return;
  }
  if (next.pendingGitCommit) {
    if (
      JSON.stringify(current.source) !== JSON.stringify(next.source) ||
      nextReceipts.length !== currentReceipts.length ||
      next.pendingGitCommit.sourceRevision !== next.revision ||
      next.pendingGitCommit.snapshotId !== next.baseSnapshot ||
      next.baseSnapshot === current.baseSnapshot ||
      latest.reason !== "coding" ||
      latest.snapshotId !== next.baseSnapshot ||
      latest.parentSnapshotId !== current.baseSnapshot ||
      JSON.stringify(latest.git) !== JSON.stringify(next.git)
    ) throw new Error("Pending local git hanya boleh dibuat oleh revision coding baru.");
    return;
  }
  if (nextReceipts.length !== currentReceipts.length) {
    throw new Error("Receipt local git baru tidak mempunyai pending exact effect.");
  }
  if (
    current.source.type === "github" &&
    next.source.type === "github" &&
    latest.reason !== "rollback" &&
    JSON.stringify(current.git) !== JSON.stringify(next.git)
  ) throw new Error("Git state tidak boleh berubah tanpa exact local git receipt.");
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${field} ProjectWorkspace tidak sah.`);
  }
  return value;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) throw new Error(`Schema ${label} ProjectWorkspace memuat field asing atau hilang.`);
}

function safeCommitMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^Harvy coding update [a-f0-9]{12}$/u.test(value)
  ) throw new Error("Pesan pending local git bukan nilai code-owned.");
  return value;
}

function sha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} ProjectWorkspace tidak sah.`);
  }
}

function gitCommit(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) {
    throw new Error(`${field} git tidak sah.`);
  }
}

function validBranch(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((segment) => segment.endsWith(".lock")) ||
    /[~^:?*[\\\p{Cc}\s]/u.test(value)
  ) {
    throw new Error("Nama branch git tidak sah.");
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} ProjectWorkspace tidak sah.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
