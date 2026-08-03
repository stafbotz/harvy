import { randomUUID } from "node:crypto";
import type {
  AiUsageContext,
  ProductEventKind,
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
  TokenUsage,
  UsageObserver,
  UsageTier,
} from "../domain/telemetry.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export interface TierPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface TelemetryOptions {
  rollingTokenLimit: number;
  retentionDays: number;
  prices: Record<UsageTier, TierPrice>;
  /** Paket/cohort boleh memberi limit dinamis; fallback tetap nilai di atas. */
  limitForOwner?: (ownerId: string) => Promise<number>;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  /** Token request bernilai yang selesai di provider, untuk transparansi. */
  totalTokens: number;
  /** Debit paket yang sudah dikonfirmasi adapter setelah delivery. */
  capacityUsedTokens: number;
  estimatedCostUsd: number;
  limit: number;
}

export interface TelemetryExport {
  usage: AiUsageRecord[];
  events: ProductEvent[];
  providerAttempts?: unknown[];
  entitlementEntries?: unknown[];
}

export interface RelatedUsageLedger {
  exportOwner(ownerId: string): Promise<unknown[]>;
  exportEntitlements(ownerId: string): Promise<unknown[]>;
  settleEntitlement(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean },
  ): Promise<void>;
  markDelivered?(ownerId: string): Promise<void>;
  discardUndelivered?(ownerId: string): Promise<void>;
  debitedTokens?(ownerId: string, since: Date): Promise<number | null>;
  forgetOwner(ownerId: string): Promise<void>;
  allowOwner?(ownerId: string): Promise<void>;
  forgetActor?(
    ownerId: string,
    actorAliases: readonly string[],
  ): Promise<boolean>;
  purgeExpired(): Promise<void>;
  drain(): Promise<void>;
}

export class UsageLimitError extends Error {
  constructor() {
    super("Batas pemakaian AI 24 jam tercapai.");
    this.name = "UsageLimitError";
  }
}

export class TelemetryOwnerBlockedError extends Error {
  constructor() {
    super("Pemrosesan AI diblokir setelah penghapusan data.");
    this.name = "TelemetryOwnerBlockedError";
  }
}

/**
 * Mencatat token dan peristiwa produk tanpa menyimpan isi pesan.
 *
 * Batasnya bergulir 24 jam, bukan "hari kalender", sehingga tidak bergantung
 * pada zona waktu proses. Panggilan keselamatan tetap lewat.
 */
export class TelemetryService implements UsageObserver {
  private readonly reservations = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly requestGenerations = new Map<
    string,
    { ownerId: string; generation: number }
  >();
  private readonly forgottenOwners = new Set<string>();
  private readonly pendingUsage = new Map<string, AiUsageRecord[]>();
  private readonly pendingEvents = new Map<string, ProductEvent[]>();
  private readonly flushes = new Map<string, Promise<void>>();
  private lastPurgeAt = 0;
  private purgeInFlight: Promise<void> | null = null;

  constructor(
    private readonly repository: TelemetryRepository,
    private readonly options: TelemetryOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.telemetry"),
    private readonly relatedUsageLedger: RelatedUsageLedger | null = null,
  ) {
    validateOptions(options);
  }

  async beforeRequest(context: AiUsageContext): Promise<void> {
    await this.exclusive(context.ownerId, async () => {
      if (this.forgottenOwners.has(context.ownerId)) {
        throw new TelemetryOwnerBlockedError();
      }
      const generation = this.generations.get(context.ownerId) ?? 0;
      const limit = await this.limitForOwner(context.ownerId);
      if (!context.safetyCritical && limit > 0) {
        const summary = await this.summary(context.ownerId);
        const reserved = this.reservations.get(context.ownerId) ?? 0;
        const requested = context.inputTokenEstimate + context.maxTokens;
        if (
          summary.capacityUsedTokens + reserved + requested >
          limit
        ) {
          throw new UsageLimitError();
        }
        this.reservations.set(
          context.ownerId,
          reserved + requested,
        );
      }
      this.requestGenerations.set(context.requestId, {
        ownerId: context.ownerId,
        generation,
      });
    });
  }

  async afterRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean; latencyMs: number },
  ): Promise<void> {
    let shouldSettle = false;
    await this.exclusive(context.ownerId, async () => {
      if (!context.safetyCritical) {
        const reserved = this.reservations.get(context.ownerId) ?? 0;
        const requested = context.inputTokenEstimate + context.maxTokens;
        const remaining = Math.max(0, reserved - requested);
        if (remaining > 0) this.reservations.set(context.ownerId, remaining);
        else this.reservations.delete(context.ownerId);
      }

      const requestGeneration = this.requestGenerations.get(context.requestId);
      this.requestGenerations.delete(context.requestId);
      const currentGeneration = this.generations.get(context.ownerId) ?? 0;
      if (
        requestGeneration === undefined ||
        requestGeneration.ownerId !== context.ownerId ||
        requestGeneration.generation !== currentGeneration ||
        this.forgottenOwners.has(context.ownerId)
      ) {
        return;
      }

      const price = this.options.prices[context.tier];
      const normalizedUsage = normalizeUsage(usage);
      const latencyMs = nonNegativeInteger(outcome.latencyMs);
      const estimatedCostUsd =
        (normalizedUsage.inputTokens / 1_000_000) *
          price.inputPerMillionUsd +
        (normalizedUsage.outputTokens / 1_000_000) *
          price.outputPerMillionUsd;

      const record: AiUsageRecord = {
        requestId: context.requestId,
        turnId: context.turnId,
        ownerId: context.ownerId,
        subjectKind: context.subjectKind ?? inferSubjectKind(context.ownerId),
        channel: context.channel ?? inferChannel(context.ownerId),
        tier: context.tier,
        purpose: context.purpose,
        model: context.model,
        maxTokens: context.maxTokens,
        inputTokenEstimate: context.inputTokenEstimate,
        safetyCritical: context.safetyCritical,
        ...normalizedUsage,
        succeeded: outcome.succeeded,
        billable: isBillable(context, outcome.succeeded),
        latencyMs,
        id: shortId(),
        at: this.now().toISOString(),
        estimatedCostUsd,
      };
      const pending = this.pendingUsage.get(context.ownerId) ?? [];
      pending.push(record);
      this.pendingUsage.set(context.ownerId, pending);
      shouldSettle = true;
    });
    if (shouldSettle && this.relatedUsageLedger) {
      const settlement = this.relatedUsageLedger.settleEntitlement(
        context,
        usage,
        { succeeded: outcome.succeeded },
      );
      void settlement.catch((error: unknown) => {
        this.logger.warn(
          "entitlement_settlement_failed",
          "Settlement entitlement gagal tanpa mengubah balasan model.",
          { error, purpose: context.purpose, tier: context.tier },
        );
      });
    }
    this.scheduleFlush(context.ownerId);
    this.schedulePurge();
  }

  async event(ownerId: string, kind: ProductEventKind): Promise<void> {
    await this.exclusive(ownerId, async () => {
      if (this.forgottenOwners.has(ownerId)) return;
      const event: ProductEvent = {
        id: shortId(),
        ownerId,
        kind,
        at: this.now().toISOString(),
      };
      const pending = this.pendingEvents.get(ownerId) ?? [];
      pending.push(event);
      this.pendingEvents.set(ownerId, pending);
    });
    this.scheduleFlush(ownerId);
    this.schedulePurge();
  }

  async summary(ownerId: string): Promise<UsageSummary> {
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
    const stored = await this.repository.usageSince(ownerId, since);
    const pending = (this.pendingUsage.get(ownerId) ?? []).filter(
      (record) => new Date(record.at).getTime() >= since.getTime(),
    );
    const records = uniqueById([...stored, ...pending]);

    const limit = await this.limitForOwner(ownerId);
    const technical = records.filter((record) => record.billable !== false).reduce<
      Omit<UsageSummary, "capacityUsedTokens" | "limit">
    >(
      (total, record) => ({
        inputTokens: total.inputTokens + record.inputTokens,
        outputTokens: total.outputTokens + record.outputTokens,
        totalTokens: total.totalTokens + record.totalTokens,
        estimatedCostUsd:
          total.estimatedCostUsd + record.estimatedCostUsd,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
    );
    const deliveredDebit = this.relatedUsageLedger?.debitedTokens
      ? await this.relatedUsageLedger.debitedTokens(ownerId, since)
      : null;
    const capacityUsedTokens = deliveredDebit ?? technical.totalTokens;
    return {
      ...technical,
      capacityUsedTokens,
      limit,
    };
  }

  async export(ownerId: string): Promise<TelemetryExport> {
    await this.waitForFlush(ownerId);
    const beginning = new Date(0);
    const [storedUsage, storedEvents, providerAttempts, entitlementEntries] = await Promise.all([
      this.repository.usageSince(ownerId, beginning),
      this.repository.eventsSince(ownerId, beginning),
      this.relatedUsageLedger?.exportOwner(ownerId) ?? Promise.resolve([]),
      this.relatedUsageLedger?.exportEntitlements(ownerId) ?? Promise.resolve([]),
    ]);
    return {
      usage: uniqueById([
        ...storedUsage,
        ...(this.pendingUsage.get(ownerId) ?? []),
      ]),
      events: uniqueById([
        ...storedEvents,
        ...(this.pendingEvents.get(ownerId) ?? []),
      ]),
      ...(providerAttempts.length > 0 ? { providerAttempts } : {}),
      ...(entitlementEntries.length > 0 ? { entitlementEntries } : {}),
    };
  }

  async forget(ownerId: string): Promise<void> {
    await this.exclusive(ownerId, async () => {
      this.generations.set(ownerId, (this.generations.get(ownerId) ?? 0) + 1);
      this.forgottenOwners.add(ownerId);
      this.reservations.delete(ownerId);
      this.pendingUsage.delete(ownerId);
      this.pendingEvents.delete(ownerId);
      for (const [requestId, request] of this.requestGenerations) {
        if (request.ownerId === ownerId) this.requestGenerations.delete(requestId);
      }
    });
    await this.waitForFlush(ownerId);
    await this.repository.removeAll(ownerId);
    await this.relatedUsageLedger?.forgetOwner(ownerId);
  }

  /** Membuka generasi baru hanya setelah pengguna memberi persetujuan baru. */
  async allow(ownerId: string): Promise<void> {
    await this.exclusive(ownerId, async () => {
      this.forgottenOwners.delete(ownerId);
    });
    await this.relatedUsageLedger?.allowOwner?.(ownerId);
  }

  /** Menghapus atribusi teknis seorang anggota tanpa menghapus agregat grup. */
  async forgetActor(
    ownerId: string,
    actorAliases: readonly string[],
  ): Promise<boolean> {
    return this.relatedUsageLedger?.forgetActor?.(ownerId, actorAliases) ?? false;
  }

  async markDelivered(ownerId: string): Promise<void> {
    try {
      await this.relatedUsageLedger?.markDelivered?.(ownerId);
    } catch (error) {
      this.logger.warn(
        "entitlement_delivery_settlement_failed",
        "Delivery berhasil tetapi debit entitlement belum tersimpan; drain akan mencoba antrean yang sudah terbentuk.",
        { error },
      );
    }
  }

  async discardUndelivered(ownerId: string): Promise<void> {
    try {
      await this.relatedUsageLedger?.discardUndelivered?.(ownerId);
    } catch (error) {
      this.logger.warn(
        "entitlement_delivery_discard_failed",
        "Kandidat entitlement gagal dibatalkan setelah delivery gagal.",
        { error },
      );
    }
  }

  /** Menunggu penulisan latar saat shutdown atau verifikasi. */
  async drain(): Promise<void> {
    while (true) {
      // `event()` dan `afterRequest()` memasukkan item lewat antrean eksklusif
      // lebih dulu. Menunggu flush saja dapat selesai sebelum operasi itu sempat
      // memindahkan item ke pending.
      const queued = [...this.queues.values()];
      if (queued.length > 0) {
        await Promise.allSettled(queued);
        continue;
      }

      const owners = new Set([
        ...this.pendingUsage.keys(),
        ...this.pendingEvents.keys(),
        ...this.flushes.keys(),
      ]);
      for (const ownerId of owners) this.scheduleFlush(ownerId);

      const active = [...this.flushes.values()];
      if (active.length > 0) {
        const results = await Promise.allSettled(active);
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed) throw failed.reason;
        continue;
      }

      const purge = this.purgeInFlight;
      if (purge) {
        await purge;
        continue;
      }

      if (
        this.queues.size === 0 &&
        this.flushes.size === 0 &&
        this.pendingUsage.size === 0 &&
        this.pendingEvents.size === 0
      ) {
        await this.relatedUsageLedger?.drain();
        return;
      }
    }
  }

  async purgeExpired(): Promise<void> {
    await this.purgeAll();
  }

  private schedulePurge(): void {
    const now = this.now().getTime();
    if (
      this.purgeInFlight ||
      now - this.lastPurgeAt < 60 * 60 * 1000
    ) {
      return;
    }
    this.lastPurgeAt = now;
    const running = this.purgeAll();
    this.purgeInFlight = running;
    void running.then(
      () => this.releasePurge(running),
      (error: unknown) => {
        this.logger.warn(
          "telemetry_retention_failed",
          "Retensi telemetry produk gagal dijalankan.",
          { error },
        );
        this.releasePurge(running);
      },
    );
  }

  private scheduleFlush(ownerId: string): void {
    if (this.flushes.has(ownerId)) return;
    if (
      (this.pendingUsage.get(ownerId)?.length ?? 0) === 0 &&
      (this.pendingEvents.get(ownerId)?.length ?? 0) === 0
    ) {
      return;
    }

    const running = this.flushOwner(ownerId);
    this.flushes.set(ownerId, running);
    void running.then(
      () => this.releaseFlush(ownerId, running, true),
      (error: unknown) => {
        this.logger.error(
          "telemetry_flush_failed",
          "Antrean telemetry produk gagal ditulis.",
          error,
        );
        this.releaseFlush(ownerId, running, false);
      },
    );
  }

  private async flushOwner(ownerId: string): Promise<void> {
    while (true) {
      const usage = this.pendingUsage.get(ownerId)?.[0];
      if (usage) {
        await this.repository.appendUsage(usage);
        this.removePendingById(this.pendingUsage, ownerId, usage.id);
        continue;
      }

      const event = this.pendingEvents.get(ownerId)?.[0];
      if (event) {
        await this.repository.appendEvent(event);
        this.removePendingById(this.pendingEvents, ownerId, event.id);
        continue;
      }
      return;
    }
  }

  private removePendingById<T extends { id: string }>(
    source: Map<string, T[]>,
    ownerId: string,
    id: string,
  ): void {
    const current = source.get(ownerId);
    if (!current) return;
    const remaining = current.filter((item) => item.id !== id);
    if (remaining.length > 0) source.set(ownerId, remaining);
    else source.delete(ownerId);
  }

  private releaseFlush(
    ownerId: string,
    running: Promise<void>,
    continueIfPending: boolean,
  ): void {
    if (this.flushes.get(ownerId) !== running) return;
    this.flushes.delete(ownerId);
    const hasPending =
      (this.pendingUsage.get(ownerId)?.length ?? 0) > 0 ||
      (this.pendingEvents.get(ownerId)?.length ?? 0) > 0;
    if (hasPending && continueIfPending) {
      this.scheduleFlush(ownerId);
    }
    // Kegagalan tidak diputar ketat. Request berikutnya atau drain akan
    // mencoba lagi; loop langsung di sini dapat membebani disk tanpa batas.
  }

  private async waitForFlush(ownerId: string): Promise<void> {
    while (true) {
      const queued = this.queues.get(ownerId);
      if (queued) {
        await queued;
        continue;
      }

      this.scheduleFlush(ownerId);
      const active = this.flushes.get(ownerId);
      if (!active) return;

      try {
        await active;
      } catch {
        // Ekspor tetap menyertakan antrean memori; penghapusan membersihkannya
        // sebelum repository dibuang.
        return;
      }
    }
  }

  private releasePurge(running: Promise<void>): void {
    if (this.purgeInFlight === running) this.purgeInFlight = null;
  }

  private async purgeAll(): Promise<void> {
    const before = new Date(
      this.now().getTime() -
        this.options.retentionDays * 24 * 60 * 60 * 1000,
    );
    await Promise.all([
      this.repository.removeBefore(before),
      this.relatedUsageLedger?.purgeExpired() ?? Promise.resolve(),
    ]);
  }

  private async limitForOwner(ownerId: string): Promise<number> {
    const resolved = this.options.limitForOwner
      ? await this.options.limitForOwner(ownerId)
      : this.options.rollingTokenLimit;
    return Number.isSafeInteger(resolved) && resolved >= 0
      ? resolved
      : this.options.rollingTokenLimit;
  }

  private async exclusive<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.queues.get(ownerId) === settled) {
        this.queues.delete(ownerId);
      }
    }
  }
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function validateOptions(options: TelemetryOptions): void {
  if (
    !Number.isFinite(options.rollingTokenLimit) ||
    options.rollingTokenLimit < 0 ||
    !Number.isFinite(options.retentionDays) ||
    options.retentionDays <= 0
  ) {
    throw new Error("Konfigurasi observabilitas tidak sah.");
  }

  for (const price of Object.values(options.prices)) {
    if (
      !Number.isFinite(price.inputPerMillionUsd) ||
      price.inputPerMillionUsd < 0 ||
      !Number.isFinite(price.outputPerMillionUsd) ||
      price.outputPerMillionUsd < 0
    ) {
      throw new Error("Harga model tidak sah.");
    }
  }
}

function normalizeUsage(usage: TokenUsage): TokenUsage {
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(
      nonNegativeInteger(usage.totalTokens),
      inputTokens + outputTokens,
    ),
    estimated: usage.estimated === true,
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function inferSubjectKind(ownerId: string): "private" | "group" {
  return ownerId.startsWith("whatsapp:") || ownerId.startsWith("telegram:")
    ? "group"
    : "private";
}

function inferChannel(
  ownerId: string,
): "telegram" | "whatsapp" | "system" {
  return ownerId.startsWith("whatsapp:") ? "whatsapp" : "telegram";
}

function isBillable(context: AiUsageContext, succeeded: boolean): boolean {
  if (!succeeded || context.safetyCritical) return false;
  return !(
    context.purpose === "turn-boundary" ||
    context.purpose === "understanding" ||
    context.purpose === "due-date" ||
    context.purpose === "risk-triage" ||
    context.purpose === "reply-review" ||
    context.purpose === "summary" ||
    context.purpose === "insight" ||
    context.purpose === "group-participation"
  );
}
