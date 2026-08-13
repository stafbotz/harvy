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
  projectSource: "upload" | "github";
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

export interface ProjectDeletionRepository {
  loadByProject(
    ownerWorkspaceKey: string,
    projectId: string,
  ): Promise<ProjectDeletionRecord | null>;
  load(deletionId: string): Promise<ProjectDeletionRecord | null>;
  listIncomplete(): Promise<ProjectDeletionRecord[]>;
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
    expectedProjectRevision: number;
    projectCreatedAt: string;
    status: ProjectDeletionRecord["status"];
    completedSteps: ProjectDeletionStep[];
  } | null>;
}

export interface ProjectDeletionRunFence {
  cancelAndFenceForDeletion(
    scope: import("../harness/scope.js").WorkspaceAgentScope,
    projectId: string,
    deletionId: string,
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
