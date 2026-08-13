import { createHash } from "node:crypto";
import type {
  MemoryGraphProjection,
  MemoryKnowledgeState,
  RetrievedMemoryEvidence,
} from "../domain/memory-knowledge.js";
import type { WorkspacePermission } from "../domain/workspace.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import {
  MemoryKnowledgeService,
  type MemoryConsolidationCandidate,
  type MemoryConsolidationResult,
} from "./memory-knowledge-service.js";
import { projectMemoryNamespace } from "./memory-namespace.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import { containsSecretLikeValue } from "../security/credential-like.js";

export interface ProjectMemoryCandidate {
  kind: "fact" | "procedure";
  subject: string;
  predicate: string;
  value: string;
  displayText: string;
  confidence?: number;
  /** Opaque durable receipts. Procedures require at least two verified refs. */
  sourceEvidenceIds?: string[];
  graphProjection?: MemoryGraphProjection | null;
}

export interface ProjectMemoryEvidenceVerifier {
  verify(
    scope: WorkspaceAgentScope,
    projectId: string,
    projectRevision: number,
    evidenceIds: readonly string[],
  ): Promise<boolean>;
}

/**
 * ACL facade for project-scoped semantic memory. The caller never supplies a
 * namespace or owner id; both are derived from a fresh WorkspaceAgentScope and
 * an existing ProjectWorkspace.
 */
export class ProjectMemoryService {
  constructor(
    private readonly knowledge: MemoryKnowledgeService,
    private readonly projects: ProjectWorkspaceService,
    private readonly authority: WorkspaceAuthorityService,
    private readonly evidenceVerifier: ProjectMemoryEvidenceVerifier | null = null,
  ) {}

  async remember(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedProjectRevision: number,
    candidates: readonly ProjectMemoryCandidate[],
  ): Promise<MemoryConsolidationResult> {
    await this.requirePermission(scope, "code.write");
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 32) {
      throw new Error("Kandidat project memory wajib berjumlah 1 sampai 32.");
    }
    return this.projects.withFreshProject(
      scope,
      projectId,
      expectedProjectRevision,
      "code.write",
      async (project) => {
      const normalized: MemoryConsolidationCandidate[] = [];
      for (const [index, candidate] of candidates.entries()) {
        const kind = candidate.kind;
        if (kind !== "fact" && kind !== "procedure") {
          throw new Error("Jenis project memory tidak sah.");
        }
        const predicate = bounded(candidate.predicate, 256, "predicate");
        const value = bounded(candidate.value, 2_000, "value");
        const evidenceIds: string[] = [...new Set<string>(
          (candidate.sourceEvidenceIds ?? []).map(
            (item: string) => bounded(item, 512, "evidenceId"),
          ),
        )];
        if (kind === "procedure") {
          if (
            evidenceIds.length < 2 ||
            !this.evidenceVerifier ||
            !await this.evidenceVerifier.verify(
              scope,
              project.id,
              project.revision,
              evidenceIds,
            )
          ) {
            throw new Error("Procedural project memory memerlukan sedikitnya dua evidence terverifikasi.");
          }
        }
        normalized.push({
          subject: bounded(candidate.subject, 256, "subject"),
          predicate: kind === "procedure" ? `procedure:${predicate}` : predicate,
          value,
          displayText: bounded(candidate.displayText, 2_000, "displayText"),
          confidence: confidence(candidate.confidence),
          sourceMemoryId: projectMemorySourceId(
            scope.workspaceKey,
            project.id,
            expectedProjectRevision,
            index,
            {
              kind,
              subject: candidate.subject,
              predicate,
              value,
              displayText: candidate.displayText,
              evidenceIds,
            },
          ),
          sensitivity: "normal" as const,
          provenance: kind === "procedure" ? "observed" as const : "asserted" as const,
          correction: false,
          graphProjection: candidate.graphProjection === undefined
            ? {
                from: {
                  type: "project" as const,
                  canonicalName: project.id,
                  aliases: [],
                },
                relation: kind === "procedure" ? `procedure:${predicate}` : predicate,
                scalarValue: value,
              }
            : structuredClone(candidate.graphProjection),
        });
      }
      return this.knowledge.consolidate(
        projectMemoryNamespace(scope.workspaceKey, project.id),
        normalized,
        { sensitiveConsent: false },
      );
      },
    );
  }

  async searchGraph(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedProjectRevision: number,
    query: string,
    limit = 8,
  ): Promise<RetrievedMemoryEvidence[]> {
    await this.requirePermission(scope, "code.read");
    return this.projects.withFreshProject(
      scope,
      projectId,
      expectedProjectRevision,
      "code.read",
      (project) => this.knowledge.searchGraph(
        projectMemoryNamespace(scope.workspaceKey, project.id),
        bounded(query, 500, "query"),
        { limit: boundedLimit(limit) },
      ),
    );
  }

  async snapshot(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedProjectRevision: number,
  ): Promise<MemoryKnowledgeState | null> {
    await this.requirePermission(scope, "code.read");
    return this.projects.withFreshProject(
      scope,
      projectId,
      expectedProjectRevision,
      "code.read",
      (project) => this.knowledge.snapshot(
        projectMemoryNamespace(scope.workspaceKey, project.id),
      ),
    );
  }

  private async requirePermission(
    scope: WorkspaceAgentScope,
    permission: WorkspacePermission,
  ): Promise<void> {
    if (!await this.authority.authorize(scope, permission)) {
      throw new Error(`Izin workspace ${permission} untuk project memory tidak tersedia atau basi.`);
    }
  }
}

function bounded(value: unknown, max: number, field: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (
    !clean ||
    clean.length > max ||
    /\p{Cc}/u.test(clean.replace(/[\r\n\t]/gu, "")) ||
    containsSecretLikeValue(clean)
  ) throw new Error(`${field} project memory tidak sah atau menyerupai credential.`);
  return clean;
}

function confidence(value: number | undefined): number {
  const resolved = value ?? 1;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error("Confidence project memory tidak sah.");
  }
  return resolved;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new Error("Limit project memory tidak sah.");
  }
  return value;
}

function projectMemorySourceId(
  workspaceKey: string,
  projectId: string,
  projectRevision: number,
  index: number,
  value: unknown,
): string {
  return `project-memory-${createHash("sha256")
    .update(JSON.stringify({ workspaceKey, projectId, projectRevision, index, value }), "utf8")
    .digest("hex")}`;
}
