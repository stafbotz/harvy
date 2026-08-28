import type { HarvyContext } from "../ai/context.js";
import { estimateTokens } from "../ai/token-estimate.js";
import {
  createContextManifest,
  type ContextManifest,
} from "./context-manifest.js";

export interface ContextBudget {
  maxCharacters: number;
  maxSummaryCharacters: number;
  maxTurnCharacters: number;
  maxMemoryCharacters: number;
  maxTurns: number;
  maxMemories: number;
  maxInteractions?: number;
}

/**
 * Perkiraan token dari batas karakter, memakai estimator bersama.
 *
 * Konstanta rasio tidak lagi hidup di sini. Modul ini sempat memegang 4,18
 * sendiri sementara `client.ts` memakai 4, sehingga anggaran dan reservasi
 * budget dapat berbeda pendapat tentang request yang sama. Sekarang keduanya
 * memakai `src/ai/token-estimate.ts`, yang menajamkan rasionya per model dari
 * pemakaian nyata.
 *
 * Untuk referensi: probe 2026-08-28 pada MiniMax-M3 mengukur 4,18 karakter per
 * token untuk prosa Indonesia, jadi default 4 sedikit melebihkan—arah yang
 * memang diinginkan untuk sebuah plafon.
 */
export function approximateTokens(characters: number): number {
  return estimateTokens(characters);
}

/**
 * Anggaran perhatian default, dinyatakan dalam karakter tetapi ditalar dalam
 * token.
 *
 * Penegakan tetap memakai karakter karena deterministik dan tidak menuntut
 * tokenizer yang tidak tersedia secara lokal. Yang berubah pada 2026-08-28
 * adalah ukurannya: 16.000 karakter (~3.800 token) hanyalah 0,4% dari jendela
 * 1.048.576 token MiniMax-M3, dan 18 giliran membuat percakapan panjang
 * kehilangan awalnya justru pada produk yang dijual sebagai pendamping yang
 * mengingat.
 *
 * Biayanya nyata dan disengaja: konteks masuk ke panggilan understand maupun
 * reply, sehingga batas penuh menambah sekitar 7.600 token per panggilan.
 * Ini plafon, bukan lantai—percakapan baru tetap murah, dan hanya percakapan
 * panjang membayar penuh. Bagian konteks tidak ikut ter-cache karena berubah
 * tiap giliran, berbeda dari prefix persona yang stabil.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  // ~11.500 token; masih di bawah 1,1% jendela model.
  maxCharacters: 48_000,
  maxSummaryCharacters: 8_000,
  maxTurnCharacters: 4_000,
  maxMemoryCharacters: 600,
  maxTurns: 40,
  maxMemories: 24,
  maxInteractions: 6,
});

export interface ContextProjection {
  includeSummary: boolean;
  includeTurns: boolean;
  includeMemories: boolean;
  includeInteractions?: boolean;
}

export const FULL_CONTEXT_PROJECTION: ContextProjection = Object.freeze({
  includeSummary: true,
  includeTurns: true,
  includeMemories: true,
  includeInteractions: true,
});

export const TURNS_ONLY_CONTEXT_PROJECTION: ContextProjection = Object.freeze({
  includeSummary: false,
  includeTurns: true,
  includeMemories: false,
  includeInteractions: false,
});

export interface CompiledHarvyContext {
  context: HarvyContext;
  /** Bebas isi; aman untuk observability dan tidak ikut ke prompt. */
  manifest: ContextManifest;
}

/**
 * Menjaga konteks tetap menjadi anggaran perhatian. Giliran terbaru
 * dipertahankan lebih dulu; isi lama yang tidak muat dibuang, bukan diletakkan
 * di tengah prompt dan berharap model menemukannya.
 */
export function fitHarvyContext(
  context: HarvyContext,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): HarvyContext {
  return compileHarvyContext(context, budget).context;
}

/**
 * Memilih proyeksi konteks sekaligus menerbitkan manifest bebas isi.
 *
 * Selection tetap identik dengan `fitHarvyContext`: giliran terbaru lebih
 * dahulu, lalu memori, lalu ringkasan. Projection membuat manifest sesuai route
 * yang benar-benar memakai bagian tersebut, misalnya triase hanya memakai
 * giliran terakhir.
 */
export function compileHarvyContext(
  context: HarvyContext,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  projection: ContextProjection = FULL_CONTEXT_PROJECTION,
): CompiledHarvyContext {
  validateBudget(budget);
  let remaining = budget.maxCharacters;
  let clippedTurnCount = 0;
  let clippedMemoryCount = 0;

  const interactions = projection.includeInteractions !== false
    ? (context.interactions ?? [])
        .slice(0, budget.maxInteractions ?? 3)
        .filter((interaction) => {
          const size = interaction.domain.length + interaction.operation.length +
            interaction.reference.length + 32;
          if (size > remaining) return false;
          remaining -= size;
          return true;
        })
    : [];

  const selected = [] as HarvyContext["turns"];
  if (projection.includeTurns) {
    for (
      let index = context.turns.length - 1;
      index >= 0 && selected.length < budget.maxTurns;
      index -= 1
    ) {
      const turn = context.turns[index];
      if (!turn) continue;
      const clippedTurn = clipWithStatus(turn.text, budget.maxTurnCharacters);
      const size = clippedTurn.value.length + 16;
      if (size > remaining) break;
      remaining -= size;
      if (clippedTurn.clipped) clippedTurnCount += 1;
      selected.push({ ...turn, text: clippedTurn.value });
    }
  }
  selected.reverse();

  const retrievalReserve = projection.includeMemories &&
      (context.retrieved?.length ?? 0) > 0 && budget.maxMemories > 0
    ? 1
    : 0;
  const memoryCandidates = projection.includeMemories
    ? context.memories.slice(0, budget.maxMemories - retrievalReserve)
    : [];
  const memories = memoryCandidates
    .map((memory) => ({
      ...memory,
      clippedContent: clipWithStatus(
        memory.content,
        budget.maxMemoryCharacters,
      ),
    }))
    .filter((memory) => {
      const size = memory.clippedContent.value.length + memory.kind.length + 8;
      if (size > remaining) return false;
      remaining -= size;
      if (memory.clippedContent.clipped) clippedMemoryCount += 1;
      return true;
    })
    .map(({ clippedContent, ...memory }) => ({
      ...memory,
      content: clippedContent.value,
    }));

  const retrieved = projection.includeMemories
    ? (context.retrieved ?? [])
        .slice(0, Math.max(0, budget.maxMemories - memories.length))
        .map((evidence) => ({
          ...evidence,
          clippedText: clipWithStatus(
            evidence.text,
            budget.maxMemoryCharacters,
          ),
        }))
        .filter((evidence) => {
          const size = evidence.clippedText.value.length + 24;
          if (size > remaining) return false;
          remaining -= size;
          if (evidence.clippedText.clipped) clippedMemoryCount += 1;
          return true;
        })
        .map(({ clippedText, ...evidence }) => ({
          ...evidence,
          text: clippedText.value,
        }))
    : [];

  const summaryCandidate = projection.includeSummary && context.summary
    ? clipWithStatus(context.summary, budget.maxSummaryCharacters)
    : null;
  const fittedSummary = summaryCandidate?.value && remaining > 0
    ? clipWithStatus(summaryCandidate.value, remaining)
    : null;
  const summary = fittedSummary?.value || null;
  if (summary) remaining -= summary.length;

  const includedCharacters = budget.maxCharacters - remaining;
  const sourceCharacters = contextSourceCharacters(context);
  const summaryPresent = Boolean(context.summary?.trim());
  const manifest: ContextManifest = createContextManifest({
    maxCharacters: budget.maxCharacters,
    maxSummaryCharacters: budget.maxSummaryCharacters,
    maxTurnCharacters: budget.maxTurnCharacters,
    maxMemoryCharacters: budget.maxMemoryCharacters,
    maxTurns: budget.maxTurns,
    maxMemories: budget.maxMemories,
    sourceCharacters,
    includedCharacters,
    sourceTurnCount: context.turns.length,
    eligibleTurnCount: projection.includeTurns ? context.turns.length : 0,
    includedTurnCount: selected.length,
    clippedTurnCount,
    droppedTurnCount:
      (projection.includeTurns ? context.turns.length : 0) - selected.length,
    sourceMemoryCount:
      context.memories.length + (context.retrieved?.length ?? 0),
    eligibleMemoryCount: projection.includeMemories
      ? context.memories.length + (context.retrieved?.length ?? 0)
      : 0,
    includedMemoryCount: memories.length + retrieved.length,
    clippedMemoryCount,
    droppedMemoryCount:
      (projection.includeMemories
        ? context.memories.length + (context.retrieved?.length ?? 0)
        : 0) -
      memories.length - retrieved.length,
    summaryPresent,
    summaryEligible: projection.includeSummary && summaryPresent,
    summaryIncluded: summary !== null,
    summaryClipped:
      (summaryCandidate?.clipped ?? false) ||
      (fittedSummary?.clipped ?? false),
  });

  return {
    context: {
      summary,
      turns: selected,
      memories,
      ...(retrieved.length > 0 ? { retrieved } : {}),
      ...(interactions.length > 0 ? { interactions } : {}),
    },
    manifest,
  };
}

function clipWithStatus(
  value: string,
  maxCharacters: number,
): { value: string; clipped: boolean } {
  const clean = value.trim();
  if (clean.length <= maxCharacters) return { value: clean, clipped: false };
  if (maxCharacters <= 1) {
    return { value: clean.slice(0, maxCharacters), clipped: true };
  }
  return {
    value: `${clean.slice(0, maxCharacters - 1).trimEnd()}…`,
    clipped: true,
  };
}

function contextSourceCharacters(context: HarvyContext): number {
  const summary = context.summary?.trim().length ?? 0;
  const turns = context.turns.reduce(
    (total, turn) => total + turn.text.trim().length + 16,
    0,
  );
  const memories = context.memories.reduce(
    (total, memory) =>
      total + memory.content.trim().length + memory.kind.length + 8,
    0,
  );
  const retrieved = (context.retrieved ?? []).reduce(
    (total, evidence) => total + evidence.text.trim().length + 24,
    0,
  );
  const interactions = (context.interactions ?? []).reduce(
    (total, interaction) =>
      total + interaction.domain.length + interaction.operation.length +
      interaction.reference.length + 32,
    0,
  );
  return summary + turns + memories + retrieved + interactions;
}

function validateBudget(budget: ContextBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Context budget ${name} tidak sah.`);
    }
  }
}
