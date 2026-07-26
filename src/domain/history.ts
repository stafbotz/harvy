/**
 * Riwayat percakapan: giliran mentah yang baru saja terjadi.
 *
 * Berbeda dari memori, isinya apa adanya dan tidak dimaksudkan bertahan lama.
 * Setelah melewati jendela tertentu, giliran terlama diringkas menjadi satu
 * paragraf bergulir dan teks mentahnya dibuang — lihat `ADR-006` bagian 3.
 */
export type TurnRole = "user" | "harvy";

export interface ConversationTurn {
  role: TurnRole;
  text: string;
  at: string;
}

export interface ConversationHistory {
  ownerId: string;
  /**
   * Ringkasan bergulir dari giliran yang sudah dibuang. `null` selama percakapan
   * masih cukup pendek untuk dibawa utuh.
   */
  summary: string | null;
  turns: ConversationTurn[];
  updatedAt: string;
}

export interface HistoryRepository {
  load(ownerId: string): Promise<ConversationHistory | null>;
  save(history: ConversationHistory): Promise<void>;
  /** Menghapus seluruh riwayat pengguna. Mengembalikan `false` bila tidak ada. */
  remove(ownerId: string): Promise<boolean>;
}
