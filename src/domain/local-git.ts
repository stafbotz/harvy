import { createHash } from "node:crypto";
import type { ProjectSnapshotBundleDescriptor } from "./project-transfer.js";

export const LOCAL_GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const LOCAL_GIT_UPLOAD_ROOT_CONTENT =
  `tree ${LOCAL_GIT_EMPTY_TREE}\n` +
  "author Harvy Bot <bot@harvy.local> 0 +0000\n" +
  "committer Harvy Bot <bot@harvy.local> 0 +0000\n" +
  "\nHarvy uploaded workspace root\n";
export const LOCAL_GIT_UPLOAD_ROOT_COMMIT = createHash("sha1")
  .update(`commit ${Buffer.byteLength(LOCAL_GIT_UPLOAD_ROOT_CONTENT)}\0`, "utf8")
  .update(LOCAL_GIT_UPLOAD_ROOT_CONTENT, "utf8")
  .digest("hex");

export interface LocalGitBinding {
  projectId: string;
  snapshotId: string;
  workspaceRevision: number;
  baseCommit: string;
  headCommit: string;
  branch: string;
}

export interface LocalGitStatus {
  binding: LocalGitBinding;
  changedPaths: string[];
  clean: boolean;
}

export interface LocalGitHealth {
  available: boolean;
  protocol: "harvy-local-git/1" | null;
  checkedAt: string;
  reason: string | null;
}

export interface LocalGitLogEntry {
  commit: string;
  parentCommit: string | null;
  subject: string;
  authoredAt: string;
  authorName: string;
  authorEmail: string;
}

export interface LocalGitCommitRequest {
  operationId: string;
  binding: LocalGitBinding;
  targetBranch: string;
  message: string;
  author: {
    name: "Harvy Bot";
    email: "bot@harvy.local";
  };
}

export interface LocalGitCommitResult {
  operationId: string;
  projectId: string;
  snapshotId: string;
  sourceWorkspaceRevision: number;
  branch: string;
  parentCommit: string;
  commit: string;
  treeHash: string;
  objectBundle: LocalGitObjectBundleReference;
  authorName: "Harvy Bot";
  authorEmail: "bot@harvy.local";
  committedAt: string;
}

/**
 * Credentialless, content-addressed hand-off from the local git trust domain
 * to the GitHub App broker. No host path or GitHub credential is legal here.
 */
export interface LocalGitObjectBundleReference {
  version: 1;
  artifactId: string;
  sha256: string;
  size: number;
  mediaType: "application/vnd.git.bundle";
  commit: string;
  parentCommit: string;
  treeHash: string;
}

/** Byte source may be an object store shared by the two trust domains. */
export interface LocalGitObjectBundleSource {
  openObjectBundle(
    reference: LocalGitObjectBundleReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

export function validateLocalGitObjectBundleReference(
  input: LocalGitObjectBundleReference,
): LocalGitObjectBundleReference {
  const expectedKeys = [
    "version",
    "artifactId",
    "sha256",
    "size",
    "mediaType",
    "commit",
    "parentCommit",
    "treeHash",
  ].sort();
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys) ||
    input.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    input.artifactId !== `git-bundle-${input.sha256}` ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > 2 * 1024 * 1024 * 1024 ||
    input.mediaType !== "application/vnd.git.bundle" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.commit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.parentCommit) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.treeHash) ||
    input.commit === input.parentCommit
  ) {
    throw new Error("Descriptor object bundle local git tidak sah.");
  }
  return Object.freeze(structuredClone(input));
}

export type LocalGitCommitReconciliation =
  | {
      operationId: string;
      status: "committed";
      operationFenced: true;
      receipt: LocalGitCommitResult;
    }
  | {
      operationId: string;
      status: "not_committed";
      /**
       * Every earlier invocation is quiescent. A later explicit commit call may
       * reuse this same permanent idempotency key.
       */
      operationFenced: true;
    }
  | {
      operationId: string;
      status: "unknown";
      operationFenced: false;
    };

/** Code-owned intent prevents model text from changing commit identity on retry. */
export function createLocalGitCommitRequest(
  binding: LocalGitBinding,
): LocalGitCommitRequest {
  const slug = binding.projectId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120) || binding.snapshotId.slice(0, 12);
  const targetBranch = /^harvy\/[a-z0-9][a-z0-9._/-]*$/u.test(binding.branch)
    ? binding.branch
    : `harvy/${slug}`;
  const message = `Harvy coding update ${binding.snapshotId.slice(0, 12)}`;
  const author = { name: "Harvy Bot" as const, email: "bot@harvy.local" as const };
  const operationId = `local-git-${createHash("sha256")
    .update(JSON.stringify({ binding, branch: targetBranch, message, author }), "utf8")
    .digest("hex")}`;
  return { operationId, binding, targetBranch, message, author };
}

/**
 * Runs local git in the coding trust domain; it has no remote/credential API.
 * `operationId` is a permanent server-side idempotency key. A
 * `not_committed` is only legal after all prior invocations are quiescent;
 * Harvy may then make one explicit commit call with the same idempotency key.
 */
export interface LocalGitTransport extends LocalGitObjectBundleSource {
  health(signal?: AbortSignal): Promise<LocalGitHealth>;
  /** Idempotently installs an immutable project snapshot in this trust domain. */
  prepare(
    binding: LocalGitBinding,
    snapshot: ProjectSnapshotBundleDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ binding: LocalGitBinding }>;
  status(binding: LocalGitBinding, signal?: AbortSignal): Promise<LocalGitStatus>;
  diff(binding: LocalGitBinding, signal?: AbortSignal): Promise<{
    binding: LocalGitBinding;
    textArtifactId: string;
    sha256: string;
  }>;
  log(binding: LocalGitBinding, limit: number, signal?: AbortSignal): Promise<{
    binding: LocalGitBinding;
    entries: LocalGitLogEntry[];
  }>;
  reconcileCommit(
    request: LocalGitCommitRequest,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitReconciliation>;
  commit(
    request: LocalGitCommitRequest,
    snapshot: ProjectSnapshotBundleDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitResult>;
}

export class UnavailableLocalGitTransport implements LocalGitTransport {
  constructor(
    private readonly reason = "Local git runner belum dikonfigurasi.",
    private readonly now: () => Date = () => new Date(),
  ) {}
  async health(_signal?: AbortSignal): Promise<LocalGitHealth> {
    return {
      available: false,
      protocol: null,
      checkedAt: this.now().toISOString(),
      reason: this.reason,
    };
  }
  async prepare(
    _binding: LocalGitBinding,
    _snapshot: ProjectSnapshotBundleDescriptor,
    _content: AsyncIterable<Uint8Array>,
    _signal?: AbortSignal,
  ): Promise<{ binding: LocalGitBinding }> {
    throw new Error(this.reason);
  }
  async status(_binding: LocalGitBinding, _signal?: AbortSignal): Promise<LocalGitStatus> {
    throw new Error(this.reason);
  }
  async diff(_binding: LocalGitBinding, _signal?: AbortSignal): Promise<{
    binding: LocalGitBinding;
    textArtifactId: string;
    sha256: string;
  }> {
    throw new Error(this.reason);
  }
  async log(
    _binding: LocalGitBinding,
    _limit: number,
    _signal?: AbortSignal,
  ): Promise<{
    binding: LocalGitBinding;
    entries: LocalGitLogEntry[];
  }> {
    throw new Error(this.reason);
  }
  async reconcileCommit(
    _request: LocalGitCommitRequest,
    _signal?: AbortSignal,
  ): Promise<LocalGitCommitReconciliation> {
    throw new Error(this.reason);
  }
  async commit(
    _request: LocalGitCommitRequest,
    _snapshot: ProjectSnapshotBundleDescriptor,
    _content: AsyncIterable<Uint8Array>,
    _signal?: AbortSignal,
  ): Promise<LocalGitCommitResult> {
    throw new Error(this.reason);
  }

  openObjectBundle(
    _reference: LocalGitObjectBundleReference,
    _signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const reason = this.reason;
    return (async function* (): AsyncGenerator<Uint8Array> {
      throw new Error(reason);
    })();
  }
}
