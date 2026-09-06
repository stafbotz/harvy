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
 *   npx tsx scripts/coba-agent.ts --kasus=recall --ulangi=12
 *
 * `--kasus` membatasi ke satu kasus, dan `--ulangi` mengulanginya. Keduanya
 * ada untuk kasus recall, yang kegagalannya **tidak** biner: satu run yang
 * meleset bisa berarti Harvy jujur tidak menemukan, atau Harvy menjahit dua
 * percakapan berbeda menjadi satu ingatan yang tidak pernah terjadi. Kelas
 * kedua itu jauh lebih merugikan, dan hanya terlihat bila hasilnya dihitung
 * dari beberapa run, bukan dinilai lulus/gagal sekali jalan.
 */
import { Conversation } from "../src/ai/conversation.js";
import { createModelAgentWorker } from "../src/ai/agent.js";
import { ParallelDelegationExecutor } from "../src/agent/parallel-delegation.js";
import { VirtualTerminalExecutor } from "../src/agent/virtual-terminal.js";
import {
  createMemoryAgentExecutors,
  type AgentHistorySearch,
} from "../src/agent/memory-executors.js";
import { loadConfig } from "../src/config.js";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentRunResult,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import {
  createStderrOperationalLogger,
  type StderrLogEvent,
} from "./stderr-operational-logger.js";
import { retryAgentRun } from "./probe-retry.js";
import {
  createSyntheticHistorySearch,
  createSyntheticMemoryStore,
  SYNTHETIC_CONSENT,
} from "./synthetic-recall.js";
import type { MemoryItem } from "../src/domain/memory.js";

const config = loadConfig();
const client = await createInstrumentedAiClient(config, "probe");

function argumen(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const kasus = argumen("--kasus=")?.trim() || "semua";
const ulangi = Math.max(1, Number(argumen("--ulangi=") ?? "1") || 1);
const jalankan = (nama: string): boolean => kasus === "semua" || kasus === nama;

/**
 * Kueri yang benar-benar disusun planner, bukan yang diketik pengguna.
 *
 * Kegagalan peringkat dan kegagalan penyusunan kueri terlihat sama persis dari
 * luar—keduanya hanya "jawabannya meleset". Merekamnya memisahkan keduanya.
 */
const kueriRiwayat: { query: string; aspect: string | null }[] = [];
const perekamRiwayat = (): AgentHistorySearch => {
  const dasar = createSyntheticHistorySearch();
  return {
    async search(ownerId, query, options) {
      kueriRiwayat.push({ query, aspect: options?.aspect ?? null });
      return dasar.search(ownerId, query, options);
    },
  };
};
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
/**
 * Kejadian yang hanya dijelaskan lewat log dihitung di sini, bukan ditebak dari
 * balasan. Perbaikan bentuk tool, misalnya, tidak terlihat sama sekali pada
 * hasil run: ia hanya membuat run lebih mahal, dan kadang membuatnya mati.
 */
const kejadianLog: StderrLogEvent[] = [];
const conversation = new Conversation(
  client,
  config.ai,
  config.defaultTimezone,
  () => new Date("2026-08-04T05:00:00.000Z"),
  createStderrOperationalLogger(
    "coba-agent",
    "warn",
    (entry) => kejadianLog.push(entry),
  ),
  harness,
  [
    syntheticAgenda,
    new VirtualTerminalExecutor(
      () => new Date("2026-08-04T05:00:00.000Z"),
    ),
    new ParallelDelegationExecutor(createModelAgentWorker(client, config.ai)),
    ...createMemoryAgentExecutors({
      history: perekamRiwayat,
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
let simplePassed = true;
if (jalankan("terminal")) {
  const simple = await retryAgentRun(() =>
    conversation.agent(
      "Gunakan terminal virtual untuk menghitung (17 + 25) * 3, lalu jawab hasilnya.",
      "tools",
      { summary: null, turns: [], memories: [] },
      { ownerId: "probe-agent", channel: "telegram", intent: "request" },
    )
  );
  simplePassed = report("root tools", simple, "terminal.run");
}

let complexPassed = true;
if (jalankan("delegasi")) {
  const kelasTool = new Map<string, number>();
  for (let percobaan = 1; percobaan <= ulangi; percobaan += 1) {
    kejadianLog.length = 0;
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
    complexPassed = report(
      ulangi > 1 ? `root orchestrate ${percobaan}/${ulangi}` : "root orchestrate",
      complex,
      "agent.delegate.parallel",
    ) && (percobaan === 1 || complexPassed);
    // Delegasi dicabut dari daftar callable sesudah langkah pertama, sementara
    // transcript native masih memuat panggilan model sendiri kepadanya. Kalau
    // model menirunya, kode menolak dengan `unknown_tool` dan membayar satu
    // perbaikan penuh. Kelasnya dihitung di sini, bukan ditebak.
    for (const kejadian of kejadianLog) {
      if (kejadian.event !== "agent_tool_shape_repair") continue;
      const kelas = String(
        kejadian.fields["toolClass"] ?? kejadian.fields["reason"] ?? "?",
      );
      kelasTool.set(kelas, (kelasTool.get(kelas) ?? 0) + 1);
    }
    if (kejadianLog.length > 0) {
      console.log(`Log       : ${
        kejadianLog.map((entry) =>
          `${entry.event}(${
            String(entry.fields["toolClass"] ?? entry.fields["reason"] ?? "")
          })`
        ).join(", ")
      }`);
    }
  }
  if (ulangi > 1) {
    console.log("");
    console.log("--- rekap root orchestrate ---");
    console.log(`Percobaan   : ${ulangi}`);
    console.log(`Tool ditolak: ${
      [...kelasTool].map(([kelas, jumlah]) => `${kelas}=${jumlah}`).join(", ") ||
        "tidak ada"
    }`);
  }
}

/**
 * Provokasi langsung terhadap celah yang menjatuhkan satu run sungguhan.
 *
 * Kasus `delegasi` biasa tidak pernah menghasilkan `unknown_tool` dalam 20 run,
 * karena tidak ada yang mendorong model memanggil delegasi untuk kedua kalinya.
 * Di sini permintaannya yang mendorong: sesudah tiga subpekerjaan selesai,
 * pengguna meminta satu putaran delegasi lagi—persis pada langkah ketika
 * `agent.delegate.parallel` sudah dicabut dari daftar callable, sementara
 * transcript masih memperlihatkan panggilan pertamanya berhasil.
 *
 * Yang dihitung hanya golongan tool yang ditolak. Jawaban akhirnya tidak
 * dinilai: model yang jujur mengatakan ia tidak bisa mendelegasikan lagi sama
 * berhasilnya dengan model yang langsung menyusun sendiri.
 */
if (jalankan("delegasi-ulang")) {
  const kelasTool = new Map<string, number>();
  const status = new Map<string, number>();
  for (let percobaan = 1; percobaan <= ulangi; percobaan += 1) {
    kejadianLog.length = 0;
    const hasil = await retryAgentRun(() =>
      conversation.agent(
        [
          "Rencanakan panduan memilih metode belajar untuk ujian.",
          "Delegasikan paralel tepat tiga subpekerjaan independen:",
          "buat opsi metode, nilai risiko tiap opsi, dan susun kriteria keputusan.",
          "Sesudah ketiganya selesai, delegasikan sekali lagi satu subpekerjaan",
          "untuk memeriksa ulang hasil gabungannya, baru susun jawaban akhir.",
        ].join(" "),
        "orchestrate",
        { summary: null, turns: [], memories: [] },
        { ownerId: "probe-agent", channel: "telegram", intent: "request" },
      )
    );
    status.set(hasil.status, (status.get(hasil.status) ?? 0) + 1);
    for (const kejadian of kejadianLog) {
      if (kejadian.event !== "agent_tool_shape_repair") continue;
      const kelas = String(
        kejadian.fields["toolClass"] ?? kejadian.fields["reason"] ?? "?",
      );
      kelasTool.set(kelas, (kelasTool.get(kelas) ?? 0) + 1);
    }
    console.log(
      `delegasi-ulang ${percobaan}/${ulangi}: ${hasil.status}${
        kejadianLog.length > 0
          ? ` | log: ${
            kejadianLog.map((entry) =>
              `${entry.event}(${
                String(entry.fields["toolClass"] ?? entry.fields["reason"] ?? "")
              })`
            ).join(", ")
          }`
          : ""
      }`,
    );
  }
  console.log("");
  console.log("--- rekap delegasi ulang ---");
  console.log(`Percobaan   : ${ulangi}`);
  console.log(`Status      : ${
    [...status].map(([nama, jumlah]) => `${nama}=${jumlah}`).join(", ")
  }`);
  console.log(`Tool ditolak: ${
    [...kelasTool].map(([kelas, jumlah]) => `${kelas}=${jumlah}`).join(", ") ||
      "tidak ada"
  }`);
}


let agendaPassed = true;
if (jalankan("agenda")) {
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
  agendaPassed =
    agendaCapabilityPassed &&
    agendaDays === 2 &&
    /biologi/iu.test(agendaReply) &&
    !/(?:rapikan|meja|latihan lari|lari)/iu.test(agendaReply);
  console.log(`Horizon   : ${agendaDays ?? "tidak terbaca"} hari`);
  console.log(`Filter    : ${agendaPassed ? "BESOK SAJA TERBUKTI" : "BELUM TERBUKTI"}`);
}

// Recall riwayat. Pertanyaannya menunjuk percakapan lama yang tidak ada di
// `turns`, jadi satu-satunya jalan menjawabnya adalah memanggil
// `history.search`. Jawaban yang benar menyebut hal yang saat itu belum
// jelas: format soalnya pilihan ganda atau uraian.
let recallPassed = true;
if (jalankan("recall")) {
  const hitung = {
    tepat: 0,
    jahitan: 0,
    tidakMenemukan: 0,
    bertanya: 0,
    gagal: 0,
  };
  for (let percobaan = 1; percobaan <= ulangi; percobaan += 1) {
    kueriRiwayat.length = 0;
    const recall = await retryAgentRun(() =>
      conversation.agent(
        "Dulu aku sempat cerita soal persiapan ujian biologi. Waktu itu ada satu hal yang masih belum jelas buatku. Cari di riwayat percakapan kita, lalu sebutkan hal itu.",
        "tools",
        { summary: null, turns: [], memories: [] },
        { ownerId: "probe-agent", channel: "telegram", intent: "question" },
      )
    );
    const dipanggil = report(
      ulangi > 1 ? `recall riwayat ${percobaan}/${ulangi}` : "recall riwayat",
      recall,
      "history.search",
    );
    // Pertanyaan balik ikut dinilai, bukan dibuang sebagai run gagal.
    // Menemukan beberapa hal yang belum jelas lalu menolak menebak—sambil
    // menyebut sumbernya terpisah—adalah persis yang diminta deskripsi tool,
    // dan itu terjadi di lapangan.
    const recallTeks = recall.status === "completed"
      ? recall.reply
      : recall.status === "needs_input"
        ? recall.prompt
        : "";
    const kelas = !dipanggil || !recallTeks
      ? "gagal"
      : recall.status === "needs_input"
        ? "bertanya"
        : nilaiRecall(recallTeks);
    hitung[kelas === "gagal"
      ? "gagal"
      : kelas === "tepat"
        ? "tepat"
        : kelas === "jahitan"
          ? "jahitan"
          : kelas === "bertanya"
            ? "bertanya"
            : "tidakMenemukan"] += 1;
    console.log(`Kelas     : ${kelas}`);
    console.log(`Kueri     : ${
      kueriRiwayat
        .map((rekam) =>
          `${JSON.stringify(rekam.query)}+${JSON.stringify(rekam.aspect)}`
        )
        .join(" | ") || "tidak ada"
    }`);
  }
  if (ulangi > 1) {
    console.log("");
    console.log("--- rekap recall riwayat ---");
    console.log(`Percobaan      : ${ulangi}`);
    console.log(`Klaim tepat    : ${hitung.tepat}`);
    console.log(`Ingatan jahitan: ${hitung.jahitan}`);
    console.log(`Jujur tak ada  : ${hitung.tidakMenemukan}`);
    console.log(`Bertanya balik : ${hitung.bertanya}`);
    console.log(`Run gagal      : ${hitung.gagal}`);
  }
  // Ingatan jahitan adalah kegagalan yang paling merugikan: pengguna diberi
  // tahu sesuatu yang tidak pernah ia katakan, dengan nada mengingat. Satu
  // saja sudah cukup untuk menyatakan kelasnya belum tertutup.
  recallPassed = hitung.jahitan === 0 && hitung.tepat > 0 && hitung.gagal === 0;
  console.log(`Isi klaim : ${recallPassed ? "TERBACA DARI EPISODE" : "BELUM TERBUKTI"}`);
}

// Kontrak bentuk jawaban. Permintaan "tepat tiga langkah" membuat kode
// mengganti fungsi final teks bebas dengan `harvy_structured_steps_v1`, dan
// sejak itu memanggil nama lama menjadi `unknown_tool`—satu perbaikan penuh
// dibayar, dan pada run berdeadline ketat perbaikan itu bisa tidak selesai.
// Kasus ini mengukur seberapa sering itu terjadi, dan tool mana yang dipanggil.
let terstrukturPassed = true;
if (jalankan("terstruktur")) {
  const hitung = { selesai: 0, bertanya: 0, berhenti: 0 };
  const kelasTool = new Map<string, number>();
  for (let percobaan = 1; percobaan <= ulangi; percobaan += 1) {
    kejadianLog.length = 0;
    const hasil = await retryAgentRun(() =>
      conversation.agent(
        [
          "Susun rencana mendalam tepat tiga langkah untuk memperbaiki cara belajarku.",
          "Pada setiap langkah, tulis jelas: Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus.",
        ].join(" "),
        "tools",
        { summary: null, turns: [], memories: [] },
        { ownerId: "probe-agent", channel: "telegram", intent: "request" },
      )
    );
    if (hasil.status === "completed") hitung.selesai += 1;
    else if (hasil.status === "needs_input") hitung.bertanya += 1;
    else hitung.berhenti += 1;
    for (const kejadian of kejadianLog) {
      if (kejadian.event !== "agent_tool_shape_repair") continue;
      const kelas = String(
        kejadian.fields["toolClass"] ?? kejadian.fields["reason"] ?? "?",
      );
      kelasTool.set(kelas, (kelasTool.get(kelas) ?? 0) + 1);
    }
    console.log(
      `terstruktur ${percobaan}/${ulangi}: ${hasil.status}${
        hasil.status === "stopped" ? ` (${hasil.reason})` : ""
      }${
        kejadianLog.length > 0
          ? ` | log: ${kejadianLog.map((entry) => entry.event).join(", ")}`
          : ""
      }`,
    );
  }
  console.log("");
  console.log("--- rekap jawaban terstruktur ---");
  console.log(`Percobaan  : ${ulangi}`);
  console.log(`Selesai    : ${hitung.selesai}`);
  console.log(`Bertanya   : ${hitung.bertanya}`);
  console.log(`Berhenti   : ${hitung.berhenti}`);
  console.log(`Tool ditolak: ${
    [...kelasTool].map(([kelas, jumlah]) => `${kelas}=${jumlah}`).join(", ") ||
      "tidak ada"
  }`);
  terstrukturPassed = hitung.berhenti === 0;
}

if (
  !simplePassed || !complexPassed || !agendaPassed || !recallPassed ||
  !terstrukturPassed
) {
  process.exitCode = 2;
}

/**
 * Menggolongkan satu jawaban recall, bukan sekadar lulus atau gagal.
 *
 * Penanda di bawah berasal dari korpus `synthetic-recall.ts`, bukan dari
 * tebakan atas gaya bahasa model. Yang dicari klaim `unresolved` episode ujian
 * biologi—format soalnya pilihan ganda atau uraian—sementara dua episode lain
 * memuat kata yang beririsan secara leksikal ("ujian" muncul juga di episode
 * jam tidur), dan itulah yang dulu terjahit menjadi satu ingatan palsu.
 *
 * Tiga kelasnya sengaja tidak setara. "Tidak menemukan" adalah kejujuran yang
 * merugikan; "jahitan" adalah kekeliruan yang terdengar seperti ingatan, dan
 * itu jauh lebih merugikan.
 */
function nilaiRecall(reply: string): "tepat" | "jahitan" | "tidak-menemukan" {
  const klaimBenar = /(pilihan ganda|uraian)/iu.test(reply);
  if (klaimBenar) return "tepat";
  const klaimEpisodeLain =
    /(jam tidur|kurang tidur|cemas|sulit fokus|pukul dua|tengah malam|presentasi|kelompok|slide|anggota)/iu
      .test(reply);
  return klaimEpisodeLain ? "jahitan" : "tidak-menemukan";
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
