export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export interface TelegramCommandOptions {
  codingRuntime: boolean;
  githubPublishing: boolean;
}

export type CommandChannel = "telegram" | "whatsapp";
export type CommandCategory =
  | "tasks"
  | "usage"
  | "memory"
  | "coding"
  | "settings"
  | "guide";

/**
 * Apakah command ikut ditawarkan sebagai jalan pintas.
 *
 * `fallback` tetap dikenali dan dijalankan; ia hanya tidak lagi ikut memenuhi
 * layar. Semua yang ditandai begitu punya pintu bahasa alami yang terbukti di
 * `DOMAIN_OPERATIONS`, sehingga menyembunyikannya tidak menghilangkan
 * kemampuan apa pun—hanya menghapus kewajiban menghafalnya.
 *
 * Yang tetap `shortcut` dipilih karena alasannya, bukan selera: tindakan yang
 * tidak dapat dibatalkan (hapus semua, tarik izin, ekspor), tindakan yang
 * memegang credential atau mengirim ke luar (github, publish), pekerjaan yang
 * memerlukan invokasi tegas (code), dua pintu navigasi (menu, bantuan), dan
 * yang memang belum punya padanan bahasa alami (batalkan-tugas, checkin,
 * gaya).
 */
export type CommandSurface = "shortcut" | "fallback";

export interface UserCommandDefinition extends TelegramCommandDefinition {
  category: CommandCategory;
  channels: readonly CommandChannel[];
  detail: string;
  example?: string;
  requires?: "coding" | "github";
  surface?: CommandSurface;
}

export interface CommandCategoryDefinition {
  id: CommandCategory;
  label: string;
  summary: string;
}

const CATEGORIES: readonly CommandCategoryDefinition[] = [
  {
    id: "tasks",
    label: "Tugas & sesi",
    summary: "lihat pekerjaan, pengingat, sesi, dan check-in",
  },
  { id: "usage", label: "Penggunaan & paket", summary: "kapasitas, pembaruan, dan dukungan" },
  { id: "memory", label: "Memori & data", summary: "lihat atau kendalikan data pribadimu" },
  { id: "coding", label: "Coding", summary: "workspace dan pekerjaan coding" },
  { id: "settings", label: "Pengaturan", summary: "izin dan kontrol akun" },
  { id: "guide", label: "Panduan", summary: "cara memakai Harvy" },
];

/** User-facing commands only. Operator and internal runtime controls are absent. */
const COMMANDS: readonly UserCommandDefinition[] = [
  {
    command: "menu",
    description: "Buka menu Harvy",
    category: "guide",
    channels: ["telegram", "whatsapp"],
    detail: "Buka daftar fitur berdasarkan kebutuhanmu.",
  },
  {
    command: "tugas",
    // Pintu bahasa alami: task/list.
    surface: "fallback",
    description: "Lihat yang harus dikerjakan",
    category: "tasks",
    channels: ["telegram", "whatsapp"],
    detail: "Lihat tugas aktif dan kelola dari tombol atau perintah teks.",
    example: "Kamu juga bisa menulis: ingatkan aku besok jam 8 untuk mengirim tugas.",
  },
  {
    command: "penggunaan",
    // Pintu bahasa alami: usage/show-summary.
    surface: "fallback",
    description: "Lihat kapasitas Harvy",
    category: "usage",
    channels: ["telegram", "whatsapp"],
    detail: "Baca kapasitas terkini dan waktu pembaruannya.",
  },
  {
    command: "dukung",
    // Pintu bahasa alami: billing/show-support.
    surface: "fallback",
    description: "Info kontribusi sukarela",
    category: "usage",
    channels: ["telegram", "whatsapp"],
    detail: "Lihat cara mendukung Harvy Commons; kontribusi selalu opsional.",
  },
  {
    command: "selesai",
    // Pintu bahasa alami: task/complete.
    surface: "fallback",
    description: "Tandai tugas selesai",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Tandai satu tugas selesai memakai ID dari /tugas.",
    example: "/selesai a1b2c3d4",
  },
  {
    command: "batalkan-tugas",
    description: "Batalkan satu tugas",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Hapus satu tugas aktif memakai ID dari /tugas.",
    example: "/batalkan-tugas a1b2c3d4",
  },
  {
    command: "tenggat",
    // Pintu bahasa alami: task/update.
    surface: "fallback",
    description: "Ubah tenggat tugas",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Pasang atau ubah tenggat satu tugas aktif.",
    example: "/tenggat a1b2c3d4 Jumat jam 4 sore",
  },
  {
    command: "ingatkan",
    // Pintu bahasa alami: task/save.
    surface: "fallback",
    description: "Pasang pengingat tugas",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Pasang pengingat satu kali pada tugas aktif.",
    example: "/ingatkan a1b2c3d4 besok jam 7 malam",
  },
  {
    command: "sesi",
    // Pintu bahasa alami: session/*.
    surface: "fallback",
    description: "Kelola sesi bantuan",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Mulai, lihat, lanjutkan, atau hentikan sesi langkah kecil.",
    example: "/sesi mulai fokus menyelesaikan pendahuluan",
  },
  {
    command: "checkin",
    description: "Jadwalkan check-in sesi",
    category: "tasks",
    channels: ["whatsapp"],
    detail: "Minta Harvy bertanya sekali lagi pada waktu pilihanmu.",
    example: "/checkin 30 menit lagi",
  },
  {
    command: "memori",
    // Pintu bahasa alami: memory/list.
    surface: "fallback",
    description: "Lihat yang aku ingat tentang kamu",
    category: "memory",
    channels: ["telegram", "whatsapp"],
    detail: "Lihat memori tersimpan dan kontrol yang tersedia.",
  },
  {
    command: "lupakan",
    // Pintu bahasa alami: memory/forget.
    surface: "fallback",
    description: "Hapus satu memori",
    category: "memory",
    channels: ["whatsapp"],
    detail: "Sesudah /memori, kirim /lupakan diikuti nomor item.",
    example: "/lupakan 2",
  },
  {
    command: "lupakan-semua",
    description: "Hapus semua memori",
    category: "memory",
    channels: ["whatsapp"],
    detail: "Mulai penghapusan semua memori dengan konfirmasi eksplisit.",
  },
  {
    command: "izin",
    // Pintu bahasa alami: data/show-controls.
    surface: "fallback",
    description: "Baca cara data diproses",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Baca penjelasan izin dan pemrosesan data.",
  },
  {
    command: "tarik-izin",
    description: "Hentikan pemrosesan AI",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Tarik izin sampai kamu menyetujuinya lagi.",
  },
  {
    command: "hapus-data",
    description: "Hapus seluruh data",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Mulai penghapusan seluruh data dengan konfirmasi eksplisit.",
  },
  {
    command: "ekspor",
    description: "Ekspor data Harvy",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Ambil salinan data yang boleh kamu lihat.",
  },
  {
    command: "zona",
    // Pintu bahasa alami: data/set-timezone.
    surface: "fallback",
    description: "Atur zona waktu",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Pilih WIB, WITA, atau WIT.",
    example: "/zona WIB",
  },
  {
    command: "jam-tenang",
    // Pintu bahasa alami: data/set-quiet-hours.
    surface: "fallback",
    description: "Atur jam tenang",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Atur rentang tanpa notifikasi atau matikan pengaturannya.",
    example: "/jam-tenang 21.30-06.00",
  },
  {
    command: "gaya",
    description: "Atur cara Harvy menemani",
    category: "settings",
    channels: ["whatsapp"],
    detail: "Pilih didengarkan dulu atau lebih cepat mendapat saran.",
    example: "/gaya dengarkan",
  },
  {
    command: "project",
    // Pintu bahasa alami: project/*.
    surface: "fallback",
    description: "Kelola workspace/project coding",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Buat, pilih, atau impor project coding privat.",
    requires: "coding",
  },
  {
    command: "code",
    description: "Mulai CodingRun pada project aktif",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Mulai pekerjaan coding pada project aktif.",
    requires: "coding",
  },
  {
    command: "goal",
    // Pintu bahasa alami: goal/*.
    surface: "fallback",
    description: "Kelola tujuan durable project",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Lihat atau ubah tujuan, kriteria selesai, milestone, dan blocker project aktif.",
    requires: "coding",
  },
  {
    command: "skill",
    // Pintu bahasa alami: skill/*.
    surface: "fallback",
    description: "Kelola skill deklaratif project",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Buat atau gunakan prosedur berversi tanpa memberi Harvy permission baru.",
    requires: "coding",
  },
  {
    command: "code_status",
    // Pintu bahasa alami: coding/show.
    surface: "fallback",
    description: "Lihat status CodingRun",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Lihat status pekerjaan coding yang sedang berjalan.",
    requires: "coding",
  },
  {
    command: "code_cancel",
    // Pintu bahasa alami: coding/cancel.
    surface: "fallback",
    description: "Batalkan CodingRun aktif",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Batalkan pekerjaan coding aktif secara eksplisit.",
    requires: "coding",
  },
  {
    command: "github",
    description: "Hubungkan GitHub App dan pilih repo",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Hubungkan GitHub App dan pilih repository yang diizinkan.",
    requires: "github",
  },
  {
    command: "publish",
    description: "Siapkan publish exact ke draft PR",
    category: "coding",
    channels: ["telegram", "whatsapp"],
    detail: "Siapkan perubahan exact ke draft pull request setelah konfirmasi.",
    requires: "github",
  },
  {
    command: "bantuan",
    description: "Lihat cara pakai",
    category: "guide",
    channels: ["telegram", "whatsapp"],
    detail: "Baca contoh percakapan dan prinsip kontrol Harvy.",
  },
];

export function userCommandCatalog(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): UserCommandDefinition[] {
  return COMMANDS.filter((command) =>
    command.channels.includes(channel) &&
    (command.requires !== "coding" || options.codingRuntime) &&
    (command.requires !== "github" || options.githubPublishing)
  ).map((command) => ({ ...command }));
}

/** One source for Telegram native registration and rendered menus/help. */
export function telegramCommands(
  options: TelegramCommandOptions,
): TelegramCommandDefinition[] {
  return userCommandCatalog(options, "telegram").map(
    ({ command, description }) => ({ command, description }),
  );
}

/**
 * Command yang ikut ditampilkan. Bukan command yang boleh dijalankan.
 *
 * WhatsApp tidak punya tombol, jadi seluruh 29 command lama tampil di sana
 * sebagai satu daftar rata—dan slash yang salah ketik membuang daftar itu ke
 * layar. Penyaringan ini memperbaiki apa yang ditawarkan; `userCommandCatalog`
 * tetap utuh supaya command yang sudah dihafal pengguna tidak mendadak hilang.
 */
export function shortcutCommandCatalog(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): UserCommandDefinition[] {
  const catalog = userCommandCatalog(options, channel);
  // Penyaringan ini menjawab kelangkaan tempat, dan tempat hanya langka di
  // kanal tanpa tombol. Telegram menaruh command di menu native yang dapat
  // dicari, mengelola sisanya lewat tombol, dan hanya menampilkan 14; memangkas
  // daftar itu justru menyembunyikan pintu yang tetap terdaftar di menu native
  // Telegram. WhatsApp membuang seluruh daftarnya ke dalam gelembung chat.
  if (channel !== "whatsapp") return catalog;
  return catalog.filter((command) => command.surface !== "fallback");
}

export function commandCategories(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): CommandCategoryDefinition[] {
  // Kategori memetakan kemampuan, bukan ketersediaan slash. Sempat disaring
  // memakai daftar jalan pintas, dan akibatnya "Penggunaan & paket" hilang
  // dari /menu WhatsApp begitu kedua command-nya dipindah ke bahasa alami—
  // kemampuannya utuh, petanya yang bohong.
  const active = new Set(
    userCommandCatalog(options, channel).map((command) => command.category),
  );
  // Telegram membuka kontrol pengaturan lewat tombol native, bukan kumpulan
  // slash command. Capability itu tetap harus terlihat di /menu; menurunkan
  // kategori hanya karena transport kontrolnya berbeda membuat Telegram
  // tampak lebih miskin daripada WhatsApp padahal operasinya tersedia.
  if (channel === "telegram") active.add("settings");
  return CATEGORIES.filter((category) => active.has(category.id)).map(
    (category) => ({ ...category }),
  );
}

export function renderCommandMenu(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): string {
  const categories = commandCategories(options, channel);
  return [
    "Menu Harvy",
    "",
    "Kamu tetap bisa menulis seperti biasa—command ini cuma jalan pintas.",
    "",
    ...categories.map((category) => `• ${category.label} — ${category.summary}`),
    "",
    channel === "telegram"
      ? "Pilih kategori di bawah untuk melihat command-nya."
      : "Gunakan command yang ditampilkan lewat /bantuan untuk membuka fitur.",
  ].join("\n");
}

export function renderCommandCategory(
  categoryId: string,
  options: TelegramCommandOptions,
  channel: CommandChannel,
): string | null {
  const category = commandCategories(options, channel).find(
    (candidate) => candidate.id === categoryId,
  );
  if (!category) return null;
  const commands = shortcutCommandCatalog(options, channel).filter(
    (command) => command.category === category.id,
  );
  if (channel === "telegram" && category.id === "settings") {
    return [
      category.label,
      category.summary,
      "",
      "Gunakan tombol di bawah untuk mengatur memori dan data, gaya respons, zona waktu, jam tenang, serta izin AI.",
    ].join("\n");
  }
  if (commands.length === 0) {
    return [
      category.label,
      category.summary,
      "",
      "Tidak ada perintah khusus di sini. Tulis saja maksudmu dalam satu kalimat, dan Harvy menjalankannya kalau permintaanmu sudah cukup jelas.",
    ].join("\n");
  }
  return [
    category.label,
    category.summary,
    "",
    ...commands.flatMap((command) => [
      `/${command.command} — ${command.detail}`,
      ...(command.example ? [`  Contoh: ${command.example}`] : []),
    ]),
  ].join("\n");
}

/**
 * Balasan untuk slash yang tidak dikenali.
 *
 * Sebelumnya kanal tanpa tombol menjawabnya dengan seluruh `renderHelpMessage`,
 * yaitu 28 baris jalan pintas. Salah ketik satu huruf membuang seluruh katalog
 * ke dalam percakapan, dan jawaban atas "perintah ini tidak ada" menjadi lebih
 * panjang daripada apa pun yang pernah ditulis pengguna.
 */
export function renderUnknownCommand(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): string {
  const shortcuts = shortcutCommandCatalog(options, channel)
    .map((command) => `/${command.command}`)
    .join(", ");
  return [
    "Aku belum punya perintah itu.",
    "",
    "Tulis aja maksudmu seperti biasa—tugas, memori, sesi, dan pengaturan bisa dijalankan dari kalimat langsung.",
    `Perintah yang ada: ${shortcuts}. Rinciannya di /bantuan.`,
  ].join("\n");
}

export function renderHelpMessage(
  options: TelegramCommandOptions,
  channel: CommandChannel,
): string {
  const shortcuts = shortcutCommandCatalog(options, channel)
    .filter((command) => command.command !== "bantuan")
    .map((command) => `/${command.command} — ${command.description}`);
  const examples = channel === "telegram"
    ? [
        "• besok jam 7 malam ingatkan aku mengumpulkan matematika",
        "• bantu jelaskan fotosintesis pelan-pelan",
        "• berapa sisa penggunaan Harvy-ku?",
      ]
    : [
        "• besok jam 7 malam ingatkan aku mengumpulkan matematika",
        "• bantu jelaskan fotosintesis pelan-pelan",
        "• berapa sisa penggunaan Harvy-ku?",
        "• lanjutkan sesi belajar yang tadi",
      ];
  const operationGuidance = channel === "telegram"
    ? "Tugas, memori, sesi, dan perubahan data hanya dijalankan ketika permintaanmu cukup jelas."
    : "Tugas, memori, sesi, dan perubahan data hanya dijalankan ketika permintaanmu cukup jelas; gunakan jalan pintas di bawah bila ingin kontrol eksplisit.";
  return [
    "Tulis aja seperti ngobrol biasa. Harvy memahami maksudmu, lalu kode tetap membatasi tindakan yang boleh dijalankan.",
    "",
    "Contoh:",
    ...examples,
    "",
    `${operationGuidance} Untuk melihat pilihan secara ringkas, buka /menu.`,
    "",
    "Jalan pintas yang tersedia:",
    ...shortcuts,
    // Yang tidak terdaftar bukan berarti tidak ada. Tanpa baris ini
    // pemangkasan daftar terbaca sebagai kemampuan yang hilang.
    ...(channel === "whatsapp"
      ? [
          "",
          "Selebihnya tidak perlu perintah. Tulis saja, misalnya: sebutkan tugas aktifku, apa yang kamu ingat tentang aku, ubah zona waktuku ke WITA, atau gimana status coding-nya.",
        ]
      : []),
  ].join("\n");
}
