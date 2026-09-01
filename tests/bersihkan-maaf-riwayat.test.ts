import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFailureTurn, verify } from "../scripts/bersihkan-maaf-riwayat.js";

/**
 * Pembersih kalimat gagal dari riwayat percakapan.
 *
 * Versi pertamanya hanya membuang giliran dan meninggalkan lubang di nomor
 * urutnya. `readHistoryV2` menolak seluruh basis data karena itu, dan akibatnya
 * tidak terlihat sebagai galat di skripnya melainkan sebagai giliran yang gagal
 * satu per satu di kanal—enam giliran berturut sebelum sebabnya ketemu.
 *
 * Skrip yang menyentuh data pengguna wajib membuktikan hasilnya masih sah
 * sebelum menyentuh berkas aslinya.
 */
describe("pembersih kalimat gagal riwayat", () => {
  const turn = (sequence: number, role: "user" | "harvy", text: string) => ({
    sequence,
    role,
    text,
    at: "2026-09-01T10:00:00.000Z",
  });

  it("mengenali kalimat gagal Harvy dari semua versinya", () => {
    for (
      const text of [
        "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku bermasalah.",
        "Aku lagi nggak bisa memproses percakapan dengan benar.",
      ]
    ) {
      assert.equal(isFailureTurn(turn(1, "harvy", text)), true, text);
    }
  });

  // Penjaga terpenting di berkas ini. Pesan pengguna yang kebetulan memuat
  // frasa serupa adalah percakapan sungguhan; membuangnya berarti menghapus
  // kata-kata orang dari riwayatnya sendiri.
  it("tidak pernah membuang pesan pengguna", () => {
    assert.equal(
      isFailureTurn(turn(1, "user", "kamu kok nggak bisa mikir sih")),
      false,
    );
  });

  it("membiarkan balasan biasa Harvy", () => {
    assert.equal(
      isFailureTurn(turn(1, "harvy", "Mulai dari sudut istimewa dulu ya.")),
      false,
    );
  });

  it("menolak nomor urut yang berlubang", () => {
    const alasan = verify({
      histories: [{
        turns: [turn(1, "user", "a"), turn(3, "harvy", "b")],
        episodes: [],
        nextSequence: 4,
      }],
    });

    assert.match(alasan ?? "", /berlubang/u);
  });

  it("menolak giliran pertama yang tidak menyambung episode terakhir", () => {
    const alasan = verify({
      histories: [{
        turns: [turn(9, "user", "a")],
        episodes: [{ source: { kind: "turn-range", throughSequence: 4 } }],
        nextSequence: 10,
      }],
    });

    assert.match(alasan ?? "", /giliran pertama/u);
  });

  it("menolak nextSequence yang tidak di atas nomor terbesar", () => {
    const alasan = verify({
      histories: [{
        turns: [turn(1, "user", "a"), turn(2, "harvy", "b")],
        episodes: [],
        nextSequence: 2,
      }],
    });

    assert.match(alasan ?? "", /nextSequence/u);
  });

  // Di atas nomor terbesar saja tidak cukup. Menomori ulang giliran ke bawah
  // sambil menahan nextSequence lama membuat giliran berikutnya lahir dengan
  // lubang, dan `save()` menolak seluruh riwayat—Harvy gagal menulis tiap
  // giliran meski membacanya berhasil. Terjadi nyata: 228 lalu 244.
  it("menolak nextSequence yang tidak tepat menyambung giliran terakhir", () => {
    const alasan = verify({
      histories: [{
        turns: [turn(1, "user", "a"), turn(2, "harvy", "b")],
        episodes: [],
        nextSequence: 18,
      }],
    });

    assert.match(alasan ?? "", /tidak menyambung/u);
  });

  it("meloloskan riwayat yang sah", () => {
    assert.equal(
      verify({
        histories: [{
          turns: [turn(5, "user", "a"), turn(6, "harvy", "b")],
          episodes: [{ source: { kind: "turn-range", throughSequence: 4 } }],
          nextSequence: 7,
        }],
      }),
      null,
    );
  });
});
