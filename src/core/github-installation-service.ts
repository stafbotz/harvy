import { createHash, randomUUID } from "node:crypto";
import type {
  GitHubBrokerTransport,
  GitHubBrokerTransportResult,
  GitHubConnectionState,
  GitHubInstallationConnection,
  GitHubInstallationRepository,
  GitHubInstallationSession,
  GitHubInstallationStatus,
  GitHubInstallationTransport,
  GitHubInteractiveAction,
  GitHubInteractiveAuthority,
  GitHubInteractiveBinding,
  GitHubInteractiveGrant,
  GitHubRepositoryAccess,
  GitHubRepositoryArchiveReference,
  GitHubRepositoryBootstrapAttempt,
  GitHubRepositoryBootstrapEffect,
  GitHubRepositoryPage,
  GitHubRepositorySelection,
  GitHubRepositorySummary,
  GitHubRepositoryVisibility,
} from "../domain/github.js";
import { createGitHubRepositoryBootstrapEffect } from
  "../domain/github-bootstrap.js";
import type { ProjectWorkspace } from "../domain/project-workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { callTransportWithDeadline } from "./transport-deadline.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import {
  ProjectWorkspaceService,
  projectIdForGitHubSelection,
} from "./project-workspace-service.js";

const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
const DEFAULT_INSTALLATION_TTL_MS = 15 * 60_000;
const DEFAULT_SELECTION_TTL_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

export interface GitHubInstallationStartView {
  connection: GitHubInstallationConnection;
  /** Transient browser handoff; never written to the durable repository. */
  authorizationUrl: string | null;
}

export interface GitHubInstallationServiceOptions {
  transportTimeoutMs?: number;
  installationTtlMs?: number;
  selectionTtlMs?: number;
}

export interface GitHubProvisionedSelection {
  selection: GitHubRepositorySelection;
  project: ProjectWorkspace;
}

/**
 * Durable, private-controller lifecycle for GitHub App installations. This is
 * deliberately not a model executor and is not wired into the chat surfaces.
 */
export class GitHubInstallationService {
  private readonly transportTimeoutMs: number;
  private readonly installationTtlMs: number;
  private readonly selectionTtlMs: number;

  constructor(
    private readonly repository: GitHubInstallationRepository,
    private readonly installationTransport: GitHubInstallationTransport,
    private readonly brokerTransport: GitHubBrokerTransport,
    private readonly interactiveAuthority: GitHubInteractiveAuthority,
    private readonly authority: WorkspaceAuthorityService,
    private readonly projects: ProjectWorkspaceService,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
    options: GitHubInstallationServiceOptions = {},
  ) {
    this.transportTimeoutMs = boundedDuration(
      options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
      "transport timeout",
      5 * 60_000,
    );
    this.installationTtlMs = boundedDuration(
      options.installationTtlMs ?? DEFAULT_INSTALLATION_TTL_MS,
      "installation TTL",
      60 * 60_000,
    );
    this.selectionTtlMs = boundedDuration(
      options.selectionTtlMs ?? DEFAULT_SELECTION_TTL_MS,
      "selection TTL",
      60 * 60_000,
    );
  }

  async beginInstallation(
    scope: WorkspaceAgentScope,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubInstallationStartView> {
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read"],
      async () => {
        await this.verifyGrant(scope, grant, {
          action: "github.install.begin",
          connectionId: null,
          repositoryId: null,
          selectionId: null,
        });
        const existing = await this.repository.loadInstallationByConfirmation(
          grant.confirmationId,
        );
        if (existing) {
          assertConnectionOwner(existing, scope);
          if (existing.status !== "pending") {
            return view(existing, null);
          }
          const session = await this.openBrowserSession(existing);
          return view(existing, session.authorizationUrl);
        }

        const at = this.now();
        const connection: GitHubInstallationConnection = {
          version: 1,
          connectionId: opaqueId("github-installation", this.makeId()),
          ownerWorkspaceKey: scope.workspaceKey,
          sessionId: opaqueId("github-session", this.makeId()),
          confirmationId: grant.confirmationId,
          requestedByMembershipId: scope.membershipId,
          requestedAclEpoch: scope.aclEpoch,
          status: "pending",
          installationId: null,
          revocationAuthorityId: null,
          revision: 1,
          createdAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + this.installationTtlMs).toISOString(),
          activatedAt: null,
          revokedAt: null,
          updatedAt: at.toISOString(),
        };
        const created = await this.repository.createInstallation(connection);
        if (created.status === "conflict") {
          const winner = await this.repository.loadInstallationByConfirmation(
            grant.confirmationId,
          );
          if (!winner) {
            throw new Error("GitHub installation WAL berkonflik tanpa winner.");
          }
          assertConnectionOwner(winner, scope);
          if (winner.status !== "pending") return view(winner, null);
          const session = await this.openBrowserSession(winner);
          return view(winner, session.authorizationUrl);
        }

        // WAL is durable before this external boundary. A timeout leaves the
        // same sessionId pending so a retry can reconcile instead of re-begin.
        const session = await this.openBrowserSession(created.connection);
        return view(created.connection, session.authorizationUrl);
      },
    );
  }

  async refreshInstallation(
    scope: WorkspaceAgentScope,
    connectionIdInput: string,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubInstallationConnection> {
    const connectionId = safeOpaque(connectionIdInput, "connectionId", 512);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read"],
      async () => {
        await this.verifyGrant(scope, grant, {
          action: "github.install.status",
          connectionId,
          repositoryId: null,
          selectionId: null,
        });
        const connection = await this.requireConnection(scope, connectionId);
        return this.refreshStoredConnection(connection);
      },
    );
  }

  async listRepositories(
    scope: WorkspaceAgentScope,
    connectionIdInput: string,
    cursorInput: string | null,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubRepositoryPage> {
    const connectionId = safeOpaque(connectionIdInput, "connectionId", 512);
    const cursor = cursorInput === null
      ? null
      : safeOpaque(cursorInput, "repository cursor", 1_024);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read"],
      async () => {
        await this.verifyGrant(scope, grant, {
          action: "github.install.repositories.list",
          connectionId,
          repositoryId: null,
          selectionId: null,
        });
        const stored = await this.requireConnection(scope, connectionId);
        const connection = await this.refreshStoredConnection(stored);
        if (connection.status !== "active" || connection.installationId === null) {
          throw new Error("GitHub installation belum aktif atau sudah dicabut.");
        }
        const page = await this.transportCall(
          "GitHub installation repository list",
          (signal) => this.installationTransport.listRepositories(
            connection.ownerWorkspaceKey,
            connection.installationId!,
            cursor,
            signal,
          ),
        );
        return validateRepositoryPage(page, connection);
      },
    );
  }

  /**
   * Persists the exact selection before archive preparation. If the archive
   * call becomes ambiguous, the same confirmation resumes the same selection.
   */
  async selectRepository(
    scope: WorkspaceAgentScope,
    input: {
      connectionId: string;
      repositoryId: string;
    },
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubRepositorySelection> {
    assertExactKeys(input, ["connectionId", "repositoryId"], "selection input");
    const connectionId = safeOpaque(input.connectionId, "connectionId", 512);
    const repositoryId = safeOpaque(input.repositoryId, "repositoryId", 128);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read", "code.write"],
      async () => {
        await this.verifyGrant(scope, grant, {
          action: "github.repository.select",
          connectionId,
          repositoryId,
          selectionId: null,
        });
        const existing = await this.repository.loadSelectionByConfirmation(
          grant.confirmationId,
        );
        if (existing) {
          assertSelectionBinding(existing, scope, connectionId, repositoryId);
          if (existing.status === "archive_ready") {
            return this.resumeArchiveReady(existing);
          }
          if (existing.status === "bootstrap_required") {
            return clone(existing);
          }
          if (existing.status !== "selected") {
            throw new Error("GitHub repository selection tidak dapat dilanjutkan.");
          }
          return this.prepareSelectionArchive(existing);
        }

        const stored = await this.requireConnection(scope, connectionId);
        const connection = await this.refreshStoredConnection(stored);
        if (connection.status !== "active" || connection.installationId === null) {
          throw new Error("GitHub installation belum aktif atau sudah dicabut.");
        }
        const access = await this.readRepositoryAccess(
          connection,
          repositoryId,
        );
        if (access.empty && (access.visibility !== "private" || !access.canPush)) {
          throw new Error(
            "Bootstrap hanya tersedia untuk repository privat kosong yang dapat ditulis GitHub App.",
          );
        }
        const at = this.now();
        const selection: GitHubRepositorySelection = {
          version: 1,
          selectionId: opaqueId("github-selection", this.makeId()),
          confirmationId: grant.confirmationId,
          ownerWorkspaceKey: scope.workspaceKey,
          installationConnectionId: connection.connectionId,
          installationId: connection.installationId,
          repositoryId: access.repositoryId,
          repositoryFullName: access.repositoryFullName,
          visibility: access.visibility,
          defaultBranch: access.defaultBranch,
          baseCommit: access.baseCommit,
          bootstrapAttempts: [],
          selectedByMembershipId: scope.membershipId,
          selectedAclEpoch: scope.aclEpoch,
          status: access.empty ? "bootstrap_required" : "selected",
          archive: null,
          projectId: null,
          bindingId: null,
          revision: 1,
          selectedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + this.selectionTtlMs).toISOString(),
          updatedAt: at.toISOString(),
        };
        const created = await this.repository.createSelection(selection);
        if (created.status === "conflict") {
          const winner = await this.repository.loadSelectionByConfirmation(
            grant.confirmationId,
          );
          if (!winner) {
            throw new Error("GitHub selection WAL berkonflik tanpa winner.");
          }
          assertSelectionBinding(winner, scope, connectionId, repositoryId);
          if (winner.status === "archive_ready") {
            return this.resumeArchiveReady(winner);
          }
          if (winner.status === "bootstrap_required") return clone(winner);
          if (winner.status !== "selected") {
            throw new Error("GitHub repository selection tidak dapat dilanjutkan.");
          }
          return this.prepareSelectionArchive(winner);
        }
        return created.selection.status === "bootstrap_required"
          ? clone(created.selection)
          : this.prepareSelectionArchive(created.selection);
      },
    );
  }

  /**
   * Initializes a selected, truly empty private repository through one
   * separately confirmed, durable exact effect. The same prepared attempt is
   * replayed by effect id after a crash; an unknown attempt is only observed.
   */
  async bootstrapEmptyRepository(
    scope: WorkspaceAgentScope,
    selectionIdInput: string,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubRepositorySelection> {
    const selectionId = safeOpaque(selectionIdInput, "selectionId", 512);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read", "github.push", "code.write"],
      async () => {
        let selection = await this.repository.loadSelection(selectionId);
        if (!selection || selection.ownerWorkspaceKey !== scope.workspaceKey) {
          throw new Error("GitHub repository selection tidak ditemukan pada workspace ini.");
        }
        await this.verifyGrant(scope, grant, {
          action: "github.repository.bootstrap",
          connectionId: selection.installationConnectionId,
          repositoryId: selection.repositoryId,
          selectionId: selection.selectionId,
        });
        if (selection.status === "archive_ready") {
          return this.resumeArchiveReady(selection);
        }
        if (selection.status === "selected") {
          return this.prepareSelectionArchive(selection);
        }
        if (selection.status !== "bootstrap_required" || selection.baseCommit !== null) {
          throw new Error("Repository GitHub tidak menunggu bootstrap baseline.");
        }
        if (this.now().getTime() >= Date.parse(selection.expiresAt)) {
          await this.saveSelection(selection, {
            ...withoutSelectionRevision(selection),
            status: "cancelled",
            updatedAt: this.now().toISOString(),
          });
          throw new Error("GitHub repository selection sudah kedaluwarsa.");
        }
        const connection = await this.repository.loadInstallation(
          selection.installationConnectionId,
        );
        if (
          !connection ||
          connection.status !== "active" ||
          connection.ownerWorkspaceKey !== scope.workspaceKey ||
          connection.installationId !== selection.installationId
        ) throw new Error("GitHub installation selection tidak lagi aktif.");

        let attempt = selection.bootstrapAttempts.at(-1) ?? null;
        if (!attempt || attempt.status === "not_committed") {
          if (selection.visibility !== "private") {
            throw new Error("Bootstrap GitHub hanya tersedia untuk repository privat.");
          }
          const effect = createGitHubRepositoryBootstrapEffect({
            attempt: (attempt?.effect.attempt ?? 0) + 1,
            ownerWorkspaceKey: selection.ownerWorkspaceKey,
            installationConnectionId: selection.installationConnectionId,
            selectionId: selection.selectionId,
            installationId: selection.installationId,
            repositoryId: selection.repositoryId,
            repositoryFullName: selection.repositoryFullName,
            visibility: selection.visibility,
            defaultBranch: selection.defaultBranch,
          });
          const at = this.now().toISOString();
          attempt = {
            confirmationId: grant.confirmationId,
            approvedByMembershipId: scope.membershipId,
            approvedAclEpoch: scope.aclEpoch,
            effect,
            status: "prepared",
            externalCommit: null,
            url: null,
            createdAt: at,
            updatedAt: at,
          };
          selection = await this.saveSelection(selection, {
            ...withoutSelectionRevision(selection),
            bootstrapAttempts: [...selection.bootstrapAttempts, attempt],
            updatedAt: at,
          });
        }

        const result = attempt.status === "unknown"
          ? await this.transportCall(
              "GitHub bootstrap reconciliation",
              (signal) => this.brokerTransport.reconcileEffect(
                attempt!.effect,
                signal,
              ),
            )
          : attempt.status === "committed"
            ? bootstrapResultFromAttempt(attempt)
            : await this.transportCall(
                "GitHub empty repository bootstrap",
                (signal) => this.brokerTransport.bootstrapRepository(
                  attempt!.effect,
                  signal,
                ),
              );
        const completed = validateBootstrapResult(result, attempt.effect);
        const updatedAttempt: GitHubRepositoryBootstrapAttempt = {
          ...attempt,
          status: completed.status,
          externalCommit: completed.status === "committed"
            ? completed.externalId
            : null,
          url: completed.status === "committed" ? completed.url : null,
          updatedAt: completed.completedAt,
        };
        selection = await this.saveSelection(selection, {
          ...withoutSelectionRevision(selection),
          bootstrapAttempts: [
            ...selection.bootstrapAttempts.slice(0, -1),
            updatedAttempt,
          ],
          updatedAt: this.now().toISOString(),
        });
        if (completed.status === "unknown") {
          throw new Error(
            "Hasil bootstrap repository GitHub belum diketahui; Harvy hanya akan merekonsiliasi effect ini.",
          );
        }
        if (completed.status === "not_committed") {
          throw new Error(
            "Bootstrap repository GitHub terbukti belum terjadi; konfirmasi baru dapat mencoba attempt berikutnya.",
          );
        }
        const access = await this.readRepositoryAccess(
          connection,
          selection.repositoryId,
        );
        if (
          access.empty ||
          access.baseCommit === null ||
          access.baseCommit !== completed.externalId ||
          access.repositoryFullName !== selection.repositoryFullName ||
          access.visibility !== "private" ||
          access.defaultBranch !== selection.defaultBranch
        ) {
          throw new Error("Baseline GitHub committed tetapi head repository berubah sebelum provisioning.");
        }
        selection = await this.saveSelection(selection, {
          ...withoutSelectionRevision(selection),
          status: "selected",
          baseCommit: access.baseCommit,
          updatedAt: this.now().toISOString(),
        });
        return this.prepareSelectionArchive(selection);
      },
    );
  }

  /**
   * Resumes the provisioning saga from the durable selection. Download and
   * project creation are exact/idempotent; a crash after project creation is
   * recovered through the deterministic project id.
   */
  async provisionRepository(
    scope: WorkspaceAgentScope,
    selectionIdInput: string,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubProvisionedSelection> {
    const selectionId = safeOpaque(selectionIdInput, "selectionId", 512);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read", "code.write"],
      async () => {
        const initial = await this.repository.loadSelection(selectionId);
        if (
          !initial ||
          initial.ownerWorkspaceKey !== scope.workspaceKey
        ) {
          throw new Error("GitHub repository selection tidak ditemukan pada workspace ini.");
        }
        await this.verifyGrant(scope, grant, {
          action: "github.repository.provision",
          connectionId: initial.installationConnectionId,
          repositoryId: initial.repositoryId,
          selectionId: initial.selectionId,
        });
        let selection = initial;
        if (selection.status === "selected") {
          selection = await this.prepareSelectionArchive(selection);
        }
        if (
          selection.status !== "archive_ready" &&
          selection.status !== "project_created" &&
          selection.status !== "bound"
        ) {
          throw new Error("GitHub repository selection tidak dapat diprovisioning.");
        }

        // Recover a deterministic project before touching the expiring archive
        // capability. This closes the crash window after ProjectWorkspace was
        // committed but before `project_created` reached the selection ledger.
        const deterministicProjectId = projectIdForGitHubSelection(
          selection.selectionId,
        );
        if (
          selection.projectId !== null &&
          selection.projectId !== deterministicProjectId
        ) {
          throw new Error("Project id durable GitHub selection tidak deterministik.");
        }
        let project = await this.projects.getGitHubProvisioningProject(
          scope,
          selection.selectionId,
        );
        if (project) {
          assertProvisionedProject(project, selection);
          if (Date.parse(project.createdAt) > Date.parse(selection.expiresAt)) {
            throw new Error("Project GitHub dibuat setelah authority selection kedaluwarsa.");
          }
          if (selection.status === "bound") {
            if (!selection.bindingId) {
              throw new Error("GitHub selection bound kehilangan binding id.");
            }
            project = await this.projects.activateGitHubSelectionProject(
              scope,
              selection.selectionId,
              selection.bindingId,
            );
            return Object.freeze({
              selection: clone(selection),
              project: clone(project),
            });
          }
          if (this.now().getTime() >= Date.parse(selection.expiresAt)) {
            await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "cleanup_required",
              projectId: project.id,
              updatedAt: this.now().toISOString(),
            });
            throw new Error(
              "GitHub repository selection kedaluwarsa sebelum binding.",
            );
          }
          if (selection.projectId === null) {
            selection = await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "project_created",
              projectId: project.id,
              updatedAt: this.now().toISOString(),
            });
          }
        } else if (
          selection.status === "project_created" ||
          selection.status === "bound"
        ) {
          throw new Error("Project provisioning GitHub hilang setelah durable commit.");
        }

        if (!project && this.now().getTime() >= Date.parse(selection.expiresAt)) {
          await this.saveSelection(selection, {
            ...withoutSelectionRevision(selection),
            status: "cancelled",
            updatedAt: this.now().toISOString(),
          });
          throw new Error("GitHub repository selection sudah kedaluwarsa.");
        }
        const connection = await this.repository.loadInstallation(
          selection.installationConnectionId,
        );
        if (!connection || connection.ownerWorkspaceKey !== scope.workspaceKey) {
          throw new Error("GitHub installation selection tidak ditemukan.");
        }
        const refreshed = await this.refreshStoredConnection(connection);
        if (
          refreshed.status !== "active" ||
          refreshed.installationId !== selection.installationId
        ) {
          if (project && selection.status === "project_created") {
            await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "cleanup_required",
              updatedAt: this.now().toISOString(),
            });
          }
          throw new Error("GitHub installation selection tidak lagi aktif.");
        }
        if (!selection.archive) {
          throw new Error("GitHub repository selection belum mempunyai archive exact.");
        }
        if (selection.baseCommit === null) {
          throw new Error("GitHub repository selection belum mempunyai baseline commit.");
        }
        if (!project) {
          if (this.now().getTime() >= Date.parse(selection.archive.expiresAt)) {
            await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "cancelled",
              updatedAt: this.now().toISOString(),
            });
            throw new Error("Archive GitHub selection sudah kedaluwarsa.");
          }
          const archive = await this.downloadExactArchive(selection.archive);
          project = await this.projects.createFromGitHubSelection(scope, {
            selectionId: selection.selectionId,
            installationConnectionId: selection.installationConnectionId,
            repositoryId: selection.repositoryId,
            installationId: selection.installationId,
            archiveSha256: selection.archive.sha256,
            archive,
            git: {
              baseCommit: selection.baseCommit,
              headCommit: selection.baseCommit,
              branch: selection.defaultBranch,
            },
          });
          assertProvisionedProject(project, selection);
          const completedAt = this.now();
          if (
            completedAt.getTime() >= Date.parse(selection.expiresAt) ||
            completedAt.getTime() >= Date.parse(selection.archive.expiresAt)
          ) {
            await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "cleanup_required",
              projectId: project.id,
              updatedAt: completedAt.toISOString(),
            });
            throw new Error(
              "GitHub repository selection kedaluwarsa saat project dimaterialisasi.",
            );
          }
          selection = await this.saveSelection(selection, {
            ...withoutSelectionRevision(selection),
            status: "project_created",
            projectId: project.id,
            updatedAt: this.now().toISOString(),
          });
        }
        if (selection.status === "project_created") {
          const bindingAt = this.now();
          if (
            bindingAt.getTime() >= Date.parse(selection.expiresAt) ||
            (selection.archive !== null &&
              bindingAt.getTime() >= Date.parse(selection.archive.expiresAt))
          ) {
            await this.saveSelection(selection, {
              ...withoutSelectionRevision(selection),
              status: "cleanup_required",
              updatedAt: bindingAt.toISOString(),
            });
            throw new Error("GitHub repository selection kedaluwarsa sebelum binding.");
          }
          selection = await this.bindProvisionedSelection(selection, project);
        }
        if (!selection.bindingId) {
          throw new Error("GitHub repository selection bound kehilangan binding id.");
        }
        project = await this.projects.activateGitHubSelectionProject(
          scope,
          selection.selectionId,
          selection.bindingId,
        );
        return Object.freeze({
          selection: clone(selection),
          project: clone(project),
        });
      },
    );
  }

  /** Local fail-closed revocation. Remote App unlink remains broker-owned. */
  async revokeInstallation(
    scope: WorkspaceAgentScope,
    connectionIdInput: string,
    grantInput: GitHubInteractiveGrant,
  ): Promise<GitHubInstallationConnection> {
    const connectionId = safeOpaque(connectionIdInput, "connectionId", 512);
    const grant = validateInteractiveGrant(grantInput, this.now());
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read"],
      async () => {
        await this.verifyGrant(scope, grant, {
          action: "github.install.revoke",
          connectionId,
          repositoryId: null,
          selectionId: null,
        });
        const connection = await this.requireConnection(scope, connectionId);
        if (connection.status === "revoked") {
          if (connection.revocationAuthorityId !== grant.confirmationId) {
            throw new Error("GitHub installation sudah dicabut oleh authority lain.");
          }
          return clone(connection);
        }
        if (connection.status === "expired") {
          throw new Error("GitHub installation session sudah kedaluwarsa.");
        }
        const at = this.now().toISOString();
        return this.saveConnection(connection, {
          ...withoutRevision(connection),
          status: "revoked",
          revocationAuthorityId: grant.confirmationId,
          revokedAt: at,
          updatedAt: at,
        });
      },
    );
  }

  private async openBrowserSession(
    connection: GitHubInstallationConnection,
  ): Promise<GitHubInstallationSession> {
    if (connection.status !== "pending") {
      throw new Error("Hanya GitHub installation pending yang dapat dibuka.");
    }
    if (this.now().getTime() >= Date.parse(connection.expiresAt)) {
      throw new Error("GitHub installation session sudah kedaluwarsa.");
    }
    const session = await this.transportCall(
      "GitHub installation begin",
      (signal) => this.installationTransport.beginInstallation(
        connection.ownerWorkspaceKey,
        connection.sessionId,
        signal,
      ),
    );
    return validateInstallationSession(session, connection, this.now());
  }

  private async refreshStoredConnection(
    connection: GitHubInstallationConnection,
  ): Promise<GitHubInstallationConnection> {
    if (connection.status === "expired" || connection.status === "revoked") {
      return clone(connection);
    }
    const status = await this.transportCall(
      "GitHub installation status",
      (signal) => this.installationTransport.installationStatus(
        connection.ownerWorkspaceKey,
        connection.sessionId,
        signal,
      ),
    );
    const observed = validateInstallationStatus(status, connection);
    const now = this.now();
    if (observed.status === "pending") {
      if (connection.status === "active") {
        throw new Error("Broker menurunkan GitHub installation active menjadi pending.");
      }
      if (now.getTime() < Date.parse(connection.expiresAt)) return clone(connection);
      return this.saveConnection(connection, {
        ...withoutRevision(connection),
        status: "expired",
        updatedAt: now.toISOString(),
      });
    }
    if (observed.status === "ready") {
      if (observed.installationId === null || observed.completedAt === null) {
        throw new Error("Status ready GitHub installation tidak lengkap.");
      }
      if (Date.parse(observed.completedAt) > Date.parse(connection.expiresAt)) {
        if (connection.status === "active") {
          throw new Error("Broker mengubah completion GitHub installation active.");
        }
        return this.saveConnection(connection, {
          ...withoutRevision(connection),
          status: "expired",
          updatedAt: now.toISOString(),
        });
      }
      if (connection.status === "active") {
        if (connection.installationId !== observed.installationId) {
          throw new Error("Broker mengubah installation id GitHub yang sudah aktif.");
        }
        return clone(connection);
      }
      return this.saveConnection(connection, {
        ...withoutRevision(connection),
        status: "active",
        installationId: observed.installationId,
        activatedAt: observed.completedAt,
        updatedAt: now.toISOString(),
      });
    }
    if (observed.status === "expired") {
      if (connection.status === "active") {
        throw new Error("Broker menurunkan GitHub installation active menjadi expired.");
      }
      return this.saveConnection(connection, {
        ...withoutRevision(connection),
        status: "expired",
        updatedAt: now.toISOString(),
      });
    }
    const revokedAt = observed.completedAt ?? now.toISOString();
    return this.saveConnection(connection, {
      ...withoutRevision(connection),
      status: "revoked",
      revocationAuthorityId: brokerRevocationId(connection.sessionId),
      revokedAt,
      updatedAt: now.toISOString(),
    });
  }

  private async prepareSelectionArchive(
    selection: GitHubRepositorySelection,
  ): Promise<GitHubRepositorySelection> {
    if (selection.baseCommit === null || selection.status === "bootstrap_required") {
      throw new Error("Repository GitHub kosong memerlukan bootstrap baseline terpisah.");
    }
    const baseCommit = selection.baseCommit;
    if (this.now().getTime() >= Date.parse(selection.expiresAt)) {
      const cancelled = await this.saveSelection(selection, {
        ...withoutSelectionRevision(selection),
        status: "cancelled",
        updatedAt: this.now().toISOString(),
      });
      throw new Error(
        `GitHub repository selection ${cancelled.selectionId} sudah kedaluwarsa.`,
      );
    }
    const connection = await this.repository.loadInstallation(
      selection.installationConnectionId,
    );
    if (
      !connection ||
      connection.status !== "active" ||
      connection.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
      connection.installationId !== selection.installationId
    ) {
      throw new Error("GitHub installation selection tidak lagi aktif.");
    }
    const access = await this.readRepositoryAccess(
      connection,
      selection.repositoryId,
    );
    if (
      access.repositoryFullName !== selection.repositoryFullName ||
      access.visibility !== selection.visibility ||
      access.defaultBranch !== selection.defaultBranch ||
      access.baseCommit !== selection.baseCommit
    ) {
      await this.saveSelection(selection, {
        ...withoutSelectionRevision(selection),
        status: "cancelled",
        updatedAt: this.now().toISOString(),
      });
      throw new Error("Repository GitHub berubah setelah selection dikonfirmasi.");
    }
    const archive = await this.transportCall(
      "GitHub repository archive prepare",
      (signal) => this.installationTransport.prepareRepositoryArchive(
        selection.ownerWorkspaceKey,
        selection.installationId,
        selection.repositoryId,
        baseCommit,
        selection.selectionId,
        signal,
      ),
    );
    const completedAt = this.now();
    if (completedAt.getTime() >= Date.parse(selection.expiresAt)) {
      await this.saveSelection(selection, {
        ...withoutSelectionRevision(selection),
        status: "cancelled",
        updatedAt: completedAt.toISOString(),
      });
      throw new Error("GitHub repository selection kedaluwarsa saat archive disiapkan.");
    }
    const reference = validateArchiveReference(
      archive,
      selection,
      completedAt,
    );
    return this.saveSelection(selection, {
      ...withoutSelectionRevision(selection),
      status: "archive_ready",
      archive: reference,
      updatedAt: this.now().toISOString(),
    });
  }

  private async resumeArchiveReady(
    selection: GitHubRepositorySelection,
  ): Promise<GitHubRepositorySelection> {
    const now = this.now();
    if (
      selection.archive &&
      now.getTime() < Date.parse(selection.expiresAt) &&
      now.getTime() < Date.parse(selection.archive.expiresAt)
    ) {
      return clone(selection);
    }
    const cancelled = await this.saveSelection(selection, {
      ...withoutSelectionRevision(selection),
      status: "cancelled",
      updatedAt: now.toISOString(),
    });
    throw new Error(
      `GitHub repository selection ${cancelled.selectionId} sudah kedaluwarsa.`,
    );
  }

  private async downloadExactArchive(
    reference: GitHubRepositoryArchiveReference,
  ): Promise<Buffer> {
    return this.transportCall(
      "GitHub repository archive download",
      async (signal) => {
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of this.installationTransport
          .downloadRepositoryArchive(reference, signal)) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) {
            throw new Error("Chunk archive GitHub tidak sah.");
          }
          if (signal.aborted) throw abortError();
          size += chunk.byteLength;
          if (size > reference.size || size > MAX_ARCHIVE_BYTES) {
            throw new Error("Archive GitHub melewati ukuran descriptor/batas.");
          }
          const bytes = Buffer.from(chunk);
          hash.update(bytes);
          chunks.push(bytes);
        }
        if (
          size !== reference.size ||
          hash.digest("hex") !== reference.sha256
        ) {
          throw new Error("Archive GitHub terpotong atau digest berubah.");
        }
        return Buffer.concat(chunks, size);
      },
    );
  }

  private async bindProvisionedSelection(
    selection: GitHubRepositorySelection,
    project: ProjectWorkspace,
  ): Promise<GitHubRepositorySelection> {
    assertProvisionedProject(project, selection);
    const at = this.now().toISOString();
    const state: GitHubConnectionState = {
      version: 1,
      binding: {
        bindingId: deterministicBindingId(selection.selectionId),
        projectId: project.id,
        ownerWorkspaceKey: selection.ownerWorkspaceKey,
        installationConnectionId: selection.installationConnectionId,
        repositorySelectionId: selection.selectionId,
        installationId: selection.installationId,
        repositoryId: selection.repositoryId,
        repositoryFullName: selection.repositoryFullName,
        visibility: selection.visibility,
        defaultBranch: selection.defaultBranch,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        revokedAt: null,
      },
      approvals: [],
      receipts: [],
    };
    const bound = await this.repository.bindSelection(
      state,
      selection.selectionId,
      selection.revision,
      at,
    );
    if (bound.status === "saved") return bound.selection;
    const winner = await this.repository.loadSelection(selection.selectionId);
    if (
      winner?.status === "bound" &&
      winner.projectId === project.id &&
      winner.bindingId === state.binding.bindingId
    ) {
      return winner;
    }
    throw new Error("GitHub selection/binding berubah bersamaan; muat ulang state.");
  }

  private async readRepositoryAccess(
    connection: GitHubInstallationConnection,
    repositoryId: string,
  ): Promise<GitHubRepositoryAccess> {
    const access = await this.transportCall(
      "GitHub installation repository access",
      (signal) => this.brokerTransport.repositoryAccess(
        connection.ownerWorkspaceKey,
        connection.installationId!,
        repositoryId,
        null,
        signal,
      ),
    );
    return validateRepositoryAccess(access, connection, repositoryId);
  }

  private async requireConnection(
    scope: WorkspaceAgentScope,
    connectionId: string,
  ): Promise<GitHubInstallationConnection> {
    const connection = await this.repository.loadInstallation(connectionId);
    if (!connection || connection.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("GitHub installation tidak ditemukan pada workspace ini.");
    }
    return connection;
  }

  private async saveConnection(
    current: GitHubInstallationConnection,
    next: Omit<GitHubInstallationConnection, "revision">,
  ): Promise<GitHubInstallationConnection> {
    const saved = await this.repository.saveInstallation(next, current.revision);
    if (saved.status === "saved") return saved.connection;
    const winner = await this.repository.loadInstallation(current.connectionId);
    if (winner && JSON.stringify(withoutRevision(winner)) === JSON.stringify(next)) {
      return winner;
    }
    throw new Error("GitHub installation berubah bersamaan; muat ulang state.");
  }

  private async saveSelection(
    current: GitHubRepositorySelection,
    next: Omit<GitHubRepositorySelection, "revision">,
  ): Promise<GitHubRepositorySelection> {
    const saved = await this.repository.saveSelection(next, current.revision);
    if (saved.status === "saved") return saved.selection;
    const winner = await this.repository.loadSelection(current.selectionId);
    if (
      winner &&
      JSON.stringify(withoutSelectionRevision(winner)) === JSON.stringify(next)
    ) {
      return winner;
    }
    throw new Error("GitHub repository selection berubah bersamaan; muat ulang state.");
  }

  private async verifyGrant(
    scope: WorkspaceAgentScope,
    grant: GitHubInteractiveGrant,
    input: {
      action: GitHubInteractiveAction;
      connectionId: string | null;
      repositoryId: string | null;
      selectionId: string | null;
    },
  ): Promise<void> {
    const binding: GitHubInteractiveBinding = {
      action: input.action,
      interactionId: grant.interactionId,
      audience: "workspace-private",
      ownerWorkspaceKey: scope.workspaceKey,
      membershipId: scope.membershipId,
      aclEpoch: scope.aclEpoch,
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      selectionId: input.selectionId,
    };
    const valid = await this.transportCall(
      "GitHub interactive confirmation verification",
      (signal) => this.interactiveAuthority.verify(grant, binding, signal),
    );
    if (valid !== true) {
      throw new Error("Confirmation controller GitHub tidak sah atau sudah dipakai.");
    }
  }

  private transportCall<T>(
    operation: string,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return callTransportWithDeadline(
      operation,
      this.transportTimeoutMs,
      call,
    );
  }
}

function validateInteractiveGrant(
  input: GitHubInteractiveGrant,
  now: Date,
): GitHubInteractiveGrant {
  assertExactKeys(
    input,
    ["confirmationId", "interactionId", "audience", "proof", "expiresAt"],
    "grant",
  );
  if (input.audience !== "workspace-private") {
    throw new Error("Audience confirmation controller GitHub harus workspace-private.");
  }
  const grant = {
    confirmationId: safeOpaque(input.confirmationId, "confirmationId", 512),
    interactionId: safeOpaque(input.interactionId, "interactionId", 512),
    audience: "workspace-private" as const,
    proof: boundedTransientProof(input.proof),
    expiresAt: validIso(input.expiresAt, "grant.expiresAt"),
  };
  const expiry = Date.parse(grant.expiresAt);
  if (expiry <= now.getTime() || expiry > now.getTime() + 60 * 60_000) {
    throw new Error("Expiry confirmation controller GitHub tidak sah.");
  }
  return grant;
}

function validateInstallationSession(
  value: GitHubInstallationSession,
  connection: GitHubInstallationConnection,
  now: Date,
): GitHubInstallationSession {
  assertExactKeys(value, [
    "sessionId", "ownerWorkspaceKey", "status", "authorizationUrl",
    "createdAt", "expiresAt",
  ], "installation session");
  if (
    value.sessionId !== connection.sessionId ||
    value.ownerWorkspaceKey !== connection.ownerWorkspaceKey ||
    value.status !== "pending"
  ) {
    throw new Error("Binding GitHub installation session tidak cocok.");
  }
  validIso(value.createdAt, "session.createdAt");
  validIso(value.expiresAt, "session.expiresAt");
  if (
    Date.parse(value.expiresAt) <= now.getTime() ||
    Date.parse(value.createdAt) > now.getTime() + 60_000
  ) {
    throw new Error("Waktu GitHub installation session tidak sah.");
  }
  validInstallationUrl(value.authorizationUrl);
  return clone(value);
}

function validateInstallationStatus(
  value: GitHubInstallationStatus,
  connection: GitHubInstallationConnection,
): GitHubInstallationStatus {
  assertExactKeys(value, [
    "sessionId", "ownerWorkspaceKey", "status", "installationId",
    "completedAt", "expiresAt",
  ], "installation status");
  if (
    value.sessionId !== connection.sessionId ||
    value.ownerWorkspaceKey !== connection.ownerWorkspaceKey ||
    !["pending", "ready", "expired", "revoked"].includes(value.status)
  ) {
    throw new Error("Binding/status GitHub installation tidak cocok.");
  }
  validIso(value.expiresAt, "status.expiresAt");
  if (value.installationId !== null) {
    safeOpaque(value.installationId, "installationId", 128);
  }
  if (value.completedAt !== null) validIso(value.completedAt, "status.completedAt");
  if (
    (value.status === "ready" &&
      (value.installationId === null || value.completedAt === null)) ||
    (value.status === "pending" &&
      (value.installationId !== null || value.completedAt !== null)) ||
    (value.status === "expired" && value.installationId !== null)
  ) {
    throw new Error("Payload status GitHub installation tidak konsisten.");
  }
  return clone(value);
}

function validateRepositoryPage(
  value: GitHubRepositoryPage,
  connection: GitHubInstallationConnection,
): GitHubRepositoryPage {
  assertExactKeys(value, [
    "ownerWorkspaceKey", "installationId", "repositories", "nextCursor",
  ], "repository page");
  if (
    value.ownerWorkspaceKey !== connection.ownerWorkspaceKey ||
    value.installationId !== connection.installationId ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 100
  ) {
    throw new Error("Binding/page repository GitHub tidak sah.");
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const repository of value.repositories) {
    validateRepositorySummary(repository, connection.installationId!);
    if (ids.has(repository.repositoryId) || names.has(repository.repositoryFullName)) {
      throw new Error("Repository GitHub duplikat pada satu page.");
    }
    ids.add(repository.repositoryId);
    names.add(repository.repositoryFullName);
  }
  if (value.nextCursor !== null) {
    safeOpaque(value.nextCursor, "nextCursor", 1_024);
  }
  return clone(value);
}

function validateRepositorySummary(
  value: GitHubRepositorySummary,
  installationId: string,
): void {
  assertExactKeys(value, [
    "installationId", "repositoryId", "repositoryFullName", "visibility",
    "defaultBranch",
  ], "repository summary");
  if (value.installationId !== installationId) {
    throw new Error("Repository GitHub berasal dari installation lain.");
  }
  safeOpaque(value.repositoryId, "repositoryId", 128);
  validRepositoryFullName(value.repositoryFullName);
  validVisibility(value.visibility);
  validBranch(value.defaultBranch);
}

function validateRepositoryAccess(
  value: GitHubRepositoryAccess,
  connection: GitHubInstallationConnection,
  repositoryId: string,
): GitHubRepositoryAccess {
  assertExactKeys(value, [
    "ownerWorkspaceKey", "installationId", "repositoryId",
    "repositoryFullName", "visibility", "defaultBranch", "baseCommit",
    "empty", "targetBranch", "targetBranchHead", "canRead", "canPush",
    "canWriteWorkflows", "canCreatePullRequest",
  ], "repository access");
  if (
    value.ownerWorkspaceKey !== connection.ownerWorkspaceKey ||
    value.installationId !== connection.installationId ||
    value.repositoryId !== repositoryId ||
    value.targetBranch !== null ||
    value.targetBranchHead !== null ||
    value.canRead !== true ||
    typeof value.empty !== "boolean" ||
    value.empty !== (value.baseCommit === null)
  ) {
    throw new Error("Authority repository GitHub tidak cocok selection.");
  }
  validRepositoryFullName(value.repositoryFullName);
  validVisibility(value.visibility);
  validBranch(value.defaultBranch);
  if (value.baseCommit !== null) validGitCommit(value.baseCommit, "baseCommit");
  for (const flag of [
    value.canPush,
    value.canWriteWorkflows,
    value.canCreatePullRequest,
  ]) {
    if (typeof flag !== "boolean") {
      throw new Error("Flag authority repository GitHub tidak sah.");
    }
  }
  return clone(value);
}

function validateArchiveReference(
  value: GitHubRepositoryArchiveReference,
  selection: GitHubRepositorySelection,
  now: Date,
): GitHubRepositoryArchiveReference {
  assertExactKeys(value, [
    "version", "operationId", "archiveId", "ownerWorkspaceKey", "installationId",
    "repositoryId", "repositoryFullName", "defaultBranch", "commit",
    "mediaType", "sha256", "size", "createdAt", "expiresAt",
  ], "archive reference");
  if (
    value.version !== 1 ||
    value.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
    value.installationId !== selection.installationId ||
    value.repositoryId !== selection.repositoryId ||
    value.operationId !== selection.selectionId ||
    value.repositoryFullName !== selection.repositoryFullName ||
    value.defaultBranch !== selection.defaultBranch ||
    value.commit !== selection.baseCommit ||
    value.mediaType !== "application/zip" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  ) {
    throw new Error("Archive GitHub tidak cocok selection atau melewati batas.");
  }
  safeOpaque(value.operationId, "archive operationId", 512);
  safeOpaque(value.archiveId, "archiveId", 512);
  validIso(value.createdAt, "archive.createdAt");
  validIso(value.expiresAt, "archive.expiresAt");
  if (
    Date.parse(value.expiresAt) <= now.getTime() ||
    Date.parse(value.expiresAt) < Date.parse(selection.expiresAt) ||
    Date.parse(value.createdAt) > now.getTime() + 60_000 ||
    Date.parse(value.expiresAt) > now.getTime() + 60 * 60_000
  ) {
    throw new Error("Expiry archive GitHub tidak sah untuk selection.");
  }
  return clone(value);
}

function bootstrapResultFromAttempt(
  attempt: GitHubRepositoryBootstrapAttempt,
): GitHubBrokerTransportResult {
  if (
    attempt.status !== "committed" ||
    attempt.externalCommit === null ||
    attempt.url === null
  ) throw new Error("Receipt bootstrap GitHub committed tidak lengkap.");
  return {
    effectId: attempt.effect.effectId,
    status: "committed",
    operationFenced: true,
    externalId: attempt.externalCommit,
    url: attempt.url,
    completedAt: attempt.updatedAt,
  };
}

function validateBootstrapResult(
  value: GitHubBrokerTransportResult,
  effect: GitHubRepositoryBootstrapEffect,
): GitHubBrokerTransportResult {
  assertExactKeys(value, [
    "effectId",
    "status",
    "operationFenced",
    "externalId",
    "url",
    "completedAt",
  ], "bootstrap result");
  if (
    value.effectId !== effect.effectId ||
    (value.status === "unknown" && value.operationFenced !== false) ||
    (value.status !== "unknown" && value.operationFenced !== true)
  ) throw new Error("Fence/identity hasil bootstrap GitHub tidak sah.");
  validIso(value.completedAt, "bootstrap completedAt");
  if (value.status !== "committed") {
    if (value.externalId !== null || value.url !== null) {
      throw new Error("Bootstrap GitHub non-committed membawa metadata eksternal.");
    }
    return clone(value);
  }
  if (typeof value.externalId !== "string") {
    throw new Error("Commit receipt bootstrap GitHub tidak tersedia.");
  }
  validGitCommit(value.externalId, "bootstrap external commit");
  if (typeof value.url !== "string") {
    throw new Error("URL receipt bootstrap GitHub tidak tersedia.");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("URL receipt bootstrap GitHub tidak sah.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/${effect.repositoryFullName}/commit/${value.externalId}`
  ) throw new Error("URL receipt bootstrap GitHub tidak exact.");
  return clone(value);
}

function validInstallationUrl(value: unknown): void {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("URL GitHub installation tidak sah.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL GitHub installation tidak sah.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !/^\/apps\/[A-Za-z0-9-]+\/installations\/new\/?$/u.test(url.pathname)
  ) {
    throw new Error("URL GitHub installation keluar dari origin/path resmi.");
  }
  for (const [key, nested] of url.searchParams) {
    if (
      /(?:token|secret|credential|password|code|private.?key)/iu.test(key) ||
      containsSecretLikeValue(nested)
    ) {
      throw new Error("URL GitHub installation memuat credential-like query.");
    }
  }
}

function assertConnectionOwner(
  connection: GitHubInstallationConnection,
  scope: WorkspaceAgentScope,
): void {
  if (
    connection.ownerWorkspaceKey !== scope.workspaceKey ||
    connection.requestedByMembershipId !== scope.membershipId
  ) {
    throw new Error("Confirmation GitHub sudah terikat ke actor/workspace lain.");
  }
}

function assertSelectionBinding(
  selection: GitHubRepositorySelection,
  scope: WorkspaceAgentScope,
  connectionId: string,
  repositoryId: string,
): void {
  if (
    selection.ownerWorkspaceKey !== scope.workspaceKey ||
    selection.selectedByMembershipId !== scope.membershipId ||
    selection.installationConnectionId !== connectionId ||
    selection.repositoryId !== repositoryId
  ) {
    throw new Error("Confirmation GitHub sudah terikat ke selection lain.");
  }
}

function assertProvisionedProject(
  project: ProjectWorkspace,
  selection: GitHubRepositorySelection,
): void {
  if (
    project.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
    project.source.type !== "github" ||
    project.source.repositorySelectionId !== selection.selectionId ||
    project.source.installationConnectionId !==
      selection.installationConnectionId ||
    project.source.repositoryId !== selection.repositoryId ||
    project.source.installationId !== selection.installationId ||
    !(
      (project.revision === 1 &&
        (project.source.provisioningStatus === "pending" ||
          project.source.provisioningStatus === undefined) &&
        project.source.repositoryBindingId === undefined) ||
      (project.revision === 2 &&
        project.source.provisioningStatus === "bound" &&
        selection.status === "bound" &&
        project.source.repositoryBindingId === selection.bindingId)
    ) ||
    !project.git ||
    project.git.baseCommit !== selection.baseCommit ||
    project.git.headCommit !== selection.baseCommit ||
    project.git.branch !== selection.defaultBranch
  ) {
    throw new Error("ProjectWorkspace tidak cocok durable GitHub selection.");
  }
}

function view(
  connection: GitHubInstallationConnection,
  authorizationUrl: string | null,
): GitHubInstallationStartView {
  return Object.freeze({ connection: clone(connection), authorizationUrl });
}

function brokerRevocationId(sessionId: string): string {
  return `broker-revocation-${createHash("sha256").update(sessionId).digest("hex")}`;
}

function deterministicBindingId(selectionId: string): string {
  return `github-binding-${createHash("sha256")
    .update("harvy-github-selection-binding-v1\0", "utf8")
    .update(selectionId, "utf8")
    .digest("hex")}`;
}

function withoutRevision(
  connection: GitHubInstallationConnection,
): Omit<GitHubInstallationConnection, "revision"> {
  const { revision: _revision, ...rest } = connection;
  return rest;
}

function withoutSelectionRevision(
  selection: GitHubRepositorySelection,
): Omit<GitHubRepositorySelection, "revision"> {
  const { revision: _revision, ...rest } = selection;
  return rest;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function opaqueId(prefix: string, input: string): string {
  return `${prefix}-${safeOpaque(input, prefix, 256)}`;
}

function safeOpaque(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /\p{Cc}/u.test(value) ||
    containsSecretLikeValue(value)
  ) {
    throw new Error(`${field} GitHub tidak sah atau credential-like.`);
  }
  return value;
}

function boundedTransientProof(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4_096 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("Proof controller GitHub tidak sah.");
  }
  return value;
}

function validRepositoryFullName(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) ||
    containsSecretLikeValue(value)
  ) {
    throw new Error("Nama penuh repository GitHub tidak sah.");
  }
}

function validVisibility(value: unknown): asserts value is GitHubRepositoryVisibility {
  if (value !== "public" && value !== "private" && value !== "internal") {
    throw new Error("Visibility repository GitHub tidak sah.");
  }
}

function validBranch(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[~^:?*[\\\p{Cc}\s]/u.test(value) ||
    containsSecretLikeValue(value)
  ) {
    throw new Error("Branch GitHub tidak sah.");
  }
}

function validGitCommit(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) {
    throw new Error(`${field} GitHub tidak sah.`);
  }
}

function validIso(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} GitHub tidak sah.`);
  }
  return value;
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(`Schema GitHub ${label} memuat field asing atau hilang.`);
  }
}

function boundedDuration(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} GitHub installation tidak sah.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("GitHub installation transport dibatalkan.");
  error.name = "AbortError";
  return error;
}
