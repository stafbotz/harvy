import type { AgentRunResult } from "../harness/agent-harness.js";

export type AgentStopReason =
  Extract<AgentRunResult, { status: "stopped" }>["reason"];

/**
 * `current` menjelaskan pekerjaan yang baru saja dicoba pada giliran ini.
 * `resumed` menjelaskan pekerjaan lama yang dilanjutkan dari jawaban pengguna,
 * sehingga kalimatnya menunjuk ke belakang alih-alih ke giliran sekarang.
 */
export type AgentStopSurface = "current" | "resumed";

/**
 * Teks deterministik untuk pekerjaan yang berhenti sebelum ada jawaban.
 *
 * Ini jaring terakhir di bawah `explainAgentStop`, yang hanya menangani kelas
 * "Harvy tidak menemukan cara mengerjakannya". Kelas kehabisan waktu, budget,
 * dan kuota sengaja tidak memanggil model lagi: menambah panggilan justru
 * menghabiskan sumber daya yang barusan dinyatakan habis.
 *
 * Tiga aturan mengikat seluruh isi berkas ini, dan ketiganya lahir dari copy
 * lama yang melanggarnya:
 *
 * 1. Tanpa kosakata internal. Teks lama menyebut "run", "planner", "agent
 *    baca-saja", dan "checkpoint" kepada pengguna yang tidak punya cara tahu
 *    apa artinya—dan tidak bisa berbuat apa pun dengan informasi itu. Prompt
 *    `explainAgentStop` sudah melarang kata-kata itu; jaring terakhirnya
 *    dahulu memakai semuanya.
 * 2. Satu langkah berikutnya yang konkret. Kegagalan tanpa jalan keluar
 *    membuat pengguna menebak sendiri apakah harus menunggu, mengulang, atau
 *    menyerah.
 * 3. Tidak meminta pengguna sekadar mengulang pesannya. Menyempitkan
 *    permintaan adalah langkah; menyuruh mengetik ulang kalimat yang sama
 *    memindahkan kegagalan Harvy menjadi pekerjaan pengguna. Copy `cycle`
 *    lama menyuruh "coba ulangi pertanyaannya" persis ketika prompt penjelas
 *    melarangnya, jadi dua jalur untuk keadaan yang sama saling bertentangan.
 */
export function agentStopMessage(
  reason: AgentStopReason,
  surface: AgentStopSurface = "current",
): string {
  if (reason.startsWith("budget_")) {
    return surface === "resumed"
      ? "Batas kerja kumulatifnya tercapai sebelum pekerjaan yang tadi selesai, jadi aku tidak akan mengarang atau meneruskan hasil setengah jadi. Sebutkan satu bagian terkecil yang paling kamu butuhkan, itu yang kukerjakan lebih dulu."
      : "Aku berhenti saat batas kerja kumulatifnya tercapai, dan aku tidak akan mengarang atau meneruskan hasil setengah jadi. Sebutkan satu bagian terkecil yang paling kamu butuhkan, itu yang kukerjakan lebih dulu.";
  }

  switch (reason) {
    case "deadline":
      return surface === "resumed"
        ? "Waktu untuk pekerjaan yang tadi sudah habis, jadi aku tidak melanjutkannya seolah hasilnya masih segar. Sebutkan bagian yang paling kamu perlukan sekarang, dan aku mulai dari situ."
        : "Aku kehabisan waktu sebelum jawabannya utuh, dan aku tidak mau mengarang sisanya. Sebutkan bagian yang paling kamu perlukan, biar itu yang kukerjakan lebih dulu.";
    case "cycle":
      return "Aku berputar di langkah yang sama terus dan tidak sampai ke jawaban, jadi aku berhenti daripada mengarang hasilnya. Sebutkan satu hal paling konkret yang kamu butuhkan dari ini, dan aku kerjakan bagian itu saja.";
    case "cancelled":
      return "Pekerjaannya kuhentikan, dan tidak ada hasil setengah jadi yang kukirim. Bilang saja kalau mau kumulai lagi.";
    case "stale":
    case "invalid_checkpoint":
      return "Pekerjaan yang tadi sudah tidak nyambung lagi dengan percakapan kita sekarang, jadi aku tidak melanjutkannya. Sampaikan lagi apa yang kamu perlukan, dan aku kerjakan dari keadaan sekarang.";
    case "usage_anti_abuse":
      return "Batas pemakaian singkat Harvy tercapai. Coba lagi setelah jeda; task dan percakapanmu tetap tersimpan.";
    case "usage_wallet_disabled":
      return "Saldo tambah compute tersedia, tetapi penggunaan otomatis belum diizinkan. Aktifkan funding atau gunakan provider sendiri untuk melanjutkan.";
    case "usage_byok_unavailable":
      return "Provider milikmu belum cocok untuk pekerjaan ini. Pilih provider lain atau gunakan compute Harvy secara eksplisit.";
    case "usage_allowance_exhausted":
      return "Kapasitas Harvy-funded periode ini sudah terpakai. Gunakan BYOK, tambah compute, atau tunggu kapasitas diperbarui.";
    default:
      // `max_steps`, `invalid_planner_output`, dan `capability_changed`
      // biasanya sudah dijelaskan model. Teks ini yang terkirim bila panggilan
      // penjelas itu sendiri gagal, jadi ia harus tetap berdiri sendiri.
      return "Aku belum berhasil menyelesaikan permintaan itu, dan aku tidak mau mengarang hasilnya. Sebutkan bagian mana yang paling kamu butuhkan, biar aku kerjakan itu dulu.";
  }
}

/**
 * Permintaan izin yang tidak dapat dipenuhi di permukaan ini.
 *
 * Pengguna tidak perlu tahu bahwa yang meminta izin adalah bagian baca-saja
 * dari Harvy. Yang berguna baginya cuma dua: tidak ada yang berubah, dan ada
 * bentuk permintaan lain yang bisa langsung dikerjakan.
 */
export function agentApprovalStopMessage(): string {
  return "Aku berhenti sebelum mengubah apa pun, karena langkah berikutnya perlu izin mengubah data yang belum kupunya di sini. Kalau yang kamu butuhkan cukup kubaca, kurangkum, atau kususun, sebutkan bagian itu dan langsung kukerjakan.";
}
