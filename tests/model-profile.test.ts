import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelProfileRegistry,
  resolveModelProfile,
  type ModelProfile,
} from "../src/ai/model-profile.js";

describe("ModelProfileRegistry", () => {
  it("mengikat capability ke provider + model tanpa tebakan nama", () => {
    const registry = new ModelProfileRegistry([
      profile("openrouter", "vendor/model"),
      profile("google-ai-studio", "vendor/model"),
    ]);

    assert.equal(registry.require("openrouter", "vendor/model").provider, "openrouter");
    assert.equal(
      registry.require("google-ai-studio", "vendor/model").provider,
      "google-ai-studio",
    );
    assert.equal(registry.get("openrouter", "vendor/model-plus"), null);
    assert.throws(
      () => registry.require("provider-lain", "vendor/model"),
      /tidak terdaftar/u,
    );
  });

  it("membekukan profile dan menolak duplikat", () => {
    const registry = new ModelProfileRegistry([profile("openrouter", "model-a")]);
    const stored = registry.require("openrouter", "model-a");
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.reasoning.supportedEfforts), true);
    assert.throws(
      () => new ModelProfileRegistry([
        profile("openrouter", "model-a"),
        profile("openrouter", "model-a"),
      ]),
      /duplikat/u,
    );
  });

  it("menolak kombinasi reasoning dan limit yang tidak sah", () => {
    assert.throws(
      () => new ModelProfileRegistry([{
        ...profile("openrouter", "model-a"),
        reasoning: {
          mandatory: true,
          defaultEffort: "none",
          supportedEfforts: ["none"],
          wireFormat: "openrouter-reasoning",
        },
      }]),
      /wajib/u,
    );
    assert.throws(
      () => new ModelProfileRegistry([{
        ...profile("openrouter", "model-a"),
        reasoning: {
          mandatory: false,
          defaultEffort: "low",
          supportedEfforts: ["low"],
          wireFormat: "none",
        },
      }]),
      /tanpa wire/u,
    );
    assert.throws(
      () => new ModelProfileRegistry([{
        ...profile("openrouter", "model-a"),
        contextWindow: Number.NaN,
      }]),
      /context window/u,
    );
  });

  it("resolve memakai model aktif per tier dan gagal tertutup bila registry hilang", () => {
    const registry = new ModelProfileRegistry([
      profile("openrouter", "cheap-model"),
    ]);
    const routing = {
      mode: "production" as const,
      providerId: "openrouter",
      testingModel: "",
      models: {
        cheap: "cheap-model",
        efficient: "efficient-model",
        ambitious: "ambitious-model",
      },
      modelProfiles: registry,
    };
    assert.equal(resolveModelProfile("cheap", routing)?.id, "cheap-model");
    assert.throws(
      () => resolveModelProfile("efficient", routing),
      /tidak terdaftar/u,
    );
  });
});

function profile(provider: string, id: string): ModelProfile {
  return {
    provider,
    id,
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high"],
      wireFormat: provider === "openrouter"
        ? "openrouter-reasoning"
        : "openai-reasoning-effort",
    },
    supports: {
      tools: true,
      toolChoice: true,
      namedToolChoice: true,
      structuredOutput: true,
      temperature: true,
    },
    continuation: {
      preserveReasoning: true,
      preserveAssistantMessage: true,
    },
    contextWindow: null,
    maxOutputTokens: null,
  };
}
