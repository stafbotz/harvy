import type {
  ConversationEpisode,
  EpisodeClaim,
  EpisodeClaimField,
  HistoricalEpisodeClaimMatch,
  HistoricalEpisodeMatch,
} from "../domain/history.js";
import { EPISODE_CLAIM_FIELDS } from "./episodic-compaction.js";

export const HISTORY_SEARCH_QUERY_MAX_CHARS = 500;
export const HISTORY_SEARCH_QUERY_TERM_LIMIT = 16;
export const HISTORY_SEARCH_DEFAULT_RESULT_LIMIT = 4;
export const HISTORY_SEARCH_RESULT_LIMIT = 8;
export const HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT = 6;

export interface HistorySearchOptions {
  limit?: number;
}

interface IndexedClaim {
  field: EpisodeClaimField;
  claimIndex: number;
  claim: EpisodeClaim;
  normalizedText: string;
  termFrequency: ReadonlyMap<string, number>;
}

interface IndexedEpisode {
  episode: ConversationEpisode;
  claims: IndexedClaim[];
  terms: ReadonlySet<string>;
}

/**
 * Pencarian full-text leksikal atas satu candidate set episode yang bounded.
 *
 * Hot store membangun index kecil ini setiap pemanggilan; cold adapter memakai
 * FTS5 untuk memilih candidate lalu menggunakan scorer yang sama. Hasil tetap
 * proposal konteks yang tidak tepercaya, bukan fakta atau authority.
 */
export function searchConversationEpisodes(
  episodes: readonly ConversationEpisode[],
  query: string,
  options: HistorySearchOptions = {},
): HistoricalEpisodeMatch[] {
  const queryText = normalizeText(
    query.slice(0, HISTORY_SEARCH_QUERY_MAX_CHARS),
  );
  const queryTerms = [...new Set(searchTerms(queryText))]
    .slice(0, HISTORY_SEARCH_QUERY_TERM_LIMIT);
  if (queryTerms.length === 0 || episodes.length === 0) return [];

  const indexed = episodes.map(indexEpisode);
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      indexed.reduce(
        (count, episode) => count + (episode.terms.has(term) ? 1 : 0),
        0,
      ),
    );
  }

  const matches = indexed
    .map((episode) => scoreEpisode(
      episode,
      queryText,
      queryTerms,
      documentFrequency,
      indexed.length,
    ))
    .filter((match): match is HistoricalEpisodeMatch => match !== null)
    .sort(compareMatches);

  return matches.slice(0, boundedResultLimit(options.limit));
}

function indexEpisode(episode: ConversationEpisode): IndexedEpisode {
  const claims: IndexedClaim[] = [];
  const terms = new Set<string>();

  for (const field of EPISODE_CLAIM_FIELDS) {
    for (let claimIndex = 0; claimIndex < episode[field].length; claimIndex += 1) {
      const claim = episode[field][claimIndex]!;
      const normalizedText = normalizeText(claim.text);
      const termFrequency = frequencyOf(searchTerms(normalizedText));
      for (const term of termFrequency.keys()) terms.add(term);
      claims.push({ field, claimIndex, claim, normalizedText, termFrequency });
    }
  }

  return { episode, claims, terms };
}

function scoreEpisode(
  indexed: IndexedEpisode,
  queryText: string,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
): HistoricalEpisodeMatch | null {
  const claims: HistoricalEpisodeClaimMatch[] = [];
  const matchedTerms = new Set<string>();

  for (const indexedClaim of indexed.claims) {
    let score = 0;
    let claimMatchedTerms = 0;
    for (const term of queryTerms) {
      const frequency = indexedClaim.termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;
      claimMatchedTerms += 1;
      matchedTerms.add(term);
      const containingDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (documentCount - containingDocuments + 0.5) /
          (containingDocuments + 0.5),
      );
      score += inverseDocumentFrequency * (1 + Math.min(frequency - 1, 2) * 0.2);
    }
    if (claimMatchedTerms === 0) continue;

    const coverage = claimMatchedTerms / queryTerms.length;
    score += coverage * 2;
    if (queryText.length >= 4 && indexedClaim.normalizedText.includes(queryText)) {
      score += 3;
    }
    claims.push({
      field: indexedClaim.field,
      claimIndex: indexedClaim.claimIndex,
      text: indexedClaim.claim.text,
      sourceSequences: [...indexedClaim.claim.sourceSequences],
      score: roundScore(score),
    });
  }

  if (claims.length === 0) return null;
  claims.sort((left, right) =>
    right.score - left.score ||
    compareOrdinal(left.field, right.field) ||
    compareOrdinal(left.text, right.text));
  const selectedClaims = claims.slice(0, HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT);
  const coverage = matchedTerms.size / queryTerms.length;
  const score = selectedClaims.reduce((total, claim) => total + claim.score, 0) +
    coverage * 4;

  return {
    episodeId: indexed.episode.episodeId,
    createdAt: indexed.episode.createdAt,
    source: structuredClone(indexed.episode.source),
    score: roundScore(score),
    claims: selectedClaims,
  };
}

function compareMatches(
  left: HistoricalEpisodeMatch,
  right: HistoricalEpisodeMatch,
): number {
  const score = right.score - left.score;
  if (score !== 0) return score;
  const recency = compareOrdinal(right.createdAt, left.createdAt);
  return recency !== 0
    ? recency
    : compareOrdinal(left.episodeId, right.episodeId);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedResultLimit(limit: number | undefined): number {
  if (limit === undefined) return HISTORY_SEARCH_DEFAULT_RESULT_LIMIT;
  if (!Number.isFinite(limit)) return HISTORY_SEARCH_DEFAULT_RESULT_LIMIT;
  return Math.max(0, Math.min(HISTORY_SEARCH_RESULT_LIMIT, Math.floor(limit)));
}

function frequencyOf(terms: readonly string[]): ReadonlyMap<string, number> {
  const frequency = new Map<string, number>();
  for (const term of terms) {
    frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  return frequency;
}

function searchTerms(value: string): string[] {
  return (value.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) =>
      (term.length >= 2 || /^\p{N}+$/u.test(term)) && !STOP_WORDS.has(term));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const STOP_WORDS = new Set([
  "ada",
  "aku",
  "atau",
  "bisa",
  "dari",
  "dan",
  "dengan",
  "gak",
  "ga",
  "harvy",
  "ini",
  "itu",
  "kamu",
  "mau",
  "nggak",
  "sudah",
  "tadi",
  "tidak",
  "untuk",
  "udah",
  "yang",
]);
