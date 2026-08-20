import type {
  LocalGitBinding,
  LocalGitCommitRequest,
  LocalGitObjectBundleReference,
} from "../domain/local-git.js";
import { validateLocalGitObjectBundleReference } from "../domain/local-git.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type {
  TrustDomainServiceHandler,
  TrustDomainServiceRequest,
  TrustDomainServiceResponse,
} from "../transport/trust-domain-http-server.js";
import {
  LocalGitBackend,
  openLocalGitBundle,
} from "./local-git-backend.js";

export class LocalGitServiceHandler implements TrustDomainServiceHandler {
  constructor(private readonly backend: LocalGitBackend) {}

  async handle(request: TrustDomainServiceRequest): Promise<TrustDomainServiceResponse> {
    rejectCredentials(request.envelope);
    switch (request.binding.pathname) {
      case "/v1/local-git/health":
        exactEnvelope(request, ["version"], false);
        return json(await this.backend.health());
      case "/v1/local-git/prepare": {
        exactEnvelope(request, ["version", "binding", "snapshot"], true);
        const envelope = object(request.envelope);
        const binding = parseBinding(envelope.binding);
        const snapshot = parseSnapshot(envelope.snapshot, binding.snapshotId);
        assertUpload(request, snapshot);
        return json(await this.backend.prepare(
          binding,
          snapshot,
          request.content!.chunks,
          request.signal,
        ));
      }
      case "/v1/local-git/status": {
        exactEnvelope(request, ["version", "binding"], false);
        return json(await this.backend.status(parseBinding(object(request.envelope).binding)));
      }
      case "/v1/local-git/diff": {
        exactEnvelope(request, ["version", "binding"], false);
        return json(await this.backend.diff(parseBinding(object(request.envelope).binding)));
      }
      case "/v1/local-git/log": {
        exactEnvelope(request, ["version", "binding", "limit"], false);
        const envelope = object(request.envelope);
        const limit = integer(envelope.limit, "log limit", 1, 100);
        return json(await this.backend.log(parseBinding(envelope.binding), limit));
      }
      case "/v1/local-git/reconcile": {
        exactEnvelope(request, ["version", "request"], false);
        return json(await this.backend.reconcileCommit(
          parseCommitRequest(object(request.envelope).request),
        ));
      }
      case "/v1/local-git/commit": {
        exactEnvelope(request, ["version", "request", "snapshot"], true);
        const envelope = object(request.envelope);
        const commit = parseCommitRequest(envelope.request);
        const snapshot = parseSnapshot(envelope.snapshot, commit.binding.snapshotId);
        assertUpload(request, snapshot);
        return json(await this.backend.commit(
          commit,
          snapshot,
          request.content!.chunks,
          request.signal,
        ));
      }
      case "/v1/local-git/object-bundle": {
        exactEnvelope(request, ["version", "reference"], false);
        const reference = validateLocalGitObjectBundleReference(
          object(request.envelope).reference as LocalGitObjectBundleReference,
        );
        const bundle = await this.backend.objectBundle(reference);
        return {
          kind: "download",
          mediaType: reference.mediaType,
          sha256: reference.sha256,
          size: reference.size,
          chunks: openLocalGitBundle(bundle.path),
        };
      }
      default:
        throw routeError("Route local git tidak dikenal.");
    }
  }
}

function parseBinding(input: unknown): LocalGitBinding {
  const value = object(input);
  exactKeys(value, [
    "projectId", "snapshotId", "workspaceRevision", "baseCommit", "headCommit", "branch",
  ], "binding local git");
  return {
    projectId: safeText(value.projectId, "projectId", 512),
    snapshotId: sha256(value.snapshotId, "snapshotId"),
    workspaceRevision: integer(value.workspaceRevision, "workspaceRevision", 1, Number.MAX_SAFE_INTEGER),
    baseCommit: gitHash(value.baseCommit, "baseCommit"),
    headCommit: gitHash(value.headCommit, "headCommit"),
    branch: gitBranch(value.branch),
  };
}

function parseCommitRequest(input: unknown): LocalGitCommitRequest {
  const value = object(input);
  exactKeys(value, ["operationId", "binding", "targetBranch", "message", "author"], "commit request local git");
  const author = object(value.author);
  exactKeys(author, ["name", "email"], "commit author local git");
  if (author.name !== "Harvy Bot" || author.email !== "bot@harvy.local" ||
    typeof value.operationId !== "string" || !/^local-git-[a-f0-9]{64}$/u.test(value.operationId) ||
    typeof value.message !== "string" || !/^Harvy coding update [a-f0-9]{12}$/u.test(value.message)) {
    throw routeError("Commit request local git tidak code-owned.");
  }
  return {
    operationId: value.operationId,
    binding: parseBinding(value.binding),
    targetBranch: gitBranch(value.targetBranch),
    message: value.message,
    author: { name: "Harvy Bot", email: "bot@harvy.local" },
  };
}

function parseSnapshot(input: unknown, expectedId: string): ProjectSnapshotBundleDescriptor {
  const value = object(input);
  exactKeys(value, [
    "version", "snapshotId", "bundleSha256", "manifestSha256", "size", "fileCount", "mediaType",
  ], "snapshot local git");
  if (value.version !== 1 || value.snapshotId !== expectedId ||
    value.mediaType !== "application/vnd.harvy.snapshot-bundle.v1") {
    throw routeError("Snapshot local git tidak cocok binding.");
  }
  return {
    version: 1,
    snapshotId: expectedId,
    bundleSha256: sha256(value.bundleSha256, "bundle sha"),
    manifestSha256: sha256(value.manifestSha256, "manifest sha"),
    size: integer(value.size, "snapshot size", 1, 2 * 1_024 * 1_024 * 1_024),
    fileCount: integer(value.fileCount, "snapshot file count", 0, 10_000),
    mediaType: "application/vnd.harvy.snapshot-bundle.v1",
  };
}

function assertUpload(
  request: TrustDomainServiceRequest,
  snapshot: ProjectSnapshotBundleDescriptor,
): void {
  if (!request.content || request.content.mediaType !== snapshot.mediaType ||
    request.content.sha256 !== snapshot.bundleSha256 || request.content.size !== snapshot.size) {
    throw routeError("Upload local git tidak cocok descriptor.");
  }
}

function exactEnvelope(
  request: TrustDomainServiceRequest,
  keys: readonly string[],
  content: boolean,
): void {
  const envelope = object(request.envelope);
  exactKeys(envelope, keys, "envelope local git");
  if (envelope.version !== 1 || Boolean(request.content) !== content) {
    throw routeError("Versi/content envelope local git tidak sah.");
  }
}

function rejectCredentials(input: unknown): void {
  const text = JSON.stringify(input);
  if (text === undefined || text.length > 2 * 1_024 * 1_024 ||
    containsSecretLikeValue(text) || /"(?:remote|url|credential|token|hostPath|internalPath)"\s*:/iu.test(text)) {
    throw routeError("Envelope local git memuat credential/remote/path terlarang.");
  }
}

function gitBranch(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 244 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input) || input.includes("..") ||
    input.includes("//") || input.endsWith(".") || input.endsWith("/") ||
    input.endsWith(".lock") || input.includes("@{")) {
    throw routeError("Branch local git tidak sah.");
  }
  return input;
}

function gitHash(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{40}$/u.test(input)) {
    throw routeError(`${label} local git tidak sah.`);
  }
  return input;
}

function sha256(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
    throw routeError(`${label} local git tidak sah.`);
  }
  return input;
}

function safeText(input: unknown, label: string, maximum: number): string {
  if (typeof input !== "string" || !input || input.length > maximum ||
    /[\u0000\r\n]/u.test(input) || containsSecretLikeValue(input)) {
    throw routeError(`${label} local git tidak sah.`);
  }
  return input;
}

function integer(input: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) ||
    input < minimum || input > maximum) throw routeError(`${label} local git tidak sah.`);
  return input;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("Object local git tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw routeError(`${label} memuat field asing atau hilang.`);
  }
}

function json(result: unknown): TrustDomainServiceResponse {
  return { kind: "json", result };
}

function routeError(message: string): Error {
  const error = new Error(message);
  error.name = "LocalGitRouteError";
  return error;
}
