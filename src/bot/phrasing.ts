/**
 * Kalimat Harvy yang tidak berasal dari model.
 *
 * Konfirmasi, sapaan pendek, dan penanda tindakan ditulis di kode supaya murah
 * dan pasti. Tetapi kalimat yang persis sama setiap kali membuat Harvy terdengar
 * seperti mesin absensi: teman tidak punya satu kalimat untuk selamanya. Modul
 * ini menyimpan beberapa bentuk untuk tiap keadaan lalu memilih satu.
 *
 * Murni dan dapat diuji: pemilihnya diberikan dari luar, dan `Math.random`
 * hanya nilai bawaannya.
 */
export type Randomizer = () => number;

/** Minimal satu bentuk, supaya pemilihan tidak pernah menghasilkan kosong. */
type Variants = readonly [string, ...string[]];

function pick(variants: Variants, random: Randomizer): string {
  const index = Math.floor(random() * variants.length);
  const bounded = Math.min(Math.max(index, 0), variants.length - 1);
  return variants[bounded] ?? variants[0];
}

const TASK_SAVED: Variants = [
  "Aku catat, ya.",
  "Oke, udah masuk daftar.",
  "Siap, aku simpan dulu.",
  "Aku pegang ini, ya.",
];

const TASK_DECLINED: Variants = [
  "Oke, nggak aku catat.",
  "Siap, aku lewatin.",
  "Oke, aku biarin aja.",
];

const TASK_DROPPED: Variants = [
  "Sudah aku batalkan.",
  "Oke, aku hapus.",
  "Udah aku buang dari daftarmu.",
];

const TASK_MISSING: Variants = [
  "Tugas itu sudah tidak ada.",
  "Yang itu udah nggak ada di daftarmu.",
];

const NOTHING_LEFT: Variants = [
  "Semua beres; tugas aktifmu sekarang kosong.",
  "Sekarang nggak ada tugas aktif yang tersisa.",
  "Daftar tugas aktifmu sudah kosong.",
];

const EMPTY_LIST: Variants = [
  "Belum ada yang perlu dikerjakan. Tulis aja kalau nanti ada yang muncul.",
  "Daftarmu masih kosong. Nanti tinggal kamu tulis kalau ada.",
];

const LIST_LEAD: Variants = [
  "Ini urutan yang aku sarankan, dari yang paling mendesak:",
  "Dari yang paling mendesak, urutannya gini:",
  "Kalau menurutku, mulai dari yang paling atas:",
];

const NOT_UNDERSTOOD: Variants = [
  "Aku belum nangkep maksudnya. Coba tulis ulang pakai kalimat lain, ya.",
  "Hmm, yang ini belum kebaca sama aku. Boleh tulis ulang beda kalimat?",
  "Maaf, aku belum ngerti bagian ini. Coba bilang dengan cara lain?",
];

const COMPLETED_MARK: Variants = ["Selesai ✓", "Beres ✓", "Kelar ✓"];

export function taskSavedHeading(random: Randomizer = Math.random): string {
  return pick(TASK_SAVED, random);
}

export function taskDeclinedNote(random: Randomizer = Math.random): string {
  return pick(TASK_DECLINED, random);
}

export function taskDroppedHeading(random: Randomizer = Math.random): string {
  return pick(TASK_DROPPED, random);
}

export function taskMissingNote(random: Randomizer = Math.random): string {
  return pick(TASK_MISSING, random);
}

export function nothingLeftNote(random: Randomizer = Math.random): string {
  return pick(NOTHING_LEFT, random);
}

export function emptyListNote(random: Randomizer = Math.random): string {
  return pick(EMPTY_LIST, random);
}

export function taskListLead(random: Randomizer = Math.random): string {
  return pick(LIST_LEAD, random);
}

export function notUnderstoodNote(random: Randomizer = Math.random): string {
  return pick(NOT_UNDERSTOOD, random);
}

export function taskCompletedHeading(
  title: string,
  random: Randomizer = Math.random,
): string {
  return `${pick(COMPLETED_MARK, random)} ${title}`;
}
