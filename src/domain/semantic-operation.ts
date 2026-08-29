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
  | "history"
  | "project"
  | "goal"
  | "skill"
  | "coding";

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
  | "delete-all"
  | "create"
  | "set"
  | "apply"
  | "block"
  | "resolve";

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

export interface SemanticInteractionReference {
  domain: SemanticDomain;
  operation: SemanticOperationName;
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
  // `cancel` membuat pembatalan tugas dapat diusulkan bahasa alami. Sebelum
  // ini satu-satunya jalur adalah `/batalkan-tugas <id>`, yang menuntut
  // pengguna menyalin ID dari daftar—satu-satunya perintah tersisa yang
  // memaksa begitu. Usulan ini tetap tidak berwenang menghapus apa pun:
  // route deterministik tidak menanganinya, jadi ia hanya boleh sampai ke
  // Agent Runtime, tempat `task.manage` menuntut konfirmasi kontekstual.
  task: ["save", "list", "update", "complete", "cancel"],
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
  project: ["create", "list", "show"],
  goal: ["show", "set", "complete", "block", "resolve"],
  skill: ["list", "create", "apply"],
  // Hanya membaca status dan membatalkan run yang sedang berjalan.
  //
  // Memulai CodingRun sengaja tidak ada di sini. Ia memerlukan teks task
  // tersendiri, memakai sandbox dan anggaran, dan batasnya terhadap
  // permintaan bantuan biasa tidak dapat ditarik dari label saja: "tolong
  // perbaiki bug token expired" adalah kalimat yang sama untuk keduanya.
  // Selama pembedaan itu belum bisa dibuktikan kode, `/code` tetap satu-satunya
  // pintu, dan itu keputusan gagal-tertutup, bukan kekurangan.
  //
  // `github` dan `publish` juga tidak masuk: keduanya memegang credential dan
  // mengirim keluar. Pintu bahasa alami ke sana berarti tindakan ke luar dapat
  // dipicu tanpa invokasi tegas.
  coding: ["show", "cancel"],
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

/**
 * Operasi yang boleh dijangkau bahasa alami pada permukaan coding.
 *
 * Sebelum ini kedua adapter menuliskan daftarnya sendiri, sebaris demi
 * sebaris, di dalam handler masing-masing. Dua salinan aturan otorisasi
 * adalah dua tempat yang harus diingat setiap kali daftarnya berubah.
 */
export const NATURAL_SURFACE_OPERATIONS = Object.freeze({
  project: ["create", "list", "show"],
  goal: ["show", "set", "complete", "block", "resolve"],
  skill: ["list", "create", "apply"],
  coding: ["show", "cancel"],
} satisfies Readonly<Record<string, readonly SemanticOperationName[]>>);

export type NaturalSurfaceDomain = keyof typeof NATURAL_SURFACE_OPERATIONS;

export function isNaturalSurfaceDomain(
  domain: SemanticDomain,
): domain is NaturalSurfaceDomain {
  return domain in NATURAL_SURFACE_OPERATIONS;
}

/**
 * Operasi yang hanya membaca. Salah membacanya berbiaya satu pembacaan.
 */
const READ_ONLY_SURFACE_OPERATIONS: ReadonlySet<SemanticOperationName> =
  new Set(["show", "list"]);

/**
 * Gerbang tunggal untuk permukaan project/goal/skill/coding.
 *
 * Ambangnya bertingkat menurut akibat, bukan seragam. Tulis durable—membuat
 * project, menetapkan tujuan, membatalkan pekerjaan—tetap menuntut 0,85, sama
 * seperti sebelumnya. Pembacaan menuntut 0,70.
 *
 * Ini bukan pelonggaran demi meloloskan sesuatu. Pengukuran 29 Agustus 2026
 * pada "gimana status coding-nya sekarang?" mengembalikan `coding/show` di 3
 * dari 3 run—domainnya tidak pernah salah—tetapi confidence-nya 0,60, 0,90,
 * dan 0,82, sehingga hanya satu yang lolos ambang seragam. Akibatnya pengguna
 * mendapat jawaban yang berbeda untuk kalimat yang sama, dan yang menentukan
 * bukan maksudnya melainkan angka yang berayun.
 *
 * Ambang bertingkat sudah menjadi pola di repositori ini: pembacaan daftar
 * task memakai 0,85 sedangkan penyelesaiannya 0,90. Yang salah membaca
 * kehilangan satu pembacaan; yang salah menulis mengubah data pengguna.
 */
export function naturalSurfaceAuthorized(
  message: string,
  operation: SemanticOperation | null | undefined,
): operation is SemanticOperation & { domain: NaturalSurfaceDomain } {
  if (!operation || !isNaturalSurfaceDomain(operation.domain)) return false;
  return semanticOperationAuthorized(message, operation, {
    domain: operation.domain,
    operations: NATURAL_SURFACE_OPERATIONS[operation.domain],
    minConfidence: READ_ONLY_SURFACE_OPERATIONS.has(operation.operation)
      ? 0.7
      : 0.85,
    explicitness: ["explicit"],
    references: ["none", "current", "recent", "quoted"],
  });
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

/**
 * A model may propose that a short turn refers to a recent deterministic
 * surface, but it cannot create that navigation state by assertion alone.
 * Contextual routing is therefore allowed only when code has a matching,
 * bounded interaction receipt from this process.
 */
export function semanticOperationContextAvailable(
  semantic: SemanticOperation | null | undefined,
  interactions: readonly SemanticInteractionReference[] | null | undefined,
): boolean {
  if (!semantic || semantic.explicitness !== "contextual") return true;
  const allowedDomains: readonly SemanticDomain[] = semantic.domain === "billing"
    ? ["billing", "usage"]
    : [semantic.domain];
  return (interactions ?? []).some((interaction) =>
    allowedDomains.includes(interaction.domain)
  );
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
