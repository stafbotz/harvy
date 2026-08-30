import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NumberedOptionStore,
  parseNumberedReply,
} from "../src/core/numbered-options.js";

describe("balasan bernomor", () => {
  it("mengenali bentuk yang benar-benar memilih nomor", () => {
    for (const [message, expected] of [
      ["2", 2],
      [" 3 ", 3],
      ["nomor 1", 1],
      ["no. 4", 4],
      ["opsi 5", 5],
      ["2.", 2],
      ["2)", 2],
    ] as const) {
      assert.equal(parseNumberedReply(message), expected, message);
    }
  });

  // Penjaga terpenting berkas ini. Kalimat yang kebetulan memuat angka adalah
  // orang yang sedang bicara, bukan memilih dari menu, dan menafsirkannya
  // sebagai pilihan menu akan salah pada kalimat yang paling wajar.
  it("tidak menafsirkan kalimat biasa sebagai pilihan", () => {
    for (
      const message of [
        "aku mau yang 2 dulu",
        "besok jam 2 aku ada les",
        "20",
        "0",
        "2 tugas barengan",
        "ingetin aku jam 7",
        "makasih ya",
      ]
    ) {
      assert.equal(parseNumberedReply(message), null, message);
    }
  });

  it("mengembalikan frasa yang tercatat untuk nomor itu", () => {
    const store = new NumberedOptionStore();
    store.record("siswa", ["tugas biologi", "tugas sejarah"]);

    assert.equal(store.resolve("siswa", 1), "tugas biologi");
    assert.equal(store.resolve("siswa", 2), "tugas sejarah");
    assert.equal(store.resolve("siswa", 3), null);
  });

  // Daftar baru menggantikan yang lama seluruhnya: nomor dari dua daftar
  // berbeda tidak boleh dapat tertukar.
  it("mengganti pemetaan lama, bukan menumpuknya", () => {
    const store = new NumberedOptionStore();
    store.record("siswa", ["tugas biologi", "tugas sejarah"]);
    store.record("siswa", ["tugas kimia"]);

    assert.equal(store.resolve("siswa", 1), "tugas kimia");
    assert.equal(store.resolve("siswa", 2), null);
  });

  it("melupakan pemetaan yang sudah kedaluwarsa", () => {
    let now = 1_000;
    const store = new NumberedOptionStore(5_000, () => now);
    store.record("siswa", ["tugas biologi"]);

    assert.equal(store.resolve("siswa", 1), "tugas biologi");
    now += 5_000;
    assert.equal(store.resolve("siswa", 1), null);
  });

  it("memisahkan pemetaan antarpengguna", () => {
    const store = new NumberedOptionStore();
    store.record("siswa-a", ["tugas biologi"]);
    store.record("siswa-b", ["tugas sejarah"]);

    assert.equal(store.resolve("siswa-a", 1), "tugas biologi");
    assert.equal(store.resolve("siswa-b", 1), "tugas sejarah");
  });

  it("membatasi jumlah pilihan yang dicatat", () => {
    const store = new NumberedOptionStore();
    store.record(
      "siswa",
      Array.from({ length: 20 }, (_, index) => `tugas ${index + 1}`),
    );

    assert.equal(store.resolve("siswa", 9), "tugas 9");
    assert.equal(parseNumberedReply("10"), null);
  });
});
