/**
 * Meaning-level proposal produced by the bounded understanding pass.
 *
 * This object never carries a capability, storage identifier, provider name,
 * credential, or permission. It is untrusted input: code-owned policy must
 * still validate the operation against the raw user turn before reading or
 * mutating state.
 */
export type SemanticDomain =
  | "usage"
  | "billing"
  | "memory"
  | "task"
  | "session"
  | "menu"
  | "data"
  | "history";

export type SemanticOperationName =
  | "show-summary"
  | "show-details"
  | "recommend-plan"
  | "select-plan"
  | "set-funding"
  | "setup-byok"
  | "cancel-subscription"
  | "show-support"
  | "dismiss-support"
  | "top-up"
  | "contribute"
  | "list"
  | "remember"
  | "forget"
  | "edit"
  | "recall"
  | "save"
  | "update"
  | "complete"
  | "continue"
  | "stuck"
  | "done"
  | "cancel"
  | "show"
  | "show-help"
  | "show-category"
  | "show-controls"
  | "set-timezone"
  | "set-quiet-hours"
  | "withdraw-consent"
  | "export"
  | "delete-all";

export type SemanticReference =
  | "none"
  | "current"
  | "recent"
  | "all"
  | "quoted";
export type SemanticExplicitness = "explicit" | "contextual" | "implicit";
export type SemanticSubject = "self" | "other" | "unspecified";

export interface SemanticOperation {
  version: 1;
  domain: SemanticDomain;
  operation: SemanticOperationName;
  /** User-facing topic/value only. Never an internal resource identifier. */
  target: string | null;
  subject: SemanticSubject;
  reference: SemanticReference;
  explicitness: SemanticExplicitness;
  /** Exact, bounded span from the current raw message, or null when absent. */
  evidence: string | null;
  confidence: number;
}

const DOMAIN_OPERATIONS = Object.freeze({
  usage: ["show-summary", "show-details"],
  billing: [
    "recommend-plan",
    "select-plan",
    "set-funding",
    "setup-byok",
    "cancel-subscription",
    "show-support",
    "dismiss-support",
    "top-up",
    "contribute",
  ],
  memory: ["list", "remember", "forget", "edit", "recall"],
  task: ["save", "list", "update", "complete"],
  session: ["continue", "stuck", "done", "cancel"],
  menu: ["show", "show-help", "show-category"],
  data: [
    "show-controls",
    "set-timezone",
    "set-quiet-hours",
    "withdraw-consent",
    "export",
    "delete-all",
  ],
  history: ["recall"],
} satisfies Readonly<Record<SemanticDomain, readonly SemanticOperationName[]>>);

const REFERENCES: readonly SemanticReference[] = [
  "none",
  "current",
  "recent",
  "all",
  "quoted",
];
const EXPLICITNESS: readonly SemanticExplicitness[] = [
  "explicit",
  "contextual",
  "implicit",
];
const SUBJECTS: readonly SemanticSubject[] = [
  "self",
  "other",
  "unspecified",
];
const EXACT_KEYS = [
  "version",
  "domain",
  "operation",
  "target",
  "subject",
  "reference",
  "explicitness",
  "evidence",
  "confidence",
] as const;

export function parseSemanticOperation(value: unknown): SemanticOperation | null {
  if (!isRecord(value) || !hasExactKeys(value, EXACT_KEYS)) return null;
  if (value["version"] !== 1) return null;

  const domain = readClosed(value["domain"], Object.keys(DOMAIN_OPERATIONS) as SemanticDomain[]);
  if (!domain) return null;
  const operation = readClosed(value["operation"], DOMAIN_OPERATIONS[domain]);
  const subject = readClosed(value["subject"], SUBJECTS);
  const reference = readClosed(value["reference"], REFERENCES);
  const explicitness = readClosed(value["explicitness"], EXPLICITNESS);
  const target = readBoundedText(value["target"], 160);
  const evidence = readBoundedText(value["evidence"], 240);
  const confidence = value["confidence"];
  if (
    !operation || !subject || !reference || !explicitness ||
    !isValidNullableBoundedText(value["target"], target) ||
    !isValidNullableBoundedText(value["evidence"], evidence) ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
  ) return null;

  return Object.freeze({
    version: 1,
    domain,
    operation,
    target,
    subject,
    reference,
    explicitness,
    evidence,
    confidence,
  });
}

/** Code-owned proposal for an already parsed exact slash command. */
export function semanticOperationForExactCommand(
  domain: SemanticDomain,
  operation: SemanticOperationName,
  evidence: string,
  options: {
    target?: string | null;
    reference?: SemanticReference;
  } = {},
): SemanticOperation {
  const parsed = parseSemanticOperation({
    version: 1,
    domain,
    operation,
    target: options.target ?? null,
    subject: "self",
    reference: options.reference ?? "none",
    explicitness: "explicit",
    evidence,
    confidence: 1,
  });
  if (!parsed) throw new Error("Semantic operation exact tidak sah.");
  return parsed;
}

export interface SemanticAuthorization {
  domain: SemanticDomain;
  operations: readonly SemanticOperationName[];
  minConfidence?: number;
  explicitness?: readonly SemanticExplicitness[];
  references?: readonly SemanticReference[];
  requireEvidence?: boolean;
  requireSelf?: boolean;
}

/**
 * Validates a semantic proposal without attempting to understand language.
 * Evidence matching proves provenance, not meaning; the closed-set extractor
 * proposes meaning while this policy owns authority.
 */
export function semanticOperationAuthorized(
  rawMessage: string,
  semantic: SemanticOperation | null | undefined,
  rule: SemanticAuthorization,
): boolean {
  if (!semantic || semantic.domain !== rule.domain) return false;
  if (!rule.operations.includes(semantic.operation)) return false;
  if (semantic.confidence < (rule.minConfidence ?? 0.8)) return false;
  if (
    rule.explicitness &&
    !rule.explicitness.includes(semantic.explicitness)
  ) return false;
  if (rule.references && !rule.references.includes(semantic.reference)) {
    return false;
  }
  if (rule.requireSelf !== false && semantic.subject !== "self") return false;
  if (rule.requireEvidence !== false && !semanticEvidenceMatches(rawMessage, semantic.evidence)) {
    return false;
  }
  return true;
}

export function semanticEvidenceMatches(
  rawMessage: string,
  evidence: string | null | undefined,
): boolean {
  const message = normalizeForEvidence(rawMessage);
  const span = normalizeForEvidence(evidence ?? "");
  return Boolean(message && span && message.includes(span));
}

/** Content-free bucket safe for operational metrics. */
export function semanticConfidenceBucket(
  semantic: SemanticOperation | null | undefined,
): "none" | "low" | "medium" | "high" {
  if (!semantic) return "none";
  if (semantic.confidence >= 0.85) return "high";
  if (semantic.confidence >= 0.65) return "medium";
  return "low";
}

function readClosed<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.find((entry) => entry === candidate) ?? null;
}

function readBoundedText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const clean = value.trim().replaceAll(/\s+/gu, " ");
  if (!clean || clean.length > max) {
    return null;
  }
  return clean;
}

function isValidNullableBoundedText(
  input: unknown,
  parsed: string | null,
): boolean {
  return input === null || (typeof input === "string" && parsed !== null);
}

function normalizeForEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(value);
  return present.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
