import type { UserUsageSummary } from "./user-usage-summary-service.js";

export type UsageDashboardChannel = "telegram" | "whatsapp" | "plain";
export type UsageCommandMatch = "summary" | "invalid" | null;

export interface RenderedUsageDashboard {
  text: string;
  telegramParseMode: "HTML" | null;
}

export const USAGE_GROUP_PRIVACY_MESSAGE =
  "Untuk menjaga privasimu, lihat penggunaan Harvy dari chat pribadi.";
export const USAGE_COMMAND_TARGET_REJECTED =
  "Perintah /penggunaan hanya menampilkan akunmu sendiri dan tidak menerima nama atau ID pengguna lain.";

interface SemanticFormatter {
  text(value: string): string;
  bold(value: string): string;
}

export function parseUsageDashboardCommand(rawText: string): UsageCommandMatch {
  const text = rawText.trim();
  const match = /^\/(?:penggunaan|usage)(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/iu.exec(text);
  if (!match) return null;
  return (match[1] ?? "").trim() ? "invalid" : "summary";
}

export function renderUsageDashboard(
  summary: UserUsageSummary,
  channel: UsageDashboardChannel,
  timeZone = "Asia/Jakarta",
): RenderedUsageDashboard {
  const format = semanticFormatter(channel);
  const sections: string[][] = [
    [format.bold("Penggunaan Harvy"), "────────────────────────"],
    [format.bold("Paket"), format.text(summary.plan.publicName)],
    [
      format.bold("Periode"),
      format.text(formatPeriod(summary.period.startsAt, summary.period.endsAt, timeZone)),
    ],
    remainingSection(summary, format),
    [
      format.bold("Reset"),
      format.text(formatResetDate(summary.period.resetsAt, summary.period.startsAt, timeZone)),
    ],
    activitySection(summary, format),
    costSection(summary, format),
    fundingSection(summary, format),
  ];
  const efficiency = efficiencySection(summary, format);
  if (efficiency) sections.push(efficiency);
  const current = currentFundingSection(summary, format);
  if (current) sections.push(current);
  if (summary.allowance.state === "exhausted") {
    sections.push([
      summary.plan.isFree
        ? "Penggunaan gratis periode ini sudah terpakai."
        : "Kapasitas paket periode ini sudah terpakai.",
      "",
      "Kamu masih bisa melanjutkan dengan paket Harvy, saldo tambahan, API milikmu, atau menunggu reset.",
    ].map((line) => format.text(line)));
  }
  return {
    text: sections.map((section) => section.join("\n")).join("\n\n"),
    telegramParseMode: channel === "telegram" ? "HTML" : null,
  };
}

const BASIS_POINTS_FULL = 10_000;
const SUBCELLS_PER_CELL = 8;
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * Keeps the established 20-cell rounded bar for ordinary values, while the
 * last cell uses eighth-block precision near full. A non-full allowance can
 * therefore never look identical to an untouched 100% allowance.
 */
export function usageProgressBarFromBasisPoints(
  basisPoints: number,
  cells = 20,
): string {
  const safeCells = Number.isSafeInteger(cells) && cells > 0 && cells <= 100
    ? cells
    : 20;
  const safe = normalizeBasisPoints(basisPoints);
  if (safe === 0) return "░".repeat(safeCells);
  if (safe === BASIS_POINTS_FULL) return "█".repeat(safeCells);

  // Fine-grained rendering is most valuable where a rounded whole-cell bar
  // previously looked full. Quantize the missing fraction conservatively and
  // force at least one missing subcell for every value below 100%.
  if (safe >= 9_500) {
    const totalSubcells = safeCells * SUBCELLS_PER_CELL;
    const usedBasisPoints = BASIS_POINTS_FULL - safe;
    const missingSubcells = Math.max(
      1,
      Math.min(
        totalSubcells,
        Number(
          (BigInt(usedBasisPoints) * BigInt(totalSubcells) + 7_500n) /
            10_000n,
        ),
      ),
    );
    const filledSubcells = totalSubcells - missingSubcells;
    const fullCells = Math.floor(filledSubcells / SUBCELLS_PER_CELL);
    const partial = filledSubcells % SUBCELLS_PER_CELL;
    const partialBlock = PARTIAL_BLOCKS[partial] ?? "";
    const emptyCells = safeCells - fullCells - (partial > 0 ? 1 : 0);
    return `${"█".repeat(fullCells)}${partialBlock}${"░".repeat(emptyCells)}`;
  }

  const roundedCells = Number(
    (BigInt(safe) * BigInt(safeCells) + 5_000n) / 10_000n,
  );
  const filled = Math.max(1, Math.min(safeCells - 1, roundedCells));
  return `${"█".repeat(filled)}${"░".repeat(safeCells - filled)}`;
}

export function formatRemainingPercentage(basisPoints: number): string {
  const safe = normalizeBasisPoints(basisPoints);
  if (safe === BASIS_POINTS_FULL) return "100%";
  if (safe === 0) return "0%";
  if (safe >= 9_900) {
    const precision = nearFullPrecision(safe);
    return formatRoundedBasisPoints(safe, precision);
  }
  if (safe < 100) return formatExactSubOnePercent(safe);
  return `${Math.floor(safe / 100)}%`;
}

export function formatCompactUsage(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "0";
  if (value < 1_000) return value.toString();
  if (value < 1_000_000) return scaled(value, 1_000, "k");
  return scaled(value, 1_000_000, "M");
}

function remainingSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] {
  const remainingBasisPoints = normalizeBasisPoints(
    summary.allowance.remainingBasisPoints,
  );
  const lines = [
    format.bold("Sisa penggunaan"),
    format.text(
      `${usageProgressBarFromBasisPoints(remainingBasisPoints)} ${
        formatRemainingPercentage(remainingBasisPoints)
      }`,
    ),
  ];
  if (remainingBasisPoints < 10_000 && remainingBasisPoints >= 9_900) {
    lines.push(format.text(
      `Terpakai: ${formatUsedPercentage(summary.allowance.usedBasisPoints)}`,
    ));
  }
  if (
    summary.allowance.state === "getting_low" ||
    summary.allowance.state === "low"
  ) {
    lines.push("", format.text("Penggunaanmu hampir habis untuk periode ini."));
  }
  return lines;
}

function normalizeBasisPoints(value: number): number {
  if (!Number.isSafeInteger(value)) return 0;
  return Math.max(0, Math.min(BASIS_POINTS_FULL, value));
}

function nearFullPrecision(remainingBasisPoints: number): 1 | 2 {
  // One decimal is the normal near-full display. Preserve hundredths only
  // when rounding to one decimal would incorrectly produce 100.0%.
  return Math.floor((remainingBasisPoints + 5) / 10) >= 1_000 ? 2 : 1;
}

function formatUsedPercentage(usedBasisPoints: number): string {
  const safeUsed = normalizeBasisPoints(usedBasisPoints);
  const remaining = BASIS_POINTS_FULL - safeUsed;
  const precision = nearFullPrecision(remaining);
  const basisPointsPerDisplayUnit = precision === 1 ? 10 : 1;
  const totalDisplayUnits = precision === 1 ? 1_000 : 10_000;
  const roundedRemainingUnits = Math.floor(
    (remaining + Math.floor(basisPointsPerDisplayUnit / 2)) /
      basisPointsPerDisplayUnit,
  );
  return formatFixedPercent(
    totalDisplayUnits - roundedRemainingUnits,
    precision,
  );
}

function formatRoundedBasisPoints(
  basisPoints: number,
  precision: 1 | 2,
): string {
  const divisor = precision === 1 ? 10 : 1;
  const rounded = Math.floor(
    (basisPoints + Math.floor(divisor / 2)) / divisor,
  );
  return formatFixedPercent(rounded, precision);
}

function formatExactSubOnePercent(basisPoints: number): string {
  const fraction = basisPoints.toString().padStart(2, "0").replace(/0$/u, "");
  return `0.${fraction}%`;
}

function formatFixedPercent(value: number, precision: 1 | 2): string {
  const scale = precision === 1 ? 10 : 100;
  const whole = Math.floor(value / scale);
  const fraction = (value % scale).toString().padStart(precision, "0");
  return `${whole}.${fraction}%`;
}

function activitySection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] {
  const usage = summary.modelUsage;
  const cached = usage.cachedInputTokens !== null && usage.cachedInputTokens > 0
    ? ` (${formatCompactUsage(usage.cachedInputTokens)} cached)`
    : "";
  const lines = [
    format.bold("Aktivitas AI"),
    format.text(`Input: ${formatCompactUsage(usage.inputTokens)}${cached}`),
    format.text(`Output: ${formatCompactUsage(usage.outputTokens)}`),
  ];
  if (usage.reasoningTokens !== null) {
    lines.push(format.text(`Reasoning: ${formatCompactUsage(usage.reasoningTokens)}`));
  }
  if (usage.hasEstimatedUsage) {
    lines.push(format.text("Sebagian angka aktivitas merupakan perkiraan."));
  }
  return lines;
}

function costSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] {
  const lines = [format.bold("Biaya penggunaan AI")];
  const total = summary.cost.totalProviderCostUsdNanos;
  if (summary.cost.completeness === "complete" && total !== null) {
    lines.push(format.text(`Total: ${formatUsd(total)}`));
  } else if (total !== null) {
    lines.push(
      format.text(`Total tercatat: ${formatUsd(total)}`),
      format.text("Sebagian penggunaan belum dapat dihitung."),
    );
  } else {
    lines.push(format.text("Sebagian biaya belum dapat dihitung."));
  }
  return lines;
}

function fundingSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] {
  const { funding } = summary;
  const lines = [format.bold("Sumber biaya")];
  const included = BigInt(funding.includedUsdNanos);
  const overhead = BigInt(funding.harvyOverheadUsdNanos);
  const byok = BigInt(funding.byokUsdNanos);
  const sponsored = BigInt(funding.sponsoredUsdNanos);
  const current = funding.current?.type ?? null;
  if (summary.plan.isFree) {
    const harvy = included + overhead;
    if (harvy > 0n || current === "free") {
      lines.push(format.text(`• Ditanggung Harvy: ${formatUsd(harvy.toString())}`));
    }
  } else {
    if (included > 0n || current === "plan") {
      lines.push(format.text(`• Termasuk paket: ${formatUsd(included.toString())}`));
    }
    if (overhead > 0n) {
      lines.push(format.text(`• Ditanggung Harvy: ${formatUsd(overhead.toString())}`));
    }
  }
  if (sponsored > 0n || current === "sponsored") {
    lines.push(format.text(`• Akses bersponsor: ${formatUsd(sponsored.toString())}`));
  }
  if (byok > 0n || current === "byok") {
    lines.push(format.text(`• API milikmu: ${formatUsd(byok.toString())}`));
  }
  if (funding.paygUsed || funding.paygRelevant || current === "payg") {
    lines.push(format.text(
      funding.paygIdr === null
        ? "• Saldo tambahan: jumlah belum tersedia"
        : `• Saldo tambahan: ${formatIdr(funding.paygIdr)}`,
    ));
  }
  if (lines.length === 1) {
    lines.push(format.text("Belum ada biaya pada periode ini."));
  }
  return lines;
}

function efficiencySection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] | null {
  const hit = summary.efficiency.cacheHitPercent;
  const cached = summary.modelUsage.cachedInputTokens;
  if (hit === null) return null;
  const lines = [format.bold("Efisiensi"), format.text(`Cache hit: ${hit}%`)];
  if (cached !== null && cached > 0) {
    lines.push(format.text(
      summary.efficiency.cacheSavingsUsdNanos === null
        ? "Hemat dari cache: Belum dapat dihitung"
        : `Hemat dari cache: ≈ ${formatUsd(summary.efficiency.cacheSavingsUsdNanos)}`,
    ));
  }
  return lines;
}

function currentFundingSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
): string[] | null {
  const current = summary.funding.current;
  if (!current) return null;
  let label: string;
  switch (current.type) {
    case "free":
      label = "Penggunaan gratis Harvy";
      break;
    case "plan":
      label = `Kuota paket ${current.publicName}`;
      break;
    case "payg":
      label = "Saldo tambahan";
      break;
    case "byok":
      label = `API milikmu · ${current.providerName}`;
      break;
    case "sponsored":
      label = "Akses bersponsor";
      break;
  }
  return [format.bold("Saat ini menggunakan"), format.text(label)];
}

function semanticFormatter(channel: UsageDashboardChannel): SemanticFormatter {
  if (channel === "telegram") {
    return {
      text: escapeTelegramHtml,
      bold: (value) => `<b>${escapeTelegramHtml(value)}</b>`,
    };
  }
  if (channel === "whatsapp") {
    return {
      text: escapeWhatsApp,
      bold: (value) => `*${escapeWhatsApp(value)}*`,
    };
  }
  return { text: (value) => value, bold: (value) => value };
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeWhatsApp(value: string): string {
  return value.replace(/([\\*_~`])/gu, "\\$1");
}

function formatPeriod(startsAt: string, endsAt: string, timeZone: string): string {
  return `${formatShortDate(startsAt, timeZone)} – ${formatShortDate(endsAt, timeZone)}`;
}

function formatShortDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(value)).replace(/\./gu, "");
}

function formatResetDate(value: string, startsAt: string, timeZone: string): string {
  const startYear = datePart(startsAt, timeZone, "year");
  const resetYear = datePart(value, timeZone, "year");
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    ...(startYear !== resetYear ? { year: "numeric" as const } : {}),
    timeZone,
  }).format(new Date(value));
}

function datePart(value: string, timeZone: string, type: "year"): string {
  return new Intl.DateTimeFormat("id-ID", { year: "numeric", timeZone })
    .formatToParts(new Date(value))
    .find((part) => part.type === type)?.value ?? "";
}

function scaled(value: number, divisor: number, suffix: string): string {
  const tenths = (BigInt(value) * 10n + BigInt(divisor) / 2n) / BigInt(divisor);
  const whole = tenths / 10n;
  const decimal = tenths % 10n;
  return `${whole}${decimal === 0n ? "" : `.${decimal}`}${suffix}`;
}

function formatUsd(value: string): string {
  const nanos = BigInt(value);
  const cents = (nanos + 5_000_000n) / 10_000_000n;
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function formatIdr(value: string): string {
  const clean = BigInt(value).toString();
  return `Rp${clean.replace(/\B(?=(\d{3})+(?!\d))/gu, ".")}`;
}
