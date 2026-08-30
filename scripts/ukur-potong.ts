/**
 * Mengukur apakah Harvy benar-benar mengakui ketika ia memotong pengguna.
 *
 * Arahan berbentuk kalimat sering diabaikan model—itu pelajaran berulang di
 * repositori ini. Sinyalnya sendiri milik kode dan sudah dikunci tes; yang
 * hanya dapat diukur dengan model nyata adalah apakah arahannya dipatuhi.
 *
 *   npx tsx scripts/ukur-potong.ts [--ulang=5]
 */
import { Conversation } from "../src/ai/conversation.js";
import { NO_RISK_HINT } from "../src/core/safety-policy.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

const BALASAN_SEBELUMNYA =
  "Dua tenggat barengan memang bikin pusing. Coba mulai dari yang paling dekat, lalu pecah jadi bagian kecil biar nggak numpuk.";
const SAMBUNGAN = "yang biologi sama yang sejarah, aku harus gimana ya";

const MENGAKUI =
  /\b(?:keburu|kecepetan|kepotong|motong|memotong|belum selesai|nyela|menyela|terlalu cepat)\b/iu;

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const repeats = Number.parseInt(argument("--ulang=") ?? "5", 10) || 5;
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "probe");
  const conversation = new Conversation(
    client,
    config.ai,
    config.defaultTimezone,
  );

  const context = {
    summary: null,
    turns: [
      { role: "user" as const, text: "eh btw, besok ada dua deadline barengan", at: new Date().toISOString() },
      { role: "harvy" as const, text: BALASAN_SEBELUMNYA, at: new Date().toISOString() },
    ],
    memories: [],
  };

  for (const premature of [true, false]) {
    let mengakui = 0;
    console.log(`\n=== prematureReply: ${premature} ===`);
    for (let i = 0; i < repeats; i += 1) {
      const reply = await conversation.reply(
        SAMBUNGAN,
        {
          intent: "question",
          taskAction: null,
          memoryAction: null,
          riskHint: NO_RISK_HINT,
          safetySensitive: false,
          needsStepByStep: false,
          task: null,
          memories: [],
        },
        context,
        null,
        undefined,
        null,
        false,
        {
          ownerId: "ukur",
          channel: "telegram",
          timeZone: config.defaultTimezone,
          ...(premature ? { prematureReply: true } : {}),
        },
      );
      const hit = MENGAKUI.test(reply);
      if (hit) mengakui += 1;
      console.log(`  ${hit ? "AKUI " : "diam "} ${reply.replace(/\s+/gu, " ").slice(0, 90)}`);
    }
    console.log(`  -> mengakui ${mengakui} dari ${repeats}`);
  }
}

await main();
