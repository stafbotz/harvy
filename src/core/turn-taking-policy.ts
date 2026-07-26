export type TurnBoundaryState =
  | "complete"
  | "open"
  | "incomplete"
  | "urgent";

export const OPEN_IDLE_MS = 7_000;
export const INCOMPLETE_IDLE_MS = 12_000;
export const MULTI_BUBBLE_IDLE_MS = 4_000;

/**
 * Model tetap menjadi penilai utama, tetapi fragmen yang sangat jelas dan
 * risiko segera tidak boleh bergantung pada satu klasifikasi jaringan.
 */
export function guardTurnBoundary(
  text: string,
  proposed: TurnBoundaryState,
): TurnBoundaryState {
  if (proposed === "urgent" || looksUrgent(text)) return "urgent";

  const bubbles = splitBubbles(text);
  const last = bubbles.at(-1) ?? "";
  if (looksClosed(last)) return "complete";
  if (looksHardIncomplete(last)) return "incomplete";
  if (proposed === "incomplete") return proposed;

  if (looksOpen(bubbles, last)) return "open";
  return proposed;
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
    .toLocaleLowerCase("id-ID")
    .replace(/[!?.,:;…-]+$/u, "")
    .trim();
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

function looksUrgent(text: string): boolean {
  const normalized = normalize(text.replaceAll("\n", " "));
  return (
    /\b(?:mau|ingin|pengen|akan)\s+(?:bunuh diri|mati|nyakitin diri|menyakiti diri)\b/iu.test(
      normalized,
    ) ||
    /\b(?:aku|saya|gue|gua)\s+(?:dalam bahaya|nggak aman|gak aman)\s+sekarang\b/iu.test(
      normalized,
    ) ||
    /\b(?:darurat|tolong aku sekarang)\b/iu.test(normalized)
  );
}
