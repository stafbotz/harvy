import { createHash, randomUUID } from "node:crypto";
import type { CodingRun, CodingRunRepository } from "../domain/coding-run.js";
import type {
  ProjectWorkspace,
  ProjectWorkspaceLocalGitCommitReceipt,
} from "../domain/project-workspace.js";
import {
  validateLocalGitObjectBundleReference,
  type LocalGitObjectBundleReference,
  type LocalGitObjectBundleSource,
} from "../domain/local-git.js";
import type {
  GitHubBrokerHealth,
  GitHubBrokerTransport,
  GitHubBrokerTransportResult,
  GitHubCapability,
  GitHubConfirmationAuthority,
  GitHubConfirmationBinding,
  GitHubConfirmationGrant,
  GitHubConnectionRepository,
  GitHubConnectionState,
  GitHubEffectApproval,
  GitHubEffectReceipt,
  GitHubExactEffect,
  GitHubRepositoryAccess,
  GitHubRepositoryBinding,
  GitHubInstallationRepository,
  GitHubUnknownEffectReference,
  GitHubUnknownEffectReconciler,
} from "../domain/github.js";
import type { WorkspacePermission } from "../domain/workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import { callTransportWithDeadline } from "./transport-deadline.js";

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GITHUB_TRANSPORT_TIMEOUT_MS = 30_000;

function boundedTransportTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new Error("Timeout GitHub Broker transport tidak sah.");
  }
  return value;
}

/**
 * Credentialless policy facade. Only GitHubBrokerTransport owns App private
 * keys and short-lived installation tokens; neither effect nor repository
 * metadata has a credential field.
 */
export class GitHubBroker implements GitHubUnknownEffectReconciler {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly transportTimeoutMs: number;

  constructor(
    private readonly repository:
      GitHubConnectionRepository & GitHubInstallationRepository,
    private readonly transport: GitHubBrokerTransport,
    private readonly confirmationAuthority: GitHubConfirmationAuthority,
    private readonly authority: WorkspaceAuthorityService,
    private readonly projects: ProjectWorkspaceService,
    private readonly codingRuns: CodingRunRepository,
    private readonly objectBundles: LocalGitObjectBundleSource,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
    options: { transportTimeoutMs?: number } = {},
  ) {
    this.transportTimeoutMs = boundedTransportTimeout(
      options.transportTimeoutMs ?? DEFAULT_GITHUB_TRANSPORT_TIMEOUT_MS,
    );
  }

  async health(): Promise<GitHubBrokerHealth> {
    const result = await this.transportCall(
      "GitHub Broker health",
      (signal) => this.transport.health(signal),
    );
    assertExactKeys(result, ["available", "protocol", "checkedAt", "reason"]);
    if (typeof result.available !== "boolean" ||
      (result.available &&
        (result.protocol !== "harvy-github-broker/1" || result.reason !== null)) ||
      (!result.available &&
        (result.protocol !== null || typeof result.reason !== "string"))) {
      throw new Error("Health GitHub Broker tidak sah.");
    }
    validIso(result.checkedAt, "GitHub Broker health checkedAt");
    if (result.reason !== null) {
      rejectCredentialMaterial(result.reason, "GitHub Broker health reason");
    }
    return Object.freeze(structuredClone(result));
  }

  async connectRepository(
    scope: WorkspaceAgentScope,
    input: {
      projectId: string;
      installationId: string;
      repositoryId: string;
    },
  ): Promise<GitHubRepositoryBinding> {
    return this.authority.withPermissions(
      scope,
      ["workspace.manage", "github.read"],
      async () => {
        safeText(input.projectId, "projectId", 512);
        safeText(input.installationId, "installationId", 128);
        safeText(input.repositoryId, "repositoryId", 128);
        throw new Error(
          "Raw GitHub repository binding dinonaktifkan; gunakan durable installation selection.",
        );
      },
    );
  }

  async prepareEffect(
    scope: WorkspaceAgentScope,
    input: {
      runId: string;
      capability: GitHubCapability;
      title?: string;
      body?: string;
    },
  ): Promise<GitHubExactEffect> {
    const run = await this.codingRuns.load(safeText(input.runId, "runId", 512));
    if (
      !run ||
      run.status !== "completed" ||
      !run.result ||
      run.binding.ownerWorkspaceKey !== scope.workspaceKey
    ) {
      throw new Error("CodingRun completed tidak ditemukan pada workspace ini.");
    }
    await this.requireEffectPermissions(scope, input.capability);
    const project = await this.projects.get(scope, run.binding.projectId);
    const localCommit = project ? exactLocalCommit(project, run) : null;
    if (
      !project ||
      project.source.type !== "github" ||
      !project.git ||
      project.baseSnapshot !== run.result.snapshotId ||
      project.pendingGitCommit !== undefined ||
      !localCommit
    ) {
      throw new Error("Project git tidak fresh terhadap hasil CodingRun.");
    }
    const state = await this.requireConnection(project.id, scope.workspaceKey);
    if (
      project.source.installationConnectionId !==
        state.binding.installationConnectionId ||
      project.source.repositorySelectionId !==
        state.binding.repositorySelectionId ||
      project.source.provisioningStatus !== "bound" ||
      project.source.repositoryBindingId !== state.binding.bindingId
    ) {
      throw new Error("Project GitHub tidak cocok durable installation selection.");
    }
    const branch = validPublishBranch(project.git.branch, state.binding.defaultBranch);
    assertWorkflowCapability(run, input.capability);
    const isPr = input.capability === "github.pr.create";
    const title = isPr
      ? boundedOptional(input.title, 256, "pull request title", true)
      : null;
    const body = isPr
      ? boundedOptional(input.body, 16_000, "pull request body", false)
      : null;
    if (title !== null) rejectCredentialMaterial(title, "pull request title");
    if (body !== null) rejectCredentialMaterial(body, "pull request body");
    const semantic = {
      capability: input.capability,
      projectId: project.id,
      runId: run.runId,
      ownerWorkspaceKey: scope.workspaceKey,
      installationConnectionId: state.binding.installationConnectionId!,
      repositoryBindingId: state.binding.bindingId,
      installationId: state.binding.installationId,
      repositoryId: state.binding.repositoryId,
      workspaceRevision: project.revision,
      instructionRevision: run.result.instructionRevision,
      branch,
      commit: validCommit(project.git.headCommit, "headCommit"),
      baseCommit: validCommit(project.git.baseCommit, "baseCommit"),
      expectedTargetHead: input.capability === "github.branch.create"
        ? null
        : input.capability === "github.push_branch" ||
            input.capability === "github.workflow.write"
          ? validCommit(localCommit.parentCommit, "local commit parent")
          : validCommit(project.git.headCommit, "headCommit"),
      baseBranch: state.binding.defaultBranch,
      title,
      body,
      draft: isPr ? true as const : null,
      objectBundle:
        input.capability === "github.push_branch" ||
        input.capability === "github.workflow.write"
          ? structuredClone(localCommit.objectBundle)
          : null,
    };
    const semanticDigest = retrySemanticDigest(semantic);
    const matching = state.receipts.filter(
      (receipt) => retrySemanticDigest(receipt.effect) === semanticDigest,
    );
    const unresolved = [...matching].reverse().find(
      (receipt) => receipt.status !== "not_committed",
    );
    if (unresolved) return structuredClone(unresolved.effect);
    const attempt = matching.reduce(
      (highest, receipt) => Math.max(highest, receipt.effect.attempt),
      0,
    ) + 1;
    const exact = { ...semantic, attempt };
    return { effectId: deterministicEffectId(exact), ...exact };
  }

  /** Called only after a visible, contextual user confirmation. */
  async approve(
    scope: WorkspaceAgentScope,
    effectInput: GitHubExactEffect,
    confirmationInput: GitHubConfirmationGrant,
  ): Promise<GitHubEffectApproval> {
    const effect = validateEffect(effectInput);
    const confirmation = validateConfirmationGrant(confirmationInput);
    return this.projects.withFreshProjectPermissions(
      scope,
      effect.projectId,
      effect.workspaceRevision,
      permissionsForEffect(effect.capability),
      () => this.exclusive(effect.projectId, async () => {
      const current = await this.validateCurrentEffect(scope, effect);
      const state = current.state;
      assertAuthorizedEffectAttempt(state, effect);
      assertPreEffectRemoteState(effect, current.access);
      const digest = effectDigest(effect);
      const confirmationBinding: GitHubConfirmationBinding = {
        effectId: effect.effectId,
        effectDigest: digest,
        capability: effect.capability,
        interactionId: confirmation.interactionId,
        audience: "workspace-private",
        ownerWorkspaceKey: scope.workspaceKey,
        membershipId: scope.membershipId,
        aclEpoch: scope.aclEpoch,
      };
      const verified = await this.transportCall(
        "GitHub user confirmation verification",
        (signal) => this.confirmationAuthority.verify(
          confirmation,
          confirmationBinding,
          signal,
        ),
      );
      if (!verified) {
        throw new Error("Confirmation pengguna GitHub tidak sah atau sudah kedaluwarsa.");
      }
      const reused = state.approvals.find(
        (approval) => approval.confirmationId === confirmation.confirmationId,
      );
      if (reused) {
        if (
          reused.effectDigest !== digest ||
          reused.capability !== effect.capability ||
          reused.approvedByMembershipId !== scope.membershipId ||
          reused.approvedAclEpoch !== scope.aclEpoch
        ) {
          throw new Error("Confirmation GitHub sudah dipakai untuk binding berbeda.");
        }
        return structuredClone(reused);
      }
      const at = this.now();
      const confirmationExpiry = Date.parse(confirmation.expiresAt);
      if (confirmationExpiry <= at.getTime()) {
        throw new Error("Confirmation pengguna GitHub sudah kedaluwarsa.");
      }
      const approval: GitHubEffectApproval = {
        approvalId: opaqueId("github-approval", this.makeId()),
        confirmationId: confirmation.confirmationId,
        effectDigest: digest,
        capability: effect.capability,
        approvedByMembershipId: scope.membershipId,
        approvedAclEpoch: scope.aclEpoch,
        approvedAt: at.toISOString(),
        expiresAt: new Date(
          Math.min(at.getTime() + APPROVAL_TTL_MS, confirmationExpiry),
        ).toISOString(),
        consumedAt: null,
      };
      const saved = await this.saveConnection(state, {
        approvals: [...state.approvals, approval],
      });
      return saved.approvals.at(-1)!;
      }),
    );
  }

  async createBranch(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
    approval: GitHubEffectApproval,
  ): Promise<GitHubEffectReceipt> {
    return this.execute(scope, effect, approval, "github.branch.create");
  }

  async pushBranch(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
    approval: GitHubEffectApproval,
  ): Promise<GitHubEffectReceipt> {
    return this.execute(scope, effect, approval, "github.push_branch");
  }

  async pushWorkflowChanges(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
    approval: GitHubEffectApproval,
  ): Promise<GitHubEffectReceipt> {
    return this.execute(scope, effect, approval, "github.workflow.write");
  }

  async createDraftPullRequest(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
    approval: GitHubEffectApproval,
  ): Promise<GitHubEffectReceipt> {
    return this.execute(scope, effect, approval, "github.pr.create");
  }

  private async execute(
    scope: WorkspaceAgentScope,
    effectInput: GitHubExactEffect,
    approvalInput: GitHubEffectApproval,
    expectedCapability: GitHubCapability,
  ): Promise<GitHubEffectReceipt> {
    const effect = validateEffect(effectInput);
    if (effect.capability !== expectedCapability) {
      throw new Error("Capability GitHub effect tidak cocok dengan operasi broker.");
    }
    return this.projects.withFreshProjectPermissions(
      scope,
      effect.projectId,
      effect.workspaceRevision,
      permissionsForEffect(effect.capability),
      () => this.exclusive(effect.projectId, async () => {
      const currentEffect = await this.validateCurrentEffect(scope, effect);
      let state = currentEffect.state;
      assertAuthorizedEffectAttempt(state, effect);
      const digest = effectDigest(effect);
      const existingReceipt = state.receipts.find(
        (receipt) => receipt.effectId === effect.effectId,
      );
      if (existingReceipt) {
        if (
          existingReceipt.effectDigest !== digest ||
          JSON.stringify(existingReceipt.effect) !== JSON.stringify(effect)
        ) {
          throw new Error("GitHub effectId dipakai ulang untuk state berbeda.");
        }
        return structuredClone(existingReceipt);
      }
      assertPreEffectRemoteState(effect, currentEffect.access);
      const approval = state.approvals.find(
        (candidate) => candidate.approvalId === approvalInput.approvalId,
      );
      if (
        !approval ||
        approval.effectDigest !== digest ||
        approval.capability !== effect.capability ||
        approval.approvedByMembershipId !== scope.membershipId ||
        approval.approvedAclEpoch !== scope.aclEpoch ||
        approval.consumedAt !== null ||
        Date.parse(approval.expiresAt) <= this.now().getTime() ||
        JSON.stringify(approval) !== JSON.stringify(approvalInput)
      ) {
        throw new Error("Approval GitHub tidak fresh atau tidak mengikat exact effect.");
      }
      if (effect.capability === "github.pr.create") {
        const pushed = state.receipts.some(
          (receipt) =>
            (receipt.capability === "github.push_branch" ||
              receipt.capability === "github.workflow.write") &&
            receipt.status === "committed" &&
            receipt.branch === effect.branch &&
            receipt.commit === effect.commit &&
            receipt.baseCommit === effect.baseCommit &&
            receipt.workspaceRevision === effect.workspaceRevision,
        );
        if (!pushed) {
          throw new Error("Draft PR memerlukan receipt push exact commit yang committed.");
        }
      }
      if (
        effect.capability === "github.push_branch" ||
        effect.capability === "github.workflow.write"
      ) {
        const branchCreated = state.receipts.some(
          (receipt) =>
            receipt.capability === "github.branch.create" &&
            receipt.status === "committed" &&
            receipt.branch === effect.branch &&
            receipt.baseCommit === effect.baseCommit &&
            receipt.effect.projectId === effect.projectId &&
            receipt.effect.installationId === effect.installationId &&
            receipt.effect.repositoryId === effect.repositoryId,
        );
        if (!branchCreated) {
          throw new Error("Push v1 memerlukan receipt pembuatan branch exact repository/base.");
        }
      }
      const consumedAt = this.now().toISOString();
      const pendingReceipt: GitHubEffectReceipt = {
        receiptId: opaqueId("github-receipt", this.makeId()),
        effectId: effect.effectId,
        effectDigest: digest,
        capability: effect.capability,
        branch: effect.branch,
        commit: effect.commit,
        baseCommit: effect.baseCommit,
        workspaceRevision: effect.workspaceRevision,
        status: "unknown",
        effect: structuredClone(effect),
        externalId: null,
        url: null,
        committedAt: consumedAt,
      };
      state = await this.saveConnection(state, {
        approvals: state.approvals.map((candidate) =>
          candidate.approvalId === approval.approvalId
            ? { ...candidate, consumedAt }
            : candidate
        ),
        receipts: [...state.receipts, pendingReceipt],
      });
      let transportResult: GitHubBrokerTransportResult;
      try {
        transportResult = await this.callTransport(effect);
        validateTransportResult(transportResult, effect);
      } catch {
        transportResult = {
          effectId: effect.effectId,
          status: "unknown",
          operationFenced: false,
          externalId: null,
          url: null,
          completedAt: this.now().toISOString(),
        };
      }
      if (transportResult.status === "unknown") return pendingReceipt;
      const receipt: GitHubEffectReceipt = {
        ...pendingReceipt,
        status: transportResult.status,
        externalId: transportResult.externalId,
        url: transportResult.url,
        committedAt: transportResult.completedAt,
      };
      const saved = await this.saveConnection(state, {
        receipts: state.receipts.map((candidate) =>
          candidate.effectId === effect.effectId ? receipt : candidate
        ),
      });
      return saved.receipts.find(
        (candidate) => candidate.effectId === effect.effectId,
      )!;
      }),
    );
  }

  async reconcileUnknown(
    scope: WorkspaceAgentScope,
    effectReference: GitHubExactEffect | { projectId: string; effectId: string },
  ): Promise<GitHubEffectReceipt> {
    const suppliedEffect = "capability" in effectReference
      ? validateEffect(effectReference)
      : null;
    if (!suppliedEffect) {
      assertExactKeys(effectReference, ["projectId", "effectId"]);
    }
    const projectId = suppliedEffect?.projectId ??
      safeText(effectReference.projectId, "projectId", 512);
    const effectId = suppliedEffect?.effectId ??
      safeText(effectReference.effectId, "effectId", 512);
    return this.authority.withPermission(scope, "github.read", () =>
      this.exclusive(projectId, async () => {
      const state = await this.requireProvisionedConnection(
        projectId,
        scope.workspaceKey,
        true,
      );
      const receipt = state.receipts.find(
        (candidate) => candidate.effectId === effectId,
      );
      if (!receipt) {
        throw new Error("Receipt GitHub unknown tidak ditemukan untuk exact effect.");
      }
      const effect = validateEffect(receipt.effect);
      const digest = effectDigest(effect);
      if (
        receipt.effectDigest !== digest ||
        receipt.effectId !== effect.effectId ||
        (suppliedEffect && JSON.stringify(suppliedEffect) !== JSON.stringify(effect))
      ) {
        throw new Error("Receipt GitHub unknown tidak mengikat canonical exact effect.");
      }
      await this.requireEffectPermissions(scope, effect.capability);
      if (
        effect.ownerWorkspaceKey !== scope.workspaceKey ||
        state.binding.projectId !== effect.projectId ||
        state.binding.installationConnectionId !==
          effect.installationConnectionId ||
        state.binding.bindingId !== effect.repositoryBindingId ||
        state.binding.installationId !== effect.installationId ||
        state.binding.repositoryId !== effect.repositoryId ||
        state.binding.defaultBranch !== effect.baseBranch
      ) {
        throw new Error("Binding immutable GitHub effect tidak lagi berwenang.");
      }
      if (receipt.status !== "unknown") return structuredClone(receipt);
      let result: GitHubBrokerTransportResult;
      try {
        result = await this.transportCall(
          "GitHub effect reconciliation",
          (signal) => this.transport.reconcileEffect(effect, signal),
        );
      } catch {
        return structuredClone(receipt);
      }
      validateTransportResult(result, effect);
      if (result.status === "unknown") return structuredClone(receipt);
      const terminalReceipt: GitHubEffectReceipt = {
        ...receipt,
        status: result.status,
        externalId: result.externalId,
        url: result.url,
        committedAt: result.completedAt,
      };
      const saved = await this.saveConnection(state, {
        receipts: state.receipts.map((candidate) =>
          candidate.effectId === effect.effectId ? terminalReceipt : candidate
        ),
      });
      return saved.receipts.find(
        (candidate) => candidate.effectId === effect.effectId,
      )!;
      })
    );
  }

  /**
   * Startup/background reconciliation for an already-sent effect. It accepts
   * no user scope, performs no ACL-derived mutation authority, and can call
   * only the broker's observation endpoint. New effects still require the
   * interactive path above.
   */
  async reconcileDurableUnknown(
    referenceInput: GitHubUnknownEffectReference,
  ): Promise<"committed" | "unknown" | "not_committed" | "missing"> {
    const reference = validateUnknownEffectReference(referenceInput);
    return this.exclusive(reference.projectId, async () => {
      const state = await this.repository.loadByProject(reference.projectId);
      if (!state) return "missing";
      const receipt = state.receipts.find(
        (candidate) => candidate.effectId === reference.effectId,
      );
      if (!receipt) return "missing";
      const effect = validateEffect(receipt.effect);
      const digest = effectDigest(effect);
      if (
        state.binding.ownerWorkspaceKey !== reference.ownerWorkspaceKey ||
        state.binding.projectId !== reference.projectId ||
        receipt.effectDigest !== reference.effectDigest ||
        receipt.effectDigest !== digest ||
        receipt.effectId !== effect.effectId ||
        effect.ownerWorkspaceKey !== state.binding.ownerWorkspaceKey ||
        effect.projectId !== state.binding.projectId ||
        effect.installationConnectionId !==
          state.binding.installationConnectionId ||
        effect.repositoryBindingId !== state.binding.bindingId ||
        effect.installationId !== state.binding.installationId ||
        effect.repositoryId !== state.binding.repositoryId ||
        effect.baseBranch !== state.binding.defaultBranch
      ) {
        throw new Error("Locator rekonsiliasi GitHub tidak cocok exact receipt/binding.");
      }
      await this.requireHistoricalReconciliationAuthority(state);
      if (receipt.status !== "unknown") return receipt.status;
      let result: GitHubBrokerTransportResult;
      try {
        result = await this.transportCall(
          "GitHub durable effect reconciliation",
          (signal) => this.transport.reconcileEffect(effect, signal),
        );
      } catch {
        return "unknown";
      }
      // A malformed terminal attestation is a protocol/security failure, not
      // an ordinary still-unknown observation. Keep the durable receipt
      // untouched and let the worker count/report the failure.
      validateTransportResult(result, effect);
      if (result.status === "unknown") return "unknown";
      const terminalReceipt: GitHubEffectReceipt = {
        ...receipt,
        status: result.status,
        externalId: result.externalId,
        url: result.url,
        committedAt: result.completedAt,
      };
      let saved: GitHubConnectionState;
      try {
        saved = await this.saveConnection(state, {
          receipts: state.receipts.map((candidate) =>
            candidate.effectId === effect.effectId ? terminalReceipt : candidate
          ),
        });
      } catch (error) {
        if (!isGitHubConnectionConflict(error)) throw error;
        const current = await this.repository.loadByProject(reference.projectId);
        const durable = current?.receipts.find(
          (candidate) => candidate.effectId === reference.effectId,
        );
        if (
          !current ||
          !durable ||
          durable.effectDigest !== reference.effectDigest ||
          durable.status !== result.status ||
          durable.externalId !== result.externalId ||
          durable.url !== result.url ||
          durable.committedAt !== result.completedAt
        ) {
          throw new Error("CAS rekonsiliasi GitHub konflik; effect tetap unknown.");
        }
        saved = current;
      }
      const durable = saved.receipts.find(
        (candidate) => candidate.effectId === reference.effectId,
      );
      if (!durable) return "missing";
      return durable.status;
    });
  }

  async reconcileProjectUnknown(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
  ): Promise<GitHubEffectReceipt[]> {
    const projectId = safeText(projectIdInput, "projectId", 512);
    const state = await this.requireProvisionedConnection(
      projectId,
      scope.workspaceKey,
      true,
    );
    const pending = state.receipts.filter((receipt) => receipt.status === "unknown");
    const reconciled: GitHubEffectReceipt[] = [];
    for (const receipt of pending) {
      reconciled.push(await this.reconcileUnknown(scope, {
        projectId,
        effectId: receipt.effectId,
      }));
    }
    return reconciled;
  }

  private async validateCurrentEffect(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
  ): Promise<{ state: GitHubConnectionState; access: GitHubRepositoryAccess }> {
    await this.requireEffectPermissions(scope, effect.capability);
    if (effect.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("GitHub effect berada di workspace lain.");
    }
    const project = await this.projects.get(scope, effect.projectId);
    if (
      !project ||
      project.revision !== effect.workspaceRevision ||
      project.source.type !== "github" ||
      !project.git ||
      project.source.installationConnectionId !==
        effect.installationConnectionId ||
      project.source.installationId !== effect.installationId ||
      project.source.repositoryId !== effect.repositoryId ||
      project.git.branch !== effect.branch ||
      project.git.headCommit !== effect.commit ||
      project.git.baseCommit !== effect.baseCommit ||
      project.pendingGitCommit !== undefined
    ) {
      throw new Error("GitHub effect basi terhadap ProjectWorkspace.");
    }
    const run = await this.codingRuns.load(effect.runId);
    if (
      !run ||
      run.status !== "completed" ||
      !run.result ||
      run.binding.projectId !== effect.projectId ||
      run.binding.ownerWorkspaceKey !== scope.workspaceKey ||
      run.result.snapshotId !== project.baseSnapshot ||
      run.result.instructionRevision !== effect.instructionRevision
    ) {
      throw new Error("GitHub effect basi terhadap CodingRun.");
    }
    const localCommit = exactLocalCommit(project, run);
    if (!localCommit) {
      throw new Error("GitHub effect tidak mempunyai exact local commit receipt.");
    }
    if (
      (effect.capability === "github.push_branch" ||
        effect.capability === "github.workflow.write") &&
      JSON.stringify(effect.objectBundle) !== JSON.stringify(localCommit.objectBundle)
    ) {
      throw new Error("Object bundle GitHub tidak fresh terhadap local commit receipt.");
    }
    if (
      !run.diff
    ) throw new Error("GitHub effect memerlukan diff CodingRun yang durable.");
    assertWorkflowCapability(run, effect.capability);
    const state = await this.requireConnection(effect.projectId, scope.workspaceKey);
    if (
      project.source.repositorySelectionId !==
        state.binding.repositorySelectionId ||
      project.source.provisioningStatus !== "bound" ||
      project.source.repositoryBindingId !== state.binding.bindingId ||
      state.binding.installationId !== effect.installationId ||
      state.binding.installationConnectionId !== effect.installationConnectionId ||
      state.binding.bindingId !== effect.repositoryBindingId ||
      state.binding.repositoryId !== effect.repositoryId ||
      state.binding.defaultBranch !== effect.baseBranch ||
      state.binding.revokedAt !== null
    ) {
      throw new Error("GitHub repository binding dicabut atau berubah.");
    }
    validPublishBranch(effect.branch, state.binding.defaultBranch);
    const access = await this.readRepositoryAccess(
      scope.workspaceKey,
      effect.installationId,
      effect.repositoryId,
      effect.branch,
    );
    if (
      !access.canRead ||
      access.repositoryFullName !== state.binding.repositoryFullName ||
      access.defaultBranch !== state.binding.defaultBranch ||
      access.baseCommit !== effect.baseCommit ||
      ((effect.capability === "github.branch.create" ||
        effect.capability === "github.push_branch" ||
        effect.capability === "github.workflow.write") && !access.canPush) ||
      (effect.capability === "github.workflow.write" && !access.canWriteWorkflows) ||
      (effect.capability === "github.pr.create" && !access.canCreatePullRequest)
    ) {
      throw new Error("Authority GitHub App atau remote base tidak lagi fresh.");
    }
    assertObservedRemoteState(effect, access);
    return { state, access };
  }

  private async requireConnection(
    projectId: string,
    ownerWorkspaceKey: string,
  ): Promise<GitHubConnectionState> {
    const state = await this.requireProvisionedConnection(
      projectId,
      ownerWorkspaceKey,
      false,
    );
    return state;
  }

  private async requireProvisionedConnection(
    projectId: string,
    ownerWorkspaceKey: string,
    allowRevokedInstallation: boolean,
  ): Promise<GitHubConnectionState> {
    const state = await this.repository.loadByProject(projectId);
    if (
      !state ||
      state.binding.ownerWorkspaceKey !== ownerWorkspaceKey ||
      state.binding.revokedAt !== null
    ) throw new Error("GitHub repository binding tidak ditemukan.");
    const connectionId = state.binding.installationConnectionId;
    const selectionId = state.binding.repositorySelectionId;
    if (connectionId === null || selectionId === null) {
      throw new Error("GitHub repository binding legacy wajib dihubungkan ulang.");
    }
    const [installation, selection] = await Promise.all([
      this.repository.loadInstallation(connectionId),
      this.repository.loadSelection(selectionId),
    ]);
    if (
      !installation ||
      (!allowRevokedInstallation && installation.status !== "active") ||
      (allowRevokedInstallation &&
        installation.status !== "active" &&
        installation.status !== "revoked") ||
      installation.ownerWorkspaceKey !== ownerWorkspaceKey ||
      installation.installationId !== state.binding.installationId ||
      !selection ||
      selection.status !== "bound" ||
      selection.bindingId !== state.binding.bindingId ||
      selection.projectId !== state.binding.projectId ||
      selection.ownerWorkspaceKey !== ownerWorkspaceKey ||
      selection.installationConnectionId !== connectionId ||
      selection.installationId !== state.binding.installationId ||
      selection.repositoryId !== state.binding.repositoryId
    ) {
      throw new Error("GitHub installation/selection authority dicabut atau berubah.");
    }
    return state;
  }

  private async requireHistoricalReconciliationAuthority(
    state: GitHubConnectionState,
  ): Promise<void> {
    const connectionId = state.binding.installationConnectionId;
    const selectionId = state.binding.repositorySelectionId;
    if (connectionId === null || selectionId === null) {
      throw new Error("Binding legacy tidak dapat direkonsiliasi otomatis.");
    }
    const [installation, selection] = await Promise.all([
      this.repository.loadInstallation(connectionId),
      this.repository.loadSelection(selectionId),
    ]);
    const selectionStatusAllowed = state.binding.revokedAt === null
      ? selection?.status === "bound"
      : selection?.status === "bound" || selection?.status === "cancelled";
    if (
      !installation ||
      (installation.status !== "active" && installation.status !== "revoked") ||
      installation.ownerWorkspaceKey !== state.binding.ownerWorkspaceKey ||
      installation.installationId !== state.binding.installationId ||
      !selection ||
      !selectionStatusAllowed ||
      selection.bindingId !== state.binding.bindingId ||
      selection.projectId !== state.binding.projectId ||
      selection.ownerWorkspaceKey !== state.binding.ownerWorkspaceKey ||
      selection.installationConnectionId !== connectionId ||
      selection.installationId !== state.binding.installationId ||
      selection.repositoryId !== state.binding.repositoryId
    ) {
      throw new Error("Historical GitHub reconciliation authority tidak cocok.");
    }
  }

  private async saveConnection(
    current: GitHubConnectionState,
    changes: Partial<Pick<GitHubConnectionState, "approvals" | "receipts">>,
  ): Promise<GitHubConnectionState> {
    const at = this.now().toISOString();
    const { revision: _revision, ...binding } = current.binding;
    const saved = await this.repository.save(
      {
        version: 1,
        binding: { ...binding, updatedAt: at },
        approvals: changes.approvals ?? current.approvals,
        receipts: changes.receipts ?? current.receipts,
      },
      current.binding.revision,
    );
    if (saved.status === "conflict") {
      throw new Error("GitHub connection berubah bersamaan; efek tidak diulang.");
    }
    return saved.state;
  }

  private async callTransport(
    effect: GitHubExactEffect,
  ): Promise<GitHubBrokerTransportResult> {
    switch (effect.capability) {
      case "github.branch.create":
        return this.transportCall(
          "GitHub create branch",
          (signal) => this.transport.createBranch(effect, signal),
        );
      case "github.push_branch":
      case "github.workflow.write": {
        const descriptor = validateLocalGitObjectBundleReference(
          effect.objectBundle!,
        );
        return this.transportCall(
          "GitHub push exact commit",
          async (signal) => {
            const transfer = verifiedObjectBundleTransfer(
              this.objectBundles,
              descriptor,
              signal,
            );
            const result = await this.transport.pushExactCommit(
              effect,
              transfer.content,
              signal,
            );
            if (!transfer.completed()) {
              throw new Error("GitHub broker tidak mengonsumsi seluruh object bundle.");
            }
            return result;
          },
        );
      }
      case "github.pr.create":
        return this.transportCall(
          "GitHub create draft pull request",
          (signal) => this.transport.createDraftPullRequest(effect, signal),
        );
    }
  }

  private async readRepositoryAccess(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    targetBranch: string | null,
  ): Promise<GitHubRepositoryAccess> {
    const access = await this.transportCall(
      "GitHub repository access",
      (signal) => this.transport.repositoryAccess(
        ownerWorkspaceKey,
        installationId,
        repositoryId,
        targetBranch,
        signal,
      ),
    );
    validateAccess(
      access,
      ownerWorkspaceKey,
      installationId,
      repositoryId,
      targetBranch,
    );
    return access;
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

  private async requirePermission(
    scope: WorkspaceAgentScope,
    permission: WorkspacePermission,
  ): Promise<void> {
    if (!await this.authority.authorize(scope, permission)) {
      throw new Error(`Izin workspace ${permission} tidak tersedia atau basi.`);
    }
  }

  private async requireEffectPermissions(
    scope: WorkspaceAgentScope,
    capability: GitHubCapability,
  ): Promise<void> {
    await this.requirePermission(scope, permissionFor(capability));
    if (capability === "github.workflow.write") {
      await this.requirePermission(scope, "github.push");
    }
  }

  private async exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(projectId, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(projectId) === tail) this.queues.delete(projectId);
    }
  }
}

function exactLocalCommit(
  project: ProjectWorkspace,
  run: CodingRun,
): ProjectWorkspaceLocalGitCommitReceipt | null {
  if (!run.result || !project.git) return null;
  return (project.localGitCommitReceipts ?? []).find(
    (receipt) =>
      receipt.snapshotId === run.result!.snapshotId &&
      receipt.sourceRevision === run.result!.projectRevision &&
      receipt.baseCommit === project.git!.baseCommit &&
      receipt.branch === project.git!.branch &&
      receipt.commit === project.git!.headCommit &&
      receipt.commit !== receipt.parentCommit &&
      receipt.authorName === "Harvy Bot" &&
      receipt.authorEmail === "bot@harvy.local",
  ) ?? null;
}

export function effectDigest(effectInput: GitHubExactEffect): string {
  const effect = validateEffect(effectInput);
  return createHash("sha256").update(canonicalJson(effect), "utf8").digest("hex");
}

function validateConfirmationGrant(
  input: GitHubConfirmationGrant,
): GitHubConfirmationGrant {
  assertExactKeys(input, [
    "confirmationId", "interactionId", "audience", "proof", "expiresAt",
  ]);
  const grant = structuredClone(input);
  safeText(grant.confirmationId, "confirmationId", 512);
  safeText(grant.interactionId, "confirmation interactionId", 512);
  if (grant.audience !== "workspace-private") {
    throw new Error("Confirmation GitHub wajib berasal dari audience workspace-private.");
  }
  safeText(grant.proof, "confirmation proof", 4_096);
  validIso(grant.expiresAt, "confirmation expiresAt");
  return grant;
}

function validateEffect(input: GitHubExactEffect): GitHubExactEffect {
  assertExactKeys(input, [
    "effectId", "attempt", "capability", "projectId", "runId", "ownerWorkspaceKey",
    "installationConnectionId", "repositoryBindingId", "installationId",
    "repositoryId", "workspaceRevision",
    "instructionRevision", "branch", "commit", "baseCommit",
    "expectedTargetHead", "baseBranch", "title", "body", "draft",
    "objectBundle",
  ]);
  const effect = structuredClone(input);
  safeText(effect.effectId, "effectId", 512);
  positive(effect.attempt, "effect attempt");
  permissionFor(effect.capability);
  safeText(effect.projectId, "projectId", 512);
  safeText(effect.runId, "runId", 512);
  safeText(effect.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
  safeText(effect.installationConnectionId, "installationConnectionId", 512);
  safeText(effect.repositoryBindingId, "repositoryBindingId", 512);
  safeText(effect.installationId, "installationId", 128);
  safeText(effect.repositoryId, "repositoryId", 128);
  rejectCredentialMaterial(effect.installationId, "installationId");
  rejectCredentialMaterial(effect.repositoryId, "repositoryId");
  positive(effect.workspaceRevision, "workspaceRevision");
  positive(effect.instructionRevision, "instructionRevision", true);
  validPublishBranch(effect.branch, effect.baseBranch);
  validCommit(effect.commit, "commit");
  validCommit(effect.baseCommit, "baseCommit");
  if (effect.expectedTargetHead !== null) {
    validCommit(effect.expectedTargetHead, "expectedTargetHead");
  }
  validBranch(effect.baseBranch);
  if (effect.capability === "github.pr.create") {
    if (effect.draft !== true || !effect.title) {
      throw new Error("Pull request GitHub v1 wajib draft dan mempunyai judul.");
    }
    boundedOptional(effect.title, 256, "pull request title", true);
    boundedOptional(effect.body, 16_000, "pull request body", false);
    rejectCredentialMaterial(effect.title, "pull request title");
    if (effect.body !== null) {
      rejectCredentialMaterial(effect.body, "pull request body");
    }
  } else if (effect.title !== null || effect.body !== null || effect.draft !== null) {
    throw new Error("Metadata pull request tidak sah untuk capability ini.");
  }
  const pushesObjects =
    effect.capability === "github.push_branch" ||
    effect.capability === "github.workflow.write";
  if (pushesObjects) {
    if (effect.objectBundle === null) {
      throw new Error("Exact push GitHub memerlukan object bundle content-addressed.");
    }
    const bundle = validateLocalGitObjectBundleReference(effect.objectBundle);
    if (
      bundle.commit !== effect.commit ||
      bundle.parentCommit !== effect.expectedTargetHead
    ) throw new Error("Object bundle GitHub tidak mengikat exact commit/target parent.");
  } else if (effect.objectBundle !== null) {
    throw new Error("Object bundle hanya sah untuk exact push GitHub.");
  }
  const expectedHead = effect.capability === "github.branch.create"
    ? null
    : effect.capability === "github.push_branch" ||
        effect.capability === "github.workflow.write"
      ? effect.objectBundle!.parentCommit
      : effect.commit;
  if (effect.expectedTargetHead !== expectedHead) {
    throw new Error("Expected target head GitHub effect tidak cocok dengan capability.");
  }
  const { effectId: _effectId, ...semantic } = effect;
  if (effect.effectId !== deterministicEffectId(semantic)) {
    throw new Error("GitHub effectId tidak deterministik terhadap exact effect.");
  }
  return effect;
}

function verifiedObjectBundleTransfer(
  source: LocalGitObjectBundleSource,
  descriptorInput: LocalGitObjectBundleReference,
  signal: AbortSignal,
): { content: AsyncIterable<Uint8Array>; completed: () => boolean } {
  const descriptor = validateLocalGitObjectBundleReference(descriptorInput);
  let opened = false;
  let complete = false;
  const content = (async function* (): AsyncGenerator<Uint8Array> {
    if (opened) throw new Error("Object bundle local git hanya boleh dibuka sekali.");
    opened = true;
    const iterable = source.openObjectBundle(descriptor, signal);
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      throw new Error("Source object bundle local git bukan async iterable.");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of iterable) {
      if (signal.aborted) throw new Error("Transfer object bundle dibatalkan.");
      if (!(value instanceof Uint8Array) || value.byteLength < 1) {
        throw new Error("Chunk object bundle local git tidak sah.");
      }
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > descriptor.size) {
        throw new Error("Object bundle local git melampaui descriptor size.");
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.sha256) {
      throw new Error("Byte object bundle tidak cocok descriptor content-addressed.");
    }
    complete = true;
  })();
  return { content, completed: () => complete };
}

function permissionFor(capability: GitHubCapability): WorkspacePermission {
  switch (capability) {
    case "github.branch.create":
    case "github.push_branch": return "github.push";
    case "github.workflow.write": return "github.workflow.write";
    case "github.pr.create": return "github.pr.create";
    default: throw new Error("Capability GitHub tidak sah.");
  }
}

function permissionsForEffect(
  capability: GitHubCapability,
): readonly WorkspacePermission[] {
  return capability === "github.workflow.write"
    ? ["github.push", "github.workflow.write"]
    : [permissionFor(capability)];
}

function validateAccess(
  access: GitHubRepositoryAccess,
  ownerWorkspaceKey: string,
  installationId: string,
  repositoryId: string,
  targetBranch: string | null,
): void {
  assertExactKeys(access, [
    "ownerWorkspaceKey",
    "installationId",
    "repositoryId",
    "repositoryFullName",
    "visibility",
    "defaultBranch",
    "baseCommit",
    "empty",
    "targetBranch",
      "targetBranchHead",
      "canRead",
      "canPush",
      "canWriteWorkflows",
      "canCreatePullRequest",
  ]);
  if (
    access.ownerWorkspaceKey !== ownerWorkspaceKey ||
    access.installationId !== installationId ||
    access.repositoryId !== repositoryId ||
    !/^[^/\s]+\/[^/\s]+$/u.test(access.repositoryFullName) ||
    (access.visibility !== "public" &&
      access.visibility !== "private" &&
      access.visibility !== "internal") ||
    typeof access.canRead !== "boolean" ||
    typeof access.canPush !== "boolean" ||
    typeof access.canWriteWorkflows !== "boolean" ||
    typeof access.canCreatePullRequest !== "boolean" ||
    access.targetBranch !== targetBranch ||
    access.empty !== (access.baseCommit === null) ||
    (access.targetBranchHead !== null &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(access.targetBranchHead))
  ) throw new Error("Metadata akses GitHub App tidak sah.");
  validBranch(access.defaultBranch);
  if (access.baseCommit !== null) {
    validCommit(access.baseCommit, "remote baseCommit");
  }
}

function validateTransportResult(
  value: GitHubBrokerTransportResult,
  effect: GitHubExactEffect,
): void {
  assertExactKeys(value, [
    "effectId", "status", "operationFenced", "externalId", "url", "completedAt",
  ]);
  if (value.effectId !== effect.effectId) {
    throw new Error("Hasil GitHub broker berasal dari effectId lain.");
  }
  if (
    value.status !== "committed" &&
    value.status !== "unknown" &&
    value.status !== "not_committed"
  ) {
    throw new Error("Status efek GitHub broker tidak sah.");
  }
  if (
    (value.status === "unknown" && value.operationFenced !== false) ||
    (value.status !== "unknown" && value.operationFenced !== true)
  ) {
    throw new Error("Fence hasil GitHub broker tidak cocok dengan status efek.");
  }
  if (value.status !== "committed" && (value.externalId !== null || value.url !== null)) {
    throw new Error("Efek GitHub yang tidak committed tidak boleh membawa receipt eksternal.");
  }
  if (
    value.externalId !== null &&
    !/^[0-9]{1,20}$/u.test(value.externalId)
  ) {
    throw new Error("External id hasil GitHub broker tidak sah.");
  }
  if (value.url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(value.url);
    } catch {
      throw new Error("URL hasil GitHub broker tidak sah.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      value.url.length > 2_048
    ) {
      throw new Error("URL hasil GitHub broker tidak sah.");
    }
  }
  validIso(value.completedAt, "GitHub effect completedAt");
}

function validPublishBranch(branch: string, defaultBranch: string): string {
  validBranch(branch);
  validBranch(defaultBranch);
  if (branch === defaultBranch || !/^harvy\/[a-z0-9][a-z0-9._/-]*$/u.test(branch)) {
    throw new Error("Publish v1 wajib memakai branch harvy/* non-default.");
  }
  return branch;
}

function validBranch(value: string): void {
  if (
    !value ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((segment) => segment.endsWith(".lock")) ||
    /[~^:?*[\\\p{Cc}\s]/u.test(value)
  ) throw new Error("Branch GitHub tidak sah.");
}

function deterministicEffectId(
  effect: Omit<GitHubExactEffect, "effectId">,
): string {
  return `github-effect-${createHash("sha256")
    .update(canonicalJson(effect), "utf8")
    .digest("hex")}`;
}

function retrySemanticDigest(
  effect:
    | Omit<GitHubExactEffect, "effectId" | "attempt">
    | GitHubExactEffect,
): string {
  const record = effect as Partial<GitHubExactEffect> &
    Omit<GitHubExactEffect, "effectId" | "attempt">;
  const { effectId: _effectId, attempt: _attempt, ...semantic } = record;
  return createHash("sha256")
    .update(canonicalJson(semantic), "utf8")
    .digest("hex");
}

function assertAuthorizedEffectAttempt(
  state: GitHubConnectionState,
  effect: GitHubExactEffect,
): void {
  const semanticDigest = retrySemanticDigest(effect);
  const matching = state.receipts.filter(
    (receipt) => retrySemanticDigest(receipt.effect) === semanticDigest,
  );
  const unresolved = [...matching].reverse().find(
    (receipt) => receipt.status !== "not_committed",
  );
  if (unresolved) {
    if (JSON.stringify(unresolved.effect) !== JSON.stringify(effect)) {
      throw new Error("Attempt GitHub baru ditolak selama effect sebelumnya belum not_committed.");
    }
    return;
  }
  const expectedAttempt = matching.reduce(
    (highest, receipt) => Math.max(highest, receipt.effect.attempt),
    0,
  ) + 1;
  if (effect.attempt !== expectedAttempt) {
    throw new Error("Urutan attempt GitHub effect tidak sah.");
  }
}

function assertExactKeys(value: unknown, expected: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schema GitHub exact effect tidak sah.");
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error("Schema GitHub exact effect memuat field asing atau hilang.");
  }
}

function postEffectTargetHead(effect: GitHubExactEffect): string {
  return effect.capability === "github.branch.create"
    ? effect.baseCommit
    : effect.commit;
}

function assertWorkflowCapability(
  run: CodingRun,
  capability: GitHubCapability,
): void {
  const changesWorkflow = Boolean(
    run.diff?.files.some((file) => file.path.startsWith(".github/workflows/")),
  );
  if (changesWorkflow && capability === "github.push_branch") {
    throw new Error(
      "Perubahan workflow GitHub memerlukan capability dan approval github.workflow.write terpisah.",
    );
  }
  if (!changesWorkflow && capability === "github.workflow.write") {
    throw new Error("Capability github.workflow.write hanya sah untuk diff workflow GitHub.");
  }
}

function assertObservedRemoteState(
  effect: GitHubExactEffect,
  access: GitHubRepositoryAccess,
): void {
  const observed = access.targetBranchHead;
  if (observed !== effect.expectedTargetHead && observed !== postEffectTargetHead(effect)) {
    throw new Error("Target branch GitHub tidak fresh terhadap exact effect.");
  }
}

function assertPreEffectRemoteState(
  effect: GitHubExactEffect,
  access: GitHubRepositoryAccess,
): void {
  if (access.targetBranchHead !== effect.expectedTargetHead) {
    throw new Error("Target branch GitHub berubah; efek non-force ditolak.");
  }
}

function validCommit(value: string, field: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field} GitHub tidak sah.`);
  }
  return value;
}

function boundedOptional(
  value: string | undefined | null,
  max: number,
  field: string,
  required: boolean,
): string | null {
  if (value === undefined || value === null || !value.trim()) {
    if (required) throw new Error(`${field} wajib diisi.`);
    return null;
  }
  return safeText(value.trim(), field, max);
}

function safeText(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, ""))
  ) throw new Error(`${field} GitHub tidak sah.`);
  return value;
}

function rejectCredentialMaterial(value: string, field: string): void {
  if (containsSecretLikeValue(value)) {
    throw new Error(`${field} menyerupai credential dan tidak boleh dipersistenkan.`);
  }
}

function validateUnknownEffectReference(
  input: GitHubUnknownEffectReference,
): GitHubUnknownEffectReference {
  assertExactKeys(input, [
    "version",
    "ownerWorkspaceKey",
    "projectId",
    "effectId",
    "effectDigest",
  ]);
  if (input.version !== 1) {
    throw new Error("Versi locator rekonsiliasi GitHub tidak sah.");
  }
  const reference: GitHubUnknownEffectReference = {
    version: 1,
    ownerWorkspaceKey: safeText(
      input.ownerWorkspaceKey,
      "reconciliation ownerWorkspaceKey",
      512,
    ),
    projectId: safeText(input.projectId, "reconciliation projectId", 512),
    effectId: safeText(input.effectId, "reconciliation effectId", 512),
    effectDigest: input.effectDigest,
  };
  if (!/^[a-f0-9]{64}$/u.test(reference.effectDigest)) {
    throw new Error("Digest locator rekonsiliasi GitHub tidak sah.");
  }
  return Object.freeze(reference);
}

function isGitHubConnectionConflict(error: unknown): boolean {
  return error instanceof Error &&
    error.message === "GitHub connection berubah bersamaan; efek tidak diulang.";
}

function positive(value: unknown, field: string, zero = false): void {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) {
    throw new Error(`${field} GitHub tidak sah.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} GitHub tidak sah.`);
}

function opaqueId(prefix: string, value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/giu, "").slice(0, 80);
  if (!clean) throw new Error("Generator ID GitHub broker tidak sah.");
  return `${prefix}-${clean}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}
