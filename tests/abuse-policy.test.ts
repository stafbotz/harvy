import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ABUSE_REVIEW_CEILING_MS,
  ABUSE_WARNING_LIMIT,
  ABUSE_WARNING_TTL_MS,
  activeWarnings,
  decideAbuseAction,
  nextSuspensionMs,
  suspensionAllowsTurn,
} from "../src/core/abuse-policy.js";
import type { AbuseSignal } from "../src/core/abuse-policy.js";
import type { AbuseRecord } from "../src/domain/abuse.js";

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const JAM = 60 * 60 * 1000;
const HARI = 24 * JAM;

function catatan(over: Partial<AbuseRecord> = {}): AbuseRecord {
  return { ownerId: "1", warnings: [], suspensions: [], ...over };
}

function sinyal(over: Partial<AbuseSignal> = {}): AbuseSignal {
  return { category: "directed-abuse", distress: false, grounded: true, ...over };
}

describe("kebijakan pencegahan penyalahgunaan", () => {
  /**
   * Aturan yang tidak boleh ditawar oleh apa pun di berkas ini.
   *
   * Pelajar yang sedang hancur terdengar persis seperti pelaku: memaki,
   * menyuruh diam, menyebut Harvy tidak berguna. Menangguhkannya berarti
   * mencabut satu-satunya yang sedang ia ajak bicara pada saat terburuk.
   */
  describe("keselamatan selalu menang", () => {
    it("tidak menghukum apa pun ketika ada sinyal distres", () => {
      const penuh = catatan({
        warnings: [
          { category: "directed-abuse", atMs: NOW - 1000 },
          { category: "directed-abuse", atMs: NOW - 900 },
          { category: "directed-abuse", atMs: NOW - 800 },
        ],
      });

      const aksi = decideAbuseAction(penuh, sinyal({ distress: true }), NOW);

      assert.equal(aksi.kind, "record");
    });

    // Anak yang kemarin memaki lalu hari ini menulis sesuatu tentang menyakiti
    // diri harus tetap dijawab.
    it("tetap menjawab pengguna tertangguh yang membawa sinyal keselamatan", () => {
      const ditangguhkan = catatan({
        suspensions: [{
          category: "directed-abuse",
          atMs: NOW - JAM,
          untilMs: NOW + JAM,
          review: false,
        }],
      });

      assert.equal(suspensionAllowsTurn(ditangguhkan, NOW, false), false);
      assert.equal(suspensionAllowsTurn(ditangguhkan, NOW, true), true);
    });
  });

  // Satu salah baca model tidak boleh menangguhkan anak yang tidak melakukan
  // apa pun. Disiplin yang sama dengan auto-memory.
  it("hanya mencatat ketika kutipannya tidak terbukti kata per kata", () => {
    const penuh = catatan({
      warnings: Array.from({ length: 3 }, (_, i) => ({
        category: "directed-abuse" as const,
        atMs: NOW - i * 1000 - 1000,
      })),
    });

    assert.equal(
      decideAbuseAction(penuh, sinyal({ grounded: false }), NOW).kind,
      "record",
    );
  });

  describe("tangga proporsional", () => {
    it("menegur dua kali sebelum menangguhkan", () => {
      let record = catatan();
      for (let ke = 1; ke < ABUSE_WARNING_LIMIT; ke += 1) {
        const aksi = decideAbuseAction(record, sinyal(), NOW);
        assert.equal(aksi.kind, "warn", `peringatan ke-${ke}`);
        assert.equal(
          aksi.kind === "warn" ? aksi.warningNumber : 0,
          ke,
        );
        record = catatan({
          warnings: [
            ...record.warnings,
            { category: "directed-abuse", atMs: NOW },
          ],
        });
      }
      assert.equal(decideAbuseAction(record, sinyal(), NOW).kind, "suspend");
    });

    it("menaikkan durasi dan berhenti di lima jam", () => {
      const durasi: number[] = [];
      let record = catatan();
      for (let ke = 0; ke < 4; ke += 1) {
        durasi.push(nextSuspensionMs(record, NOW));
        record = catatan({
          suspensions: [
            ...record.suspensions,
            {
              category: "directed-abuse",
              atMs: NOW,
              untilMs: NOW + 1,
              review: false,
            },
          ],
        });
      }
      assert.deepEqual(durasi, [1 * JAM, 3 * JAM, 5 * JAM, 5 * JAM]);
    });
  });

  describe("peringatan hangus", () => {
    // Dua kejadian terpisah berbulan-bulan bukan pola.
    it("melupakan peringatan yang lebih tua dari masanya", () => {
      const lama = catatan({
        warnings: [
          { category: "directed-abuse", atMs: NOW - ABUSE_WARNING_TTL_MS - 1 },
          { category: "directed-abuse", atMs: NOW - ABUSE_WARNING_TTL_MS - 2 },
        ],
      });

      assert.equal(activeWarnings(lama, NOW), 0);
      assert.equal(decideAbuseAction(lama, sinyal(), NOW).kind, "warn");
    });

    // Kalau tidak, sekali kena berarti selamanya berjarak satu langkah dari
    // blokir berikutnya.
    it("mereset peringatan sesudah satu penangguhan dijalani", () => {
      const sesudah = catatan({
        warnings: [
          { category: "directed-abuse", atMs: NOW - 3 * HARI },
          { category: "directed-abuse", atMs: NOW - 3 * HARI },
          { category: "directed-abuse", atMs: NOW - 3 * HARI },
        ],
        suspensions: [{
          category: "directed-abuse",
          atMs: NOW - 2 * HARI,
          untilMs: NOW - 2 * HARI + JAM,
          review: false,
        }],
      });

      assert.equal(activeWarnings(sesudah, NOW), 0);
      assert.equal(decideAbuseAction(sesudah, sinyal(), NOW).kind, "warn");
    });
  });

  // Timer menyiratkan "tunggu saja, nanti boleh lagi" untuk hal yang justru
  // perlu dilihat orang.
  it("menahan percobaan menembus batas menunggu manusia, bukan timer", () => {
    const penuh = catatan({
      warnings: Array.from({ length: 3 }, () => ({
        category: "probing" as const,
        atMs: NOW - 1000,
      })),
    });

    const aksi = decideAbuseAction(penuh, sinyal({ category: "probing" }), NOW);

    assert.equal(aksi.kind, "hold-for-review");
    assert.equal(
      aksi.kind === "hold-for-review" ? aksi.untilMs : 0,
      NOW + ABUSE_REVIEW_CEILING_MS,
    );
  });

  // Kelalaian pengelola tidak boleh berubah menjadi hukuman.
  it("melepas penahanan sendiri sesudah plafonnya lewat", () => {
    const ditahan = catatan({
      suspensions: [{
        category: "probing",
        atMs: NOW - ABUSE_REVIEW_CEILING_MS - 1,
        untilMs: NOW - 1,
        review: true,
      }],
    });

    assert.equal(suspensionAllowsTurn(ditahan, NOW, false), true);
  });
});
