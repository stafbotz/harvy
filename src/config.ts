import { resolve } from "node:path";
import { ApiKeyPool } from "./ai/key-pool.js";
import type { ModelTier } from "./ai/model-policy.js";

/**
 * `testing` memakai satu model gratis lewat Google AI Studio, dengan beberapa
 * kunci yang dipakai bergantian. `production` memakai tiga model lewat
 * OpenRouter, dipilih menurut kesulitan pekerjaan.
 */
export type AiMode = "testing" | "production";

export interface AiConfig {
  mode: AiMode;
  keys: ApiKeyPool;
  baseUrl: string;
  testingModel: string;
  /**
   * Model uji per tingkatan. Kosong berarti memakai `testingModel`.
   *
   * Tanpa peta ini seluruh routing tidak dapat diamati dalam mode uji: satu
   * model melayani semua tingkatan, sehingga naik-turunnya tier tidak pernah
   * terlihat pada keluaran mana pun.
   */
  testingModels: Partial<Record<ModelTier, string>>;
  models: Record<ModelTier, string>;
}

export interface AppConfig {
  telegramBotToken: string;
  dataFile: string;
  /** Memori terstruktur per pengguna. Lihat `ADR-006`. */
  memoryFile: string;
  /** Folder memori Markdown, satu subfolder per pengguna. */
  memoryFolder: string;
  /** Riwayat percakapan yang sudah dipadatkan. Berisi kata-kata pengguna. */
  historyFile: string;
  /** Status kenalan dan persetujuan per pengguna. */
  profileFile: string;
  defaultTimezone: string;
  defaultUtcOffset: string;
  reminderIntervalMs: number;
  ai: AiConfig;
}

const GOOGLE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function loadConfig(): AppConfig {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!isMissingEnvFile(error)) throw error;
  }

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN belum diisi.");
  }

  const defaultUtcOffset = process.env.DEFAULT_UTC_OFFSET ?? "+07:00";
  if (!/^[+-]\d{2}:\d{2}$/.test(defaultUtcOffset)) {
    throw new Error("DEFAULT_UTC_OFFSET harus seperti +07:00.");
  }

  const reminderIntervalMs = Number(
    process.env.REMINDER_INTERVAL_MS ?? "30000",
  );
  if (!Number.isFinite(reminderIntervalMs) || reminderIntervalMs < 5_000) {
    throw new Error("REMINDER_INTERVAL_MS minimal 5000.");
  }

  return {
    telegramBotToken,
    dataFile: resolve(process.env.DATA_FILE ?? "./data/tasks.json"),
    memoryFile: resolve(process.env.MEMORY_FILE ?? "./data/memories.json"),
    memoryFolder: resolve(process.env.MEMORY_FOLDER ?? "./data/memori"),
    historyFile: resolve(process.env.HISTORY_FILE ?? "./data/history.json"),
    profileFile: resolve(process.env.PROFILE_FILE ?? "./data/profiles.json"),
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Jakarta",
    defaultUtcOffset,
    reminderIntervalMs,
    ai: loadAiConfig(),
  };
}

/**
 * Seluruh ID model dibaca dari environment, tidak ditulis mati di kode.
 *
 * Nama, ketersediaan, dan harga model berubah cepat. Menaruhnya di konfigurasi
 * membuat koreksi cukup satu baris `.env`, tanpa menyentuh kode.
 */
function loadAiConfig(): AiConfig {
  const mode = (process.env.AI_MODE ?? "testing") as AiMode;
  if (mode !== "testing" && mode !== "production") {
    throw new Error("AI_MODE harus testing atau production.");
  }

  const models = {
    cheap: process.env.AI_MODEL_CHEAP?.trim() ?? "",
    efficient: process.env.AI_MODEL_EFFICIENT?.trim() ?? "",
    ambitious: process.env.AI_MODEL_AMBITIOUS?.trim() ?? "",
  } satisfies Record<ModelTier, string>;

  const testingModel = process.env.AI_MODEL_TESTING?.trim() ?? "";
  const testingModels: Partial<Record<ModelTier, string>> = {
    ...(process.env.AI_MODEL_TESTING_CHEAP?.trim()
      ? { cheap: process.env.AI_MODEL_TESTING_CHEAP.trim() }
      : {}),
    ...(process.env.AI_MODEL_TESTING_EFFICIENT?.trim()
      ? { efficient: process.env.AI_MODEL_TESTING_EFFICIENT.trim() }
      : {}),
    ...(process.env.AI_MODEL_TESTING_AMBITIOUS?.trim()
      ? { ambitious: process.env.AI_MODEL_TESTING_AMBITIOUS.trim() }
      : {}),
  };

  if (mode === "testing") {
    const keys = ApiKeyPool.parse(process.env.GOOGLE_AI_STUDIO_API_KEYS);
    if (keys.length === 0) {
      throw new Error(
        "GOOGLE_AI_STUDIO_API_KEYS wajib diisi ketika AI_MODE=testing. " +
          "Beberapa kunci boleh dipisah koma.",
      );
    }
    if (!testingModel) {
      throw new Error("AI_MODEL_TESTING wajib diisi ketika AI_MODE=testing.");
    }

    return {
      mode,
      keys: new ApiKeyPool(keys),
      baseUrl: process.env.AI_BASE_URL?.trim() || GOOGLE_BASE_URL,
      testingModel,
      testingModels,
      models,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY wajib diisi ketika AI_MODE=production.",
    );
  }

  const missing = (Object.keys(models) as ModelTier[]).filter(
    (tier) => !models[tier],
  );
  if (missing.length > 0) {
    throw new Error(
      `Model belum lengkap untuk AI_MODE=production: ${missing.join(", ")}.`,
    );
  }

  return {
    mode,
    keys: new ApiKeyPool([apiKey]),
    baseUrl: process.env.AI_BASE_URL?.trim() || OPENROUTER_BASE_URL,
    testingModel,
    testingModels,
    models,
  };
}

function isMissingEnvFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
