import { InlineKeyboard } from "grammy";
import { EMERGENCY_AVAILABILITY_NOTE } from "../ai/safety.js";
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
    "Satu hal dulu biar jujur di depan: aku jalan pakai AI, dan biar bisa ngerti pesanmu, isinya dapat dikirim ke satu atau lebih layanan AI di luar Harvy. Supaya obrolan nyambung, model utama juga dapat menerima potongan memori dan riwayat tersimpan yang relevan. Kalau layanan utama gagal, permintaan yang sama dapat dicoba lagi lewat layanan cadangan. Untuk permintaan rumit yang aman, bagian relevan dari permintaanmu juga dapat dibagi ke paling banyak tiga worker AI sekaligus; worker itu tidak menerima memori atau riwayat tersimpanmu. Kalau kamu memintaku research web dan fiturnya aktif, kata pencariannya juga dikirim ke layanan pencarian, lalu server Harvy dapat membuka URL publik yang dipilih. Kalau kamu memilih sesi atau check-in, keadaan singkatnya juga kusimpan supaya bisa dilanjutkan. Aku juga bisa salah, jadi hal penting tetap perlu kamu cek sendiri.",
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
    .text("Aku mau tanya dulu", "consent:info")
    .row()
    .text("Aku sedang nggak aman", "safety:now");
}

/**
 * Penjelasan yang lebih panjang, hanya untuk yang memintanya.
 *
 * Pasal 2 nomor 3 memberi hak atas penjelasan yang jujur, dan Pasal 3.9 meminta
 * penjelasan yang sesuai usia. Karena itu isinya kalimat biasa, bukan kebijakan
 * privasi, dan ia tidak dipaksakan kepada yang tidak bertanya.
 */
export function consentDetail(
  retentionDays = 30,
  operationalLogRetentionDays = 14,
): string {
  return [
    "Boleh. Ini apa adanya:",
    "",
    "• Isi pesanmu dapat dikirim ke satu atau lebih layanan AI di luar Harvy supaya bisa dipahami. Model utama juga dapat menerima potongan memori dan riwayat tersimpan yang dipilih karena relevan agar percakapan tetap nyambung. Kalau layanan utama gagal, permintaan yang sama dapat dikirim ulang ke layanan cadangan. Tanpa layanan AI itu aku nggak bisa jalan sama sekali.",
    "• Untuk permintaan rumit yang sudah lolos pemeriksaan keselamatan, sistem dapat membagi bagian relevan permintaanmu menjadi dua atau tiga subpekerjaan model yang berjalan bersamaan. Worker itu tidak menerima memori, riwayat, credential, atau akses tool; satu model utama menyatukan hasilnya.",
    "• Kalau kamu meminta research web dan operator mengaktifkan fiturnya, kata pencarian dikirim ke penyedia search terpisah. Server Harvy juga dapat membuka URL publik dari pesanmu atau hasil search untuk membaca teksnya. Memori dan riwayat lama tidak ikut diberikan ke planner research.",
    "• Satu pengecualian, dan cuma satu: pesan pertamamu aku lihat sekilas sebelum kamu setuju, khusus buat ngecek kamu lagi dalam bahaya atau nggak. Kalau iya, aku nggak mau kamu nunggu tombol dulu.",
    "• Aku nyimpen sebagian obrolan kita dan beberapa catatan tentang kamu, biar kamu nggak perlu ngulang cerita. Kalau sistemku menilai catatannya pribadi atau sensitif, aku tanya dulu. Penilaian AI bisa keliru; setiap catatan otomatis tetap aku tunjukkan dengan tombol untuk melupakannya.",
    "• Kalau kamu memilih sesi atau check-in, aku menyimpan tujuan singkat, tahapnya, dan waktu yang kamu pilih. Check-in cuma dikirim sekali dan tidak memuat tujuanmu di notifikasi.",
    `• Aku mencatat jumlah token, jenis proses, keberhasilan, dan perkiraan biaya selama ${retentionDays} hari agar batas pemakaian bisa dijaga. Catatan ini tidak berisi pesan atau balasannya.`,
    `• Sistemku juga menyimpan file log gangguan teknis lokal selama paling lama ${operationalLogRetentionDays} hari: waktu, komponen, tahap, durasi, status, kode error, dan fingerprint. Log ini tidak menyimpan isi pesan, prompt atau balasan AI, identitas akun/chat, QR, token, atau kredensial. Kalau deployment meneruskan log aman ini ke collector perusahaan, retensi collector mengikuti kebijakan infrastrukturnya sendiri.`,
    "• Kapan aja kamu bisa melihat atau mengubah memori, nyuruh aku lupain satu per satu, mengekspor data yang boleh kamu lihat, menarik izin AI, dan menghapus seluruh datamu.",
    "• Aku bukan terapis, dokter, atau layanan darurat. Kalau keadaannya berat atau bahaya, manusia yang harus kamu hubungi, bukan aku.",
    "",
    "Kalau kamu oke, kita mulai.",
  ].join("\n");
}

export const CONSENT_DETAIL = consentDetail();

/**
 * Jawaban untuk pesan pertama yang menunjukkan bahaya segera.
 *
 * Ditulis sebagai teks tetap setelah triase sempit atas pesan pertama.
 * Konstitusi v0.3 Pasal 3.9 mengizinkan hanya pemeriksaan keselamatan itu
 * sebelum persetujuan; isi bubble berikutnya tetap tidak dikirim ke penyedia.
 */
export const PRE_CONSENT_SAFETY = [
  "Aku baca ada yang berat banget di pesanmu, dan itu aku tanggapi duluan.",
  "",
  `Kalau kamu lagi dalam bahaya sekarang, ambil langkah paling kecil supaya beberapa menit ke depan lebih aman: menjauh dari benda atau tempat yang bisa melukaimu, pindah ke tempat yang lebih terbuka kalau memungkinkan, atau hubungi layanan darurat yang tersedia di daerahmu. ${EMERGENCY_AVAILABILITY_NOTE}`,
  "",
  "Kalau ada orang atau petugas yang terasa aman, kamu boleh minta mereka tetap bersamamu. Kalau nggak ada, kamu nggak perlu memaksa percaya pada siapa pun dulu—fokus ke satu langkah aman tadi.",
  "",
  "Aku nggak bisa gantiin mereka atau layanan darurat, tapi aku juga nggak akan meninggalkan percakapan ini begitu saja.",
].join("\n");

/**
 * Dipakai bila triase pesan pertama gagal.
 *
 * Harvy tidak mengaku melihat bahaya yang belum berhasil dinilai, tetapi juga
 * tidak membiarkan gangguan penyedia menghilangkan seluruh jalur keselamatan.
 */
export const PRE_CONSENT_UNCERTAIN = [
  "Aku belum berhasil memeriksa pesanmu dengan baik, jadi aku nggak akan menebak keadaanmu.",
  "",
  `Kalau kamu sedang nggak aman sekarang, jangan tunggu tombol ini: menjauh dulu dari benda atau tempat yang bisa melukaimu, pindah ke tempat yang lebih terbuka atau dekat petugas bila memungkinkan, lalu hubungi layanan darurat yang tersedia di daerahmu. ${EMERGENCY_AVAILABILITY_NOTE}`,
].join("\n");

/**
 * Bubble setelah pesan pertama tidak dikirim ke penyedia sebelum persetujuan.
 *
 * Karena isinya sengaja tidak diperiksa, pengingat ini membawa jalur aman
 * bersyarat. Dengan begitu privasi tidak diperluas diam-diam dan bubble kedua
 * yang ternyata mendesak juga tidak dibiarkan tanpa arah sama sekali.
 */
export const HOLD_REMINDER = [
  "Pesan tambahanmu masih aku pegang dan belum kukirim ke layanan AI.",
  "",
  "Kalau salah satunya soal bahaya yang sedang terjadi, jangan tunggu tombol ini: pindah ke tempat yang lebih aman atau dekat petugas bila memungkinkan, lalu hubungi layanan darurat yang tersedia di daerahmu.",
].join("\n");

export const HOLD_LIMIT_REACHED =
  "Aku belum bisa menahan tambahan pesan lagi sebelum kamu memilih tombol di atas. Pesan yang sudah masuk tetap kupegang; setelah kamu setuju, kirim ulang bagian terakhir supaya tidak ada yang terlewat.";

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
  private readonly limitWarned = new Set<string>();

  hold(ownerId: string, text: string): boolean {
    const bubbles = this.held.get(ownerId) ?? [];
    if (bubbles.length >= MAX_HELD_BUBBLES) return false;

    const total = bubbles.reduce((sum, bubble) => sum + bubble.length, 0);
    if (total + text.length > MAX_HELD_CHARS) return false;

    bubbles.push(text);
    this.held.set(ownerId, bubbles);
    return true;
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

  /** `true` hanya sekali ketika batas penahanan sudah tercapai. */
  markLimitWarned(ownerId: string): boolean {
    if (this.limitWarned.has(ownerId)) return false;
    this.limitWarned.add(ownerId);
    return true;
  }

  clear(ownerId: string): void {
    this.held.delete(ownerId);
    this.introduced.delete(ownerId);
    this.reminded.delete(ownerId);
    this.safetyShown.delete(ownerId);
    this.limitWarned.delete(ownerId);
  }
}
