import { AiError } from "../src/ai/client.js";

export type EvaluationFailureKind = "provider" | "harness";

export function classifyEvaluationFailure(error: unknown): {
  kind: EvaluationFailureKind;
  detail: string;
} {
  const detail =
    error instanceof Error
      ? `${error.name} (${error.message.slice(0, 160)})`
      : typeof error;
  if (error instanceof AiError) {
    return {
      kind:
        error.status === 429 ||
        (error.status !== undefined && error.status >= 500)
          ? "provider"
          : "harness",
      detail,
    };
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      isFetchNetworkError(error))
  ) {
    return { kind: "provider", detail };
  }
  return { kind: "harness", detail };
}

export function ratioOrNull(
  numerator: number,
  denominator: number,
): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number {
  if (values.length === 0) {
    throw new Error("Persentil membutuhkan sedikitnya satu sampel.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] as number;
}

export function percentileOrNull(
  values: readonly number[],
  quantile: number,
): number | null {
  return values.length === 0 ? null : percentile(values, quantile);
}

export function coverageOrNull<T>(
  values: readonly T[],
  covered: (value: T) => boolean,
): number | null {
  return values.length === 0
    ? null
    : values.filter(covered).length / values.length;
}

function isFetchNetworkError(error: Error): boolean {
  if (!(error instanceof TypeError)) return false;
  const code =
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause
      ? String((error.cause as { code?: unknown }).code ?? "")
      : "";
  return (
    /fetch failed|failed to fetch|network|socket/iu.test(
      error.message,
    ) ||
    /^(?:ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)/u.test(code)
  );
}
