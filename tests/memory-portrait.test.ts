import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groundedMemoryPortraitFallback,
  hasMemoryPortraitEvidence,
  isMemoryPortraitGrounded,
  memoryPortraitInput,
  parseMemoryPortrait,
} from "../src/ai/memory-portrait.js";
import type { HarvyContext } from "../src/ai/context.js";

describe("potret memori", () => {
  it("membawa hanya primary dan evidence yang dapat ditelusuri ke primary", () => {
    const context: HarvyContext = {
      summary: "Pernah membicarakan pilihan kuliah.",
      turns: [{
        role: "user",
        text: "rahasia raw turn tidak boleh masuk",
        at: "2026-08-21T00:00:00.000Z",
      }],
      memories: [{
        id: "memory-secret-id",
        ownerId: "owner-secret-id",
        kind: "context",
        content: "Belakangan lebih condong ke ITB",
        createdAt: "2026-08-21T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
      }],
      retrieved: [{
        id: "semantic-secret-id",
        sources: ["semantic"],
        text: "Dulu sempat mempertimbangkan UI",
        score: 0.8,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-07-01T00:00:00.000Z",
        status: "superseded",
        sensitivity: "normal",
        sourceEpisodeIds: ["episode-secret-id"],
        sourceSequences: [1],
        sourceMemoryIds: ["memory-secret-id"],
      }, {
        id: "user-model-secret-id",
        sources: ["user-model"],
        text: "Mungkin lebih nyaman belajar malam",
        score: 0.4,
        validFrom: null,
        validUntil: null,
        status: "uncertain",
        sensitivity: "normal",
        sourceEpisodeIds: [],
        sourceSequences: [],
        sourceMemoryIds: [],
      }],
    };

    const input = memoryPortraitInput(context);

    assert.match(input, /superseded/u);
    assert.match(input, /Dulu sempat mempertimbangkan UI/u);
    assert.doesNotMatch(input, /uncertain/u);
    assert.doesNotMatch(input, /Mungkin lebih nyaman belajar malam/u);
    assert.doesNotMatch(input, /Pernah membicarakan pilihan kuliah/u);
    assert.doesNotMatch(input, /rahasia raw turn/u);
    assert.doesNotMatch(input, /secret-id/u);
    assert.equal(hasMemoryPortraitEvidence(context), true);
  });

  it("menerima narasi yang menyatakan ketidakpastian secara manusiawi", () => {
    const summary = parseMemoryPortrait(JSON.stringify({
      summary:
        "Kamu sedang memikirkan pilihan kuliah. Aku punya kesan kamu lebih nyaman belajar malam, tapi aku belum terlalu yakin soal ini.",
    }));

    assert.match(summary ?? "", /belum terlalu yakin/u);
  });

  it("menolak fakta baru yang tidak mempunyai token pada source terkontrol", () => {
    const context: HarvyContext = {
      summary: null,
      turns: [],
      memories: [{
        id: "garden",
        ownerId: "owner",
        kind: "context",
        content: "Kebun ini hanya proyek yang sedang dibahas",
        createdAt: "2026-08-26T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
      }],
    };

    assert.equal(
      isMemoryPortraitGrounded(
        "Kamu punya rutinitas berkebun yang memulihkan fokus dan suasana hati.",
        context,
      ),
      false,
    );
    assert.equal(
      isMemoryPortraitGrounded(
        "Aku ingat kebun ini hanya proyek yang sedang dibahas.",
        context,
      ),
      true,
    );
  });

  it("fallback menyajikan source exact tanpa menyisipkan inferensi", () => {
    const context: HarvyContext = {
      summary: null,
      turns: [],
      memories: [{
        id: "preference",
        ownerId: "owner",
        kind: "preference",
        content: "Kalau penjelasan teknis panjang, aku sering kehilangan inti",
        createdAt: "2026-08-26T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: null,
      }],
    };
    const fallback = groundedMemoryPortraitFallback(context) ?? "";

    assert.match(fallback, /Kalau penjelasan teknis panjang, aku sering kehilangan inti/u);
    assert.doesNotMatch(fallback, /fokus|mood|rutinitas/iu);
  });

  it("menolak daftar dan metadata internal pada hasil user-facing", () => {
    assert.equal(parseMemoryPortrait(JSON.stringify({
      summary: "• confidence: 0.82\n• status: uncertain",
    })), null);
    assert.equal(parseMemoryPortrait(JSON.stringify({
      summary: "Graph dan sourceMemoryId menunjukkan hubungan tertentu.",
    })), null);
  });

  it("mengenali empty context tanpa mengarang profil", () => {
    assert.equal(hasMemoryPortraitEvidence({
      summary: null,
      turns: [],
      memories: [],
    }), false);
  });

  it("tidak menganggap summary atau episode-only sebagai memori pengguna", () => {
    assert.equal(hasMemoryPortraitEvidence({
      summary: "Sedang membahas audit pada percakapan aktif.",
      turns: [],
      memories: [],
      retrieved: [{
        id: "episode-only",
        sources: ["episode"],
        text: "Temuan pekerjaan saat ini.",
        score: 1,
        validFrom: null,
        validUntil: null,
        status: "active",
        sensitivity: "normal",
        sourceEpisodeIds: ["episode"],
        sourceSequences: [1],
        sourceMemoryIds: [],
      }],
    }), false);
  });
});
