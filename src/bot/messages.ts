import { InlineKeyboard } from "grammy";
import type { ActionOffer } from "./action-offers.js";
import type { AdaptiveActionId } from "../core/action-policy.js";
import { formatClockMinute } from "../core/time-policy.js";
import type { UsageSummary } from "../core/telemetry-service.js";
import type { EconomyUsageView } from "../core/economy-service.js";
import type { MemoryItem } from "../domain/memory.js";
import type { QuietHours, UserProfile } from "../domain/profile.js";
import type { ActiveSession, SessionKind } from "../domain/session.js";
import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "santai",
  2: "biasa",
  3: "penting",
};

/**
 * Konstitusi Pasal 3.11: pengguna tidak boleh dipaksa menghafal perintah,
 * format tanggal, atau ID teknis. Seluruh teks di bawah ini memakai bahasa
 * sehari-hari dan tindakan dijalankan lewat tombol, bukan kode.
 */
export const HELP_MESSAGE = [
  "Tulis aja tugasmu seperti biasa, aku yang rapikan.",
  "",
  "Contoh:",
  "• besok jam 7 malam kumpulin matematika halaman 20",
  "• senin ada ulangan biologi, penting banget",
  "• bawa buku sejarah",
  "",
  "Setelah tercatat, tinggal pakai tombol buat nandain selesai, memilih waktu pengingat, atau ngebatalin. Kamu yang nentuin, aku cuma bantu.",
  "",
  "Kalau keadaanmu lagi berantakan, Harvy bisa menawarkan sesi untuk menjernihkan, memilih prioritas, mulai satu langkah kecil, belajar bertahap, menyusun rencana, atau menyiapkan pesan untuk orang lain. Hanya satu sesi aktif, dan check-in dikirim sekali kalau kamu sendiri memilih waktunya.",
  "",
  "Aku juga nyimpen beberapa hal biar kamu nggak perlu ngulang cerita: kelasmu, cara belajar yang cocok, apa yang lagi kamu hadapi. Buat hal pribadi aku selalu nanya dulu. Pakai /memori atau tanya aja apa yang aku ingat tentang kamu. Kalau ada yang salah, berubah, atau ingin dilupakan, cukup bilang.",
  "",
  "/tugas — lihat semua tugasmu",
  "/memori — lihat yang aku ingat tentang kamu",
  "/penggunaan — lihat kapasitas dan waktu pembaruan Harvy",
  "/dukung — informasi kontribusi sukarela Harvy Commons",
  "/bantuan — tampilkan pesan ini",
].join("\n");

export function helpActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Data & izin", "control:data")
    .text("Atur waktu", "control:timezone")
    .row()
    .text("Sesi yang aktif", "control:active-session");
}

export function formatTask(task: StudentTask, timeZone: string): string {
  const details = [IMPORTANCE_LABEL[task.importance], formatDue(task, timeZone)];

  if (task.reminderAt) {
    details.push(`🔔 ${formatMoment(task.reminderAt, timeZone, "short")}`);
  }

  return [`• ${task.title}`, `  ${details.join(" · ")}`].join("\n");
}

function formatDue(task: StudentTask, timeZone: string): string {
  if (!task.dueAt) return "tanpa tenggat";

  // Tenggat 23.59 berasal dari tanggal tanpa jam; menampilkannya sebagai jam
  // persis akan terasa lebih mendesak daripada yang pengguna maksud.
  const local = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(task.dueAt));

  const day = formatMoment(task.dueAt, timeZone, "medium", false);
  return local === "23.59" ? day : `${day} ${local}`;
}

function formatMoment(
  iso: string,
  timeZone: string,
  dateStyle: "short" | "medium",
  withTime = true,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle,
    ...(withTime ? { timeStyle: "short" as const } : {}),
    timeZone,
  }).format(new Date(iso));
}

/** Tombol untuk satu tugas yang baru saja dicatat atau diubah. */
export function taskActions(task: StudentTask): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("✓ Selesai", `done:${task.id}`);

  if (task.dueAt) {
    keyboard.text("🔔 Ingatkan", `remind:${task.id}`);
  }

  return keyboard
    .row()
    .text("Ubah tenggat", `edit:${task.id}`)
    .text("Batalkan", `drop:${task.id}`);
}

/** Persetujuan sebelum sebuah pesan dicatat sebagai tugas. */
export function confirmActions(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, catat", `save:${token}`)
    .text("Nggak usah", `nosave:${token}`);
}

/** Satu baris tombol per tugas, agar pengguna tidak perlu mengetik ID. */
export function taskListActions(tasks: StudentTask[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const task of tasks) {
    keyboard.text(`✓ ${shorten(task.title)}`, `done:${task.id}`).row();
  }

  return keyboard;
}

export function reminderActions(task: StudentTask): InlineKeyboard {
  return new InlineKeyboard()
    .text("✓ Selesai", `done:${task.id}`)
    .text("Ingatkan 1 jam lagi", `snooze:${task.id}`);
}

/**
 * Menjelaskan apa yang belum dipahami, agar pengguna dapat mengoreksi.
 *
 * Tugas yang lahir dari permintaan pengingat memang tidak punya tenggat, dan
 * menanyakannya di situ hanya membingungkan: pengguna sudah menyebut waktunya.
 */
export function understandingNote(task: StudentTask): string {
  if (task.dueAt || task.reminderAt) return "";

  return "\nAku belum nangkep kapan tenggatnya. Kalau ada, tekan Ubah tenggat.";
}

function shorten(title: string, limit = 28): string {
  return title.length <= limit ? title : `${title.slice(0, limit - 1)}…`;
}

/**
 * Pemberitahuan bahwa sesuatu baru saja diingat.
 *
 * Pasal 4 nomor 2 meminta pengguna tahu sebelum sesuatu yang baru disimpan.
 * Catatan ini tetap tipis dan menempel pada percakapan, tetapi tidak lagi
 * meminta pengguna mengelola setiap penyimpanan lewat tombol database.
 */
export const MEMORY_NOTE_PREFIX = "💭";

export function memoryNoteLines(items: MemoryItem[]): string {
  if (items.length > 1) {
    return [
      `${MEMORY_NOTE_PREFIX} Siap, beberapa hal yang berguna dari ceritamu aku ingat supaya kamu nggak perlu mengulangnya:`,
      ...items.map((item) => `• ${item.content}`),
    ].join("\n");
  }
  const item = items[0];
  if (!item) return "";
  switch (item.kind) {
    case "preference":
      return `${MEMORY_NOTE_PREFIX} Oke, yang ini aku ingat supaya caraku membantumu lebih pas: ${item.content}`;
    case "routine":
      return `${MEMORY_NOTE_PREFIX} Siap, kebiasaan ini aku ingat: ${item.content}`;
    case "context":
      return `${MEMORY_NOTE_PREFIX} Oke, yang sedang berjalan ini aku ingat: ${item.content}`;
    case "personal":
      return `${MEMORY_NOTE_PREFIX} Siap, dengan izinmu aku ingat: ${item.content}`;
    case "profile":
      return `${MEMORY_NOTE_PREFIX} Siap, yang ini aku ingat: ${item.content}`;
  }
}

/** Menempelkan catatan ke bubble terakhir sebuah balasan. */
export function withMemoryNotes(bubble: string, items: MemoryItem[]): string {
  if (items.length === 0) return bubble;
  return [bubble.trimEnd(), "", memoryNoteLines(items)].join("\n");
}

/**
 * Membuang satu baris catatan dari balasan yang sudah terkirim.
 *
 * Balasan itu pesan sungguhan, jadi ia tidak boleh dihapus atau ditimpa daftar
 * memori hanya karena tombolnya ditekan. Yang hilang cukup barisnya, supaya
 * chat tidak menyisakan pernyataan "aku inget ini" tentang sesuatu yang sudah
 * dilupakan.
 */
export function withoutMemoryNote(
  text: string,
  content: string | null,
): string {
  const kept = content
    ? text
        .split("\n")
        .filter(
          (line) =>
            !(line.startsWith(MEMORY_NOTE_PREFIX) && line.includes(content)),
        )
    : text.split("\n");

  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const note = "🗑 Oke, itu aku lupain.";

  return cleaned ? `${cleaned}\n\n${note}` : note;
}

/**
 * Jeda kecil sebelum bubble lanjutan dikirim.
 *
 * Tiga bubble yang tiba pada milidetik yang sama terbaca seperti notifikasi
 * beruntun, bukan seperti orang yang sedang mengetik. Jeda ini untuk
 * keterbacaan, bukan untuk memperpanjang percakapan — Pasal 3.12 melarang yang
 * kedua — karena itu ia pendek dan berplafon.
 */
export const MAX_BUBBLE_PAUSE_MS = 1_200;

export function bubblePauseMs(text: string): number {
  const estimate = Math.round(text.trim().length * 18);
  return Math.min(Math.max(estimate, 300), MAX_BUBBLE_PAUSE_MS);
}

/** Persetujuan sebelum hal sensitif disimpan. Pasal 4 nomor 3. */
export function memoryConsentActions(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Boleh diingat", `memsave:${token}`)
    .text("Jangan", `memskip:${token}`);
}

export const MEMORY_PORTRAIT_TITLE = "Yang aku ingat tentang kamu";
export const MEMORY_PORTRAIT_EMPTY = [
  MEMORY_PORTRAIT_TITLE,
  "",
  "Belum banyak. Kita masih baru saling kenal, jadi belum ada banyak hal yang benar-benar perlu kusimpan.",
  "",
  "Kalau nanti ada hal yang berguna untuk kuingat, aku akan menggunakannya supaya kamu nggak perlu terus mengulang cerita.",
].join("\n");
export const MEMORY_PORTRAIT_UNAVAILABLE = [
  MEMORY_PORTRAIT_TITLE,
  "",
  "Aku masih punya beberapa ingatan tentang kamu, tapi sekarang aku belum bisa menyusunnya menjadi ringkasan yang jujur. Coba buka lagi sebentar lagi, ya.",
].join("\n");
export const MEMORY_CHANGE_PROMPT =
  "Ada yang salah atau udah berubah? Bilang aja. Kamu juga bisa minta aku melupakan sesuatu.";
export const MEMORY_WIPE_PROMPT = [
  "Ini bakal membuatku melupakan semua yang kusimpan tentang kamu, termasuk riwayat obrolan kita.",
  "",
  "Setelah ini, beberapa percakapan mungkin terasa seperti kita mulai mengenal lagi.",
].join("\n");

export function formatMemoryPortrait(summary: string): string {
  return [MEMORY_PORTRAIT_TITLE, "", summary.trim()].join("\n");
}

export function memoryPortraitActions(): InlineKeyboard {
  return new InlineKeyboard().text("Ubah", "memchange:");
}

/**
 * Menghapus seluruh ingatan tidak dapat dibatalkan, jadi ia dikonfirmasi.
 *
 * Ini bukan penghalang: Pasal 4 nomor 5 melarang penarikan izin dipersulit.
 * Satu ketukan tambahan yang menjelaskan akibatnya bukan mempersulit, melainkan
 * memenuhi Pasal 3.11 soal menunjukkan konsekuensi sebelum tindakan penting.
 */
export function memoryWipeConfirmActions(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, lupakan semuanya", `memallyes:${token}`)
    .text("Batal", `memallno:${token}`);
}

const ACTION_LABEL: Record<AdaptiveActionId, string> = {
  listen: "Dengerin dulu",
  clarify: "Bantu jernihin",
  prioritize: "Bantu pilih prioritas",
  start_small: "Mulai langkah kecil",
  tutor: "Ajari pelan-pelan",
  plan: "Susun rencana",
  human_bridge: "Bantu ngomong ke orang",
  schedule_checkin: "Tanyain lagi nanti",
  view_session: "Lihat sesi",
  stop_session: "Berhenti",
  data_controls: "Data & izin",
};

export function adaptiveActionLabel(action: AdaptiveActionId): string {
  return ACTION_LABEL[action];
}

export function adaptiveActionButtons(offer: ActionOffer): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const action of offer.actions) {
    keyboard
      .text(
        ACTION_LABEL[action],
        `flow:${offer.token}.${action}`,
      )
      .row();
  }
  return keyboard;
}

export function mergeKeyboards(
  ...keyboards: (InlineKeyboard | null | undefined)[]
): InlineKeyboard | undefined {
  const merged = new InlineKeyboard();
  for (const keyboard of keyboards) {
    if (!keyboard) continue;
    for (const row of keyboard.inline_keyboard) {
      merged.inline_keyboard.push([...row]);
    }
  }
  return merged.inline_keyboard.length > 0 ? merged : undefined;
}

const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  clarify: "menjernihkan keadaan",
  prioritize: "memilih prioritas",
  focus: "langkah kecil",
  tutor: "belajar bertahap",
  plan: "menyusun rencana",
  "human-bridge": "menyusun pesan untuk orang lain",
};

const SESSION_STAGE_LABEL: Record<ActiveSession["stage"], string> = {
  assess: "melihat pemahaman awal",
  attempt: "mencoba",
  hint: "petunjuk",
  explain: "penjelasan",
  retry: "mencoba lagi",
  collect: "mengumpulkan yang penting",
  choose: "memilih",
  act: "mengerjakan langkah terdekat",
  reflect: "menyesuaikan rencana",
  draft: "menyusun draf",
};

export function formatSession(
  session: ActiveSession,
  timeZone: string,
): string {
  const checkIn = session.checkIn
    ? session.checkIn.sentAt
      ? " · check-in sudah dikirim"
      : ` · check-in ${new Intl.DateTimeFormat("id-ID", {
          dateStyle: "short",
          timeStyle: "short",
          timeZone,
        }).format(new Date(session.checkIn.at))}`
    : "";

  return [
    `🌿 Sesi aktif: ${SESSION_KIND_LABEL[session.kind]}`,
    `Tujuan: ${session.goal}`,
    `Tahap: ${SESSION_STAGE_LABEL[session.stage]}${checkIn}`,
  ].join("\n");
}

export function sessionActions(session: ActiveSession): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const prefix = `${session.id}.`;

  if (session.kind === "tutor") {
    if (session.stage === "assess") {
      keyboard.text("Aku coba dulu", `session:${prefix}attempt`);
    } else if (session.stage === "attempt" || session.stage === "hint") {
      keyboard.text("Kasih petunjuk", `session:${prefix}hint`);
    } else {
      keyboard.text("Coba lagi", `session:${prefix}retry`);
    }
    return keyboard
      .text("Jelaskan langsung", `session:${prefix}direct`)
      .row()
      .text("Berhenti", `session:${prefix}stop`);
  }

  if (session.kind === "focus") {
    return keyboard
      .text("Selesai", `session:${prefix}done`)
      .text("Aku tersangkut", `session:${prefix}stuck`)
      .row()
      .text("Tanyain lagi nanti", `session:${prefix}checkin`);
  }

  return keyboard
    .text("Lanjut", `session:${prefix}continue`)
    .text("Selesai", `session:${prefix}done`)
    .row()
    .text("Tanyain lagi nanti", `session:${prefix}checkin`);
}

export function checkInOutcomeActions(session: ActiveSession): InlineKeyboard {
  const prefix = `${session.id}.`;
  return new InlineKeyboard()
    .text("Selesai", `checkin:${prefix}done`)
    .text("Masih jalan", `checkin:${prefix}ongoing`)
    .row()
    .text("Aku tersangkut", `checkin:${prefix}stuck`)
    .text("Ubah rencana", `checkin:${prefix}replan`)
    .row()
    .text("Berhenti", `checkin:${prefix}stop`);
}

export const CHECK_IN_MESSAGE =
  "Gimana langkah kecil tadi—selesai, masih jalan, atau mau ubah rencana?";

export function dataControlActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Lihat yang aku ingat", "control:memories")
    .row()
    .text("Hapus semua ingatan", "memall:")
    .row()
    .text("Didengerin dulu", "style:listen")
    .text("Langsung saran", "style:advice")
    .row()
    .text("Ekspor dataku", "control:export")
    .text("Penggunaan Harvy", "control:usage")
    .row()
    .text("Atur zona waktu", "control:timezone")
    .text("Atur jam tenang", "control:quiet-hours")
    .row()
    .text("Tarik izin AI", "control:withdraw")
    .text("Hapus seluruh data", "control:delete-all");
}

export function timezoneActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("WIB", "timezone:Asia/Jakarta")
    .text("WITA", "timezone:Asia/Makassar")
    .text("WIT", "timezone:Asia/Jayapura");
}

export function quietHoursActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("21.00–06.00", "quiet:1260-360")
    .text("22.00–06.00", "quiet:1320-360")
    .row()
    .text("Tulis sendiri", "quiet:custom")
    .text("Tanpa jam tenang", "quiet:none");
}

export function formatTimeSettings(profile: UserProfile): string {
  const quiet = profile.quietHoursSetAt
    ? profile.quietHours
      ? formatQuietHours(profile.quietHours)
      : "tidak dipakai"
    : "belum dipilih";
  return [
    `Zona waktu: ${timeZoneLabel(profile.timeZone)}`,
    `Jam tenang: ${quiet}`,
  ].join("\n");
}

function timeZoneLabel(timeZone: string | null): string {
  switch (timeZone) {
    case "Asia/Jakarta":
      return "WIB";
    case "Asia/Makassar":
      return "WITA";
    case "Asia/Jayapura":
      return "WIT";
    case null:
      return "belum dipilih";
    default:
      return timeZone;
  }
}

function formatQuietHours(hours: QuietHours): string {
  return `${formatClockMinute(hours.startMinute)}–${formatClockMinute(
    hours.endMinute,
  )}`;
}

export function withdrawConsentConfirmActions(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, tarik izin", `consentwithdraw:${token}.yes`)
    .text("Batal", `consentwithdraw:${token}.no`);
}

export function deleteAllConfirmActions(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, hapus seluruh data", `datawipe:${token}.yes`)
    .text("Batal", `datawipe:${token}.no`);
}

export function formatUsage(summary: UsageSummary): string {
  const limit =
    summary.limit > 0
      ? `${summary.capacityUsedTokens.toLocaleString("id-ID")} dari ${summary.limit.toLocaleString("id-ID")} token kapasitas`
      : `${summary.capacityUsedTokens.toLocaleString("id-ID")} token kapasitas (tanpa batas aktif)`;
  const cost =
    summary.estimatedCostUsd > 0
      ? `Perkiraan biaya: US$${summary.estimatedCostUsd.toFixed(6)}`
      : "Perkiraan biaya belum dihitung karena harga model belum diisi.";

  return [
    "Pemakaian AI dalam 24 jam terakhir:",
    limit,
    `Request bernilai ${summary.totalTokens.toLocaleString("id-ID")} token · masuk ${summary.inputTokens.toLocaleString("id-ID")} · keluar ${summary.outputTokens.toLocaleString("id-ID")}`,
    "Kapasitas hanya berkurang setelah balasan berhasil dikirim.",
    cost,
    "",
    "Angka ini tidak menyimpan isi pesanmu.",
  ].join("\n");
}

/** Ringkasan pemakaian yang tidak memaksa pengguna memahami token/provider. */
export function formatEconomyUsage(view: EconomyUsageView): string {
  const health = view.health === "healthy"
    ? "Banyak tersisa"
    : view.health === "getting_low"
      ? "Cukup"
      : view.health === "low"
        ? "Hampir habis"
        : "Sudah terpakai";
  const reset = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(view.nextResetAt));
  const funding = view.byokAvailable
    ? "BYOK tersedia"
    : view.autoUseWallet
      ? "Saldo tambah compute dapat digunakan otomatis"
      : "Saldo tambah compute tidak digunakan otomatis";
  return [
    "Penggunaan Harvy",
    health,
    `Paket: ${view.planName}`,
    `Diperbarui ${reset}`,
    funding,
    "Memory, percakapan, dan pekerjaanmu tetap tersimpan.",
  ].join("\n");
}

/**
 * Paragraf pendek terasa seperti bubble chat; blok kode tetap utuh selama
 * ukurannya masih dapat dikirim Telegram.
 *
 * Maksimal tiga bubble mencegah satu balasan berubah menjadi rentetan
 * notifikasi. Jika model menulis lebih banyak paragraf, sisanya digabung ke
 * bubble terakhir tanpa menghilangkan teks. Batas keras platform lebih tinggi
 * prioritas: bubble di atas 4.000 karakter dipecah tanpa membuang karakter,
 * meskipun hasil akhirnya perlu lebih dari tiga bubble.
 */
export function splitReplyBubbles(reply: string, limit = 3): string[] {
  const clean = normalizeTelegramText(reply).trim();
  if (!clean) return [];
  const logicalBubbles =
    clean.includes("```") || limit <= 1
      ? [clean]
      : splitParagraphs(clean, limit);

  return logicalBubbles.flatMap((bubble) => splitForTelegram(bubble));
}

/**
 * Model kadang mengirim Markdown/LaTeX walau Telegram menerima teks biasa.
 * Normalisasi ini hanya menyentuh bagian di luar pagar kode agar kode yang
 * memang diminta pengguna tidak rusak.
 */
export function normalizeTelegramText(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => (index % 2 === 1 ? part : normalizePlainPart(part)))
    .join("");
}

function normalizePlainPart(text: string): string {
  return text
    .split(/(https?:\/\/[^\s<>"']+)/giu)
    .map((part, index) => index % 2 === 1 ? part : normalizeMarkup(part))
    .join("");
}

function normalizeMarkup(text: string): string {
  return text
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
    .replace(/\\(?:times|cdot)\b/g, "×")
    .replace(/\\[()[\]]/g, "")
    .replace(/\$\$?([^$\n]+)\$\$?/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

const TELEGRAM_SAFE_MESSAGE_CHARS = 4_000;

function splitParagraphs(clean: string, limit: number): string[] {
  const paragraphs = clean
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1) return [clean];
  if (paragraphs.length <= limit) return paragraphs;

  return [
    ...paragraphs.slice(0, limit - 1),
    paragraphs.slice(limit - 1).join("\n\n"),
  ];
}

function splitForTelegram(text: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= TELEGRAM_SAFE_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  for (
    let start = 0;
    start < characters.length;
    start += TELEGRAM_SAFE_MESSAGE_CHARS
  ) {
    chunks.push(
      characters
        .slice(start, start + TELEGRAM_SAFE_MESSAGE_CHARS)
        .join(""),
    );
  }
  return chunks;
}
