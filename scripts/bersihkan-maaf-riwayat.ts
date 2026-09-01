/**
 * Membuang kalimat gagal Harvy dari riwayat percakapan tersimpan.
 *
 * Sampai 1 September 2026 setiap kegagalan menulis kalimat maafnya ke riwayat
 * sebagai ucapan Harvy. Riwayat ikut dikirim ke model tiap giliran, jadi model
 * membaca belasan contoh dirinya sendiri berkata "aku lagi nggak bisa mikir"
 * lalu **menirunya**—pada giliran yang justru berhasil, tanpa satu pun kegagalan
 * tercatat. Pengguna melihat kalimat maaf yang teksnya sudah dihapus dari kode.
 *
 * Penulisannya sudah dihentikan di `create-bot.ts`. Berkas ini membersihkan
 * bekasnya, karena yang sudah telanjur tersimpan tetap dibaca model sampai
 * pemadatan riwayat membuangnya—dan pemadatan itu sendiri sedang gagal.
 *
 * Harvy WAJIB dimatikan lebih dulu: penyimpanannya satu proses, dan proses yang
 * hidup memegang keadaan di memori yang akan menimpa suntingan dari luar.
 *
 *   npx tsx scripts/bersihkan-maaf-riwayat.ts --periksa
 *   npx tsx scripts/bersihkan-maaf-riwayat.ts --kerjakan
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.cwd());
const HISTORY = join(REPO, "data", "history.json");

/**
 * Penanda kalimat gagal yang pernah dikirim Harvy.
 *
 * Sengaja frasa, bukan kalimat utuh: teksnya pernah berubah, dan yang perlu
 * dikenali adalah bekas dari semua versinya. Frasa ini tidak pernah muncul di
 * balasan biasa, jadi tidak ada risiko membuang percakapan sungguhan.
 */
const FAILURE_MARKERS: readonly string[] = [
  "nggak bisa mikir",
  "sambungan ke otakku",
  "nggak bisa memproses percakapan",
];

interface Turn {
  sequence: number;
  role: string;
  text: string;
  at: string;
}

interface History {
  turns?: Turn[];
  episodes?: unknown[];
  [key: string]: unknown;
}

interface Store {
  histories?: History[];
  [key: string]: unknown;
}

export function isFailureTurn(turn: Turn): boolean {
  // Hanya ucapan Harvy. Pesan pengguna yang kebetulan memuat frasa serupa
  // adalah percakapan sungguhan dan tidak boleh ikut terbuang.
  if (turn.role !== "harvy") return false;
  return FAILURE_MARKERS.some((marker) => turn.text.includes(marker));
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--kerjakan");
  const store = JSON.parse(readFileSync(HISTORY, "utf8")) as Store;

  let found = 0;
  let kept = 0;
  for (const history of store.histories ?? []) {
    const turns = history.turns ?? [];
    const remaining = turns.filter((turn) => {
      const failure = isFailureTurn(turn);
      if (failure) found += 1;
      return !failure;
    });
    kept += remaining.length;
    if (apply) history.turns = remaining;
  }

  console.log(`kalimat gagal ditemukan : ${found}`);
  console.log(`giliran yang disisakan  : ${kept}`);

  if (!apply) {
    console.log("\n(mode periksa; tambahkan --kerjakan untuk benar-benar membuang)");
    return;
  }

  // Cadangan dulu, lalu tulis lewat berkas sementara dan rename—pola yang sama
  // dengan penyimpanan Harvy sendiri, supaya berkas tidak pernah setengah jadi.
  const backup = `${HISTORY}.cadangan-${Date.now()}`;
  copyFileSync(HISTORY, backup);
  const temporary = `${HISTORY}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(temporary, HISTORY);
  console.log(`\ncadangan: ${backup}`);
  console.log("selesai. Jalankan Harvy lagi.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
