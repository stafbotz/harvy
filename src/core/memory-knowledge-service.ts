import { createHash, randomUUID } from "node:crypto";
import type { ConversationEpisode, EpisodeClaimField } from "../domain/history.js";
import type { MemoryItem, NewMemory } from "../domain/memory.js";
import {
  type MemoryEntity,
  type MemoryGraphProjection,
  type MemoryKnowledgeNamespace,
  type MemoryKnowledgeRepository,
  type MemoryKnowledgeState,
  type MemoryProvenance,
  type MemoryRelation,
  type MemorySensitivity,
  type RetrievedMemoryEvidence,
  type SemanticMemory,
  type SemanticMemoryEvidence,
  type TextEmbeddingProvider,
} from "../domain/memory-knowledge.js";
import {
  memoryNamespaceKey,
  memoryNamespaceOwnerId,
  privateMemoryNamespace,
  validateMemoryNamespace,
} from "./memory-namespace.js";
import { deriveMemoryMetadata } from "./memory-candidate.js";

const MAX_CONSOLIDATION_CANDIDATES = 32;
const MAX_SEMANTIC_MEMORIES = 512;
// 32 episode retained × maksimum 24 claim = 768 source claims. Tombstone harus
// hidup lebih lama daripada seluruh provenance yang masih dapat diretrieve.
const MAX_SEMANTIC_QUERY_DOCUMENTS = 160;
const MIN_EPISODE_DOCUMENT_RESERVE = 32;
const DEFAULT_RESULT_LIMIT = 8;
const MAX_RESULT_LIMIT = 16;
// Conservative floor: RRF only sees genuinely related candidates, not every
// finite vector returned by a provider. Provider/model calibration remains an
// eval concern before a new model is enabled in production.
const MIN_SEMANTIC_SCORE = 0.35;
const MUTATION_RETRIES = 3;

export interface MemoryConsolidationCandidate {
  subject: string;
  predicate: string;
  value: string;
  displayText?: string;
  confidence?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  sourceMemoryId?: string | null;
  sourceEpisodeIds?: string[];
  sourceSequences?: number[];
  sensitivity?: MemorySensitivity;
  provenance: MemoryProvenance;
  /** Koreksi eksplisit menutup validity record lama pada slot yang sama. */
  correction?: boolean;
  graphProjection?: MemoryGraphProjection | null;
}

export interface MemoryConsolidationResult {
  saved: number;
  merged: number;
  superseded: number;
  uncertain: number;
  rejected: number;
}

export interface EpisodeSemanticDocument {
  id: string;
  episodeId: string;
  field: EpisodeClaimField;
  text: string;
  createdAt: string;
  sourceSequences: number[];
}

export interface SemanticMemoryQueryOptions {
  limit?: number;
  asOf?: string | null;
  includeHistorical?: boolean;
  episodeDocuments?: readonly EpisodeSemanticDocument[];
  signal?: AbortSignal;
}

export interface GraphMemoryQueryOptions {
  limit?: number;
  asOf?: string | null;
  includeHistorical?: boolean;
  maxDepth?: number;
}

export interface MemoryEvidenceProbe {
  text: string;
  sourceEpisodeIds?: readonly string[];
  sourceSequences?: readonly number[];
  sourceMemoryIds?: readonly string[];
}

export interface SourceMemoryContextResult {
  coveredSourceMemoryIds: string[];
  evidence: RetrievedMemoryEvidence[];
}

/**
 * Semantic memory dan graph lokal yang tetap diturunkan dari evidence.
 *
 * Seluruh mutasi owner-scoped diserialisasi dan memakai CAS repository. Graph
 * dibangun ulang setelah setiap perubahan sehingga penghapusan source tidak
 * meninggalkan edge yatim. Embedding tidak disimpan: provider menerima batch
 * bounded pada query dan tidak dapat menghidupkan cache setelah deletion.
 */
export class MemoryKnowledgeService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly blocked = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly repository: MemoryKnowledgeRepository,
    private readonly embeddingProvider: TextEmbeddingProvider | null = null,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  hasSemanticProvider(): boolean {
    return this.embeddingProvider !== null;
  }

  /** Lazy migration untuk MemoryItem yang sudah ada sebelum knowledge v1. */
  async reconcileSources(items: readonly MemoryItem[]): Promise<void> {
    if (items.length === 0) return;
    const ownerId = items[0]!.ownerId;
    if (items.some((item) => item.ownerId !== ownerId)) {
      throw new Error("Reconciliation memory tidak boleh mencampur owner.");
    }
    const namespace = privateMemoryNamespace(ownerId);
    if (this.isBlocked(namespace)) return;
    const state = await this.repository.load(namespace);
    const known = new Set([
      ...(state?.semanticMemories.flatMap((memory) => memory.sourceMemoryIds) ?? []),
      ...(state?.suppressions.map((item) => item.sourceMemoryId) ?? []),
    ]);
    const missing = items.filter((item) => !known.has(item.id));
    for (let offset = 0; offset < missing.length; offset += MAX_CONSOLIDATION_CANDIDATES) {
      const batch = missing.slice(offset, offset + MAX_CONSOLIDATION_CANDIDATES);
      await this.consolidate(namespace, batch.map((item) => {
        const metadata = deriveMemoryMetadata(
          item.kind,
          item.content,
          item.content,
        );
        return {
          subject: metadata.subject ?? "user",
          predicate: metadata.predicate ?? predicateForMemoryKind(item.kind),
          value: metadata.value ?? item.content,
          displayText: item.content,
          confidence: 1,
          validFrom: item.createdAt,
          validUntil: item.expiresAt,
          sourceMemoryId: item.id,
          sensitivity: item.kind === "personal" ? "personal" : "normal",
          provenance: "asserted" as const,
          correction: false,
          graphProjection: metadata.graphProjection ?? null,
        };
      }), { sensitiveConsent: true });
    }
  }

  async rememberSource(item: MemoryItem, input: NewMemory): Promise<void> {
    if (input.ownerId !== item.ownerId) {
      throw new Error("Source semantic memory tidak cocok dengan owner input.");
    }
    const namespace = privateMemoryNamespace(item.ownerId);
    const sourceSequences = boundedSequences(input.sourceSequences ?? []);
    const sourceEpisodeIds = boundedStrings(
      input.sourceEpisodeIds ?? [],
      64,
      256,
      "source episode",
    );
    await this.consolidate(
      namespace,
      [{
        subject: input.subject ?? "user",
        predicate: input.predicate ?? predicateForMemoryKind(item.kind),
        value: input.value ?? item.content,
        displayText: item.content,
        confidence: input.confidence ?? 1,
        validFrom: input.validFrom ?? item.createdAt,
        validUntil: input.validUntil ?? item.expiresAt,
        sourceMemoryId: item.id,
        sourceEpisodeIds,
        sourceSequences,
        sensitivity: input.sensitivity ??
          (item.kind === "personal" ? "personal" : "normal"),
        provenance: input.provenance ?? "asserted",
        correction: input.correction ?? false,
        graphProjection: input.graphProjection ?? {
          from: {
            type: "person",
            canonicalName: "Pengguna",
            aliases: [],
          },
          relation: input.predicate ?? predicateForMemoryKind(item.kind),
          scalarValue: input.value ?? item.content,
        },
      }],
      {
        sensitiveConsent:
          input.sensitiveConsent === true,
      },
    );
  }

  async editSource(
    previous: MemoryItem,
    updated: MemoryItem,
    input: NewMemory = {
      ownerId: updated.ownerId,
      kind: updated.kind,
      content: updated.content,
    },
  ): Promise<void> {
    if (
      previous.ownerId !== updated.ownerId ||
      input.ownerId !== updated.ownerId
    ) {
      throw new Error("Edit semantic memory tidak boleh berpindah owner.");
    }
    const namespace = privateMemoryNamespace(previous.ownerId);
    // Removal, tombstone, dan replacement harus satu CAS commit. Dua commit
    // membuat kegagalan write kedua meninggalkan primary yang di-rollback
    // tetapi derivative sudah hilang permanen.
    await this.mutate(namespace, (state) => {
      const at = this.now().toISOString();
      const prior = state.semanticMemories.find((memory) =>
        memory.sourceMemoryIds.includes(previous.id) &&
        (memory.status === "active" || memory.status === "uncertain")) ??
        state.semanticMemories.find((memory) =>
          memory.sourceMemoryIds.includes(previous.id));
      const subject = input.subject ?? prior?.subject ?? "user";
      const predicate = input.predicate ?? prior?.predicate ??
        predicateForMemoryKind(updated.kind);
      const confidence = input.confidence ?? prior?.confidence ?? 1;
      const sensitivity = input.sensitivity ?? prior?.sensitivity ??
        (updated.kind === "personal" ? "personal" : "normal");
      const provenance = input.provenance ?? prior?.provenance ?? "asserted";
      const graphProjection = input.graphProjection ??
        projectionWithUpdatedValue(prior?.graphProjection, updated.content) ?? {
          from: { type: "person", canonicalName: "Pengguna", aliases: [] },
          relation: predicate,
          scalarValue: input.value ?? updated.content,
        };

      this.forgetSourceInState(state, previous, "edited", at);
      const result = emptyConsolidationResult();
      this.consolidateState(state, [{
        subject,
        predicate,
        value: input.value ?? updated.content,
        displayText: updated.content,
        confidence,
        validFrom: input.validFrom ?? at,
        validUntil: input.validUntil ?? updated.expiresAt,
        sourceMemoryId: updated.id,
        sourceEpisodeIds: input.sourceEpisodeIds ?? [],
        sourceSequences: input.sourceSequences ?? [],
        sensitivity,
        provenance,
        correction: input.correction ?? true,
        graphProjection,
      }], {
        sensitiveConsent:
          input.sensitiveConsent === true ||
          updated.kind === "personal" ||
          sensitivity !== "normal",
      }, result, at);
      if (result.rejected !== 0 || result.saved + result.merged !== 1) {
        throw new Error("Replacement semantic memory hasil edit tidak sah.");
      }
      state.semanticMemories = retainSemanticMemories(state.semanticMemories);
      state.suppressions = retainSuppressions(state.suppressions);
      projectTemporalGraph(state);
    }, { deletion: true });
  }

  async forgetSource(
    item: MemoryItem,
    reason: "forgotten" | "edited" | "expired" = "forgotten",
  ): Promise<void> {
    const namespace = privateMemoryNamespace(item.ownerId);
    await this.mutate(namespace, (state) => {
      this.forgetSourceInState(state, item, reason, this.now().toISOString());
      state.suppressions = retainSuppressions(state.suppressions);
      projectTemporalGraph(state);
    }, { deletion: true });
  }

  async consolidate(
    namespaceInput: MemoryKnowledgeNamespace,
    candidates: readonly MemoryConsolidationCandidate[],
    options: { sensitiveConsent?: boolean } = {},
  ): Promise<MemoryConsolidationResult> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (candidates.length > MAX_CONSOLIDATION_CANDIDATES) {
      throw new Error("Kandidat consolidation memory terlalu banyak.");
    }
    let result = emptyConsolidationResult();
    if (this.isBlocked(namespace)) {
      return { ...result, rejected: candidates.length };
    }

    await this.mutate(namespace, (state) => {
      const at = this.now().toISOString();
      const attemptResult = emptyConsolidationResult();
      this.consolidateState(state, candidates, options, attemptResult, at);
      state.semanticMemories = retainSemanticMemories(
        state.semanticMemories,
      );
      projectTemporalGraph(state);
      // CAS dapat memanggil operation lagi. Hanya counter dari attempt yang
      // akhirnya dicoba terakhir yang boleh dikembalikan ke caller.
      result = attemptResult;
    });
    return result;
  }

  async searchSemantic(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    options: SemanticMemoryQueryOptions = {},
  ): Promise<RetrievedMemoryEvidence[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    const cleanQuery = boundedText(query, 500, "query semantic");
    if (!cleanQuery || !this.embeddingProvider || this.isBlocked(namespace)) {
      return [];
    }
    const generation = this.generationOf(namespace);
    const loaded = await this.repository.load(namespace);
    if (
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace)
    ) {
      return [];
    }
    // Episode-semantic retrieval tidak membutuhkan primary semantic file.
    // Owner baru tetap boleh menemukan episode lama melalui vector route.
    const state = loaded ?? emptyState(namespace, this.now().toISOString());
    const at = queryTime(options.asOf, this.now());
    const semanticDocuments = state.semanticMemories
      .filter((memory) => visibleAt(
        memory,
        at,
        options.includeHistorical,
        options.asOf !== undefined && options.asOf !== null,
      ))
      .filter((memory) => !isSuppressedWithState(state, {
        text: memory.displayText,
        sourceEpisodeIds: memory.sourceEpisodes,
        sourceSequences: memory.sourceSequences,
        sourceMemoryIds: memory.sourceMemoryIds,
      }))
      .map((memory) => ({
        id: `semantic:${memory.id}`,
        text: memory.displayText,
        memory,
      }));
    const episodeDocuments = (options.episodeDocuments ?? [])
      .filter((document) =>
        !isSuppressedWithState(state, {
          text: document.text,
          sourceEpisodeIds: [document.episodeId],
          sourceSequences: document.sourceSequences,
        }))
      .map((document) => ({
        id: `episode:${document.id}`,
        text: boundedText(document.text, 500, "episode semantic") ?? "",
        episode: document,
      }))
      .filter((document) => document.text.length > 0);
    const episodeReserve = Math.min(
      MIN_EPISODE_DOCUMENT_RESERVE,
      episodeDocuments.length,
    );
    const selectedSemantic = semanticDocuments.slice(
      0,
      MAX_SEMANTIC_QUERY_DOCUMENTS - episodeReserve,
    );
    const selectedEpisodes = episodeDocuments.slice(
      0,
      MAX_SEMANTIC_QUERY_DOCUMENTS - selectedSemantic.length,
    );
    const remaining = MAX_SEMANTIC_QUERY_DOCUMENTS -
      selectedSemantic.length - selectedEpisodes.length;
    const documents = [
      ...selectedSemantic,
      ...semanticDocuments.slice(
        selectedSemantic.length,
        selectedSemantic.length + remaining,
      ),
      ...selectedEpisodes,
    ];
    if (documents.length === 0) return [];

    const vectors = await this.embeddingProvider.embed(
      [cleanQuery, ...documents.map((document) => document.text)],
      options.signal,
    );
    const latest = await this.repository.load(namespace);
    if (
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace) ||
      (latest?.revision ?? null) !== (loaded?.revision ?? null)
    ) {
      return [];
    }
    const normalized = validateEmbeddings(vectors, documents.length + 1);
    const queryVector = normalized[0]!;
    return documents
      .map((document, index) => ({
        document,
        score: cosine(queryVector, normalized[index + 1]!),
      }))
      .filter((match) => match.score >= MIN_SEMANTIC_SCORE)
      .sort((left, right) =>
        right.score - left.score ||
        left.document.id.localeCompare(right.document.id))
      .slice(0, resultLimit(options.limit))
      .map(({ document, score }) => {
        if ("memory" in document) {
          const memory = document.memory;
          return semanticEvidence(
            memory,
            document.id,
            roundScore(score),
            options.includeHistorical === true,
            at,
          );
        }
        const episode = document.episode;
        return {
          id: document.id,
          sources: ["episode"],
          text: episode.text,
          score: roundScore(score),
          validFrom: episode.createdAt,
          validUntil: null,
          status: options.includeHistorical ? "superseded" : "uncertain",
          sensitivity: "personal",
          sourceEpisodeIds: [episode.episodeId],
          sourceSequences: [...episode.sourceSequences],
          sourceMemoryIds: [],
        } satisfies RetrievedMemoryEvidence;
      });
  }

  async searchGraph(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    options: GraphMemoryQueryOptions = {},
  ): Promise<RetrievedMemoryEvidence[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    const cleanQuery = boundedText(query, 500, "query graph");
    if (!cleanQuery || this.isBlocked(namespace)) return [];
    const generation = this.generationOf(namespace);
    const state = await this.repository.load(namespace);
    if (
      !state ||
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace)
    ) {
      return [];
    }
    const at = queryTime(options.asOf, this.now());
    const maxDepth = Math.max(1, Math.min(3, Math.floor(options.maxDepth ?? 2)));
    const terms = significantTerms(cleanQuery);
    if (terms.size === 0) return [];
    const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
    const semantic = new Map(
      state.semanticMemories.map((memory) => [memory.id, memory]),
    );
    const eligibleRelations = state.relations.filter((relation) => {
      const source = semantic.get(relation.semanticMemoryId);
      return Boolean(
        source &&
        relationVisibleAt(
          relation,
          at,
          options.includeHistorical,
          options.asOf !== undefined && options.asOf !== null,
        ) &&
        !isSuppressedWithState(state, {
          text: source.displayText,
          sourceEpisodeIds: relation.sourceEpisodeIds,
          sourceSequences: relation.sourceSequences,
          sourceMemoryIds: relation.sourceMemoryIds,
        }),
      );
    });

    const entityMatches = new Set<string>();
    for (const entity of entities.values()) {
      if (overlapScore(entitySearchText(entity), terms) > 0) {
        entityMatches.add(entity.id);
      }
    }
    const reached = new Map<string, number>(
      [...entityMatches].map((id) => [id, 0]),
    );
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      let changed = false;
      for (const relation of eligibleRelations) {
        const fromDepth = reached.get(relation.fromEntityId);
        const toDepth = relation.toEntityId === null
          ? undefined
          : reached.get(relation.toEntityId);
        if (fromDepth !== undefined && fromDepth < depth && relation.toEntityId) {
          if (!reached.has(relation.toEntityId)) {
            reached.set(relation.toEntityId, depth);
            changed = true;
          }
        }
        if (toDepth !== undefined && toDepth < depth) {
          if (!reached.has(relation.fromEntityId)) {
            reached.set(relation.fromEntityId, depth);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }

    const matches = new Map<string, RetrievedMemoryEvidence>();
    for (const relation of eligibleRelations) {
      const memory = semantic.get(relation.semanticMemoryId)!;
      const directScore = overlapScore(
        relationSearchText(relation, entities, memory),
        terms,
      );
      const traversalDepth = Math.min(
        reached.get(relation.fromEntityId) ?? Number.POSITIVE_INFINITY,
        relation.toEntityId === null
          ? Number.POSITIVE_INFINITY
          : reached.get(relation.toEntityId) ?? Number.POSITIVE_INFINITY,
      );
      const traversalAllowed = Number.isFinite(traversalDepth) &&
        traversalDepth < maxDepth;
      if (directScore === 0 && !traversalAllowed) continue;
      const score = directScore * 2 +
        (traversalAllowed ? 1 / (1 + traversalDepth) : 0) +
        relation.confidence;
      const existing = matches.get(memory.id);
      if (existing && existing.score >= score) continue;
      matches.set(memory.id, {
        id: `graph:${memory.id}`,
        // Graph hanyalah access path; semantic source tetap disebut agar hasil
        // tidak pernah tampil seolah edge merupakan authority mandiri.
        sources: ["semantic", "graph"],
        text: memory.displayText,
        score: roundScore(score),
        validFrom: relation.validFrom,
        validUntil: relation.validUntil,
        status: retrievalStatus(
          memory,
          options.includeHistorical === true,
          at,
        ),
        sensitivity: relation.sensitivity,
        sourceEpisodeIds: [...relation.sourceEpisodeIds],
        sourceSequences: [...relation.sourceSequences],
        sourceMemoryIds: [...relation.sourceMemoryIds],
      });
    }
    return [...matches.values()]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, resultLimit(options.limit));
  }

  async filterSuppressed<T extends MemoryEvidenceProbe>(
    namespaceInput: MemoryKnowledgeNamespace,
    evidence: readonly T[],
  ): Promise<T[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const generation = this.generationOf(namespace);
    const state = await this.repository.load(namespace);
    if (
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace)
    ) {
      return [];
    }
    if (!state) return [...evidence];
    return evidence.filter((item) => !isSuppressedWithState(state, item));
  }

  /**
   * Episode lama yang sudah menjadi source record superseded tidak boleh
   * kembali sebagai klaim current hanya karena lexical/vector route cocok.
   */
  async filterTemporalEvidence<T extends MemoryEvidenceProbe>(
    namespaceInput: MemoryKnowledgeNamespace,
    evidence: readonly T[],
    options: { asOf?: string | null; includeHistorical?: boolean } = {},
  ): Promise<T[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const generation = this.generationOf(namespace);
    const state = await this.repository.load(namespace);
    if (
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace)
    ) return [];
    if (!state) return [...evidence];
    const at = queryTime(options.asOf, this.now());
    const explicitAsOf = options.asOf !== undefined && options.asOf !== null;
    return evidence.filter((probe) => {
      const episodeIds = new Set(probe.sourceEpisodeIds ?? []);
      const sequences = new Set(probe.sourceSequences ?? []);
      const memoryIds = new Set(probe.sourceMemoryIds ?? []);
      const hash = memoryContentHash(probe.text);
      const terms = new Set(memoryTermHashes(probe.text));
      const related = state.semanticMemories.filter((memory) => {
        const sameSource = memory.sourceMemoryIds.some((id) => memoryIds.has(id)) ||
          memory.sourceEpisodes.some((id) => episodeIds.has(id)) ||
          memory.sourceSequences.some((sequence) => sequences.has(sequence));
        if (!sameSource) return false;
        return memoryContentHash(memory.displayText) === hash ||
          similarHashedTerms(memoryTermHashes(memory.displayText), terms);
      });
      return related.length === 0 || related.some((memory) => visibleAt(
        memory,
        at,
        options.includeHistorical,
        explicitAsOf,
      ));
    });
  }

  async removeEpisodeSources(
    namespaceInput: MemoryKnowledgeNamespace,
    episodeIds: readonly string[],
  ): Promise<void> {
    const namespace = validateMemoryNamespace(namespaceInput);
    const removed = new Set(boundedStrings(
      episodeIds,
      64,
      256,
      "episode removal",
    ));
    if (removed.size === 0) return;
    await this.mutate(namespace, (state) => {
      state.semanticMemories = state.semanticMemories.flatMap((memory) => {
        const evidence = memory.evidence.filter(
          (entry) =>
            entry.sourceEpisodeId === null ||
            !removed.has(entry.sourceEpisodeId),
        );
        return evidence.length === 0 ? [] : [withEvidence(memory, evidence)];
      });
      projectTemporalGraph(state);
    }, { deletion: true });
  }

  suspend(namespaceInput: MemoryKnowledgeNamespace): void {
    const namespace = validateMemoryNamespace(namespaceInput);
    const key = memoryNamespaceKey(namespace);
    this.blocked.add(key);
    this.generations.set(key, this.generationOf(namespace) + 1);
  }

  allow(namespaceInput: MemoryKnowledgeNamespace): void {
    const namespace = validateMemoryNamespace(namespaceInput);
    const key = memoryNamespaceKey(namespace);
    this.removed.delete(key);
    this.blocked.delete(key);
  }

  async forgetAll(namespaceInput: MemoryKnowledgeNamespace): Promise<void> {
    const namespace = validateMemoryNamespace(namespaceInput);
    const key = memoryNamespaceKey(namespace);
    this.suspend(namespace);
    // Tandai sebelum menunggu queue agar deletion callback yang terlambat tidak
    // membuat state suppression baru setelah full-delete mengosongkan file.
    this.removed.add(key);
    await this.exclusive(namespace, () => this.repository.remove(namespace));
  }

  suspendPrivateOwner(ownerId: string): void {
    this.suspend(privateMemoryNamespace(ownerId));
  }

  allowPrivateOwner(ownerId: string): void {
    this.allow(privateMemoryNamespace(ownerId));
  }

  async forgetPrivateOwner(ownerId: string): Promise<void> {
    await this.forgetAll(privateMemoryNamespace(ownerId));
  }

  async snapshot(
    namespaceInput: MemoryKnowledgeNamespace,
  ): Promise<MemoryKnowledgeState | null> {
    return this.repository.load(validateMemoryNamespace(namespaceInput));
  }

  async snapshotPrivateOwner(ownerId: string): Promise<MemoryKnowledgeState | null> {
    return this.snapshot(privateMemoryNamespace(ownerId));
  }

  /**
   * Mengganti primary MemoryItem yang sudah punya derivative dengan evidence
   * temporal berstatus. Dengan begitu record superseded/uncertain tidak masuk
   * prompt sebagai catatan polos yang tampak current.
   */
  async contextForSourceMemories(
    namespaceInput: MemoryKnowledgeNamespace,
    sourceMemoryIds: readonly string[],
    options: { asOf?: string | null; includeHistorical?: boolean } = {},
  ): Promise<SourceMemoryContextResult> {
    const namespace = validateMemoryNamespace(namespaceInput);
    const requested = new Set(boundedStrings(
      sourceMemoryIds,
      64,
      256,
      "source memory context",
    ));
    if (requested.size === 0) {
      return { coveredSourceMemoryIds: [], evidence: [] };
    }
    if (this.isBlocked(namespace)) {
      return { coveredSourceMemoryIds: [...requested], evidence: [] };
    }
    const generation = this.generationOf(namespace);
    const state = await this.repository.load(namespace);
    if (
      this.isBlocked(namespace) ||
      generation !== this.generationOf(namespace)
    ) {
      return { coveredSourceMemoryIds: [...requested], evidence: [] };
    }
    if (!state) return { coveredSourceMemoryIds: [], evidence: [] };

    const covered = new Set<string>();
    for (const memory of state.semanticMemories) {
      for (const id of memory.sourceMemoryIds) {
        if (requested.has(id)) covered.add(id);
      }
    }
    for (const suppression of state.suppressions) {
      if (requested.has(suppression.sourceMemoryId)) {
        covered.add(suppression.sourceMemoryId);
      }
    }
    const at = queryTime(options.asOf, this.now());
    const explicitAsOf = options.asOf !== undefined && options.asOf !== null;
    const evidence = state.semanticMemories
      .filter((memory) => memory.sourceMemoryIds.some((id) => requested.has(id)))
      .filter((memory) => visibleAt(
        memory,
        at,
        options.includeHistorical,
        explicitAsOf,
      ))
      .filter((memory) => !isSuppressedWithState(state, {
        text: memory.displayText,
        sourceEpisodeIds: memory.sourceEpisodes,
        sourceSequences: memory.sourceSequences,
        sourceMemoryIds: memory.sourceMemoryIds,
      }))
      .map((memory) => semanticEvidence(
        memory,
        `semantic:${memory.id}`,
        1,
        options.includeHistorical === true,
        at,
      ));
    return {
      coveredSourceMemoryIds: [...covered].sort(),
      evidence,
    };
  }

  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) =>
      queue.catch(() => undefined)));
  }

  private forgetSourceInState(
    state: MemoryKnowledgeState,
    item: MemoryItem,
    reason: "forgotten" | "edited" | "expired",
    at: string,
  ): void {
    const affected = state.semanticMemories.filter((memory) =>
      memory.sourceMemoryIds.includes(item.id));
    const sourceEpisodeIds = unique(
      affected.flatMap((memory) =>
        memory.evidence.flatMap((entry) =>
          entry.sourceMemoryId === item.id && entry.sourceEpisodeId !== null
            ? [entry.sourceEpisodeId]
            : [])),
    );
    const sourceSequences = uniqueNumbers(
      affected.flatMap((memory) =>
        memory.evidence.flatMap((entry) =>
          entry.sourceMemoryId === item.id ? entry.sourceSequences : [])),
    );
    state.suppressions.push({
      id: `sup-${cleanId(this.makeId())}`,
      sourceMemoryId: item.id,
      contentHash: memoryContentHash(item.content),
      termHashes: memoryTermHashes(item.content),
      sourceEpisodeIds,
      sourceSequences,
      createdAt: at,
      reason,
    });
    state.semanticMemories = state.semanticMemories.flatMap((memory) => {
      if (!memory.sourceMemoryIds.includes(item.id)) return [memory];
      const evidence = memory.evidence.filter(
        (entry) => entry.sourceMemoryId !== item.id,
      );
      return evidence.length === 0 ? [] : [withEvidence(memory, evidence)];
    });
  }

  private consolidateState(
    state: MemoryKnowledgeState,
    candidates: readonly MemoryConsolidationCandidate[],
    options: { sensitiveConsent?: boolean },
    result: MemoryConsolidationResult,
    at: string,
  ): void {
    expireSemanticMemories(state, at);
    for (const raw of candidates) {
      const candidate = normalizeCandidate(raw);
      if (
        !candidate ||
        !candidateHasEvidence(candidate) ||
        (candidate.sourceMemoryId !== null && state.suppressions.some(
          (suppression) =>
            suppression.sourceMemoryId === candidate.sourceMemoryId &&
            suppression.reason !== "edited",
        )) ||
        (candidate.provenance === "inferred" &&
          candidate.sensitivity !== "normal") ||
        (candidate.sensitivity !== "normal" && !options.sensitiveConsent)
      ) {
        result.rejected += 1;
        continue;
      }

      const slot = state.semanticMemories.filter((memory) =>
        (memory.status === "active" || memory.status === "uncertain") &&
        normalize(memory.subject) === normalize(candidate.subject) &&
        normalize(memory.predicate) === normalize(candidate.predicate));
      const same = slot.find((memory) => sameSemanticValue(memory, candidate));
      const evidence = evidenceForCandidate(candidate);
      const mergeSame = (memory: SemanticMemory): void => {
        Object.assign(memory, withEvidence(
          memory,
          mergeEvidence(memory.evidence, evidence),
        ), {
          confidence: Math.max(memory.confidence, candidate.confidence),
          lastVerifiedAt: at,
          validFrom: earliestDate(memory.validFrom, candidate.validFrom),
          validUntil: latestDate(memory.validUntil, candidate.validUntil),
          graphProjection: candidate.graphProjection ?? memory.graphProjection,
        });
      };
      const close = (memory: SemanticMemory, validUntil: string): void => {
        memory.status = "superseded";
        memory.validUntil = validUntil;
        memory.lastVerifiedAt = at;
        result.superseded += 1;
      };

      if (candidate.correction) {
        const effectiveAt = candidate.validFrom ?? at;
        if (same?.status === "active") {
          mergeSame(same);
          for (const memory of slot) {
            if (memory !== same) close(memory, effectiveAt);
          }
          same.status = "active";
          result.merged += 1;
          continue;
        }
        // Record uncertain tidak diaktifkan retroaktif. Tutup seluruh interval
        // ambigu lalu buat interval active baru pada waktu koreksi.
        for (const memory of slot) close(memory, effectiveAt);
      } else if (same) {
        mergeSame(same);
        result.merged += 1;
        continue;
      }

      const conflicts = !candidate.correction &&
          predicateIsExclusive(candidate.predicate)
        ? slot.filter((memory) =>
            normalize(memory.value) !== normalize(candidate.value))
        : [];
      let status: SemanticMemory["status"] = "active";
      if (conflicts.length > 0) {
        status = "uncertain";
        for (const memory of conflicts) memory.status = "uncertain";
        result.uncertain += conflicts.length + 1;
      }

      const memory: SemanticMemory = {
        id: `sm-${cleanId(this.makeId())}`,
        ownerId: memoryNamespaceOwnerId(state.namespace),
        subject: candidate.subject,
        predicate: candidate.predicate,
        value: candidate.value,
        displayText: candidate.displayText,
        confidence: candidate.confidence,
        validFrom: candidate.validFrom,
        validUntil: candidate.validUntil,
        sourceEpisodes: [],
        sourceSequences: [],
        sourceMemoryIds: [],
        evidence: [],
        createdAt: at,
        lastVerifiedAt: at,
        lastUsedAt: null,
        sensitivity: candidate.sensitivity,
        provenance: candidate.provenance,
        status,
        graphProjection: candidate.graphProjection,
      };
      state.semanticMemories.push(withEvidence(memory, evidence));
      result.saved += 1;
    }
  }

  private async mutate(
    namespace: MemoryKnowledgeNamespace,
    operation: (state: MemoryKnowledgeState) => void,
    options: { deletion?: boolean } = {},
  ): Promise<void> {
    // Mutasi biasa berhenti saat consent ditarik. Mutasi deletion justru harus
    // tetap dapat membersihkan evidence ketika scope sedang diblokir; block
    // bukan alasan membiarkan derivative lama hidup lalu muncul lagi saat
    // consent diberikan kembali.
    if (!options.deletion && this.isBlocked(namespace)) return;
    if (options.deletion && this.isRemoved(namespace)) return;
    const generation = this.generationOf(namespace);
    await this.exclusive(namespace, async () => {
      if (
        !options.deletion &&
        (this.isBlocked(namespace) ||
          generation !== this.generationOf(namespace))
      ) {
        return;
      }
      if (options.deletion && this.isRemoved(namespace)) return;
      for (let attempt = 0; attempt < MUTATION_RETRIES; attempt += 1) {
        const current = await this.repository.load(namespace);
        const state = current
          ? structuredClone(current)
          : emptyState(namespace, this.now().toISOString());
        operation(state);
        if (
          !options.deletion &&
          (this.isBlocked(namespace) ||
            generation !== this.generationOf(namespace))
        ) {
          return;
        }
        if (options.deletion && this.isRemoved(namespace)) return;
        state.revision = current ? current.revision + 1 : 1;
        state.updatedAt = this.now().toISOString();
        const saved = await this.repository.save(
          state,
          current?.revision ?? null,
        );
        if (saved === "saved") return;
      }
      throw new Error("Memory knowledge gagal commit setelah konflik berulang.");
    });
  }

  private async exclusive<T>(
    namespace: MemoryKnowledgeNamespace,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = memoryNamespaceKey(namespace);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.queues.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  private isBlocked(namespace: MemoryKnowledgeNamespace): boolean {
    return this.blocked.has(memoryNamespaceKey(namespace));
  }

  private isRemoved(namespace: MemoryKnowledgeNamespace): boolean {
    return this.removed.has(memoryNamespaceKey(namespace));
  }

  private generationOf(namespace: MemoryKnowledgeNamespace): number {
    return this.generations.get(memoryNamespaceKey(namespace)) ?? 0;
  }
}

export function episodeSemanticDocuments(
  episodes: readonly ConversationEpisode[],
): EpisodeSemanticDocument[] {
  const documents: EpisodeSemanticDocument[] = [];
  for (const episode of episodes) {
    for (const field of EPISODE_FIELDS) {
      for (let index = 0; index < episode[field].length; index += 1) {
        const claim = episode[field][index]!;
        documents.push({
          id: `${episode.episodeId}:${field}:${index}`,
          episodeId: episode.episodeId,
          field,
          text: claim.text,
          createdAt: episode.createdAt,
          sourceSequences: [...claim.sourceSequences],
        });
      }
    }
  }
  return documents;
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(normalize(content), "utf8").digest("hex");
}

export function memoryTermHashes(content: string): string[] {
  return [...significantTerms(content)]
    .map((term) => digest(`memory-term-v1\0${term}`))
    .sort()
    .slice(0, 64);
}

function emptyState(
  namespace: MemoryKnowledgeNamespace,
  at: string,
): MemoryKnowledgeState {
  return {
    schemaVersion: 1,
    namespace: structuredClone(namespace),
    revision: 1,
    semanticMemories: [],
    entities: [],
    relations: [],
    suppressions: [],
    updatedAt: at,
  };
}

function normalizeCandidate(
  input: MemoryConsolidationCandidate,
): Required<Omit<
  MemoryConsolidationCandidate,
  "sourceMemoryId" | "sourceEpisodeIds" | "sourceSequences" |
  "graphProjection"
>> & {
  sourceMemoryId: string | null;
  sourceEpisodeIds: string[];
  sourceSequences: number[];
  graphProjection: MemoryGraphProjection | null;
} | null {
  try {
    const subject = boundedText(input.subject, 280, "subject semantic");
    const predicate = boundedText(input.predicate, 120, "predicate semantic");
    const value = boundedText(input.value, 500, "value semantic");
    const displayText = boundedText(
      input.displayText ?? input.value,
      500,
      "display semantic",
    );
    if (!subject || !predicate || !value || !displayText) return null;
    const confidence = input.confidence ?? 0.8;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return null;
    }
    const validFrom = optionalDate(input.validFrom ?? null);
    const validUntil = optionalDate(input.validUntil ?? null);
    if (
      validFrom && validUntil &&
      Date.parse(validFrom) >= Date.parse(validUntil)
    ) {
      return null;
    }
    if (!PROVENANCES.has(input.provenance)) return null;
    const sensitivity = input.sensitivity ?? "normal";
    if (!SENSITIVITIES.has(sensitivity)) return null;
    const sourceMemoryId = input.sourceMemoryId === undefined ||
        input.sourceMemoryId === null
      ? null
      : boundedText(input.sourceMemoryId, 256, "source memory");
    const sourceEpisodeIds = boundedStrings(
      input.sourceEpisodeIds ?? [],
      64,
      256,
      "source episode",
    );
    const sourceSequences = boundedSequences(input.sourceSequences ?? []);
    // Dengan lebih dari satu episode, pasangan provenance harus eksplisit
    // melalui index yang sama. Menempelkan seluruh sequence ke setiap episode
    // membuat cascade deletion mempertahankan provenance palsu.
    if (
      sourceEpisodeIds.length > 1 &&
      sourceEpisodeIds.length !== sourceSequences.length
    ) {
      return null;
    }
    return {
      subject,
      predicate,
      value,
      displayText,
      confidence,
      validFrom,
      validUntil,
      sourceMemoryId,
      sourceEpisodeIds,
      sourceSequences,
      sensitivity,
      provenance: input.provenance,
      correction: input.correction ?? false,
      graphProjection: input.graphProjection
        ? normalizeProjection(input.graphProjection)
        : null,
    };
  } catch {
    return null;
  }
}

function normalizeProjection(
  projection: MemoryGraphProjection,
): MemoryGraphProjection {
  const from = normalizeEntityDraft(projection.from);
  const relation = boundedText(projection.relation, 120, "relation graph");
  if (!from || !relation) throw new Error("Proyeksi graph tidak sah.");
  const to = projection.to ? normalizeEntityDraft(projection.to) : undefined;
  const scalarValue = projection.scalarValue === undefined
    ? undefined
    : boundedText(projection.scalarValue, 280, "scalar graph") ?? undefined;
  if ((!to && scalarValue === undefined) || (to && scalarValue !== undefined)) {
    throw new Error("Proyeksi graph harus mempunyai tepat satu target.");
  }
  return {
    from,
    relation,
    ...(to ? { to } : {}),
    ...(scalarValue !== undefined ? { scalarValue } : {}),
  };
}

function normalizeEntityDraft(
  draft: MemoryGraphProjection["from"],
): MemoryGraphProjection["from"] | null {
  if (!ENTITY_TYPES.has(draft.type)) return null;
  const canonicalName = boundedText(
    draft.canonicalName,
    280,
    "canonical entity",
  );
  if (!canonicalName) return null;
  return {
    type: draft.type,
    canonicalName,
    aliases: boundedStrings(draft.aliases ?? [], 16, 280, "alias entity"),
  };
}

function candidateHasEvidence(
  candidate: ReturnType<typeof normalizeCandidate> & object,
): boolean {
  return candidate.sourceMemoryId !== null ||
    candidate.sourceEpisodeIds.length > 0 ||
    candidate.sourceSequences.length > 0;
}

function evidenceForCandidate(
  candidate: NonNullable<ReturnType<typeof normalizeCandidate>>,
): SemanticMemoryEvidence[] {
  const episodeIds = candidate.sourceEpisodeIds.length > 0
    ? candidate.sourceEpisodeIds
    : [null];
  return episodeIds.map((sourceEpisodeId, index) => ({
    sourceMemoryId: candidate.sourceMemoryId,
    sourceEpisodeId,
    sourceSequences: episodeIds.length > 1
      ? [candidate.sourceSequences[index]!]
      : [...candidate.sourceSequences],
  }));
}

function mergeEvidence(
  current: readonly SemanticMemoryEvidence[],
  additions: readonly SemanticMemoryEvidence[],
): SemanticMemoryEvidence[] {
  const merged = new Map<string, SemanticMemoryEvidence>();
  for (const evidence of [...current, ...additions]) {
    const key = `${evidence.sourceMemoryId ?? ""}\0${evidence.sourceEpisodeId ?? ""}`;
    const previous = merged.get(key);
    merged.set(key, {
      sourceMemoryId: evidence.sourceMemoryId,
      sourceEpisodeId: evidence.sourceEpisodeId,
      sourceSequences: uniqueNumbers([
        ...(previous?.sourceSequences ?? []),
        ...evidence.sourceSequences,
      ]),
    });
  }
  return [...merged.values()];
}

function withEvidence(
  memory: SemanticMemory,
  evidence: readonly SemanticMemoryEvidence[],
): SemanticMemory {
  const clean = mergeEvidence([], evidence);
  return {
    ...memory,
    evidence: clean,
    sourceEpisodes: unique(
      clean.flatMap((entry) =>
        entry.sourceEpisodeId === null ? [] : [entry.sourceEpisodeId]),
    ),
    sourceSequences: uniqueNumbers(
      clean.flatMap((entry) => entry.sourceSequences),
    ),
    sourceMemoryIds: unique(
      clean.flatMap((entry) =>
        entry.sourceMemoryId === null ? [] : [entry.sourceMemoryId]),
    ),
  };
}

function sameSemanticValue(
  memory: SemanticMemory,
  candidate: NonNullable<ReturnType<typeof normalizeCandidate>>,
): boolean {
  return normalize(memory.subject) === normalize(candidate.subject) &&
    normalize(memory.predicate) === normalize(candidate.predicate) &&
    normalize(memory.value) === normalize(candidate.value);
}

function expireSemanticMemories(
  state: MemoryKnowledgeState,
  at: string,
): void {
  const timestamp = Date.parse(at);
  for (const memory of state.semanticMemories) {
    if (
      memory.validUntil !== null &&
      Date.parse(memory.validUntil) <= timestamp &&
      memory.status === "active"
    ) {
      memory.status = "expired";
    }
  }
}

function retainSemanticMemories(memories: SemanticMemory[]): SemanticMemory[] {
  const sorted = [...memories].sort((left, right) =>
      statusPriority(left.status) - statusPriority(right.status) ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      left.id.localeCompare(right.id));
  // Primary source yang masih user-visible tidak boleh dipruning: jika marker
  // superseded hilang, MemoryItem lama akan terlihat current lagi. Slot sisa
  // baru dipakai untuk derivative episode-only yang rebuildable.
  const sourceBacked = sorted.filter((memory) =>
    memory.sourceMemoryIds.length > 0);
  const derived = sorted.filter((memory) =>
    memory.sourceMemoryIds.length === 0);
  return [
    ...sourceBacked,
    ...derived.slice(0, Math.max(0, MAX_SEMANTIC_MEMORIES - sourceBacked.length)),
  ];
}

function retainSuppressions(
  suppressions: MemoryKnowledgeState["suppressions"],
): MemoryKnowledgeState["suppressions"] {
  const byIdentity = new Map<string, MemoryKnowledgeState["suppressions"][number]>();
  for (const item of suppressions) {
    const key = `${item.sourceMemoryId}\0${item.contentHash}`;
    const previous = byIdentity.get(key);
    if (!previous || Date.parse(previous.createdAt) < Date.parse(item.createdAt)) {
      byIdentity.set(key, item);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function projectTemporalGraph(state: MemoryKnowledgeState): void {
  const namespace = state.namespace;
  const ownerId = memoryNamespaceOwnerId(namespace);
  const entities = new Map<string, MemoryEntity>();
  const relations: MemoryRelation[] = [];
  for (const memory of state.semanticMemories) {
    const projection = memory.graphProjection;
    if (
      !projection ||
      memory.status === "expired" ||
      (memory.sourceEpisodes.length === 0 &&
        memory.sourceSequences.length === 0 &&
        memory.sourceMemoryIds.length === 0)
    ) {
      continue;
    }
    const from = graphEntity(namespace, ownerId, projection.from);
    mergeEntity(entities, from);
    const to = projection.to
      ? graphEntity(namespace, ownerId, projection.to)
      : null;
    if (to) mergeEntity(entities, to);
    relations.push({
      id: `mr-${digest(`${memory.id}\0${projection.relation}`).slice(0, 24)}`,
      ownerId,
      fromEntityId: from.id,
      relation: projection.relation,
      toEntityId: to?.id ?? null,
      scalarValue: projection.scalarValue ?? null,
      validFrom: memory.validFrom,
      validUntil: memory.validUntil,
      learnedAt: memory.createdAt,
      confidence: memory.confidence,
      sourceEpisodeIds: [...memory.sourceEpisodes],
      sourceSequences: [...memory.sourceSequences],
      sourceMemoryIds: [...memory.sourceMemoryIds],
      semanticMemoryId: memory.id,
      sensitivity: memory.sensitivity,
      status: memory.status === "superseded"
        ? "superseded"
        : memory.status === "uncertain"
          ? "uncertain"
          : "active",
    });
  }
  state.entities = [...entities.values()];
  state.relations = relations;
}

function graphEntity(
  namespace: MemoryKnowledgeNamespace,
  ownerId: string,
  draft: MemoryGraphProjection["from"],
): MemoryEntity {
  const id = `me-${digest(
    `${memoryNamespaceKey(namespace)}\0${draft.type}\0${normalize(draft.canonicalName)}`,
  ).slice(0, 24)}`;
  return {
    id,
    ownerId,
    scope: namespace.kind,
    type: draft.type,
    canonicalName: draft.canonicalName,
    aliases: unique(draft.aliases ?? []),
  };
}

function mergeEntity(
  entities: Map<string, MemoryEntity>,
  candidate: MemoryEntity,
): void {
  const current = entities.get(candidate.id);
  if (!current) {
    entities.set(candidate.id, candidate);
    return;
  }
  current.aliases = unique([...current.aliases, ...candidate.aliases]);
}

function isSuppressedWithState(
  state: MemoryKnowledgeState,
  evidence: MemoryEvidenceProbe,
): boolean {
  const episodeIds = new Set(evidence.sourceEpisodeIds ?? []);
  const sequences = new Set(evidence.sourceSequences ?? []);
  const memoryIds = new Set(evidence.sourceMemoryIds ?? []);
  const hash = memoryContentHash(evidence.text);
  const probeTerms = new Set(memoryTermHashes(evidence.text));
  for (const item of state.suppressions) {
    // Edit mempertahankan ID record user-facing. Tombstone edit menekan klaim
    // lama, bukan record baru yang sengaja ditulis pengguna dengan ID sama.
    if (
      item.reason !== "edited" &&
      memoryIds.has(item.sourceMemoryId)
    ) {
      return true;
    }
  }

  // Source MemoryItem yang masih hidup adalah provenance lebih kuat daripada
  // sequence/episode bersama. Satu turn dapat melahirkan beberapa fakta;
  // melupakan satu fakta tidak boleh menekan fakta lain pada turn yang sama.
  if (memoryIds.size > 0) return false;

  for (const item of state.suppressions) {
    const sameSource =
      item.sourceEpisodeIds.some((id) => episodeIds.has(id)) ||
      item.sourceSequences.some((sequence) => sequences.has(sequence));
    const sameClaim = item.contentHash === hash ||
      similarHashedTerms(item.termHashes, probeTerms);
    if (
      sameSource && sameClaim
    ) {
      return true;
    }
  }
  return state.suppressions.some((item) =>
    item.contentHash === hash ||
    similarHashedTerms(item.termHashes, probeTerms));
}

function similarHashedTerms(
  suppressed: readonly string[],
  probe: ReadonlySet<string>,
): boolean {
  if (suppressed.length === 0 || probe.size === 0) return false;
  const overlap = suppressed.reduce(
    (count, term) => count + (probe.has(term) ? 1 : 0),
    0,
  );
  if (Math.min(suppressed.length, probe.size) === 1) {
    return overlap === 1 && suppressed.length === probe.size;
  }
  return overlap >= 2 &&
    overlap / Math.min(suppressed.length, probe.size) >= 0.6;
}

function semanticEvidence(
  memory: SemanticMemory,
  id: string,
  score: number,
  includeHistorical: boolean,
  at: Date,
): RetrievedMemoryEvidence {
  return {
    id,
    sources: ["semantic"],
    text: memory.displayText,
    score,
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    status: retrievalStatus(memory, includeHistorical, at),
    sensitivity: memory.sensitivity,
    sourceEpisodeIds: [...memory.sourceEpisodes],
    sourceSequences: [...memory.sourceSequences],
    sourceMemoryIds: [...memory.sourceMemoryIds],
  };
}

function retrievalStatus(
  memory: SemanticMemory,
  includeHistorical: boolean,
  at: Date,
): SemanticMemory["status"] {
  if (includeHistorical) return memory.status;
  if (memory.status === "uncertain") return "uncertain";
  // Status durable menggambarkan knowledge terbaru. Untuk correction yang
  // effective di masa depan, interval lama masih current sampai validUntil.
  if (
    memory.status === "superseded" &&
    memory.validUntil !== null &&
    Date.parse(memory.validUntil) > at.getTime()
  ) {
    return "active";
  }
  return memory.status;
}

function visibleAt(
  memory: SemanticMemory,
  at: Date,
  includeHistorical = false,
  explicitAsOf = false,
): boolean {
  const timestamp = at.getTime();
  if (memory.validFrom && Date.parse(memory.validFrom) > timestamp) return false;
  if (includeHistorical && !explicitAsOf) return true;
  if (memory.validUntil && Date.parse(memory.validUntil) <= timestamp) return false;
  if (includeHistorical || explicitAsOf) return true;
  return memory.status !== "expired";
}

function relationVisibleAt(
  relation: MemoryRelation,
  at: Date,
  includeHistorical = false,
  explicitAsOf = false,
): boolean {
  const timestamp = at.getTime();
  if (relation.validFrom && Date.parse(relation.validFrom) > timestamp) {
    return false;
  }
  if (includeHistorical && !explicitAsOf) return true;
  if (relation.validUntil && Date.parse(relation.validUntil) <= timestamp) {
    return false;
  }
  return includeHistorical || explicitAsOf || relation.status !== "superseded" ||
    (relation.validUntil !== null && Date.parse(relation.validUntil) > timestamp);
}

function validateEmbeddings(
  vectors: number[][],
  expectedCount: number,
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error("Provider embedding mengembalikan jumlah vector tidak sah.");
  }
  const dimension = vectors[0]?.length ?? 0;
  if (dimension < 1 || dimension > 16_384) {
    throw new Error("Dimensi embedding tidak sah.");
  }
  return vectors.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== dimension ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Provider embedding mengembalikan vector tidak sah.");
    }
    const magnitude = Math.sqrt(vector.reduce(
      (total, value) => total + value * value,
      0,
    ));
    if (!Number.isFinite(magnitude) || magnitude === 0) {
      throw new Error("Provider embedding mengembalikan zero vector.");
    }
    return vector.map((value) => value / magnitude);
  });
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce(
    (score, value, index) => score + value * (right[index] ?? 0),
    0,
  );
}

function entitySearchText(entity: MemoryEntity): string {
  return [entity.canonicalName, ...entity.aliases].join(" ");
}

function relationSearchText(
  relation: MemoryRelation,
  entities: ReadonlyMap<string, MemoryEntity>,
  memory: SemanticMemory,
): string {
  return [
    entitySearchText(entities.get(relation.fromEntityId)!),
    relation.relation.replaceAll("_", " "),
    relation.toEntityId ? entitySearchText(entities.get(relation.toEntityId)!) : "",
    relation.scalarValue ?? "",
    memory.displayText,
  ].join(" ");
}

function overlapScore(text: string, terms: ReadonlySet<string>): number {
  const haystack = significantTerms(text);
  let score = 0;
  for (const term of terms) if (haystack.has(term)) score += 1;
  return score;
}

function significantTerms(text: string): Set<string> {
  return new Set(
    normalize(text)
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 2 && !STOP_WORDS.has(term)) ?? [],
  );
}

function boundedText(
  value: unknown,
  maximum: number,
  label: string,
): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replaceAll(/\s+/gu, " ");
  if (!clean) return null;
  if (clean.length > maximum || /\p{Cc}/u.test(clean)) {
    throw new Error(`${label} tidak sah.`);
  }
  return clean;
}

function boundedStrings(
  values: readonly string[],
  maximumItems: number,
  maximumCharacters: number,
  label: string,
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new Error(`${label} terlalu banyak.`);
  }
  return unique(values.map((value) => {
    const clean = boundedText(value, maximumCharacters, label);
    if (!clean) throw new Error(`${label} kosong.`);
    return clean;
  }));
}

function boundedSequences(values: readonly number[]): number[] {
  if (
    !Array.isArray(values) ||
    values.length > 256 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("Source sequence semantic memory tidak sah.");
  }
  return uniqueNumbers(values);
}

function optionalDate(value: string | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Tanggal semantic memory tidak sah.");
  }
  return new Date(value).toISOString();
}

function queryTime(value: string | null | undefined, now: Date): Date {
  if (value === null || value === undefined) return now;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("Waktu query memory tidak sah.");
  }
  return new Date(value);
}

function resultLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULT_LIMIT;
  return Math.max(0, Math.min(MAX_RESULT_LIMIT, Math.floor(value)));
}

function earliestDate(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function latestDate(left: string | null, right: string | null): string | null {
  // `null` berarti validity terbuka dan selalu lebih akhir.
  if (left === null || right === null) return null;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function statusPriority(status: SemanticMemory["status"]): number {
  switch (status) {
    case "active": return 0;
    case "uncertain": return 1;
    case "superseded": return 2;
    case "expired": return 3;
  }
}

function predicateForMemoryKind(kind: MemoryItem["kind"]): string {
  switch (kind) {
    case "profile": return "has_profile";
    case "preference": return "prefers";
    case "routine": return "follows_routine";
    case "context": return "has_context";
    case "personal": return "has_personal_context";
  }
}

function predicateIsExclusive(predicate: string): boolean {
  const normalized = normalize(predicate);
  return EXCLUSIVE_PREDICATES.has(normalized) ||
    normalized.startsWith("favorite_");
}

function emptyConsolidationResult(): MemoryConsolidationResult {
  return {
    saved: 0,
    merged: 0,
    superseded: 0,
    uncertain: 0,
    rejected: 0,
  };
}

function projectionWithUpdatedValue(
  projection: MemoryGraphProjection | null | undefined,
  value: string,
): MemoryGraphProjection | null | undefined {
  if (!projection) return projection;
  if (projection.scalarValue !== undefined) {
    return { ...projection, scalarValue: value };
  }
  if (projection.to) {
    return {
      ...projection,
      to: { ...projection.to, canonicalName: value },
    };
  }
  return projection;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanId(value: string): string {
  const clean = value.trim().replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(0, 80);
  if (!clean) throw new Error("ID memory knowledge tidak sah.");
  return clean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const EXCLUSIVE_PREDICATES = new Set([
  "studies_at",
  "grade_level",
  "major",
  "preferred_learning_time",
  "prefers_learning_style",
  "taught_by",
]);
const PROVENANCES = new Set<MemoryProvenance>([
  "asserted",
  "observed",
  "inferred",
]);
const SENSITIVITIES = new Set<MemorySensitivity>([
  "normal",
  "personal",
  "restricted",
]);
const ENTITY_TYPES = new Set([
  "person",
  "subject",
  "course",
  "exam",
  "project",
  "goal",
  "activity",
  "place",
  "concept",
]);
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
] as const satisfies readonly EpisodeClaimField[];
const STOP_WORDS = new Set([
  "aku",
  "atau",
  "dan",
  "dari",
  "dengan",
  "ini",
  "itu",
  "kamu",
  "yang",
  "untuk",
]);
