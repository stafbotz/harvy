/**
 * Mengukur latensi nyata classifier batas giliran.
 *
 * Sesi Telegram langsung 29 Agustus 2026 mencatat 3 dari 5 giliran berakhir
 * `AbortError` pada `purpose: "turn-boundary"` dengan `timeoutMs: 2000` dan
 * `maxAttempts: 1`. Kegagalannya tidak fatal—batcher memakai keputusan
 * defaultnya—tetapi artinya keputusan penggabungan bubble berbasis model
 * praktis tidak tersedia pada mayoritas giliran, sambil tetap membayar satu
 * request penuh.
 *
 * Menaikkan angkanya tanpa data akan menambah jeda pada setiap giliran yang
 * justru sedang menunggu. Skrip ini mengambil datanya.
 *
 * Permintaannya disusun ulang di sini, bukan lewat `assessTurnBoundary`, karena
 * method itu mengikat `TURN_BOUNDARY_TIMEOUT_MS` di dalamnya: setiap panggilan
 * yang melewati 2 detik akan dibatalkan tepat di 2 detik, sehingga distribusi
 * yang terukur tersensor persis di angka yang sedang dipertanyakan. Prompt,
 * model, tier, batas token, dan bentuk input tetap sama persis—yang berbeda
 * hanya batas waktunya.
 *
 *   npx tsx scripts/ukur-batas-giliran.ts
 *   npx tsx scripts/ukur-batas-giliran.ts --ulang=5
 */
import { resolveModel } from "../src/ai/model-policy.js";
import {
  TURN_BOUNDARY_PROMPT,
  turnBoundaryInput,
} from "../src/ai/persona.js";
import {
  parseTurnBoundaryAssessment,
  TURN_BOUNDARY_MAX_TOKENS,
  TURN_BOUNDARY_TIMEOUT_MS,
} from "../src/ai/conversation.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

/** Batas longgar khusus pengukuran; produksi memakai konstanta nyata. */
const MEASUREMENT_TIMEOUT_MS = 30_000;

/** Kalimat sintetis yang mewakili bentuk giliran nyata, bukan data pengguna. */
const SAMPLES: readonly string[] = [
  "halo",
  "makasih ya",
  "ingetin aku besok jam 7 malam buat ngumpulin tugas biologi",
  "sebutkan tugas aktifku dan kapan pengingatnya",
  "apa aja yang kamu inget tentang aku?",
  "coba cari di riwayat percakapan kita yang lama, dulu aku pernah cerita soal apa aja?",
  "aku bingung mau mulai dari mana, tugasnya numpuk banget",
  "gimana status pekerjaan coding yang lagi jalan?",
];

function argument(prefix: string, fallback: number): number {
  const found = process.argv.find((value) => value.startsWith(prefix));
  if (!found) return fallback;
  const parsed = Number.parseInt(found.slice(prefix.length), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

/**
 * Konteks dan sinyal seperti yang benar-benar dikirim produksi.
 *
 * Pengukuran 30 Agustus 2026 mula-mula memanggil `turnBoundaryInput(sample)`
 * tanpa keduanya, dan menyimpulkan classifier ini cepat: p90 1.775 ms, hanya
 * 6% melewati batas 2 detik. Log sesi nyata mencatat sebaliknya—6 dari 10
 * giliran gagal dengan `aborterror`—karena produksi mengirim empat giliran
 * terakhir dan sinyal timing, sehingga `inputTokenEstimate` mencapai 689-831
 * sedangkan probe hanya mengirim satu kalimat. Alat ukurnya mengukur
 * permintaan yang lebih mudah daripada yang dipertanyakan.
 */
const KONTEKS = {
  turns: [
    {
      role: "user" as const,
      text: "ingetin aku besok jam 7 malam buat ngumpulin tugas biologi",
      at: "2026-08-30T07:20:00.000Z",
    },
    {
      role: "harvy" as const,
      text:
        "Oke, udah masuk daftar. • Ngumpulin tugas biologi — biasa, 31 Agu 2026 19.00, pengingat 31/08/26 19.00",
      at: "2026-08-30T07:20:14.000Z",
    },
    {
      role: "user" as const,
      text: "sebutkan tugas aktifku dan kapan pengingatnya",
      at: "2026-08-30T07:21:00.000Z",
    },
    {
      role: "harvy" as const,
      text:
        "Ini ya tugas aktifmu yang masih tercatat. Tugas aktif: • Ngumpulin tugas biologi — 31 Agu 2026 19.00",
      at: "2026-08-30T07:21:15.000Z",
    },
  ],
};

const SINYAL = {
  bubbleCount: 1,
  sinceFirstMs: 1_200,
  sinceLastMs: 1_200,
  adaptiveTimingUsed: false,
  learnedSettleMs: 800,
  rapidBurst: false,
};

async function main(): Promise<void> {
  const repeats = argument("--ulang=", 3);
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "probe");
  const model = resolveModel("cheap", config.ai);

  console.log(`model    : ${model}`);
  console.log(`sampel   : ${SAMPLES.length} kalimat x ${repeats} ulangan`);
  console.log(
    `batas ukur: ${MEASUREMENT_TIMEOUT_MS}ms (produksi ${TURN_BOUNDARY_TIMEOUT_MS}ms)`,
  );
  console.log("");

  const latencies: number[] = [];
  let invalid = 0;
  let errored = 0;

  for (const sample of SAMPLES) {
    const perSample: number[] = [];
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      const startedAt = Date.now();
      try {
        const raw = await client.complete({
          model,
          temperature: 0,
          maxTokens: TURN_BOUNDARY_MAX_TOKENS,
          timeoutMs: MEASUREMENT_TIMEOUT_MS,
          maxAttempts: 1,
          json: true,
          messages: [
            { role: "system", content: TURN_BOUNDARY_PROMPT },
            {
              role: "user",
              content: turnBoundaryInput(sample, KONTEKS, SINYAL),
            },
          ],
        });
        perSample.push(Date.now() - startedAt);
        if (parseTurnBoundaryAssessment(raw) === null) invalid += 1;
      } catch {
        errored += 1;
        perSample.push(Date.now() - startedAt);
      }
    }
    latencies.push(...perSample);
    const average = Math.round(
      perSample.reduce((sum, value) => sum + value, 0) / perSample.length,
    );
    console.log(
      `${String(average).padStart(6)}ms rata-rata  ${
        perSample.map((value) => `${value}ms`).join(" ").padEnd(26)
      }  ${sample.slice(0, 46)}`,
    );
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const overBudget =
    sorted.filter((value) => value > TURN_BOUNDARY_TIMEOUT_MS).length;
  console.log("");
  console.log(`pengukuran  : ${sorted.length}`);
  console.log(`error       : ${errored}`);
  console.log(`bentuk salah: ${invalid}`);
  console.log(`minimum     : ${sorted[0]}ms`);
  console.log(`p50         : ${percentile(sorted, 0.5)}ms`);
  console.log(`p90         : ${percentile(sorted, 0.9)}ms`);
  console.log(`p99         : ${percentile(sorted, 0.99)}ms`);
  console.log(`maksimum    : ${sorted.at(-1)}ms`);
  console.log("");
  console.log(
    `melewati batas produksi ${TURN_BOUNDARY_TIMEOUT_MS}ms: ${overBudget}/${sorted.length} (${
      Math.round((overBudget / sorted.length) * 100)
    }%)`,
  );
}

await main();
