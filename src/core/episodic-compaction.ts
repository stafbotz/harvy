import { createHash, randomUUID } from "node:crypto";
import {
  EPISODE_CLAIM_MAX_CHARS,
  EPISODE_CLAIMS_PER_FIELD_LIMIT,
  EPISODE_SCHEMA_VERSION,
  EPISODE_TOTAL_CLAIMS_LIMIT,
  HISTORY_EPISODE_CONTEXT_LIMIT,
  HISTORY_EPISODE_RETENTION_LIMIT,
  type ConversationEpisode,
  type EpisodeClaim,
  type EpisodeSummaryDraft,
  type StoredConversationTurn,
} from "../domain/history.js";

export {
  EPISODE_CLAIM_MAX_CHARS,
  EPISODE_CLAIMS_PER_FIELD_LIMIT,
  EPISODE_TOTAL_CLAIMS_LIMIT,
  HISTORY_EPISODE_CONTEXT_LIMIT,
  HISTORY_EPISODE_RETENTION_LIMIT,
} from "../domain/history.js";
import { harvestEpisodeAnchors } from "./episode-anchors.js";

export const EPISODE_SUMMARIZER_VERSION = "episodic-v2.0";
export const HISTORY_EPISODE_CONTEXT_MAX_CHARS = 3_000;

export const EPISODE_CLAIM_FIELDS = [
  "topics",
  "facts",
  "goals",
  "decisions",
  "corrections",
  "commitments",
  "unresolved",
  "progress",
  "temporalAnchors",
  "uncertainties",
] as const satisfies readonly (keyof EpisodeSummaryDraft)[];

const EPISODE_CONTEXT_FIELD_PRIORITY = [
  "corrections",
  "unresolved",
  // Tepat sesudah "belum selesai": ketika konteks dipangkas, apa yang sudah
  // bisa dikerjakan penggunanya sama pentingnya dengan apa yang belum.
  "progress",
  "commitments",
  "decisions",
  "goals",
  "temporalAnchors",
  "uncertainties",
  "facts",
  "topics",
] as const satisfies readonly (keyof EpisodeSummaryDraft)[];

type EpisodeClaimField = (typeof EPISODE_CLAIM_FIELDS)[number];

export function episodeDraftHasClaims(draft: EpisodeSummaryDraft): boolean {
  return EPISODE_CLAIM_FIELDS.some((field) => draft[field].length > 0);
}

/**
 * Empty episode boleh membuang basa-basi, tetapi tidak boleh menghapus source
 * yang jelas membawa artefak atau pekerjaan substantif. False positive di
 * sini hanya menahan raw turn untuk retry; false negative menghilangkan
 * konteks pengguna secara permanen dari hot history.
 */
export function episodeSourceRequiresClaims(
  turns: readonly StoredConversationTurn[],
): boolean {
  const texts = turns.map((turn) => turn.text.trim()).filter(Boolean);
  const totalCharacters = texts.reduce((sum, text) => sum + text.length, 0);
  return totalCharacters >= 480 || texts.some((text) =>
    text.length >= 160 ||
    /```[\s\S]*?```/u.test(text) ||
    text.split(/\r?\n/u).filter((line) => line.trim()).length >= 3
  );
}

/**
 * Membaca rancangan episode sebagai input tidak tepercaya.
 *
 * Semua field wajib hadir, bahkan bila kosong. Setiap klaim wajib menunjuk
 * sedikitnya satu sequence dari snapshot yang sedang dipadatkan; model tidak
 * dapat menciptakan provenance atau menunjuk percakapan di luar rentang itu.
 */
export function readEpisodeSummaryDraft(
  value: unknown,
  allowedSequences: ReadonlySet<number>,
): EpisodeSummaryDraft | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, EPISODE_CLAIM_FIELDS)
  ) {
    return null;
  }

  const result = {} as Record<EpisodeClaimField, EpisodeClaim[]>;
  let totalClaims = 0;

  for (const field of EPISODE_CLAIM_FIELDS) {
    const rawClaims = value[field];
    if (
      !Array.isArray(rawClaims) ||
      rawClaims.length > EPISODE_CLAIMS_PER_FIELD_LIMIT
    ) {
      return null;
    }

    const claims: EpisodeClaim[] = [];
    for (const rawClaim of rawClaims) {
      const claim = readClaim(rawClaim, allowedSequences);
      if (!claim) return null;
      claims.push(claim);
    }
    totalClaims += claims.length;
    if (totalClaims > EPISODE_TOTAL_CLAIMS_LIMIT) return null;
    result[field] = claims;
  }

  return result;
}

/** SHA-256 dari sequence, peran, waktu, dan teks sumber dalam bentuk kanonik. */
export function episodeSourceHash(
  turns: readonly StoredConversationTurn[],
): string {
  const canonical = turns.map((turn) => [
    turn.sequence,
    turn.role,
    turn.at,
    turn.text,
  ]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** Mendeteksi perubahan episode selama peringkas bekerja di luar antrean. */
export function episodeCoverageHash(
  episodes: readonly ConversationEpisode[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(episodes), "utf8")
    .digest("hex");
}

export function createConversationEpisode(
  draft: unknown,
  turns: readonly StoredConversationTurn[],
  createdAt: string,
  makeId: () => string = randomUUID,
): ConversationEpisode | null {
  if (!isContiguousSource(turns)) return null;

  const allowedSequences = new Set(turns.map((turn) => turn.sequence));
  const cleanDraft = readEpisodeSummaryDraft(draft, allowedSequences);
  const first = turns[0];
  const last = turns.at(-1);
  if (!cleanDraft || !first || !last) return null;
  if (
    !episodeDraftHasClaims(cleanDraft) && episodeSourceRequiresClaims(turns)
  ) return null;

  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: `episode_${makeId().replaceAll("-", "").slice(0, 20)}`,
    // Dipanen sesudah model menjawab, dari giliran sumbernya sendiri. Klaim
    // memberi konteks; anchor menjamin token persisnya selamat.
    anchors: harvestEpisodeAnchors(turns),
    source: {
      kind: "turn-range",
      fromSequence: first.sequence,
      throughSequence: last.sequence,
      turnCount: turns.length,
      sourceHash: episodeSourceHash(turns),
    },
    summarizerVersion: EPISODE_SUMMARIZER_VERSION,
    createdAt,
    ...cleanDraft,
  };
}

/**
 * Menambah episode secara monoton dan memangkas hot corpus. Caller wajib
 * menulis episode ke cold archive lebih dulu; fungsi ini hanya mengatur working
 * set JSON yang murah, bukan retention lifetime pengguna.
 */
export function retainConversationEpisode(
  episodes: readonly ConversationEpisode[],
  episode: ConversationEpisode,
): ConversationEpisode[] | null {
  if (episode.source.kind !== "turn-range") return null;
  const latestRange = [...episodes]
    .reverse()
    .find((candidate) => candidate.source.kind === "turn-range")?.source;
  if (
    latestRange?.kind === "turn-range" &&
    latestRange.throughSequence + 1 !== episode.source.fromSequence
  ) {
    return null;
  }

  return [...episodes, episode].slice(-HISTORY_EPISODE_RETENTION_LIMIT);
}

/**
 * Merender episode terbaru lebih dulu agar clipping downstream selalu
 * mempertahankan kelanjutan paling dekat. Hash, ID, dan sequence provenance
 * tetap di penyimpanan/ekspor dan tidak menghabiskan attention budget model.
 */
export function renderEpisodeContext(
  episodes: readonly ConversationEpisode[],
  maxCharacters = HISTORY_EPISODE_CONTEXT_MAX_CHARS,
): string | null {
  if (maxCharacters <= 0) return null;

  const preface = [
    "Episode percakapan, terbaru ke terlama.",
    "Koreksi yang lebih baru mengalahkan catatan lama yang bertentangan.",
    // Tanpa baris ini model tidak punya cara tahu bahwa yang hilang dari
    // ringkasan masih ada. Ia lalu menebak—dan tebakan tentang tanggal ujian
    // atau nomor bab adalah bentuk kekeliruan yang paling merugikan. Dibayar
    // pada setiap giliran, jadi ditulis sependek mungkin.
    "Giliran aslinya masih tersimpan dan dapat dicari: kalau sebuah detail tidak ada di sini, cari dulu alih-alih menebak.",
  ];
  const lines = [...preface];
  let included = 0;

  for (const episode of episodes
    .slice(-HISTORY_EPISODE_CONTEXT_LIMIT)
    .reverse()) {
    const details = episodeLines(episode);
    if (details.length === 0) continue;

    const heading = episode.source.kind === "turn-range"
      ? `Episode ${episode.source.fromSequence}-${episode.source.throughSequence}:`
      : "Episode warisan v1 (provenance tidak tersedia):";
    const firstLine = [...lines, "", heading, details[0]!].join("\n");
    if (firstLine.length > maxCharacters) {
      return included === 0 ? clipText(firstLine, maxCharacters) : lines.join("\n");
    }

    lines.push("", heading);
    let detailCount = 0;
    for (const detail of details) {
      if ([...lines, detail].join("\n").length > maxCharacters) break;
      lines.push(detail);
      detailCount += 1;
    }
    included += 1;
    if (detailCount < details.length) {
      const marker = "- … klaim lain dipotong oleh batas konteks.";
      if ([...lines, marker].join("\n").length <= maxCharacters) {
        lines.push(marker);
      }
      break;
    }
  }

  return included > 0 ? lines.join("\n") : null;
}

function readClaim(
  value: unknown,
  allowedSequences: ReadonlySet<number>,
): EpisodeClaim | null {
  if (!isRecord(value) || !hasExactKeys(value, ["text", "sourceSequences"])) {
    return null;
  }
  const rawText = typeof value["text"] === "string" ? value["text"] : "";
  if (/\p{C}/u.test(rawText)) return null;
  const text = rawText.trim().replaceAll(/\s+/gu, " ");
  const rawSources = value["sourceSequences"];
  if (
    !text ||
    text.length > EPISODE_CLAIM_MAX_CHARS ||
    !Array.isArray(rawSources) ||
    rawSources.length === 0 ||
    rawSources.length > allowedSequences.size
  ) {
    return null;
  }

  const sources: number[] = [];
  for (const source of rawSources) {
    if (
      !Number.isSafeInteger(source) ||
      !allowedSequences.has(source as number) ||
      sources.includes(source as number)
    ) {
      return null;
    }
    sources.push(source as number);
  }
  sources.sort((left, right) => left - right);
  return { text, sourceSequences: sources };
}

function isContiguousSource(
  turns: readonly StoredConversationTurn[],
): boolean {
  if (turns.length === 0) return false;
  return turns.every(
    (turn, index) =>
      Number.isSafeInteger(turn.sequence) &&
      turn.sequence > 0 &&
      (index === 0 || turn.sequence === turns[index - 1]!.sequence + 1),
  );
}

function episodeLines(episode: ConversationEpisode): string[] {
  if (episode.source.kind === "legacy-summary") {
    return EPISODE_CLAIM_FIELDS.flatMap((field) => episode[field])
      .map((claim) => `- ringkasan lama, belum terklasifikasi: ${claim.text}`);
  }

  const labels: Record<EpisodeClaimField, string> = {
    topics: "topik",
    facts: "fakta",
    goals: "tujuan",
    decisions: "keputusan",
    corrections: "koreksi",
    commitments: "komitmen",
    unresolved: "belum selesai",
    progress: "sudah bisa",
    temporalAnchors: "waktu",
    uncertainties: "belum pasti",
  };
  const lines: string[] = [];
  for (const field of EPISODE_CONTEXT_FIELD_PRIORITY) {
    for (const claim of episode[field]) {
      lines.push(`- ${labels[field]}: ${claim.text}`);
    }
  }
  // Anchor SENGAJA tidak dirender ke konteks giliran.
  //
  // Hipotesisnya masuk akal dan ternyata salah. `npm run eval:compaction`
  // 4 September 2026 mengukurnya dengan arm terpisah: 93,8% utuh, 87,5% tanpa
  // anchor, 75,0% dengan anchor—turun 12,5 poin dan konteksnya lebih besar,
  // konsisten di kedua transkrip. Dugaan sebabnya deretan token telanjang
  // mengencerkan perhatian penjawab, tetapi itu belum diuji.
  //
  // Panennya tetap disimpan pada episode: ia deterministik, murah, dan
  // membawa provenance sequence, sehingga tetap berguna sebagai jangkar
  // pencarian riwayat. Yang dicabut hanya penyuntikannya ke setiap giliran,
  // karena justru itu yang diukur dan ditolak.
  return lines;
}

function clipText(value: string, maxCharacters: number): string | null {
  if (maxCharacters <= 0) return null;
  if (value.length <= maxCharacters) return value;
  if (maxCharacters === 1) return "…";
  return `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}
