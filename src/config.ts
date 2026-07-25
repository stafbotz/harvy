import { resolve } from "node:path";

export interface AppConfig {
  telegramBotToken: string;
  dataFile: string;
  eligibilityDataFile: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  defaultTimezone: string;
  defaultUtcOffset: string;
  reminderIntervalMs: number;
}

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

  const openaiTimeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? "30000");
  if (
    !Number.isFinite(openaiTimeoutMs) ||
    openaiTimeoutMs < 5_000 ||
    openaiTimeoutMs > 120_000
  ) {
    throw new Error("OPENAI_TIMEOUT_MS harus antara 5000 dan 120000.");
  }

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();

  return {
    telegramBotToken,
    dataFile: resolve(process.env.DATA_FILE ?? "./data/tasks.json"),
    eligibilityDataFile: resolve(
      process.env.ELIGIBILITY_DATA_FILE ?? "./data/eligibility.json",
    ),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna",
    openaiTimeoutMs,
    defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Jakarta",
    defaultUtcOffset,
    reminderIntervalMs,
  };
}

function isMissingEnvFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
