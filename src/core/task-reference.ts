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
  if (active.length === 1) return active[0] ?? null;
  const targetTerms = meaningfulTerms(target ?? "");
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

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length >= 2 && !GENERIC_REFERENCE_TERMS.has(term)),
  );
}
