export type WorkspacePrincipalChannel = "telegram" | "whatsapp";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export type WorkspacePermission =
  | "workspace.view"
  | "artifact.read"
  | "artifact.write"
  | "run.create"
  | "run.cancel.own"
  | "run.cancel.any"
  | "membership.manage"
  | "workspace.manage"
  | "code.read"
  | "code.write"
  | "sandbox.execute"
  | "sandbox.network"
  | "git.commit"
  | "github.read"
  | "github.push"
  | "github.pr.create"
  | "github.pr.review"
  | "github.pr.merge"
  | "github.workflow.write";

/**
 * Principal workspace selalu berasal dari ingress/account-link tepercaya.
 * `principalKey` adalah pseudonim ber-HMAC, bukan ID kanal mentah dan bukan
 * nilai yang boleh diambil dari teks atau keluaran model.
 */
export interface WorkspacePrincipal {
  channel: WorkspacePrincipalChannel;
  principalKey: string;
}

export interface WorkspaceRecord {
  workspaceKey: string;
  displayName: string;
  /** Naik pada setiap perubahan membership/role/ACL. */
  aclEpoch: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface WorkspaceMembership {
  workspaceKey: string;
  membershipId: string;
  channel: WorkspacePrincipalChannel;
  principalKey: string;
  role: WorkspaceRole;
  joinedAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface WorkspaceAuthorityState {
  workspace: WorkspaceRecord;
  memberships: WorkspaceMembership[];
}

export interface WorkspaceRepository {
  /** Stable identity for adapters that share one backing store in-process. */
  readonly coordinationKey?: string;
  loadAuthorityState(
    workspaceKey: string,
  ): Promise<WorkspaceAuthorityState | null>;
  /** Trusted directory lookup; callers pass a code-derived principal. */
  listAuthorityStatesByPrincipal(
    principal: WorkspacePrincipal,
  ): Promise<WorkspaceAuthorityState[]>;
  /**
   * Mengganti workspace dan seluruh membership-nya dalam satu commit. `null`
   * hanya untuk create; angka lain adalah epoch yang wajib masih sama (CAS).
   */
  saveAuthorityState(
    state: WorkspaceAuthorityState,
    expectedAclEpoch: number | null,
  ): Promise<"saved" | "conflict">;
}
