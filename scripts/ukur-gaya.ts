/**
 * Mengukur bentuk balasan Harvy: seberapa jauh ia menulis seperti dokumen.
 *
 * Sesi percakapan langsung 1 September 2026 memperlihatkan balasan substantif
 * pertama berupa dua daftar berbutir, tiga pertanyaan bernomor, dan penutup—
 * untuk pesan panik satu baris. Pemilik produk menyebutnya "terlalu formal", dan
 * diagnosisnya ternyata bukan kosakata: kata-katanya sudah santai ("waduh",
 * "banget"), yang formal adalah **tipografinya**.
 *
 * Yang dihitung di sini sengaja hal yang dapat dihitung, bukan kesan:
 *
 * - berapa pertanyaan diajukan sebelum menolong
 * - ada tidaknya butir, penomoran, panah, tanda hubung panjang
 * - berapa emoji
 * - panjang karakter dan jumlah baris
 *
 * Arahan bentuk (`shapeDirective`) sudah melarang semua itu sejak 31 Agustus.
 * Jadi pertanyaan pertamanya bukan "apa yang harus ditambahkan", melainkan
 * "kenapa yang sudah ada tidak dipatuhi"—dan itu hanya terjawab dengan
 * menjalankan model sungguhan.
 *
 *   npx tsx scripts/ukur-gaya.ts
 *   npx tsx scripts/ukur-gaya.ts --label=sesudah --putaran=1
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.cwd());

/**
 * Pembuka yang bentuknya paling sering bikin Harvy menjawab seperti dokumen.
 *
 * Sengaja bervariasi panjang dan nada: panik, datar, emosional, dan permintaan
 * eksplisit. Yang terakhir adalah kontrol—di sana struktur memang pantas, jadi
 * kalau ia ikut hilang berarti arahannya terlalu jauh.
 */
const OPENERS: readonly {
  id: string;
  variants: readonly string[];
  structureOk?: boolean;
}[] = [
  {
    id: "panik",
    variants: [
      "anjir bsk ulangan mtk gua blm belajar sama sekali",
      "waduh lusa ada ujian fisika gua blm nyentuh materinya",
      "gawat minggu depan uts kimia gua belum siap apa apa",
    ],
  },
  {
    id: "datar",
    variants: [
      "besok ada ulangan biologi",
      "hari jumat ada kuis sejarah",
      "minggu depan ada ujian geografi",
    ],
  },
  {
    id: "emosi",
    variants: [
      "gua ngerasa bego banget, temen2 udah pada ngerti semua",
      "aku ngerasa ketinggalan jauh, yang lain kayaknya paham semua",
      "kayaknya cuma gua yang gagal paham, malu banget rasanya",
    ],
  },
  {
    id: "tanya",
    variants: [
      "sin cos tan itu bedanya apa sih",
      "mol sama massa molar itu beda ya",
      "gaya gesek statis sama kinetis bedanya apa",
    ],
  },
  {
    id: "minta-struktur",
    variants: [
      "tolong buatin daftar langkah belajar trigonometri dari nol",
      "coba susunin urutan langkah belajar stoikiometri dari awal",
      "buatkan daftar tahapan belajar hukum newton dari dasar",
    ],
    structureOk: true,
  },
];

interface Shape {
  characters: number;
  lines: number;
  questions: number;
  bullets: number;
  numbered: number;
  arrows: number;
  emoji: number;
}

export function measureShape(reply: string): Shape {
  const lines = reply.split("\n");
  return {
    characters: reply.length,
    lines: lines.length,
    questions: (reply.match(/\?/gu) ?? []).length,
    bullets: lines.filter((line) => /^\s*[-*•]\s/u.test(line)).length,
    numbered: lines.filter((line) => /^\s*\d+[.)]\s/u.test(line)).length,
    arrows: (reply.match(/→|->/gu) ?? []).length,
    // Rentang emoji utama; cukup untuk menghitung, tidak perlu sempurna.
    emoji: (reply.match(/\p{Extended_Pictographic}/gu) ?? []).length,
  };
}

function probe(text: string): string | null {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/probe-chat.ts", `--message=${text}`],
    { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ""}`;
  // Probe mencetak satu objek JSON; balasannya di field `harvy`.
  const match = /"harvy":\s*"((?:[^"\\]|\\.)*)"/u.exec(output);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const label = process.argv.find((value) => value.startsWith("--label="))
    ?.slice("--label=".length) ?? "baseline";
  console.log(`label: ${label}\n`);
  console.log(
    `${"kasus".padEnd(16)}${"char".padStart(6)}${"baris".padStart(6)}` +
      `${"tanya".padStart(6)}${"butir".padStart(6)}${"nomor".padStart(6)}` +
      `${"panah".padStart(6)}${"emoji".padStart(6)}`,
  );
  const rows: Shape[] = [];
  // Varian dipilih per putaran, bukan tetap. Dua putaran dengan pesan sama
  // persis pernah mengembalikan angka identik—469, 715, 998—dan itu bukan
  // kestabilan melainkan cache jawaban provider. Alat ukur yang mengulang
  // kalimat yang sama mengukur cache, bukan perilaku.
  const round = Number(
    process.argv.find((value) => value.startsWith("--putaran="))
      ?.slice("--putaran=".length) ?? "0",
  );
  for (const opener of OPENERS) {
    const text = opener.variants[round % opener.variants.length] ??
      opener.variants[0]!;
    const reply = probe(text);
    if (reply === null) {
      console.log(`${opener.id.padEnd(16)}(gagal)`);
      continue;
    }
    const shape = measureShape(reply);
    rows.push(shape);
    console.log(
      `${opener.id.padEnd(16)}${String(shape.characters).padStart(6)}` +
        `${String(shape.lines).padStart(6)}${String(shape.questions).padStart(6)}` +
        `${String(shape.bullets).padStart(6)}${String(shape.numbered).padStart(6)}` +
        `${String(shape.arrows).padStart(6)}${String(shape.emoji).padStart(6)}` +
        (opener.structureOk ? "   (struktur boleh)" : ""),
    );
  }
  if (rows.length === 0) return;
  const sum = (pick: (shape: Shape) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  console.log(
    `\ntotal: ${sum((r) => r.questions)} pertanyaan, ` +
      `${sum((r) => r.bullets)} butir, ${sum((r) => r.numbered)} nomor, ` +
      `${sum((r) => r.arrows)} panah, ${sum((r) => r.emoji)} emoji, ` +
      `${Math.round(sum((r) => r.characters) / rows.length)} char rata-rata`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
