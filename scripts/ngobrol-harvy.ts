/**
 * Percakapan langsung dengan Harvy, disetir giliran demi giliran.
 *
 * `uji-telegram-langsung.ts` memutar korpus tetap: tiga belas kalimat yang sama
 * dikirim ulang tiap run. Itu membuktikan Harvy sanggup menangani tiga belas
 * bentuk itu, dan tiap run mengukur ulang tiga belas bentuk yang sama. Pesan
 * pengguna sungguhan tidak pernah begitu.
 *
 * Ada akibat yang lebih halus. Karena pesannya identik tiap run, itu justru
 * satu-satunya keadaan di mana cache provider kena—terukur 6.583 dari 6.584
 * token untuk permintaan berulang identik, melawan 128 ketika pesannya berbeda.
 * Jadi angka latensi dan biaya dari pengujian korpus datang dari jalur yang
 * tidak mewakili produksi sama sekali.
 *
 * Berkas ini membuka jalur kedua. `live-exploratory-tester.ts` sudah menerima
 * perintah JSON dari stdin; yang belum ada hanyalah cara menyetirnya sedikit
 * demi sedikit, karena penyusun pesan berikutnya perlu **membaca balasan
 * sebelumnya** dulu. Tanpa itu percakapannya tetap skrip, cuma skrip yang lebih
 * panjang.
 *
 * Caranya berkas antrean: penyetir menyalakan tester sekali, lalu mengawasi satu
 * berkas dan meneruskan tiap baris baru ke stdin anak.
 *
 *   npx tsx scripts/ngobrol-harvy.ts --journey=ngobrol-1
 *   lalu tambahkan baris JSON ke data/ngobrol/ngobrol-1/perintah.jsonl
 *   dan baca data/ngobrol/ngobrol-1/percakapan.txt
 *
 * Dua hal yang menghabiskan waktu bila tidak diketahui lebih dulu:
 *
 * **Setiap perintah butuh `{"type":"settle"}` sesudahnya.** Tester menolak
 * perintah berikutnya selama giliran masih berjalan dengan
 * `LIVE_EXPLORATION_TURN_ACTIVE_SETTLE_OR_INTERRUPT_REQUIRED`. Jadi kirim
 * berpasangan: perintahnya, lalu settle.
 *
 * **Tombol dirujuk lewat alias surface, bukan nomor tebakan.** Aliasnya muncul
 * di transkrip sebagai `[surface-3]` di depan teks pesannya, dan itu yang
 * dipakai pada `{"type":"click","surface":"surface-3","label":"..."}`.
 *
 * Ini bukan pengganti suite fixture. Penilaiannya datang dari yang membaca,
 * tidak berjalan di CI, dan berbeda tiap run. Fixture menangkap regresi; ini
 * menemukan yang tidak terpikir dibuatkan fixture.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.cwd());
/** Cukup cepat untuk terasa langsung, cukup lambat untuk tidak membakar CPU. */
const POLL_MS = 400;

interface TesterEvent {
  type: string;
  text?: string;
  surface?: string;
  operation?: string;
  buttons?: string[];
  latencyMs?: number | null;
  code?: string;
}

interface QueuedCommand {
  type?: string;
  text?: string;
  label?: string;
}

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/**
 * Status transient tidak dicatat ke transkrip.
 *
 * Satu giliran dapat menyunting statusnya dua puluh lima kali. Menuliskan
 * semuanya menenggelamkan balasan sungguhan yang justru sedang dibaca.
 */
function isProgressSurface(text: string): boolean {
  const [first] = text.trim().split("\n");
  const withoutMoon = (first ?? "").replace(/^[🌑🌒🌓🌔🌕🌖🌗🌘]\s/u, "");
  const [title] = withoutMoon.split(" · ");
  const bare = (title ?? "").replace(/\.\.\.$/u, "");
  return /^(?:Menunggu Harvy|Memikirkan|Mencoba lagi|Mencari|Membaca|Membandingkan|Memeriksa|Menyesuaikan|Beralih|Menyusun|Menulis|Menjalankan|Menyimpan|Mengirim|Mengerjakan)$/u
    .test(bare);
}

function describeCommand(line: string): string {
  let command: QueuedCommand;
  try {
    command = JSON.parse(line) as QueuedCommand;
  } catch {
    return "[perintah tidak terbaca]";
  }
  if (command.type === "send") return command.text ?? "";
  if (command.type === "click") return `[klik] ${command.label ?? ""}`;
  return `[${command.type ?? "?"}]`;
}

async function main(): Promise<void> {
  const journey = argument("--journey=") ?? `ngobrol-${Date.now().toString(36)}`;
  const dir = join(REPO, "data", "ngobrol", journey);
  mkdirSync(dir, { recursive: true });
  const queueFile = join(dir, "perintah.jsonl");
  const transcriptFile = join(dir, "percakapan.txt");
  const eventFile = join(dir, "kejadian.jsonl");
  if (!existsSync(queueFile)) writeFileSync(queueFile, "", "utf8");
  writeFileSync(transcriptFile, "", "utf8");
  writeFileSync(eventFile, "", "utf8");

  console.error(`journey   : ${journey}`);
  console.error(`antrean   : ${queueFile}`);
  console.error(`transkrip : ${transcriptFile}`);

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
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );

  // Anak proses memegang lock data Harvy. Setiap jalan keluar wajib menutupnya,
  // atau proses yatim akan memblokir sesi berikutnya.
  const stopChild = (): void => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  process.once("exit", stopChild);

  const note = (line: string): void => {
    appendFileSync(transcriptFile, `${line}\n`, "utf8");
  };

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
      appendFileSync(eventFile, `${line}\n`, "utf8");
      let event: TesterEvent;
      try {
        event = JSON.parse(line) as TesterEvent;
      } catch {
        continue;
      }
      if (event.type === "ready") {
        note("[siap] Harvy hidup. Tambahkan perintah ke berkas antrean.");
        continue;
      }
      if (event.type === "surface") {
        const text = event.text ?? "";
        // Suntingan status transient dilewati; hanya pesan baru yang berarti.
        // Teks kosong juga: gelembung status yang baru dibuat sempat terekam
        // tanpa isi, dan tanpa penjaga ini ia muncul sebagai baris hampa yang
        // terbaca seperti balasan Harvy yang kosong.
        if (!text.trim() || event.operation === "edit") continue;
        if (isProgressSurface(text)) continue;
        const latency = typeof event.latencyMs === "number"
          ? ` (${(event.latencyMs / 1000).toFixed(1)} detik)`
          : "";
        note(`<<<${latency} [${event.surface ?? "?"}] ${text}`);
        if (event.buttons?.length) {
          note(`    [tombol] ${event.buttons.join(" | ")}`);
        }
        continue;
      }
      if (
        event.type === "command_rejected" ||
        event.type === "blocked_or_failed" ||
        event.type === "runner_error" ||
        event.type === "startup_failed"
      ) {
        note(`[${event.type}] ${event.code ?? ""}`);
        continue;
      }
      // Penanda giliran tuntas. Dicatat karena ia patokan kapan aman menyusun
      // pesan berikutnya—bukan sekadar munculnya balasan pertama.
      if (event.type === "turn_settled") {
        note("[giliran selesai]");
        continue;
      }
      if (event.type === "stopped") note("[selesai]");
    }
  });

  child.on("close", (code) => {
    note(`[tester berhenti, kode ${code ?? "?"}]`);
    process.exit(code ?? 0);
  });

  // Meneruskan baris baru dari berkas antrean ke stdin anak. Posisi dicatat
  // supaya baris lama tidak terkirim dua kali ketika berkasnya dibaca ulang.
  let forwarded = 0;
  const pump = (): void => {
    let queued: string[];
    try {
      queued = readFileSync(queueFile, "utf8").split("\n");
    } catch {
      return;
    }
    // Baris terakhir mungkin belum lengkap ditulis; tunggu newline-nya.
    const complete = queued.slice(0, -1);
    while (forwarded < complete.length) {
      const line = (complete[forwarded] ?? "").trim();
      forwarded += 1;
      if (!line) continue;
      // Kejadian `sent` dari tester tidak membawa teksnya, jadi baris keluar
      // dicatat di sini—saat perintahnya benar-benar diteruskan.
      note(`\n>>> ${describeCommand(line)}`);
      child.stdin.write(`${line}\n`);
    }
  };
  const timer = setInterval(pump, POLL_MS);
  timer.unref?.();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
