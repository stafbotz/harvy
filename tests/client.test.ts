import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AiClient } from "../src/ai/client.js";
import { ApiKeyPool } from "../src/ai/key-pool.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AiClient", () => {
  it("menolak balasan terpotong alih-alih meneruskan teks setengah jadi", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"intent":"history"' },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () =>
        client.complete({
          model: "model-uji",
          messages: [{ role: "user", content: "halo" }],
        }),
      /terpotong karena batas token/,
    );
  });
});
