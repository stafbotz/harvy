import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveVerifiedModelProfiles } from
  "../src/ai/live-verified-model-profiles.js";

describe("live verified model profiles", () => {
  it("hanya membuka capability MiniMax-M3 pada endpoint GMI resmi exact", () => {
    const [profile] = liveVerifiedModelProfiles(
      "gmi-serving",
      "https://api.gmi-serving.com/v1/",
    );
    assert.ok(profile);
    assert.equal(profile.id, "MiniMaxAI/MiniMax-M3");
    assert.equal(profile.verification, "explicit");
    assert.equal(profile.supports.promptCaching, true);
    assert.equal(profile.supports.imageInput, true);
    assert.equal(profile.continuation.preserveReasoning, false);
    assert.equal(profile.contextWindow, 1_048_576);
  });

  it("menolak gateway, downgrade HTTP, credential URL, dan provider lain", () => {
    for (const [provider, endpoint] of [
      ["openrouter", "https://api.gmi-serving.com/v1"],
      ["gmi-serving", "http://api.gmi-serving.com/v1"],
      ["gmi-serving", "https://api.gmi-serving.com.evil.example/v1"],
      ["gmi-serving", "https://user:pass@api.gmi-serving.com/v1"],
      ["gmi-serving", "https://api.gmi-serving.com/v1?x=1"],
      ["gmi-serving", "https://gateway.example/v1"],
    ] as const) {
      assert.deepEqual(liveVerifiedModelProfiles(provider, endpoint), []);
    }
  });
});
