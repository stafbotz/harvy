/**
 * Mengukur klasifikasi `understand()` pada kalimat berulang, termasuk pesan
 * multi-baris.
 *
 * `coba-pemahaman.ts` menerima kalimatnya lewat argumen baris perintah, dan itu
 * cukup untuk satu kalimat pendek. Untuk pesan multi-baris ia berbahaya: pada
 * 30 Agustus 2026 sebuah pengukuran mengirim hanya baris pertama tanpa keluhan
 * apa pun, menghasilkan pola yang tampak rapi—tiga bentuk permukaan, tiga
 * intent, 3 dari 3 setiap kali—dan satu kesimpulan keliru sempat dipublikasikan
 * di atasnya. Kalimat uji di sini karena itu tertanam di kode, bukan lewat
 * shell.
 *
 * Ulangan wajib. Satu pengukuran tidak membedakan perilaku dari kebetulan;
 * varians antar-run pada extractor ini besar.
 *
 *   npx tsx scripts/ukur-pemahaman.ts
 *   npx tsx scripts/ukur-pemahaman.ts --ulang=5 --kasus=semburan-minta-bantuan
 */
import { resolveModel } from "../src/ai/model-policy.js";
import { understandingInput, understandingPrompt } from "../src/ai/persona.js";
import { parseUnderstanding } from "../src/ai/understand.js";
import { UNDERSTANDING_MAX_TOKENS } from "../src/ai/conversation.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

interface KasusPemahaman {
  id: string;
  /** Baris pesan; digabung dengan newline, persis seperti batcher menggabung bubble. */
  baris: readonly string[];
  catatan: string;
}

const KASUS: readonly KasusPemahaman[] = [
  {
    id: "semburan-minta-bantuan",
    baris: [
      "eh btw",
      "aku baru inget besok ada dua deadline barengan",
      "yang biologi sama yang sejarah, aku harus gimana ya",
    ],
    catatan:
      "Bentuk paling wajar pelajar: mengetik terputus-putus, permintaan di akhir.",
  },
  {
    id: "semburan-tanpa-pembuka",
    baris: [
      "aku baru inget besok ada dua deadline barengan",
      "yang biologi sama yang sejarah, aku harus gimana ya",
    ],
    catatan: "Isi sama tanpa bubble pembuka; memisahkan pengaruh pembuka.",
  },
  {
    id: "satu-baris-minta-bantuan",
    baris: [
      "besok ada dua deadline barengan, biologi sama sejarah, aku harus gimana ya",
    ],
    catatan: "Isi sama dalam satu baris; memisahkan pengaruh bentuk multi-baris.",
  },
  {
    id: "minta-bantuan-eksplisit",
    baris: ["tolong bantu aku menyusun urutan mengerjakan dua tugas yang deadline-nya besok"],
    catatan: "Permintaan yang bentuknya tidak ambigu, sebagai pembanding atas.",
  },
];

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const repeats = Number.parseInt(argument("--ulang=") ?? "3", 10) || 3;
  const requested = new Set(
    (argument("--kasus=") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  );
  const cases = requested.size > 0
    ? KASUS.filter((k) => requested.has(k.id))
    : KASUS;

  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "probe");
  const model = resolveModel("cheap", config.ai);

  console.log(`model  : ${model}`);
  console.log(`ulangan: ${repeats} per kasus`);
  console.log("");

  for (const kasus of cases) {
    const teks = kasus.baris.join("\n");
    const hasil: string[] = [];
    for (let i = 0; i < repeats; i += 1) {
      try {
        const raw = await client.complete({
          model,
          temperature: 0,
          maxTokens: UNDERSTANDING_MAX_TOKENS,
          timeoutMs: 45_000,
          maxAttempts: 1,
          json: true,
          messages: [
            { role: "system", content: understandingPrompt(new Date(), config.defaultTimezone) },
            { role: "user", content: understandingInput(teks) },
          ],
        });
        const parsed = parseUnderstanding(raw);
        hasil.push(
          parsed
            ? `${parsed.intent}/${parsed.routingAssessment?.toolNeed ?? "-"}`
            : "tak-terbaca",
        );
      } catch {
        hasil.push("gagal");
      }
    }
    console.log(`${kasus.id}`);
    console.log(`  ${kasus.baris.length} baris — ${kasus.catatan}`);
    console.log(`  intent/toolNeed: ${hasil.join("  ")}`);
    console.log("");
  }
}

await main();
