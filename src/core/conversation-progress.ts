import type { ExecutionPlan } from "./execution-policy.js";
import type { TurnInterruptionRelation } from "./turn-taking-policy.js";
import { containsSecretLikeValue } from "../security/credential-like.js";

export type ConversationProgressPhase =
  | "listening"
  | "thinking"
  | "searching"
  | "reading"
  | "comparing"
  | "calculating"
  | "checking"
  | "adjusting"
  | "switching"
  | "composing"
  | "responding";

export type ConversationProgressDetail =
  | "general"
  | "latest-information"
  | "personal-fit"
  | "consistency"
  | "new-context"
  | "new-direction";

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
  seed?: string;
  onError?: (operation: "show" | "update" | "remove" | "typing", error: unknown) => void;
}

const DEFAULT_GRACE_MS = 700;
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
  private operation = Promise.resolve();
  private lastRenderedAt = 0;
  private closed = false;
  private readonly graceMs: number;
  private readonly minimumUpdateIntervalMs: number;
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
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.enqueue(() => this.showLatest());
      }, this.graceMs);
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
        renderConversationProgress(this.latest, this.seed),
      );
      this.lastRenderedAt = this.now();
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
        renderConversationProgress(this.latest, this.seed),
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

export function capabilityProgressEvent(
  capabilityId: string,
  publicFocus?: SafePublicProgressFocus | null,
): ConversationProgressEvent {
  const normalized = capabilityId.toLocaleLowerCase("en-US");
  if (/(?:search|browse|web|lookup)/u.test(normalized)) {
    return progressEvent(
      "searching",
      "latest-information",
      publicFocus,
    );
  }
  if (/(?:compare|parallel|delegate)/u.test(normalized)) {
    return progressEvent("comparing", "personal-fit", publicFocus);
  }
  if (/(?:calculate|math|compute)/u.test(normalized)) {
    return progressEvent("calculating", "general", publicFocus);
  }
  if (/(?:read|list|get|agenda|status)/u.test(normalized)) {
    return progressEvent("reading", "general", publicFocus);
  }
  return progressEvent("checking", "consistency", publicFocus);
}

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
  const normalized = parsePublicProgressFocus(publicFocus);
  if (!normalized) return null;
  return interruptionProgressEvent(relation, normalized) ??
    progressEvent("checking", "consistency", normalized);
}

export function renderConversationProgress(
  event: ConversationProgressEvent,
  seed = "harvy",
): string {
  const status = STATUS[event.phase];
  if (!status) return "";
  const publicFocus = parsePublicProgressFocus(event.publicFocus);
  const focusedNote = publicFocus
    ? realizePublicProgressNote(event.phase, publicFocus)
    : null;
  const notes = FALLBACK_NOTES[event.phase]?.[event.detail ?? "general"] ??
    FALLBACK_NOTES[event.phase]?.general ?? [];
  const note = focusedNote ?? notes[stableIndex(seed, event.phase, notes.length)] ??
    "Aku cek dulu bagian yang paling penting.";
  return `${status}...\n💭 ${note}`;
}

/** Hanya untuk membedakan surface status transient dari jawaban user-facing. */
export function isRenderedConversationProgress(text: string): boolean {
  return /^(?:Memikirkan|Mencari|Membaca|Membandingkan|Menghitung|Memeriksa|Menyesuaikan|Beralih|Menyusun jawaban)\.\.\.\n💭\s/u.test(
    text.trim(),
  );
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

const STATUS: Partial<Record<ConversationProgressPhase, string>> = {
  thinking: "Memikirkan",
  searching: "Mencari",
  reading: "Membaca",
  comparing: "Membandingkan",
  calculating: "Menghitung",
  checking: "Memeriksa",
  adjusting: "Menyesuaikan",
  switching: "Beralih",
  composing: "Menyusun jawaban",
};

const FALLBACK_NOTES: Partial<Record<
  ConversationProgressPhase,
  Partial<Record<ConversationProgressDetail, readonly string[]>>
>> = {
  thinking: {
    general: [
      "Aku lihat dulu ini dari beberapa sisi.",
      "Aku urutin dulu hal yang paling berpengaruh.",
      "Aku pertimbangkan dulu biar jawabannya nggak asal cepat.",
    ],
    "personal-fit": [
      "Aku lihat dulu mana yang paling cocok buat keadaanmu.",
      "Aku bedakan dulu hal yang kelihatan bagus dan yang benar-benar pas buatmu.",
    ],
  },
  searching: {
    general: ["Aku cari sumber yang paling relevan dulu."],
    "latest-information": [
      "Aku cari informasi terbarunya dulu.",
      "Aku cek sumber terbaru yang paling relevan.",
    ],
  },
  reading: {
    general: [
      "Aku baca bagian yang paling relevan dulu.",
      "Aku rangkum dulu informasi yang benar-benar kepakai.",
    ],
  },
  comparing: {
    general: ["Aku lihat dulu perbedaannya yang paling berarti."],
    "personal-fit": [
      "Aku bandingkan dari hal yang paling ngaruh buat kamu.",
      "Aku pisahkan dulu kelebihan yang benar-benar relevan buatmu.",
    ],
  },
  calculating: {
    general: ["Aku hitung dan cek lagi angkanya dulu."],
  },
  checking: {
    general: ["Aku cek dulu bagian yang paling penting."],
    consistency: [
      "Aku pastikan dulu nggak ada bagian penting yang bertentangan.",
      "Aku cek satu-satu biar nggak ada yang kelewat.",
    ],
  },
  adjusting: {
    general: ["Oke, aku sesuaikan dengan tambahan barumu."],
    "new-context": [
      "Oke, itu cukup ngubah pertimbangannya.",
      "Sip, tambahan itu aku masukin ke jawaban yang sedang kususun.",
    ],
  },
  switching: {
    general: ["Oke, yang tadi aku tinggal dan aku ikuti arah barumu."],
    "new-direction": [
      "Oke, aku beralih ke yang baru kamu minta.",
      "Sip, aku tinggalkan arah yang tadi dan pindah ke yang ini.",
    ],
  },
  composing: {
    general: [
      "Aku susun biar jawabannya tetap enak diikuti.",
      "Aku rapikan dulu jawabannya supaya nggak muter-muter.",
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

function realizePublicProgressNote(
  phase: ConversationProgressPhase,
  focus: SafePublicProgressFocus,
): string | null {
  const purpose = focus.purpose ? ` untuk ${focus.purpose}` : "";
  let note: string;
  switch (phase) {
    case "thinking":
      if (focus.kind === "distinguish" && focus.contrast) {
        note = `Yang perlu kubedakan dulu di sini: ${focus.subject} dan ${focus.contrast}${purpose}.`;
      } else if (focus.kind === "compare" && focus.contrast) {
        note = `Aku timbang dulu ${focus.subject} dan ${focus.contrast}${purpose}.`;
      } else {
        note = `Aku pahami dulu ${focus.subject}${purpose}.`;
      }
      break;
    case "searching":
      note = focus.kind === "current-information"
        ? `Aku cari dulu apa yang berubah pada ${focus.subject}${
            focus.contrast
              ? ` supaya nggak tercampur dengan ${focus.contrast}`
              : ""
          }.`
        : focus.contrast
        ? `Aku cari informasi yang relevan untuk membandingkan ${focus.subject} dan ${focus.contrast}${purpose}.`
        : `Aku cari informasi terbaru tentang ${focus.subject}${purpose}.`;
      break;
    case "reading":
      note = focus.contrast
        ? `Aku baca bagian paling relevan tentang ${focus.subject} dan ${focus.contrast}${purpose}.`
        : `Aku baca bagian tentang ${focus.subject} yang paling relevan${purpose}.`;
      break;
    case "comparing":
      note = focus.contrast
        ? `Aku bandingkan dulu ${focus.subject} dan ${focus.contrast}${purpose}.`
        : `Aku bandingkan dulu ${focus.subject}${purpose}.`;
      break;
    case "calculating":
      note = `Aku hitung dulu ${focus.subject}${purpose}.`;
      break;
    case "checking":
      note = focus.kind === "current-information"
        ? `Aku cek dulu apakah informasi tentang ${focus.subject} masih terbaru.`
        : focus.contrast
        ? `Aku periksa dulu perbandingan ${focus.subject} dan ${focus.contrast}${purpose}.`
        : `Aku periksa dulu ${focus.subject}${purpose}.`;
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
        ? `Aku susun dulu perbandingan ${focus.subject} dan ${focus.contrast}${purpose}.`
        : `Aku susun jawaban tentang ${focus.subject}${purpose} supaya tetap enak diikuti.`;
      break;
    case "listening":
    case "responding":
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

function stableIndex(seed: string, phase: string, length: number): number {
  if (length <= 1) return 0;
  let hash = 2166136261;
  for (const character of `${seed}\u0000${phase}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
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
