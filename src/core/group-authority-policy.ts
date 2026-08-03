import type { GroupScope } from "../domain/group.js";

export type GroupRole = "member" | "admin" | "system";

export type GroupAuthorityAction =
  | "social.read"
  | "room.read"
  | "member.self.manage"
  | "room.propose"
  | "room.confirm"
  | "room.delete"
  | "social.reset"
  | "alias.manage"
  | "scope.disable";

const GROUP_AUTHORITY_MATRIX: Readonly<
  Record<GroupRole, ReadonlySet<GroupAuthorityAction>>
> = Object.freeze({
  member: authorityActions([
    "social.read",
    "room.read",
    "member.self.manage",
    "room.propose",
  ]),
  admin: authorityActions([
    "social.read",
    "room.read",
    "member.self.manage",
    "room.propose",
    "room.confirm",
    "room.delete",
    "social.reset",
    "alias.manage",
  ]),
  system: authorityActions(["scope.disable"]),
});

function authorityActions(
  actions: GroupAuthorityAction[],
): ReadonlySet<GroupAuthorityAction> {
  return new Set(actions);
}

export interface GroupAuthoritySnapshot {
  role: "member" | "admin";
  authorityEpoch: number;
}

export interface GroupAuthorityRequest {
  scope: GroupScope;
  accountId: string;
  participantIds: readonly string[];
  claimedAdmin: boolean;
  claimedAuthorityEpoch: number;
}

export interface GroupAuthorityResolver {
  resolveGroupAuthority(
    request: GroupAuthorityRequest,
  ): Promise<GroupAuthoritySnapshot | null>;
}

/** Hanya fallback tes/adapter lama. Runtime WhatsApp memasang resolver nyata. */
export const CLAIMED_GROUP_AUTHORITY_RESOLVER: GroupAuthorityResolver = {
  resolveGroupAuthority: async (request) => ({
    role: request.claimedAdmin ? "admin" : "member",
    authorityEpoch: request.claimedAuthorityEpoch,
  }),
};

/** Runtime default. A missing adapter must never turn message claims into admin authority. */
export const DENY_GROUP_AUTHORITY_RESOLVER: GroupAuthorityResolver = {
  resolveGroupAuthority: async () => null,
};

export function groupAuthorityAllows(
  role: GroupRole,
  action: GroupAuthorityAction,
): boolean {
  return GROUP_AUTHORITY_MATRIX[role].has(action);
}
