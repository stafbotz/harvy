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
  /** Metadata scalar context-pressure; tidak pernah memuat isi prompt. */
  readonly pressure?: ContextPressureMetadata;
}

export interface ContextPressureMetadata {
  readonly applied: boolean;
  readonly recovery: boolean;
  readonly contextWindowTokens: number | null;
  readonly thresholdTokens: number | null;
  readonly compactAtRatioPermille: number;
  readonly maxOutputTokens: number;
  readonly inputTokensBefore: number;
  readonly inputTokensAfter: number;
  readonly nativeMessagesBefore: number;
  readonly nativeMessagesAfter: number;
  readonly observationCount: number;
  readonly clippedObservationCount: number;
}

export type ContextManifestInput = Omit<
  ContextManifest,
  | "version"
  | "budgetBasis"
  | "tokenEstimateMethod"
  | "estimatedTokens"
  | "utilizationPercent"
  | "pressure"
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

/** Menempelkan hasil compiler pressure tanpa mengubah manifest sumber. */
export function withContextPressureMetadata(
  manifest: ContextManifest,
  pressure: ContextPressureMetadata,
): ContextManifest {
  validatePressureMetadata(pressure);
  return Object.freeze({
    ...manifest,
    pressure: Object.freeze({ ...pressure }),
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
  const pressureFields = manifest.pressure
    ? contextPressureLogFields(manifest.pressure)
    : {};
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
    ...pressureFields,
  };
}

function contextPressureLogFields(
  pressure: ContextPressureMetadata,
): Record<string, string | number | boolean> {
  validatePressureMetadata(pressure);
  let windowFields: Record<string, number> = {};
  if (pressure.contextWindowTokens !== null) {
    if (pressure.thresholdTokens === null) {
      throw new Error("Threshold context pressure tidak tersedia.");
    }
    windowFields = {
      contextWindowTokens: pressure.contextWindowTokens,
      contextCompactionThresholdTokens: pressure.thresholdTokens,
    };
  }
  return {
    contextCompactionApplied: pressure.applied,
    contextRecovery: pressure.recovery,
    ...windowFields,
    contextCompactAtRatioPermille: pressure.compactAtRatioPermille,
    contextPressureMaxOutputTokens: pressure.maxOutputTokens,
    contextInputTokensBefore: pressure.inputTokensBefore,
    contextInputTokensAfter: pressure.inputTokensAfter,
    contextNativeMessagesBefore: pressure.nativeMessagesBefore,
    contextNativeMessagesAfter: pressure.nativeMessagesAfter,
    contextObservationCount: pressure.observationCount,
    contextClippedObservationCount: pressure.clippedObservationCount,
  };
}

function validatePressureMetadata(value: ContextPressureMetadata): void {
  const counters = [
    value.compactAtRatioPermille,
    value.maxOutputTokens,
    value.inputTokensBefore,
    value.inputTokensAfter,
    value.nativeMessagesBefore,
    value.nativeMessagesAfter,
    value.observationCount,
    value.clippedObservationCount,
  ];
  if (
    typeof value.applied !== "boolean" ||
    typeof value.recovery !== "boolean" ||
    counters.some((counter) =>
      !Number.isSafeInteger(counter) || counter < 0
    ) ||
    value.compactAtRatioPermille < 1 ||
    value.compactAtRatioPermille >= 1_000 ||
    !validOptionalPositiveInteger(value.contextWindowTokens) ||
    !validOptionalPositiveInteger(value.thresholdTokens) ||
    ((value.contextWindowTokens === null) !==
      (value.thresholdTokens === null)) ||
    (value.contextWindowTokens !== null &&
      value.thresholdTokens !== null &&
      value.thresholdTokens > value.contextWindowTokens) ||
    value.clippedObservationCount > value.observationCount
  ) {
    throw new Error("Metadata context pressure tidak sah.");
  }
}

function validOptionalPositiveInteger(value: number | null): boolean {
  return value === null ||
    (Number.isSafeInteger(value) && value > 0);
}
