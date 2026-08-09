export interface AdaptiveDebounceOptions {
  /** Jumlah gap valid minimum sebelum timing personal menggantikan fallback. */
  minSamples?: number;
  /** Sampel terbaru yang dipakai untuk p90; state sengaja kecil dan in-memory. */
  maxSamples?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Gap lebih panjang dianggap giliran terpisah, bukan rangkaian bubble. */
  maxGapMs?: number;
  retentionMs?: number;
  maxSubjects?: number;
}

export interface AdaptiveDebounceEstimate {
  adaptive: boolean;
  sampleCount: number;
  p90GapMs: number | null;
  settleMs: number;
}

interface SubjectTiming {
  gaps: number[];
  /** Terakhir ada arrival/gap baru; estimate tidak memperpanjang TTL. */
  observedAt: number;
  lastArrivalAt: number | null;
}

const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_MAX_SAMPLES = 32;
const DEFAULT_MIN_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 2_500;
const DEFAULT_MAX_GAP_MS = 5_000;
const DEFAULT_RETENTION_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_MAX_SUBJECTS = 5_000;

/**
 * Kebijakan debounce adaptif yang hanya menyimpan gap waktu content-free.
 *
 * State tidak dipersistenkan dan tidak memuat teks, label risiko, atau profil.
 * P90 memakai sampel terbaru agar ritme lama tidak mengunci pengguna selamanya.
 */
export class AdaptiveDebouncePolicy {
  private readonly subjects = new Map<string, SubjectTiming>();
  private readonly minSamples: number;
  private readonly maxSamples: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxGapMs: number;
  private readonly retentionMs: number;
  private readonly maxSubjects: number;

  constructor(
    options: AdaptiveDebounceOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.minSamples = positiveInteger(
      options.minSamples,
      DEFAULT_MIN_SAMPLES,
    );
    this.maxSamples = Math.max(
      this.minSamples,
      positiveInteger(options.maxSamples, DEFAULT_MAX_SAMPLES),
    );
    this.minDelayMs = nonNegativeInteger(
      options.minDelayMs,
      DEFAULT_MIN_DELAY_MS,
    );
    this.maxDelayMs = Math.max(
      this.minDelayMs,
      nonNegativeInteger(options.maxDelayMs, DEFAULT_MAX_DELAY_MS),
    );
    this.maxGapMs = positiveInteger(options.maxGapMs, DEFAULT_MAX_GAP_MS);
    this.retentionMs = positiveInteger(
      options.retentionMs,
      DEFAULT_RETENTION_MS,
    );
    this.maxSubjects = positiveInteger(
      options.maxSubjects,
      DEFAULT_MAX_SUBJECTS,
    );
  }

  observe(subject: string, gapMs: number): void {
    if (
      !subject ||
      !Number.isFinite(gapMs) ||
      gapMs <= 0 ||
      gapMs > this.maxGapMs
    ) {
      return;
    }

    const observedAt = this.now();
    this.pruneExpired(observedAt);
    const existing = this.subjects.get(subject);
    if (!existing) this.makeRoom();
    const gaps = existing?.gaps ?? [];
    gaps.push(Math.round(gapMs));
    if (gaps.length > this.maxSamples) {
      gaps.splice(0, gaps.length - this.maxSamples);
    }
    this.touch(subject, {
      gaps,
      observedAt,
      lastArrivalAt: existing?.lastArrivalAt ?? null,
    });
  }

  /**
   * Mencatat arrival lintas batas batch. Tanpa ini, gap slow typist yang lebih
   * panjang daripada fallback settle tidak pernah dapat dipelajari.
   */
  observeArrival(
    subject: string,
    arrivedAt = this.now(),
    continuous = true,
  ): void {
    if (!subject || !Number.isFinite(arrivedAt)) return;
    const roundedAt = Math.round(arrivedAt);
    this.pruneExpired(roundedAt);
    const existing = this.subjects.get(subject);
    if (!existing) this.makeRoom();
    const gaps = existing?.gaps ?? [];
    const gap = existing?.lastArrivalAt === null ||
        existing?.lastArrivalAt === undefined
      ? null
      : roundedAt - existing.lastArrivalAt;
    if (continuous && gap !== null && gap > 0 && gap <= this.maxGapMs) {
      gaps.push(gap);
      if (gaps.length > this.maxSamples) {
        gaps.splice(0, gaps.length - this.maxSamples);
      }
    }
    this.touch(subject, {
      gaps,
      observedAt: roundedAt,
      lastArrivalAt: roundedAt,
    });
  }

  estimate(subject: string, fallbackMs: number): AdaptiveDebounceEstimate {
    const safeFallback = Number.isFinite(fallbackMs)
      ? Math.max(0, Math.round(fallbackMs))
      : 0;
    const observedAt = this.now();
    this.pruneExpired(observedAt);
    const timing = this.subjects.get(subject);
    if (!timing || timing.gaps.length < this.minSamples) {
      return {
        adaptive: false,
        sampleCount: timing?.gaps.length ?? 0,
        p90GapMs: null,
        settleMs: safeFallback,
      };
    }

    // Akses memengaruhi eviction LRU, tetapi bukan TTL observasi.
    this.touch(subject, timing);
    const p90GapMs = percentile90(timing.gaps);
    // Ruang 20% dibatasi 200–300 ms: 800 ms → 1,0 s dan 1,6 s → 1,9 s.
    const cushion = clamp(Math.round(p90GapMs * 0.2), 200, 300);
    return {
      adaptive: true,
      sampleCount: timing.gaps.length,
      p90GapMs,
      settleMs: clamp(
        p90GapMs + cushion,
        this.minDelayMs,
        this.maxDelayMs,
      ),
    };
  }

  forget(subject: string): void {
    this.subjects.delete(subject);
  }

  forgetPrefix(prefix: string): void {
    for (const subject of this.subjects.keys()) {
      if (subject.startsWith(prefix)) this.subjects.delete(subject);
    }
  }

  clear(): void {
    this.subjects.clear();
  }

  private pruneExpired(at: number): void {
    for (const [subject, timing] of this.subjects) {
      // Scan bounded ini tetap benar bila clock host mundur lalu maju lagi;
      // jangan mengandalkan insertion order sebagai urutan waktu mutlak.
      if (at - timing.observedAt <= this.retentionMs) continue;
      this.subjects.delete(subject);
    }
  }

  private makeRoom(): void {
    while (this.subjects.size >= this.maxSubjects) {
      const oldest = this.subjects.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.subjects.delete(oldest);
    }
  }

  private touch(subject: string, timing: SubjectTiming): void {
    this.subjects.delete(subject);
    this.subjects.set(subject, timing);
  }
}

function percentile90(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
  return sorted[index] ?? 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}
