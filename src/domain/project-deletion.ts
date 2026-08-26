export type ProjectDeletionStep =
  | "runs_fenced"
  | "evidence_removed"
  | "runs_removed"
  | "github_detached"
  | "project_removed";

export interface ProjectDeletionRecord {
  version: 1;
  deletionId: string;
  ownerWorkspaceKey: string;
  projectId: string;
  projectCreatedAt: string;
  projectSource: "blank" | "upload" | "github";
  expectedProjectRevision: number;
  status: "requested" | "cleanup_required" | "completed";
  runIds: string[];
  fencedRunCount: number;
  completedSteps: ProjectDeletionStep[];
  lastError: { step: string; code: string; at: string } | null;
  revision: number;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ProjectDeletionSaveResult =
  | { status: "saved"; record: ProjectDeletionRecord }
  | { status: "conflict" };

/** Content-free locator for monotonic cleanup of an existing tombstone. */
export interface ProjectDeletionReference {
  version: 1;
  deletionId: string;
  ownerWorkspaceKey: string;
  projectId: string;
  projectCreatedAt: string;
  projectSource: ProjectDeletionRecord["projectSource"];
  expectedProjectRevision: number;
}

export interface ProjectDeletionPage {
  references: ProjectDeletionReference[];
  nextCursor: string | null;
}

export interface ProjectDeletionReconciler {
  /** Cleanup-only; never synthesize a user scope or create non-cleanup effects. */
  resumeDurable(
    reference: ProjectDeletionReference,
  ): Promise<"completed" | "cleanup_required" | "missing">;
}

export interface ProjectDeletionRepository {
  loadByProject(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<ProjectDeletionRecord | null>;
  load(deletionId: string): Promise<ProjectDeletionRecord | null>;
  listIncomplete(input: {
    cursor: string | null;
    limit: number;
  }): Promise<ProjectDeletionPage>;
  create(
    record: Omit<ProjectDeletionRecord, "revision">,
  ): Promise<ProjectDeletionSaveResult>;
  save(
    record: Omit<ProjectDeletionRecord, "revision">,
    expectedRevision: number,
  ): Promise<ProjectDeletionSaveResult>;
}

export interface ProjectDeletionAuthority {
  isDeletionPending(ownerWorkspaceKey: string, projectId: string): Promise<boolean>;
  cleanupBinding(
    ownerWorkspaceKey: string,
    projectId: string,
    deletionId: string,
  ): Promise<{
    version: 1;
    deletionId: string;
    ownerWorkspaceKey: string;
    projectId: string;
    expectedProjectRevision: number;
    projectCreatedAt: string;
    projectSource: ProjectDeletionRecord["projectSource"];
    status: ProjectDeletionRecord["status"];
    completedSteps: ProjectDeletionStep[];
  } | null>;
}

export interface ProjectDeletionRunFence {
  cancelAndFenceForDeletion(
    reference: ProjectDeletionReference,
  ): Promise<{
    runIds: string[];
    totalRunCount: number;
    blockedRunId: string | null;
  }>;
}

export interface ProjectDeletionGitHubLifecycle {
  detachLocalProject(
    ownerWorkspaceKey: string,
    projectId: string,
    deletionId: string,
  ): Promise<"detached" | "missing" | "blocked_unknown">;
}
