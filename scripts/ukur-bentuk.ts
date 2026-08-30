/**
 * Mengukur bentuk balasan pada pesan pendek, dengan dan tanpa `shapeDirective`.
 *
 * Arahan berbentuk kalimat sering diabaikan model—itu pelajaran berulang di
 * repositori ini, dan satu-satunya cara mengetahuinya adalah membandingkan.
 * Yang diukur bukan selera melainkan bentuk: jumlah karakter, ada tidaknya
 * penomoran, dan berapa pertanyaan yang diajukan sebelum menjawab.
 *
 *   npx tsx scripts/ukur-bentuk.ts [--ulang=3]
 */
import { Conversation } from "../src/ai/conversation.js";
import { NO_RISK_HINT } from "../src/core/safety-policy.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

const PESAN: readonly string[] = [
  "aduh besok ada dua deadline barengan",
  "aku bingung mau mulai belajar dari mana",
  "gimana caranya biar nggak gampang ngantuk pas belajar",
];

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function bentuk(reply: string): string {
  const bernomor = /^\s*\d+[.)]\s/mu.test(reply);
  const butir = /^\s*[-•*]\s/mu.test(reply);
  const tanya = (reply.match(/\?/gu) ?? []).length;
  return `${String(reply.length).padStart(4)} char  ${
    bernomor ? "bernomor" : "        "
  }  ${butir ? "butir" : "     "}  ${tanya} tanya`;
}

async function main(): Promise<void> {
  const repeats = Number.parseInt(argument("--ulang=") ?? "3", 10) || 3;
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "probe");
  const conversation = new Conversation(client, config.ai, config.defaultTimezone);
  const understanding = {
    intent: "feeling" as const,
    taskAction: null,
    memoryAction: null,
    riskHint: NO_RISK_HINT,
    safetySensitive: false,
    needsStepByStep: false,
    task: null,
    memories: [],
  };

  for (const pesan of PESAN) {
    console.log(`\n=== ${pesan} ===`);
    for (let i = 0; i < repeats; i += 1) {
      const reply = await conversation.reply(
        pesan,
        understanding,
        { summary: null, turns: [], memories: [] },
        null,
        undefined,
        null,
        false,
        { ownerId: "ukur", channel: "telegram", timeZone: config.defaultTimezone },
      );
      console.log(`  ${bentuk(reply)}  ${reply.replace(/\s+/gu, " ").slice(0, 58)}`);
    }
  }
}

await main();
