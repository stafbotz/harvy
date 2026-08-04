/**
 * Probe Agent Runtime v1 langsung ke model, tanpa Telegram atau data pengguna.
 *
 * Kasusnya sengaja sintetis: satu root tools yang harus memakai terminal
 * virtual, lalu satu root orchestrate dengan tiga subpekerjaan independen.
 * Trace yang dicetak hanya nama capability/status, tidak pernah credential,
 * observation mentah, memori, atau riwayat.
 *
 *   npx tsx scripts/coba-agent.ts
 *   npx tsx scripts/coba-agent.ts --allow-fallback
 */
import { Conversation } from "../src/ai/conversation.js";
import { createModelAgentWorker } from "../src/ai/agent.js";
import { ParallelDelegationExecutor } from "../src/agent/parallel-delegation.js";
import { VirtualTerminalExecutor } from "../src/agent/virtual-terminal.js";
import { loadConfig } from "../src/config.js";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentRunResult,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";

const allowFallback = process.argv.slice(2).includes("--allow-fallback");
const config = loadConfig();
const client = await createInstrumentedAiClient(config, "probe", allowFallback);
let agendaDays: number | null = null;
const syntheticAgenda: AgentCapabilityExecutor<{
  days: number;
  localDate?: string;
}> = {
  capabilityId: "calendar.agenda",
  capabilityVersion: "1",
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
const harness = new AgentHarness(createHarvyCapabilityCatalog({
  internalToolsInstalled: true,
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
  ],
);

console.log(`Mode    : ${config.ai.mode}`);
console.log(`Fallback: ${allowFallback && config.ai.fallback ? "aktif" : "nonaktif"}`);
console.log("Data    : sintetis; tanpa memori, riwayat, atau state pengguna");

const simple = await conversation.agent(
  "Gunakan terminal virtual untuk menghitung (17 + 25) * 3, lalu jawab hasilnya.",
  "tools",
  { summary: null, turns: [], memories: [] },
  { ownerId: "probe-agent", channel: "telegram", intent: "request" },
);
const simplePassed = report("root tools", simple, "terminal.run");

const complex = await conversation.agent(
  [
    "Rencanakan panduan memilih metode belajar untuk ujian.",
    "Sebelum sintesis, delegasikan paralel tepat tiga subpekerjaan independen:",
    "buat opsi metode, nilai risiko tiap opsi, dan susun kriteria keputusan.",
    "Setelah ketiganya selesai, gabungkan menjadi jawaban ringkas.",
  ].join(" "),
  "orchestrate",
  { summary: null, turns: [], memories: [] },
  { ownerId: "probe-agent", channel: "telegram", intent: "request" },
);
const complexPassed = report(
  "root orchestrate",
  complex,
  "agent.delegate.parallel",
);

const agenda = await conversation.agent(
  "Lihat agendaku besok. Sebutkan hanya acara pada tanggal lokal besok.",
  "tools",
  { summary: null, turns: [], memories: [] },
  {
    ownerId: "probe-agent",
    channel: "telegram",
    intent: "question",
    timeZone: "Asia/Jakarta",
  },
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

if (!simplePassed || !complexPassed || !agendaPassed) process.exitCode = 2;

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
  if (result.status === "stopped") console.log(`Alasan    : ${result.reason}`);
  return passed;
}
