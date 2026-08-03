/**
 * Manifest bebas isi untuk satu proyeksi konteks Harvy.
 *
 * Bentuk ini sengaja datar agar dapat masuk log operasional tanpa membawa
 * prompt, ringkasan, memori, ID, atau teks percakapan. Angka estimasi hanya
 * observability; ia belum menjadi policy pemadatan berbasis token.
 */
export interface ContextManifest {
  readonly version: 1;
  readonly budgetBasis: "characters";
  readonly tokenEstimateMethod: "characters_div_4_v1";
  readonly maxCharacters: number;
  readonly maxSummaryCharacters: number;
  readonly maxTurnCharacters: number;
  readonly maxMemoryCharacters: number;
  readonly maxTurns: number;
  readonly maxMemories: number;
  /** Unit karakter yang sama dengan perhitungan budget, termasuk overhead. */
  readonly sourceCharacters: number;
  readonly includedCharacters: number;
  readonly estimatedTokens: number;
  readonly utilizationPercent: number;
  readonly sourceTurnCount: number;
  readonly eligibleTurnCount: number;
  readonly includedTurnCount: number;
  readonly clippedTurnCount: number;
  readonly droppedTurnCount: number;
  readonly sourceMemoryCount: number;
  readonly eligibleMemoryCount: number;
  readonly includedMemoryCount: number;
  readonly clippedMemoryCount: number;
  readonly droppedMemoryCount: number;
  readonly summaryPresent: boolean;
  readonly summaryEligible: boolean;
  readonly summaryIncluded: boolean;
  readonly summaryClipped: boolean;
}

export type ContextManifestInput = Omit<
  ContextManifest,
  | "version"
  | "budgetBasis"
  | "tokenEstimateMethod"
  | "estimatedTokens"
  | "utilizationPercent"
>;

/** Estimator lama `/4`, sekarang diberi nama agar hasilnya tidak disangka pasti. */
export function estimateContextTokens(characters: number): number {
  if (!Number.isSafeInteger(characters) || characters < 0) {
    throw new Error("Jumlah karakter konteks tidak sah.");
  }
  return Math.ceil(characters / 4);
}

/**
 * Satu pembentuk manifest menjaga arti counter private dan grup tetap sama.
 * Pemilih konteks tetap dimiliki route masing-masing; fungsi ini tidak melihat
 * atau menyimpan isi konteks.
 */
export function createContextManifest(
  input: ContextManifestInput,
): ContextManifest {
  for (const [name, value] of Object.entries(input)) {
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error(`Counter context manifest ${name} tidak sah.`);
    }
  }

  return Object.freeze({
    version: 1,
    budgetBasis: "characters",
    tokenEstimateMethod: "characters_div_4_v1",
    ...input,
    estimatedTokens: estimateContextTokens(input.includedCharacters),
    utilizationPercent:
      input.maxCharacters === 0
        ? 0
        : Math.min(
            100,
            Math.round(
              (input.includedCharacters / input.maxCharacters) * 100,
            ),
          ),
  });
}

/**
 * Mengubah manifest ke scalar allowlist log. Prefix `context` membedakannya
 * dari usage seluruh prompt yang dicatat `AiClient`.
 *
 * Detail jumlah giliran/memori dan keberadaan summary sengaja tetap transient.
 * Log persisten hanya memerlukan kapasitas agregat untuk mengkalibrasi budget;
 * menyimpan struktur percakapan tidak diperlukan pada tahap ini.
 */
export function contextManifestLogFields(
  manifest: ContextManifest,
): Record<string, string | number | boolean> {
  return {
    contextManifestVersion: manifest.version,
    contextBudgetBasis: manifest.budgetBasis,
    contextTokenEstimateMethod: manifest.tokenEstimateMethod,
    contextBudgetCharacters: manifest.maxCharacters,
    contextMaxSummaryCharacters: manifest.maxSummaryCharacters,
    contextMaxTurnCharacters: manifest.maxTurnCharacters,
    contextMaxMemoryCharacters: manifest.maxMemoryCharacters,
    contextMaxTurns: manifest.maxTurns,
    contextMaxMemories: manifest.maxMemories,
    contextIncludedCharacters: manifest.includedCharacters,
    contextEstimatedTokens: manifest.estimatedTokens,
    contextUtilizationPercent: manifest.utilizationPercent,
  };
}
