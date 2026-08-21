import type {
  CapabilitySnapshot,
  CapabilitySnapshotEntry,
} from "./capabilities.js";
import type { AgentCallableCapability } from "./agent-harness.js";

export interface CapabilityDiscoveryMatch extends Pick<
  CapabilitySnapshotEntry,
  "id" | "version" | "title" | "description" | "effect" | "available"
> {
  score: number;
}

export interface CapabilityDiscoveryResult {
  snapshotHash: string;
  mode: "focused" | "high_recall";
  matches: readonly CapabilityDiscoveryMatch[];
  /** True when focused retrieval missed and metadata fallback was used. */
  fallback: boolean;
  /** Content-free pagination for high-recall scans; null means exhausted. */
  nextOffset: number | null;
}

/**
 * Provider-neutral metadata retrieval. It never returns native schemas,
 * executors, credentials, or new authority.
 */
export function discoverCapabilities(
  snapshot: CapabilitySnapshot,
  query: string,
  options: {
    mode?: "focused" | "high_recall";
    limit?: number;
    offset?: number;
  } = {},
): CapabilityDiscoveryResult {
  const clean = query.normalize("NFKC").trim().slice(0, 240);
  if (!clean) throw new Error("Query discovery capability kosong.");
  const mode = options.mode ?? "focused";
  const maximum = mode === "high_recall" ? 50 : 5;
  const limit = options.limit ?? maximum;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error("Limit discovery capability tidak sah.");
  }
  if (
    !Number.isSafeInteger(offset) || offset < 0 ||
    (mode === "focused" && offset !== 0) || offset > snapshot.entries.length
  ) throw new Error("Offset discovery capability tidak sah.");
  const tokens = lexicalTokens(clean);
  const scored = snapshot.entries
    .map((entry) => ({ entry, score: capabilityScore(entry, tokens) }))
    .filter(({ score }) => mode === "high_recall" || score > 0)
    .sort((left, right) =>
      right.score - left.score || left.entry.id.localeCompare(right.entry.id, "en")
    );
  const fallback = mode === "focused" && scored.length === 0;
  const candidates = fallback
    ? snapshot.entries
        .filter((entry) => entry.available)
        .map((entry) => ({ entry, score: 0 }))
    : scored;
  const matches = candidates.slice(offset, offset + limit).map(({ entry, score }) =>
    Object.freeze({
      id: entry.id,
      version: entry.version,
      title: entry.title,
      description: entry.description,
      effect: entry.effect,
      available: entry.available,
      score,
    })
  );
  return Object.freeze({
    snapshotHash: snapshot.hash,
    mode,
    matches: Object.freeze(matches),
    fallback,
    nextOffset:
      mode === "high_recall" && offset + matches.length < candidates.length
        ? offset + matches.length
        : null,
  });
}

/**
 * Converts discovery metadata to a schema shortlist only by intersecting with
 * the already code-owned callable set. Retrieval can remove context presence;
 * it can never make an unavailable/unauthorized capability executable.
 */
export function shortlistCallableCapabilities(
  discovery: CapabilityDiscoveryResult,
  callable: readonly AgentCallableCapability[],
): readonly AgentCallableCapability[] {
  const selected = new Set(
    discovery.matches
      .filter((match) => match.available)
      .map((match) => `${match.id}\u0000${match.version}`),
  );
  return Object.freeze(callable.filter((entry) =>
    selected.has(`${entry.id}\u0000${entry.version}`)
  ));
}

function capabilityScore(
  entry: CapabilitySnapshotEntry,
  tokens: readonly string[],
): number {
  const id = entry.id.toLocaleLowerCase("en-US");
  const title = entry.title.toLocaleLowerCase("id-ID");
  const description = entry.description.toLocaleLowerCase("id-ID");
  let score = 0;
  for (const token of tokens) {
    if (id === token) score += 20;
    else if (id.includes(token)) score += 8;
    if (title.includes(token)) score += 5;
    if (description.includes(token)) score += 2;
  }
  return score + (entry.available && score > 0 ? 1 : 0);
}

function lexicalTokens(value: string): readonly string[] {
  return Object.freeze([
    ...new Set(
      value
        .toLocaleLowerCase("id-ID")
        .split(/[^\p{L}\p{N}_.]+/u)
        .filter((token) => token.length >= 2)
        .slice(0, 24),
    ),
  ]);
}
