import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  EPISODE_CLAIM_MAX_CHARS,
  EPISODE_CLAIMS_PER_FIELD_LIMIT,
  EPISODE_SCHEMA_VERSION,
  EPISODE_TOTAL_CLAIMS_LIMIT,
  HISTORY_EPISODE_RETENTION_LIMIT,
  HISTORY_LEGACY_SUMMARY_MAX_CHARS,
  HISTORY_TURN_MAX_CHARS,
  type ConversationEpisode,
  type ConversationHistory,
  type EpisodeClaim,
  type EpisodeSummaryDraft,
  type HistoryRepository,
  type StoredConversationTurn,
} from "../domain/history.js";

interface HistoryDatabase {
  version: 2;
  histories: ConversationHistory[];
}

interface LegacyHistoryDatabase {
  version: 1;
  histories: unknown[];
}

const EPISODE_FIELDS = [
  "topics",
  "facts",
  "goals",
  "decisions",
  "corrections",
  "commitments",
  "unresolved",
  "temporalAnchors",
  "uncertainties",
] as const satisfies readonly (keyof EpisodeSummaryDraft)[];

/**
 * Penyimpanan riwayat percakapan berupa satu berkas JSON.
 *
 * Berkas ini berisi kata-kata pengguna apa adanya, bukan sekadar judul tugas.
 * Nilainya bagi orang lain jauh lebih tinggi daripada `tasks.json`, dan itulah
 * alasan pemadatan pada `HistoryService` bukan sekadar penghematan tempat.
 *
 * Pembacaan juga diserialisasi karena load v1 melakukan migrasi atomik ke v2.
 */
export class FileHistoryRepository implements HistoryRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(ownerId: string): Promise<ConversationHistory | null> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      return (
        database.histories.find((history) => history.ownerId === ownerId) ?? null
      );
    });
  }

  async save(history: ConversationHistory): Promise<void> {
    await this.exclusive(async () => {
      const validated = readHistoryV2(history);
      if (!validated) {
        throw new Error("Riwayat v2 yang akan disimpan tidak sah.");
      }

      const database = await this.readDatabase();
      const index = database.histories.findIndex(
        (stored) => stored.ownerId === validated.ownerId,
      );

      if (index >= 0) {
        database.histories[index] = validated;
      } else {
        database.histories.push(validated);
      }

      await this.writeDatabase(database);
    });
  }

  async remove(ownerId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.histories.findIndex(
        (history) => history.ownerId === ownerId,
      );
      if (index < 0) return false;

      database.histories.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  private async readDatabase(): Promise<HistoryDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !Array.isArray(parsed["histories"])) {
        throw new Error("Format basis data riwayat tidak dikenali.");
      }

      if (parsed["version"] === 1) {
        const database = migrateLegacyDatabase({
          version: 1,
          histories: parsed["histories"],
        });
        await this.writeDatabase(database);
        return database;
      }
      if (parsed["version"] !== 2) {
        throw new Error("Format basis data riwayat tidak dikenali.");
      }

      const histories = parsed["histories"].map(readHistoryV2);
      if (histories.some((history) => history === null)) {
        throw new Error("Isi basis data riwayat v2 tidak sah.");
      }
      return {
        version: 2,
        histories: histories as ConversationHistory[],
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 2, histories: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: HistoryDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function migrateLegacyDatabase(database: LegacyHistoryDatabase): HistoryDatabase {
  const histories = database.histories.map(migrateLegacyHistory);
  if (histories.some((history) => history === null)) {
    throw new Error("Isi basis data riwayat v1 tidak sah.");
  }
  return { version: 2, histories: histories as ConversationHistory[] };
}

function migrateLegacyHistory(value: unknown): ConversationHistory | null {
  if (!isRecord(value)) return null;
  const ownerId = readNonEmptyString(value["ownerId"]);
  const updatedAt = readNonEmptyString(value["updatedAt"]);
  const rawTurns = value["turns"];
  const rawSummary = value["summary"];
  if (
    !ownerId ||
    !updatedAt ||
    !Array.isArray(rawTurns) ||
    (rawSummary !== null && typeof rawSummary !== "string")
  ) {
    return null;
  }

  const turns: StoredConversationTurn[] = [];
  for (let index = 0; index < rawTurns.length; index += 1) {
    const turn = readLegacyTurn(rawTurns[index], index + 1);
    if (!turn) return null;
    turns.push(turn);
  }

  const summary = typeof rawSummary === "string"
    ? normalizeLegacySummary(rawSummary)
    : "";
  if (summary === null) return null;
  const episodes = summary ? [legacyEpisode(summary, updatedAt)] : [];
  return {
    ownerId,
    episodes,
    turns,
    nextSequence: turns.length + 1,
    updatedAt,
  };
}

function legacyEpisode(summary: string, createdAt: string): ConversationEpisode {
  const sourceHash = createHash("sha256")
    .update(`legacy-summary:${summary}`, "utf8")
    .digest("hex");
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: `legacy_${sourceHash.slice(0, 20)}`,
    source: { kind: "legacy-summary", sourceHash },
    summarizerVersion: "rolling-v1",
    createdAt,
    topics: [],
    facts: [{ text: summary, sourceSequences: [] }],
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}

function readHistoryV2(value: unknown): ConversationHistory | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "ownerId",
      "episodes",
      "turns",
      "nextSequence",
      "updatedAt",
    ])
  ) return null;
  const ownerId = readNonEmptyString(value["ownerId"]);
  const updatedAt = readNonEmptyString(value["updatedAt"]);
  const nextSequence = value["nextSequence"];
  const rawTurns = value["turns"];
  const rawEpisodes = value["episodes"];
  if (
    !ownerId ||
    !updatedAt ||
    !Number.isSafeInteger(nextSequence) ||
    (nextSequence as number) <= 0 ||
    !Array.isArray(rawTurns) ||
    !Array.isArray(rawEpisodes) ||
    rawEpisodes.length > HISTORY_EPISODE_RETENTION_LIMIT
  ) {
    return null;
  }

  const turns: StoredConversationTurn[] = [];
  for (const rawTurn of rawTurns) {
    const turn = readStoredTurn(rawTurn);
    if (!turn) return null;
    const previous = turns.at(-1);
    if (previous && turn.sequence !== previous.sequence + 1) return null;
    turns.push(turn);
  }

  const episodes: ConversationEpisode[] = [];
  let latestThrough = 0;
  let hasTurnRange = false;
  for (const rawEpisode of rawEpisodes) {
    const episode = readEpisode(rawEpisode);
    if (!episode) return null;
    if (episode.source.kind === "turn-range") {
      if (
        hasTurnRange &&
        episode.source.fromSequence !== latestThrough + 1
      ) {
        return null;
      }
      latestThrough = episode.source.throughSequence;
      hasTurnRange = true;
    }
    episodes.push(episode);
  }

  const firstTurn = turns[0];
  const lastTurn = turns.at(-1);
  if (
    firstTurn &&
    firstTurn.sequence !== (hasTurnRange ? latestThrough + 1 : 1)
  ) {
    return null;
  }
  const greatestSequence = Math.max(latestThrough, lastTurn?.sequence ?? 0);
  if ((nextSequence as number) <= greatestSequence) return null;

  return {
    ownerId,
    episodes,
    turns,
    nextSequence: nextSequence as number,
    updatedAt,
  };
}

function readEpisode(value: unknown): ConversationEpisode | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "episodeId",
      "source",
      "summarizerVersion",
      "createdAt",
      ...EPISODE_FIELDS,
    ]) ||
    value["schemaVersion"] !== EPISODE_SCHEMA_VERSION
  ) {
    return null;
  }
  const episodeId = readNonEmptyString(value["episodeId"]);
  const summarizerVersion = readNonEmptyString(value["summarizerVersion"]);
  const createdAt = readNonEmptyString(value["createdAt"]);
  const source = readEpisodeSource(value["source"]);
  if (!episodeId || !summarizerVersion || !createdAt || !source) return null;

  const claims = {} as Record<keyof EpisodeSummaryDraft, EpisodeClaim[]>;
  let totalClaims = 0;
  for (const field of EPISODE_FIELDS) {
    const rawClaims = value[field];
    if (
      !Array.isArray(rawClaims) ||
      rawClaims.length > EPISODE_CLAIMS_PER_FIELD_LIMIT
    ) {
      return null;
    }
    const parsed: EpisodeClaim[] = [];
    for (const rawClaim of rawClaims) {
      const claim = readStoredClaim(rawClaim, source);
      if (!claim) return null;
      parsed.push(claim);
    }
    totalClaims += parsed.length;
    if (totalClaims > EPISODE_TOTAL_CLAIMS_LIMIT) return null;
    claims[field] = parsed;
  }

  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId,
    source,
    summarizerVersion,
    createdAt,
    ...claims,
  };
}

function readEpisodeSource(value: unknown): ConversationEpisode["source"] | null {
  if (!isRecord(value) || !isSha256(value["sourceHash"])) return null;
  if (value["kind"] === "legacy-summary") {
    if (!hasExactKeys(value, ["kind", "sourceHash"])) return null;
    return { kind: "legacy-summary", sourceHash: value["sourceHash"] };
  }
  if (value["kind"] !== "turn-range") return null;
  if (!hasExactKeys(value, [
    "kind",
    "fromSequence",
    "throughSequence",
    "turnCount",
    "sourceHash",
  ])) return null;

  const fromSequence = value["fromSequence"];
  const throughSequence = value["throughSequence"];
  const turnCount = value["turnCount"];
  if (
    !Number.isSafeInteger(fromSequence) ||
    !Number.isSafeInteger(throughSequence) ||
    !Number.isSafeInteger(turnCount) ||
    (fromSequence as number) <= 0 ||
    (throughSequence as number) < (fromSequence as number) ||
    turnCount !== (throughSequence as number) - (fromSequence as number) + 1
  ) {
    return null;
  }
  return {
    kind: "turn-range",
    fromSequence: fromSequence as number,
    throughSequence: throughSequence as number,
    turnCount: turnCount as number,
    sourceHash: value["sourceHash"],
  };
}

function readStoredClaim(
  value: unknown,
  source: ConversationEpisode["source"],
): EpisodeClaim | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["text", "sourceSequences"]) ||
    typeof value["text"] !== "string"
  ) return null;
  const text = value["text"].trim();
  const rawSequences = value["sourceSequences"];
  if (
    !text ||
    text.length > (source.kind === "legacy-summary"
      ? HISTORY_LEGACY_SUMMARY_MAX_CHARS
      : EPISODE_CLAIM_MAX_CHARS) ||
    /\p{C}/u.test(text) ||
    !Array.isArray(rawSequences)
  ) {
    return null;
  }
  if (source.kind === "turn-range" && rawSequences.length === 0) return null;
  if (source.kind === "legacy-summary" && rawSequences.length > 0) return null;

  const sourceSequences: number[] = [];
  for (const rawSequence of rawSequences) {
    if (
      !Number.isSafeInteger(rawSequence) ||
      source.kind !== "turn-range" ||
      (rawSequence as number) < source.fromSequence ||
      (rawSequence as number) > source.throughSequence ||
      sourceSequences.includes(rawSequence as number)
    ) {
      return null;
    }
    sourceSequences.push(rawSequence as number);
  }
  return { text, sourceSequences };
}

function readStoredTurn(value: unknown): StoredConversationTurn | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sequence", "role", "text", "at"]) ||
    !Number.isSafeInteger(value["sequence"])
  ) return null;
  return readTurn(value, value["sequence"] as number);
}

function readLegacyTurn(
  value: unknown,
  sequence: number,
): StoredConversationTurn | null {
  return isRecord(value) && hasExactKeys(value, ["role", "text", "at"])
    ? readTurn(value, sequence)
    : null;
}

function readTurn(
  value: Record<string, unknown>,
  sequence: number,
): StoredConversationTurn | null {
  const role = value["role"];
  const text = value["text"];
  const at = value["at"];
  if (
    sequence <= 0 ||
    (role !== "user" && role !== "harvy") ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > HISTORY_TURN_MAX_CHARS ||
    typeof at !== "string"
  ) {
    return null;
  }
  return { sequence, role, text, at };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeLegacySummary(value: string): string | null {
  const clean = value.trim().replaceAll(/\s+/gu, " ");
  if (!clean) return "";
  return clean.length <= HISTORY_LEGACY_SUMMARY_MAX_CHARS && !/\p{C}/u.test(clean)
    ? clean
    : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
