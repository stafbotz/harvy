import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collapseRepetition,
  isRepetitionDominated,
  MIN_FRAGMENT_CHARACTERS,
} from "../src/core/repetition-guard.js";

const ECHO = "Aku ngerti banget rasanya kewalahan sama tugas yang numpuk.";

describe("penjaga balasan berulang", () => {
  it("membiarkan balasan pendek lewat tanpa dinilai", () => {
    const text = `${ECHO}\n`.repeat(3);
    assert.ok(text.length < MIN_FRAGMENT_CHARACTERS);
    assert.equal(isRepetitionDominated(text), false);
  });

  it("menangkap satu baris yang menggema memenuhi balasan", () => {
    const text = `${ECHO}\n`.repeat(12);
    assert.ok(text.length >= MIN_FRAGMENT_CHARACTERS);
    assert.equal(isRepetitionDominated(text), true);
  });

  it("menangkap perulangan yang tidak rapi di batas baris", () => {
    const fragment = "kamu bisa mulai dari soal yang paling gampang dulu ya oke ";
    assert.equal(isRepetitionDominated(fragment.repeat(20)), true);
  });

  it("membiarkan penjelasan panjang yang wajar", () => {
    const text = [
      "Ada tiga hal yang bikin belajar fisika terasa berat di awal.",
      "Pertama, rumusnya dihafal sebelum konsepnya kepegang, jadi tiap soal terasa baru.",
      "Kedua, satuan sering diabaikan padahal itu yang paling cepat menunjukkan salah langkah.",
      "Ketiga, latihannya lompat ke soal ujian sebelum soal dasarnya lancar.",
      "Coba mulai dari yang kedua: tulis satuan di tiap baris pengerjaanmu minggu ini.",
      "Kalau masih macet di satu bab tertentu, bilang bab mana, nanti kita pecah bareng.",
    ].join(" ");
    assert.ok(text.length >= MIN_FRAGMENT_CHARACTERS);
    assert.equal(isRepetitionDominated(text), false);
  });

  it("membiarkan daftar bernomor yang berbagi ekor kalimat sama persis", () => {
    // Bentuk paling rawan salah tuduh, dan sebab uji jendela verbatim milik
    // Hermes tidak ditiru: delapan baris paralel yang berbagi ekor identik
    // jauh lebih panjang daripada satu jendela.
    const text = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((bab) =>
        `${bab}. Buka catatan bab ${bab}, baca ringkasannya sekali, lalu tandai istilah yang belum jelas di pinggir halaman.`
      )
      .join("\n");

    assert.ok(text.length >= MIN_FRAGMENT_CHARACTERS);
    assert.equal(isRepetitionDominated(text), false);
  });

  it("menyisakan awalan yang berarti, bukan membuang seluruh jawaban", () => {
    const opening = "Oke, kita pecah pelan-pelan ya.";
    const collapsed = collapseRepetition(`${opening}\n${`${ECHO}\n`.repeat(12)}`);

    assert.ok(collapsed.startsWith(opening));
    assert.equal(collapsed.includes(ECHO), true);
    assert.ok(collapsed.length < MIN_FRAGMENT_CHARACTERS);
    assert.equal(isRepetitionDominated(collapsed), false);
  });

  it("mengembalikan teks apa adanya ketika tidak ada yang perlu dipangkas", () => {
    const text = "Besok ada ulangan biologi bab sel, mau kita bikin ringkasannya?";
    assert.equal(collapseRepetition(text), text);
  });

  it("membiarkan pengulangan berperiode sangat pendek", () => {
    // Garis pemisah, padding, dan keluaran kerja yang berpola bukan loop
    // model. Yang digemakan loop adalah frasa, bukan satu-dua karakter.
    for (const text of ["j".repeat(5_000), "ab".repeat(400), "─".repeat(600)]) {
      assert.equal(isRepetitionDominated(text), false);
      assert.equal(collapseRepetition(text), text);
    }
  });
});
