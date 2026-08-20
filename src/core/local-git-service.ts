import { createHash } from "node:crypto";
import {
  createLocalGitCommitRequest,
  validateLocalGitObjectBundleReference,
  type LocalGitCommitReconciliation,
  type LocalGitBinding,
  type LocalGitCommitRequest,
  type LocalGitCommitResult,
  type LocalGitHealth,
  type LocalGitLogEntry,
  type LocalGitStatus,
  type LocalGitTransport,
} from "../domain/local-git.js";
import type {
  ProjectSnapshotBundleDescriptor,
  ProjectSnapshotBundleSource,
} from "../domain/project-transfer.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { canonicalProjectPath } from "./project-files.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import { callTransportWithDeadline } from "./transport-deadline.js";

const DEFAULT_LOCAL_GIT_TRANSPORT_TIMEOUT_MS = 30_000;

/** Local commit is a separate effect from every remote GitHub operation. */
export class LocalGitService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly transportTimeoutMs: number;

  constructor(
    private readonly projects: ProjectWorkspaceService,
    private readonly transport: LocalGitTransport,
    private readonly authority: WorkspaceAuthorityService,
    options: { transportTimeoutMs?: number } = {},
  ) {
    this.transportTimeoutMs = boundedTransportTimeout(
      options.transportTimeoutMs ?? DEFAULT_LOCAL_GIT_TRANSPORT_TIMEOUT_MS,
    );
  }

  async health(): Promise<LocalGitHealth> {
    const result = await this.transportCall(
      "Local git health",
      (signal) => this.transport.health(signal),
    );
    assertExactKeys(result, ["available", "protocol", "checkedAt", "reason"], "health git lokal");
    if (typeof result.available !== "boolean" ||
      (result.available && result.protocol !== "harvy-local-git/1") ||
      (!result.available && result.protocol !== null) ||
      (result.reason !== null && (typeof result.reason !== "string" ||
        result.reason.length < 1 || result.reason.length > 512 ||
        containsSecretLikeValue(result.reason))) ||
      (result.available && result.reason !== null)) {
      throw new Error("Health local git tidak sah.");
    }
    validIso(result.checkedAt, "local git health checkedAt");
    return Object.freeze(structuredClone(result));
  }

  async status(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<LocalGitStatus> {
    return this.authority.withPermission(scope, "code.read", () =>
      this.projects.withFreshProjectPermissions(
        scope,
        projectId,
        expectedRevision,
        ["code.read"],
        async () => {
          const binding = await this.readBinding(scope, projectId, expectedRevision);
          await this.prepareBinding(scope, binding);
          const result = await this.transportCall(
            "Local git status",
            (signal) => this.transport.status(binding, signal),
          );
          assertExactKeys(result, ["binding", "changedPaths", "clean"], "status git lokal");
          if (!sameBinding(result.binding, binding)) {
            throw new Error("Status git lokal berasal dari binding lain.");
          }
          if (!Array.isArray(result.changedPaths) || result.changedPaths.length > 10_000 ||
            typeof result.clean !== "boolean" ||
            result.clean !== (result.changedPaths.length === 0)) {
            throw new Error("Status git lokal tidak sah.");
          }
          const changedPaths = result.changedPaths.map((value) => {
            const path = canonicalProjectPath(value);
            if (isSensitiveProjectPath(path) || containsSecretLikeValue(path)) {
              throw new Error("Status git lokal memuat path sensitif.");
            }
            return path;
          });
          if (new Set(changedPaths).size !== changedPaths.length) {
            throw new Error("Status git lokal memuat path duplikat.");
          }
          return { binding: structuredClone(binding), changedPaths, clean: result.clean };
        },
      )
    );
  }

  async diff(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<{ textArtifactId: string; sha256: string }> {
    return this.authority.withPermission(scope, "code.read", () =>
      this.projects.withFreshProjectPermissions(
        scope,
        projectId,
        expectedRevision,
        ["code.read"],
        async () => {
          const binding = await this.readBinding(scope, projectId, expectedRevision);
          await this.prepareBinding(scope, binding);
          const result = await this.transportCall(
            "Local git diff",
            (signal) => this.transport.diff(binding, signal),
          );
          assertExactKeys(result, ["binding", "textArtifactId", "sha256"], "diff git lokal");
          if (!sameBinding(result.binding, binding)) {
            throw new Error("Diff git lokal berasal dari binding lain.");
          }
          safeText(result.textArtifactId, "git diff artifactId", 512);
          sha(result.sha256, "git diff sha256");
          return { textArtifactId: result.textArtifactId, sha256: result.sha256 };
        },
      )
    );
  }

  async log(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
    limit = 20,
  ): Promise<LocalGitLogEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Limit git log tidak sah.");
    }
    return this.authority.withPermission(scope, "code.read", () =>
      this.projects.withFreshProjectPermissions(
        scope,
        projectId,
        expectedRevision,
        ["code.read"],
        async () => {
          const binding = await this.readBinding(scope, projectId, expectedRevision);
          await this.prepareBinding(scope, binding);
          const result = await this.transportCall(
            "Local git log",
            (signal) => this.transport.log(binding, limit, signal),
          );
          assertExactKeys(result, ["binding", "entries"], "log git lokal");
          if (!sameBinding(result.binding, binding)) {
            throw new Error("Log git lokal berasal dari binding lain.");
          }
          const entries = result.entries;
          if (!Array.isArray(entries) || entries.length > limit) {
            throw new Error("Hasil git log melampaui batas.");
          }
          for (const entry of entries) {
            assertExactKeys(entry, [
              "commit",
              "parentCommit",
              "subject",
              "authoredAt",
              "authorName",
              "authorEmail",
            ], "entry log git lokal");
            commit(entry.commit, "git log commit");
            if (entry.parentCommit !== null) {
              commit(entry.parentCommit, "git log parent");
            }
            safeText(entry.subject, "git log subject", 512);
            safeText(entry.authorName, "git log authorName", 256);
            safeText(entry.authorEmail, "git log authorEmail", 320);
            validIso(entry.authoredAt, "git log authoredAt");
          }
          return structuredClone(entries);
        },
      )
    );
  }

  async commit(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<{ projectRevision: number; receipt: LocalGitCommitResult }> {
    return this.authority.withPermission(scope, "git.commit", () =>
      this.projects.withFreshProjectPermissions(
        scope,
        projectId,
        expectedRevision,
        ["git.commit"],
        () => this.exclusive(projectId, async () => {
      const { binding, request } = await this.commitBinding(
        scope,
        projectId,
        expectedRevision,
      );
      let reconciliation = await this.transportCall(
        "Local git commit reconciliation",
        (signal) => this.transport.reconcileCommit(request, signal),
      );
      validateReconciliation(reconciliation, request.operationId);
      let result = committedResult(reconciliation);
      if (reconciliation.status === "unknown") {
        throw new Error("Hasil local git commit belum diketahui; efek tidak diulang otomatis.");
      }
      if (reconciliation.status === "not_committed") {
        const snapshotHandle = await this.projects.getSnapshotHandle(
          scope,
          binding.projectId,
          binding.workspaceRevision,
        );
        try {
          result = await this.projects.withLocalGitSnapshotSource(
            scope,
            snapshotHandle,
            (snapshotSource) => this.transportCall(
              "Local git commit",
              async (signal) => {
                const transfer = verifiedProjectSnapshotTransfer(
                  snapshotSource,
                  binding.snapshotId,
                  signal,
                );
                const committed = await this.transport.commit(
                  request,
                  transfer.descriptor,
                  transfer.content,
                  signal,
                );
                if (!transfer.completed()) {
                  throw new Error("Local git transport tidak mengonsumsi seluruh snapshot bundle.");
                }
                return committed;
              },
            ),
          );
        } catch {
          reconciliation = await this.transportCall(
            "Local git commit reconciliation",
            (signal) => this.transport.reconcileCommit(request, signal),
          );
          validateReconciliation(reconciliation, request.operationId);
          result = committedResult(reconciliation);
          if (!result) {
            if (reconciliation.status === "not_committed") {
              throw new Error("Local git commit terbukti belum terjadi; retry eksplisit aman.");
            }
            throw new Error("Hasil local git commit belum diketahui; efek tidak diulang otomatis.");
          }
        }
      }
      if (!result) throw new Error("Receipt local git commit tidak tersedia.");
      validateCommitResult(result, binding, request.targetBranch, request.operationId);
      const project = await this.projects.recordLocalGitCommit(
        scope,
        projectId,
        expectedRevision,
        result,
      );
      return { projectRevision: project.revision, receipt: structuredClone(result) };
        }),
      )
    );
  }

  private async readBinding(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<LocalGitBinding> {
    const project = await this.projects.get(scope, projectId);
    if (
      !project ||
      project.revision !== expectedRevision ||
      !project.git
    ) {
      throw new Error(
        "Project git tidak tersedia atau revision sudah basi.",
      );
    }
    return {
      projectId: project.id,
      snapshotId: project.baseSnapshot,
      workspaceRevision: project.revision,
      baseCommit: project.git.baseCommit,
      headCommit: project.git.headCommit,
      branch: project.git.branch,
    };
  }

  private async prepareBinding(
    scope: WorkspaceAgentScope,
    binding: LocalGitBinding,
  ): Promise<void> {
    const snapshotHandle = await this.projects.getSnapshotHandle(
      scope,
      binding.projectId,
      binding.workspaceRevision,
    );
    await this.projects.withLocalGitSnapshotSource(
      scope,
      snapshotHandle,
      (snapshotSource) => this.transportCall(
        "Local git prepare",
        async (signal) => {
          const transfer = verifiedProjectSnapshotTransfer(
            snapshotSource,
            binding.snapshotId,
            signal,
          );
          const prepared = await this.transport.prepare(
            binding,
            transfer.descriptor,
            transfer.content,
            signal,
          );
          if (!transfer.completed()) {
            throw new Error("Local git transport tidak mengonsumsi seluruh prepare snapshot.");
          }
          if (!sameBinding(prepared.binding, binding)) {
            throw new Error("Local git prepare berasal dari binding lain.");
          }
        },
      ),
    );
  }

  private async commitBinding(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedRevision: number,
  ): Promise<{ binding: LocalGitBinding; request: LocalGitCommitRequest }> {
    const binding = await this.readBinding(scope, projectId, expectedRevision);
    const project = await this.projects.get(scope, projectId);
    const pending = project?.pendingGitCommit;
    const request = createLocalGitCommitRequest(binding);
    if (
      !project ||
      project.revision !== expectedRevision ||
      !pending ||
      pending.snapshotId !== binding.snapshotId ||
      pending.sourceRevision !== binding.workspaceRevision ||
      pending.baseCommit !== binding.baseCommit ||
      pending.parentCommit !== binding.headCommit ||
      pending.operationId !== request.operationId ||
      pending.targetBranch !== request.targetBranch ||
      pending.message !== request.message
    ) {
      throw new Error("Project tidak mempunyai exact pending local git effect.");
    }
    return { binding, request };
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

  private transportCall<T>(
    operation: string,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return callTransportWithDeadline(operation, this.transportTimeoutMs, call);
  }
}

function boundedTransportTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new Error("Timeout LocalGit transport tidak sah.");
  }
  return value;
}

function validateCommitResult(
  result: LocalGitCommitResult,
  binding: LocalGitBinding,
  branch: string,
  operationId: string,
): void {
  assertExactKeys(result, [
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
  ], "receipt local git");
  if (
    result.projectId !== binding.projectId ||
    result.operationId !== operationId ||
    result.snapshotId !== binding.snapshotId ||
    result.sourceWorkspaceRevision !== binding.workspaceRevision ||
    result.branch !== branch ||
    result.parentCommit !== binding.headCommit ||
    result.commit === result.parentCommit ||
    result.authorName !== "Harvy Bot" ||
    result.authorEmail !== "bot@harvy.local"
  ) throw new Error("Receipt local git tidak cocok dengan exact snapshot/binding.");
  commit(result.commit, "local git commit");
  commit(result.parentCommit, "local git parent");
  commit(result.treeHash, "local git tree");
  const bundle = validateLocalGitObjectBundleReference(result.objectBundle);
  if (
    bundle.commit !== result.commit ||
    bundle.parentCommit !== result.parentCommit ||
    bundle.treeHash !== result.treeHash
  ) throw new Error("Object bundle local git tidak mengikat exact commit receipt.");
  validIso(result.committedAt, "local git committedAt");
}

function sameBinding(left: LocalGitBinding, right: LocalGitBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function committedResult(
  result: LocalGitCommitReconciliation,
): LocalGitCommitResult | null {
  return result.status === "committed" ? result.receipt : null;
}

function validateReconciliation(
  input: unknown,
  operationId: string,
): asserts input is LocalGitCommitReconciliation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Rekonsiliasi local git tidak mengikat exact operation fence.");
  }
  const result = input as Partial<LocalGitCommitReconciliation>;
  if (
    result.status !== "committed" &&
    result.status !== "not_committed" &&
    result.status !== "unknown"
  ) {
    throw new Error("Status rekonsiliasi local git tidak sah.");
  }
  const expectedKeys = result.status === "committed"
    ? ["operationId", "status", "operationFenced", "receipt"]
    : ["operationId", "status", "operationFenced"];
  if (
    JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys.sort()) ||
    result.operationId !== operationId ||
    (result.status === "unknown" && result.operationFenced !== false) ||
    (result.status !== "unknown" && result.operationFenced !== true)
  ) {
    throw new Error("Rekonsiliasi local git tidak mengikat exact operation fence.");
  }
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
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) throw new Error(`Schema ${label} memuat field asing atau hilang.`);
}

function verifiedProjectSnapshotTransfer(
  source: ProjectSnapshotBundleSource,
  expectedSnapshotId: string,
  signal: AbortSignal,
): {
  descriptor: ProjectSnapshotBundleDescriptor;
  content: AsyncIterable<Uint8Array>;
  completed: () => boolean;
} {
  assertExactKeys(source, ["descriptor", "open"], "source snapshot local git");
  if (typeof source.open !== "function") {
    throw new Error("Source snapshot local git tidak dapat dibuka.");
  }
  const descriptor = structuredClone(source.descriptor);
  assertExactKeys(descriptor, [
    "version",
    "snapshotId",
    "bundleSha256",
    "manifestSha256",
    "size",
    "fileCount",
    "mediaType",
  ], "descriptor snapshot local git");
  if (
    descriptor.version !== 1 ||
    descriptor.snapshotId !== expectedSnapshotId ||
    !/^[a-f0-9]{64}$/u.test(descriptor.bundleSha256) ||
    !/^[a-f0-9]{64}$/u.test(descriptor.manifestSha256) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size > 2 * 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(descriptor.fileCount) ||
    descriptor.fileCount < 0 ||
    descriptor.fileCount > 10_000 ||
    descriptor.mediaType !== "application/vnd.harvy.snapshot-bundle.v1"
  ) throw new Error("Descriptor snapshot local git tidak sah atau tidak fresh.");

  let opened = false;
  let complete = false;
  const content = (async function* (): AsyncGenerator<Uint8Array> {
    if (opened) throw new Error("Snapshot bundle local git hanya boleh dibuka sekali.");
    opened = true;
    const iterable = source.open();
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      throw new Error("Source snapshot local git bukan async iterable.");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of iterable) {
      if (signal.aborted) throw abortError();
      if (!(value instanceof Uint8Array) || value.byteLength < 1) {
        throw new Error("Chunk snapshot local git tidak sah.");
      }
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > descriptor.size) {
        throw new Error("Snapshot bundle local git melampaui descriptor size.");
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.bundleSha256) {
      throw new Error("Byte snapshot local git tidak cocok descriptor content-addressed.");
    }
    complete = true;
  })();
  return { descriptor: Object.freeze(descriptor), content, completed: () => complete };
}

function abortError(): Error {
  const error = new Error("Transfer snapshot local git dibatalkan.");
  error.name = "AbortError";
  return error;
}

function commit(value: string, field: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field} tidak sah.`);
  }
}

function sha(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${field} tidak sah.`);
}

function safeText(value: string, field: string, max: number): string {
  if (!value || value.length > max || containsSecretLikeValue(value) ||
    /\p{Cc}/u.test(value.replace(/[\r\n\t]/gu, ""))) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}

function validIso(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} tidak sah.`);
  }
}
