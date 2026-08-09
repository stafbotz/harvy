/** Peran model dalam satu tahap kerja, bukan urutan kecerdasan. */
export type ModelRole =
  | "extractor"
  | "classifier"
  | "conversationalist"
  | "planner"
  | "worker"
  | "critic"
  | "synthesizer"
  | "recovery";

/**
 * Nilai provider-neutral. Adapter boleh memetakan ke nilai wire yang lebih
 * sempit, tetapi prompt, model, dan tool output tidak boleh memilihnya.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type Verbosity = "low" | "medium" | "high";

/** Metadata bebas isi yang aman dicatat pada attempt provider. */
export interface ModelExecutionMetadata {
  role: ModelRole;
  requestedEffort: ReasoningEffort;
  /** `null` berarti profile provider/model tidak mengaktifkan kontrol effort. */
  effectiveEffort: ReasoningEffort | null;
  verbosity: Verbosity;
}
