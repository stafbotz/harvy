/**
 * Probe Agent Runtime v1 langsung ke model, tanpa Telegram atau data pengguna.
 *
 * Kasusnya sengaja sintetis: satu root tools yang harus memakai terminal
 * virtual, satu root orchestrate dengan tiga subpekerjaan independen, satu
 * pembacaan agenda, dan satu pencarian riwayat.
 *
 * Katalog capability-nya dijaga sama dengan `src/app.ts` supaya yang diukur di
 * sini adalah pilihan yang benar-benar dihadapi Harvy di produksi. Riwayat dan
 * catatan yang dipakai tool recall berasal dari korpus sintetis di
 * `synthetic-recall.ts`, bukan dari data pengguna mana pun.
 *
 * Trace yang dicetak hanya nama capability/status, tidak pernah credential,
 * observation mentah, memori, atau riwayat.
 *
 *   npx tsx scripts/coba-agent.ts
 */
import { Conversation } from "../src/ai/conversation.js";
import { createModelAgentWorker } from "../src/ai/agent.js";
import { ParallelDelegationExecutor } from "../src/agent/parallel-delegation.js";
import { VirtualTerminalExecutor } from "../src/agent/virtual-terminal.js";
import { createMemoryAgentExecutors } from "../src/agent/memory-executors.js";
import { loadConfig } from "../src/config.js";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentRunResult,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import { retryAgentRun } from "./probe-retry.js";
import {
  createSyntheticHistorySearch,
  createSyntheticMemoryStore,
  SYNTHETIC_CONSENT,
} from "./synthetic-recall.js";
import type { MemoryItem } from "../src/domain/memory.js";

const config = loadConfig();
const client = await createInstrumentedAiClient(config, "probe");
let agendaDays: number | null = null;
const syntheticAgenda: AgentCapabilityExecutor<{
  days: number;
  localDate?: string;
}> = {
  capabilityId: "calendar.agenda",
  capabilityVersion: "1",
  // Tanpa schema ini seluruh run di proses ini berhenti pada langkah pertama.
  // `agentNativeTools` melempar begitu satu capability callable tidak punya
  // schema, dan harness menamainya `invalid_planner_output`—sehingga empat
  // kasus di berkas ini pernah terbaca sebagai "model tidak dapat menyusun
  // langkah" padahal penyebabnya ada di baris ini.
  nativeTool: {
    name: "harvy_calendar_agenda_v1",
    description:
      "Baca agenda pengguna beberapa hari ke depan beserta tenggat yang jatuh di dalamnya.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["days"],
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 31,
          description: "Jumlah hari ke depan yang dibaca, dihitung dari hari ini.",
        },
        localDate: {
          type: "string",
          description: "Tanggal lokal acuan dalam format YYYY-MM-DD bila perlu dibatasi.",
        },
      },
    },
  },
  validate(input) {
    const days = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).days
      : null;
    const localDate = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).localDate
      : null;
    return Number.isInteger(days) && (days as number) >= 1 && (days as number) <= 31
      ? {
          ok: true,
          value: {
            days: days as number,
            ...(typeof localDate === "string" ? { localDate } : {}),
          },
        }
      : { ok: false, reason: "days harus 1–31" };
  },
  execute: async (input) => {
    agendaDays = input.days;
    return {
      status: "ok",
      summary: JSON.stringify({
        kind: "calendar.agenda.result",
        source: "synthetic_probe",
        externalCalendar: false,
        days: input.days,
        localDate: input.localDate ?? null,
        timeZone: "Asia/Jakarta",
        from: "2026-08-04T05:00:00.000Z",
        through: "2026-08-06T05:00:00.000Z",
        events: [
          {
            kind: "due",
            local: "Selasa, 4 Agustus 2026 pukul 16.00",
            label: "RAPIKAN_MEJA_HARI_INI",
          },
          {
            kind: "due",
            local: "Rabu, 5 Agustus 2026 pukul 09.00",
            label: "UJIAN_BIOLOGI_BESOK",
          },
          {
            kind: "due",
            local: "Kamis, 6 Agustus 2026 pukul 07.00",
            label: "LATIHAN_LARI_LUSA",
          },
        ],
      }),
    };
  },
};
// Catatan yang ditulis probe lewat `memory.remember` hidup di array ini saja.
const probeNotes: MemoryItem[] = [];
const harness = new AgentHarness(createHarvyCapabilityCatalog({
  internalToolsInstalled: true,
  recallToolsInstalled: true,
  virtualTerminalInstalled: true,
  parallelDelegationInstalled: true,
}));
const conversation = new Conversation(
  client,
  config.ai,
  config.defaultTimezone,
  () => new Date("2026-08-04T05:00:00.000Z"),
  undefined,
  harness,
  [
    syntheticAgenda,
    new VirtualTerminalExecutor(
      () => new Date("2026-08-04T05:00:00.000Z"),
    ),
    new ParallelDelegationExecutor(createModelAgentWorker(client, config.ai)),
    ...createMemoryAgentExecutors({
      history: () => createSyntheticHistorySearch(),
      memories: createSyntheticMemoryStore(probeNotes, "coba-agent"),
      profiles: SYNTHETIC_CONSENT,
    }),
  ],
);

console.log(`Mode    : ${config.ai.mode}`);
console.log("Fallback: nonaktif");
console.log("Data    : sintetis; riwayat dan catatan dari korpus probe, bukan pengguna");

// Tanpa pengulangan, satu gangguan sesaat provider membuat seluruh kasus
// terbaca sebagai kemampuan yang belum terbukti. Empat kasus di berkas ini
// pernah gagal serentak karena itu.
const simple = await retryAgentRun(() =>
  conversation.agent(
    "Gunakan terminal virtual untuk menghitung (17 + 25) * 3, lalu jawab hasilnya.",
    "tools",
    { summary: null, turns: [], memories: [] },
    { ownerId: "probe-agent", channel: "telegram", intent: "request" },
  )
);
const simplePassed = report("root tools", simple, "terminal.run");

const complex = await retryAgentRun(() =>
  conversation.agent(
    [
    "Rencanakan panduan memilih metode belajar untuk ujian.",
    "Sebelum sintesis, delegasikan paralel tepat tiga subpekerjaan independen:",
    "buat opsi metode, nilai risiko tiap opsi, dan susun kriteria keputusan.",
      "Setelah ketiganya selesai, gabungkan menjadi jawaban ringkas.",
    ].join(" "),
    "orchestrate",
    { summary: null, turns: [], memories: [] },
    { ownerId: "probe-agent", channel: "telegram", intent: "request" },
  )
);
const complexPassed = report(
  "root orchestrate",
  complex,
  "agent.delegate.parallel",
);

const agenda = await retryAgentRun(() =>
  conversation.agent(
    "Lihat agendaku besok. Sebutkan hanya acara pada tanggal lokal besok.",
    "tools",
    { summary: null, turns: [], memories: [] },
    {
      ownerId: "probe-agent",
      channel: "telegram",
      intent: "question",
      timeZone: "Asia/Jakarta",
    },
  )
);
const agendaCapabilityPassed = report("agenda besok", agenda, "calendar.agenda");
const agendaReply = agenda.status === "completed" ? agenda.reply : "";
const agendaPassed =
  agendaCapabilityPassed &&
  agendaDays === 2 &&
  /biologi/iu.test(agendaReply) &&
  !/(?:rapikan|meja|latihan lari|lari)/iu.test(agendaReply);
console.log(`Horizon   : ${agendaDays ?? "tidak terbaca"} hari`);
console.log(`Filter    : ${agendaPassed ? "BESOK SAJA TERBUKTI" : "BELUM TERBUKTI"}`);

// Recall riwayat. Pertanyaannya menunjuk percakapan lama yang tidak ada di
// `turns`, jadi satu-satunya jalan menjawabnya adalah memanggil
// `history.search`. Jawaban yang benar menyebut hal yang saat itu belum
// jelas: format soalnya pilihan ganda atau uraian.
const recall = await retryAgentRun(() =>
  conversation.agent(
    "Dulu aku sempat cerita soal persiapan ujian biologi. Waktu itu ada satu hal yang masih belum jelas buatku. Cari di riwayat percakapan kita, lalu sebutkan hal itu.",
    "tools",
    { summary: null, turns: [], memories: [] },
    { ownerId: "probe-agent", channel: "telegram", intent: "question" },
  )
);
const recallCapabilityPassed = report("recall riwayat", recall, "history.search");
const recallReply = recall.status === "completed" ? recall.reply : "";
const recallPassed = recallCapabilityPassed &&
  /(pilihan ganda|uraian)/iu.test(recallReply);
console.log(`Isi klaim : ${recallPassed ? "TERBACA DARI EPISODE" : "BELUM TERBUKTI"}`);

if (!simplePassed || !complexPassed || !agendaPassed || !recallPassed) {
  process.exitCode = 2;
}

function report(
  label: string,
  result: AgentRunResult,
  expectedCapability: string,
): boolean {
  const executed = result.trace
    .filter((event) => event.phase === "execute")
    .map((event) => `${event.capabilityId}:${event.outcome}`);
  const passed = executed.includes(`${expectedCapability}:ok`);
  console.log("");
  console.log(`--- ${label} ---`);
  console.log(`Status    : ${result.status}`);
  console.log(`Capability: ${executed.join(", ") || "tidak ada"}`);
  console.log(`Ekspektasi: ${expectedCapability} ${passed ? "TERBUKTI" : "BELUM TERBUKTI"}`);
  if (result.status === "completed") console.log(`Balasan   : ${result.reply}`);
  if (result.status === "needs_input") console.log(`Pertanyaan: ${result.prompt}`);
  if (result.status === "stopped") {
    console.log(`Alasan    : ${result.reason}`);
    // "Capability: tidak ada" tidak membedakan planner yang menolak menyusun
    // langkah dari planner yang tidak pernah sampai ke langkah pertama. Jejak
    // fase menjawabnya; ia tidak membawa input tool maupun teks model.
    console.log(`Jejak     : ${
      result.trace.map((event) =>
        `${event.step}:${event.phase}:${event.outcome}`
      ).join(" -> ") || "kosong"
    }`);
  }
  return passed;
}
