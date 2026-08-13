import type { LocalGitObjectBundleReference } from "./local-git.js";

export type ProjectWorkspaceSource =
  | {
      type: "upload";
      artifactId: string;
      sha256: string;
    }
  | {
      type: "github";
      repositoryId: string;
      installationId: string;
      /** Present for projects created through the durable installation saga. */
      installationConnectionId?: string;
      repositorySelectionId?: string;
      /**
       * A deterministic GitHub project is not visible to ordinary project
       * consumers until the exact repository selection has been bound.
       * Missing only identifies legacy/non-saga records.
       */
      provisioningStatus?: "pending" | "bound";
      repositoryBindingId?: string;
    };

export interface ProjectWorkspaceGitState {
  baseCommit: string;
  branch: string;
  headCommit: string;
}

export interface ProjectSnapshotFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface ProjectSnapshotManifest {
  version: 1;
  snapshotId: string;
  files: ProjectSnapshotFile[];
  totalBytes: number;
  createdAt: string;
}

export interface ProjectWorkspaceRevision {
  revision: number;
  snapshotId: string;
  parentSnapshotId: string | null;
  reason: "import" | "provisioning" | "coding" | "replacement" | "rollback";
  /** Idempotency key for a prepared CodingRun commit effect. */
  effectId?: string;
  git?: ProjectWorkspaceGitState;
  createdAt: string;
}

export interface ProjectWorkspaceStorageUsage {
  artifactBytes: number;
  snapshotBytes: number;
}

/**
 * Satu slot revision yang dicadangkan ketika snapshot GitHub berubah sebelum
 * commit lokal dibuat. Reservation ini durable agar restart tidak membuat
 * efek git berhasil tetapi metadata project kehabisan revision.
 */
export interface ProjectWorkspacePendingGitCommit {
  snapshotId: string;
  sourceRevision: number;
  baseCommit: string;
  parentCommit: string;
  operationId: string;
  targetBranch: string;
  message: string;
  preparedAt: string;
}

export interface ProjectWorkspaceLocalGitCommitReceipt {
  operationId: string;
  snapshotId: string;
  sourceRevision: number;
  baseCommit: string;
  branch: string;
  parentCommit: string;
  commit: string;
  treeHash: string;
  objectBundle: LocalGitObjectBundleReference;
  authorName: "Harvy Bot";
  authorEmail: "bot@harvy.local";
  committedAt: string;
}

/**
 * Project identity is source-neutral. Repository content is referenced through
 * immutable snapshot ids; chat/model records never carry the whole project.
 */
export interface ProjectWorkspace {
  id: string;
  ownerWorkspaceKey: string;
  source: ProjectWorkspaceSource;
  revision: number;
  baseSnapshot: string;
  snapshotHistory: ProjectWorkspaceRevision[];
  storageUsage: ProjectWorkspaceStorageUsage;
  git?: ProjectWorkspaceGitState;
  pendingGitCommit?: ProjectWorkspacePendingGitCommit;
  /** Append-only exact local effects; optional only for legacy records. */
  localGitCommitReceipts?: ProjectWorkspaceLocalGitCommitReceipt[];
  createdAt: string;
  updatedAt: string;
}

export interface GitHubProjectProvisioningBinding {
  ownerWorkspaceKey: string;
  projectId: string;
  selectionId: string;
  bindingId: string;
  installationConnectionId: string;
  installationId: string;
  repositoryId: string;
}

/** Read-only authority over the separate durable installation/binding ledger. */
export interface GitHubProjectProvisioningAuthority {
  isProjectSelectionBound(
    binding: GitHubProjectProvisioningBinding,
  ): Promise<boolean>;
}

export type NewProjectWorkspace = Omit<ProjectWorkspace, "revision"> & {
  revision?: 1;
};

export type ProjectWorkspaceSaveResult =
  | { status: "saved"; workspace: ProjectWorkspace }
  | { status: "conflict" };

export type ProjectWorkspaceRemoveResult =
  | "removed"
  | "missing"
  | "conflict";

export interface ProjectWorkspaceRepository {
  load(projectId: string): Promise<ProjectWorkspace | null>;
  listByOwner(ownerWorkspaceKey: string): Promise<ProjectWorkspace[]>;
  create(workspace: NewProjectWorkspace): Promise<ProjectWorkspaceSaveResult>;
  save(
    workspace: Omit<ProjectWorkspace, "revision">,
    expectedRevision: number,
  ): Promise<ProjectWorkspaceSaveResult>;
  remove(
    projectId: string,
    expectedRevision: number,
  ): Promise<ProjectWorkspaceRemoveResult>;
}
