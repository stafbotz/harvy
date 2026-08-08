const DIRECT_TIME_QUESTIONS = new Set([
  "jam berapa",
  "jam berapa sekarang",
  "sekarang jam berapa",
  "pukul berapa",
  "pukul berapa sekarang",
  "sekarang pukul berapa",
  "sekarang tanggal berapa",
  "tanggal berapa sekarang",
  "hari apa sekarang",
  "sekarang hari apa",
]);

const DIRECT_TIME_FAST_PATH_CONTEXT_MS = 30 * 60 * 1_000;

/** Hanya pertanyaan jam/tanggal yang berdiri sendiri; bukan classifier umum. */
export function isDirectTimeQuestion(message: string): boolean {
  const tokens = message
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[?!.,:;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // Sapaan kanonis boleh muncul tepat sekali di salah satu tepi. Closed set di
  // atas tetap menjadi classifier agar pertanyaan pertandingan/meeting tidak
  // ikut tersapu hanya karena memuat kata "jam".
  if (tokens[0] === "harvy") tokens.shift();
  else if (tokens.at(-1) === "harvy") tokens.pop();
  return DIRECT_TIME_QUESTIONS.has(tokens.join(" "));
}

/**
 * Melewati model hanya ketika tidak ada episode hangat yang perlu tetap
 * menjalani triase dan pemahaman konteks.
 */
export function canUseDirectTimeFastPath(
  message: string,
  turns: readonly { at: string }[],
  now = new Date(),
): boolean {
  if (!isDirectTimeQuestion(message)) return false;
  const latest = turns.at(-1);
  if (!latest) return true;
  const at = new Date(latest.at).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > DIRECT_TIME_FAST_PATH_CONTEXT_MS;
}

export function deterministicTimeReply(now: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("id-ID", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    hourCycle: "h23",
  }).format(now);
  return `Sekarang ${formatted}. Zona waktunya ${timeZone}.`;
}
