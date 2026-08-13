import { createHash, randomUUID } from "node:crypto";
import type {
  CodingEvidenceStore,
  CodingRunRepository,
} from "../domain/coding-run.js";
import type {
  ProjectDeletionGitHubLifecycle,
  ProjectDeletionReconciler,
  ProjectDeletionRecord,
  ProjectDeletionReference,
  ProjectDeletionRepository,
  ProjectDeletionRunFence,
  ProjectDeletionStep,
} from "../domain/project-deletion.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type { ProjectWorkspaceService } from "./project-workspace-service.js";

const STEPS: readonly ProjectDeletionStep[] = [
  "runs_fenced",
  "evidence_removed",
  "runs_removed",
  "github_detached",
  "project_removed",
];
const PROJECT_DELETION_RESUME_QUEUES = new Map<string, Promise<void>>();

/** Crash-resumable local deletion saga. Remote GitHub content is never deleted. */
export class ProjectDeletionCoordinator implements ProjectDeletionReconciler {
  constructor(
    private readonly repository: ProjectDeletionRepository,
    private readonly projects: ProjectWorkspaceService,
    private readonly runs: CodingRunRepository,
    private readonly runFence: ProjectDeletionRunFence,
    private readonly evidence: CodingEvidenceStore,
    private readonly github?: ProjectDeletionGitHubLifecycle,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async request(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
    expectedProjectRevision: number,
  ): Promise<ProjectDeletionRecord> {
    const projectId = safeKey(projectIdInput, "projectId");
    if (!Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 1) {
      throw new Error("Expected revision project deletion tidak sah.");
    }
    return this.projects.withWorkspacePermission(scope, "workspace.manage", async () => {
      const existing = await this.repository.loadByProject(
        scope.workspaceKey,
        projectId,
      );
      if (existing) {
        if (existing.expectedProjectRevision !== expectedProjectRevision) {
          throw new Error("Project deletion sudah diminta untuk revision berbeda.");
        }
        return existing;
      }
      const pendingRun = (await this.runs.listByProject(projectId)).find(
        (run) => run.binding.ownerWorkspaceKey === scope.workspaceKey && run.pendingCommit,
      );
      if (pendingRun) {
        throw new Error("Pending CodingRun commit wajib direkonsiliasi sebelum project deletion.");
      }
      return this.projects.withFreshProject(
        scope,
        projectId,
        expectedProjectRevision,
        "workspace.manage",
        async (project) => {
        if (project.pendingGitCommit) {
          throw new Error("Pending local git wajib direkonsiliasi sebelum project deletion.");
        }
        const at = this.now().toISOString();
        const created = await this.repository.create({
          version: 1,
          deletionId: `project-deletion-${safeId(this.makeId())}`,
          ownerWorkspaceKey: scope.workspaceKey,
          projectId,
          projectCreatedAt: project.createdAt,
          projectSource: project.source.type,
          expectedProjectRevision,
          status: "requested",
          runIds: [],
          fencedRunCount: 0,
          completedSteps: [],
          lastError: null,
          requestedAt: at,
          updatedAt: at,
          completedAt: null,
        });
        if (created.status === "saved") return created.record;
        const winner = await this.repository.loadByProject(
          scope.workspaceKey,
          projectId,
        );
        if (winner) return winner;
        throw new Error("Project deletion berubah saat request dibuat.");
        },
      );
    });
  }

  async status(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
  ): Promise<ProjectDeletionRecord | null> {
    const projectId = safeKey(projectIdInput, "projectId");
    return this.projects.withWorkspacePermission(scope, "workspace.manage", async () =>
      this.repository.loadByProject(scope.workspaceKey, projectId)
    );
  }

  async resume(
    scope: WorkspaceAgentScope,
    deletionIdInput: string,
  ): Promise<ProjectDeletionRecord> {
    const deletionId = safeKey(deletionIdInput, "deletionId");
    return this.projects.withWorkspacePermission(scope, "workspace.manage", async () => {
      return this.exclusive(deletionId, async () => {
        const record = await this.repository.load(deletionId);
        if (!record || record.ownerWorkspaceKey !== scope.workspaceKey) {
          throw new Error("Project deletion tidak ditemukan pada workspace ini.");
        }
        return this.resumeRecord(record);
      });
    });
  }

  async resumeDurable(
    referenceInput: ProjectDeletionReference,
  ): Promise<"completed" | "cleanup_required" | "missing"> {
    const reference = validDeletionReference(referenceInput);
    return this.exclusive(reference.deletionId, async () => {
      const record = await this.repository.load(reference.deletionId);
      if (!record) return "missing";
      assertDeletionReference(record, reference);
      const resumed = await this.resumeRecord(record);
      return resumed.status === "completed" ? "completed" : "cleanup_required";
    });
  }

  private async resumeRecord(
    initial: ProjectDeletionRecord,
  ): Promise<ProjectDeletionRecord> {
    let record = initial;
    if (record.status === "completed") return record;
    const reference = referenceFromRecord(record);
    try {
      if (!hasStep(record, "runs_fenced")) {
        const fenced = await this.runFence.cancelAndFenceForDeletion(reference);
        record = await this.save(record, {
          runIds: mergeIds(record.runIds, fenced.runIds),
          fencedRunCount: fenced.totalRunCount,
        });
        if (fenced.blockedRunId) {
          return this.fail(record, "runs_fenced", "commit_barrier");
        }
        record = await this.completeStep(record, "runs_fenced");
      }
      if (!hasStep(record, "evidence_removed")) {
        for (const runId of record.runIds) {
          await this.evidence.removeRun({
            ownerWorkspaceKey: record.ownerWorkspaceKey,
            projectId: record.projectId,
            runId,
          });
        }
        await this.evidence.removeProject({
          ownerWorkspaceKey: record.ownerWorkspaceKey,
          projectId: record.projectId,
        });
        record = await this.completeStep(record, "evidence_removed");
      }
      if (!hasStep(record, "runs_removed")) {
        for (const runId of record.runIds) {
          const run = await this.runs.load(runId);
          if (!run) continue;
          if (
            run.binding.ownerWorkspaceKey !== record.ownerWorkspaceKey ||
            run.binding.projectId !== record.projectId
          ) {
            throw new Error("Run project deletion berada di workspace lain.");
          }
          if (run.pendingCommit || !terminal(run.status)) {
            return this.fail(record, "runs_removed", "run_not_terminal");
          }
          if (!await this.runs.remove(runId, run.stateRevision)) {
            throw new Error("Run berubah selama project deletion.");
          }
        }
        record = await this.completeStep(record, "runs_removed");
      }
      if (!hasStep(record, "github_detached")) {
        if (record.projectSource === "github") {
          if (!this.github) {
            return this.fail(record, "github_detached", "github_lifecycle_missing");
          }
          const detached = await this.github.detachLocalProject(
            record.ownerWorkspaceKey,
            record.projectId,
            record.deletionId,
          );
          if (detached === "blocked_unknown") {
            return this.fail(record, "github_detached", "github_effect_unknown");
          }
        }
        record = await this.completeStep(record, "github_detached");
      }
      if (!hasStep(record, "project_removed")) {
        await this.projects.removeForDurableDeletion(reference);
        record = await this.completeStep(record, "project_removed", true);
      }
      return record;
    } catch (error) {
      const durable = await this.repository.load(record.deletionId).catch(() => null);
      if (durable) record = durable;
      if (record.status === "completed") return record;
      return this.fail(record, nextStep(record), errorCode(error));
    }
  }

  private async completeStep(
    record: ProjectDeletionRecord,
    step: ProjectDeletionStep,
    completed = false,
  ): Promise<ProjectDeletionRecord> {
    if (hasStep(record, step)) return record;
    if (STEPS[record.completedSteps.length] !== step) {
      throw new Error("Step project deletion dijalankan di luar urutan.");
    }
    const at = this.now().toISOString();
    return this.save(record, {
      status: completed ? "completed" : "requested",
      completedSteps: [...record.completedSteps, step],
      lastError: null,
      completedAt: completed ? at : null,
      updatedAt: at,
    });
  }

  private fail(
    record: ProjectDeletionRecord,
    step: string,
    code: string,
  ): Promise<ProjectDeletionRecord> {
    const at = this.now().toISOString();
    return this.save(record, {
      status: "cleanup_required",
      lastError: { step: safeKey(step, "error step"), code: safeKey(code, "error code"), at },
      updatedAt: at,
    });
  }

  private async save(
    record: ProjectDeletionRecord,
    changes: Partial<Omit<ProjectDeletionRecord, "version" | "deletionId" | "ownerWorkspaceKey" | "projectId" | "projectCreatedAt" | "projectSource" | "expectedProjectRevision" | "revision" | "requestedAt">>,
  ): Promise<ProjectDeletionRecord> {
    const { revision, ...withoutRevision } = record;
    const saved = await this.repository.save(
      { ...withoutRevision, ...changes },
      revision,
    );
    if (saved.status !== "saved") {
      throw new Error("Project deletion berubah bersamaan.");
    }
    return saved.record;
  }

  private async exclusive<T>(
    deletionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = PROJECT_DELETION_RESUME_QUEUES.get(deletionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    PROJECT_DELETION_RESUME_QUEUES.set(deletionId, tail);
    try {
      return await next;
    } finally {
      if (PROJECT_DELETION_RESUME_QUEUES.get(deletionId) === tail) {
        PROJECT_DELETION_RESUME_QUEUES.delete(deletionId);
      }
    }
  }
}

function referenceFromRecord(record: ProjectDeletionRecord): ProjectDeletionReference {
  return {
    version: 1,
    deletionId: record.deletionId,
    ownerWorkspaceKey: record.ownerWorkspaceKey,
    projectId: record.projectId,
    projectCreatedAt: record.projectCreatedAt,
    projectSource: record.projectSource,
    expectedProjectRevision: record.expectedProjectRevision,
  };
}

function validDeletionReference(
  input: ProjectDeletionReference,
): ProjectDeletionReference {
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([
      "deletionId",
      "expectedProjectRevision",
      "ownerWorkspaceKey",
      "projectCreatedAt",
      "projectId",
      "projectSource",
      "version",
    ])
  ) throw new Error("Locator project deletion memuat field asing atau hilang.");
  if (input.version !== 1) throw new Error("Versi locator project deletion tidak sah.");
  if (input.projectSource !== "upload" && input.projectSource !== "github") {
    throw new Error("Source locator project deletion tidak sah.");
  }
  if (
    !Number.isSafeInteger(input.expectedProjectRevision) ||
    input.expectedProjectRevision < 1
  ) throw new Error("Revision locator project deletion tidak sah.");
  if (
    !Number.isFinite(Date.parse(input.projectCreatedAt)) ||
    new Date(input.projectCreatedAt).toISOString() !== input.projectCreatedAt
  ) throw new Error("CreatedAt locator project deletion tidak sah.");
  return Object.freeze({
    version: 1,
    deletionId: safeKey(input.deletionId, "deletionId"),
    ownerWorkspaceKey: safeKey(input.ownerWorkspaceKey, "ownerWorkspaceKey"),
    projectId: safeKey(input.projectId, "projectId"),
    projectCreatedAt: input.projectCreatedAt,
    projectSource: input.projectSource,
    expectedProjectRevision: input.expectedProjectRevision,
  });
}

function assertDeletionReference(
  record: ProjectDeletionRecord,
  reference: ProjectDeletionReference,
): void {
  const expected = referenceFromRecord(record);
  if (JSON.stringify(expected) !== JSON.stringify(reference)) {
    throw new Error("Locator project deletion tidak cocok ledger.");
  }
}

function hasStep(record: ProjectDeletionRecord, step: ProjectDeletionStep): boolean {
  return record.completedSteps.includes(step);
}

function nextStep(record: ProjectDeletionRecord): ProjectDeletionStep {
  return STEPS[record.completedSteps.length] ?? "project_removed";
}

function mergeIds(current: readonly string[], next: readonly string[]): string[] {
  const result = [...current];
  const known = new Set(current);
  for (const id of next) {
    if (known.has(id)) continue;
    known.add(id);
    result.push(id);
  }
  return result;
}

function terminal(status: string): boolean {
  return ["completed", "failed", "cancelled", "stale", "partial"].includes(status);
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value || value.length > 512 ||
    /\p{Cc}/u.test(value) || containsSecretLikeValue(value)
  ) throw new Error(`${field} project deletion tidak sah.`);
  return value;
}

function safeId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 96);
  if (!clean) throw new Error("Generator deletion id tidak sah.");
  return clean;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return `cleanup-${createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16)}`;
}
