/**
 * Memori terstruktur tentang seorang pengguna.
 *
 * Bentuknya sengaja butiran pendek, bukan transkrip. Konstitusi Pasal 4 nomor 4
 * memberi pengguna hak menghapus *satu* memori, dan hak itu tidak berarti apa-apa
 * kalau yang tersimpan hanya gumpalan percakapan yang tidak dapat ditunjuk.
 *
 * Lihat `ADR-006`.
 */

/**
 * Jenis memori menentukan dua hal sekaligus: apakah ia boleh disimpan tanpa
 * bertanya, dan berapa lama ia hidup.
 *
 * `personal` berdiri sendiri karena Pasal 4 nomor 3 melarang informasi sensitif
 * disimpan secara otomatis. Jenis lain boleh langsung disimpan asal pengguna
 * diberi tahu.
 */
export type MemoryKind =
  | "profile"
  | "preference"
  | "routine"
  | "context"
  | "personal";

export interface MemoryItem {
  id: string;
  ownerId: string;
  kind: MemoryKind;
  /** Satu kalimat pendek, ditulis sebagai catatan Harvy tentang penggunanya. */
  content: string;
  createdAt: string;
  /** Kapan memori ini terakhir ikut membantu sebuah balasan. */
  lastUsedAt: string | null;
  /** ISO UTC. `null` berarti tidak kedaluwarsa dengan sendirinya. */
  expiresAt: string | null;
}

export interface NewMemory {
  ownerId: string;
  kind: MemoryKind;
  content: string;
}

export interface MemoryRepository {
  save(item: MemoryItem): Promise<void>;
  list(ownerId: string): Promise<MemoryItem[]>;
  /** Menghapus satu memori. Mengembalikan `false` bila tidak ada. */
  remove(ownerId: string, id: string): Promise<boolean>;
  /** Menghapus seluruh memori pengguna. Mengembalikan jumlah yang terhapus. */
  removeAll(ownerId: string): Promise<number>;
}
