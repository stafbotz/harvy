import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import type {
  CodingDiffEntry,
  CodingDiffSummary,
} from "../domain/coding-run.js";
import type {
  ProjectSnapshotHandle,
  ProjectWorkingCopy,
} from "../core/project-workspace-service.js";
import {
  canonicalProjectPath,
  resolveProjectPath,
  scanProjectTree,
} from "../core/project-files.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";

export interface WorkspaceTreeEntry {
  path: string;
  type: "file" | "directory";
  size: number | null;
}

export interface WorkspaceReadResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  sha256: string;
  truncated: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspaceSymbol {
  path: string;
  line: number;
  kind: "class" | "function" | "interface" | "type" | "variable";
  name: string;
}

export interface WorkspaceCollection<T> {
  items: T[];
  truncated: boolean;
}

/** Read-only repository view with the instruction revision bound by code. */
export interface BoundReadOnlyRepositoryTools {
  tree(input?: {
    path?: string;
    maxDepth?: number;
  }): Promise<WorkspaceCollection<WorkspaceTreeEntry>>;
  read(input: {
    path: string;
    startLine?: number;
    endLine?: number;
  }): Promise<WorkspaceReadResult>;
  search(input: {
    query: string;
    path?: string;
    caseSensitive?: boolean;
    extensions?: readonly string[];
  }): Promise<WorkspaceCollection<WorkspaceSearchMatch>>;
  symbols(input?: { query?: string }): Promise<WorkspaceCollection<WorkspaceSymbol>>;
  references(symbol: string): Promise<WorkspaceCollection<WorkspaceSearchMatch>>;
  diff(): Promise<CodingDiffSummary>;
}

export type StructuredPatchOperation =
  | {
      kind: "add";
      path: string;
      content: string;
      executable?: boolean;
    }
  | {
      kind: "update";
      path: string;
      expectedSha256: string;
      content: string;
      executable?: boolean;
    }
  | {
      kind: "delete";
      path: string;
      expectedSha256: string;
    };

export interface RepositoryToolLimits {
  maxTreeEntries: number;
  maxReadBytes: number;
  maxSearchFiles: number;
  maxSearchMatches: number;
  maxPatchOperations: number;
  maxPatchBytes: number;
  maxChangedFiles: number;
  maxChangedBytes: number;
}

const DEFAULT_LIMITS: Readonly<RepositoryToolLimits> = Object.freeze({
  maxTreeEntries: 2_000,
  maxReadBytes: 256 * 1024,
  maxSearchFiles: 5_000,
  maxSearchMatches: 200,
  maxPatchOperations: 64,
  maxPatchBytes: 4 * 1024 * 1024,
  maxChangedFiles: 256,
  maxChangedBytes: 32 * 1024 * 1024,
});

interface WorkingCopyMutationState {
  tail: Promise<void>;
  poisoned: WorkingCopyQuarantinedError | null;
}

const WORKING_COPY_MUTATIONS = new Map<string, WorkingCopyMutationState>();

export class WorkingCopyQuarantinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkingCopyQuarantinedError";
  }
}

export type RepositoryFreshnessGuard = (
  expectedInstructionRevision: number,
  effect: "read" | "write",
) => Promise<void>;

/** Bound read-only view safe to hand to mapper/test/critic workers. */
export class ReadOnlyRepositoryTools {
  constructor(
    protected readonly base: ProjectSnapshotHandle,
    protected readonly working: ProjectWorkingCopy,
    protected readonly guard: RepositoryFreshnessGuard,
    protected readonly limits: RepositoryToolLimits,
  ) {}

  async tree(
    expectedInstructionRevision: number,
    input: { path?: string; maxDepth?: number } = {},
  ): Promise<WorkspaceCollection<WorkspaceTreeEntry>> {
    await this.guard(expectedInstructionRevision, "read");
    const root = input.path
      ? resolveProjectPath(this.working.internalPath, input.path)
      : this.working.internalPath;
    const rootState = await lstat(root);
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
      throw new Error("Path tree harus direktori project nyata.");
    }
    const maxDepth = Math.min(Math.max(input.maxDepth ?? 6, 0), 32);
    const results: WorkspaceTreeEntry[] = [];
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        truncated ||= (await readdir(directory)).length > 0;
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        if (truncated) return;
        const absolute = resolve(directory, entry.name);
        const path = relative(this.working.internalPath, absolute)
          .split("\\")
          .join("/");
        canonicalProjectPath(path);
        if (isSensitiveProjectPath(path)) continue;
        const state = await lstat(absolute);
        if (state.isSymbolicLink()) {
          throw new Error("Symlink muncul di working copy project.");
        }
        if (state.isDirectory()) {
          results.push({ path, type: "directory", size: null });
          if (results.length > this.limits.maxTreeEntries) {
            truncated = true;
            return;
          }
          await visit(absolute, depth + 1);
        } else if (state.isFile()) {
          results.push({ path, type: "file", size: state.size });
          if (results.length > this.limits.maxTreeEntries) {
            truncated = true;
            return;
          }
        } else {
          throw new Error("Special file muncul di working copy project.");
        }
      }
    };
    await visit(root, 0);
    await this.guard(expectedInstructionRevision, "read");
    return {
      items: results.slice(0, this.limits.maxTreeEntries),
      truncated,
    };
  }

  async read(
    expectedInstructionRevision: number,
    input: { path: string; startLine?: number; endLine?: number },
  ): Promise<WorkspaceReadResult> {
    await this.guard(expectedInstructionRevision, "read");
    const path = canonicalProjectPath(input.path);
    assertProviderSafeProjectPath(path);
    const absolute = resolveProjectPath(this.working.internalPath, path);
    const state = await lstat(absolute);
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new Error("workspace.read hanya menerima file biasa.");
    }
    if (state.size > this.limits.maxReadBytes) {
      throw new Error("File terlalu besar untuk workspace.read.");
    }
    const bytes = await readFile(absolute);
    if (looksBinary(bytes)) throw new Error("File biner tidak dapat dibaca sebagai teks.");
    const text = bytes.toString("utf8");
    assertProviderSafeProjectText(path, text);
    const lines = text.split(/\r?\n/u);
    const startLine = boundedLine(input.startLine ?? 1, 1, lines.length || 1);
    const requestedEnd = input.endLine ?? Math.min(lines.length, startLine + 399);
    const endLine = boundedLine(requestedEnd, startLine, lines.length || startLine);
    const result = {
      path,
      startLine,
      endLine,
      totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join("\n"),
      sha256: sha256(bytes),
      truncated: startLine > 1 || endLine < lines.length,
    };
    await this.guard(expectedInstructionRevision, "read");
    return result;
  }

  async search(
    expectedInstructionRevision: number,
    input: {
      query: string;
      path?: string;
      caseSensitive?: boolean;
      extensions?: readonly string[];
    },
  ): Promise<WorkspaceCollection<WorkspaceSearchMatch>> {
    await this.guard(expectedInstructionRevision, "read");
    const query = safeQuery(input.query);
    const root = input.path
      ? resolveProjectPath(this.working.internalPath, input.path)
      : this.working.internalPath;
    const extensions = input.extensions?.map(validExtension);
    const files = await collectFiles(root, this.working.internalPath, this.limits.maxSearchFiles);
    const needle = input.caseSensitive ? query : query.toLocaleLowerCase("en-US");
    const results: WorkspaceSearchMatch[] = [];
    searchFiles: for (const file of files) {
      if (extensions && !extensions.includes(extname(file.path).toLowerCase())) continue;
      if (file.size > this.limits.maxReadBytes) continue;
      const bytes = await readFile(file.absolute);
      if (looksBinary(bytes)) continue;
      const text = bytes.toString("utf8");
      if (containsSecretLikeValue(text)) continue;
      const lines = text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = input.caseSensitive
          ? line
          : line.toLocaleLowerCase("en-US");
        const column = haystack.indexOf(needle);
        if (column < 0) continue;
        results.push({
          path: file.path,
          line: index + 1,
          column: column + 1,
          preview: boundedPreview(line),
        });
        if (results.length > this.limits.maxSearchMatches) break searchFiles;
      }
    }
    await this.guard(expectedInstructionRevision, "read");
    return {
      items: results.slice(0, this.limits.maxSearchMatches),
      truncated: results.length > this.limits.maxSearchMatches,
    };
  }

  async symbols(
    expectedInstructionRevision: number,
    input: { query?: string } = {},
  ): Promise<WorkspaceCollection<WorkspaceSymbol>> {
    await this.guard(expectedInstructionRevision, "read");
    const query = input.query?.toLocaleLowerCase("en-US") ?? null;
    const files = await collectFiles(
      this.working.internalPath,
      this.working.internalPath,
      this.limits.maxSearchFiles,
    );
    const results: WorkspaceSymbol[] = [];
    const pattern = /^\s*(?:(?:export|public|private|protected|async|declare|abstract|static)\s+)*(class|function|interface|type|const|let|var|def)\s+([A-Za-z_$][\w$]*)/u;
    symbolFiles: for (const file of files) {
      if (file.size > this.limits.maxReadBytes) continue;
      const bytes = await readFile(file.absolute);
      if (looksBinary(bytes)) continue;
      const text = bytes.toString("utf8");
      if (containsSecretLikeValue(text)) continue;
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        const match = pattern.exec(line);
        if (!match) continue;
        const name = match[2]!;
        if (query && !name.toLocaleLowerCase("en-US").includes(query)) continue;
        results.push({
          path: file.path,
          line: index + 1,
          kind: symbolKind(match[1]!),
          name,
        });
        if (results.length > this.limits.maxSearchMatches) break symbolFiles;
      }
    }
    await this.guard(expectedInstructionRevision, "read");
    return {
      items: results.slice(0, this.limits.maxSearchMatches),
      truncated: results.length > this.limits.maxSearchMatches,
    };
  }

  async references(
    expectedInstructionRevision: number,
    symbol: string,
  ): Promise<WorkspaceCollection<WorkspaceSearchMatch>> {
    const clean = safeIdentifier(symbol);
    return this.search(expectedInstructionRevision, {
      query: clean,
      caseSensitive: true,
    });
  }

  async diff(expectedInstructionRevision: number): Promise<CodingDiffSummary> {
    await this.guard(expectedInstructionRevision, "read");
    const result = await diffTrees(this.base, this.working);
    if (result.files.some((file) => isSensitiveProjectPath(file.path))) {
      throw new Error("Diff memuat path sensitif yang tidak boleh menjadi observation provider.");
    }
    await this.guard(expectedInstructionRevision, "read");
    return result;
  }
}

export function bindReadOnlyRepositoryTools(
  tools: ReadOnlyRepositoryTools,
  instructionRevision: number,
): BoundReadOnlyRepositoryTools {
  if (!Number.isSafeInteger(instructionRevision) || instructionRevision < 0) {
    throw new Error("Instruction revision repository view tidak sah.");
  }
  const bound: BoundReadOnlyRepositoryTools = {
    tree: (input = {}) => tools.tree(instructionRevision, input),
    read: (input) => tools.read(instructionRevision, input),
    search: (input) => tools.search(instructionRevision, input),
    symbols: (input = {}) => tools.symbols(instructionRevision, input),
    references: (symbol) => tools.references(instructionRevision, symbol),
    diff: () => tools.diff(instructionRevision),
  };
  return Object.freeze(bound);
}

export function createSnapshotReadOnlyRepositoryTools(
  base: ProjectSnapshotHandle,
  snapshot: ProjectSnapshotHandle,
  guard: RepositoryFreshnessGuard,
  limits: Partial<RepositoryToolLimits> = {},
): ReadOnlyRepositoryTools {
  if (
    base.projectId !== snapshot.projectId ||
    base.ownerWorkspaceKey !== snapshot.ownerWorkspaceKey ||
    base.workspaceRevision !== snapshot.workspaceRevision
  ) {
    throw new Error("Snapshot repository view tidak mempunyai binding yang sama.");
  }
  return new ReadOnlyRepositoryTools(
    base,
    {
      projectId: snapshot.projectId,
      ownerWorkspaceKey: snapshot.ownerWorkspaceKey,
      workingCopyId: `review-${snapshot.snapshotId.slice(0, 32)}`,
      workspaceRevision: snapshot.workspaceRevision,
      baseSnapshot: base.snapshotId,
      internalPath: snapshot.internalPath,
    },
    guard,
    validatedLimits({ ...DEFAULT_LIMITS, ...limits }),
  );
}

/** Only the single integrator receives this mutable view. */
export class RepositoryTools extends ReadOnlyRepositoryTools {
  private readonly mutationState: WorkingCopyMutationState;

  constructor(
    base: ProjectSnapshotHandle,
    working: ProjectWorkingCopy,
    guard: RepositoryFreshnessGuard,
    limits: Partial<RepositoryToolLimits> = {},
    private readonly makeId: () => string = randomUUID,
  ) {
    super(base, working, guard, validatedLimits({ ...DEFAULT_LIMITS, ...limits }));
    const key = resolve(working.internalPath);
    this.mutationState = WORKING_COPY_MUTATIONS.get(key) ?? {
      tail: Promise.resolve(),
      poisoned: null,
    };
    WORKING_COPY_MUTATIONS.set(key, this.mutationState);
  }

  readOnlyWorker(): ReadOnlyRepositoryTools {
    return new SerializedReadOnlyRepositoryTools(
      this.base,
      this.working,
      this.guard,
      this.limits,
      (operation) => this.serialize(operation),
    );
  }

  /** Serializes code-owned snapshot/validation work with every patch/read view. */
  withStableWorkingCopy<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(operation);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      if (this.mutationState.poisoned) throw this.mutationState.poisoned;
      return operation();
    };
    const next = this.mutationState.tail.then(guarded, guarded);
    this.mutationState.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  override tree(
    expectedInstructionRevision: number,
    input: { path?: string; maxDepth?: number } = {},
  ): Promise<WorkspaceCollection<WorkspaceTreeEntry>> {
    return this.serialize(() => super.tree(expectedInstructionRevision, input));
  }

  override read(
    expectedInstructionRevision: number,
    input: { path: string; startLine?: number; endLine?: number },
  ): Promise<WorkspaceReadResult> {
    return this.serialize(() => super.read(expectedInstructionRevision, input));
  }

  override search(
    expectedInstructionRevision: number,
    input: {
      query: string;
      path?: string;
      caseSensitive?: boolean;
      extensions?: readonly string[];
    },
  ): Promise<WorkspaceCollection<WorkspaceSearchMatch>> {
    return this.serialize(() => super.search(expectedInstructionRevision, input));
  }

  override symbols(
    expectedInstructionRevision: number,
    input: { query?: string } = {},
  ): Promise<WorkspaceCollection<WorkspaceSymbol>> {
    return this.serialize(() => super.symbols(expectedInstructionRevision, input));
  }

  override diff(expectedInstructionRevision: number): Promise<CodingDiffSummary> {
    return this.serialize(() => super.diff(expectedInstructionRevision));
  }

  async applyPatch<T>(
    expectedInstructionRevision: number,
    operations: readonly StructuredPatchOperation[],
    persist: (diff: CodingDiffSummary) => Promise<T>,
    verifyAfterRollback?: () => Promise<void>,
  ): Promise<{ diff: CodingDiffSummary; persisted: T }> {
    const operation = this.mutationState.tail.then(async () => {
      if (this.mutationState.poisoned) throw this.mutationState.poisoned;
      await this.guard(expectedInstructionRevision, "write");
      const validated = await validatePatch(
        this.working.internalPath,
        operations,
        this.limits,
      );
      const originals = new Map<string, { bytes: Buffer; mode: number } | null>();
      const temporaryPaths = new Set<string>();
      for (const item of validated) originals.set(item.path, item.original);
      try {
        for (const item of validated) {
          const target = resolveProjectPath(this.working.internalPath, item.path);
          if (item.operation.kind === "delete") {
            await rm(target, { force: false });
            continue;
          }
          await mkdir(dirname(target), { recursive: true });
          const temporary = `${target}.harvy-${temporaryId(this.makeId())}.tmp`;
          temporaryPaths.add(temporary);
          const executable = item.operation.executable ??
            (item.original !== null && (item.original.mode & 0o111) !== 0);
          await writeFile(temporary, item.operation.content, {
            encoding: "utf8",
            flag: "wx",
            mode: executable ? 0o700 : 0o600,
          });
          await rename(temporary, target);
          temporaryPaths.delete(temporary);
          await chmod(target, executable ? 0o700 : 0o600);
        }
        await this.guard(expectedInstructionRevision, "write");
        const diff = await diffTrees(this.base, this.working);
        assertDiffLimits(diff, this.limits);
        const persisted = await persist(diff);
        return { diff, persisted };
      } catch (error) {
        const cleanup = await Promise.allSettled(
          [...temporaryPaths].map((path) => rm(path, { force: true })),
        );
        try {
          if (cleanup.some((result) => result.status === "rejected")) {
            throw new Error("Temporary patch tidak seluruhnya dapat dibersihkan.");
          }
          await restoreFiles(this.working.internalPath, originals);
          await verifyRestoredFiles(this.working.internalPath, originals);
          await verifyAfterRollback?.();
        } catch (rollbackError) {
          this.mutationState.poisoned = new WorkingCopyQuarantinedError(
            `Working copy dikarantina karena rollback patch tidak dapat dibuktikan: ${errorText(rollbackError)}`,
          );
          throw this.mutationState.poisoned;
        }
        throw error;
      }
    });
    this.mutationState.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

class SerializedReadOnlyRepositoryTools extends ReadOnlyRepositoryTools {
  constructor(
    base: ProjectSnapshotHandle,
    working: ProjectWorkingCopy,
    guard: RepositoryFreshnessGuard,
    limits: RepositoryToolLimits,
    private readonly schedule: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {
    super(base, working, guard, limits);
  }

  override tree(
    expectedInstructionRevision: number,
    input: { path?: string; maxDepth?: number } = {},
  ): Promise<WorkspaceCollection<WorkspaceTreeEntry>> {
    return this.schedule(() => super.tree(expectedInstructionRevision, input));
  }

  override read(
    expectedInstructionRevision: number,
    input: { path: string; startLine?: number; endLine?: number },
  ): Promise<WorkspaceReadResult> {
    return this.schedule(() => super.read(expectedInstructionRevision, input));
  }

  override search(
    expectedInstructionRevision: number,
    input: {
      query: string;
      path?: string;
      caseSensitive?: boolean;
      extensions?: readonly string[];
    },
  ): Promise<WorkspaceCollection<WorkspaceSearchMatch>> {
    return this.schedule(() => super.search(expectedInstructionRevision, input));
  }

  override symbols(
    expectedInstructionRevision: number,
    input: { query?: string } = {},
  ): Promise<WorkspaceCollection<WorkspaceSymbol>> {
    return this.schedule(() => super.symbols(expectedInstructionRevision, input));
  }

  override diff(expectedInstructionRevision: number): Promise<CodingDiffSummary> {
    return this.schedule(() => super.diff(expectedInstructionRevision));
  }
}

interface ValidatedPatch {
  operation: StructuredPatchOperation;
  path: string;
  original: { bytes: Buffer; mode: number } | null;
}

async function validatePatch(
  root: string,
  operations: readonly StructuredPatchOperation[],
  limits: RepositoryToolLimits,
): Promise<ValidatedPatch[]> {
  if (!Array.isArray(operations) || operations.length < 1 ||
    operations.length > limits.maxPatchOperations) {
    throw new Error("Jumlah operasi workspace.apply_patch tidak sah.");
  }
  const paths = new Set<string>();
  let patchBytes = 0;
  const validated: ValidatedPatch[] = [];
  for (const operation of operations) {
    const path = canonicalProjectPath(operation.path);
    if (containsSecretLikeValue(path) || isSensitiveProjectPath(path)) {
      throw new Error("Path patch sensitif atau menyerupai credential dan ditolak.");
    }
    const key = path.toLocaleLowerCase("en-US");
    if (paths.has(key)) throw new Error("Satu patch tidak boleh menyentuh path dua kali.");
    paths.add(key);
    const target = resolveProjectPath(root, path);
    const state = await optionalLstat(target);
    if (state?.isSymbolicLink() || (state && !state.isFile())) {
      throw new Error("Patch hanya boleh menyentuh file biasa.");
    }
    const original = state
      ? { bytes: await readFile(target), mode: state.mode }
      : null;
    if (operation.kind === "add") {
      if (original) throw new Error("Operasi add menargetkan file yang sudah ada.");
    } else {
      if (!original) throw new Error("Operasi update/delete menargetkan file yang hilang.");
      if (!/^[a-f0-9]{64}$/u.test(operation.expectedSha256) ||
        sha256(original.bytes) !== operation.expectedSha256) {
        throw new Error("Patch ditolak karena hash file sudah berubah.");
      }
    }
    if (operation.kind !== "delete") {
      if (typeof operation.content !== "string" || operation.content.includes("\0")) {
        throw new Error("Patch content harus teks tanpa NUL.");
      }
      if (containsSecretLikeValue(operation.content)) {
        throw new Error("Patch content menyerupai credential dan ditolak.");
      }
      patchBytes += Buffer.byteLength(operation.content);
      if (patchBytes > limits.maxPatchBytes) {
        throw new Error("Ukuran workspace.apply_patch melampaui batas.");
      }
    }
    validated.push({ operation: structuredClone(operation), path, original });
  }
  return validated;
}

async function restoreFiles(
  root: string,
  originals: ReadonlyMap<string, { bytes: Buffer; mode: number } | null>,
): Promise<void> {
  for (const [path, original] of originals) {
    const target = resolveProjectPath(root, path);
    if (!original) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, original.bytes, { mode: original.mode & 0o777 });
    await chmod(target, original.mode & 0o777);
  }
}

async function verifyRestoredFiles(
  root: string,
  originals: ReadonlyMap<string, { bytes: Buffer; mode: number } | null>,
): Promise<void> {
  for (const [path, original] of originals) {
    const target = resolveProjectPath(root, path);
    const state = await optionalLstat(target);
    if (!original) {
      if (state) throw new Error("File baru masih ada setelah rollback.");
      continue;
    }
    if (!state?.isFile() || state.isSymbolicLink()) {
      throw new Error("File original tidak pulih sebagai file biasa.");
    }
    const bytes = await readFile(target);
    if (!bytes.equals(original.bytes) || (state.mode & 0o777) !== (original.mode & 0o777)) {
      throw new Error("Isi atau mode file original tidak pulih.");
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "rollback_error";
}

export async function diffTrees(
  base: ProjectSnapshotHandle,
  working: ProjectWorkingCopy,
): Promise<CodingDiffSummary> {
  const [before, after] = await Promise.all([
    scanProjectTree(base.internalPath),
    scanProjectTree(working.internalPath),
  ]);
  if (before.snapshotId !== base.snapshotId) {
    throw new Error("Immutable base snapshot tidak cocok dengan manifest aktual.");
  }
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .sort((left, right) => left.localeCompare(right, "en"));
  const files: CodingDiffEntry[] = [];
  let addedBytes = 0;
  let removedBytes = 0;
  for (const path of paths) {
    const oldFile = beforeByPath.get(path) ?? null;
    const newFile = afterByPath.get(path) ?? null;
    if (oldFile?.sha256 === newFile?.sha256 &&
      oldFile?.executable === newFile?.executable) continue;
    const status = !oldFile ? "added" : !newFile ? "deleted" : "modified";
    const binary = await changedFileIsBinary(base.internalPath, working.internalPath, path);
    files.push({
      path,
      status,
      beforeSha256: oldFile?.sha256 ?? null,
      afterSha256: newFile?.sha256 ?? null,
      beforeSize: oldFile?.size ?? null,
      afterSize: newFile?.size ?? null,
      binary,
    });
    addedBytes += newFile?.size ?? 0;
    removedBytes += oldFile?.size ?? 0;
  }
  return {
    baseSnapshot: before.snapshotId,
    workingSnapshot: after.snapshotId,
    files,
    addedBytes,
    removedBytes,
    generatedAt: new Date().toISOString(),
  };
}

function assertDiffLimits(diff: CodingDiffSummary, limits: RepositoryToolLimits): void {
  if (diff.files.length > limits.maxChangedFiles) {
    throw new Error("Jumlah file berubah melampaui CodingRun budget.");
  }
  if (diff.addedBytes + diff.removedBytes > limits.maxChangedBytes) {
    throw new Error("Ukuran perubahan melampaui CodingRun budget.");
  }
}

async function changedFileIsBinary(
  baseRoot: string,
  workingRoot: string,
  path: string,
): Promise<boolean> {
  let binary = false;
  for (const root of [workingRoot, baseRoot]) {
    const absolute = resolveProjectPath(root, path);
    const state = await optionalLstat(absolute);
    if (state?.isFile()) binary ||= looksBinary(await readFile(absolute));
  }
  return binary;
}

async function collectFiles(
  root: string,
  projectRoot: string,
  maxFiles: number,
): Promise<Array<{ path: string; absolute: string; size: number }>> {
  const results: Array<{ path: string; absolute: string; size: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = relative(projectRoot, absolute).split("\\").join("/");
      canonicalProjectPath(path);
      if (isSensitiveProjectPath(path)) continue;
      const state = await lstat(absolute);
      if (state.isSymbolicLink()) throw new Error("Symlink muncul di project.");
      if (state.isDirectory()) await visit(absolute);
      else if (state.isFile()) {
        results.push({ path, absolute, size: state.size });
        if (results.length > maxFiles) {
          throw new Error("Jumlah file pencarian project melampaui batas.");
        }
      } else throw new Error("Special file muncul di project.");
    }
  };
  await visit(root);
  return results;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  return sample.includes(0);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedLine(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Rentang baris workspace.read tidak sah.");
  }
  return value;
}

function safeQuery(value: string): string {
  const clean = typeof value === "string" ? value : "";
  if (!clean || clean.length > 512 || clean.includes("\0")) {
    throw new Error("Query workspace.search tidak sah.");
  }
  return clean;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_$][\w$]{0,127}$/u.test(value)) {
    throw new Error("Identifier workspace.references tidak sah.");
  }
  return value;
}

function validExtension(value: string): string {
  const clean = value.toLowerCase();
  if (!/^\.[a-z0-9_+-]{1,16}$/u.test(clean)) {
    throw new Error("Extension pencarian project tidak sah.");
  }
  return clean;
}

function boundedPreview(value: string): string {
  const clean = value.trim().replace(/\s+/gu, " ");
  return clean.length <= 240 ? clean : `${clean.slice(0, 237)}...`;
}

function assertProviderSafeProjectPath(path: string): void {
  if (isSensitiveProjectPath(path) || containsSecretLikeValue(path)) {
    throw new Error("Path project sensitif tidak boleh dibaca sebagai observation provider.");
  }
}

function assertProviderSafeProjectText(path: string, text: string): void {
  assertProviderSafeProjectPath(path);
  if (containsSecretLikeValue(text)) {
    throw new Error("Isi project menyerupai credential dan tidak boleh menjadi observation provider.");
  }
}

function symbolKind(value: string): WorkspaceSymbol["kind"] {
  switch (value) {
    case "class": return "class";
    case "function":
    case "def": return "function";
    case "interface": return "interface";
    case "type": return "type";
    case "const":
    case "let":
    case "var": return "variable";
    default: throw new Error("Jenis symbol tidak dikenal.");
  }
}

function validatedLimits(value: RepositoryToolLimits): RepositoryToolLimits {
  for (const [name, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Limit repository tool ${name} tidak sah.`);
    }
  }
  return Object.freeze({ ...value });
}

function temporaryId(value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/giu, "").slice(0, 64);
  if (!clean) throw new Error("ID temporary patch tidak sah.");
  return clean;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
