import type { RiskLevel } from "../core/safety-policy.js";

/**
 * Catatan yang tidak ditampilkan kepada pemiliknya.
 *
 * Konstitusi v0.3, Pasal 3.9 dan Pasal 4 nomor 6, mengizinkan satu jenis
 * catatan tersembunyi dan hanya satu: catatan keselamatan dan pemahaman. Ia ada
 * karena perlindungan yang dapat dimatikan pengguna bukan perlindungan, dan
 * karena Harvy perlu menyesuaikan cara menemani tanpa pernah menanyakan umur.
 *
 * Batasnya ikut tertulis di pasal yang sama, dan berlaku di modul ini:
 *
 * - isinya hanya yang diperlukan untuk keselamatan dan cara menemani;
 * - ia ikut terhapus ketika pengguna menghapus seluruh datanya; dan
 * - ia tidak pernah dipakai untuk personalisasi yang menaikkan keterlibatan,
 *   analitik, pemasaran, atau penilaian yang merugikan pengguna.
 *
 * Menambah field di sini berarti memperluas pengecualian terhadap Larangan
 * Mutlak. Jangan melakukannya tanpa keputusan pemilik produk.
 */
export interface SafetyNote {
  at: string;
  level: RiskLevel;
  /** Satu kalimat tentang apa yang sedang dihadapi pengguna. */
  ringkasan: string;
  /** Apa yang Harvy lakukan atau tawarkan saat itu. */
  tindakan: string;
}

export interface UserInsight {
  ownerId: string;
  /** Bagaimana ia menulis, dan cara menemani yang tampaknya cocok untuknya. */
  gaya: string | null;
  /**
   * Perkiraan tahap perkembangan dari isi percakapan — jenjang sekolah,
   * cara bercerita, hal yang ia hadapi. Bukan angka umur, dan tidak pernah
   * ditanyakan. Pasal 3.10 meminta perlindungan menyesuaikan tahap
   * perkembangan; Pasal 3.9 meminta data dikumpulkan sesedikit mungkin.
   */
  tahap: string | null;
  /** Hal yang perlu diperlakukan hati-hati pada percakapan berikutnya. */
  kerentanan: string | null;
  /** Riwayat giliran berisiko, terbaru di akhir. */
  catatan: SafetyNote[];
  /** Kapan Harvy terakhir mengangkat bantuan profesional. */
  terakhirMenyarankanBantuan: string | null;
  updatedAt: string | null;
}

export interface InsightRepository {
  load(ownerId: string): Promise<UserInsight | null>;
  save(insight: UserInsight): Promise<void>;
  /** Mengembalikan `false` bila memang tidak ada. */
  remove(ownerId: string): Promise<boolean>;
}

export function emptyInsight(ownerId: string): UserInsight {
  return {
    ownerId,
    gaya: null,
    tahap: null,
    kerentanan: null,
    catatan: [],
    terakhirMenyarankanBantuan: null,
    updatedAt: null,
  };
}

export function isEmptyInsight(insight: UserInsight): boolean {
  return (
    !insight.gaya &&
    !insight.tahap &&
    !insight.kerentanan &&
    insight.catatan.length === 0
  );
}
