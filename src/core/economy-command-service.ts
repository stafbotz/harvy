import { randomUUID } from "node:crypto";
import type { EconomyService } from "./economy-service.js";
import { renderUsageDashboard } from "./usage-dashboard-renderer.js";
import type { UserUsageSummaryService } from "./user-usage-summary-service.js";

/**
 * Deterministic, content-free account command surface. It intentionally only
 * recognizes narrow account/billing phrases; ordinary conversation still
 * goes through the normal understanding/runtime path.
 */
export class EconomyCommandService {
  constructor(
    private readonly economy: EconomyService,
    private readonly usageDashboard: Pick<UserUsageSummaryService, "summary"> | null = null,
  ) {}

  async handle(
    ownerId: string,
    rawText: string,
    requestId: string | null = null,
  ): Promise<string | null> {
    const text = normalize(rawText);
    if (!text) return null;

    // A credential accidentally pasted into chat must never be copied into
    // conversation memory. The bot also skips history for every deterministic
    // economy command, but this guard keeps the authority safe outside it.
    if (containsLikelyCredential(rawText)) {
      return "Demi keamanan, jangan kirim API key melalui chat. Gunakan secure setup provider pada deployment ini; key yang tertempel tidak dapat diproses dari percakapan.";
    }

    if (isUsageQuery(text)) {
      if (this.usageDashboard) {
        return renderUsageDashboard(
          await this.usageDashboard.summary(ownerId),
          "plain",
        ).text;
      }
      return renderUsage(await this.economy.usage(ownerId));
    }
    if (isPlanRecommendation(text)) {
      const recommendation = await this.economy.recommendPlan(ownerId);
      if (recommendation.kind === "none") {
        return "Paketmu saat ini sudah paling sesuai dengan pemakaian yang tercatat. Aku tidak akan mendorong paket yang lebih mahal tanpa alasan.";
      }
      const action = recommendation.kind === "downgrade" ? "menurunkan" : "memilih";
      return `Dari pemakaianmu, paket yang kemungkinan cukup adalah ${recommendation.recommendedPublicName ?? recommendation.recommendedPlanId} (${recommendation.monthlyPriceIdr === null ? "harga belum tersedia" : `Rp${recommendation.monthlyPriceIdr.toLocaleString("id-ID")}`}). Ini rekomendasi untuk ${action} biaya secukupnya; keputusan tetap di tanganmu.`;
    }
    const requestedPlan = parseRequestedPlan(text);
    if (requestedPlan) {
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
    if (isWalletDisable(text)) {
      await this.economy.setFundingPreference(ownerId, { autoUseWallet: false });
      return "Saldo tambah compute tidak akan digunakan otomatis. Harvy akan memakai allowance yang tersedia, BYOK sesuai pilihanmu, atau berhenti dengan penjelasan sebelum memakai saldo.";
    }
    if (isWalletEnable(text)) {
      await this.economy.setFundingPreference(ownerId, { autoUseWallet: true });
      return "Penggunaan saldo tambah compute otomatis diaktifkan. Harvy tetap tidak akan membuat saldo negatif atau menagih tanpa saldo yang sudah kamu tambahkan.";
    }
    if (isHarvyFirstPreference(text)) {
      await this.economy.setFundingPreference(ownerId, { mode: "harvy_first" });
      return "Preference funding Harvy-first diaktifkan: allowance dan sponsor dipakai lebih dulu, lalu PAYG hanya bila kamu mengizinkannya, kemudian BYOK. Kualitas dan escalation ceiling tidak berubah.";
    }
    if (isByokRequest(text)) {
      if (isByokPreference(text)) {
        await this.economy.setFundingPreference(ownerId, { mode: "byok_first" });
        return "Preference BYOK diutamakan. Jika credential tidak mampu atau gagal, Harvy akan menjelaskan pilihan berikutnya dan tidak memakai saldo Harvy/PAYG tanpa policy yang sesuai.";
      }
      return this.economy.secureByokSetupAvailable
        ? "Secure setup BYOK tersedia melalui Harvy Console lokal yang terautentikasi. Jangan kirim API key di chat; Console hanya mengembalikan metadata tersamarkan, sementara secret disimpan terenkripsi dan dapat dicabut kapan saja."
        : "Runtime Harvy mendukung BYOK, tetapi secure secret store belum dikonfigurasi pada instalasi ini. Jangan kirim API key di chat; operator perlu menyiapkan secure setup terlebih dahulu.";
    }
    if (isCancelSubscription(text)) {
      const subscription = await this.economy.cancelSubscription(ownerId);
      if (!subscription) return "Tidak ada langganan aktif yang perlu dibatalkan. Free tetap tersedia.";
      return `Pembatalan dicatat untuk akhir periode pada ${formatDate(subscription.currentPeriodEnd)}. Kapasitas yang termasuk tetap berlaku sampai periode selesai.`;
    }
    if (isSupportDismiss(text)) {
      await this.economy.dismissSupport(ownerId);
      return "Baik, pengingat kontribusi Harvy Commons tidak akan ditampilkan lagi selama masa cooldown. Kontribusi tetap opsional dan tidak memengaruhi kualitas Harvy.";
    }
    if (isSupportRequest(text)) {
      const contributionAmount = parseContributionAmount(text);
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
    const amount = parseTopupAmount(text);
    if (amount !== null) {
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

function commandIdempotency(prefix: string, requestId: string | null): string {
  const safe = requestId?.trim();
  return `${prefix}:${safe && safe.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(safe) ? safe : randomUUID()}`;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID").replace(/\s+/gu, " ");
}

function containsLikelyCredential(value: string): boolean {
  return /\b(?:sk-(?:proj-|ant-|or-)?|xai-|AIza)[A-Za-z0-9_.-]{12,}\b/u.test(value);
}

function isUsageQuery(text: string): boolean {
  return text === "/penggunaan" ||
    text.includes("sisa penggunaan") ||
    text.includes("sisa pemakaian") ||
    text.includes("kapan penggunaan gratis") ||
    text.includes("kapan pemakaian gratis") ||
    text === "paketku" || text === "paket saya" || text.includes("paketku apa");
}

function isPlanRecommendation(text: string): boolean {
  return text.includes("paket paling murah") ||
    text.includes("paket termurah") ||
    text.includes("paket yang cocok") ||
    text.includes("paket mana") ||
    text.includes("downgrade");
}

function parseRequestedPlan(text: string): "personal_perkenalan" | "personal_toro" | "personal_sora" | "personal_kuro" | null {
  if (!/(?:berlangganan|pilih|ambil|mau paket|upgrade ke|pakai paket)/u.test(text)) return null;
  if (text.includes("perkenalan") || text.includes("free")) return "personal_perkenalan";
  if (text.includes("toro") || text.includes("plus")) return "personal_toro";
  if (text.includes("sora") || text.includes("pro")) return "personal_sora";
  if (text.includes("kuro") || text.includes("max")) return "personal_kuro";
  return null;
}

function isWalletDisable(text: string): boolean {
  return text.includes("jangan gunakan saldo payg") ||
    text.includes("jangan gunakan saldo tambah") ||
    text.includes("jangan pakai saldo");
}

function isWalletEnable(text: string): boolean {
  return text.includes("gunakan saldo payg otomatis") ||
    text.includes("gunakan saldo tambah otomatis") ||
    text.includes("pakai saldo otomatis");
}

function isByokRequest(text: string): boolean {
  return text.includes("api openai-ku") ||
    text.includes("api openai saya") ||
    text.includes("api provider-ku") ||
    text.includes("provider milikku") ||
    text.includes("api-ku sendiri") ||
    text.includes("byok");
}

function isByokPreference(text: string): boolean {
  return text.includes("gunakan api") &&
    (text.includes("dulu") || text.includes("selalu")) ||
    text.includes("byok dulu") || text.includes("provider saya dulu");
}

function isHarvyFirstPreference(text: string): boolean {
  return text.includes("gunakan compute harvy dulu") ||
    text.includes("pakai compute harvy dulu") ||
    text.includes("jangan utamakan byok") ||
    text.includes("jangan pakai provider saya dulu");
}

function isCancelSubscription(text: string): boolean {
  return text.includes("berhenti berlangganan") ||
    text.includes("batalkan langganan") ||
    text.includes("cancel subscription");
}

function isSupportRequest(text: string): boolean {
  return text === "/dukung" || text.includes("dukung harvy") ||
    text.includes("bantu harvy") || text.includes("harvy commons");
}

function isSupportDismiss(text: string): boolean {
  return text === "/dukung nanti" ||
    text.includes("jangan tawarkan dukungan") ||
    text.includes("jangan ingatkan kontribusi") ||
    ((text.includes("tidak sekarang") || text.includes("nanti saja")) &&
      (text.includes("dukung") || text.includes("kontribusi") || text.includes("commons")));
}

function parseTopupAmount(text: string): number | null {
  if (!text.includes("tambah") && !text.includes("top up") && !text.includes("topup")) return null;
  if (!text.includes("compute") && !text.includes("saldo")) return null;
  const match = /(?:rp|idr)\s*([\d.,]+)|([\d.,]+)\s*(?:rupiah|rb|ribu)/u.exec(text);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").replace(/[.,]/gu, "");
  const amount = Number(raw) * (/(?:\brb\b|\bribu\b)/u.test(text) ? 1_000 : 1);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function parseContributionAmount(text: string): number | null {
  if (!text.includes("rp") && !text.includes("idr") && !text.includes("rupiah")) return null;
  const match = /(?:rp|idr)\s*([\d.,]+)|([\d.,]+)\s*(?:rupiah|rb|ribu)/u.exec(text);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").replace(/[.,]/gu, "");
  const amount = Number(raw) * (/(?:\brb\b|\bribu\b)/u.test(text) ? 1_000 : 1);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
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
