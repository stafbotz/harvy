export type TurnBoundaryState =
  | "complete"
  | "open"
  | "incomplete"
  | "urgent";

export type TurnBoundaryReasonClass =
  | "closed-request"
  | "closed-response"
  | "narrative-opening"
  | "narrative-continuation"
  | "syntactic-fragment"
  | "correction"
  | "redirect"
  | "urgent-danger"
  | "uncertain";

export interface TurnBoundaryAssessment {
  state: TurnBoundaryState;
  /** Confidence pada state, bukan confidence tentang isi percakapan. */
  confidence: number;
  /** Peluang ada bubble lanjutan dalam logical turn yang sama. */
  continuationLikelihood: number;
  /** Closed-set dan content-free; bukan chain-of-thought. */
  reasonClass: TurnBoundaryReasonClass;
}

export type TurnBoundaryProposal = TurnBoundaryState | TurnBoundaryAssessment;

export interface TurnBoundarySignals {
  bubbleCount: number;
  adaptiveTimingUsed: boolean;
  learnedSettleMs: number;
  rapidBurst: boolean;
}

export type TurnInterruptionRelation =
  | "addition"
  | "correction"
  | "redirect"
  | "independent";

export type LocalTurnBoundaryState = Extract<
  TurnBoundaryState,
  "complete" | "incomplete"
>;

export const OPEN_IDLE_MS = 7_000;
export const INCOMPLETE_IDLE_MS = 12_000;
export const MULTI_BUBBLE_IDLE_MS = 4_000;

/**
 * Proposal model tetap tidak dipercaya begitu saja. Pagar ini mempertahankan
 * bentuk kalimat yang jelas ketika fallback model terlalu cepat menutup atau
 * menunggu. Sinyal darurat lokal ditangani terpisah sebelum pagar bentuk ini.
 */
export function guardTurnBoundary(
  text: string,
  proposed: TurnBoundaryState,
): TurnBoundaryState {
  return guardTurnBoundaryAssessment(
    text,
    normalizeTurnBoundaryAssessment(proposed),
  ).state;
}

/**
 * Pagar lokal hanya mempertahankan bentuk yang benar-benar deterministik.
 * Bahasa natural ambigu tidak ditimpa regex; assessment semantik tetap
 * authority utamanya.
 */
export function guardTurnBoundaryAssessment(
  text: string,
  proposed: TurnBoundaryAssessment,
): TurnBoundaryAssessment {
  if (proposed.state === "urgent") return proposed;

  const local = assessTurnBoundaryLocally(text);
  if (local) return local;

  const last = splitBubbles(text).at(-1) ?? "";
  if (looksHardIncomplete(last)) {
    return Object.freeze({
      state: "incomplete",
      confidence: 0.98,
      continuationLikelihood: 0.99,
      reasonClass: "syntactic-fragment",
    });
  }
  return normalizeTurnBoundaryAssessment(proposed);
}

/**
 * Menentukan boundary tanpa model hanya ketika bentuknya benar-benar jelas.
 *
 * Multi-bubble dan isi emosional yang tidak eksplisit sengaja dikembalikan
 * sebagai `null`: callback classifier tetap menjadi fallback untuk ambiguitas.
 */
export function classifyTurnBoundaryLocally(
  text: string,
): LocalTurnBoundaryState | null {
  return assessTurnBoundaryLocally(text)?.state ?? null;
}

export function assessTurnBoundaryLocally(
  text: string,
): (TurnBoundaryAssessment & { state: LocalTurnBoundaryState }) | null {
  const rawBubbles = text
    .split("\n")
    .map((bubble) => bubble.trim())
    .filter(Boolean);
  if (rawBubbles.length === 0) return null;
  // Bubble terakhir yang menentukan apakah pengguna sudah selesai, sama seperti
  // cara orang membacanya. Sampai 30 Agustus 2026 fungsi ini menyerah pada
  // setiap pesan multi-bubble, sehingga seluruh semburan dilempar ke classifier
  // model—padahal semburan justru bentuk yang paling sering muncul dan
  // classifier itu gagal pada 16 dari 28 giliran, dan setiap kegagalan menjadi
  // tunggu tujuh detik.
  const multiBubble = rawBubbles.length > 1;
  const raw = rawBubbles.at(-1) ?? "";
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (looksClearlyComplete(raw, normalized)) {
    // Keyakinan sengaja diturunkan untuk semburan. Dengan 0,99 dan
    // continuation 0,02, `assessmentIdleWindowMs` melewati bantalan
    // multi-bubble dan memotong di nol detik—tepat pada bentuk pesan yang
    // paling mungkin masih berlanjut. Nilai di bawah membuatnya memakai
    // `MULTI_BUBBLE_IDLE_MS`, angka yang memang dipilih repositori ini untuk
    // "sudah lengkap tetapi masih mungkin disambung".
    return Object.freeze(
      multiBubble
        ? {
            state: "complete" as const,
            confidence: 0.7,
            continuationLikelihood: 0.5,
            reasonClass: "closed-request" as const,
          }
        : {
            state: "complete" as const,
            confidence: 0.99,
            continuationLikelihood: 0.02,
            reasonClass: "closed-request" as const,
          },
    );
  }
  if (looksClearlyIncomplete(normalized)) {
    return Object.freeze({
      state: "incomplete",
      confidence: 0.99,
      continuationLikelihood: 0.99,
      reasonClass: "syntactic-fragment",
    });
  }
  return null;
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

  switch (state) {
    case "urgent":
      return 0;
    case "incomplete":
      return incompleteMs;
    case "open":
      return openMs;
    case "complete":
      return 0;
  }
}

export function assessmentIdleWindowMs(
  assessment: TurnBoundaryAssessment,
  bubbleCount: number,
  options: {
    openMs?: number;
    incompleteMs?: number;
    multiBubbleMs?: number;
  } = {},
): number {
  const normalized = normalizeTurnBoundaryAssessment(assessment);
  if (
    normalized.state === "complete" &&
    bubbleCount > 1 &&
    normalized.confidence < 0.72 &&
    normalized.continuationLikelihood >= 0.45
  ) {
    return options.multiBubbleMs ?? MULTI_BUBBLE_IDLE_MS;
  }
  return idleWindowMs(normalized.state, bubbleCount, options);
}

export function normalizeTurnBoundaryAssessment(
  proposal: TurnBoundaryProposal,
): TurnBoundaryAssessment {
  if (typeof proposal === "string") {
    const defaults: Record<TurnBoundaryState, TurnBoundaryAssessment> = {
      complete: {
        state: "complete",
        confidence: 0.75,
        continuationLikelihood: 0.2,
        reasonClass: "uncertain",
      },
      open: {
        state: "open",
        confidence: 0.75,
        continuationLikelihood: 0.75,
        reasonClass: "narrative-opening",
      },
      incomplete: {
        state: "incomplete",
        confidence: 0.9,
        continuationLikelihood: 0.95,
        reasonClass: "syntactic-fragment",
      },
      urgent: {
        state: "urgent",
        confidence: 1,
        continuationLikelihood: 0,
        reasonClass: "urgent-danger",
      },
    };
    return Object.freeze({ ...defaults[proposal] });
  }
  return Object.freeze({
    state: proposal.state,
    confidence: probability(proposal.confidence),
    continuationLikelihood: probability(proposal.continuationLikelihood),
    reasonClass: proposal.reasonClass,
  });
}

export function boundaryConfidenceBucket(
  confidence: number,
): "low" | "medium" | "high" {
  const normalized = probability(confidence);
  return normalized >= 0.8 ? "high" : normalized >= 0.5 ? "medium" : "low";
}

function splitBubbles(text: string): string[] {
  return text
    .split("\n")
    .map((bubble) => normalize(bubble))
    .filter(Boolean);
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[!?.,:;…-]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function looksClearlyComplete(raw: string, text: string): boolean {
  if (/^\/[a-z][a-z0-9_-]*(?:@[a-z0-9_]+)?(?:\s|$)/iu.test(raw)) {
    return true;
  }
  if (
    /^\s*\d+(?:[.,]\d+)?\s*[+\-*/x×÷]\s*\d+(?:[.,]\d+)?(?:\s*(?:berapa|hasilnya))?\s*[?？]?\s*$/iu.test(
      raw,
    )
  ) {
    return true;
  }
  if (looksTrivialStandaloneQuestion(raw, text)) return true;
  return /^(?:(?:iya+|ya+|oke+|ok(?:ay)?|sip+|siap|baik)(?:\s+(?:deh|ya|nih))?|(?:makasih|terima\s+kasih|thanks)(?:\s+(?:ya|banyak))?|(?:nggak|gak|ga|tidak|udah|sudah|belum)\s+jadi(?:\s+deh)?|(?:(?:udah|sudah|yaudah)\s+)?(?:itu|segitu)\s+aja|cukup(?:\s+segitu)?|(?:halo+|hai+|hey+|hei+|pagi|siang|sore|malam)(?:\s+harvy)?|(?:opsi\s+)?(?:[a-e]|[1-9]))$/iu.test(text);
}

function looksTrivialStandaloneQuestion(raw: string, text: string): boolean {
  if (
    !/[?？]\s*$/u.test(raw) ||
    raw.includes("\n") ||
    Array.from(raw).length > 180 ||
    looksHardIncomplete(text)
  ) {
    return false;
  }
  const words = text.split(" ").filter(Boolean);
  if (/^(?:siapa|kapan|berapa|di mana|dimana)\b/u.test(text)) {
    return words.length >= 2;
  }
  if (/^(?:apa|apakah)\b/u.test(text)) return words.length >= 3;
  return words.length >= 4 &&
    /\b(?:apa|siapa|kapan|berapa|di mana|dimana)$/u.test(text);
}

function looksClearlyIncomplete(text: string): boolean {
  return /^(?:karena|karna|soalnya|sebab|tapi|dan|atau|terus|lalu|kalau|kalo|yang|jadi|terus\s+(?:aku|saya|gue|gua)|jadi\s+tadi\s+(?:aku|saya|gue|gua)\s+mau|(?:aku|saya|gue|gua)\s+(?:hari\s+ini|tadi|besok))$/iu.test(
    text,
  );
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

function probability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Jendela tempat pesan susulan masih mungkin sudah diketik sebelum balasan
 * Harvy muncul.
 *
 * Angkanya waktu membaca, bukan waktu mengetik. Orang yang menerima balasan
 * lalu menyusun pertanyaan lanjutan harus membacanya lebih dulu; delapan detik
 * terlalu singkat untuk itu pada balasan sepanjang apa pun yang dikirim Harvy.
 * Pesan yang tiba lebih cepat dari itu hampir pasti sudah dalam perjalanan
 * ketika Harvy menjawab—artinya Harvy yang memotong, bukan pengguna yang
 * bertanya lagi.
 */
export const PREMATURE_REPLY_WINDOW_MS = 8_000;

/**
 * Pembuka yang menandai kalimat ini menyambung sesuatu, bukan memulai.
 *
 * Sengaja hanya bentuk yang tidak dapat berdiri sendiri sebagai pembuka topik
 * baru. "Terus" dan "jadi" ikut karena keduanya lazim menyambung semburan yang
 * terpotong, dan jendela delapan detik sudah menahan pemakaian lain.
 */
const CONTINUATION_OPENERS =
  /^(?:yang|sama|serta|terus|trus|lalu|tapi|tp|jadi|soalnya|karena|karna|dan|plus|maksudku|maksudnya|oh iya|eh)\b/u;

/** Kata yang tidak membuktikan apa pun tentang isi. */
const CONTENT_STOPWORDS: ReadonlySet<string> = new Set([
  "yang", "sama", "untuk", "dengan", "aku", "saya", "kamu", "harus", "gimana",
  "bagaimana", "sudah", "udah", "belum", "juga", "masih", "nanti", "kalau",
  "kalo", "kayak", "banget", "tapi", "terus", "jadi", "soalnya", "karena",
  "itu", "ini", "ada", "nggak", "enggak", "gak", "bisa", "mau", "dari",
]);

/**
 * Kata isi yang benar-benar baru terhadap sebuah balasan.
 *
 * Perbandingan dilakukan pada kata utuh supaya "sejarah" tidak dianggap sudah
 * terjawab hanya karena balasannya memuat "sejarahnya" — justru sebaliknya,
 * bentuk berimbuhan itu memang menandakan topiknya sudah disinggung, jadi
 * pencocokan memakai awalan.
 */
function unaddressedContentWords(
  message: string,
  reply: string,
): readonly string[] {
  const replyText = reply.toLowerCase();
  const seen = new Set<string>();
  const unaddressed: string[] = [];
  for (const raw of message.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 4 || CONTENT_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    if (!replyText.includes(raw)) unaddressed.push(raw);
  }
  return unaddressed;
}

export interface PrematureReplyInput {
  /** Pesan susulan yang baru tiba. */
  message: string;
  /** Balasan Harvy yang sudah terlanjur terkirim. */
  reply: string;
  /** Jarak antara balasan itu terkirim dan pesan ini tiba. */
  elapsedMs: number;
}

/**
 * Menilai apakah Harvy memotong pengguna **dan** jawabannya jadi berbeda.
 *
 * Harvy sudah mengenali empat bentuk penyelaan, tetapi keempatnya satu arah:
 * pengguna menyela pekerjaan yang sedang berjalan. Ketika balasan sudah
 * terkirim tidak ada pekerjaan yang tergantikan, sehingga sambungan kalimat
 * pengguna diperlakukan sebagai topik baru—Harvy tidak punya cara tahu bahwa
 * ia baru saja memotong orang di tengah pikiran.
 *
 * Menebak batas giliran tidak akan pernah sempurna; manusia pun saling
 * memotong. Yang membedakan percakapan yang enak bukan tidak pernah memotong,
 * melainkan sadar ketika memotong lalu memperbaikinya.
 *
 * Pengakuan sengaja dibatasi pada sambungan yang **mengubah jawaban**. Mengakui
 * setiap potongan lebih jujur tetapi terasa cerewet, dan potongan yang tidak
 * mengubah apa pun memang tidak merugikan siapa pun.
 */
export function acknowledgesPrematureReply(
  input: PrematureReplyInput,
): boolean {
  const message = input.message.trim();
  const reply = input.reply.trim();
  if (message.length === 0 || reply.length === 0) return false;
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) return false;
  if (input.elapsedMs > PREMATURE_REPLY_WINDOW_MS) return false;

  // Bentuk yang jelas menutup giliran tidak pernah menjadi sambungan yang
  // terpotong, betapa pun cepat datangnya.
  if (classifyTurnBoundaryLocally(message) === "complete") return false;

  const continues = CONTINUATION_OPENERS.test(message.toLowerCase()) ||
    classifyTurnBoundaryLocally(message) === "incomplete";
  if (!continues) return false;

  return unaddressedContentWords(message, reply).length > 0;
}

/**
 * Bentuk pengakuan yang dipakai ketika Harvy memotong pengguna.
 *
 * Pengukuran 30 Agustus 2026 dengan model nyata: arahan berbentuk kalimat di
 * prompt menghasilkan pengakuan **0 dari 5**, baik sinyalnya menyala maupun
 * tidak. Arahannya bukan tanpa efek—jawabannya berubah menjadi menyambung
 * alih-alih memulai topik baru—tetapi bagian yang paling penting, mengakui
 * telah memotong, tidak pernah muncul.
 *
 * Ini pola yang sama dengan dua perbaikan sebelumnya: yang wajib terjadi tidak
 * boleh bergantung pada kepatuhan model. Faktanya milik kode, jadi kalimatnya
 * juga.
 */
const PREMATURE_ACKNOWLEDGEMENTS: readonly string[] = [
  "Eh, aku keburu jawab tadi.",
  "Maaf, tadi aku motong kamu.",
  "Eh, kamu belum selesai ya—aku keburu nyaut.",
];

/** Menandai pengakuan yang sudah ada supaya tidak ditulis dua kali. */
const ACKNOWLEDGEMENT_PRESENT =
  /\b(?:keburu|kecepetan|kepotong|motong|memotong|nyela|menyela|belum selesai)\b/iu;

/**
 * Menambahkan pengakuan di depan balasan, kecuali balasannya sudah mengakui.
 *
 * Seed membuat pilihannya stabil dalam satu giliran tetapi berbeda antar
 * pengguna, sehingga tidak terdengar seperti satu kalimat template yang sama
 * setiap kali.
 */
export function withPrematureAcknowledgement(
  reply: string,
  seed = "harvy",
): string {
  const text = reply.trim();
  if (text.length === 0) return reply;
  if (ACKNOWLEDGEMENT_PRESENT.test(text)) return reply;
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const prefix =
    PREMATURE_ACKNOWLEDGEMENTS[(hash >>> 0) % PREMATURE_ACKNOWLEDGEMENTS.length] ??
      PREMATURE_ACKNOWLEDGEMENTS[0]!;
  return `${prefix} ${text}`;
}
