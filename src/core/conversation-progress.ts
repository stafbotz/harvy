import type { ExecutionPlan } from "./execution-policy.js";

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

export interface ConversationProgressEvent {
  phase: ConversationProgressPhase;
  /** Closed-set agar adapter tidak pernah meneruskan hidden reasoning. */
  detail?: ConversationProgressDetail;
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
    if (sameEvent(this.latest, event)) return;
    this.latest = Object.freeze({ ...event });
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
): ConversationProgressEvent {
  const effort = execution.effectiveEffort;
  if (effort !== null && effort !== "none") {
    return { phase: "thinking", detail: "general" };
  }
  return { phase: "composing", detail: "general" };
}

export function capabilityProgressEvent(
  capabilityId: string,
): ConversationProgressEvent {
  const normalized = capabilityId.toLocaleLowerCase("en-US");
  if (/(?:search|browse|web|lookup)/u.test(normalized)) {
    return { phase: "searching", detail: "latest-information" };
  }
  if (/(?:compare|parallel|delegate)/u.test(normalized)) {
    return { phase: "comparing", detail: "personal-fit" };
  }
  if (/(?:calculate|math|compute)/u.test(normalized)) {
    return { phase: "calculating", detail: "general" };
  }
  if (/(?:read|list|get|agenda|status)/u.test(normalized)) {
    return { phase: "reading", detail: "general" };
  }
  return { phase: "checking", detail: "consistency" };
}

export function renderConversationProgress(
  event: ConversationProgressEvent,
  seed = "harvy",
): string {
  const status = STATUS[event.phase];
  if (!status) return "";
  const notes = NOTES[event.phase]?.[event.detail ?? "general"] ??
    NOTES[event.phase]?.general ?? [];
  const note = notes[stableIndex(seed, event.phase, notes.length)] ??
    "Aku cek dulu bagian yang paling penting.";
  return `${status}...\n💭 ${note}`;
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

const NOTES: Partial<Record<
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
    (left.detail ?? "general") === (right.detail ?? "general");
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}
