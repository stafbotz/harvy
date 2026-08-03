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
  "AI_TESTING_FALLBACK_BASE_URL",
  "AI_TESTING_FALLBACK_API_KEY",
  "AI_TESTING_FALLBACK_MODEL",
  "AI_TESTING_FALLBACK_PROVIDER_ID",
  "AI_TESTING_FALLBACK_COOLDOWN_MS",
  "OPENROUTER_API_KEY",
  "AI_MODEL_CHEAP",
  "AI_MODEL_EFFICIENT",
  "AI_MODEL_AMBITIOUS",
] as const;

describe("konfigurasi fallback AI testing", () => {
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
    });
  });

  it("menginventarisasi seluruh model env tanpa credential", () => {
    withAiEnvironment(validTestingEnvironment({
      AI_MODEL_TESTING_CHEAP: "model-testing-cheap",
      AI_MODEL_CHEAP: "model-production-cheap",
      AI_MODEL_EFFICIENT: "model-production-efficient",
      AI_MODEL_AMBITIOUS: "model-production-ambitious",
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
      AI_TESTING_FALLBACK_BASE_URL:
        "https://fallback.example/api/v3",
      AI_TESTING_FALLBACK_API_KEY: "rahasia-cadangan",
      AI_TESTING_FALLBACK_MODEL: "model-cadangan",
    }, () => {
      assert.equal(loadAiConfig().fallback, null);
    });
  });
});

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
