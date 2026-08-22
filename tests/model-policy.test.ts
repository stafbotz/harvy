import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveModel,
  resolveModelRoute,
  selectConversationModelRole,
  selectGlobalRoute,
  selectTier,
  type RoutingAssessment,
} from "../src/ai/model-policy.js";

describe("kebijakan pemilihan model", () => {
  it("memakai tingkatan menengah untuk percakapan keselamatan", () => {
    // Default tetap kompatibel; intelligence role dapat dipilih terpisah tanpa
    // memberi tool atau delegation pada work class safety.
    assert.equal(
      selectTier({ intent: "feeling", messageLength: 12, safetySensitive: true }),
      "efficient",
    );
    assert.equal(
      selectTier({ intent: "smalltalk", messageLength: 8, risk: "bahaya" }),
      "efficient",
    );
    assert.equal(
      selectTier({ intent: "smalltalk", messageLength: 8, risk: "dukungan" }),
      "efficient",
    );
    // Risiko biasa tidak menaikkan apa pun.
    assert.equal(
      selectTier({ intent: "smalltalk", messageLength: 8, risk: "biasa" }),
      "cheap",
    );
  });

  it("memisahkan intelligence safety dari operational authority", () => {
    const input = {
      intent: "feeling" as const,
      messageLength: 32,
      risk: "bahaya" as const,
      safetySensitive: true,
    };
    assert.equal(selectGlobalRoute(input), "conversation");
    assert.equal(
      selectConversationModelRole(input),
      "everyday_conversation",
    );
    assert.equal(
      selectConversationModelRole({
        ...input,
        safetyCognitiveRole: "orchestrator",
      }),
      "orchestrator",
    );
    assert.equal(selectGlobalRoute({
      ...input,
      safetyCognitiveRole: "orchestrator",
    }), "conversation");
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

  it("memisahkan global route dari deep orchestration memakai assessment", () => {
    assert.equal(selectGlobalRoute({
      intent: "smalltalk",
      messageLength: 3,
      assessment: assessment(),
    }), "conversation");
    assert.equal(selectConversationModelRole({
      intent: "smalltalk",
      messageLength: 8,
      assessment: assessment(),
    }), "everyday_conversation");

    assert.equal(selectGlobalRoute({
      intent: "question",
      messageLength: 10,
      deterministicFastPath: true,
      assessment: assessment({ toolNeed: "internal_state" }),
    }), "deterministic");
    assert.equal(selectGlobalRoute({
      intent: "question",
      messageLength: 28,
      specializedFlow: true,
      assessment: assessment({ complexity: "deep", planningRequired: true }),
    }), "specialized");
  });

  it("mengirim request pendek bernuansa ke orkestrator tanpa proxy panjang", () => {
    assert.equal(selectGlobalRoute({
      intent: "feeling",
      messageLength: 52,
      assessment: assessment({
        complexity: "deep",
        ambiguity: "high",
        emotionalNuance: "high",
        factualStakes: "high",
      }),
    }), "orchestrate");
    assert.equal(selectGlobalRoute({
      intent: "question",
      messageLength: 52,
      assessment: assessment({ complexity: "deep", confidence: 0.2 }),
    }), "specialized");
  });

  it("tidak menganggap transformasi mekanis panjang sebagai deep", () => {
    assert.equal(selectGlobalRoute({
      intent: "request",
      messageLength: 2_000,
      needsStepByStep: true,
      assessment: assessment({
        complexity: "mechanical",
        planningRequired: false,
        executionSize: "heavy",
        transformationMechanical: true,
      }),
    }), "conversation");
  });

  it("mengarahkan planning kompleks berdasarkan kebutuhan, bukan kata/model", () => {
    assert.equal(selectGlobalRoute({
      intent: "request",
      messageLength: 80,
      assessment: assessment({
        complexity: "deep",
        planningRequired: true,
        executionSize: "heavy",
      }),
    }), "orchestrate");
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

  it("mengikat cognitive role ke exact model tanpa menjadikannya ladder", () => {
    const routing = {
      mode: "production" as const,
      testingModel: "",
      models: {
        cheap: "model-murah",
        efficient: "model-sehari-hari",
        ambitious: "model-default-dalam",
      },
      roleBindings: {
        challenger: { tier: "efficient" as const, modelId: "model-penantang" },
        verifier: { tier: "cheap" as const, modelId: "model-verifier" },
      },
    };

    assert.deepEqual(resolveModelRoute("challenger", routing), {
      role: "challenger",
      tier: "efficient",
      modelId: "model-penantang",
    });
    assert.deepEqual(resolveModelRoute("verifier", routing), {
      role: "verifier",
      tier: "cheap",
      modelId: "model-verifier",
    });
    assert.equal(resolveModelRoute("heavy_executor", routing).modelId, "model-default-dalam");
  });

  it("membuat fallback tier untuk role tanpa exact binding terlihat eksplisit", () => {
    const route = resolveModelRoute("challenger", {
      mode: "production",
      testingModel: "",
      models: {
        cheap: "model-mechanical",
        efficient: "model-everyday",
        ambitious: "model-compatibility-deep",
      },
    });
    assert.deepEqual(route, {
      role: "challenger",
      tier: "ambitious",
      modelId: "model-compatibility-deep",
    });
  });
});

function assessment(
  overrides: Partial<RoutingAssessment> = {},
): RoutingAssessment {
  return {
    complexity: "normal",
    ambiguity: "low",
    planningRequired: false,
    emotionalNuance: "low",
    executionSize: "small",
    factualStakes: "low",
    transformationMechanical: false,
    toolNeed: "none",
    confidence: 0.95,
    ...overrides,
  };
}
