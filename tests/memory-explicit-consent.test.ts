import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explicitMemoryRememberAuthority } from "../src/core/memory-explicit-consent.js";

describe("authority explicit remember", () => {
  it("memahami perintah informal dan mencocokkan parafrasa candidate", () => {
    const cases = [
      ["harvy inget aku cintaaa banget sama sohit", "Sangat mencintai Sohit"],
      ["ingat ya nama pacarku Sohit", "Nama pacarnya adalah Sohit"],
      ["jangan lupa aku lebih suka belajar pagi", "Lebih suka belajar pagi"],
      ["tolong simpan ini, aku mau daftar ITB", "Ingin mendaftar ITB"],
      ["catat ya aku sekarang kelas 12", "Sekarang kelas 12"],
      [
        "ingetin kamu kalau aku lebih nyaman belajar pagi",
        "Lebih nyaman belajar pagi",
      ],
    ] as const;

    for (const [message, content] of cases) {
      const authority = explicitMemoryRememberAuthority(message, [{ content }]);
      assert.deepEqual(authority?.candidateIndexes, [0], message);
      assert.equal(authority?.forbiddenSecret, false, message);
    }
  });

  it("mengikat consent hanya ke klausa yang diminta diingat", () => {
    const authority = explicitMemoryRememberAuthority(
      "inget ya Sohit pacarku, btw tadi aku habis dari rumah sakit",
      [
        { content: "Sohit adalah pacarku" },
        { content: "Baru pulang dari rumah sakit" },
      ],
    );

    assert.equal(authority?.requestedText, "sohit pacarku");
    assert.deepEqual(authority?.candidateIndexes, [0]);
  });

  it("tidak memberi authority pada candidate yang menambah fakta sendiri", () => {
    const authority = explicitMemoryRememberAuthority(
      "ingat ya Sohit pacarku",
      [{ content: "Sohit adalah pacarku dan sedang dirawat di rumah sakit" }],
    );

    assert.deepEqual(authority?.candidateIndexes, []);
  });

  it("menolak negasi, retrieval, lupa biasa, dan reminder waktu", () => {
    for (const message of [
      "jangan ingat yang barusan",
      "jangan simpan kalau Sohit pacarku",
      "aku tidak ingin kamu ingat kalau Sohit pacarku",
      "kamu inget gak dulu aku cerita soal Sohit?",
      "inget gak dulu aku cerita soal Sohit?",
      "masih inget dulu aku cerita soal Sohit?",
      "ingat siapa Sohit itu?",
      "apa kamu masih ingat Sohit?",
      "aku lupa kapan ketemu Sohit",
      "ingetin aku belajar jam 7 malam",
      "jangan lupa ingetin aku belajar jam 7 malam",
    ]) {
      assert.equal(
        explicitMemoryRememberAuthority(message, [
          { content: "Sohit adalah pacarku" },
        ]),
        null,
        message,
      );
    }
  });

  it("mengenali request credential tetapi tidak memberi candidate authority", () => {
    for (const message of [
      "ingat password emailku adalah CONTOH_SANDI_123",
      "simpan OTP-ku 123456",
      "catat PIN kartu aku 4321",
      "ingat API key-ku adalah CONTOH_KUNCI_123456",
    ]) {
      const authority = explicitMemoryRememberAuthority(message, [
        { content: message },
      ]);
      assert.equal(authority?.forbiddenSecret, true, message);
      assert.deepEqual(authority?.candidateIndexes, [], message);
    }
  });
});
