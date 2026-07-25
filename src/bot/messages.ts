import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "rendah",
  2: "sedang",
  3: "tinggi",
};

export const ELIGIBILITY_PROMPT = [
  "Hai, aku Harvy. Aku AI pendamping buat pelajar.",
  "",
  "Sebelum ngobrol lebih jauh, aku perlu cek satu hal dulu: kamu sudah kelas 8 SMP, tingkat setara, atau lebih tinggi?",
  "",
  "Agar tidak menanyakannya setiap kali, aku akan menyimpan ID akun Telegram dan status jawabanmu. Aku tidak meminta kelas persis, nama sekolah, atau kartu pelajar.",
].join("\n");

export const FIRST_WELCOME_MESSAGE = [
  "Oke, izin pemrosesan AI aktif.",
  "",
  "Sekarang ceritain aja apa yang lagi pengin kamu beresin, pikirin, atau pahami. Nggak perlu dirapikan dulu—kita mulai dari ceritamu.",
  "",
  "Aku hanya membawa beberapa pesan terbaru dalam konteks aktif sementara—bukan memori jangka panjang. Hapus kapan saja lewat /hapuspercakapan atau ubah izin AI lewat /privasi.",
].join("\n");

export const RETURNING_WELCOME_MESSAGE = [
  "Hai lagi.",
  "",
  "Hari ini lagi ada apa? Ceritain aja seadanya. Aku hanya membawa konteks aktif sementara, bukan ingatan jangka panjang.",
].join("\n");

export const INELIGIBLE_MESSAGE = [
  "Terima kasih sudah jawab.",
  "",
  "Harvy versi percobaan ini baru bisa dipakai mulai kelas 8 SMP atau tingkat setara, jadi kita belum bisa lanjut.",
  "",
  "Agar ingat jawaban ini, aku menyimpan ID akun Telegram dan status kelayakan—bukan kelas persis, nama sekolah, atau kartu pelajar. Kalau tadi salah pilih, kamu bisa koreksi jawaban.",
].join("\n");

export const AI_CONSENT_PROMPT = [
  "Sebelum pesan bebas pertama, aku perlu izinmu.",
  "",
  "Kalau kamu setuju, isi pesan dan jawaban akan diproses oleh OpenAI. Data API tidak dipakai melatih model secara default, tetapi pada pengaturan standar dapat berada di log pemantauan penyalahgunaan hingga 30 hari.",
  "",
  "Harvy mematikan penyimpanan percakapan sebagai state di API (store:false). Agar balasan lanjutan tetap nyambung, beberapa pesan terakhir disimpan sementara di RAM maksimal 30 menit dan dikirim bersama pesan berikutnya; tidak ditulis ke disk, hilang saat restart, dan bisa dihapus lewat /hapuspercakapan.",
  "",
  "Perintah tugas tetap bisa dipakai tanpa izin ini. Kamu boleh menolak atau menarik izin lewat /privasi.",
].join("\n");

export const AI_CONSENT_DECLINED_MESSAGE = [
  "Oke, izin AI tidak aktif. Pesan bebasmu tidak akan dikirim ke OpenAI.",
  "",
  "Perintah tugas tetap bisa dipakai. Kalau berubah pikiran, buka /privasi.",
].join("\n");

export const PRIVACY_GRANTED_MESSAGE = [
  "Izin AI saat ini aktif.",
  "",
  "Pesan dan jawaban diproses OpenAI. Data API tidak dipakai melatih model secara default, tetapi dapat berada di log pemantauan penyalahgunaan hingga 30 hari pada pengaturan standar.",
  "",
  "Harvy mematikan penyimpanan percakapan sebagai state di API (store:false). Beberapa pesan terakhir disimpan sementara di RAM maksimal 30 menit dan dikirim bersama pesan berikutnya agar percakapan nyambung; tidak ditulis ke disk dan bisa dihapus lewat /hapuspercakapan. Kamu bisa menarik izin di bawah.",
].join("\n");

export const CONVERSATION_CLEARED_MESSAGE =
  "Konteks percakapan aktif sudah dihapus. Pesan berikutnya akan dimulai tanpa riwayat.";

export const INPUT_TOO_LONG_MESSAGE = [
  "Pesan itu terlalu panjang untuk percobaan ini.",
  "",
  "Coba kirim bagian yang paling penting dulu, maksimal sekitar 6.000 karakter.",
].join("\n");

export const AI_UNAVAILABLE_MESSAGE = [
  "Maaf, koneksi AI Harvy lagi belum bisa menjawab.",
  "",
  "Pesanmu tidak disimpan sebagai memori. Kamu bisa mencoba lagi nanti atau memakai /bantuan untuk fitur tugas yang tetap tersedia.",
].join("\n");

export const HIGH_RISK_MESSAGE = [
  "Aku khawatir pesanmu mungkin menyangkut keselamatanmu.",
  "",
  "Kalau bahaya sedang terjadi sekarang, pindah ke tempat yang lebih aman jika kamu bisa, lalu hubungi orang dewasa yang kamu percaya atau layanan darurat setempat sekarang. Kalau sulit menjelaskan, kamu bisa kirim: “Aku sedang tidak aman dan butuh ditemani sekarang.”",
  "",
  "Harvy adalah AI, bukan layanan darurat, dan keadaan seperti ini membutuhkan bantuan manusia secara langsung.",
].join("\n");

export const HELP_MESSAGE = [
  "Kamu bisa menulis pesan biasa tentang hal yang ingin dibereskan, dipikirkan, atau dipahami setelah izin AI aktif.",
  "",
  "Percakapan AI hanya membawa konteks aktif sementara, maksimal 30 menit dan tidak ditulis ke disk. Hapus lewat /hapuspercakapan atau atur izinnya lewat /privasi.",
  "",
  "Tambah tugas:",
  "/tambah Matematika halaman 20 | 2026-07-28 19:00 | tinggi",
  "",
  "Tenggat dan prioritas boleh dikosongkan:",
  "/tambah Bawa buku sejarah",
  "",
  "Perintah lain:",
  "/tugas — lihat tugas aktif",
  "/selesai ID — tandai selesai",
  "/ingatkan ID | 2026-07-28 17:00 — pasang pengingat",
  "/hapuspercakapan — hapus konteks aktif sementara",
  "/privasi — lihat atau ubah izin AI",
  "/bantuan — tampilkan panduan",
].join("\n");

export function formatTask(task: StudentTask, timeZone: string): string {
  const due = task.dueAt
    ? new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(task.dueAt))
    : "tanpa tenggat";

  const reminder = task.reminderAt
    ? ` · pengingat ${new Intl.DateTimeFormat("id-ID", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone,
      }).format(new Date(task.reminderAt))}`
    : "";

  return [
    `• ${task.title}`,
    `  ID ${task.id} · ${IMPORTANCE_LABEL[task.importance]} · ${due}${reminder}`,
  ].join("\n");
}
