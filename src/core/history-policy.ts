/**
 * Aturan main riwayat: berapa giliran dibawa utuh, dan kapan yang terlama
 * diringkas lalu dibuang.
 *
 * Murni dan tanpa I/O. Peringkasnya sendiri memanggil model, jadi ia disuntikkan
 * dari luar — lihat `HistoryService`.
 */
import type { ConversationHistory, ConversationTurn } from "../domain/history.js";

/**
 * Jumlah giliran mentah yang dibawa ke dalam prompt.
 *
 * Enam giliran kira-kira tiga tanya-jawab: cukup untuk memahami "yang tadi itu"
 * tanpa membuat setiap pesan membawa seluruh percakapan.
 */
export const HISTORY_WINDOW = 6;

/**
 * Batas sebelum pemadatan dijalankan.
 *
 * Sengaja lebih besar daripada jendelanya supaya peringkasan tidak berjalan di
 * setiap giliran. Peringkasan memanggil model, dan memanggilnya setiap kali
 * berarti membayar dua kali untuk satu pesan.
 */
export const HISTORY_COMPACT_AT = 16;

/** Panjang satu giliran yang disimpan. Sisanya dipotong. */
export const TURN_MAX_CHARS = 2000;

export function needsCompaction(history: ConversationHistory): boolean {
  return history.turns.length > HISTORY_COMPACT_AT;
}

/**
 * Membelah riwayat menjadi bagian yang diringkas dan bagian yang tetap mentah.
 *
 * Yang tersisa selalu paling tidak sepanjang jendela prompt; kalau tidak,
 * pemadatan justru membuang konteks yang sedang dipakai.
 */
export function splitForCompaction(history: ConversationHistory): {
  evict: ConversationTurn[];
  keep: ConversationTurn[];
} {
  const keepCount = Math.min(history.turns.length, HISTORY_WINDOW);
  const cut = history.turns.length - keepCount;

  return {
    evict: history.turns.slice(0, cut),
    keep: history.turns.slice(cut),
  };
}

/** Giliran terakhir yang dibawa ke dalam prompt. */
export function promptWindow(history: ConversationHistory): ConversationTurn[] {
  return history.turns.slice(-HISTORY_WINDOW);
}

export function trimTurnText(text: string): string {
  const clean = text.trim();
  return clean.length <= TURN_MAX_CHARS ? clean : clean.slice(0, TURN_MAX_CHARS);
}
