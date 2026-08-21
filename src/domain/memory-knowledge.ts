/**
 * Namespace durable untuk semantic memory dan graph turunannya.
 *
 * Namespace dibentuk kode dari identity tepercaya. Teks/model hanya boleh
 * mengusulkan isi memori; ia tidak pernah memilih owner atau scope storage.
 */
export type MemoryKnowledgeNamespace =
  | {
      kind: "private";
      ownerId: string;
    }
  | {
      kind: "group";
      groupId: string;
      /** `null` adalah shared-room memory; nilai lain member-local. */
      memberId: string | null;
    }
  | {
      kind: "project";
      workspaceKey: string;
      projectId: string;
    };

export type MemorySensitivity = "normal" | "personal" | "restricted";
export type MemoryProvenance = "asserted" | "observed" | "inferred";
export type SemanticMemoryStatus =
  | "active"
  | "superseded"
  | "uncertain"
  | "expired";

export type MemoryEntityType =
  | "person"
  | "subject"
  | "course"
  | "exam"
  | "project"
  | "goal"
  | "activity"
  | "place"
  | "concept";

/** Satu sumber terperinci agar deletion cascade dapat dihitung ulang. */
export interface SemanticMemoryEvidence {
  sourceMemoryId: string | null;
  sourceEpisodeId: string | null;
  sourceSequences: number[];
}

export interface MemoryGraphEntityDraft {
  type: MemoryEntityType;
  canonicalName: string;
  aliases?: string[];
}

/**
 * Proposal proyeksi graph. Ia disimpan bersama semantic source, lalu graph
 * selalu dibangun ulang darinya; graph bukan sumber kebenaran kedua.
 */
export interface MemoryGraphProjection {
  from: MemoryGraphEntityDraft;
  relation: string;
  to?: MemoryGraphEntityDraft;
  scalarValue?: string;
}

export interface SemanticMemory {
  id: string;
  ownerId: string;

  subject: string;
  predicate: string;
  value: string;
  displayText: string;

  confidence: number;

  validFrom: string | null;
  validUntil: string | null;

  sourceEpisodes: string[];
  sourceSequences: number[];
  /** ID user-facing memory yang dapat menghapus derivation ini. */
  sourceMemoryIds: string[];
  evidence: SemanticMemoryEvidence[];

  createdAt: string;
  lastVerifiedAt: string | null;
  lastUsedAt: string | null;

  sensitivity: MemorySensitivity;
  provenance: MemoryProvenance;
  status: SemanticMemoryStatus;
  graphProjection: MemoryGraphProjection | null;
}

export interface MemoryEntity {
  id: string;
  ownerId: string;
  scope: MemoryKnowledgeNamespace["kind"];
  type: MemoryEntityType;
  canonicalName: string;
  aliases: string[];
}

export interface MemoryRelation {
  id: string;
  ownerId: string;
  fromEntityId: string;
  relation: string;
  toEntityId: string | null;
  scalarValue: string | null;
  validFrom: string | null;
  validUntil: string | null;
  learnedAt: string;
  confidence: number;
  sourceEpisodeIds: string[];
  sourceSequences: number[];
  sourceMemoryIds: string[];
  /** Semantic source wajib masih ada agar edge boleh digunakan. */
  semanticMemoryId: string;
  sensitivity: MemorySensitivity;
  status: "active" | "superseded" | "uncertain";
}

/**
 * Tombstone per-item. Hash teks hanya fallback untuk record legacy; sequence
 * atau source ID lebih kuat dan selalu diprioritaskan bila tersedia.
 */
export interface MemorySuppression {
  id: string;
  sourceMemoryId: string;
  contentHash: string;
  /** Hash token bermakna untuk suppression legacy tanpa menyimpan teks lama. */
  termHashes: string[];
  sourceEpisodeIds: string[];
  sourceSequences: number[];
  createdAt: string;
  reason: "forgotten" | "edited" | "expired";
}

export interface MemoryKnowledgeState {
  schemaVersion: 1;
  namespace: MemoryKnowledgeNamespace;
  revision: number;
  semanticMemories: SemanticMemory[];
  entities: MemoryEntity[];
  relations: MemoryRelation[];
  suppressions: MemorySuppression[];
  updatedAt: string;
}

export interface MemoryKnowledgeRepository {
  load(
    namespace: MemoryKnowledgeNamespace,
  ): Promise<MemoryKnowledgeState | null>;
  save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict">;
  remove(namespace: MemoryKnowledgeNamespace): Promise<boolean>;
}

/**
 * Port embedding sungguhan. Implementasi keyword/hash tidak boleh dipasang ke
 * port ini dan disebut semantic. Provider live dapat dihubungkan terpisah.
 */
export interface TextEmbeddingProvider {
  readonly modelId: string;
  /** Exact model/config revision; defaults to modelId for legacy adapters. */
  readonly modelVersion?: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export type RetrievedMemorySource =
  | "episode"
  | "semantic"
  | "graph"
  | "user-model"
  | "procedure"
  | "error-lesson";

/** Paket evidence yang tetap berstruktur sampai renderer prompt. */
export interface RetrievedMemoryEvidence {
  id: string;
  sources: RetrievedMemorySource[];
  text: string;
  score: number;
  validFrom: string | null;
  validUntil: string | null;
  status: SemanticMemoryStatus;
  sensitivity: MemorySensitivity;
  sourceEpisodeIds: string[];
  sourceSequences: number[];
  sourceMemoryIds: string[];
}
