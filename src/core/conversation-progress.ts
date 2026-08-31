import type { ExecutionPlan } from "./execution-policy.js";
import type { TurnInterruptionRelation } from "./turn-taking-policy.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { capabilityWork } from "../harness/capabilities.js";
import type { CapabilityWork } from "../harness/capabilities.js";

/**
 * Tahap giliran Harvy sendiri—bukan kerja alat.
 *
 * Sepenuhnya milik kode. Model tidak dapat memilih maupun menambahnya.
 */
export type TurnStagePhase =
  | "listening"
  /**
   * Pesan pengguna sudah tiba, tetapi belum ada pekerjaan yang dimulai.
   *
   * Harvy menahan giliran beberapa detik untuk memastikan pengguna selesai
   * mengetik. Selama itu layar dulu sunyi total—status pertama baru muncul
   * sesudah jendela tutup, sehingga pesan yang menggantung bisa tidak berbalas
   * tanda apa pun sampai dua belas detik. Fase ini mengisi bagian itu, dan
   * sengaja tidak mengaku sedang membaca atau memikirkan: pada detik itu model
   * belum dipanggil sama sekali.
   */
  | "waiting"
  | "thinking"
  | "checking"
  | "adjusting"
  | "switching"
  | "composing"
  | "responding";

/**
 * Kerja alat, dinyatakan capability-nya sendiri.
 *
 * Sengaja identik dengan `CapabilityWork` supaya tidak ada dua sumber
 * kebenaran: menambah kerja baru di katalog langsung membuat compiler menuntut
 * judulnya di sini.
 */
export type ToolWorkPhase = CapabilityWork;

/**
 * Gabungan keduanya.
 *
 * Dulu satu enum datar, dan satu fungsi dipaksa melayani dua hal berbeda—di
 * sambungan itulah keranjang sampah "Memeriksa" lahir. Dipisah, masing-masing
 * bisa lengkap sendiri dan compiler bisa memaksa keduanya.
 */
export type ConversationProgressPhase = TurnStagePhase | ToolWorkPhase;

export type ConversationProgressDetail =
  | "general"
  | "initial"
  | "latest-information"
  | "personal-fit"
  | "consistency"
  | "new-context"
  | "new-direction"
  /** Pesan susulan yang datang saat pekerjaan sudah mulai, hubungannya belum dinilai. */
  | "new-message";

export const PUBLIC_PROGRESS_FOCUS_KINDS = [
  "inspect",
  "distinguish",
  "compare",
  "current-information",
  "calculate",
  "verify",
  "adjust",
  "switch",
] as const;

export type PublicProgressFocusKind =
  typeof PUBLIC_PROGRESS_FOCUS_KINDS[number];

/**
 * Ringkasan pekerjaan yang aman ditampilkan. Ini bukan reasoning, hasil, atau
 * salinan pesan: hanya subject/contrast/purpose pendek untuk surface transient.
 */
export interface SafePublicProgressFocus {
  readonly kind: PublicProgressFocusKind;
  readonly subject: string;
  readonly contrast: string | null;
  readonly purpose: string | null;
}

export interface ConversationProgressEvent {
  phase: ConversationProgressPhase;
  /** Closed-set agar adapter tidak pernah meneruskan hidden reasoning. */
  detail?: ConversationProgressDetail;
  /** Bounded public work focus; tidak pernah provider reasoning atau authority. */
  publicFocus?: SafePublicProgressFocus;
}

export interface ConversationProgressReporter {
  report(event: ConversationProgressEvent): void;
  responding?(): Promise<void> | void;
}

export interface ConversationProgressLifecycle
  extends ConversationProgressReporter {
  finish(): Promise<void>;
}

export interface ProgressSurfaceRenderer<Reference> {
  show(text: string): Promise<Reference>;
  update(reference: Reference, text: string): Promise<void>;
  remove(reference: Reference): Promise<void>;
  typing?(): Promise<void>;
}

export interface TransientProgressOptions {
  graceMs?: number;
  minimumUpdateIntervalMs?: number;
  /**
   * Irama denyut bulan. Terpisah dari `minimumUpdateIntervalMs` karena throttle
   * itu boleh disetel sekecil apa pun, sedangkan animasi yang ikut mengecil
   * akan menyunting puluhan kali per detik untuk gerak yang tak terlihat mata.
   */
  animationIntervalMs?: number;
  /**
   * Baris terakhir status: lamanya giliran berjalan dan token yang terpakai.
   *
   * Disediakan pemanggil, bukan dihitung di sini, karena sumbernya milik
   * adapter—jam giliran dan ledger pemakaian. Dipanggil ulang tiap denyut,
   * jadi ia wajib murah dan tidak boleh menyentuh I/O.
   */
  footer?: () => string | null;
  seed?: string;
  onError?: (operation: "show" | "update" | "remove" | "typing", error: unknown) => void;
}

const DEFAULT_GRACE_MS = 700;

/**
 * Jeda khusus fase menunggu, jauh lebih pendek daripada fase lain.
 *
 * Jeda 700 ms ada supaya balasan cepat tidak memunculkan status yang langsung
 * hilang lagi. Untuk fase menunggu itu justru menghapus gunanya: kalimat biasa
 * yang jelas selesai mendapat jendela tunggu nol detik, sehingga fasenya sudah
 * pindah ke "Membaca" sebelum 700 ms lewat—dan pengakuan yang seharusnya
 * seketika tidak pernah terlihat sama sekali.
 *
 * Yang tersisa dijaga: balasan deterministik di bawah 250 ms tetap tidak
 * memunculkan apa pun.
 */
const WAITING_GRACE_MS = 250;

/**
 * Irama denyut bulan: satu detik.
 *
 * Punya lantainya sendiri, tidak mengikuti `minimumUpdateIntervalMs`. Throttle
 * itu boleh disetel sekecil apa pun oleh pemanggil, dan animasi yang ikut
 * mengecil akan menyunting pesan puluhan kali per detik untuk gerak yang tak
 * terlihat mata.
 *
 * Semula 1.500 ms dan disalurkan lewat `scheduleUpdate`, dan hasilnya tersendat:
 * penjadwal itu menelan denyut yang datang selagi ia menunggu, sehingga
 * fasenya melompat alih-alih mengalir. Denyut kini menyunting langsung—ia tidak
 * pernah bertabrakan dengan perubahan fase karena keduanya berbagi antrean
 * operasi yang sama.
 */
const ANIMATION_INTERVAL_MS = 1_000;

/** Berapa denyut bulan sebelum kalimat di bawah judul bergeser. */
const NOTE_ROTATION_FRAMES = 5;
const DEFAULT_MINIMUM_UPDATE_INTERVAL_MS = 1_500;

/**
 * Satu transient surface per turn. Semua kegagalan bersifat kosmetik dan tidak
 * pernah menolak promise delivery jawaban utama.
 */
export class TransientConversationProgress<Reference>
  implements ConversationProgressLifecycle {
  private latest: ConversationProgressEvent | null = null;
  private reference: Reference | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingTimer: ReturnType<typeof setInterval> | null = null;
  private waitingFrame = 0;
  private operation = Promise.resolve();
  private lastRenderedAt = 0;
  private closed = false;
  private readonly graceMs: number;
  private readonly minimumUpdateIntervalMs: number;
  private readonly animationIntervalMs: number;
  private readonly seed: string;

  constructor(
    private readonly renderer: ProgressSurfaceRenderer<Reference>,
    private readonly options: TransientProgressOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.graceMs = nonNegativeInteger(options.graceMs, DEFAULT_GRACE_MS);
    this.minimumUpdateIntervalMs = nonNegativeInteger(
      options.minimumUpdateIntervalMs,
      DEFAULT_MINIMUM_UPDATE_INTERVAL_MS,
    );
    this.animationIntervalMs = nonNegativeInteger(
      options.animationIntervalMs,
      ANIMATION_INTERVAL_MS,
    );
    this.seed = options.seed ?? "harvy";
  }

  report(event: ConversationProgressEvent): void {
    if (this.closed || event.phase === "listening") return;
    if (event.phase === "responding") {
      void this.responding();
      return;
    }
    const normalized = normalizeProgressEvent(event);
    if (sameEvent(this.latest, normalized)) return;
    this.latest = normalized;
    if (this.reference === null && this.graceTimer === null) {
      const grace = normalized.phase === "waiting"
        ? Math.min(this.graceMs, WAITING_GRACE_MS)
        : this.graceMs;
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.enqueue(() => this.showLatest());
      }, grace);
      this.graceTimer.unref?.();
      return;
    }
    if (this.reference !== null) this.scheduleUpdate();
  }

  async responding(): Promise<void> {
    await this.finish();
  }

  async finish(): Promise<void> {
    if (this.closed) {
      await this.operation;
      return;
    }
    this.closed = true;
    this.stopAnimation();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.graceTimer = null;
    this.updateTimer = null;
    this.enqueue(async () => {
      const reference = this.reference;
      this.reference = null;
      if (reference === null) return;
      try {
        await this.renderer.remove(reference);
      } catch (error) {
        this.options.onError?.("remove", error);
      }
    });
    await this.operation;
  }

  /**
   * Status bergerak sendiri, tidak menunggu peristiwa baru.
   *
   * Seluruh status lain berubah karena ada yang dilaporkan. Fase menunggu tidak
   * punya peristiwa apa pun untuk dilaporkan—justru itu maksudnya—sehingga
   * tanpa denyut sendiri ia akan diam sepenuhnya selama beberapa detik dan
   * terlihat macet, persis kebalikan dari yang hendak ditunjukkannya.
   *
   * Iramanya mengikuti `minimumUpdateIntervalMs`, jadi ia tidak pernah
   * menyunting lebih sering daripada batas yang sudah dipilih untuk kanal.
   */
  private startAnimation(): void {
    if (this.closed || this.waitingTimer !== null) return;
    this.waitingTimer = setInterval(() => {
      if (this.closed) {
        this.stopAnimation();
        return;
      }
      this.waitingFrame += 1;
      if (this.reference !== null) this.enqueue(() => this.updateLatest());
    }, this.animationIntervalMs);
    this.waitingTimer.unref?.();
  }

  private stopAnimation(): void {
    if (this.waitingTimer === null) return;
    clearInterval(this.waitingTimer);
    this.waitingTimer = null;
  }
  private async showLatest(): Promise<void> {
    if (this.closed || this.reference !== null || !this.latest) return;
    try {
      await this.renderer.typing?.();
    } catch (error) {
      this.options.onError?.("typing", error);
    }
    if (this.closed || !this.latest) return;
    try {
      this.reference = await this.renderer.show(
        renderConversationProgress(
          this.latest,
          this.seed,
          this.waitingFrame,
          this.options.footer?.() ?? null,
        ),
      );
      this.lastRenderedAt = this.now();
      this.startAnimation();
    } catch (error) {
      this.options.onError?.("show", error);
    }
  }

  private scheduleUpdate(): void {
    if (this.closed || this.updateTimer !== null) return;
    const elapsed = this.now() - this.lastRenderedAt;
    const delay = Math.max(0, this.minimumUpdateIntervalMs - elapsed);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.enqueue(() => this.updateLatest());
    }, delay);
    this.updateTimer.unref?.();
  }

  private async updateLatest(): Promise<void> {
    if (this.closed || this.reference === null || !this.latest) return;
    try {
      await this.renderer.update(
        this.reference,
        renderConversationProgress(
          this.latest,
          this.seed,
          this.waitingFrame,
          this.options.footer?.() ?? null,
        ),
      );
      this.lastRenderedAt = this.now();
    } catch (error) {
      this.options.onError?.("update", error);
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operation = this.operation.then(operation, operation).catch(() => undefined);
  }
}

/**
 * Status untuk jendela sebelum pemahaman pesan selesai.
 *
 * Sampai 28 Agustus 2026 laporan progress paling awal terjadi *sesudah*
 * `understand()`, triase, dan retrieval memori. Padahal di situlah giliran
 * membayar panggilan model termahalnya, sehingga surface status baru menyala
 * ketika Harvy hampir siap menjawab dan pengguna menunggu dengan layar kosong
 * pada bagian yang justru paling lama.
 *
 * Event ini sepenuhnya code-owned: tidak ada `publicFocus`, jadi tidak ada
 * bagian keluaran model yang tampil sebelum triase final menilai giliran ini.
 */
export function initialProgressEvent(): ConversationProgressEvent {
  return progressEvent("thinking", "initial");
}

export function executionProgressEvent(
  execution: ExecutionPlan,
  publicFocus?: SafePublicProgressFocus | null,
): ConversationProgressEvent {
  const effort = execution.effectiveEffort;
  if (effort !== null && effort !== "none") {
    return progressEvent("thinking", "general", publicFocus);
  }
  return progressEvent("composing", "general", publicFocus);
}

/**
 * Fase untuk sebuah capability, dibaca dari deklarasinya.
 *
 * Dulu ini mencocokkan potongan kata di dalam id-nya pakai regex, dan itu salah
 * secara mendasar: id adalah nama, bukan janji. Mengganti nama sebuah capability
 * diam-diam mengubah judulnya, dan capability baru dengan nama yang tidak memuat
 * kata ajaib jatuh ke keranjang tanpa peringatan. Diukur 31 Agustus 2026: 25
 * dari 37 capability jatuh ke sana.
 *
 * `working` di sini hanya untuk id yang tidak ada di katalog sama sekali—itu
 * kesalahan pemanggil, bukan jenis kerja. Setiap capability nyata menyatakan
 * miliknya sendiri, dan satu tes memeriksa itu atas katalog sungguhan.
 */
export function capabilityProgressEvent(
  capabilityId: string,
  publicFocus?: SafePublicProgressFocus | null,
): ConversationProgressEvent {
  const work = capabilityWork(capabilityId) ?? "working";
  return progressEvent(work, WORK_DETAIL[work], publicFocus);
}

const WORK_DETAIL: Record<ToolWorkPhase, ConversationProgressDetail> = {
  reading: "general",
  searching: "latest-information",
  comparing: "personal-fit",
  writing: "general",
  running: "general",
  saving: "general",
  sending: "general",
  working: "general",
};

export function interruptionProgressEvent(
  relation: TurnInterruptionRelation | null | undefined,
  publicFocus?: SafePublicProgressFocus | null,
): ConversationProgressEvent | null {
  if (relation === "addition" || relation === "correction") {
    return progressEvent("adjusting", "new-context", publicFocus);
  }
  if (relation === "redirect") {
    return progressEvent("switching", "new-direction", publicFocus);
  }
  return null;
}

/**
 * Baru dipanggil adapter setelah triase final. Dengan begitu focus hasil
 * understanding tidak sempat tampil pada turn yang kemudian masuk lane safety.
 */
export function publicFocusProgressEvent(
  relation: TurnInterruptionRelation | null | undefined,
  publicFocus: SafePublicProgressFocus | null | undefined,
): ConversationProgressEvent | null {
  // Focus dari extractor adalah advisory dan dapat tertinggal satu objek/topik
  // pada giliran koreksi atau redirect. Relation code-owned lebih tepercaya:
  // tampilkan status generik yang jujur tanpa membocorkan detail model yang
  // belum tervalidasi oleh jawaban akhir.
  if (relation === "correction" || relation === "redirect") {
    return interruptionProgressEvent(relation, null);
  }
  const normalized = parsePublicProgressFocus(publicFocus);
  if (!normalized) return null;
  return interruptionProgressEvent(relation, normalized) ??
    progressEvent("checking", "consistency", normalized);
}

/**
 * Fase bulan yang berputar selama Harvy bekerja.
 *
 * Semula hanya untuk fase menunggu, dan itu membuatnya nyaris tak terlihat:
 * kalimat lengkap mendapat jendela tunggu nol detik, sehingga bulannya tampil
 * satu fase lalu langsung berganti judul. Kini ia menemani seluruh fase—judul
 * menjelaskan apa yang dikerjakan, bulan membuktikan ada yang sedang
 * dikerjakan.
 *
 * Siklus penuh, bukan separuh: pekerjaan yang belum selesai tidak punya tujuan
 * yang dapat ditunjukkan, dan indikator yang berhenti di purnama terlihat
 * macet.
 */
const PROGRESS_FRAMES = [
  "🌒",
  "🌓",
  "🌔",
  "🌕",
  "🌖",
  "🌗",
  "🌘",
  "🌑",
] as const;

export function renderConversationProgress(
  event: ConversationProgressEvent,
  seed = "harvy",
  frame = 0,
  meter: string | null = null,
): string {
  const status = STATUS[event.phase];
  if (!status) return "";
  const moon = PROGRESS_FRAMES[frame % PROGRESS_FRAMES.length] ??
    PROGRESS_FRAMES[0];
  // Biaya menempel di baris judul, bukan baris sendiri: tiga baris untuk satu
  // status transient terlalu berat, dan judul adalah baris yang matanya cari.
  const lines: string[] = [
    meter ? `${moon} ${status} · ${meter}` : `${moon} ${status}`,
  ];
  if (event.phase !== "waiting") {
    const publicFocus = parsePublicProgressFocus(event.publicFocus);
    const focusedNote = publicFocus
      ? realizePublicProgressNote(event.phase, publicFocus)
      : null;
    const notes = FALLBACK_NOTES[event.phase]?.[event.detail ?? "general"] ??
      FALLBACK_NOTES[event.phase]?.general ?? [];
    // Tanpa catatan pengganti ketika tidak ada yang berarti untuk disebut.
    // Kalimat yang muat untuk apa saja tidak memberi tahu apa pun, dan judul
    // sendirian lebih jujur daripada mengisi baris kedua demi ada isinya.
    const note = focusedNote ??
      notes[stableIndex(seed, event.phase, notes.length, frame)] ?? null;
    if (note) lines.push(note);
  }
  return lines.join("\n");
}

/**
 * Bagian biaya pada baris judul: lama berjalan, lalu token bila sudah ada.
 *
 * Tanpa kurung dan tanpa kata "tokens"—panahnya sudah menjelaskan, dan judul
 * yang terlalu panjang patah ke baris berikutnya pada layar sempit, yang
 * membuat baris jangkar justru terlihat berantakan.
 *
 * Arah panahnya dari kursi pengguna, bukan kursi model: pertanyaanku **naik**
 * ke Harvy, jawabannya **turun** ke aku. Versi pertama memakainya terbalik
 * karena berpikir dari sisi model, dan itu tidak masuk akal bagi orang yang
 * membacanya—ia tidak melihat modelnya.
 *
 * Keduanya ditampilkan, bukan digabung. Timpangnya ekstrem: input sekitar 97%
 * dari totalnya karena prompt sistem dikirim ulang tiap panggilan. Satu angka
 * gabungan terbaca seolah Harvy menulis panjang sekali; dipisah, ia jujur bahwa
 * yang mahal bukan jawabannya.
 */
export function renderProgressMeter(
  elapsedMs: number,
  tokens: { input: number; output: number },
): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return null;
  const seconds = Math.floor(elapsedMs / 1_000);
  const waktu = seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
  const masuk = ringkasToken(tokens.input);
  const keluar = ringkasToken(tokens.output);
  // Token belum tentu ada pada detik pertama: panggilan model pertama baru
  // melapor sesudah selesai. Menampilkan "0" akan terbaca seperti klaim bahwa
  // tidak ada yang dikerjakan.
  if (masuk === null && keluar === null) return waktu;
  const bagian = [waktu];
  if (masuk !== null) bagian.push(`↑ ${masuk}`);
  if (keluar !== null) bagian.push(`↓ ${keluar}`);
  return bagian.join(" · ");
}

function ringkasToken(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

/** Hanya untuk membedakan surface status transient dari jawaban user-facing. */
export function isRenderedConversationProgress(text: string): boolean {
  // Judul saja sudah cukup: sejak catatan menjadi opsional dan titik-titik
  // dihapus, bentuknya bisa satu baris atau dua baris. Baris pertamanya kini
  // boleh membawa biaya di belakang judul, dipisah titik tengah.
  const [pertama] = text.trim().split("\n");
  const tanpaBulan = (pertama ?? "").replace(/^[🌑🌒🌓🌔🌕🌖🌗🌘]\s/u, "");
  const [judul] = tanpaBulan.split(" · ");
  // Titik-titik tetap diterima supaya teks status dari build sebelumnya tidak
  // terbaca sebagai balasan dan tertinggal di layar.
  return KNOWN_TITLES.has((judul ?? "").replace(/\.\.\.$/u, ""));
}

/**
 * Memvalidasi output model sebagai frasa semantic kecil. Field yang rusak
 * dibuang seluruhnya agar renderer jatuh ke fallback, bukan merangkai separuh
 * input tak tepercaya menjadi copy publik.
 */
export function parsePublicProgressFocus(
  value: unknown,
): SafePublicProgressFocus | null {
  if (!isRecord(value)) return null;
  const keys = ["kind", "subject", "contrast", "purpose"] as const;
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) return null;

  const kind = typeof value["kind"] === "string"
    ? PUBLIC_PROGRESS_FOCUS_KINDS.find((entry) => entry === value["kind"])
    : undefined;
  const subject = readFocusPart(value["subject"], false);
  const contrast = readFocusPart(value["contrast"], true);
  const purpose = readFocusPart(value["purpose"], true);
  if (!kind || !subject || contrast === undefined || purpose === undefined) {
    return null;
  }
  if (
    [subject, contrast, purpose]
      .filter((part): part is string => part !== null)
      .join(" ").length > MAX_PUBLIC_FOCUS_TOTAL_CHARACTERS
  ) return null;

  return Object.freeze({ kind, subject, contrast, purpose });
}

/**
 * Judul tahap giliran. `Record` penuh, bukan `Partial`: menambah tahap tanpa
 * judulnya menggagalkan type-check, bukan menghasilkan status kosong di layar.
 */
const TURN_STAGE_STATUS: Record<
  Exclude<TurnStagePhase, "listening" | "responding">,
  string
> = {
  waiting: "Menunggu Harvy",
  thinking: "Memikirkan",
  checking: "Memeriksa",
  adjusting: "Menyesuaikan",
  switching: "Beralih",
  composing: "Menyusun",
};

/**
 * Judul kerja alat, satu untuk tiap nilai `CapabilityWork`.
 *
 * Juga `Record` penuh: menambah jenis kerja di katalog capability langsung
 * membuat compiler menuntut judulnya di sini.
 */
const TOOL_WORK_STATUS: Record<ToolWorkPhase, string> = {
  reading: "Membaca",
  searching: "Mencari",
  comparing: "Membandingkan",
  writing: "Menulis",
  running: "Menjalankan",
  saving: "Menyimpan",
  sending: "Mengirim",
  working: "Mengerjakan",
};

const STATUS: Partial<Record<ConversationProgressPhase, string>> = {
  ...TURN_STAGE_STATUS,
  ...TOOL_WORK_STATUS,
};

/**
 * Diturunkan dari tabel judul, bukan ditulis ulang.
 *
 * Daftar yang dihafal terpisah akan melenceng: judul `composing` pernah berubah
 * dari "Menyusun jawaban" menjadi "Menyusun" sementara daftar di sini tidak
 * ikut, dan akibatnya status lama gagal dikenali lalu tertinggal di layar
 * pengguna sebagai balasan palsu.
 */
const KNOWN_TITLES: ReadonlySet<string> = new Set(Object.values(STATUS));

/**
 * Catatan di bawah judul menyebut **objeknya**, bukan mengulang kata kerjanya.
 *
 * Versi sebelumnya membuat kedua baris mengatakan hal yang sama: judul
 * "Memikirkan", catatan "Aku lihat dulu ini dari beberapa sisi". Satu informasi,
 * dua baris. Hampir semuanya juga diawali "Aku", sehingga satu giliran tiga fase
 * terbaca "Aku..., Aku..., Aku...".
 *
 * Catatan yang tidak menambah apa pun sengaja dihapus, bukan diganti kalimat
 * lain: fase tanpa objek yang berarti lebih baik tampil sebagai judul saja
 * daripada membawa kalimat yang muat untuk apa saja.
 *
 * Pengakuan pada `adjusting` dan `switching` tetap berbentuk kalimat penuh. Di
 * sana suaranya memang bagian dari isinya—Harvy sedang mengakui perubahan arah,
 * bukan melaporkan pekerjaan.
 */
const FALLBACK_NOTES: Partial<Record<
  ConversationProgressPhase,
  Partial<Record<ConversationProgressDetail, readonly string[]>>
>> = {
  thinking: {
    general: [
      "dari beberapa sisi dulu",
      "mulai dari yang paling berpengaruh",
      "biar jawabannya nggak asal cepat",
    ],
    "personal-fit": [
      "mana yang paling cocok buat keadaanmu",
      "yang kelihatan bagus dan yang benar-benar pas buatmu",
    ],
  },
  searching: {
    "latest-information": [
      "informasi terbarunya",
      "sumber terbaru yang paling relevan",
    ],
  },
  reading: {
    general: [
      "bagian yang paling relevan",
      "yang benar-benar kepakai",
    ],
    "new-message": [
      "pesan barumu yang baru masuk",
    ],
  },
  comparing: {
    "personal-fit": [
      "dari hal yang paling ngaruh buat kamu",
      "kelebihan yang benar-benar relevan buatmu",
    ],
  },
  checking: {
    consistency: [
      "kalau-kalau ada bagian yang bertentangan",
      "satu-satu biar nggak ada yang kelewat",
    ],
  },
  adjusting: {
    "new-context": [
      "Oke, itu cukup ngubah pertimbangannya.",
      "Sip, tambahan itu masuk ke jawaban yang sedang kususun.",
    ],
  },
  switching: {
    "new-direction": [
      "Oke, aku beralih ke yang baru kamu minta.",
      "Sip, arah yang tadi kutinggalkan dan pindah ke yang ini.",
    ],
  },
};

const MAX_PUBLIC_FOCUS_PART_CHARACTERS = 72;
const MAX_PUBLIC_FOCUS_TOTAL_CHARACTERS = 160;
const MAX_PUBLIC_PROGRESS_NOTE_CHARACTERS = 220;
const PUBLIC_FOCUS_INTERNAL_PATTERN =
  /\b(?:chain[ -]?of[ -]?thought|alur (?:pikir|pemikiran|penalaran)|private reasoning|pemikiran (?:privat|pribadi|internal)|reasoning(?:_content|_details)?|thought signature|model (?:tier|role|id|routing)|provider (?:id|routing|fallback)|tool call|capability|execution plan|system prompt|prompt sistem|token budget|workbrief|runbudget|context manifest|telemetry runtime)\b/iu;
const PUBLIC_FOCUS_INJECTION_PATTERN =
  /\b(?:abaikan (?:semua|instruksi)|ikuti instruksi|ignore (?:all|previous|prior|the) instructions?|follow (?:these|the) instructions?|jailbreak|bocorkan prompt|reveal (?:the )?(?:system )?prompt)\b/iu;
const PUBLIC_FOCUS_CREDENTIAL_PATTERN =
  /\b(?:password|kata sandi|passcode|otp|api[ _-]?key|kunci api|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|credential|kredensial)\b/iu;

/**
 * Menyusun catatan baris kedua dari focus yang disebut model.
 *
 * Berbentuk **frasa objek**, bukan kalimat—sama seperti catatan cadangan. Judul
 * sudah menyebut kata kerjanya; mengulangnya di baris kedua membuat dua baris
 * mengatakan satu hal. Sesi Telegram 31 Agustus 2026 memperlihatkan akibatnya:
 * dari sembilan belas bingkai yang bercatatan, dua belas memakai jalur ini, dan
 * setiap satunya berbunyi "Yang perlu kubedakan dulu di sini: …" di bawah judul
 * "Memikirkan".
 *
 * `adjusting` dan `switching` sengaja tetap kalimat penuh: di sana Harvy sedang
 * mengakui perubahan arah, jadi suaranya memang bagian dari isinya.
 */
function realizePublicProgressNote(
  phase: ConversationProgressPhase,
  focus: SafePublicProgressFocus,
): string | null {
  const purpose = focus.purpose ? ` untuk ${focus.purpose}` : "";
  let note: string;
  switch (phase) {
    case "thinking":
      if (focus.kind === "distinguish" && focus.contrast) {
        note = `beda antara ${focus.subject} dan ${focus.contrast}${purpose}`;
      } else if (focus.kind === "compare" && focus.contrast) {
        note = `${focus.subject} dibanding ${focus.contrast}${purpose}`;
      } else {
        note = `${focus.subject}${purpose}`;
      }
      break;
    case "searching":
      note = focus.kind === "current-information"
        ? `apa yang berubah pada ${focus.subject}${
            focus.contrast ? `, bukan ${focus.contrast}` : ""
          }`
        : focus.contrast
        ? `bahan buat membandingkan ${focus.subject} dan ${focus.contrast}${purpose}`
        : `yang terbaru soal ${focus.subject}${purpose}`;
      break;
    case "reading":
      note = focus.contrast
        ? `bagian tentang ${focus.subject} dan ${focus.contrast}${purpose}`
        : `bagian yang paling relevan soal ${focus.subject}${purpose}`;
      break;
    case "comparing":
      note = focus.contrast
        ? `${focus.subject} dan ${focus.contrast}${purpose}`
        : `${focus.subject}${purpose}`;
      break;
    // Lima kerja alat berikut judulnya sudah menyebut kerjanya dengan jelas
    // ("Menulis", "Menjalankan", …), jadi catatannya cukup objeknya.
    case "writing":
    case "running":
    case "saving":
    case "sending":
    case "working":
      note = `${focus.subject}${purpose}`;
      break;
    case "checking":
      note = focus.kind === "current-information"
        ? `apakah ${focus.subject} masih terbaru`
        : focus.contrast
        ? `perbandingan ${focus.subject} dan ${focus.contrast}${purpose}`
        : `${focus.subject}${purpose}`;
      break;
    case "adjusting": {
      const change = focus.purpose ?? focus.contrast;
      note = change
        ? `Oke, ${change} cukup mengubah ${focus.subject}.`
        : `Oke, aku sesuaikan ${focus.subject}.`;
      break;
    }
    case "switching":
      note = focus.contrast
        ? `Oke, aku tinggalkan ${focus.subject} dan beralih ke ${focus.contrast}.`
        : `Oke, aku beralih ke ${focus.subject}.`;
      break;
    case "composing":
      note = focus.contrast
        ? `perbandingan ${focus.subject} dan ${focus.contrast}${purpose}`
        : `jawaban soal ${focus.subject}${purpose}`;
      break;
    case "listening":
    case "responding":
    // Fase menunggu tidak punya catatan: pada detik itu belum ada pekerjaan
    // yang dapat diringkas, dan bulannya yang menjadi tandanya.
    case "waiting":
      return null;
  }
  return note.length <= MAX_PUBLIC_PROGRESS_NOTE_CHARACTERS ? note : null;
}

function readFocusPart(
  value: unknown,
  nullable: boolean,
): string | null | undefined {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || /[\r\n\u2028\u2029]/u.test(value)) {
    return undefined;
  }
  const clean = value
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (
    !clean ||
    clean.length > MAX_PUBLIC_FOCUS_PART_CHARACTERS ||
    /^(?:aku|saya|kami)\b/iu.test(clean) ||
    /[\u0000-\u001F\u007F]/u.test(clean) ||
    /https?:\/\/|www\.|[`*_#<>\[\]]/iu.test(clean) ||
    /\b[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\b/iu.test(clean) ||
    PUBLIC_FOCUS_INTERNAL_PATTERN.test(clean) ||
    PUBLIC_FOCUS_INJECTION_PATTERN.test(clean) ||
    PUBLIC_FOCUS_CREDENTIAL_PATTERN.test(clean) ||
    containsSecretLikeValue(clean)
  ) return undefined;
  return clean;
}

function progressEvent(
  phase: ConversationProgressPhase,
  detail: ConversationProgressDetail,
  publicFocus?: SafePublicProgressFocus | null,
): ConversationProgressEvent {
  return publicFocus ? { phase, detail, publicFocus } : { phase, detail };
}

function normalizeProgressEvent(
  event: ConversationProgressEvent,
): ConversationProgressEvent {
  const publicFocus = parsePublicProgressFocus(event.publicFocus);
  return Object.freeze({
    phase: event.phase,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(publicFocus ? { publicFocus } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Memilih catatan secara stabil per pengguna, lalu bergeser seiring denyut.
 *
 * Sebelumnya satu kalimat dipilih lalu dipakai sepanjang fase. Satu fase dapat
 * bertahan sebelas detik, dan kalimat yang sama terbaca belasan kali sementara
 * hanya bulannya yang bergerak. Pergeserannya sengaja jauh lebih lambat
 * daripada bulan—setiap beberapa denyut, bukan tiap denyut—karena teks yang
 * berganti secepat itu terasa gelisah, bukan hidup.
 */
function stableIndex(
  seed: string,
  phase: string,
  length: number,
  frame = 0,
): number {
  if (length <= 1) return 0;
  let hash = 2166136261;
  for (const character of `${seed}\u0000${phase}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) + Math.floor(frame / NOTE_ROTATION_FRAMES)) % length;
}

function sameEvent(
  left: ConversationProgressEvent | null,
  right: ConversationProgressEvent,
): boolean {
  return left?.phase === right.phase &&
    (left.detail ?? "general") === (right.detail ?? "general") &&
    samePublicFocus(left.publicFocus, right.publicFocus);
}

function samePublicFocus(
  left: SafePublicProgressFocus | undefined,
  right: SafePublicProgressFocus | undefined,
): boolean {
  return left?.kind === right?.kind &&
    left?.subject === right?.subject &&
    left?.contrast === right?.contrast &&
    left?.purpose === right?.purpose;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}
