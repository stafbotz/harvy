import { createHash } from "node:crypto";
import type {
  CodingRun,
  CodingRunStartOptions,
  CodingTaskBrief,
} from "../domain/coding-run.js";
import type { WorkspacePrincipal } from "../domain/workspace.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Opaque handle constructed by an authenticated ingress/account link. */
export interface AuthenticatedWorkspaceActor {
  readonly __workspaceActorHandle: unique symbol;
}

export interface ResolvedWorkspaceActor {
  principal: WorkspacePrincipal;
  interactionId: string;
  audience: "workspace-private" | "group";
}

/** The controller never deserializes a principal from a command/body. */
export interface WorkspaceActorResolver {
  resolve(actor: AuthenticatedWorkspaceActor): Promise<ResolvedWorkspaceActor | null>;
}

export interface UploadWorkspaceZipCommand {
  workspaceKey: string;
  archive: Buffer;
}

export interface CreateCodingRunCommand {
  workspaceKey: string;
  projectId: string;
  expectedProjectRevision: number;
  brief: CodingTaskBrief;
}

export interface UploadedProjectView {
  projectId: string;
  revision: number;
  snapshotId: string;
  archiveSha256: string;
}

export interface CreatedCodingRunView {
  runId: string;
  projectId: string;
  workspaceRevision: number;
  stateRevision: number;
  status: CodingRun["status"];
  phase: CodingRun["phase"];
}

export interface CodingRunCreator {
  start(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedWorkspaceRevision: number,
    brief: CodingTaskBrief,
    options?: CodingRunStartOptions,
  ): Promise<CodingRun>;
}

/**
 * Application boundary for a future trusted Workspace UI. It never accepts a
 * WorkspaceAgentScope, role, permission, conversation history, HarvyContext,
 * memory, or transcript from the command body.
 */
export class WorkspaceCodingController {
  constructor(
    private readonly authority: WorkspaceAuthorityService,
    private readonly actors: WorkspaceActorResolver,
    private readonly projects: ProjectWorkspaceService,
    private readonly codingRuns: CodingRunCreator,
  ) {}

  async uploadZip(
    actorInput: AuthenticatedWorkspaceActor,
    commandInput: UploadWorkspaceZipCommand,
  ): Promise<UploadedProjectView> {
    const { principal } = await this.resolveActor(actorInput);
    assertExactKeys(commandInput, ["workspaceKey", "archive"], "upload command");
    const workspaceKey = safeKey(commandInput.workspaceKey, "workspaceKey");
    if (
      !Buffer.isBuffer(commandInput.archive) ||
      commandInput.archive.byteLength < 1 ||
      commandInput.archive.byteLength > MAX_UPLOAD_BYTES
    ) {
      throw new WorkspaceCodingControllerError(
        "workspace_upload_invalid",
        "Archive workspace kosong, bukan Buffer, atau melewati 32 MiB.",
      );
    }
    const scope = await this.resolveScope(workspaceKey, principal);
    return this.authority.withPermissions(
      scope,
      ["artifact.write", "code.write"],
      async () => {
        const project = await this.projects.createFromUpload(
          scope,
          commandInput.archive,
        );
        if (project.source.type !== "upload") {
          throw new WorkspaceCodingControllerError(
            "workspace_upload_invalid",
            "Project upload menghasilkan source yang tidak sah.",
          );
        }
        return Object.freeze({
          projectId: project.id,
          revision: project.revision,
          snapshotId: project.baseSnapshot,
          archiveSha256: project.source.sha256,
        });
      },
    );
  }

  async createCodingRun(
    actorInput: AuthenticatedWorkspaceActor,
    commandInput: CreateCodingRunCommand,
  ): Promise<CreatedCodingRunView> {
    const { principal } = await this.resolveActor(actorInput);
    assertExactKeys(
      commandInput,
      ["workspaceKey", "projectId", "expectedProjectRevision", "brief"],
      "create run command",
    );
    const workspaceKey = safeKey(commandInput.workspaceKey, "workspaceKey");
    const projectId = safeKey(commandInput.projectId, "projectId");
    if (
      !Number.isSafeInteger(commandInput.expectedProjectRevision) ||
      commandInput.expectedProjectRevision < 1
    ) {
      throw new WorkspaceCodingControllerError(
        "workspace_run_invalid",
        "Expected project revision tidak sah.",
      );
    }
    assertExactTaskBriefShape(commandInput.brief);
    const scope = await this.resolveScope(workspaceKey, principal);
    return this.authority.withPermissions(
      scope,
      ["run.create", "code.read", "code.write"],
      async () => {
        const run = await this.codingRuns.start(
          scope,
          projectId,
          commandInput.expectedProjectRevision,
          structuredClone(commandInput.brief),
        );
        if (
          run.binding.projectId !== projectId ||
          run.binding.ownerWorkspaceKey !== workspaceKey ||
          run.binding.workspaceRevision !== commandInput.expectedProjectRevision
        ) {
          throw new WorkspaceCodingControllerError(
            "workspace_run_invalid",
            "CodingRun result tidak cocok command binding.",
          );
        }
        return Object.freeze({
          runId: run.runId,
          projectId: run.binding.projectId,
          workspaceRevision: run.binding.workspaceRevision,
          stateRevision: run.stateRevision,
          status: run.status,
          phase: run.phase,
        });
      },
    );
  }

  private async resolveScope(
    workspaceKey: string,
    principal: WorkspacePrincipal,
  ): Promise<WorkspaceAgentScope> {
    const scope = await this.authority.resolveScope(workspaceKey, principal);
    if (!scope) {
      throw new WorkspaceCodingControllerError(
        "workspace_access_denied",
        "Workspace tidak tersedia untuk actor ini.",
      );
    }
    return scope;
  }

  private async resolveActor(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<ResolvedWorkspaceActor> {
    const resolved = await this.actors.resolve(actor);
    const principal = resolved?.principal;
    if (
      !resolved ||
      resolved.audience !== "workspace-private" ||
      typeof resolved.interactionId !== "string" ||
      !resolved.interactionId ||
      resolved.interactionId.length > 512 ||
      /\p{Cc}/u.test(resolved.interactionId) ||
      containsSecretLikeValue(resolved.interactionId) ||
      !principal ||
      (principal.channel !== "telegram" && principal.channel !== "whatsapp") ||
      typeof principal.principalKey !== "string" ||
      !/^[a-f0-9]{64}$/u.test(principal.principalKey)
    ) {
      throw new WorkspaceCodingControllerError(
        "workspace_access_denied",
        "Authenticated workspace actor tidak sah.",
      );
    }
    return structuredClone(resolved);
  }
}

export class WorkspaceCodingControllerError extends Error {
  constructor(
    readonly code:
      | "workspace_access_denied"
      | "workspace_upload_invalid"
      | "workspace_run_invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceCodingControllerError";
  }
}

function assertExactTaskBriefShape(value: unknown): asserts value is CodingTaskBrief {
  assertExactKeys(
    value,
    ["request", "objective", "acceptanceCriteria", "initialConstraints"],
    "task brief",
  );
  const brief = value as CodingTaskBrief;
  if (
    !Array.isArray(brief.acceptanceCriteria) ||
    !Array.isArray(brief.initialConstraints) ||
    brief.acceptanceCriteria.length > 64 ||
    brief.initialConstraints.length > 64
  ) {
    throw new WorkspaceCodingControllerError(
      "workspace_run_invalid",
      "Daftar acceptance/constraint CodingRun tidak sah.",
    );
  }
  for (const [field, text] of [
    ["request", brief.request],
    ["objective", brief.objective],
    ...brief.acceptanceCriteria.map((item) => ["acceptanceCriteria", item]),
    ...brief.initialConstraints.map((item) => ["initialConstraints", item]),
  ] as Array<[string, unknown]>) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 8_000 ||
      containsSecretLikeValue(text)
    ) {
      throw new WorkspaceCodingControllerError(
        "workspace_run_invalid",
        `${field} CodingRun tidak sah atau credential-like.`,
      );
    }
  }
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /\p{Cc}/u.test(value) ||
    /[\\/]/u.test(value) ||
    containsSecretLikeValue(value)
  ) {
    throw new WorkspaceCodingControllerError(
      "workspace_access_denied",
      `${field} workspace tidak sah.`,
    );
  }
  return value;
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
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new WorkspaceCodingControllerError(
      "workspace_access_denied",
      `Schema ${label} memuat field asing atau hilang.`,
    );
  }
}

/** Content-free digest helper for a future network idempotency ledger. */
export function workspaceCodingCommandDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return JSON.stringify({
      type: "buffer",
      size: value.byteLength,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
