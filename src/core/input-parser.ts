import type { TaskImportance } from "../domain/task.js";

const DATE_TIME_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[ T](?<hour>\d{2}):(?<minute>\d{2})$/;

const IMPORTANCE_MAP: Record<string, TaskImportance> = {
  rendah: 1,
  sedang: 2,
  tinggi: 3,
  "1": 1,
  "2": 2,
  "3": 3,
};

export interface ParsedAddTask {
  title: string;
  dueAt: Date | null;
  importance: TaskImportance;
}

export function parseLocalDateTime(
  value: string,
  utcOffset: string,
): Date | null {
  const match = DATE_TIME_PATTERN.exec(value.trim());
  if (!match?.groups) return null;

  const date = new Date(
    `${match.groups.year}-${match.groups.month}-${match.groups.day}` +
      `T${match.groups.hour}:${match.groups.minute}:00${utcOffset}`,
  );

  if (Number.isNaN(date.getTime())) return null;

  const [year, month, day, hour, minute] = [
    match.groups.year,
    match.groups.month,
    match.groups.day,
    match.groups.hour,
    match.groups.minute,
  ].map(Number);

  const shifted = new Date(date.getTime() + offsetToMinutes(utcOffset) * 60_000);
  const valid =
    shifted.getUTCFullYear() === year &&
    shifted.getUTCMonth() + 1 === month &&
    shifted.getUTCDate() === day &&
    shifted.getUTCHours() === hour &&
    shifted.getUTCMinutes() === minute;

  return valid ? date : null;
}

export function parseAddTask(
  input: string,
  utcOffset: string,
): ParsedAddTask {
  const [rawTitle = "", rawDueAt, rawImportance] = input
    .split("|")
    .map((part) => part.trim());

  if (!rawTitle) {
    throw new Error("Tulis judul tugas setelah /tambah.");
  }

  let dueAt: Date | null = null;
  if (rawDueAt && rawDueAt.toLowerCase() !== "tanpa deadline") {
    dueAt = parseLocalDateTime(rawDueAt, utcOffset);
    if (!dueAt) {
      throw new Error("Format tenggat harus YYYY-MM-DD HH:mm.");
    }
  }

  let importance: TaskImportance = 2;
  if (rawImportance) {
    const parsed = IMPORTANCE_MAP[rawImportance.toLowerCase()];
    if (!parsed) {
      throw new Error("Prioritas harus rendah, sedang, atau tinggi.");
    }
    importance = parsed;
  }

  return { title: rawTitle, dueAt, importance };
}

export function parseReminder(
  input: string,
  utcOffset: string,
): { id: string; reminderAt: Date } {
  const [rawId = "", rawDate = ""] = input
    .split("|")
    .map((part) => part.trim());

  if (!rawId || !rawDate) {
    throw new Error(
      "Gunakan /ingatkan ID | YYYY-MM-DD HH:mm.",
    );
  }

  const reminderAt = parseLocalDateTime(rawDate, utcOffset);
  if (!reminderAt) {
    throw new Error("Format waktu pengingat harus YYYY-MM-DD HH:mm.");
  }

  return { id: rawId, reminderAt };
}

function offsetToMinutes(offset: string): number {
  const match = /^(?<sign>[+-])(?<hour>\d{2}):(?<minute>\d{2})$/.exec(offset);
  if (!match?.groups) {
    throw new Error("DEFAULT_UTC_OFFSET harus seperti +07:00.");
  }

  const minutes = Number(match.groups.hour) * 60 + Number(match.groups.minute);
  return match.groups.sign === "-" ? -minutes : minutes;
}
