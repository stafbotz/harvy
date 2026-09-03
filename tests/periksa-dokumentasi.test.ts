import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  CURRENT_STALE_COMMITS,
  currentBaselineLag,
  missingPaths,
  missingSymbols,
} from "../scripts/periksa-dokumentasi.js";

/**
 * Dokumentasi yang tertinggal membuat pembacanya memahami Harvy masa lalu
 * sebagai Harvy sekarang.
 *
 * Itu sudah terjadi berkali-kali dan tidak pernah tertangkap apa pun. ADR-004
 * mendaftar empat hal "belum dikerjakan" padahal keempatnya sudah ada;
 * `docs/engineering/status/memory.md` menyatakan pencarian semantik mati
 * padahal sudah hidup; `CURRENT.md` menyebut baseline dari delapan commit
 * sebelumnya. Tidak ada satu pun yang salah waktu ditulis—semuanya menjadi
 * salah karena kodenya bergerak dan dokumennya tidak.
 *
 * Membaca ulang 2,1 MB dokumentasi setiap kali kode berubah tidak mungkin.
 * Karena itu yang dapat dibuktikan mesin dijaga mesin, dan berkas ini
 * membuatnya merah alih-alih menunggu ada yang kebetulan menyadarinya.
 *
 * Yang dijaga hanya rujukan yang dapat dicari, bukan mutu tulisannya. Dokumen
 * yang keliru tetapi konsisten tetap lolos, dan itu memang di luar jangkauan
 * mesin mana pun.
 */
const REPO = resolve(process.cwd());

/** Sama persis dengan skripnya; diulang di sini agar tesnya berdiri sendiri. */
const HISTORICAL = [
  "docs/log/",
  "docs/evidence/",
  "docs/decisions/",
  "docs/engineering/status/archive/",
];

function livingDocs(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry);
    if (statSync(full).isDirectory()) found.push(...livingDocs(full));
    else if (entry.endsWith(".md")) {
      const relative = full.slice(REPO.length + 1).replaceAll("\\", "/");
      if (!HISTORICAL.some((skip) => relative.startsWith(skip))) found.push(full);
    }
  }
  return found;
}

function sourceIndex(folder: string): string {
  let text = "";
  for (const entry of readdirSync(folder)) {
    const full = join(folder, entry);
    if (statSync(full).isDirectory()) text += sourceIndex(full);
    else if (entry.endsWith(".ts")) text += readFileSync(full, "utf8");
  }
  return text;
}

describe("dokumentasi masih menggambarkan Harvy yang sekarang", () => {
  const index = sourceIndex(join(REPO, "src")) +
    sourceIndex(join(REPO, "scripts")) +
    sourceIndex(join(REPO, "tests")) +
    readFileSync(join(REPO, "tsconfig.json"), "utf8") +
    readFileSync(join(REPO, "package.json"), "utf8") +
    readFileSync(join(REPO, ".env.example"), "utf8");

  /**
   * Backtick berarti "pembaca dapat menemukannya di repositori ini".
   *
   * Itu aturannya, dan itu pula yang membuat pemeriksaan ini mungkin. Dokumen
   * yang sengaja menyebut sesuatu yang sudah tiada—misalnya menjelaskan bahwa
   * suatu kelas dihapus—cukup menuliskannya tanpa backtick.
   */
  it("tidak menyebut berkas atau simbol yang sudah tiada", () => {
    const findings = livingDocs(join(REPO, "docs")).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const relative = file.slice(REPO.length + 1).replaceAll("\\", "/");
      return [
        ...missingPaths(text, relative),
        ...missingSymbols(text, relative, index),
      ];
    });

    assert.deepEqual(
      findings.map((item) => `${item.file}:${item.line} ${item.claim}`),
      [],
      "dokumen hidup menyebut sesuatu yang tidak ada lagi di kode",
    );
  });

  /**
   * `CURRENT.md` adalah berkas pertama yang dibaca siapa pun yang ingin tahu
   * keadaan Harvy. Ia yang paling mahal bila basi, dan paling mudah basi
   * karena tidak ada yang memaksanya disegarkan.
   */
  it("CURRENT.md tidak tertinggal terlalu jauh dari main", () => {
    const lag = currentBaselineLag();
    assert.ok(lag, "baseline CURRENT.md tidak terbaca");
    if (Number.isNaN(lag.behind)) return; // baseline belum ada di riwayat lokal
    assert.ok(
      lag.behind <= CURRENT_STALE_COMMITS,
      `CURRENT.md tertinggal ${lag.behind} commit dari ${lag.baseline}; ` +
        `ambangnya ${CURRENT_STALE_COMMITS}. Segarkan sebelum melanjutkan.`,
    );
  });
});
