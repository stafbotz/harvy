import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasMemoryPortraitEvidence,
  memoryPortraitInput,
  parseMemoryPortrait,
} from "../src/ai/memory-portrait.js";
import type { HarvyContext } from "../src/ai/context.js";

describe("potret memori", () => {
  it("membawa context pack bounded tanpa raw turn atau ID internal", () => {
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
    assert.match(input, /uncertain/u);
    assert.match(input, /Dulu sempat mempertimbangkan UI/u);
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
});
