import { collapseRepetition } from "./repetition-guard.js";

export type ResponseSegmentRelation =
  | "primary"
  | "continuation"
  | "beat"
  | "follow-up"
  | "code"
  | "transport-continuation";

export interface ResponsePresentationSegment {
  text: string;
  relation: ResponseSegmentRelation;
  /** Jeda adalah hint keterbacaan dan selalu boleh dibatalkan adapter. */
  pauseBeforeMs: number;
  final: boolean;
}

export interface ResponsePresentationPlan {
  /** Jawaban logis sebelum diproyeksikan menjadi beberapa message transport. */
  logicalText: string;
  segments: readonly ResponsePresentationSegment[];
  /** Pagar ekstrem, bukan aturan kepribadian atau target jumlah bubble. */
  antiSpamGuardApplied: boolean;
  /**
   * Balasan tergelincir ke perulangan dan ekornya dipangkas.
   *
   * Terpisah dari `antiSpamGuardApplied` karena keduanya menjaga hal berbeda:
   * yang itu membatasi jumlah segmen semantik, yang ini menangkap kegagalan
   * model yang justru lolos darinya—satu segmen raksasa yang tetap pecah
   * menjadi belasan potongan transport.
   */
  repetitionGuardApplied: boolean;
}

export interface ResponsePresentationOptions {
  maxSegmentCharacters: number;
  /** Hanya melindungi kegagalan model yang menghasilkan spam beat ekstrem. */
  antiSpamSegmentCeiling?: number;
}

const DEFAULT_ANTI_SPAM_SEGMENT_CEILING = 8;
const SHORT_BEAT_CHARACTERS = 96;
const LONG_EXPLANATION_CHARACTERS = 520;

/**
 * Membentuk satu rencana presentasi yang dapat dirender semua channel.
 *
 * Blank line hanyalah sinyal. Penjelasan koheren, daftar, dan blok kode tetap
 * disatukan; reaksi/follow-up pendek boleh menjadi beat terpisah. Pemecahan
 * hard-length baru dilakukan sesudah keputusan percakapan ini.
 */
export function planResponsePresentation(
  response: string,
  options: ResponsePresentationOptions,
): ResponsePresentationPlan {
  const delivered = response.trim();
  if (!delivered) {
    return Object.freeze({
      logicalText: "",
      segments: Object.freeze([]),
      antiSpamGuardApplied: false,
      repetitionGuardApplied: false,
    });
  }

  // Dipangkas sebelum apa pun yang lain. Segmentasi semantik atas teks yang
  // menggema hanya menghasilkan segmen raksasa, dan pemecahan transport
  // sesudahnya justru yang mengubah satu kegagalan model menjadi belasan
  // notifikasi.
  //
  // Kode berpagar dikecualikan, dengan alasan yang sama seperti
  // `semanticSegments` mengecualikannya: memangkas kode di tengah menghasilkan
  // jawaban yang salah tanpa terlihat salah. Guard ini menukar satu mode
  // kegagalan yang mencolok (banjir notifikasi) dengan risiko satu mode
  // kegagalan yang senyap, dan pertukaran itu hanya sepadan di luar kode.
  const logicalText = containsFencedCode(delivered)
    ? delivered
    : collapseRepetition(delivered);
  const repetitionGuardApplied = logicalText !== delivered;

  const maxCharacters = positiveInteger(
    options.maxSegmentCharacters,
    "maxSegmentCharacters",
  );
  const ceiling = Math.max(
    2,
    positiveInteger(
      options.antiSpamSegmentCeiling ?? DEFAULT_ANTI_SPAM_SEGMENT_CEILING,
      "antiSpamSegmentCeiling",
    ),
  );
  const semantic = semanticSegments(logicalText);
  const guarded = applyAntiSpamGuard(semantic, ceiling);
  const transportSegments = guarded.segments.flatMap((segment, index) => {
    const chunks = splitForTransport(segment.text, maxCharacters);
    return chunks.map((text, chunkIndex) => ({
      text,
      relation: chunkIndex === 0
        ? relationFor(segment.text, index)
        : "transport-continuation" as const,
    }));
  });
  const segments = transportSegments.map((segment, index) =>
    Object.freeze({
      ...segment,
      pauseBeforeMs: index === 0 ? 0 : presentationPauseMs(segment.text),
      final: index === transportSegments.length - 1,
    })
  );

  return Object.freeze({
    logicalText,
    segments: Object.freeze(segments),
    antiSpamGuardApplied: guarded.applied,
    repetitionGuardApplied,
  });
}

export function presentationPauseMs(text: string): number {
  const estimate = Math.round(Array.from(text.trim()).length * 18);
  return Math.min(Math.max(estimate, 300), 1_200);
}

function semanticSegments(text: string): Array<{ text: string }> {
  if (containsFencedCode(text)) return [{ text }];

  const paragraphs = text
    .split(/\n\s*\n+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) return [{ text }];

  const hasStructuredExplanation = paragraphs.some(isStructuredParagraph);
  const averageLength = paragraphs.reduce(
    (total, paragraph) => total + Array.from(paragraph).length,
    0,
  ) / paragraphs.length;
  const shortBeatCount = paragraphs.filter(isShortBeat).length;
  const conversational = shortBeatCount >= Math.ceil(paragraphs.length / 2);

  // Satu penjelasan runtut boleh tetap menjadi satu bubble panjang. Blank line
  // untuk paragraf tidak otomatis berarti notifikasi baru.
  if (
    hasStructuredExplanation ||
    (Array.from(text).length >= LONG_EXPLANATION_CHARACTERS &&
      averageLength >= 120 && !conversational)
  ) {
    return [{ text }];
  }

  if (conversational) {
    return paragraphs.map((paragraph) => ({ text: paragraph }));
  }

  const grouped: Array<{ text: string }> = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const isolate = isShortBeat(paragraph) || isShortFollowUp(paragraph);
    if (isolate) {
      if (current) grouped.push({ text: current });
      grouped.push({ text: paragraph });
      current = "";
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) grouped.push({ text: current });
  return grouped.length > 0 ? grouped : [{ text }];
}

function applyAntiSpamGuard(
  segments: Array<{ text: string }>,
  ceiling: number,
): { segments: Array<{ text: string }>; applied: boolean } {
  if (segments.length <= ceiling) return { segments, applied: false };
  return {
    segments: [
      ...segments.slice(0, ceiling - 1),
      { text: segments.slice(ceiling - 1).map((item) => item.text).join("\n\n") },
    ],
    applied: true,
  };
}

function relationFor(text: string, index: number): ResponseSegmentRelation {
  if (containsFencedCode(text)) return "code";
  if (index === 0) return "primary";
  if (isShortFollowUp(text)) return "follow-up";
  if (isShortBeat(text)) return "beat";
  return "continuation";
}

function isShortBeat(text: string): boolean {
  const length = Array.from(text).length;
  if (length > SHORT_BEAT_CHARACTERS) return false;
  if (isStructuredParagraph(text)) return false;
  const sentences = text.split(/[.!?]+(?:\s|$)/u).filter(Boolean).length;
  return sentences <= 2;
}

function isShortFollowUp(text: string): boolean {
  return Array.from(text).length <= 180 && /[?？]\s*$/u.test(text);
}

function isStructuredParagraph(text: string): boolean {
  return /^(?:\s*(?:[-*•]|\d+[.)])\s+)|(?:\n\s*(?:[-*•]|\d+[.)])\s+)/mu.test(
    text,
  );
}

function containsFencedCode(text: string): boolean {
  return /```/u.test(text);
}

/** Mempertahankan setiap code point; tidak ada karakter yang dibuang. */
function splitForTransport(text: string, maximum: number): string[] {
  const characters = Array.from(text);
  if (characters.length <= maximum) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + maximum, characters.length);
    if (end < characters.length) {
      const preferred = preferredBoundary(characters, start, end);
      if (preferred > start) end = preferred;
    }
    chunks.push(characters.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

function preferredBoundary(
  characters: readonly string[],
  start: number,
  hardEnd: number,
): number {
  const minimum = start + Math.floor((hardEnd - start) * 0.7);
  for (let index = hardEnd; index > minimum; index -= 1) {
    const previous = characters[index - 1];
    if (previous === "\n") return index;
  }
  for (let index = hardEnd; index > minimum; index -= 1) {
    const previous = characters[index - 1];
    if (previous === " " || previous === "\t") return index;
  }
  return hardEnd;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} harus bilangan bulat positif.`);
  }
  return value;
}
