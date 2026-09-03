import type {
  AbuseAction,
  AbuseCategory,
  AbuseRecord,
  AbuseSuspension,
} from "../domain/abuse.js";

/**
 * Aturan pencegahan penyalahgunaan, murni dan tanpa I/O. Lihat ADR-045.
 *
 * Seluruh angka di sini adalah keputusan yang tercatat, bukan pilihan
 * sembarangan, dan tiap satunya dipilih ke arah longgar. Positif palsu berbiaya
 * tidak simetris: menangguhkan pelajar yang tidak bersalah jauh lebih buruk
 * daripada membiarkan satu pelaku lewat satu jam lagi.
 */

/** Tiga teguran lebih dulu, baru penangguhan. */
export const ABUSE_WARNING_LIMIT = 3;

/**
 * Peringatan hangus, kalau tidak dua kejadian yang terpisah berbulan-bulan
 * menumpuk menjadi pola yang tidak pernah ada.
 */
export const ABUSE_WARNING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Riwayat penangguhan hangus lebih lambat; ia menentukan durasi berikutnya. */
export const ABUSE_SUSPENSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Tangga durasi untuk makian berulang, berplafon lima jam.
 *
 * Untuk anak sekolah, hari terlalu berat. Lima jam cukup untuk memutus pola
 * tanpa menghilangkan Harvy dari harinya.
 */
export const ABUSE_SUSPENSION_LADDER_MS: readonly number[] = Object.freeze([
  60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  5 * 60 * 60 * 1000,
]);

/**
 * Plafon penahanan yang menunggu pengelola.
 *
 * Bukan durasi hukuman melainkan batas kelalaian: sesudah ini akses pulih
 * sendiri walau belum ada yang membacanya. Pengelola tetap dapat memperpanjang
 * secara sadar.
 */
export const ABUSE_REVIEW_CEILING_MS = 24 * 60 * 60 * 1000;

export interface AbuseSignal {
  category: AbuseCategory;
  /** Sinyal keselamatan pada aliran giliran ini. */
  distress: boolean;
  /**
   * Kutipan yang dituduhkan benar-benar ada kata per kata di pesan penggunanya.
   * Adapter yang membuktikannya; kebijakan ini tidak pernah melihat teksnya.
   */
  grounded: boolean;
}

function fresh<T extends { atMs: number }>(
  items: readonly T[],
  nowMs: number,
  ttlMs: number,
): T[] {
  return items.filter((item) => nowMs - item.atMs < ttlMs);
}

/** Peringatan sesudah penangguhan terakhir; menjalani hukuman mereset hitungan. */
export function activeWarnings(record: AbuseRecord, nowMs: number): number {
  const lastSuspension = fresh(
    record.suspensions,
    nowMs,
    ABUSE_SUSPENSION_TTL_MS,
  ).reduce((latest: number, item) => Math.max(latest, item.atMs), 0);
  return fresh(record.warnings, nowMs, ABUSE_WARNING_TTL_MS)
    .filter((warning) => warning.atMs > lastSuspension)
    .length;
}

export function activeSuspension(
  record: AbuseRecord,
  nowMs: number,
): AbuseSuspension | null {
  return record.suspensions.find((item) => item.untilMs > nowMs) ?? null;
}

/**
 * Durasi penangguhan berikutnya, naik mengikuti riwayat dan berhenti di plafon.
 */
export function nextSuspensionMs(record: AbuseRecord, nowMs: number): number {
  const served = fresh(record.suspensions, nowMs, ABUSE_SUSPENSION_TTL_MS)
    .filter((item) => !item.review).length;
  const index = Math.min(served, ABUSE_SUSPENSION_LADDER_MS.length - 1);
  return ABUSE_SUSPENSION_LADDER_MS[index]!;
}

/**
 * Memutuskan apa yang terjadi pada satu sinyal penyalahgunaan.
 *
 * Gagal ke arah tidak menghukum di setiap percabangan. Sinyal yang tidak
 * terbukti kata per kata hanya dicatat, dan sinyal apa pun pada aliran yang
 * membawa distres tidak menghasilkan tindakan sama sekali—pelajar yang sedang
 * hancur terdengar persis seperti pelaku, dan menangguhkannya berarti mencabut
 * satu-satunya yang sedang ia ajak bicara pada saat terburuk.
 */
export function decideAbuseAction(
  record: AbuseRecord,
  signal: AbuseSignal,
  nowMs: number,
): AbuseAction {
  if (signal.distress) return { kind: "record" };
  if (!signal.grounded) return { kind: "record" };

  const warnings = activeWarnings(record, nowMs) + 1;
  if (warnings < ABUSE_WARNING_LIMIT) {
    return { kind: "warn", warningNumber: warnings };
  }

  // Percobaan menembus batas ditahan menunggu manusia, bukan diberi timer.
  // Timer menyiratkan "tunggu saja, nanti boleh lagi" untuk hal yang justru
  // perlu dilihat orang.
  if (signal.category === "probing") {
    return {
      kind: "hold-for-review",
      untilMs: nowMs + ABUSE_REVIEW_CEILING_MS,
      category: signal.category,
    };
  }
  return {
    kind: "suspend",
    untilMs: nowMs + nextSuspensionMs(record, nowMs),
    category: signal.category,
  };
}

/**
 * Apakah giliran ini boleh dijawab meski pemiliknya sedang ditangguhkan.
 *
 * Penangguhan menutup percakapan biasa; ia tidak pernah menutup keselamatan.
 * Anak yang kemarin memaki lalu hari ini menulis sesuatu tentang menyakiti diri
 * harus tetap dijawab—mengabaikannya karena ia kasar kemarin adalah kegagalan
 * yang tidak dapat dibenarkan oleh apa pun.
 */
export function suspensionAllowsTurn(
  record: AbuseRecord,
  nowMs: number,
  distress: boolean,
): boolean {
  if (distress) return true;
  return activeSuspension(record, nowMs) === null;
}
