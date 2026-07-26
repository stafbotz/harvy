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
