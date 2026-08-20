import { randomBytes } from "node:crypto";
import type {
  GitHubCapability,
  GitHubEffectReceipt,
  GitHubExactEffect,
  GitHubInstallationConnection,
  GitHubRepositoryPage,
} from "../domain/github.js";
import type { WorkspacePrincipal } from "../domain/workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import type { AuthenticatedWorkspaceActor, WorkspaceActorResolver } from "./workspace-coding-controller.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import { CodingRunEngine } from "./coding-run-engine.js";
import { GitHubBroker } from "./github-broker.js";
import { GitHubInstallationService, type GitHubInstallationStartView } from "./github-installation-service.js";
import { PrivateGitHubConfirmationController } from "./private-github-confirmation-controller.js";
import { FileGitHubConnectionRepository } from "../storage/file-github-connection-repository.js";
import {
  FilePrivateCodingSessionStore,
  type PrivateCodingSession,
} from "../storage/file-private-coding-session-store.js";
import { containsSecretLikeValue } from "../security/credential-like.js";

const OFFER_TTL_MS = 10 * 60_000;
const MAX_OFFERS = 2_048;

export interface PrivateGitHubPublishOffer {
  offerId: string;
  effectId: string;
  capability: GitHubCapability;
  repositoryFullName: string;
  branch: string;
  commit: string;
  baseCommit: string;
  actorMembershipId: string;
  authorityRevision: number;
  audience: "workspace-private";
  expiresAt: string;
}

export interface PrivateGitHubPublishConfirmation {
  receipt: GitHubEffectReceipt;
  nextOffer: PrivateGitHubPublishOffer | null;
}

interface StoredOffer {
  view: PrivateGitHubPublishOffer;
  principalKey: string;
  effect: GitHubExactEffect;
  title: string;
  body: string;
}

/** Trusted private GitHub UX; neither model nor sandbox receives this port. */
export class PrivateGitHubApplication {
  readonly #offers = new Map<string, StoredOffer>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    private readonly actors: WorkspaceActorResolver,
    private readonly authority: WorkspaceAuthorityService,
    private readonly runs: CodingRunEngine,
    private readonly installations: GitHubInstallationService,
    private readonly broker: GitHubBroker,
    private readonly confirmations: PrivateGitHubConfirmationController,
    private readonly connections: FileGitHubConnectionRepository,
    private readonly sessions: FilePrivateCodingSessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beginInstallation(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<GitHubInstallationStartView> {
    const resolved = await this.resolveActor(actor);
    const { scope } = await this.scopeSession(resolved.principal);
    const grant = this.confirmations.issueInteractive(
      scope,
      resolved.interactionId,
      {
        action: "github.install.begin",
        connectionId: null,
        repositoryId: null,
        selectionId: null,
      },
    );
    return this.installations.beginInstallation(scope, grant);
  }

  async installationStatus(
    actor: AuthenticatedWorkspaceActor,
    connectionId: string,
  ): Promise<GitHubInstallationConnection> {
    const resolved = await this.resolveActor(actor);
    const { scope } = await this.scopeSession(resolved.principal);
    const grant = this.confirmations.issueInteractive(
      scope,
      resolved.interactionId,
      {
        action: "github.install.status",
        connectionId,
        repositoryId: null,
        selectionId: null,
      },
    );
    return this.installations.refreshInstallation(scope, connectionId, grant);
  }

  async listRepositories(
    actor: AuthenticatedWorkspaceActor,
    connectionId: string,
    cursor: string | null = null,
  ): Promise<GitHubRepositoryPage> {
    const resolved = await this.resolveActor(actor);
    const { scope } = await this.scopeSession(resolved.principal);
    const grant = this.confirmations.issueInteractive(
      scope,
      resolved.interactionId,
      {
        action: "github.install.repositories.list",
        connectionId,
        repositoryId: null,
        selectionId: null,
      },
    );
    return this.installations.listRepositories(scope, connectionId, cursor, grant);
  }

  async selectAndProvision(
    actor: AuthenticatedWorkspaceActor,
    input: { connectionId: string; repositoryId: string },
  ) {
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const { scope, session } = await this.scopeSession(resolved.principal);
      const selectionGrant = this.confirmations.issueInteractive(
        scope,
        resolved.interactionId,
        {
          action: "github.repository.select",
          connectionId: input.connectionId,
          repositoryId: input.repositoryId,
          selectionId: null,
        },
      );
      const selection = await this.installations.selectRepository(
        scope,
        input,
        selectionGrant,
      );
      const provisionGrant = this.confirmations.issueInteractive(
        scope,
        resolved.interactionId,
        {
          action: "github.repository.provision",
          connectionId: selection.installationConnectionId,
          repositoryId: selection.repositoryId,
          selectionId: selection.selectionId,
        },
      );
      const provisioned = await this.installations.provisionRepository(
        scope,
        selection.selectionId,
        provisionGrant,
      );
      await this.sessions.save({
        version: 1,
        principalKey: session.principalKey,
        channel: session.channel,
        workspaceKey: scope.workspaceKey,
        projectId: provisioned.project.id,
        projectRevision: provisioned.project.revision,
        foregroundRunId: null,
        lastRunId: null,
        updatedAt: this.now().toISOString(),
      }, session.revision);
      return provisioned;
    });
  }

  async preparePublishOffer(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<PrivateGitHubPublishOffer | null> {
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () =>
      this.prepareOffer(resolved.principal)
    );
  }

  /** Workspace-private adoption path for a completed group-origin CodingRun. */
  async preparePublishOfferForRun(
    actor: AuthenticatedWorkspaceActor,
    runIdInput: string,
  ): Promise<PrivateGitHubPublishOffer | null> {
    const resolved = await this.resolveActor(actor);
    const runId = safeRunId(runIdInput);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const { scope, session } = await this.scopeSession(resolved.principal);
      if (session.foregroundRunId && session.foregroundRunId !== runId) {
        throw new Error("Selesaikan CodingRun privat aktif sebelum mengadopsi hasil grup.");
      }
      const run = await this.runs.get(scope, runId);
      if (
        !run || run.status !== "completed" || !run.result ||
        run.binding.ownerWorkspaceKey !== scope.workspaceKey ||
        run.admission?.source !== "group" || run.admission.audience !== "group-safe"
      ) throw new Error("CodingRun grup completed tidak tersedia di Workspace ini.");
      await this.sessions.save({
        version: 1,
        principalKey: session.principalKey,
        channel: session.channel,
        workspaceKey: scope.workspaceKey,
        projectId: run.binding.projectId,
        projectRevision: run.result.projectRevision,
        foregroundRunId: null,
        lastRunId: run.runId,
        updatedAt: this.now().toISOString(),
      }, session.revision);
      return this.prepareOffer(resolved.principal);
    });
  }

  async confirmPublishOffer(
    actor: AuthenticatedWorkspaceActor,
    offerId: string,
  ): Promise<PrivateGitHubPublishConfirmation> {
    const resolved = await this.resolveActor(actor);
    return this.exclusive(resolved.principal.principalKey, async () => {
      const stored = this.#offers.get(offerId);
      if (
        !stored || stored.principalKey !== resolved.principal.principalKey ||
        Date.parse(stored.view.expiresAt) <= this.now().getTime()
      ) {
        this.#offers.delete(offerId);
        throw new Error("Offer publish GitHub tidak tersedia atau kedaluwarsa.");
      }
      const { scope } = await this.scopeSession(resolved.principal);
      if (
        scope.membershipId !== stored.view.actorMembershipId ||
        scope.aclEpoch !== stored.view.authorityRevision
      ) throw new Error("Authority offer publish GitHub sudah berubah.");
      const grant = this.confirmations.issueEffect(
        scope,
        resolved.interactionId,
        stored.effect,
      );
      const approval = await this.broker.approve(scope, stored.effect, grant);
      let receipt: GitHubEffectReceipt;
      switch (stored.effect.capability) {
        case "github.branch.create":
          receipt = await this.broker.createBranch(scope, stored.effect, approval);
          break;
        case "github.push_branch":
          receipt = await this.broker.pushBranch(scope, stored.effect, approval);
          break;
        case "github.workflow.write":
          receipt = await this.broker.pushWorkflowChanges(scope, stored.effect, approval);
          break;
        case "github.pr.create":
          receipt = await this.broker.createDraftPullRequest(scope, stored.effect, approval);
          break;
      }
      this.#offers.delete(offerId);
      const nextOffer = receipt.status === "committed"
        ? await this.prepareOffer(resolved.principal, stored.title, stored.body)
        : null;
      return { receipt, nextOffer };
    });
  }

  async prepareOffer(
    principal: WorkspacePrincipal,
    titleInput?: string,
    bodyInput?: string,
  ): Promise<PrivateGitHubPublishOffer | null> {
    const { scope, session } = await this.scopeSession(principal);
    if (!session.projectId || !session.lastRunId) {
      throw new Error("Project atau hasil CodingRun untuk publish belum tersedia.");
    }
    const run = await this.runs.get(scope, session.lastRunId);
    if (!run || run.status !== "completed" || !run.result) {
      throw new Error("CodingRun completed untuk publish tidak tersedia.");
    }
    const state = await this.connections.loadByProject(session.projectId);
    if (!state || state.binding.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("Binding GitHub project tidak tersedia.");
    }
    const commit = state.receipts.find((receipt) =>
      receipt.status === "committed" &&
      receipt.effect.runId === run.runId &&
      (receipt.capability === "github.push_branch" ||
        receipt.capability === "github.workflow.write")
    )?.commit;
    const branchCreated = state.receipts.some((receipt) =>
      receipt.status === "committed" &&
      receipt.effect.runId === run.runId &&
      receipt.capability === "github.branch.create"
    );
    const pullRequestCreated = state.receipts.some((receipt) =>
      receipt.status === "committed" &&
      receipt.effect.runId === run.runId &&
      receipt.capability === "github.pr.create"
    );
    if (pullRequestCreated) return null;
    const workflowChanged = run.diff?.files.some((file) =>
      file.path.startsWith(".github/workflows/")
    ) ?? false;
    const capability: GitHubCapability = !branchCreated
      ? "github.branch.create"
      : !commit
        ? workflowChanged ? "github.workflow.write" : "github.push_branch"
        : "github.pr.create";
    const title = safeTitle(titleInput ?? `Harvy: ${run.taskBrief.request}`);
    const body = safeBody(bodyInput ?? [
      "Draft PR dibuat Harvy dari CodingRun yang telah melewati validator dan task review.",
      `Run: ${run.runId}`,
    ].join("\n\n"));
    const effect = await this.broker.prepareEffect(scope, {
      runId: run.runId,
      capability,
      ...(capability === "github.pr.create" ? { title, body } : {}),
    });
    const offerId = randomBytes(16).toString("base64url");
    const view: PrivateGitHubPublishOffer = {
      offerId,
      effectId: effect.effectId,
      capability,
      repositoryFullName: state.binding.repositoryFullName,
      branch: effect.branch,
      commit: effect.commit,
      baseCommit: effect.baseCommit,
      actorMembershipId: scope.membershipId,
      authorityRevision: scope.aclEpoch,
      audience: "workspace-private",
      expiresAt: new Date(this.now().getTime() + OFFER_TTL_MS).toISOString(),
    };
    this.#offers.set(offerId, {
      view,
      principalKey: principal.principalKey,
      effect,
      title,
      body,
    });
    this.pruneOffers();
    return structuredClone(view);
  }

  async scopeSession(principal: WorkspacePrincipal): Promise<{
    scope: WorkspaceAgentScope;
    session: PrivateCodingSession;
  }> {
    const session = await this.sessions.load(principal.principalKey);
    if (!session?.workspaceKey) throw new Error("Pilih workspace lebih dulu.");
    const scope = await this.authority.resolveScope(session.workspaceKey, principal);
    if (!scope) throw new Error("Authority workspace sudah berubah atau dicabut.");
    return { scope, session };
  }

  async resolveActor(actor: AuthenticatedWorkspaceActor) {
    const resolved = await this.actors.resolve(actor);
    if (!resolved || resolved.audience !== "workspace-private") {
      throw new Error("Actor private GitHub tidak sah.");
    }
    return resolved;
  }

  pruneOffers(): void {
    const now = this.now().getTime();
    for (const [id, offer] of this.#offers) {
      if (Date.parse(offer.view.expiresAt) <= now) this.#offers.delete(id);
    }
    while (this.#offers.size > MAX_OFFERS) {
      const first = this.#offers.keys().next().value as string | undefined;
      if (!first) break;
      this.#offers.delete(first);
    }
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
}

function safeTitle(value: string): string {
  const clean = value.trim().slice(0, 256);
  if (!clean || containsSecretLikeValue(clean) || /\p{Cc}/u.test(clean)) {
    throw new Error("Judul PR tidak sah.");
  }
  return clean;
}

function safeBody(value: string): string {
  const clean = value.trim();
  if (
    !clean || clean.length > 16_000 || containsSecretLikeValue(clean) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(clean)
  ) {
    throw new Error("Body PR tidak sah.");
  }
  return clean;
}

function safeRunId(value: string): string {
  const clean = value.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(clean) ||
    containsSecretLikeValue(clean)
  ) throw new Error("runId publish privat tidak sah.");
  return clean;
}
