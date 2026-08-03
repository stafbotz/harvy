import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarvyContext } from "../src/ai/context.js";
import {
  compileHarvyContext,
  fitHarvyContext,
  TURNS_ONLY_CONTEXT_PROJECTION,
} from "../src/harness/context-budget.js";
import { contextManifestLogFields } from "../src/harness/context-manifest.js";

describe("context budget harness", () => {
  it("mempertahankan giliran terbaru dan membuang yang lama saat anggaran habis", () => {
    const context: HarvyContext = {
      summary: "ringkasan lama",
      memories: [],
      turns: [
        { role: "user", text: "pertama".repeat(10), at: "2026-01-01" },
        { role: "harvy", text: "kedua".repeat(10), at: "2026-01-02" },
        { role: "user", text: "terbaru".repeat(10), at: "2026-01-03" },
      ],
    };

    const fitted = fitHarvyContext(context, {
      maxCharacters: 100,
      maxSummaryCharacters: 20,
      maxTurnCharacters: 80,
      maxMemoryCharacters: 20,
      maxTurns: 3,
      maxMemories: 0,
    });

    assert.deepEqual(fitted.turns.map((turn) => turn.at), ["2026-01-03"]);
    assert.equal(fitted.summary, "ringkasan lama");
  });

  it("membatasi jumlah dan panjang memori tanpa mengubah objek sumber", () => {
    const context: HarvyContext = {
      summary: null,
      turns: [],
      memories: [memory("satu".repeat(30)), memory("dua"), memory("tiga")],
    };
    const fitted = fitHarvyContext(context, {
      maxCharacters: 1_000,
      maxSummaryCharacters: 20,
      maxTurnCharacters: 20,
      maxMemoryCharacters: 20,
      maxTurns: 0,
      maxMemories: 2,
    });

    assert.equal(fitted.memories.length, 2);
    assert.equal(fitted.memories[0]?.content.length, 20);
    assert.ok(fitted.memories[0]?.content.endsWith("…"));
    assert.ok((context.memories[0]?.content.length ?? 0) > 20);
  });

  it("menerbitkan manifest bebas isi dan memakai sisa anggaran untuk ringkasan", () => {
    const context: HarvyContext = {
      summary: "ringkasan-rahasia-".repeat(4),
      turns: [
        { role: "user", text: "giliran-pertama-rahasia-".repeat(3), at: "1" },
        { role: "harvy", text: "giliran-kedua-rahasia-".repeat(3), at: "2" },
        { role: "user", text: "giliran-terbaru-rahasia-".repeat(3), at: "3" },
      ],
      memories: [
        memory("memori-pertama-rahasia-".repeat(3)),
        memory("memori-kedua-rahasia-".repeat(3)),
      ],
    };
    const budget = {
      maxCharacters: 100,
      maxSummaryCharacters: 20,
      maxTurnCharacters: 30,
      maxMemoryCharacters: 10,
      maxTurns: 2,
      maxMemories: 2,
    };

    const compiled = compileHarvyContext(context, budget);

    assert.deepEqual(compiled.context, fitHarvyContext(context, budget));
    assert.equal(compiled.manifest.version, 1);
    assert.equal(compiled.manifest.budgetBasis, "characters");
    assert.equal(
      compiled.manifest.tokenEstimateMethod,
      "characters_div_4_v1",
    );
    assert.equal(compiled.manifest.sourceTurnCount, 3);
    assert.equal(compiled.manifest.includedTurnCount, 2);
    assert.equal(compiled.manifest.clippedTurnCount, 2);
    assert.equal(compiled.manifest.droppedTurnCount, 1);
    assert.equal(compiled.manifest.sourceMemoryCount, 2);
    assert.equal(compiled.manifest.includedMemoryCount, 0);
    assert.equal(compiled.manifest.droppedMemoryCount, 2);
    assert.equal(compiled.manifest.summaryPresent, true);
    assert.equal(compiled.manifest.summaryIncluded, true);
    assert.equal(compiled.manifest.summaryClipped, true);
    assert.equal(compiled.context.summary?.length, 8);
    assert.equal(compiled.manifest.includedCharacters, 100);
    assert.equal(compiled.manifest.estimatedTokens, 25);
    assert.equal(compiled.manifest.utilizationPercent, 100);

    const serialized = JSON.stringify({
      manifest: compiled.manifest,
      log: contextManifestLogFields(compiled.manifest),
    });
    for (const forbidden of ["ringkasan-rahasia", "giliran-", "memori-"]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden));
    }
  });

  it("membedakan data sumber dari bagian yang layak masuk route turns-only", () => {
    const context: HarvyContext = {
      summary: "ringkasan lama",
      turns: [{ role: "user", text: "yang tadi", at: "1" }],
      memories: [memory("kelas sebelas")],
    };

    const compiled = compileHarvyContext(
      context,
      undefined,
      TURNS_ONLY_CONTEXT_PROJECTION,
    );

    assert.equal(compiled.context.summary, null);
    assert.equal(compiled.context.memories.length, 0);
    assert.equal(compiled.context.turns.length, 1);
    assert.equal(compiled.manifest.summaryPresent, true);
    assert.equal(compiled.manifest.summaryEligible, false);
    assert.equal(compiled.manifest.sourceMemoryCount, 1);
    assert.equal(compiled.manifest.eligibleMemoryCount, 0);
    assert.equal(compiled.manifest.includedMemoryCount, 0);
  });
});

function memory(content: string): HarvyContext["memories"][number] {
  return {
    id: content,
    ownerId: "owner",
    kind: "preference",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}
