import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  planResponsePresentation,
} from "../src/core/response-presentation.js";

describe("rencana presentasi respons", () => {
  it("mempertahankan jumlah beat percakapan yang natural", () => {
    const text = "WOAH 😭\n\nakhirnyaaa\n\naku ikut seneng\n\ncerita dong";
    const plan = planResponsePresentation(text, {
      maxSegmentCharacters: 4_000,
    });

    assert.deepEqual(plan.segments.map((segment) => segment.text), [
      "WOAH 😭",
      "akhirnyaaa",
      "aku ikut seneng",
      "cerita dong",
    ]);
    assert.equal(plan.antiSpamGuardApplied, false);
  });

  it("menjaga penjelasan dan daftar koheren dalam satu segmen", () => {
    const text = [
      "Ada dua hal yang paling berpengaruh pada pilihanmu.",
      "1. Cara belajar: kampus pertama lebih teoritis.\n2. Tujuan: kampus kedua lebih dekat ke proyek industri.",
      "Kalau tujuanmu AI, bandingkan mata kuliah dan kesempatan risetnya.",
    ].join("\n\n");
    const plan = planResponsePresentation(text, {
      maxSegmentCharacters: 4_000,
    });

    assert.deepEqual(plan.segments.map((segment) => segment.text), [text]);
  });

  it("memakai guard anti-spam tanpa membuang satu pun beat", () => {
    const beats = Array.from({ length: 12 }, (_, index) => `beat ${index + 1}`);
    const text = beats.join("\n\n");
    const plan = planResponsePresentation(text, {
      maxSegmentCharacters: 4_000,
      antiSpamSegmentCeiling: 8,
    });

    assert.equal(plan.antiSpamGuardApplied, true);
    assert.equal(plan.segments.length, 8);
    assert.equal(plan.segments.map((segment) => segment.text).join("\n\n"), text);
  });

  it("hard splitter menjaga seluruh code point setelah rencana semantik", () => {
    const text = `\`\`\`ts\n${"😀x".repeat(2_500)}\n\`\`\``;
    const plan = planResponsePresentation(text, {
      maxSegmentCharacters: 4_000,
    });

    assert.ok(plan.segments.length > 1);
    assert.equal(
      plan.segments.every((segment) =>
        Array.from(segment.text).length <= 4_000
      ),
      true,
    );
    assert.equal(plan.segments.map((segment) => segment.text).join(""), text);
  });

  it("memberi Telegram dan WhatsApp semantic plan yang sama sebelum batas transport", () => {
    const text = "Nah, ini inti jawabannya.\n\nMau kita bandingkan dua opsi itu?";
    const telegram = planResponsePresentation(text, {
      maxSegmentCharacters: 4_000,
    });
    const whatsapp = planResponsePresentation(text, {
      maxSegmentCharacters: 12_000,
    });

    assert.deepEqual(
      telegram.segments.map(({ text, relation }) => ({ text, relation })),
      whatsapp.segments.map(({ text, relation }) => ({ text, relation })),
    );
  });
});
