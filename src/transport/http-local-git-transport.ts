import {
  validateLocalGitObjectBundleReference,
  type LocalGitBinding,
  type LocalGitCommitReconciliation,
  type LocalGitCommitRequest,
  type LocalGitCommitResult,
  type LocalGitHealth,
  type LocalGitLogEntry,
  type LocalGitObjectBundleReference,
  type LocalGitStatus,
  type LocalGitTransport,
} from "../domain/local-git.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import { canonicalProjectPath } from "../core/project-files.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";
import {
  TrustDomainHttpClient,
  trustDomainRequestId,
  type TrustDomainHttpClientOptions,
} from "./trust-domain-http.js";

const PROTOCOL = "harvy-local-git/1";
const MAX_CHANGED_PATHS = 10_000;

export type HttpLocalGitTransportOptions = Omit<
  TrustDomainHttpClientOptions,
  "protocol"
>;

/**
 * Authenticated, credentialless wire adapter for a separately deployed local
 * git service. It is intentionally not composed by app.ts: protocol success
 * alone does not prove durable object storage, git semantics, or readiness.
 */
export class HttpLocalGitTransport implements LocalGitTransport {
  private readonly client: TrustDomainHttpClient;

  constructor(options: HttpLocalGitTransportOptions) {
    this.client = new TrustDomainHttpClient({ ...options, protocol: PROTOCOL });
  }

  async health(signal?: AbortSignal): Promise<LocalGitHealth> {
    const envelope = { version: 1 as const };
    const raw = await this.client.postJson(
      "/v1/local-git/health",
      trustDomainRequestId("local-git-health", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "health local git");
    exactKeys(result, ["available", "protocol", "checkedAt", "reason"], "health local git");
    if (typeof result.available !== "boolean" ||
      (result.available && result.protocol !== PROTOCOL) ||
      (!result.available && result.protocol !== null) ||
      (result.available && result.reason !== null) ||
      (result.reason !== null && typeof result.reason !== "string")) {
      throw protocolError("Health local git tidak sah.");
    }
    return Object.freeze({
      available: result.available,
      protocol: result.available ? PROTOCOL : null,
      checkedAt: iso(result.checkedAt, "waktu health local git"),
      reason: result.reason === null
        ? null
        : safeText(result.reason, "alasan health local git", 512),
    });
  }

  async status(bindingInput: LocalGitBinding, signal?: AbortSignal): Promise<LocalGitStatus> {
    const binding = bindingEnvelope(bindingInput);
    const envelope = { version: 1 as const, binding };
    const raw = await this.client.postJson(
      "/v1/local-git/status",
      trustDomainRequestId("local-git-status", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "status local git");
    exactKeys(result, ["binding", "changedPaths", "clean"], "status local git");
    const observedBinding = parseBinding(result.binding);
    if (!same(observedBinding, binding)) throw protocolError("Binding status local git tidak cocok.");
    if (!Array.isArray(result.changedPaths) || result.changedPaths.length > MAX_CHANGED_PATHS) {
      throw protocolError("Daftar path status local git tidak sah.");
    }
    const changedPaths = result.changedPaths.map((value) => safeProjectPath(value));
    if (new Set(changedPaths).size !== changedPaths.length ||
      typeof result.clean !== "boolean" || result.clean !== (changedPaths.length === 0)) {
      throw protocolError("Status local git tidak konsisten.");
    }
    return Object.freeze({ binding: observedBinding, changedPaths, clean: result.clean });
  }

  async diff(bindingInput: LocalGitBinding, signal?: AbortSignal): Promise<{
    binding: LocalGitBinding;
    textArtifactId: string;
    sha256: string;
  }> {
    const binding = bindingEnvelope(bindingInput);
    const envelope = { version: 1 as const, binding };
    const raw = await this.client.postJson(
      "/v1/local-git/diff",
      trustDomainRequestId("local-git-diff", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "diff local git");
    exactKeys(result, ["binding", "textArtifactId", "sha256"], "diff local git");
    const observedBinding = parseBinding(result.binding);
    if (!same(observedBinding, binding)) throw protocolError("Binding diff local git tidak cocok.");
    return Object.freeze({
      binding: observedBinding,
      textArtifactId: safeOpaque(result.textArtifactId, "artifact diff local git", 512),
      sha256: sha(result.sha256, "SHA diff local git"),
    });
  }

  async log(
    bindingInput: LocalGitBinding,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ binding: LocalGitBinding; entries: LocalGitLogEntry[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw protocolError("Limit log local git tidak sah.");
    }
    const binding = bindingEnvelope(bindingInput);
    const envelope = { version: 1 as const, binding, limit };
    const raw = await this.client.postJson(
      "/v1/local-git/log",
      trustDomainRequestId("local-git-log", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "log local git");
    exactKeys(result, ["binding", "entries"], "log local git");
    const observedBinding = parseBinding(result.binding);
    if (!same(observedBinding, binding) || !Array.isArray(result.entries) ||
      result.entries.length > limit) {
      throw protocolError("Log local git tidak mengikat request.");
    }
    const entries = result.entries.map((entry) => parseLogEntry(entry));
    return Object.freeze({ binding: observedBinding, entries });
  }

  async reconcileCommit(
    requestInput: LocalGitCommitRequest,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitReconciliation> {
    const request = commitRequestEnvelope(requestInput);
    const envelope = { version: 1 as const, request };
    const raw = await this.client.postJson(
      "/v1/local-git/reconcile",
      request.operationId,
      envelope,
      signal,
    );
    return parseReconciliation(wireResult(raw, "rekonsiliasi local git"), request);
  }

  async commit(
    requestInput: LocalGitCommitRequest,
    snapshotInput: ProjectSnapshotBundleDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitResult> {
    const request = commitRequestEnvelope(requestInput);
    const snapshot = snapshotEnvelope(snapshotInput, request.binding.snapshotId);
    const envelope = { version: 1 as const, request, snapshot };
    const raw = await this.client.postUpload(
      "/v1/local-git/commit",
      request.operationId,
      envelope,
      {
        mediaType: snapshot.mediaType,
        sha256: snapshot.bundleSha256,
        size: snapshot.size,
        chunks: content,
      },
      signal,
    );
    return parseCommitResult(wireResult(raw, "commit local git"), request);
  }

  openObjectBundle(
    referenceInput: LocalGitObjectBundleReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const reference = validateLocalGitObjectBundleReference(referenceInput);
    const envelope = { version: 1 as const, reference };
    return this.client.postDownload(
      "/v1/local-git/object-bundle",
      reference.artifactId,
      envelope,
      {
        mediaType: reference.mediaType,
        sha256: reference.sha256,
        size: reference.size,
      },
      signal,
    );
  }
}

function bindingEnvelope(input: LocalGitBinding): LocalGitBinding {
  exactKeys(input, [
    "projectId",
    "snapshotId",
    "workspaceRevision",
    "baseCommit",
    "headCommit",
    "branch",
  ], "binding local git request");
  return Object.freeze({
    projectId: safeOpaque(input.projectId, "projectId local git", 256),
    snapshotId: sha(input.snapshotId, "snapshotId local git"),
    workspaceRevision: positiveInteger(input.workspaceRevision, "revision local git"),
    baseCommit: gitHash(input.baseCommit, "base commit local git"),
    headCommit: gitHash(input.headCommit, "head commit local git"),
    branch: gitBranch(input.branch),
  });
}

function commitRequestEnvelope(input: LocalGitCommitRequest): LocalGitCommitRequest {
  exactKeys(input, ["operationId", "binding", "targetBranch", "message", "author"], "request commit local git");
  exactKeys(input.author, ["name", "email"], "author commit local git");
  if (input.author.name !== "Harvy Bot" || input.author.email !== "bot@harvy.local") {
    throw protocolError("Author local git tidak sah.");
  }
  return Object.freeze({
    operationId: safeOperationId(input.operationId),
    binding: bindingEnvelope(input.binding),
    targetBranch: gitBranch(input.targetBranch),
    message: safeText(input.message, "message local git", 512),
    author: Object.freeze({ name: "Harvy Bot" as const, email: "bot@harvy.local" as const }),
  });
}

function snapshotEnvelope(
  input: ProjectSnapshotBundleDescriptor,
  expectedSnapshotId: string,
): ProjectSnapshotBundleDescriptor {
  exactKeys(input, [
    "version",
    "snapshotId",
    "bundleSha256",
    "manifestSha256",
    "size",
    "fileCount",
    "mediaType",
  ], "snapshot local git");
  if (input.version !== 1 || input.snapshotId !== expectedSnapshotId ||
    input.mediaType !== "application/vnd.harvy.snapshot-bundle.v1") {
    throw protocolError("Descriptor snapshot local git tidak cocok.");
  }
  return Object.freeze({
    version: 1,
    snapshotId: sha(input.snapshotId, "snapshotId local git"),
    bundleSha256: sha(input.bundleSha256, "bundle SHA local git"),
    manifestSha256: sha(input.manifestSha256, "manifest SHA local git"),
    size: boundedInteger(input.size, "ukuran snapshot local git", 1, 2 * 1024 * 1024 * 1024),
    fileCount: boundedInteger(input.fileCount, "jumlah file snapshot local git", 0, 10_000),
    mediaType: "application/vnd.harvy.snapshot-bundle.v1",
  });
}

function parseBinding(input: unknown): LocalGitBinding {
  return bindingEnvelope(input as LocalGitBinding);
}

function parseLogEntry(input: unknown): LocalGitLogEntry {
  exactKeys(input, [
    "commit",
    "parentCommit",
    "subject",
    "authoredAt",
    "authorName",
    "authorEmail",
  ], "entry log local git");
  const entry = input as Record<string, unknown>;
  return Object.freeze({
    commit: gitHash(entry.commit, "commit log local git"),
    parentCommit: entry.parentCommit === null
      ? null
      : gitHash(entry.parentCommit, "parent log local git"),
    subject: safeText(entry.subject, "subject log local git", 512),
    authoredAt: iso(entry.authoredAt, "waktu log local git"),
    authorName: safeText(entry.authorName, "author log local git", 256),
    authorEmail: safeText(entry.authorEmail, "email log local git", 320),
  });
}

function parseReconciliation(
  input: unknown,
  request: LocalGitCommitRequest,
): LocalGitCommitReconciliation {
  if (!plainObject(input)) throw protocolError("Rekonsiliasi local git bukan object.");
  const status = input.status;
  if (status === "committed") {
    exactKeys(input, ["operationId", "status", "operationFenced", "receipt"], "rekonsiliasi committed local git");
    if (input.operationId !== request.operationId || input.operationFenced !== true) {
      throw protocolError("Fence rekonsiliasi committed local git tidak sah.");
    }
    return Object.freeze({
      operationId: request.operationId,
      status,
      operationFenced: true,
      receipt: parseCommitResult(input.receipt, request),
    });
  }
  if (status !== "not_committed" && status !== "unknown") {
    throw protocolError("Status rekonsiliasi local git tidak sah.");
  }
  exactKeys(input, ["operationId", "status", "operationFenced"], "rekonsiliasi local git");
  const expectedFence = status === "not_committed";
  if (input.operationId !== request.operationId || input.operationFenced !== expectedFence) {
    throw protocolError("Fence rekonsiliasi local git tidak sah.");
  }
  return Object.freeze({
    operationId: request.operationId,
    status,
    operationFenced: expectedFence,
  } as LocalGitCommitReconciliation);
}

function parseCommitResult(
  input: unknown,
  request: LocalGitCommitRequest,
): LocalGitCommitResult {
  exactKeys(input, [
    "operationId",
    "projectId",
    "snapshotId",
    "sourceWorkspaceRevision",
    "branch",
    "parentCommit",
    "commit",
    "treeHash",
    "objectBundle",
    "authorName",
    "authorEmail",
    "committedAt",
  ], "receipt commit local git");
  const result = input as Record<string, unknown>;
  if (result.operationId !== request.operationId ||
    result.projectId !== request.binding.projectId ||
    result.snapshotId !== request.binding.snapshotId ||
    result.sourceWorkspaceRevision !== request.binding.workspaceRevision ||
    result.branch !== request.targetBranch ||
    result.parentCommit !== request.binding.headCommit ||
    result.authorName !== "Harvy Bot" || result.authorEmail !== "bot@harvy.local") {
    throw protocolError("Receipt commit local git tidak mengikat request.");
  }
  const commit = gitHash(result.commit, "commit receipt local git");
  const parentCommit = gitHash(result.parentCommit, "parent receipt local git");
  const treeHash = gitHash(result.treeHash, "tree receipt local git");
  const objectBundle = validateLocalGitObjectBundleReference(
    result.objectBundle as LocalGitObjectBundleReference,
  );
  if (commit === parentCommit || objectBundle.commit !== commit ||
    objectBundle.parentCommit !== parentCommit || objectBundle.treeHash !== treeHash) {
    throw protocolError("Object bundle local git tidak mengikat receipt.");
  }
  return Object.freeze({
    operationId: request.operationId,
    projectId: request.binding.projectId,
    snapshotId: request.binding.snapshotId,
    sourceWorkspaceRevision: request.binding.workspaceRevision,
    branch: request.targetBranch,
    parentCommit,
    commit,
    treeHash,
    objectBundle,
    authorName: "Harvy Bot",
    authorEmail: "bot@harvy.local",
    committedAt: iso(result.committedAt, "waktu commit local git"),
  });
}

function wireResult(input: unknown, label: string): Record<string, unknown> {
  exactKeys(input, ["version", "result"], `wire ${label}`);
  const wire = input as Record<string, unknown>;
  if (wire.version !== 1 || !plainObject(wire.result)) {
    throw protocolError(`Wire ${label} tidak sah.`);
  }
  return wire.result;
}

function safeProjectPath(input: unknown): string {
  if (typeof input !== "string") throw protocolError("Path status local git bukan teks.");
  const path = canonicalProjectPath(input);
  if (isSensitiveProjectPath(path) || containsSecretLikeValue(path)) {
    throw protocolError("Path sensitif tidak boleh keluar dari local git trust-domain.");
  }
  return path;
}

function safeOperationId(input: unknown): string {
  if (typeof input !== "string" || !/^local-git-[a-f0-9]{64}$/u.test(input)) {
    throw protocolError("Operation ID local git tidak sah.");
  }
  return input;
}

function gitBranch(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 244 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(input) ||
    input.includes("..") || input.includes("//") || input.endsWith(".") ||
    input.endsWith("/") || input.endsWith(".lock") || input.includes("@{")) {
    throw protocolError("Branch local git tidak sah.");
  }
  return input;
}

function gitHash(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input)) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function sha(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function safeOpaque(input: unknown, label: string, max: number): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max ||
    /\p{Cc}/u.test(input) || containsSecretLikeValue(input)) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function safeText(input: unknown, label: string, max: number): string {
  return safeOpaque(input, label, max);
}

function iso(input: unknown, label: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  return boundedInteger(input, label, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(input: unknown, label: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) {
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

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function protocolError(message: string): Error {
  const error = new Error(message);
  error.name = "LocalGitProtocolError";
  return error;
}
