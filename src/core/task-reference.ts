import type { StudentTask } from "../domain/task.js";

const GENERIC_REFERENCE_TERMS = new Set([
  "task",
  "tugas",
  "yang",
  "itu",
  "ini",
  "tersebut",
]);

/**
 * Resolusi hanya berlangsung di daftar active milik owner yang sudah dibaca
 * adapter. Satu kandidat boleh dipilih langsung; banyak kandidat wajib punya
 * satu skor lexical tertinggi agar model tidak menebak record yang dimutasi.
 */
export function resolveActiveTaskReference(
  active: readonly StudentTask[],
  target: string | null,
): StudentTask | null {
  if (active.length === 0) return null;
  const targetTerms = meaningfulTerms(target ?? "");
  if (active.length === 1) {
    const only = active[0];
    if (!only) return null;
    // Tanpa sebutan spesifik, satu-satunya tugas aktif memang yang dimaksud.
    if (targetTerms.size === 0) return only;
    // Dengan sebutan spesifik, sebutan itu harus benar-benar menunjuk tugas
    // ini. Sebelumnya kandidat tunggal dipilih tanpa memeriksa target sama
    // sekali, sehingga "tandai selesai tugas kimia" menyelesaikan satu-satunya
    // tugas yang ada meski judulnya fisika. Jalur dua kandidat atau lebih sudah
    // menuntut kecocokan; kandidat tunggal tidak boleh lebih longgar justru
    // untuk mutasi yang merusak.
    return relatesTo(targetTerms, meaningfulTerms(only.title)) ? only : null;
  }
  if (targetTerms.size === 0) return null;
  const ranked = active
    .map((task) => ({
      task,
      score: [...meaningfulTerms(task.title)]
        .filter((term) => targetTerms.has(term)).length,
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score === 0 || ranked[1]?.score === best.score) return null;
  return best.task;
}

/** Panjang akar bersama minimum agar dua kata dianggap menunjuk hal yang sama. */
const SHARED_ROOT_CHARACTERS = 5;

/**
 * Kecocokan longgar untuk afiks bahasa Indonesia.
 *
 * "peninjauan" dan "meninjau" adalah kata yang sama bagi pengguna, tetapi tidak
 * pernah sama persis sebagai string. Membandingkan akar bersama menangkap
 * pasangan itu tanpa ikut menyamakan "kimia" dengan "fisika".
 */
function relatesTo(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const term of left) {
    for (const other of right) {
      if (term === other) return true;
      const shorter = term.length <= other.length ? term : other;
      const longer = shorter === term ? other : term;
      if (shorter.length >= SHARED_ROOT_CHARACTERS && longer.includes(shorter)) {
        return true;
      }
      if (sharedRunLength(term, other) >= SHARED_ROOT_CHARACTERS) return true;
    }
  }
  return false;
}

/** Substring bersama terpanjang; cukup untuk kata pendek bahasa Indonesia. */
function sharedRunLength(left: string, right: string): number {
  let best = 0;
  for (let start = 0; start < left.length; start += 1) {
    for (let end = left.length; end > start + best; end -= 1) {
      if (right.includes(left.slice(start, end))) {
        best = end - start;
        break;
      }
    }
  }
  return best;
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length >= 2 && !GENERIC_REFERENCE_TERMS.has(term)),
  );
}
