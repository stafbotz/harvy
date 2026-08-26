import type { ConversationTurn } from "../domain/history.js";

export type UnexpectedReplyScript =
  | "arabic"
  | "cyrillic"
  | "devanagari"
  | "han"
  | "hangul"
  | "hebrew"
  | "hiragana"
  | "katakana"
  | "thai";

export type ExplicitReplyConstraintViolation =
  | "exact-lines"
  | "numbers-only"
  | "no-question"
  | "no-absolute-time"
  | "code-only"
  | "malformed-conditional"
  | "language-mismatch";

export type ConversationReplyLanguage = "id" | "en" | "es";

const COUNT_WORDS: Readonly<Record<string, number>> = Object.freeze({
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  delapan: 8,
  sembilan: 9,
  sepuluh: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

const COUNT_PATTERN =
  "(\\d{1,2}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|one|two|three|four|five|six|seven|eight|nine|ten)";
const NON_EMPTY_LINES_ID = new RegExp(
  `\\b(?:tepat|persis)\\s+(?:sebanyak\\s+)?${COUNT_PATTERN}\\s+baris\\s+(?:yang\\s+)?tidak\\s+kosong\\b`,
  "iu",
);
const NON_EMPTY_LINES_EN = new RegExp(
  `\\bexactly\\s+${COUNT_PATTERN}\\s+non[- ]?(?:empty|blank)\\s+lines?\\b`,
  "iu",
);
const EXACT_LINES = new RegExp(
  `\\b(?:tepat|persis|exactly)\\s+(?:sebanyak\\s+)?${COUNT_PATTERN}\\s+(?:baris|lines?)\\b`,
  "iu",
);
const NUMBERS_ONLY =
  /\b(?:angka(?:nya)?\s+saja|hanya\s+(?:angka|angkanya)|number\s+only)\b/iu;
const NO_QUESTION =
  /\b(?:jangan|tidak\s+usah|tanpa)\s+(?:bertanya|tanya)(?:\s+balik)?\b/iu;
const NO_ABSOLUTE_TIME =
  /\b(?:jangan|tanpa)\s+(?:(?:pakai|gunakan|menyebut)\s+)?(?:jam|waktu)\s+absolut\b/iu;
const CODE_ONLY =
  /(?:\b(?:write|give|show|return|output)\s+only\b[^\n.?!]{0,160}\b(?:code|typescript|javascript|python|types?|function|class|interface)\b|\b(?:tulis|berikan|tampilkan|keluarkan|jawab)\s+(?:hanya|cuma)\b[^\n.?!]{0,160}\b(?:kode|typescript|javascript|python|types?|tipe|fungsi|kelas|interface)\b|\b(?:hanya|cuma|only)\s+(?:kode|code)\b)/iu;
const ABSOLUTE_CLOCK =
  /\b(?:(?:pukul|jam)\s*)?\d{1,2}(?:[:.]\d{2})(?:\s*(?:wib|wita|wit))?\b/iu;
const NUMBER_ONLY_REPLY = /^[+-]?(?:\d+(?:[.,]\d+)?|\d+\/\d+)%?$/u;
const FENCED_CODE = /```[^\r\n`]*\r?\n([\s\S]*?)```/gu;

const SCRIPT_PATTERNS: ReadonlyArray<readonly [
  UnexpectedReplyScript,
  RegExp,
]> = [
  ["han", /\p{Script=Han}/u],
  ["hiragana", /\p{Script=Hiragana}/u],
  ["katakana", /\p{Script=Katakana}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["thai", /\p{Script=Thai}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
];

const EXPLICIT_SCRIPT_REQUESTS: Readonly<Record<
  UnexpectedReplyScript,
  RegExp
>> = {
  han:
    /\b(?:bahasa\s+)?(?:mandarin|cina|tionghoa|chinese|hanzi|kanji|jepang|japanese)\b/iu,
  hiragana: /\b(?:jepang|japanese|hiragana|kana)\b/iu,
  katakana: /\b(?:jepang|japanese|katakana|kana)\b/iu,
  hangul: /\b(?:korea|korean|hangul)\b/iu,
  thai: /\b(?:thai|thailand)\b/iu,
  arabic: /\b(?:arab|arabic|hijaiyah)\b/iu,
  hebrew: /\b(?:ibrani|hebrew)\b/iu,
  cyrillic: /\b(?:rusia|russian|ukraina|ukrainian|kiril|cyrillic)\b/iu,
  devanagari: /\b(?:hindi|sanskrit|devanagari)\b/iu,
};

const LANGUAGE_TERMS: Readonly<Record<
  ConversationReplyLanguage,
  ReadonlySet<string>
>> = Object.freeze({
  id: new Set([
    "aku", "saya", "kamu", "yang", "dan", "atau", "dengan", "untuk",
    "dari", "dalam", "ini", "itu", "tadi", "jangan", "cuma", "hanya",
    "lebih", "paling", "saja", "sebutkan", "ingatkan", "keputusan",
    "cara", "maksudku", "kembali", "kalimat", "sekarang", "jawaban",
  ]),
  en: new Set([
    "the", "this", "that", "and", "or", "with", "for", "from", "you",
    "your", "only", "just", "please", "write", "what", "should", "need",
    "earlier", "back", "remember", "answer", "will", "uses", "returns",
    "prefer", "like", "going", "exactly", "lines", "first", "now",
  ]),
  es: new Set([
    "ahora", "una", "para", "del", "agua", "con", "cuantos", "necesito",
    "responde", "lineas", "calculo", "primero", "luego", "importa",
    "practica", "que", "como", "los", "las", "por", "solo", "quiero",
    "entre", "diferencia", "volver", "volvamos", "anterior", "antes",
  ]),
});

/**
 * Menemukan kontaminasi writing-system pada prosa balasan model.
 *
 * Ini bukan intent router. Model tetap memahami bahasa dan maksud pengguna;
 * kode hanya menolak aksara yang tidak punya bukti di percakapan atau
 * permintaan bahasa eksplisit. Fenced/inline code dikecualikan agar source code
 * dan literal yang memang sedang dibahas tidak diubah diam-diam.
 */
export function unexpectedReplyScripts(
  message: string,
  reply: string,
  turns: readonly ConversationTurn[] = [],
): UnexpectedReplyScript[] {
  const evidence = [
    ...turns.map((turn) => turn.text),
    message,
  ].join("\n");
  const prose = proseOnly(reply);

  return SCRIPT_PATTERNS
    .filter(([script, pattern]) =>
      pattern.test(prose) &&
      !pattern.test(evidence) &&
      !EXPLICIT_SCRIPT_REQUESTS[script].test(message)
    )
    .map(([script]) => script);
}

/** Fallback terakhir bila regeneration provider juga terkontaminasi. */
export function removeUnexpectedReplyScripts(
  reply: string,
  scripts: readonly UnexpectedReplyScript[],
): string {
  if (scripts.length === 0) return reply.trim();
  const blocked = new Set(scripts);
  const repaired = reply.split(/(```[\s\S]*?```|`[^`\n]+`)/gu)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let value = part;
      for (const [script, pattern] of SCRIPT_PATTERNS) {
        if (!blocked.has(script)) continue;
        value = value.replace(new RegExp(pattern.source, "gu"), "");
      }
      return value;
    })
    .join("")
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return repaired;
}

export function replyLanguageRepairInstruction(
  scripts: readonly UnexpectedReplyScript[],
): string {
  return [
    "<pemeriksaan-kualitas-keluaran>",
    "Tulis ulang jawaban untuk pesan ini dari awal.",
    `Percobaan sebelumnya menyisipkan aksara yang tidak diminta (${scripts.join(", ")}).`,
    "Gunakan hanya bahasa dan aksara yang dipakai atau diminta pengguna.",
    "Pertahankan isi yang berguna, jangan membahas pemeriksaan internal ini,",
    "dan jangan menambah penutup generik.",
    "</pemeriksaan-kualitas-keluaran>",
  ].join("\n");
}

/**
 * Menegakkan hanya constraint keluaran yang dinyatakan explicit dan dapat
 * dibuktikan secara mekanis. Ini bukan intent router dan tidak menilai isi
 * jawaban; model tetap menentukan substansi serta personalisasinya.
 */
export function explicitReplyConstraintViolations(
  message: string,
  reply: string,
): ExplicitReplyConstraintViolation[] {
  const violations: ExplicitReplyConstraintViolation[] = [];
  const codeOnly = CODE_ONLY.test(message);
  const codeBlocks = fencedCodeBlocks(reply);
  const lineConstraint = exactLineConstraint(message);
  if (
    lineConstraint !== null &&
    replyLineCount(
        reply,
        codeOnly,
        codeBlocks,
        lineConstraint.nonEmpty,
      ) !== lineConstraint.count
  ) {
    violations.push("exact-lines");
  }
  if (NUMBERS_ONLY.test(message) && !NUMBER_ONLY_REPLY.test(reply.trim())) {
    violations.push("numbers-only");
  }
  if (NO_QUESTION.test(message) && reply.includes("?")) {
    violations.push("no-question");
  }
  if (NO_ABSOLUTE_TIME.test(message) && ABSOLUTE_CLOCK.test(reply)) {
    violations.push("no-absolute-time");
  }
  if (
    codeOnly &&
    (codeBlocks.length !== 1 || textOutsideFencedCode(reply).length > 0)
  ) {
    violations.push("code-only");
  }
  const code = codeBlocks.length > 0
    ? codeBlocks.map((block) => block.code).join("\n")
    : codeOnly
      ? reply
      : "";
  if (code && hasMalformedConditionalExpression(code)) {
    violations.push("malformed-conditional");
  }
  if (replyLanguageMismatch(message, proseOnly(reply))) {
    violations.push("language-mismatch");
  }
  return violations;
}

export function replyConstraintRepairInstruction(
  violations: readonly ExplicitReplyConstraintViolation[],
): string {
  const details: string[] = [];
  if (violations.includes("code-only")) {
    details.push(
      "Keluarkan tepat satu fenced code block dan jangan tulis prosa, judul,",
      "catatan, atau pertanyaan di luarnya.",
    );
  }
  if (violations.includes("malformed-conditional")) {
    details.push(
      "Periksa sintaks kode. Setiap conditional expression wajib lengkap:",
      "condition ? whenTrue : whenFalse. Pertahankan ejaan identifier yang",
      "sudah dipakai di kode percakapan; jangan menggantinya diam-diam.",
    );
  }
  if (violations.includes("language-mismatch")) {
    details.push(
      "Gunakan bahasa utama pada pesan pengguna saat ini. Jangan meneruskan",
      "bahasa dari giliran lama, memori yang baru dicabut, atau identifier kode",
      "ke prosa jawaban.",
    );
  }
  return [
    "<pemeriksaan-constraint-keluaran>",
    "Tulis ulang jawaban dari awal dan patuhi constraint explicit pengguna.",
    `Pelanggaran percobaan sebelumnya: ${violations.join(", ")}.`,
    ...details,
    "Jangan membahas pemeriksaan ini, jangan menambah ringkasan/total di luar",
    "jumlah baris yang diminta, dan pertahankan isi yang sudah benar.",
    "</pemeriksaan-constraint-keluaran>",
  ].join("\n");
}

interface ExactLineConstraint {
  count: number;
  nonEmpty: boolean;
}

function exactLineConstraint(message: string): ExactLineConstraint | null {
  const nonEmptyMatch = NON_EMPTY_LINES_ID.exec(message) ??
    NON_EMPTY_LINES_EN.exec(message);
  const match = nonEmptyMatch ?? EXACT_LINES.exec(message);
  const raw = match?.[1]?.toLocaleLowerCase("id-ID");
  if (!raw) return null;
  const count = /^\d+$/u.test(raw) ? Number(raw) : COUNT_WORDS[raw];
  return typeof count === "number" && Number.isSafeInteger(count) &&
      count >= 1 && count <= 20
    ? { count, nonEmpty: nonEmptyMatch !== null }
    : null;
}

interface FencedCodeBlock {
  full: string;
  code: string;
}

function fencedCodeBlocks(reply: string): FencedCodeBlock[] {
  return [...reply.matchAll(FENCED_CODE)].map((match) => ({
    full: match[0],
    code: match[1] ?? "",
  }));
}

function textOutsideFencedCode(reply: string): string {
  return reply.replace(FENCED_CODE, "").trim();
}

function replyLineCount(
  reply: string,
  codeOnly: boolean,
  codeBlocks: readonly FencedCodeBlock[],
  nonEmpty: boolean,
): number {
  const value = codeOnly && codeBlocks.length === 1
    ? codeBlocks[0]!.code
    : reply;
  const lines = value.replace(/\r?\n$/u, "").split(/\r?\n/u);
  return nonEmpty
    ? lines.filter((line) => line.trim().length > 0).length
    : lines.length;
}

/** Deteksi bahasa kecil untuk quality gate Latin-script, bukan intent router. */
export function inferConversationReplyLanguage(
  value: string,
): ConversationReplyLanguage | null {
  const tokens = value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .match(/[\p{L}]+/gu) ?? [];
  const unique = new Set(tokens);
  const scores = (Object.entries(LANGUAGE_TERMS) as Array<
    [ConversationReplyLanguage, ReadonlySet<string>]
  >).map(([language, terms]) => ({
    language,
    score: [...unique].filter((token) => terms.has(token)).length,
  })).sort((left, right) => right.score - left.score);
  const first = scores[0];
  const second = scores[1];
  if (!first || first.score < 2 || first.score === second?.score) return null;
  return first.language;
}

export function replyLanguageGuidance(message: string): string | null {
  const language = inferConversationReplyLanguage(message);
  if (!language) return null;
  const label = language === "id"
    ? "Bahasa Indonesia"
    : language === "es"
      ? "español"
      : "English";
  return [
    "KONTRAK BAHASA GILIRAN INI:",
    `- Tulis prosa jawaban dalam ${label}, yaitu bahasa utama pesan terbaru.`,
    "- Kutipan, istilah teknis, dan identifier kode boleh tetap dalam bentuk",
    "  aslinya, tetapi konteks atau preferensi lama tidak boleh mengganti bahasa",
    "  pesan terbaru.",
  ].join("\n");
}

export function normalizeAccidentalDuplicatePunctuation(value: string): string {
  return value.split(/(```[\s\S]*?```|`[^`\n]+`)/gu)
    .map((part, index) => index % 2 === 1
      ? part
      : part
        .replace(/,{2,}/gu, ",")
        .replace(/(?<!\.)\.\.(?!\.)/gu, "."))
    .join("");
}

function replyLanguageMismatch(message: string, replyProse: string): boolean {
  const expected = inferConversationReplyLanguage(message);
  const actual = inferConversationReplyLanguage(replyProse);
  return expected !== null && actual !== null && expected !== actual;
}

/**
 * Pagar sempit untuk satu bentuk kerusakan kode yang ditemukan live.
 *
 * Ini bukan compiler dan tidak mencoba memahami intent pengguna. Ia hanya
 * menolak conditional expression pada assignment/return yang mempunyai `?`
 * tetapi tidak mempunyai pasangan `:` pada nesting yang sama. Optional
 * chaining, nullish coalescing, string, dan komentar dikecualikan.
 */
function hasMalformedConditionalExpression(code: string): boolean {
  const clean = maskStringsAndComments(code);
  for (const statement of clean.split(";")) {
    if (!/(?:\b(?:const|let|var)\b[^=]*=|\breturn\b)/u.test(statement)) {
      continue;
    }
    if (hasUnpairedConditionalQuestion(statement)) return true;
  }
  return false;
}

function hasUnpairedConditionalQuestion(value: string): boolean {
  let round = 0;
  let square = 0;
  let curly = 0;
  const pending: Array<readonly [number, number, number]> = [];
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current === "(") round += 1;
    else if (current === ")") round = Math.max(0, round - 1);
    else if (current === "[") square += 1;
    else if (current === "]") square = Math.max(0, square - 1);
    else if (current === "{") curly += 1;
    else if (current === "}") curly = Math.max(0, curly - 1);
    else if (current === "?") {
      const previous = value[index - 1] ?? "";
      const next = value[index + 1] ?? "";
      if (previous !== "?" && next !== "?" && next !== ".") {
        pending.push([round, square, curly]);
      }
    } else if (current === ":") {
      const matching = pending.findLastIndex(([r, s, c]) =>
        r === round && s === square && c === curly
      );
      if (matching >= 0) pending.splice(matching, 1);
    }
  }
  return pending.length > 0;
}

function maskStringsAndComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length))
    .replace(/\/\/[^\r\n]*/gu, (match) => " ".repeat(match.length))
    .replace(
      /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gu,
      (match) => " ".repeat(match.length),
    );
}

function proseOnly(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]+`/gu, "")
    .replace(/https?:\/\/[^\s<>"']+/giu, "");
}
