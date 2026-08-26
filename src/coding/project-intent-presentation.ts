import type { ProjectGoal, ProjectSkill } from "../domain/project-intent.js";
import { currentSkill } from "../core/project-intent-service.js";

export function renderProjectGoal(goal: ProjectGoal | null): string {
  if (!goal) {
    return "Project aktif belum mempunyai tujuan durable. Tetapkan tujuan sebelum mulai coding agar Harvy tidak kehilangan arah.";
  }
  const criteria = goal.acceptanceCriteria.map((criterion) =>
    `${criterion.status === "met" ? "✓" : "○"} ${criterion.id} · ${criterion.kind} · ${criterion.text}`
  );
  const milestones = goal.milestones.map((milestone) => {
    const mark = milestone.status === "completed"
      ? "✓"
      : milestone.status === "in_progress"
      ? "→"
      : milestone.status === "blocked"
      ? "!"
      : "○";
    return `${mark} ${milestone.title}`;
  });
  const blockers = goal.blockers
    .filter((blocker) => blocker.status === "open")
    .map((blocker) => `! ${blocker.id} · ${blocker.summary}`);
  return [
    `Tujuan proyek · ${goal.status}`,
    goal.objective,
    "",
    "Kriteria penerimaan",
    ...criteria,
    ...(milestones.length > 0 ? ["", "Milestone", ...milestones] : []),
    ...(blockers.length > 0 ? ["", "Blocker", ...blockers] : []),
    "",
    `Revision ${goal.revision} · ${goal.evidence.length} evidence`,
  ].join("\n");
}

export function renderProjectSkills(skills: readonly ProjectSkill[]): string {
  if (skills.length === 0) {
    return "Project aktif belum mempunyai skill deklaratif.";
  }
  return [
    "Skill project",
    ...skills.map((skill) => {
      const current = currentSkill(skill);
      return `${skill.status === "active" ? "✓" : "○"} ${current.name} · v${current.version} · ${skill.skillId}`;
    }),
  ].join("\n");
}

export function renderProjectSkill(skill: ProjectSkill): string {
  const current = currentSkill(skill);
  return [
    `${current.name} · v${current.version} · ${skill.status}`,
    current.description,
    "",
    "Langkah",
    ...current.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Tool yang dibutuhkan",
    ...(current.toolRequirements.length > 0 ? current.toolRequirements.map((tool) => `• ${tool}`) : ["• Tidak ada"]),
    "",
    "Verifikasi",
    ...current.verification.map((item) => `• ${item}`),
  ].join("\n");
}
