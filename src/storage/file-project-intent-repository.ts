import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  IntentSaveResult,
  ProjectGoal,
  ProjectIntentRepository,
  ProjectSkill,
} from "../domain/project-intent.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";

interface ProjectIntentDatabase {
  version: 1;
  goals: ProjectGoal[];
  skills: ProjectSkill[];
}

const FILE_QUEUES = new Map<string, Promise<void>>();

export class FileProjectIntentRepository implements ProjectIntentRepository {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
  }

  async loadGoal(projectId: string): Promise<ProjectGoal | null> {
    const id = safeKey(projectId, "projectId");
    const value = (await this.read()).goals.find((goal) => goal.projectId === id);
    return value ? structuredClone(value) : null;
  }

  async saveGoal(
    goalInput: Omit<ProjectGoal, "revision">,
    expectedRevision: number | null,
  ): Promise<IntentSaveResult<ProjectGoal>> {
    const goal: ProjectGoal = {
      ...structuredClone(goalInput),
      revision: expectedRevision === null ? 1 : expectedRevision + 1,
    };
    validateGoal(goal);
    return this.exclusive(async () => {
      const database = await this.read();
      const index = database.goals.findIndex((item) => item.projectId === goal.projectId);
      if (
        expectedRevision === null ? index >= 0
        : index < 0 || database.goals[index]!.revision !== expectedRevision
      ) return { status: "conflict" };
      if (index < 0) database.goals.push(goal);
      else {
        validateGoalTransition(database.goals[index]!, goal);
        database.goals[index] = goal;
      }
      await this.write(database);
      return { status: "saved", value: structuredClone(goal) };
    });
  }

  async loadSkill(projectId: string, skillId: string): Promise<ProjectSkill | null> {
    const project = safeKey(projectId, "projectId");
    const id = safeKey(skillId, "skillId");
    const value = (await this.read()).skills.find((skill) =>
      skill.projectId === project && skill.skillId === id
    );
    return value ? structuredClone(value) : null;
  }

  async listSkills(projectId: string): Promise<ProjectSkill[]> {
    const project = safeKey(projectId, "projectId");
    return structuredClone((await this.read()).skills
      .filter((skill) => skill.projectId === project)
      .sort((left, right) => currentSkill(left).name.localeCompare(currentSkill(right).name, "id")));
  }

  async saveSkill(
    skillInput: Omit<ProjectSkill, "revision">,
    expectedRevision: number | null,
  ): Promise<IntentSaveResult<ProjectSkill>> {
    const skill: ProjectSkill = {
      ...structuredClone(skillInput),
      revision: expectedRevision === null ? 1 : expectedRevision + 1,
    };
    validateSkill(skill);
    return this.exclusive(async () => {
      const database = await this.read();
      const index = database.skills.findIndex((item) => item.skillId === skill.skillId);
      if (
        expectedRevision === null ? index >= 0
        : index < 0 || database.skills[index]!.revision !== expectedRevision
      ) return { status: "conflict" };
      if (index < 0) database.skills.push(skill);
      else {
        validateSkillTransition(database.skills[index]!, skill);
        database.skills[index] = skill;
      }
      await this.write(database);
      return { status: "saved", value: structuredClone(skill) };
    });
  }

  async removeSkill(
    projectId: string,
    skillId: string,
    expectedRevision: number,
  ): Promise<"removed" | "missing" | "conflict"> {
    const project = safeKey(projectId, "projectId");
    const id = safeKey(skillId, "skillId");
    return this.exclusive(async () => {
      const database = await this.read();
      const index = database.skills.findIndex((skill) =>
        skill.projectId === project && skill.skillId === id
      );
      if (index < 0) return "missing";
      if (database.skills[index]!.revision !== expectedRevision) return "conflict";
      database.skills.splice(index, 1);
      await this.write(database);
      return "removed";
    });
  }

  async removeProject(projectId: string): Promise<void> {
    const project = safeKey(projectId, "projectId");
    await this.exclusive(async () => {
      const database = await this.read();
      database.goals = database.goals.filter((goal) => goal.projectId !== project);
      database.skills = database.skills.filter((skill) => skill.projectId !== project);
      await this.write(database);
    });
  }

  private async read(): Promise<ProjectIntentDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<ProjectIntentDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.goals) || !Array.isArray(parsed.skills)) {
        throw new Error("Format basis data project intent tidak dikenali.");
      }
      parsed.goals.forEach(validateGoal);
      parsed.skills.forEach(validateSkill);
      return structuredClone(parsed as ProjectIntentDatabase);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, goals: [], skills: [] };
      }
      throw error;
    }
  }

  private async write(database: ProjectIntentDatabase): Promise<void> {
    await writeDurableFileAtomic(this.#filePath, `${JSON.stringify(database, null, 2)}\n`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.#filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    FILE_QUEUES.set(this.#filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.#filePath) === tail) FILE_QUEUES.delete(this.#filePath);
    }
  }
}

function validateGoal(value: unknown): asserts value is ProjectGoal {
  if (!record(value) || value.version !== 1) throw invalid("goal");
  const goal = value as unknown as ProjectGoal;
  safeKey(goal.goalId, "goalId");
  safeKey(goal.ownerWorkspaceKey, "ownerWorkspaceKey");
  safeKey(goal.projectId, "projectId");
  positive(goal.revision, "goal revision");
  text(goal.objective, 4_000, "objective");
  if (!["active", "blocked", "completed", "cancelled"].includes(goal.status)) throw invalid("status goal");
  iso(goal.createdAt, "goal createdAt");
  iso(goal.updatedAt, "goal updatedAt");
  list(goal.acceptanceCriteria, 64, (criterion) => {
    if (!record(criterion)) throw invalid("criterion");
    safeKey(criterion.id, "criterionId");
    if (!["code", "github", "manual"].includes(String(criterion.kind))) throw invalid("criterion kind");
    text(criterion.text, 2_000, "criterion text");
    if (criterion.status !== "pending" && criterion.status !== "met") throw invalid("criterion status");
    textList(criterion.evidenceRefs, 32, 512, "criterion evidence");
    if (criterion.status === "met" && criterion.evidenceRefs.length === 0) throw invalid("criterion evidence");
  }, "acceptance criteria");
  if (goal.acceptanceCriteria.length === 0) throw invalid("acceptance criteria");
  list(goal.milestones, 64, (milestone) => {
    if (!record(milestone)) throw invalid("milestone");
    safeKey(milestone.id, "milestoneId");
    text(milestone.title, 1_000, "milestone title");
    if (!["pending", "in_progress", "completed", "blocked"].includes(String(milestone.status))) throw invalid("milestone status");
    textList(milestone.evidenceRefs, 32, 512, "milestone evidence");
  }, "milestones");
  list(goal.decisions, 128, (decision) => {
    if (!record(decision)) throw invalid("decision");
    safeKey(decision.id, "decisionId");
    text(decision.summary, 2_000, "decision summary");
    text(decision.rationale, 2_000, "decision rationale");
    iso(decision.decidedAt, "decision decidedAt");
  }, "decisions");
  list(goal.blockers, 64, (blocker) => {
    if (!record(blocker)) throw invalid("blocker");
    safeKey(blocker.id, "blockerId");
    text(blocker.summary, 2_000, "blocker summary");
    if (blocker.status !== "open" && blocker.status !== "resolved") throw invalid("blocker status");
    iso(blocker.createdAt, "blocker createdAt");
    if (blocker.resolvedAt !== null) iso(blocker.resolvedAt, "blocker resolvedAt");
    if ((blocker.status === "resolved") !== (blocker.resolvedAt !== null)) throw invalid("blocker resolution");
  }, "blockers");
  list(goal.evidence, 256, (evidence) => {
    if (!record(evidence)) throw invalid("evidence");
    safeRef(evidence.ref, "evidence ref");
    if (!["coding_run", "validator", "artifact", "github", "user_confirmation"].includes(String(evidence.kind))) throw invalid("evidence kind");
    text(evidence.summary, 2_000, "evidence summary");
    iso(evidence.recordedAt, "evidence recordedAt");
  }, "evidence");
  unique(goal.acceptanceCriteria.map((item) => item.id), "criterion id");
  unique(goal.milestones.map((item) => item.id), "milestone id");
  unique(goal.decisions.map((item) => item.id), "decision id");
  unique(goal.blockers.map((item) => item.id), "blocker id");
  unique(goal.evidence.map((item) => item.ref), "evidence ref");
  const evidence = new Set(goal.evidence.map((item) => item.ref));
  for (const ref of [...goal.acceptanceCriteria, ...goal.milestones].flatMap((item) => item.evidenceRefs)) {
    if (!evidence.has(ref)) throw invalid("dangling evidence ref");
  }
  if (goal.status === "completed" && (
    goal.acceptanceCriteria.some((criterion) => criterion.status !== "met") ||
    goal.blockers.some((blocker) => blocker.status === "open")
  )) throw invalid("completed goal without evidence");
}

function validateGoalTransition(current: ProjectGoal, next: ProjectGoal): void {
  if (
    current.goalId !== next.goalId || current.ownerWorkspaceKey !== next.ownerWorkspaceKey ||
    current.projectId !== next.projectId || current.createdAt !== next.createdAt ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) throw invalid("goal immutable field");
  const evidenceRefs = new Set(current.evidence.map((item) => item.ref));
  if (current.evidence.some((item) =>
    JSON.stringify(item) !== JSON.stringify(next.evidence.find((candidate) => candidate.ref === item.ref))
  )) throw invalid("goal evidence append-only");
  if (next.evidence.length < evidenceRefs.size) throw invalid("goal evidence removal");
}

function validateSkill(value: unknown): asserts value is ProjectSkill {
  if (!record(value) || value.version !== 1) throw invalid("skill");
  const skill = value as unknown as ProjectSkill;
  safeKey(skill.skillId, "skillId");
  safeKey(skill.ownerWorkspaceKey, "ownerWorkspaceKey");
  safeKey(skill.projectId, "projectId");
  positive(skill.revision, "skill revision");
  if (skill.status !== "active" && skill.status !== "inactive") throw invalid("skill status");
  iso(skill.createdAt, "skill createdAt");
  iso(skill.updatedAt, "skill updatedAt");
  list(skill.versions, 64, (version) => {
    if (!record(version)) throw invalid("skill version");
    positive(version.version, "skill version");
    text(version.name, 80, "skill name");
    text(version.description, 1_000, "skill description");
    textList(version.semanticTriggers, 24, 240, "skill triggers");
    textList(version.preconditions, 24, 1_000, "skill preconditions");
    textList(version.steps, 64, 1_500, "skill steps");
    if (version.steps.length === 0) throw invalid("skill steps");
    textList(version.toolRequirements, 24, 128, "skill tools");
    textList(version.verification, 32, 1_000, "skill verification");
    if (version.verification.length === 0) throw invalid("skill verification");
    textList(version.sourceEvidenceRefs, 32, 512, "skill source evidence");
    iso(version.createdAt, "skill version createdAt");
  }, "skill versions");
  if (skill.versions.length === 0 || skill.versions.some((version, index) => version.version !== index + 1)) throw invalid("skill version sequence");
}

function validateSkillTransition(current: ProjectSkill, next: ProjectSkill): void {
  if (
    current.skillId !== next.skillId || current.ownerWorkspaceKey !== next.ownerWorkspaceKey ||
    current.projectId !== next.projectId || current.createdAt !== next.createdAt ||
    next.versions.length < current.versions.length ||
    JSON.stringify(current.versions) !== JSON.stringify(next.versions.slice(0, current.versions.length)) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) throw invalid("skill immutable/version field");
}

function currentSkill(skill: ProjectSkill) {
  return skill.versions.at(-1)!;
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown, maximum: number, validate: (item: any) => void, label: string): asserts value is any[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid(label);
  value.forEach(validate);
}

function textList(value: unknown, maximum: number, maxCharacters: number, label: string): asserts value is string[] {
  list(value, maximum, (item) => text(item, maxCharacters, label), label);
  unique(value as string[], label);
}

function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\p{Cc}/u.test(value) || containsSecretLikeValue(value)) throw invalid(label);
}

function safeKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{3,512}$/u.test(value) || containsSecretLikeValue(value)) throw invalid(label);
  return value;
}

function safeRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{3,512}$/u.test(value) || containsSecretLikeValue(value)) throw invalid(label);
  return value;
}

function positive(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(label);
}

function iso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid(label);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalid(`${label} duplicate`);
}

function invalid(label: string): Error {
  return new Error(`Project intent ${label} tidak sah.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
