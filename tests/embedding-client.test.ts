import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiCompatibleEmbeddingProvider } from "../src/ai/embedding-client.js";
import { ApiKeyPool } from "../src/ai/key-pool.js";

describe("OpenAiCompatibleEmbeddingProvider", () => {
  it("mengirim batch bounded dan mengurutkan vector berdasarkan index", async () => {
    let request: RequestInit | undefined;
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://example.test/api/v1/",
      keys: new ApiKeyPool(["secret-test"]),
      model: "embedding-test",
      providerId: "openrouter",
      fetcher: async (input, init) => {
        assert.equal(input, "https://example.test/api/v1/embeddings");
        request = init;
        return new Response(JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }));
      },
    });

    assert.deepEqual(await provider.embed(["query", "document"]), [
      [1, 0],
      [0, 1],
    ]);
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: "embedding-test",
      input: ["query", "document"],
      provider: { data_collection: "deny" },
    });
    assert.equal(
      (request?.headers as Record<string, string>).authorization,
      "Bearer secret-test",
    );
  });

  it("gagal tertutup pada status provider dan payload vector tidak sah", async () => {
    const failed = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://example.test/v1",
      keys: new ApiKeyPool(["secret-test"]),
      model: "embedding-test",
      providerId: "google-ai-studio",
      fetcher: async () => new Response("rate limited", { status: 429 }),
    });
    await assert.rejects(failed.embed(["query"]), /status 429/u);

    const malformed = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://example.test/v1",
      keys: new ApiKeyPool(["secret-test"]),
      model: "embedding-test",
      providerId: "google-ai-studio",
      fetcher: async () => new Response(JSON.stringify({
        data: [{ index: 0, embedding: [Number.NaN] }],
      })),
    });
    await assert.rejects(malformed.embed(["query"]), /Item embedding/u);
  });

  it("menghentikan stream embedding ketika byte response melewati hard cap", async () => {
    let cancelled = false;
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: "https://example.test/v1",
      keys: new ApiKeyPool(["secret-test"]),
      model: "embedding-test",
      providerId: "google-ai-studio",
      maxResponseBytes: 1_024,
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(700).fill(65));
          controller.enqueue(new Uint8Array(700).fill(66));
        },
        cancel() {
          cancelled = true;
        },
      })),
    });

    await assert.rejects(provider.embed(["query"]), /melewati batas/u);
    assert.equal(cancelled, true);
  });
});
