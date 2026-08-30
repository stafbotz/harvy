import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCaseCommands,
  MAX_TESTER_COMMANDS,
  splitIntoBatches,
} from "../scripts/uji-telegram-langsung.js";
import { LIVE_TELEGRAM_CASES } from "../scripts/live-telegram-cases.js";
import type { LiveTelegramCase } from "../scripts/live-telegram-cases.js";

/**
 * Batas 32 perintah milik tester adalah batas per sesi, bukan batas korpus.
 * Sampai 30 Agustus 2026 harness berhenti dengan kode 2 begitu korpus melewatinya,
 * sehingga kasus kesepuluh tidak dapat ditambahkan sama sekali—dan dua kelas yang
 * paling dibutuhkan, keselamatan dan kesadaran Harvy saat memotong, keduanya
 * tertahan di situ.
 */
describe("pembagian sesi penguji Telegram", () => {
  it("membiarkan korpus yang muat tetap satu sesi", () => {
    const batches = splitIntoBatches(LIVE_TELEGRAM_CASES);

    assert.equal(batches.length, 1);
    assert.ok(batches[0]!.lines.length <= MAX_TESTER_COMMANDS);
  });

  it("memecah korpus besar tanpa melewati batas satu sesi pun", () => {
    const batches = splitIntoBatches(grown(40));

    assert.ok(batches.length > 1, "korpus 40 kasus wajib terpecah");
    for (const [index, batch] of batches.entries()) {
      assert.ok(
        batch.lines.length <= MAX_TESTER_COMMANDS,
        `batch ${index + 1} memakai ${batch.lines.length} perintah`,
      );
    }
  });

  // Penjaga terpenting berkas ini. Kasus yang terpotong di tengah menghasilkan
  // sesi yang tampak berjalan tetapi mengukur bentuk giliran yang berbeda:
  // `interrupt` menuntut giliran yang masih aktif, dan `burst` menuntut ketiga
  // bubble-nya berurutan tanpa jeda sesi.
  it("tidak pernah memotong satu kasus menjadi dua sesi", () => {
    const grownCases = grown(40);
    const batches = splitIntoBatches(grownCases);
    const seen: string[] = [];
    for (const batch of batches) {
      for (const id of batch.caseBySequence) {
        if (id !== null && !seen.includes(id)) seen.push(id);
      }
    }

    // Setiap kasus muncul tepat sekali, dan seluruh perintahnya berada dalam
    // batch yang sama—dibuktikan dengan menyusun ulang batch dari daftar id-nya
    // dan mendapatkan rencana yang identik.
    assert.equal(seen.length, grownCases.length);
    for (const batch of batches) {
      const ids = new Set(
        batch.caseBySequence.filter((id): id is string => id !== null),
      );
      const rebuilt = buildCaseCommands(
        grownCases.filter((testCase) => ids.has(testCase.id)),
      );
      assert.deepEqual(rebuilt.lines, batch.lines);
    }
  });

  it("mempertahankan urutan kasus lintas sesi", () => {
    const grownCases = grown(25);
    const order: string[] = [];
    for (const batch of splitIntoBatches(grownCases)) {
      for (const id of batch.caseBySequence) {
        if (id !== null && order.at(-1) !== id) order.push(id);
      }
    }

    assert.deepEqual(order, grownCases.map((testCase) => testCase.id));
  });
});

/** Korpus buatan sepanjang `size`, memakai bentuk kasus nyata secara bergantian. */
function grown(size: number): LiveTelegramCase[] {
  const cases: LiveTelegramCase[] = [];
  for (let index = 0; index < size; index += 1) {
    const source = LIVE_TELEGRAM_CASES[index % LIVE_TELEGRAM_CASES.length]!;
    cases.push({ ...source, id: `${source.id}-${index}` });
  }
  return cases;
}
