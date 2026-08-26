import { randomUUID } from "node:crypto";
import type {
  ProjectGoal,
  ProjectGoalCriterionKind,
  ProjectGoalEvidence,
  ProjectIntentRepository,
  ProjectSkill,
  ProjectSkillDefinition,
  ProjectSkillVersion,
} from "../domain/project-intent.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import type { WorkspaceAuthorityService } from "./workspace-authority-service.js";
import type { ProjectWorkspaceService } from "./project-workspace-service.js";

export interface SetProjectGoalInput {
  objective: string;
  acceptanceCriteria: Array<{ kind: ProjectGoalCriterionKind; text: string }>;
  milestones?: string[];
}

export interface SaveProjectSkillInput extends ProjectSkillDefinition {
  sourceEvidenceRefs: string[];
}

const MAX_CAS_ATTEMPTS = 5;

/**
 * Durable goal/skill boundary. Scope always comes from trusted Workspace
 * authority; neither a model nor command body may supply owner identity.
 */
export class ProjectIntentService {
  readonly #availableSkillTools: ReadonlySet<string>;

  constructor(
    private readonly repository: ProjectIntentRepository,
    private readonly authority: WorkspaceAuthorityService,
    private readonly projects: ProjectWorkspaceService,
    availableSkillTools: readonly string[],
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {
    this.#availableSkillTools = new Set(availableSkillTools.map(toolRequirement));
  }

  async goal(scope: WorkspaceAgentScope, projectId: string): Promise<ProjectGoal | null> {
    await this.requireProject(scope, projectId, false);
    const goal = await this.repository.loadGoal(projectId);
    return goal?.ownerWorkspaceKey === scope.workspaceKey ? goal : null;
  }

  async setGoal(
    scope: WorkspaceAgentScope,
    projectId: string,
    input: SetProjectGoalInput,
  ): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    const normalized = goalInput(input);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.repository.loadGoal(projectId);
      if (current && current.ownerWorkspaceKey !== scope.workspaceKey) {
        throw new Error("Goal project berada di Workspace lain.");
      }
      const at = this.now().toISOString();
      const next: Omit<ProjectGoal, "revision"> = current
        ? {
            ...withoutRevision(current),
            objective: normalized.objective,
            acceptanceCriteria: normalized.acceptanceCriteria.map((criterion) => ({
              id: opaqueId("criterion", this.makeId()),
              ...criterion,
              status: "pending",
              evidenceRefs: [],
            })),
            milestones: normalized.milestones.map((title) => ({
              id: opaqueId("milestone", this.makeId()),
              title,
              status: "pending",
              evidenceRefs: [],
            })),
            blockers: current.blockers.map((blocker) =>
              blocker.status === "open"
                ? { ...blocker, status: "resolved" as const, resolvedAt: at }
                : blocker
            ),
            status: "active",
            decisions: [...current.decisions, {
              id: opaqueId("decision", this.makeId()),
              summary: "Tujuan proyek diperbarui oleh pengguna.",
              rationale: "Objective atau kriteria penerimaan baru menggantikan kontrak goal sebelumnya.",
              decidedAt: at,
            }],
            updatedAt: at,
          }
        : {
            version: 1,
            goalId: opaqueId("goal", this.makeId()),
            ownerWorkspaceKey: scope.workspaceKey,
            projectId,
            objective: normalized.objective,
            acceptanceCriteria: normalized.acceptanceCriteria.map((criterion) => ({
              id: opaqueId("criterion", this.makeId()),
              ...criterion,
              status: "pending",
              evidenceRefs: [],
            })),
            milestones: normalized.milestones.map((title) => ({
              id: opaqueId("milestone", this.makeId()),
              title,
              status: "pending",
              evidenceRefs: [],
            })),
            decisions: [],
            blockers: [],
            evidence: [],
            status: "active",
            createdAt: at,
            updatedAt: at,
          };
      const saved = await this.repository.saveGoal(next, current?.revision ?? null);
      if (saved.status === "saved") return saved.value;
    }
    throw new Error("Goal project berubah bersamaan; coba lagi.");
  }

  async recordEvidence(
    scope: WorkspaceAgentScope,
    projectId: string,
    input: {
      ref: string;
      kind: ProjectGoalEvidence["kind"];
      summary: string;
      satisfyKinds?: ProjectGoalCriterionKind[];
      satisfyCriterionIds?: string[];
    },
  ): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    const evidenceBase: Omit<ProjectGoalEvidence, "recordedAt"> = {
      ref: evidenceRef(input.ref),
      kind: input.kind,
      summary: safeText(input.summary, 2_000, "ringkasan evidence"),
    };
    const kinds = new Set(input.satisfyKinds ?? []);
    const ids = new Set((input.satisfyCriterionIds ?? []).map((id) => safeKey(id, "criterion id")));
    return this.updateGoal(scope, projectId, (current) => {
      const existing = current.evidence.find((item) => item.ref === evidenceBase.ref);
      if (existing && (
        existing.kind !== evidenceBase.kind || existing.summary !== evidenceBase.summary
      )) {
        throw new Error("Evidence ref goal sudah dipakai untuk fakta lain.");
      }
      const evidence: ProjectGoalEvidence = existing ?? {
        ...evidenceBase,
        recordedAt: this.now().toISOString(),
      };
      const allEvidence = existing ? current.evidence : [...current.evidence, evidence];
      const criteria = current.acceptanceCriteria.map((criterion) => {
        if (!kinds.has(criterion.kind) && !ids.has(criterion.id)) return criterion;
        return {
          ...criterion,
          status: "met" as const,
          evidenceRefs: criterion.evidenceRefs.includes(evidence.ref)
            ? criterion.evidenceRefs
            : [...criterion.evidenceRefs, evidence.ref],
        };
      });
      const milestones = current.milestones.map((milestone, index) =>
        index === current.milestones.findIndex((item) => item.status === "in_progress" || item.status === "pending")
          ? {
              ...milestone,
              status: "completed" as const,
              evidenceRefs: milestone.evidenceRefs.includes(evidence.ref)
                ? milestone.evidenceRefs
                : [...milestone.evidenceRefs, evidence.ref],
            }
          : milestone
      );
      return { ...current, evidence: allEvidence, acceptanceCriteria: criteria, milestones };
    });
  }

  async startMilestone(scope: WorkspaceAgentScope, projectId: string): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    return this.updateGoal(scope, projectId, (current) => {
      const index = current.milestones.findIndex((item) => item.status === "pending");
      if (index < 0) return current;
      return {
        ...current,
        milestones: current.milestones.map((item, candidate) =>
          candidate === index ? { ...item, status: "in_progress" as const } : item
        ),
      };
    });
  }

  async addBlocker(
    scope: WorkspaceAgentScope,
    projectId: string,
    summaryInput: string,
  ): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    const summary = safeText(summaryInput, 2_000, "blocker");
    return this.updateGoal(scope, projectId, (current) => ({
      ...current,
      blockers: [...current.blockers, {
        id: opaqueId("blocker", this.makeId()),
        summary,
        status: "open",
        createdAt: this.now().toISOString(),
        resolvedAt: null,
      }],
      status: "blocked",
    }));
  }

  async resolveBlocker(
    scope: WorkspaceAgentScope,
    projectId: string,
    blockerIdInput: string,
  ): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    const blockerId = safeKey(blockerIdInput, "blocker id");
    return this.updateGoal(scope, projectId, (current) => {
      if (!current.blockers.some((item) => item.id === blockerId)) {
        throw new Error("Blocker goal tidak ditemukan.");
      }
      const blockers = current.blockers.map((item) =>
        item.id === blockerId && item.status === "open"
          ? { ...item, status: "resolved" as const, resolvedAt: this.now().toISOString() }
          : item
      );
      return {
        ...current,
        blockers,
        status: blockers.some((item) => item.status === "open") ? "blocked" : "active",
      };
    });
  }

  async resolveBlockerByQuery(
    scope: WorkspaceAgentScope,
    projectId: string,
    queryInput: string,
  ): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    const query = safeText(queryInput, 1_000, "rujukan blocker");
    const goal = await this.goal(scope, projectId);
    if (!goal) throw new Error("Goal project belum dibuat.");
    const normalized = normalizedReference(query);
    const open = goal.blockers.filter((blocker) => blocker.status === "open");
    const exact = open.filter((blocker) =>
      blocker.id === query || normalizedReference(blocker.summary) === normalized
    );
    const partial = exact.length > 0 ? exact : open.filter((blocker) => {
      const summary = normalizedReference(blocker.summary);
      return summary.includes(normalized) || normalized.includes(summary);
    });
    if (partial.length !== 1) {
      throw new Error(
        partial.length === 0
          ? "Blocker terbuka yang dimaksud tidak ditemukan."
          : "Rujukan blocker ambigu; sebutkan hambatannya lebih spesifik.",
      );
    }
    return this.resolveBlocker(scope, projectId, partial[0]!.id);
  }

  async completeGoal(scope: WorkspaceAgentScope, projectId: string): Promise<ProjectGoal> {
    await this.requireProject(scope, projectId, true);
    return this.updateGoal(scope, projectId, (current) => {
      if (current.acceptanceCriteria.some((criterion) => criterion.status !== "met")) {
        throw new Error("Goal belum dapat selesai: masih ada acceptance criterion tanpa evidence.");
      }
      if (current.blockers.some((blocker) => blocker.status === "open")) {
        throw new Error("Goal belum dapat selesai: masih ada blocker terbuka.");
      }
      return { ...current, status: "completed" };
    });
  }

  async createSkill(
    scope: WorkspaceAgentScope,
    projectId: string,
    input: SaveProjectSkillInput,
  ): Promise<ProjectSkill> {
    await this.requireProject(scope, projectId, true);
    const definition = skillDefinition(input);
    this.assertSkillTools(definition.toolRequirements);
    await this.assertEvidenceRefs(projectId, input.sourceEvidenceRefs);
    const existing = (await this.repository.listSkills(projectId)).find((skill) =>
      currentSkill(skill).name.toLocaleLowerCase("id") === definition.name.toLocaleLowerCase("id")
    );
    if (existing) throw new Error("Nama skill sudah digunakan pada project ini.");
    const at = this.now().toISOString();
    const version: ProjectSkillVersion = {
      ...definition,
      version: 1,
      sourceEvidenceRefs: input.sourceEvidenceRefs.map(evidenceRef),
      createdAt: at,
    };
    const saved = await this.repository.saveSkill({
      version: 1,
      skillId: opaqueId("skill", this.makeId()),
      ownerWorkspaceKey: scope.workspaceKey,
      projectId,
      status: "active",
      versions: [version],
      createdAt: at,
      updatedAt: at,
    }, null);
    if (saved.status !== "saved") throw new Error("Skill berubah bersamaan; coba lagi.");
    return saved.value;
  }

  async updateSkill(
    scope: WorkspaceAgentScope,
    projectId: string,
    skillIdInput: string,
    input: SaveProjectSkillInput,
  ): Promise<ProjectSkill> {
    await this.requireProject(scope, projectId, true);
    const skillId = safeKey(skillIdInput, "skill id");
    const definition = skillDefinition(input);
    this.assertSkillTools(definition.toolRequirements);
    await this.assertEvidenceRefs(projectId, input.sourceEvidenceRefs);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.requireSkill(scope, projectId, skillId);
      const at = this.now().toISOString();
      const saved = await this.repository.saveSkill({
        ...withoutRevision(current),
        status: "active",
        versions: [...current.versions, {
          ...definition,
          version: current.versions.length + 1,
          sourceEvidenceRefs: input.sourceEvidenceRefs.map(evidenceRef),
          createdAt: at,
        }],
        updatedAt: at,
      }, current.revision);
      if (saved.status === "saved") return saved.value;
    }
    throw new Error("Skill berubah bersamaan; coba lagi.");
  }

  async listSkills(scope: WorkspaceAgentScope, projectId: string): Promise<ProjectSkill[]> {
    await this.requireProject(scope, projectId, false);
    return (await this.repository.listSkills(projectId))
      .filter((skill) => skill.ownerWorkspaceKey === scope.workspaceKey);
  }

  async latestEvidenceRefs(
    scope: WorkspaceAgentScope,
    projectId: string,
    maximum = 1,
  ): Promise<string[]> {
    await this.requireProject(scope, projectId, false);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8) {
      throw new Error("Batas evidence skill tidak sah.");
    }
    const goal = await this.repository.loadGoal(projectId);
    if (!goal || goal.ownerWorkspaceKey !== scope.workspaceKey) return [];
    return goal.evidence.slice(-maximum).map((item) => item.ref);
  }

  async skillForApply(
    scope: WorkspaceAgentScope,
    projectId: string,
    nameOrIdInput: string,
  ): Promise<ProjectSkillVersion> {
    await this.requireProject(scope, projectId, false);
    const query = safeText(nameOrIdInput, 80, "nama skill").toLocaleLowerCase("id");
    const matches = (await this.listSkills(scope, projectId)).filter((skill) => {
      const version = currentSkill(skill);
      return skill.status === "active" && (
        skill.skillId.toLocaleLowerCase("id") === query ||
        version.name.toLocaleLowerCase("id") === query
      );
    });
    if (matches.length !== 1) throw new Error("Skill aktif tidak ditemukan atau ambigu.");
    const version = currentSkill(matches[0]!);
    this.assertSkillTools(version.toolRequirements);
    return structuredClone(version);
  }

  async setSkillActive(
    scope: WorkspaceAgentScope,
    projectId: string,
    skillIdInput: string,
    active: boolean,
  ): Promise<ProjectSkill> {
    await this.requireProject(scope, projectId, true);
    const skillId = safeKey(skillIdInput, "skill id");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.requireSkill(scope, projectId, skillId);
      const saved = await this.repository.saveSkill({
        ...withoutRevision(current),
        status: active ? "active" : "inactive",
        updatedAt: this.now().toISOString(),
      }, current.revision);
      if (saved.status === "saved") return saved.value;
    }
    throw new Error("Skill berubah bersamaan; coba lagi.");
  }

  async removeSkill(
    scope: WorkspaceAgentScope,
    projectId: string,
    skillIdInput: string,
  ): Promise<void> {
    await this.requireProject(scope, projectId, true);
    const skill = await this.requireSkill(scope, projectId, safeKey(skillIdInput, "skill id"));
    const removed = await this.repository.removeSkill(projectId, skill.skillId, skill.revision);
    if (removed === "conflict") throw new Error("Skill berubah bersamaan; coba lagi.");
  }

  purgeProject(projectId: string): Promise<void> {
    return this.repository.removeProject(safeKey(projectId, "project id"));
  }

  private async updateGoal(
    scope: WorkspaceAgentScope,
    projectId: string,
    mutate: (current: ProjectGoal) => ProjectGoal,
  ): Promise<ProjectGoal> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.repository.loadGoal(projectId);
      if (!current || current.ownerWorkspaceKey !== scope.workspaceKey) {
        throw new Error("Goal project belum dibuat.");
      }
      const changed = mutate(structuredClone(current));
      const saved = await this.repository.saveGoal({
        ...withoutRevision(changed),
        updatedAt: this.now().toISOString(),
      }, current.revision);
      if (saved.status === "saved") return saved.value;
    }
    throw new Error("Goal project berubah bersamaan; coba lagi.");
  }

  private async requireProject(
    scope: WorkspaceAgentScope,
    projectIdInput: string,
    write: boolean,
  ): Promise<void> {
    const projectId = safeKey(projectIdInput, "project id");
    const permissions = write ? ["code.write"] as const : ["code.read"] as const;
    await this.authority.withPermissions(scope, permissions, async () => {
      const project = await this.projects.get(scope, projectId);
      if (!project) throw new Error("Project tidak tersedia pada Workspace ini.");
    });
  }

  private async requireSkill(
    scope: WorkspaceAgentScope,
    projectId: string,
    skillId: string,
  ): Promise<ProjectSkill> {
    const skill = await this.repository.loadSkill(projectId, skillId);
    if (!skill || skill.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("Skill project tidak ditemukan.");
    }
    return skill;
  }

  private assertSkillTools(requirements: readonly string[]): void {
    const missing = requirements.filter((item) => !this.#availableSkillTools.has(item));
    if (missing.length > 0) {
      throw new Error(`Skill meminta capability yang tidak tersedia: ${missing.join(", ")}.`);
    }
  }

  private async assertEvidenceRefs(projectId: string, refs: readonly string[]): Promise<void> {
    const goal = await this.repository.loadGoal(projectId);
    const available = new Set(goal?.evidence.map((item) => item.ref) ?? []);
    for (const ref of refs.map(evidenceRef)) {
      if (!available.has(ref)) throw new Error("Skill harus berasal dari evidence goal yang terbukti.");
    }
  }
}

export function currentSkill(skill: ProjectSkill): ProjectSkillVersion {
  const current = skill.versions.at(-1);
  if (!current) throw new Error("Skill tidak mempunyai versi current.");
  return current;
}

function goalInput(input: SetProjectGoalInput): Required<SetProjectGoalInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Goal input tidak sah.");
  const objective = safeText(input.objective, 4_000, "objective");
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.length > 64) {
    throw new Error("Goal memerlukan 1–64 acceptance criteria.");
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !["code", "github", "manual"].includes(item.kind)) {
      throw new Error("Acceptance criterion goal tidak sah.");
    }
    return { kind: item.kind, text: safeText(item.text, 2_000, "acceptance criterion") };
  });
  const milestones = (input.milestones ?? []).map((item) => safeText(item, 1_000, "milestone"));
  if (milestones.length > 64) throw new Error("Jumlah milestone goal melampaui batas.");
  return { objective, acceptanceCriteria, milestones };
}

function skillDefinition(input: SaveProjectSkillInput): ProjectSkillDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill input tidak sah.");
  return {
    name: safeText(input.name, 80, "nama skill"),
    description: safeText(input.description, 1_000, "deskripsi skill"),
    semanticTriggers: safeTextList(input.semanticTriggers, 24, 240, "trigger skill"),
    preconditions: safeTextList(input.preconditions, 24, 1_000, "precondition skill"),
    steps: requiredTextList(input.steps, 64, 1_500, "langkah skill"),
    toolRequirements: safeTextList(input.toolRequirements, 24, 128, "tool skill").map(toolRequirement),
    verification: requiredTextList(input.verification, 32, 1_000, "verifikasi skill"),
  };
}

function safeTextList(value: unknown, maximum: number, characters: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} tidak sah.`);
  const result = value.map((item) => safeText(item, characters, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} duplikat.`);
  return result;
}

function requiredTextList(value: unknown, maximum: number, characters: number, label: string): string[] {
  const result = safeTextList(value, maximum, characters, label);
  if (result.length === 0) throw new Error(`${label} wajib diisi.`);
  return result;
}

function toolRequirement(value: unknown): string {
  const tool = safeText(value, 128, "tool requirement");
  if (!/^[a-z][a-z0-9_.-]{2,127}$/u.test(tool)) throw new Error("Tool requirement skill tidak sah.");
  return tool;
}

function safeText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /\p{Cc}/u.test(value) || containsSecretLikeValue(value)) {
    throw new Error(`${label} tidak sah atau credential-like.`);
  }
  return value.trim();
}

function safeKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{3,512}$/u.test(value) || containsSecretLikeValue(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  return value;
}

function evidenceRef(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{3,512}$/u.test(value) || containsSecretLikeValue(value)) {
    throw new Error("Evidence ref tidak sah.");
  }
  return value;
}

function normalizedReference(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("id").replaceAll(/\s+/gu, " ").trim();
}

function opaqueId(prefix: string, raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 128);
  if (!clean) throw new Error("Generator id project intent tidak sah.");
  return `${prefix}-${clean}`;
}

function withoutRevision<T extends { revision: number }>(value: T): Omit<T, "revision"> {
  const { revision: _revision, ...rest } = value;
  return rest;
}
