import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasExplicitMemoryForgetRequest,
  isExplicitForgetAllMemories,
  memoriesMatchingNaturalTarget,
} from "../src/core/memory-natural-control.js";
import type { MemoryItem } from "../src/domain/memory.js";

describe("kontrol memori natural", () => {
  const items = [
    memory("school", "Sekarang kelas 12 di SMAN 3", "2026-08-01T00:00:00.000Z"),
    memory("sohit", "Sohit adalah pacarku", "2026-08-02T00:00:00.000Z"),
    memory("study", "Lebih nyaman belajar pagi", "2026-08-03T00:00:00.000Z"),
  ];

  it("memerlukan kata forget eksplisit sebelum mutasi", () => {
    assert.equal(hasExplicitMemoryForgetRequest("ceritain soal Sohit"), false);
    assert.equal(hasExplicitMemoryForgetRequest("lupain semua soal Sohit"), true);
  });

  it("memilih topik tanpa meminta ID memory", () => {
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, "Sohit", "lupain soal Sohit")
        .map((item) => item.id),
      ["sohit"],
    );
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, "sekolahku", "jangan ingat sekolahku")
        .map((item) => item.id),
      ["school"],
    );
  });

  it("memahami yang tadi sebagai source terbaru", () => {
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, "yang tadi", "yang tadi jangan disimpan")
        .map((item) => item.id),
      ["study"],
    );
  });

  it("memisahkan forget-all untuk gerbang konfirmasi", () => {
    assert.equal(
      isExplicitForgetAllMemories("hapus semua ingatanmu tentang aku"),
      true,
    );
    assert.equal(isExplicitForgetAllMemories("lupain semua soal Sohit"), false);
  });
});

function memory(id: string, content: string, createdAt: string): MemoryItem {
  return {
    id,
    ownerId: "student",
    kind: "profile",
    content,
    createdAt,
    lastUsedAt: null,
    expiresAt: null,
  };
}
