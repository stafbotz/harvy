import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AiClient } from "../ai/client.js";
import { AiCodingWorkerDriver } from "../ai/coding-worker-driver.js";
import { CodingValidatorToughestRecovery } from "../ai/coding-validator-escalation.js";
import type { AiConfig } from "../config.js";
import { ProductionCodingValidatorPolicy } from "../coding/production-coding-validator-policy.js";
import type { WorkspacePrincipalChannel } from "../domain/workspace.js";
import type { GroupMessage } from "../domain/group.js";
import type {
  AuthenticatedGroupCodingActor,
  GroupCodingRunMutator,
  GroupCodingRunCreator,
  GroupCodingRunReader,
  GroupRuntimeBindingReader,
} from "./group-workspace-coding-controller.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { FileCodingEvidenceStore } from "../storage/file-coding-evidence-store.js";
import { FileCodingRunRepository } from "../storage/file-coding-run-repository.js";
import { FileGitHubConnectionRepository } from "../storage/file-github-connection-repository.js";
import { FileGroupCodingRepository } from "../storage/file-group-coding-repository.js";
import { FilePrivateCodingSessionStore } from "../storage/file-private-coding-session-store.js";
import { FileModelEscalationRepository } from "../storage/file-model-escalation-repository.js";
import { FileProjectDeletionRepository } from "../storage/file-project-deletion-repository.js";
import { FileProjectWorkspaceRepository } from "../storage/file-project-workspace-repository.js";
import { SqliteSandboxLeaseJournal } from
  "../storage/sqlite-sandbox-lease-journal.js";
import { FileWorkspaceRepository } from "../storage/file-workspace-repository.js";
import { HttpGitHubBrokerTransport } from "../transport/http-github-broker-transport.js";
import { HttpLocalGitTransport } from "../transport/http-local-git-transport.js";
import { HttpSandboxTransport } from "../transport/http-sandbox-transport.js";
import { HmacTrustDomainRequestProofProvider } from "../transport/trust-domain-http.js";
import { CodingRunCoordinator } from "./coding-run-coordinator.js";
import { CodingRunEngine } from "./coding-run-engine.js";
import { CodingRunProgressHub } from "./coding-run-progress-hub.js";
import { CodingRunScheduler } from "./coding-run-scheduler.js";
import { CodingRuntimeSupervisor } from "./coding-runtime-supervisor.js";
import { GitHubBroker } from "./github-broker.js";
import { GitHubInstallationService } from "./github-installation-service.js";
import { startGitHubReconciliationWorker } from "./github-reconciliation-worker.js";
import { GroupCodingRunDriver } from "./group-coding-run-driver.js";
import {
  GroupCodingLifecycleFenceService,
  type GroupCodingLifecycleFenceInput,
  type GroupCodingLifecycleFenceResult,
} from "./group-coding-lifecycle-fence.js";
import { LocalGitService } from "./local-git-service.js";
import { OneShotModelEscalationService } from "./model-escalation-policy.js";
import {
  assertSandboxRuntimeMatchesConformanceReceipt,
  loadCodingRuntimeConformanceReceipt,
  PinnedCodingRuntimeConformanceVerifier,
} from "./pinned-coding-runtime-conformance.js";
import { PrivateCodingApplication } from "./private-coding-application.js";
import { PrivateGitHubConfirmationController } from "./private-github-confirmation-controller.js";
import { PrivateGitHubApplication } from "./private-github-application.js";
import { ProjectDeletionCoordinator } from "./project-deletion-coordinator.js";
import { startProjectDeletionRecoveryWorker } from "./project-deletion-recovery-worker.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { SandboxRunnerService } from "./sandbox-runner-service.js";
import { TrustedWorkspaceActorRegistry } from "./trusted-workspace-actor-registry.js";
import { TrustedGroupCodingActorRegistry } from "./trusted-group-coding-actor-registry.js";
import { WorkspaceAuthorityService, workspacePrincipal } from "./workspace-authority-service.js";
import { WorkspaceCodingController, type AuthenticatedWorkspaceActor } from "./workspace-coding-controller.js";

export interface TrustDomainClientDeployment {
  origin: string;
  keyId: string;
  secretFile: string;
  allowInsecureLoopback: boolean;
}

export interface CodingRuntimeDeploymentConfig {
  enabled: boolean;
  stateRoot: string | null;
  principalSecretFile: string | null;
  conformanceReceiptFile: string | null;
  conformanceReceiptSha256: string | null;
  sandbox: TrustDomainClientDeployment | null;
  localGit: TrustDomainClientDeployment | null;
  github: TrustDomainClientDeployment | null;
  /** Explicit privacy domain for project material sent to the primary model. */
  codingAiPrivacyDomain: string | null;
}

export interface CodingRuntimeComposition {
  application: PrivateCodingApplication;
  actors: TrustedWorkspaceActorRegistry;
  authority: WorkspaceAuthorityService;
  projects: ProjectWorkspaceService;
  runs: CodingRunEngine;
  supervisor: CodingRuntimeSupervisor;
  githubInstallations: GitHubInstallationService | null;
  githubBroker: GitHubBroker | null;
  githubConfirmations: PrivateGitHubConfirmationController;
  privateGitHub: PrivateGitHubApplication | null;
  groupActors: TrustedGroupCodingActorRegistry;
  groupRuns: GroupCodingRunCreator & GroupCodingRunReader & GroupCodingRunMutator;
  groupRepository: FileGroupCodingRepository;
  progress: CodingRunProgressHub;
  fenceGroupCoding(
    input: GroupCodingLifecycleFenceInput,
  ): Promise<GroupCodingLifecycleFenceResult>;
  issuePrivateActor(input: {
    channel: WorkspacePrincipalChannel;
    platformId: string;
    interactionId: string;
  }): AuthenticatedWorkspaceActor;
  issueGroupActor(message: GroupMessage): AuthenticatedGroupCodingActor;
}

export function loadCodingRuntimeDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): CodingRuntimeDeploymentConfig {
  const enabled = enabledFlag(env.HARVY_CODING_RUNTIME_ENABLED);
  if (!enabled) {
    return {
      enabled: false,
      stateRoot: null,
      principalSecretFile: null,
      conformanceReceiptFile: null,
      conformanceReceiptSha256: null,
      sandbox: null,
      localGit: null,
      github: null,
      codingAiPrivacyDomain: null,
    };
  }
  const insecure = enabledFlag(env.HARVY_CODING_ALLOW_INSECURE_LOOPBACK);
  const githubEnabled = enabledFlag(env.HARVY_GITHUB_RUNTIME_ENABLED);
  return {
    enabled: true,
    stateRoot: requiredPath(env, "HARVY_CODING_STATE_ROOT"),
    principalSecretFile: requiredPath(env, "HARVY_WORKSPACE_PRINCIPAL_SECRET_FILE"),
    conformanceReceiptFile: requiredPath(env, "HARVY_CODING_CONFORMANCE_RECEIPT_FILE"),
    conformanceReceiptSha256: requiredSha(env, "HARVY_CODING_CONFORMANCE_RECEIPT_SHA256"),
    sandbox: trustDomain(env, "SANDBOX", insecure),
    localGit: trustDomain(env, "LOCAL_GIT", insecure),
    github: githubEnabled ? trustDomain(env, "GITHUB_BROKER", insecure) : null,
    codingAiPrivacyDomain: optionalPrivacyDomain(
      env.HARVY_CODING_AI_PRIVACY_DOMAIN,
    ),
  };
}

export async function createCodingRuntimeComposition(input: {
  config: CodingRuntimeDeploymentConfig;
  aiClient: AiClient;
  ai: AiConfig;
  groupBindings?: GroupRuntimeBindingReader | null;
  logger?: OperationalLogger;
}): Promise<CodingRuntimeComposition | null> {
  const config = input.config;
  if (!config.enabled) return null;
  if (
    !config.stateRoot || !config.principalSecretFile ||
    !config.conformanceReceiptFile || !config.conformanceReceiptSha256 ||
    !config.sandbox || !config.localGit
  ) throw new Error("Konfigurasi coding runtime production tidak lengkap.");
  const logger = input.logger ?? NOOP_OPERATIONAL_LOGGER.child("coding.runtime");
  const root = resolve(config.stateRoot);
  const principalSecret = await readBase64UrlSecret(config.principalSecretFile);
  const sandboxProof = await proof(config.sandbox);
  const localGitProof = await proof(config.localGit);
  const githubProof = config.github ? await proof(config.github) : null;
  const receipt = await loadCodingRuntimeConformanceReceipt(
    config.conformanceReceiptFile,
  );
  const verifier = new PinnedCodingRuntimeConformanceVerifier(
    config.conformanceReceiptSha256,
  );

  const workspaceRepository = new FileWorkspaceRepository(join(root, "workspaces.json"));
  const authority = new WorkspaceAuthorityService(workspaceRepository);
  const projectRepository = new FileProjectWorkspaceRepository(join(root, "projects.json"));
  const deletionRepository = new FileProjectDeletionRepository(join(root, "project-deletions.json"));
  const githubRepository = new FileGitHubConnectionRepository(join(root, "github-connections.json"));
  const groupRepository = new FileGroupCodingRepository(join(root, "group-coding.json"));
  const projects = new ProjectWorkspaceService(
    projectRepository,
    authority,
    {
      root: join(root, "project-storage"),
      processRoot: process.cwd(),
    },
    undefined,
    undefined,
    undefined,
    githubRepository,
    deletionRepository,
  );
  const sandboxTransport = new HttpSandboxTransport({
    origin: config.sandbox.origin,
    proofProvider: sandboxProof,
    allowInsecureLoopback: config.sandbox.allowInsecureLoopback,
  });
  const sandbox = new SandboxRunnerService(
    sandboxTransport,
    new SqliteSandboxLeaseJournal(join(root, "sandbox-leases.sqlite")),
  );
  const evidence = new FileCodingEvidenceStore(join(root, "coding-evidence"));
  const runRepository = new FileCodingRunRepository(join(root, "coding-runs.json"));
  const validator = new ProductionCodingValidatorPolicy(input.aiClient, input.ai);
  const runs = new CodingRunEngine(
    runRepository,
    projects,
    sandbox,
    validator,
    { evidenceStore: evidence },
  );
  const progress = new CodingRunProgressHub();
  const worker = new AiCodingWorkerDriver(input.aiClient, input.ai);
  const escalationService = new OneShotModelEscalationService(
    new FileModelEscalationRepository(join(root, "model-escalations.json")),
  );
  if (input.ai.toughest && !config.codingAiPrivacyDomain) {
    throw new Error(
      "HARVY_CODING_AI_PRIVACY_DOMAIN wajib untuk toughest coding.",
    );
  }
  const validatorEscalation = input.ai.toughest && config.codingAiPrivacyDomain
    ? new CodingValidatorToughestRecovery(
        input.aiClient,
        input.ai,
        escalationService,
        (run) => worker.budgetFor(run),
        {
          sourcePrivacyDomain: config.codingAiPrivacyDomain,
          crossProviderApproved: false,
        },
      )
    : undefined;
  const coordinator = new CodingRunCoordinator(runs, worker, {
    onProgress: (run) => progress.report(run),
    ...(validatorEscalation ? { validatorEscalation } : {}),
  });
  const scheduler = new CodingRunScheduler(
    coordinator,
    runs,
    {},
    receipt,
    () => new Date(),
    verifier,
  );
  const actors = new TrustedWorkspaceActorRegistry();
  const groupActors = new TrustedGroupCodingActorRegistry();
  const workspaceController = new WorkspaceCodingController(
    authority,
    actors,
    projects,
    runs,
  );
  const localGitTransport = new HttpLocalGitTransport({
    origin: config.localGit.origin,
    proofProvider: localGitProof,
    allowInsecureLoopback: config.localGit.allowInsecureLoopback,
  });
  const localGit = new LocalGitService(projects, localGitTransport, authority);
  const groupDriver = new GroupCodingRunDriver(
    scheduler,
    runs,
    localGit,
    logger.child("group-coding-driver"),
  );
  const groupRuns: GroupCodingRunCreator & GroupCodingRunReader & GroupCodingRunMutator = {
    start: async (scope, projectId, expectedRevision, brief, options) => {
      const run = await runs.start(scope, projectId, expectedRevision, brief, options);
      await progress.report(run);
      return run;
    },
    get: (scope, runId) => runs.get(scope, runId),
    revise: async (scope, runId, revision) => {
      const run = await runs.revise(scope, runId, revision);
      await progress.report(run);
      return run;
    },
    cancel: async (scope, runId) => {
      const run = await runs.cancel(scope, runId);
      await progress.report(run);
      return run;
    },
    interrupt: (scope, runId) => scheduler.interrupt(scope, runId),
    schedule: (scope, initialRun) => groupDriver.schedule(scope, initialRun),
  };
  const groupCodingLifecycle = new GroupCodingLifecycleFenceService(
    groupRepository,
    runRepository,
    scheduler,
    runs,
    progress,
  );
  const fenceGroupCoding = (
    input: GroupCodingLifecycleFenceInput,
  ): Promise<GroupCodingLifecycleFenceResult> => groupCodingLifecycle.fence(input);
  const recoverGroupCodingRuns = async (): Promise<void> => {
    const references = await groupRepository.listRunReferences();
    const referencedRunIds = new Set(references.map((reference) => reference.runId));
    for (const orphan of await runRepository.listActive()) {
      if (orphan.admission?.source !== "group" || referencedRunIds.has(orphan.runId)) {
        continue;
      }
      await scheduler.interruptByBinding(
        orphan.binding.ownerWorkspaceKey,
        orphan.runId,
      );
      const fenced = await runs.cancelByAdmissionFence({
        version: 1,
        source: "group",
        cause: "group_authority_changed",
        runId: orphan.runId,
        ownerWorkspaceKey: orphan.binding.ownerWorkspaceKey,
        projectId: orphan.binding.projectId,
        effectId: orphan.admission.effectId,
        authorityRef: orphan.admission.authorityRef,
      });
      await progress.report(fenced.run);
      if (fenced.pendingCommit) {
        throw new Error(
          `Group CodingRun yatim ${orphan.runId} masih mempunyai pending commit.`,
        );
      }
    }
    for (const reference of references) {
      let durable = await runRepository.load(reference.runId);
      if (!durable) continue;
      const terminal = terminalCodingRun(durable);
      const link = await groupRepository.loadLink(
        reference.scopeKey,
        reference.accountId,
      );
      const binding = await input.groupBindings?.binding(reference.scopeKey) ?? null;
      const bindingCurrent = Boolean(
        link && link.status === "active" && link.linkId === reference.linkId &&
        link.stateRevision === reference.linkStateRevision &&
        link.groupJoinedAt === reference.groupJoinedAt && binding &&
        binding.disabledAt === null && binding.accountId === reference.accountId &&
        binding.joinedAt === reference.groupJoinedAt,
      );
      const scope = await authority.resolveScope(reference.workspaceKey, {
        channel: "whatsapp",
        principalKey: reference.initiatedByPrincipalKey,
      });
      if (!bindingCurrent || !scope || scope.membershipId !== reference.initiatedByMembershipId) {
        if (!terminal) {
          await groupCodingLifecycle.fence({
            scopeKey: reference.scopeKey,
            accountId: reference.accountId,
            cause: "group_authority_changed",
          });
          durable = await runRepository.load(reference.runId);
          if (!durable || !terminalCodingRun(durable)) {
            throw new Error(
              `Recovery Group CodingRun ${reference.runId} belum terminal setelah authority fence.`,
            );
          }
          await progress.report(durable);
        }
        continue;
      }
      if (
        durable.binding.ownerWorkspaceKey !== reference.workspaceKey ||
        durable.binding.projectId !== reference.projectId ||
        durable.admission?.source !== "group" ||
        durable.admission.effectId !== reference.effectId ||
        durable.admission.authorityRef !== reference.linkId
      ) throw new Error("Recovery Group CodingRun menemukan binding yang tidak konsisten.");
      if (durable.pendingCommit) {
        durable = await runs.recoverPendingCommit(scope, durable.runId);
        if (durable.pendingCommit) {
          throw new Error("Pending commit Group CodingRun belum dapat direkonsiliasi.");
        }
      }
      await progress.report(durable);
      if (
        durable.status === "completed" ||
        (!terminal && durable.status !== "waiting_input")
      ) groupRuns.schedule?.(scope, durable);
    }
  };
  const privateSessions = new FilePrivateCodingSessionStore(
    join(root, "private-coding-sessions.json"),
  );
  const application = new PrivateCodingApplication(
    actors,
    workspaceController,
    authority,
    projects,
    runs,
    scheduler,
    localGit,
    privateSessions,
    progress,
    undefined,
    groupRepository,
  );
  const githubConfirmations = new PrivateGitHubConfirmationController();
  const githubTransport = config.github && githubProof
    ? new HttpGitHubBrokerTransport({
        origin: config.github.origin,
        proofProvider: githubProof,
        allowInsecureLoopback: config.github.allowInsecureLoopback,
      })
    : null;
  const githubInstallations = githubTransport
    ? new GitHubInstallationService(
        githubRepository,
        githubTransport,
        githubTransport,
        githubConfirmations,
        authority,
        projects,
      )
    : null;
  const githubBroker = githubTransport
    ? new GitHubBroker(
        githubRepository,
        githubTransport,
        githubConfirmations,
        authority,
        projects,
        runRepository,
        localGitTransport,
      )
    : null;
  const privateGitHub = githubInstallations && githubBroker
    ? new PrivateGitHubApplication(
        actors,
        authority,
        runs,
        githubInstallations,
        githubBroker,
        githubConfirmations,
        githubRepository,
        privateSessions,
      )
    : null;
  const deletion = new ProjectDeletionCoordinator(
    deletionRepository,
    projects,
    runRepository,
    runs,
    evidence,
    githubRepository,
  );
  const supervisor = new CodingRuntimeSupervisor({
    sandbox,
    scheduler,
    createGitHubRecoveryWorker: () => githubBroker
      ? startGitHubReconciliationWorker(
          githubRepository,
          githubBroker,
          logger.child("github-reconciliation"),
        )
      : emptyGitHubRecoveryWorker(),
    createProjectDeletionRecoveryWorker: () =>
      startProjectDeletionRecoveryWorker(
        deletionRepository,
        deletion,
        logger.child("project-deletion-recovery"),
      ),
    async verifyProductionDependencies() {
      const sandboxHealth = await sandbox.health();
      assertSandboxRuntimeMatchesConformanceReceipt(sandboxHealth, receipt);
      const localHealth = await localGit.health();
      if (!localHealth.available) {
        throw new Error("Local-git trust domain tidak tersedia.");
      }
      if (githubBroker) {
        const githubHealth = await githubBroker.health();
        if (!githubHealth.available) {
          throw new Error("GitHub Broker trust domain tidak tersedia.");
        }
      }
    },
    recoverCodingRuns: async () => {
      await escalationService.recoverReserved();
      groupDriver.start();
      application.start();
      await application.recoverDurableRuns();
      await recoverGroupCodingRuns();
    },
    runLifecycle: {
      stop: () => {
        application.stop();
        groupDriver.stop();
      },
      drain: async () => {
        await Promise.all([
          application.drain(),
          groupDriver.drain(),
        ]);
      },
    },
  }, { enableCodingAdmission: true });

  return {
    application,
    actors,
    authority,
    projects,
    runs,
    supervisor,
    githubInstallations,
    githubBroker,
    githubConfirmations,
    privateGitHub,
    groupActors,
    groupRuns,
    groupRepository,
    progress,
    fenceGroupCoding,
    issuePrivateActor({ channel, platformId, interactionId }) {
      return actors.issue({
        principal: workspacePrincipal(principalSecret, channel, platformId),
        interactionId,
        audience: "workspace-private",
      });
    },
    issueGroupActor(message) {
      return groupActors.issue(
        message,
        workspacePrincipal(
          principalSecret,
          "whatsapp",
          message.participantId,
        ),
      );
    },
  };
}

async function proof(
  config: TrustDomainClientDeployment,
): Promise<HmacTrustDomainRequestProofProvider> {
  return new HmacTrustDomainRequestProofProvider(
    config.keyId,
    await readBase64UrlSecretBytes(config.secretFile),
  );
}

async function readBase64UrlSecret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength < 32) throw new Error("Secret principal workspace terlalu pendek.");
  return value;
}

async function readBase64UrlSecretBytes(path: string): Promise<Buffer> {
  return decodeBase64Url((await readFile(path, "utf8")).trim());
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Secret base64url tidak sah.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.byteLength < 32 || bytes.byteLength > 4_096) {
    throw new Error("Secret trust-domain tidak sah.");
  }
  return bytes;
}

function trustDomain(
  env: NodeJS.ProcessEnv,
  prefix: string,
  allowInsecureLoopback: boolean,
): TrustDomainClientDeployment {
  const origin = requiredText(env, `HARVY_${prefix}_ORIGIN`);
  const url = new URL(origin);
  if (url.origin !== origin || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`HARVY_${prefix}_ORIGIN harus exact origin.`);
  }
  return {
    origin,
    keyId: requiredText(env, `HARVY_${prefix}_HMAC_KEY_ID`),
    secretFile: requiredPath(env, `HARVY_${prefix}_HMAC_SECRET_FILE`),
    allowInsecureLoopback,
  };
}

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  return resolve(requiredText(env, name));
}

function requiredSha(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredText(env, name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} bukan SHA-256.`);
  return value;
}

function requiredText(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || /\p{Cc}/u.test(value)) throw new Error(`${name} wajib diisi.`);
  return value;
}

function enabledFlag(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Flag coding runtime tidak sah.");
}

function optionalPrivacyDomain(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(normalized)) {
    throw new Error("HARVY_CODING_AI_PRIVACY_DOMAIN tidak sah.");
  }
  return normalized;
}

function emptyGitHubRecoveryWorker() {
  return {
    stop() {},
    async drain() {},
    async runNow() {
      return { discovered: 0, terminal: 0, unresolved: 0, missing: 0, failed: 0 };
    },
  };
}

function terminalCodingRun(run: { status: string }): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}
