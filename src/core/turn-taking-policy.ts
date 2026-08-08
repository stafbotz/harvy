export type TurnBoundaryState =
  | "complete"
  | "open"
  | "incomplete"
  | "urgent";

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
  if (proposed === "urgent") return "urgent";

  const bubbles = splitBubbles(text);
  const last = bubbles.at(-1) ?? "";
  if (looksClosed(last)) return "complete";
  if (looksHardIncomplete(last)) return "incomplete";
  if (proposed === "incomplete") return proposed;

  if (looksOpen(bubbles, last)) return "open";
  return proposed;
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
  const bubbles = splitBubbles(text);
  if (bubbles.length !== 1) return null;
  const only = bubbles[0] ?? "";
  if (!only) return null;
  if (looksClearlyComplete(only)) return "complete";
  if (looksClearlyIncomplete(only)) return "incomplete";
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
  const multiBubbleMs = options.multiBubbleMs ?? MULTI_BUBBLE_IDLE_MS;

  switch (state) {
    case "urgent":
      return 0;
    case "incomplete":
      return incompleteMs;
    case "open":
      return openMs;
    case "complete":
      return bubbleCount > 1 ? multiBubbleMs : 0;
  }
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

function looksClearlyComplete(text: string): boolean {
  return /^(?:(?:iya+|ya+|yup+|yep+|oke+|ok(?:ay)?|sip+|siap|baik|betul|benar|nggak|gak|ga|tidak|belum)(?:\s+(?:deh|kok|ya|nih))?|(?:makasih|terima\s+kasih|thanks|thank\s+you)(?:\s+(?:ya|banyak))?|(?:nggak|gak|ga|tidak|udah|sudah|belum)\s+jadi(?:\s+(?:deh|kok))?|(?:(?:udah|sudah|yaudah)\s+)?(?:itu|segitu)\s+aja|cukup(?:\s+segitu)?|(?:halo+|hai+|hey+|hei+|pagi|siang|sore|malam)(?:\s+harvy)?|(?:opsi\s+)?(?:[a-e]|[1-9]))$/iu.test(
    text,
  );
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

function looksClosed(last: string): boolean {
  return (
    /(?:^|\s)(?:nggak|gak|ga|tidak|udah|sudah|belum)\s+jadi(?:\s+(?:deh|kok))?$/iu.test(
      last,
    ) ||
    /(?:^|\s)(?:(?:udah|sudah|yaudah)\s+)?(?:itu|segitu)\s+aja$/iu.test(
      last,
    ) ||
    /(?:^|\s)(?:cukup(?:\s+segitu)?|makasih(?:\s+ya)?)$/iu.test(last)
  );
}

function looksOpen(bubbles: string[], last: string): boolean {
  const first = bubbles[0] ?? "";
  if (
    /^(?:eh\s+)?tau\s+(?:ga|gak|nggak)|^eh\s+tau\s+(?:ga|gak|nggak)|^(?:aku|gue|gua|saya)\s+mau\s+(?:curhat|cerita)|^(?:(?:aku|gue|gua|saya)\s+)?boleh\s+(?:curhat|cerita)(?:\s+(?:kah|ga|gak|nggak))?$|^jadi\s+gini/iu.test(
      first,
    )
  ) {
    return true;
  }

  if (/^(?:sumpah+|serius(?:\s+deh)?)$/iu.test(last)) return true;
  if (/^ada\s+\S+$/iu.test(last)) return true;

  return /^(?:aku|gue|gua|saya)\s+.*\b(?:cape|capek+|takut+|sedih+|bingung+|cemas+|khawatir+)\b/iu.test(
    last,
  );
}
