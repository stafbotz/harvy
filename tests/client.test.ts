import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  AiClient,
  AiError,
  ByokProviderError,
  AiResponseError,
  type ChatFunctionTool,
  type ChatToolCall,
} from "../src/ai/client.js";
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
import {
  ModelProfileRegistry,
  type ModelProfile,
} from "../src/ai/model-profile.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";
import {
  RunBudgetAccount,
  RunBudgetExceededError,
  type RunBudget,
} from "../src/core/run-budget.js";

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
      (error: unknown) =>
        error instanceof AiResponseError &&
        error.reason === "truncated" &&
        error.finishReason === "length" &&
        /terpotong karena batas token/u.test(error.message),
    );
  });

  it("tetap menghitung usage respons terpotong ke RunBudget", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: "setengah" },
            finish_reason: "length",
          }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const budget = clientRunBudget();
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /terpotong/u,
    );
    assert.equal(budget.checkpoint().consumedTokens, 12);
    assert.equal(budget.checkpoint().modelCalls, 1);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 0);
  });

  it("menahan reservation penuh untuk respons terpotong tanpa usage", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: "x" },
            finish_reason: "length",
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const budget = clientRunBudget();
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /terpotong/u,
    );
    assert.equal(budget.checkpoint().consumedTokens, 101);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("mempertahankan reported cost pada truncation tanpa token counts", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: "x" },
            finish_reason: "length",
          }],
          usage: { cost: "2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const budget = clientRunBudget({ maxCostUsd: 1 });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /terpotong/u,
    );
    assert.equal(
      budget.checkpoint().consumedCostUsdNanos,
      "2000000000",
    );
    assert.equal(budget.overageReason(), "budget_cost");
  });

  it("menahan reservation penuh untuk usage provider yang tidak aman", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: "selesai" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: Number.MAX_SAFE_INTEGER,
            completion_tokens: 1,
            total_tokens: Number.MAX_SAFE_INTEGER,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const budget = clientRunBudget();
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /Usage token provider tidak sah/u,
    );
    assert.equal(budget.checkpoint().consumedTokens, 101);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("menahan reservation penuh untuk respons 2xx tanpa usage yang malformed", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: { content: null },
            finish_reason: "stop",
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const budget = clientRunBudget();
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /Balasan model kosong/u,
    );
    assert.equal(budget.checkpoint().consumedTokens, 101);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("memutus body provider yang melewati hard cap sebelum dibuffer penuh", async () => {
    let cancelled = false;
    globalThis.fetch = async () => new Response(
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
    );
    const budget = clientRunBudget();
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      maxResponseBytes: 1_024,
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      (error: unknown) => error instanceof AiError &&
        /melewati batas ukuran aman/u.test(error.message),
    );
    assert.equal(cancelled, true);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("menghentikan retry ketika attempt unknown menghabiskan model-call budget", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new TypeError("network down");
    };
    const budget = clientRunBudget({ maxModelCalls: 1 });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_model_calls",
    );
    assert.equal(fetches, 1);
    assert.equal(budget.checkpoint().modelCalls, 1);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("melepaskan reservation token HTTP error tetapi tetap menghitung attempt", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return fetches === 1
        ? new Response("{}", { status: 429 })
        : chatResponse("selesai");
    };
    const budget = clientRunBudget({
      maxTotalTokens: 110,
      maxModelCalls: 2,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    assert.equal(await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 100,
      execution: clientExecution(100),
      runBudget: budget,
    }), "selesai");
    assert.equal(fetches, 2);
    assert.equal(budget.checkpoint().modelCalls, 2);
    assert.equal(budget.checkpoint().consumedTokens, 6);
  });

  it("menahan reservation penuh untuk HTTP 5xx yang usage-nya tidak diketahui", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    const budget = clientRunBudget({
      maxTotalTokens: 110,
      maxModelCalls: 1,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: budget,
      }),
      /503/u,
    );
    assert.equal(budget.checkpoint().consumedTokens, 101);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("menghitung HTTP 408 sebagai unknown lalu retry dalam budget yang sama", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return fetches === 1
        ? new Response("{}", { status: 408 })
        : chatResponse("selesai");
    };
    const budget = clientRunBudget({
      maxTotalTokens: 250,
      maxModelCalls: 2,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    assert.equal(await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 100,
      execution: clientExecution(100),
      runBudget: budget,
    }), "selesai");
    assert.equal(fetches, 2);
    assert.equal(budget.checkpoint().consumedTokens, 107);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("memakai satu RunBudget untuk attempt primary dan fallback", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).startsWith("https://primary.invalid/")) {
        primaryCalls += 1;
        return new Response("{}", { status: 503 });
      }
      fallbackCalls += 1;
      return chatResponse("fallback selesai");
    };
    const budget = clientRunBudget({
      maxTotalTokens: 250,
      maxModelCalls: 2,
    });
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback(),
    });

    assert.equal(await client.complete({
      model: "model-utama",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 100,
      execution: clientExecution(100),
      runBudget: budget,
    }), "fallback selesai");
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);
    assert.equal(budget.checkpoint().modelCalls, 2);
    assert.equal(budget.checkpoint().consumedTokens, 107);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("tidak diam-diam fallback ke Harvy saat provider BYOK gagal", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).startsWith("https://owned.invalid/")) {
        primaryCalls += 1;
        return new Response("{}", { status: 503 });
      }
      fallbackCalls += 1;
      return chatResponse("fallback tidak boleh dipakai");
    };
    const usage: AiUsageContext = {
      requestId: "request-byok-client",
      turnId: "turn-byok-client",
      ownerId: "owner-uji",
      tier: "ambitious",
      purpose: "reply",
      model: "model-harvy",
      maxTokens: 80,
      inputTokenEstimate: 10,
      safetyCritical: false,
    };
    const observer: UsageObserver = {
      beforeRequest: async () => ({
        reservationId: "reservation-byok-client",
        source: "byok",
        providerCredentialRef: "credential-byok-client",
      }),
      afterRequest: async () => undefined,
    };
    const client = new AiClient({
      baseUrl: "https://harvy.invalid/v1",
      keys: new ApiKeyPool(["harvy-key"]),
      fallback: {
        baseUrl: "https://fallback.invalid/v1",
        keys: new ApiKeyPool(["fallback-key"]),
        model: "fallback-model",
      },
      usageObserver: observer,
      fundingCredentialResolver: async () => ({
        credentialRef: "credential-byok-client",
        providerId: "owned-provider",
        baseUrl: "https://owned.invalid/v1",
        modelId: "owned-model",
        apiKey: "owned-key",
      }),
    });
    await assert.rejects(
      () => client.complete({
        model: "model-harvy",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 80,
        usage,
      }),
      (error: unknown) => error instanceof ByokProviderError,
    );
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 0);
  });

  it("penolakan budget lokal tidak memutar API key", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      authorizations.push(headers.authorization ?? "");
      return chatResponse("selesai");
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });
    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100),
        runBudget: clientRunBudget({ maxTotalTokens: 100 }),
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );

    assert.equal(await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    }), "selesai");
    assert.deepEqual(authorizations, ["Bearer satu"]);
  });

  it("meneruskan kelas budget execution agar reserve final tetap tersedia", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return chatResponse("selesai");
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });
    const budget = clientRunBudget({ maxTotalTokens: 90 });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 60,
        execution: clientExecution(60, "planner"),
        runBudget: budget,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
    assert.equal(fetches, 0);

    assert.equal(await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 60,
      execution: clientExecution(60, "synthesizer"),
      runBudget: budget,
    }), "selesai");
    assert.equal(fetches, 1);
  });

  it("mengirim native tools dan membaca tool_calls tanpa mode JSON", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return nativeToolResponse("harvy_final_v1", { reply: "Selesai." });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    const calls = await client.completeToolCalls({
      model: "model-uji",
      messages: [{ role: "user", content: "selesaikan" }],
      tools: TEST_NATIVE_TOOLS,
      validateToolCalls: (received) => received.length === 1,
    });

    assert.deepEqual(calls, [{
      id: "call-uji",
      type: "function",
      function: {
        name: "harvy_final_v1",
        arguments: '{"reply":"Selesai."}',
      },
    }]);
    assert.ok(body);
    assert.deepEqual(body["tools"], TEST_NATIVE_TOOLS);
    assert.equal(body["tool_choice"], "required");
    assert.equal(body["parallel_tool_calls"], false);
    assert.equal(body["response_format"], undefined);
    assert.equal(body["validateToolCalls"], undefined);
  });

  it("mempertahankan thought signature pada transcript native tool-result", async () => {
    const bodies: Record<string, unknown>[] = [];
    const infoLogs: Record<string, unknown>[] = [];
    const signature = "SIGNATURE_CANARY_NATIVE_123";
    let call = 0;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      return call === 1
        ? nativeToolResponse(
            "harvy_final_v1",
            { reply: "baca" },
            { google: { thought_signature: signature } },
          )
        : nativeToolResponse("harvy_final_v1", { reply: "selesai" });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      logger: recordingLogger((_event, fields) => infoLogs.push(fields ?? {})),
    });

    const first = await client.completeToolCalls(nativeToolRequest());
    assert.deepEqual(first[0]?.extra_content, {
      google: { thought_signature: signature },
    });
    await client.completeToolCalls({
      ...nativeToolRequest(),
      messages: [
        { role: "user", content: "selesaikan" },
        { role: "assistant", content: null, tool_calls: first },
        {
          role: "tool",
          tool_call_id: first[0]!.id,
          name: first[0]!.function.name,
          content: '{"status":"ok"}',
        },
      ],
    });

    const sentMessages = bodies[1]?.["messages"] as unknown[];
    assert.deepEqual(sentMessages, [
      { role: "user", content: "selesaikan" },
      { role: "assistant", content: null, tool_calls: first },
      {
        role: "tool",
        tool_call_id: first[0]!.id,
        name: first[0]!.function.name,
        content: '{"status":"ok"}',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(infoLogs), /SIGNATURE_CANARY_NATIVE_123/u);
  });

  it("mempertahankan reasoning_details OpenRouter pada assistant turn utuh", async () => {
    const bodies: Record<string, unknown>[] = [];
    const infoLogs: Record<string, unknown>[] = [];
    const reasoningDetails = [{
      type: "reasoning.encrypted",
      data: "REASONING_DETAILS_CANARY_456",
      index: 0,
    }];
    let call = 0;
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      return call === 1
        ? nativeToolResponse(
            "harvy_final_v1",
            { reply: "baca" },
            undefined,
            {
              reasoning: "RAW_REASONING_CANARY_789",
              reasoning_details: reasoningDetails,
            },
          )
        : nativeToolResponse("harvy_final_v1", { reply: "selesai" });
    };
    const registry = modelProfiles("openrouter", "openrouter-reasoning");
    const execution = new ExecutionPolicy().decide({
      tier: "ambitious",
      role: "planner",
      workClass: "agent",
      profile: registry.require("openrouter", "model-uji"),
      maxOutputTokens: 4_096,
      deadlineMs: 45_000,
      maxSteps: 6,
      allowTools: true,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "openrouter",
      modelProfiles: registry,
      logger: recordingLogger((_event, fields) => infoLogs.push(fields ?? {})),
    });

    const first = await client.completeToolTurn({
      ...nativeToolRequest(),
      maxTokens: 4_096,
      execution,
    });
    assert.deepEqual(first.continuation?.reasoningDetails, reasoningDetails);
    assert.equal(first.continuation?.providerId, "openrouter");
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.continuation?.reasoningDetails), true);

    await client.completeToolTurn({
      ...nativeToolRequest(),
      maxTokens: 4_096,
      execution,
      messages: [
        { role: "user", content: "selesaikan" },
        first,
        {
          role: "tool",
          tool_call_id: first.tool_calls[0]!.id,
          content: '{"status":"ok"}',
        },
      ],
    });

    assert.deepEqual(bodies[0]?.["reasoning"], {
      effort: "medium",
      exclude: false,
    });
    const replay = (bodies[1]?.["messages"] as Record<string, unknown>[])[1];
    assert.deepEqual(replay?.["reasoning_details"], reasoningDetails);
    assert.equal(replay?.["reasoning"], "RAW_REASONING_CANARY_789");
    assert.doesNotMatch(
      JSON.stringify(infoLogs),
      /(?:REASONING_DETAILS|RAW_REASONING)_CANARY/u,
    );
  });

  it("menyerialisasi effort OpenAI-compatible tanpa field OpenRouter", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return chatResponse("selesai");
    };
    const registry = modelProfiles(
      "gmi-serving",
      "openai-reasoning-effort",
    );
    const execution = new ExecutionPolicy().decide({
      tier: "cheap",
      role: "classifier",
      workClass: "mechanical",
      profile: registry.require("gmi-serving", "model-uji"),
      maxOutputTokens: 128,
      deadlineMs: 2_000,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "gmi-serving",
      modelProfiles: registry,
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "klasifikasikan" }],
      temperature: 0,
      maxTokens: 128,
      timeoutMs: 2_000,
      execution,
    });
    assert.ok(body);
    assert.equal(body["reasoning_effort"], "low");
    assert.equal(body["reasoning"], undefined);
    assert.equal(body["temperature"], 0);
  });

  it("menghilangkan tool_choice untuk profile DeepSeek yang tidak mendukungnya", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return nativeToolResponse("harvy_final_v1", { reply: "selesai" });
    };
    const registry = new ModelProfileRegistry([{
      provider: "deepseek",
      id: "model-uji",
      verification: "explicit",
      reasoning: {
        mandatory: false,
        defaultEffort: "high",
        supportedEfforts: ["high", "max"],
        wireFormat: "deepseek-thinking",
      },
      supports: {
        tools: true,
        toolChoice: false,
        namedToolChoice: false,
        structuredOutput: true,
        temperature: false,
        promptCaching: false,
        imageInput: false,
      },
      continuation: {
        preserveReasoning: true,
        preserveAssistantMessage: true,
      },
      contextWindow: null,
      maxOutputTokens: null,
    }]);
    const execution = new ExecutionPolicy().decide({
      tier: "ambitious",
      role: "recovery",
      workClass: "agent",
      profile: registry.require("deepseek", "model-uji"),
      maxOutputTokens: 4_096,
      deadlineMs: 30_000,
      allowTools: true,
      allowEscalation: true,
      escalationReason: "validator_failed",
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "deepseek",
      modelProfiles: registry,
    });

    await client.completeToolTurn({
      ...nativeToolRequest(),
      maxTokens: 4_096,
      execution,
    });
    assert.ok(body);
    assert.equal(body["tool_choice"], undefined);
    assert.equal(body["parallel_tool_calls"], undefined);
    assert.equal(body["temperature"], undefined);
    assert.equal(body["reasoning_effort"], "high");
    assert.deepEqual(body["thinking"], { type: "enabled" });
  });

  it("menolak continuation lintas provider sebelum network", async () => {
    let fetches = 0;
    let attemptStarts = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return nativeToolResponse("harvy_final_v1", { reply: "tidak boleh" });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "provider-a",
      attemptObserver: {
        startAttempt: async () => {
          attemptStarts += 1;
        },
        finishAttempt: async () => undefined,
      },
    });
    await assert.rejects(
      () => client.completeToolTurn({
        ...nativeToolRequest(),
        messages: [
          { role: "user", content: "lanjut" },
          {
            role: "assistant",
            content: null,
            tool_calls: [nativeDecisionToolCall()],
            continuation: {
              providerId: "openrouter",
              modelId: "model-uji",
              reasoningDetails: [{ type: "reasoning.encrypted", data: "x" }],
            },
          },
          {
            role: "tool",
            tool_call_id: "call-uji",
            content: "{}",
          },
        ],
        usage: {
          ownerId: "pemilik-uji",
          tier: "cheap",
          purpose: "reply",
          safetyCritical: false,
        },
      }),
      /terikat provider\/model lain/u,
    );
    assert.equal(fetches, 0);
    assert.equal(attemptStarts, 0);
  });

  it("menolak reasoning continuation yang belum di-opt-in profile", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return nativeToolResponse(
        "harvy_final_v1",
        { reply: "belum boleh" },
        undefined,
        { reasoning: "opaque-but-unverified" },
      );
    };
    const explicit = modelProfiles(
      "openrouter",
      "openrouter-reasoning",
    ).require("openrouter", "model-uji");
    const compatibility = new ModelProfileRegistry([{
      ...explicit,
      verification: "compatibility",
      reasoning: {
        mandatory: false,
        defaultEffort: "none",
        supportedEfforts: [],
        wireFormat: "none",
      },
      continuation: {
        preserveReasoning: false,
        preserveAssistantMessage: true,
      },
    }]);
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "openrouter",
      modelProfiles: compatibility,
    });

    await assert.rejects(
      () => client.completeToolTurn(nativeToolRequest()),
      /tidak mengizinkan reasoning continuation provider/u,
    );
    assert.equal(fetches, 1);
  });

  it("menegakkan capability explicit walau caller legacy tanpa execution plan", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return chatResponse("tidak boleh tercapai");
    };
    const base = modelProfiles(
      "gmi-serving",
      "openai-reasoning-effort",
    ).require("gmi-serving", "model-uji");
    const noTools = new ModelProfileRegistry([{
      ...base,
      supports: {
        tools: false,
        toolChoice: false,
        namedToolChoice: false,
        structuredOutput: false,
        temperature: true,
        promptCaching: false,
        imageInput: false,
      },
      contextWindow: 1,
      maxOutputTokens: 1,
    }]);
    const toolClient = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "gmi-serving",
      modelProfiles: noTools,
    });
    await assert.rejects(
      () => toolClient.completeToolTurn(nativeToolRequest()),
      /tidak mendukung native tool/u,
    );

    const tinyOutput = new ModelProfileRegistry([{
      ...base,
      contextWindow: null,
      maxOutputTokens: 1,
    }]);
    const textClient = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      providerId: "gmi-serving",
      modelProfiles: tinyOutput,
    });
    await assert.rejects(
      () => textClient.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 2,
      }),
      /melampaui output ceiling/u,
    );
    assert.equal(fetches, 0);
  });

  it("menolak model asing saat registry aktif sebelum key dan attempt dipakai", async () => {
    let fetches = 0;
    let keyTakes = 0;
    let attemptStarts = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return chatResponse("tidak boleh tercapai");
    };
    const keys = new ApiKeyPool(["kunci-uji"]);
    const take = keys.take.bind(keys);
    keys.take = () => {
      keyTakes += 1;
      return take();
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys,
      providerId: "gmi-serving",
      modelProfiles: modelProfiles(
        "gmi-serving",
        "openai-reasoning-effort",
      ),
      attemptObserver: {
        startAttempt: async () => {
          attemptStarts += 1;
        },
        finishAttempt: async () => undefined,
      },
    });

    await assert.rejects(
      () => client.complete({
        model: "model-asing",
        messages: [{ role: "user", content: "halo" }],
      }),
      /Profile model tidak terdaftar/u,
    );
    assert.equal(fetches, 0);
    assert.equal(keyTakes, 0);
    assert.equal(attemptStarts, 0);
  });

  it("menolak terminal content_filter sebagai final sukses", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "teks parsial" },
        finish_reason: "content_filter",
      }],
    }), { status: 200 });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });
    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      }),
      /tidak lengkap atau ditolak/u,
    );
  });

  it("menolak finish_reason yang hilang sebagai final sukses", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "teks tanpa terminal" } }],
    }), { status: 200 });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });
    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      }),
      /finish_reason=missing/u,
    );
  });

  it("mencoba kunci berikutnya ketika respons 2xx kehilangan finish_reason", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(
        String((init?.headers as Record<string, string>).authorization),
      );
      return authorizations.length === 1
        ? new Response(JSON.stringify({
            choices: [{ message: { content: "teks tanpa terminal" } }],
          }), { status: 200 })
        : chatResponse("respons terminal");
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    assert.equal(
      await client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      }),
      "respons terminal",
    );
    assert.deepEqual(authorizations, ["Bearer satu", "Bearer dua"]);
  });

  it("memberi satu recovery bounded setelah semua kunci kehilangan finish_reason", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(
        String((init?.headers as Record<string, string>).authorization),
      );
      return authorizations.length < 3
        ? new Response(JSON.stringify({
            choices: [{ message: { content: "teks tanpa terminal" } }],
          }), { status: 200 })
        : chatResponse("pulih pada recovery bounded");
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    assert.equal(
      await client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      }),
      "pulih pada recovery bounded",
    );
    assert.deepEqual(authorizations, [
      "Bearer satu",
      "Bearer dua",
      "Bearer satu",
    ]);
  });

  it("menghormati maxAttempts eksplisit pada finish_reason yang hilang", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "teks tanpa terminal" } }],
      }), { status: 200 });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxAttempts: 1,
      }),
      /finish_reason=missing/u,
    );
    assert.equal(fetches, 1);
  });

  it("tidak merotasi kunci untuk content_filter", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: { content: "teks parsial" },
          finish_reason: "content_filter",
        }],
      }), { status: 200 });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["satu", "dua"]),
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      }),
      /tidak lengkap atau ditolak/u,
    );
    assert.equal(fetches, 1);
  });

  it("menolak tool call yang mengaku finish_reason stop", async () => {
    globalThis.fetch = async () => {
      const response = await nativeToolResponse(
        "harvy_final_v1",
        { reply: "belum sah" },
      );
      const payload = await response.json() as {
        choices: { finish_reason: string }[];
      };
      payload.choices[0]!.finish_reason = "stop";
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });
    await assert.rejects(
      () => client.completeToolTurn(nativeToolRequest()),
      /tidak mempunyai finish_reason=tool_calls/u,
    );
  });

  it("tidak memutar API key untuk request execution yang ditolak lokal", async () => {
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(String((init?.headers as Record<string, string>).authorization));
      return chatResponse("selesai");
    };
    const registry = modelProfiles(
      "gmi-serving",
      "openai-reasoning-effort",
    );
    const execution = new ExecutionPolicy().decide({
      tier: "cheap",
      role: "classifier",
      workClass: "mechanical",
      profile: registry.require("gmi-serving", "model-uji"),
      maxOutputTokens: 128,
      deadlineMs: 2_000,
    });
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-1", "kunci-2"]),
      providerId: "gmi-serving",
      modelProfiles: registry,
    });

    await assert.rejects(
      () => client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "invalid" }],
        maxTokens: 256,
        timeoutMs: 2_000,
        execution,
      }),
      /tidak cocok dengan execution plan/u,
    );
    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "valid" }],
      maxTokens: 128,
      timeoutMs: 2_000,
      execution,
    });
    assert.deepEqual(authorizations, ["Bearer kunci-1"]);
  });

  it("menolak thought signature native yang kosong", async () => {
    globalThis.fetch = async () =>
      nativeToolResponse(
        "harvy_final_v1",
        { reply: "selesai" },
        { google: { thought_signature: "" } },
      );
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.completeToolCalls(nativeToolRequest()),
      /Thought signature native tool call tidak sah/u,
    );
  });

  it("menolak plain text dan nama tool response di luar registry", async () => {
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });
    globalThis.fetch = async () => chatResponse("teks biasa");
    await assert.rejects(
      () => client.completeToolCalls(nativeToolRequest()),
      /tidak menghasilkan native tool call/u,
    );

    globalThis.fetch = async () => nativeToolResponse("harvy_unknown_v1", {});
    await assert.rejects(
      () => client.completeToolCalls(nativeToolRequest()),
      /tool yang tidak tersedia/u,
    );
  });

  it("memvalidasi definisi native tool sebelum menyentuh provider", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return nativeToolResponse("harvy_final_v1", { reply: "Selesai." });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
    });

    await assert.rejects(
      () => client.completeToolCalls({
        ...nativeToolRequest(),
        tools: [{
          type: "function",
          function: {
            name: "nama.berdot",
            description: "Tidak sah.",
            parameters: { type: "object" },
          },
        }],
      }),
      /Definisi native tool tidak sah/u,
    );
    assert.equal(fetchCalls, 0);
  });

  it("tidak mengalihkan native tool request ke fallback yang belum diverifikasi", async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      if (String(input).startsWith("https://fallback.invalid/")) {
        return nativeToolResponse("harvy_final_v1", { reply: "fallback" });
      }
      return new Response("provider down", { status: 503 });
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      fallback: testFallback(),
    });

    await assert.rejects(
      () => client.completeToolCalls(nativeToolRequest()),
      /503/u,
    );
    assert.equal(urls.length, 1);
    assert.equal(
      urls.some((url) => url.startsWith("https://fallback.invalid/")),
      false,
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
    assert.doesNotMatch(JSON.stringify(body), /kunci-uji/u);
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
    assert.doesNotMatch(
      JSON.stringify(fallbackBodies[0]),
      /(?:utama-[12]|cadangan-rahasia)/u,
    );
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

  it("timeout turn-boundary tidak membuka circuit untuk classifier lanjutan", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://primary.invalid/")) {
        primaryCalls += 1;
        if (primaryCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const rejectAbort = (): void => {
              const error = new Error("aborted by turn-boundary timeout");
              error.name = "AbortError";
              reject(error);
            };
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        }
        return chatResponse(`primary-${primaryCalls}`);
      }
      fallbackCalls += 1;
      return chatResponse("fallback");
    };
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback({ cooldownMs: 30_000 }),
    });
    const usage = (purpose: AiUsageContext["purpose"]): AiUsageContext => ({
      ownerId: "telegram:group-1",
      tier: "cheap",
      purpose,
      safetyCritical: purpose === "risk-triage",
      requestId: `request-${purpose}`,
      turnId: null,
      model: "model-utama",
      maxTokens: 100,
      inputTokenEstimate: 10,
    });

    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "boundary" }],
        timeoutMs: 5,
        maxAttempts: 1,
        usage: usage("turn-boundary"),
      }),
      "fallback",
    );
    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "understanding" }],
        usage: usage("understanding"),
      }),
      "primary-2",
    );
    assert.equal(
      await client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "risk triage" }],
        usage: usage("risk-triage"),
      }),
      "primary-3",
    );
    assert.equal(primaryCalls, 3);
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

  it("menolak capability explicit fallback alih-alih menurunkan reasoning diam-diam", async () => {
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new TypeError("primary network down");
    };
    const fallbackProfiles = new ModelProfileRegistry([
      {
        provider: "primary",
        id: "model-utama",
        verification: "compatibility",
        reasoning: {
          mandatory: false,
          defaultEffort: "none",
          supportedEfforts: [],
          wireFormat: "none",
        },
        supports: {
          tools: true,
          toolChoice: true,
          namedToolChoice: true,
          structuredOutput: true,
          temperature: true,
          promptCaching: false,
          imageInput: false,
        },
        continuation: {
          preserveReasoning: false,
          preserveAssistantMessage: true,
        },
        contextWindow: null,
        maxOutputTokens: null,
      },
      {
        provider: "deepseek",
        id: "model-fallback",
        verification: "explicit",
        reasoning: {
          mandatory: true,
          defaultEffort: "high",
          supportedEfforts: ["high", "max"],
          wireFormat: "deepseek-thinking",
        },
        supports: {
          tools: true,
          toolChoice: false,
          namedToolChoice: false,
          structuredOutput: true,
          temperature: false,
          promptCaching: false,
          imageInput: false,
        },
        continuation: {
          preserveReasoning: true,
          preserveAssistantMessage: true,
        },
        contextWindow: null,
        maxOutputTokens: null,
      },
    ]);
    const client = new AiClient({
      baseUrl: "https://primary.invalid/v1",
      keys: new ApiKeyPool(["utama"]),
      fallback: testFallback({ providerId: "deepseek" }),
      modelProfiles: fallbackProfiles,
    });

    await assert.rejects(
      () => client.complete({
        model: "model-utama",
        messages: [{ role: "user", content: "halo" }],
      }),
      /Capability explicit provider fallback belum didukung/u,
    );
    assert.equal(fetches, 1);
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

const TEST_NATIVE_TOOLS = [{
  type: "function",
  function: {
    name: "harvy_final_v1",
    description: "Berikan jawaban final.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { reply: { type: "string" } },
      required: ["reply"],
    },
  },
}] satisfies readonly ChatFunctionTool[];

function nativeToolRequest(): Parameters<AiClient["completeToolCalls"]>[0] {
  return {
    model: "model-uji",
    messages: [{ role: "user", content: "selesaikan" }],
    tools: TEST_NATIVE_TOOLS,
  };
}

function nativeToolResponse(
  name: string,
  input: Record<string, unknown>,
  extraContent?: NonNullable<ChatToolCall["extra_content"]>,
  assistantFields: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: null,
          ...assistantFields,
          tool_calls: [{
            id: "call-uji",
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
            ...(extraContent ? { extra_content: extraContent } : {}),
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function nativeDecisionToolCall(): ChatToolCall {
  return {
    id: "call-uji",
    type: "function",
    function: {
      name: "harvy_final_v1",
      arguments: '{"reply":"selesai"}',
    },
  };
}

function modelProfiles(
  provider: string,
  wireFormat: ModelProfile["reasoning"]["wireFormat"],
): ModelProfileRegistry {
  return new ModelProfileRegistry([{
    provider,
    id: "model-uji",
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high"],
      wireFormat,
    },
    supports: {
      tools: true,
      toolChoice: true,
      namedToolChoice: true,
      structuredOutput: true,
      temperature: true,
      promptCaching: false,
      imageInput: false,
    },
    continuation: {
      preserveReasoning: true,
      preserveAssistantMessage: true,
    },
    contextWindow: null,
    maxOutputTokens: null,
  }]);
}

function recordingLogger(
  onInfo: (
    event: string,
    fields: Record<string, unknown> | undefined,
  ) => void,
  // Opsional supaya pemanggil lama tidak ikut menerima peristiwa warn dan
  // assertion mereka tidak berubah.
  onWarn: (
    event: string,
    fields: Record<string, unknown> | undefined,
  ) => void = () => {},
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
    warn(event, _message, fields): void {
      onWarn(event, fields);
    },
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

/**
 * Percobaan ulang di dalam AgentRun.
 *
 * Terukur 5 September 2026: empat percobaan ulang worker berjalan dengan sisa
 * 8,3-10,5 detik. Tiga dibatalkan deadline; yang keempat selesai dan runnya
 * tetap tidak menghasilkan apa pun, karena keberhasilan itu memakai seluruh
 * jendela yang tersisa. Yang diperiksa karena itu bukan peluang berhasil,
 * melainkan apakah run masih sempat memakai hasilnya.
 */
describe("percobaan ulang menghormati sisa waktu run", () => {
  function timeoutLaluBaik(hitung: { n: number }) {
    return async (): Promise<Response> => {
      hitung.n += 1;
      if (hitung.n === 1) {
        const error = new Error("dibatalkan");
        error.name = "AbortError";
        throw error;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
  }

  function klien(): AiClient {
    return new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });
  }

  it("menahan pengulangan work ketika sisa waktu hanya cukup untuk menjawab", async () => {
    const hitung = { n: 0 };
    globalThis.fetch = timeoutLaluBaik(hitung);

    await assert.rejects(
      () => klien().complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxTokens: 100,
        execution: clientExecution(100, "planner"),
        runBudget: clientRunBudget({ deadlineMs: 10_000 }),
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(hitung.n, 1, "percobaan kedua tidak boleh dimulai");
  });

  it("tetap mengulang work ketika run masih punya waktu sesudah menjawab", async () => {
    const hitung = { n: 0 };
    globalThis.fetch = timeoutLaluBaik(hitung);

    const hasil = await klien().complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 100,
      execution: clientExecution(100, "planner"),
      runBudget: clientRunBudget({ deadlineMs: 45_000 }),
    });

    assert.equal(hitung.n, 2);
    assert.equal(hasil, "oke");
  });

  it("tidak menahan panggilan final, karena justru itu yang dilindungi", async () => {
    const hitung = { n: 0 };
    globalThis.fetch = timeoutLaluBaik(hitung);

    const hasil = await klien().complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
      maxTokens: 100,
      execution: clientExecution(100, "synthesizer"),
      runBudget: clientRunBudget({ deadlineMs: 10_000 }),
    });

    assert.equal(hitung.n, 2);
    assert.equal(hasil, "oke");
  });

  it("tidak mengubah apa pun di luar AgentRun", async () => {
    const hitung = { n: 0 };
    globalThis.fetch = timeoutLaluBaik(hitung);

    const hasil = await klien().complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(hitung.n, 2);
    assert.equal(hasil, "oke");
  });
});

function clientExecution(
  maxOutputTokens: number,
  role: "conversationalist" | "planner" | "synthesizer" =
    "conversationalist",
) {
  return new ExecutionPolicy().decide({
    tier: "cheap",
    role,
    workClass: "agent",
    profile: null,
    maxOutputTokens,
    deadlineMs: 30_000,
  });
}

function clientRunBudget(
  limits: Partial<RunBudget> = {},
): RunBudgetAccount {
  return new RunBudgetAccount({
    limits: {
      maxTotalTokens: 10_000,
      maxCostUsd: 1,
      maxSteps: 6,
      maxToolCalls: 5,
      maxModelCalls: 6,
      deadlineMs: 45_000,
      compactAtContextRatio: 0.8,
      maxConcurrentWorkers: 3,
      ...limits,
    },
  });
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

/**
 * Percobaan ulang untuk kegagalan sementara.
 *
 * Sampai 31 Agustus 2026 anggaran percobaan hanya diturunkan dari banyaknya
 * kunci API. Produksi memakai satu kunci, jadi anggarannya selalu 1 dan
 * percobaan kedua tidak pernah terjadi—meski timeout sudah dikenali layak-ulang
 * dan lognya sudah disiapkan. Log satu hari penuh: 23 kegagalan layak-ulang,
 * nol `ai_request_retrying`. Setiap cegukan provider langsung menjadi "maaf" di
 * layar pengguna.
 */
describe("percobaan ulang tidak bergantung jumlah kunci", () => {
  const jawabanBaik = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("mengulang timeout walau hanya ada satu kunci", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      if (panggilan === 1) {
        const error = new Error("dibatalkan");
        error.name = "AbortError";
        throw error;
      }
      return jawabanBaik();
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    const hasil = await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(panggilan, 2, "timeout pertama wajib dicoba ulang");
    assert.equal(hasil, "oke");
  });

  // Percobaan kedua memakai anggaran waktu lebih panjang. Timeout pertama
  // biasanya berarti provider sedang lambat, bukan mati; mengulang dengan
  // anggaran yang sama akan gagal karena alasan yang sama persis.
  it("memberi percobaan kedua waktu lebih panjang", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      if (panggilan === 1) {
        const error = new Error("dibatalkan");
        error.name = "AbortError";
        throw error;
      }
      return jawabanBaik();
    };

    const anggaran: number[] = [];
    const catat = (
      event: string,
      fields: Record<string, unknown> | undefined,
    ): void => {
      const timeoutMs = fields?.["timeoutMs"];
      if (
        (event === "ai_request_retrying" ||
          event === "ai_request_completed") &&
        typeof timeoutMs === "number"
      ) {
        anggaran.push(timeoutMs);
      }
    };
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
      timeoutMs: 1_000,
      logger: recordingLogger(catat, catat),
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(panggilan, 2);
    assert.equal(anggaran.length, 2, "kedua percobaan wajib tercatat");
    assert.equal(anggaran[0], 1_000, "percobaan pertama memakai anggaran biasa");
    assert.ok(
      (anggaran[1] ?? 0) > (anggaran[0] ?? 0),
      `percobaan kedua wajib lebih sabar: ${anggaran.join(" -> ")}`,
    );
  });

  // Penjaga arah sebaliknya. Classifier batas giliran menyetel `maxAttempts: 1`
  // dengan sengaja: deadline-nya pendek, pengguna sedang menunggu, dan
  // kegagalannya sudah gagal-aman. Mengulangnya menambah tunggu tanpa guna.
  it("menghormati maxAttempts eksplisit", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      const error = new Error("dibatalkan");
      error.name = "AbortError";
      throw error;
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    await assert.rejects(() =>
      client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxAttempts: 1,
      })
    );

    assert.equal(panggilan, 1, "maxAttempts eksplisit tidak boleh diulang");
  });

  it("tidak mengulang galat yang bukan sementara", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      return new Response(JSON.stringify({ error: "ditolak" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    await assert.rejects(() =>
      client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      })
    );

    assert.equal(panggilan, 1, "400 bukan alasan mengulang");
  });
});

/**
 * Prompt caching wajib terlihat di log.
 *
 * Sampai 1 September 2026 angka ini tidak pernah dicatat, padahal provider
 * melaporkannya di tiap jawaban dan client sudah menguraikannya. Penghematan
 * yang dirancang—aturan durable ditaruh di depan sebagai prefix stabil—jadi
 * tidak dapat diperiksa sama sekali, dan selama berbulan-bulan diasumsikan
 * bekerja. Pengukuran langsung menemukan sebaliknya.
 *
 * Kelas kesalahan yang sama dengan coba-ulang yang tidak pernah menyala:
 * mekanisme yang tidak terlihat tidak dapat dibedakan dari yang rusak.
 */
describe("prompt caching tercatat", () => {
  it("mencatat token yang dibaca dari cache provider", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 6_632,
            completion_tokens: 12,
            total_tokens: 6_644,
            prompt_tokens_details: { cached_tokens: 6_500 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const dicatat: Record<string, unknown>[] = [];
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      logger: recordingLogger((event, fields) => {
        if (event === "ai_request_completed") dicatat.push(fields ?? {});
      }),
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(dicatat.length, 1);
    assert.equal(dicatat[0]?.["cacheReadTokens"], 6_500);
    assert.equal(dicatat[0]?.["inputTokens"], 6_632);
  });

  // Nol adalah kabar, bukan ketiadaan kabar: itu justru keadaan yang selama ini
  // tidak terlihat. Menghilangkan fieldnya saat nol akan menyembunyikan persis
  // hal yang ingin dilihat.
  it("tetap mencatat ketika tidak ada yang ter-cache", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 6_632,
            completion_tokens: 12,
            total_tokens: 6_644,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const dicatat: Record<string, unknown>[] = [];
    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-uji"]),
      logger: recordingLogger((event, fields) => {
        if (event === "ai_request_completed") dicatat.push(fields ?? {});
      }),
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(dicatat[0]?.["cacheReadTokens"], 0);
  });
});

/**
 * Batas laju provider dicoba ulang, dengan jeda.
 *
 * Ditemukan dari pemakaian nyata 1 September 2026: satu HTTP 429 pada pemahaman
 * pesan langsung menjatuhkan giliran tanpa satu percobaan pun. Penyebabnya
 * keputusan sebelumnya—jatah coba-ulang sengaja dipersempit ke timeout saja,
 * karena melebarkannya ke seluruh kelas layak-ulang membuat empat tes fallback
 * merah.
 *
 * Alasan penyempitan itu ternyata hanya berlaku untuk 408 dan 5xx, yang memang
 * termasuk `isProviderWideFailure` dan punya jalur fallback sendiri. 429 tidak,
 * jadi ia jatuh ke lantai tanpa penangkap apa pun.
 *
 * Diulang dengan jeda, bukan seketika: 429 berarti kita mengetuk terlalu sering,
 * dan mengulang segera justru memperburuknya.
 */
describe("batas laju provider dicoba ulang dengan jeda", () => {
  const tolak429 = () =>
    new Response(JSON.stringify({ error: "rate limit" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  const jawabanBaik = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "oke" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("mengulang 429 dan berhasil pada percobaan kedua", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      return panggilan === 1 ? tolak429() : jawabanBaik();
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    const hasil = await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(panggilan, 2);
    assert.equal(hasil, "oke");
  });

  // Penjaga jeda. Tanpa menunggu, mengulang 429 menambah ketukan pada provider
  // yang justru sedang menyuruh berhenti.
  it("menunggu sebelum mencoba lagi", async () => {
    let panggilan = 0;
    const waktu: number[] = [];
    globalThis.fetch = async () => {
      panggilan += 1;
      waktu.push(Date.now());
      return panggilan === 1 ? tolak429() : jawabanBaik();
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    await client.complete({
      model: "model-uji",
      messages: [{ role: "user", content: "halo" }],
    });

    assert.equal(waktu.length, 2);
    assert.ok(
      (waktu[1] ?? 0) - (waktu[0] ?? 0) >= 500,
      `jeda terlalu pendek: ${(waktu[1] ?? 0) - (waktu[0] ?? 0)} ms`,
    );
  });

  it("menyerah sesudah jatahnya habis", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      return tolak429();
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    await assert.rejects(() =>
      client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
      })
    );

    assert.equal(panggilan, 2);
  });

  // Classifier berdeadline pendek menyetel `maxAttempts: 1` dengan sengaja;
  // menunggu satu detik di sana menghabiskan seluruh anggarannya.
  it("menghormati maxAttempts eksplisit tanpa menunggu", async () => {
    let panggilan = 0;
    globalThis.fetch = async () => {
      panggilan += 1;
      return tolak429();
    };

    const client = new AiClient({
      baseUrl: "https://example.invalid",
      keys: new ApiKeyPool(["kunci-tunggal"]),
    });

    await assert.rejects(() =>
      client.complete({
        model: "model-uji",
        messages: [{ role: "user", content: "halo" }],
        maxAttempts: 1,
      })
    );

    assert.equal(panggilan, 1);
  });
});
