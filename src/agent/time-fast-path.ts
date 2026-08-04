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

/** Hanya pertanyaan jam/tanggal yang berdiri sendiri; bukan classifier umum. */
export function isDirectTimeQuestion(message: string): boolean {
  const normalized = message
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[?!.,]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return DIRECT_TIME_QUESTIONS.has(normalized);
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
