import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadWebToolsConfig } from "../src/config.js";

const WEB_ENV_KEYS = [
  "WEB_SEARCH_ENABLED",
  "WEB_SEARCH_API_KEY",
  "WEB_SEARCH_TIMEOUT_MS",
  "WEB_OPEN_ENABLED",
  "WEB_OPEN_TIMEOUT_MS",
] as const;

describe("konfigurasi executor web", () => {
  it("mati secara default dan tidak mengekspos key yang hanya tersimpan", () => {
    withWebEnvironment({ WEB_SEARCH_API_KEY: "key-tidak-aktif" }, () => {
      const config = loadWebToolsConfig();
      assert.equal(config.searchApiKey, null);
      assert.equal(config.openEnabled, false);
    });
  });

  it("mengaktifkan search/open secara eksplisit", () => {
    withWebEnvironment({
      WEB_SEARCH_ENABLED: "true",
      WEB_SEARCH_API_KEY: "key-aktif",
      WEB_SEARCH_TIMEOUT_MS: "12000",
      WEB_OPEN_ENABLED: "true",
      WEB_OPEN_TIMEOUT_MS: "9000",
    }, () => {
      assert.deepEqual(loadWebToolsConfig(), {
        searchApiKey: "key-aktif",
        searchTimeoutMs: 12_000,
        openEnabled: true,
        openTimeoutMs: 9_000,
      });
    });
  });

  it("menolak search aktif tanpa key dan timeout berlebihan", () => {
    withWebEnvironment({ WEB_SEARCH_ENABLED: "true" }, () => {
      assert.throws(
        () => loadWebToolsConfig(),
        hasCode("CONFIG_WEB_SEARCH_API_KEY_MISSING"),
      );
    });
    withWebEnvironment({ WEB_OPEN_TIMEOUT_MS: "60001" }, () => {
      assert.throws(
        () => loadWebToolsConfig(),
        hasCode("CONFIG_WEB_OPEN_TIMEOUT_MS_INVALID"),
      );
    });
  });
});

function withWebEnvironment(
  values: Partial<Record<(typeof WEB_ENV_KEYS)[number], string>>,
  action: () => void,
): void {
  const previous = new Map(
    WEB_ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const key of WEB_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    action();
  } finally {
    for (const key of WEB_ENV_KEYS) {
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
