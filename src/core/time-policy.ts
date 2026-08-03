import type { QuietHours } from "../domain/profile.js";

export const INDONESIAN_TIME_ZONES = [
  "Asia/Jakarta",
  "Asia/Makassar",
  "Asia/Jayapura",
] as const;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
