import type { EpisodeAnchor } from "../core/episode-anchors.js";

/**
 * Riwayat percakapan: giliran mentah terbaru dan episode terstruktur dari
 * rentang yang sudah dipadatkan.
 *
 * Giliran mentah tetap bounded. Episode hasil compaction ditulis satu kali ke
 * cold archive sebelum hot corpus boleh memangkasnya; episode lama tidak
 * diringkas ulang sehingga koreksi dan provenance tidak mengalami drift.
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

/**
 * Versi 3 menambahkan `progress` dan `anchors`. Episode versi 2 tetap dibaca
 * apa adanya dan memperoleh keduanya kosong; menaikkan versi tanpa itu akan
 * membuang seluruh episode lama, dan riwayat yang sudah dipadatkan tidak dapat
 * dibuat ulang dari mana pun.
 */
export const EPISODE_SCHEMA_VERSION = 3 as const;
export const EPISODE_CLAIM_MAX_CHARS = 280;
export const EPISODE_CLAIMS_PER_FIELD_LIMIT = 4;
export const EPISODE_TOTAL_CLAIMS_LIMIT = 24;
/**
 * Batas episode padat di hot JSON store. Cold archive tidak memakai cap ini;
 * ini juga bukan attention budget prompt dan hanya sebagian terbaru dirender.
 */
export const HISTORY_EPISODE_RETENTION_LIMIT = 32;
/** Episode terbaru yang boleh masuk context otomatis tanpa query retrieval. */
export const HISTORY_EPISODE_CONTEXT_LIMIT = 12;
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
  /**
   * Yang berhasil dikerjakan atau dipahami penggunanya sendiri di episode ini.
   *
   * Pasangan `unresolved`. Tanpanya, riwayat Harvy hanya merekam sisi
   * masalah—apa yang macet, apa yang belum jelas—dan tidak pernah sisi
   * kemajuan. Konstitusi Pasal 2 menuntut Harvy mengurangi bantuan untuk
   * kemampuan yang sudah dikuasai penggunanya; tanpa field ini tidak ada
   * satu pun tempat yang dapat menunjukkan sesuatu sudah dikuasai.
   */
  progress: EpisodeClaim[];
  temporalAnchors: EpisodeClaim[];
  uncertainties: EpisodeClaim[];
}

export type EpisodeClaimField = keyof EpisodeSummaryDraft;

/** Satu klaim yang cocok dengan query pencarian episode. */
export interface HistoricalEpisodeClaimMatch extends EpisodeClaim {
  field: EpisodeClaimField;
  /** Posisi asli di field episode; stabil walau hasil diurutkan berdasarkan skor. */
  claimIndex: number;
  /** Skor retrieval, bukan confidence bahwa klaimnya benar. */
  score: number;
}

/**
 * Hasil minimal pencarian riwayat. Isi episode lain tidak ikut terbawa hanya
 * karena satu klaim cocok; provenance penyimpanan tetap tersedia bagi consumer
 * tepercaya dan tidak dimaksudkan untuk operational log.
 */
export interface HistoricalEpisodeMatch {
  episodeId: string;
  createdAt: string;
  source: ConversationEpisode["source"];
  /** Skor retrieval, bukan authority atau semantic confidence. */
  score: number;
  claims: HistoricalEpisodeClaimMatch[];
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
  /**
   * Fakta persis yang dipanen kode, bukan ditulis model.
   *
   * Sengaja **tidak** ikut `EpisodeSummaryDraft`: draft adalah kontrak
   * keluaran model, dan seluruh nilai berkas ini justru karena tidak ada model
   * di jalurnya. Diisi sesudah peringkas menjawab.
   */
  anchors: EpisodeAnchor[];
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
