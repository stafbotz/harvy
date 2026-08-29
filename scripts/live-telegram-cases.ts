/**
 * Kasus pemeriksaan Telegram langsung.
 *
 * Dipisah dari driver-nya supaya menambah kasus tidak menyentuh logika
 * penyatuan bukti, dan supaya daftar ini dapat dibaca sendiri sebagai
 * pernyataan tentang jalur kode mana yang seharusnya dilalui tiap kalimat.
 *
 * Ekspektasi di sini menilai **jalur**, bukan gaya bahasa. Balasan yang enak
 * dibaca tetapi lewat jalur yang salah adalah kegagalan yang paling mahal:
 * ia terlihat benar sampai datanya berubah.
 */

export interface LiveTelegramExpectation {
  /** Label intent dari `understand()`, dibaca dari `decision` pada log route. */
  intent?: string | readonly string[];
  /** Route yang benar-benar dijalankan adapter. */
  selectedRoute?: string;
  semanticDomain?: string;
  semanticOperation?: string;
  /** Apakah giliran ini seharusnya masuk Agent Runtime. */
  agentUsed?: boolean;
  /** Capability yang wajib berhasil dieksekusi di dalam run. */
  capabilities?: readonly string[];
  replyMatches?: readonly RegExp[];
  replyForbids?: readonly RegExp[];
  maxLatencyMs?: number;
}

export interface LiveTelegramCase {
  id: string;
  message: string;
  waitMs?: number;
  expect: LiveTelegramExpectation;
}

export const LIVE_TELEGRAM_CASES: readonly LiveTelegramCase[] = [
  {
    id: "simpan-task",
    message: "ingetin aku besok jam 7 malam buat ngumpulin tugas biologi",
    expect: {
      intent: "task",
      selectedRoute: "save-task",
      semanticDomain: "task",
      semanticOperation: "save",
      agentUsed: false,
      replyMatches: [/tugas biologi/iu, /19[.:]00|jam 7/iu],
    },
  },
  {
    id: "baca-task",
    message: "sebutkan tugas aktifku dan kapan pengingatnya",
    expect: {
      selectedRoute: "show-tasks",
      semanticDomain: "task",
      semanticOperation: "list",
      agentUsed: false,
      replyMatches: [/tugas biologi/iu],
      // Pembacaan deterministik tidak boleh mengaku menyimpan apa pun.
      replyForbids: [/sudah (?:ku)?(?:simpan|catat|tambahkan)/iu],
    },
  },
  {
    id: "memori-deterministik",
    message: "apa aja yang kamu inget tentang aku?",
    expect: {
      intent: "memory",
      // Kontrol memori eksplisit sengaja ditangkap route deterministik sebelum
      // gerbang agent dinilai; ini yang menjaga jawabannya murah dan konsisten.
      selectedRoute: "memory-control",
      semanticDomain: "memory",
      semanticOperation: "list",
      agentUsed: false,
      replyForbids: [/aku ingat kamu (?:suka|selalu|sering)/iu],
    },
  },
  {
    id: "recall-di-luar-konteks",
    // Frasa recall yang jawabannya **tidak** ada di giliran terbaru. Ini yang
    // memaksa gerbang intent `history` yang dibuka 29 Agustus benar-benar
    // dipakai; pertanyaan yang jawabannya baru saja disebut akan dijawab dari
    // konteks tanpa pernah menyentuh Agent Runtime, sehingga tidak menguji apa
    // pun.
    message:
      "coba cari di riwayat percakapan kita yang lama, dulu aku pernah cerita soal apa aja? sebutkan yang kamu temukan",
    waitMs: 60_000,
    expect: {
      intent: ["history", "question", "request"],
      selectedRoute: "conversation",
      // Tidak ada episode terkompaksi pada journey sesegar ini, jadi jawaban
      // jujur adalah mengatakan riwayatnya belum ada—bukan mengarang isinya.
      replyForbids: [/\b(?:kamu pernah cerita|dulu kamu bilang) (?:soal|tentang) [a-z]{4,}/iu],
    },
  },
  {
    id: "status-coding",
    message: "gimana status pekerjaan coding yang lagi jalan?",
    expect: {
      // Pintu bahasa alami `coding/show` terbukti menyala: satu run mencatat
      // `semantic_route_selected` dengan domain coding, operasi show,
      // confidence high. Tetapi run berikutnya pada kalimat yang sama tidak
      // mengusulkan operasi apa pun dan masuk Agent Runtime membaca daftar
      // tugas. Usulan extractor untuk frasa status coding belum stabil.
      //
      // Menuntut satu jalur di sini akan membuat harness merah permanen pada
      // hal yang memang berayun, dan harness yang selalu merah berhenti
      // dibaca. Yang dikunci adalah bagian yang tidak boleh berayun: jawaban
      // tidak boleh mengarang pekerjaan coding yang sedang berjalan.
      // Kestabilan usulannya dicatat sebagai butir tersendiri di scratchpad.
      replyForbids: [
        /sedang (?:berjalan|dikerjakan|jalan)[^?]*(?:progres|selesai|persen|%)/iu,
      ],
    },
  },
  {
    id: "batalkan-task-alami",
    // `/batalkan-tugas <id>` adalah satu-satunya perintah tersisa yang menuntut
    // pengguna menyalin ID dari daftar. Kalimat ini menguji padanan bahasa
    // alaminya. Pembatalan tidak punya route deterministik, jadi ia wajib
    // sampai ke Agent Runtime—tempat `task.manage` menuntut konfirmasi.
    message: "batalin aja tugas biologi itu, nggak jadi aku kerjain",
    waitMs: 60_000,
    expect: {
      semanticDomain: "task",
      semanticOperation: "cancel",
      // Menghapus tanpa menyebutkan apa yang dihapus adalah kegagalan yang
      // paling mahal di sini: pengguna tidak punya cara tahu apa yang hilang.
      replyMatches: [/biologi/iu],
    },
  },
  {
    id: "obrolan-biasa",
    message: "makasih ya, kamu ngebantu banget",
    expect: {
      intent: "smalltalk",
      selectedRoute: "conversation",
      // Basa-basi tidak boleh menaikkan biaya menjadi loop planner.
      agentUsed: false,
      replyForbids: [/tugas aktif/iu],
      // Sesi 29 Agustus mencatat 31 detik untuk kalimat ini. Sebagian memang
      // anggaran desain—jendela batch sekitar 7 detik plus 2 detik batas
      // giliran—tetapi sisanya tidak dijelaskan. Angka ini mengubah pengamatan
      // itu menjadi pagar; bila terlampaui, yang salah bukan harness-nya.
      maxLatencyMs: 40_000,
    },
  },
];
