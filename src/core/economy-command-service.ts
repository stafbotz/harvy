import { randomUUID } from "node:crypto";
import type { EconomyService } from "./economy-service.js";
import { renderUsageDashboard } from "./usage-dashboard-renderer.js";
import type { UserUsageSummaryService } from "./user-usage-summary-service.js";
import { PERSONAL_PLAN_IDS } from "../domain/control-plane.js";
import {
  semanticOperationAuthorized,
  type SemanticOperation,
} from "../domain/semantic-operation.js";

export interface EconomySemanticRequest {
  rawText: string;
  semanticOperation: SemanticOperation | null | undefined;
}

/**
 * Deterministic, content-free account command surface. Natural language is
 * understood once by the bounded semantic compiler; this service only grants
 * closed operations and never interprets synonyms itself.
 */
export class EconomyCommandService {
  constructor(
    private readonly economy: EconomyService,
    private readonly usageDashboard: Pick<UserUsageSummaryService, "summary"> | null = null,
  ) {}

  async handle(
    ownerId: string,
    request: EconomySemanticRequest,
    requestId: string | null = null,
  ): Promise<string | null> {
    const rawText = request.rawText;
    const semantic = request.semanticOperation;
    if (!rawText.trim()) return null;

    // A credential accidentally pasted into chat must never be copied into
    // conversation memory. The bot also skips history for every deterministic
    // economy command, but this guard keeps the authority safe outside it.
    const credentialReply = economyCredentialSafetyReply(rawText);
    if (credentialReply) return credentialReply;
    if (!semantic) return null;

    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "usage",
      operations: ["show-summary", "show-details"],
      minConfidence: 0.75,
      explicitness: ["explicit", "contextual"],
      references: ["none", "current", "recent"],
    })) {
      if (this.usageDashboard) {
        return renderUsageDashboard(
          await this.usageDashboard.summary(ownerId),
          "plain",
        ).text;
      }
      return renderUsage(await this.economy.usage(ownerId));
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["recommend-plan"],
      minConfidence: 0.8,
      explicitness: ["explicit", "contextual"],
    })) {
      const recommendation = await this.economy.recommendPlan(ownerId);
      if (recommendation.kind === "none") {
        return "Paketmu saat ini sudah paling sesuai dengan pemakaian yang tercatat. Aku tidak akan mendorong paket yang lebih mahal tanpa alasan.";
      }
      const action = recommendation.kind === "downgrade" ? "menurunkan" : "memilih";
      return `Dari pemakaianmu, paket yang kemungkinan cukup adalah ${recommendation.recommendedPublicName ?? recommendation.recommendedPlanId} (${recommendation.monthlyPriceIdr === null ? "harga belum tersedia" : `Rp${recommendation.monthlyPriceIdr.toLocaleString("id-ID")}`}). Ini rekomendasi untuk ${action} biaya secukupnya; keputusan tetap di tanganmu.`;
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["select-plan"],
      minConfidence: 0.9,
      explicitness: ["explicit"],
    })) {
      const requestedPlan = requestedPlanId(semantic.target);
      if (!requestedPlan) {
        return "Aku belum bisa memastikan paket yang kamu pilih. Buka /menu lalu pilih Penggunaan & paket untuk melihat pilihan yang tersedia.";
      }
      if (requestedPlan === "personal_perkenalan") {
        return "Perkenalan adalah Free dan tidak memerlukan checkout. Kapasitasnya akan diperbarui sesuai periode yang tertera di penggunaan Harvy.";
      }
      try {
        const checkout = await this.economy.createSubscriptionCheckoutForPlan(
          ownerId,
          requestedPlan,
          commandIdempotency("chat-subscription", requestId),
        );
        return checkout.checkoutUrl
          ? `Checkout paket siap: ${checkout.checkoutUrl}`
          : "Permintaan paket dicatat melalui gateway yang dikonfigurasi.";
      } catch (error) {
        if (error instanceof Error && /belum tersedia|gateway/i.test(error.message)) {
          return "Pembayaran langsung belum tersedia pada instalasi ini. Free, BYOK, dan menunggu pembaruan kapasitas tetap tersedia.";
        }
        throw error;
      }
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["set-funding"],
      minConfidence: 0.9,
      explicitness: ["explicit"],
    })) {
      switch (normalizeTarget(semantic.target)) {
        case "wallet-off":
          await this.economy.setFundingPreference(ownerId, { autoUseWallet: false });
          return "Saldo tambah compute tidak akan digunakan otomatis. Harvy akan memakai allowance yang tersedia, BYOK sesuai pilihanmu, atau berhenti dengan penjelasan sebelum memakai saldo.";
        case "wallet-on":
          await this.economy.setFundingPreference(ownerId, { autoUseWallet: true });
          return "Penggunaan saldo tambah compute otomatis diaktifkan. Harvy tetap tidak akan membuat saldo negatif atau menagih tanpa saldo yang sudah kamu tambahkan.";
        case "harvy-first":
          await this.economy.setFundingPreference(ownerId, { mode: "harvy_first" });
          return "Preference funding Harvy-first diaktifkan: allowance dan sponsor dipakai lebih dulu, lalu PAYG hanya bila kamu mengizinkannya, kemudian BYOK. Kualitas dan escalation ceiling tidak berubah.";
        case "byok-first":
          await this.economy.setFundingPreference(ownerId, { mode: "byok_first" });
          return "Preference BYOK diutamakan. Jika credential tidak mampu atau gagal, Harvy akan menjelaskan pilihan berikutnya dan tidak memakai saldo Harvy/PAYG tanpa policy yang sesuai.";
        default:
          return "Aku belum bisa memastikan preference funding yang kamu maksud, jadi tidak ada pengaturan yang diubah.";
      }
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["setup-byok"],
      minConfidence: 0.8,
      explicitness: ["explicit", "contextual"],
    })) {
      return this.economy.secureByokSetupAvailable
        ? "Secure setup BYOK tersedia melalui Harvy Console lokal yang terautentikasi. Jangan kirim API key di chat; Console hanya mengembalikan metadata tersamarkan, sementara secret disimpan terenkripsi dan dapat dicabut kapan saja."
        : "Runtime Harvy mendukung BYOK, tetapi secure secret store belum dikonfigurasi pada instalasi ini. Jangan kirim API key di chat; operator perlu menyiapkan secure setup terlebih dahulu.";
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["cancel-subscription"],
      minConfidence: 0.9,
      explicitness: ["explicit"],
    })) {
      const subscription = await this.economy.cancelSubscription(ownerId);
      if (!subscription) return "Tidak ada langganan aktif yang perlu dibatalkan. Free tetap tersedia.";
      return `Pembatalan dicatat untuk akhir periode pada ${formatDate(subscription.currentPeriodEnd)}. Kapasitas yang termasuk tetap berlaku sampai periode selesai.`;
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["dismiss-support"],
      minConfidence: 0.9,
      explicitness: ["explicit"],
    })) {
      await this.economy.dismissSupport(ownerId);
      return "Baik, pengingat kontribusi Harvy Commons tidak akan ditampilkan lagi selama masa cooldown. Kontribusi tetap opsional dan tidak memengaruhi kualitas Harvy.";
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["show-support", "contribute"],
      minConfidence: 0.8,
      explicitness: ["explicit", "contextual"],
    })) {
      const contributionAmount = semantic.operation === "contribute"
        ? parseMoneyAmount(rawText)
        : null;
      if (contributionAmount !== null) {
        try {
          const checkout = await this.economy.createContributionCheckout(
            ownerId,
            contributionAmount,
            commandIdempotency("chat-contribution", requestId),
          );
          return checkout.checkoutUrl
            ? `Checkout kontribusi Harvy Commons siap: ${checkout.checkoutUrl}`
            : "Permintaan kontribusi dicatat melalui gateway yang dikonfigurasi.";
        } catch (error) {
          if (error instanceof Error && /belum tersedia|gateway/i.test(error.message)) {
            return "Pembayaran langsung belum tersedia pada instalasi ini. Kontribusi tetap opsional dan Free tidak bergantung pada pembayaran.";
          }
          throw error;
        }
      }
      return "Harvy bisa digunakan gratis. Jika kamu mampu dan ingin membantu menjaga akses gratis bagi pengguna lain, kamu dapat memberikan kontribusi sukarela melalui jalur pembayaran yang tersedia. Kontribusi ini opsional dan tidak memengaruhi kualitas jawaban atau akses Free.";
    }
    if (semanticOperationAuthorized(rawText, semantic, {
      domain: "billing",
      operations: ["top-up"],
      minConfidence: 0.9,
      explicitness: ["explicit"],
    })) {
      const amount = parseMoneyAmount(rawText);
      if (amount === null) {
        return "Sebutkan nominal tambah compute secara jelas, misalnya Rp50.000. Tidak ada pembayaran yang dibuat.";
      }
      try {
        const checkout = await this.economy.createTopupCheckout(
          ownerId,
          amount,
          commandIdempotency("chat-topup", requestId),
        );
        return checkout.checkoutUrl
          ? `Checkout tambah compute siap: ${checkout.checkoutUrl}`
          : "Permintaan tambah compute dicatat. Instruksi pembayaran akan tersedia melalui gateway yang dikonfigurasi.";
      } catch (error) {
        if (error instanceof Error && /belum tersedia|gateway/i.test(error.message)) {
          return "Pembayaran langsung belum tersedia pada instalasi ini. Free, BYOK, dan pendaftaran pilot tetap dapat digunakan.";
        }
        throw error;
      }
    }
    return null;
  }
}

export function economyCredentialSafetyReply(rawText: string): string | null {
  return containsLikelyCredential(rawText)
    ? "Demi keamanan, jangan kirim API key melalui chat. Gunakan secure setup provider pada deployment ini; key yang tertempel tidak dapat diproses dari percakapan."
    : null;
}

function commandIdempotency(prefix: string, requestId: string | null): string {
  const safe = requestId?.trim();
  return `${prefix}:${safe && safe.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(safe) ? safe : randomUUID()}`;
}

function containsLikelyCredential(value: string): boolean {
  return /\b(?:sk-(?:proj-|ant-|or-)?|xai-|AIza)[A-Za-z0-9_.-]{12,}\b/u.test(value);
}

function parseMoneyAmount(text: string): number | null {
  const normalized = text.toLocaleLowerCase("und");
  const match = /(?:rp|idr)\s*([\d.,]+)|([\d.,]+)\s*(?:rupiah|rb|ribu)/u.exec(normalized);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").replace(/[.,]/gu, "");
  const amount = Number(raw) * (/(?:\brb\b|\bribu\b)/u.test(normalized) ? 1_000 : 1);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function requestedPlanId(target: string | null): typeof PERSONAL_PLAN_IDS[keyof typeof PERSONAL_PLAN_IDS] | null {
  const value = normalizeTarget(target);
  for (const [label, planId] of Object.entries(PERSONAL_PLAN_IDS)) {
    const publicName = planId.replace(/^personal_/u, "");
    if (value === label || value === publicName || value === planId) return planId;
  }
  return null;
}

function normalizeTarget(value: string | null): string {
  return (value ?? "").normalize("NFKC").trim().toLocaleLowerCase("und");
}

function renderUsage(view: Awaited<ReturnType<EconomyService["usage"]>>): string {
  const status = view.health === "healthy"
    ? "Banyak tersisa"
    : view.health === "getting_low"
      ? "Cukup"
      : view.health === "low"
        ? "Hampir habis"
        : "Sudah terpakai";
  return [
    "Penggunaan Harvy",
    status,
    `Paket: ${view.planName}`,
    `Kapasitas yang termasuk diperbarui ${formatDate(view.nextResetAt)}.`,
    view.walletComputeUnits !== "0"
      ? "Saldo tambah compute tersedia, tetapi tidak digunakan otomatis kecuali kamu mengizinkannya."
      : "Kamu dapat menambah compute, memakai BYOK, atau menunggu pembaruan berikutnya.",
  ].join("\n");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}
