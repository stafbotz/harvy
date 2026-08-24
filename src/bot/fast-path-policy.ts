import type { Pending } from "./pending.js";

const ARITHMETIC_OPERAND =
  String.raw`(?:-?\d+(?:[.,]\d{1,6})?|setengah|seperempat|tiga\s+perempat)`;
const ARITHMETIC_OPERATOR =
  String.raw`(?:ditambah|plus|dikurangi|minus|dikali|kali|dibagi|[+\-*/:x×])`;
const ARITHMETIC_EXPRESSION = new RegExp(
  String.raw`(${ARITHMETIC_OPERAND})\s*(${ARITHMETIC_OPERATOR})\s*(${ARITHMETIC_OPERAND})`,
  "giu",
);
const ARITHMETIC_REQUEST =
  /\b(?:berapa|hitung(?:kan)?|kerjakan\s+soal|hasil(?:nya)?|langsung\s+(?:kasih|beri(?:kan)?))\b/iu;

/**
 * Menjawab satu operasi aritmetika pendek tanpa menunggu model.
 * Parser sengaja tidak mendukung ekspresi bebas, unit, atau beberapa operasi;
 * ketidakpastian kembali ke pipeline percakapan/alat kalkulasi biasa.
 */
export function deterministicArithmeticReply(message: string): string | null {
  const normalized = normalize(message);
  if (!normalized || normalized.length > 180) return null;
  const matches = [...normalized.matchAll(ARITHMETIC_EXPRESSION)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (!match || match.index === undefined) return null;

  const outside = `${normalized.slice(0, match.index)}${
    normalized.slice(match.index + match[0].length)
  }`.replaceAll(/[\s?!.,:;]+/gu, "");
  if (outside && !ARITHMETIC_REQUEST.test(normalized)) return null;

  const left = parseRational(match[1] ?? "");
  const right = parseRational(match[3] ?? "");
  if (!left || !right) return null;
  const result = applyRational(left, match[2] ?? "", right);
  if (!result) return null;
  const rendered = renderRational(result);
  return rendered ? `Hasilnya ${rendered}.` : null;
}

/**
 * Form value berstruktur sempit tidak memerlukan compiler intent atau triase
 * umum. Caller tetap menjalankan emergency preflight lokal lebih dahulu.
 */
export function isNarrowPendingAnswer(
  waiting: Pending,
  answer: string,
): boolean {
  switch (waiting.kind) {
    case "edit-due":
    case "set-task-reminder":
    case "schedule-checkin":
    case "custom-quiet-hours":
      return looksLikeNarrowTimeValue(answer);
    case "agent-input":
      // Checkpoint belum menyimpan schema jawaban yang diharapkan. Watermark
      // update saja tidak cukup untuk mengikat "iya"/"besok" ke pertanyaan
      // terbuka agent, jadi jalur ini tetap memakai compiler umum.
      return false;
    case "checkin-settings":
      return looksLikeNarrowChoice(answer);
    case "edit-memory":
    case "confirm-task":
    case "confirm-memory-wipe":
    case "confirm-consent-withdrawal":
    case "confirm-full-deletion":
      return false;
  }
}

function looksLikeNarrowChoice(value: string): boolean {
  const normalized = normalize(value);
  return /^(?:iya|ya|y|oke|ok|tidak|nggak|gak|ga|belum|sudah|udah|opsi\s+[a-z0-9]|[a-z0-9])$/u.test(
    normalized,
  );
}

function looksLikeNarrowTimeValue(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized || normalized.length > 48) return false;
  return /^(?:(?:hari ini|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu)(?:\s+(?:(?:jam|pukul)\s*)?\d{1,2}(?:(?:[:.]\d{2})|(?:\s*(?:pagi|siang|sore|malam)))?)?|(?:(?:jam|pukul)\s*)\d{1,2}(?:(?:[:.]\d{2})|(?:\s*(?:pagi|siang|sore|malam)))?|setengah\s+\d{1,2}|\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?|\d+(?:\s*[-–]\s*\d+)?\s*(?:menit|jam|hari|minggu)|\d{1,2}(?::|\.)\d{2}\s*[-–]\s*\d{1,2}(?::|\.)\d{2})$/u.test(
    normalized,
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .trim()
    .replace(/[!?.,]+$/gu, "")
    .replace(/\s+/gu, " ");
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

function parseRational(value: string): Rational | null {
  const normalized = value.toLocaleLowerCase("id-ID").replaceAll(/\s+/gu, " ");
  switch (normalized) {
    case "setengah":
      return { numerator: 1n, denominator: 2n };
    case "seperempat":
      return { numerator: 1n, denominator: 4n };
    case "tiga perempat":
      return { numerator: 3n, denominator: 4n };
  }
  const numeric = /^(-?\d+)(?:[.,](\d{1,6}))?$/u.exec(normalized);
  if (!numeric) return null;
  const integer = numeric[1] ?? "";
  const decimals = numeric[2] ?? "";
  try {
    const denominator = 10n ** BigInt(decimals.length);
    const sign = integer.startsWith("-") ? -1n : 1n;
    const whole = BigInt(integer);
    const fraction = decimals ? BigInt(decimals) * sign : 0n;
    return reduceRational({
      numerator: whole * denominator + fraction,
      denominator,
    });
  } catch {
    return null;
  }
}

function applyRational(
  left: Rational,
  rawOperator: string,
  right: Rational,
): Rational | null {
  const operator = rawOperator.toLocaleLowerCase("id-ID");
  let result: Rational;
  if (operator === "+" || operator === "ditambah" || operator === "plus") {
    result = {
      numerator:
        left.numerator * right.denominator + right.numerator * left.denominator,
      denominator: left.denominator * right.denominator,
    };
  } else if (
    operator === "-" || operator === "dikurangi" || operator === "minus"
  ) {
    result = {
      numerator:
        left.numerator * right.denominator - right.numerator * left.denominator,
      denominator: left.denominator * right.denominator,
    };
  } else if (
    operator === "*" || operator === "x" || operator === "×" ||
    operator === "dikali" || operator === "kali"
  ) {
    result = {
      numerator: left.numerator * right.numerator,
      denominator: left.denominator * right.denominator,
    };
  } else {
    if (right.numerator === 0n) return null;
    result = {
      numerator: left.numerator * right.denominator,
      denominator: left.denominator * right.numerator,
    };
  }
  return reduceRational(result);
}

function reduceRational(value: Rational): Rational | null {
  if (value.denominator === 0n) return null;
  const sign = value.denominator < 0n ? -1n : 1n;
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reduced = {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
  return reduced.numerator.toString().length <= 48 &&
      reduced.denominator.toString().length <= 48
    ? reduced
    : null;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function renderRational(value: Rational): string | null {
  if (value.denominator === 1n) return value.numerator.toString();
  return `${value.numerator}/${value.denominator}`;
}
