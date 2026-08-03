/**
 * Riwayat percakapan: giliran mentah terbaru dan episode terstruktur dari
 * rentang yang sudah dipadatkan.
 *
 * Berbeda dari memori, isinya tidak dimaksudkan bertahan tanpa batas. Setiap
 * giliran mentah hanya diringkas satu kali; episode lama tidak dimasukkan lagi
 * ke peringkas sehingga koreksi dan provenance tidak mengalami drift karena
 * rangkuman berulang.
 */
export type TurnRole = "user" | "harvy";

export interface ConversationTurn {
  role: TurnRole;
  text: string;
  at: string;
}

/** Giliran yang sudah mendapat urutan monoton di dalam satu scope privat. */
export interface StoredConversationTurn extends ConversationTurn {
  sequence: number;
}

export const EPISODE_SCHEMA_VERSION = 2 as const;
export const EPISODE_CLAIM_MAX_CHARS = 280;
export const EPISODE_CLAIMS_PER_FIELD_LIMIT = 4;
export const EPISODE_TOTAL_CLAIMS_LIMIT = 24;
export const HISTORY_EPISODE_RETENTION_LIMIT = 12;
export const HISTORY_TURN_MAX_CHARS = 2_000;
/** Batas kompatibilitas untuk satu blob ringkasan rolling v1 saat migrasi. */
export const HISTORY_LEGACY_SUMMARY_MAX_CHARS = 16_000;

/**
 * Satu pernyataan ringkas beserta giliran mentah yang benar-benar mendukungnya.
 * `sourceSequences` wajib tidak kosong pada episode hasil compaction v2.
 */
export interface EpisodeClaim {
  text: string;
  sourceSequences: number[];
}

/** Isi yang boleh ditulis model. Metadata sumber dibuat dan diverifikasi kode. */
export interface EpisodeSummaryDraft {
  topics: EpisodeClaim[];
  facts: EpisodeClaim[];
  goals: EpisodeClaim[];
  decisions: EpisodeClaim[];
  corrections: EpisodeClaim[];
  commitments: EpisodeClaim[];
  unresolved: EpisodeClaim[];
  temporalAnchors: EpisodeClaim[];
  uncertainties: EpisodeClaim[];
}

export type EpisodeSource =
  | {
      kind: "turn-range";
      fromSequence: number;
      throughSequence: number;
      turnCount: number;
      /** SHA-256 dari bentuk kanonik seluruh giliran sumber. */
      sourceHash: string;
    }
  | {
      /** Ringkasan v1 tidak mempunyai rentang sumber yang dapat dibuktikan. */
      kind: "legacy-summary";
      sourceHash: string;
    };

export interface ConversationEpisode extends EpisodeSummaryDraft {
  schemaVersion: typeof EPISODE_SCHEMA_VERSION;
  episodeId: string;
  source: EpisodeSource;
  /** Versi kontrak prompt/parser, bukan ID model penyedia. */
  summarizerVersion: string;
  createdAt: string;
}

export interface ConversationHistory {
  ownerId: string;
  /** Episode tersimpan dari yang paling lama ke yang paling baru. */
  episodes: ConversationEpisode[];
  turns: StoredConversationTurn[];
  /** Urutan yang akan diberikan kepada giliran berikutnya. */
  nextSequence: number;
  updatedAt: string;
}

export interface HistoryRepository {
  load(ownerId: string): Promise<ConversationHistory | null>;
  save(history: ConversationHistory): Promise<void>;
  /** Menghapus seluruh riwayat pengguna. Mengembalikan `false` bila tidak ada. */
  remove(ownerId: string): Promise<boolean>;
}
