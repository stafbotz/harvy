import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnderstanding } from "../src/ai/understand.js";

const TASK_JSON = JSON.stringify({
  intent: "task",
  safetySensitive: false,
  needsStepByStep: false,
  task: {
    title: "Kumpulin matematika halaman 20",
    dueAt: "2026-07-27T19:00:00+07:00",
    importance: 3,
  },
});

describe("pembacaan balasan model", () => {
  it("membaca JSON yang bersih", () => {
    const result = parseUnderstanding(TASK_JSON);

    assert.equal(result?.intent, "task");
    assert.equal(result?.task?.title, "Kumpulin matematika halaman 20");
    assert.equal(result?.task?.dueAt?.toISOString(), "2026-07-27T12:00:00.000Z");
    assert.equal(result?.task?.importance, 3);
  });

  it("membaca JSON yang terbungkus pagar kode dan basa-basi", () => {
    const raw = ["Tentu! Ini hasilnya:", "```json", TASK_JSON, "```"].join("\n");
    assert.equal(parseUnderstanding(raw)?.task?.importance, 3);
  });

  it("menolak balasan yang bukan JSON", () => {
    assert.equal(parseUnderstanding("maaf, aku tidak mengerti"), null);
    assert.equal(parseUnderstanding(""), null);
  });

  it("menyelamatkan pesan ketika intent dikarang tetapi tugasnya sah", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "reminder",
        safetySensitive: false,
        needsStepByStep: false,
        task: {
          title: "Minum obat",
          dueAt: null,
          remindAt: "2026-07-26T11:21:00+07:00",
          importance: 2,
        },
      }),
    );

    assert.equal(understanding?.intent, "task");
    assert.equal(understanding?.task?.title, "Minum obat");
  });

  it("menerima intent yang hurufnya berbeda", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ intent: " Feeling ", task: null }),
    );

    assert.equal(understanding?.intent, "feeling");
  });

  it("menolak intent di luar yang dikenal", () => {
    const raw = JSON.stringify({ intent: "belanja", task: null });
    assert.equal(parseUnderstanding(raw), null);
  });

  it("membuang tugas tanpa judul", () => {
    const raw = JSON.stringify({
      intent: "feeling",
      task: { title: "   ", dueAt: null, importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task, null);
  });

  it("mengabaikan tenggat yang tidak masuk akal", () => {
    const raw = JSON.stringify({
      intent: "task",
      task: { title: "Ujian", dueAt: "2999-01-01T00:00:00+07:00", importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.dueAt, null);
  });

  it("mengabaikan tenggat yang tidak dapat dibaca", () => {
    const raw = JSON.stringify({
      intent: "task",
      task: { title: "Ujian", dueAt: "besok pokoknya", importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.dueAt, null);
  });

  it("mengembalikan kepentingan ke nilai tengah bila tidak sah", () => {
    const raw = JSON.stringify({
      intent: "task",
      task: { title: "Ujian", dueAt: null, importance: 9 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.importance, 2);
  });

  it("membaca usulan memori beserta jenisnya", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "smalltalk",
        memories: [
          { kind: "profile", content: "Kelas 11 IPA di SMAN 3" },
          { kind: "personal", content: "Ibunya sedang sakit" },
        ],
      }),
    );

    assert.equal(understanding?.memories.length, 2);
    assert.equal(understanding?.memories[0]?.kind, "profile");
    assert.equal(understanding?.memories[1]?.kind, "personal");
  });

  it("memperlakukan jenis memori yang tidak dikenal sebagai sensitif", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "feeling",
        memories: [{ kind: "kesehatan", content: "Sedang sakit tipes" }],
      }),
    );

    // Menebak ke arah yang lebih longgar berarti menyimpan diam-diam sesuatu
    // yang mungkin sensitif. Menebak ke arah yang ketat hanya membuat Harvy
    // bertanya dulu, dan itu jauh lebih murah kalau salah.
    assert.equal(understanding?.memories[0]?.kind, "personal");
  });

  it("membuang usulan memori yang cacat tanpa menjatuhkan pesannya", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "task",
        task: { title: "Kumpulkan matematika", importance: 2 },
        memories: [
          { kind: "profile" },
          { content: "" },
          "bukan objek",
          { kind: "routine", content: "Les Jumat sore" },
        ],
      }),
    );

    assert.equal(understanding?.task?.title, "Kumpulkan matematika");
    assert.equal(understanding?.memories.length, 1);
    assert.equal(understanding?.memories[0]?.content, "Les Jumat sore");
  });

  it("membatasi jumlah memori per pesan", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "smalltalk",
        memories: [
          { kind: "profile", content: "Satu" },
          { kind: "profile", content: "Dua" },
          { kind: "profile", content: "Tiga" },
        ],
      }),
    );

    assert.equal(understanding?.memories.length, 2);
  });

  it("mengembalikan daftar memori kosong bila tidak ada", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ intent: "smalltalk" }),
    );

    assert.deepEqual(understanding?.memories, []);
  });

  it("membaca tanda keselamatan sebagai boolean tegas", () => {
    const aman = JSON.stringify({ intent: "feeling", task: null });
    assert.equal(parseUnderstanding(aman)?.safetySensitive, false);

    const berisiko = JSON.stringify({
      intent: "feeling",
      safetySensitive: true,
      task: null,
    });
    assert.equal(parseUnderstanding(berisiko)?.safetySensitive, true);
  });
});
