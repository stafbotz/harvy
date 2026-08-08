/**
 * Aturan main memori: apa yang boleh disimpan diam-diam, berapa lama ia hidup,
 * dan mana yang layak ikut masuk ke prompt.
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, maupun jam sistem. Waktu
 * selalu diberikan pemanggil supaya seluruh aturan di sini dapat diuji.
 */
import type { MemoryItem, MemoryKind } from "../domain/memory.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Masa hidup per jenis. `null` berarti tidak kedaluwarsa dengan sendirinya.
 *
 * `context` pendek karena ujian yang sudah lewat bukan pengetahuan tentang
 * pengguna, hanya sampah yang membuat Harvy salah bicara. `personal` diberi
 * batas supaya keadaan berat tidak menempel selamanya tanpa pernah ditinjau —
 * Pasal 3.9 menuntut ada batas penyimpanan, dan justru di sinilah batas itu
 * paling berarti.
 */
const LIFETIME_MS: Record<MemoryKind, number | null> = {
  profile: null,
  preference: null,
  routine: null,
  context: 60 * DAY_MS,
  personal: 180 * DAY_MS,
};

/**
 * Bobot jenis saat memilih memori untuk dibawa ke dalam prompt.
 *
 * `profile` selalu berguna: menyapa dengan nama yang benar tidak pernah salah
 * konteks. `personal` sengaja tidak diberi bobot tinggi — bahwa Harvy
 * mengingatnya tidak berarti ia perlu membawanya ke setiap percakapan.
 */
const KIND_WEIGHT: Record<MemoryKind, number> = {
  profile: 6,
  preference: 4,
  routine: 3,
  context: 3,
  personal: 2,
};

/** Berapa butir memori yang paling banyak ikut ke dalam satu prompt. */
export const MEMORY_PROMPT_LIMIT = 8;

/**
 * Jenis yang tidak boleh disimpan tanpa jawaban pengguna.
 *
 * Konstitusi Pasal 4 nomor 3. Harvy boleh mengingat curhat; yang dilarang
 * adalah menyimpannya diam-diam.
 */
export function isSensitiveKind(kind: MemoryKind): boolean {
  return kind === "personal";
}

/**
 * Apakah sebuah usulan memori harus lewat jalur izin.
 *
 * Dulu ini berisi daftar kata. Daftar itu gagal dua kali dengan cara yang sama:
 * ia menangkap "menyukai laki-laki" tetapi melewatkan "menyukai seseorang
 * berjenis kelamin pria", dan orientasi seksual seseorang tersimpan tanpa izin.
 * Satu daftar kata tidak pernah dapat mengejar semua cara orang menceritakan
 * hal yang sama.
 *
 * Sejak ADR-022, chat privat menilainya lewat classifier privasi khusus hanya
 * ketika compiler benar-benar menghasilkan kandidat memori. Port grup masih
 * memperoleh flag kompatibilitas dari screening gabungannya. Dalam kedua
 * jalur, `sensitiveByModel` adalah pendapat model dan jenis `personal` tetap
 * sensitif tanpa perlu ditanya.
 */
export function isSensitiveMemory(
  memory: Pick<MemoryItem, "kind">,
  sensitiveByModel = false,
): boolean {
  return isSensitiveKind(memory.kind) || sensitiveByModel;
}

export function expiryFor(kind: MemoryKind, now: Date): Date | null {
  const lifetime = LIFETIME_MS[kind];
  return lifetime === null ? null : new Date(now.getTime() + lifetime);
}

export function isExpired(item: MemoryItem, now: Date): boolean {
  if (!item.expiresAt) return false;
  return new Date(item.expiresAt).getTime() <= now.getTime();
}

/**
 * Memilih memori yang pantas ikut ke dalam prompt.
 *
 * Deterministik dan dapat diuji, bukan panggilan model kedua. Skornya
 * menjumlahkan tiga hal: kecocokan kata dengan pesan yang sedang ditangani,
 * bobot jenis, dan kebaruan. Yang kedaluwarsa tidak pernah ikut.
 */
export function selectRelevantMemories(
  items: MemoryItem[],
  message: string,
  now: Date,
  limit = MEMORY_PROMPT_LIMIT,
): MemoryItem[] {
  const words = significantWords(message);

  return items
    .filter((item) => !isExpired(item, now))
    // `top-k` tanpa ambang dulu membuat semua memori ikut bila jumlahnya
    // kurang dari delapan. Akibatnya catatan personal yang sama sekali tidak
    // relevan ikut ke prompt sapaan. Profile dasar boleh selalu ikut; jenis
    // lain harus benar-benar beririsan dengan topik sekarang.
    .filter((item) =>
      item.kind === "profile" ||
      wordOverlap(item.content, words) > 0
    )
    .map((item) => ({ item, score: scoreOf(item, words, now) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((scored) => scored.item);
}

function scoreOf(item: MemoryItem, words: Set<string>, now: Date): number {
  const content = significantWords(item.content);

  let overlap = 0;
  for (const word of content) {
    if (words.has(word)) overlap += 1;
  }

  const ageDays = (now.getTime() - new Date(item.createdAt).getTime()) / DAY_MS;
  // Kebaruan hanya penyeimbang, bukan penentu. Memori lama yang benar-benar
  // cocok dengan pesan harus tetap menang atas memori baru yang tidak nyambung.
  const recency = Math.max(0, 3 - ageDays / 30);

  return overlap * 5 + KIND_WEIGHT[item.kind] + recency;
}

function wordOverlap(content: string, words: Set<string>): number {
  let overlap = 0;
  for (const word of significantWords(content)) {
    if (words.has(word)) overlap += 1;
  }
  return overlap;
}

/**
 * Kata yang cukup berarti untuk dicocokkan.
 *
 * Kata sangat pendek dibuang karena "di", "ke", dan "aku" muncul di hampir
 * setiap kalimat dan hanya membuat semua memori terlihat sama relevannya.
 */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((word) => word.length > 3),
  );
}
