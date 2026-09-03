/**
 * Bentuk data pencegahan penyalahgunaan. Lihat ADR-045.
 *
 * Tidak ada satu pun field yang menyimpan kutipan pesan pengguna. Keputusan
 * penangguhan hanya membutuhkan hitungan dan waktu; menyimpan kalimatnya berarti
 * Harvy memegang arsip omongan kasar anak orang tanpa gunanya.
 */

/**
 * Dua kategori dengan konsekuensi berbeda.
 *
 * `directed-abuse` adalah makian yang ditujukan kepada Harvy, bukan kata kasar
 * yang dipakai pengguna untuk melampiaskan sesuatu. `probing` adalah usaha
 * menembus batas Harvy, dan dikenali dari kegigihan sesudah ditolak—bukan dari
 * kosakata satu pesan.
 */
export type AbuseCategory = "directed-abuse" | "probing";

export type AbuseAction =
  /** Belum apa-apa; hanya dicatat. */
  | { kind: "record" }
  /** Harvy menegur, percakapan tetap berjalan. */
  | { kind: "warn"; warningNumber: number }
  /** Akses ditutup sampai waktu tertentu. */
  | { kind: "suspend"; untilMs: number; category: AbuseCategory }
  /**
   * Ditahan menunggu pengelola membacanya, dengan plafon.
   *
   * Plafonnya ada supaya kesibukan pengelola tidak berubah menjadi hukuman:
   * hasil terburuk adalah pengguna terkunci lama karena tidak ada yang sempat,
   * bukan karena ada yang memutuskan.
   */
  | { kind: "hold-for-review"; untilMs: number; category: AbuseCategory };

export interface AbuseWarning {
  category: AbuseCategory;
  atMs: number;
}

export interface AbuseSuspension {
  category: AbuseCategory;
  atMs: number;
  untilMs: number;
  /** True bila ini penahanan menunggu pengelola, bukan penangguhan bertimer. */
  review: boolean;
}

export interface AbuseRecord {
  ownerId: string;
  warnings: readonly AbuseWarning[];
  suspensions: readonly AbuseSuspension[];
}

export const EMPTY_ABUSE_RECORD: Omit<AbuseRecord, "ownerId"> = Object.freeze({
  warnings: [],
  suspensions: [],
});

export interface AbuseRepository {
  load(ownerId: string): Promise<AbuseRecord>;
  save(record: AbuseRecord): Promise<void>;
  forget(ownerId: string): Promise<void>;
}
