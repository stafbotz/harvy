import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ProjectSnapshotFile,
  ProjectSnapshotManifest,
} from "../domain/project-workspace.js";

export interface ProjectTreeLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxDepth: number;
  maxPathCharacters: number;
}

export const DEFAULT_PROJECT_TREE_LIMITS: Readonly<ProjectTreeLimits> =
  Object.freeze({
    maxFiles: 10_000,
    maxTotalBytes: 512 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    maxDepth: 32,
    maxPathCharacters: 240,
  });

const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const VCS_CONTROL_SEGMENTS = new Set([".git", ".hg", ".svn"]);

/**
 * Resolve a model/user supplied project path without ever following it outside
 * the selected project root. Existing symlinks are rejected separately by the
 * caller or by scanProjectTree.
 */
export function resolveProjectPath(root: string, projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...canonical.split("/"));
  assertPathInside(absoluteRoot, candidate);
  return candidate;
}

export function canonicalProjectPath(value: string): string {
  if (typeof value !== "string") throw new Error("Path project tidak sah.");
  const normalized = value.normalize("NFC");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    /\p{Cc}/u.test(normalized) ||
    isAbsolute(normalized) ||
    /^[a-z]:/iu.test(normalized)
  ) {
    throw new Error("Path project tidak sah.");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        segment.includes(":"),
    )
  ) {
    throw new Error("Path project tidak sah.");
  }
  for (const segment of segments) {
    if (WINDOWS_RESERVED_BASENAMES.test(segment)) {
      throw new Error("Path project memakai nama perangkat terlarang.");
    }
    if (VCS_CONTROL_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error("Metadata version-control tidak boleh masuk snapshot project.");
    }
  }
  return segments.join("/");
}

export async function scanProjectTree(
  root: string,
  options: {
    limits?: Partial<ProjectTreeLimits>;
    now?: () => Date;
    /**
     * Windows cannot faithfully materialize the POSIX executable bit carried
     * by a Git tree. Trusted snapshot metadata may supply that bit while this
     * scanner still verifies every path, byte count, and content digest.
     */
    executableOverrides?: ReadonlyMap<string, boolean>;
  } = {},
): Promise<ProjectSnapshotManifest> {
  const limits = resolveTreeLimits(options.limits);
  const absoluteRoot = resolve(root);
  const rootState = await lstat(absoluteRoot);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error("Root project harus direktori nyata.");
  }

  const files: ProjectSnapshotFile[] = [];
  let totalBytes = 0;
  const collisionKeys = new Set<string>();

  async function walk(directory: string, prefix: string, depth: number) {
    if (depth > limits.maxDepth) {
      throw new Error("Kedalaman direktori project melampaui batas.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = canonicalProjectPath(
        prefix ? `${prefix}/${entry.name}` : entry.name,
      );
      if (path.length > limits.maxPathCharacters) {
        throw new Error("Path project melampaui batas panjang.");
      }
      const collisionKey = path.toLocaleLowerCase("en-US");
      if (collisionKeys.has(collisionKey)) {
        throw new Error("Project memuat path yang bertabrakan.");
      }
      collisionKeys.add(collisionKey);
      const absolute = resolveProjectPath(absoluteRoot, path);
      const state = await lstat(absolute);
      if (state.isSymbolicLink()) {
        throw new Error("Symlink tidak diizinkan dalam snapshot project.");
      }
      if (state.isDirectory()) {
        await walk(absolute, path, depth + 1);
        continue;
      }
      if (!state.isFile()) {
        throw new Error("Snapshot project hanya boleh memuat file biasa.");
      }
      if (state.size > limits.maxFileBytes) {
        throw new Error("Satu file project melampaui batas ukuran.");
      }
      if (files.length >= limits.maxFiles) {
        throw new Error("Jumlah file project melampaui batas.");
      }
      totalBytes += state.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error("Ukuran project terurai melampaui batas.");
      }
      const verified = await readVerifiedRegularFile(
        absoluteRoot,
        absolute,
        limits.maxFileBytes,
      );
      const bytes = verified.bytes;
      if (bytes.length !== state.size) {
        throw new Error("File project berubah selama scan.");
      }
      const hasExecutableOverride = options.executableOverrides?.has(path) === true;
      const executableOverride = hasExecutableOverride
        ? options.executableOverrides?.get(path)
        : undefined;
      if (hasExecutableOverride && typeof executableOverride !== "boolean") {
        throw new Error("Metadata executable snapshot project tidak sah.");
      }
      files.push({
        path,
        size: state.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: executableOverride ?? (state.mode & 0o111) !== 0,
      });
    }
  }

  await walk(absoluteRoot, "", 0);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const snapshotId = createHash("sha256")
    .update(
      files
        .map(
          (file) =>
            `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? "x" : "-"}\n`,
        )
        .join(""),
      "utf8",
    )
    .digest("hex");
  return {
    version: 1,
    snapshotId,
    files,
    totalBytes,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

/** Copy a previously scanned tree without following symlinks. */
export async function copyProjectTree(
  sourceRoot: string,
  destinationRoot: string,
  limits?: Partial<ProjectTreeLimits>,
  executableOverrides?: ReadonlyMap<string, boolean>,
): Promise<ProjectSnapshotManifest> {
  const source = resolve(sourceRoot);
  const destination = resolve(destinationRoot);
  if (source === destination) throw new Error("Source dan tujuan project sama.");
  assertPathNotInside(source, destination);
  const manifest = await scanProjectTree(source, {
    ...(limits ? { limits } : {}),
    ...(executableOverrides ? { executableOverrides } : {}),
  });
  await mkdir(destination, { recursive: false });
  for (const file of manifest.files) {
    const from = resolveProjectPath(source, file.path);
    const to = resolveProjectPath(destination, file.path);
    await mkdir(dirname(to), { recursive: true });
    const verified = await readVerifiedRegularFile(source, from, limits?.maxFileBytes ??
      DEFAULT_PROJECT_TREE_LIMITS.maxFileBytes);
    if (
      verified.bytes.length !== file.size ||
      createHash("sha256").update(verified.bytes).digest("hex") !== file.sha256
    ) {
      throw new Error("Source project berubah selama copy snapshot.");
    }
    const handle = await open(to, "wx", file.executable ? 0o700 : 0o600);
    try {
      await handle.writeFile(verified.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(to, file.executable ? 0o700 : 0o600);
  }
  return scanProjectTree(destination, {
    ...(limits ? { limits } : {}),
    ...(executableOverrides ? { executableOverrides } : {}),
  });
}

async function readVerifiedRegularFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Buffer }> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const named = await lstat(path);
    if (
      !opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
      opened.dev !== named.dev || opened.ino !== named.ino ||
      opened.nlink !== 1 || named.nlink !== 1 ||
      opened.size > maxBytes
    ) {
      throw new Error("File project bukan file biasa stabil di dalam root.");
    }
    const resolved = await realpath(path);
    assertPathInside(root, resolved);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || bytes.length !== after.size ||
      bytes.length > maxBytes
    ) {
      throw new Error("File project berubah selama pembacaan descriptor.");
    }
    return { bytes };
  } finally {
    await handle.close();
  }
}

export function assertPathInside(root: string, candidate: string): void {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const pathFromRoot = relative(absoluteRoot, absoluteCandidate);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Path harus berada di dalam root terkelola.");
  }
}

function assertPathNotInside(root: string, candidate: string): void {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  if (
    !pathFromRoot ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  ) {
    throw new Error("Tujuan copy tidak boleh berada di dalam source project.");
  }
}

function resolveTreeLimits(
  input: Partial<ProjectTreeLimits> | undefined,
): ProjectTreeLimits {
  const limits = { ...DEFAULT_PROJECT_TREE_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Batas project ${name} tidak sah.`);
    }
  }
  if (limits.maxFileBytes > limits.maxTotalBytes) {
    throw new Error("Batas satu file tidak boleh melampaui batas total project.");
  }
  return limits;
}
