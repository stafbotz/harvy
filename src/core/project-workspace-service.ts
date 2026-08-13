import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspacePermission } from "../domain/workspace.js";
import type { ProjectSnapshotBundleSource } from "../domain/project-transfer.js";
import type {
  GitHubProjectProvisioningAuthority,
  ProjectSnapshotManifest,
  ProjectWorkspace,
  ProjectWorkspaceGitState,
  ProjectWorkspaceLocalGitCommitReceipt,
  ProjectWorkspacePendingGitCommit,
  ProjectWorkspaceRepository,
  ProjectWorkspaceRevision,
} from "../domain/project-workspace.js";
import {
  createLocalGitCommitRequest,
  validateLocalGitObjectBundleReference,
  type LocalGitBinding,
  type LocalGitCommitResult,
} from "../domain/local-git.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { projectMemoryNamespace } from "./memory-namespace.js";
import {
  canonicalProjectPath,
  copyProjectTree,
  scanProjectTree,
  type ProjectTreeLimits,
} from "./project-files.js";
import {
  extractSafeZip,
  type SafeZipLimits,
} from "./safe-zip.js";
import {
  createSandboxSnapshotSource as buildSandboxSnapshotSource,
} from "../sandbox/snapshot-bundle.js";
import type { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import type { ProjectDeletionAuthority } from "../domain/project-deletion.js";

export interface ProjectMemoryLifecycle {
  forgetAll(namespace: ReturnType<typeof projectMemoryNamespace>): Promise<void>;
}

export interface ProjectWorkingCopy {
  projectId: string;
  ownerWorkspaceKey: string;
  workingCopyId: string;
  workspaceRevision: number;
  baseSnapshot: string;
  /** Internal executor handle. Never place this host path in chat/model state. */
  internalPath: string;
}

export interface ProjectSnapshotHandle {
  projectId: string;
  ownerWorkspaceKey: string;
  workspaceRevision: number;
  snapshotId: string;
  /** Internal read-only handle; never serialize this path into run/chat state. */
  internalPath: string;
}

export interface ProjectWorkspaceStorageOptions {
  root: string;
  processRoot?: string;
  zipLimits?: Partial<SafeZipLimits>;
  treeLimits?: Partial<ProjectTreeLimits>;
  maxProjectsPerOwner?: number;
  maxRevisionsPerProject?: number;
  maxStoredBytesPerProject?: number;
  maxStoredBytesPerOwner?: number;
  maxStoredEntriesPerProject?: number;
  maxStoredEntriesPerOwner?: number;
  maxStagedSnapshotsPerProject?: number;
  maxWorkingCopiesPerProject?: number;
  maxWorkingCopiesPerOwner?: number;
}

interface ProjectStoragePolicy {
  maxProjectsPerOwner: number;
  maxRevisionsPerProject: number;
  maxStoredBytesPerProject: number;
  maxStoredBytesPerOwner: number;
  maxStoredEntriesPerProject: number;
  maxStoredEntriesPerOwner: number;
  maxStagedSnapshotsPerProject: number;
  maxWorkingCopiesPerProject: number;
  maxWorkingCopiesPerOwner: number;
}

const DEFAULT_PROJECT_STORAGE_POLICY: Readonly<ProjectStoragePolicy> = Object.freeze({
  maxProjectsPerOwner: 32,
  maxRevisionsPerProject: 256,
  maxStoredBytesPerProject: 2 * 1024 * 1024 * 1024,
  maxStoredBytesPerOwner: 8 * 1024 * 1024 * 1024,
  maxStoredEntriesPerProject: 500_000,
  maxStoredEntriesPerOwner: 2_000_000,
  maxStagedSnapshotsPerProject: 32,
  maxWorkingCopiesPerProject: 4,
  maxWorkingCopiesPerOwner: 32,
});

const MANAGED_ENTRY_BYTES = 4_096;
const MANAGED_STORAGE_KINDS = [
  "artifacts",
  "snapshots",
  "manifests",
  "working",
  "trash",
] as const;

interface ManagedStorageUsage {
  accountedBytes: number;
  entries: number;
}

interface QuarantinedManagedPaths {
  root: string;
  moves: Array<{ source: string; destination: string }>;
}

interface TrashMarker {
  version: 1;
  kind: "project-remove" | "snapshot-prune";
  ownerPart: string;
  projectId: string;
  projectCreatedAt: string | null;
  snapshotId: string | null;
}

const TRASH_MARKER = ".harvy-trash.json";
const PROJECT_WORKSPACE_QUEUES = new Map<string, Promise<void>>();
interface ProjectWorkspaceLease {
  active: boolean;
  children: Set<Promise<unknown>>;
}
const PROJECT_WORKSPACE_CONTEXT = new AsyncLocalStorage<
  ReadonlyMap<string, ProjectWorkspaceLease>
>();

export class ProjectWorkspaceService {
  private readonly storageRoot: string;
  private readonly processRoot: string;
  private readonly zipLimits: Partial<SafeZipLimits> | undefined;
  private readonly treeLimits: Partial<ProjectTreeLimits> | undefined;
  private readonly storagePolicy: Readonly<ProjectStoragePolicy>;
  private readonly queues = PROJECT_WORKSPACE_QUEUES;
  private isolationReady: Promise<void> | null = null;

  constructor(
    private readonly repository: ProjectWorkspaceRepository,
    private readonly authority: WorkspaceAuthorityService,
    storage: ProjectWorkspaceStorageOptions,
    private readonly memoryLifecycle?: ProjectMemoryLifecycle,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
    private readonly githubProvisioning?: GitHubProjectProvisioningAuthority,
    private readonly deletionAuthority?: ProjectDeletionAuthority,
  ) {
    this.processRoot = resolve(storage.processRoot ?? process.cwd());
    this.storageRoot = isolatedStorageRoot(storage.root, this.processRoot);
    this.zipLimits = storage.zipLimits;
    this.treeLimits = storage.treeLimits;
    this.storagePolicy = validateStoragePolicy({
      maxProjectsPerOwner: storage.maxProjectsPerOwner ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxProjectsPerOwner,
      maxRevisionsPerProject: storage.maxRevisionsPerProject ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxRevisionsPerProject,
      maxStoredBytesPerProject: storage.maxStoredBytesPerProject ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxStoredBytesPerProject,
      maxStoredBytesPerOwner: storage.maxStoredBytesPerOwner ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxStoredBytesPerOwner,
      maxStoredEntriesPerProject: storage.maxStoredEntriesPerProject ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxStoredEntriesPerProject,
      maxStoredEntriesPerOwner: storage.maxStoredEntriesPerOwner ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxStoredEntriesPerOwner,
      maxStagedSnapshotsPerProject: storage.maxStagedSnapshotsPerProject ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxStagedSnapshotsPerProject,
      maxWorkingCopiesPerProject: storage.maxWorkingCopiesPerProject ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxWorkingCopiesPerProject,
      maxWorkingCopiesPerOwner: storage.maxWorkingCopiesPerOwner ??
        DEFAULT_PROJECT_STORAGE_POLICY.maxWorkingCopiesPerOwner,
    });
  }

  async createFromUpload(
    scope: WorkspaceAgentScope,
    archive: Buffer,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["artifact.write", "code.write"]);
    const projectId = opaqueId("project", this.makeId());
    const artifactId = opaqueId("artifact", this.makeId());
    const createdAt = this.now().toISOString();
    return this.guardedExclusive(scope, ["artifact.write", "code.write"], projectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      let artifactPath: string | null = null;
      let attemptSnapshot: string | null = null;
      await this.assertNotDeleting(scope.workspaceKey, projectId);
      if (await this.repository.load(projectId)) {
        throw new Error("ProjectWorkspace id sudah ada.");
      }
      await this.assertOwnerQuota(scope.workspaceKey, projectId, 0, 0, true);
      try {
        const installed = await this.installArchiveSnapshot(
          scope.workspaceKey,
          projectId,
          archive,
        );
        attemptSnapshot = installed.manifest.snapshotId;
        await this.assertOwnerQuota(
          scope.workspaceKey,
          projectId,
          accountedFileBytes(archive.length) + MANAGED_ENTRY_BYTES,
          2,
          true,
        );
        artifactPath = await this.storeArtifact(
          scope.workspaceKey,
          projectId,
          artifactId,
          archive,
        );
        await this.assertOwnerQuota(
          scope.workspaceKey,
          projectId,
          0,
          0,
          true,
        );
        const revision: ProjectWorkspaceRevision = {
          revision: 1,
          snapshotId: installed.manifest.snapshotId,
          parentSnapshotId: null,
          reason: "import",
          createdAt,
        };
        const saved = await this.repository.create({
          id: projectId,
          ownerWorkspaceKey: scope.workspaceKey,
          source: {
            type: "upload",
            artifactId,
            sha256: installed.archiveSha256,
          },
          baseSnapshot: installed.manifest.snapshotId,
          snapshotHistory: [revision],
          storageUsage: {
            artifactBytes: archive.length,
            snapshotBytes: installed.manifest.totalBytes,
          },
          localGitCommitReceipts: [],
          createdAt,
          updatedAt: createdAt,
        });
        if (saved.status === "conflict") {
          throw new Error("ProjectWorkspace id sudah ada.");
        }
        return saved.workspace;
      } catch (error) {
        if (artifactPath) {
          await chmod(artifactPath, 0o600).catch(() => undefined);
          await rm(artifactPath, { force: true });
        }
        if (attemptSnapshot) {
          await this.removeUnreferencedSnapshot(
            scope.workspaceKey,
            projectId,
            attemptSnapshot,
          );
        }
        throw error;
      }
      })
    );
  }

  /** Archive is materialized by the GitHub trust domain; credentials stay there. */
  async createFromGitHubArchive(
    scope: WorkspaceAgentScope,
    input: {
      repositoryId: string;
      installationId: string;
      archive: Buffer;
      git: ProjectWorkspaceGitState;
    },
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["github.read", "code.write"]);
    const projectId = opaqueId("project", this.makeId());
    const createdAt = this.now().toISOString();
    return this.guardedExclusive(scope, ["github.read", "code.write"], projectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      let attemptSnapshot: string | null = null;
      await this.assertNotDeleting(scope.workspaceKey, projectId);
      if (await this.repository.load(projectId)) {
        throw new Error("ProjectWorkspace id sudah ada.");
      }
      await this.assertOwnerQuota(scope.workspaceKey, projectId, 0, 0, true);
      try {
        const installed = await this.installArchiveSnapshot(
          scope.workspaceKey,
          projectId,
          input.archive,
        );
        attemptSnapshot = installed.manifest.snapshotId;
        await this.assertOwnerQuota(
          scope.workspaceKey,
          projectId,
          0,
          0,
          true,
        );
        const git = validGitState(input.git);
        const revision: ProjectWorkspaceRevision = {
          revision: 1,
          snapshotId: installed.manifest.snapshotId,
          parentSnapshotId: null,
          reason: "import",
          git,
          createdAt,
        };
        const saved = await this.repository.create({
          id: projectId,
          ownerWorkspaceKey: scope.workspaceKey,
          source: {
            type: "github",
            repositoryId: safeExternalMetadata(
              input.repositoryId,
              "repositoryId",
            ),
            installationId: safeExternalMetadata(
              input.installationId,
              "installationId",
            ),
          },
          baseSnapshot: installed.manifest.snapshotId,
          snapshotHistory: [revision],
          storageUsage: {
            artifactBytes: 0,
            snapshotBytes: installed.manifest.totalBytes,
          },
          git,
          localGitCommitReceipts: [],
          createdAt,
          updatedAt: createdAt,
        });
        if (saved.status === "conflict") {
          throw new Error("ProjectWorkspace id sudah ada.");
        }
        return saved.workspace;
      } catch (error) {
        if (attemptSnapshot) {
          await this.removeUnreferencedSnapshot(
            scope.workspaceKey,
            projectId,
            attemptSnapshot,
          );
        }
        throw error;
      }
      })
    );
  }

  /**
   * Idempotent project materialization for a durable GitHub repository
   * selection. The project id is derived from the selection id, so a crash
   * after project creation can resume without creating a second project.
   */
  async createFromGitHubSelection(
    scope: WorkspaceAgentScope,
    input: {
      selectionId: string;
      installationConnectionId: string;
      repositoryId: string;
      installationId: string;
      archiveSha256: string;
      archive: Buffer;
      git: ProjectWorkspaceGitState;
    },
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["github.read", "code.write"]);
    const selectionId = safeExternalMetadata(input.selectionId, "selectionId");
    const installationConnectionId = safeExternalMetadata(
      input.installationConnectionId,
      "installationConnectionId",
    );
    const repositoryId = safeExternalMetadata(input.repositoryId, "repositoryId");
    const installationId = safeExternalMetadata(
      input.installationId,
      "installationId",
    );
    const archiveSha256 = sha256(input.archiveSha256, "archiveSha256");
    if (
      input.archive.byteLength < 1 ||
      createHash("sha256").update(input.archive).digest("hex") !== archiveSha256
    ) {
      throw new Error("Byte archive GitHub tidak cocok descriptor selection.");
    }
    const git = validGitState(input.git);
    if (this.storagePolicy.maxRevisionsPerProject < 2) {
      throw new Error(
        "Provisioning GitHub memerlukan satu slot revision untuk aktivasi binding.",
      );
    }
    const projectId = projectIdForGitHubSelection(selectionId);
    const createdAt = this.now().toISOString();
    return this.guardedExclusive(
      scope,
      ["github.read", "code.write"],
      projectId,
      async () => this.exclusive("__storage-quota__", async () => {
        if (await this.isDeletionPending(scope.workspaceKey, projectId)) {
          throw new Error("ProjectWorkspace sedang atau sudah dihapus.");
        }
        const existing = await this.repository.load(projectId);
        if (existing) {
          assertExactGitHubSelectionProject(existing, {
            ownerWorkspaceKey: scope.workspaceKey,
            selectionId,
            installationConnectionId,
            repositoryId,
            installationId,
            git,
          });
          return existing;
        }
        await this.assertOwnerQuota(scope.workspaceKey, projectId, 0, 0, true);
        let attemptSnapshot: string | null = null;
        try {
          const installed = await this.installArchiveSnapshot(
            scope.workspaceKey,
            projectId,
            input.archive,
          );
          attemptSnapshot = installed.manifest.snapshotId;
          await this.assertOwnerQuota(
            scope.workspaceKey,
            projectId,
            0,
            0,
            true,
          );
          const revision: ProjectWorkspaceRevision = {
            revision: 1,
            snapshotId: installed.manifest.snapshotId,
            parentSnapshotId: null,
            reason: "import",
            git,
            createdAt,
          };
          const saved = await this.repository.create({
            id: projectId,
            ownerWorkspaceKey: scope.workspaceKey,
            source: {
              type: "github",
              repositoryId,
              installationId,
              installationConnectionId,
              repositorySelectionId: selectionId,
              provisioningStatus: "pending",
            },
            baseSnapshot: installed.manifest.snapshotId,
            snapshotHistory: [revision],
            storageUsage: {
              artifactBytes: 0,
              snapshotBytes: installed.manifest.totalBytes,
            },
            git,
            localGitCommitReceipts: [],
            createdAt,
            updatedAt: createdAt,
          });
          if (saved.status === "conflict") {
            const winner = await this.repository.load(projectId);
            if (!winner) {
              throw new Error("ProjectWorkspace GitHub berkonflik tanpa winner.");
            }
            assertExactGitHubSelectionProject(winner, {
              ownerWorkspaceKey: scope.workspaceKey,
              selectionId,
              installationConnectionId,
              repositoryId,
              installationId,
              git,
            });
            return winner;
          }
          return saved.workspace;
        } catch (error) {
          if (attemptSnapshot) {
            await this.removeUnreferencedSnapshot(
              scope.workspaceKey,
              projectId,
              attemptSnapshot,
            );
          }
          throw error;
        }
      }),
    );
  }

  /**
   * Internal provisioning-saga lookup. Ordinary get/list intentionally hide
   * a deterministic GitHub project until the selection ledger is bound.
   */
  async getGitHubProvisioningProject(
    scope: WorkspaceAgentScope,
    selectionIdInput: string,
  ): Promise<ProjectWorkspace | null> {
    await this.requirePermissions(
      scope,
      ["workspace.manage", "github.read", "code.write"],
    );
    const selectionId = safeExternalMetadata(selectionIdInput, "selectionId");
    const projectId = projectIdForGitHubSelection(selectionId);
    return this.guardedExclusive(
      scope,
      ["workspace.manage", "github.read", "code.write"],
      projectId,
      async () => {
        await this.assertNotDeleting(scope.workspaceKey, projectId);
        const project = await this.repository.load(projectId);
        if (
          !project ||
          project.ownerWorkspaceKey !== scope.workspaceKey ||
          project.source.type !== "github" ||
          project.source.repositorySelectionId !== selectionId
        ) return null;
        return structuredClone(project);
      },
    );
  }

  /**
   * Final local leg of the GitHub provisioning saga. The binding is already
   * durable when this method is called. A crash before this transition leaves
   * the project pending and invisible; replay activates the same project.
   */
  async activateGitHubSelectionProject(
    scope: WorkspaceAgentScope,
    selectionIdInput: string,
    bindingIdInput: string,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(
      scope,
      ["workspace.manage", "github.read", "code.write"],
    );
    const selectionId = safeExternalMetadata(selectionIdInput, "selectionId");
    const bindingId = safeExternalMetadata(bindingIdInput, "bindingId");
    const projectId = projectIdForGitHubSelection(selectionId);
    return this.guardedExclusive(
      scope,
      ["workspace.manage", "github.read", "code.write"],
      projectId,
      async () => {
        await this.assertNotDeleting(scope.workspaceKey, projectId);
        const current = await this.repository.load(projectId);
        if (
          !current ||
          current.ownerWorkspaceKey !== scope.workspaceKey ||
          current.source.type !== "github" ||
          current.source.repositorySelectionId !== selectionId ||
          current.source.installationConnectionId === undefined
        ) {
          throw new Error("ProjectWorkspace provisioning GitHub tidak ditemukan.");
        }
        if (!this.githubProvisioning) {
          throw new Error("Authority binding provisioning GitHub belum dikonfigurasi.");
        }
        const bound = await this.githubProvisioning.isProjectSelectionBound({
          ownerWorkspaceKey: current.ownerWorkspaceKey,
          projectId: current.id,
          selectionId,
          bindingId,
          installationConnectionId: current.source.installationConnectionId,
          installationId: current.source.installationId,
          repositoryId: current.source.repositoryId,
        });
        if (!bound) {
          throw new Error("Binding GitHub belum durable atau tidak cocok project pending.");
        }
        if (current.source.provisioningStatus === "bound") {
          if (current.source.repositoryBindingId !== bindingId) {
            throw new Error("ProjectWorkspace GitHub sudah terikat ke binding lain.");
          }
          return structuredClone(current);
        }
        if (
          current.source.provisioningStatus !== "pending" &&
          current.source.provisioningStatus !== undefined
        ) {
          throw new Error("Status provisioning ProjectWorkspace GitHub tidak sah.");
        }
        assertNoPendingLocalGit(current, "mengaktifkan provisioning GitHub");
        this.assertRevisionCapacity(current);
        const updatedAt = this.now().toISOString();
        const revision = current.revision + 1;
        const saved = await this.repository.save(
          {
            ...withoutRevision(current),
            source: {
              ...current.source,
              provisioningStatus: "bound",
              repositoryBindingId: bindingId,
            },
            snapshotHistory: [
              ...current.snapshotHistory,
              {
                revision,
                snapshotId: current.baseSnapshot,
                parentSnapshotId: current.baseSnapshot,
                reason: "provisioning",
                ...(current.git ? { git: structuredClone(current.git) } : {}),
                createdAt: updatedAt,
              },
            ],
            updatedAt,
          },
          current.revision,
        );
        if (saved.status === "saved") return saved.workspace;
        const winner = await this.repository.load(projectId);
        if (
          winner?.source.type === "github" &&
          winner.source.repositorySelectionId === selectionId &&
          winner.source.provisioningStatus === "bound" &&
          winner.source.repositoryBindingId === bindingId
        ) return structuredClone(winner);
        throw new Error("ProjectWorkspace berubah saat provisioning diaktifkan.");
      },
    );
  }

  async get(
    scope: WorkspaceAgentScope,
    projectId: string,
  ): Promise<ProjectWorkspace | null> {
    await this.ensureStorageIsolation();
    if (!(await this.authority.authorize(scope, "code.read"))) return null;
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.authority.withPermission(scope, "code.read", () =>
      this.exclusive(cleanProjectId, async () => {
        const project = await this.repository.load(cleanProjectId);
        return project?.ownerWorkspaceKey === scope.workspaceKey &&
            isProjectAvailable(project) &&
            !await this.isDeletionPending(scope.workspaceKey, cleanProjectId)
          ? project
          : null;
      })
    );
  }

  async list(scope: WorkspaceAgentScope): Promise<ProjectWorkspace[]> {
    await this.ensureStorageIsolation();
    if (!(await this.authority.authorize(scope, "code.read"))) return [];
    return this.authority.withPermission(
      scope,
      "code.read",
      async () => {
        const available: ProjectWorkspace[] = [];
        for (const project of await this.repository.listByOwner(scope.workspaceKey)) {
          const visible = await this.exclusive(project.id, async () => {
            const current = await this.repository.load(project.id);
            return current &&
                current.ownerWorkspaceKey === scope.workspaceKey &&
                isProjectAvailable(current) &&
                !await this.isDeletionPending(scope.workspaceKey, current.id)
              ? structuredClone(current)
              : null;
          });
          if (visible) available.push(visible);
        }
        return available;
      },
    );
  }

  /**
   * Runs a bounded metadata operation while the project revision is locked.
   * Used by project-scoped consumers (for example memory) that must not commit
   * or reveal a result after a concurrent project replacement.
   */
  async withFreshProject<T>(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    permission: WorkspacePermission,
    operation: (project: ProjectWorkspace) => Promise<T>,
  ): Promise<T> {
    return this.withFreshProjectPermissions(
      scope,
      projectId,
      expectedRevision,
      [permission],
      operation,
    );
  }

  async withFreshProjectPermissions<T>(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    permissions: readonly WorkspacePermission[],
    operation: (project: ProjectWorkspace) => Promise<T>,
  ): Promise<T> {
    await this.ensureStorageIsolation();
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.authority.withPermissions(scope, permissions, () =>
      this.exclusive(cleanProjectId, async () => {
        const project = await this.requireCurrentProject(
          scope,
          cleanProjectId,
          expectedRevision,
        );
        return operation(structuredClone(project));
      })
    );
  }

  async withWorkspacePermission<T>(
    scope: WorkspaceAgentScope,
    permission: WorkspacePermission,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureStorageIsolation();
    return this.authority.withPermission(scope, permission, operation);
  }

  async withWorkspacePermissions<T>(
    scope: WorkspaceAgentScope,
    permissions: readonly WorkspacePermission[],
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.ensureStorageIsolation();
    return this.authority.withPermissions(scope, permissions, operation);
  }

  /** Exact cleanup-only access after a durable deletion tombstone exists. */
  async withDeletionProject<T>(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
    deletionIdInput: string,
    operation: (project: ProjectWorkspace) => Promise<T>,
  ): Promise<T> {
    await this.ensureStorageIsolation();
    const projectId = safeMetadata(projectIdInput, "projectId");
    const deletionId = safeMetadata(deletionIdInput, "deletionId");
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "code.write"],
      () =>
      this.exclusive(projectId, async () => {
        const binding = await this.requireDeletionBinding(
          scope.workspaceKey,
          projectId,
          deletionId,
        );
        const project = await this.repository.load(projectId);
        if (
          !project ||
          project.ownerWorkspaceKey !== scope.workspaceKey ||
          project.createdAt !== binding.projectCreatedAt ||
          project.revision !== binding.expectedProjectRevision
        ) {
          throw new Error("ProjectWorkspace deletion binding sudah basi.");
        }
        return operation(structuredClone(project));
      }),
    );
  }

  async replaceFromUpload(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    archive: Buffer,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["artifact.write", "code.write"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["artifact.write", "code.write"], cleanProjectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      const current = await this.requireCurrentProject(
        scope,
        cleanProjectId,
        expectedRevision,
      );
      assertNoPendingLocalGit(current, "mengganti source project");
      this.assertRevisionCapacity(current);
      const artifactId = opaqueId("artifact", this.makeId());
      let artifactPath: string | null = null;
      let attemptSnapshot: string | null = null;
      try {
        const installed = await this.installArchiveSnapshot(
          scope.workspaceKey,
          cleanProjectId,
          archive,
        );
        attemptSnapshot = installed.manifest.snapshotId;
        const updatedAt = this.now().toISOString();
        const nextRevision = expectedRevision + 1;
        const snapshotBytes = current.snapshotHistory.some(
          (entry) => entry.snapshotId === installed.manifest.snapshotId,
        ) ? 0 : installed.manifest.totalBytes;
        await this.assertOwnerQuota(
          scope.workspaceKey,
          cleanProjectId,
          accountedFileBytes(archive.length) + MANAGED_ENTRY_BYTES,
          2,
          false,
        );
        artifactPath = await this.storeArtifact(
          scope.workspaceKey,
          cleanProjectId,
          artifactId,
          archive,
        );
        await this.assertOwnerQuota(
          scope.workspaceKey,
          cleanProjectId,
          0,
          0,
          false,
        );
        const snapshotHistory = [
          ...current.snapshotHistory,
          {
            revision: nextRevision,
            snapshotId: installed.manifest.snapshotId,
            parentSnapshotId: current.baseSnapshot,
            reason: "replacement" as const,
            createdAt: updatedAt,
          },
        ];
        const saved = await this.repository.save(
          {
            ...omitPendingGitCommit(omitGit(withoutRevision(current))),
            source: {
              type: "upload",
              artifactId,
              sha256: installed.archiveSha256,
            },
            baseSnapshot: installed.manifest.snapshotId,
            snapshotHistory,
            storageUsage: {
              artifactBytes: current.storageUsage.artifactBytes + archive.length,
              snapshotBytes: current.storageUsage.snapshotBytes + snapshotBytes,
            },
            updatedAt,
          },
          expectedRevision,
        );
        if (saved.status === "conflict") {
          throw new Error("ProjectWorkspace berubah selama penggantian archive.");
        }
        return saved.workspace;
      } catch (error) {
        if (artifactPath) {
          await chmod(artifactPath, 0o600).catch(() => undefined);
          await rm(artifactPath, { force: true });
        }
        if (attemptSnapshot) {
          await this.removeUnreferencedSnapshot(
            scope.workspaceKey,
            cleanProjectId,
            attemptSnapshot,
          );
        }
        throw error;
      }
      })
    );
  }

  async createWorkingCopy(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<ProjectWorkingCopy> {
    await this.requirePermissions(scope, ["code.read", "code.write"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["code.read", "code.write"], cleanProjectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      const project = await this.requireCurrentProject(
        scope,
        cleanProjectId,
        expectedRevision,
      );
      await this.assertWorkingCopyQuota(project);
      const workingCopyId = opaqueId("work", this.makeId());
      const internalPath = this.workingPath(
        scope.workspaceKey,
        cleanProjectId,
        workingCopyId,
      );
      await assertNoManagedSymlink(this.storageRoot, internalPath);
      const source = await this.verifySnapshot(project, project.baseSnapshot);
      const sourceUsage = await scanManagedUsage(source);
      const workingProjectRoot = resolve(internalPath, "..");
      const hadWorkingProjectRoot = await exists(workingProjectRoot);
      await this.assertOwnerQuota(
        scope.workspaceKey,
        cleanProjectId,
        sourceUsage.accountedBytes + (hadWorkingProjectRoot ? 0 : MANAGED_ENTRY_BYTES),
        sourceUsage.entries + (hadWorkingProjectRoot ? 0 : 1),
        false,
      );
      try {
        await mkdir(workingProjectRoot, { recursive: true });
        const copied = await copyProjectTree(
          source,
          internalPath,
          this.treeLimits,
        );
        if (copied.snapshotId !== project.baseSnapshot) {
          throw new Error("Snapshot project berubah selama materialisasi working copy.");
        }
        await this.assertOwnerQuota(
          scope.workspaceKey,
          cleanProjectId,
          0,
          0,
          false,
        );
      } catch (error) {
        await rm(internalPath, { recursive: true, force: true });
        if (!hadWorkingProjectRoot) {
          await rm(workingProjectRoot, { recursive: true, force: true });
        }
        throw error;
      }
      return {
        projectId: cleanProjectId,
        ownerWorkspaceKey: scope.workspaceKey,
        workingCopyId,
        workspaceRevision: expectedRevision,
        baseSnapshot: project.baseSnapshot,
        internalPath,
      };
      })
    );
  }

  async getSnapshotHandle(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<ProjectSnapshotHandle> {
    await this.requirePermissions(scope, ["code.read"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.withFreshProjectPermissions(
      scope,
      cleanProjectId,
      expectedRevision,
      ["code.read"],
      async (project) => {
        const internalPath = await this.verifySnapshot(project, project.baseSnapshot);
        return {
          projectId: cleanProjectId,
          ownerWorkspaceKey: scope.workspaceKey,
          workspaceRevision: project.revision,
          snapshotId: project.baseSnapshot,
          internalPath,
        };
      },
    );
  }

  async withSandboxSnapshotSource<T>(
    scope: WorkspaceAgentScope,
    snapshot: ProjectSnapshotHandle,
    operation: (source: ProjectSnapshotBundleSource) => Promise<T>,
  ): Promise<T> {
    return this.withSnapshotSource(
      scope,
      snapshot,
      ["code.read", "sandbox.execute"],
      "sandbox",
      operation,
    );
  }

  async withLocalGitSnapshotSource<T>(
    scope: WorkspaceAgentScope,
    snapshot: ProjectSnapshotHandle,
    operation: (source: ProjectSnapshotBundleSource) => Promise<T>,
  ): Promise<T> {
    return this.withSnapshotSource(
      scope,
      snapshot,
      ["code.read", "git.commit"],
      "local git",
      operation,
    );
  }

  private async withSnapshotSource<T>(
    scope: WorkspaceAgentScope,
    snapshot: ProjectSnapshotHandle,
    permissions: readonly WorkspacePermission[],
    consumer: "sandbox" | "local git",
    operation: (source: ProjectSnapshotBundleSource) => Promise<T>,
  ): Promise<T> {
    if (snapshot.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error(`Snapshot ${consumer} berada di workspace lain.`);
    }
    return this.withFreshProjectPermissions(
      scope,
      snapshot.projectId,
      snapshot.workspaceRevision,
      permissions,
      async (project) => {
        const expectedPath = this.rawSnapshotPath(
          project.ownerWorkspaceKey,
          project.id,
          snapshot.snapshotId,
        );
        if (resolve(snapshot.internalPath) !== expectedPath) {
          throw new Error(`Handle snapshot ${consumer} tidak sah.`);
        }
        const verifiedPath = await this.verifySnapshot(project, snapshot.snapshotId);
        const manifest = JSON.parse(
          await readFile(
            this.rawManifestPath(
              project.ownerWorkspaceKey,
              project.id,
              snapshot.snapshotId,
            ),
            "utf8",
          ),
        ) as ProjectSnapshotManifest;
        validateManifest(manifest, snapshot.snapshotId);
        const source = await buildSandboxSnapshotSource(verifiedPath, manifest);
        const lease = { active: true };
        try {
          return await operation(guardedSnapshotSource(source, lease, consumer));
        } finally {
          lease.active = false;
        }
      },
    );
  }

  async commitWorkingCopy(
    scope: WorkspaceAgentScope,
    working: ProjectWorkingCopy,
    options: {
      git?: ProjectWorkspaceGitState;
      effectId?: string;
      expectedSnapshotId?: string;
    } = {},
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["code.write"]);
    this.validateWorkingHandle(scope, working);
    return this.guardedExclusive(scope, ["code.write"], working.projectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      const effectId = options.effectId === undefined
        ? null
        : safeMetadata(options.effectId, "commit effectId");
      const expectedSnapshotId = options.expectedSnapshotId === undefined
        ? null
        : sha256(options.expectedSnapshotId, "expectedSnapshotId");
      if ((effectId === null) !== (expectedSnapshotId === null)) {
        throw new Error("Commit effectId dan expectedSnapshotId wajib berpasangan.");
      }
      await this.assertNotDeleting(scope.workspaceKey, working.projectId);
      const loaded = await this.repository.load(working.projectId);
      if (!loaded || loaded.ownerWorkspaceKey !== scope.workspaceKey) {
        throw new Error("ProjectWorkspace tidak ditemukan pada scope ini.");
      }
      if (effectId && expectedSnapshotId) {
        const observed = loaded.snapshotHistory.find(
          (entry) => entry.effectId === effectId,
        );
        if (observed) {
          assertCommittedWorkspaceEffect(observed, working, expectedSnapshotId);
          await rm(working.internalPath, { recursive: true, force: true });
          return loaded;
        }
      }
      if (loaded.revision !== working.workspaceRevision) {
        throw new Error("ProjectWorkspace revision sudah basi.");
      }
      const current = loaded;
      assertNoPendingLocalGit(current, "meng-commit working copy baru");
      if (current.baseSnapshot !== working.baseSnapshot) {
        throw new Error("Base snapshot working copy sudah basi.");
      }
      this.assertRevisionCapacity(
        current,
        current.source.type === "github" ? 2 : 1,
      );
      const installed = await this.installWorkingSnapshot(current, working);
      if (expectedSnapshotId && installed.snapshotId !== expectedSnapshotId) {
        throw new Error("Snapshot commit tidak cocok dengan effect CodingRun prepared.");
      }
      if (installed.snapshotId === current.baseSnapshot) {
        throw new Error("Working copy tidak mempunyai perubahan.");
      }
      const updatedAt = this.now().toISOString();
      const git = options.git ? validGitState(options.git) : current.git;
      if (
        current.source.type === "github" &&
        (!current.git || JSON.stringify(git) !== JSON.stringify(current.git))
      ) {
        throw new Error("Coding snapshot tidak boleh mengubah git binding tanpa broker refresh.");
      }
      const historyEntry: ProjectWorkspaceRevision = {
        revision: current.revision + 1,
        snapshotId: installed.snapshotId,
        parentSnapshotId: current.baseSnapshot,
        reason: "coding",
        ...(effectId ? { effectId } : {}),
        ...(git ? { git } : {}),
        createdAt: updatedAt,
      };
      const snapshotBytes = current.snapshotHistory.some(
        (entry) => entry.snapshotId === installed.snapshotId,
      ) ? 0 : installed.totalBytes;
      await this.assertOwnerQuota(
        scope.workspaceKey,
        current.id,
        0,
        0,
        false,
      );
      const pendingGitCommit = current.source.type === "github"
        ? localGitPendingIntent(
            current.id,
            installed.snapshotId,
            current.revision + 1,
            git!,
            updatedAt,
          )
        : null;
      const next = {
          ...withoutRevision(current),
          baseSnapshot: installed.snapshotId,
          snapshotHistory: [...current.snapshotHistory, historyEntry],
          storageUsage: {
            ...current.storageUsage,
            snapshotBytes: current.storageUsage.snapshotBytes + snapshotBytes,
          },
          ...(git ? { git } : {}),
          ...(pendingGitCommit ? { pendingGitCommit } : {}),
          updatedAt,
        };
      const saved = await this.repository.save(
        pendingGitCommit ? next : omitPendingGitCommit(next),
        current.revision,
      );
      if (saved.status === "conflict") {
        if (effectId && expectedSnapshotId) {
          const reconciled = await this.repository.load(current.id);
          const observed = reconciled?.snapshotHistory.find(
            (entry) => entry.effectId === effectId,
          );
          if (reconciled && observed) {
            assertCommittedWorkspaceEffect(observed, working, expectedSnapshotId);
            await rm(working.internalPath, { recursive: true, force: true });
            return reconciled;
          }
        }
        throw new Error("ProjectWorkspace berubah sebelum snapshot di-commit.");
      }
      await rm(working.internalPath, { recursive: true, force: true });
      return saved.workspace;
      })
    );
  }

  async stageWorkingSnapshot(
    scope: WorkspaceAgentScope,
    working: ProjectWorkingCopy,
  ): Promise<ProjectSnapshotHandle> {
    await this.requirePermissions(scope, ["code.read", "sandbox.execute"]);
    this.validateWorkingHandle(scope, working);
    return this.guardedExclusive(
      scope,
      ["code.read", "sandbox.execute"],
      working.projectId,
      async () => this.exclusive("__storage-quota__", async () => {
        const current = await this.requireCurrentProject(
          scope,
          working.projectId,
          working.workspaceRevision,
        );
        if (current.baseSnapshot !== working.baseSnapshot) {
          throw new Error("Base snapshot working copy sudah basi.");
        }
        const manifest = await this.installWorkingSnapshot(current, working);
        return {
          projectId: current.id,
          ownerWorkspaceKey: current.ownerWorkspaceKey,
          workspaceRevision: current.revision,
          snapshotId: manifest.snapshotId,
          internalPath: this.rawSnapshotPath(
            current.ownerWorkspaceKey,
            current.id,
            manifest.snapshotId,
          ),
        };
      }),
    );
  }

  async rehydrateWorkingCopy(
    scope: WorkspaceAgentScope,
    input: Omit<ProjectWorkingCopy, "internalPath">,
  ): Promise<ProjectWorkingCopy> {
    await this.requirePermissions(scope, ["code.read"]);
    return this.withFreshProjectPermissions(
      scope,
      input.projectId,
      input.workspaceRevision,
      ["code.read"],
      async (current) => {
        if (
          current.ownerWorkspaceKey !== input.ownerWorkspaceKey ||
          current.baseSnapshot !== input.baseSnapshot
        ) {
          throw new Error("Binding working copy tidak cocok dengan ProjectWorkspace.");
        }
        const internalPath = this.workingPath(
          input.ownerWorkspaceKey,
          input.projectId,
          input.workingCopyId,
        );
        const state = await lstat(internalPath);
        if (!state.isDirectory() || state.isSymbolicLink()) {
          throw new Error("Working copy durable tidak tersedia.");
        }
        return { ...input, internalPath };
      },
    );
  }

  async assertWorkingCopyStorage(
    scope: WorkspaceAgentScope,
    working: ProjectWorkingCopy,
  ): Promise<void> {
    await this.requirePermissions(scope, ["code.read", "code.write"]);
    this.validateWorkingHandle(scope, working);
    await this.guardedExclusive(scope, ["code.read", "code.write"], working.projectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      const current = await this.requireCurrentProject(
        scope,
        working.projectId,
        working.workspaceRevision,
      );
      if (current.baseSnapshot !== working.baseSnapshot) {
        throw new Error("Base snapshot working copy sudah basi.");
      }
      await this.assertOwnerQuota(
        scope.workspaceKey,
        working.projectId,
        0,
        0,
        false,
      );
      })
    );
  }

  async rollback(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    targetRevision: number,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["code.write"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["code.write"], cleanProjectId, async () => {
      const current = await this.requireCurrentProject(
        scope,
        cleanProjectId,
        expectedRevision,
      );
      assertNoPendingLocalGit(current, "rollback project");
      this.assertRevisionCapacity(current);
      const target = current.snapshotHistory.find(
        (entry) => entry.revision === targetRevision,
      );
      if (!target) throw new Error("Revision rollback project tidak ditemukan.");
      if (target.snapshotId === current.baseSnapshot) {
        throw new Error("Project sudah berada pada snapshot tersebut.");
      }
      await this.verifySnapshot(current, target.snapshotId);
      const updatedAt = this.now().toISOString();
      const restoredGit = target.git;
      const entry: ProjectWorkspaceRevision = {
        revision: current.revision + 1,
        snapshotId: target.snapshotId,
        parentSnapshotId: current.baseSnapshot,
        reason: "rollback",
        ...(restoredGit ? { git: restoredGit } : {}),
        createdAt: updatedAt,
      };
      const base = {
        ...omitPendingGitCommit(withoutRevision(current)),
        baseSnapshot: target.snapshotId,
        snapshotHistory: [...current.snapshotHistory, entry],
        updatedAt,
      };
      const next = restoredGit
        ? { ...base, git: restoredGit }
        : omitGit(base);
      const saved = await this.repository.save(next, current.revision);
      if (saved.status === "conflict") {
        throw new Error("ProjectWorkspace berubah selama rollback.");
      }
      return saved.workspace;
    });
  }

  async updateGitState(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    gitInput: ProjectWorkspaceGitState,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["git.commit"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["git.commit"], cleanProjectId, async () => {
      const current = await this.requireCurrentProject(
        scope,
        cleanProjectId,
        expectedRevision,
      );
      this.assertRevisionCapacity(current);
      if (current.source.type !== "github") {
        throw new Error("Git state hanya berlaku untuk source GitHub.");
      }
      const git = validGitState(gitInput);
      const pending = current.pendingGitCommit;
      if (pending) {
        throw new Error("Local git effect belum direkonsiliasi; git state tidak boleh diubah.");
      }
      if (!current.git || JSON.stringify(git) !== JSON.stringify(current.git)) {
        throw new Error("Git state baru tidak mempunyai reservation revision durable.");
      }
      const updatedAt = this.now().toISOString();
      const entry: ProjectWorkspaceRevision = {
        revision: current.revision + 1,
        snapshotId: current.baseSnapshot,
        parentSnapshotId: current.baseSnapshot,
        reason: "coding",
        git,
        createdAt: updatedAt,
      };
      const saved = await this.repository.save(
        {
          ...omitPendingGitCommit(withoutRevision(current)),
          git,
          snapshotHistory: [...current.snapshotHistory, entry],
          updatedAt,
        },
        current.revision,
      );
      if (saved.status === "conflict") {
        throw new Error("ProjectWorkspace berubah sebelum git state disimpan.");
      }
      return saved.workspace;
    });
  }

  async recordLocalGitCommit(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    result: LocalGitCommitResult,
  ): Promise<ProjectWorkspace> {
    await this.requirePermissions(scope, ["git.commit"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["git.commit"], cleanProjectId, async () => {
      const current = await this.requireCurrentProject(
        scope,
        cleanProjectId,
        expectedRevision,
      );
      this.assertRevisionCapacity(current);
      if (current.source.type !== "github" || !current.git || !current.pendingGitCommit) {
        throw new Error("Project tidak mempunyai pending local git effect.");
      }
      const pending = current.pendingGitCommit;
      const receipt = exactLocalGitReceipt(current, pending, result);
      const existing = (current.localGitCommitReceipts ?? []).find(
        (candidate) => candidate.operationId === receipt.operationId,
      );
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
          throw new Error("Operation local git dipakai ulang untuk receipt berbeda.");
        }
        return current;
      }
      const git: ProjectWorkspaceGitState = {
        baseCommit: pending.baseCommit,
        headCommit: receipt.commit,
        branch: pending.targetBranch,
      };
      const updatedAt = this.now().toISOString();
      const entry: ProjectWorkspaceRevision = {
        revision: current.revision + 1,
        snapshotId: current.baseSnapshot,
        parentSnapshotId: current.baseSnapshot,
        reason: "coding",
        git,
        createdAt: updatedAt,
      };
      const saved = await this.repository.save(
        {
          ...omitPendingGitCommit(withoutRevision(current)),
          git,
          localGitCommitReceipts: [
            ...(current.localGitCommitReceipts ?? []),
            receipt,
          ],
          snapshotHistory: [...current.snapshotHistory, entry],
          updatedAt,
        },
        current.revision,
      );
      if (saved.status === "conflict") {
        const reconciled = await this.repository.load(cleanProjectId);
        const observed = reconciled?.localGitCommitReceipts?.find(
          (candidate) => candidate.operationId === receipt.operationId,
        );
        if (reconciled && observed && JSON.stringify(observed) === JSON.stringify(receipt)) {
          return reconciled;
        }
        throw new Error("ProjectWorkspace berubah sebelum receipt local git disimpan.");
      }
      return saved.workspace;
    });
  }

  async disposeWorkingCopy(
    scope: WorkspaceAgentScope,
    working: ProjectWorkingCopy,
  ): Promise<void> {
    await this.ensureStorageIsolation();
    this.validateWorkingHandle(scope, working);
    const cleanProjectId = safeMetadata(working.projectId, "projectId");
    await this.guardedExclusive(scope, ["code.write"], cleanProjectId, async () => {
      await this.assertNotDeleting(scope.workspaceKey, cleanProjectId);
      const project = await this.repository.load(cleanProjectId);
      if (!project || project.ownerWorkspaceKey !== scope.workspaceKey) {
        throw new Error("ProjectWorkspace working copy tidak ditemukan pada scope ini.");
      }
      await this.disposeWorkingCopyUnsafe(working);
    });
  }

  private async disposeWorkingCopyUnsafe(working: ProjectWorkingCopy): Promise<void> {
    const expected = this.workingPath(
      working.ownerWorkspaceKey,
      working.projectId,
      working.workingCopyId,
    );
    if (resolve(working.internalPath) !== expected) {
      throw new Error("Handle working copy tidak sah.");
    }
    await assertNoManagedSymlink(this.storageRoot, expected);
    await rm(expected, { recursive: true, force: true });
  }

  async disposeWorkingCopyReference(
    scope: WorkspaceAgentScope,
    input: Omit<ProjectWorkingCopy, "internalPath">,
  ): Promise<void> {
    await this.requirePermissions(scope, ["code.write"]);
    if (input.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("Working copy berada di workspace lain.");
    }
    const cleanProjectId = safeMetadata(input.projectId, "projectId");
    await this.guardedExclusive(scope, ["code.write"], cleanProjectId, async () => {
      await this.assertNotDeleting(scope.workspaceKey, cleanProjectId);
      const project = await this.repository.load(cleanProjectId);
      if (!project || project.ownerWorkspaceKey !== scope.workspaceKey) {
        throw new Error("ProjectWorkspace working copy tidak ditemukan pada scope ini.");
      }
      const bindingExists = project.snapshotHistory.some(
        (entry) =>
          entry.revision === input.workspaceRevision &&
          entry.snapshotId === input.baseSnapshot,
      );
      if (!bindingExists) {
        throw new Error("Binding working copy tidak pernah dimiliki ProjectWorkspace ini.");
      }
      await this.disposeWorkingCopyUnsafe({
        ...input,
        projectId: cleanProjectId,
        internalPath: this.workingPath(
          input.ownerWorkspaceKey,
          cleanProjectId,
          input.workingCopyId,
        ),
      });
    });
  }

  async disposeWorkingCopyReferenceForDeletion(
    scope: WorkspaceAgentScope,
    input: Omit<ProjectWorkingCopy, "internalPath">,
    deletionId: string,
  ): Promise<void> {
    if (input.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("Working copy deletion berada di workspace lain.");
    }
    await this.withDeletionProject(
      scope,
      input.projectId,
      deletionId,
      async (project) => {
        const bindingExists = project.snapshotHistory.some(
          (entry) =>
            entry.revision === input.workspaceRevision &&
            entry.snapshotId === input.baseSnapshot,
        );
        if (!bindingExists) {
          throw new Error("Binding working copy deletion tidak dimiliki project.");
        }
        await this.disposeWorkingCopyUnsafe({
          ...input,
          internalPath: this.workingPath(
            input.ownerWorkspaceKey,
            input.projectId,
            input.workingCopyId,
          ),
        });
      },
    );
  }

  async pruneUnreferencedSnapshots(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<number> {
    await this.requirePermissions(scope, ["code.write"]);
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["code.write"], cleanProjectId, async () =>
      this.exclusive("__storage-quota__", async () => {
        const project = await this.requireCurrentProject(
          scope,
          cleanProjectId,
          expectedRevision,
        );
        const retained = new Set(
          project.snapshotHistory.map((entry) => entry.snapshotId),
        );
        const root = resolve(
          this.storageRoot,
          "snapshots",
          ownerDirectory(project.ownerWorkspaceKey),
          project.id,
        );
        await assertNoManagedSymlink(this.storageRoot, root);
        let entries: Dirent[];
        try {
          entries = await readdir(root, { withFileTypes: true });
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return 0;
          throw error;
        }
        let removed = 0;
        for (const entry of entries) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new Error("Storage snapshot project memuat entry tidak sah.");
          }
          const snapshotId = sha256(entry.name, "snapshotId");
          if (retained.has(snapshotId)) continue;
          await this.removeUnreferencedSnapshot(
            project.ownerWorkspaceKey,
            project.id,
            snapshotId,
          );
          removed += 1;
        }
        return removed;
      })
    );
  }

  async remove(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<"removed" | "missing"> {
    await this.requirePermissions(scope, ["workspace.manage"]);
    if (this.deletionAuthority) {
      throw new Error("Penghapusan ProjectWorkspace wajib melalui deletion coordinator.");
    }
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.guardedExclusive(scope, ["workspace.manage"], cleanProjectId, async () =>
      this.exclusive("__storage-quota__", async () => {
      const project = await this.repository.load(cleanProjectId);
      if (!project || project.ownerWorkspaceKey !== scope.workspaceKey) {
        return "missing";
      }
      if (project.revision !== expectedRevision) {
        throw new Error("ProjectWorkspace berubah sebelum dihapus.");
      }
      assertNoPendingLocalGit(project, "menghapus project");
      if (!this.memoryLifecycle) {
        throw new Error("Lifecycle memory project belum dikonfigurasi; penghapusan gagal tertutup.");
      }
      return this.removeProjectLocked(scope.workspaceKey, project);
      })
    );
  }

  async removeForDeletion(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
    expectedRevision: number,
    deletionIdInput: string,
  ): Promise<"removed" | "missing"> {
    await this.requirePermissions(scope, ["workspace.manage"]);
    const projectId = safeMetadata(projectIdInput, "projectId");
    const deletionId = safeMetadata(deletionIdInput, "deletionId");
    return this.guardedExclusive(scope, ["workspace.manage"], projectId, async () =>
      this.exclusive("__storage-quota__", async () => {
        const binding = await this.requireDeletionBinding(
          scope.workspaceKey,
          projectId,
          deletionId,
        );
        if (binding.expectedProjectRevision !== expectedRevision) {
          throw new Error("Revision deletion ProjectWorkspace tidak cocok ledger.");
        }
        if (
          JSON.stringify(binding.completedSteps) !== JSON.stringify([
            "runs_fenced",
            "evidence_removed",
            "runs_removed",
            "github_detached",
          ])
        ) {
          throw new Error("Project deletion belum mencapai cleanup project.");
        }
        const project = await this.repository.load(projectId);
        if (!project) {
          if (!this.memoryLifecycle) {
            throw new Error("Lifecycle memory project belum dikonfigurasi; penghapusan gagal tertutup.");
          }
          await this.memoryLifecycle.forgetAll(
            projectMemoryNamespace(scope.workspaceKey, projectId),
          );
          await this.reapTrashForOwner(scope.workspaceKey);
          await this.assertProjectPayloadAbsent(scope.workspaceKey, projectId);
          return "missing";
        }
        if (
          project.ownerWorkspaceKey !== scope.workspaceKey ||
          project.createdAt !== binding.projectCreatedAt ||
          project.revision !== expectedRevision
        ) {
          throw new Error("ProjectWorkspace deletion binding sudah basi.");
        }
        assertNoPendingLocalGit(project, "menghapus project");
        return this.removeProjectLocked(scope.workspaceKey, project);
      })
    );
  }

  async readManifest(
    scope: WorkspaceAgentScope,
    projectId: string,
    snapshotId?: string,
  ): Promise<ProjectSnapshotManifest | null> {
    await this.ensureStorageIsolation();
    const cleanProjectId = safeMetadata(projectId, "projectId");
    return this.authority.withPermission(scope, "code.read", () =>
      this.exclusive(cleanProjectId, async () => {
        const project = await this.repository.load(cleanProjectId);
        if (
          !project ||
          project.ownerWorkspaceKey !== scope.workspaceKey ||
          !isProjectAvailable(project) ||
          await this.isDeletionPending(scope.workspaceKey, cleanProjectId)
        ) {
          return null;
        }
        const selected = snapshotId ?? project.baseSnapshot;
        if (!project.snapshotHistory.some((entry) => entry.snapshotId === selected)) {
          return null;
        }
        await this.verifySnapshot(project, selected);
        return JSON.parse(
          await readFile(this.manifestPath(project, selected), "utf8"),
        ) as ProjectSnapshotManifest;
      })
    );
  }

  private async installArchiveSnapshot(
    ownerWorkspaceKey: string,
    projectId: string,
    archive: Buffer,
  ): Promise<{
    archiveSha256: string;
    manifest: ProjectSnapshotManifest;
  }> {
    const stagingId = opaqueId("stage", this.makeId());
    const staging = join(this.storageRoot, "staging", stagingId);
    await assertNoManagedSymlink(this.storageRoot, staging);
    try {
      const extracted = await extractSafeZip(archive, staging, {
        ...(this.zipLimits ? { limits: this.zipLimits } : {}),
        now: this.now,
        makeId: this.makeId,
      });
      const snapshot = this.rawSnapshotPath(
        ownerWorkspaceKey,
        projectId,
        extracted.manifest.snapshotId,
      );
      await assertNoManagedSymlink(this.storageRoot, snapshot);
      await mkdir(resolve(snapshot, ".."), { recursive: true });
      if (!await exists(snapshot)) {
        await rename(staging, snapshot);
        await makeTreeReadOnly(snapshot);
      }
      await this.writeManifest(
        ownerWorkspaceKey,
        projectId,
        extracted.manifest,
      );
      const projectLike = {
        id: projectId,
        ownerWorkspaceKey,
        snapshotHistory: [{ snapshotId: extracted.manifest.snapshotId }],
      } as ProjectWorkspace;
      await this.verifySnapshot(projectLike, extracted.manifest.snapshotId);
      return extracted;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async installWorkingSnapshot(
    project: ProjectWorkspace,
    working: ProjectWorkingCopy,
  ): Promise<ProjectSnapshotManifest> {
    const preliminary = await scanProjectTree(working.internalPath, {
      ...(this.treeLimits ? { limits: this.treeLimits } : {}),
      now: this.now,
    });
    await this.assertOwnerQuota(
      project.ownerWorkspaceKey,
      project.id,
      0,
      0,
      false,
    );
    const destination = this.rawSnapshotPath(
      project.ownerWorkspaceKey,
      project.id,
      preliminary.snapshotId,
    );
    await assertNoManagedSymlink(this.storageRoot, destination);
    let createdSnapshot = false;
    try {
      if (!await exists(destination)) {
        await this.assertStagedSnapshotQuota(project, preliminary);
        const temporary = `${destination}.copy-${opaqueId("tmp", this.makeId())}`;
        try {
        await mkdir(resolve(destination, ".."), { recursive: true });
        const copied = await copyProjectTree(
          working.internalPath,
          temporary,
          this.treeLimits,
        );
        if (copied.snapshotId !== preliminary.snapshotId) {
          throw new Error("Working copy berubah selama pembentukan snapshot.");
        }
        await rename(temporary, destination);
        createdSnapshot = true;
        await makeTreeReadOnly(destination);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      await this.writeManifest(project.ownerWorkspaceKey, project.id, preliminary);
      await this.assertOwnerQuota(
        project.ownerWorkspaceKey,
        project.id,
        0,
        0,
        false,
      );
      await this.verifySnapshot(project, preliminary.snapshotId);
      return preliminary;
    } catch (error) {
      if (createdSnapshot) {
        await this.removeUnreferencedSnapshot(
          project.ownerWorkspaceKey,
          project.id,
          preliminary.snapshotId,
        );
      }
      throw error;
    }
  }

  private async verifySnapshot(
    project: ProjectWorkspace,
    snapshotId: string,
  ): Promise<string> {
    const path = this.rawSnapshotPath(
      project.ownerWorkspaceKey,
      project.id,
      snapshotId,
    );
    const manifest = JSON.parse(
      await readFile(
        this.rawManifestPath(project.ownerWorkspaceKey, project.id, snapshotId),
        "utf8",
      ),
    ) as ProjectSnapshotManifest;
    validateManifest(manifest, snapshotId);
    const actual = await scanProjectTree(path, {
      ...(this.treeLimits ? { limits: this.treeLimits } : {}),
      now: this.now,
    });
    await assertTreeReadOnly(path);
    if (
      actual.snapshotId !== snapshotId ||
      actual.totalBytes !== manifest.totalBytes ||
      JSON.stringify(actual.files) !== JSON.stringify(manifest.files)
    ) {
      throw new Error("Immutable snapshot project gagal verifikasi content-addressed.");
    }
    return path;
  }

  private async assertStagedSnapshotQuota(
    project: ProjectWorkspace,
    next: ProjectSnapshotManifest,
  ): Promise<void> {
    const usage = await this.stagedSnapshotUsage(project);
    const stagedCount = usage.count;
    const stagedBytes = usage.bytes;
    if (stagedCount >= this.storagePolicy.maxStagedSnapshotsPerProject) {
      throw new Error("Quota staged snapshot ProjectWorkspace tercapai.");
    }
    const projectedProjectBytes = project.storageUsage.artifactBytes +
      project.storageUsage.snapshotBytes + stagedBytes + next.totalBytes;
    if (projectedProjectBytes > this.storagePolicy.maxStoredBytesPerProject) {
      throw new Error("Quota storage project workspace tercapai oleh staged snapshot.");
    }
    const projects = await this.repository.listByOwner(project.ownerWorkspaceKey);
    let ownerStagedBytes = stagedBytes;
    for (const candidate of projects) {
      if (candidate.id === project.id) continue;
      ownerStagedBytes += (await this.stagedSnapshotUsage(candidate)).bytes;
    }
    const ownerAccounted = projects.reduce(
      (total, candidate) => total + candidate.storageUsage.artifactBytes +
        candidate.storageUsage.snapshotBytes,
      0,
    );
    if (ownerAccounted + ownerStagedBytes + next.totalBytes >
      this.storagePolicy.maxStoredBytesPerOwner) {
      throw new Error("Quota storage workspace owner tercapai oleh staged snapshot.");
    }
  }

  private async stagedSnapshotUsage(
    project: ProjectWorkspace,
  ): Promise<{ count: number; bytes: number }> {
    const root = resolve(
      this.storageRoot,
      "snapshots",
      ownerDirectory(project.ownerWorkspaceKey),
      project.id,
    );
    await assertNoManagedSymlink(this.storageRoot, root);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") entries = [];
      else throw error;
    }
    const retained = new Set(project.snapshotHistory.map((entry) => entry.snapshotId));
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("Storage snapshot project memuat entry tidak sah.");
      }
      const snapshotId = sha256(entry.name, "snapshotId");
      if (retained.has(snapshotId)) continue;
      const manifest = JSON.parse(
        await readFile(
          this.rawManifestPath(project.ownerWorkspaceKey, project.id, snapshotId),
          "utf8",
        ),
      ) as ProjectSnapshotManifest;
      validateManifest(manifest, snapshotId);
      count += 1;
      bytes += manifest.totalBytes;
    }
    return { count, bytes };
  }

  private async storeArtifact(
    ownerWorkspaceKey: string,
    projectId: string,
    artifactId: string,
    archive: Buffer,
  ): Promise<string> {
    const path = this.artifactPath(ownerWorkspaceKey, projectId, artifactId);
    await assertNoManagedSymlink(this.storageRoot, path);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, archive, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o400);
    return path;
  }

  private async writeManifest(
    ownerWorkspaceKey: string,
    projectId: string,
    manifest: ProjectSnapshotManifest,
  ): Promise<void> {
    const path = this.rawManifestPath(
      ownerWorkspaceKey,
      projectId,
      manifest.snapshotId,
    );
    await assertNoManagedSymlink(this.storageRoot, path);
    await mkdir(resolve(path, ".."), { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }

  private async requireCurrentProject(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<ProjectWorkspace> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision ProjectWorkspace tidak sah.");
    }
    const project = await this.repository.load(projectId);
    if (
      !project ||
      project.ownerWorkspaceKey !== scope.workspaceKey ||
      !isProjectAvailable(project) ||
      await this.isDeletionPending(scope.workspaceKey, projectId)
    ) {
      throw new Error("ProjectWorkspace tidak ditemukan pada scope ini.");
    }
    if (project.revision !== expectedRevision) {
      throw new Error("ProjectWorkspace revision sudah basi.");
    }
    return project;
  }

  private async assertNotDeleting(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<void> {
    if (await this.isDeletionPending(ownerWorkspaceKey, projectId)) {
      throw new Error("ProjectWorkspace sedang atau sudah dihapus.");
    }
  }

  private async requireDeletionBinding(
    ownerWorkspaceKey: string,
    projectId: string,
    deletionId: string,
  ): Promise<{
    expectedProjectRevision: number;
    projectCreatedAt: string;
    status: "requested" | "cleanup_required" | "completed";
    completedSteps: import("../domain/project-deletion.js").ProjectDeletionStep[];
  }> {
    if (!this.deletionAuthority) {
      throw new Error("Deletion authority ProjectWorkspace belum dikonfigurasi.");
    }
    const binding = await this.deletionAuthority.cleanupBinding(
      ownerWorkspaceKey,
      projectId,
      deletionId,
    );
    if (!binding || binding.status === "completed") {
      throw new Error("Deletion binding ProjectWorkspace tidak tersedia.");
    }
    return binding;
  }

  private async isDeletionPending(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<boolean> {
    return this.deletionAuthority
      ? this.deletionAuthority.isDeletionPending(ownerWorkspaceKey, projectId)
      : false;
  }

  private async removeProjectLocked(
    ownerWorkspaceKey: string,
    project: ProjectWorkspace,
  ): Promise<"removed" | "missing"> {
    if (!this.memoryLifecycle) {
      throw new Error("Lifecycle memory project belum dikonfigurasi; penghapusan gagal tertutup.");
    }
    await this.memoryLifecycle.forgetAll(
      projectMemoryNamespace(ownerWorkspaceKey, project.id),
    );
    const quarantined = await this.quarantineProjectFiles(project);
    let removed: "removed" | "missing" | "conflict";
    try {
      removed = await this.repository.remove(project.id, project.revision);
    } catch (error) {
      let durable: ProjectWorkspace | null;
      try {
        durable = await this.repository.load(project.id);
      } catch {
        // Unknown local commit outcome: retain the exact trash marker so a
        // later replay can reconcile metadata without restoring live bytes.
        throw error;
      }
      if (durable) {
        await this.restoreQuarantined(quarantined).catch(() => undefined);
        throw error;
      }
      await this.purgeQuarantined(quarantined);
      await this.assertProjectPayloadAbsent(ownerWorkspaceKey, project.id);
      return "removed";
    }
    if (removed === "conflict") {
      await this.restoreQuarantined(quarantined);
      throw new Error("ProjectWorkspace berubah selama penghapusan.");
    }
    if (removed === "missing") {
      const durable = await this.repository.load(project.id);
      if (durable) {
        await this.restoreQuarantined(quarantined);
        throw new Error("ProjectWorkspace muncul kembali selama penghapusan.");
      }
    }
    await this.purgeQuarantined(quarantined);
    await this.assertProjectPayloadAbsent(ownerWorkspaceKey, project.id);
    return removed === "missing" ? "missing" : "removed";
  }

  private async assertProjectPayloadAbsent(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<void> {
    const ownerPart = ownerDirectory(ownerWorkspaceKey);
    for (const kind of ["artifacts", "snapshots", "manifests", "working"] as const) {
      if (await exists(resolve(this.storageRoot, kind, ownerPart, projectId))) {
        throw new Error("Payload ProjectWorkspace deletion belum seluruhnya dibersihkan.");
      }
    }
    const trashRoot = resolve(this.storageRoot, "trash", ownerPart, projectId);
    try {
      if ((await readdir(trashRoot)).length > 0) {
        throw new Error("Trash ProjectWorkspace deletion belum seluruhnya dibersihkan.");
      }
      await rm(trashRoot, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  private async requirePermissions(
    scope: WorkspaceAgentScope,
    permissions: readonly WorkspacePermission[],
  ): Promise<void> {
    await this.ensureStorageIsolation();
    for (const permission of permissions) {
      if (!await this.authority.authorize(scope, permission)) {
        throw new Error(`Izin workspace ${permission} tidak tersedia atau basi.`);
      }
    }
  }

  private assertRevisionCapacity(
    project: ProjectWorkspace,
    requiredSlots = 1,
  ): void {
    if (
      !Number.isSafeInteger(requiredSlots) ||
      requiredSlots < 1 ||
      project.revision > this.storagePolicy.maxRevisionsPerProject - requiredSlots
    ) {
      throw new Error("Batas revision ProjectWorkspace tercapai; hapus atau ekspor project sebelum melanjutkan.");
    }
  }

  private async assertOwnerQuota(
    ownerWorkspaceKey: string,
    projectId: string,
    additionalBytes: number,
    additionalEntries: number,
    addingProject: boolean,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(additionalBytes) ||
      additionalBytes < 0 ||
      !Number.isSafeInteger(additionalEntries) ||
      additionalEntries < 0
    ) {
      throw new Error("Perhitungan quota ProjectWorkspace tidak sah.");
    }
    const cleanProjectId = safeMetadata(projectId, "projectId");
    await this.reapTrashForOwner(ownerWorkspaceKey);
    const projects = await this.repository.listByOwner(ownerWorkspaceKey);
    if (addingProject && projects.length >= this.storagePolicy.maxProjectsPerOwner) {
      throw new Error("Quota jumlah project workspace tercapai.");
    }
    const [projectUsage, ownerUsage] = await Promise.all([
      this.projectManagedUsage(ownerWorkspaceKey, cleanProjectId),
      this.ownerManagedUsage(ownerWorkspaceKey),
    ]);
    if (
      projectUsage.accountedBytes + additionalBytes >
        this.storagePolicy.maxStoredBytesPerProject
    ) {
      throw new Error("Quota storage project workspace tercapai.");
    }
    if (
      ownerUsage.accountedBytes + additionalBytes >
        this.storagePolicy.maxStoredBytesPerOwner
    ) {
      throw new Error("Quota storage workspace owner tercapai.");
    }
    if (
      projectUsage.entries + additionalEntries >
        this.storagePolicy.maxStoredEntriesPerProject
    ) {
      throw new Error("Quota entry storage project workspace tercapai.");
    }
    if (
      ownerUsage.entries + additionalEntries >
        this.storagePolicy.maxStoredEntriesPerOwner
    ) {
      throw new Error("Quota entry storage workspace owner tercapai.");
    }
  }

  private async assertWorkingCopyQuota(project: ProjectWorkspace): Promise<void> {
    const projectRoot = resolve(
      this.storageRoot,
      "working",
      ownerDirectory(project.ownerWorkspaceKey),
      project.id,
    );
    const ownerRoot = resolve(
      this.storageRoot,
      "working",
      ownerDirectory(project.ownerWorkspaceKey),
    );
    const [projectCount, ownerCount] = await Promise.all([
      countWorkingCopies(projectRoot, false),
      countWorkingCopies(ownerRoot, true),
    ]);
    if (projectCount >= this.storagePolicy.maxWorkingCopiesPerProject) {
      throw new Error("Quota working copy project workspace tercapai.");
    }
    if (ownerCount >= this.storagePolicy.maxWorkingCopiesPerOwner) {
      throw new Error("Quota working copy workspace owner tercapai.");
    }
  }

  private async reapTrashForOwner(ownerWorkspaceKey: string): Promise<void> {
    const ownerPart = ownerDirectory(ownerWorkspaceKey);
    const ownerTrash = resolve(this.storageRoot, "trash", ownerPart);
    await assertNoManagedSymlink(this.storageRoot, ownerTrash);
    let projectEntries: Dirent[];
    try {
      projectEntries = await readdir(ownerTrash, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
        throw new Error("Trash ProjectWorkspace memuat entry project tidak sah.");
      }
      const projectId = safeMetadata(projectEntry.name, "trash projectId");
      const projectTrash = resolve(ownerTrash, projectId);
      for (const batch of await readdir(projectTrash, { withFileTypes: true })) {
        if (!batch.isDirectory() || batch.isSymbolicLink()) {
          throw new Error("Trash ProjectWorkspace memuat batch tidak sah.");
        }
        const batchRoot = resolve(projectTrash, batch.name);
        const markerPath = join(batchRoot, TRASH_MARKER);
        await assertNoManagedSymlink(this.storageRoot, markerPath);
        const marker = validateTrashMarker(
          JSON.parse(await readFile(markerPath, "utf8")),
          ownerPart,
          projectId,
        );
        const current = await this.repository.load(projectId);
        const sameProject = Boolean(
          current &&
          ownerDirectory(current.ownerWorkspaceKey) === ownerPart &&
          current.createdAt === marker.projectCreatedAt,
        );
        if (marker.kind === "project-remove" && sameProject) {
          const moves = ["artifacts", "snapshots", "manifests", "working"]
            .map((kind) => ({
              source: resolve(this.storageRoot, kind, ownerPart, projectId),
              destination: resolve(batchRoot, kind),
            }));
          const presentMoves: QuarantinedManagedPaths["moves"] = [];
          for (const move of moves) {
            if (await exists(move.destination)) presentMoves.push(move);
          }
          await this.restoreQuarantined({ root: batchRoot, moves: presentMoves });
          continue;
        }
        if (
          marker.kind === "snapshot-prune" &&
          sameProject &&
          marker.snapshotId &&
          current!.snapshotHistory.some((entry) => entry.snapshotId === marker.snapshotId)
        ) {
          const candidates = [
            {
              source: this.rawSnapshotPath(ownerWorkspaceKey, projectId, marker.snapshotId),
              destination: resolve(batchRoot, "snapshot"),
            },
            {
              source: this.rawManifestPath(ownerWorkspaceKey, projectId, marker.snapshotId),
              destination: resolve(batchRoot, "manifest"),
            },
          ];
          const moves: QuarantinedManagedPaths["moves"] = [];
          for (const move of candidates) {
            if (await exists(move.destination)) moves.push(move);
          }
          await this.restoreQuarantined({ root: batchRoot, moves });
          continue;
        }
        if (marker.kind === "snapshot-prune" && (sameProject || !current)) {
          const leftovers = [
            {
              source: this.rawSnapshotPath(
                ownerWorkspaceKey,
                projectId,
                marker.snapshotId!,
              ),
              destination: resolve(batchRoot, "snapshot"),
            },
            {
              source: this.rawManifestPath(
                ownerWorkspaceKey,
                projectId,
                marker.snapshotId!,
              ),
              destination: resolve(batchRoot, "manifest"),
            },
          ];
          for (const leftover of leftovers) {
            if (!await exists(leftover.source)) continue;
            if (await exists(leftover.destination)) {
              throw new Error("Recovery prune menemukan source dan trash duplikat.");
            }
            await assertNoManagedSymlink(this.storageRoot, leftover.source);
            await rename(leftover.source, leftover.destination);
          }
        }
        await this.purgeQuarantined({ root: batchRoot, moves: [] });
      }
    }
  }

  private async projectManagedUsage(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<ManagedStorageUsage> {
    const ownerPart = ownerDirectory(ownerWorkspaceKey);
    return combinedManagedUsage(
      MANAGED_STORAGE_KINDS.map((kind) =>
        resolve(this.storageRoot, kind, ownerPart, projectId)
      ),
    );
  }

  private async ownerManagedUsage(
    ownerWorkspaceKey: string,
  ): Promise<ManagedStorageUsage> {
    const ownerPart = ownerDirectory(ownerWorkspaceKey);
    return combinedManagedUsage(
      MANAGED_STORAGE_KINDS.map((kind) =>
        resolve(this.storageRoot, kind, ownerPart)
      ),
    );
  }

  private async ensureStorageIsolation(): Promise<void> {
    this.isolationReady ??= (async () => {
      await mkdir(this.storageRoot, { recursive: true, mode: 0o700 });
      const [realStorage, realProcess] = await Promise.all([
        realpath(this.storageRoot),
        realpath(this.processRoot),
      ]);
      isolatedStorageRoot(realStorage, realProcess);
    })();
    try {
      await this.isolationReady;
      const state = await lstat(this.storageRoot);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error("Root ProjectWorkspace tidak lagi direktori nyata.");
      }
      const [realStorage, realProcess] = await Promise.all([
        realpath(this.storageRoot),
        realpath(this.processRoot),
      ]);
      isolatedStorageRoot(realStorage, realProcess);
    } catch (error) {
      this.isolationReady = null;
      throw error;
    }
  }

  private validateWorkingHandle(
    scope: WorkspaceAgentScope,
    working: ProjectWorkingCopy,
  ): void {
    if (working.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("Working copy berada di workspace lain.");
    }
    const expected = this.workingPath(
      working.ownerWorkspaceKey,
      working.projectId,
      working.workingCopyId,
    );
    if (resolve(working.internalPath) !== expected) {
      throw new Error("Handle working copy tidak sah.");
    }
  }

  private manifestPath(project: ProjectWorkspace, snapshotId: string): string {
    return this.rawManifestPath(project.ownerWorkspaceKey, project.id, snapshotId);
  }

  private rawSnapshotPath(owner: string, projectId: string, snapshotId: string): string {
    return join(
      this.storageRoot,
      "snapshots",
      ownerDirectory(owner),
      safeMetadata(projectId, "projectId"),
      sha256(snapshotId, "snapshotId"),
    );
  }

  private rawManifestPath(owner: string, projectId: string, snapshotId: string): string {
    return join(
      this.storageRoot,
      "manifests",
      ownerDirectory(owner),
      safeMetadata(projectId, "projectId"),
      `${sha256(snapshotId, "snapshotId")}.json`,
    );
  }

  private artifactPath(owner: string, projectId: string, artifactId: string): string {
    return join(
      this.storageRoot,
      "artifacts",
      ownerDirectory(owner),
      safeMetadata(projectId, "projectId"),
      `${safeMetadata(artifactId, "artifactId")}.zip`,
    );
  }

  private workingPath(owner: string, projectId: string, workingId: string): string {
    return resolve(
      this.storageRoot,
      "working",
      ownerDirectory(owner),
      safeMetadata(projectId, "projectId"),
      safeMetadata(workingId, "workingCopyId"),
    );
  }

  private async quarantineProjectFiles(
    project: ProjectWorkspace,
  ): Promise<QuarantinedManagedPaths> {
    const ownerPart = ownerDirectory(project.ownerWorkspaceKey);
    const cleanProjectId = safeMetadata(project.id, "projectId");
    const quarantineRoot = resolve(
      this.storageRoot,
      "trash",
      ownerPart,
      cleanProjectId,
      opaqueId("remove", this.makeId()),
    );
    const result: QuarantinedManagedPaths = { root: quarantineRoot, moves: [] };
    try {
      await assertNoManagedSymlink(this.storageRoot, quarantineRoot);
      await writeTrashMarker(quarantineRoot, {
        version: 1,
        kind: "project-remove",
        ownerPart,
        projectId: cleanProjectId,
        projectCreatedAt: project.createdAt,
        snapshotId: null,
      });
      for (const kind of ["artifacts", "snapshots", "manifests", "working"] as const) {
        const source = resolve(this.storageRoot, kind, ownerPart, cleanProjectId);
        assertManagedPath(this.storageRoot, source);
        await assertNoManagedSymlink(this.storageRoot, source);
        if (!await exists(source)) continue;
        const destination = resolve(quarantineRoot, kind);
        await assertNoManagedSymlink(this.storageRoot, destination);
        await mkdir(resolve(destination, ".."), { recursive: true });
        await rename(source, destination);
        result.moves.push({ source, destination });
      }
      return result;
    } catch (error) {
      await this.restoreQuarantined(result).catch(() => undefined);
      throw error;
    }
  }

  private async restoreQuarantined(
    quarantined: QuarantinedManagedPaths,
  ): Promise<void> {
    for (const move of [...quarantined.moves].reverse()) {
      if (!await exists(move.destination)) continue;
      await assertNoManagedSymlink(this.storageRoot, move.destination);
      await assertNoManagedSymlink(this.storageRoot, move.source);
      if (await exists(move.source)) {
        throw new Error("Restore trash ProjectWorkspace menemukan target yang sudah ada.");
      }
      await mkdir(resolve(move.source, ".."), { recursive: true });
      await rename(move.destination, move.source);
    }
    await rm(quarantined.root, { recursive: true, force: true });
  }

  private async purgeQuarantined(
    quarantined: QuarantinedManagedPaths,
  ): Promise<void> {
    await assertNoManagedSymlink(this.storageRoot, quarantined.root);
    await makeManagedTreeRemovable(quarantined.root);
    await rm(quarantined.root, { recursive: true, force: true });
  }

  private async removeUnreferencedSnapshot(
    owner: string,
    projectId: string,
    snapshotId: string,
  ): Promise<void> {
    const current = await this.repository.load(projectId);
    if (current?.snapshotHistory.some((entry) => entry.snapshotId === snapshotId)) return;
    const targets = [
      {
        name: "snapshot",
        source: this.rawSnapshotPath(owner, projectId, snapshotId),
      },
      {
        name: "manifest",
        source: this.rawManifestPath(owner, projectId, snapshotId),
      },
    ];
    const quarantineRoot = resolve(
      this.storageRoot,
      "trash",
      ownerDirectory(owner),
      safeMetadata(projectId, "projectId"),
      opaqueId("prune", this.makeId()),
    );
    const quarantined: QuarantinedManagedPaths = {
      root: quarantineRoot,
      moves: [],
    };
    try {
      await assertNoManagedSymlink(this.storageRoot, quarantineRoot);
      await writeTrashMarker(quarantineRoot, {
        version: 1,
        kind: "snapshot-prune",
        ownerPart: ownerDirectory(owner),
        projectId: safeMetadata(projectId, "projectId"),
        projectCreatedAt: current?.createdAt ?? null,
        snapshotId,
      });
      for (const target of targets) {
        await assertNoManagedSymlink(this.storageRoot, target.source);
        if (!await exists(target.source)) continue;
        const destination = resolve(quarantineRoot, target.name);
        await mkdir(resolve(destination, ".."), { recursive: true });
        await rename(target.source, destination);
        quarantined.moves.push({ source: target.source, destination });
      }
    } catch (error) {
      await this.restoreQuarantined(quarantined).catch(() => undefined);
      throw error;
    }
    await this.purgeQuarantined(quarantined);
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = `${this.storageRoot}\0${key}`;
    const held = PROJECT_WORKSPACE_CONTEXT.getStore()?.get(queueKey);
    if (held?.active) {
      const child = Promise.resolve().then(operation);
      held.children.add(child);
      void child.catch(() => undefined);
      void child.then(
        () => held.children.delete(child),
        () => held.children.delete(child),
      );
      return child;
    }
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const parent = PROJECT_WORKSPACE_CONTEXT.getStore();
    const context = new Map(parent ?? []);
    const lease: ProjectWorkspaceLease = { active: true, children: new Set() };
    context.set(queueKey, lease);
    const guarded = () => PROJECT_WORKSPACE_CONTEXT.run(context, async () => {
      let value: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        value = await operation();
      } catch (error) {
        failed = true;
        failure = error;
      }
      await drainProjectChildren(lease.children);
      lease.active = false;
      if (failed) {
        throw failure;
      }
      return value as T;
    });
    const next = previous.then(guarded, guarded);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(queueKey, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    }
  }

  private guardedExclusive<T>(
    scope: WorkspaceAgentScope,
    permissions: readonly WorkspacePermission[],
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.authority.withPermissions(
      scope,
      permissions,
      () => this.exclusive(key, operation),
    );
  }
}

async function drainProjectChildren(
  children: Set<Promise<unknown>>,
): Promise<void> {
  while (children.size > 0) {
    await Promise.allSettled([...children]);
  }
}

function guardedSnapshotSource(
  source: ProjectSnapshotBundleSource,
  lease: { active: boolean },
  consumer: "sandbox" | "local git",
): ProjectSnapshotBundleSource {
  let opened = false;
  return Object.freeze({
    descriptor: Object.freeze(structuredClone(source.descriptor)),
    open(): AsyncIterable<Uint8Array> {
      if (!lease.active || opened) {
        return rejectedSnapshotStream(`Source snapshot ${consumer} sudah basi atau terpakai.`);
      }
      opened = true;
      const input = source.open();
      return (async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of input) {
          if (!lease.active) {
            throw new Error(`Guard source snapshot ${consumer} sudah berakhir.`);
          }
          yield chunk;
        }
        if (!lease.active) {
          throw new Error(`Guard source snapshot ${consumer} sudah berakhir.`);
        }
      })();
    },
  });
}

function rejectedSnapshotStream(message: string): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncGenerator<Uint8Array> {
    throw new Error(message);
  })();
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const state = await lstat(root);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("Snapshot immutable harus berupa direktori nyata.");
  }
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const child = await lstat(path);
      if (child.isSymbolicLink()) {
        throw new Error("Symlink tidak boleh masuk snapshot immutable.");
      }
      if (child.isDirectory()) {
        await walk(path);
      } else if (child.isFile()) {
        await chmod(path, (child.mode & 0o111) !== 0 ? 0o500 : 0o400);
      } else {
        throw new Error("Snapshot immutable hanya boleh berisi file biasa.");
      }
    }
    await chmod(directory, 0o500);
  }
  await walk(root);
}

async function writeTrashMarker(root: string, marker: TrashMarker): Promise<void> {
  validateTrashMarker(marker, marker.ownerPart, marker.projectId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, TRASH_MARKER), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function validateTrashMarker(
  value: unknown,
  expectedOwnerPart: string,
  expectedProjectId: string,
): TrashMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Marker trash ProjectWorkspace tidak sah.");
  }
  const marker = value as TrashMarker;
  const keys = Object.keys(marker).sort();
  const expectedKeys = [
    "version",
    "kind",
    "ownerPart",
    "projectId",
    "projectCreatedAt",
    "snapshotId",
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    marker.version !== 1 ||
    (marker.kind !== "project-remove" && marker.kind !== "snapshot-prune") ||
    marker.ownerPart !== expectedOwnerPart ||
    !/^[a-f0-9]{64}$/u.test(marker.ownerPart) ||
    safeMetadata(marker.projectId, "trash projectId") !== expectedProjectId ||
    (marker.projectCreatedAt !== null &&
      (!Number.isFinite(Date.parse(marker.projectCreatedAt)) ||
        new Date(marker.projectCreatedAt).toISOString() !== marker.projectCreatedAt)) ||
    (marker.kind === "project-remove" &&
      (marker.projectCreatedAt === null || marker.snapshotId !== null)) ||
    (marker.kind === "snapshot-prune" &&
      (marker.snapshotId === null || sha256(marker.snapshotId, "trash snapshotId") !== marker.snapshotId))
  ) {
    throw new Error("Marker trash ProjectWorkspace tidak sah.");
  }
  return structuredClone(marker);
}

function accountedFileBytes(size: number): number {
  return Math.max(size, MANAGED_ENTRY_BYTES);
}

async function combinedManagedUsage(
  roots: readonly string[],
): Promise<ManagedStorageUsage> {
  const usages = await Promise.all(roots.map((root) => scanManagedUsage(root)));
  return usages.reduce<ManagedStorageUsage>(
    (total, usage) => {
      const accountedBytes = total.accountedBytes + usage.accountedBytes;
      const entries = total.entries + usage.entries;
      if (!Number.isSafeInteger(accountedBytes) || !Number.isSafeInteger(entries)) {
        throw new Error("Perhitungan storage terkelola melampaui integer aman.");
      }
      return { accountedBytes, entries };
    },
    { accountedBytes: 0, entries: 0 },
  );
}

async function scanManagedUsage(root: string): Promise<ManagedStorageUsage> {
  let state;
  try {
    state = await lstat(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { accountedBytes: 0, entries: 0 };
    }
    throw error;
  }
  if (state.isSymbolicLink()) {
    throw new Error("Storage terkelola memuat symlink saat accounting quota.");
  }
  const blocks = (state as typeof state & { blocks?: number }).blocks;
  const allocatedBytes = typeof blocks === "number" && Number.isFinite(blocks)
    ? blocks * 512
    : 0;
  let usage: ManagedStorageUsage = {
    accountedBytes: Math.max(state.size, allocatedBytes, MANAGED_ENTRY_BYTES),
    entries: 1,
  };
  if (state.isDirectory()) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = await scanManagedUsage(join(root, entry.name));
      usage = {
        accountedBytes: usage.accountedBytes + child.accountedBytes,
        entries: usage.entries + child.entries,
      };
      if (
        !Number.isSafeInteger(usage.accountedBytes) ||
        !Number.isSafeInteger(usage.entries)
      ) {
        throw new Error("Perhitungan storage terkelola melampaui integer aman.");
      }
    }
  } else if (!state.isFile()) {
    throw new Error("Storage terkelola memuat special file saat accounting quota.");
  }
  return usage;
}

async function countWorkingCopies(root: string, nestedProjects: boolean): Promise<number> {
  let entries: Dirent[];
  try {
    const state = await lstat(root);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("Root working copy bukan direktori nyata.");
    }
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Storage working copy memuat entry tidak sah.");
    }
    if (!nestedProjects) {
      count += 1;
      continue;
    }
    const projectRoot = join(root, entry.name);
    for (const working of await readdir(projectRoot, { withFileTypes: true })) {
      if (!working.isDirectory() || working.isSymbolicLink()) {
        throw new Error("Storage working copy memuat entry tidak sah.");
      }
      count += 1;
    }
  }
  return count;
}

async function assertTreeReadOnly(root: string): Promise<void> {
  async function walk(path: string): Promise<void> {
    const state = await lstat(path);
    if (state.isSymbolicLink() || (state.mode & 0o222) !== 0) {
      throw new Error("Immutable snapshot project mempunyai symlink atau write bit.");
    }
    if (state.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        await walk(join(path, entry.name));
      }
    } else if (!state.isFile()) {
      throw new Error("Immutable snapshot project memuat special file.");
    }
  }
  await walk(root);
}

async function makeManagedTreeRemovable(path: string): Promise<void> {
  let state;
  try {
    state = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (state.isSymbolicLink()) {
    throw new Error("Symlink tidak boleh dibuka saat cleanup storage terkelola.");
  }
  if (state.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await makeManagedTreeRemovable(join(path, entry.name));
    }
    await chmod(path, 0o700);
  } else if (state.isFile()) {
    await chmod(path, 0o600);
  } else {
    throw new Error("Special file tidak boleh dibuka saat cleanup storage terkelola.");
  }
}

async function assertNoManagedSymlink(root: string, candidate: string): Promise<void> {
  assertManagedPath(root, candidate);
  const absoluteRoot = resolve(root);
  const rootState = await lstat(absoluteRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error("Root storage terkelola bukan direktori nyata.");
  }
  const segments = relative(absoluteRoot, resolve(candidate)).split(sep);
  let cursor = absoluteRoot;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const state = await lstat(cursor);
      if (state.isSymbolicLink()) {
        throw new Error("Path storage terkelola memuat symlink.");
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function withoutRevision(
  project: ProjectWorkspace,
): Omit<ProjectWorkspace, "revision"> {
  const { revision: _revision, ...rest } = project;
  return rest;
}

function assertCommittedWorkspaceEffect(
  entry: ProjectWorkspaceRevision,
  working: ProjectWorkingCopy,
  expectedSnapshotId: string,
): void {
  if (
    entry.reason !== "coding" ||
    entry.revision !== working.workspaceRevision + 1 ||
    entry.parentSnapshotId !== working.baseSnapshot ||
    entry.snapshotId !== expectedSnapshotId
  ) {
    throw new Error("Commit effectId ProjectWorkspace dipakai ulang untuk binding berbeda.");
  }
}

function omitGit<T extends { git?: ProjectWorkspaceGitState }>(
  value: T,
): Omit<T, "git"> {
  const { git: _git, ...rest } = value;
  return rest;
}

function omitPendingGitCommit<T extends { pendingGitCommit?: unknown }>(
  value: T,
): Omit<T, "pendingGitCommit"> {
  const { pendingGitCommit: _pending, ...rest } = value;
  return rest;
}

function localGitPendingIntent(
  projectId: string,
  snapshotId: string,
  sourceRevision: number,
  git: ProjectWorkspaceGitState,
  preparedAt: string,
): ProjectWorkspacePendingGitCommit {
  const binding: LocalGitBinding = {
    projectId,
    snapshotId,
    workspaceRevision: sourceRevision,
    baseCommit: git.baseCommit,
    headCommit: git.headCommit,
    branch: git.branch,
  };
  const request = createLocalGitCommitRequest(binding);
  return {
    snapshotId,
    sourceRevision,
    baseCommit: git.baseCommit,
    parentCommit: git.headCommit,
    operationId: request.operationId,
    targetBranch: request.targetBranch,
    message: request.message,
    preparedAt,
  };
}

function exactLocalGitReceipt(
  project: ProjectWorkspace,
  pending: ProjectWorkspacePendingGitCommit,
  result: LocalGitCommitResult,
): ProjectWorkspaceLocalGitCommitReceipt {
  if (
    result.operationId !== pending.operationId ||
    result.projectId !== project.id ||
    result.snapshotId !== pending.snapshotId ||
    result.sourceWorkspaceRevision !== pending.sourceRevision ||
    result.branch !== pending.targetBranch ||
    result.parentCommit !== pending.parentCommit ||
    result.commit === result.parentCommit ||
    result.authorName !== "Harvy Bot" ||
    result.authorEmail !== "bot@harvy.local"
  ) throw new Error("Receipt local git tidak cocok dengan pending exact effect.");
  const git = validGitState({
    baseCommit: pending.baseCommit,
    headCommit: result.commit,
    branch: result.branch,
  });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result.treeHash)) {
    throw new Error("Tree hash receipt local git tidak sah.");
  }
  if (
    !Number.isFinite(Date.parse(result.committedAt)) ||
    new Date(result.committedAt).toISOString() !== result.committedAt
  ) throw new Error("Waktu receipt local git tidak sah.");
  const receipt: ProjectWorkspaceLocalGitCommitReceipt = {
    operationId: safeMetadata(result.operationId, "local git operationId"),
    snapshotId: sha256(result.snapshotId, "local git snapshotId"),
    sourceRevision: result.sourceWorkspaceRevision,
    baseCommit: git.baseCommit,
    branch: git.branch,
    parentCommit: result.parentCommit,
    commit: git.headCommit,
    treeHash: result.treeHash,
    objectBundle: validateLocalGitObjectBundleReference(result.objectBundle),
    authorName: result.authorName,
    authorEmail: result.authorEmail,
    committedAt: result.committedAt,
  };
  if (
    receipt.objectBundle.commit !== receipt.commit ||
    receipt.objectBundle.parentCommit !== receipt.parentCommit ||
    receipt.objectBundle.treeHash !== receipt.treeHash
  ) throw new Error("Object bundle local git tidak mengikat receipt ProjectWorkspace.");
  return receipt;
}

function assertNoPendingLocalGit(project: ProjectWorkspace, operation: string): void {
  if (project.pendingGitCommit) {
    throw new Error(`Pending local git effect wajib direkonsiliasi sebelum ${operation}.`);
  }
}

function isolatedStorageRoot(value: string, processRoot: string): string {
  if (!value || !isAbsolute(value)) {
    throw new Error("Root ProjectWorkspace harus absolute.");
  }
  const storage = resolve(value);
  const processDirectory = resolve(processRoot);
  if (
    storage === processDirectory ||
    isInside(processDirectory, storage) ||
    isInside(storage, processDirectory)
  ) {
    throw new Error("Storage ProjectWorkspace harus terpisah dari root proses Harvy.");
  }
  return storage;
}

function validateStoragePolicy(
  value: ProjectStoragePolicy,
): Readonly<ProjectStoragePolicy> {
  for (const [field, limit] of Object.entries(value)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`Policy storage ProjectWorkspace ${field} tidak sah.`);
    }
  }
  if (value.maxStoredBytesPerProject > value.maxStoredBytesPerOwner) {
    throw new Error("Quota project tidak boleh melebihi quota owner.");
  }
  return Object.freeze({ ...value });
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

function assertManagedPath(root: string, candidate: string): void {
  if (!isInside(resolve(root), resolve(candidate))) {
    throw new Error("Path operasi ProjectWorkspace keluar dari root terkelola.");
  }
}

function ownerDirectory(owner: string): string {
  return createHash("sha256")
    .update("harvy-project-owner-v1\0", "utf8")
    .update(safeMetadata(owner, "ownerWorkspaceKey"), "utf8")
    .digest("hex");
}

function opaqueId(prefix: string, value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/giu, "").slice(0, 80);
  if (!clean) throw new Error("Generator ID ProjectWorkspace tidak sah.");
  return `${prefix}-${clean}`;
}

function safeMetadata(value: string, field: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > 512 || /\p{Cc}/u.test(clean) || /[\\/]/u.test(clean)) {
    throw new Error(`${field} ProjectWorkspace tidak sah.`);
  }
  return clean;
}

function safeExternalMetadata(value: string, field: string): string {
  const clean = safeMetadata(value, field);
  if (containsSecretLikeValue(clean)) {
    throw new Error(`${field} ProjectWorkspace menyerupai credential dan ditolak.`);
  }
  return clean;
}

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} ProjectWorkspace tidak sah.`);
  }
  return value;
}

export function projectIdForGitHubSelection(selectionIdInput: string): string {
  const selectionId = safeExternalMetadata(selectionIdInput, "selectionId");
  return `project-gh-${createHash("sha256")
    .update("harvy-github-selection-project-v1\0", "utf8")
    .update(selectionId, "utf8")
    .digest("hex")}`;
}

function assertExactGitHubSelectionProject(
  project: ProjectWorkspace,
  expected: {
    ownerWorkspaceKey: string;
    selectionId: string;
    installationConnectionId: string;
    repositoryId: string;
    installationId: string;
    git: ProjectWorkspaceGitState;
  },
): void {
  if (
    project.ownerWorkspaceKey !== expected.ownerWorkspaceKey ||
    project.source.type !== "github" ||
    project.source.repositorySelectionId !== expected.selectionId ||
    project.source.installationConnectionId !==
      expected.installationConnectionId ||
    project.source.repositoryId !== expected.repositoryId ||
    project.source.installationId !== expected.installationId ||
    !(
      (project.revision === 1 &&
        (project.source.provisioningStatus === "pending" ||
          project.source.provisioningStatus === undefined) &&
        project.source.repositoryBindingId === undefined) ||
      (project.revision === 2 &&
        project.source.provisioningStatus === "bound" &&
        typeof project.source.repositoryBindingId === "string")
    ) ||
    !project.git ||
    project.git.baseCommit !== expected.git.baseCommit ||
    project.git.headCommit !== expected.git.headCommit ||
    project.git.branch !== expected.git.branch ||
    project.pendingGitCommit !== undefined ||
    (project.localGitCommitReceipts?.length ?? 0) !== 0
  ) {
    throw new Error(
      "ProjectWorkspace GitHub deterministic tidak cocok selection provisioning.",
    );
  }
}

function isProjectAvailable(project: ProjectWorkspace): boolean {
  if (project.source.type !== "github") return true;
  // GitHub archives imported before the installation saga remain ordinary
  // visible projects. A saga project is fail-closed until exact activation.
  if (
    project.source.installationConnectionId === undefined &&
    project.source.repositorySelectionId === undefined
  ) return true;
  return project.source.provisioningStatus === "bound" &&
    typeof project.source.repositoryBindingId === "string";
}

function validGitState(input: ProjectWorkspaceGitState): ProjectWorkspaceGitState {
  const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  if (!commit.test(input.baseCommit) || !commit.test(input.headCommit)) {
    throw new Error("Commit git ProjectWorkspace tidak sah.");
  }
  if (
    !input.branch ||
    input.branch.length > 255 ||
    input.branch.startsWith("-") ||
    input.branch.startsWith("/") ||
    input.branch.endsWith("/") ||
    input.branch.endsWith(".") ||
    input.branch.includes("..") ||
    input.branch.includes("//") ||
    input.branch.includes("@{") ||
    input.branch.split("/").some((segment) => segment.endsWith(".lock")) ||
    /[~^:?*[\\\p{Cc}\s]/u.test(input.branch)
  ) {
    throw new Error("Branch git ProjectWorkspace tidak sah.");
  }
  return Object.freeze({ ...input });
}

function validateManifest(
  manifest: ProjectSnapshotManifest,
  expectedSnapshot: string,
): void {
  if (
    manifest?.version !== 1 ||
    manifest.snapshotId !== expectedSnapshot ||
    !Array.isArray(manifest.files) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0 ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw new Error("Manifest snapshot project tidak sah.");
  }
  let total = 0;
  let previous = "";
  for (const file of manifest.files) {
    if (canonicalProjectPath(file.path) !== file.path) {
      throw new Error("Path manifest snapshot project tidak kanonik.");
    }
    if (
      file.path <= previous ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      typeof file.executable !== "boolean"
    ) {
      throw new Error("Entry manifest snapshot project tidak sah.");
    }
    previous = file.path;
    total += file.size;
  }
  if (total !== manifest.totalBytes) {
    throw new Error("Total ukuran manifest snapshot project tidak cocok.");
  }
  const computed = createHash("sha256")
    .update(
      manifest.files.map(
        (file) =>
          `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? "x" : "-"}\n`,
      ).join(""),
      "utf8",
    )
    .digest("hex");
  if (computed !== manifest.snapshotId) {
    throw new Error("Digest manifest snapshot project tidak cocok.");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
