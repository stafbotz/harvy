import type {
  GitHubBrokerEffect,
  GitHubExactEffect,
  GitHubRepositoryArchiveReference,
} from "../domain/github.js";
import { validateGitHubRepositoryBootstrapEffect } from
  "../domain/github-bootstrap.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type {
  TrustDomainServiceHandler,
  TrustDomainServiceRequest,
  TrustDomainServiceResponse,
} from "../transport/trust-domain-http-server.js";
import {
  GitHubAppBackend,
  openBrokerFile,
} from "./github-app-backend.js";

export class GitHubBrokerServiceHandler implements TrustDomainServiceHandler {
  constructor(private readonly backend: GitHubAppBackend) {}

  async handle(request: TrustDomainServiceRequest): Promise<TrustDomainServiceResponse> {
    rejectCredentials(request.envelope);
    switch (request.binding.pathname) {
      case "/v1/github-broker/health":
        exactEnvelope(request, ["version"], false);
        return json(await this.backend.health(request.signal));
      case "/v1/github-broker/installations/begin": {
        exactEnvelope(request, ["version", "ownerWorkspaceKey", "sessionId"], false);
        const envelope = object(request.envelope);
        return json(await this.backend.beginInstallation(
          text(envelope.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
          text(envelope.sessionId, "sessionId", 128),
        ));
      }
      case "/v1/github-broker/installations/status": {
        exactEnvelope(request, ["version", "ownerWorkspaceKey", "sessionId", "observationId"], false);
        const envelope = object(request.envelope);
        text(envelope.observationId, "observationId", 256);
        return json(await this.backend.installationStatus(
          text(envelope.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
          text(envelope.sessionId, "sessionId", 128),
          request.signal,
        ));
      }
      case "/v1/github-broker/installations/repositories": {
        exactEnvelope(request, [
          "version", "observationId", "ownerWorkspaceKey", "installationId", "cursor",
        ], false);
        const envelope = object(request.envelope);
        text(envelope.observationId, "observationId", 256);
        return json(await this.backend.listRepositories(
          text(envelope.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
          numericId(envelope.installationId, "installationId"),
          envelope.cursor === null ? null : text(envelope.cursor, "cursor", 512),
          request.signal,
        ));
      }
      case "/v1/github-broker/repository-access": {
        exactEnvelope(request, [
          "version", "observationId", "ownerWorkspaceKey", "installationId", "repositoryId",
          "targetBranch",
        ], false);
        const envelope = object(request.envelope);
        text(envelope.observationId, "observationId", 256);
        return json(await this.backend.repositoryAccess(
          text(envelope.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
          numericId(envelope.installationId, "installationId"),
          numericId(envelope.repositoryId, "repositoryId"),
          envelope.targetBranch === null ? null : branch(envelope.targetBranch),
          request.signal,
        ));
      }
      case "/v1/github-broker/repository-archive/prepare": {
        exactEnvelope(request, [
          "version", "ownerWorkspaceKey", "installationId", "repositoryId", "commit", "operationId",
        ], false);
        const envelope = object(request.envelope);
        return json(await this.backend.prepareRepositoryArchive({
          ownerWorkspaceKey: text(envelope.ownerWorkspaceKey, "ownerWorkspaceKey", 256),
          installationId: numericId(envelope.installationId, "installationId"),
          repositoryId: numericId(envelope.repositoryId, "repositoryId"),
          commit: hash(envelope.commit, "commit"),
          operationId: text(envelope.operationId, "operationId", 256),
        }, request.signal));
      }
      case "/v1/github-broker/repository-archive/download": {
        exactEnvelope(request, ["version", "reference"], false);
        const archive = await this.backend.repositoryArchive(
          parseArchive(object(request.envelope).reference),
        );
        return {
          kind: "download",
          mediaType: archive.reference.mediaType,
          sha256: archive.reference.sha256,
          size: archive.reference.size,
          chunks: openBrokerFile(archive.path),
        };
      }
      case "/v1/github-broker/create-branch": {
        exactEnvelope(request, ["version", "effect"], false);
        return json(await this.backend.createBranch(
          parseEffect(object(request.envelope).effect),
          request.signal,
        ));
      }
      case "/v1/github-broker/bootstrap-repository": {
        exactEnvelope(request, ["version", "effect"], false);
        return json(await this.backend.bootstrapRepository(
          parseBootstrapEffect(object(request.envelope).effect),
          request.signal,
        ));
      }
      case "/v1/github-broker/push-exact-commit": {
        exactEnvelope(request, ["version", "effect"], true);
        const effect = parseEffect(object(request.envelope).effect);
        if (!effect.objectBundle || !request.content ||
          request.content.mediaType !== effect.objectBundle.mediaType ||
          request.content.sha256 !== effect.objectBundle.sha256 ||
          request.content.size !== effect.objectBundle.size) {
          throw routeError("Upload object bundle GitHub tidak cocok exact effect.");
        }
        return json(await this.backend.pushExactCommit(
          effect,
          request.content.chunks,
          request.signal,
        ));
      }
      case "/v1/github-broker/create-draft-pr": {
        exactEnvelope(request, ["version", "effect"], false);
        return json(await this.backend.createDraftPullRequest(
          parseEffect(object(request.envelope).effect),
          request.signal,
        ));
      }
      case "/v1/github-broker/reconcile-effect": {
        exactEnvelope(request, ["version", "effect"], false);
        return json(await this.backend.reconcileEffect(
          parseBrokerEffect(object(request.envelope).effect),
        ));
      }
      default:
        throw routeError("Route GitHub Broker tidak dikenal.");
    }
  }
}

function parseBrokerEffect(value: unknown): GitHubBrokerEffect {
  const input = object(value);
  return input.capability === "github.repository.bootstrap"
    ? parseBootstrapEffect(input)
    : parseEffect(input);
}

function parseBootstrapEffect(value: unknown) {
  const effect = validateGitHubRepositoryBootstrapEffect(
    structuredClone(object(value)) as never,
  );
  numericId(effect.installationId, "installationId");
  numericId(effect.repositoryId, "repositoryId");
  return effect;
}

function parseEffect(value: unknown): GitHubExactEffect {
  const input = object(value);
  exactKeys(input, [
    "effectId", "attempt", "capability", "projectId", "runId", "ownerWorkspaceKey",
    "installationConnectionId", "repositoryBindingId", "installationId", "repositoryId",
    "workspaceRevision", "instructionRevision", "branch", "commit", "baseCommit",
    "expectedTargetHead", "baseBranch", "title", "body", "draft", "objectBundle",
  ], "exact effect GitHub");
  return structuredClone(input) as unknown as GitHubExactEffect;
}

function parseArchive(value: unknown): GitHubRepositoryArchiveReference {
  const input = object(value);
  exactKeys(input, [
    "version", "operationId", "archiveId", "ownerWorkspaceKey", "installationId", "repositoryId",
    "repositoryFullName", "defaultBranch", "commit", "mediaType", "sha256", "size", "createdAt", "expiresAt",
  ], "archive reference GitHub");
  return structuredClone(input) as unknown as GitHubRepositoryArchiveReference;
}

function exactEnvelope(
  request: TrustDomainServiceRequest,
  expected: readonly string[],
  content: boolean,
): void {
  const envelope = object(request.envelope);
  exactKeys(envelope, expected, "envelope GitHub Broker");
  if (envelope.version !== 1 || Boolean(request.content) !== content) {
    throw routeError("Versi/content envelope GitHub Broker tidak sah.");
  }
}

function rejectCredentials(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 2 * 1024 * 1024 ||
    containsSecretLikeValue(serialized) ||
    /"(?:credential|token|privateKey|clientSecret|hostPath|internalPath|remoteUrl)"\s*:/iu.test(serialized)) {
    throw routeError("Envelope GitHub Broker memuat credential/path terlarang.");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("Object GitHub Broker tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw routeError(`${label} memuat field asing atau hilang.`);
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw routeError(`${label} GitHub Broker tidak sah.`);
  }
  return value;
}

function numericId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value) || BigInt(value) < 1n) {
    throw routeError(`${label} GitHub Broker tidak sah.`);
  }
  return value;
}

function branch(value: unknown): string {
  return text(value, "branch", 244);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw routeError(`${label} GitHub Broker tidak sah.`);
  }
  return value;
}

function json(result: unknown): TrustDomainServiceResponse {
  return { kind: "json", result };
}

function routeError(message: string): Error {
  const error = new Error(message);
  error.name = "GitHubBrokerRouteError";
  return error;
}
