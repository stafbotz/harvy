import { randomUUID } from "node:crypto";
import type {
  GitHubBrokerEffect,
  GitHubBrokerHealth,
  GitHubBrokerTransport,
  GitHubBrokerTransportResult,
  GitHubExactEffect,
  GitHubInstallationTransport,
  GitHubInstallationSession,
  GitHubInstallationStatus,
  GitHubRepositoryArchiveReference,
  GitHubRepositoryAccess,
  GitHubRepositoryBootstrapEffect,
  GitHubRepositoryPage,
} from "../domain/github.js";
import { validateGitHubRepositoryBootstrapEffect } from
  "../domain/github-bootstrap.js";
import {
  validateLocalGitObjectBundleReference,
} from "../domain/local-git.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  TrustDomainHttpClient,
  trustDomainRequestId,
  type TrustDomainHttpClientOptions,
} from "./trust-domain-http.js";

const PROTOCOL = "harvy-github-broker/1";
const EFFECT_KEYS = [
  "effectId",
  "attempt",
  "capability",
  "projectId",
  "runId",
  "ownerWorkspaceKey",
  "installationConnectionId",
  "repositoryBindingId",
  "installationId",
  "repositoryId",
  "workspaceRevision",
  "instructionRevision",
  "branch",
  "commit",
  "baseCommit",
  "expectedTargetHead",
  "baseBranch",
  "title",
  "body",
  "draft",
  "objectBundle",
] as const;

export type HttpGitHubBrokerTransportOptions = Omit<
  TrustDomainHttpClientOptions,
  "protocol"
>;

/**
 * Service-identity HTTP adapter. It never accepts an App private key,
 * installation token, PAT, or generic REST operation. Provider credentials
 * remain exclusively inside the remote broker implementation.
 */
export class HttpGitHubBrokerTransport
implements GitHubBrokerTransport, GitHubInstallationTransport {
  private readonly client: TrustDomainHttpClient;

  constructor(options: HttpGitHubBrokerTransportOptions) {
    this.client = new TrustDomainHttpClient({ ...options, protocol: PROTOCOL });
  }

  async health(signal?: AbortSignal): Promise<GitHubBrokerHealth> {
    const envelope = { version: 1 as const };
    const raw = await this.client.postJson(
      "/v1/github-broker/health",
      trustDomainRequestId("github-broker-health", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "health GitHub Broker");
    exactKeys(result, ["available", "protocol", "checkedAt", "reason"], "health GitHub Broker");
    if (typeof result.available !== "boolean" ||
      (result.available && (result.protocol !== PROTOCOL || result.reason !== null)) ||
      (!result.available && (result.protocol !== null || typeof result.reason !== "string"))) {
      throw protocolError("Health GitHub Broker tidak sah.");
    }
    return Object.freeze({
      available: result.available,
      protocol: result.available ? PROTOCOL : null,
      checkedAt: iso(result.checkedAt, "waktu health GitHub Broker"),
      reason: result.reason === null
        ? null
        : safeText(result.reason, "alasan health GitHub Broker", 512),
    });
  }

  async beginInstallation(
    ownerWorkspaceKey: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GitHubInstallationSession> {
    const envelope = installationEnvelope(ownerWorkspaceKey, sessionId);
    const raw = await this.client.postJson(
      "/v1/github-broker/installations/begin",
      sessionId,
      envelope,
      signal,
    );
    const result = installationSessionResult(raw);
    if (result.ownerWorkspaceKey !== envelope.ownerWorkspaceKey ||
      result.sessionId !== envelope.sessionId) {
      throw protocolError("Binding GitHub installation session tidak cocok request.");
    }
    return result;
  }

  async installationStatus(
    ownerWorkspaceKey: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GitHubInstallationStatus> {
    const envelope = {
      ...installationEnvelope(ownerWorkspaceKey, sessionId),
      observationId: `github-installation-status-${randomUUID()}`,
    };
    const raw = await this.client.postJson(
      "/v1/github-broker/installations/status",
      envelope.observationId,
      envelope,
      signal,
    );
    const result = installationStatusResult(raw);
    if (result.ownerWorkspaceKey !== envelope.ownerWorkspaceKey ||
      result.sessionId !== envelope.sessionId) {
      throw protocolError("Binding GitHub installation status tidak cocok request.");
    }
    return result;
  }

  async listRepositories(
    ownerWorkspaceKey: string,
    installationId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryPage> {
    const envelope = {
      version: 1 as const,
      observationId: `github-repository-list-${randomUUID()}`,
      ownerWorkspaceKey: safeText(ownerWorkspaceKey, "ownerWorkspaceKey", 256),
      installationId: safeText(installationId, "installationId", 128),
      cursor: cursor === null ? null : safeText(cursor, "repository cursor", 512),
    };
    noCredentialEnvelope(envelope, "installation repositories");
    const raw = await this.client.postJson(
      "/v1/github-broker/installations/repositories",
      envelope.observationId,
      envelope,
      signal,
    );
    const result = repositoryPageResult(raw);
    if (result.ownerWorkspaceKey !== envelope.ownerWorkspaceKey ||
      result.installationId !== envelope.installationId) {
      throw protocolError("Binding daftar repository GitHub tidak cocok request.");
    }
    return result;
  }

  async repositoryAccess(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    targetBranch: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryAccess> {
    const envelope = {
      version: 1 as const,
      observationId: `github-repository-access-${randomUUID()}`,
      ownerWorkspaceKey: safeText(ownerWorkspaceKey, "ownerWorkspaceKey", 256),
      installationId: safeText(installationId, "installationId", 128),
      repositoryId: safeText(repositoryId, "repositoryId", 128),
      targetBranch: targetBranch === null ? null : safeText(targetBranch, "target branch", 244),
    };
    noCredentialEnvelope(envelope, "repository access");
    const raw = await this.client.postJson(
      "/v1/github-broker/repository-access",
      envelope.observationId,
      envelope,
      signal,
    );
    const result = structuredClone(
      wireResult(raw, "repository access"),
    ) as unknown as GitHubRepositoryAccess;
    exactKeys(result, [
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
    ], "repository access");
    if (result.ownerWorkspaceKey !== envelope.ownerWorkspaceKey ||
      result.installationId !== envelope.installationId ||
      result.repositoryId !== envelope.repositoryId ||
      result.targetBranch !== envelope.targetBranch) {
      throw protocolError("Binding repository access tidak cocok request.");
    }
    return result;
  }

  async prepareRepositoryArchive(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    commit: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryArchiveReference> {
    const envelope = {
      version: 1 as const,
      ownerWorkspaceKey: safeText(ownerWorkspaceKey, "ownerWorkspaceKey", 256),
      installationId: safeText(installationId, "installationId", 128),
      repositoryId: safeText(repositoryId, "repositoryId", 128),
      commit: commitHash(commit, "repository archive commit"),
      operationId: safeText(operationId, "repository archive operationId", 256),
    };
    noCredentialEnvelope(envelope, "repository archive descriptor");
    const raw = await this.client.postJson(
      "/v1/github-broker/repository-archive/prepare",
      envelope.operationId,
      envelope,
      signal,
    );
    const result = repositoryArchiveResult(raw);
    if (result.ownerWorkspaceKey !== envelope.ownerWorkspaceKey ||
      result.installationId !== envelope.installationId ||
      result.repositoryId !== envelope.repositoryId ||
      result.operationId !== envelope.operationId ||
      result.commit !== envelope.commit) {
      throw protocolError("Binding archive repository GitHub tidak cocok request.");
    }
    return result;
  }

  downloadRepositoryArchive(
    referenceInput: GitHubRepositoryArchiveReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const reference = repositoryArchiveReference(referenceInput);
    const envelope = { version: 1 as const, reference };
    noCredentialEnvelope(envelope, "repository archive download");
    return this.client.postDownload(
      "/v1/github-broker/repository-archive/download",
      reference.archiveId,
      envelope,
      {
        mediaType: reference.mediaType,
        sha256: reference.sha256,
        size: reference.size,
      },
      signal,
    );
  }

  async createBranch(
    effectInput: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = effectEnvelope(effectInput, "github.branch.create");
    return this.effectJson("/v1/github-broker/create-branch", effect, signal);
  }

  async bootstrapRepository(
    effectInput: GitHubRepositoryBootstrapEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = validateGitHubRepositoryBootstrapEffect(effectInput);
    return this.effectJson(
      "/v1/github-broker/bootstrap-repository",
      effect,
      signal,
    );
  }

  async pushExactCommit(
    effectInput: GitHubExactEffect,
    objectBundle: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = effectEnvelope(effectInput, ["github.push_branch", "github.workflow.write"]);
    if (!effect.objectBundle) throw protocolError("Exact push GitHub kehilangan object bundle.");
    const bundle = validateLocalGitObjectBundleReference(effect.objectBundle);
    const envelope = { version: 1 as const, effect };
    const raw = await this.client.postUpload(
      "/v1/github-broker/push-exact-commit",
      effect.effectId,
      envelope,
      {
        mediaType: bundle.mediaType,
        sha256: bundle.sha256,
        size: bundle.size,
        chunks: objectBundle,
      },
      signal,
    );
    return structuredClone(wireResult(raw, "exact push GitHub")) as unknown as GitHubBrokerTransportResult;
  }

  async createDraftPullRequest(
    effectInput: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = effectEnvelope(effectInput, "github.pr.create");
    return this.effectJson("/v1/github-broker/create-draft-pr", effect, signal);
  }

  async reconcileEffect(
    effectInput: GitHubBrokerEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = effectInput.capability === "github.repository.bootstrap"
      ? validateGitHubRepositoryBootstrapEffect(effectInput)
      : effectEnvelope(effectInput);
    return this.effectJson("/v1/github-broker/reconcile-effect", effect, signal);
  }

  private async effectJson(
    path: string,
    effect: GitHubBrokerEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const envelope = { version: 1 as const, effect };
    const raw = await this.client.postJson(path, effect.effectId, envelope, signal);
    return structuredClone(wireResult(raw, "effect GitHub")) as unknown as GitHubBrokerTransportResult;
  }
}

function installationEnvelope(ownerWorkspaceKey: string, sessionId: string) {
  const envelope = {
    version: 1 as const,
    ownerWorkspaceKey: safeText(ownerWorkspaceKey, "ownerWorkspaceKey", 256),
    sessionId: safeText(sessionId, "installation sessionId", 128),
  };
  noCredentialEnvelope(envelope, "GitHub installation session");
  return envelope;
}

function installationSessionResult(input: unknown): GitHubInstallationSession {
  const result = wireResult(input, "GitHub installation session");
  exactKeys(result, [
    "sessionId",
    "ownerWorkspaceKey",
    "status",
    "authorizationUrl",
    "createdAt",
    "expiresAt",
  ], "GitHub installation session");
  if (result.status !== "pending") {
    throw protocolError("Status GitHub installation session tidak sah.");
  }
  const authorizationUrl = safeInstallationUrl(result.authorizationUrl);
  return Object.freeze({
    sessionId: safeText(result.sessionId, "installation sessionId", 128),
    ownerWorkspaceKey: safeText(result.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
    status: "pending",
    authorizationUrl,
    createdAt: iso(result.createdAt, "installation createdAt"),
    expiresAt: iso(result.expiresAt, "installation expiresAt"),
  });
}

function installationStatusResult(input: unknown): GitHubInstallationStatus {
  const result = wireResult(input, "GitHub installation status");
  exactKeys(result, [
    "sessionId",
    "ownerWorkspaceKey",
    "status",
    "installationId",
    "completedAt",
    "expiresAt",
  ], "GitHub installation status");
  if (result.status !== "pending" && result.status !== "ready" &&
    result.status !== "expired" && result.status !== "revoked") {
    throw protocolError("Status GitHub installation tidak sah.");
  }
  const installationId = result.installationId === null
    ? null
    : safeText(result.installationId, "installationId", 128);
  const completedAt = result.completedAt === null
    ? null
    : iso(result.completedAt, "installation completedAt");
  return Object.freeze({
    sessionId: safeText(result.sessionId, "installation sessionId", 128),
    ownerWorkspaceKey: safeText(result.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
    status: result.status,
    installationId,
    completedAt,
    expiresAt: iso(result.expiresAt, "installation expiresAt"),
  });
}

function repositoryPageResult(input: unknown): GitHubRepositoryPage {
  const result = wireResult(input, "GitHub installation repositories");
  exactKeys(result, [
    "ownerWorkspaceKey",
    "installationId",
    "repositories",
    "nextCursor",
  ], "GitHub installation repositories");
  if (!Array.isArray(result.repositories) || result.repositories.length > 100) {
    throw protocolError("Daftar repository GitHub installation tidak sah.");
  }
  const installationId = safeText(result.installationId, "installationId", 128);
  const repositories = result.repositories.map((repository) => {
    exactKeys(repository, [
      "installationId",
      "repositoryId",
      "repositoryFullName",
      "visibility",
      "defaultBranch",
    ], "GitHub repository summary");
    const value = repository as Record<string, unknown>;
    if (value.installationId !== installationId ||
      (value.visibility !== "public" && value.visibility !== "private" &&
        value.visibility !== "internal")) {
      throw protocolError("Repository summary GitHub tidak sah.");
    }
    return {
      installationId,
      repositoryId: safeText(value.repositoryId, "repositoryId", 128),
      repositoryFullName: repositoryName(value.repositoryFullName),
      visibility: value.visibility as GitHubRepositoryPage["repositories"][number]["visibility"],
      defaultBranch: branch(value.defaultBranch, "defaultBranch"),
    };
  });
  return Object.freeze({
    ownerWorkspaceKey: safeText(result.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
    installationId,
    repositories,
    nextCursor: result.nextCursor === null
      ? null
      : safeText(result.nextCursor, "repository cursor", 512),
  });
}

function repositoryArchiveResult(input: unknown): GitHubRepositoryArchiveReference {
  return repositoryArchiveReference(wireResult(input, "GitHub repository archive"));
}

function repositoryArchiveReference(input: unknown): GitHubRepositoryArchiveReference {
  exactKeys(input, [
    "version",
    "operationId",
    "archiveId",
    "ownerWorkspaceKey",
    "installationId",
    "repositoryId",
    "repositoryFullName",
    "defaultBranch",
    "commit",
    "mediaType",
    "sha256",
    "size",
    "createdAt",
    "expiresAt",
  ], "GitHub repository archive");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || value.mediaType !== "application/zip" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || (value.size as number) < 1 ||
    (value.size as number) > 128 * 1024 * 1024) {
    throw protocolError("Descriptor archive GitHub tidak sah.");
  }
  const reference: GitHubRepositoryArchiveReference = {
    version: 1,
    operationId: safeText(value.operationId, "repository archive operationId", 256),
    archiveId: safeText(value.archiveId, "repository archiveId", 256),
    ownerWorkspaceKey: safeText(value.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
    installationId: safeText(value.installationId, "installationId", 128),
    repositoryId: safeText(value.repositoryId, "repositoryId", 128),
    repositoryFullName: repositoryName(value.repositoryFullName),
    defaultBranch: branch(value.defaultBranch, "defaultBranch"),
    commit: commitHash(value.commit, "repository archive commit"),
    mediaType: "application/zip",
    sha256: value.sha256,
    size: value.size as number,
    createdAt: iso(value.createdAt, "repository archive createdAt"),
    expiresAt: iso(value.expiresAt, "repository archive expiresAt"),
  };
  noCredentialEnvelope(reference, "GitHub repository archive");
  return Object.freeze(reference);
}

function safeInstallationUrl(input: unknown): string {
  const value = safeText(input, "GitHub installation URL", 4096);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError("URL GitHub installation tidak sah.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
    url.username !== "" || url.password !== "" || url.hash !== "" ||
    !/^\/apps\/[a-z0-9-]+\/installations\/new$/iu.test(url.pathname) ||
    !url.searchParams.has("state") ||
    [...url.searchParams.keys()].some(
      (key) => key !== "state" && key !== "suggested_target_id",
    )) {
    throw protocolError("URL GitHub installation tidak sah.");
  }
  return url.toString();
}

function repositoryName(input: unknown): string {
  const value = safeText(input, "repositoryFullName", 256);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw protocolError("Nama repository GitHub tidak sah.");
  }
  return value;
}

function branch(input: unknown, label: string): string {
  const value = safeText(input, label, 244);
  if (value.startsWith("-") || value.startsWith(".") || value.endsWith(".") ||
    value.endsWith("/") || value.includes("..") || value.includes("//") ||
    /[~^:?*[\\\s\x00-\x1f\x7f]/u.test(value) || value.endsWith(".lock")) {
    throw protocolError(`${label} GitHub tidak sah.`);
  }
  return value;
}

function commitHash(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input)) {
    throw protocolError(`${label} GitHub tidak sah.`);
  }
  return input;
}

function effectEnvelope(
  input: GitHubExactEffect,
  expectedCapability?: GitHubExactEffect["capability"] | readonly GitHubExactEffect["capability"][],
): GitHubExactEffect {
  exactKeys(input, EFFECT_KEYS, "exact effect GitHub");
  const effect = structuredClone(input);
  const expected = expectedCapability === undefined
    ? null
    : Array.isArray(expectedCapability)
      ? expectedCapability
      : [expectedCapability];
  if (expected && !expected.includes(effect.capability)) {
    throw protocolError("Capability exact effect tidak cocok endpoint GitHub Broker.");
  }
  noCredentialEnvelope(effect, "exact effect GitHub");
  return effect;
}

function wireResult(input: unknown, label: string): Record<string, unknown> {
  exactKeys(input, ["version", "result"], `wire ${label}`);
  const wire = input as Record<string, unknown>;
  if (wire.version !== 1 || !plainObject(wire.result)) {
    throw protocolError(`Wire ${label} tidak sah.`);
  }
  noCredentialEnvelope(wire.result, `response ${label}`);
  return wire.result;
}

function noCredentialEnvelope(input: unknown, label: string): void {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || serialized.length > 1024 * 1024 ||
    containsSecretLikeValue(serialized) ||
    /"(?:credential|token|privateKey|authorization|internalPath|hostPath)"\s*:/iu.test(serialized)) {
    throw protocolError(`Envelope ${label} memuat credential/path terlarang atau terlalu besar.`);
  }
}

function safeText(input: unknown, label: string, max: number): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max ||
    /\p{Cc}/u.test(input) || containsSecretLikeValue(input)) {
    throw protocolError(`${label} GitHub Broker tidak sah.`);
  }
  return input;
}

function iso(input: unknown, label: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function exactKeys(input: unknown, expected: readonly string[], label: string): void {
  if (!plainObject(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...expected].sort())) {
    throw protocolError(`Schema ${label} memuat field asing atau hilang.`);
  }
}

function plainObject(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function protocolError(message: string): Error {
  const error = new Error(message);
  error.name = "GitHubBrokerProtocolError";
  return error;
}
