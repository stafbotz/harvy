import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiClientOptions,
  loadAiConfig,
} from "../src/config.js";

const AI_ENV_KEYS = [
  "AI_MODE",
  "AI_BASE_URL",
  "GMI_API_KEY",
  "AI_MODEL_TESTING",
  "AI_MODEL_TESTING_CHEAP",
  "AI_MODEL_TESTING_EFFICIENT",
  "AI_MODEL_TESTING_AMBITIOUS",
  "AI_MODEL_TESTING_TOUGHEST",
  "OPENROUTER_API_KEY",
  "AI_MODEL_CHEAP",
  "AI_MODEL_EFFICIENT",
  "AI_MODEL_AMBITIOUS",
  "AI_MODEL_TOUGHEST",
  "AI_TOUGHEST_PRIVACY_DOMAIN",
  "AI_MODEL_ROLE_BINDINGS",
  "AI_SPECIALIST_DELEGATION_ENABLED",
  "AI_MODEL_PROFILES",
  "MEMORY_EMBEDDING_MODEL",
] as const;

describe("konfigurasi provider AI", () => {
  it("mengaktifkan embedding hanya dengan model opt-in eksplisit", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      assert.equal(loadAiConfig().memoryEmbeddingModel, null);
    });
    withAiEnvironment(validTestingEnvironment({
      MEMORY_EMBEDDING_MODEL: "embedding-model-uji",
    }), () => {
      assert.equal(
        loadAiConfig().memoryEmbeddingModel,
        "embedding-model-uji",
      );
    });
    withAiEnvironment(validTestingEnvironment({
      MEMORY_EMBEDDING_MODEL: "model<rusak",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_MEMORY_EMBEDDING_MODEL_INVALID"),
      );
    });
  });

  it("memakai GMI sebagai provider testing tunggal tanpa fallback", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      const config = loadAiConfig();
      assert.equal(config.mode, "testing");
      assert.equal(config.providerId, "gmi-serving");
      assert.equal(config.baseUrl, "https://api.gmi-serving.com/v1");
      assert.equal(config.keys.take(), "gmi-test-key");
      assert.equal(aiClientOptions(config).fallback, null);
      assert.equal(
        config.modelProfiles.require(
          "gmi-serving",
          "model-testing",
        ).reasoning.wireFormat,
        "none",
      );
      assert.equal(
        config.modelProfiles.require(
          "gmi-serving",
          "model-testing",
        ).verification,
        "compatibility",
      );
    });
  });

  it("menginventarisasi seluruh model env tanpa credential", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_CHEAP: "model-testing-cheap",
      AI_MODEL_CHEAP: "model-production-cheap",
      AI_MODEL_EFFICIENT: "model-production-efficient",
      AI_MODEL_AMBITIOUS: "model-production-ambitious",
      AI_MODEL_TOUGHEST: "model-production-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
    }), () => {
      const catalog = loadAiConfig().configuredModels;
      assert.deepEqual(
        catalog.map((model) => `${model.providerId}:${model.modelId}`),
        [
          "gmi-serving:model-testing",
          "gmi-serving:model-testing-cheap",
          "openrouter:model-production-ambitious",
          "openrouter:model-production-cheap",
          "openrouter:model-production-efficient",
          "openrouter:model-production-toughest",
        ],
      );
      assert.equal(
        catalog.find((model) => model.modelId === "model-production-cheap")?.active,
        false,
      );
      assert.equal(loadAiConfig().toughest, null);
      const serialized = JSON.stringify(catalog);
      assert.doesNotMatch(serialized, /gmi-test-key|api\.gmi-serving\.com/u);
    });
  });

  it("menggabungkan model yang sama dari beberapa slot tier", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_CHEAP: "model-bersama",
      AI_MODEL_TESTING_EFFICIENT: "model-bersama",
    }), () => {
      const shared = loadAiConfig().configuredModels.find(
        (model) => model.modelId === "model-bersama",
      );
      assert.deepEqual(
        shared?.sources.map((source) => source.environmentVariable),
        ["AI_MODEL_TESTING_CHEAP", "AI_MODEL_TESTING_EFFICIENT"],
      );
      assert.equal(shared?.active, true);
    });
  });

  it("mengikat cognitive role ke exact model tanpa mengubah tier accounting", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_ROLE_BINDINGS: JSON.stringify({
        everyday_conversation: { tier: "efficient" },
        orchestrator: {
          tier: "ambitious",
          modelId: "model-orchestrator",
        },
      }),
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("gmi-serving", "model-orchestrator"),
      ]),
    }), () => {
      const config = loadAiConfig();
      assert.deepEqual(config.roleBindings, {
        everyday_conversation: { tier: "efficient" },
        orchestrator: {
          tier: "ambitious",
          modelId: "model-orchestrator",
        },
      });
      const configured = config.configuredModels.find(
        (model) => model.modelId === "model-orchestrator",
      );
      assert.equal(configured?.providerId, "gmi-serving");
      assert.equal(configured?.active, true);
      assert.deepEqual(configured?.sources, [{
        environmentVariable: "AI_MODEL_ROLE_BINDINGS.orchestrator",
        mode: "testing",
        origin: "primary",
        tiers: ["ambitious"],
        active: true,
      }]);
      assert.equal(
        config.modelProfiles.require(
          "gmi-serving",
          "model-orchestrator",
        ).verification,
        "explicit",
      );
    });
  });

  it("menjaga specialist delegation default-off dan membaca opt-in eksplisit", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      assert.equal(loadAiConfig().specialistDelegationEnabled, false);
    });
    withAiEnvironment(validTestingEnvironment({
      AI_SPECIALIST_DELEGATION_ENABLED: "true",
    }), () => {
      assert.equal(loadAiConfig().specialistDelegationEnabled, true);
    });
    withAiEnvironment(validTestingEnvironment({
      AI_SPECIALIST_DELEGATION_ENABLED: "maybe",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_SPECIALIST_DELEGATION_ENABLED_INVALID"),
      );
    });
  });

  it("menolak cognitive role binding yang terbuka atau tidak sah", () => {
    const invalid = [
      "bukan-json",
      JSON.stringify([]),
      JSON.stringify({ role_buatan_model: { tier: "ambitious" } }),
      JSON.stringify({ orchestrator: { tier: "toughest" } }),
      JSON.stringify({ orchestrator: { modelId: "model" } }),
      JSON.stringify({
        orchestrator: {
          tier: "ambitious",
          modelId: "model",
          provider: "bebas",
        },
      }),
      JSON.stringify({
        orchestrator: { tier: "ambitious", modelId: "model<rusak" },
      }),
      "x".repeat(8_193),
    ];
    for (const value of invalid) {
      withAiEnvironment(validTestingEnvironment({
        AI_MODEL_ROLE_BINDINGS: value,
      }), () => {
        assert.throws(
          () => loadAiConfig(),
          hasCode("CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID"),
        );
      });
    }
  });

  it("menjaga toughest default-off dan hanya mengaktifkan profile exact", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      assert.equal(loadAiConfig().toughest, null);
    });

    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_TOUGHEST: "model-testing-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("gmi-serving", "model-testing-toughest"),
      ]),
    }), () => {
      const config = loadAiConfig();
      assert.deepEqual(config.toughest, {
        modelId: "model-testing-toughest",
        privacyDomain: "provider.approved",
      });
      const toughest = config.configuredModels.find(
        (model) => model.modelId === "model-testing-toughest",
      );
      assert.equal(toughest?.active, true);
      assert.deepEqual(toughest?.sources[0]?.tiers, ["toughest"]);
      assert.equal(
        config.modelProfiles.require(
          "gmi-serving",
          "model-testing-toughest",
        ).verification,
        "explicit",
      );
    });
  });

  it("menolak slot toughest yang parsial, domain rusak, atau tanpa profile exact", () => {
    for (const environment of [
      validTestingEnvironment({
        AI_MODEL_TESTING_TOUGHEST: "model-testing-toughest",
      }),
      validTestingEnvironment({
        AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
      }),
    ]) {
      withAiEnvironment(environment, () => {
        assert.throws(
          () => loadAiConfig(),
          hasCode("CONFIG_AI_TOUGHEST_INCOMPLETE"),
        );
      });
    }

    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_TOUGHEST: "model-testing-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "domain tidak sah",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_TOUGHEST_PRIVACY_DOMAIN_INVALID"),
      );
    });

    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_TOUGHEST: "model-testing-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_TOUGHEST_PROFILE_REQUIRED"),
      );
    });
  });

  it("menolak ID model rusak dan testing tanpa key GMI", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "model<rusak",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_TESTING_INVALID"),
      );
    });
    withAiEnvironment(validTestingEnvironment({ GMI_API_KEY: "" }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_GMI_KEY_MISSING"),
      );
    });
  });

  it("memvalidasi base URL primary sebelum API key dapat dikirim", () => {
    const invalid = [
      "http://provider.example/v1",
      "https://user:secret@provider.example/v1",
      "https://provider.example/v1?apikey=secret",
      "https://provider.example/v1#bagian",
      "https://provider.example/v1/chat/completions",
      "bukan-url",
    ];
    for (const baseUrl of invalid) {
      withAiEnvironment(validTestingEnvironment({ AI_BASE_URL: baseUrl }), () => {
        assert.throws(
          () => loadAiConfig(),
          hasCode("CONFIG_AI_BASE_URL_INVALID"),
          baseUrl,
        );
      });
    }

    withAiEnvironment(validTestingEnvironment({
      AI_BASE_URL: "http://127.0.0.1:43123/v1/",
    }), () => {
      assert.equal(loadAiConfig().baseUrl, "http://127.0.0.1:43123/v1");
    });
  });

  it("mempertahankan OpenRouter sebagai provider production", () => {
    withAiEnvironment({
      AI_MODE: "production",
      OPENROUTER_API_KEY: "openrouter",
      AI_MODEL_CHEAP: "cheap",
      AI_MODEL_EFFICIENT: "efficient",
      AI_MODEL_AMBITIOUS: "ambitious",
      AI_MODEL_TOUGHEST: "model-production-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("openrouter", "model-production-toughest"),
      ]),
    }, () => {
      const config = loadAiConfig();
      assert.equal(config.providerId, "openrouter");
      assert.equal(aiClientOptions(config).fallback, null);
      assert.equal(
        config.modelProfiles.require(
          "openrouter",
          "ambitious",
        ).reasoning.wireFormat,
        "none",
      );
      assert.deepEqual(config.toughest, {
        modelId: "model-production-toughest",
        privacyDomain: "provider.approved",
      });
    });
  });

  it("tidak menebak reasoning wire pada base URL kustom", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_BASE_URL: "https://gateway.example/v1",
    }), () => {
      const profile = loadAiConfig().modelProfiles.require(
        "gmi-serving",
        "model-testing",
      );
      assert.equal(profile.reasoning.wireFormat, "none");
      assert.deepEqual(profile.reasoning.supportedEfforts, []);
    });
  });

  it("mempromosikan MiniMax hanya pada endpoint GMI resmi yang sudah lulus smoke", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "MiniMaxAI/MiniMax-M3",
    }), () => {
      const profile = loadAiConfig().modelProfiles.require(
        "gmi-serving",
        "MiniMaxAI/MiniMax-M3",
      );
      assert.equal(profile.verification, "explicit");
      assert.equal(profile.reasoning.defaultEffort, "none");
      assert.equal(profile.continuation.preserveReasoning, false);
      assert.equal(profile.supports.promptCaching, true);
      assert.equal(profile.supports.imageInput, true);
    });
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "MiniMaxAI/MiniMax-M3",
      AI_BASE_URL: "https://gateway.example/v1",
    }), () => {
      assert.equal(
        loadAiConfig().modelProfiles.require(
          "gmi-serving",
          "MiniMaxAI/MiniMax-M3",
        ).verification,
        "compatibility",
      );
    });
  });

  it("mengaktifkan capability hanya untuk deklarasi exact provider + model", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_CHEAP: "model-production-cheap",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("gmi-serving", "model-testing"),
        explicitProfile("openrouter", "model-production-cheap"),
      ]),
    }), () => {
      const profile = loadAiConfig().modelProfiles.require(
        "gmi-serving",
        "model-testing",
      );
      assert.equal(profile.verification, "explicit");
      assert.equal(profile.reasoning.wireFormat, "openai-reasoning-effort");
      assert.deepEqual(profile.reasoning.supportedEfforts, [
        "low",
        "medium",
        "high",
      ]);
      assert.equal(
        loadAiConfig().modelProfiles.require(
          "openrouter",
          "model-production-cheap",
        ).reasoning.wireFormat,
        "openrouter-reasoning",
      );
    });
  });

  it("menolak profile model asing, duplikat, dan schema yang tidak sah", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("gmi-serving", "model-asing"),
      ]),
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_PROFILES_UNKNOWN"),
      );
    });

    const duplicate = explicitProfile("gmi-serving", "model-testing");
    for (const value of [
      "bukan-json",
      JSON.stringify([duplicate, duplicate]),
      JSON.stringify([{ ...duplicate, fieldBerlebih: true }]),
      JSON.stringify([{
        ...duplicate,
        reasoning: { ...duplicate.reasoning, wireFormat: "bogus" },
      }]),
      JSON.stringify(Array.from({ length: 33 }, () => duplicate)),
      "x".repeat(64_001),
    ]) {
      withAiEnvironment(validTestingEnvironment({
        AI_MODEL_PROFILES: value,
      }), () => {
        assert.throws(
          () => loadAiConfig(),
          hasCode("CONFIG_AI_MODEL_PROFILES_INVALID"),
        );
      });
    }
  });

});

function explicitProfile(provider: string, id: string) {
  return {
    provider,
    id,
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high"],
      wireFormat: provider === "openrouter"
        ? "openrouter-reasoning"
        : "openai-reasoning-effort",
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

function validTestingEnvironment(
  overrides: Partial<
    Record<(typeof AI_ENV_KEYS)[number], string>
  > = {},
): Partial<Record<(typeof AI_ENV_KEYS)[number], string>> {
  return {
    AI_MODE: "testing",
    GMI_API_KEY: "gmi-test-key",
    AI_MODEL_TESTING: "model-testing",
    ...overrides,
  };
}

function withAiEnvironment(
  values: Partial<
    Record<(typeof AI_ENV_KEYS)[number], string>
  >,
  action: () => void,
): void {
  const previous = new Map(
    AI_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const key of AI_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    action();
  } finally {
    for (const key of AI_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string }).code === expected;
}
