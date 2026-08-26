import type { CodingRun, CodingTaskBrief } from "../domain/coding-run.js";
import type { LocalGitCommitResult } from "../domain/local-git.js";
import type { ProjectWorkspace } from "../domain/project-workspace.js";
import type { WorkspacePrincipal } from "../domain/workspace.js";
import type { GroupCodingRepository, GroupWorkspaceLinkRequest } from
  "../domain/group-coding.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { renderCodingRunAnchor, type CodingRunAnchorView } from "../coding/coding-run-anchor.js";
import type { AuthenticatedWorkspaceActor, WorkspaceActorResolver } from "./workspace-coding-controller.js";
import { WorkspaceCodingController } from "./workspace-coding-controller.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { CodingRunEngine } from "./coding-run-engine.js";
import { CodingRunScheduler } from "./coding-run-scheduler.js";
import { LocalGitService } from "./local-git-service.js";
import { CodingRunProgressHub, type CodingRunProgressListener } from "./coding-run-progress-hub.js";
import {
  FilePrivateCodingSessionStore,
  type PrivateCodingSession,
} from "../storage/file-private-coding-session-store.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type {
  ProjectGoal,
  ProjectSkill,
  ProjectSkillVersion,
} from "../domain/project-intent.js";
import {
  ProjectIntentService,
  type SaveProjectSkillInput,
  type SetProjectGoalInput,
} from "./project-intent-service.js";

export interface PrivateCodingRunOutcome {
  run: CodingRun;
  anchor: CodingRunAnchorView;
  localCommit: LocalGitCommitResult | null;
  projectRevision: number | null;
  stoppedReason: string | null;
}

export interface PrivateCodingRunHandle {
  runId: string;
  initialAnchor: CodingRunAnchorView;
  completion: Promise<PrivateCodingRunOutcome>;
  unsubscribeProgress(): void;
}

export interface PrivateCodingSelectionView {
  workspaceKey: string | null;
  projectId: string | null;
  projectRevision: number | null;
  foregroundRunId: string | null;
  lastRunId: string | null;
}

interface ActiveDrive {
  restartRequested: boolean;
  cancelRequested: boolean;
  cancelledRun: CodingRun | null;
  cancellationSettled: Promise<void>;
  settleCancellation(): void;
  completion: Promise<PrivateCodingRunOutcome>;
}

/**
 * Private user-facing application service. Every scope is re-resolved from a
 * trusted actor principal; persisted selections are routing hints, never ACL.
 */
export class PrivateCodingApplication {
  readonly #queues = new Map<string, Promise<void>>();
  readonly #active = new Map<string, ActiveDrive>();
  #state: "idle" | "accepting" | "stopping" | "stopped" = "idle";

  constructor(
    private readonly actors: WorkspaceActorResolver,
    private readonly controller: WorkspaceCodingController,
    private readonly authority: WorkspaceAuthorityService,
    private readonly projects: ProjectWorkspaceService,
    private readonly runs: CodingRunEngine,
    private readonly scheduler: CodingRunScheduler,
    private readonly localGit: LocalGitService,
    private readonly sessions: FilePrivateCodingSessionStore,
    private readonly progress: CodingRunProgressHub,
    private readonly now: () => Date = () => new Date(),
    private readonly groupCodingRepository: GroupCodingRepository | null = null,
    private readonly projectIntents: ProjectIntentService | null = null,
  ) {}

  start(): void {
    if (this.#state === "accepting") return;
    if (this.#state !== "idle") {
      throw new Error("Private coding application yang dihentikan tidak dapat dimulai ulang.");
    }
    this.#state = "accepting";
  }

  stop(): void {
    if (this.#state === "stopped" || this.#state === "stopping") return;
    this.#state = "stopping";
  }

  async drain(): Promise<void> {
    this.stop();
    while (this.#active.size > 0) {
      await Promise.allSettled(
        [...this.#active.values()].map((entry) => entry.completion),
      );
    }
    this.#state = "stopped";
  }

  async createWorkspace(
    actor: AuthenticatedWorkspaceActor,
    displayName: string,
  ): Promise<PrivateCodingSelectionView> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const workspace = await this.controller.createWorkspace(actor, { displayName });
      const saved = await this.saveSession(session, {
        workspaceKey: workspace.workspaceKey,
        projectId: null,
        projectRevision: null,
        foregroundRunId: null,
        lastRunId: null,
      });
      return selection(saved);
    });
  }

  async listWorkspaces(actor: AuthenticatedWorkspaceActor) {
    await this.resolveActor(actor);
    return this.controller.listWorkspaces(actor);
  }

  async selectWorkspace(
    actor: AuthenticatedWorkspaceActor,
    workspaceKey: string,
  ): Promise<PrivateCodingSelectionView> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const scope = await this.requireScope(workspaceKey, resolved.principal);
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const saved = await this.saveSession(session, {
        workspaceKey: scope.workspaceKey,
        projectId: null,
        projectRevision: null,
        foregroundRunId: null,
        lastRunId: null,
      });
      return selection(saved);
    });
  }

  async listProjects(actor: AuthenticatedWorkspaceActor) {
    const { principal } = await this.resolveActor(actor);
    const session = await this.session(principal);
    if (!session.workspaceKey) throw new Error("Pilih workspace lebih dulu.");
    return this.controller.listProjects(actor, { workspaceKey: session.workspaceKey });
  }

  async selectProject(
    actor: AuthenticatedWorkspaceActor,
    projectId: string,
  ): Promise<PrivateCodingSelectionView> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      if (!session.workspaceKey) throw new Error("Pilih workspace lebih dulu.");
      const scope = await this.requireScope(session.workspaceKey, resolved.principal);
      const project = await this.projects.get(scope, projectId);
      if (!project) throw new Error("Project tidak tersedia pada workspace ini.");
      const saved = await this.saveSession(session, {
        workspaceKey: session.workspaceKey,
        projectId: project.id,
        projectRevision: project.revision,
        foregroundRunId: null,
        lastRunId: null,
      });
      return selection(saved);
    });
  }

  async confirmGroupWorkspaceLink(
    actor: AuthenticatedWorkspaceActor,
    requestIdInput: string,
  ): Promise<{ status: "approved" | "already-approved"; role: "admin" }> {
    this.assertAdmission();
    if (!this.groupCodingRepository) {
      throw new Error("Runtime linking Workspace grup belum dikonfigurasi.");
    }
    const requestId = groupLinkRequestId(requestIdInput);
    const resolved = await this.resolveActor(actor);
    // Kedua kanal privat membentuk actor dari ingress tepercaya dan memakai
    // audience workspace-private yang sama. Kanal bukan authority tambahan;
    // membership+ACL current di bawah tetap menjadi pagar sebenarnya.
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      if (!session.workspaceKey) throw new Error("Pilih Workspace lebih dulu.");
      let ownerScope = await this.requireScope(
        session.workspaceKey,
        resolved.principal,
      );
      if (!ownerScope.permissions.includes("workspace.manage")) {
        throw new Error("Hanya owner Workspace yang dapat mengonfirmasi link grup.");
      }
      let request = await this.requireGroupLinkRequest(requestId);
      if (request.status === "consumed" || request.status === "approved") {
        assertApprovedRequestOwner(request, ownerScope);
        return { status: "already-approved", role: "admin" };
      }
      if (request.status === "expired" || request.status === "revoked") {
        throw new Error(
          request.status === "revoked"
            ? "Request link grup sudah dicabut karena authority grup berubah."
            : "Request link grup sudah kedaluwarsa.",
        );
      }
      if (
        request.status === "pending" &&
        this.now().getTime() >= Date.parse(request.expiresAt)
      ) {
        await this.groupCodingRepository!.saveLinkRequest({
          ...withoutGroupLinkRequestRevision(request),
          status: "expired",
          updatedAt: this.now().toISOString(),
        }, request.stateRevision);
        throw new Error("Request link grup sudah kedaluwarsa.");
      }
      if (request.status === "pending") {
        const at = this.now().toISOString();
        const reserved = await this.groupCodingRepository!.saveLinkRequest({
          ...withoutGroupLinkRequestRevision(request),
          status: "approving",
          workspaceKey: ownerScope.workspaceKey,
          approvedByMembershipId: ownerScope.membershipId,
          approvedAclEpoch: ownerScope.aclEpoch,
          updatedAt: at,
        }, request.stateRevision);
        if (reserved.status !== "saved") {
          request = await this.requireGroupLinkRequest(requestId);
        } else {
          request = reserved.request;
        }
      }
      if (
        request.status !== "approving" ||
        request.workspaceKey !== ownerScope.workspaceKey ||
        request.approvedByMembershipId !== ownerScope.membershipId
      ) throw new Error("Request link grup sedang dikonfirmasi oleh authority lain.");

      let targetScope = await this.authority.resolveScope(
        ownerScope.workspaceKey,
        request.participantPrincipal,
      );
      if (!targetScope) {
        const added = await this.authority.addMember(
          ownerScope,
          request.participantPrincipal,
          "admin",
        );
        if (added.status !== "updated") {
          targetScope = await this.authority.resolveScope(
            ownerScope.workspaceKey,
            request.participantPrincipal,
          );
          if (!targetScope) {
            throw new Error("Membership WhatsApp Workspace gagal dibuat secara exact.");
          }
        }
      }
      targetScope ??= await this.authority.resolveScope(
        ownerScope.workspaceKey,
        request.participantPrincipal,
      );
      if (!targetScope) throw new Error("Membership WhatsApp Workspace tidak tersedia.");
      ownerScope = await this.requireScope(ownerScope.workspaceKey, resolved.principal);
      if (targetScope.role !== "admin") {
        const changed = await this.authority.changeRole(
          ownerScope,
          targetScope.membershipId,
          "admin",
        );
        if (changed.status !== "updated") {
          throw new Error("Membership WhatsApp tidak dapat diberi role admin secara exact.");
        }
        targetScope = await this.authority.resolveScope(
          ownerScope.workspaceKey,
          request.participantPrincipal,
        );
      }
      if (!targetScope || targetScope.role !== "admin") {
        throw new Error("Role membership WhatsApp belum current.");
      }
      const current = await this.requireGroupLinkRequest(requestId);
      if (current.status === "approved" || current.status === "consumed") {
        assertApprovedRequestOwner(current, ownerScope);
        return { status: "already-approved", role: "admin" };
      }
      if (
        current.status !== "approving" ||
        current.workspaceKey !== ownerScope.workspaceKey ||
        current.approvedByMembershipId !== ownerScope.membershipId
      ) throw new Error("Reservation approval link grup berubah bersamaan.");
      const at = this.now().toISOString();
      const approved = await this.groupCodingRepository!.saveLinkRequest({
        ...withoutGroupLinkRequestRevision(current),
        status: "approved",
        grantedMembershipId: targetScope.membershipId,
        approvedAclEpoch: targetScope.aclEpoch,
        approvedAt: at,
        updatedAt: at,
      }, current.stateRevision);
      if (approved.status !== "saved") {
        const replay = await this.requireGroupLinkRequest(requestId);
        assertApprovedRequestOwner(replay, ownerScope);
        return { status: "already-approved", role: "admin" };
      }
      return { status: "approved", role: "admin" };
    });
  }

  async uploadZip(
    actor: AuthenticatedWorkspaceActor,
    archive: Buffer,
  ): Promise<PrivateCodingSelectionView & { project: ProjectWorkspace }> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      let session = await this.session(resolved.principal);
      assertNoForeground(session);
      if (!session.workspaceKey) {
        const workspace = await this.controller.createWorkspace(actor, {
          displayName: "Project saya",
        });
        session = await this.saveSession(session, {
          workspaceKey: workspace.workspaceKey,
          projectId: null,
          projectRevision: null,
          foregroundRunId: null,
          lastRunId: null,
        });
      }
      const uploaded = await this.controller.uploadZip(actor, {
        workspaceKey: session.workspaceKey!,
        archive,
      });
      const scope = await this.requireScope(session.workspaceKey!, resolved.principal);
      const project = await this.projects.get(scope, uploaded.projectId);
      if (!project || project.revision !== uploaded.revision) {
        throw new Error("Project upload tidak dapat dimuat ulang.");
      }
      const saved = await this.saveSession(session, {
        workspaceKey: session.workspaceKey,
        projectId: project.id,
        projectRevision: project.revision,
        foregroundRunId: null,
        lastRunId: null,
      });
      return { ...selection(saved), project };
    });
  }

  async createBlankProject(
    actor: AuthenticatedWorkspaceActor,
    displayNameInput: string,
  ): Promise<PrivateCodingSelectionView & { project: ProjectWorkspace }> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    const displayName = taskText(displayNameInput, 80);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const workspace = await this.controller.createWorkspace(actor, {
        displayName,
      });
      const selectedWorkspace = await this.saveSession(session, {
        workspaceKey: workspace.workspaceKey,
        projectId: null,
        projectRevision: null,
        foregroundRunId: null,
        lastRunId: null,
      });
      const created = await this.controller.createBlankProject(actor, {
        workspaceKey: workspace.workspaceKey,
      });
      const scope = await this.requireScope(
        workspace.workspaceKey,
        resolved.principal,
      );
      const project = await this.projects.get(scope, created.projectId);
      if (!project || project.revision !== created.revision) {
        throw new Error("Project kosong tidak dapat dimuat ulang.");
      }
      const saved = await this.saveSession(selectedWorkspace, {
        workspaceKey: workspace.workspaceKey,
        projectId: project.id,
        projectRevision: project.revision,
        foregroundRunId: null,
        lastRunId: null,
      });
      return { ...selection(saved), project };
    });
  }

  async setGoal(
    actor: AuthenticatedWorkspaceActor,
    input: SetProjectGoalInput,
  ): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.setGoal(bound.scope, bound.project.id, input);
    });
  }

  async currentGoal(actor: AuthenticatedWorkspaceActor): Promise<ProjectGoal | null> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    const session = await this.session(resolved.principal);
    const bound = await this.boundSelection(session, resolved.principal);
    return intents.goal(bound.scope, bound.project.id);
  }

  async completeGoal(actor: AuthenticatedWorkspaceActor): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.completeGoal(bound.scope, bound.project.id);
    });
  }

  async addGoalBlocker(
    actor: AuthenticatedWorkspaceActor,
    summary: string,
  ): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.addBlocker(bound.scope, bound.project.id, summary);
    });
  }

  async resolveGoalBlocker(
    actor: AuthenticatedWorkspaceActor,
    blockerId: string,
  ): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.resolveBlocker(bound.scope, bound.project.id, blockerId);
    });
  }

  async resolveGoalBlockerByReference(
    actor: AuthenticatedWorkspaceActor,
    query: string,
  ): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.resolveBlockerByQuery(bound.scope, bound.project.id, query);
    });
  }

  async confirmManualGoalCriterion(
    actor: AuthenticatedWorkspaceActor,
    criterionId: string,
    summary: string,
  ): Promise<ProjectGoal> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.recordEvidence(bound.scope, bound.project.id, {
        ref: `user-confirmation:${taskText(criterionId, 128)}`,
        kind: "user_confirmation",
        summary: taskText(summary, 2_000),
        satisfyCriterionIds: [criterionId],
      });
    });
  }

  async createSkill(
    actor: AuthenticatedWorkspaceActor,
    input: SaveProjectSkillInput,
  ): Promise<ProjectSkill> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      return intents.createSkill(bound.scope, bound.project.id, input);
    });
  }

  async createSkillFromLatestEvidence(
    actor: AuthenticatedWorkspaceActor,
    input: Omit<SaveProjectSkillInput, "sourceEvidenceRefs">,
  ): Promise<ProjectSkill> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      const sourceEvidenceRefs = await intents.latestEvidenceRefs(
        bound.scope,
        bound.project.id,
      );
      if (sourceEvidenceRefs.length === 0) {
        throw new Error(
          "Skill belum dapat dibuat: selesaikan minimal satu CodingRun yang menghasilkan evidence goal.",
        );
      }
      return intents.createSkill(bound.scope, bound.project.id, {
        ...input,
        sourceEvidenceRefs,
      });
    });
  }

  async listSkills(actor: AuthenticatedWorkspaceActor): Promise<ProjectSkill[]> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    const session = await this.session(resolved.principal);
    const bound = await this.boundSelection(session, resolved.principal);
    return intents.listSkills(bound.scope, bound.project.id);
  }

  async skillForApply(
    actor: AuthenticatedWorkspaceActor,
    nameOrId: string,
  ): Promise<ProjectSkillVersion> {
    const intents = this.requireProjectIntents();
    const resolved = await this.resolveActor(actor);
    const session = await this.session(resolved.principal);
    const bound = await this.boundSelection(session, resolved.principal);
    return intents.skillForApply(bound.scope, bound.project.id, nameOrId);
  }

  async startCodingWithSkill(
    actor: AuthenticatedWorkspaceActor,
    nameOrId: string,
    requestInput: string,
    listener?: CodingRunProgressListener,
  ): Promise<PrivateCodingRunHandle> {
    const skill = await this.skillForApply(actor, nameOrId);
    const request = taskText(requestInput);
    const skillContext = [
      `Gunakan skill deklaratif \"${skill.name}\" versi ${skill.version}.`,
      `Tujuan skill: ${skill.description}`,
      ...skill.preconditions.map((item) => `Precondition: ${item}`),
      ...skill.steps.map((item, index) => `Langkah ${index + 1}: ${item}`),
      ...skill.verification.map((item) => `Verifikasi: ${item}`),
      "Skill ini tidak memberi izin atau capability baru; gunakan hanya tool runtime yang tersedia.",
    ].join("\n");
    return this.startCoding(actor, `${request}\n\n${skillContext}`, listener);
  }

  async startCoding(
    actor: AuthenticatedWorkspaceActor,
    requestInput: string,
    listener?: CodingRunProgressListener,
  ): Promise<PrivateCodingRunHandle> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    const request = taskText(requestInput);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      assertNoForeground(session);
      const bound = await this.boundSelection(session, resolved.principal);
      const goal = await this.projectIntents?.goal(
        bound.scope,
        bound.project.id,
      ) ?? null;
      if (goal?.status === "blocked") {
        throw new Error("ProjectGoal masih mempunyai blocker terbuka.");
      }
      if (goal?.status === "completed" || goal?.status === "cancelled") {
        throw new Error("ProjectGoal sudah terminal; perbarui tujuan sebelum CodingRun baru.");
      }
      const brief: CodingTaskBrief = {
        request,
        objective: goal?.objective ?? request,
        acceptanceCriteria: goal
          ? goal.acceptanceCriteria.map((criterion) => criterion.text)
          : [
              "Perubahan memenuhi permintaan dan seluruh validator code-owned terbaru lulus.",
              "Diff task-level ditinjau dan perubahan tidak terkait diminimalkan.",
            ],
        initialConstraints: [
          "Jangan mengubah public API kecuali permintaan membutuhkannya secara eksplisit.",
          ...(goal
            ? [
                `Pertahankan ProjectGoal ${goal.goalId} revision ${goal.revision}; jangan menyatakan selesai tanpa evidence untuk setiap criterion.`,
              ]
            : []),
        ],
      };
      const created = await this.controller.createCodingRun(actor, {
        workspaceKey: bound.scope.workspaceKey,
        projectId: bound.project.id,
        expectedProjectRevision: bound.project.revision,
        brief,
      });
      if (goal) {
        await this.projectIntents!.startMilestone(bound.scope, bound.project.id);
      }
      await this.saveSession(session, {
        workspaceKey: bound.scope.workspaceKey,
        projectId: bound.project.id,
        projectRevision: bound.project.revision,
        foregroundRunId: created.runId,
        lastRunId: created.runId,
      });
      const run = await this.requireRun(bound.scope, created.runId);
      const unsubscribe = listener
        ? this.progress.subscribe(created.runId, listener)
        : () => undefined;
      if (listener) await listener(structuredClone(run));
      const entry = activeDrive();
      entry.completion = this.#drive(
        resolved.principal,
        bound.scope,
        created.runId,
        entry,
      ).finally(() => {
        if (this.#active.get(created.runId) === entry) {
          this.#active.delete(created.runId);
        }
      });
      entry.completion.catch(() => undefined);
      this.#active.set(created.runId, entry);
      return {
        runId: created.runId,
        initialAnchor: renderCodingRunAnchor(run),
        completion: entry.completion,
        unsubscribeProgress: unsubscribe,
      };
    });
  }

  async revise(
    actor: AuthenticatedWorkspaceActor,
    input: {
      sourceMessageId: string;
      content: string;
      kind?: "constraint" | "correction" | "scope_change";
    },
    listener?: CodingRunProgressListener,
  ): Promise<PrivateCodingRunHandle> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      if (!session.workspaceKey || !session.foregroundRunId) {
        throw new Error("Tidak ada CodingRun foreground untuk direvisi.");
      }
      const scope = await this.requireScope(session.workspaceKey, resolved.principal);
      const revised = await this.runs.revise(scope, session.foregroundRunId, {
        sourceMessageId: taskText(input.sourceMessageId, 512),
        kind: input.kind ?? "constraint",
        content: taskText(input.content),
      });
      await this.progress.report(revised);
      let entry = this.#active.get(revised.runId);
      if (entry) {
        entry.restartRequested = true;
      } else {
        entry = activeDrive(true);
        entry.completion = this.#drive(
          resolved.principal,
          scope,
          revised.runId,
          entry,
        ).finally(() => {
          if (this.#active.get(revised.runId) === entry) {
            this.#active.delete(revised.runId);
          }
        });
        entry.completion.catch(() => undefined);
        this.#active.set(revised.runId, entry);
      }
      const unsubscribe = listener
        ? this.progress.subscribe(revised.runId, listener)
        : () => undefined;
      return {
        runId: revised.runId,
        initialAnchor: renderCodingRunAnchor(revised),
        completion: entry.completion,
        unsubscribeProgress: unsubscribe,
      };
    });
  }

  async cancel(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<CodingRun> {
    this.assertAdmission();
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const session = await this.session(resolved.principal);
      if (!session.workspaceKey || !session.foregroundRunId) {
        throw new Error("Tidak ada CodingRun foreground untuk dibatalkan.");
      }
      const scope = await this.requireScope(session.workspaceKey, resolved.principal);
      const entry = this.#active.get(session.foregroundRunId);
      if (entry) entry.cancelRequested = true;
      try {
        await this.scheduler.interrupt(scope, session.foregroundRunId);
        const current = await this.requireRun(scope, session.foregroundRunId);
        const cancelled = terminal(current)
          ? current
          : await this.runs.cancel(scope, session.foregroundRunId);
        if (entry) entry.cancelledRun = cancelled;
        await this.progress.report(cancelled);
        await this.saveSession(session, {
          workspaceKey: session.workspaceKey,
          projectId: session.projectId,
          projectRevision: session.projectRevision,
          foregroundRunId: null,
          lastRunId: session.foregroundRunId,
        });
        return cancelled;
      } finally {
        entry?.settleCancellation();
      }
    });
  }

  async current(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<{ selection: PrivateCodingSelectionView; run: CodingRun | null }> {
    const resolved = await this.resolveActor(actor);
    const session = await this.session(resolved.principal);
    if (!session.workspaceKey || !session.foregroundRunId) {
      return { selection: selection(session), run: null };
    }
    const scope = await this.requireScope(session.workspaceKey, resolved.principal);
    return {
      selection: selection(session),
      run: await this.runs.get(scope, session.foregroundRunId),
    };
  }

  async recoverDurableRuns(): Promise<void> {
    this.assertAdmission();
    for (const session of await this.sessions.list()) {
      if (!session.workspaceKey || !session.foregroundRunId) continue;
      const principal: WorkspacePrincipal = {
        channel: session.channel,
        principalKey: session.principalKey,
      };
      const scope = await this.requireScope(session.workspaceKey, principal);
      let run = await this.requireRun(scope, session.foregroundRunId);
      if (run.pendingCommit) {
        run = await this.runs.recoverPendingCommit(scope, run.runId);
        await this.progress.report(run);
        if (run.pendingCommit) {
          throw new Error("Pending CodingRun commit belum dapat direkonsiliasi.");
        }
      }
      if (terminal(run)) {
        await this.finish(principal, scope, run, null);
        continue;
      }
      if (run.status === "waiting_input") continue;
      if (this.#active.has(run.runId)) continue;
      const entry = activeDrive();
      entry.completion = this.#drive(principal, scope, run.runId, entry)
        .finally(() => {
          if (this.#active.get(run.runId) === entry) this.#active.delete(run.runId);
        });
      entry.completion.catch(() => undefined);
      this.#active.set(run.runId, entry);
    }
  }

  async #drive(
    principal: WorkspacePrincipal,
    initialScope: WorkspaceAgentScope,
    runId: string,
    entry: ActiveDrive,
  ): Promise<PrivateCodingRunOutcome> {
    let scope = initialScope;
    let stoppedReason: string | null = null;
    while (this.#state === "accepting") {
      scope = await this.requireScope(scope.workspaceKey, principal);
      let run = await this.requireRun(scope, runId);
      if (terminal(run)) return this.finish(principal, scope, run, null);
      try {
        const result = await this.scheduler.advance(scope, {
          runId,
          expectedStateRevision: run.stateRevision,
        });
        run = result.run;
        await this.progress.report(run);
        if (terminal(run)) return this.finish(principal, scope, run, null);
        if (result.outcome === "yielded") {
          stoppedReason = result.reasonCode;
          break;
        }
        if (result.outcome === "action_budget") {
          if (
            run.counters.coordinatorDecisions >=
            run.limits.maxCoordinatorDecisions
          ) {
            stoppedReason = "cumulative_decision_budget";
            break;
          }
          await nextTurn();
          continue;
        }
      } catch (error) {
        await nextTurn();
        run = await this.requireRun(scope, runId);
        if (entry.cancelRequested) {
          await entry.cancellationSettled;
          run = entry.cancelledRun ?? await this.requireRun(scope, runId);
          return this.finish(principal, scope, run, "cancelled");
        }
        if (entry.restartRequested && !terminal(run)) {
          entry.restartRequested = false;
          continue;
        }
        if (terminal(run)) return this.finish(principal, scope, run, null);
        stoppedReason = safeErrorCode(error);
        break;
      }
    }
    if (this.#state !== "accepting") stoppedReason ??= "runtime_stopping";
    const run = await this.requireRun(scope, runId);
    return this.finish(principal, scope, run, stoppedReason);
  }

  async finish(
    principal: WorkspacePrincipal,
    scope: WorkspaceAgentScope,
    run: CodingRun,
    stoppedReason: string | null,
  ): Promise<PrivateCodingRunOutcome> {
    let localCommit: LocalGitCommitResult | null = null;
    let projectRevision: number | null = run.result?.projectRevision ?? null;
    if (run.status === "completed" && run.result) {
      const project = await this.projects.get(scope, run.binding.projectId);
      const existing = project?.localGitCommitReceipts?.find((receipt) =>
        receipt.sourceRevision === run.result!.projectRevision &&
        receipt.snapshotId === run.result!.snapshotId
      );
      if (project && existing) {
        localCommit = {
          operationId: existing.operationId,
          projectId: project.id,
          snapshotId: existing.snapshotId,
          sourceWorkspaceRevision: existing.sourceRevision,
          branch: existing.branch,
          parentCommit: existing.parentCommit,
          commit: existing.commit,
          treeHash: existing.treeHash,
          objectBundle: structuredClone(existing.objectBundle),
          authorName: existing.authorName,
          authorEmail: existing.authorEmail,
          committedAt: existing.committedAt,
        };
        projectRevision = project.revision;
      } else {
        try {
          const committed = await this.localGit.commit(
            scope,
            run.binding.projectId,
            run.result.projectRevision,
          );
          localCommit = committed.receipt;
          projectRevision = committed.projectRevision;
        } catch {
          stoppedReason ??= "local_git_commit_failed";
        }
      }
    }
    if (run.status === "completed" && localCommit && this.projectIntents) {
      try {
        const goal = await this.projectIntents.goal(
          scope,
          run.binding.projectId,
        );
        if (goal) {
          await this.projectIntents.recordEvidence(
            scope,
            run.binding.projectId,
            {
              ref: `coding-run:${run.runId}`,
              kind: "coding_run",
              summary:
                `CodingRun selesai pada project revision ${projectRevision ?? run.result?.projectRevision ?? "unknown"}; validator code-owned dan local Git commit tersedia.`,
              satisfyKinds: ["code"],
            },
          );
        }
      } catch {
        stoppedReason ??= "project_goal_evidence_failed";
      }
    }
    await this.exclusive(principal.principalKey, async () => {
      const session = await this.session(principal);
      if (session.foregroundRunId === run.runId) {
        await this.saveSession(session, {
          workspaceKey: session.workspaceKey,
          projectId: session.projectId,
          projectRevision: projectRevision ?? session.projectRevision,
          foregroundRunId: terminal(run) ? null : run.runId,
          lastRunId: run.runId,
        });
      }
    });
    return {
      run,
      anchor: renderCodingRunAnchor(run),
      localCommit,
      projectRevision,
      stoppedReason,
    };
  }

  async boundSelection(
    session: PrivateCodingSession,
    principal: WorkspacePrincipal,
  ): Promise<{ scope: WorkspaceAgentScope; project: ProjectWorkspace }> {
    if (!session.workspaceKey || !session.projectId || !session.projectRevision) {
      throw new Error("Pilih atau upload project lebih dulu.");
    }
    const scope = await this.requireScope(session.workspaceKey, principal);
    const project = await this.projects.get(scope, session.projectId);
    if (!project || project.revision !== session.projectRevision) {
      throw new Error("Project selection sudah basi; pilih ulang project.");
    }
    return { scope, project };
  }

  async requireScope(
    workspaceKey: string,
    principal: WorkspacePrincipal,
  ): Promise<WorkspaceAgentScope> {
    const scope = await this.authority.resolveScope(workspaceKey, principal);
    if (!scope) throw new Error("Authority workspace sudah berubah atau dicabut.");
    return scope;
  }

  async requireGroupLinkRequest(
    requestId: string,
  ): Promise<GroupWorkspaceLinkRequest> {
    const request = await this.groupCodingRepository?.loadLinkRequest(requestId);
    if (!request) throw new Error("Request link grup tidak ditemukan.");
    return request;
  }

  async requireRun(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun> {
    const run = await this.runs.get(scope, runId);
    if (!run) throw new Error("CodingRun tidak ditemukan.");
    return run;
  }

  private requireProjectIntents(): ProjectIntentService {
    if (!this.projectIntents) {
      throw new Error("ProjectGoal dan skill belum dikonfigurasi pada runtime coding.");
    }
    return this.projectIntents;
  }

  async resolveActor(actor: AuthenticatedWorkspaceActor) {
    const resolved = await this.actors.resolve(actor);
    if (!resolved || resolved.audience !== "workspace-private") {
      throw new Error("Actor private coding tidak sah.");
    }
    return resolved;
  }

  async session(principal: WorkspacePrincipal): Promise<PrivateCodingSession> {
    const existing = await this.sessions.load(principal.principalKey);
    if (existing) return existing;
    return this.sessions.save({
      version: 1,
      principalKey: principal.principalKey,
      channel: principal.channel,
      workspaceKey: null,
      projectId: null,
      projectRevision: null,
      foregroundRunId: null,
      lastRunId: null,
      updatedAt: this.now().toISOString(),
    }, null);
  }

  saveSession(
    current: PrivateCodingSession,
    selectionInput: Omit<PrivateCodingSelectionView, never>,
  ): Promise<PrivateCodingSession> {
    return this.sessions.save({
      version: 1,
      principalKey: current.principalKey,
      channel: current.channel,
      ...selectionInput,
      updatedAt: this.now().toISOString(),
    }, current.revision);
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    this.#queues.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }

  private assertAdmission(): void {
    if (this.#state !== "accepting") {
      throw new Error("Private coding admission belum dibuka atau sedang dihentikan.");
    }
  }
}

function groupLinkRequestId(value: string): string {
  const clean = value.trim();
  if (!/^group-link-request-[A-Za-z0-9._:-]{3,256}$/u.test(clean)) {
    throw new Error("Kode konfirmasi link grup tidak sah.");
  }
  return clean;
}

function withoutGroupLinkRequestRevision(
  request: GroupWorkspaceLinkRequest,
): Omit<GroupWorkspaceLinkRequest, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = request;
  return rest;
}

function assertApprovedRequestOwner(
  request: GroupWorkspaceLinkRequest,
  scope: WorkspaceAgentScope,
): void {
  if (
    (request.status !== "approved" && request.status !== "consumed") ||
    request.workspaceKey !== scope.workspaceKey ||
    request.approvedByMembershipId !== scope.membershipId ||
    request.grantedMembershipId === null || request.approvedAclEpoch === null
  ) throw new Error("Approval link grup tidak cocok Workspace-private actor.");
}

function selection(session: PrivateCodingSession): PrivateCodingSelectionView {
  return {
    workspaceKey: session.workspaceKey,
    projectId: session.projectId,
    projectRevision: session.projectRevision,
    foregroundRunId: session.foregroundRunId,
    lastRunId: session.lastRunId,
  };
}

function terminal(run: CodingRun): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function assertNoForeground(session: PrivateCodingSession): void {
  if (session.foregroundRunId !== null) {
    throw new Error("Selesaikan atau batalkan CodingRun foreground sebelum mengganti project.");
  }
}

function taskText(value: string, maximum = 8_000): string {
  const clean = value.trim();
  if (
    !clean || clean.length > maximum || /\p{Cc}/u.test(clean) ||
    containsSecretLikeValue(clean)
  ) throw new Error("Teks private coding tidak sah atau credential-like.");
  return clean;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "coding_runtime_error";
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function activeDrive(restartRequested = false): ActiveDrive {
  let settled = false;
  let settle!: () => void;
  const cancellationSettled = new Promise<void>((resolve) => { settle = resolve; });
  return {
    restartRequested,
    cancelRequested: false,
    cancelledRun: null,
    cancellationSettled,
    settleCancellation() {
      if (settled) return;
      settled = true;
      settle();
    },
    completion: Promise.resolve(null as never),
  };
}
