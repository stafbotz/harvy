import type {
  LocalGitObjectBundleReference,
} from "./local-git.js";
import type {
  GitHubProjectProvisioningAuthority,
} from "./project-workspace.js";

export type GitHubRepositoryVisibility = "public" | "private" | "internal";

/**
 * A browser hand-off owned by the credential-holding broker. `sessionId` and
 * `installationId` are opaque broker identifiers, never GitHub credentials.
 */
export interface GitHubInstallationSession {
  sessionId: string;
  ownerWorkspaceKey: string;
  status: "pending";
  authorizationUrl: string;
  createdAt: string;
  expiresAt: string;
}

export interface GitHubInstallationStatus {
  sessionId: string;
  ownerWorkspaceKey: string;
  status: "pending" | "ready" | "expired" | "revoked";
  installationId: string | null;
  completedAt: string | null;
  expiresAt: string;
}

export interface GitHubRepositorySummary {
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  visibility: GitHubRepositoryVisibility;
  defaultBranch: string;
}

export interface GitHubRepositoryPage {
  ownerWorkspaceKey: string;
  installationId: string;
  repositories: GitHubRepositorySummary[];
  nextCursor: string | null;
}

export interface GitHubRepositoryArchiveReference {
  version: 1;
  /** Durable selection-scoped idempotency key for archive preparation. */
  operationId: string;
  archiveId: string;
  ownerWorkspaceKey: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  commit: string;
  mediaType: "application/zip";
  sha256: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

export type GitHubInstallationConnectionStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked";

/**
 * Durable Harvy-side authority for one broker installation session. It stores
 * only opaque IDs and lifecycle metadata; the browser URL, callback code,
 * confirmation proof, App key, and installation token are deliberately absent.
 */
export interface GitHubInstallationConnection {
  version: 1;
  connectionId: string;
  ownerWorkspaceKey: string;
  sessionId: string;
  confirmationId: string;
  requestedByMembershipId: string;
  requestedAclEpoch: number;
  status: GitHubInstallationConnectionStatus;
  installationId: string | null;
  /** Confirmation id for a local revoke or code-owned broker status receipt id. */
  revocationAuthorityId: string | null;
  revision: number;
  createdAt: string;
  expiresAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

export type GitHubRepositorySelectionStatus =
  | "selected"
  | "archive_ready"
  | "project_created"
  | "bound"
  | "cleanup_required"
  | "cancelled";

/** Durable provisioning saga state. A selection grant is single-use. */
export interface GitHubRepositorySelection {
  version: 1;
  selectionId: string;
  confirmationId: string;
  ownerWorkspaceKey: string;
  installationConnectionId: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  visibility: GitHubRepositoryVisibility;
  defaultBranch: string;
  baseCommit: string;
  selectedByMembershipId: string;
  selectedAclEpoch: number;
  status: GitHubRepositorySelectionStatus;
  archive: GitHubRepositoryArchiveReference | null;
  projectId: string | null;
  bindingId: string | null;
  revision: number;
  selectedAt: string;
  expiresAt: string;
  updatedAt: string;
}

export type GitHubInteractiveAction =
  | "github.install.begin"
  | "github.install.status"
  | "github.install.repositories.list"
  | "github.repository.select"
  | "github.repository.provision"
  | "github.install.revoke";

/** Opaque private-controller grant. `proof` must never be persisted. */
export interface GitHubInteractiveGrant {
  confirmationId: string;
  /** Trusted private-controller interaction; never inferred from model input. */
  interactionId: string;
  audience: "workspace-private";
  proof: string;
  expiresAt: string;
}

export interface GitHubInteractiveBinding {
  action: GitHubInteractiveAction;
  interactionId: string;
  audience: "workspace-private";
  ownerWorkspaceKey: string;
  membershipId: string;
  aclEpoch: number;
  connectionId: string | null;
  repositoryId: string | null;
  selectionId: string | null;
}

/**
 * Implemented by a trusted private controller. A model executor never receives
 * the grant or this authority.
 */
export interface GitHubInteractiveAuthority {
  verify(
    grant: GitHubInteractiveGrant,
    binding: GitHubInteractiveBinding,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface GitHubRepositoryBinding {
  bindingId: string;
  projectId: string;
  ownerWorkspaceKey: string;
  /** Null only for legacy records, which cannot be published by the new flow. */
  installationConnectionId: string | null;
  repositorySelectionId: string | null;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  visibility: GitHubRepositoryVisibility;
  defaultBranch: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export type GitHubCapability =
  | "github.branch.create"
  | "github.push_branch"
  | "github.workflow.write"
  | "github.pr.create";

export interface GitHubExactEffect {
  effectId: string;
  attempt: number;
  capability: GitHubCapability;
  projectId: string;
  runId: string;
  ownerWorkspaceKey: string;
  /** Null only while loading a legacy receipt; live effects require both. */
  installationConnectionId: string | null;
  repositoryBindingId: string | null;
  installationId: string;
  repositoryId: string;
  workspaceRevision: number;
  instructionRevision: number;
  branch: string;
  commit: string;
  baseCommit: string;
  expectedTargetHead: string | null;
  baseBranch: string;
  title: string | null;
  body: string | null;
  draft: true | null;
  /** Required only for exact push/workflow effects; never contains a host path. */
  objectBundle: LocalGitObjectBundleReference | null;
}

export interface GitHubEffectApproval {
  approvalId: string;
  /** One user-confirmation nonce may mint at most one durable approval. */
  confirmationId: string;
  effectDigest: string;
  capability: GitHubCapability;
  approvedByMembershipId: string;
  approvedAclEpoch: number;
  approvedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

/** Opaque controller-issued grant; proof is never persisted in connection state. */
export interface GitHubConfirmationGrant {
  confirmationId: string;
  /** Trusted controller session; never inferred from a model/chat payload. */
  interactionId: string;
  audience: "workspace-private";
  proof: string;
  expiresAt: string;
}

export interface GitHubConfirmationBinding {
  effectId: string;
  effectDigest: string;
  capability: GitHubCapability;
  interactionId: string;
  audience: "workspace-private";
  ownerWorkspaceKey: string;
  membershipId: string;
  aclEpoch: number;
}

/** Trusted UI/controller authority. Model-callable executors never receive it. */
export interface GitHubConfirmationAuthority {
  verify(
    grant: GitHubConfirmationGrant,
    binding: GitHubConfirmationBinding,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface GitHubEffectReceipt {
  receiptId: string;
  effectId: string;
  effectDigest: string;
  capability: GitHubCapability;
  branch: string;
  commit: string;
  baseCommit: string;
  workspaceRevision: number;
  status: "committed" | "unknown" | "not_committed";
  /** Canonical recovery payload; contains no credential or token fields. */
  effect: GitHubExactEffect;
  externalId: string | null;
  url: string | null;
  committedAt: string;
}

export interface GitHubConnectionState {
  version: 1;
  binding: GitHubRepositoryBinding;
  approvals: GitHubEffectApproval[];
  receipts: GitHubEffectReceipt[];
}

export type GitHubConnectionSaveResult =
  | { status: "saved"; state: GitHubConnectionState }
  | { status: "conflict" };

/** Content-free locator for an already-sent effect that may only be observed. */
export interface GitHubUnknownEffectReference {
  version: 1;
  ownerWorkspaceKey: string;
  projectId: string;
  effectId: string;
  effectDigest: string;
}

export interface GitHubUnknownEffectPage {
  references: GitHubUnknownEffectReference[];
  nextCursor: string | null;
}

export interface GitHubUnknownEffectRepository {
  listUnknownEffects(input: {
    cursor: string | null;
    limit: number;
  }): Promise<GitHubUnknownEffectPage>;
}

export interface GitHubUnknownEffectReconciler {
  /** Observation-only: this method must never replay create/push/PR. */
  reconcileDurableUnknown(
    reference: GitHubUnknownEffectReference,
  ): Promise<"committed" | "unknown" | "not_committed" | "missing">;
}

export interface GitHubConnectionRepository extends GitHubUnknownEffectRepository {
  loadByProject(projectId: string): Promise<GitHubConnectionState | null>;
  create(state: GitHubConnectionState): Promise<GitHubConnectionSaveResult>;
  save(
    state: Omit<GitHubConnectionState, "binding"> & {
      binding: Omit<GitHubRepositoryBinding, "revision">;
    },
    expectedRevision: number,
  ): Promise<GitHubConnectionSaveResult>;
  remove(projectId: string, expectedRevision: number): Promise<boolean>;
}

export type GitHubInstallationConnectionSaveResult =
  | { status: "saved"; connection: GitHubInstallationConnection }
  | { status: "conflict" };

export type GitHubRepositorySelectionSaveResult =
  | { status: "saved"; selection: GitHubRepositorySelection }
  | { status: "conflict" };

export type GitHubSelectionBindResult =
  | {
      status: "saved";
      selection: GitHubRepositorySelection;
      state: GitHubConnectionState;
    }
  | { status: "conflict" };

/**
 * Durable installation/selection ledger. Implementations must make every CAS
 * commit atomic before returning success.
 */
export interface GitHubInstallationRepository
  extends GitHubProjectProvisioningAuthority {
  loadInstallation(
    connectionId: string,
  ): Promise<GitHubInstallationConnection | null>;
  loadInstallationByConfirmation(
    confirmationId: string,
  ): Promise<GitHubInstallationConnection | null>;
  listInstallationsByWorkspace(
    ownerWorkspaceKey: string,
  ): Promise<GitHubInstallationConnection[]>;
  createInstallation(
    connection: GitHubInstallationConnection,
  ): Promise<GitHubInstallationConnectionSaveResult>;
  saveInstallation(
    connection: Omit<GitHubInstallationConnection, "revision">,
    expectedRevision: number,
  ): Promise<GitHubInstallationConnectionSaveResult>;
  loadSelection(selectionId: string): Promise<GitHubRepositorySelection | null>;
  loadSelectionByConfirmation(
    confirmationId: string,
  ): Promise<GitHubRepositorySelection | null>;
  createSelection(
    selection: GitHubRepositorySelection,
  ): Promise<GitHubRepositorySelectionSaveResult>;
  saveSelection(
    selection: Omit<GitHubRepositorySelection, "revision">,
    expectedRevision: number,
  ): Promise<GitHubRepositorySelectionSaveResult>;
  /** Atomically consumes project_created selection and creates its binding. */
  bindSelection(
    state: GitHubConnectionState,
    selectionId: string,
    expectedSelectionRevision: number,
    updatedAt: string,
  ): Promise<GitHubSelectionBindResult>;
}

export interface GitHubRepositoryAccess {
  ownerWorkspaceKey: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  visibility: GitHubRepositoryVisibility;
  defaultBranch: string;
  baseCommit: string;
  targetBranch: string | null;
  targetBranchHead: string | null;
  canRead: boolean;
  canPush: boolean;
  /** Separate GitHub App installation permission for workflow-file writes. */
  canWriteWorkflows: boolean;
  canCreatePullRequest: boolean;
}

export interface GitHubBrokerHealth {
  available: boolean;
  protocol: "harvy-github-broker/1" | null;
  checkedAt: string;
  reason: string | null;
}

export type GitHubBrokerTransportResult = {
  effectId: string;
  status: "committed";
  /** Terminal server-side fence: no worker for this effectId remains in flight. */
  operationFenced: true;
  externalId: string | null;
  url: string | null;
  completedAt: string;
} | {
  effectId: string;
  status: "not_committed";
  /** Proof that no earlier/later worker can still commit this effectId. */
  operationFenced: true;
  externalId: null;
  url: null;
  completedAt: string;
} | {
  effectId: string;
  status: "unknown";
  /** Unknown is deliberately nonterminal and may only be reconciled, never replayed. */
  operationFenced: false;
  externalId: null;
  url: null;
  completedAt: string;
};

/**
 * Low-level broker protocol for a future durable, private installation
 * controller. It is intentionally not exposed by GitHubBroker or any model
 * executor until Harvy can persist sessions/selections before crossing the
 * external boundary.
 */
export interface GitHubInstallationTransport {
  beginInstallation(
    ownerWorkspaceKey: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GitHubInstallationSession>;
  installationStatus(
    ownerWorkspaceKey: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GitHubInstallationStatus>;
  listRepositories(
    ownerWorkspaceKey: string,
    installationId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryPage>;
  prepareRepositoryArchive(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    commit: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryArchiveReference>;
  downloadRepositoryArchive(
    reference: GitHubRepositoryArchiveReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

/**
 * Implemented in the credential-owning broker trust domain. Every effectId is
 * a permanent server-side idempotency key. `not_committed` is valid only after
 * the broker has durably fenced and joined every worker for that exact key.
 */
export interface GitHubBrokerTransport {
  health(signal?: AbortSignal): Promise<GitHubBrokerHealth>;
  repositoryAccess(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    targetBranch: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryAccess>;
  createBranch(
    effect: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult>;
  pushExactCommit(
    effect: GitHubExactEffect,
    objectBundle: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult>;
  createDraftPullRequest(
    effect: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult>;
  reconcileEffect(
    effect: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult>;
}

/** Explicit fail-closed default; it never accepts App credentials in Harvy. */
export class UnavailableGitHubBrokerTransport
implements GitHubBrokerTransport, GitHubInstallationTransport {
  constructor(
    private readonly reason = "GitHub App Broker belum dikonfigurasi.",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async health(_signal?: AbortSignal): Promise<GitHubBrokerHealth> {
    return {
      available: false,
      protocol: null,
      checkedAt: this.now().toISOString(),
      reason: this.reason,
    };
  }

  async repositoryAccess(
    _ownerWorkspaceKey: string,
    _installationId: string,
    _repositoryId: string,
    _targetBranch: string | null,
    _signal?: AbortSignal,
  ): Promise<GitHubRepositoryAccess> {
    throw new Error(this.reason);
  }

  async beginInstallation(
    _ownerWorkspaceKey: string,
    _sessionId: string,
    _signal?: AbortSignal,
  ): Promise<GitHubInstallationSession> {
    throw new Error(this.reason);
  }

  async installationStatus(
    _ownerWorkspaceKey: string,
    _sessionId: string,
    _signal?: AbortSignal,
  ): Promise<GitHubInstallationStatus> {
    throw new Error(this.reason);
  }

  async listRepositories(
    _ownerWorkspaceKey: string,
    _installationId: string,
    _cursor: string | null,
    _signal?: AbortSignal,
  ): Promise<GitHubRepositoryPage> {
    throw new Error(this.reason);
  }

  async prepareRepositoryArchive(
    _ownerWorkspaceKey: string,
    _installationId: string,
    _repositoryId: string,
    _commit: string,
    _operationId: string,
    _signal?: AbortSignal,
  ): Promise<GitHubRepositoryArchiveReference> {
    throw new Error(this.reason);
  }

  downloadRepositoryArchive(
    _reference: GitHubRepositoryArchiveReference,
    _signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const reason = this.reason;
    return (async function* (): AsyncGenerator<Uint8Array> {
      throw new Error(reason);
    })();
  }

  async createBranch(
    _effect: GitHubExactEffect,
    _signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    throw new Error(this.reason);
  }

  async pushExactCommit(
    _effect: GitHubExactEffect,
    _objectBundle: AsyncIterable<Uint8Array>,
    _signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    throw new Error(this.reason);
  }

  async createDraftPullRequest(
    _effect: GitHubExactEffect,
    _signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    throw new Error(this.reason);
  }

  async reconcileEffect(
    _effect: GitHubExactEffect,
    _signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    throw new Error(this.reason);
  }
}
