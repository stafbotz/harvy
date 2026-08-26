import type { MemoryItem } from "../domain/memory.js";
import {
  semanticEvidenceMatches,
  semanticOperationAuthorized,
  type SemanticOperation,
  type SemanticReference,
} from "../domain/semantic-operation.js";

export interface MemoryRetractionProposal {
  target: string;
  sourceEvidence: string;
  explicitness: "explicit";
  confidence: number;
}

/**
 * Pagar authority untuk koreksi natural atas primary memory.
 *
 * Proposal model hanya diterima bila satu klausa current turn menjadi evidence
 * exact, confidence tinggi, targetnya item-scoped, dan tidak mencoba berubah
 * menjadi bulk deletion. Target kemudian masih harus cocok dengan source milik
 * owner sebelum `MemoryService.forget` dapat menghasilkan receipt.
 */
export function memoryRetractionAuthorized(
  message: string,
  proposal: MemoryRetractionProposal,
): boolean {
  const target = proposal.target.trim().replaceAll(/\s+/gu, " ");
  const evidence = proposal.sourceEvidence.trim().replaceAll(/\s+/gu, " ");
  if (
    proposal.explicitness !== "explicit" || proposal.confidence < 0.85 ||
    !target || target.length > 160 || !evidence || evidence.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(`${target}${evidence}`) ||
    containsMultipleClauses(evidence) ||
    !semanticEvidenceMatches(message, evidence)
  ) return false;

  const normalizedTarget = normalize(target);
  return !/^(?:semua|seluruh|semuanya|everything|all)(?:\s+(?:ingatan|memori|memory|memories))?$/iu
    .test(normalizedTarget);
}

/** Semantic evidence proposes meaning; code still owns mutation authority. */
export function hasExplicitMemoryForgetRequest(
  message: string,
  semantic: SemanticOperation | null | undefined,
): boolean {
  return semanticOperationAuthorized(message, semantic, {
    domain: "memory",
    operations: ["forget"],
    minConfidence: 0.85,
    explicitness: ["explicit"],
  });
}

export function isExplicitForgetAllMemories(
  message: string,
  semantic: SemanticOperation | null | undefined,
): boolean {
  return hasExplicitMemoryForgetRequest(message, semantic) &&
    semantic?.reference === "all" && !semantic.target;
}

/**
 * Memilih source user-visible secara owner-local tanpa meminta ID. Hasil ini
 * kemudian tetap melewati MemoryService.forget agar seluruh cascade berlaku.
 */
export function memoriesMatchingNaturalTarget(
  items: readonly MemoryItem[],
  target: string | null,
  reference: SemanticReference = "none",
): MemoryItem[] {
  if (items.length === 0) return [];
  const normalizedTarget = normalize(target ?? "");
  if (reference === "recent") {
    return [newest(items)];
  }

  const targetTerms = meaningfulTerms(normalizedTarget);
  if (targetTerms.size === 0) return [];
  const expandedTerms = expandTopicTerms(targetTerms);

  return items
    .map((item) => ({
      item,
      score: overlapScore(meaningfulTerms(normalize(item.content)), expandedTerms),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Date.parse(right.item.createdAt) - Date.parse(left.item.createdAt) ||
      left.item.id.localeCompare(right.item.id))
    .map(({ item }) => item);
}

export function naturalMemoryTargetLabel(
  target: string | null,
  reference: SemanticReference = "none",
): string {
  const candidate = (target?.trim() ?? "")
    .replaceAll(/[.!?]+$/gu, "")
    .trim();
  if (!candidate || reference === "recent") return "yang tadi";
  return candidate.slice(0, 80);
}

function newest(items: readonly MemoryItem[]): MemoryItem {
  return [...items].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id))[0]!;
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (value.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(stemPossessive)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
  );
}

function stemPossessive(value: string): string {
  return value.replace(/(?:ku|mu|nya)$/u, "");
}

function expandTopicTerms(terms: ReadonlySet<string>): Set<string> {
  const expanded = new Set(terms);
  for (const group of TOPIC_ALIASES) {
    if (group.some((term) => terms.has(term))) {
      for (const term of group) expanded.add(term);
    }
  }
  return expanded;
}

function overlapScore(
  contentTerms: ReadonlySet<string>,
  targetTerms: ReadonlySet<string>,
): number {
  let score = 0;
  for (const term of targetTerms) {
    if (contentTerms.has(term)) score += term.length >= 5 ? 2 : 1;
  }
  return score;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

const TOPIC_ALIASES: readonly string[][] = [
  ["sekolah", "kelas", "sman", "smk", "sma", "kampus", "jurusan"],
  ["kuliah", "kampus", "universitas", "jurusan"],
  ["pasangan", "pacar", "hubungan", "relasi"],
  ["belajar", "pelajaran", "kelas", "les"],
  ["english", "inggris"],
  ["garden", "gardening", "kebun", "berkebun", "tanaman"],
];

const STOP_WORDS = new Set([
  "ada",
  "aja",
  "aku",
  "dan",
  "dari",
  "di",
  "dong",
  "ini",
  "itu",
  "kamu",
  "mengenai",
  "soal",
  "tentang",
  "yang",
]);

function containsMultipleClauses(value: string): boolean {
  const withoutTrailing = value.trim().replace(/[.!?;]+$/u, "");
  return /[.!?;]\s+\S/u.test(withoutTrailing);
}
