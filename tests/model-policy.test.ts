import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveModel, selectTier } from "../src/ai/model-policy.js";

describe("kebijakan pemilihan model", () => {
  it("tidak pernah menghemat pada percakapan keselamatan", () => {
    const tier = selectTier({
      intent: "feeling",
      messageLength: 12,
      safetySensitive: true,
    });

    assert.equal(tier, "ambitious");
  });

  it("memakai model termurah untuk mengurai tugas", () => {
    assert.equal(selectTier({ intent: "task", messageLength: 40 }), "cheap");
    assert.equal(selectTier({ intent: "smalltalk", messageLength: 8 }), "cheap");
    assert.equal(selectTier({ intent: "history", messageLength: 40 }), "cheap");
  });

  it("menaikkan tingkatan untuk pertanyaan yang perlu dituntun bertahap", () => {
    const ringan = selectTier({ intent: "question", messageLength: 30 });
    const bertahap = selectTier({
      intent: "question",
      messageLength: 30,
      needsStepByStep: true,
    });

    assert.equal(ringan, "efficient");
    assert.equal(bertahap, "ambitious");
  });

  it("memperlakukan permintaan hasil langsung seperti pertanyaan", () => {
    assert.equal(selectTier({ intent: "request", messageLength: 40 }), "efficient");
    assert.equal(
      selectTier({
        intent: "request",
        messageLength: 40,
        needsStepByStep: true,
      }),
      "ambitious",
    );
  });

  it("menaikkan tingkatan untuk pertanyaan yang panjang", () => {
    const tier = selectTier({ intent: "question", messageLength: 500 });
    assert.equal(tier, "ambitious");
  });

  it("mengarahkan semua tingkatan ke satu model selama mode uji", () => {
    const routing = {
      mode: "testing" as const,
      testingModel: "model-uji",
      models: {
        cheap: "model-murah",
        efficient: "model-efisien",
        ambitious: "model-ambisius",
      },
    };

    assert.equal(resolveModel("cheap", routing), "model-uji");
    assert.equal(resolveModel("ambitious", routing), "model-uji");
  });

  it("memakai tiga model berbeda setelah mode uji dihentikan", () => {
    const routing = {
      mode: "production" as const,
      testingModel: "model-uji",
      models: {
        cheap: "model-murah",
        efficient: "model-efisien",
        ambitious: "model-ambisius",
      },
    };

    assert.equal(resolveModel("cheap", routing), "model-murah");
    assert.equal(resolveModel("efficient", routing), "model-efisien");
    assert.equal(resolveModel("ambitious", routing), "model-ambisius");
  });
});
