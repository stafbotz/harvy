import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasExplicitMemoryForgetRequest,
  isExplicitForgetAllMemories,
  memoryRetractionAuthorized,
  memoriesMatchingNaturalTarget,
} from "../src/core/memory-natural-control.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

describe("kontrol memori semantic", () => {
  const items = [
    memory("school", "Sekarang kelas 12 di SMAN 3", "2026-08-01T00:00:00.000Z"),
    memory("sohit", "Sohit adalah pacarku", "2026-08-02T00:00:00.000Z"),
    memory("study", "Lebih nyaman belajar pagi", "2026-08-03T00:00:00.000Z"),
  ];

  it("memerlukan forget explicit dengan evidence dari raw turn", () => {
    for (const [message, target] of [
      ["Forget what I told you about school", "school"],
      ["Pupuskeun anu ngeunaan sakola", "sakola"],
      ["Tulung laliaken sing soal sekolah", "sekolah"],
    ] as const) {
      assert.equal(
        hasExplicitMemoryForgetRequest(message, forget(message, target)),
        true,
        message,
      );
    }
    const message = "Please forget Sohit";
    assert.equal(
      hasExplicitMemoryForgetRequest(message, {
        ...forget(message, "Sohit"),
        explicitness: "implicit",
      }),
      false,
    );
    assert.equal(
      hasExplicitMemoryForgetRequest(message, forget("different evidence", "Sohit")),
      false,
    );
  });

  it("memilih semantic target tanpa meminta ID memory", () => {
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, "Sohit").map((item) => item.id),
      ["sohit"],
    );
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, "sekolahku").map((item) => item.id),
      ["school"],
    );
  });

  it("mengotorisasi retraction item-scoped hanya dari satu evidence exact", () => {
    const message =
      "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap.";
    assert.equal(memoryRetractionAuthorized(message, {
      target: "preferensi bahasa Inggris",
      sourceEvidence:
        "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
      explicitness: "explicit",
      confidence: 0.96,
    }), true);
    assert.equal(memoryRetractionAuthorized(message, {
      target: "semua ingatan",
      sourceEvidence:
        "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
      explicitness: "explicit",
      confidence: 0.96,
    }), false, "retraction natural tidak boleh menjadi bulk deletion");
    assert.equal(memoryRetractionAuthorized(message, {
      target: "preferensi bahasa Inggris",
      sourceEvidence: "evidence yang tidak ada",
      explicitness: "explicit",
      confidence: 0.96,
    }), false);
  });

  it("mencocokkan koreksi topik lintas bahasa secara owner-local", () => {
    const multilingual = [
      memory("english", "Prefers coding conversations in English", "2026-08-04T00:00:00.000Z"),
      memory("garden", "Memiliki kebun kecil", "2026-08-05T00:00:00.000Z"),
    ];
    assert.deepEqual(
      memoriesMatchingNaturalTarget(multilingual, "preferensi bahasa Inggris")
        .map((item) => item.id),
      ["english"],
    );
    assert.deepEqual(
      memoriesMatchingNaturalTarget(multilingual, "garden project")
        .map((item) => item.id),
      ["garden"],
    );
  });

  it("memakai reference recent sebagai source terbaru tanpa phrase parser", () => {
    assert.deepEqual(
      memoriesMatchingNaturalTarget(items, null, "recent").map((item) => item.id),
      ["study"],
    );
  });

  it("memisahkan forget-all untuk gerbang konfirmasi", () => {
    const all = "Delete everything you remember about me";
    assert.equal(
      isExplicitForgetAllMemories(all, {
        ...forget(all, null),
        reference: "all",
      }),
      true,
    );
    assert.equal(
      isExplicitForgetAllMemories("Lali Sohit", forget("Lali Sohit", "Sohit")),
      false,
    );
  });
});

function forget(message: string, target: string | null): SemanticOperation {
  return {
    version: 1,
    domain: "memory",
    operation: "forget",
    target,
    subject: "self",
    reference: "none",
    explicitness: "explicit",
    evidence: message,
    confidence: 0.95,
  };
}

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
