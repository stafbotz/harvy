import type { HarvyContext } from "../ai/context.js";
import type {
  ConversationEpisode,
  HistoricalEpisodeMatch,
} from "../domain/history.js";
import { HISTORY_EPISODE_CONTEXT_LIMIT } from "../domain/history.js";
import type {
  RetrievedMemoryEvidence,
  RetrievedMemorySource,
} from "../domain/memory-knowledge.js";
import type { LongTermMemoryRetriever } from "../domain/long-term-memory.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import type { HistoryService } from "./history-service.js";
import {
  EPISODE_CLAIM_FIELDS,
  renderEpisodeContext,
} from "./episodic-compaction.js";
import {
  episodeSemanticDocuments,
  type MemoryKnowledgeService,
} from "./memory-knowledge-service.js";
import { privateMemoryNamespace } from "./memory-namespace.js";
import {
  memoryPlanUsesRetrieval,
  planMemoryQuery,
  type MemoryQueryPlan,
} from "./memory-query-plan.js";

const RRF_K = 60;
const RETRIEVED_ITEM_MAX_CHARACTERS = 500;

export interface MemoryRetrievalManifest {
  readonly version: 1;
  readonly planUsed: boolean;
  readonly episodicRequested: boolean;
  readonly semanticRequested: boolean;
  readonly graphRequested: boolean;
  readonly personalizationRequested: boolean;
  readonly proceduralRequested: boolean;
  readonly errorLessonsRequested: boolean;
  readonly semanticProviderAvailable: boolean;
  readonly episodicResultCount: number;
  readonly semanticResultCount: number;
  readonly graphResultCount: number;
  readonly personalizationResultCount: number;
  readonly proceduralResultCount: number;
  readonly errorLessonResultCount: number;
  readonly suppressedCount: number;
  readonly deduplicatedCount: number;
  readonly selectedCount: number;
  readonly selectedCharacters: number;
  readonly failedRouteCount: number;
}

export interface CompiledMemoryContext {
  context: HarvyContext;
  plan: MemoryQueryPlan;
  /** Hanya counter/boolean; aman untuk observability. */
  manifest: MemoryRetrievalManifest;
}

export interface MemoryContextCompileOptions {
  allowRetrieval?: boolean;
  signal?: AbortSignal;
  semanticOperation?: import("../domain/semantic-operation.js").SemanticOperation | null;
}

/**
 * Menggabungkan lexical episode, vector semantic, dan graph melalui RRF.
 * Semua source tetap berstruktur sampai prompt renderer; compiler tidak pernah
 * menaruh hasil retrieval ke authority/capability maupun mengubah raw request.
 */
export class MemoryContextCompiler {
  constructor(
    private readonly history: HistoryService,
    private readonly knowledge: MemoryKnowledgeService,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.memory-context"),
    private readonly longTerm: LongTermMemoryRetriever | null = null,
  ) {}

  /** Normalisasi lokal selalu-on; tidak memanggil embedding/provider. */
  async normalizePrivateBase(
    ownerId: string,
    rawRequest: string,
    baseContext: HarvyContext,
    options: MemoryContextCompileOptions = {},
  ): Promise<HarvyContext> {
    const plan = planMemoryQuery(rawRequest, {
      allowRetrieval: false,
      now: this.now(),
      semanticOperation: options.semanticOperation ?? null,
    });
    return this.contextualizePrivate(ownerId, plan, baseContext, options);
  }

  async compilePrivate(
    ownerId: string,
    rawRequest: string,
    baseContext: HarvyContext,
    options: MemoryContextCompileOptions = {},
  ): Promise<CompiledMemoryContext> {
    const namespace = privateMemoryNamespace(ownerId);
    const plan = planMemoryQuery(rawRequest, {
      ...(options.allowRetrieval !== undefined
        ? { allowRetrieval: options.allowRetrieval }
        : {}),
      now: this.now(),
      semanticOperation: options.semanticOperation ?? null,
    });
    const empty = emptyManifest(plan, this.knowledge.hasSemanticProvider());
    if (options.signal?.aborted) {
      return { context: baseContext, plan, manifest: empty };
    }
    const normalizedBase = await this.contextualizePrivate(
      ownerId,
      plan,
      baseContext,
      options,
    );
    if (options.signal?.aborted) {
      return { context: baseContext, plan, manifest: empty };
    }
    const existingRetrieved = normalizedBase.retrieved ?? [];
    const contextualBase: HarvyContext = {
      summary: normalizedBase.summary,
      turns: normalizedBase.turns,
      memories: normalizedBase.memories,
      ...(normalizedBase.interactions
        ? { interactions: normalizedBase.interactions }
        : {}),
    };
    if (!memoryPlanUsesRetrieval(plan)) {
      this.logger.debug(
        "memory_retrieval_skipped",
        "Query plan memilih fast path tanpa long-term retrieval.",
        { reason: "no_relevant_route" },
      );
      const selected = fitContextPack(
        existingRetrieved,
        plan.limits.contextItems,
        plan.limits.contextCharacters,
      );
      return {
        context: selected.length === 0
          ? contextualBase
          : { ...contextualBase, retrieved: selected },
        plan,
        manifest: Object.freeze({
          ...empty,
          selectedCount: selected.length,
          selectedCharacters: selected.reduce(
            (total, evidence) => total + evidence.text.length,
            0,
          ),
        }),
      };
    }
    this.logger.debug(
      "memory_retrieval_planned",
      "Query plan memilih route memory secara selektif.",
      {
        episodic: plan.routes.episodic,
        semantic: plan.routes.semantic,
        graph: plan.routes.graph,
        personalization: plan.routes.personalization,
        procedural: plan.routes.procedural,
        errorLessons: plan.routes.errorLessons,
      },
    );

    let failedRouteCount = 0;
    let episodesPromise: Promise<Awaited<
      ReturnType<HistoryService["episodesForRetrieval"]>
    >> | null = null;
    const episodes = () => {
      episodesPromise ??= this.history.episodesForRetrieval(ownerId);
      return episodesPromise;
    };

    const episodicPromise = plan.routes.episodic
      ? this.history.search(ownerId, plan.query, {
          limit: plan.limits.perRoute,
        }).then((matches) => episodeMatchesToEvidence(
          filterEpisodeMatchesForPlan(matches, plan),
          plan,
        )).catch((error: unknown) => {
          failedRouteCount += 1;
          this.routeFailure("episodic", error);
          return [];
        })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);
    const semanticPromise = plan.routes.semantic &&
        this.knowledge.hasSemanticProvider()
      ? (plan.temporal.mode === "historical"
          ? episodes().then((source) => filterEpisodesForPlan(source, plan))
          : Promise.resolve([]))
          .then((source) => this.knowledge.searchSemantic(
            namespace,
            plan.query,
            {
              limit: plan.limits.perRoute,
              asOf: plan.temporal.asOf,
              includeHistorical: plan.temporal.mode === "historical",
              episodeDocuments: episodeSemanticDocuments(source),
              ...(options.signal ? { signal: options.signal } : {}),
            },
          ))
          .catch((error: unknown) => {
            failedRouteCount += 1;
            this.routeFailure("semantic", error);
            return [];
          })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);
    const graphPromise = plan.routes.graph
      ? this.knowledge.searchGraph(namespace, plan.query, {
          limit: plan.limits.perRoute,
          asOf: plan.temporal.asOf,
          includeHistorical: plan.temporal.mode === "historical",
          maxDepth: plan.limits.graphDepth,
        }).catch((error: unknown) => {
          failedRouteCount += 1;
          this.routeFailure("graph", error);
          return [];
        })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);
    const personalizationPromise = plan.routes.personalization && this.longTerm
      ? this.longTerm.searchUserModel(
          namespace,
          plan.query,
          plan.limits.perRoute,
        ).catch((error: unknown) => {
          failedRouteCount += 1;
          this.routeFailure("personalization", error);
          return [];
        })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);
    const proceduralPromise = plan.routes.procedural && this.longTerm
      ? this.longTerm.searchProcedures(namespace, plan.query, {
          limit: plan.limits.perRoute,
        }).catch((error: unknown) => {
          failedRouteCount += 1;
          this.routeFailure("procedural", error);
          return [];
        })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);
    const errorLessonsPromise = plan.routes.errorLessons && this.longTerm
      ? this.longTerm.searchErrorLessons(
          namespace,
          plan.query,
          plan.limits.perRoute,
        ).catch((error: unknown) => {
          failedRouteCount += 1;
          this.routeFailure("error-lessons", error);
          return [];
        })
      : Promise.resolve([] as RetrievedMemoryEvidence[]);

    const [
      episodicRaw,
      semanticRaw,
      graphRaw,
      personalizationRaw,
      proceduralRaw,
      errorLessonsRaw,
    ] = await Promise.all([
      episodicPromise,
      semanticPromise,
      graphPromise,
      personalizationPromise,
      proceduralPromise,
      errorLessonsPromise,
    ]);
    if (options.signal?.aborted) {
      return {
        context: baseContext,
        plan,
        manifest: Object.freeze({ ...empty, failedRouteCount }),
      };
    }

    // Filter per-route sebelum fusion. Jika episode lama sudah ditombstone
    // tetapi fakta yang sama kemudian ditegaskan ulang dengan source baru,
    // provenance episode terlarang tidak boleh meracuni semantic evidence baru.
    const tagged = [
      ...episodicRaw.map((evidence) => ({ route: "episodic" as const, evidence })),
      ...semanticRaw.map((evidence) => ({ route: "semantic" as const, evidence })),
      ...graphRaw.map((evidence) => ({ route: "graph" as const, evidence })),
      ...personalizationRaw.map((evidence) => ({
        route: "user-model" as const,
        evidence,
      })),
      ...proceduralRaw.map((evidence) => ({
        route: "procedure" as const,
        evidence,
      })),
      ...errorLessonsRaw.map((evidence) => ({
        route: "error-lesson" as const,
        evidence,
      })),
    ];
    const safeTagged = await this.knowledge.filterSuppressed(
      namespace,
      tagged.map(({ route, evidence }) => ({
        route,
        evidence,
        text: evidence.text,
        sourceEpisodeIds: evidence.sourceEpisodeIds,
        sourceSequences: evidence.sourceSequences,
        sourceMemoryIds: evidence.sourceMemoryIds,
      })),
    );
    const episodic = await this.knowledge.filterTemporalEvidence(
      namespace,
      deduplicateEvidence(safeTagged
      .filter((item) => item.route === "episodic")
      .map((item) => item.evidence)),
      {
        asOf: plan.temporal.asOf,
        includeHistorical: plan.temporal.mode === "historical",
      },
    );
    const semantic = await this.knowledge.filterTemporalEvidence(
      namespace,
      deduplicateEvidence(safeTagged
      .filter((item) => item.route === "semantic")
      .map((item) => item.evidence)),
      {
        asOf: plan.temporal.asOf,
        includeHistorical: plan.temporal.mode === "historical",
      },
    );
    const graph = deduplicateEvidence(safeTagged
      .filter((item) => item.route === "graph")
      .map((item) => item.evidence));
    const personalization = deduplicateEvidence(safeTagged
      .filter((item) => item.route === "user-model")
      .map((item) => item.evidence));
    const procedural = deduplicateEvidence(safeTagged
      .filter((item) => item.route === "procedure")
      .map((item) => item.evidence));
    const errorLessons = deduplicateEvidence(safeTagged
      .filter((item) => item.route === "error-lesson")
      .map((item) => item.evidence));
    const suppressedCount = tagged.length - safeTagged.length;
    const ranked = reciprocalRankFusion({
      episodic,
      semantic,
      graph,
      personalization,
      procedural,
      errorLessons,
    });
    const existingContent = new Set(
      plan.temporal.mode === "current"
        ? contextualBase.memories.map((memory) => normalize(memory.content))
        : [],
    );
    const rankedWithExisting = deduplicateEvidence([
      ...ranked,
      ...existingRetrieved,
    ]);
    const latestUnsuppressed = await this.knowledge.filterSuppressed(
      namespace,
      rankedWithExisting,
    );
    const latestVisible = await this.knowledge.filterTemporalEvidence(
      namespace,
      latestUnsuppressed,
      {
        asOf: plan.temporal.asOf,
        includeHistorical: plan.temporal.mode === "historical",
      },
    );
    const deduplicated = latestVisible.filter(
      (evidence) => !existingContent.has(normalize(evidence.text)),
    );
    const deduplicatedCount = latestVisible.length - deduplicated.length;
    const finalSuppressedCount = suppressedCount +
      rankedWithExisting.length - latestUnsuppressed.length;
    const selected = fitContextPack(
      deduplicated,
      plan.limits.contextItems,
      plan.limits.contextCharacters,
    );
    const context = selected.length === 0
      ? contextualBase
      : { ...contextualBase, retrieved: selected };
    return {
      context,
      plan,
      manifest: Object.freeze({
        version: 1,
        planUsed: true,
        episodicRequested: plan.routes.episodic,
        semanticRequested: plan.routes.semantic,
        graphRequested: plan.routes.graph,
        personalizationRequested: plan.routes.personalization,
        proceduralRequested: plan.routes.procedural,
        errorLessonsRequested: plan.routes.errorLessons,
        semanticProviderAvailable: this.knowledge.hasSemanticProvider(),
        episodicResultCount: episodicRaw.length,
        semanticResultCount: semanticRaw.length,
        graphResultCount: graphRaw.length,
        personalizationResultCount: personalizationRaw.length,
        proceduralResultCount: proceduralRaw.length,
        errorLessonResultCount: errorLessonsRaw.length,
        suppressedCount: finalSuppressedCount,
        deduplicatedCount,
        selectedCount: selected.length,
        selectedCharacters: selected.reduce(
          (total, evidence) => total + evidence.text.length,
          0,
        ),
        failedRouteCount,
      }),
    };
  }

  private async contextualizePrivate(
    ownerId: string,
    plan: MemoryQueryPlan,
    baseContext: HarvyContext,
    options: MemoryContextCompileOptions,
  ): Promise<HarvyContext> {
    const namespace = privateMemoryNamespace(ownerId);
    try {
      const [sourceContext, episodes] = await Promise.all([
        this.knowledge.contextForSourceMemories(
          namespace,
          baseContext.memories.map((memory) => memory.id),
          {
            asOf: plan.temporal.asOf,
            includeHistorical: plan.temporal.mode === "historical",
          },
        ),
        this.history.episodesForContext(ownerId),
      ]);
      if (options.signal?.aborted) return baseContext;
      const recent = filterEpisodesForPlan(episodes, plan)
        .slice(-HISTORY_EPISODE_CONTEXT_LIMIT);
      const claims = recent.flatMap((episode) =>
        EPISODE_CLAIM_FIELDS.flatMap((field) =>
          episode[field].map((claim, claimIndex) => ({
            episodeId: episode.episodeId,
            field,
            claimIndex,
            text: claim.text,
            sourceEpisodeIds: [episode.episodeId],
            sourceSequences: claim.sourceSequences,
          }))));
      const unsuppressedClaims = await this.knowledge.filterSuppressed(
        namespace,
        claims,
      );
      const safeClaims = await this.knowledge.filterTemporalEvidence(
        namespace,
        unsuppressedClaims,
        {
          asOf: plan.temporal.asOf,
          includeHistorical: plan.temporal.mode === "historical",
        },
      );
      const allowed = new Set(safeClaims.map((claim) =>
        `${claim.episodeId}\0${claim.field}\0${claim.claimIndex}`));
      const filteredEpisodes = recent.map((episode) => {
        const filtered = structuredClone(episode);
        for (const field of EPISODE_CLAIM_FIELDS) {
          filtered[field] = episode[field].filter((_claim, claimIndex) =>
            allowed.has(`${episode.episodeId}\0${field}\0${claimIndex}`));
        }
        return filtered;
      });
      const covered = new Set(sourceContext.coveredSourceMemoryIds);
      const retrieved = deduplicateEvidence([
        ...(baseContext.retrieved ?? []),
        ...sourceContext.evidence,
      ]);
      const currentRetrieved = await this.knowledge.filterTemporalEvidence(
        namespace,
        await this.knowledge.filterSuppressed(namespace, retrieved),
        {
          asOf: plan.temporal.asOf,
          includeHistorical: plan.temporal.mode === "historical",
        },
      );
      return {
        summary: renderEpisodeContext(filteredEpisodes),
        turns: baseContext.turns,
        memories: baseContext.memories.filter((memory) =>
          !covered.has(memory.id)),
        ...(currentRetrieved.length > 0
          ? { retrieved: currentRetrieved }
          : {}),
        ...(baseContext.interactions
          ? { interactions: baseContext.interactions }
          : {}),
      };
    } catch (error) {
      this.routeFailure("context-normalization", error);
      // Tombstone/derivative yang tidak dapat dibaca tidak boleh dilewati
      // dengan membawa ulang summary atau primary memory mentah.
      return {
        summary: null,
        turns: baseContext.turns,
        memories: [],
        ...(baseContext.interactions
          ? { interactions: baseContext.interactions }
          : {}),
      };
    }
  }

  private routeFailure(route: string, error: unknown): void {
    this.logger.warn(
      "memory_retrieval_route_failed",
      "Satu route retrieval memory gagal; route lokal lain tetap dipakai.",
      {
        route,
        errorType: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}

export function reciprocalRankFusion(routes: {
  episodic: readonly RetrievedMemoryEvidence[];
  semantic: readonly RetrievedMemoryEvidence[];
  graph: readonly RetrievedMemoryEvidence[];
  personalization?: readonly RetrievedMemoryEvidence[];
  procedural?: readonly RetrievedMemoryEvidence[];
  errorLessons?: readonly RetrievedMemoryEvidence[];
}): RetrievedMemoryEvidence[] {
  const fused = new Map<string, RetrievedMemoryEvidence>();
  const routeEntries: Array<[
    RetrievedMemorySource,
    readonly RetrievedMemoryEvidence[],
  ]> = [
    ["episode", routes.episodic],
    ["semantic", routes.semantic],
    ["graph", routes.graph],
    ["user-model", routes.personalization ?? []],
    ["procedure", routes.procedural ?? []],
    ["error-lesson", routes.errorLessons ?? []],
  ];
  for (const [source, matches] of routeEntries) {
    matches.forEach((match, index) => {
      const key = evidenceIdentity(match);
      const score = 1 / (RRF_K + index + 1);
      const current = fused.get(key);
      if (!current) {
        fused.set(key, {
          ...structuredClone(match),
          sources: uniqueSources([...match.sources, source]),
          score,
        });
        return;
      }
      const hadSemanticSource = current.sources.includes("semantic");
      current.score += score;
      current.sources = uniqueSources([
        ...current.sources,
        ...match.sources,
        source,
      ]);
      current.sourceEpisodeIds = unique([
        ...current.sourceEpisodeIds,
        ...match.sourceEpisodeIds,
      ]);
      current.sourceSequences = uniqueNumbers([
        ...current.sourceSequences,
        ...match.sourceSequences,
      ]);
      current.sourceMemoryIds = unique([
        ...current.sourceMemoryIds,
        ...match.sourceMemoryIds,
      ]);
      // Jika episode lexical dan semantic record berisi teks sama, metadata
      // temporal dari semantic source lebih kuat daripada label episode.
      if (
        match.sources.includes("semantic") &&
        !hadSemanticSource
      ) {
        current.id = match.id;
        current.validFrom = match.validFrom;
        current.validUntil = match.validUntil;
        current.status = match.status;
        current.sensitivity = match.sensitivity;
      }
    });
  }
  return [...fused.values()]
    .map((evidence) => ({
      ...evidence,
      score: roundScore(evidence.score),
    }))
    .sort((left, right) =>
      right.score - left.score || left.id.localeCompare(right.id));
}

function episodeMatchesToEvidence(
  matches: HistoricalEpisodeMatch[],
  plan: MemoryQueryPlan,
): RetrievedMemoryEvidence[] {
  return matches.flatMap((match) =>
    match.claims.map((claim) => ({
      id: `episode:${match.episodeId}:${claim.field}:${claim.claimIndex}`,
      sources: ["episode"] as RetrievedMemorySource[],
      text: claim.text,
      score: claim.score,
      validFrom: match.createdAt,
      validUntil: null,
      status: plan.temporal.mode === "historical"
        ? "superseded" as const
        : "uncertain" as const,
      // Episode privat boleh memuat hal personal; label konservatif mencegah
      // consumer group/project menganggapnya ordinary.
      sensitivity: "personal" as const,
      sourceEpisodeIds: [match.episodeId],
      sourceSequences: [...claim.sourceSequences],
      sourceMemoryIds: [],
    })),
  );
}

function filterEpisodeMatchesForPlan(
  matches: readonly HistoricalEpisodeMatch[],
  plan: MemoryQueryPlan,
): HistoricalEpisodeMatch[] {
  if (!plan.temporal.asOf) return [...matches];
  const ceiling = Date.parse(plan.temporal.asOf);
  return matches.filter((match) => Date.parse(match.createdAt) <= ceiling);
}

function filterEpisodesForPlan(
  episodes: readonly ConversationEpisode[],
  plan: MemoryQueryPlan,
): ConversationEpisode[] {
  if (!plan.temporal.asOf) return [...episodes];
  const ceiling = Date.parse(plan.temporal.asOf);
  return episodes.filter((episode) => Date.parse(episode.createdAt) <= ceiling);
}

function fitContextPack(
  evidence: readonly RetrievedMemoryEvidence[],
  maximumItems: number,
  maximumCharacters: number,
): RetrievedMemoryEvidence[] {
  const selected: RetrievedMemoryEvidence[] = [];
  let used = 0;
  for (const item of evidence) {
    if (selected.length >= maximumItems) break;
    const text = clip(item.text, RETRIEVED_ITEM_MAX_CHARACTERS);
    const size = text.length + 24;
    if (used + size > maximumCharacters) continue;
    used += size;
    selected.push({ ...structuredClone(item), text });
  }
  return selected;
}

function emptyManifest(
  plan: MemoryQueryPlan,
  semanticProviderAvailable: boolean,
): MemoryRetrievalManifest {
  return Object.freeze({
    version: 1,
    planUsed: memoryPlanUsesRetrieval(plan),
    episodicRequested: plan.routes.episodic,
    semanticRequested: plan.routes.semantic,
    graphRequested: plan.routes.graph,
    personalizationRequested: plan.routes.personalization,
    proceduralRequested: plan.routes.procedural,
    errorLessonsRequested: plan.routes.errorLessons,
    semanticProviderAvailable,
    episodicResultCount: 0,
    semanticResultCount: 0,
    graphResultCount: 0,
    personalizationResultCount: 0,
    proceduralResultCount: 0,
    errorLessonResultCount: 0,
    suppressedCount: 0,
    deduplicatedCount: 0,
    selectedCount: 0,
    selectedCharacters: 0,
    failedRouteCount: 0,
  });
}

function evidenceIdentity(evidence: RetrievedMemoryEvidence): string {
  const semanticId = /^(?:semantic|graph):(.+)$/u.exec(evidence.id)?.[1];
  if (semanticId) return `semantic:${semanticId}`;
  // Lexical dan vector episode memakai ID claim kanonik yang sama.
  if (evidence.id.startsWith("episode:")) return evidence.id;
  // Teks dapat berulang pada interval berbeda (A→B→A). Interval adalah bagian
  // identity agar provenance historis tidak dicampur ke record current.
  return [
    normalize(evidence.text),
    evidence.validFrom ?? "",
    evidence.validUntil ?? "",
    evidence.status,
  ].join("\0");
}

function deduplicateEvidence(
  evidence: readonly RetrievedMemoryEvidence[],
): RetrievedMemoryEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const identity = evidenceIdentity(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function uniqueSources(
  values: readonly RetrievedMemorySource[],
): RetrievedMemorySource[] {
  const order: RetrievedMemorySource[] = [
    "episode",
    "semantic",
    "graph",
    "user-model",
    "procedure",
    "error-lesson",
  ];
  const selected = new Set(values);
  return order.filter((source) => selected.has(source));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function clip(value: string, maximum: number): string {
  const clean = value.trim();
  if (clean.length <= maximum) return clean;
  return `${clean.slice(0, maximum - 1).trimEnd()}…`;
}

function normalize(value: string): string {
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
