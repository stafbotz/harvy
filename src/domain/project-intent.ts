export type ProjectGoalStatus = "active" | "blocked" | "completed" | "cancelled";
export type ProjectGoalCriterionKind = "code" | "github" | "manual";

/**
 * Capability yang boleh disebut skill project. Skill hanya dapat menyusun
 * urutan pemakaian capability yang sudah ada; ia tidak memberi izin baru.
 */
export const PROJECT_SKILL_TOOL_IDS = Object.freeze([
  "workspace.tree",
  "workspace.read",
  "workspace.search",
  "workspace.symbols",
  "workspace.references",
  "workspace.diff",
  "workspace.apply_patch",
  "sandbox.exec",
  "sandbox.test",
  "git.status",
  "git.diff",
  "git.log",
  "git.commit",
] as const);

export interface ProjectGoalCriterion {
  id: string;
  kind: ProjectGoalCriterionKind;
  text: string;
  status: "pending" | "met";
  evidenceRefs: string[];
}

export interface ProjectGoalMilestone {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  evidenceRefs: string[];
}

export interface ProjectGoalDecision {
  id: string;
  summary: string;
  rationale: string;
  decidedAt: string;
}

export interface ProjectGoalBlocker {
  id: string;
  summary: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}

export interface ProjectGoalEvidence {
  ref: string;
  kind: "coding_run" | "validator" | "artifact" | "github" | "user_confirmation";
  summary: string;
  recordedAt: string;
}

export interface ProjectGoal {
  version: 1;
  goalId: string;
  ownerWorkspaceKey: string;
  projectId: string;
  revision: number;
  objective: string;
  acceptanceCriteria: ProjectGoalCriterion[];
  milestones: ProjectGoalMilestone[];
  decisions: ProjectGoalDecision[];
  blockers: ProjectGoalBlocker[];
  evidence: ProjectGoalEvidence[];
  status: ProjectGoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSkillDefinition {
  name: string;
  description: string;
  semanticTriggers: string[];
  preconditions: string[];
  steps: string[];
  toolRequirements: string[];
  verification: string[];
}

export interface ProjectSkillVersion extends ProjectSkillDefinition {
  version: number;
  sourceEvidenceRefs: string[];
  createdAt: string;
}

export interface ProjectSkill {
  version: 1;
  skillId: string;
  ownerWorkspaceKey: string;
  projectId: string;
  revision: number;
  status: "active" | "inactive";
  versions: ProjectSkillVersion[];
  createdAt: string;
  updatedAt: string;
}

export type IntentSaveResult<T> =
  | { status: "saved"; value: T }
  | { status: "conflict" };

export interface ProjectIntentRepository {
  loadGoal(projectId: string): Promise<ProjectGoal | null>;
  saveGoal(goal: Omit<ProjectGoal, "revision">, expectedRevision: number | null):
    Promise<IntentSaveResult<ProjectGoal>>;
  loadSkill(projectId: string, skillId: string): Promise<ProjectSkill | null>;
  listSkills(projectId: string): Promise<ProjectSkill[]>;
  saveSkill(skill: Omit<ProjectSkill, "revision">, expectedRevision: number | null):
    Promise<IntentSaveResult<ProjectSkill>>;
  removeSkill(projectId: string, skillId: string, expectedRevision: number):
    Promise<"removed" | "missing" | "conflict">;
  removeProject(projectId: string): Promise<void>;
}
