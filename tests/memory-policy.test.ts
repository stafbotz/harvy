import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  containsForbiddenMemorySecret,
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

  it("memakai jenis dan pendapat model, bukan daftar kata", () => {
    // Daftar kata yang dulu ada di sini gagal dua kali dengan cara yang sama:
    // ia menangkap "menyukai laki-laki" tetapi melewatkan "menyukai seseorang
    // berjenis kelamin pria", dan orientasi seksual seseorang tersimpan tanpa
    // izin. Penilaiannya kini datang dari triase risiko.
    assert.equal(isSensitiveMemory({ kind: "personal" }), true);
    assert.equal(isSensitiveMemory({ kind: "profile" }), false);
    assert.equal(isSensitiveMemory({ kind: "profile" }, true), true);
    assert.equal(isSensitiveMemory({ kind: "context" }, false), false);
  });

  it("memisahkan data personal berizin dari credential yang tetap terlarang", () => {
    assert.equal(containsForbiddenMemorySecret("Sangat mencintai Rani"), false);
    for (const content of [
      "Password email adalah CONTOH_SANDI_123",
      "OTP-ku 123456",
      "PIN kartu aku 4321",
      "API key adalah CONTOH_KUNCI_123456",
    ]) {
      assert.equal(containsForbiddenMemorySecret(content), true, content);
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

  it("tidak membawa memori personal atau preferensi yang tidak relevan", () => {
    const selected = selectRelevantMemories(
      [
        memory({ kind: "profile", content: "Nama panggilannya Raka" }),
        memory({ kind: "personal", content: "Sedang berkonflik dengan keluarga" }),
        memory({ kind: "preference", content: "Lebih suka belajar memakai diagram" }),
      ],
      "halo, apa kabar?",
      NOW,
    );

    assert.deepEqual(selected.map((item) => item.kind), ["profile"]);
  });

  it("tetap membawa memori personal ketika topiknya benar-benar cocok", () => {
    const selected = selectRelevantMemories(
      [memory({ kind: "personal", content: "Sedang berkonflik dengan keluarga" })],
      "konflik keluarga yang kemarin masih bikin kepikiran",
      NOW,
    );

    assert.equal(selected[0]?.kind, "personal");
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
