/**
 * Memeriksa apakah dokumentasi masih menggambarkan Harvy yang sekarang.
 *
 * Repositori ini punya 2,1 MB dokumentasi, jauh lebih banyak daripada yang
 * dapat dibaca ulang setiap kali kode berubah. Akibatnya dapat diramalkan dan
 * sudah terjadi berkali-kali: ADR-004 mendaftar empat hal "belum dikerjakan"
 * padahal keempatnya sudah ada, dan `CURRENT.md` menyebut baseline dari delapan
 * commit sebelumnya. Yang membacanya memahami Harvy masa lalu sebagai Harvy
 * sekarang.
 *
 * Yang diperiksa hanya klaim yang **dapat dibuktikan mesin**, bukan mutu
 * tulisannya:
 *
 * - berkas `src/...` yang disebut dokumen tetapi sudah tidak ada
 * - simbol kode dalam backtick yang sudah tidak ada di mana pun
 * - `CURRENT.md` yang baselinenya tertinggal terlalu jauh
 *
 * Ini tidak menangkap dokumen yang salah tetapi konsisten. Ia menangkap
 * dokumen yang menyebut sesuatu yang sudah tiada, dan itu kelas kekeliruan
 * yang paling sering terjadi sekaligus paling menyesatkan.
 *
 *   npx tsx scripts/periksa-dokumentasi.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(process.cwd());

/** Ambang tertinggalnya `CURRENT.md` sebelum dianggap menyesatkan. */
export const CURRENT_STALE_COMMITS = 12;

/**
 * Folder yang memang menggambarkan masa lalu, bukan keadaan sekarang.
 *
 * `docs/log/` adalah catatan harian: menyebut berkas yang sudah dihapus di
 * sana justru benar, karena begitulah keadaannya waktu itu. Memeriksanya
 * hanya menghasilkan kebisingan yang membuat pemeriksaan ini diabaikan.
 */
/**
 * API platform yang memang bukan milik Harvy.
 *
 * Konsol Harvy adalah antarmuka web, jadi menyebut `localStorage` di sana
 * benar. Tanpa daftar ini pemeriksaan akan berteriak pada hal yang tepat,
 * dan pemeriksaan yang berteriak palsu adalah pemeriksaan yang diabaikan.
 */
const PLATFORM_APIS = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "navigator",
  "structuredClone",
]);

const HISTORICAL = [
  "docs/log/",
  "docs/evidence/",
  // ADR adalah catatan keputusan bertanggal. Tugasnya menjelaskan mengapa
  // sesuatu diputuskan pada hari itu, bukan menjadi rujukan API hari ini;
  // kelas yang kemudian berganti nama tidak membuat keputusannya keliru.
  // Yang wajib dijaga pada ADR adalah field Status-nya, dan itu urusan
  // manusia yang mencabutnya.
  "docs/decisions/",
  "docs/engineering/status/archive/",
];

function markdownFiles(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry);
    if (statSync(full).isDirectory()) found.push(...markdownFiles(full));
    else if (entry.endsWith(".md")) {
      const relative = full.slice(REPO.length + 1).replaceAll("\\", "/");
      if (!HISTORICAL.some((skip) => relative.startsWith(skip))) found.push(full);
    }
  }
  return found;
}

export interface DocFinding {
  file: string;
  line: number;
  claim: string;
  reason: string;
}

/**
 * Jalur `src/...` di dalam backtick yang tidak ada lagi.
 *
 * Hanya `src/` dan `scripts/` yang diperiksa: keduanya kode nyata, sedangkan
 * `data/` dan `docs/` dapat berisi contoh atau berkas yang memang tidak
 * di-commit.
 */
export function missingPaths(text: string, file: string): DocFinding[] {
  const found: DocFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/`((?:src|scripts)\/[\w./-]+\.ts)`/gu)) {
      const path = match[1]!;
      if (existsSync(join(REPO, path))) continue;
      found.push({
        file,
        line: index + 1,
        claim: path,
        reason: "berkas tidak ada lagi",
      });
    }
  }
  return found;
}

/**
 * Simbol kode dalam backtick yang tidak ditemukan di mana pun.
 *
 * `tests/` ikut diindeks: dokumen sah menyebut nama assertion dan test
 * double, dan itu tetap kode nyata yang dapat dicari.
 *
 * Sengaja konservatif. Hanya nama berbentuk camelCase, PascalCase, atau
 * SCREAMING_CASE yang cukup panjang, dan hanya yang menyerupai identifier
 * program—sehingga istilah bahasa Indonesia dan kata sehari-hari tidak ikut
 * tertangkap.
 */
export function missingSymbols(
  text: string,
  file: string,
  sourceIndex: string,
): DocFinding[] {
  const found: DocFinding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const match of line.matchAll(/`([A-Za-z_][\w]{5,})(?:\(\))?`/gu)) {
      const symbol = match[1]!;
      const camel = /^[a-z]+[A-Z]/u.test(symbol);
      const pascal = /^[A-Z][a-z]+[A-Z]/u.test(symbol);
      const screaming = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/u.test(symbol);
      if (!camel && !pascal && !screaming) continue;
      if (PLATFORM_APIS.has(symbol)) continue;
      if (sourceIndex.includes(symbol)) continue;
      found.push({
        file,
        line: index + 1,
        claim: symbol,
        reason: "simbol tidak ada di src/",
      });
    }
  }
  return found;
}

/** Berapa commit `CURRENT.md` tertinggal dari `main`. */
export function currentBaselineLag(): { baseline: string; behind: number } | null {
  const text = readFileSync(join(REPO, "docs/agent/CURRENT.md"), "utf8");
  const baseline = /^Baseline:\s*(\S+)$/mu.exec(text)?.[1];
  if (!baseline) return null;
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${baseline}..HEAD`],
      { cwd: REPO, encoding: "utf8" },
    ).trim();
    return { baseline, behind: Number(count) };
  } catch {
    return { baseline, behind: Number.NaN };
  }
}

function readSourceIndex(folder: string): string {
  let text = "";
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry);
    if (statSync(full).isDirectory()) text += readSourceIndex(full);
    else if (entry.endsWith(".ts")) text += readFileSync(full, "utf8");
  }
  return text;
}

async function main(): Promise<void> {
  // Konfigurasi ikut diindeks: opsi seperti `noUncheckedIndexedAccess` dan
  // nama skrip npm nyata, hanya saja bukan di dalam `src/`.
  const sourceIndex = readSourceIndex(join(REPO, "src")) +
    readSourceIndex(join(REPO, "scripts")) +
    readSourceIndex(join(REPO, "tests")) +
    readFileSync(join(REPO, "tsconfig.json"), "utf8") +
    readFileSync(join(REPO, "package.json"), "utf8") +
    readFileSync(join(REPO, ".env.example"), "utf8");
  const findings: DocFinding[] = [];
  for (const file of markdownFiles(join(REPO, "docs"))) {
    const text = readFileSync(file, "utf8");
    const relative = file.slice(REPO.length + 1).replaceAll("\\", "/");
    findings.push(...missingPaths(text, relative));
    findings.push(...missingSymbols(text, relative, sourceIndex));
  }

  const lag = currentBaselineLag();
  console.log("=== CURRENT.md ===");
  if (!lag) console.log("  baseline tidak terbaca");
  else {
    console.log(`  baseline ${lag.baseline}, tertinggal ${lag.behind} commit`);
    if (lag.behind > CURRENT_STALE_COMMITS) {
      console.log(`  MELEWATI ambang ${CURRENT_STALE_COMMITS}`);
    }
  }

  console.log(`\n=== rujukan yang sudah tidak ada: ${findings.length} ===`);
  const perFile = new Map<string, DocFinding[]>();
  for (const finding of findings) {
    perFile.set(finding.file, [...(perFile.get(finding.file) ?? []), finding]);
  }
  for (const [file, items] of [...perFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${file}  (${items.length})`);
    for (const item of items.slice(0, 8)) {
      console.log(`  baris ${item.line}: ${item.claim} — ${item.reason}`);
    }
    if (items.length > 8) console.log(`  ... dan ${items.length - 8} lagi`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
