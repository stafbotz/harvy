/**
 * Menua-tidaknya sebuah memori diukur dari **pemakaian**, bukan hanya umur.
 *
 * Harvy sudah menua memori berdasarkan waktu: `expiryFor` memberi `context`
 * 60 hari dan `personal` 180 hari. Tetapi `profile`, `preference`, dan
 * `routine` tidak pernah kedaluwarsa dengan sendirinya, dan tidak ada apa pun
 * yang membaca `lastUsedAt` selain penulisnya. Akibatnya penyimpanan hanya
 * bertambah, dan ketika `MEMORY_STORAGE_LIMIT` tercapai `remember` menolak
 * dengan sebab "penuh" — untuk selamanya. Seorang pelajar yang memakai Harvy
 * cukup lama berhenti diingat hal baru, tanpa pernah diberi tahu.
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, maupun jam sistem.
 *
 * Asalnya `hermes/agent/curator.py` dan `hermes/tools/skill_usage.py`, beserta
 * dua invarian kerasnya yang ikut dibawa:
 *
 * 1. **Tidak pernah menghapus diam-diam sebagai kebiasaan.** Di Hermes aksi
 *    paling merusak adalah mengarsipkan, dan arsipnya dapat dikembalikan.
 *    Harvy belum punya arsip, jadi batasnya dipasang di tempat lain: retirasi
 *    hanya boleh terjadi saat penyimpanan benar-benar penuh dan hanya atas
 *    memori yang tidak pernah sekali pun ikut membantu sebuah balasan dalam
 *    jendela dormansi. Kalau tidak ada yang memenuhi syarat, penolakan "penuh"
 *    tetap berlaku apa adanya — gagal tertutup, bukan mengarang ruang.
 * 2. **Ada yang kebal.** Hermes mengecualikan skill yang dipin dan built-in
 *    yang menopang UX. Di sini `profile` yang kebal: memanggil seseorang
 *    dengan namanya yang benar tidak pernah menjadi salah konteks, dan
 *    jarang-tidaknya nama itu terpakai bukan ukuran apakah ia masih benar.
 */
import type { MemoryItem, MemoryKind } from "../domain/memory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Setelah sekian hari tanpa dipakai, memori disebut menua. */
export const STALE_AFTER_DAYS = 30;

/** Setelah sekian hari tanpa dipakai, memori boleh dipertimbangkan pensiun. */
export const DORMANT_AFTER_DAYS = 90;

export type MemoryActivity = "active" | "stale" | "dormant";

/**
 * Jenis yang tidak pernah menua karena jarang dipakai.
 *
 * Sengaja hanya satu. Menambah jenis ke sini berarti membuat penyimpanan lebih
 * mudah membeku lagi, jadi tiap tambahan harus punya alasan sekuat nama.
 */
function isExemptKind(kind: MemoryKind): boolean {
  return kind === "profile";
}

/**
 * Kapan memori ini terakhir benar-benar berguna.
 *
 * Memori yang belum pernah dipakai dihitung dari kelahirannya, sehingga
 * catatan yang baru dibuat tidak langsung dianggap terbengkalai.
 */
function lastActivityAt(item: MemoryItem): number {
  return new Date(item.lastUsedAt ?? item.createdAt).getTime();
}

export function daysSinceUse(item: MemoryItem, now: Date): number {
  const elapsed = now.getTime() - lastActivityAt(item);
  return elapsed <= 0 ? 0 : elapsed / DAY_MS;
}

export function classifyMemoryActivity(
  item: MemoryItem,
  now: Date,
): MemoryActivity {
  if (isExemptKind(item.kind)) return "active";
  const days = daysSinceUse(item, now);
  if (days >= DORMANT_AFTER_DAYS) return "dormant";
  if (days >= STALE_AFTER_DAYS) return "stale";
  return "active";
}

/**
 * Pengurang skor retrieval untuk memori yang lama tidak terpakai.
 *
 * Kecil dengan sengaja. Ini penyeimbang, bukan penentu: memori lama yang
 * benar-benar cocok dengan pesan sekarang tetap harus menang atas memori baru
 * yang tidak nyambung, persis seperti kebaruan diperlakukan di
 * `memory-policy.ts`. Yang dikoreksi hanya satu hal—catatan yang tidak pernah
 * sekali pun terpakai selama berbulan-bulan seharusnya tidak mendahului
 * catatan yang tiap minggu membantu.
 */
export function dormancyPenalty(item: MemoryItem, now: Date): number {
  switch (classifyMemoryActivity(item, now)) {
    case "dormant":
      return 2;
    case "stale":
      return 1;
    case "active":
      return 0;
  }
}

/**
 * Satu memori yang boleh dipensiunkan untuk memberi tempat, atau `null`.
 *
 * Mengembalikan `null` jauh lebih sering daripada tidak, dan itu memang
 * tujuannya. Syaratnya berlapis: penyimpanan harus benar-benar penuh, jenisnya
 * tidak kebal, dan ia harus melewati jendela dormansi penuh. Yang terpilih
 * adalah yang paling lama tidak tersentuh; seri diputus oleh yang lebih tua,
 * supaya hasilnya tidak bergantung pada urutan penyimpanan.
 *
 * Tidak ada di sini yang menghapus apa pun. Pemanggil yang memutuskan, dan
 * pemanggil pula yang wajib mencatatnya.
 */
export function retirableMemory(
  items: readonly MemoryItem[],
  now: Date,
): MemoryItem | null {
  let candidate: MemoryItem | null = null;
  let candidateActivity = Number.POSITIVE_INFINITY;

  for (const item of items) {
    if (classifyMemoryActivity(item, now) !== "dormant") continue;
    const activity = lastActivityAt(item);
    if (
      candidate === null ||
      activity < candidateActivity ||
      (activity === candidateActivity &&
        new Date(item.createdAt).getTime() <
          new Date(candidate.createdAt).getTime())
    ) {
      candidate = item;
      candidateActivity = activity;
    }
  }
  return candidate;
}

/** Memori yang layak ditanyakan ulang kepada pemiliknya. */
export function dormantMemories(
  items: readonly MemoryItem[],
  now: Date,
): MemoryItem[] {
  return items.filter((item) => classifyMemoryActivity(item, now) === "dormant");
}
