import type { QuietHours } from "../domain/profile.js";

export const INDONESIAN_TIME_ZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
] as const;

const TIME_ZONE_ALIASES = Object.freeze({
  wib: INDONESIAN_TIME_ZONES[0],
  "asia/jakarta": INDONESIAN_TIME_ZONES[0],
  wita: INDONESIAN_TIME_ZONES[1],
  "asia/makassar": INDONESIAN_TIME_ZONES[1],
  wit: INDONESIAN_TIME_ZONES[2],
  "asia/jayapura": INDONESIAN_TIME_ZONES[2],
} satisfies Readonly<Record<string, string>>);

const DIRECT_TIME_ZONE_CHANGE = /^(?:(?:harvy[\s,]+)?(?:tolong\s+)?|(?:aku|saya|gue|gua|i)\s+(?:mau|ingin|pengen|want\s+to)\s+)(?:ubah(?:kan)?|ganti(?:kan)?|atur(?:kan)?|set|pakai|gunakan|pindah(?:kan)?|switch|change)\b/iu;
const TIME_ZONE_CONTEXT = /\b(?:zona\s+waktu(?:ku|mu)?|time\s*zone|timezone(?:ku|mu)?|waktu(?:ku|mu)?)\b/iu;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Membaca satu zona waktu Indonesia dari teks tanpa memberi izin mutasi.
 * Beberapa zona yang saling bertentangan sengaja gagal tertutup.
 */
export function parseIndonesianTimeZone(text: string): string | null {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("id-ID");
  const matches = new Set<string>();
  for (const [alias, zone] of Object.entries(TIME_ZONE_ALIASES)) {
    const escaped = alias.replaceAll("/", "\\/");
    const pattern = alias.includes("/")
      ? new RegExp(`(?:^|\\s)${escaped}(?=\\s|$|[.,!?])`, "u")
      : new RegExp(`\\b${escaped}\\b`, "u");
    if (pattern.test(normalized)) matches.add(zone);
  }
  return matches.size === 1 ? [...matches][0] ?? null : null;
}

/**
 * Fallback authority berpresisi tinggi untuk kegagalan compiler semantic.
 * Ia hanya menerima permintaan langsung yang diawali verba perubahan, bukan
 * pertanyaan tentang cara mengubah zona atau penyebutan zona semata.
 */
export function explicitIndonesianTimeZoneChange(
  text: string,
): string | null {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .trim()
    .replaceAll(/\s+/gu, " ");
  const zone = parseIndonesianTimeZone(normalized);
  return zone && DIRECT_TIME_ZONE_CHANGE.test(normalized) &&
      TIME_ZONE_CONTEXT.test(normalized)
    ? zone
    : null;
}

/** Menilai jam tenang memakai jam dinding pengguna, bukan zona proses. */
export function isInQuietHours(
  moment: Date,
  timeZone: string,
  quietHours: QuietHours | null,
): boolean {
  if (!quietHours) return false;

  const minute = localMinuteOfDay(moment, timeZone);
  const { startMinute, endMinute } = quietHours;

  if (startMinute < endMinute) {
    return minute >= startMinute && minute < endMinute;
  }

  // Rentang yang melewati tengah malam, misalnya 21.00–06.00.
  return minute >= startMinute || minute < endMinute;
}

export function isValidQuietHours(value: QuietHours): boolean {
  return (
    Number.isInteger(value.startMinute) &&
    Number.isInteger(value.endMinute) &&
    value.startMinute >= 0 &&
    value.startMinute < 24 * 60 &&
    value.endMinute >= 0 &&
    value.endMinute < 24 * 60 &&
    value.startMinute !== value.endMinute
  );
}

export function localMinuteOfDay(moment: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(moment);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? "0",
  );
  return hour * 60 + minute;
}

export function formatClockMinute(minute: number): string {
  const hour = Math.floor(minute / 60)
    .toString()
    .padStart(2, "0");
  const rest = (minute % 60).toString().padStart(2, "0");
  return `${hour}.${rest}`;
}

/** Membaca rentang seperti `21.30-06.00` tanpa memanggil model. */
export function parseQuietHours(text: string): QuietHours | null {
  const match =
    /(?:^|\s)(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})(?:\s|$)/u.exec(
      text.trim(),
    );
  if (!match) return null;

  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return null;
  }

  const quietHours = {
    startMinute: startHour * 60 + startMinute,
    endMinute: endHour * 60 + endMinute,
  };
  return isValidQuietHours(quietHours) ? quietHours : null;
}

/** Authority lokal sempit untuk perubahan jam tenang reversible. */
export function explicitQuietHoursChange(text: string): QuietHours | null {
  const quietHours = parseQuietHours(text);
  if (!quietHours) return null;
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .trim()
    .replaceAll(/\s+/gu, " ");
  return /^(?:(?:harvy[\s,]+)?(?:tolong\s+)?|(?:aku|saya|gue|gua|i)\s+(?:mau|ingin|pengen|want\s+to)\s+)(?:ubah(?:kan)?|ganti(?:kan)?|atur(?:kan)?|set|pakai|gunakan|change)\b/iu.test(
      normalized,
    ) && /\b(?:jam\s+tenang(?:ku|mu)?|quiet\s+hours?)\b/iu.test(normalized)
    ? quietHours
    : null;
}
