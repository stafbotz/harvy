import type { ProjectGoalCriterionKind } from "../domain/project-intent.js";
import type {
  SaveProjectSkillInput,
  SetProjectGoalInput,
} from "../core/project-intent-service.js";

export type GoalCommand =
  | { kind: "show" }
  | { kind: "set"; input: SetProjectGoalInput }
  | { kind: "complete" }
  | { kind: "block"; summary: string }
  | { kind: "resolve"; blockerId: string }
  | { kind: "confirm"; criterionId: string; summary: string }
  | { kind: "help" };

export type SkillCommand =
  | { kind: "list" }
  | { kind: "create"; input: SaveProjectSkillInput }
  | { kind: "apply"; nameOrId: string; request: string }
  | { kind: "help" };

export function parseGoalCommand(rawInput: string): GoalCommand {
  const raw = rawInput.trim();
  if (!raw || raw === "show") return { kind: "show" };
  if (raw === "complete") return { kind: "complete" };
  if (raw.startsWith("block ")) {
    return { kind: "block", summary: required(raw.slice(6), "Ringkasan blocker") };
  }
  if (raw.startsWith("resolve ")) {
    return { kind: "resolve", blockerId: required(raw.slice(8), "ID blocker") };
  }
  if (raw.startsWith("confirm ")) {
    const [criterionId, ...summary] = raw.slice(8).trim().split(/\s+/u);
    if (!criterionId || summary.length === 0) return { kind: "help" };
    return { kind: "confirm", criterionId, summary: summary.join(" ") };
  }
  if (!raw.startsWith("set ")) return { kind: "help" };
  const parts = pipeParts(raw.slice(4));
  if (parts.length < 2) return { kind: "help" };
  const objective = parts[0]!;
  const acceptanceCriteria: Array<{ kind: ProjectGoalCriterionKind; text: string }> = [];
  const milestones: string[] = [];
  for (const part of parts.slice(1)) {
    const parsed = keyed(part);
    if (parsed.key === "milestone") {
      milestones.push(parsed.value);
      continue;
    }
    const kind = parsed.key === "github" || parsed.key === "manual" ? parsed.key : "code";
    acceptanceCriteria.push({ kind, text: parsed.key === "code" ? parsed.value : parsed.key === kind ? parsed.value : part });
  }
  if (acceptanceCriteria.length === 0) return { kind: "help" };
  return { kind: "set", input: { objective, acceptanceCriteria, milestones } };
}

export function parseSkillCommand(rawInput: string): SkillCommand {
  const raw = rawInput.trim();
  if (!raw || raw === "list") return { kind: "list" };
  if (raw.startsWith("apply ")) {
    const parts = pipeParts(raw.slice(6));
    if (parts.length !== 2) return { kind: "help" };
    return { kind: "apply", nameOrId: parts[0]!, request: parts[1]! };
  }
  if (!raw.startsWith("create ")) return { kind: "help" };
  const parts = pipeParts(raw.slice(7));
  if (parts.length < 3) return { kind: "help" };
  const fields = new Map(parts.slice(2).map((part) => {
    const item = keyed(part);
    return [item.key, item.value] as const;
  }));
  const sourceEvidenceRefs = commaList(fields.get("evidence"));
  const steps = semicolonList(fields.get("steps"));
  const verification = semicolonList(fields.get("verify"));
  if (sourceEvidenceRefs.length === 0 || steps.length === 0 || verification.length === 0) {
    return { kind: "help" };
  }
  return {
    kind: "create",
    input: {
      name: parts[0]!,
      description: parts[1]!,
      semanticTriggers: semicolonList(fields.get("triggers")),
      preconditions: semicolonList(fields.get("preconditions")),
      steps,
      toolRequirements: commaList(fields.get("tools")),
      verification,
      sourceEvidenceRefs,
    },
  };
}

export const GOAL_COMMAND_HELP = [
  "Kelola tujuan project:",
  "/goal",
  "/goal set <tujuan> | code:<kriteria> | github:<kriteria> | manual:<kriteria> | milestone:<tahap>",
  "/goal block <hambatan>",
  "/goal resolve <blockerId>",
  "/goal confirm <criterionId> <bukti penerimaan pengguna>",
  "/goal complete",
].join("\n");

export const SKILL_COMMAND_HELP = [
  "Kelola skill deklaratif project:",
  "/skill list",
  "/skill create <nama> | <deskripsi> | evidence=<ref> | tools=<tool,tool> | triggers=<a;b> | preconditions=<a;b> | steps=<a;b> | verify=<a;b>",
  "/skill apply <nama atau id> | <pekerjaan>",
  "Skill tidak memasang kode atau permission baru.",
].join("\n");

function pipeParts(raw: string): string[] {
  return raw.split("|").map((part) => part.trim()).filter(Boolean);
}

function keyed(raw: string): { key: string; value: string } {
  const separator = raw.indexOf(":") >= 0 ? raw.indexOf(":") : raw.indexOf("=");
  if (separator < 1) return { key: "code", value: required(raw, "Nilai") };
  return {
    key: raw.slice(0, separator).trim().toLocaleLowerCase("en-US"),
    value: required(raw.slice(separator + 1), "Nilai"),
  };
}

function commaList(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function semicolonList(raw: string | undefined): string[] {
  return raw ? raw.split(";").map((item) => item.trim()).filter(Boolean) : [];
}

function required(raw: string, label: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`${label} wajib diisi.`);
  return value;
}
