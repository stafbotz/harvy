import type { HarvyContext } from "../ai/context.js";
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
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  maxCharacters: 16_000,
  maxSummaryCharacters: 3_000,
  maxTurnCharacters: 2_000,
  maxMemoryCharacters: 400,
  maxTurns: 18,
  maxMemories: 8,
});

export interface ContextProjection {
  includeSummary: boolean;
  includeTurns: boolean;
  includeMemories: boolean;
}

export const FULL_CONTEXT_PROJECTION: ContextProjection = Object.freeze({
  includeSummary: true,
  includeTurns: true,
  includeMemories: true,
});

export const TURNS_ONLY_CONTEXT_PROJECTION: ContextProjection = Object.freeze({
  includeSummary: false,
  includeTurns: true,
  includeMemories: false,
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

  const memoryCandidates = projection.includeMemories
    ? context.memories.slice(0, budget.maxMemories)
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
    sourceMemoryCount: context.memories.length,
    eligibleMemoryCount: projection.includeMemories
      ? context.memories.length
      : 0,
    includedMemoryCount: memories.length,
    clippedMemoryCount,
    droppedMemoryCount:
      (projection.includeMemories ? context.memories.length : 0) -
      memories.length,
    summaryPresent,
    summaryEligible: projection.includeSummary && summaryPresent,
    summaryIncluded: summary !== null,
    summaryClipped:
      (summaryCandidate?.clipped ?? false) ||
      (fittedSummary?.clipped ?? false),
  });

  return { context: { summary, turns: selected, memories }, manifest };
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
  return summary + turns + memories;
}

function validateBudget(budget: ContextBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Context budget ${name} tidak sah.`);
    }
  }
}
