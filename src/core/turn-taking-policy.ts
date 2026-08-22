export type TurnBoundaryState =
  | "complete"
  | "open"
  | "incomplete"
  | "urgent";

export type TurnBoundaryReasonClass =
  | "closed-request"
  | "closed-response"
  | "narrative-opening"
  | "narrative-continuation"
  | "syntactic-fragment"
  | "correction"
  | "redirect"
  | "urgent-danger"
  | "uncertain";

export interface TurnBoundaryAssessment {
  state: TurnBoundaryState;
  /** Confidence pada state, bukan confidence tentang isi percakapan. */
  confidence: number;
  /** Peluang ada bubble lanjutan dalam logical turn yang sama. */
  continuationLikelihood: number;
  /** Closed-set dan content-free; bukan chain-of-thought. */
  reasonClass: TurnBoundaryReasonClass;
}

export type TurnBoundaryProposal = TurnBoundaryState | TurnBoundaryAssessment;

export interface TurnBoundarySignals {
  bubbleCount: number;
  adaptiveTimingUsed: boolean;
  learnedSettleMs: number;
  rapidBurst: boolean;
}

export type TurnInterruptionRelation =
  | "addition"
  | "correction"
  | "redirect"
  | "independent";

export type LocalTurnBoundaryState = Extract<
  TurnBoundaryState,
  "complete" | "incomplete"
>;

export const OPEN_IDLE_MS = 7_000;
export const INCOMPLETE_IDLE_MS = 12_000;
export const MULTI_BUBBLE_IDLE_MS = 4_000;

/**
 * Proposal model tetap tidak dipercaya begitu saja. Pagar ini mempertahankan
 * bentuk kalimat yang jelas ketika fallback model terlalu cepat menutup atau
 * menunggu. Sinyal darurat lokal ditangani terpisah sebelum pagar bentuk ini.
 */
export function guardTurnBoundary(
  text: string,
  proposed: TurnBoundaryState,
): TurnBoundaryState {
  return guardTurnBoundaryAssessment(
    text,
    normalizeTurnBoundaryAssessment(proposed),
  ).state;
}

/**
 * Pagar lokal hanya mempertahankan bentuk yang benar-benar deterministik.
 * Bahasa natural ambigu tidak ditimpa regex; assessment semantik tetap
 * authority utamanya.
 */
export function guardTurnBoundaryAssessment(
  text: string,
  proposed: TurnBoundaryAssessment,
): TurnBoundaryAssessment {
  if (proposed.state === "urgent") return proposed;

  const local = assessTurnBoundaryLocally(text);
  if (local) return local;

  const last = splitBubbles(text).at(-1) ?? "";
  if (looksHardIncomplete(last)) {
    return Object.freeze({
      state: "incomplete",
      confidence: 0.98,
      continuationLikelihood: 0.99,
      reasonClass: "syntactic-fragment",
    });
  }
  return normalizeTurnBoundaryAssessment(proposed);
}

/**
 * Menentukan boundary tanpa model hanya ketika bentuknya benar-benar jelas.
 *
 * Multi-bubble dan isi emosional yang tidak eksplisit sengaja dikembalikan
 * sebagai `null`: callback classifier tetap menjadi fallback untuk ambiguitas.
 */
export function classifyTurnBoundaryLocally(
  text: string,
): LocalTurnBoundaryState | null {
  return assessTurnBoundaryLocally(text)?.state ?? null;
}

export function assessTurnBoundaryLocally(
  text: string,
): (TurnBoundaryAssessment & { state: LocalTurnBoundaryState }) | null {
  const rawBubbles = text
    .split("\n")
    .map((bubble) => bubble.trim())
    .filter(Boolean);
  if (rawBubbles.length !== 1) return null;
  const raw = rawBubbles[0] ?? "";
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (looksClearlyComplete(raw, normalized)) {
    return Object.freeze({
      state: "complete",
      confidence: 0.99,
      continuationLikelihood: 0.02,
      reasonClass: "closed-request",
    });
  }
  if (looksClearlyIncomplete(normalized)) {
    return Object.freeze({
      state: "incomplete",
      confidence: 0.99,
      continuationLikelihood: 0.99,
      reasonClass: "syntactic-fragment",
    });
  }
  return null;
}

export function idleWindowMs(
  state: TurnBoundaryState,
  bubbleCount: number,
  options: {
    openMs?: number;
    incompleteMs?: number;
    multiBubbleMs?: number;
  } = {},
): number {
  const openMs = options.openMs ?? OPEN_IDLE_MS;
  const incompleteMs = options.incompleteMs ?? INCOMPLETE_IDLE_MS;

  switch (state) {
    case "urgent":
      return 0;
    case "incomplete":
      return incompleteMs;
    case "open":
      return openMs;
    case "complete":
      return 0;
  }
}

export function assessmentIdleWindowMs(
  assessment: TurnBoundaryAssessment,
  bubbleCount: number,
  options: {
    openMs?: number;
    incompleteMs?: number;
    multiBubbleMs?: number;
  } = {},
): number {
  const normalized = normalizeTurnBoundaryAssessment(assessment);
  if (
    normalized.state === "complete" &&
    bubbleCount > 1 &&
    normalized.confidence < 0.72 &&
    normalized.continuationLikelihood >= 0.45
  ) {
    return options.multiBubbleMs ?? MULTI_BUBBLE_IDLE_MS;
  }
  return idleWindowMs(normalized.state, bubbleCount, options);
}

export function normalizeTurnBoundaryAssessment(
  proposal: TurnBoundaryProposal,
): TurnBoundaryAssessment {
  if (typeof proposal === "string") {
    const defaults: Record<TurnBoundaryState, TurnBoundaryAssessment> = {
      complete: {
        state: "complete",
        confidence: 0.75,
        continuationLikelihood: 0.2,
        reasonClass: "uncertain",
      },
      open: {
        state: "open",
        confidence: 0.75,
        continuationLikelihood: 0.75,
        reasonClass: "narrative-opening",
      },
      incomplete: {
        state: "incomplete",
        confidence: 0.9,
        continuationLikelihood: 0.95,
        reasonClass: "syntactic-fragment",
      },
      urgent: {
        state: "urgent",
        confidence: 1,
        continuationLikelihood: 0,
        reasonClass: "urgent-danger",
      },
    };
    return Object.freeze({ ...defaults[proposal] });
  }
  return Object.freeze({
    state: proposal.state,
    confidence: probability(proposal.confidence),
    continuationLikelihood: probability(proposal.continuationLikelihood),
    reasonClass: proposal.reasonClass,
  });
}

export function boundaryConfidenceBucket(
  confidence: number,
): "low" | "medium" | "high" {
  const normalized = probability(confidence);
  return normalized >= 0.8 ? "high" : normalized >= 0.5 ? "medium" : "low";
}

function splitBubbles(text: string): string[] {
  return text
    .split("\n")
    .map((bubble) => normalize(bubble))
    .filter(Boolean);
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[!?.,:;…-]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function looksClearlyComplete(raw: string, text: string): boolean {
  if (/^\/[a-z][a-z0-9_-]*(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(raw)) {
    return true;
  }
  if (
    /^\s*\d+(?:[.,]\d+)?\s*[+\-*/x×÷]\s*\d+(?:[.,]\d+)?(?:\s*(?:berapa|hasilnya))?\s*[?？]?\s*$/iu.test(
      raw,
    )
  ) {
    return true;
  }
  if (looksTrivialStandaloneQuestion(raw, text)) return true;
  return /^(?:(?:iya+|ya+|oke+|ok(?:ay)?|sip+|siap|baik)(?:\s+(?:deh|ya|nih))?|(?:makasih|terima\s+kasih|thanks)(?:\s+(?:ya|banyak))?|(?:nggak|gak|ga|tidak|udah|sudah|belum)\s+jadi(?:\s+deh)?|(?:(?:udah|sudah|yaudah)\s+)?(?:itu|segitu)\s+aja|cukup(?:\s+segitu)?|(?:halo+|hai+|hey+|hei+|pagi|siang|sore|malam)(?:\s+harvy)?|(?:opsi\s+)?(?:[a-e]|[1-9]))$/iu.test(text);
}

function looksTrivialStandaloneQuestion(raw: string, text: string): boolean {
  if (
    !/[?？]\s*$/u.test(raw) ||
    raw.includes("\n") ||
    Array.from(raw).length > 180 ||
    looksHardIncomplete(text)
  ) {
    return false;
  }
  const words = text.split(" ").filter(Boolean);
  if (/^(?:siapa|kapan|berapa|di mana|dimana)\b/u.test(text)) {
    return words.length >= 2;
  }
  if (/^(?:apa|apakah)\b/u.test(text)) return words.length >= 3;
  return words.length >= 4 &&
    /\b(?:apa|siapa|kapan|berapa|di mana|dimana)$/u.test(text);
}

function looksClearlyIncomplete(text: string): boolean {
  return /^(?:karena|karna|soalnya|sebab|tapi|dan|atau|terus|lalu|kalau|kalo|yang|jadi|terus\s+(?:aku|saya|gue|gua)|jadi\s+tadi\s+(?:aku|saya|gue|gua)\s+mau|(?:aku|saya|gue|gua)\s+(?:hari\s+ini|tadi|besok))$/iu.test(
    text,
  );
}

function looksHardIncomplete(last: string): boolean {
  if (
    /\b(?:karena|karna|soalnya|sebab|tapi|dan|atau|terus|lalu|kalau|kalo|yang|jadi)$/iu.test(
      last,
    )
  ) {
    return true;
  }

  return /^(?:aku|gue|gua|saya)\s+(?:hari ini|tadi|besok)$/iu.test(last);
}

function probability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
