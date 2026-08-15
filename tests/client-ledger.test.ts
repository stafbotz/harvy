import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiClient,
  type ChatFunctionTool,
} from "../src/ai/client.js";
import { ApiKeyPool } from "../src/ai/key-pool.js";
import type {
  AiUsageContext,
  TokenUsage,
  UsageObserver,
} from "../src/domain/telemetry.js";
import type {
  ProviderAttemptFinish,
  ProviderAttemptObserver,
  ProviderAttemptStart,
} from "../src/domain/usage-ledger.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";

class LogicalObserver implements UsageObserver {
  before: AiUsageContext[] = [];
  after: {
    context: AiUsageContext;
    usage: TokenUsage;
    succeeded: boolean;
  }[] = [];
  async beforeRequest(context: AiUsageContext) {
    this.before.push(context);
  }
  async afterRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean; latencyMs: number },
  ) {
    this.after.push({ context, usage, succeeded: outcome.succeeded });
  }
}

class AttemptObserver implements ProviderAttemptObserver {
  starts: ProviderAttemptStart[] = [];
  finishes: { context: ProviderAttemptStart; result: ProviderAttemptFinish }[] = [];
  async startAttempt(context: ProviderAttemptStart) {
    this.starts.push(context);
  }
  async finishAttempt(context: ProviderAttemptStart, result: ProviderAttemptFinish) {
    this.finishes.push({ context, result });
  }
}

describe("AiClient usage ledger", () => {
  it("menghubungkan primary gagal dan fallback berhasil tanpa double logical settlement", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return new Response(JSON.stringify({
        id: "generation-fallback",
        choices: [{ message: { content: "jawaban fallback" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
          cost: "0.0004",
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const logical = new LogicalObserver();
      const attempts = new AttemptObserver();
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        providerId: "google-ai-studio",
        keys: new ApiKeyPool(["primary-key"]),
        fallback: {
          baseUrl: "https://fallback.example/v1",
          providerId: "deepseek",
          keys: new ApiKeyPool(["fallback-key"]),
          model: "deepseek-v4-flash",
        },
        usageObserver: logical,
        attemptObserver: attempts,
      });
      const result = await client.complete({
        model: "gemini-flash-lite",
        messages: [{ role: "user", content: "halo" }],
        usage: {
          ownerId: "student",
          tier: "cheap",
          purpose: "reply",
          safetyCritical: false,
        },
      });

      assert.equal(result, "jawaban fallback");
      assert.equal(logical.before.length, 1);
      assert.equal(logical.after.length, 1);
      assert.equal(logical.after[0]?.succeeded, true);
      assert.equal(logical.after[0]?.context.model, "deepseek-v4-flash");
      assert.equal(attempts.starts.length, 2);
      assert.equal(attempts.finishes.length, 2);
      assert.equal(new Set(attempts.starts.map((item) => item.requestId)).size, 1);
      assert.deepEqual(attempts.starts.map((item) => item.attemptNo), [1, 2]);
      assert.deepEqual(attempts.starts.map((item) => item.origin), ["primary", "fallback"]);
      assert.deepEqual(attempts.starts.map((item) => item.providerId), ["google-ai-studio", "deepseek"]);
      assert.deepEqual(attempts.starts.map((item) => item.modelId), ["gemini-flash-lite", "deepseek-v4-flash"]);
      assert.equal(attempts.finishes[0]?.result.status, "network_error");
      assert.equal(attempts.finishes[1]?.result.status, "completed");
      assert.equal(attempts.finishes[1]?.result.usage.providerCostUsd, "0.0004");
      assert.equal(attempts.finishes[1]?.result.usage.cacheReadTokens, 3);
      assert.equal(attempts.finishes[1]?.result.usage.reasoningTokens, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("meneruskan metadata route toughest ke observer tanpa memasukkannya ke wire", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "candidate" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const attempts = new AttemptObserver();
      const execution = new ExecutionPolicy().decide({
        tier: "toughest",
        role: "critic",
        workClass: "agent",
        profile: null,
        maxOutputTokens: 512,
        deadlineMs: 20_000,
        maxSteps: 1,
        allowTools: false,
        allowDelegation: false,
        allowEscalation: true,
        escalationReason: "observation_contradiction",
        routeReason: "validator_escalation",
        promptMaterial: "structured-brief+candidate",
        sourcePrivacyDomain: "workspace.private",
        targetPrivacyDomain: "provider.approved",
      });
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        providerId: "openrouter",
        keys: new ApiKeyPool(["key"]),
        attemptObserver: attempts,
      });
      await client.complete({
        model: "model-toughest",
        maxTokens: execution.maxOutputTokens,
        execution,
        messages: [{ role: "user", content: "structured candidate" }],
        usage: {
          ownerId: "student",
          tier: "ambitious",
          purpose: "reply",
          safetyCritical: false,
        },
      });

      assert.equal(attempts.starts[0]?.routeTier, "toughest");
      assert.equal(
        attempts.starts[0]?.escalationReason,
        "observation_contradiction",
      );
      assert.equal(attempts.starts[0]?.sourcePrivacyDomain, "workspace.private");
      assert.equal(attempts.starts[0]?.targetPrivacyDomain, "provider.approved");
      assert.doesNotMatch(
        requestBody,
        /routeTier|promptMaterial|sourcePrivacyDomain|targetPrivacyDomain|validator_escalation/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mencatat retry JSON sebagai fetch kedua dalam request yang sama", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const attempts = new AttemptObserver();
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        keys: new ApiKeyPool(["key"]),
        attemptObserver: attempts,
      });
      await client.complete({
        model: "model",
        json: true,
        messages: [{ role: "user", content: "{}" }],
        usage: {
          ownerId: "student",
          tier: "cheap",
          purpose: "understanding",
          safetyCritical: false,
        },
      });
      assert.equal(attempts.starts.length, 2);
      assert.equal(new Set(attempts.starts.map((item) => item.requestId)).size, 1);
      assert.deepEqual(attempts.finishes.map((item) => item.result.status), ["http_error", "completed"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mencatat schema_rejected ketika transport sukses tetapi parser domain menolak", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "bukan-json-domain" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }), { status: 200 })) as typeof fetch;
    try {
      const logical = new LogicalObserver();
      const attempts = new AttemptObserver();
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        keys: new ApiKeyPool(["key"]),
        usageObserver: logical,
        attemptObserver: attempts,
      });
      const raw = await client.complete({
        model: "model",
        messages: [{ role: "user", content: "uji" }],
        validateResponse: () => false,
        usage: {
          ownerId: "student",
          tier: "cheap",
          purpose: "due-date",
          safetyCritical: false,
        },
      });
      assert.equal(raw, "bukan-json-domain");
      assert.equal(logical.after[0]?.succeeded, false);
      assert.equal(attempts.finishes[0]?.result.status, "completed");
      assert.equal(attempts.finishes[0]?.result.responseOutcome, "schema_rejected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mencatat respons nonterminal sebagai incomplete beserta usage", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "teks belum terminal" } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    }), { status: 200 })) as typeof fetch;
    try {
      const attempts = new AttemptObserver();
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        keys: new ApiKeyPool(["key"]),
        attemptObserver: attempts,
      });
      await assert.rejects(
        () => client.complete({
          model: "model",
          messages: [{ role: "user", content: "uji" }],
          usage: {
            ownerId: "student",
            tier: "cheap",
            purpose: "reply",
            safetyCritical: false,
          },
        }),
        /finish_reason=missing/u,
      );
      assert.equal(attempts.finishes[0]?.result.status, "response_rejected");
      assert.equal(attempts.finishes[0]?.result.responseOutcome, "incomplete");
      assert.equal(attempts.finishes[0]?.result.finishReason, null);
      assert.equal(attempts.finishes[0]?.result.usage.inputTokens, 7);
      assert.equal(attempts.finishes[0]?.result.usage.outputTokens, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("menormalisasi finish_reason asing tanpa mempersistenkan isi provider", async () => {
    const originalFetch = globalThis.fetch;
    const canary = "SECRET_REASONING_CANARY_MUST_NOT_PERSIST";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "parsial" },
        finish_reason: canary,
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200 })) as typeof fetch;
    try {
      const attempts = new AttemptObserver();
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        keys: new ApiKeyPool(["key"]),
        attemptObserver: attempts,
      });
      let rejection: unknown;
      try {
        await client.complete({
          model: "model",
          messages: [{ role: "user", content: "uji" }],
          usage: {
            ownerId: "student",
            tier: "cheap",
            purpose: "reply",
            safetyCritical: false,
          },
        });
      } catch (error) {
        rejection = error;
      }
      assert.ok(rejection instanceof Error);
      assert.match(rejection.message, /finish_reason=other/u);
      assert.doesNotMatch(rejection.message, /SECRET_REASONING_CANARY/u);
      assert.equal(attempts.finishes[0]?.result.finishReason, "other");
      assert.doesNotMatch(JSON.stringify(attempts), /SECRET_REASONING_CANARY/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mencatat native tool di luar kontrak sebagai schema_rejected", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-asing",
            type: "function",
            function: { name: "tool_tidak_tersedia", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    }), { status: 200 })) as typeof fetch;
    try {
      const logical = new LogicalObserver();
      const attempts = new AttemptObserver();
      const tools = [{
        type: "function",
        function: {
          name: "tool_diizinkan",
          description: "Tool uji.",
          parameters: { type: "object", additionalProperties: false },
        },
      }] satisfies readonly ChatFunctionTool[];
      const client = new AiClient({
        baseUrl: "https://primary.example/v1",
        keys: new ApiKeyPool(["key"]),
        usageObserver: logical,
        attemptObserver: attempts,
      });

      await assert.rejects(
        () => client.completeToolTurn({
          model: "model",
          messages: [{ role: "user", content: "uji" }],
          tools,
          usage: {
            ownerId: "student",
            tier: "cheap",
            purpose: "agent",
            safetyCritical: false,
          },
        }),
        /tidak tersedia/u,
      );
      assert.equal(logical.after[0]?.succeeded, false);
      assert.equal(attempts.finishes[0]?.result.status, "completed");
      assert.equal(attempts.finishes[0]?.result.responseOutcome, "schema_rejected");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
