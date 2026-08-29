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
const CONSENT_SURFACE_CANDIDATES = ["surface-2", "surface-3", "surface-4"];
/**
 * Batas perintah per sesi tester (`MAX_SCRIPTED_COMMANDS`).
 *
 * Dilampaui tanpa sadar begitu kasus ketujuh ditambahkan: onboarding plus tujuh
 * kasus menghasilkan 34 perintah, tester keluar dengan kode 2 sebelum satu
 * kejadian pun terkirim, dan satu-satunya pesan yang muncul adalah "tester
 * keluar dengan kode 2". Onboarding kini berjalan sebagai sesi tersendiri
 * supaya sesi kasus tidak ikut membawanya, dan batas ini dijaga eksplisit.
 */
const MAX_TESTER_COMMANDS = 32;

interface TesterEvent {
  type: string;
  at: string;
  turn?: number;
  text?: string;
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
  failures: LogRecord[];
}

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

interface CommandPlan {
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
function buildCaseCommands(cases: readonly LiveTelegramCase[]): CommandPlan {
  const lines: string[] = [];
  // Indeks 0 tidak terpakai: `commandSequence` milik tester dimulai dari 1.
  const caseBySequence: (string | null)[] = [null];
  const push = (command: unknown, caseId: string | null): void => {
    lines.push(JSON.stringify(command));
    caseBySequence.push(caseId);
  };
  for (const testCase of cases) {
    push({ type: "send", text: testCase.message }, testCase.id);
    push({ type: "wait", ms: testCase.waitMs ?? 45_000 }, null);
    push({ type: "settle" }, null);
  }
  push({ type: "stop" }, null);
  return { lines, caseBySequence };
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
        failures: [],
      };
      turns.push(current);
    } else if (event.type === "surface" && current) {
      const text = String(event.text ?? "").trim();
      if (text) current.replies.push(text);
      if (event.latencyMs != null) current.latencyMs = event.latencyMs;
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
      } else if (record.level === "error" || record.level === "warn") {
        turn.failures.push(record);
      }
    }
  }
  return turns;
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
  for (const pattern of expect.replyForbids ?? []) {
    if (pattern.test(reply)) {
      failures.push(`balasan memuat yang dilarang ${String(pattern)}`);
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

  const plan = buildCaseCommands(cases);
  if (plan.lines.length > MAX_TESTER_COMMANDS) {
    const maxCases = Math.floor((MAX_TESTER_COMMANDS - 1) / 3);
    console.error(
      `Terlalu banyak perintah: ${plan.lines.length} melewati batas ` +
        `${MAX_TESTER_COMMANDS}. Jalankan paling banyak ${maxCases} kasus per ` +
        "sesi, atau pilih sebagiannya dengan --kasus=.",
    );
    process.exit(2);
  }

  // Onboarding dijalankan sebagai sesi tersendiri pada journey yang sama.
  // Menyatukannya dengan kasus pernah melewati batas perintah tester tanpa
  // pesan yang dapat dibaca, dan ia juga membatasi berapa kasus yang muat.
  console.error("fase 1: menyetujui izin AI");
  await runTester(journey, buildOnboardingCommands());
  console.error("fase 2: menjalankan kasus");
  const events = await runTester(journey, plan.lines);
  const records = readRuntimeLog(journey);
  const turns = joinEvidence(events, records, plan.caseBySequence);
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

  const boundaryTimeouts = records.filter(
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

await main();
