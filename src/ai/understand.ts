import type { TaskImportance } from "../domain/task.js";
import type { ConversationIntent } from "./model-policy.js";

/**
 * Membaca balasan model menjadi data yang dapat dipercaya.
 *
 * Model bisa mengembalikan JSON yang terbungkus pagar kode, disertai kalimat
 * pengantar, atau berisi nilai di luar dugaan. Modul ini memperlakukan seluruh
 * balasan sebagai masukan yang tidak tepercaya dan memaksanya masuk ke bentuk
 * yang sudah ditetapkan. Bila gagal, ia mengembalikan `null` supaya Harvy dapat
 * mengaku tidak paham alih-alih menebak.
 */
export interface ExtractedTask {
  title: string;
  dueAt: Date | null;
  /** Hanya terisi bila pengguna memang minta diingatkan pada waktu tertentu. */
  remindAt: Date | null;
  importance: TaskImportance;
}

export interface Understanding {
  intent: ConversationIntent;
  safetySensitive: boolean;
  needsStepByStep: boolean;
  task: ExtractedTask | null;
}

const INTENTS: readonly ConversationIntent[] = [
  "task",
  "feeling",
  "question",
  "smalltalk",
];

export function parseUnderstanding(raw: string): Understanding | null {
  const payload = extractJson(raw);
  if (!payload) return null;

  const task = readTask(payload["task"]);
  const intent = readIntent(payload["intent"], task);
  if (!intent) return null;

  return {
    intent,
    safetySensitive: payload["safetySensitive"] === true,
    needsStepByStep: payload["needsStepByStep"] === true,
    task,
  };
}

/**
 * Model kecil kadang mengarang label di luar empat yang diminta, misalnya
 * "reminder" untuk permintaan pengingat.
 *
 * Membuang seluruh pesan karena satu label yang salah terlalu mahal bagi
 * pengguna: ia harus mengetik ulang sesuatu yang sebenarnya sudah dipahami.
 * Ketika data tugasnya sah, maksudnya sudah cukup jelas untuk diperlakukan
 * sebagai pencatatan pekerjaan. Tanpa data itu, menebak tetap lebih buruk
 * daripada mengaku tidak paham.
 */
function readIntent(
  value: unknown,
  task: ExtractedTask | null,
): ConversationIntent | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  const known = INTENTS.find((candidate) => candidate === label);
  if (known) return known;

  return task ? "task" : null;
}

function readTask(value: unknown): ExtractedTask | null {
  if (!isRecord(value)) return null;

  const title = typeof value["title"] === "string" ? value["title"].trim() : "";
  if (!title) return null;

  return {
    title,
    dueAt: readDate(value["dueAt"]),
    remindAt: readDate(value["remindAt"]),
    importance: readImportance(value["importance"]),
  };
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  // Tenggat yang jatuh jauh di luar akal dianggap salah baca, bukan niat
  // pengguna. Lebih baik kehilangan tenggat daripada memasang yang keliru.
  const years = Math.abs(date.getUTCFullYear() - new Date().getUTCFullYear());
  return years > 5 ? null : date;
}

function readImportance(value: unknown): TaskImportance {
  return value === 1 || value === 3 ? value : 2;
}

/** Mengambil objek JSON pertama, meski terbungkus pagar kode atau basa-basi. */
function extractJson(raw: string): Record<string, unknown> | null {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
