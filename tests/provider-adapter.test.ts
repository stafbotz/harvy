import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  serializeProviderMessages,
  serializeProviderOptions,
} from "../src/ai/provider-adapter.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";
import type {
  ChatAssistantToolMessage,
  ChatMessage,
} from "../src/ai/client.js";
import type { ModelProfile } from "../src/ai/model-profile.js";

describe("provider adapter", () => {
  it("menyerialisasi kontrol thinking DeepSeek tanpa temperature", () => {
    const profile = deepSeekProfile();
    const execution = new ExecutionPolicy().decide({
      tier: "ambitious",
      role: "recovery",
      workClass: "agent",
      profile,
      maxOutputTokens: 4_096,
      deadlineMs: 30_000,
      allowEscalation: true,
      escalationReason: "validator_failed",
    });

    assert.deepEqual(serializeProviderOptions({
      providerId: profile.provider,
      modelId: profile.id,
      profile,
      execution,
      temperature: 0.7,
    }), {
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
  });

  it("memutar reasoning_content persis pada provider dan model yang sama", () => {
    const profile = deepSeekProfile();
    const assistant = assistantTurn({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      reasoningContent: "opaque-reasoning-content",
    });

    assert.deepEqual(serializeProviderMessages([assistant], {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      profile,
    })[0], {
      role: "assistant",
      content: null,
      tool_calls: assistant.tool_calls,
      reasoning_content: "opaque-reasoning-content",
    });
  });

  it("hanya mengirim field message yang termasuk kontrak wire", () => {
    const tainted = {
      role: "user",
      content: "halo",
      localOnlySecret: "LOCAL_CANARY_MUST_NOT_CROSS_WIRE",
    } as ChatMessage;
    assert.deepEqual(serializeProviderMessages([tainted], {
      providerId: "openrouter",
      modelId: "vendor/model",
    }), [{ role: "user", content: "halo" }]);
  });

  it("menempelkan gambar transient hanya pada giliran user terakhir", () => {
    const base = openRouterProfile();
    const profile: ModelProfile = {
      ...base,
      supports: { ...base.supports, imageInput: true },
    };
    const wire = serializeProviderMessages([
      { role: "system", content: "aturan" },
      { role: "user", content: "pertanyaan lama" },
      { role: "assistant", content: "jawaban lama" },
      { role: "user", content: "apa isi gambar ini?" },
    ], {
      providerId: profile.provider,
      modelId: profile.id,
      profile,
      imageInputs: [{
        type: "input_image",
        mediaType: "image/png",
        data: Uint8Array.from([1, 2, 3]),
        detail: "low",
      }],
    });

    assert.equal(wire[1]?.content, "pertanyaan lama");
    assert.deepEqual(wire[3], {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,AQID",
            detail: "low",
          },
        },
        { type: "text", text: "apa isi gambar ini?" },
      ],
    });
    assert.throws(
      () => serializeProviderMessages([{ role: "system", content: "aturan" }], {
        providerId: profile.provider,
        modelId: profile.id,
        profile,
        imageInputs: [{
          type: "input_image",
          mediaType: "image/png",
          data: Uint8Array.from([1]),
        }],
      }),
      /giliran user/u,
    );
  });

  it("menolak continuation lintas model, siklik, dan terlalu besar", () => {
    const profile = openRouterProfile();
    const valid = assistantTurn({
      providerId: "openrouter",
      modelId: "vendor/model-a",
      reasoningDetails: [{ type: "reasoning.encrypted", data: "opaque" }],
    });
    assert.throws(
      () => serializeProviderMessages([valid], {
        providerId: "openrouter",
        modelId: "vendor/model-b",
        profile,
      }),
      /terikat provider\/model lain/u,
    );

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    assert.throws(
      () => serializeProviderMessages([assistantTurn({
        providerId: "openrouter",
        modelId: "vendor/model-a",
        reasoningDetails: cyclic,
      })], {
        providerId: "openrouter",
        modelId: "vendor/model-a",
        profile,
      }),
      /array JSON/u,
    );

    assert.throws(
      () => serializeProviderMessages([assistantTurn({
        providerId: "openrouter",
        modelId: "vendor/model-a",
        reasoning: "x".repeat(256_001),
      })], {
        providerId: "openrouter",
        modelId: "vendor/model-a",
        profile,
      }),
      /terlalu besar/u,
    );

    const opaqueWithoutBinding = assistantTurn(undefined);
    opaqueWithoutBinding.tool_calls[0]!.extra_content = {
      google: { thought_signature: "opaque-signature" },
    };
    assert.throws(
      () => serializeProviderMessages([opaqueWithoutBinding], {
        providerId: "provider-uji",
        modelId: "model-uji",
      }),
      /tidak mempunyai provider binding/u,
    );
  });
});

function assistantTurn(
  continuation: ChatAssistantToolMessage["continuation"],
): ChatAssistantToolMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call-uji",
      type: "function",
      function: { name: "harvy_final_v1", arguments: "{}" },
    }],
    ...(continuation ? { continuation } : {}),
  };
}

function deepSeekProfile(): ModelProfile {
  return {
    provider: "deepseek",
    id: "deepseek-v4-pro",
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
  };
}

function openRouterProfile(): ModelProfile {
  return {
    provider: "openrouter",
    id: "vendor/model-a",
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high"],
      wireFormat: "openrouter-reasoning",
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
  };
}
