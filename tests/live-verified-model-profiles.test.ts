import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { liveVerifiedModelProfiles } from
  "../src/ai/live-verified-model-profiles.js";
import { ModelProfileRegistry } from "../src/ai/model-profile.js";

const LIVE_DIGEST =
  "4d4c4f299b84b5a1767c96a54e6591a53c06a90807aba16d78a04fe4967d7d5c";

describe("live verified model profiles", () => {
  it("mengunci exact Gemini 3.5 Flash-Lite profile ke live-smoke digest", () => {
    const profile = new ModelProfileRegistry(liveVerifiedModelProfiles(
      "google-ai-studio",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    )).require("google-ai-studio", "gemini-3.5-flash-lite");

    assert.equal(profile.verification, "explicit");
    assert.equal(profile.reasoning.wireFormat, "openai-reasoning-effort");
    assert.deepEqual(profile.reasoning.supportedEfforts, [
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    assert.equal(profile.supports.temperature, false);
    assert.equal(profile.supports.namedToolChoice, false);
    assert.equal(profile.continuation.preserveReasoning, true);
    assert.equal(profile.contextWindow, 1_048_576);
    assert.equal(profile.maxOutputTokens, 65_536);
    assert.equal(
      createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
      LIVE_DIGEST,
    );
  });

  it("tidak memakai bukti Google untuk gateway atau provider lain", () => {
    assert.deepEqual(liveVerifiedModelProfiles(
      "google-ai-studio",
      "https://gateway.example/v1",
    ), []);
    assert.deepEqual(liveVerifiedModelProfiles(
      "openrouter",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    ), []);
  });
});
