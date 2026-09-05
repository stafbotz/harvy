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

export interface QuietHours {
  /** Menit sejak pukul 00.00 pada jam dinding pengguna. */
  startMinute: number;
  endMinute: number;
}

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
  /** Zona waktu dipilih pengguna; `null` berarti belum pernah memilih. */
  timeZone: string | null;
  /**
   * `null` dapat berarti tidak memakai jam tenang. `quietHoursSetAt`
   * membedakannya dari keadaan belum pernah ditanya.
   */
  quietHours: QuietHours | null;
  quietHoursSetAt: string | null;
  /** Waktu terakhir pengguna menarik izin pemrosesan AI. */
  consentWithdrawnAt: string | null;
  /**
   * Tombstone penghapusan lintas-berkas. Profil dihapus paling akhir setelah
   * seluruh penyimpanan lain bersih.
   */
  deletionRequestedAt: string | null;
  /**
   * Tawaran tindakan yang sudah berkali-kali dilewatkan tanpa ditekan.
   *
   * Opsional supaya berkas profil lama terbaca apa adanya tanpa migrasi.
   * Isinya hitungan dan stempel waktu per tombol—tidak ada isi percakapan,
   * dan tidak ada apa pun tentang pengguna selain bahwa satu tombol tidak
   * berguna baginya belakangan ini.
   *
   * Ada di sini, bukan di memori, karena inilah tepatnya yang dimaksud berkas
   * ini: status kenalan. Ia juga sengaja bertahan melewati penghapusan memori,
   * dengan alasan yang sama seperti catatan persetujuan—memakai hak menghapus
   * ingatan tidak seharusnya membuat Harvy mulai mendesak lagi dari awal.
   */
  offerFatigue?: import("../core/offer-fatigue-policy.js").OfferFatigue;
}

export interface ProfileRepository {
  find(ownerId: string): Promise<UserProfile | null>;
  save(profile: UserProfile): Promise<void>;
  remove(ownerId: string): Promise<boolean>;
  listDeletionRequested(): Promise<UserProfile[]>;
}
