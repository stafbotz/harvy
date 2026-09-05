/**
 * Janji yang sudah dibuat tetapi belum terbukti sampai.
 *
 * Sebuah balasan yang sudah disusun tetapi belum dikonfirmasi terkirim adalah
 * satu-satunya hal yang dapat hilang dari Harvy tanpa meninggalkan jejak apa
 * pun. Gilirannya sudah membayar token, pesan penggunanya sudah tercatat di
 * riwayat, dan teks jawabannya hanya ada di dalam satu variabel di memori.
 * Proses yang mati di antara "jawaban jadi" dan "jawaban terkirim" membuang
 * jawaban itu tanpa siapa pun tahu—yang tersisa hanyalah pelajar yang bertanya
 * lalu tidak dijawab.
 *
 * `ScheduledDeliveryAttempt` sudah menjaga hal serupa untuk efek terjadwal
 * (pengingat tugas, check-in), tetapi memilih **at-most-once**: `in_flight`
 * sengaja tidak pernah diulang, karena pengingat ganda adalah gangguan.
 * Timbangan untuk balasan percakapan terbalik, dan itulah sebab berkas ini
 * ada terpisah. Lihat `ADR-046`.
 */

export type ReplyObligationChannel = "telegram";

/**
 * Keadaan sebuah janji.
 *
 * Pembedaan `pending` dan `attempting` bukan kerapian: keduanya menentukan
 * apakah pengiriman ulang dapat menghasilkan duplikat.
 *
 * - `pending` — belum satu byte pun dikirim. Aman diulang, nol risiko ganda.
 * - `attempting` — I/O sudah dimulai dan hasilnya tidak dapat dibuktikan.
 *   Telegram **mungkin** sudah menerimanya. Diulang dengan penanda yang
 *   terlihat, sehingga kontraknya at-least-once yang jujur, bukan duplikat
 *   diam-diam.
 * - `delivered` — selesai; tinggal menunggu dipangkas.
 * - `abandoned` — terlalu tua atau terlalu sering gagal. Balasan yang tiba
 *   lima belas menit terlambat lebih buruk daripada tidak ada.
 */
export type ReplyObligationState =
  | "pending"
  | "attempting"
  | "delivered"
  | "abandoned";

/**
 * Proses yang memegang sebuah janji.
 *
 * PID saja tidak cukup: sistem operasi memakai ulang nomornya, dan proses baru
 * yang kebetulan mendapat PID yang sama akan membuat baris milik proses mati
 * terlihat masih hidup. Waktu mulai membedakan keduanya.
 */
export interface ReplyObligationOwnerProcess {
  pid: number;
  startedAt: string;
}

export interface ReplyObligation {
  id: string;
  ownerId: string;
  chatId: string;
  channel: ReplyObligationChannel;
  /**
   * Teks yang belum terbukti sampai.
   *
   * Ini isi percakapan pengguna, dan ia ada di disk. Karena itu berkas ini
   * berumur pendek dengan sengaja, ikut terekspor lewat kontrol data, dan ikut
   * terhapus ketika pengguna menghapus datanya—tanpa ketiganya, ia menjadi
   * tempat data pengguna menumpuk di luar pengawasan pemiliknya.
   */
  text: string;
  state: ReplyObligationState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  ownerProcess: ReplyObligationOwnerProcess;
}

export interface ReplyObligationRepository {
  save(obligation: ReplyObligation): Promise<void>;
  /** Seluruh janji yang belum selesai, lintas pemilik. */
  listUnsettled(): Promise<ReplyObligation[]>;
  list(ownerId: string): Promise<ReplyObligation[]>;
  remove(id: string): Promise<boolean>;
  removeAll(ownerId: string): Promise<number>;
}
