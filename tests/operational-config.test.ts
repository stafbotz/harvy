import assert from "node:assert/strict";
import { parse, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadOperationalLogConfig } from "../src/config.js";

const LOG_ENVIRONMENT_KEYS = [
  "APP_ENV",
  "RELEASE_SHA",
  "LOG_FOLDER",
  "LOG_LEVEL",
  "LOG_RETENTION_DAYS",
  "LOG_MAX_FILE_BYTES",
  "LOG_MAX_TOTAL_BYTES",
  "LOG_QUEUE_MAX_RECORDS",
  "LOG_QUEUE_MAX_BYTES",
  "LOG_CONSOLE",
  "LOG_CONSOLE_FORMAT",
  "LOG_FILE_REQUIRED",
] as const;

describe("konfigurasi log operasional", () => {
  it("membaca seluruh batas produksi secara eksplisit", () => {
    withLogEnvironment(
      {
        APP_ENV: "production",
        RELEASE_SHA: "release-abc123",
        LOG_FOLDER: "./data/log-test-config",
        LOG_LEVEL: "warn",
        LOG_RETENTION_DAYS: "9",
        LOG_MAX_FILE_BYTES: "4096",
        LOG_MAX_TOTAL_BYTES: "16384",
        LOG_QUEUE_MAX_RECORDS: "99",
        LOG_QUEUE_MAX_BYTES: "8192",
        LOG_CONSOLE: "false",
        LOG_CONSOLE_FORMAT: "json",
        LOG_FILE_REQUIRED: "true",
      },
      () => {
        assert.deepEqual(loadOperationalLogConfig(), {
          directory: resolve("./data/log-test-config"),
          level: "warn",
          environment: "production",
          release: "release-abc123",
          retentionDays: 9,
          maxSegmentBytes: 4096,
          maxTotalBytes: 16384,
          maxQueueRecords: 99,
          maxQueueBytes: 8192,
          consoleEnabled: false,
          consoleFormat: "json",
          fileRequired: true,
        });
      },
    );
  });

  it("memberi kode stabil untuk konfigurasi yang tidak sah", () => {
    withLogEnvironment(
      validEnvironment({ LOG_LEVEL: "ramai" }),
      () => {
        assert.throws(
          () => loadOperationalLogConfig(),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code ===
              "CONFIG_LOG_LEVEL_INVALID",
        );
      },
    );

    withLogEnvironment(
      validEnvironment({ LOG_FOLDER: parse(process.cwd()).root }),
      () => {
        assert.throws(
          () => loadOperationalLogConfig(),
          (error: unknown) =>
            error instanceof Error &&
            (error as Error & { code?: string }).code ===
              "CONFIG_LOG_FOLDER_ROOT",
        );
      },
    );
  });
});

function validEnvironment(
  overrides: Partial<Record<(typeof LOG_ENVIRONMENT_KEYS)[number], string>>,
): Record<(typeof LOG_ENVIRONMENT_KEYS)[number], string> {
  return {
    APP_ENV: "test",
    RELEASE_SHA: "test",
    LOG_FOLDER: "./data/log-test-config",
    LOG_LEVEL: "info",
    LOG_RETENTION_DAYS: "14",
    LOG_MAX_FILE_BYTES: "4096",
    LOG_MAX_TOTAL_BYTES: "16384",
    LOG_QUEUE_MAX_RECORDS: "99",
    LOG_QUEUE_MAX_BYTES: "8192",
    LOG_CONSOLE: "false",
    LOG_CONSOLE_FORMAT: "json",
    LOG_FILE_REQUIRED: "false",
    ...overrides,
  };
}

function withLogEnvironment(
  values: Partial<Record<(typeof LOG_ENVIRONMENT_KEYS)[number], string>>,
  action: () => void,
): void {
  const previous = new Map(
    LOG_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const key of LOG_ENVIRONMENT_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    action();
  } finally {
    for (const key of LOG_ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
