import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aiClientOptions,
  loadAiConfig,
} from "../src/config.js";

const AI_ENV_KEYS = [
  "AI_MODE",
  "AI_BASE_URL",
  "GOOGLE_AI_STUDIO_API_KEYS",
  "AI_MODEL_TESTING",
  "AI_MODEL_TESTING_CHEAP",
  "AI_MODEL_TESTING_EFFICIENT",
  "AI_MODEL_TESTING_AMBITIOUS",
  "AI_MODEL_TESTING_TOUGHEST",
  "AI_TESTING_FALLBACK_BASE_URL",
  "AI_TESTING_FALLBACK_API_KEY",
  "AI_TESTING_FALLBACK_MODEL",
  "AI_TESTING_FALLBACK_PROVIDER_ID",
  "AI_TESTING_FALLBACK_COOLDOWN_MS",
  "OPENROUTER_API_KEY",
  "AI_MODEL_CHEAP",
  "AI_MODEL_EFFICIENT",
  "AI_MODEL_AMBITIOUS",
  "AI_MODEL_TOUGHEST",
  "AI_TOUGHEST_PRIVACY_DOMAIN",
  "AI_MODEL_PROFILES",
  "MEMORY_EMBEDDING_MODEL",
] as const;

describe("konfigurasi fallback AI testing", () => {
  it("mengaktifkan embedding hanya dengan model opt-in eksplisit", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      assert.equal(loadAiConfig().memoryEmbeddingModel, null);
    });
    withAiEnvironment(validTestingEnvironment({
      MEMORY_EMBEDDING_MODEL: "gemini-embedding-001",
    }), () => {
      assert.equal(
        loadAiConfig().memoryEmbeddingModel,
        "gemini-embedding-001",
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

  it("membaca fallback lengkap dan dapat mematikannya untuk evaluator", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL:
        "https://fallback.example/api/v3/",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      AI_TESTING_FALLBACK_COOLDOWN_MS: "45000",
    }), () => {
      const config = loadAiConfig();
      assert.equal(config.mode, "testing");
      assert.equal(
        config.fallback?.baseUrl,
        "https://fallback.example/api/v3",
      );
      assert.equal(config.fallback?.model, "model-cadangan");
      assert.equal(config.fallback?.modelInQuery, true);
      assert.equal(config.fallback?.cooldownMs, 45_000);
      assert.equal(config.fallback?.keys.take(), "rahasia-cadangan");
      assert.equal(
        aiClientOptions(config, { fallback: false }).fallback,
        null,
      );
      assert.equal(
        config.modelProfiles.require(
          "google-ai-studio",
          "model-testing",
        ).reasoning.wireFormat,
        "none",
      );
      assert.equal(
        config.modelProfiles.require(
          "google-ai-studio",
          "model-testing",
        ).verification,
        "compatibility",
      );
      assert.equal(
        config.modelProfiles.require(
          "testing-fallback",
          "model-cadangan",
        ).reasoning.wireFormat,
        "none",
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
      AI_TESTING_FALLBACK_BASE_URL: "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      AI_TESTING_FALLBACK_PROVIDER_ID: "always-codex",
    }), () => {
      const catalog = loadAiConfig().configuredModels;
      assert.deepEqual(
        catalog.map((model) => `${model.providerId}:${model.modelId}`),
        [
          "always-codex:model-cadangan",
          "google-ai-studio:model-testing",
          "google-ai-studio:model-testing-cheap",
          "openrouter:model-production-ambitious",
          "openrouter:model-production-cheap",
          "openrouter:model-production-efficient",
          "openrouter:model-production-toughest",
        ],
      );
      assert.equal(
        catalog.find((model) => model.modelId === "model-cadangan")?.active,
        true,
      );
      assert.equal(
        catalog.find((model) => model.modelId === "model-production-cheap")?.active,
        false,
      );
      assert.equal(loadAiConfig().toughest, null);
      const serialized = JSON.stringify(catalog);
      assert.doesNotMatch(serialized, /rahasia-cadangan|fallback\.example/u);
      assert.match(serialized, /AI_TESTING_FALLBACK_MODEL/u);
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

  it("menjaga toughest default-off dan hanya mengaktifkan profile exact", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      assert.equal(loadAiConfig().toughest, null);
    });

    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_TOUGHEST: "model-testing-toughest",
      AI_TOUGHEST_PRIVACY_DOMAIN: "provider.approved",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("google-ai-studio", "model-testing-toughest"),
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
          "google-ai-studio",
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

  it("menolak ID model dan provider env yang tidak dapat dikatalogkan", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "model<rusak",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_TESTING_INVALID"),
      );
    });
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL: "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      AI_TESTING_FALLBACK_PROVIDER_ID: "provider tidak sah",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_TESTING_FALLBACK_PROVIDER_ID_INVALID"),
      );
    });
  });

  it("membolehkan mode testing tanpa fallback", () => {
    withAiEnvironment(validTestingEnvironment(), () => {
      const config = loadAiConfig();
      assert.equal(config.fallback, null);
    });
  });

  it("menolak konfigurasi fallback yang hanya terisi sebagian", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL:
        "https://fallback.example/api/v3",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_TESTING_FALLBACK_INCOMPLETE"),
      );
    });
  });

  it("menolak URL fallback yang dapat membawa secret atau path endpoint penuh", () => {
    const invalid = [
      "http://fallback.example/api/v3",
      "https://user:secret@fallback.example/api/v3",
      "https://fallback.example/api/v3?apikey=secret",
      "https://fallback.example/api/v3#bagian",
      "https://fallback.example/api/v3/chat/completions",
      "bukan-url",
    ];
    for (const baseUrl of invalid) {
      withAiEnvironment(validTestingEnvironment({
        AI_TESTING_FALLBACK_BASE_URL: baseUrl,
        AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
        AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      }), () => {
        assert.throws(
          () => loadAiConfig(),
          hasCode("CONFIG_TESTING_FALLBACK_URL_INVALID"),
          baseUrl,
        );
      });
    }
  });

  it("menolak cooldown nol", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL:
        "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      AI_TESTING_FALLBACK_COOLDOWN_MS: "0",
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode(
          "CONFIG_AI_TESTING_FALLBACK_COOLDOWN_MS_INVALID",
        ),
      );
    });
  });

  it("tidak pernah mengaktifkan fallback testing di production", () => {
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
      AI_TESTING_FALLBACK_BASE_URL:
        "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
    }, () => {
      const config = loadAiConfig();
      assert.equal(config.fallback, null);
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
        "google-ai-studio",
        "model-testing",
      );
      assert.equal(profile.reasoning.wireFormat, "none");
      assert.deepEqual(profile.reasoning.supportedEfforts, []);
    });
  });

  it("memakai profile live-verified hanya pada model dan endpoint Google exact", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "gemini-3.5-flash-lite",
    }), () => {
      const profile = loadAiConfig().modelProfiles.require(
        "google-ai-studio",
        "gemini-3.5-flash-lite",
      );
      assert.equal(profile.verification, "explicit");
      assert.equal(profile.reasoning.defaultEffort, "minimal");
      assert.equal(profile.supports.temperature, false);
      assert.equal(profile.continuation.preserveReasoning, true);
    });

    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "gemini-3.5-flash-lite",
      AI_BASE_URL: "https://gateway.example/v1",
    }), () => {
      assert.equal(loadAiConfig().modelProfiles.require(
        "google-ai-studio",
        "gemini-3.5-flash-lite",
      ).verification, "compatibility");
    });
  });

  it("tidak mengaktifkan profile live-verified pada pasangan fallback aktif", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING: "gemini-3.5-flash-lite",
      AI_TESTING_FALLBACK_BASE_URL: "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "gemini-3.5-flash-lite",
      AI_TESTING_FALLBACK_PROVIDER_ID: "google-ai-studio",
    }), () => {
      assert.equal(loadAiConfig().modelProfiles.require(
        "google-ai-studio",
        "gemini-3.5-flash-lite",
      ).verification, "compatibility");
    });
  });

  it("mengaktifkan capability hanya untuk deklarasi exact provider + model", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_CHEAP: "model-production-cheap",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("google-ai-studio", "model-testing"),
        explicitProfile("openrouter", "model-production-cheap"),
      ]),
    }), () => {
      const profile = loadAiConfig().modelProfiles.require(
        "google-ai-studio",
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
        explicitProfile("google-ai-studio", "model-asing"),
      ]),
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_PROFILES_UNKNOWN"),
      );
    });

    const duplicate = explicitProfile("google-ai-studio", "model-testing");
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

  it("menolak capability explicit pada provider fallback testing", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL: "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("testing-fallback", "model-cadangan"),
      ]),
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_PROFILES_FALLBACK_UNSUPPORTED"),
      );
    });
  });

  it("menolak capability explicit bila model primary juga dipakai fallback aktif", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_TESTING_FALLBACK_BASE_URL: "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-testing",
      AI_TESTING_FALLBACK_PROVIDER_ID: "google-ai-studio",
      AI_MODEL_PROFILES: JSON.stringify([
        explicitProfile("google-ai-studio", "model-testing"),
      ]),
    }), () => {
      assert.throws(
        () => loadAiConfig(),
        hasCode("CONFIG_AI_MODEL_PROFILES_FALLBACK_UNSUPPORTED"),
      );
    });
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
    GOOGLE_AI_STUDIO_API_KEYS: "google-satu,google-dua",
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
