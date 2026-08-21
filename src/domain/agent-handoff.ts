/**
 * Provider-neutral cross-model state. Deliberately no chain-of-thought,
 * scratchpad, provider continuation, credential, or authority fields.
 */
export interface WorkEvidence {
  id: string;
  source: "user_request" | "tool_observation" | "validator" | "code";
  summary: string;
}

export interface WorkBrief {
  version: 1;
  goal: string;
  /** Opaque local reference; not raw request content. */
  originalRequestRef: string;
  facts: readonly string[];
  constraints: readonly string[];
  evidence: readonly WorkEvidence[];
  assumptions: readonly string[];
  plan: readonly string[];
  openQuestions: readonly string[];
  acceptanceCriteria: readonly string[];
  requestedCapabilities: readonly string[];
}

export type AgentHandoffStatus =
  | "completed"
  | "partial"
  | "plan_conflict"
  | "uncertain"
  | "failed";

export type AgentHandoffFailureCode =
  | "plan_conflict"
  | "missing_evidence"
  | "unresolved_constraint"
  | "validator_failure"
  | "capability_unavailable"
  | "execution_failure";

export interface HandoffProvenance {
  source: "brief" | "tool_observation" | "worker" | "validator" | "code";
  ref: string;
}

export interface AgentHandoff {
  version: 1;
  status: AgentHandoffStatus;
  workBriefRef: string;
  facts: readonly string[];
  evidence: readonly WorkEvidence[];
  assumptions: readonly string[];
  plan: readonly string[];
  workProduct: string | null;
  openQuestions: readonly string[];
  confidence: number;
  provenance: readonly HandoffProvenance[];
  failureCodes: readonly AgentHandoffFailureCode[];
}

const BRIEF_KEYS = [
  "version",
  "goal",
  "originalRequestRef",
  "facts",
  "constraints",
  "evidence",
  "assumptions",
  "plan",
  "openQuestions",
  "acceptanceCriteria",
  "requestedCapabilities",
] as const;
const HANDOFF_KEYS = [
  "version",
  "status",
  "workBriefRef",
  "facts",
  "evidence",
  "assumptions",
  "plan",
  "workProduct",
  "openQuestions",
  "confidence",
  "provenance",
  "failureCodes",
] as const;
const EVIDENCE_KEYS = ["id", "source", "summary"] as const;
const PROVENANCE_KEYS = ["source", "ref"] as const;
const CAPABILITY_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const EVIDENCE_SOURCES = new Set<WorkEvidence["source"]>([
  "user_request",
  "tool_observation",
  "validator",
  "code",
]);
const HANDOFF_STATUSES = new Set<AgentHandoffStatus>([
  "completed",
  "partial",
  "plan_conflict",
  "uncertain",
  "failed",
]);
const PROVENANCE_SOURCES = new Set<HandoffProvenance["source"]>([
  "brief",
  "tool_observation",
  "worker",
  "validator",
  "code",
]);
const FAILURE_CODES = new Set<AgentHandoffFailureCode>([
  "plan_conflict",
  "missing_evidence",
  "unresolved_constraint",
  "validator_failure",
  "capability_unavailable",
  "execution_failure",
]);

export function parseWorkBrief(value: unknown): WorkBrief | null {
  if (!exactRecord(value, BRIEF_KEYS) || value.version !== 1) return null;
  const goal = shortText(value.goal, 2_000);
  const originalRequestRef = reference(value.originalRequestRef);
  const facts = textList(value.facts, 24, 1_000);
  const constraints = textList(value.constraints, 24, 1_000);
  const evidence = evidenceList(value.evidence);
  const assumptions = textList(value.assumptions, 16, 1_000);
  const plan = textList(value.plan, 24, 1_000);
  const openQuestions = textList(value.openQuestions, 16, 1_000);
  const acceptanceCriteria = textList(value.acceptanceCriteria, 24, 1_000);
  const requestedCapabilities = capabilityList(value.requestedCapabilities);
  if (
    !goal || !originalRequestRef || !facts || !constraints || !evidence ||
    !assumptions || !plan || !openQuestions || !acceptanceCriteria ||
    !requestedCapabilities
  ) return null;
  return freezeBrief({
    version: 1,
    goal,
    originalRequestRef,
    facts,
    constraints,
    evidence,
    assumptions,
    plan,
    openQuestions,
    acceptanceCriteria,
    requestedCapabilities,
  });
}

export function parseAgentHandoff(value: unknown): AgentHandoff | null {
  const payload = typeof value === "string" ? extractJson(value) : value;
  if (!exactRecord(payload, HANDOFF_KEYS) || payload.version !== 1) return null;
  const status = typeof payload.status === "string" &&
      HANDOFF_STATUSES.has(payload.status as AgentHandoffStatus)
    ? payload.status as AgentHandoffStatus
    : null;
  const workBriefRef = reference(payload.workBriefRef);
  const facts = textList(payload.facts, 24, 1_000);
  const evidence = evidenceList(payload.evidence);
  const assumptions = textList(payload.assumptions, 16, 1_000);
  const plan = textList(payload.plan, 24, 1_000);
  const workProduct = payload.workProduct === null
    ? null
    : shortText(payload.workProduct, 8_000);
  const openQuestions = textList(payload.openQuestions, 16, 1_000);
  const confidence = payload.confidence;
  const provenance = provenanceList(payload.provenance);
  const failureCodes = failureCodeList(payload.failureCodes);
  if (
    !status || !workBriefRef || !facts || !evidence || !assumptions || !plan ||
    (payload.workProduct !== null && !workProduct) || !openQuestions ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1 || !provenance || !failureCodes
  ) return null;
  if (status === "completed" && workProduct === null) return null;
  if (status === "plan_conflict" && !failureCodes.includes("plan_conflict")) {
    return null;
  }
  return Object.freeze({
    version: 1,
    status,
    workBriefRef,
    facts: Object.freeze(facts),
    evidence: Object.freeze(evidence),
    assumptions: Object.freeze(assumptions),
    plan: Object.freeze(plan),
    workProduct,
    openQuestions: Object.freeze(openQuestions),
    confidence,
    provenance: Object.freeze(provenance),
    failureCodes: Object.freeze(failureCodes),
  });
}

export function workBriefReference(brief: WorkBrief): string {
  return brief.originalRequestRef;
}

function freezeBrief(brief: WorkBrief): WorkBrief {
  return Object.freeze({
    ...brief,
    facts: Object.freeze([...brief.facts]),
    constraints: Object.freeze([...brief.constraints]),
    evidence: Object.freeze([...brief.evidence]),
    assumptions: Object.freeze([...brief.assumptions]),
    plan: Object.freeze([...brief.plan]),
    openQuestions: Object.freeze([...brief.openQuestions]),
    acceptanceCriteria: Object.freeze([...brief.acceptanceCriteria]),
    requestedCapabilities: Object.freeze([...brief.requestedCapabilities]),
  });
}

function evidenceList(value: unknown): WorkEvidence[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const result: WorkEvidence[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!exactRecord(entry, EVIDENCE_KEYS)) return null;
    const id = reference(entry.id);
    const summary = shortText(entry.summary, 1_500);
    const source = typeof entry.source === "string" &&
        EVIDENCE_SOURCES.has(entry.source as WorkEvidence["source"])
      ? entry.source as WorkEvidence["source"]
      : null;
    if (!id || ids.has(id) || !summary || !source) return null;
    ids.add(id);
    result.push(Object.freeze({ id, source, summary }));
  }
  return result;
}

function provenanceList(value: unknown): HandoffProvenance[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const result: HandoffProvenance[] = [];
  for (const entry of value) {
    if (!exactRecord(entry, PROVENANCE_KEYS)) return null;
    const ref = reference(entry.ref);
    const source = typeof entry.source === "string" &&
        PROVENANCE_SOURCES.has(entry.source as HandoffProvenance["source"])
      ? entry.source as HandoffProvenance["source"]
      : null;
    if (!ref || !source) return null;
    result.push(Object.freeze({ source, ref }));
  }
  return result;
}

function failureCodeList(value: unknown): AgentHandoffFailureCode[] | null {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length) {
    return null;
  }
  if (value.some((entry) =>
    typeof entry !== "string" || !FAILURE_CODES.has(entry as AgentHandoffFailureCode)
  )) return null;
  return value as AgentHandoffFailureCode[];
}

function capabilityList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length) {
    return null;
  }
  if (value.some((entry) => typeof entry !== "string" || !CAPABILITY_ID.test(entry))) {
    return null;
  }
  return value as string[];
}

function textList(value: unknown, limit: number, chars: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: string[] = [];
  for (const entry of value) {
    const text = shortText(entry, chars);
    if (!text) return null;
    result.push(text);
  }
  return result;
}

function shortText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replaceAll(/[\u0000-\u001f\u007f]/gu, " ");
  return clean && clean.length <= limit ? clean : null;
}

function reference(value: unknown): string | null {
  return typeof value === "string" && REFERENCE.test(value) ? value : null;
}

function exactRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function extractJson(raw: string): unknown {
  const clean = raw
    .replace(/^\s*```(?:json)?/iu, "")
    .replace(/```\s*$/u, "")
    .trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}
