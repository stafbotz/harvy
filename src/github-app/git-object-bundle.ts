import { mkdtemp, mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { GitHubExactEffect } from "../domain/github.js";
import {
  validateLocalGitObjectBundleReference,
  type LocalGitObjectBundleReference,
} from "../domain/local-git.js";
import { canonicalProjectPath } from "../core/project-files.js";
import {
  SpawnOciCommandRunner,
  type OciCommandRunner,
} from "../sandbox/oci-command-runner.js";

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_TOTAL_BLOB_BYTES = 256 * 1024 * 1024;

export interface GitBundleBlob {
  path: string;
  mode: "100644" | "100755";
  sha: string;
  bytes: Buffer;
}

export interface GitBundleCommit {
  commit: string;
  tree: string;
  parent: string;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  blobs: readonly GitBundleBlob[];
}

export interface GitObjectBundleReaderOptions {
  temporaryRoot: string;
  gitCommand?: string;
  commandEnvironment?: Readonly<Record<string, string>>;
  commandRunner?: OciCommandRunner;
}

/**
 * Parses only the credentialless Git bundle produced by LocalGitBackend. It
 * does not contact a remote and never receives an installation token.
 */
export class GitObjectBundleReader {
  readonly #temporaryRoot: string;
  readonly #gitCommand: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #runner: OciCommandRunner;

  constructor(options: GitObjectBundleReaderOptions) {
    this.#temporaryRoot = resolve(options.temporaryRoot);
    this.#gitCommand = options.gitCommand ?? "git";
    this.#environment = Object.freeze({ ...(options.commandEnvironment ?? {}) });
    this.#runner = options.commandRunner ?? new SpawnOciCommandRunner();
  }

  async initialize(): Promise<void> {
    await mkdir(this.#temporaryRoot, { recursive: true, mode: 0o700 });
    const version = await this.#git(["--version"], 10_000);
    assertSuccess(version, "git bundle reader");
  }

  async read(
    effect: GitHubExactEffect,
    descriptorInput: LocalGitObjectBundleReference,
    bundlePathInput: string,
    signal?: AbortSignal,
  ): Promise<GitBundleCommit> {
    const descriptor = validateLocalGitObjectBundleReference(descriptorInput);
    const bundlePath = resolve(bundlePathInput);
    if (descriptor.size > MAX_BUNDLE_BYTES || descriptor.commit !== effect.commit ||
      descriptor.parentCommit !== effect.baseCommit || !inside(this.#temporaryRoot, bundlePath)) {
      throw new Error("Descriptor/path object bundle GitHub tidak sah.");
    }
    const bundle = await readFile(bundlePath);
    if (bundle.byteLength !== descriptor.size) throw new Error("Object bundle GitHub terpotong.");
    const parsed = parseBundle(bundle, effect, descriptor);
    const work = await mkdtemp(join(this.#temporaryRoot, "read-"));
    try {
      const repository = join(work, "repo.git");
      const packPath = join(work, "objects.pack");
      const initialized = await this.#git(["init", "--bare", "--object-format=sha1", repository], 30_000, signal);
      assertSuccess(initialized, "git init bundle reader");
      await durableBytes(packPath, parsed.pack);
      const indexed = await this.#git([
        `--git-dir=${repository}`, "index-pack", "--stdin",
      ], 120_000, signal, packPath);
      assertSuccess(indexed, "git index-pack bundle reader");
      const commitObject = await this.#git([
        `--git-dir=${repository}`, "cat-file", "-p", effect.commit,
      ], 30_000, signal);
      assertSuccess(commitObject, "git cat-file commit bundle");
      const commit = parseCommit(commitObject.stdout.toString("utf8"), effect, descriptor);
      const listed = await this.#git([
        `--git-dir=${repository}`, "ls-tree", "-r", "-z", commit.tree,
      ], 60_000, signal);
      assertSuccess(listed, "git ls-tree bundle");
      const entries = parseTree(listed.stdout);
      if (entries.length > MAX_FILES) throw new Error("Jumlah file object bundle melampaui batas.");
      const blobs: GitBundleBlob[] = [];
      let total = 0;
      for (const entry of entries) {
        const blob = await this.#git([
          `--git-dir=${repository}`, "cat-file", "blob", entry.sha,
        ], 30_000, signal, undefined, MAX_TOTAL_BLOB_BYTES);
        assertSuccess(blob, "git cat-file blob bundle");
        total += blob.stdout.byteLength;
        if (total > MAX_TOTAL_BLOB_BYTES) throw new Error("Byte blob object bundle melampaui batas.");
        blobs.push({ ...entry, bytes: blob.stdout });
      }
      return Object.freeze({ ...commit, blobs: Object.freeze(blobs) });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  #git(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    stdinPath?: string,
    maxOutputBytes = MAX_GIT_OUTPUT,
  ) {
    return this.#runner.run({
      executable: this.#gitCommand,
      args,
      timeoutMs,
      maxOutputBytes,
      env: this.#environment,
      ...(signal ? { signal } : {}),
      ...(stdinPath ? { stdinPath } : {}),
    });
  }
}

function parseBundle(
  bytes: Buffer,
  effect: GitHubExactEffect,
  descriptor: LocalGitObjectBundleReference,
): { pack: Buffer } {
  const separator = bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (separator < 1 || separator > 64 * 1024) throw new Error("Header Git bundle tidak sah.");
  const header = bytes.subarray(0, separator + 2).toString("ascii");
  const lines = header.slice(0, -2).split("\n");
  if (lines.shift() !== "# v2 git bundle") throw new Error("Versi Git bundle tidak didukung.");
  const references = lines.filter((line) => !line.startsWith("-"));
  const prerequisites = lines.filter((line) => line.startsWith("-"));
  if (references.length !== 1 ||
    references[0] !== `${effect.commit} refs/heads/${effect.branch}` ||
    (prerequisites.length !== 0 &&
      (prerequisites.length !== 1 || prerequisites[0] !== `-${effect.baseCommit} parent`)) ||
    descriptor.commit !== effect.commit || descriptor.parentCommit !== effect.baseCommit) {
    throw new Error("Binding Git bundle tidak cocok exact effect.");
  }
  const pack = bytes.subarray(separator + 2);
  if (pack.byteLength < 12 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("Payload pack Git bundle tidak sah.");
  }
  return { pack };
}

function parseCommit(
  content: string,
  effect: GitHubExactEffect,
  descriptor: LocalGitObjectBundleReference,
): Omit<GitBundleCommit, "blobs"> {
  const separator = content.indexOf("\n\n");
  if (separator < 1) throw new Error("Object commit bundle tidak sah.");
  const headers = content.slice(0, separator).split("\n");
  const messageWithNewline = content.slice(separator + 2);
  const treeLine = headers.filter((line) => line.startsWith("tree "));
  const parentLine = headers.filter((line) => line.startsWith("parent "));
  const authorLine = headers.filter((line) => line.startsWith("author "));
  const committerLine = headers.filter((line) => line.startsWith("committer "));
  if (treeLine.length !== 1 || parentLine.length !== 1 || authorLine.length !== 1 ||
    committerLine.length !== 1 || headers.length !== 4 ||
    treeLine[0] !== `tree ${descriptor.treeHash}` || parentLine[0] !== `parent ${effect.baseCommit}` ||
    !messageWithNewline.endsWith("\n")) {
    throw new Error("Header commit object bundle tidak exact.");
  }
  const author = identity(authorLine[0]!.slice("author ".length));
  const committer = identity(committerLine[0]!.slice("committer ".length));
  if (author.name !== "Harvy Bot" || author.email !== "bot@harvy.local" ||
    committer.name !== author.name || committer.email !== author.email || committer.date !== author.date) {
    throw new Error("Identity commit object bundle tidak code-owned.");
  }
  const message = messageWithNewline.slice(0, -1);
  if (!/^Harvy coding update [a-f0-9]{12}$/u.test(message)) {
    throw new Error("Pesan commit object bundle tidak code-owned.");
  }
  return {
    commit: effect.commit,
    tree: descriptor.treeHash,
    parent: effect.baseCommit,
    message,
    author,
    committer,
  };
}

function identity(input: string): { name: string; email: string; date: string } {
  const match = /^([^<>\r\n]{1,128}) <([^<>\s\r\n]{3,254})> (\d{1,12}) \+0000$/u.exec(input);
  if (!match) throw new Error("Identity commit Git tidak sah.");
  const epoch = Number(match[3]);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Timestamp commit Git tidak sah.");
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(epoch * 1_000).toISOString(),
  };
}

function parseTree(output: Buffer): Array<Omit<GitBundleBlob, "bytes">> {
  const entries: Array<Omit<GitBundleBlob, "bytes">> = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(record);
    if (!match) throw new Error("Tree object bundle memuat type/mode tidak diizinkan.");
    const path = canonicalProjectPath(match[3]!);
    if (entries.some((entry) => entry.path === path)) throw new Error("Path tree object bundle duplikat.");
    entries.push({ path, mode: match[1] as "100644" | "100755", sha: match[2]! });
  }
  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  return entries;
}

async function durableBytes(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function assertSuccess(
  result: { exitCode: number | null; timedOut: boolean; aborted: boolean; outputExceeded: boolean },
  operation: string,
): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputExceeded) {
    throw new Error(`${operation} gagal.`);
  }
}
