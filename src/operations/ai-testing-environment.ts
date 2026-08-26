import { chmod, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { writeDurableFileAtomic } from "../storage/durable-file.js";

const GMI_BASE_URL = "https://api.gmi-serving.com/v1";
const GMI_MODEL = "MiniMaxAI/MiniMax-M3";
const RETIRED_KEYS = new Set([
  "GOOGLE_AI_STUDIO_API_KEYS",
  "AI_TESTING_FALLBACK_BASE_URL",
  "AI_TESTING_FALLBACK_API_KEY",
  "AI_TESTING_FALLBACK_MODEL",
  "AI_TESTING_FALLBACK_PROVIDER_ID",
  "AI_TESTING_FALLBACK_COOLDOWN_MS",
]);
const MANAGED_KEYS = new Set([
  ...RETIRED_KEYS,
  "GMI_API_KEY",
  "AI_MODEL_TESTING",
  "AI_BASE_URL",
]);
const LEGACY_COMMENT_REPLACEMENTS = new Map<string, string>([
  [
    "# testing    = satu model gratis lewat Google AI Studio",
    "# testing    = satu model lewat GMI Serving, tanpa provider fallback",
  ],
  [
    "# testing    = satu model default lewat Google AI Studio",
    "# testing    = satu model default lewat GMI Serving, tanpa provider fallback",
  ],
  [
    "# --- Mode testing: Google AI Studio ---",
    "# --- Mode testing: GMI Serving ---",
  ],
  [
    "# Boleh lebih dari satu kunci, dipisah koma. Kunci dipakai bergantian agar",
    "# Endpoint OpenAI-compatible bawaan: https://api.gmi-serving.com/v1",
  ],
  [
    "# kuota gratis tidak cepat habis saat pengembangan.",
    "# Simpan satu key GMI hanya secara lokal; jangan masukkan ke Git atau chat.",
  ],
]);
const RETIRED_COMMENT_LINES = new Set([
  "# Cadangan khusus testing; file ini diabaikan Git.",
  "# Opsional: provider cadangan khusus mode testing. Ketiganya harus diisi",
  "# bersama. Base URL tidak boleh memuat /chat/completions, query, atau API key.",
  "# Harvy mengirim key lewat Authorization: Bearer dan model lewat body+query.",
  "# Setelah timeout/gangguan provider-wide atau 429 pada seluruh key, primary",
  "# dilewati sementara selama cooldown agar burst tidak mengulang kegagalan sama.",
  "# Request yang sama dapat diterima primary lalu dikirim lagi ke cadangan.",
  "# Verifikasi privasi/retensi gateway sebelum memakai selain data uji/dogfood.",
  "# ID ini adalah label ledger/Console, bukan tebakan dari URL provider.",
]);
const ASSIGNMENT = /^\uFEFF?\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/u;

export interface AiTestingEnvironmentMigration {
  contents: string;
  removedLegacyEntries: number;
  rewrittenLegacyComments: number;
  gmiKeyEntryCreated: boolean;
}

/**
 * Retire provider testing lama tanpa pernah mengembalikan atau mencetak secret.
 * Nilai GMI yang sudah ada dipertahankan; key baru sengaja dibiarkan kosong
 * agar operator memasukkannya sendiri lewat boundary lokal.
 */
export function migrateAiTestingEnvironmentContents(
  contents: string,
): AiTestingEnvironmentMigration {
  let parsed: NodeJS.ProcessEnv;
  try {
    parsed = parseEnv(contents);
  } catch {
    throw migrationError(
      "AI_TESTING_ENVIRONMENT_INVALID",
      "Berkas environment tidak dapat dibaca dengan aman.",
    );
  }
  if ((parsed.AI_MODE ?? "testing").trim() !== "testing") {
    throw migrationError(
      "AI_TESTING_ENVIRONMENT_MODE_CONFLICT",
      "Migrasi GMI hanya boleh dijalankan ketika AI_MODE=testing.",
    );
  }

  const lines = contents.split(/\r?\n/u);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key && MANAGED_KEYS.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const key of ["GMI_API_KEY", "AI_MODEL_TESTING", "AI_BASE_URL"]) {
    if ((counts.get(key) ?? 0) > 1) {
      throw migrationError(
        "AI_TESTING_ENVIRONMENT_AMBIGUOUS",
        `Berkas environment memuat ${key} lebih dari sekali.`,
      );
    }
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/u.test(contents);
  const hasGmiKey = (counts.get("GMI_API_KEY") ?? 0) === 1;
  let gmiKeyEntryCreated = false;
  let modelWritten = false;
  let baseUrlWritten = false;
  let removedLegacyEntries = 0;
  let rewrittenLegacyComments = 0;
  const migrated: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const replacement = LEGACY_COMMENT_REPLACEMENTS.get(trimmed);
    if (replacement) {
      const indentation = /^\s*/u.exec(line)?.[0] ?? "";
      migrated.push(`${indentation}${replacement}`);
      rewrittenLegacyComments++;
      continue;
    }
    if (RETIRED_COMMENT_LINES.has(trimmed)) {
      rewrittenLegacyComments++;
      continue;
    }
    const key = ASSIGNMENT.exec(line)?.[1] ?? null;
    if (key && RETIRED_KEYS.has(key)) {
      removedLegacyEntries++;
      if (
        key === "GOOGLE_AI_STUDIO_API_KEYS" &&
        !hasGmiKey && !gmiKeyEntryCreated
      ) {
        migrated.push("GMI_API_KEY=");
        gmiKeyEntryCreated = true;
      }
      continue;
    }
    if (key === "AI_MODEL_TESTING") {
      migrated.push(`AI_MODEL_TESTING=${GMI_MODEL}`);
      modelWritten = true;
      continue;
    }
    if (key === "AI_BASE_URL") {
      migrated.push(`AI_BASE_URL=${GMI_BASE_URL}`);
      baseUrlWritten = true;
      continue;
    }
    migrated.push(line);
  }

  if (finalNewline && migrated.at(-1) === "") migrated.pop();
  if (!hasGmiKey && !gmiKeyEntryCreated) {
    migrated.push("GMI_API_KEY=");
    gmiKeyEntryCreated = true;
  }
  if (!modelWritten) migrated.push(`AI_MODEL_TESTING=${GMI_MODEL}`);
  if (!baseUrlWritten) migrated.push(`AI_BASE_URL=${GMI_BASE_URL}`);
  const rewritten = migrated.join(newline);
  return {
    contents: finalNewline ? `${rewritten}${newline}` : rewritten,
    removedLegacyEntries,
    rewrittenLegacyComments,
    gmiKeyEntryCreated,
  };
}

export async function migrateAiTestingEnvironmentFile(
  fileInput = ".env",
): Promise<Omit<AiTestingEnvironmentMigration, "contents">> {
  const file = resolve(fileInput);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw migrationError(
      "AI_TESTING_ENVIRONMENT_FILE_UNSAFE",
      "Berkas environment harus regular file tanpa link lain.",
    );
  }
  const result = migrateAiTestingEnvironmentContents(
    await readFile(file, "utf8"),
  );
  await writeDurableFileAtomic(file, result.contents);
  await chmod(file, 0o600).catch(() => undefined);
  return {
    removedLegacyEntries: result.removedLegacyEntries,
    rewrittenLegacyComments: result.rewrittenLegacyComments,
    gmiKeyEntryCreated: result.gmiKeyEntryCreated,
  };
}

function migrationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
