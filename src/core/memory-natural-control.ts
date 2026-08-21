import type { MemoryItem } from "../domain/memory.js";

/** Model boleh membantu memahami topik, tetapi kata pengguna tetap izin mutasi. */
export function hasExplicitMemoryForgetRequest(message: string): boolean {
  const value = normalize(message);
  return /\b(lupain|lupakan|melupakan|hapus|hilangkan)\b/u.test(value) ||
    /\bjangan\s+(?:di)?(?:simpan|ingat|catat)\b/u.test(value);
}

export function isExplicitForgetAllMemories(message: string): boolean {
  const value = normalize(message);
  if (!hasExplicitMemoryForgetRequest(value)) return false;
  if (
    /\b(?:soal|mengenai)\s+\S+/u.test(value) ||
    /\btentang\s+(?!aku\b|diriku\b|saya\b)\S+/u.test(value)
  ) return false;
  return /\b(semua|seluruh)\b/u.test(value) &&
    /\b(ingatan|memori|tentang aku|tentangku)\b/u
      .test(value);
}

/**
 * Memilih source user-visible secara owner-local tanpa meminta ID. Hasil ini
 * kemudian tetap melewati MemoryService.forget agar seluruh cascade berlaku.
 */
export function memoriesMatchingNaturalTarget(
  items: readonly MemoryItem[],
  target: string | null,
  rawMessage: string,
): MemoryItem[] {
  if (items.length === 0) return [];
  const normalizedTarget = normalize(target ?? "");
  const normalizedMessage = normalize(rawMessage);
  if (isRecentReference(normalizedTarget || normalizedMessage)) {
    return [newest(items)];
  }

  const targetTerms = meaningfulTerms(
    normalizedTarget || targetFromMessage(normalizedMessage),
  );
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
  rawMessage: string,
): string {
  const candidate = (target?.trim() || targetFromMessage(normalize(rawMessage)))
    .replaceAll(/[.!?]+$/gu, "")
    .trim();
  if (!candidate || isRecentReference(normalize(candidate))) return "yang tadi";
  return candidate.slice(0, 80);
}

function newest(items: readonly MemoryItem[]): MemoryItem {
  return [...items].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id))[0]!;
}

function isRecentReference(value: string): boolean {
  return /\b(yang tadi|barusan|baru saja|terakhir)\b/u.test(value);
}

function targetFromMessage(value: string): string {
  const topic = /\b(?:soal|tentang|mengenai|bagian)\s+(.+)$/u.exec(value)?.[1];
  if (topic) return topic;
  return value
    .replaceAll(
      /\b(?:tolong|dong|ya|deh|lupain|lupakan|melupakan|hapus|hilangkan|jangan|disimpan|simpan|ingat|diingat|dicatat|catat|semua|seluruh|yang|kamu|kau|tahu|aku)\b/gu,
      " ",
    )
    .replaceAll(/\s+/gu, " ")
    .trim();
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
