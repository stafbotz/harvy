/**
 * Pemeriksaan Telegram langsung dengan ekspektasi yang diperiksa kode.
 *
 * `live-exploratory-tester.ts` adalah alat eksplorasi: ia mengirim, merekam,
 * dan menampilkan. Ia tidak menilai. Sesi 29 Agustus 2026 memperlihatkan
 * akibatnya — tujuh giliran berjalan mulus, laporannya terdengar meyakinkan,
 * dan dua kesimpulannya keliru sampai log runtime dibaca baris demi baris:
 * giliran `history` dilaporkan memakai kontrak auto padahal tidak pernah masuk
 * Agent Runtime sama sekali, dan giliran coding dikira gagal karena runtime
 * mati padahal operasi semantiknya memang tidak pernah diusulkan.
 *
 * Berkas ini menutup celah itu. Setiap kasus menyatakan jalur kode yang
 * seharusnya dilalui, lalu bukti dari dua sumber independen disatukan:
 *
 * 1. Kejadian transport dari tester: apa yang benar-benar terkirim dan dibalas.
 * 2. Log operasional runtime: intent, domain semantik, route yang dipilih,
 *    apakah Agent Runtime dipakai, dan capability mana yang berhasil.
 *
 * Keduanya dicocokkan lewat jendela waktu antara `sent` dan `turn_settled`.
 * Tanpa penyatuan itu, "Harvy menjawab benar" tidak membedakan jawaban benar
 * yang lewat jalur benar dari jawaban benar yang kebetulan.
 *
 * Keluar dengan kode 1 bila ada ekspektasi yang tidak terpenuhi.
 *
 *   npx tsx scripts/uji-telegram-langsung.ts
 *   npx tsx scripts/uji-telegram-langsung.ts --kasus=simpan-task,baca-task
 *   npx tsx scripts/uji-telegram-langsung.ts --simpan-transkrip
 */
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  LIVE_TELEGRAM_CASES,
  type LiveTelegramCase,
} from "./live-telegram-cases.js";

const REPO = resolve(process.cwd());
const CONSENT_LABEL = "Okei, mulai.";
/**
 * Alias bubble onboarding yang membawa tombol persetujuan.
 *
 * Journey baru menahan seluruh pesan sampai izin AI disetujui, dan alias-nya
 * tidak dapat dicabang di tengah run karena seluruh perintah dimuat sekaligus.
 * Kandidatnya dicoba berurutan; klik yang salah sasaran ditolak transport tanpa
 * mengubah state apa pun.
 */
/**
 * Kandidat sengaja dilebihkan, dan kegagalannya kini dideteksi sebelum kasus
 * berjalan.
 *
 * Onboarding gagal 1 dari 3 sesi pada 30 Agustus 2026: tombol persetujuan
 * tidak berada di alias yang dicoba, seluruh sembilan kasus berjalan dengan
 * pesan yang ditahan runtime, dan sesi itu terbuang percuma—sembilan giliran
 * model yang tidak mengukur apa pun.
 */
const CONSENT_SURFACE_CANDIDATES = [
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "surface-5",
];
/** Kalimat yang hanya muncul setelah izin benar-benar diterima. */
const CONSENT_ACCEPTED = /oke, kita mulai/iu;
/**
 * Batas perintah per sesi tester (`MAX_SCRIPTED_COMMANDS`).
 *
 * Dilampaui tanpa sadar begitu kasus ketujuh ditambahkan: onboarding plus tujuh
 * kasus menghasilkan 34 perintah, tester keluar dengan kode 2 sebelum satu
 * kejadian pun terkirim, dan satu-satunya pesan yang muncul adalah "tester
 * keluar dengan kode 2". Onboarding kini berjalan sebagai sesi tersendiri
 * supaya sesi kasus tidak ikut membawanya, dan batas ini dijaga eksplisit.
 */
export const MAX_TESTER_COMMANDS = 32;

interface TesterEvent {
  type: string;
  at: string;
  turn?: number;
  text?: string;
  /** Alias stabil per pesan kanal; sama untuk pembuatan dan seluruh suntingannya. */
  surface?: string;
  /** `create` menandai pesan baru; `edit` menandai perubahan pesan yang sudah ada. */
  operation?: string;
  buttons?: string[];
  latencyMs?: number | null;
  code?: string;
  commandSequence?: number;
}

interface LogRecord {
  timestamp: string;
  event: string;
  level: string;
  data?: Record<string, unknown>;
}

interface TurnEvidence {
  turn: number;
  /** Kasus pemilik giliran ini, ditentukan nomor urut perintah. */
  caseId: string | null;
  sentAt: number;
  settledAt: number;
  replies: string[];
  latencyMs: number | null;
  route: Record<string, unknown> | null;
  agentRun: Record<string, unknown> | null;
  /** Bukti turn-taking dari `conversation_turn_completed`. */
  turnMetrics: Record<string, unknown> | null;
  failures: LogRecord[];
}

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

export interface CommandPlan {
  lines: string[];
  /** id kasus per nomor urut perintah, 1-based. Null untuk perintah rumah tangga. */
  caseBySequence: (string | null)[];
}

/**
 * Sesi pertama: menyetujui izin AI pada journey baru.
 *
 * Journey baru menahan seluruh pesan sampai izin disetujui, dan alias bubble
 * pembawa tombol tidak dapat dicabang di tengah run karena semua perintah
 * dimuat sekaligus. Kandidatnya dicoba berurutan; klik yang salah sasaran
 * ditolak transport tanpa mengubah state apa pun.
 */
function buildOnboardingCommands(): string[] {
  const lines: string[] = [
    JSON.stringify({ type: "send", text: "halo" }),
    JSON.stringify({ type: "wait", ms: 25_000 }),
    JSON.stringify({ type: "settle" }),
  ];
  for (const surface of CONSENT_SURFACE_CANDIDATES) {
    lines.push(
      JSON.stringify({ type: "click", surface, label: CONSENT_LABEL }),
      JSON.stringify({ type: "wait", ms: 6_000 }),
      JSON.stringify({ type: "settle" }),
    );
  }
  lines.push(JSON.stringify({ type: "stop" }));
  return lines;
}

/** Sesi kedua: hanya kasus, pada journey yang izinnya sudah tersetujui. */
export function buildCaseCommands(cases: readonly LiveTelegramCase[]): CommandPlan {
  const lines: string[] = [];
  // Indeks 0 tidak terpakai: `commandSequence` milik tester dimulai dari 1.
  const caseBySequence: (string | null)[] = [null];
  const push = (command: unknown, caseId: string | null): void => {
    lines.push(JSON.stringify(command));
    caseBySequence.push(caseId);
  };
  for (const testCase of cases) {
    if (testCase.kind === "burst") {
      // Satu perintah, satu giliran, beberapa bubble. Jeda antarpesan sengaja
      // kecil supaya batcher benar-benar menghadapi semburan, bukan tiga
      // giliran berurutan.
      push({
        type: "burst",
        messages: [testCase.message, ...(testCase.followUps ?? [])],
        gapMs: testCase.gapMs ?? 900,
      }, testCase.id);
    } else if (testCase.kind === "interrupt") {
      // Interupsi menuntut giliran yang masih aktif, jadi tidak ada `settle`
      // di antara keduanya. Ini satu-satunya bentuk yang membuat dua giliran
      // tumpang tindih, dan karena itu satu-satunya yang menguji batas jendela
      // korelasi harness ini sendiri.
      push({ type: "send", text: testCase.message }, null);
      push({ type: "wait", ms: testCase.interruptAfterMs ?? 3_000 }, null);
      push(
        { type: "interrupt", text: testCase.interruptWith ?? "" },
        testCase.id,
      );
    } else if (testCase.kind === "follow-up") {
      // Tidak ada `wait` antara balasan dan sambungan. Kesadaran Harvy saat
      // memotong hanya menyala bila sambungannya tiba dalam delapan detik, dan
      // `wait` berdurasi tetap tidak dapat menjamin itu: balasan yang datang
      // cepat akan menyisakan jeda panjang sesudahnya. `settle` menunggu kanal
      // `await_reply` menunggu balasan yang benar-benar terlihat, lalu `settle`
      // menutup gilirannya. Sambungan berangkat beberapa ratus milidetik
      // sesudahnya—di dalam jendela delapan detik.
      push({ type: "send", text: testCase.message }, null);
      push({ type: "await_reply", timeoutMs: 90_000 }, null);
      push({ type: "settle" }, null);
      push(
        { type: "send", text: testCase.followUpAfterReply ?? "" },
        testCase.id,
      );
    } else {
      push({ type: "send", text: testCase.message }, testCase.id);
    }
    push({ type: "wait", ms: testCase.waitMs ?? 45_000 }, null);
    push({ type: "settle" }, null);
  }
  push({ type: "stop" }, null);
  return { lines, caseBySequence };
}

/**
 * Memecah kasus menjadi beberapa sesi tester yang masing-masing muat.
 *
 * Batas 32 perintah milik tester adalah batas per sesi, bukan batas korpus.
 * Sembilan kasus memakai 30 dari 32, sehingga kasus kesepuluh tidak muat sama
 * sekali—dan dua kelas yang paling dibutuhkan, keselamatan dan kesadaran Harvy
 * saat memotong, keduanya tertahan di situ.
 *
 * Journey-nya sama untuk semua batch, jadi state berjalan terus: tugas yang
 * disimpan batch pertama tetap terbaca batch berikutnya. Pola ini sudah dipakai
 * onboarding, yang memang sesi tersendiri pada journey yang sama.
 *
 * Kasus tidak pernah dipotong di tengah: perintah satu kasus selalu utuh dalam
 * satu batch, karena `interrupt` menuntut giliran yang masih aktif dan `burst`
 * menuntut ketiga bubble-nya berurutan tanpa jeda sesi.
 */
export function splitIntoBatches(
  cases: readonly LiveTelegramCase[],
): CommandPlan[] {
  const batches: CommandPlan[] = [];
  let pending: LiveTelegramCase[] = [];
  const flush = (): void => {
    if (pending.length > 0) batches.push(buildCaseCommands(pending));
    pending = [];
  };
  for (const testCase of cases) {
    const candidate = buildCaseCommands([...pending, testCase]);
    if (candidate.lines.length > MAX_TESTER_COMMANDS && pending.length > 0) {
      flush();
    }
    pending.push(testCase);
    // Satu kasus yang sendirian pun tidak muat berarti korpusnya yang salah,
    // bukan pembagiannya. Dilaporkan saat batch itu dijalankan.
    if (buildCaseCommands(pending).lines.length > MAX_TESTER_COMMANDS) {
      flush();
    }
  }
  flush();
  return batches;
}

async function runTester(
  journey: string,
  commands: readonly string[],
): Promise<TesterEvent[]> {
  const events: TesterEvent[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(REPO, "scripts", "live-exploratory-tester.ts"),
        "--channel=telegram",
        `--journey=${journey}`,
        "--mode=focused",
      ],
      {
        cwd: REPO,
        env: {
          ...process.env,
          HARVY_LIVE_EXPLORATION_CONFIRM: "RUN_NONCRITICAL_LIVE_EXPLORATION",
          HARVY_LIVE_EXPLORATION_ACCOUNT: "DEDICATED_TEST_ACCOUNT",
          HARVY_LIVE_EXPLORATION_COMMANDS_JSONL: commands.join("\n"),
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    // Anak proses menyalakan runtime Harvy sungguhan yang memegang lock data.
    // Sesi 29 Agustus meninggalkan dua proses yatim sampai dimatikan manual,
    // jadi setiap jalan keluar dari sini wajib menutupnya.
    const stopChild = (): void => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    };
    process.once("SIGINT", stopChild);
    process.once("SIGTERM", stopChild);
    process.once("exit", stopChild);

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const event = JSON.parse(line) as TesterEvent;
          events.push(event);
          reportProgress(event);
        } catch {
          // Baris non-JSON bukan kejadian; abaikan tanpa menggagalkan sesi.
        }
      }
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      process.off("SIGINT", stopChild);
      process.off("SIGTERM", stopChild);
      if (code === 0 || code === null) resolvePromise();
      else rejectPromise(new Error(`tester keluar dengan kode ${code}`));
    });
  });
  return events;
}

function reportProgress(event: TesterEvent): void {
  if (event.type === "ready") console.error("runtime siap; mulai mengirim");
  else if (event.type === "sent") console.error(`  giliran ${event.turn} terkirim`);
  else if (event.type === "startup_failed" || event.type === "blocked_or_failed") {
    console.error(`  GAGAL: ${event.code}`);
  } else if (event.type === "command_rejected") {
    // Perintah yang ditolak transport dulu hanya terlihat sebagai kasus yang
    // "tidak pernah terkirim" di akhir laporan, tanpa sebab. Sesi 30 Agustus
    // 2026 berhenti sesudah tujuh giliran tanpa satu baris pun menjelaskan
    // kenapa, dan itu menghabiskan satu sesi penuh untuk mencari tahu.
    console.error(
      `  perintah #${event.commandSequence ?? "?"} ditolak: ${event.code ?? "tanpa kode"}`,
    );
  }
}

function readRuntimeLog(journey: string): LogRecord[] {
  const directory = join(
    REPO,
    "data",
    "live-exploration",
    "telegram",
    journey,
    "data",
    "logs",
  );
  if (!existsSync(directory)) return [];
  const records: LogRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".ndjson")) continue;
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as LogRecord);
      } catch {
        // Baris parsial di ujung berkas bukan bukti; lewati.
      }
    }
  }
  return records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/**
 * Menyatukan kejadian tester dengan log runtime lewat jendela waktu giliran.
 *
 * Keduanya proses terpisah tanpa identifier bersama, jadi batasnya adalah
 * waktu: catatan runtime antara `sent` dan `turn_settled` milik giliran itu.
 * `settle` memang menutup jendela observasi runtime, sehingga batas ini
 * mengikuti kontrak tester, bukan menebaknya.
 */
/**
 * Perintah yang ditolak transport—misalnya klik consent yang salah sasaran—
 * tidak pernah membuka giliran. Menghitung giliran berdasarkan urutan kasus
 * karena itu meleset diam-diam: percobaan pertama berkas ini menggeser seluruh
 * balasan dua posisi dan melaporkan dua kasus terakhir "tidak pernah terkirim"
 * padahal keduanya terkirim. `commandSequence` milik tester adalah satu-satunya
 * penanda yang tidak bergantung pada berapa banyak perintah yang berhasil.
 */
function joinEvidence(
  events: readonly TesterEvent[],
  records: readonly LogRecord[],
  caseBySequence: readonly (string | null)[],
): TurnEvidence[] {
  const turns: TurnEvidence[] = [];
  let current: TurnEvidence | null = null;
  /** Alias pesan -> giliran pemiliknya, supaya suntingan tidak berpindah. */
  const surfaceOwner = new Map<string, TurnEvidence>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.type === "sent" && event.turn !== undefined) {
      current = {
        turn: event.turn,
        caseId: caseBySequence[event.commandSequence ?? -1] ?? null,
        sentAt: at,
        settledAt: Number.POSITIVE_INFINITY,
        replies: [],
        latencyMs: null,
        route: null,
        agentRun: null,
        turnMetrics: null,
        failures: [],
      };
      turns.push(current);
    } else if (event.type === "surface") {
      // Balasan dikembalikan ke giliran tempat pesannya **dibuat**, bukan ke
      // giliran yang kebetulan sedang terbuka.
      //
      // Harvy mengirim status "Memikirkan..." lebih dulu lalu menyuntingnya
      // menjadi jawaban akhir. Ketika suntingan itu datang sesudah kasus
      // berikutnya dikirim, atribusi berdasarkan jendela waktu memberikannya
      // kepada kasus yang salah. Sesi 30 Agustus 2026 merekamnya terang-
      // terangan: satu balasan yang sama persis tercatat sebagai balasan tiga
      // kasus berbeda, padahal log runtime menunjukkan permukaannya hanya
      // menyala sekali. Laporan seperti itu lebih buruk daripada tidak ada
      // laporan—ia menyembunyikan giliran yang sebenarnya tidak dijawab.
      const alias = event.surface;
      const owner = event.operation === "create" || alias === undefined
        ? current
        : surfaceOwner.get(alias) ?? current;
      if (owner) {
        const text = String(event.text ?? "").trim();
        if (text) owner.replies.push(text);
        if (event.latencyMs != null) owner.latencyMs = event.latencyMs;
        if (alias !== undefined) surfaceOwner.set(alias, owner);
      }
    } else if (event.type === "turn_settled" && current) {
      current.settledAt = at;
      current = null;
    }
  }

  for (const turn of turns) {
    for (const record of records) {
      const at = Date.parse(record.timestamp);
      if (at < turn.sentAt || at > turn.settledAt) continue;
      if (
        record.event === "semantic_route_evaluated" ||
        record.event === "semantic_route_selected"
      ) {
        // Keduanya bukti route, dan keduanya perlu dibaca. `evaluated` datang
        // dari pemilihan route utama; `selected` dari surface deterministik
        // yang memotong lebih awal sehingga tidak pernah sampai ke pemilihan
        // utama. Membaca satu saja membuat jalur permukaan bahasa alami
        // terlihat kosong padahal ia berjalan—kekeliruan yang membuat kasus
        // coding dilaporkan gagal dua kali berturut-turut.
        turn.route = { ...(turn.route ?? {}), ...(record.data ?? {}) };
      } else if (
        record.event === "agent_run_completed" ||
        record.event === "agent_run_stopped"
      ) {
        turn.agentRun = record.data ?? null;
      } else if (record.event === "conversation_turn_completed") {
        turn.turnMetrics = record.data ?? null;
      } else if (record.level === "error" || record.level === "warn") {
        turn.failures.push(record);
      }
    }
  }
  return turns;
}

/**
 * Aksara di luar Latin, dan penanda kalimat Inggris.
 *
 * `HARVY_IDENTITY` menuntut Harvy mengikuti bahasa pengguna "dan pakai hanya
 * kata serta aksara dari bahasa itu". Aturan itu dilanggar dua kali secara
 * teramati: satu balasan jadwal belajar dibuka dalam bahasa Inggris untuk
 * pesan berbahasa Indonesia, dan satu catatan durable tersimpan dengan aksara
 * Mandarin di tengah kalimat Indonesia.
 *
 * Pemeriksaan ini universal—berlaku pada setiap kasus—karena pelanggarannya
 * tidak terikat pada satu jalur, dan karena aturannya sudah ada: yang kurang
 * hanya pagarnya.
 */
const NON_LATIN_SCRIPT =
  /[一-鿿぀-ヿЀ-ӿ؀-ۿ]/u;
/** Menuntut dua penanda berbeda supaya satu kata pinjaman tidak memicu alarm. */
const ENGLISH_MARKERS: readonly RegExp[] = [
  /\bhere(?:'s| is)\b/iu,
  /\bi have\b/iu,
  /\blet me\b/iu,
  /\bbased on\b/iu,
  /\byou can\b/iu,
  /\bthe following\b/iu,
  /\bmake sure\b/iu,
];

export function registerViolations(reply: string): string[] {
  const problems: string[] = [];
  const asing = NON_LATIN_SCRIPT.exec(reply);
  if (asing) problems.push(`aksara di luar Latin: "${asing[0]}"`);
  const inggris = ENGLISH_MARKERS.filter((pattern) => pattern.test(reply));
  if (inggris.length >= 2) {
    problems.push(`berpindah ke bahasa Inggris (${inggris.length} penanda)`);
  }
  return problems;
}

function decisionIntent(route: Record<string, unknown> | null): string | null {
  const decision = route?.["decision"];
  if (typeof decision !== "string") return null;
  const match = /(?:^|\.)intent-([a-z]+)/u.exec(decision);
  return match?.[1] ?? null;
}

function evaluate(
  testCase: LiveTelegramCase,
  turn: TurnEvidence | undefined,
): string[] {
  if (!turn) return ["giliran tidak pernah terkirim"];
  const failures: string[] = [];
  const reply = turn.replies.join("\n");
  const expect = testCase.expect;
  // Giliran tanpa balasan dilaporkan sendiri, bukan lewat assertion isi yang
  // gagal. Keduanya dulu terlihat sama—"balasan tidak memuat X"—padahal yang
  // satu berarti Harvy salah menjawab dan yang lain berarti ia tidak menjawab
  // sama sekali. Yang kedua jauh lebih serius, dan sebelum atribusi balasan
  // diperbaiki ia tersamar sebagai balasan milik giliran lain.
  if (turn.replies.length === 0) {
    return ["giliran terkirim tetapi tidak ada balasan sama sekali"];
  }

  if (expect.intent !== undefined) {
    const actual = decisionIntent(turn.route);
    const allowed = typeof expect.intent === "string"
      ? [expect.intent]
      : [...expect.intent];
    if (!actual || !allowed.includes(actual)) {
      failures.push(
        `intent ${actual ?? "(tidak tercatat)"}, diharapkan ${allowed.join("|")}`,
      );
    }
  }
  if (expect.selectedRoute !== undefined) {
    const actual = turn.route?.["selectedRoute"];
    if (actual !== expect.selectedRoute) {
      failures.push(`route ${String(actual)}, diharapkan ${expect.selectedRoute}`);
    }
  }
  if (expect.semanticDomain !== undefined) {
    const actual = turn.route?.["semanticDomain"];
    if (actual !== expect.semanticDomain) {
      failures.push(`domain ${String(actual)}, diharapkan ${expect.semanticDomain}`);
    }
  }
  if (expect.semanticOperation !== undefined) {
    const actual = turn.route?.["semanticOperation"];
    if (actual !== expect.semanticOperation) {
      failures.push(
        `operasi ${String(actual)}, diharapkan ${expect.semanticOperation}`,
      );
    }
  }
  if (expect.agentUsed !== undefined) {
    const used = turn.agentRun !== null;
    if (used !== expect.agentUsed) {
      failures.push(
        expect.agentUsed
          ? "Agent Runtime tidak dipakai padahal diharapkan"
          : "Agent Runtime dipakai padahal tidak diharapkan",
      );
    }
  }
  for (const capability of expect.capabilities ?? []) {
    const invoked = String(turn.agentRun?.["capabilities"] ?? "").split("+");
    if (!invoked.includes(capability)) {
      failures.push(
        `capability ${capability} tidak dipanggil (tercatat: ${invoked.join("+") || "none"})`,
      );
    }
  }
  for (const pattern of expect.replyMatches ?? []) {
    if (!pattern.test(reply)) failures.push(`balasan tidak memuat ${String(pattern)}`);
  }
  // Berlaku pada setiap kasus, bukan hanya yang menyatakannya.
  failures.push(...registerViolations(reply));
  for (const pattern of expect.replyForbids ?? []) {
    if (pattern.test(reply)) {
      failures.push(`balasan memuat yang dilarang ${String(pattern)}`);
    }
  }
  if (expect.bubbleCount !== undefined) {
    const actual = turn.turnMetrics?.["bubbleCount"];
    if (actual !== expect.bubbleCount) {
      failures.push(
        `bubble ${String(actual)}, diharapkan ${expect.bubbleCount}`,
      );
    }
  }
  if (expect.maxBatchWaitMs !== undefined) {
    const actual = turn.turnMetrics?.["batchWaitMs"];
    if (typeof actual !== "number" || actual > expect.maxBatchWaitMs) {
      failures.push(
        `jeda penggabungan ${String(actual)}ms, batas ${expect.maxBatchWaitMs}ms`,
      );
    }
  }
  if (expect.boundaryState !== undefined) {
    const actual = turn.turnMetrics?.["boundaryState"];
    if (actual !== expect.boundaryState) {
      failures.push(
        `batas giliran ${String(actual)}, diharapkan ${expect.boundaryState}`,
      );
    }
  }
  if (expect.interruptionRelation !== undefined) {
    const allowed = typeof expect.interruptionRelation === "string"
      ? [expect.interruptionRelation]
      : [...expect.interruptionRelation];
    const actual = turn.turnMetrics?.["interruptionRelation"];
    if (typeof actual !== "string" || !allowed.includes(actual)) {
      failures.push(
        `hubungan interupsi ${String(actual)}, diharapkan ${allowed.join("|")}`,
      );
    }
  }
  if (expect.maxLatencyMs !== undefined && turn.latencyMs !== null) {
    if (turn.latencyMs > expect.maxLatencyMs) {
      failures.push(`latensi ${turn.latencyMs}ms melewati ${expect.maxLatencyMs}ms`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const requested = new Set(
    (argument("--kasus=") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const cases = requested.size > 0
    ? LIVE_TELEGRAM_CASES.filter((testCase) => requested.has(testCase.id))
    : LIVE_TELEGRAM_CASES;
  if (cases.length === 0) {
    console.error("Tidak ada kasus yang cocok.");
    process.exit(2);
  }
  const journey = argument("--journey=") ??
    `uji-langsung-${Date.now().toString(36)}`;
  const keepTranscript = process.argv.includes("--simpan-transkrip");

  console.error(`journey : ${journey}`);
  console.error(`kasus   : ${cases.length}`);

  // Batas 32 perintah adalah batas per sesi tester, bukan batas korpus. Korpus
  // yang tidak muat dipecah menjadi beberapa sesi berurutan pada journey yang
  // sama, sehingga state berjalan terus dan kasus baru tidak lagi terhalang
  // ukuran korpus.
  const batches = splitIntoBatches(cases);
  const tooLarge = batches.find((batch) => batch.lines.length > MAX_TESTER_COMMANDS);
  if (tooLarge) {
    // Hanya mungkin bila satu kasus sendirian melewati batas—korpusnya yang
    // salah, bukan pembagiannya.
    console.error(
      `Satu kasus memerlukan ${tooLarge.lines.length} perintah, melewati batas ` +
        `${MAX_TESTER_COMMANDS}. Perkecil kasusnya.`,
    );
    process.exit(2);
  }
  if (batches.length > 1) {
    console.error(`batch   : ${batches.length} sesi berurutan`);
  }

  // Mencetak pembagiannya tanpa menyentuh kanal. Pembagian yang salah hanya
  // terlihat sesudah satu sesi penuh terbakar, jadi ia harus dapat diperiksa
  // lebih murah daripada itu.
  if (process.argv.includes("--rencana")) {
    for (const [index, batch] of batches.entries()) {
      const ids = batch.caseBySequence.filter((id): id is string => id !== null);
      console.log(
        `batch ${index + 1}: ${batch.lines.length} perintah, ${ids.length} kasus — ${ids.join(", ")}`,
      );
    }
    process.exit(0);
  }

  // Onboarding dijalankan sebagai sesi tersendiri pada journey yang sama.
  // Menyatukannya dengan kasus pernah melewati batas perintah tester tanpa
  // pesan yang dapat dibaca, dan ia juga membatasi berapa kasus yang muat.
  console.error("fase 1: menyetujui izin AI");
  const onboarding = await runTester(journey, buildOnboardingCommands());
  const consentAccepted = onboarding.some((event) =>
    event.type === "surface" && CONSENT_ACCEPTED.test(String(event.text ?? ""))
  );
  if (!consentAccepted) {
    // Berhenti di sini, bukan menjalankan kasus yang pasti tidak sah. Sesi yang
    // gagal onboarding tetap membakar sembilan giliran model tanpa mengukur
    // apa pun.
    console.error("");
    console.error("ONBOARDING GAGAL: tombol persetujuan tidak pernah tertekan.");
    console.error(
      "Kasus tidak dijalankan. Periksa alias bubble onboarding pada " +
        "CONSENT_SURFACE_CANDIDATES.",
    );
    process.exit(2);
  }
  console.error("fase 2: menjalankan kasus");
  const turns: TurnEvidence[] = [];
  let sentTurns = 0;
  let expectedTurns = 0;
  let executed = 0;
  let plannedLines = 0;
  for (const [index, batch] of batches.entries()) {
    if (batches.length > 1) {
      console.error(`  batch ${index + 1} dari ${batches.length}`);
    }
    const events = await runTester(journey, batch.lines);
    // `commandSequence` tester dimulai ulang tiap sesi, jadi pemetaan kasusnya
    // wajib per batch. Menyatukan kejadian lebih dulu lalu memetakan sekali
    // akan menggeser seluruh atribusi pada batch kedua dan seterusnya.
    turns.push(...joinEvidence(events, readRuntimeLog(journey), batch.caseBySequence));
    sentTurns += events.filter((event) => event.type === "sent").length;
    executed += events.filter((event) =>
      event.type === "sent" || event.type === "command_rejected"
    ).length;
    expectedTurns += batch.caseBySequence.filter((id) => id !== null).length;
    plannedLines += batch.lines.length;
  }

  // Penguji wajib menghabiskan seluruh perintahnya. Sesi 30 Agustus 2026
  // berhenti sesudah tujuh dari sembilan kasus tanpa satu baris penjelasan;
  // dua kasus terakhir hanya muncul sebagai "tidak pernah terkirim" di antara
  // kegagalan lain, sehingga terbaca seolah Harvy yang bermasalah. Sesi yang
  // tidak lengkap bukan sesi yang gagal sebagian—ia sesi yang tidak sah, dan
  // menilai Harvy darinya berarti menilai dari bukti yang tidak ada.
  if (sentTurns < expectedTurns) {
    console.error("");
    console.error(
      `SESI TIDAK LENGKAP: ${sentTurns} dari ${expectedTurns} giliran kasus terkirim ` +
        `(${executed} perintah terpakai dari ${plannedLines}).`,
    );
    console.error(
      "Penilaian di bawah hanya berlaku untuk kasus yang benar-benar berjalan.",
    );
  }
  const byCase = new Map<string, TurnEvidence>();
  for (const turn of turns) {
    if (turn.caseId && !byCase.has(turn.caseId)) byCase.set(turn.caseId, turn);
  }

  // Hanya giliran kasus yang dinilai. Bubble onboarding pada giliran sapaan
  // memang memuat kalimat ini; memindai seluruh giliran membuat alarm menyala
  // pada sesi yang persetujuannya justru berhasil.
  const consentPending = turns.some((turn) =>
    turn.caseId !== null &&
    /belum aku proses sampai kamu oke/iu.test(turn.replies.join("\n"))
  );
  if (consentPending) {
    console.error("");
    console.error("ONBOARDING GAGAL: izin AI tidak pernah disetujui.");
    console.error("Kasus di bawah tidak sah karena pesannya ditahan runtime.");
  }

  let failed = 0;
  console.log("");
  for (const testCase of cases) {
    const turn = byCase.get(testCase.id);
    const problems = evaluate(testCase, turn);
    if (problems.length > 0) failed += 1;
    console.log(`[${problems.length === 0 ? "LULUS" : "GAGAL"}] ${testCase.id}`);
    console.log(`  kirim   : ${testCase.message}`);
    if (turn) {
      console.log(`  intent  : ${decisionIntent(turn.route) ?? "-"}`);
      console.log(`  route   : ${String(turn.route?.["selectedRoute"] ?? "-")}`);
      console.log(
        `  semantik: ${String(turn.route?.["semanticDomain"] ?? "-")}/${
          String(turn.route?.["semanticOperation"] ?? "-")
        } (${String(turn.route?.["confidenceBucket"] ?? "-")})`,
      );
      console.log(
        `  agent   : ${
          turn.agentRun
            ? `${String(turn.agentRun["plannerMode"])}, capability ${
              String(turn.agentRun["capabilities"])
            }`
            : "tidak dipakai"
        }`,
      );
      console.log(`  latensi : ${turn.latencyMs ?? "-"}ms`);
      if (turn.turnMetrics) {
        console.log(
          `  giliran : ${String(turn.turnMetrics["bubbleCount"] ?? "-")} bubble, batas ${
            String(turn.turnMetrics["boundaryState"] ?? "-")
          }, interupsi ${String(turn.turnMetrics["interruptionRelation"] ?? "-")}, tunggu ${String(turn.turnMetrics["batchWaitMs"] ?? "-")}ms`,
        );
      }
      if (turn.failures.length > 0) {
        console.log(
          `  masalah : ${
            turn.failures
              .map((record) =>
                `${record.event}${
                  record.data?.["purpose"]
                    ? `(${String(record.data["purpose"])})`
                    : ""
                }`
              )
              .join(", ")
          }`,
        );
      }
      if (keepTranscript) {
        console.log(`  balasan : ${turn.replies.join("\n            ")}`);
      }
    }
    for (const problem of problems) console.log(`  -> ${problem}`);
    console.log("");
  }

  const boundaryTimeouts = readRuntimeLog(journey).filter(
    (record) => record.event === "turn_boundary_check_failed",
  ).length;
  console.log(`Ringkasan: ${cases.length - failed}/${cases.length} lulus`);
  console.log(`Giliran runtime tercatat: ${turns.length}`);
  if (boundaryTimeouts > 0) {
    console.log(`Pemeriksa batas giliran habis waktu: ${boundaryTimeouts}x`);
  }

  if (!keepTranscript) {
    // Direktori journey memuat riwayat percakapan nyata akun penguji. Ia
    // diabaikan Git, tetapi tetap tidak perlu tertinggal di disk.
    rmSync(join(REPO, "data", "live-exploration", "telegram", journey), {
      recursive: true,
      force: true,
    });
  }
  process.exit(failed > 0 || consentPending ? 1 : 0);
}

// Hanya berjalan ketika dipanggil langsung.
//
// Sebelum penjaga ini, `import` apa pun dari berkas ini menyalakan sesi
// Telegram sungguhan: satu tes yang mengimpor pembagi batch langsung membuka
// runtime, memegang lock data, dan menggantung sampai dimatikan. Modul yang
// mengerjakan sesuatu hanya karena dibaca tidak dapat diuji.
const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
