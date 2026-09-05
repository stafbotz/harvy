import type { SessionKind, SessionStage } from "./session.js";

/**
 * Yang tersisa setelah satu sesi pendampingan selesai.
 *
 * Sampai 4 September 2026 tidak ada apa pun yang tersisa. `SessionService`
 * memanggil `repository.remove` begitu sinyalnya `done`, dengan alasan yang
 * benar—minimisasi data—tetapi akibatnya sebuah sesi tutor yang membawa
 * seorang pelajar dari buntu sampai bisa menghilang tanpa jejak. Harvy
 * kemudian tidak punya cara mengetahui pelajarnya sudah bisa apa.
 *
 * Konstitusi menuntut pengetahuan itu, bukan menganjurkannya. Pasal 2:
 * "Untuk kemampuan yang sudah dikuasai pengguna, Harvy mengurangi bantuan
 * secara bertahap." Pasal 4 menutup tangganya dengan "Harvy mengurangi bantuan
 * ketika pengguna siap." Keduanya mensyaratkan Harvy dapat membedakan pelajar
 * yang baru pertama kali menemui sesuatu dari pelajar yang sudah tiga kali
 * menyelesaikannya sendiri. Lihat `ADR-047`.
 *
 * Isinya sengaja sesedikit mungkin: apa yang dikerjakan, sedalam apa bantuan
 * yang dibutuhkan, dan kapan. Tidak ada transkrip, tidak ada penilaian, tidak
 * ada nilai atau skor.
 */

/**
 * Sedalam apa bantuan yang sempat dibutuhkan sebelum sesi selesai.
 *
 * Diturunkan dari tahap terdalam yang pernah dicapai sesi, bukan dari penilaian
 * model. Tangga `TutorStage` sudah menyusunnya: berhenti di `attempt` berarti
 * ia mengerjakannya sendiri; sampai `explain` berarti ia perlu dijelaskan
 * ulang.
 */
export type ScaffoldDepth = "mandiri" | "berpetunjuk" | "dijelaskan";

export interface LearningTrace {
  id: string;
  ownerId: string;
  kind: SessionKind;
  /**
   * Tujuan sesi apa adanya, yaitu kalimat yang pengguna lihat dan dapat
   * koreksi sendiri. Bukan topik hasil klasifikasi model.
   */
  topic: string;
  depth: ScaffoldDepth;
  /** Tahap terdalam yang tercatat, disimpan agar `depth` dapat diperiksa. */
  deepestStage: SessionStage;
  completedAt: string;
}

export interface LearningTraceRepository {
  save(trace: LearningTrace): Promise<void>;
  list(ownerId: string): Promise<LearningTrace[]>;
  removeAll(ownerId: string): Promise<number>;
}
