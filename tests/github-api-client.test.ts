import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GitHubApiClient,
  GitHubApiError,
} from "../src/github-app/github-api-client.js";

describe("GitHubApiClient boundary", () => {
  it("memutus JSON stream sebelum buffering melewati maxJsonBytes", async () => {
    let cancelled = false;
    const client = new GitHubApiClient({
      maxJsonBytes: 1_024,
      retryCount: 0,
      fetchImplementation: async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(700).fill(65));
            controller.enqueue(new Uint8Array(700).fill(66));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    await assert.rejects(
      () => client.apiJson({
        method: "GET",
        path: "/app",
        authorization: "token-for-test",
      }),
      (error: unknown) => error instanceof GitHubApiError &&
        error.code === "GITHUB_RESPONSE_TOO_LARGE",
    );
    assert.equal(cancelled, true);
  });

  it("memberi setiap call watchdog internal meski caller tidak membawa signal", async () => {
    let calls = 0;
    const client = new GitHubApiClient({
      timeoutMs: 10,
      retryCount: 0,
      fetchImplementation: (async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert.ok(signal);
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => client.apiJson({
        method: "GET",
        path: "/app",
        authorization: "token-for-test",
      }),
      (error: unknown) => error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"),
    );
    assert.equal(calls, 1);
  });
});
