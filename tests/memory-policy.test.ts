import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expiryFor,
  isExpired,
  isSensitiveMemory,
  isSensitiveKind,
  selectRelevantMemories,
} from "../src/core/memory-policy.js";
import type { MemoryItem, MemoryKind } from "../src/domain/memory.js";

const NOW = new Date("2026-07-26T10:00:00.000Z");

describe("kebijakan memori", () => {
  it("hanya menandai jenis personal sebagai sensitif", () => {
    assert.equal(isSensitiveKind("personal"), true);
    assert.equal(isSensitiveKind("profile"), false);
    assert.equal(isSensitiveKind("preference"), false);
    assert.equal(isSensitiveKind("routine"), false);
    assert.equal(isSensitiveKind("context"), false);
  });

  it("menahan data sensitif meski model salah memberi jenis biasa", () => {
    assert.equal(
      isSensitiveMemory({
        kind: "profile",
        content: "Pengguna berjenis kelamin laki-laki.",
      }),
      true,
    );
    assert.equal(
      isSensitiveMemory({
        kind: "profile",
        content: "Pengguna adalah laki-laki yang menyukai laki-laki.",
      }),
      true,
    );
    assert.equal(
      isSensitiveMemory({
        kind: "profile",
        content: "Nama pengguna adalah Dimas.",
      }),
      false,
    );
  });

  it("menahan ketertarikan romantis sejauh apa pun jarak katanya", () => {
    // Kalimat persis ini tersimpan otomatis pada 26 Juli 2026, hanya karena
    // "berjenis kelamin" tidak cocok dengan `\\bjenis kelamin\\b` dan "pria"
    // tidak ada di daftar. Yang bocor adalah orientasi seksual seseorang.
    for (const content of [
      "Pengguna menyukai seseorang berjenis kelamin pria yang dikenal dari game Mobile Legends.",
      "Menyukai seorang cowok yang dikenal lewat game online.",
      "Punya crush yang jarang aktif karena sekolah asrama.",
      "Merasa dirinya cukup feminin.",
      "Sedang PDKT sama teman sekelas.",
    ]) {
      assert.equal(
        isSensitiveMemory({ kind: "context", content }),
        true,
        content,
      );
    }

    // Tetap tidak boleh menarik kalimat biasa ke jalur izin.
    for (const content of [
      "Kelas 11 IPA di SMAN 3 Bandung.",
      "Suka menulis untuk melepas pikiran.",
      "Suka roti cokelat.",
      "Tertarik dunia pemrograman dan ingin masuk ITB.",
    ]) {
      assert.equal(
        isSensitiveMemory({ kind: "context", content }),
        false,
        content,
      );
    }
  });

  it("memberi masa berlaku pada yang sementara, bukan pada jati diri", () => {
    assert.equal(expiryFor("profile", NOW), null);
    assert.equal(expiryFor("preference", NOW), null);
    assert.equal(expiryFor("routine", NOW), null);

    // Pasal 3.9 menuntut ada batas penyimpanan. Keadaan sementara dan hal
    // sensitif tidak boleh menempel selamanya tanpa pernah ditinjau.
    assert.notEqual(expiryFor("context", NOW), null);
    assert.notEqual(expiryFor("personal", NOW), null);
  });

  it("menganggap memori kedaluwarsa setelah waktunya lewat", () => {
    const item = memory({
      kind: "context",
      content: "Ujian biologi minggu depan",
      expiresAt: "2026-07-25T10:00:00.000Z",
    });

    assert.equal(isExpired(item, NOW), true);
    assert.equal(isExpired({ ...item, expiresAt: null }, NOW), false);
  });

  it("tidak pernah membawa memori kedaluwarsa ke dalam prompt", () => {
    const selected = selectRelevantMemories(
      [
        memory({
          content: "Sudah lewat masanya",
          expiresAt: "2026-07-01T00:00:00.000Z",
        }),
        memory({ content: "Masih berlaku" }),
      ],
      "halo",
      NOW,
    );

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.content, "Masih berlaku");
  });

  it("mendahulukan memori yang katanya cocok dengan pesan", () => {
    const selected = selectRelevantMemories(
      [
        memory({ kind: "profile", content: "Kelas 11 IPA di SMAN 3" }),
        memory({ kind: "context", content: "Sedang menyiapkan lomba fotografi" }),
      ],
      "besok ada lomba fotografi, aku deg-degan",
      NOW,
      1,
    );

    // Bobot jenis membuat profile unggul secara bawaan; kecocokan kata harus
    // dapat mengalahkannya, kalau tidak memori selalu itu-itu saja.
    assert.equal(selected[0]?.content, "Sedang menyiapkan lomba fotografi");
  });

  it("membatasi jumlah memori yang ikut ke dalam prompt", () => {
    const many = Array.from({ length: 20 }, (_unused, index) =>
      memory({ content: `Catatan ke-${index}` }),
    );

    assert.equal(selectRelevantMemories(many, "halo", NOW, 3).length, 3);
  });
});

function memory(overrides: Partial<MemoryItem> & { content: string }): MemoryItem {
  const kind: MemoryKind = overrides.kind ?? "profile";

  return {
    id: overrides.id ?? Math.random().toString(36).slice(2, 10),
    ownerId: overrides.ownerId ?? "student",
    kind,
    content: overrides.content,
    createdAt: overrides.createdAt ?? "2026-07-20T10:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
  };
}
