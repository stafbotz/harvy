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
}

export interface GroupCodingRunReader {
  get(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null>;
}

export interface GroupCodingLinkView {
  audience: "group-safe";
  status: "linked" | "unlinked";
  text: string;
}

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
              if (
                existing.status === "active" &&
                existing.groupJoinedAt === binding.joinedAt
              ) {
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
    private readonly codingRuns: GroupCodingRunCreator & GroupCodingRunReader,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
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
      async (context) => {
        const { link, scope } = context;
        const interactionDigest = sha256(actor.interactionId);
        const effectId = `group-coding-run-${sha256(`${link.linkId}\0${actor.interactionId}`)}`;
        const commandDigest = sha256(canonicalJson({
          projectId,
          expectedProjectRevision: command.expectedProjectRevision,
          brief,
        }));
        const existingReference = await this.repository.loadRunReferenceByEffect(effectId);
        if (existingReference) {
          assertReferenceMatches(existingReference, link, commandDigest, interactionDigest);
          const existingRun = await this.loadExactGroupRun(
            context,
            existingReference.runId,
          );
          return renderGroupSafeCodingRun(existingRun);
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
          command.expectedProjectRevision,
          brief,
          { admission },
        );
        if (
          JSON.stringify(run.admission) !== JSON.stringify(admission) ||
          run.binding.ownerWorkspaceKey !== link.workspaceKey ||
          run.binding.projectId !== projectId ||
          run.binding.workspaceRevision !== command.expectedProjectRevision
        ) {
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
          initiatedByParticipantId: actor.participantIds[0]!,
          createdAt: this.now().toISOString(),
        };
        const saved = await this.repository.saveRunReference(reference);
        if (saved.status !== "saved") {
          const replay = await this.repository.loadRunReferenceByEffect(effectId);
          if (!replay) {
            throw new GroupWorkspaceCodingError(
              "group_coding_reconciliation_required",
              "Reference Group CodingRun gagal dikomit.",
            );
          }
          assertReferenceMatches(replay, link, commandDigest, interactionDigest, run.runId);
        }
        return renderGroupSafeCodingRun(run);
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
    return run;
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
      | "group_coding_command_invalid"
      | "group_coding_command_collision"
      | "group_coding_run_not_ready"
      | "group_coding_reconciliation_required",
    message: string,
  ) {
    super(message);
    this.name = "GroupWorkspaceCodingError";
  }
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
