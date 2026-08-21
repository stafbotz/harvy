import type { PaymentPurpose } from "../domain/economy.js";

export interface PaymentCheckoutRequest {
  idempotencyKey: string;
  subjectRef: string;
  purpose: PaymentPurpose;
  amountIdr: number;
  description: string;
  returnUrl: string | null;
  planId?: string | null;
}

export interface PaymentCheckout {
  gatewayId: string;
  gatewayPaymentRef: string;
  checkoutUrl: string | null;
  status: "pending" | "succeeded";
}

export interface VerifiedPaymentWebhook {
  gatewayPaymentRef: string;
  idempotencyKey: string;
  status: "pending" | "succeeded" | "failed" | "refunded" | "expired";
  amountIdr: number;
  purpose: PaymentPurpose;
  planId?: string | null;
  subjectRef: string;
  receivedAt: string;
}

/** Gateway adalah boundary; implementasi production wajib memverifikasi signature. */
export interface PaymentGateway {
  readonly id: string;
  readonly available: boolean;
  createCheckout(request: PaymentCheckoutRequest): Promise<PaymentCheckout>;
  verifyWebhook(payload: Uint8Array, signature: string): Promise<VerifiedPaymentWebhook>;
  lookupPayment(gatewayPaymentRef: string): Promise<VerifiedPaymentWebhook | null>;
  refund(gatewayPaymentRef: string, idempotencyKey: string): Promise<VerifiedPaymentWebhook>;
}

export class UnavailablePaymentGateway implements PaymentGateway {
  readonly id = "unavailable";
  readonly available = false;

  async createCheckout(): Promise<PaymentCheckout> {
    throw new Error("Pembayaran langsung belum tersedia pada instalasi ini.");
  }

  async verifyWebhook(): Promise<VerifiedPaymentWebhook> {
    throw new Error("Payment gateway belum dikonfigurasi.");
  }

  async lookupPayment(): Promise<VerifiedPaymentWebhook | null> {
    return null;
  }

  async refund(): Promise<VerifiedPaymentWebhook> {
    throw new Error("Payment gateway belum dikonfigurasi.");
  }
}

/** Fake lokal untuk acceptance/idempotency test; tidak pernah menghubungi uang nyata. */
export class LocalPaymentGateway implements PaymentGateway {
  readonly id = "local-test";
  readonly available = true;
  private readonly payments = new Map<string, VerifiedPaymentWebhook>();

  async createCheckout(request: PaymentCheckoutRequest): Promise<PaymentCheckout> {
    const existing = this.payments.get(request.idempotencyKey);
    if (existing) {
      return {
        gatewayId: this.id,
        gatewayPaymentRef: existing.gatewayPaymentRef,
        checkoutUrl: null,
        status: existing.status === "succeeded" ? "succeeded" : "pending",
      };
    }
    const reference = `local_${request.idempotencyKey}`;
    this.payments.set(request.idempotencyKey, {
      gatewayPaymentRef: reference,
      idempotencyKey: request.idempotencyKey,
      status: "pending",
      amountIdr: request.amountIdr,
      purpose: request.purpose,
      planId: request.planId ?? null,
      subjectRef: request.subjectRef,
      receivedAt: new Date().toISOString(),
    });
    return {
      gatewayId: this.id,
      gatewayPaymentRef: reference,
      checkoutUrl: null,
      status: "pending",
    };
  }

  async verifyWebhook(
    payload: Uint8Array,
    signature: string,
  ): Promise<VerifiedPaymentWebhook> {
    if (signature !== "local-test") {
      throw new Error("Signature webhook payment lokal tidak sah.");
    }
    const value = JSON.parse(new TextDecoder().decode(payload)) as VerifiedPaymentWebhook;
    if (!value || typeof value.gatewayPaymentRef !== "string") {
      throw new Error("Webhook payment lokal tidak sah.");
    }
    return structuredClone(value);
  }

  async lookupPayment(gatewayPaymentRef: string): Promise<VerifiedPaymentWebhook | null> {
    return [...this.payments.values()].find(
      (payment) => payment.gatewayPaymentRef === gatewayPaymentRef,
    ) ?? null;
  }

  async refund(gatewayPaymentRef: string, idempotencyKey: string): Promise<VerifiedPaymentWebhook> {
    const existing = await this.lookupPayment(gatewayPaymentRef);
    if (!existing) throw new Error("Pembayaran lokal tidak ditemukan.");
    const refunded = { ...existing, idempotencyKey, status: "refunded" as const };
    this.payments.set(existing.idempotencyKey, refunded);
    return refunded;
  }

  /** Hanya test/local operator; payment production tetap menunggu webhook terverifikasi. */
  succeed(idempotencyKey: string): VerifiedPaymentWebhook {
    const current = this.payments.get(idempotencyKey);
    if (!current) throw new Error("Checkout lokal tidak ditemukan.");
    const next = { ...current, status: "succeeded" as const };
    this.payments.set(idempotencyKey, next);
    return structuredClone(next);
  }
}
