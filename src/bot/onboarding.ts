import { InlineKeyboard } from "grammy";
import type { StylePreference } from "../domain/profile.js";

/**
 * Perkenalan pada kontak pertama.
 *
 * Dipicu oleh kontak pertama, bukan oleh `/start`. Perintah hanyalah salah satu
 * pintu masuk, dan Pasal 3.11 melarang pengguna dipaksa menghafal perintah untuk
 * memakai sesuatu — termasuk untuk berkenalan.
 *
 * Dua hal yang sengaja tidak ada di sini: daftar fitur dan frasa "AI
 * pendamping". Yang pertama membuat pengguna membaca manual sebelum merasakan
 * percakapan; yang kedua membuat kemampuan Harvy terdengar sempit sejak kalimat
 * pertama. Transparansi bahwa Harvy berjalan dengan AI tetap ada — Pasal 3.6 dan
 * 3.9 mewajibkannya — tetapi disampaikan sebagai keterusterangan, bukan sebagai
 * label identitas.
 */
export function introBubbles(
  firstName: string | null,
  heldMessage: boolean,
): string[] {
  const name = usableName(firstName);
  const opening = name ? `Hai ${name}, aku Harvy 🌿` : "Hai, aku Harvy 🌿";

  const consent = [
    "Satu hal dulu biar jujur di depan: aku jalan pakai AI, dan biar bisa ngerti pesanmu, isinya dikirim ke layanan AI di luar Harvy. Aku juga bisa salah, jadi hal penting tetap perlu kamu cek sendiri.",
  ];

  if (heldMessage) {
    // Naskah ini pernah berbunyi "belum aku baca". Sejak pemeriksaan bahaya
    // boleh berjalan sebelum persetujuan (Konstitusi v0.3 Pasal 3.9), kalimat
    // itu tidak benar lagi — dan Pasal 5 nomor 6 melarang mengarang tindakan
    // yang tidak dilakukan. Yang berubah bukan perilakunya, melainkan
    // kejujurannya.
    consent.push(
      "",
      "Pesanmu yang barusan cuma aku lihat sekilas dulu, buat mastiin kamu lagi nggak dalam bahaya. Selebihnya belum aku proses sampai kamu oke.",
    );
  }

  return [
    [
      opening,
      "",
      "Ke sini boleh bawa apa aja — cerita yang masih berantakan, pertanyaan, tugas yang numpuk, rencana, atau hal yang kamu sendiri belum tau mau mulai dari mana.",
    ].join("\n"),
    consent.join("\n"),
  ];
}

export function consentActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Oke, mulai", "consent:yes")
    .text("Aku mau tanya dulu", "consent:info");
}

/**
 * Penjelasan yang lebih panjang, hanya untuk yang memintanya.
 *
 * Pasal 2 nomor 3 memberi hak atas penjelasan yang jujur, dan Pasal 3.9 meminta
 * penjelasan yang sesuai usia. Karena itu isinya kalimat biasa, bukan kebijakan
 * privasi, dan ia tidak dipaksakan kepada yang tidak bertanya.
 */
export const CONSENT_DETAIL = [
  "Boleh. Ini apa adanya:",
  "",
  "• Isi pesanmu dikirim ke layanan AI di luar Harvy supaya bisa dipahami. Tanpa itu aku nggak bisa jalan sama sekali.",
  "• Satu pengecualian, dan cuma satu: pesan pertamamu aku lihat sekilas sebelum kamu setuju, khusus buat ngecek kamu lagi dalam bahaya atau nggak. Kalau iya, aku nggak mau kamu nunggu tombol dulu.",
  "• Aku nyimpen sebagian obrolan kita dan beberapa catatan tentang kamu, biar kamu nggak perlu ngulang cerita. Yang sifatnya pribadi selalu aku tanya dulu sebelum disimpan.",
  "• Kapan aja kamu bisa nanya apa yang aku inget, dan nyuruh aku lupain — satu per satu atau semuanya sekalian.",
  "• Aku bukan terapis, dokter, atau layanan darurat. Kalau keadaannya berat atau bahaya, manusia yang harus kamu hubungi, bukan aku.",
  "",
  "Kalau kamu oke, kita mulai.",
].join("\n");

/**
 * Jawaban untuk pesan pertama yang menunjukkan bahaya segera.
 *
 * Ditulis sebagai teks tetap, bukan hasil model, karena persetujuan pengiriman
 * ke penyedia pihak ketiga belum ada. Pasal 3.8 meminta bahaya serius
 * diutamakan; Pasal 3.9 tidak memberi pengecualian untuk mengirim isi pesan ke
 * luar tanpa izin. Keduanya bisa dipenuhi sekaligus justru dengan tidak
 * memanggil model sama sekali di titik ini.
 */
export const PRE_CONSENT_SAFETY = [
  "Aku baca ada yang berat banget di pesanmu, dan itu aku tanggapi duluan.",
  "",
  "Kalau kamu lagi dalam bahaya sekarang, tolong hubungi orang yang bisa langsung ada di dekatmu — orang tua, wali, guru, atau siapa pun yang kamu percaya. Buat keadaan darurat di Indonesia, nomornya 112.",
  "",
  "Aku nggak bisa gantiin mereka dan nggak mau pura-pura bisa. Aku tetap di sini, tapi yang beneran bisa nolong sekarang itu manusia yang dekat sama kamu.",
].join("\n");

/** Diingatkan sekali saja, bukan setiap kali pengguna mengetik lagi. */
export const HOLD_REMINDER =
  "Pesanmu masih aku pegang, belum aku baca — aku nunggu kamu tekan tombolnya dulu di atas.";

export const CONSENT_ACCEPTED = [
  "Oke, kita mulai 🌿",
  "",
  "Tulis aja apa yang ada di kepalamu, nggak usah dirapiin dulu.",
].join("\n");

export const CONSENT_ACCEPTED_HELD =
  "Oke. Aku baca pesanmu yang tadi dulu, ya.";

export function welcomeBack(activeTasks: number): string {
  if (activeTasks > 0) {
    return [
      "Hai lagi 🌿",
      "",
      `Di daftarmu masih ada ${activeTasks} yang belum kelar. Mau lanjut itu, atau ada hal lain hari ini?`,
    ].join("\n");
  }

  return ["Hai lagi 🌿", "", "Ada apa hari ini?"].join("\n");
}

/**
 * Satu pertanyaan yang benar-benar mengubah cara Harvy menjawab.
 *
 * Bukan pengumpulan profil. Ditanyakan setelah percakapan pertama, ketika
 * pengguna sudah punya bahan untuk menjawabnya.
 */
export const STYLE_QUESTION =
  "Oiya, satu pertanyaan biar aku nggak salah nemenin. Kalau kamu lagi cerita, kamu lebih suka didengerin dulu, atau langsung aku kasih saran?";

export function styleActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Didengerin dulu", "style:listen")
    .text("Langsung saran", "style:advice");
}

export function styleAck(style: StylePreference): string {
  return style === "listen"
    ? "Oke, aku inget. Aku dengerin dulu, saran nanti kalau kamu minta."
    : "Siap. Kalau kamu cerita, aku langsung ke intinya.";
}

/** Nama Telegram dipakai apa adanya bila wajar, tanpa disimpan di mana pun. */
function usableName(firstName: string | null): string | null {
  const name = firstName?.trim() ?? "";
  if (!name || name.length > 20) return null;
  return name;
}

const MAX_HELD_BUBBLES = 12;
const MAX_HELD_CHARS = 2_000;

/**
 * Pesan yang sudah telanjur dikirim sebelum pengguna menyetujui apa pun.
 *
 * Hanya di memori proses, tidak pernah ditulis ke berkas. Isinya kata-kata yang
 * pemiliknya belum menyetujui pemrosesannya, jadi menuliskannya ke disk berarti
 * mendahului jawaban yang sedang ditunggu. Hilang saat proses restart, dan itu
 * keadaan normal — sama seperti `PendingStore`.
 */
export class HeldMessageStore {
  private readonly held = new Map<string, string[]>();
  private readonly introduced = new Set<string>();
  private readonly reminded = new Set<string>();
  private readonly safetyShown = new Set<string>();

  hold(ownerId: string, text: string): void {
    const bubbles = this.held.get(ownerId) ?? [];
    if (bubbles.length >= MAX_HELD_BUBBLES) return;

    const total = bubbles.reduce((sum, bubble) => sum + bubble.length, 0);
    if (total + text.length > MAX_HELD_CHARS) return;

    bubbles.push(text);
    this.held.set(ownerId, bubbles);
  }

  has(ownerId: string): boolean {
    return (this.held.get(ownerId)?.length ?? 0) > 0;
  }

  /** Mengambil sekaligus mengosongkan; pesan yang sama tidak diproses dua kali. */
  take(ownerId: string): string {
    const bubbles = this.held.get(ownerId) ?? [];
    this.held.delete(ownerId);
    return bubbles.join("\n");
  }

  /**
   * `true` hanya untuk pemanggil pertama.
   *
   * Diperiksa dan ditandai tanpa `await` di antaranya, supaya beberapa bubble
   * yang datang berbarengan tidak menghasilkan dua perkenalan.
   */
  markIntroduced(ownerId: string): boolean {
    if (this.introduced.has(ownerId)) return false;
    this.introduced.add(ownerId);
    return true;
  }

  /** `true` hanya sekali; pengingat yang berulang berubah menjadi omelan. */
  markReminded(ownerId: string): boolean {
    if (this.reminded.has(ownerId)) return false;
    this.reminded.add(ownerId);
    return true;
  }

  /** Arahan keselamatan pra-persetujuan dikirim sekali, bukan per bubble. */
  markSafetyShown(ownerId: string): boolean {
    if (this.safetyShown.has(ownerId)) return false;
    this.safetyShown.add(ownerId);
    return true;
  }

  clear(ownerId: string): void {
    this.held.delete(ownerId);
    this.introduced.delete(ownerId);
    this.reminded.delete(ownerId);
    this.safetyShown.delete(ownerId);
  }
}
