/**
 * Tawaran yang terus-menerus diabaikan berhenti ditawarkan.
 *
 * `adaptiveActions` memilih tombol yang boleh ditampilkan dari niat dan tingkat
 * risiko giliran ini saja. Ia tidak mengingat apa pun. Akibatnya seorang
 * pelajar yang sudah sepuluh kali melewatkan tawaran "tutor" tetap
 * ditawari "tutor" pada giliran kesebelas, dan Harvy terlihat tidak
 * mendengarkan hal yang paling jelas dikatakan orangnya: tidak dengan cara
 * berkata tidak, melainkan dengan cara tidak pernah menekannya.
 *
 * Konstitusi menyebut ini dua kali. "Harvy membantu, tetapi tidak mengambil
 * alih" pada mukadimah, dan Pasal 3.11 yang meminta pilihan tidak berlebihan
 * di depan. Menawarkan hal yang sama tanpa henti adalah bentuk mendesak yang
 * paling mudah luput karena tiap tawarannya, sendirian, terlihat sopan.
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, maupun jam sistem.
 *
 * Asalnya `hermes/cron/suggestions.py`, yang menjaga tiga hal sekaligus—usulan
 * tidak pernah dibuat sendiri, yang ditolak dikunci lewat `dedup_key` dan tidak
 * pernah ditawarkan lagi, dan daftar tertunggu dibatasi "so the list never
 * becomes a nag wall". Harvy sudah memenuhi yang pertama (tombol selalu
 * ditekan sendiri) dan yang ketiga (`adaptiveActions` memotong di tiga). Yang
 * hilang justru yang kedua, dan itulah isi berkas ini.
 *
 * Pola koolingnya sendiri sudah dikenal repositori ini: `economy-service`
 * memakai `dismissedUntil` dengan cooldown 30 hari untuk prompt dukungan.
 * Yang di sini mengikuti bentuk yang sama supaya tidak ada dua gagasan
 * berbeda tentang hal yang sama.
 */
import type { AdaptiveActionId } from "./action-policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Berapa kali berturut-turut sebuah tawaran boleh diabaikan sebelum diistirahatkan.
 *
 * Tiga, bukan satu. Sekali dilewatkan tidak berarti apa-apa—orang sedang
 * mengetik, atau tombolnya tidak terlihat di layar kecil. Tiga kali berturut
 * tanpa sekali pun ditekan barulah pola.
 */
export const OFFER_IGNORE_LIMIT = 3;

/**
 * Lama sebuah tawaran diistirahatkan.
 *
 * Beristirahat, bukan dihapus. Keadaan seorang pelajar berubah—yang tidak
 * berguna waktu ujian masih jauh bisa jadi persis yang dibutuhkan seminggu
 * sebelumnya. Latch permanen milik Hermes cocok untuk automasi yang dipilih
 * sekali; tawaran pendampingan bukan itu.
 */
export const OFFER_MUTE_MS = 14 * DAY_MS;

/**
 * Tawaran yang tidak pernah boleh diistirahatkan.
 *
 * Sepadan dengan `PROTECTED_BUILTIN_SKILLS` milik Hermes—daftar yang sengaja
 * dibuat kecil, berisi hal yang menopang jalur yang dijanjikan produk, dan
 * yang kalau diarsipkan diam-diam akan hilang tanpa sinyal apa pun.
 *
 * Di sini isinya bukan soal UX melainkan soal hak dan keselamatan:
 *
 * - `human_bridge` mengarahkan ke bantuan manusia. Pasal 3 revisi v0.3
 *   melarangnya dipakai sebagai cara menolak membantu, dan mengistirahatkannya
 *   karena jarang ditekan akan menghapus jalan keluar justru dari orang yang
 *   paling sering melewatinya.
 * - `data_controls` adalah pintu ke hak melihat, mengoreksi, dan menghapus
 *   data pada Pasal 4. Hak yang tombolnya menghilang karena jarang dipakai
 *   bukan lagi hak.
 *
 * Keduanya juga tidak pernah sampai ke sini pada giliran berisiko:
 * `adaptiveActions` sudah mengosongkan seluruh tawaran ketika risikonya bukan
 * `biasa`. Pengecualian ini menjaga giliran yang tenang.
 */
const NEVER_MUTED: ReadonlySet<AdaptiveActionId> = new Set<AdaptiveActionId>([
  "human_bridge",
  "data_controls",
]);

export interface OfferFatigueRecord {
  /** Berapa kali berturut-turut ditampilkan tanpa sekali pun ditekan. */
  ignored: number;
  /** ISO UTC. `null` berarti tidak sedang diistirahatkan. */
  mutedUntil: string | null;
}

/** Catatan per tawaran. Kosong berarti belum ada yang pernah ditampilkan. */
export type OfferFatigue = Partial<Record<AdaptiveActionId, OfferFatigueRecord>>;

export function isOfferMuted(
  fatigue: OfferFatigue | undefined,
  action: AdaptiveActionId,
  now: Date,
): boolean {
  if (NEVER_MUTED.has(action)) return false;
  const mutedUntil = fatigue?.[action]?.mutedUntil;
  if (!mutedUntil) return false;
  const until = Date.parse(mutedUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Menyaring tawaran yang sedang diistirahatkan.
 *
 * Dipanggil sesudah `adaptiveActions`, bukan menggantikannya. Urutan itu
 * penting: seluruh pagar niat dan risiko tetap berjalan lebih dahulu, dan
 * berkas ini hanya boleh membuang, tidak pernah menambah.
 */
export function withoutMutedOffers(
  actions: readonly AdaptiveActionId[],
  fatigue: OfferFatigue | undefined,
  now: Date,
): AdaptiveActionId[] {
  return actions.filter((action) => !isOfferMuted(fatigue, action, now));
}

/**
 * Mencatat bahwa tawaran ditampilkan dan tidak diambil.
 *
 * Mengembalikan catatan baru; tidak pernah mengubah yang diberikan. Yang
 * mencapai batas mulai diistirahatkan sejak `now`.
 */
export function recordOffersIgnored(
  fatigue: OfferFatigue | undefined,
  actions: readonly AdaptiveActionId[],
  now: Date,
): OfferFatigue {
  const next: OfferFatigue = { ...fatigue };
  for (const action of new Set(actions)) {
    if (NEVER_MUTED.has(action)) continue;
    const current = next[action];
    const ignored = (current?.ignored ?? 0) + 1;
    next[action] = ignored >= OFFER_IGNORE_LIMIT
      ? { ignored: 0, mutedUntil: new Date(now.getTime() + OFFER_MUTE_MS).toISOString() }
      : { ignored, mutedUntil: current?.mutedUntil ?? null };
  }
  return next;
}

/**
 * Mencatat bahwa tawaran benar-benar dipakai.
 *
 * Menghapus catatannya seluruhnya, bukan sekadar mengurangi hitungan. Sekali
 * seorang pelajar menekannya, apa pun yang terjadi sebelumnya tidak lagi
 * menggambarkan apa yang ia inginkan.
 */
export function recordOfferTaken(
  fatigue: OfferFatigue | undefined,
  action: AdaptiveActionId,
): OfferFatigue {
  if (!fatigue || !(action in fatigue)) return { ...fatigue };
  const next: OfferFatigue = { ...fatigue };
  delete next[action];
  return next;
}
