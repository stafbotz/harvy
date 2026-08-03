const USD_NANOS = 1_000_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

/**
 * Mengubah decimal USD menjadi integer nano-USD tanpa melewati floating point.
 * Lebih dari sembilan digit pecahan dibulatkan half-up.
 */
export function usdDecimalToNanos(value: string): bigint | null {
  const clean = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(clean);
  if (!match) return null;
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (!whole) return null;

  const kept = fraction.slice(0, 9).padEnd(9, "0");
  let nanos = BigInt(whole) * USD_NANOS + BigInt(kept || "0");
  if ((fraction[9] ?? "0") >= "5") nanos += 1n;
  return nanos;
}

export function nanosToUsdDecimal(value: bigint): string {
  if (value < 0n) throw new Error("Nilai uang tidak boleh negatif.");
  const whole = value / USD_NANOS;
  const fraction = (value % USD_NANOS)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Harga diberikan sebagai USD per satu juta token. */
export function tokenCostNanos(
  tokens: number,
  pricePerMillionUsd: string,
): bigint | null {
  const price = usdDecimalToNanos(pricePerMillionUsd);
  if (price === null || !Number.isSafeInteger(tokens) || tokens < 0) {
    return null;
  }
  const numerator = BigInt(tokens) * price;
  return (numerator + TOKENS_PER_MILLION / 2n) / TOKENS_PER_MILLION;
}

export function addNanoUsd(
  ...values: readonly (string | null | undefined)[]
): string {
  return values.reduce<bigint>((sum, value) => {
    if (value === null || value === undefined || !/^\d+$/u.test(value)) {
      return sum;
    }
    return sum + BigInt(value);
  }, 0n).toString();
}

export function validNanoUsd(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value);
}

export function validUsdRate(value: unknown): value is string {
  return typeof value === "string" && usdDecimalToNanos(value) !== null;
}
