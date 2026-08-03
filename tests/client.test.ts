import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AiClient } from "../src/ai/client.js";
import { ApiKeyPool } from "../src/ai/key-pool.js";
import { compileHarvyContext } from "../src/harness/context-budget.js";
import type {
  LogChannel,
  LogContext,
  OperationalLogger,
} from "../src/observability/operational-logger.js";
import type {
  AiUsageContext,
  TokenUsage,
  UsageObserver,
} from "../src/domain/telemetry.js";

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

  it("mencatat usage provider dan menormalisasi total yang inkonsisten", async () => {
    const before: AiUsageContext[] = [];
    const after: {
      context: AiUsageContext;
      usage: TokenUsage;
      succeeded: boolean;
    }[] = [];
    const observer: UsageObserver = {
      async beforeRequest(context): Promise<void> {
        before.push(context);
      },
      async afterRequest(context, usage, outcome): Promise<void> {
        after.push({ context, usage, succeeded: outcome.succeeded });
      },
    };
    const infoLogs: Array<{
      event: string;
      fields: Record<string, unknown> | undefined;
    }> = [];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "oke" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      usageObserver: observer,
      logger: recordingLogger((event, fields) => {
        infoLogs.push({ event, fields });
      }),
    });

    assert.equal(
      await client.complete({
        model: "model-uji",
        maxTokens: 40,
        messages: [{ role: "user", content: "halo dunia" }],
        usage: {
          ownerId: "student",
          tier: "cheap",
          purpose: "understanding",
          safetyCritical: false,
        },
      }),
      "oke",
    );
    assert.equal(before[0]?.maxTokens, 40);
    assert.ok((before[0]?.inputTokenEstimate ?? 0) > 0);
    assert.equal(after[0]?.usage.totalTokens, 25);
    assert.equal(after[0]?.succeeded, true);
    assert.equal(after[0]?.context, before[0]);
    const completed = infoLogs.find(
      (entry) => entry.event === "ai_request_completed",
    );
    assert.equal(completed?.fields?.["inputTokenEstimate"], 3);
    assert.equal(completed?.fields?.["inputTokens"], 20);
    assert.equal(completed?.fields?.["inputTokenEstimateErrorTokens"], -17);
    assert.equal(
      completed?.fields?.["inputTokenEstimateRatioPermille"],
      150,
    );
    assert.equal(completed?.fields?.["tokenUsageEstimated"], false);
    assert.equal(completed?.fields?.["estimatedTokens"], undefined);
  });

  it("tidak mengirim context manifest lokal ke provider", async () => {
    let body: Record<string, unknown> | null = null;
    const infoLogs: Array<{
      event: string;
      fields: Record<string, unknown> | undefined;
    }> = [];
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      logger: recordingLogger((event, fields) => {
        infoLogs.push({ event, fields });
      }),
    });
    const { manifest } = compileHarvyContext({
      summary: "ringkasan yang tidak boleh terkirim",
      turns: [],
      memories: [],
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      contextManifest: manifest,
      operation: "group-revalidate-ambient",
    });

    assert.ok(body);
    assert.equal(body["contextManifest"], undefined);
    assert.equal(body["operation"], undefined);
    assert.doesNotMatch(JSON.stringify(body), /tidak boleh terkirim/u);
    const completed = infoLogs.find(
      (entry) => entry.event === "ai_request_completed",
    );
    assert.equal(completed?.fields?.["contextManifestVersion"], 1);
    assert.equal(
      completed?.fields?.["operation"],
      "group-revalidate-ambient",
    );
    assert.equal(completed?.fields?.["contextBudgetBasis"], "characters");
    assert.ok((completed?.fields?.["contextEstimatedTokens"] as number) > 0);
    assert.equal(completed?.fields?.["contextSummaryPresent"], undefined);
    assert.equal(completed?.fields?.["inputTokenEstimate"], 1);
    assert.equal(completed?.fields?.["tokenUsageEstimated"], true);
    assert.equal(
      completed?.fields?.["inputTokenEstimateErrorTokens"],
      undefined,
    );
    assert.equal(
      completed?.fields?.["inputTokenEstimateRatioPermille"],
      undefined,
    );
    assert.doesNotMatch(JSON.stringify(completed), /tidak boleh terkirim/u);
  });

  it("tidak memutar kunci ketika kebijakan lokal menolak request", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response("{}", { status: 500 });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
      fallback: testFallback(),
      usageObserver: {
        async beforeRequest(): Promise<void> {
          throw new Error("batas lokal");
        },
        async afterRequest(): Promise<void> {},
      },
    });

    await assert.rejects(
      client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        usage: {
          ownerId: "student",
          tier: "cheap",
          purpose: "understanding",
          safetyCritical: false,
        },
      }),
      /batas lokal/u,
    );
    assert.equal(fetches, 0);
  });

  it("tidak menyentuh fallback ketika provider utama berhasil", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return chatResponse("dari utama");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      "dari utama",
    );
    assert.deepEqual(urls, [
      "https://primary.invalid/v1/chat/completions",
    ]);
  });

  it("beralih langsung pada gangguan jaringan, memakai Bearer, lalu membuka circuit", async () => {
    let now = 0;
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const fallbackUrls: string[] = [];
    const fallbackBodies: Record<string, unknown>[] = [];
    const fallbackHeaders: Record<string, string>[] = [];
    const before: AiUsageContext[] = [];
    const after: {
      context: AiUsageContext;
      succeeded: boolean;
    }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://primary.invalid/")) {
        primaryCalls += 1;
        if (primaryCalls === 1) throw new TypeError("network down");
        return chatResponse("utama pulih");
      }
      fallbackCalls += 1;
      fallbackUrls.push(url);
      fallbackBodies.push(JSON.parse(String(init?.body)));
      fallbackHeaders.push(init?.headers as Record<string, string>);
      assert.equal(init?.redirect, "error");
      return chatResponse("dari fallback");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback({ cooldownMs: 30_000 }),
      now: () => now,
      usageObserver: {
        async beforeRequest(context): Promise<void> {
          before.push(context);
        },
        async afterRequest(context, _usage, outcome): Promise<void> {
          after.push({ context, succeeded: outcome.succeeded });
        },
      },
    });
    const request = {
      model: "model-utama",
      messages: [{ role: "user" as const, content: "halo" }],
      usage: {
        ownerId: "student",
        tier: "cheap" as const,
        purpose: "understanding" as const,
        safetyCritical: false,
      },
    };

    assert.equal(await client.complete(request), "dari fallback");
    assert.equal(primaryCalls, 1, "kunci utama kedua harus dilewati");
    assert.equal(fallbackCalls, 1);
    assert.equal(
      fallbackUrls[0],
      "https://fallback.invalid/api/v3/chat/completions?model=model-fallback",
    );
    assert.ok(!fallbackUrls[0]?.includes("apikey"));
    assert.equal(
      fallbackHeaders[0]?.authorization,
      "Bearer cadangan-rahasia",
    );
    assert.equal(fallbackBodies[0]?.model, "model-fallback");
    assert.deepEqual(
      before.slice(0, 1).map((context) => context.model),
      ["model-utama"],
    );
    assert.deepEqual(
      after.slice(0, 1).map((entry) => entry.succeeded),
      [true],
    );
    assert.equal(after[0]?.context.model, "model-fallback");

    assert.equal(await client.complete(request), "dari fallback");
    assert.equal(primaryCalls, 1, "circuit harus melewati primary");
    assert.equal(fallbackCalls, 2);

    now = 30_001;
    assert.equal(await client.complete(request), "utama pulih");
    assert.equal(primaryCalls, 2, "primary dicoba lagi setelah cooldown");
  });

  it("merotasi kunci utama pada 429 lalu membuka circuit", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      authorizations.push(headers.authorization ?? "");
      if (authorizations.length <= 2) {
        return new Response("{}", { status: 429 });
      }
      return chatResponse("fallback");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      "fallback",
    );
    assert.deepEqual(authorizations, [
      "Bearer utama-1",
      "Bearer utama-2",
      "Bearer cadangan-rahasia",
    ]);

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo lagi" }],
      }),
      "fallback",
    );
    assert.deepEqual(authorizations, [
      "Bearer utama-1",
      "Bearer utama-2",
      "Bearer cadangan-rahasia",
      "Bearer cadangan-rahasia",
    ]);
  });

  it("tidak membuka circuit 429 bila request membatasi rotasi satu kunci", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      authorizations.push(headers.authorization ?? "");
      if (String(input).startsWith("https://fallback.invalid/")) {
        return chatResponse("fallback");
      }
      if (headers.authorization === "Bearer utama-1") {
        return new Response("{}", { status: 429 });
      }
      return chatResponse("primary kedua");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });
    const request = {
      model: "model-utama",
      messages: [{ role: "user" as const, content: "halo" }],
      maxAttempts: 1,
    };

    assert.equal(await client.complete(request), "fallback");
    assert.equal(await client.complete(request), "primary kedua");
    assert.deepEqual(authorizations, [
      "Bearer utama-1",
      "Bearer cadangan-rahasia",
      "Bearer utama-2",
    ]);
  });

  it("menganggap timeout internal sebagai alasan failover", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://primary.invalid/")) {
        primaryCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = (): void => {
            const error = new Error("aborted by request timeout");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      fallbackCalls += 1;
      return chatResponse("fallback setelah timeout");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
        timeoutMs: 5,
      }),
      "fallback setelah timeout",
    );
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it("menganggap 5xx provider-wide dan tidak menghabiskan kunci utama lain", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      authorizations.push(headers.authorization ?? "");
      if (authorizations.length === 1) {
        return new Response("{}", { status: 503 });
      }
      return chatResponse("fallback");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      "fallback",
    );
    assert.deepEqual(authorizations, [
      "Bearer utama-1",
      "Bearer cadangan-rahasia",
    ]);
  });

  it("tidak menyembunyikan 4xx atau keluaran model rusak dengan fallback", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response("{}", { status: 401 });
    };
    const unauthorized = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });
    await assert.rejects(
      unauthorized.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      /401/u,
    );
    assert.equal(fetches, 1);

    fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "setengah" },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const truncated = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });
    await assert.rejects(
      truncated.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      /terpotong/u,
    );
    assert.equal(fetches, 1);
  });

  it("tidak meneruskan request yang dibatalkan lifecycle ke fallback", async () => {
    let fetches = 0;
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async (_input, init) => {
      fetches += 1;
      assert.equal((init?.signal as AbortSignal).aborted, true);
      throw new DOMException("dibatalkan", "AbortError");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });

    await assert.rejects(
      client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
        signal: controller.signal,
      }),
      (error: unknown) =>
        error instanceof Error && error.name === "AbortError",
    );
    assert.equal(fetches, 1);
  });

  it("tidak failover ketika lifecycle dibatalkan saat fetch berlangsung", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://fallback.invalid/")) {
        fallbackCalls += 1;
        return chatResponse("tidak boleh dipakai");
      }
      primaryCalls += 1;
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("dibatalkan", "AbortError")),
          { once: true },
        );
      });
    };
    const lifecycle = new AbortController();
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });

    const completion = client.complete({
      model: "model-utama",
      messages: [{ role: "user", content: "halo" }],
      signal: lifecycle.signal,
    });
    await started;
    lifecycle.abort();

    await assert.rejects(
      completion,
      (error: unknown) =>
        error instanceof Error && error.name === "AbortError",
    );
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 0);
  });

  it("menurunkan JSON mode hanya pada fallback yang menolaknya", async () => {
    const bodies: Record<string, unknown>[] = [];
    let fetches = 0;
    globalThis.fetch = async (input, init) => {
      fetches += 1;
      if (String(input).startsWith("https://primary.invalid/")) {
        throw new TypeError("network down");
      }
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return new Response("{}", { status: 400 });
      }
      return chatResponse("fallback tanpa json mode");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
        json: true,
      }),
      "fallback tanpa json mode",
    );
    assert.equal(fetches, 3);
    assert.deepEqual(bodies[0]?.response_format, {
      type: "json_object",
    });
    assert.equal(bodies[1]?.response_format, undefined);
  });

  it("berhenti setelah fallback ikut gagal", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new TypeError("semua provider gagal");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama-1", "utama-2"]),
      fallback: testFallback(),
    });

    await assert.rejects(
      client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      /semua provider gagal/u,
    );
    assert.equal(fetches, 2);
  });
});

function recordingLogger(
  onInfo: (
    event: string,
    fields: Record<string, unknown> | undefined,
  ) => void,
): OperationalLogger {
  const logger: OperationalLogger = {
    child(): OperationalLogger {
      return logger;
    },
    runWithContext<T>(_context: LogContext, action: () => T): T {
      return action();
    },
    newTraceContext(
      channel: LogChannel,
      operation?: string,
      accountId?: string,
    ): LogContext {
      return {
        traceId: "trace-test",
        channel,
        ...(operation ? { operation } : {}),
        ...(accountId ? { accountId } : {}),
      };
    },
    trace(): void {},
    debug(): void {},
    info(event, _message, fields): void {
      onInfo(event, fields);
    },
    warn(): void {},
    error(): void {},
    fatal(): void {},
  };
  return logger;
}

function testFallback(
  overrides: Partial<NonNullable<
    ConstructorParameters<typeof AiClient>[0]["fallback"]
  >> = {},
) {
  return {
    baseUrl: "https://fallback.invalid/api/v3",
    keys: new ApiKeyPool(["cadangan-rahasia"]),
    model: "model-fallback",
    modelInQuery: true,
    cooldownMs: 30_000,
    ...overrides,
  };
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
