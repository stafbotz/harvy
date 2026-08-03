import { createHmac, randomUUID } from "node:crypto";
import type {
  WorkspaceAuthorityState,
  WorkspaceMembership,
  WorkspacePermission,
  WorkspacePrincipal,
  WorkspacePrincipalChannel,
  WorkspaceRecord,
  WorkspaceRepository,
  WorkspaceRole,
} from "../domain/workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";

const MAX_NAME_CHARACTERS = 80;
const MAX_KEY_CHARACTERS = 512;
const MIN_PRINCIPAL_SECRET_CHARACTERS = 32;

const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly WorkspacePermission[]>> =
  Object.freeze({
    owner: permissions([
      "workspace.view",
      "artifact.read",
      "artifact.write",
      "run.create",
      "run.cancel.own",
      "run.cancel.any",
      "membership.manage",
      "workspace.manage",
    ]),
    admin: permissions([
      "workspace.view",
      "artifact.read",
      "artifact.write",
      "run.create",
      "run.cancel.own",
      "run.cancel.any",
      "membership.manage",
    ]),
    editor: permissions([
      "workspace.view",
      "artifact.read",
      "artifact.write",
      "run.create",
      "run.cancel.own",
    ]),
    viewer: permissions([
      "workspace.view",
      "artifact.read",
    ]),
  });

function permissions(
  values: WorkspacePermission[],
): readonly WorkspacePermission[] {
  return Object.freeze(values);
}

export type WorkspaceMutationResult =
  | {
      status: "updated";
      aclEpoch: number;
      membership: WorkspaceMembership;
    }
  | { status: "stale" | "forbidden" | "not-found" | "conflict" };

export interface CreatedWorkspace {
  workspace: WorkspaceRecord;
  owner: WorkspaceMembership;
  scope: WorkspaceAgentScope;
}

/**
 * Membuat pseudonim principal yang terpisah per kanal. Secret berasal dari
 * control plane/deployment dan tidak pernah masuk scope, repository, atau log.
 */
export function workspacePrincipal(
  secret: string,
  channel: WorkspacePrincipalChannel,
  platformId: string,
): WorkspacePrincipal {
  if (secret.length < MIN_PRINCIPAL_SECRET_CHARACTERS) {
    throw new Error("Secret principal workspace terlalu pendek.");
  }
  const cleanId = safeKey(platformId, "platformId");
  return Object.freeze({
    channel,
    principalKey: createHmac("sha256", secret)
      .update("harvy-workspace-principal-v1\0", "utf8")
      .update(channel, "utf8")
      .update("\0", "utf8")
      .update(cleanId, "utf8")
      .digest("hex"),
  });
}

export function permissionsForWorkspaceRole(
  role: WorkspaceRole,
): readonly WorkspacePermission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * Satu-satunya pembentuk WorkspaceAgentScope. Setiap mutasi membaca state
 * terbaru lagi; role atau aclEpoch dari model/checkpoint tidak pernah menjadi
 * authority.
 */
export class WorkspaceAuthorityService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async createWorkspace(
    displayName: string,
    owner: WorkspacePrincipal,
  ): Promise<CreatedWorkspace> {
    const cleanName = workspaceName(displayName);
    const principal = validPrincipal(owner);
    const at = this.now().toISOString();
    const workspaceKey = `ws-${safeKey(this.makeId(), "workspaceId")}`;
    const membershipId = `wm-${safeKey(this.makeId(), "membershipId")}`;
    const workspace: WorkspaceRecord = {
      workspaceKey,
      displayName: cleanName,
      aclEpoch: 1,
      createdAt: at,
      updatedAt: at,
      disabledAt: null,
    };
    const membership: WorkspaceMembership = {
      workspaceKey,
      membershipId,
      channel: principal.channel,
      principalKey: principal.principalKey,
      role: "owner",
      joinedAt: at,
      updatedAt: at,
      revokedAt: null,
    };

    await this.exclusive(workspaceKey, async () => {
      if (await this.repository.loadAuthorityState(workspaceKey)) {
        throw new Error("Workspace key sudah ada.");
      }
      const saved = await this.repository.saveAuthorityState({
        workspace,
        memberships: [membership],
      }, null);
      if (saved === "conflict") {
        throw new Error("Workspace key sudah ada.");
      }
    });
    return {
      workspace: structuredClone(workspace),
      owner: structuredClone(membership),
      scope: workspaceScope(workspace, membership),
    };
  }

  async resolveScope(
    workspaceKey: string,
    principal: WorkspacePrincipal,
  ): Promise<WorkspaceAgentScope | null> {
    const cleanWorkspaceKey = safeKey(workspaceKey, "workspaceKey");
    const cleanPrincipal = validPrincipal(principal);
    const state = await this.repository.loadAuthorityState(cleanWorkspaceKey);
    if (!state || state.workspace.disabledAt !== null) return null;
    const membership = activeMembership(state, cleanPrincipal);
    return membership ? workspaceScope(state.workspace, membership) : null;
  }

  async authorize(
    scope: WorkspaceAgentScope,
    permission: WorkspacePermission,
  ): Promise<boolean> {
    const current = await this.currentMembership(scope);
    return current !== null && ROLE_PERMISSIONS[current.role].includes(permission);
  }

  async isCurrent(scope: WorkspaceAgentScope): Promise<boolean> {
    return (await this.currentMembership(scope)) !== null;
  }

  async addMember(
    actor: WorkspaceAgentScope,
    principal: WorkspacePrincipal,
    role: Exclude<WorkspaceRole, "owner">,
  ): Promise<WorkspaceMutationResult> {
    const target = validPrincipal(principal);
    return this.mutate(actor, (state, actorMembership) => {
      if (!canManageRole(actorMembership.role, role)) {
        return { status: "forbidden" };
      }
      if (activeMembership(state, target)) return { status: "conflict" };
      const at = this.now().toISOString();
      const membership: WorkspaceMembership = {
        workspaceKey: state.workspace.workspaceKey,
        membershipId: `wm-${safeKey(this.makeId(), "membershipId")}`,
        channel: target.channel,
        principalKey: target.principalKey,
        role,
        joinedAt: at,
        updatedAt: at,
        revokedAt: null,
      };
      state.memberships.push(membership);
      return { status: "updated", membership };
    });
  }

  async changeRole(
    actor: WorkspaceAgentScope,
    membershipId: string,
    role: Exclude<WorkspaceRole, "owner">,
  ): Promise<WorkspaceMutationResult> {
    const cleanMembershipId = safeKey(membershipId, "membershipId");
    return this.mutate(actor, (state, actorMembership) => {
      const target = state.memberships.find(
        (membership) =>
          membership.membershipId === cleanMembershipId &&
          membership.revokedAt === null,
      );
      if (!target) return { status: "not-found" };
      if (
        target.role === "owner" ||
        !canManageRole(actorMembership.role, target.role) ||
        !canManageRole(actorMembership.role, role)
      ) {
        return { status: "forbidden" };
      }
      if (target.role === role) return { status: "conflict" };
      target.role = role;
      target.updatedAt = this.now().toISOString();
      return { status: "updated", membership: target };
    });
  }

  async removeMember(
    actor: WorkspaceAgentScope,
    membershipId: string,
  ): Promise<WorkspaceMutationResult> {
    const cleanMembershipId = safeKey(membershipId, "membershipId");
    return this.mutate(actor, (state, actorMembership) => {
      const target = state.memberships.find(
        (membership) =>
          membership.membershipId === cleanMembershipId &&
          membership.revokedAt === null,
      );
      if (!target) return { status: "not-found" };
      if (
        target.role === "owner" ||
        target.membershipId === actorMembership.membershipId ||
        !canManageRole(actorMembership.role, target.role)
      ) {
        return { status: "forbidden" };
      }
      const at = this.now().toISOString();
      target.revokedAt = at;
      target.updatedAt = at;
      return { status: "updated", membership: target };
    });
  }

  async leave(scope: WorkspaceAgentScope): Promise<WorkspaceMutationResult> {
    return this.mutate(scope, (_state, membership) => {
      if (membership.role === "owner") return { status: "forbidden" };
      const at = this.now().toISOString();
      membership.revokedAt = at;
      membership.updatedAt = at;
      return { status: "updated", membership };
    });
  }

  private async mutate(
    actor: WorkspaceAgentScope,
    operation: (
      state: WorkspaceAuthorityState,
      actorMembership: WorkspaceMembership,
    ) =>
      | { status: "updated"; membership: WorkspaceMembership }
      | { status: "forbidden" | "not-found" | "conflict" },
  ): Promise<WorkspaceMutationResult> {
    return this.exclusive(actor.workspaceKey, async () => {
      const state = await this.repository.loadAuthorityState(actor.workspaceKey);
      if (!state || state.workspace.disabledAt !== null) {
        return { status: "not-found" };
      }
      const actorMembership = currentActor(state, actor);
      if (!actorMembership) return { status: "stale" };
      const result = operation(state, actorMembership);
      if (result.status !== "updated") return result;

      state.workspace.aclEpoch += 1;
      state.workspace.updatedAt = this.now().toISOString();
      const saved = await this.repository.saveAuthorityState(
        state,
        actor.aclEpoch,
      );
      if (saved === "conflict") return { status: "stale" };
      return {
        status: "updated",
        aclEpoch: state.workspace.aclEpoch,
        membership: structuredClone(result.membership),
      };
    });
  }

  private async currentMembership(
    scope: WorkspaceAgentScope,
  ): Promise<WorkspaceMembership | null> {
    const state = await this.repository.loadAuthorityState(scope.workspaceKey);
    if (!state || state.workspace.disabledAt !== null) return null;
    return currentActor(state, scope);
  }

  private async exclusive<T>(
    workspaceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(workspaceKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.queues.set(workspaceKey, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.queues.get(workspaceKey) === tail) {
        this.queues.delete(workspaceKey);
      }
    }
  }
}

function workspaceScope(
  workspace: WorkspaceRecord,
  membership: WorkspaceMembership,
): WorkspaceAgentScope {
  const root = `v1:workspace:${encodeURIComponent(workspace.workspaceKey)}`;
  const member = `${root}:member:${encodeURIComponent(membership.membershipId)}`;
  const permissions = Object.freeze([...ROLE_PERMISSIONS[membership.role]]);
  return Object.freeze({
    kind: "workspace",
    channel: membership.channel,
    workspaceKey: workspace.workspaceKey,
    principalKey: membership.principalKey,
    membershipId: membership.membershipId,
    role: membership.role,
    aclEpoch: workspace.aclEpoch,
    permissions,
    conversationKey: `${member}:conversation`,
    sharedMemoryKey: `${root}:memory`,
    artifactKey: `${root}:artifact`,
    authorityKey: `${member}:principal:${encodeURIComponent(membership.principalKey)}:acl:${workspace.aclEpoch}`,
  });
}

function currentActor(
  state: WorkspaceAuthorityState,
  scope: WorkspaceAgentScope,
): WorkspaceMembership | null {
  if (
    state.workspace.workspaceKey !== scope.workspaceKey ||
    state.workspace.aclEpoch !== scope.aclEpoch
  ) {
    return null;
  }
  const membership = state.memberships.find(
    (candidate) =>
      candidate.membershipId === scope.membershipId &&
      candidate.principalKey === scope.principalKey &&
      candidate.channel === scope.channel &&
      candidate.role === scope.role &&
      candidate.revokedAt === null,
  );
  if (!membership) return null;
  const canonical = workspaceScope(state.workspace, membership);
  return sameScope(scope, canonical) ? membership : null;
}

function activeMembership(
  state: WorkspaceAuthorityState,
  principal: WorkspacePrincipal,
): WorkspaceMembership | null {
  return state.memberships.find(
    (membership) =>
      membership.channel === principal.channel &&
      membership.principalKey === principal.principalKey &&
      membership.revokedAt === null,
  ) ?? null;
}

function canManageRole(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  if (actor === "owner") return target !== "owner";
  return actor === "admin" && (target === "editor" || target === "viewer");
}

function samePermissions(
  claimed: readonly WorkspacePermission[],
  expected: readonly WorkspacePermission[],
): boolean {
  return (
    claimed.length === expected.length &&
    expected.every((permission) => claimed.includes(permission))
  );
}

function sameScope(
  claimed: WorkspaceAgentScope,
  canonical: WorkspaceAgentScope,
): boolean {
  return (
    claimed.kind === canonical.kind &&
    claimed.channel === canonical.channel &&
    claimed.workspaceKey === canonical.workspaceKey &&
    claimed.principalKey === canonical.principalKey &&
    claimed.membershipId === canonical.membershipId &&
    claimed.role === canonical.role &&
    claimed.aclEpoch === canonical.aclEpoch &&
    samePermissions(claimed.permissions, canonical.permissions) &&
    claimed.conversationKey === canonical.conversationKey &&
    claimed.sharedMemoryKey === canonical.sharedMemoryKey &&
    claimed.artifactKey === canonical.artifactKey &&
    claimed.authorityKey === canonical.authorityKey
  );
}

function validPrincipal(principal: WorkspacePrincipal): WorkspacePrincipal {
  if (principal.channel !== "telegram" && principal.channel !== "whatsapp") {
    throw new Error("Kanal principal workspace tidak sah.");
  }
  return {
    channel: principal.channel,
    principalKey: safeKey(principal.principalKey, "principalKey"),
  };
}

function workspaceName(value: string): string {
  const clean = value.trim().replace(/\s+/gu, " ");
  if (!clean || clean.length > MAX_NAME_CHARACTERS || /\p{Cc}/u.test(clean)) {
    throw new Error("Nama workspace tidak sah.");
  }
  return clean;
}

function safeKey(value: string, field: string): string {
  const clean = value.trim();
  if (
    !clean ||
    clean.length > MAX_KEY_CHARACTERS ||
    /\p{Cc}/u.test(clean)
  ) {
    throw new Error(`${field} tidak sah.`);
  }
  return clean;
}
