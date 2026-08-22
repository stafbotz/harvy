import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { understandingInput } from "../src/ai/persona.js";
import { TransientInteractionContextStore } from "../src/core/transient-interaction-context.js";

describe("transient interaction context", () => {
  it("terisolasi menurut owner, channel, dan conversation", () => {
    const store = new TransientInteractionContextStore();
    const scope = {
      ownerId: "owner-a",
      channel: "telegram" as const,
      conversationId: "chat-a",
    };
    store.record(scope, { domain: "usage", operation: "show-summary" });

    assert.equal(store.read(scope)[0]?.domain, "usage");
    assert.deepEqual(store.read({ ...scope, ownerId: "owner-b" }), []);
    assert.deepEqual(store.read({ ...scope, channel: "whatsapp" }), []);
    assert.deepEqual(store.read({ ...scope, conversationId: "chat-b" }), []);
    store.clear(scope);
    assert.deepEqual(store.read(scope), []);
  });

  it("bounded, TTL-scoped, dan hilang saat store baru dibuat", () => {
    let now = new Date("2026-08-22T00:00:00.000Z");
    const scope = {
      ownerId: "owner-a",
      channel: "telegram" as const,
      conversationId: "chat-a",
    };
    const store = new TransientInteractionContextStore({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    store.record(scope, { domain: "menu", operation: "show" });
    store.record(scope, { domain: "memory", operation: "list" });
    store.record(scope, { domain: "usage", operation: "show-summary" });
    assert.deepEqual(store.read(scope).map((item) => item.domain), ["usage", "memory"]);

    now = new Date("2026-08-22T00:00:01.001Z");
    assert.deepEqual(store.read(scope), []);
    assert.deepEqual(new TransientInteractionContextStore().read(scope), []);
  });

  it("hanya membawa metadata surface, tanpa state akun atau raw content", () => {
    const store = new TransientInteractionContextStore();
    const scope = {
      ownerId: "owner-a",
      channel: "telegram" as const,
      conversationId: "chat-a",
    };
    store.record(scope, { domain: "usage", operation: "show-details" });
    const interactions = store.read(scope);
    const serialized = JSON.stringify(interactions);
    assert.doesNotMatch(serialized, /owner-a|chat-a|token|saldo|credential|password/iu);

    const prompt = understandingInput("detailnya", {
      summary: null,
      turns: [],
      memories: [],
      interactions,
    });
    assert.match(prompt, /domain=usage; operation=show-details/u);
    assert.match(prompt, /Baca state terbaru/u);
    assert.doesNotMatch(prompt, /owner-a|chat-a/u);
  });
});
