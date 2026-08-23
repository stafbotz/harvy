/**
 * Menguji pemahaman satu kalimat langsung ke model, tanpa lewat Telegram.
 *
 * Percakapan Harvy tidak dapat dibuktikan gerbang otomatis: tes yang memanggil
 * model sungguhan biayanya tidak dapat diprediksi dan hasilnya tidak dapat
 * diulang. Lihat `docs/engineering/TESTING.md`. Skrip ini mengisi kekosongan
 * itu untuk pemeriksaan manual — terutama saat menyetel prompt, karena ia
 * menampilkan balasan mentah model apa adanya.
 *
 * Perlu `.env` berisi kunci sungguhan. Pakai `AI_MODE=testing` agar gratis.
 *
 *   npx tsx scripts/coba-pemahaman.ts "ingetin aku jam 8 minum obat"
 */
import {
  parseTurnBoundaryDecision,
  TURN_BOUNDARY_MAX_TOKENS,
  TURN_BOUNDARY_TIMEOUT_MS,
  UNDERSTANDING_MAX_TOKENS,
} from "../src/ai/conversation.js";
import {
  dueDateInput,
  dueDatePrompt,
  turnBoundaryInput,
  TURN_BOUNDARY_PROMPT,
  understandingInput,
  understandingPrompt,
} from "../src/ai/persona.js";
import {
  parseDueDate,
  parseUnderstanding,
} from "../src/ai/understand.js";
import {
  resolveModel,
  resolveModelRoute,
} from "../src/ai/model-policy.js";
import { resolveModelProfileById } from "../src/ai/model-profile.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_EXECUTION_POLICY } from "../src/core/execution-policy.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

type DiagnosticPath = "understanding" | "due" | "boundary";

const args = process.argv.slice(2);
const allowFallback = args.includes("--allow-fallback");
const path: DiagnosticPath =
  args.includes("--due")
    ? "due"
    : args.includes("--boundary")
      ? "boundary"
      : "understanding";
const rawMessage = args
  .filter(
    (argument) =>
      !["--due", "--boundary", "--allow-fallback"].includes(argument),
  )
  .join(" ")
  .trim();
const message = rawMessage.replaceAll("\\n", "\n");

if (!message) {
  console.error(
    'Pakai: npx tsx scripts/coba-pemahaman.ts [--due|--boundary] [--allow-fallback] "kalimat kamu"',
  );
  process.exit(1);
}

const config = loadConfig();
const client = await createInstrumentedAiClient(config, "probe", allowFallback);
const modelRoute = path === "understanding"
  ? resolveModelRoute("mechanical", config.ai)
  : {
      tier: "cheap" as const,
      modelId: resolveModel("cheap", config.ai),
    };
const model = modelRoute.modelId;
const maxTokens = path === "boundary"
  ? TURN_BOUNDARY_MAX_TOKENS
  : UNDERSTANDING_MAX_TOKENS;
const execution = DEFAULT_EXECUTION_POLICY.decide({
  tier: modelRoute.tier,
  role: path === "boundary" ? "classifier" : "extractor",
  ...(path === "understanding"
    ? {
        cognitiveRole: "mechanical" as const,
        difficulty: "mechanical" as const,
      }
    : {}),
  workClass: "mechanical",
  profile: resolveModelProfileById(model, config.ai),
  maxOutputTokens: maxTokens,
  deadlineMs: path === "boundary" ? TURN_BOUNDARY_TIMEOUT_MS : 30_000,
});

console.log(`Mode    : ${config.ai.mode}`);
console.log(`Model   : ${model}`);
console.log(
  `Fallback: ${
    allowFallback && config.ai.fallback
      ? `aktif (${config.ai.fallback.model})`
      : "nonaktif"
  }`,
);
console.log(`Jalur   : ${pathLabel(path)}`);
console.log(`Pesan   : ${message}`);
console.log("");

let raw: string | null = null;

try {
  raw = await client.complete({
    model,
    temperature: 0,
    // Harus sama dengan jalur sungguhan. Angka yang lebih kecil membuat skrip
    // ini melaporkan kegagalan yang tidak terjadi pada jalur Harvy.
    maxTokens,
    execution,
    ...(path === "boundary"
      ? { timeoutMs: TURN_BOUNDARY_TIMEOUT_MS, maxAttempts: 1 }
      : {}),
    json: true,
    usage: {
      ownerId: "probe-private",
      tier: modelRoute.tier,
      purpose:
        path === "boundary"
          ? "turn-boundary"
          : path === "due"
            ? "due-date"
            : "understanding",
      safetyCritical: path === "boundary",
      subjectKind: "private",
      channel: "telegram",
    },
    messages: [
      {
        role: "system",
        content: diagnosticPrompt(path, config.defaultTimezone),
      },
      {
        role: "user",
        content: diagnosticInput(path, message),
      },
    ],
  });
} catch (error) {
  console.error(
    "MODEL GAGAL:",
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  if (path === "boundary") {
    console.log(
      "Pada runtime, deadline MessageBatcher tetap memproses bubble yang sudah terkumpul.",
    );
  }
  process.exitCode = 1;
}

if (raw !== null) {
  console.log("--- balasan mentah model ---");
  console.log(raw);
  console.log("--- hasil pembacaan ---");

  const result =
    path === "due"
      ? parseDueDate(raw)
      : path === "boundary"
        ? parseTurnBoundaryDecision(raw)
        : parseUnderstanding(raw);

  if (result === null) {
    console.log(
      path === "due"
        ? "GAGAL DIBACA. Harvy akan meminta waktu ditulis ulang."
        : path === "boundary"
          ? "GAGAL DIBACA. Harvy akan memproses kumpulan bubble saat deadline."
          : "GAGAL DIBACA. Harvy akan menjawab 'aku belum menangkap maksudnya'.",
    );
    // Bukan process.exit(): mematikan proses saat handle async masih menutup
    // memicu assertion libuv di Windows, dan pesannya menutupi hasil di atas.
    process.exitCode = 1;
  } else {
    console.log(
      result instanceof Date
        ? JSON.stringify({ dueAt: result.toISOString() }, null, 2)
        : path === "boundary"
          ? JSON.stringify({ state: result }, null, 2)
          : JSON.stringify(result, null, 2),
    );
  }
}

function pathLabel(path: DiagnosticPath): string {
  switch (path) {
    case "due":
      return "ubah tenggat";
    case "boundary":
      return "batas bubble";
    case "understanding":
      return "pemahaman umum";
  }
}

function diagnosticPrompt(path: DiagnosticPath, timeZone: string): string {
  switch (path) {
    case "due":
      return dueDatePrompt(new Date(), timeZone);
    case "boundary":
      return TURN_BOUNDARY_PROMPT;
    case "understanding":
      return understandingPrompt(new Date(), timeZone);
  }
}

function diagnosticInput(path: DiagnosticPath, message: string): string {
  switch (path) {
    case "due":
      return dueDateInput(message);
    case "boundary":
      return turnBoundaryInput(message);
    case "understanding":
      return understandingInput(message);
  }
}
