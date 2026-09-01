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

interface Episode {
  source?: { kind?: string; throughSequence?: number };
}

interface History {
  turns?: Turn[];
  episodes?: Episode[];
  nextSequence?: number;
  [key: string]: unknown;
}

/**
 * Nomor urut terakhir yang sudah tertutup episode.
 *
 * Giliran mentah pertama wajib tepat satu di atas angka ini—`readHistoryV2`
 * menolak seluruh basis data bila tidak.
 */
function latestEpisodeThrough(history: History): number {
  let through = 0;
  for (const episode of history.episodes ?? []) {
    if (episode.source?.kind === "turn-range") {
      through = Math.max(through, episode.source.throughSequence ?? 0);
    }
  }
  return through;
}

interface Store {
  histories?: History[];
  [key: string]: unknown;
}

/**
 * Memeriksa invarian yang dituntut `readHistoryV2` sebelum berkasnya ditulis.
 *
 * Sengaja mengulang syaratnya di sini, bukan mengimpor pembacanya: yang perlu
 * dijaga adalah kontraknya, dan menuliskannya ulang membuat kontrak itu terbaca
 * oleh siapa pun yang menyunting skrip ini. Mengembalikan alasan kegagalan
 * pertama, atau null bila sah.
 */
export function verify(store: Store): string | null {
  for (const history of store.histories ?? []) {
    const turns = history.turns ?? [];
    for (let index = 1; index < turns.length; index += 1) {
      if (turns[index]!.sequence !== turns[index - 1]!.sequence + 1) {
        return `nomor urut berlubang di sekitar ${turns[index]!.sequence}`;
      }
    }
    const through = latestEpisodeThrough(history);
    const first = turns[0];
    if (first && first.sequence !== through + 1) {
      return `giliran pertama ${first.sequence}, seharusnya ${through + 1}`;
    }
    const last = turns.at(-1);
    const greatest = Math.max(through, last?.sequence ?? 0);
    if ((history.nextSequence ?? 0) <= greatest) {
      return `nextSequence ${history.nextSequence} tidak di atas ${greatest}`;
    }
    // Di atas saja tidak cukup: ia harus **tepat** menyambung, atau
    // giliran berikutnya lahir dengan lubang dan `save()` menolaknya.
    if (last && history.nextSequence !== last.sequence + 1) {
      return `nextSequence ${history.nextSequence} tidak menyambung ${last.sequence}`;
    }
  }
  return null;
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
    if (!apply) continue;

    // Nomor urut WAJIB dinomori ulang berurutan tanpa lubang.
    //
    // Versi pertama skrip ini hanya membuang giliran dan meninggalkan lubang di
    // nomor urutnya. `readHistoryV2` menolak seluruh basis data karena itu—ia
    // menuntut `turn.sequence === previous.sequence + 1`, giliran pertama tepat
    // di atas episode terakhir, dan `nextSequence` di atas semuanya. Akibatnya
    // setiap giliran gagal dengan "Isi basis data riwayat v2 tidak sah", dan
    // Harvy praktis mati sampai berkasnya dikembalikan.
    //
    // Menomori ulang aman: episode hanya menunjuk giliran yang sudah dipadatkan
    // dan berada di bawah `latestEpisodeThrough`, sedangkan yang dinomori ulang
    // hanya ekor mentah di atasnya.
    let sequence = latestEpisodeThrough(history) + 1;
    history.turns = remaining.map((turn) => ({
      ...turn,
      sequence: sequence++,
    }));
    // Persis satu di atas giliran terakhir, BUKAN nilai lama yang lebih
    // tinggi. Menahan angka lama membuat giliran berikutnya lahir dengan
    // nomor jauh di atas yang terakhir—lubang lagi, dan `save()` menolak
    // seluruh riwayat. Itu terjadi: 228 lalu 244, dan Harvy gagal menulis
    // tiap giliran meski membacanya sudah berhasil.
    //
    // Menurunkannya aman: nomor yang dilepas milik giliran yang sudah
    // dibuang, dan episode hanya menunjuk nomor di bawah ekor ini.
    history.nextSequence = sequence;
  }

  console.log(`kalimat gagal ditemukan : ${found}`);
  console.log(`giliran yang disisakan  : ${kept}`);

  if (!apply) {
    console.log("\n(mode periksa; tambahkan --kerjakan untuk benar-benar membuang)");
    return;
  }

  // Hasilnya diperiksa sebelum ditulis, bukan sesudah.
  //
  // Versi pertama skrip ini menulis berkas yang ditolak `readHistoryV2`, dan
  // akibatnya baru terlihat sebagai giliran yang gagal satu per satu di kanal—
  // bukan sebagai galat di sini. Skrip yang menyentuh data pengguna wajib
  // membuktikan hasilnya masih sah sebelum menyentuh berkas aslinya.
  const invalid = verify(store);
  if (invalid) {
    console.error(`\nDIBATALKAN: hasilnya tidak sah — ${invalid}`);
    console.error("Berkas asli tidak disentuh.");
    process.exitCode = 1;
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
