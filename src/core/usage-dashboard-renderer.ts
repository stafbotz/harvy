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
  now: Date = new Date(),
): RenderedUsageDashboard {
  const format = semanticFormatter(channel);
  const sections: string[][] = [
    [format.bold(`Penggunaan Harvy · ${summary.plan.publicName}`)],
    remainingSection(summary, format, timeZone, now),
    contextSection(summary, format, timeZone),
  ];
  if (summary.allowance.state === "exhausted") {
    sections.push([
      summary.plan.isFree
        ? "Penggunaan gratis periode ini sudah terpakai."
        : "Kapasitas paket periode ini sudah terpakai.",
      "Kamu masih bisa melanjutkan dengan paket Harvy, saldo tambahan, API milikmu, atau menunggu reset.",
    ].map((line) => format.text(line)));
  }
  return {
    // Bagian kosong tidak boleh meninggalkan baris kosong ganda.
    text: sections
      .filter((section) => section.length > 0)
      .map((section) => section.join("\n"))
      .join("\n\n"),
    telegramParseMode: channel === "telegram" ? "HTML" : null,
  };
}

/**
 * Ambang saat jam pemulihan lebih berguna daripada penjelasan mekanismenya.
 *
 * Satu giliran percakapan memakan sekitar 2% jatah harian pada plan Perkenalan
 * (diukur 6 September 2026: 35 giliran menghabiskan 77% jatah). Seperempat
 * jatah karena itu berarti belasan giliran lagi—titik ketika "kapan aku bisa
 * lanjut" mulai menjadi pertanyaan nyata, dan penjelasan cara kerja jendela
 * berhenti menolong.
 */
const RECOVERY_HINT_BASIS_POINTS = 2_500;

/**
 * Sisa yang benar-benar bisa dipakai sekarang.
 *
 * Menjawab satu pertanyaan: berapa banyak lagi sebelum ada yang menghentikan.
 * Sampai 6 September 2026 baris ini menampilkan kuota periode, dan pada plan
 * Perkenalan kuota itu tepat 30 kali jatah hariannya—sehingga ia hampir tidak
 * pernah bisa turun jauh dan membaca 97% pada hari pengguna benar-benar
 * terhenti.
 */
function remainingSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
  timeZone: string,
  now: Date,
): string[] {
  const remaining = normalizeBasisPoints(
    summary.effectiveAllowance.remainingBasisPoints,
  );
  const lines = [
    format.bold("Sisa sekarang"),
    format.text(
      `${usageProgressBarFromBasisPoints(remaining)} ${
        formatRemainingPercentage(remaining)
      }`,
    ),
  ];
  const note = remainingNote(summary, remaining, timeZone, now);
  if (note) lines.push(format.text(note));
  return lines;
}

/**
 * Keterangan di bawah batang: mekanisme saat longgar, jam pemulihan saat mepet.
 *
 * Penjelasan cara kerja berguna sekali lalu menjadi kebisingan; jam pemulihan
 * berguna tiap kali pengguna mepet. Keduanya karena itu tidak pernah tampil
 * bersamaan.
 */
function remainingNote(
  summary: UserUsageSummary,
  remaining: number,
  timeZone: string,
  now: Date,
): string | null {
  if (summary.effectiveAllowance.binding !== "rolling") {
    const state = summary.allowance.state;
    return state === "getting_low" || state === "low" || state === "exhausted"
      ? "Kuota periode hampir habis, pulih saat reset"
      : null;
  }
  const jam = summary.rollingAllowance.windowHours;
  const recoversAt = summary.rollingAllowance.recoversAt;
  if (remaining <= RECOVERY_HINT_BASIS_POINTS && recoversAt) {
    const at = new Date(recoversAt);
    if (at.getTime() > now.getTime()) {
      return `Jatah nambah lagi sekitar ${formatClock(at, timeZone, now)}`;
    }
  }
  return `Batas ${jam} jam terakhir, bukan per hari`;
}

/** Baris pendamping: kolam periode, aktivitas, dan siapa yang menanggung. */
function contextSection(
  summary: UserUsageSummary,
  format: SemanticFormatter,
  timeZone: string,
): string[] {
  const usage = summary.modelUsage;
  const cached = usage.cachedInputTokens !== null && usage.cachedInputTokens > 0
    ? ` (${formatCompactUsage(usage.cachedInputTokens)} cache)`
    : "";
  const lines = [
    format.text(
      `Kuota periode ${
        formatRemainingPercentage(
          normalizeBasisPoints(summary.allowance.remainingBasisPoints),
        )
      } · reset ${
        formatResetDate(summary.period.resetsAt, summary.period.startsAt, timeZone)
      }`,
    ),
    format.text(
      `Aktivitas ${formatCompactUsage(usage.inputTokens)} masuk${cached} · ${
        formatCompactUsage(usage.outputTokens)
      } keluar${usage.hasEstimatedUsage ? " (sebagian perkiraan)" : ""}`,
    ),
  ];
  const funding = fundingLine(summary);
  if (funding) lines.push(format.text(funding));
  return lines;
}

/**
 * Satu baris untuk siapa yang menanggung biayanya.
 *
 * Menggantikan dua seksi lama—daftar "Sumber biaya" dan "Saat ini
 * menggunakan"—yang pada akun gratis biasa berisi satu butir dan satu label
 * yang mengatakan hal yang sama.
 */
function fundingLine(summary: UserUsageSummary): string | null {
  const { funding } = summary;
  const included = BigInt(funding.includedUsdNanos);
  const overhead = BigInt(funding.harvyOverheadUsdNanos);
  const byok = BigInt(funding.byokUsdNanos);
  const sponsored = BigInt(funding.sponsoredUsdNanos);
  const current = funding.current?.type ?? null;
  const parts: string[] = [];
  if (summary.plan.isFree) {
    const harvy = included + overhead;
    if (harvy > 0n || current === "free") {
      parts.push(`Ditanggung Harvy ${formatUsd(harvy.toString())}`);
    }
  } else {
    if (included > 0n || current === "plan") {
      parts.push(`Termasuk paket ${formatUsd(included.toString())}`);
    }
    if (overhead > 0n) {
      parts.push(`Ditanggung Harvy ${formatUsd(overhead.toString())}`);
    }
  }
  if (sponsored > 0n || current === "sponsored") {
    parts.push(`Bersponsor ${formatUsd(sponsored.toString())}`);
  }
  if (byok > 0n || current === "byok") {
    parts.push(`API milikmu ${formatUsd(byok.toString())}`);
  }
  if (funding.paygUsed || funding.paygRelevant || current === "payg") {
    parts.push(
      funding.paygIdr === null
        ? "Saldo tambahan: jumlah belum tersedia"
        : `Saldo tambahan ${formatIdr(funding.paygIdr)}`,
    );
  }
  if (parts.length === 0) return "Belum ada biaya pada periode ini";
  const incomplete = summary.cost.completeness !== "complete"
    ? " · sebagian biaya belum terhitung"
    : "";
  return `${parts.join(" · ")}${incomplete}`;
}

/**
 * Jam pemulihan, dengan "besok" ketika tanggalnya memang berbeda.
 *
 * Jendela berjalan membuat pemulihan selalu berada di dalam 24 jam ke depan,
 * jadi tanggal yang berbeda hanya bisa berarti besok. Tanpa kata itu, keluaran
 * pertama di kanal nyata berbunyi "sekitar pukul 12.51" pada pukul 19.00—jam
 * yang sudah lewat hari itu, dan pembacanya tidak punya cara tahu bahwa yang
 * dimaksud hari berikutnya.
 */
function formatClock(value: Date, timeZone: string, now: Date): string {
  const hari = new Intl.DateTimeFormat("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const besok = hari.format(value) !== hari.format(now) ? "besok " : "";
  return `${besok}pukul ${
    new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(value).replace(":", ".")
  }`;
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



function normalizeBasisPoints(value: number): number {
  if (!Number.isSafeInteger(value)) return 0;
  return Math.max(0, Math.min(BASIS_POINTS_FULL, value));
}

function nearFullPrecision(remainingBasisPoints: number): 1 | 2 {
  // One decimal is the normal near-full display. Preserve hundredths only
  // when rounding to one decimal would incorrectly produce 100.0%.
  return Math.floor((remainingBasisPoints + 5) / 10) >= 1_000 ? 2 : 1;
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
