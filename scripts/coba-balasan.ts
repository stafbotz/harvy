/**
 * Menguji balasan Harvy langsung ke model, tanpa lewat Telegram.
 *
 * `coba-pemahaman.ts` hanya menunjukkan bagaimana sebuah kalimat dibaca.
 * Bagaimana Harvy *terdengar* adalah pertanyaan lain, dan sampai skrip ini ada,
 * satu-satunya cara memeriksanya adalah membuka Telegram. Gaya bicara justru
 * bagian yang paling sering disetel, jadi ia perlu jalur pemeriksaan yang murah.
 *
 * Ditampilkan apa adanya: hasil pembacaan, teks balasan mentah, lalu
 * normalisasi dan pemecahan bubble pada lapisan model. Tombol, pending, dan
 * state adapter diuji terpisah lewat create-bot-flow.test.
 *
 * Perlu `.env` berisi kunci sungguhan. Pakai `AI_MODE=testing` agar gratis.
 *
 *   npx tsx scripts/coba-balasan.ts "aku capek banget hari ini"
 *   npx tsx scripts/coba-balasan.ts --riwayat "yang tadi gimana"
 *   npx tsx scripts/coba-balasan.ts --riwayat=percakapan.json "lanjut dong"
 *   npx tsx scripts/coba-balasan.ts --listen "besok ada ulangan biologi"
 */
import { readFileSync } from "node:fs";
import { Conversation } from "../src/ai/conversation.js";
import {
  uncertainTriage,
  withEmergencyAvailability,
} from "../src/ai/safety.js";
import {
  normalizeTelegramText,
  splitReplyBubbles,
} from "../src/bot/messages.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type { StylePreference } from "../src/domain/profile.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--")));
const allowFallback = flags.has("--allow-fallback");
const message = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"))
  .join(" ")
  .trim()
  .replaceAll("\\n", "\n");

if (!message) {
  console.error(
    'Pakai: npx tsx scripts/coba-balasan.ts [--riwayat|--riwayat=file.json] [--listen|--advice] [--allow-fallback] "kalimat kamu"',
  );
  process.exit(1);
}

const style: StylePreference | null = flags.has("--listen")
  ? "listen"
  : flags.has("--advice")
    ? "advice"
    : null;

/**
 * Riwayat bebas: `--riwayat=percakapan.json` berisi [{ "role", "text" }].
 *
 * Tanpa ini, pengulangan pembuka lintas giliran tidak dapat diuji sama sekali:
 * aturan anti-pengulangan hanya hidup ketika riwayatnya memang ada, dan riwayat
 * contoh yang tetap selalu bertema sama.
 */
function customTurns(): ConversationTurn[] | null {
  const flag = [...flags].find((arg) => arg.startsWith("--riwayat="));
  if (!flag) return null;

  const raw = readFileSync(flag.slice("--riwayat=".length), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Berkas riwayat harus array.");

  return parsed.map((entry): ConversationTurn => {
    const turn = entry as { role?: unknown; text?: unknown };
    return {
      role: turn.role === "harvy" ? "harvy" : "user",
      text: String(turn.text ?? ""),
      at: new Date().toISOString(),
    };
  });
}

/** Riwayat contoh, supaya kesinambungan dan pengulangan pembuka ikut terlihat. */
const SAMPLE_TURNS: ConversationTurn[] = [
  {
    role: "user",
    text: "besok aku ulangan biologi dan aku belum belajar sama sekali",
    at: new Date().toISOString(),
  },
  {
    role: "harvy",
    text: "Wah, tinggal sehari ya. Bab mana yang paling bikin pusing?",
    at: new Date().toISOString(),
  },
];

const config = loadConfig();
const conversation = new Conversation(
  await createInstrumentedAiClient(config, "probe", allowFallback),
  config.ai,
  config.defaultTimezone,
  undefined,
  undefined,
  new AgentHarness(createHarvyCapabilityCatalog({
    internalToolsInstalled: true,
    virtualTerminalInstalled: true,
    parallelDelegationInstalled: true,
  })),
);

const context = {
  summary: null,
  turns: customTurns() ?? (flags.has("--riwayat") ? SAMPLE_TURNS : []),
  memories: [],
};

console.log(`Mode    : ${config.ai.mode}`);
console.log(
  `Fallback: ${
    allowFallback && config.ai.fallback
      ? `aktif (${config.ai.fallback.model})`
      : "nonaktif"
  }`,
);
console.log(`Gaya    : ${style ?? "belum ditentukan"}`);
console.log(`Riwayat : ${context.turns.length} giliran contoh`);
console.log(`Pesan   : ${message}`);
console.log("");

const [understanding, assessedRisk] = await Promise.all([
  conversation.understand(message, context, { ownerId: "probe-private" }),
  conversation.triageRisk(message, "probe-private", context),
]);

if (!understanding) {
  console.error(
    "GAGAL DIBACA. Harvy akan minta pesannya ditulis ulang, tanpa membalas.",
  );
  process.exitCode = 1;
} else {
  console.log("--- hasil pembacaan ---");
  console.log(JSON.stringify(understanding, null, 2));

  // Triase dijalankan persis seperti pada jalur sungguhan. Tanpa ini skrip
  // memeriksa Harvy yang tidak pernah ada: seluruh arahan keselamatan hidup
  // dari hasil triase, dan probe tanpa triase akan selalu terlihat baik.
  const triage = assessedRisk ?? uncertainTriage(understanding.safetySensitive);
  console.log("");
  console.log("--- triase risiko ---");
  console.log(JSON.stringify(triage, null, 2));

  let reply = await conversation.reply(
    message,
    understanding,
    context,
    style,
    triage,
    null,
    false,
    { ownerId: "probe-private" },
  );
  reply = withEmergencyAvailability(normalizeTelegramText(reply), triage);

  console.log("");
  console.log("--- balasan mentah model ---");
  console.log(reply);
  console.log("");
  console.log("--- bentuk model setelah normalisasi Telegram ---");

  for (const [index, bubble] of splitReplyBubbles(reply).entries()) {
    console.log(`[bubble ${index + 1}] ${bubble}`);
  }

  if (triage.level !== "biasa") {
    const verdict = await conversation.reviewReply(
      message,
      reply,
      triage,
      "probe-private",
      context,
    );
    console.log("");
    console.log(
      `--- pemeriksaan balasan: ${
        verdict === null ? "GAGAL DIBACA" : verdict ? "aman" : "DITOLAK"
      } ---`,
    );
  }
}
