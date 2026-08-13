import { performance } from "node:perf_hooks";
import type {
  StructuredPatchOperation,
  WorkspaceCollection,
  WorkspaceReadResult,
  WorkspaceSearchMatch,
} from "../coding/repository-tools.js";
import type { CodingRunEngine } from "../core/coding-run-engine.js";
import type { LocalGitService } from "../core/local-git-service.js";
import type {
  CodingDiffSummary,
  CodingRun,
  CodingValidatorKind,
} from "../domain/coding-run.js";
import type { LocalGitHealth, LocalGitLogEntry } from "../domain/local-git.js";
import type {
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
} from "../domain/sandbox.js";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";
import { MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS } from "../harness/agent-harness.js";
import type { HarvyCapabilityCatalogOptions } from "../harness/capabilities.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";

const MAX_ID_CHARACTERS = 192;
const MAX_PATH_CHARACTERS = 1_024;
const MAX_QUERY_CHARACTERS = 1_024;
const MAX_PATCH_OPERATIONS = 64;
const MAX_PATCH_BYTES = 4 * 1_024 * 1_024;
const MAX_ARGV = 128;
const MAX_ARG_CHARACTERS = 8_192;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

type CodingEnginePort = Pick<
  CodingRunEngine,
  | "get"
  | "readOnlyWorkerTools"
  | "applyPatch"
  | "executeSandbox"
  | "runValidator"
>;

type LocalGitPort = Pick<
  LocalGitService,
  "health" | "status" | "diff" | "log" | "commit"
>;

export interface CodingAgentExecutorDependencies {
  engine: CodingEnginePort;
  /** Presence means a concrete local-only git service was deliberately wired. */
  localGit?: LocalGitPort;
  /** Must inspect the same isolated runner used by `engine`; absent means off. */
  sandboxHealth?: () => Promise<SandboxHealth>;
  healthTimeoutMs?: number;
}

export interface CodingAgentExecutorBundle {
  executors: readonly AgentCapabilityExecutor[];
  catalogOptions: Readonly<
    Pick<
      HarvyCapabilityCatalogOptions,
      "codingWorkspaceInstalled" | "sandboxRunnerInstalled" | "localGitInstalled"
    >
  >;
  sandboxHealth: SandboxHealth | null;
  localGitHealth: LocalGitHealth | null;
}

interface RunStateInput {
  runId: string;
  instructionRevision: number;
  stateRevision: number;
}

interface ProjectRevisionInput {
  projectId: string;
  expectedRevision: number;
}

/**
 * Creates only executors whose dependencies are present at bootstrap. Sandbox
 * executors additionally require a bounded, positive isolated-runner health
 * result. GitHub is intentionally excluded: its approval grant must come from
 * a user-confirmation controller, never from an executor callable by a model.
 */
export async function createCodingAgentExecutorBundle(
  dependencies: CodingAgentExecutorDependencies,
): Promise<CodingAgentExecutorBundle> {
  const workspaceExecutors = createWorkspaceExecutors(dependencies.engine);
  const health = dependencies.sandboxHealth
    ? await boundedSandboxHealth(
        dependencies.sandboxHealth,
        dependencies.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      )
    : null;
  const sandboxExecutors = health?.available
    ? createSandboxExecutors(dependencies.engine)
    : [];
  const localGitHealth = dependencies.localGit
    ? await boundedLocalGitHealth(
        () => dependencies.localGit!.health(),
        dependencies.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      )
    : null;
  const localGitExecutors = dependencies.localGit && localGitHealth?.available
    ? createLocalGitExecutors(dependencies.localGit)
    : [];
  const executors: AgentCapabilityExecutor[] = [
    ...workspaceExecutors,
    ...sandboxExecutors,
    ...localGitExecutors,
  ];
  const ids = new Set(executors.map((executor) => executor.capabilityId));
  return {
    executors: Object.freeze(executors),
    catalogOptions: Object.freeze({
      codingWorkspaceInstalled: WORKSPACE_CAPABILITIES.every((id) => ids.has(id)),
      sandboxRunnerInstalled:
        health?.available === true && SANDBOX_CAPABILITIES.every((id) => ids.has(id)),
      localGitInstalled: LOCAL_GIT_CAPABILITIES.every((id) => ids.has(id)),
    }),
    sandboxHealth: health ? structuredClone(health) : null,
    localGitHealth: localGitHealth ? structuredClone(localGitHealth) : null,
  };
}

const WORKSPACE_CAPABILITIES = Object.freeze([
  "workspace.tree",
  "workspace.read",
  "workspace.search",
  "workspace.symbols",
  "workspace.references",
  "workspace.diff",
  "workspace.apply_patch",
] as const);
const SANDBOX_CAPABILITIES = Object.freeze([
  "sandbox.exec",
  "sandbox.test",
] as const);
const LOCAL_GIT_CAPABILITIES = Object.freeze([
  "git.status",
  "git.diff",
  "git.log",
  "git.commit",
] as const);

function createWorkspaceExecutors(engine: CodingEnginePort): AgentCapabilityExecutor[] {
  return [
    executor(
      "workspace.tree",
      nativeTool(
        "harvy_workspace_tree_v1",
        "Baca tree project dari CodingRun dan state revision yang persis.",
        runSchema({
          path: stringSchema(MAX_PATH_CHARACTERS),
          maxDepth: integerSchema(0, 32),
        }),
      ),
      validateTreeInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const entries = await tools.tree(input.instructionRevision, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        });
        await assertExactRun(engine, scope, input);
        return collectionResult("workspace.tree.result", "entries", entries.items, {
          run: publicRunState(input),
          sourceTruncated: entries.truncated,
          trust: "repository-authored-data",
          treatAsInstructions: false,
        });
      },
    ),
    executor(
      "workspace.read",
      nativeTool(
        "harvy_workspace_read_v1",
        "Baca rentang file teks dari CodingRun dan state revision yang persis.",
        runSchema(
          {
            path: stringSchema(MAX_PATH_CHARACTERS),
            startLine: integerSchema(1, Number.MAX_SAFE_INTEGER),
            endLine: integerSchema(1, Number.MAX_SAFE_INTEGER),
          },
          ["path"],
        ),
      ),
      validateReadInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const value = await tools.read(input.instructionRevision, {
          path: input.path,
          ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
          ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        });
        await assertExactRun(engine, scope, input);
        return workspaceReadResult(input, value);
      },
    ),
    executor(
      "workspace.search",
      nativeTool(
        "harvy_workspace_search_v1",
        "Cari teks berbatas dalam CodingRun dan state revision yang persis.",
        runSchema(
          {
            query: stringSchema(MAX_QUERY_CHARACTERS),
            path: stringSchema(MAX_PATH_CHARACTERS),
            caseSensitive: { type: "boolean" },
            extensions: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: stringSchema(32),
            },
          },
          ["query"],
        ),
      ),
      validateSearchInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const matches = await tools.search(input.instructionRevision, {
          query: input.query,
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.caseSensitive === undefined
            ? {}
            : { caseSensitive: input.caseSensitive }),
          ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
        });
        await assertExactRun(engine, scope, input);
        return searchResult("workspace.search.result", input, matches);
      },
    ),
    executor(
      "workspace.symbols",
      nativeTool(
        "harvy_workspace_symbols_v1",
        "Petakan deklarasi simbol dari CodingRun yang persis.",
        runSchema({ query: stringSchema(MAX_QUERY_CHARACTERS) }),
      ),
      validateSymbolsInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const symbols = await tools.symbols(input.instructionRevision, {
          ...(input.query === undefined ? {} : { query: input.query }),
        });
        await assertExactRun(engine, scope, input);
        return collectionResult("workspace.symbols.result", "symbols", symbols.items, {
          run: publicRunState(input),
          sourceTruncated: symbols.truncated,
          trust: "repository-authored-data",
          treatAsInstructions: false,
        });
      },
    ),
    executor(
      "workspace.references",
      nativeTool(
        "harvy_workspace_references_v1",
        "Cari referensi identifier dari CodingRun yang persis.",
        runSchema({ symbol: stringSchema(256) }, ["symbol"]),
      ),
      validateReferencesInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const matches = await tools.references(
          input.instructionRevision,
          input.symbol,
        );
        await assertExactRun(engine, scope, input);
        return searchResult("workspace.references.result", input, matches);
      },
    ),
    executor(
      "workspace.diff",
      nativeTool(
        "harvy_workspace_diff_v1",
        "Bandingkan working copy CodingRun dengan immutable base snapshot.",
        runSchema({}),
      ),
      validateRunOnlyInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const tools = await engine.readOnlyWorkerTools(scope, input.runId);
        const diff = await tools.diff(input.instructionRevision);
        await assertExactRun(engine, scope, input);
        return diffResult("workspace.diff.result", input, diff);
      },
    ),
    executor(
      "workspace.apply_patch",
      nativeTool(
        "harvy_workspace_apply_patch_v1",
        "Terapkan operasi add/update/delete terstruktur pada single writer CodingRun.",
        runSchema(
          {
            operations: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PATCH_OPERATIONS,
              items: {
                oneOf: [
                  patchOperationSchema("add"),
                  patchOperationSchema("update"),
                  patchOperationSchema("delete"),
                ],
              },
            },
          },
          ["operations"],
        ),
      ),
      validatePatchInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const applied = await engine.applyPatch(
          scope,
          input.runId,
          input.instructionRevision,
          input.operations,
        );
        return diffResult(
          "workspace.apply_patch.result",
          runState(applied.run),
          applied.diff,
        );
      },
    ),
  ];
}

function createSandboxExecutors(engine: CodingEnginePort): AgentCapabilityExecutor[] {
  return [
    executor(
      "sandbox.exec",
      nativeTool(
        "harvy_sandbox_exec_v1",
        "Jalankan argv tanpa shell pada isolated SandboxRunner yang sehat.",
        runSchema({ request: sandboxRequestSchema() }, ["request"]),
      ),
      validateSandboxExecInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const result = await engine.executeSandbox(
          scope,
          input.runId,
          input.instructionRevision,
          input.request,
          context.signal,
        );
        const current = await requireRun(engine, scope, input.runId);
        return sandboxResult(current, result);
      },
    ),
    executor(
      "sandbox.test",
      nativeTool(
        "harvy_sandbox_test_v1",
        "Jalankan validator policy-owned pada isolated SandboxRunner.",
        runSchema(
          {
            kind: {
              type: "string",
              enum: ["test", "lint", "typecheck", "build"],
            },
          },
          ["kind"],
        ),
      ),
      validateSandboxTestInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        await assertExactRun(engine, scope, input);
        const validated = await engine.runValidator(
          scope,
          input.runId,
          input.instructionRevision,
          input.kind,
          context.signal,
        );
        return okResult({
          kind: "sandbox.test.result",
          run: runState(validated.run),
          receipt: validated.receipt,
          trust: "sandbox-attested-evidence",
        });
      },
    ),
  ];
}

function createLocalGitExecutors(localGit: LocalGitPort): AgentCapabilityExecutor[] {
  return [
    executor(
      "git.status",
      nativeTool(
        "harvy_git_status_v1",
        "Baca status git lokal dari exact ProjectWorkspace revision.",
        projectSchema({}),
      ),
      validateProjectOnlyInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        const status = await localGit.status(
          scope,
          input.projectId,
          input.expectedRevision,
        );
        return collectionResult(
          "git.status.result",
          "changedPaths",
          status.changedPaths,
          {
            projectId: input.projectId,
            projectRevision: input.expectedRevision,
            clean: status.clean,
            trust: "local-git-attested-state",
          },
        );
      },
    ),
    executor(
      "git.diff",
      nativeTool(
        "harvy_git_diff_v1",
        "Dapatkan artifact diff git lokal dari exact ProjectWorkspace revision.",
        projectSchema({}),
      ),
      validateProjectOnlyInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        const diff = await localGit.diff(
          scope,
          input.projectId,
          input.expectedRevision,
        );
        return okResult({
          kind: "git.diff.result",
          projectId: input.projectId,
          projectRevision: input.expectedRevision,
          artifact: diff,
          trust: "local-git-attested-state",
        });
      },
    ),
    executor(
      "git.log",
      nativeTool(
        "harvy_git_log_v1",
        "Baca histori git lokal berbatas dari exact ProjectWorkspace revision.",
        projectSchema({ limit: integerSchema(1, 100) }),
      ),
      validateGitLogInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        const entries = await localGit.log(
          scope,
          input.projectId,
          input.expectedRevision,
          input.limit,
        );
        return gitLogResult(input, entries);
      },
    ),
    executor(
      "git.commit",
      nativeTool(
        "harvy_git_commit_v1",
        "Commit exact pending local-git effect; branch/message/identity dimiliki kode.",
        projectSchema({}),
      ),
      validateProjectOnlyInput,
      async (input, context) => {
        const scope = workspaceScope(context);
        const committed = await localGit.commit(
          scope,
          input.projectId,
          input.expectedRevision,
        );
        return okResult({
          kind: "git.commit.result",
          projectId: input.projectId,
          sourceProjectRevision: input.expectedRevision,
          projectRevision: committed.projectRevision,
          receipt: committed.receipt,
          trust: "local-git-attested-effect",
        });
      },
    ),
  ];
}

class FunctionalExecutor<T> implements AgentCapabilityExecutor<T> {
  readonly capabilityVersion = "1";

  constructor(
    readonly capabilityId: string,
    readonly nativeTool: AgentNativeToolDefinition,
    private readonly validator: (
      input: unknown,
    ) =>
      | { ok: true; value: T }
      | { ok: false; reason: string },
    private readonly operation: (
      input: T,
      context: AgentExecutionContext,
    ) => Promise<AgentExecutorResult>,
  ) {}

  validate(input: unknown) {
    return this.validator(input);
  }

  async execute(input: T, context: AgentExecutionContext): Promise<AgentExecutorResult> {
    try {
      return await this.operation(input, context);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof CodingExecutorError) {
        return errorResult(this.capabilityId, error.code, error.details);
      }
      return errorResult(this.capabilityId, "operation_failed");
    }
  }
}

function executor<T>(
  capabilityId: string,
  tool: AgentNativeToolDefinition,
  validator: FunctionalExecutor<T>["validate"],
  operation: (
    input: T,
    context: AgentExecutionContext,
  ) => Promise<AgentExecutorResult>,
): AgentCapabilityExecutor<T> {
  return new FunctionalExecutor(capabilityId, tool, validator, operation);
}

class CodingExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = "CodingExecutorError";
  }
}

async function requireRun(
  engine: CodingEnginePort,
  scope: WorkspaceAgentScope,
  runId: string,
): Promise<CodingRun> {
  const run = await engine.get(scope, runId);
  if (!run) throw new CodingExecutorError("coding_run_not_found");
  return run;
}

async function assertExactRun(
  engine: CodingEnginePort,
  scope: WorkspaceAgentScope,
  input: RunStateInput,
): Promise<CodingRun> {
  const run = await requireRun(engine, scope, input.runId);
  if (
    run.instructionRevision !== input.instructionRevision ||
    run.stateRevision !== input.stateRevision
  ) {
    throw new CodingExecutorError("coding_run_state_stale", {
      currentInstructionRevision: run.instructionRevision,
      currentStateRevision: run.stateRevision,
    });
  }
  return run;
}

function workspaceScope(context: AgentExecutionContext): WorkspaceAgentScope {
  if (context.scope.kind !== "workspace") {
    throw new CodingExecutorError("workspace_scope_required");
  }
  return context.scope;
}

async function boundedSandboxHealth(
  check: () => Promise<SandboxHealth>,
  timeoutMs: number,
): Promise<SandboxHealth> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Timeout health SandboxRunner tidak sah.");
  }
  const deadline = performance.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Health SandboxRunner timeout.")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    if (
      performance.now() >= deadline ||
      typeof value.available !== "boolean" ||
      (value.runtime !== null && value.runtime !== "isolated-linux") ||
      (value.available && value.runtime !== "isolated-linux") ||
      typeof value.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      (value.available ? value.reason !== null : typeof value.reason !== "string")
    ) {
      throw new Error("Health SandboxRunner tidak sah.");
    }
    return structuredClone(value);
  } catch {
    return {
      available: false,
      runtime: null,
      checkedAt: new Date().toISOString(),
      reason: "SandboxRunner tidak sehat saat bootstrap.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedLocalGitHealth(
  check: () => Promise<LocalGitHealth>,
  timeoutMs: number,
): Promise<LocalGitHealth> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Timeout health local git tidak sah.");
  }
  const deadline = performance.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Health local git timeout.")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    if (
      performance.now() >= deadline ||
      typeof value.available !== "boolean" ||
      (value.protocol !== null && value.protocol !== "harvy-local-git/1") ||
      (value.available && value.protocol !== "harvy-local-git/1") ||
      typeof value.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      (value.available ? value.reason !== null : typeof value.reason !== "string")
    ) {
      throw new Error("Health local git tidak sah.");
    }
    return structuredClone(value);
  } catch {
    return {
      available: false,
      protocol: null,
      checkedAt: new Date().toISOString(),
      reason: "Local git trust-domain tidak sehat saat bootstrap.",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface TreeInput extends RunStateInput {
  path?: string;
  maxDepth?: number;
}

function validateTreeInput(input: unknown) {
  const common = validateRunRecord(input, [], ["path", "maxDepth"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (record.path !== undefined && !validPathText(record.path)) return invalid("path tidak sah.");
  if (record.maxDepth !== undefined && !boundedInteger(record.maxDepth, 0, 32)) {
    return invalid("maxDepth harus bilangan 0–32.");
  }
  return valid<TreeInput>({
    ...common.value,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.maxDepth === "number" ? { maxDepth: record.maxDepth } : {}),
  });
}

interface ReadInput extends RunStateInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

function validateReadInput(input: unknown) {
  const common = validateRunRecord(input, ["path"], ["startLine", "endLine"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (!validPathText(record.path)) return invalid("path tidak sah.");
  if (record.startLine !== undefined && !boundedInteger(record.startLine, 1)) {
    return invalid("startLine tidak sah.");
  }
  if (record.endLine !== undefined && !boundedInteger(record.endLine, 1)) {
    return invalid("endLine tidak sah.");
  }
  if (
    typeof record.startLine === "number" &&
    typeof record.endLine === "number" &&
    record.endLine < record.startLine
  ) {
    return invalid("endLine tidak boleh sebelum startLine.");
  }
  return valid<ReadInput>({
    ...common.value,
    path: record.path,
    ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
    ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
  });
}

interface SearchInput extends RunStateInput {
  query: string;
  path?: string;
  caseSensitive?: boolean;
  extensions?: string[];
}

function validateSearchInput(input: unknown) {
  const common = validateRunRecord(
    input,
    ["query"],
    ["path", "caseSensitive", "extensions"],
  );
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (!safeText(record.query, MAX_QUERY_CHARACTERS)) return invalid("query tidak sah.");
  if (record.path !== undefined && !validPathText(record.path)) return invalid("path tidak sah.");
  if (record.caseSensitive !== undefined && typeof record.caseSensitive !== "boolean") {
    return invalid("caseSensitive harus boolean.");
  }
  let extensions: string[] | undefined;
  if (record.extensions !== undefined) {
    if (
      !Array.isArray(record.extensions) ||
      record.extensions.length < 1 ||
      record.extensions.length > 32 ||
      !record.extensions.every(
        (value: unknown) => typeof value === "string" && /^\.[a-z0-9][a-z0-9+_-]{0,30}$/u.test(value),
      )
    ) {
      return invalid("extensions tidak sah.");
    }
    extensions = [...new Set(record.extensions as string[])];
  }
  return valid<SearchInput>({
    ...common.value,
    query: record.query,
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.caseSensitive === "boolean"
      ? { caseSensitive: record.caseSensitive }
      : {}),
    ...(extensions ? { extensions } : {}),
  });
}

interface SymbolsInput extends RunStateInput {
  query?: string;
}

function validateSymbolsInput(input: unknown) {
  const common = validateRunRecord(input, [], ["query"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (record.query !== undefined && !safeText(record.query, MAX_QUERY_CHARACTERS)) {
    return invalid("query simbol tidak sah.");
  }
  return valid<SymbolsInput>({
    ...common.value,
    ...(typeof record.query === "string" ? { query: record.query } : {}),
  });
}

interface ReferencesInput extends RunStateInput {
  symbol: string;
}

function validateReferencesInput(input: unknown) {
  const common = validateRunRecord(input, ["symbol"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (
    typeof record.symbol !== "string" ||
    !/^[A-Za-z_$][\w$]{0,255}$/u.test(record.symbol)
  ) {
    return invalid("symbol tidak sah.");
  }
  return valid<ReferencesInput>({ ...common.value, symbol: record.symbol });
}

function validateRunOnlyInput(input: unknown) {
  return validateRunRecord(input);
}

interface PatchInput extends RunStateInput {
  operations: StructuredPatchOperation[];
}

function validatePatchInput(input: unknown) {
  const common = validateRunRecord(input, ["operations"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (
    !Array.isArray(record.operations) ||
    record.operations.length < 1 ||
    record.operations.length > MAX_PATCH_OPERATIONS
  ) {
    return invalid("operations patch tidak sah.");
  }
  const operations: StructuredPatchOperation[] = [];
  let totalBytes = 0;
  for (const operation of record.operations) {
    const parsed = validatePatchOperation(operation);
    if (!parsed.ok) return parsed;
    if ("content" in parsed.value) {
      totalBytes += Buffer.byteLength(parsed.value.content, "utf8");
      if (totalBytes > MAX_PATCH_BYTES) return invalid("Payload patch terlalu besar.");
    }
    operations.push(parsed.value);
  }
  return valid<PatchInput>({ ...common.value, operations });
}

interface SandboxInput extends RunStateInput {
  request: SandboxExecRequest;
}

function validateSandboxExecInput(input: unknown) {
  const common = validateRunRecord(input, ["request"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  const request = validateSandboxRequest(record.request);
  return request.ok
    ? valid<SandboxInput>({ ...common.value, request: request.value })
    : request;
}

interface SandboxTestInput extends RunStateInput {
  kind: CodingValidatorKind;
}

function validateSandboxTestInput(input: unknown) {
  const common = validateRunRecord(input, ["kind"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  if (!validatorKind(record.kind)) return invalid("kind validator tidak sah.");
  return valid<SandboxTestInput>({ ...common.value, kind: record.kind });
}

function validateProjectOnlyInput(input: unknown) {
  return validateProjectRecord(input);
}

interface GitLogInput extends ProjectRevisionInput {
  limit: number;
}

function validateGitLogInput(input: unknown) {
  const common = validateProjectRecord(input, [], ["limit"]);
  if (!common.ok) return common;
  const record = input as Record<string, unknown>;
  const limit = record.limit === undefined ? 20 : record.limit;
  if (!boundedInteger(limit, 1, 100)) return invalid("limit git log harus 1–100.");
  return valid<GitLogInput>({ ...common.value, limit });
}

function validateRunRecord(
  input: unknown,
  extraRequired: readonly string[] = [],
  extraOptional: readonly string[] = [],
) {
  const required = ["runId", "instructionRevision", "stateRevision", ...extraRequired];
  if (!isExactRecord(input, required, extraOptional)) {
    return invalid("Input coding harus memakai schema exact yang terikat run.");
  }
  if (!opaqueText(input.runId, MAX_ID_CHARACTERS)) return invalid("runId tidak sah.");
  if (!boundedInteger(input.instructionRevision, 0)) {
    return invalid("instructionRevision tidak sah.");
  }
  if (!boundedInteger(input.stateRevision, 0)) return invalid("stateRevision tidak sah.");
  return valid<RunStateInput>({
    runId: input.runId,
    instructionRevision: input.instructionRevision,
    stateRevision: input.stateRevision,
  });
}

function validateProjectRecord(
  input: unknown,
  extraRequired: readonly string[] = [],
  extraOptional: readonly string[] = [],
) {
  const required = ["projectId", "expectedRevision", ...extraRequired];
  if (!isExactRecord(input, required, extraOptional)) {
    return invalid("Input git harus memakai schema exact yang terikat project.");
  }
  if (!opaqueText(input.projectId, MAX_ID_CHARACTERS)) return invalid("projectId tidak sah.");
  if (!boundedInteger(input.expectedRevision, 1)) {
    return invalid("expectedRevision tidak sah.");
  }
  return valid<ProjectRevisionInput>({
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
  });
}

function validatePatchOperation(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("Operasi patch harus object.");
  }
  const operation = input as Record<string, unknown>;
  if (operation.kind === "add") {
    if (!isExactRecord(operation, ["kind", "path", "content"], ["executable"])) {
      return invalid("Schema add patch tidak sah.");
    }
    if (!validPathText(operation.path) || typeof operation.content !== "string") {
      return invalid("Path/content add patch tidak sah.");
    }
    if (operation.executable !== undefined && typeof operation.executable !== "boolean") {
      return invalid("executable add patch tidak sah.");
    }
    return valid<StructuredPatchOperation>({
      kind: "add",
      path: operation.path,
      content: operation.content,
      ...(typeof operation.executable === "boolean"
        ? { executable: operation.executable }
        : {}),
    });
  }
  if (operation.kind === "update") {
    if (
      !isExactRecord(
        operation,
        ["kind", "path", "expectedSha256", "content"],
        ["executable"],
      )
    ) {
      return invalid("Schema update patch tidak sah.");
    }
    if (
      !validPathText(operation.path) ||
      !sha256(operation.expectedSha256) ||
      typeof operation.content !== "string"
    ) {
      return invalid("Precondition/content update patch tidak sah.");
    }
    if (operation.executable !== undefined && typeof operation.executable !== "boolean") {
      return invalid("executable update patch tidak sah.");
    }
    return valid<StructuredPatchOperation>({
      kind: "update",
      path: operation.path,
      expectedSha256: operation.expectedSha256,
      content: operation.content,
      ...(typeof operation.executable === "boolean"
        ? { executable: operation.executable }
        : {}),
    });
  }
  if (operation.kind === "delete") {
    if (!isExactRecord(operation, ["kind", "path", "expectedSha256"])) {
      return invalid("Schema delete patch tidak sah.");
    }
    if (!validPathText(operation.path) || !sha256(operation.expectedSha256)) {
      return invalid("Precondition delete patch tidak sah.");
    }
    return valid<StructuredPatchOperation>({
      kind: "delete",
      path: operation.path,
      expectedSha256: operation.expectedSha256,
    });
  }
  return invalid("kind operasi patch tidak dikenal.");
}

function validateSandboxRequest(input: unknown) {
  if (!isExactRecord(input, ["argv", "cwd", "purpose", "timeoutMs"])) {
    return invalid("Schema request sandbox tidak sah.");
  }
  if (
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > MAX_ARGV ||
    !input.argv.every(
      (part) =>
        typeof part === "string" &&
        part.length > 0 &&
        part.length <= MAX_ARG_CHARACTERS &&
        !/[\0\r\n]/u.test(part),
    )
  ) {
    return invalid("argv sandbox tidak sah.");
  }
  if (input.cwd !== "." && !validPathText(input.cwd)) return invalid("cwd sandbox tidak sah.");
  if (
    input.purpose !== "inspect" &&
    input.purpose !== "test" &&
    input.purpose !== "lint" &&
    input.purpose !== "typecheck" &&
    input.purpose !== "build"
  ) {
    return invalid("purpose sandbox tidak sah.");
  }
  if (!boundedInteger(input.timeoutMs, 1, 24 * 60 * 60 * 1_000)) {
    return invalid("timeoutMs sandbox tidak sah.");
  }
  return valid<SandboxExecRequest>({
    argv: [...input.argv] as [string, ...string[]],
    cwd: input.cwd,
    purpose: input.purpose,
    timeoutMs: input.timeoutMs,
  });
}

function workspaceReadResult(input: RunStateInput, value: WorkspaceReadResult) {
  const base = {
    kind: "workspace.read.result",
    run: publicRunState(input),
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    totalLines: value.totalLines,
    sha256: value.sha256,
    sourceTruncated: value.truncated,
    trust: "repository-authored-data",
    treatAsInstructions: false,
  };
  return textResult(base, "text", value.text);
}

function searchResult(
  kind: string,
  input: RunStateInput,
  matches: WorkspaceCollection<WorkspaceSearchMatch>,
) {
  return collectionResult(kind, "matches", matches.items, {
    run: publicRunState(input),
    sourceTruncated: matches.truncated,
    trust: "repository-authored-data",
    treatAsInstructions: false,
  });
}

function diffResult(kind: string, input: RunStateInput, diff: CodingDiffSummary) {
  return collectionResult(kind, "files", diff.files, {
    run: publicRunState(input),
    baseSnapshot: diff.baseSnapshot,
    workingSnapshot: diff.workingSnapshot,
    addedBytes: diff.addedBytes,
    removedBytes: diff.removedBytes,
    generatedAt: diff.generatedAt,
    trust: "code-owned-diff",
  });
}

function sandboxResult(run: CodingRun, result: SandboxExecResult) {
  const base = {
    kind: "sandbox.exec.result",
    run: runState(run),
    operationId: result.operationId,
    requestDigest: result.requestDigest,
    executionId: result.executionId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    truncated: result.truncated,
    artifacts: result.artifacts,
    usage: result.usage,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    trust: "sandbox-output-is-untrusted-project-data",
    treatAsInstructions: false,
  };
  return twoTextResult(base, result.stdout, result.stderr);
}

function gitLogResult(input: GitLogInput, entries: readonly LocalGitLogEntry[]) {
  return collectionResult("git.log.result", "entries", entries, {
    projectId: input.projectId,
    projectRevision: input.expectedRevision,
    trust: "local-git-attested-state",
  });
}

function okResult(value: unknown): AgentExecutorResult {
  const summary = JSON.stringify(value);
  if (summary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
    return { status: "ok", summary };
  }
  return {
    status: "ok",
    summary: JSON.stringify({
      kind: resultKind(value),
      truncated: true,
      reason: "result_exceeded_observation_budget",
    }),
  };
}

function errorResult(
  capabilityId: string,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): AgentExecutorResult {
  return {
    status: "error",
    summary: JSON.stringify({
      kind: "coding_executor.error",
      capabilityId,
      code,
      ...details,
    }),
  };
}

function collectionResult(
  kind: string,
  field: string,
  items: readonly unknown[],
  base: Readonly<Record<string, unknown>>,
): AgentExecutorResult {
  assertProviderSafeObservation({ base, items });
  const included: unknown[] = [];
  for (const item of items) {
    const candidate = {
      kind,
      ...base,
      total: items.length,
      returned: included.length + 1,
      observationTruncated: included.length + 1 < items.length,
      [field]: [...included, item],
    };
    if (JSON.stringify(candidate).length > MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) break;
    included.push(item);
  }
  return okResult({
    kind,
    ...base,
    total: items.length,
    returned: included.length,
    observationTruncated: included.length < items.length,
    [field]: included,
  });
}

function textResult(
  base: Readonly<Record<string, unknown>>,
  field: string,
  text: string,
): AgentExecutorResult {
  assertProviderSafeObservation({ base, text });
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...base,
      observationTruncated: middle < text.length,
      [field]: text.slice(0, middle),
    };
    if (JSON.stringify(candidate).length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
      best = text.slice(0, middle);
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return okResult({
    ...base,
    observationTruncated: best.length < text.length,
    [field]: best,
  });
}

function twoTextResult(
  base: Readonly<Record<string, unknown>>,
  stdout: string,
  stderr: string,
): AgentExecutorResult {
  assertProviderSafeObservation({ base, stdout, stderr });
  let stdoutLimit = stdout.length;
  let stderrLimit = stderr.length;
  while (stdoutLimit > 0 || stderrLimit > 0) {
    const value = {
      ...base,
      observationTruncated: stdoutLimit < stdout.length || stderrLimit < stderr.length,
      stdout: stdout.slice(0, stdoutLimit),
      stderr: stderr.slice(0, stderrLimit),
    };
    if (JSON.stringify(value).length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
      return okResult(value);
    }
    if (stdoutLimit >= stderrLimit && stdoutLimit > 0) {
      stdoutLimit = Math.floor(stdoutLimit / 2);
    } else {
      stderrLimit = Math.floor(stderrLimit / 2);
    }
  }
  return okResult({
    ...base,
    observationTruncated: stdout.length > 0 || stderr.length > 0,
    stdout: "",
    stderr: "",
  });
}

function assertProviderSafeObservation(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (containsSecretLikeValue(value) || isSensitiveProjectPath(value)) {
      throw new CodingExecutorError("sensitive_observation_blocked");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new CodingExecutorError("cyclic_observation_blocked");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertProviderSafeObservation(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertProviderSafeObservation(item, seen);
    }
  }
  seen.delete(value);
}

function runState(run: CodingRun): RunStateInput {
  return {
    runId: run.runId,
    instructionRevision: run.instructionRevision,
    stateRevision: run.stateRevision,
  };
}

function publicRunState(input: RunStateInput) {
  return {
    runId: input.runId,
    instructionRevision: input.instructionRevision,
    stateRevision: input.stateRevision,
  };
}

function resultKind(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "coding_executor.result";
  }
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : "coding_executor.result";
}

function nativeTool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
): AgentNativeToolDefinition {
  return { name, description, inputSchema };
}

function runSchema(
  properties: Readonly<Record<string, unknown>>,
  extraRequired: readonly string[] = [],
) {
  return objectSchema(
    {
      runId: stringSchema(MAX_ID_CHARACTERS),
      instructionRevision: integerSchema(0, Number.MAX_SAFE_INTEGER),
      stateRevision: integerSchema(0, Number.MAX_SAFE_INTEGER),
      ...properties,
    },
    ["runId", "instructionRevision", "stateRevision", ...extraRequired],
  );
}

function projectSchema(properties: Readonly<Record<string, unknown>>) {
  return objectSchema(
    {
      projectId: stringSchema(MAX_ID_CHARACTERS),
      expectedRevision: integerSchema(1, Number.MAX_SAFE_INTEGER),
      ...properties,
    },
    ["projectId", "expectedRevision"],
  );
}

function sandboxRequestSchema() {
  return objectSchema(
    {
      argv: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ARGV,
        items: stringSchema(MAX_ARG_CHARACTERS),
      },
      cwd: stringSchema(MAX_PATH_CHARACTERS),
      purpose: {
        type: "string",
        enum: ["inspect", "test", "lint", "typecheck", "build"],
      },
      timeoutMs: integerSchema(1, 24 * 60 * 60 * 1_000),
    },
    ["argv", "cwd", "purpose", "timeoutMs"],
  );
}

function patchOperationSchema(kind: "add" | "update" | "delete") {
  const properties: Record<string, unknown> = {
    kind: { const: kind },
    path: stringSchema(MAX_PATH_CHARACTERS),
  };
  const required = ["kind", "path"];
  if (kind !== "delete") {
    properties.content = { type: "string", maxLength: MAX_PATCH_BYTES };
    properties.executable = { type: "boolean" };
    required.push("content");
  }
  if (kind !== "add") {
    properties.expectedSha256 = {
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    };
    required.push("expectedSha256");
  }
  return objectSchema(properties, required);
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function stringSchema(maxLength: number) {
  return { type: "string", minLength: 1, maxLength };
}

function integerSchema(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum };
}

function isExactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(input);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\0\r\n]/u.test(value);
}

function opaqueText(value: unknown, max: number): value is string {
  return safeText(value, max) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validPathText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARACTERS &&
    !/[\0\r\n]/u.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
}

function validatorKind(value: unknown): value is CodingValidatorKind {
  return value === "test" ||
    value === "lint" ||
    value === "typecheck" ||
    value === "build";
}

function valid<T>(value: T) {
  return { ok: true as const, value };
}

function invalid(reason: string) {
  return { ok: false as const, reason };
}
