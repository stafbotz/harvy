/**
 * Penjaga balasan yang jatuh ke perulangan.
 *
 * Model yang masuk loop degeneratif menghabiskan seluruh anggaran keluarannya
 * untuk mengulang satu potongan teks. Yang sampai ke pengguna bukan jawaban
 * salah—ia jawaban yang benar untuk kalimat pertama, lalu kalimat itu lagi,
 * dan lagi. Di Telegram maupun WhatsApp bentuk itu tidak berhenti di satu
 * pesan: `planResponsePresentation` memotong teks panjang menjadi beberapa
 * message transport, sehingga satu kegagalan model menjadi belasan notifikasi
 * berturut-turut ke ponsel seorang pelajar.
 *
 * Pagar anti-spam yang sudah ada membatasi jumlah *segmen semantik*, bukan
 * jumlah potongan transport, jadi ia tidak menangkap bentuk ini sama sekali.
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, jam, maupun model.
 *
 * Asalnya `hermes/agent/repetition_guard.py`, yang menuliskan ambangnya
 * setelah satu insiden nyata: 60.698 karakter terkirim sebagai 31 pesan.
 * Satu hal sengaja **tidak** ditiru. Hermes menilai jendela verbatim sepanjang
 * 60 karakter, dan itu aman di sana karena ia hanya menilai potongan lanjutan
 * dari balasan yang terpotong. Harvy menilai setiap balasan, dan balasan Harvy
 * kepada pelajar sering berbentuk daftar langkah paralel—lima baris yang
 * berbagi ekor kalimat yang sama persis. Uji jendela menuduh daftar seperti
 * itu sebagai loop. Karena itu jalur kedua di sini memakai **periodisitas**:
 * loop sungguhan mengulang pada jarak yang tetap, sedangkan daftar paralel
 * punya isi unik di tiap barisnya yang mematahkan periode.
 *
 * Deteksinya gagal terbuka: balasan yang tidak dapat dinilai dengan yakin
 * selalu lolos.
 */

/** Di bawah panjang ini teks tidak dinilai sama sekali. */
export const MIN_FRAGMENT_CHARACTERS = 400;

/** Sedikitnya berapa kali sesuatu harus muncul sebelum dianggap sinyal. */
const MIN_REPEAT_COUNT = 5;

/** Bagian teks yang harus tertutup pengulangan sebelum ia disebut dominan. */
const DOMINANCE_RATIO = 0.5;

/**
 * Periode terpendek yang masih dianggap loop.
 *
 * Loop model menggemakan **frasa**—insiden yang melahirkan guard ini
 * menghasilkan 60.698 karakter berisi kalimat yang sama berulang. Sesuatu yang
 * berulang tiap satu atau dua karakter bukan bentuk itu: ia garis pemisah,
 * padding, keluaran kerja yang memang berpola, atau fixture uji. Memangkasnya
 * membuang isi yang sah demi menangkap sesuatu yang tidak pernah menjadi
 * masalahnya.
 *
 * Ambang ini ditemukan oleh suite penuh, bukan oleh penalaran: satu tes
 * pemecahan transport memakai balasan 5.000 karakter berisi satu huruf, dan
 * versi pertama guard ini memangkasnya menjadi satu huruf.
 */
const MIN_PERIOD = 16;

/**
 * Periode terpanjang yang dicari.
 *
 * Cukup untuk satu paragraf pendek yang menggema. Lebih panjang dari ini
 * pengulangan tidak lagi terlihat seperti loop, dan biayanya naik sia-sia.
 */
const MAX_PERIOD = 240;

/**
 * Satu putaran loop, beserta di mana ia mulai mengambil alih teks.
 */
interface PeriodicTail {
  period: number;
  /** Indeks awal ekor yang berulang; sebelum ini isinya masih berarti. */
  start: number;
}

/** Apakah teks didominasi pengulangan. */
export function isRepetitionDominated(text: string): boolean {
  if (text.length < MIN_FRAGMENT_CHARACTERS) return false;
  return echoedLine(text) !== null || periodicTail(text) !== null;
}

/**
 * Membuang bagian yang berulang, menyisakan yang masih berarti.
 *
 * Hermes memilih membatalkan giliran dan menampilkan error. Harvy tidak:
 * seorang pelajar yang bertanya lalu menerima pesan galat kehilangan
 * jawabannya sepenuhnya, padahal kalimat-kalimat pertama biasanya benar. Yang
 * dikembalikan di sini adalah bagian sebelum perulangan mengambil alih,
 * ditambah satu kemunculan—lebih baik daripada belasan notifikasi berisi teks
 * yang sama, dan lebih baik daripada tidak ada jawaban sama sekali.
 *
 * Mengembalikan teks asli apa adanya bila tidak ada yang perlu dipangkas,
 * sehingga pemanggil dapat membandingkan identitasnya untuk tahu apakah guard
 * benar-benar bekerja.
 */
export function collapseRepetition(text: string): string {
  if (text.length < MIN_FRAGMENT_CHARACTERS) return text;

  const line = echoedLine(text);
  if (line !== null) {
    const collapsed = dropRepeatsOfLine(text, line);
    if (collapsed) return collapsed;
  }

  const tail = periodicTail(text);
  if (tail !== null) {
    const collapsed = text.slice(0, tail.start + tail.period).trim();
    if (collapsed) return collapsed;
  }

  return text;
}

/**
 * Satu baris utuh yang diulang cukup sering untuk menutupi separuh teks.
 *
 * Jalur ini nyaris tidak mungkin salah tuduh: balasan yang wajar tidak pernah
 * mengulang satu baris yang sama persis lima kali.
 */
function echoedLine(text: string): string | null {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const normalized = line.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  for (const [line, seen] of counts) {
    if (
      seen >= MIN_REPEAT_COUNT &&
      seen * line.length >= text.length * DOMINANCE_RATIO
    ) {
      return line;
    }
  }
  return null;
}

/**
 * Ekor terpanjang yang mengulang dirinya **persis** pada satu periode tetap.
 *
 * Kecocokan harus sempurna, dan justru di situ letak seluruh nilainya. Daftar
 * langkah paralel—delapan baris yang hanya berbeda nomor babnya—nyaris
 * periodik: 98% posisinya cocok, dan ambang berbasis rasio akan menuduhnya.
 * Tetapi angka yang berbeda itu adalah informasi, dan memangkasnya berarti
 * membuang jawaban yang benar. Loop model tidak punya perbedaan seperti itu:
 * ia mengulang byte yang sama persis. Kecocokan sempurna memisahkan keduanya
 * tanpa perlu menebak.
 *
 * Awalan yang tidak periodik dibiarkan—model biasanya menulis beberapa kalimat
 * yang benar sebelum tergelincir.
 *
 * Murah pada teks biasa: pemindaian tiap periode berhenti pada ketidakcocokan
 * pertama dari belakang, jadi teks yang tidak berulang hanya membayar satu
 * perbandingan per periode.
 */
function periodicTail(text: string): PeriodicTail | null {
  const length = text.length;
  const longest = Math.min(MAX_PERIOD, Math.floor(length / MIN_REPEAT_COUNT));
  const minimumSpan = Math.max(length * DOMINANCE_RATIO, MIN_REPEAT_COUNT);

  for (let period = 1; period <= longest; period += 1) {
    let start = length - period;
    while (start > 0 && text[start - 1] === text[start - 1 + period]) {
      start -= 1;
    }
    const span = length - start;
    if (span >= minimumSpan && span >= MIN_REPEAT_COUNT * period) {
      // Periode fundamental—yang terkecil—adalah yang menggambarkan bentuknya.
      // Teks berisi satu huruf berulang periodik pada *setiap* periode, jadi
      // menaikkan titik mulai pemindaian tidak mengecualikannya; yang
      // mengecualikannya adalah menemukan periode terkecilnya lebih dahulu
      // lalu menolaknya. Ditemukan lewat suite penuh, bukan penalaran.
      return period >= MIN_PERIOD ? { period, start } : null;
    }
  }
  return null;
}

/** Menyisakan kemunculan pertama dari baris yang menggema. */
function dropRepeatsOfLine(text: string, echoed: string): string {
  const kept: string[] = [];
  let emitted = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === echoed) {
      if (emitted) continue;
      emitted = true;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}
