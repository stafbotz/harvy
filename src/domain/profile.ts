/**
 * Status kenalan seorang pengguna dengan Harvy.
 *
 * Sengaja dipisahkan dari memori dan riwayat. Menghapus seluruh ingatan adalah
 * hak pengguna (Pasal 4 nomor 4), tetapi kalau penghapusan itu ikut menghapus
 * catatan persetujuan, pengguna dipaksa berkenalan ulang setiap kali memakai
 * haknya — dan itu justru mempersulit penarikan izin yang dilarang Pasal 4
 * nomor 5.
 *
 * Isinya sengaja sesedikit mungkin. Nama panggilan tidak disimpan di sini:
 * Telegram sudah mengirimkannya pada setiap pesan, dan nama yang dikoreksi
 * pengguna sendiri sudah menjadi memori jenis `profile`. Pasal 3.9 meminta data
 * dikumpulkan sesedikit mungkin, bukan sebanyak yang muat.
 */

/**
 * Bagaimana pengguna ingin ditemani ketika ia bercerita.
 *
 * `listen` mendengarkan dulu dan menahan saran; `advice` langsung ke langkah
 * konkret. Ditanyakan sekali setelah percakapan pertama, tidak di gerbang
 * perkenalan — Pasal 3.11 meminta pilihan tidak berlebihan di depan.
 */
export type StylePreference = "listen" | "advice";

export interface UserProfile {
  ownerId: string;
  /**
   * Versi ketentuan yang sudah disetujui pengguna. `0` berarti belum pernah.
   *
   * Berversi supaya persetujuan hanya diminta ulang ketika yang disetujui
   * memang berubah — misalnya penyedia model atau jenis data yang dikirim —
   * bukan setiap kali naskahnya diperhalus.
   */
  consentVersion: number;
  /** ISO UTC saat perkenalan selesai. `null` berarti belum berkenalan. */
  onboardedAt: string | null;
  stylePreference: StylePreference | null;
  /** Pertanyaan gaya hanya diajukan sekali, diterima atau tidak. */
  styleAskedAt: string | null;
}

export interface ProfileRepository {
  find(ownerId: string): Promise<UserProfile | null>;
  save(profile: UserProfile): Promise<void>;
}
