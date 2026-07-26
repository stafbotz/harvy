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
import { AiClient } from "../src/ai/client.js";
import { understandingInput, understandingPrompt } from "../src/ai/persona.js";
import { parseUnderstanding } from "../src/ai/understand.js";
import { loadConfig } from "../src/config.js";

const message = process.argv.slice(2).join(" ").trim();

if (!message) {
  console.error('Pakai: npx tsx scripts/coba-pemahaman.ts "kalimat kamu"');
  process.exit(1);
}

const config = loadConfig();
const client = new AiClient({
  baseUrl: config.ai.baseUrl,
  keys: config.ai.keys,
});

const model =
  config.ai.mode === "testing" ? config.ai.testingModel : config.ai.models.cheap;

console.log(`Mode    : ${config.ai.mode}`);
console.log(`Model   : ${model}`);
console.log(`Pesan   : ${message}`);
console.log("");

const raw = await client.complete({
  model,
  temperature: 0,
  maxTokens: 400,
  json: true,
  messages: [
    {
      role: "system",
      content: understandingPrompt(new Date(), config.defaultTimezone),
    },
    { role: "user", content: understandingInput(message) },
  ],
});

console.log("--- balasan mentah model ---");
console.log(raw);
console.log("--- hasil pembacaan ---");

const understanding = parseUnderstanding(raw);

if (!understanding) {
  console.log(
    "GAGAL DIBACA. Harvy akan menjawab 'aku belum menangkap maksudnya'.",
  );
  // Bukan process.exit(): mematikan proses saat handle async masih menutup
  // memicu assertion libuv di Windows, dan pesannya menutupi hasil di atas.
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(understanding, null, 2));
}
