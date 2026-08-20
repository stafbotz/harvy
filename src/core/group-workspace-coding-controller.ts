import { createHash, randomUUID } from "node:crypto";
import type {
  CodingRun,
  CodingRunAdmission,
  CodingRunStartOptions,
  CodingTaskBrief,
} from "../domain/coding-run.js";
import type {
  GroupCodingRepository,
  GroupCodingRunReference,
  GroupSafeCodingRunView,
  GroupSafePublishOffer,
  GroupWorkspaceLink,
  GroupWorkspaceLinkRequest,
} from "../domain/group-coding.js";
import { renderGroupSafeCodingRun } from "../domain/group-coding.js";
import { groupScopeKey, type GroupBinding, type GroupScope } from "../domain/group.js";
import type { WorkspacePermission, WorkspacePrincipal } from "../domain/workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type { GroupAuthoritySnapshot } from "./group-authority-policy.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";

/** Opaque ingress-owned handle. Command bodies can never manufacture one. */
export interface AuthenticatedGroupCodingActor {
  readonly __groupCodingActorHandle: unique symbol;
}

export interface ResolvedGroupCodingActor {
  audience: "group";
  interactionId: string;
  principal: WorkspacePrincipal;
  scope: GroupScope;
  accountId: string;
  participantIds: readonly string[];
  claimedAdmin: boolean;
  claimedAuthorityEpoch: number;
}

export interface GroupCodingActorResolver {
  resolve(
    actor: AuthenticatedGroupCodingActor,
  ): Promise<ResolvedGroupCodingActor | null>;
}

export interface GroupCodingAuthorityExpectation {
  scope: GroupScope;
  accountId: string;
  participantIds: readonly string[];
  claimedAdmin: boolean;
  claimedAuthorityEpoch: number;
  minimumRole: "member" | "admin";
}

/**
 * Trust-domain lease, not a snapshot-only lookup. Membership removal, account
 * unbinding, or authority-epoch mutation must share this guard and wait until
 * the callback settles. A deployment without this primitive must not install
 * group coding.
 */
export interface GroupCodingAuthorityGuard {
  withCurrentActor<T>(
    expectation: GroupCodingAuthorityExpectation,
    operation: (authority: GroupAuthoritySnapshot) => Promise<T>,
  ): Promise<T>;
}

export const DENY_GROUP_CODING_AUTHORITY_GUARD: GroupCodingAuthorityGuard = {
  withCurrentActor: async () => {
    throw new GroupWorkspaceCodingError(
      "group_coding_authority_unavailable",
      "Guard authority group-coding belum tersedia.",
    );
  },
};

export interface GroupRuntimeBindingReader {
  binding(scopeKey: string): Promise<GroupBinding | null>;
}

export interface GroupCodingRunCreator {
  start(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedWorkspaceRevision: number,
    brief: CodingTaskBrief,
    options?: CodingRunStartOptions,
  ): Promise<CodingRun>;
  /** Called only after the durable group/run reference is committed. */
  schedule?(scope: WorkspaceAgentScope, run: CodingRun): void;
}

export interface GroupCodingRunReader {
  get(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null>;
}

export interface GroupCodingRunMutator {
  revise(
    scope: WorkspaceAgentScope,
    runId: string,
    input: {
      sourceMessageId: string;
      kind: "constraint" | "correction" | "scope_change";
      content: string;
    },
  ): Promise<CodingRun>;
  cancel(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun>;
  /** Quiesces an in-flight coordinator invocation before a revision/cancel. */
  interrupt?(scope: WorkspaceAgentScope, runId: string): Promise<void>;
}

export interface GroupCodingProjectCatalog {
  list(scope: WorkspaceAgentScope): Promise<Array<{ id: string; revision: number }>>;
}

export interface GroupCodingLinkView {
  audience: "group-safe";
  status: "linked" | "unlinked" | "workspace-private-confirmation-required";
  text: string;
}

type GroupWorkspaceLinkAttempt =
  | { status: "linked"; link: GroupWorkspaceLink }
  | {
      status: "workspace-private-confirmation-required";
      request: GroupWorkspaceLinkRequest;
    };

export interface CreateGroupCodingRunCommand {
  projectId: string;
  expectedProjectRevision: number;
  brief: CodingTaskBrief;
}

export interface GetGroupCodingRunCommand {
  runId: string;
}

export interface RequestGroupCodingPublishCommand {
  runId: string;
  action: GroupSafePublishOffer["action"];
}

export interface ReviseGroupCodingRunCommand {
  runId: string;
  sourceMessageId: string;
  kind: "constraint" | "correction" | "scope_change";
  content: string;
}

export interface CancelGroupCodingRunCommand {
  runId: string;
}

interface LinkedActorContext {
  actor: ResolvedGroupCodingActor;
  authority: GroupAuthoritySnapshot;
  link: GroupWorkspaceLink;
  scope: WorkspaceAgentScope;
}

/** Owns the intersection of live group and live Workspace authority. */
export class GroupWorkspaceLinkService {
  constructor(
    private readonly repository: GroupCodingRepository,
    private readonly bindings: GroupRuntimeBindingReader,
    private readonly authorityGuard: GroupCodingAuthorityGuard,
    private readonly workspaceAuthority: WorkspaceAuthorityService,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async linkWorkspace(
    actorInput: ResolvedGroupCodingActor,
    workspaceKeyInput: string,
  ): Promise<GroupWorkspaceLink> {
    const actor = validateResolvedActor(actorInput);
    const workspaceKey = safeKey(workspaceKeyInput, "workspaceKey");
    return this.authorityGuard.withCurrentActor(
      authorityExpectation(actor, "admin"),
      async (authority) => {
        assertCurrentGroupAuthority(actor, authority, "admin");
        const binding = await this.currentBinding(actor);
        return this.linkCurrent(actor, authority, binding, workspaceKey);
      },
    );
  }

  /** Group-safe UX: never print or ask the room for a Workspace identifier. */
  async linkOnlyWorkspace(
    actorInput: ResolvedGroupCodingActor,
  ): Promise<GroupWorkspaceLink> {
    const result = await this.linkOrRequestWorkspace(actorInput);
    if (result.status === "linked") return result.link;
    throw new GroupWorkspaceCodingError(
      "group_workspace_selection_required",
      "Konfirmasi Workspace melalui jalur privat sebelum menghubungkan grup.",
    );
  }

  async linkOrRequestWorkspace(
    actorInput: ResolvedGroupCodingActor,
  ): Promise<GroupWorkspaceLinkAttempt> {
    const actor = validateResolvedActor(actorInput);
    return this.authorityGuard.withCurrentActor(
      authorityExpectation(actor, "admin"),
      async (authority) => {
        assertCurrentGroupAuthority(actor, authority, "admin");
        const binding = await this.currentBinding(actor);
        const active = await this.repository.loadLink(
          groupScopeKey(actor.scope),
          actor.accountId,
        );
        if (
          active?.status === "active" &&
          active.groupJoinedAt === binding.joinedAt
        ) return { status: "linked" as const, link: active };
        const accessible = await this.workspaceAuthority.listWorkspaces(actor.principal);
        const manageable = [];
        for (const candidate of accessible) {
          if (await this.workspaceAuthority.authorize(candidate.scope, "workspace.manage")) {
            manageable.push(candidate);
          }
        }
        if (manageable.length === 1) {
          return {
            status: "linked" as const,
            link: await this.linkCurrent(
              actor,
              authority,
              binding,
              manageable[0]!.workspace.workspaceKey,
            ),
          };
        }
        const requests = (await this.repository.listLinkRequests())
          .filter((request) =>
            request.scopeKey === groupScopeKey(actor.scope) &&
            request.accountId === actor.accountId &&
            request.groupJoinedAt === binding.joinedAt &&
            request.participantPrincipal.principalKey === actor.principal.principalKey &&
            request.participantPrincipal.channel === actor.principal.channel
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const approved = requests.find((request) => request.status === "approved");
        if (approved) {
          return {
            status: "linked" as const,
            link: await this.linkApprovedCurrent(
              actor,
              authority,
              binding,
              approved,
            ),
          };
        }
        const pending = requests.find((request) =>
          request.status === "pending" || request.status === "approving"
        );
        if (pending && (
          pending.status === "approving" ||
          this.now().getTime() < Date.parse(pending.expiresAt)
        )) {
          return {
            status: "workspace-private-confirmation-required" as const,
            request: pending,
          };
        }
        if (pending?.status === "pending") {
          await this.repository.saveLinkRequest({
            ...withoutRequestRevision(pending),
            status: "expired",
            updatedAt: this.now().toISOString(),
          }, pending.stateRevision);
        }
        const at = this.now();
        const requestInput: Omit<GroupWorkspaceLinkRequest, "stateRevision"> = {
          version: 1,
          requestId: `group-link-request-${safeKey(this.makeId(), "requestId")}`,
          scopeKey: groupScopeKey(actor.scope),
          scope: structuredClone(actor.scope),
          accountId: actor.accountId,
          groupJoinedAt: binding.joinedAt,
          participantPrincipal: structuredClone(actor.principal),
          requestedByParticipantId: actor.participantIds[0]!,
          requestedAtAuthorityEpoch: authority.authorityEpoch,
          status: "pending",
          workspaceKey: null,
          grantedMembershipId: null,
          approvedByMembershipId: null,
          approvedAclEpoch: null,
          createdAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + 15 * 60_000).toISOString(),
          approvedAt: null,
          consumedAt: null,
          revokedAt: null,
          updatedAt: at.toISOString(),
        };
        const saved = await this.repository.saveLinkRequest(requestInput, null);
        if (saved.status !== "saved") {
          throw new GroupWorkspaceCodingError(
            "group_workspace_link_conflict",
            "Request link Workspace berubah bersamaan.",
          );
        }
        return {
          status: "workspace-private-confirmation-required" as const,
          request: saved.request,
        };
      },
    );
  }

  async unlinkWorkspace(
    actorInput: ResolvedGroupCodingActor,
  ): Promise<GroupWorkspaceLink> {
    const actor = validateResolvedActor(actorInput);
    return this.authorityGuard.withCurrentActor(
      authorityExpectation(actor, "admin"),
      async (authority) => {
        assertCurrentGroupAuthority(actor, authority, "admin");
        const current = await this.requireActiveLink(actor);
        const workspaceScope = await this.resolveWorkspaceScope(
          current.workspaceKey,
          actor.principal,
        );
        return this.workspaceAuthority.withPermission(
          workspaceScope,
          "workspace.manage",
          async () => {
            await this.requireActiveLink(actor, current);
            const at = this.now().toISOString();
            const saved = await this.repository.saveLink({
              ...withoutLinkRevision(current),
              status: "revoked",
              updatedAt: at,
              revokedAt: at,
            }, current.stateRevision);
            if (saved.status !== "saved") {
              throw new GroupWorkspaceCodingError(
                "group_workspace_link_conflict",
                "Link Workspace berubah bersamaan.",
              );
            }
            return saved.link;
          },
        );
      },
    );
  }

  async withLinkedPermissions<T>(
    actorInput: ResolvedGroupCodingActor,
    permissions: readonly WorkspacePermission[],
    operation: (context: LinkedActorContext) => Promise<T>,
  ): Promise<T> {
    const actor = validateResolvedActor(actorInput);
    const required = [...new Set(permissions)];
    if (required.length < 1) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Operasi group-coding tidak mempunyai permission Workspace.",
      );
    }
    return this.authorityGuard.withCurrentActor(
      authorityExpectation(actor, "member"),
      async (authority) => {
        assertCurrentGroupAuthority(actor, authority, "member");
        const link = await this.requireActiveLink(actor);
        const scope = await this.resolveWorkspaceScope(link.workspaceKey, actor.principal);
        return this.workspaceAuthority.withPermissions(scope, required, async () => {
          const current = await this.requireActiveLink(actor, link);
          return operation({ actor, authority, link: current, scope });
        });
      },
    );
  }

  private async currentBinding(actor: ResolvedGroupCodingActor): Promise<GroupBinding> {
    const binding = await this.bindings.binding(groupScopeKey(actor.scope));
    if (
      !binding || binding.disabledAt !== null || binding.accountId !== actor.accountId ||
      binding.channel !== actor.scope.channel || binding.groupId !== actor.scope.groupId
    ) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Binding grup tidak aktif atau bukan milik akun ini.",
      );
    }
    return binding;
  }

  private async linkCurrent(
    actor: ResolvedGroupCodingActor,
    authority: GroupAuthoritySnapshot,
    binding: GroupBinding,
    workspaceKey: string,
  ): Promise<GroupWorkspaceLink> {
    const workspaceScope = await this.resolveWorkspaceScope(workspaceKey, actor.principal);
    return this.workspaceAuthority.withPermission(
      workspaceScope,
      "workspace.manage",
      async () => {
        await this.assertBindingStillCurrent(actor, binding);
        const existing = await this.repository.loadLink(
          groupScopeKey(actor.scope),
          actor.accountId,
        );
        if (existing) {
          if (
            existing.status === "active" &&
            existing.workspaceKey === workspaceKey &&
            existing.groupJoinedAt === binding.joinedAt
          ) return existing;
          if (existing.status === "active" && existing.groupJoinedAt === binding.joinedAt) {
            throw new GroupWorkspaceCodingError(
              "group_workspace_link_conflict",
              "Generation grup ini sudah mempunyai link Workspace lain.",
            );
          }
        }
        const at = this.now().toISOString();
        const saved = await this.repository.saveLink({
          version: 1,
          linkId: `group-workspace-link-${safeKey(this.makeId(), "linkId")}`,
          scopeKey: groupScopeKey(actor.scope),
          scope: structuredClone(actor.scope),
          accountId: actor.accountId,
          groupJoinedAt: binding.joinedAt,
          workspaceKey,
          linkedByMembershipId: workspaceScope.membershipId,
          linkedByParticipantId: actor.participantIds[0]!,
          linkedAtAuthorityEpoch: authority.authorityEpoch,
          status: "active",
          createdAt: at,
          updatedAt: at,
          revokedAt: null,
        }, existing?.stateRevision ?? null);
        if (saved.status !== "saved") {
          throw new GroupWorkspaceCodingError(
            "group_workspace_link_conflict",
            "Link Workspace berubah bersamaan.",
          );
        }
        return saved.link;
      },
    );
  }

  private async linkApprovedCurrent(
    actor: ResolvedGroupCodingActor,
    authority: GroupAuthoritySnapshot,
    binding: GroupBinding,
    request: GroupWorkspaceLinkRequest,
  ): Promise<GroupWorkspaceLink> {
    if (
      request.status !== "approved" || request.workspaceKey === null ||
      request.grantedMembershipId === null || request.approvedAclEpoch === null ||
      request.participantPrincipal.principalKey !== actor.principal.principalKey ||
      request.scopeKey !== groupScopeKey(actor.scope) ||
      request.accountId !== actor.accountId || request.groupJoinedAt !== binding.joinedAt
    ) throw new GroupWorkspaceCodingError(
      "group_coding_access_denied",
      "Approval privat link Workspace tidak cocok actor atau generation grup.",
    );
    const workspaceScope = await this.resolveWorkspaceScope(
      request.workspaceKey,
      actor.principal,
    );
    if (
      workspaceScope.membershipId !== request.grantedMembershipId ||
      workspaceScope.role !== "admin" ||
      workspaceScope.aclEpoch !== request.approvedAclEpoch
    ) throw new GroupWorkspaceCodingError(
      "group_coding_access_denied",
      "Approval privat link Workspace basi setelah perubahan ACL.",
    );
    await this.assertBindingStillCurrent(actor, binding);
    const existing = await this.repository.loadLink(
      groupScopeKey(actor.scope),
      actor.accountId,
    );
    if (existing?.status === "active" && existing.groupJoinedAt === binding.joinedAt) {
      return existing;
    }
    const at = this.now().toISOString();
    const saved = await this.repository.saveLink({
      version: 1,
      linkId: `group-workspace-link-${safeKey(this.makeId(), "linkId")}`,
      scopeKey: groupScopeKey(actor.scope),
      scope: structuredClone(actor.scope),
      accountId: actor.accountId,
      groupJoinedAt: binding.joinedAt,
      workspaceKey: request.workspaceKey,
      linkedByMembershipId: workspaceScope.membershipId,
      linkedByParticipantId: actor.participantIds[0]!,
      linkedAtAuthorityEpoch: authority.authorityEpoch,
      status: "active",
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
    }, existing?.stateRevision ?? null);
    if (saved.status !== "saved") {
      throw new GroupWorkspaceCodingError(
        "group_workspace_link_conflict",
        "Link Workspace berubah bersamaan setelah approval privat.",
      );
    }
    const currentRequest = await this.repository.loadLinkRequest(request.requestId);
    if (currentRequest?.status === "approved") {
      await this.repository.saveLinkRequest({
        ...withoutRequestRevision(currentRequest),
        status: "consumed",
        consumedAt: at,
        updatedAt: at,
      }, currentRequest.stateRevision).catch(() => undefined);
    }
    return saved.link;
  }

  private async assertBindingStillCurrent(
    actor: ResolvedGroupCodingActor,
    expected: GroupBinding,
  ): Promise<void> {
    const current = await this.currentBinding(actor);
    if (current.joinedAt !== expected.joinedAt) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Generation binding grup berubah.",
      );
    }
  }

  private async requireActiveLink(
    actor: ResolvedGroupCodingActor,
    expected?: GroupWorkspaceLink,
  ): Promise<GroupWorkspaceLink> {
    const binding = await this.currentBinding(actor);
    const link = await this.repository.loadLink(
      groupScopeKey(actor.scope),
      actor.accountId,
    );
    if (
      !link || link.status !== "active" ||
      link.scopeKey !== groupScopeKey(actor.scope) ||
      link.groupJoinedAt !== binding.joinedAt ||
      (expected && (
        link.linkId !== expected.linkId ||
        link.stateRevision !== expected.stateRevision ||
        link.workspaceKey !== expected.workspaceKey
      ))
    ) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Grup tidak mempunyai link Workspace aktif yang sesuai.",
      );
    }
    return link;
  }

  private async resolveWorkspaceScope(
    workspaceKey: string,
    principal: WorkspacePrincipal,
  ): Promise<WorkspaceAgentScope> {
    const scope = await this.workspaceAuthority.resolveScope(workspaceKey, principal);
    if (!scope) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Actor grup tidak mempunyai membership Workspace aktif.",
      );
    }
    return scope;
  }
}

/** Group surface: only link controls and sanitized CodingRun projections. */
export class GroupWorkspaceCodingController {
  constructor(
    private readonly actors: GroupCodingActorResolver,
    private readonly links: GroupWorkspaceLinkService,
    private readonly repository: GroupCodingRepository,
    private readonly codingRuns:
      GroupCodingRunCreator & GroupCodingRunReader & Partial<GroupCodingRunMutator>,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
    private readonly projects: GroupCodingProjectCatalog | null = null,
  ) {}

  async linkWorkspace(
    actorHandle: AuthenticatedGroupCodingActor,
    command: { workspaceKey: string },
  ): Promise<GroupCodingLinkView> {
    assertExactKeys(command, ["workspaceKey"], "link command");
    const actor = await this.resolveActor(actorHandle);
    await this.links.linkWorkspace(actor, safeKey(command.workspaceKey, "workspaceKey"));
    return Object.freeze({
      audience: "group-safe",
      status: "linked",
      text: "Grup ini sudah terhubung ke Workspace. Izin setiap anggota tetap diperiksa per aksi.",
    });
  }

  async linkOnlyWorkspace(
    actorHandle: AuthenticatedGroupCodingActor,
    command: Record<string, never>,
  ): Promise<GroupCodingLinkView> {
    assertExactKeys(command, [], "link-only command");
    const actor = await this.resolveActor(actorHandle);
    const result = await this.links.linkOrRequestWorkspace(actor);
    if (result.status === "workspace-private-confirmation-required") {
      return Object.freeze({
        audience: "group-safe" as const,
        status: "workspace-private-confirmation-required" as const,
        text: [
          "Link Workspace perlu konfirmasi di chat privat Harvy.",
          `Kode konfirmasi: ${result.request.requestId}`,
          "Di Telegram privat, pilih Workspace lalu gunakan /project group-confirm <kode>.",
          "Setelah dikonfirmasi, ulangi @Harvy hubungkan workspace di grup ini.",
        ].join("\n"),
      });
    }
    return Object.freeze({
      audience: "group-safe",
      status: "linked",
      text: "Grup ini sudah terhubung ke Workspace. Izin setiap anggota tetap diperiksa per aksi.",
    });
  }

  async unlinkWorkspace(
    actorHandle: AuthenticatedGroupCodingActor,
    command: Record<string, never>,
  ): Promise<GroupCodingLinkView> {
    assertExactKeys(command, [], "unlink command");
    const actor = await this.resolveActor(actorHandle);
    await this.links.unlinkWorkspace(actor);
    return Object.freeze({
      audience: "group-safe",
      status: "unlinked",
      text: "Link Workspace grup sudah dicabut. CodingRun yang ada tidak dipublikasikan ke grup.",
    });
  }

  async createCodingRun(
    actorHandle: AuthenticatedGroupCodingActor,
    command: CreateGroupCodingRunCommand,
  ): Promise<GroupSafeCodingRunView> {
    assertExactKeys(
      command,
      ["projectId", "expectedProjectRevision", "brief"],
      "create group CodingRun command",
    );
    const projectId = safeKey(command.projectId, "projectId");
    if (
      !Number.isSafeInteger(command.expectedProjectRevision) ||
      command.expectedProjectRevision < 1
    ) throw invalidCommand("Expected project revision group-coding tidak sah.");
    const brief = validateTaskBrief(command.brief);
    const actor = await this.resolveActor(actorHandle);
    return this.links.withLinkedPermissions(
      actor,
      ["run.create", "code.read", "code.write"],
      (context) => this.startCodingRun(
        context,
        actor,
        projectId,
        command.expectedProjectRevision,
        brief,
      ),
    );
  }

  async createCodingRunForOnlyProject(
    actorHandle: AuthenticatedGroupCodingActor,
    command: { brief: CodingTaskBrief },
  ): Promise<GroupSafeCodingRunView> {
    assertExactKeys(command, ["brief"], "create only-project group CodingRun command");
    if (!this.projects) {
      throw new GroupWorkspaceCodingError(
        "group_coding_project_selection_required",
        "Project harus dipilih melalui Workspace privat.",
      );
    }
    const brief = validateTaskBrief(command.brief);
    const actor = await this.resolveActor(actorHandle);
    return this.links.withLinkedPermissions(
      actor,
      ["run.create", "code.read", "code.write"],
      async (context) => {
        const projects = await this.projects!.list(context.scope);
        if (projects.length !== 1) {
          throw new GroupWorkspaceCodingError(
            "group_coding_project_selection_required",
            "Pilih project melalui Workspace privat sebelum memulai coding dari grup.",
          );
        }
        const project = projects[0]!;
        return this.startCodingRun(
          context,
          actor,
          safeKey(project.id, "projectId"),
          project.revision,
          brief,
        );
      },
    );
  }

  async getCodingRun(
    actorHandle: AuthenticatedGroupCodingActor,
    command: GetGroupCodingRunCommand,
  ): Promise<GroupSafeCodingRunView> {
    assertExactKeys(command, ["runId"], "get group CodingRun command");
    const runId = safeKey(command.runId, "runId");
    const actor = await this.resolveActor(actorHandle);
    return this.links.withLinkedPermissions(actor, ["code.read"], async (context) =>
      this.loadGroupRun(context, runId)
    );
  }

  async requestPublish(
    actorHandle: AuthenticatedGroupCodingActor,
    command: RequestGroupCodingPublishCommand,
  ): Promise<GroupSafePublishOffer> {
    assertExactKeys(command, ["runId", "action"], "group publish command");
    const runId = safeKey(command.runId, "runId");
    if (command.action !== "github.push_branch" && command.action !== "github.pr.create") {
      throw invalidCommand("Aksi publish group-coding tidak sah.");
    }
    const actor = await this.resolveActor(actorHandle);
    const permission: WorkspacePermission = command.action === "github.push_branch"
      ? "github.push"
      : "github.pr.create";
    return this.links.withLinkedPermissions(
      actor,
      ["code.read", permission],
      async (context) => {
        const run = await this.loadExactGroupRun(context, runId);
        if (run.status !== "completed" || !run.result) {
          throw new GroupWorkspaceCodingError(
            "group_coding_run_not_ready",
            "CodingRun belum mempunyai hasil lokal tervalidasi untuk publish.",
          );
        }
        return Object.freeze({
          audience: "group-safe",
          runId,
          action: command.action,
          status: "workspace-private-confirmation-required",
          text: command.action === "github.push_branch"
            ? "Push belum dijalankan. Lanjutkan konfirmasi exact commit di Workspace privat."
            : "PR belum dibuat. Lanjutkan konfirmasi repository dan commit di Workspace privat.",
        });
      },
    );
  }

  async reviseCodingRun(
    actorHandle: AuthenticatedGroupCodingActor,
    command: ReviseGroupCodingRunCommand,
  ): Promise<GroupSafeCodingRunView> {
    assertExactKeys(
      command,
      ["runId", "sourceMessageId", "kind", "content"],
      "revise group CodingRun command",
    );
    const runId = safeKey(command.runId, "runId");
    const sourceMessageId = safeKey(command.sourceMessageId, "sourceMessageId");
    if (
      command.kind !== "constraint" && command.kind !== "correction" &&
      command.kind !== "scope_change"
    ) throw invalidCommand("Jenis revision group-coding tidak sah.");
    const content = boundedTaskText(command.content, 8_192, "group coding revision");
    const actor = await this.resolveActor(actorHandle);
    return this.links.withLinkedPermissions(
      actor,
      ["code.read", "code.write"],
      async (context) => {
        const current = await this.loadExactGroupRunBinding(context, runId);
        assertHighLevelRunControl(context, current.reference);
        if (!this.codingRuns.revise) {
          throw new GroupWorkspaceCodingError(
            "group_coding_runtime_unavailable",
            "Runtime revision group-coding tidak tersedia.",
          );
        }
        await this.codingRuns.interrupt?.(context.scope, runId);
        const revised = await this.codingRuns.revise(context.scope, runId, {
          sourceMessageId,
          kind: command.kind,
          content,
        });
        this.codingRuns.schedule?.(context.scope, revised);
        return renderGroupSafeCodingRun(revised);
      },
    );
  }

  async cancelCodingRun(
    actorHandle: AuthenticatedGroupCodingActor,
    command: CancelGroupCodingRunCommand,
  ): Promise<GroupSafeCodingRunView> {
    assertExactKeys(command, ["runId"], "cancel group CodingRun command");
    const runId = safeKey(command.runId, "runId");
    const actor = await this.resolveActor(actorHandle);
    return this.links.withLinkedPermissions(
      actor,
      ["code.read", "code.write"],
      async (context) => {
        const current = await this.loadExactGroupRunBinding(context, runId);
        assertHighLevelRunControl(context, current.reference);
        if (terminalCodingRun(current.run)) return renderGroupSafeCodingRun(current.run);
        if (!this.codingRuns.cancel) {
          throw new GroupWorkspaceCodingError(
            "group_coding_runtime_unavailable",
            "Runtime cancellation group-coding tidak tersedia.",
          );
        }
        await this.codingRuns.interrupt?.(context.scope, runId);
        const latest = await this.loadExactGroupRunBinding(context, runId);
        const cancelled = terminalCodingRun(latest.run)
          ? latest.run
          : await this.codingRuns.cancel(context.scope, runId);
        return renderGroupSafeCodingRun(cancelled);
      },
    );
  }

  private async startCodingRun(
    context: LinkedActorContext,
    actor: ResolvedGroupCodingActor,
    projectId: string,
    expectedProjectRevision: number,
    brief: CodingTaskBrief,
  ): Promise<GroupSafeCodingRunView> {
    const { link, scope } = context;
    const interactionDigest = sha256(actor.interactionId);
    const effectId = `group-coding-run-${sha256(`${link.linkId}\0${actor.interactionId}`)}`;
    const commandDigest = sha256(canonicalJson({
      projectId,
      expectedProjectRevision,
      brief,
    }));
    const existingReference = await this.repository.loadRunReferenceByEffect(effectId);
    if (existingReference) {
      assertReferenceMatches(existingReference, link, commandDigest, interactionDigest);
      const existingRun = await this.loadExactGroupRun(context, existingReference.runId);
      return renderGroupSafeCodingRun(existingRun);
    }
    for (const reference of await this.repository.listRunReferences()) {
      if (
        reference.linkId !== link.linkId ||
        reference.scopeKey !== link.scopeKey ||
        reference.accountId !== link.accountId ||
        reference.groupJoinedAt !== link.groupJoinedAt
      ) continue;
      const foreground = await this.codingRuns.get(scope, reference.runId);
      if (foreground && !terminalCodingRun(foreground)) {
        throw new GroupWorkspaceCodingError(
          "group_coding_foreground_exists",
          "Grup ini sudah mempunyai satu foreground CodingRun aktif.",
        );
      }
    }
    const admission: CodingRunAdmission = {
      source: "group",
      effectId,
      audience: "group-safe",
      authorityRef: link.linkId,
      interactionDigest,
    };
    const run = await this.codingRuns.start(
      scope,
      projectId,
      expectedProjectRevision,
      brief,
      { admission },
    );
    if (
      JSON.stringify(run.admission) !== JSON.stringify(admission) ||
      run.binding.ownerWorkspaceKey !== link.workspaceKey ||
      run.binding.projectId !== projectId ||
      run.binding.workspaceRevision !== expectedProjectRevision
    ) {
      await this.cancelUnadmittedRun(scope, run).catch(() => undefined);
      throw new GroupWorkspaceCodingError(
        "group_coding_reconciliation_required",
        "CodingRun tidak cocok dengan admission group-coding exact.",
      );
    }
    const reference: GroupCodingRunReference = {
      version: 1,
      referenceId: `group-coding-reference-${safeKey(this.makeId(), "referenceId")}`,
      effectId,
      interactionDigest,
      commandDigest,
      runId: run.runId,
      linkId: link.linkId,
      linkStateRevision: link.stateRevision,
      scopeKey: link.scopeKey,
      accountId: link.accountId,
      groupJoinedAt: link.groupJoinedAt,
      workspaceKey: link.workspaceKey,
      projectId,
      initiatedByMembershipId: scope.membershipId,
      initiatedByPrincipalKey: actor.principal.principalKey,
      initiatedByParticipantId: actor.participantIds[0]!,
      createdAt: this.now().toISOString(),
    };
    const saved = await this.repository.saveRunReference(reference);
    if (saved.status !== "saved") {
      const replay = await this.repository.loadRunReferenceByEffect(effectId);
      if (!replay) {
        await this.cancelUnadmittedRun(scope, run).catch(() => undefined);
        throw new GroupWorkspaceCodingError(
          "group_coding_reconciliation_required",
          "Reference Group CodingRun gagal dikomit.",
        );
      }
      assertReferenceMatches(replay, link, commandDigest, interactionDigest, run.runId);
    }
    try {
      await this.links.withLinkedPermissions(
        actor,
        ["run.create", "code.read", "code.write"],
        async (current) => {
          if (
            current.link.linkId !== link.linkId ||
            current.link.stateRevision !== link.stateRevision ||
            current.link.workspaceKey !== link.workspaceKey ||
            current.scope.membershipId !== scope.membershipId ||
            current.scope.aclEpoch !== scope.aclEpoch
          ) throw new Error("Authority/link group-coding berubah setelah admission.");
        },
      );
    } catch (error) {
      await this.cancelUnadmittedRun(scope, run).catch(() => undefined);
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        error instanceof Error
          ? error.message
          : "Authority group-coding berubah setelah admission.",
      );
    }
    this.codingRuns.schedule?.(scope, run);
    return renderGroupSafeCodingRun(run);
  }

  private async cancelUnadmittedRun(
    scope: WorkspaceAgentScope,
    run: CodingRun,
  ): Promise<void> {
    await this.codingRuns.interrupt?.(scope, run.runId);
    const current = await this.codingRuns.get(scope, run.runId);
    if (!current || terminalCodingRun(current)) return;
    if (!this.codingRuns.cancel) {
      throw new Error("Runtime tidak dapat membatalkan admission group-coding yatim.");
    }
    await this.codingRuns.cancel(scope, run.runId);
  }

  private async loadGroupRun(
    context: LinkedActorContext,
    runId: string,
  ): Promise<GroupSafeCodingRunView> {
    return renderGroupSafeCodingRun(await this.loadExactGroupRun(context, runId));
  }

  private async loadExactGroupRun(
    context: LinkedActorContext,
    runId: string,
  ): Promise<CodingRun> {
    return (await this.loadExactGroupRunBinding(context, runId)).run;
  }

  private async loadExactGroupRunBinding(
    context: LinkedActorContext,
    runId: string,
  ): Promise<{ run: CodingRun; reference: GroupCodingRunReference }> {
    const reference = await this.repository.loadRunReference(runId);
    if (
      !reference || reference.linkId !== context.link.linkId ||
      reference.scopeKey !== context.link.scopeKey ||
      reference.accountId !== context.link.accountId ||
      reference.groupJoinedAt !== context.link.groupJoinedAt ||
      reference.workspaceKey !== context.scope.workspaceKey
    ) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "CodingRun bukan milik audience grup ini.",
      );
    }
    const run = await this.codingRuns.get(context.scope, runId);
    if (
      !run || run.binding.ownerWorkspaceKey !== context.scope.workspaceKey ||
      run.binding.projectId !== reference.projectId ||
      run.admission?.authorityRef !== context.link.linkId ||
      run.admission.effectId !== reference.effectId ||
      run.admission.audience !== "group-safe"
    ) {
      throw new GroupWorkspaceCodingError(
        "group_coding_reconciliation_required",
        "Binding Group CodingRun tidak konsisten.",
      );
    }
    return { run, reference };
  }

  private async resolveActor(
    handle: AuthenticatedGroupCodingActor,
  ): Promise<ResolvedGroupCodingActor> {
    const resolved = await this.actors.resolve(handle);
    if (!resolved) {
      throw new GroupWorkspaceCodingError(
        "group_coding_access_denied",
        "Authenticated group-coding actor tidak tersedia.",
      );
    }
    return validateResolvedActor(resolved);
  }
}

export class GroupWorkspaceCodingError extends Error {
  constructor(
    readonly code:
      | "group_coding_access_denied"
      | "group_coding_authority_unavailable"
      | "group_workspace_link_conflict"
      | "group_workspace_selection_required"
      | "group_coding_command_invalid"
      | "group_coding_command_collision"
      | "group_coding_project_selection_required"
      | "group_coding_foreground_exists"
      | "group_coding_run_not_ready"
      | "group_coding_runtime_unavailable"
      | "group_coding_reconciliation_required",
    message: string,
  ) {
    super(message);
    this.name = "GroupWorkspaceCodingError";
  }
}

function assertHighLevelRunControl(
  context: LinkedActorContext,
  reference: GroupCodingRunReference,
): void {
  const initiator = context.actor.participantIds.includes(
    reference.initiatedByParticipantId,
  );
  if (!initiator && context.authority.role !== "admin") {
    throw new GroupWorkspaceCodingError(
      "group_coding_access_denied",
      "Hanya initiator atau admin grup yang dapat merevisi atau membatalkan CodingRun.",
    );
  }
}

function terminalCodingRun(run: CodingRun): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function validateResolvedActor(value: ResolvedGroupCodingActor): ResolvedGroupCodingActor {
  if (
    value.audience !== "group" ||
    (value.scope.channel !== "whatsapp" && value.scope.channel !== "telegram") ||
    value.principal.channel !== value.scope.channel ||
    !/^[a-f0-9]{64}$/u.test(value.principal.principalKey) ||
    !Array.isArray(value.participantIds) || value.participantIds.length < 1 ||
    value.participantIds.length > 16 ||
    new Set(value.participantIds).size !== value.participantIds.length ||
    value.participantIds.some((id) => safeKey(id, "participantId") !== id) ||
    typeof value.claimedAdmin !== "boolean" ||
    !Number.isSafeInteger(value.claimedAuthorityEpoch) ||
    value.claimedAuthorityEpoch < 0
  ) throw invalidAccess("Resolved group-coding actor tidak sah.");
  safeKey(value.scope.groupId, "groupId");
  safeKey(value.accountId, "accountId");
  safeKey(value.interactionId, "interactionId");
  return structuredClone(value);
}

function authorityExpectation(
  actor: ResolvedGroupCodingActor,
  minimumRole: "member" | "admin",
): GroupCodingAuthorityExpectation {
  return {
    scope: structuredClone(actor.scope),
    accountId: actor.accountId,
    participantIds: [...actor.participantIds],
    claimedAdmin: actor.claimedAdmin,
    claimedAuthorityEpoch: actor.claimedAuthorityEpoch,
    minimumRole,
  };
}

function assertCurrentGroupAuthority(
  actor: ResolvedGroupCodingActor,
  authority: GroupAuthoritySnapshot,
  minimumRole: "member" | "admin",
): void {
  if (
    (authority.role !== "member" && authority.role !== "admin") ||
    authority.authorityEpoch !== actor.claimedAuthorityEpoch ||
    (minimumRole === "admin" && authority.role !== "admin")
  ) throw invalidAccess("Authority group-coding hilang, berubah, atau tidak cukup.");
}

function withoutLinkRevision(
  link: GroupWorkspaceLink,
): Omit<GroupWorkspaceLink, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = link;
  return rest;
}

function withoutRequestRevision(
  request: GroupWorkspaceLinkRequest,
): Omit<GroupWorkspaceLinkRequest, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = request;
  return rest;
}

function validateTaskBrief(value: unknown): CodingTaskBrief {
  assertExactKeys(
    value,
    ["request", "objective", "acceptanceCriteria", "initialConstraints"],
    "group CodingTaskBrief",
  );
  const brief = value as CodingTaskBrief;
  if (
    !Array.isArray(brief.acceptanceCriteria) ||
    !Array.isArray(brief.initialConstraints) ||
    brief.acceptanceCriteria.length > 32 || brief.initialConstraints.length > 32
  ) throw invalidCommand("Daftar TaskBrief group-coding tidak sah.");
  const bounded = (
    text: unknown,
    max: number,
    field: string,
  ): string => {
    if (
      typeof text !== "string" || !text.trim() || text.length > max ||
      /\p{Cc}/u.test(text.replace(/[\r\n\t]/gu, "")) ||
      containsSecretLikeValue(text)
    ) throw invalidCommand(`${field} group-coding tidak sah atau credential-like.`);
    return text.trim();
  };
  return {
    request: bounded(brief.request, 16_000, "request"),
    objective: bounded(brief.objective, 4_000, "objective"),
    acceptanceCriteria: brief.acceptanceCriteria.map((item) =>
      bounded(item, 2_000, "acceptanceCriteria")
    ),
    initialConstraints: brief.initialConstraints.map((item) =>
      bounded(item, 2_000, "initialConstraints")
    ),
  };
}

function assertReferenceMatches(
  reference: GroupCodingRunReference,
  link: GroupWorkspaceLink,
  commandDigest: string,
  interactionDigest: string,
  runId?: string,
): void {
  if (
    reference.linkId !== link.linkId ||
    reference.scopeKey !== link.scopeKey ||
    reference.accountId !== link.accountId ||
    reference.groupJoinedAt !== link.groupJoinedAt ||
    reference.workspaceKey !== link.workspaceKey ||
    reference.commandDigest !== commandDigest ||
    reference.interactionDigest !== interactionDigest ||
    (runId !== undefined && reference.runId !== runId)
  ) {
    throw new GroupWorkspaceCodingError(
      "group_coding_command_collision",
      "Interaction group-coding sudah terikat command lain.",
    );
  }
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value || value.length > 512 ||
    /\p{Cc}/u.test(value) || /[\\/]/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw invalidAccess(`${field} group-coding tidak sah.`);
  return value;
}

function boundedTaskText(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > maximum ||
    /\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, "")) ||
    containsSecretLikeValue(value)
  ) throw invalidCommand(`${field} group-coding tidak sah atau credential-like.`);
  return value.trim();
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) throw invalidCommand(`Schema ${label} memuat field asing atau hilang.`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function invalidAccess(message: string): GroupWorkspaceCodingError {
  return new GroupWorkspaceCodingError("group_coding_access_denied", message);
}

function invalidCommand(message: string): GroupWorkspaceCodingError {
  return new GroupWorkspaceCodingError("group_coding_command_invalid", message);
}
