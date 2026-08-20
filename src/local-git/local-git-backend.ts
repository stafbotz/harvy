import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  LocalGitBinding,
  LocalGitCommitReconciliation,
  LocalGitCommitRequest,
  LocalGitCommitResult,
  LocalGitHealth,
  LocalGitLogEntry,
  LocalGitObjectBundleReference,
  LocalGitStatus,
} from "../domain/local-git.js";
import {
  LOCAL_GIT_EMPTY_TREE,
  LOCAL_GIT_UPLOAD_ROOT_COMMIT,
  LOCAL_GIT_UPLOAD_ROOT_CONTENT,
  validateLocalGitObjectBundleReference,
} from "../domain/local-git.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import { extractProjectSnapshotBundle } from "../sandbox/snapshot-bundle-codec.js";
import {
  SpawnOciCommandRunner,
  type OciCommandResult,
  type OciCommandRunner,
} from "../sandbox/oci-command-runner.js";

const MAX_GIT_OUTPUT_BYTES = 128 * 1_024 * 1_024;
const ZERO_GIT_HASH = "0".repeat(40);
const FORBIDDEN_ENV = new Set([
  "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_APP_PRIVATE_KEY", "OPENAI_API_KEY",
  "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN", "DATABASE_URL", "WHATSAPP_SESSION",
]);

interface LocalGitSnapshotRecord {
  snapshotId: string;
  treeHash: string;
  workspaceRevision: number;
}

interface LocalGitProjectRecord {
  version: 1;
  projectId: string;
  baseSnapshotId: string;
  baseCommit: string;
  latestBinding: LocalGitBinding;
  snapshots: LocalGitSnapshotRecord[];
  commits: LocalGitCommitResult[];
  createdAt: string;
  updatedAt: string;
}

interface LocalGitOperationRecord {
  version: 1;
  operationId: string;
  request: LocalGitCommitRequest;
  committedAt: string;
  status: "preparing" | "committed";
  receipt: LocalGitCommitResult | null;
  updatedAt: string;
}

export interface LocalGitBackendOptions {
  dataRoot: string;
  gitCommand?: string;
  commandEnvironment: Readonly<Record<string, string>>;
  runner?: OciCommandRunner;
  now?: () => Date;
  serviceEnvironment?: Readonly<Record<string, string | undefined>>;
}

/** Credentialless git/object-store implementation for a separate service. */
export class LocalGitBackend {
  readonly #dataRoot: string;
  readonly #projectsRoot: string;
  readonly #operationsRoot: string;
  readonly #gitCommand: string;
  readonly #commandEnvironment: Readonly<Record<string, string>>;
  readonly #runner: OciCommandRunner;
  readonly #now: () => Date;
  readonly #serviceEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #queues = new Map<string, Promise<void>>();
  #initialized = false;

  constructor(options: LocalGitBackendOptions) {
    this.#dataRoot = absolutePath(options.dataRoot, "local git dataRoot");
    this.#projectsRoot = join(this.#dataRoot, "projects");
    this.#operationsRoot = join(this.#dataRoot, "operations");
    this.#gitCommand = safeExecutable(options.gitCommand ?? "git");
    this.#commandEnvironment = gitEnvironment(options.commandEnvironment);
    this.#runner = options.runner ?? new SpawnOciCommandRunner();
    this.#now = options.now ?? (() => new Date());
    this.#serviceEnvironment = options.serviceEnvironment ?? process.env;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#projectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 });
    await assertDirectory(this.#dataRoot);
    this.#initialized = true;
  }

  async health(): Promise<LocalGitHealth> {
    const checkedAt = this.#now().toISOString();
    try {
      if (!this.#initialized) throw new Error("backend belum diinisialisasi");
      for (const name of FORBIDDEN_ENV) {
        if (this.#serviceEnvironment[name]) throw new Error("credential remote terlarang");
      }
      const version = await this.#git(["--version"], 10_000);
      if (version.exitCode !== 0 || !/^git version 2\./u.test(version.stdout.toString("utf8").trim())) {
        throw new Error("git executable tidak sehat");
      }
      return {
        available: true,
        protocol: "harvy-local-git/1",
        checkedAt,
        reason: null,
      };
    } catch {
      return {
        available: false,
        protocol: null,
        checkedAt,
        reason: "Credentialless local git service belum memenuhi conformance.",
      };
    }
  }

  async prepare(
    binding: LocalGitBinding,
    snapshot: ProjectSnapshotBundleDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ binding: LocalGitBinding }> {
    return this.#exclusive(binding.projectId, async () => {
      await this.#assertHealthy();
      const projectRoot = this.#projectRoot(binding.projectId);
      await mkdir(projectRoot, { recursive: true, mode: 0o700 });
      await this.#ensureRepository(projectRoot, signal);
      const existing = await this.#readProject(binding.projectId);
      if (existing && (
        existing.projectId !== binding.projectId ||
        existing.baseCommit !== binding.baseCommit ||
        existing.latestBinding.baseCommit !== binding.baseCommit
      )) throw new Error("Base binding local git berubah tanpa provisioning baru.");
      const known = existing?.snapshots.find((item) => item.snapshotId === snapshot.snapshotId);
      let treeHash = known?.treeHash ?? null;
      if (known) {
        await drainAndVerify(content, snapshot, signal);
      } else {
        const snapshotRoot = this.#snapshotRoot(binding.projectId, snapshot.snapshotId);
        const bundlePath = `${snapshotRoot}.bundle`;
        await rm(snapshotRoot, { recursive: true, force: true });
        await mkdir(dirname(snapshotRoot), { recursive: true, mode: 0o700 });
        await writeSnapshot(bundlePath, content, snapshot, signal);
        await extractProjectSnapshotBundle(bundlePath, snapshotRoot, snapshot, {
          maxExtractedBytes: 2 * 1_024 * 1_024 * 1_024,
        });
        await rm(bundlePath, { force: true });
        treeHash = await this.#writeTree(projectRoot, snapshotRoot, snapshot.snapshotId, signal);
      }
      const now = this.#now().toISOString();
      const next: LocalGitProjectRecord = existing
        ? {
            ...existing,
            latestBinding: structuredClone(binding),
            snapshots: known
              ? existing.snapshots
              : [...existing.snapshots, {
                  snapshotId: snapshot.snapshotId,
                  treeHash: treeHash!,
                  workspaceRevision: binding.workspaceRevision,
                }],
            updatedAt: now,
          }
        : {
            version: 1,
            projectId: binding.projectId,
            baseSnapshotId: snapshot.snapshotId,
            baseCommit: binding.baseCommit,
            latestBinding: structuredClone(binding),
            snapshots: [{
              snapshotId: snapshot.snapshotId,
              treeHash: treeHash!,
              workspaceRevision: binding.workspaceRevision,
            }],
            commits: [],
            createdAt: now,
            updatedAt: now,
          };
      await this.#writeProject(next);
      return { binding: structuredClone(binding) };
    });
  }

  async status(binding: LocalGitBinding): Promise<LocalGitStatus> {
    const project = await this.#requirePrepared(binding);
    const changedPaths = await this.#changedPaths(project);
    return {
      binding: structuredClone(binding),
      changedPaths,
      clean: changedPaths.length === 0,
    };
  }

  async diff(binding: LocalGitBinding): Promise<{
    binding: LocalGitBinding;
    textArtifactId: string;
    sha256: string;
  }> {
    const project = await this.#requirePrepared(binding);
    const base = snapshotRecord(project, project.baseSnapshotId);
    const current = snapshotRecord(project, binding.snapshotId);
    const result = await this.#gitInProject(project.projectId, [
      "diff", "--no-ext-diff", "--no-color", "--binary", base.treeHash, current.treeHash, "--",
    ], 60_000, MAX_GIT_OUTPUT_BYTES);
    if (result.exitCode !== 0) throw new Error("git diff local service gagal.");
    const sha256 = createHash("sha256").update(result.stdout).digest("hex");
    const textArtifactId = `local-git-diff-${sha256}`;
    await atomicBytes(join(this.#projectRoot(project.projectId), "diffs", `${textArtifactId}.patch`), result.stdout);
    return { binding: structuredClone(binding), textArtifactId, sha256 };
  }

  async log(binding: LocalGitBinding, limit: number): Promise<{
    binding: LocalGitBinding;
    entries: LocalGitLogEntry[];
  }> {
    const project = await this.#requirePrepared(binding);
    const entries = project.commits.slice(-limit).reverse().map((receipt, index) => ({
      commit: receipt.commit,
      parentCommit: receipt.parentCommit,
      subject: index === 0 ? commitMessageFor(project, receipt.operationId) :
        `Harvy coding update ${receipt.snapshotId.slice(0, 12)}`,
      authoredAt: receipt.committedAt,
      authorName: receipt.authorName,
      authorEmail: receipt.authorEmail,
    }));
    for (const entry of entries) {
      const verified = await this.#gitInProject(project.projectId, [
        "cat-file", "-t", entry.commit,
      ], 10_000);
      if (verified.exitCode !== 0 || verified.stdout.toString("utf8").trim() !== "commit") {
        throw new Error("Object commit local git tidak dapat diverifikasi.");
      }
    }
    return { binding: structuredClone(binding), entries };
  }

  async reconcileCommit(request: LocalGitCommitRequest): Promise<LocalGitCommitReconciliation> {
    return this.#exclusive(request.binding.projectId, async () => {
      const operation = await this.#readOperation(request.operationId);
      if (!operation) {
        return {
          operationId: request.operationId,
          status: "not_committed",
          operationFenced: true,
        };
      }
      if (JSON.stringify(operation.request) !== JSON.stringify(request)) {
        throw new Error("Operation local git dipakai ulang untuk request berbeda.");
      }
      if (operation.status === "committed" && operation.receipt) {
        return {
          operationId: request.operationId,
          status: "committed",
          operationFenced: true,
          receipt: structuredClone(operation.receipt),
        };
      }
      const recovered = await this.#recoverPreparedOperation(operation);
      if (recovered) {
        return {
          operationId: request.operationId,
          status: "committed",
          operationFenced: true,
          receipt: recovered,
        };
      }
      return {
        operationId: request.operationId,
        status: "unknown",
        operationFenced: false,
      };
    });
  }

  async commit(
    request: LocalGitCommitRequest,
    snapshot: ProjectSnapshotBundleDescriptor,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitResult> {
    await this.prepare(request.binding, snapshot, content, signal);
    return this.#exclusive(request.binding.projectId, async () => {
      const existing = await this.#readOperation(request.operationId);
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw new Error("Operation local git bertabrakan.");
        }
        if (existing.receipt) return structuredClone(existing.receipt);
      }
      const committedAt = existing?.committedAt ?? this.#now().toISOString();
      const operation: LocalGitOperationRecord = existing ?? {
        version: 1,
        operationId: request.operationId,
        request: structuredClone(request),
        committedAt,
        status: "preparing",
        receipt: null,
        updatedAt: committedAt,
      };
      await this.#writeOperation(operation);
      return this.#commitPrepared(operation, signal);
    });
  }

  async objectBundle(
    referenceInput: LocalGitObjectBundleReference,
  ): Promise<{ reference: LocalGitObjectBundleReference; path: string }> {
    const reference = validateLocalGitObjectBundleReference(referenceInput);
    for (const name of await readdir(this.#operationsRoot)) {
      if (!name.endsWith(".json")) continue;
      const operation = parseOperation(JSON.parse(
        await readFile(join(this.#operationsRoot, name), "utf8"),
      ) as unknown);
      if (operation.receipt?.objectBundle.artifactId === reference.artifactId) {
        if (JSON.stringify(operation.receipt.objectBundle) !== JSON.stringify(reference)) {
          throw new Error("Object bundle reference tidak cocok receipt.");
        }
        const path = this.#bundlePath(operation.request.binding.projectId, reference.sha256);
        const state = await lstat(path);
        if (!state.isFile() || state.size !== reference.size || await fileSha256(path) !== reference.sha256) {
          throw new Error("Object bundle local git rusak atau hilang.");
        }
        return { reference, path };
      }
    }
    throw new Error("Object bundle local git tidak dikenal.");
  }

  async #commitPrepared(
    operation: LocalGitOperationRecord,
    signal?: AbortSignal,
  ): Promise<LocalGitCommitResult> {
    const request = operation.request;
    const project = await this.#requirePrepared(request.binding);
    const snapshot = snapshotRecord(project, request.binding.snapshotId);
    const epoch = Math.floor(Date.parse(operation.committedAt) / 1_000);
    const content = [
      `tree ${snapshot.treeHash}`,
      `parent ${request.binding.headCommit}`,
      `author ${request.author.name} <${request.author.email}> ${epoch} +0000`,
      `committer ${request.author.name} <${request.author.email}> ${epoch} +0000`,
      "",
      request.message,
      "",
    ].join("\n");
    const commitInput = join(this.#projectRoot(project.projectId), "operations", `${request.operationId}.commit`);
    await atomicBytes(commitInput, Buffer.from(content, "utf8"));
    const hashed = await this.#gitInProject(project.projectId, [
      "hash-object", "-t", "commit", "-w", "--stdin",
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal, commitInput);
    assertGitSuccess(hashed, "git hash-object commit");
    const commit = gitHash(hashed.stdout.toString("utf8").trim(), "commit local git");
    const object = await this.#gitInProject(project.projectId, ["cat-file", "-p", commit], 10_000);
    assertGitSuccess(object, "git cat-file commit");
    if (object.stdout.toString("utf8") !== content) {
      throw new Error("Object commit local git tidak cocok content exact.");
    }
    await this.#updateBranchRef(
      project.projectId,
      request.targetBranch,
      request.binding.headCommit,
      commit,
      signal,
    );
    const bundle = await this.#buildBundle(
      project,
      request.targetBranch,
      commit,
      snapshot.treeHash,
      request.binding.headCommit,
      signal,
    );
    const receipt: LocalGitCommitResult = {
      operationId: request.operationId,
      projectId: request.binding.projectId,
      snapshotId: request.binding.snapshotId,
      sourceWorkspaceRevision: request.binding.workspaceRevision,
      branch: request.targetBranch,
      parentCommit: request.binding.headCommit,
      commit,
      treeHash: snapshot.treeHash,
      objectBundle: bundle,
      authorName: "Harvy Bot",
      authorEmail: "bot@harvy.local",
      committedAt: operation.committedAt,
    };
    const nextProject: LocalGitProjectRecord = {
      ...project,
      latestBinding: {
        ...project.latestBinding,
        headCommit: commit,
        branch: request.targetBranch,
      },
      commits: project.commits.some((item) => item.operationId === receipt.operationId)
        ? project.commits
        : [...project.commits, receipt],
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeProject(nextProject);
    await this.#writeOperation({
      ...operation,
      status: "committed",
      receipt,
      updatedAt: this.#now().toISOString(),
    });
    return structuredClone(receipt);
  }

  async #recoverPreparedOperation(
    operation: LocalGitOperationRecord,
  ): Promise<LocalGitCommitResult | null> {
    try {
      return await this.#commitPrepared(operation);
    } catch {
      return null;
    }
  }

  async #updateBranchRef(
    projectId: string,
    branch: string,
    expectedParent: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const observed = await this.#gitInProject(projectId, [
      "rev-parse", "--verify", "--quiet", ref,
    ], 10_000, MAX_GIT_OUTPUT_BYTES, signal);
    let expectedOld = ZERO_GIT_HASH;
    if (observed.exitCode === 0 && !observed.timedOut && !observed.aborted &&
      !observed.outputExceeded) {
      const current = gitHash(
        observed.stdout.toString("utf8").trim(),
        "head branch local git",
      );
      if (current === commit) return;
      if (current !== expectedParent) {
        throw new Error("Branch local git berubah sebelum exact commit.");
      }
      expectedOld = current;
    } else if (
      observed.exitCode !== 1 || observed.timedOut || observed.aborted ||
      observed.outputExceeded
    ) {
      throw new Error("Head branch local git tidak dapat diverifikasi.");
    }
    const updated = await this.#gitInProject(projectId, [
      "update-ref", ref, commit, expectedOld,
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal);
    assertGitSuccess(updated, "git update-ref branch exact");
  }

  async #buildBundle(
    project: LocalGitProjectRecord,
    branch: string,
    commit: string,
    treeHash: string,
    parentCommit: string,
    signal?: AbortSignal,
  ): Promise<LocalGitObjectBundleReference> {
    const root = this.#projectRoot(project.projectId);
    const bundleRoot = join(root, "bundles");
    await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
    const listed = await this.#gitInProject(project.projectId, [
      "ls-tree", "-r", "-t", treeHash,
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal);
    assertGitSuccess(listed, "git ls-tree bundle");
    const objects = new Set<string>([commit, treeHash]);
    for (const line of listed.stdout.toString("utf8").split(/\r?\n/gu)) {
      if (!line) continue;
      const match = /^\d{6} (?:blob|tree) ([a-f0-9]{40})\t/u.exec(line);
      if (!match) throw new Error("Output git ls-tree bundle tidak sah.");
      objects.add(match[1]!);
    }
    const uploadRoot = parentCommit === LOCAL_GIT_UPLOAD_ROOT_COMMIT;
    if (uploadRoot) {
      objects.add(LOCAL_GIT_UPLOAD_ROOT_COMMIT);
      objects.add(LOCAL_GIT_EMPTY_TREE);
    }
    const objectList = join(bundleRoot, `${commit}.objects`);
    await atomicBytes(objectList, Buffer.from(`${[...objects].join("\n")}\n`, "ascii"));
    const packPrefix = join(bundleRoot, `${commit}.pack`);
    const packed = await this.#gitInProject(project.projectId, [
      "pack-objects", packPrefix,
    ], 120_000, MAX_GIT_OUTPUT_BYTES, signal, objectList);
    assertGitSuccess(packed, "git pack-objects bundle");
    const packHash = gitHash(packed.stdout.toString("utf8").trim(), "pack hash");
    const packPath = `${packPrefix}-${packHash}.pack`;
    const packState = await lstat(packPath);
    if (!packState.isFile() || packState.size < 12) throw new Error("Pack object local git tidak sah.");
    const verified = await this.#gitInProject(project.projectId, [
      "index-pack", "--verify", packPath,
    ], 120_000, MAX_GIT_OUTPUT_BYTES, signal);
    assertGitSuccess(verified, "git index-pack verify");
    const header = Buffer.from(
      "# v2 git bundle\n" +
      (uploadRoot ? "" : `-${parentCommit} parent\n`) +
      `${commit} refs/heads/${branch}\n\n`,
      "ascii",
    );
    const temporaryBundle = join(bundleRoot, `${commit}.bundle.tmp`);
    const handle = await open(temporaryBundle, "w", 0o600);
    let position = 0;
    try {
      await handle.write(header, 0, header.byteLength, position);
      position += header.byteLength;
      for await (const value of createReadStream(packPath)) {
        const chunk = Buffer.from(value as Buffer);
        await handle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = await fileSha256(temporaryBundle);
    const finalPath = this.#bundlePath(project.projectId, sha256);
    await rename(temporaryBundle, finalPath).catch(async (error: unknown) => {
      if (errorCode(error) === "EEXIST") await rm(temporaryBundle, { force: true });
      else throw error;
    });
    const heads = await this.#gitInProject(project.projectId, [
      "bundle", "list-heads", finalPath,
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal);
    assertGitSuccess(heads, "git bundle list-heads");
    if (heads.stdout.toString("utf8").trim() !== `${commit} refs/heads/${branch}`) {
      throw new Error("Head git bundle tidak cocok exact commit.");
    }
    const size = (await stat(finalPath)).size;
    return validateLocalGitObjectBundleReference({
      version: 1,
      artifactId: `git-bundle-${sha256}`,
      sha256,
      size,
      mediaType: "application/vnd.git.bundle",
      commit,
      parentCommit,
      treeHash,
    });
  }

  async #changedPaths(project: LocalGitProjectRecord): Promise<string[]> {
    const base = snapshotRecord(project, project.baseSnapshotId);
    const current = snapshotRecord(project, project.latestBinding.snapshotId);
    if (base.treeHash === current.treeHash) return [];
    const result = await this.#gitInProject(project.projectId, [
      "diff-tree", "--no-commit-id", "--name-only", "-r", base.treeHash, current.treeHash,
    ], 30_000, MAX_GIT_OUTPUT_BYTES);
    assertGitSuccess(result, "git diff-tree status");
    return result.stdout.toString("utf8").split(/\r?\n/gu).filter(Boolean).sort();
  }

  async #writeTree(
    projectRoot: string,
    snapshotRoot: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const repository = join(projectRoot, "repo.git");
    const index = join(projectRoot, "indexes", `${snapshotId}.index`);
    await mkdir(dirname(index), { recursive: true, mode: 0o700 });
    await rm(index, { force: true });
    const env = { ...this.#commandEnvironment, GIT_INDEX_FILE: index };
    const readTree = await this.#runGit([
      `--git-dir=${repository}`, `--work-tree=${snapshotRoot}`, "read-tree", "--empty",
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal, undefined, env);
    assertGitSuccess(readTree, "git read-tree snapshot");
    const add = await this.#runGit([
      `--git-dir=${repository}`, `--work-tree=${snapshotRoot}`, "add", "--all", "--", ".",
    ], 120_000, MAX_GIT_OUTPUT_BYTES, signal, undefined, env);
    assertGitSuccess(add, "git add snapshot");
    const tree = await this.#runGit([
      `--git-dir=${repository}`, `--work-tree=${snapshotRoot}`, "write-tree",
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal, undefined, env);
    assertGitSuccess(tree, "git write-tree snapshot");
    return gitHash(tree.stdout.toString("utf8").trim(), "tree snapshot");
  }

  async #ensureRepository(projectRoot: string, signal?: AbortSignal): Promise<void> {
    const repository = join(projectRoot, "repo.git");
    try {
      if ((await lstat(repository)).isDirectory()) return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const initialized = await this.#runGit([
      "init", "--bare", "--object-format=sha1", repository,
    ], 30_000, MAX_GIT_OUTPUT_BYTES, signal);
    assertGitSuccess(initialized, "git init local service");
    const empty = join(projectRoot, "empty");
    await atomicBytes(empty, Buffer.alloc(0));
    const tree = await this.#runGit([
      `--git-dir=${repository}`, "hash-object", "-t", "tree", "-w", "--stdin",
    ], 10_000, MAX_GIT_OUTPUT_BYTES, signal, empty);
    assertGitSuccess(tree, "git empty tree");
    if (tree.stdout.toString("utf8").trim() !== LOCAL_GIT_EMPTY_TREE) {
      throw new Error("Empty tree local git tidak deterministik.");
    }
    const rootContent = join(projectRoot, "upload-root.commit");
    await atomicBytes(rootContent, Buffer.from(LOCAL_GIT_UPLOAD_ROOT_CONTENT, "utf8"));
    const rootCommit = await this.#runGit([
      `--git-dir=${repository}`, "hash-object", "-t", "commit", "-w", "--stdin",
    ], 10_000, MAX_GIT_OUTPUT_BYTES, signal, rootContent);
    assertGitSuccess(rootCommit, "git upload root commit");
    if (rootCommit.stdout.toString("utf8").trim() !== LOCAL_GIT_UPLOAD_ROOT_COMMIT) {
      throw new Error("Upload root commit local git tidak deterministik.");
    }
  }

  async #requirePrepared(binding: LocalGitBinding): Promise<LocalGitProjectRecord> {
    const project = await this.#readProject(binding.projectId);
    if (!project || !project.snapshots.some((item) => item.snapshotId === binding.snapshotId) ||
      project.latestBinding.snapshotId !== binding.snapshotId ||
      project.latestBinding.workspaceRevision !== binding.workspaceRevision ||
      project.latestBinding.baseCommit !== binding.baseCommit ||
      (project.latestBinding.headCommit !== binding.headCommit &&
        !project.commits.some((item) => item.commit === binding.headCommit) &&
        !project.commits.some((item) =>
          item.parentCommit === binding.headCommit && item.snapshotId === binding.snapshotId
        ))) {
      throw new Error("Binding local git belum diprepare atau sudah basi.");
    }
    return project;
  }

  #gitInProject(
    projectId: string,
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
    signal?: AbortSignal,
    stdinPath?: string,
  ): Promise<OciCommandResult> {
    return this.#runGit([
      `--git-dir=${this.#repositoryPath(projectId)}`,
      ...args,
    ], timeoutMs, maxOutputBytes, signal, stdinPath);
  }

  #git(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
    signal?: AbortSignal,
  ): Promise<OciCommandResult> {
    return this.#runGit(args, timeoutMs, maxOutputBytes, signal);
  }

  #runGit(
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
    stdinPath?: string,
    env: Readonly<Record<string, string>> = this.#commandEnvironment,
  ): Promise<OciCommandResult> {
    return this.#runner.run({
      executable: this.#gitCommand,
      args,
      timeoutMs,
      maxOutputBytes,
      env,
      ...(signal ? { signal } : {}),
      ...(stdinPath ? { stdinPath } : {}),
    });
  }

  #projectRoot(projectId: string): string {
    return join(this.#projectsRoot, createHash("sha256").update(projectId, "utf8").digest("hex"));
  }

  #repositoryPath(projectId: string): string {
    return join(this.#projectRoot(projectId), "repo.git");
  }

  #snapshotRoot(projectId: string, snapshotId: string): string {
    return join(this.#projectRoot(projectId), "snapshots", gitSha256(snapshotId, "snapshotId"));
  }

  #bundlePath(projectId: string, sha256: string): string {
    return join(this.#projectRoot(projectId), "bundles", `git-bundle-${gitSha256(sha256, "bundle sha")}.bundle`);
  }

  #projectRecordPath(projectId: string): string {
    return join(this.#projectRoot(projectId), "project.json");
  }

  async #readProject(projectId: string): Promise<LocalGitProjectRecord | null> {
    try {
      return parseProject(JSON.parse(await readFile(this.#projectRecordPath(projectId), "utf8")) as unknown);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  #writeProject(project: LocalGitProjectRecord): Promise<void> {
    return atomicJson(this.#projectRecordPath(project.projectId), project);
  }

  #operationPath(operationId: string): string {
    if (!/^local-git-[a-f0-9]{64}$/u.test(operationId)) throw new Error("Operation ID local git tidak sah.");
    return join(this.#operationsRoot, `${operationId}.json`);
  }

  async #readOperation(operationId: string): Promise<LocalGitOperationRecord | null> {
    try {
      return parseOperation(JSON.parse(await readFile(this.#operationPath(operationId), "utf8")) as unknown);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  #writeOperation(operation: LocalGitOperationRecord): Promise<void> {
    return atomicJson(this.#operationPath(operation.operationId), operation);
  }

  async #assertHealthy(): Promise<void> {
    const health = await this.health();
    if (!health.available) throw new Error(health.reason ?? "Local git backend tidak sehat.");
  }

  async #exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const key = safeText(projectId, "projectId", 512);
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

function parseProject(value: unknown): LocalGitProjectRecord {
  const project = object(value) as Partial<LocalGitProjectRecord>;
  exactKeys(project, [
    "version", "projectId", "baseSnapshotId", "baseCommit", "latestBinding",
    "snapshots", "commits", "createdAt", "updatedAt",
  ], "project local git");
  if (project.version !== 1 || typeof project.projectId !== "string" ||
    typeof project.baseSnapshotId !== "string" || !/^[a-f0-9]{64}$/u.test(project.baseSnapshotId) ||
    typeof project.baseCommit !== "string" || !/^[a-f0-9]{40}$/u.test(project.baseCommit) ||
    !Array.isArray(project.snapshots) || !Array.isArray(project.commits) ||
    !validIso(project.createdAt) || !validIso(project.updatedAt)) {
    throw new Error("Record project local git tidak sah.");
  }
  return structuredClone(project as LocalGitProjectRecord);
}

function parseOperation(value: unknown): LocalGitOperationRecord {
  const operation = object(value) as Partial<LocalGitOperationRecord>;
  exactKeys(operation, [
    "version", "operationId", "request", "committedAt", "status", "receipt", "updatedAt",
  ], "operation local git");
  if (operation.version !== 1 || typeof operation.operationId !== "string" ||
    !/^local-git-[a-f0-9]{64}$/u.test(operation.operationId) ||
    (operation.status !== "preparing" && operation.status !== "committed") ||
    !validIso(operation.committedAt) || !validIso(operation.updatedAt) ||
    (operation.status === "committed" && !operation.receipt)) {
    throw new Error("Record operation local git tidak sah.");
  }
  return structuredClone(operation as LocalGitOperationRecord);
}

function snapshotRecord(project: LocalGitProjectRecord, snapshotId: string): LocalGitSnapshotRecord {
  const found = project.snapshots.find((item) => item.snapshotId === snapshotId);
  if (!found) throw new Error("Snapshot local git belum diprepare.");
  return found;
}

function commitMessageFor(project: LocalGitProjectRecord, operationId: string): string {
  const receipt = project.commits.find((item) => item.operationId === operationId);
  return receipt ? `Harvy coding update ${receipt.snapshotId.slice(0, 12)}` : "Harvy coding update";
}

async function writeSnapshot(
  path: string,
  content: AsyncIterable<Uint8Array>,
  descriptor: ProjectSnapshotBundleDescriptor,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const value of content) {
      if (signal?.aborted) throw abortError();
      if (!(value instanceof Uint8Array) || value.byteLength < 1) throw new Error("Chunk snapshot local git tidak sah.");
      size += value.byteLength;
      if (size > descriptor.size) throw new Error("Snapshot local git melampaui descriptor.");
      hash.update(value);
      await handle.write(value, 0, value.byteLength, size - value.byteLength);
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.bundleSha256) {
      throw new Error("Snapshot local git tidak cocok descriptor.");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function drainAndVerify(
  content: AsyncIterable<Uint8Array>,
  descriptor: ProjectSnapshotBundleDescriptor,
  signal?: AbortSignal,
): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const value of content) {
    if (signal?.aborted) throw abortError();
    size += value.byteLength;
    if (size > descriptor.size) throw new Error("Snapshot replay local git melampaui descriptor.");
    hash.update(value);
  }
  if (size !== descriptor.size || hash.digest("hex") !== descriptor.bundleSha256) {
    throw new Error("Snapshot replay local git tidak cocok descriptor.");
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicBytes(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const value of createReadStream(path)) hash.update(value as Buffer);
  return hash.digest("hex");
}

function gitEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const output: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const [key, item] of Object.entries(value)) {
    if ((key !== "PATH" && key !== "HOME" && key !== "TMPDIR") || !item ||
      item.length > 4_096 || item.includes("\0")) {
      throw new Error("Environment local git memuat field terlarang.");
    }
    output[key] = item;
  }
  if (!output.PATH || !output.HOME) throw new Error("PATH/HOME local git wajib tersedia.");
  return Object.freeze(output);
}

function assertGitSuccess(result: OciCommandResult, label: string): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputExceeded) {
    throw new Error(`${label} gagal tertutup.`);
  }
}

function gitHash(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label} tidak sah.`);
  return value;
}

function gitSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} tidak sah.`);
  return value;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  return resolve(value);
}

function safeExecutable(value: string): string {
  if (!value || value.length > 512 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Executable local git tidak sah.");
  }
  return value;
}

function safeText(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} local git tidak sah.`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Object local git tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

async function assertDirectory(path: string): Promise<void> {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("Data root local git tidak sah.");
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function abortError(): Error {
  const error = new Error("Operasi local git dibatalkan.");
  error.name = "AbortError";
  return error;
}

export function openLocalGitBundle(path: string): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncGenerator<Uint8Array> {
    for await (const value of createReadStream(path)) yield Buffer.from(value as Buffer);
  })();
}
