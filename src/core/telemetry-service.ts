import { createHash, randomUUID } from "node:crypto";
import type {
  AiUsageContext,
  ProductEventKind,
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
  TokenUsage,
  TurnTelemetryOutcome,
  TurnTelemetryRecord,
  UsageObserver,
  UsageTier,
} from "../domain/telemetry.js";

import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

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
  turns: TurnTelemetryRecord[];
  providerAttempts?: unknown[];
  entitlementEntries?: unknown[];
}

export interface TurnTelemetryCompletion {
  turnId: string;
  ownerId: string;
  subjectKind: "private" | "group";
  channel: "telegram" | "whatsapp" | "system";
  outcome: TurnTelemetryOutcome;
  bubbleCount: number;
  batchWaitMs: number;
  queueWaitMs: number;
  handlingLatencyMs: number;
  totalLatencyMs: number;
}

export type TurnTelemetrySignal =
  | "deterministic-fast-path"
  | "risk-triage-unavailable"
  | "safety-fallback"
  | "safe-action-blocked"
  | "urgent-acknowledgement";

export interface PercentileSummary {
  p50: number | null;
  p95: number | null;
}

export interface TurnPerformanceSummary {
  turnCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  totalLatencyMs: PercentileSummary;
  batchWaitMs: PercentileSummary;
  queueWaitMs: PercentileSummary;
  handlingLatencyMs: PercentileSummary;
  timeToFirstResponseMs: PercentileSummary;
  timeToFinalResponseMs: PercentileSummary;
  averageModelCalls: number;
  boundaryClassifierRate: number;
  riskTriageRate: number;
  replyReviewRate: number;
  riskTriageUnavailableRate: number;
  safetyFallbackRate: number;
  safeActionBlockedRate: number;
  deterministicFastPathRate: number;
  urgentAcknowledgementRate: number;
}

type TurnAccumulator = Pick<
  TurnTelemetryRecord,
  | "modelCallCount"
  | "failedModelCallCount"
  | "boundaryCallCount"
  | "understandingCallCount"
  | "riskTriageCallCount"
  | "replyCallCount"
  | "replyReviewCallCount"
  | "agentCallCount"
  | "deterministicFastPathCount"
  | "riskTriageUnavailableCount"
  | "safetyFallbackCount"
  | "safeActionBlockedCount"
  | "urgentAcknowledgementCount"
>;

export interface RelatedUsageLedger {
  exportOwner(ownerId: string): Promise<unknown[]>;
  exportEntitlements(ownerId: string): Promise<unknown[]>;
  settleEntitlement(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean },
  ): Promise<void>;
  markDelivered?(ownerId: string, turnId: string | null): Promise<void>;
  discardUndelivered?(ownerId: string, turnId: string | null): Promise<void>;
  debitedTokens?(ownerId: string, since: Date): Promise<number | null>;
  pendingDebitTokens?(ownerId: string, since: Date): Promise<number>;
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
  private readonly pendingTurns = new Map<string, TurnTelemetryRecord[]>();
  private readonly openTurns = new Map<string, number>();
  private readonly turnResponseTimes = new Map<
    string,
    { firstMs: number; finalMs: number }
  >();
  private readonly turnAccumulators = new Map<string, TurnAccumulator>();
  private readonly closedTurns = new Map<string, number>();
  private readonly lifecycleQueues = new Map<string, Promise<void>>();
  private readonly deletionFailures = new Map<string, unknown>();
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
        const since = new Date(this.now().getTime() - DAY_MS);
        const pendingDebit = this.relatedUsageLedger?.pendingDebitTokens
          ? await this.relatedUsageLedger.pendingDebitTokens(context.ownerId, since)
          : 0;
        const reserved = this.reservations.get(context.ownerId) ?? 0;
        const requested = context.inputTokenEstimate + context.maxTokens;
        if (
          summary.capacityUsedTokens + pendingDebit + reserved + requested >
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
      this.accumulateTurnRequest(context);
    });
  }

  async afterRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean; latencyMs: number },
  ): Promise<void> {
    let shouldSettle = false;
    let holdReservationUntilSettlement = false;
    const requested = context.inputTokenEstimate + context.maxTokens;
    await this.exclusive(context.ownerId, async () => {
      const requestGeneration = this.requestGenerations.get(context.requestId);
      this.requestGenerations.delete(context.requestId);
      const currentGeneration = this.generations.get(context.ownerId) ?? 0;
      if (
        requestGeneration === undefined ||
        requestGeneration.ownerId !== context.ownerId ||
        requestGeneration.generation !== currentGeneration ||
        this.forgottenOwners.has(context.ownerId)
      ) {
        this.releaseReservation(context.ownerId, requested, context.safetyCritical);
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
      this.accumulateTurnOutcome(record);
      shouldSettle = true;
      holdReservationUntilSettlement = record.billable;
      if (!holdReservationUntilSettlement) {
        this.releaseReservation(context.ownerId, requested, context.safetyCritical);
      }
    });
    if (shouldSettle && this.relatedUsageLedger) {
      const settlement = this.relatedUsageLedger.settleEntitlement(
        context,
        usage,
        { succeeded: outcome.succeeded },
      );
      if (holdReservationUntilSettlement) {
        try {
          // Kandidat delivery harus tercatat sebelum estimasi request ini
          // dilepas; kalau tidak, langkah agent berikutnya dapat menyalip cap.
          await settlement;
          await this.exclusive(context.ownerId, async () => {
            this.releaseReservation(context.ownerId, requested, false);
          });
        } catch (error) {
          // Fail-closed: reservation dipertahankan bila kandidat debit gagal
          // dibentuk. Balasan tetap boleh dikirim, tetapi kuota tidak dapat
          // dilewati oleh request lanjutan pada proses ini.
          this.logger.warn(
            "entitlement_settlement_failed",
            "Settlement entitlement gagal; reservation kuota dipertahankan.",
            { error, purpose: context.purpose, tier: context.tier },
          );
        }
      } else {
      void settlement.catch((error: unknown) => {
        this.logger.warn(
          "entitlement_settlement_failed",
          "Settlement entitlement gagal tanpa mengubah balasan model.",
          { error, purpose: context.purpose, tier: context.tier },
        );
      });
      }
    } else if (shouldSettle && holdReservationUntilSettlement) {
      // Tanpa ledger delivery, telemetry teknis menjadi sumber kapasitas.
      await this.exclusive(context.ownerId, async () => {
        this.releaseReservation(context.ownerId, requested, false);
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

  /**
   * Membuka korelasi saat handler biasa dimulai. Sinyal urgent out-of-band
   * dapat membuka korelasinya sendiri sebelum handler mencapai jalur ini.
   */
  async beginTurn(ownerId: string, turnId: string): Promise<void> {
    if (!turnId) return;
    await this.exclusive(ownerId, async () => {
      if (this.forgottenOwners.has(ownerId)) return;
      const key = turnKey(ownerId, turnId);
      this.pruneTurnState();
      if (!this.closedTurns.has(key) && !this.openTurns.has(key)) {
        this.openTurns.set(key, this.now().getTime());
      }
    });
  }

  async noteTurnSignal(
    ownerId: string,
    turnId: string | null,
    signal: TurnTelemetrySignal,
  ): Promise<void> {
    if (!turnId) return;
    await this.exclusive(ownerId, async () => {
      if (this.forgottenOwners.has(ownerId)) return;
      const key = turnKey(ownerId, turnId);
      if (this.closedTurns.has(key)) return;
      if (!this.openTurns.has(key)) {
        if (signal !== "urgent-acknowledgement") return;
        this.pruneTurnState();
        this.openTurns.set(key, this.now().getTime());
      }
      const accumulator = this.turnAccumulators.get(key) ?? emptyTurnAccumulator();
      switch (signal) {
        case "deterministic-fast-path":
          accumulator.deterministicFastPathCount += 1;
          break;
        case "risk-triage-unavailable":
          accumulator.riskTriageUnavailableCount += 1;
          break;
        case "safety-fallback":
          accumulator.safetyFallbackCount += 1;
          break;
        case "safe-action-blocked":
          accumulator.safeActionBlockedCount += 1;
          break;
        case "urgent-acknowledgement":
          accumulator.urgentAcknowledgementCount += 1;
          break;
      }
      this.turnAccumulators.set(key, accumulator);
    });
  }

  /** Called only after a user-visible delivery API has acknowledged success. */
  async noteTurnResponse(ownerId: string, turnId: string | null): Promise<void> {
    if (!turnId) return;
    await this.exclusive(ownerId, async () => {
      const key = turnKey(ownerId, turnId);
      const openedAt = this.openTurns.get(key);
      if (openedAt === undefined || this.closedTurns.has(key)) return;
      const elapsed = Math.max(0, this.now().getTime() - openedAt);
      const current = this.turnResponseTimes.get(key);
      this.turnResponseTimes.set(key, current
        ? { firstMs: current.firstMs, finalMs: Math.max(current.finalMs, elapsed) }
        : { firstMs: elapsed, finalMs: elapsed });
    });
  }

  /** Menutup satu span giliran secara idempoten dan menulis metrik tanpa isi. */
  async recordTurn(completion: TurnTelemetryCompletion): Promise<void> {
    if (!completion.turnId) return;
    let recorded = false;
    await this.exclusive(completion.ownerId, async () => {
      if (this.forgottenOwners.has(completion.ownerId)) return;
      const key = turnKey(completion.ownerId, completion.turnId);
      if (this.closedTurns.has(key)) return;
      const accumulator = this.turnAccumulators.get(key) ?? emptyTurnAccumulator();
      const batchWaitMs = nonNegativeInteger(completion.batchWaitMs);
      const queueWaitMs = nonNegativeInteger(completion.queueWaitMs);
      const handlingLatencyMs = nonNegativeInteger(completion.handlingLatencyMs);
      const responseTimes = this.turnResponseTimes.get(key) ?? null;
      const record: TurnTelemetryRecord = {
        id: turnRecordId(completion.ownerId, completion.turnId),
        at: this.now().toISOString(),
        turnId: completion.turnId,
        ownerId: completion.ownerId,
        subjectKind: completion.subjectKind,
        channel: completion.channel,
        outcome: completion.outcome,
        bubbleCount: Math.max(1, nonNegativeInteger(completion.bubbleCount)),
        batchWaitMs,
        queueWaitMs,
        handlingLatencyMs,
        totalLatencyMs: Math.max(
          nonNegativeInteger(completion.totalLatencyMs),
          batchWaitMs + queueWaitMs + handlingLatencyMs,
        ),
        timeToFirstResponseMs: responseTimes?.firstMs ?? null,
        timeToFinalResponseMs: responseTimes?.finalMs ?? null,
        ...accumulator,
      };
      const pending = this.pendingTurns.get(completion.ownerId) ?? [];
      pending.push(record);
      this.pendingTurns.set(completion.ownerId, pending);
      this.openTurns.delete(key);
      this.turnAccumulators.delete(key);
      this.turnResponseTimes.delete(key);
      this.markTurnClosed(key);
      recorded = true;
    });
    if (!recorded) return;
    this.scheduleFlush(completion.ownerId);
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

  async performanceSummary(
    ownerId: string,
    since: Date = new Date(this.now().getTime() - DAY_MS),
  ): Promise<TurnPerformanceSummary> {
    await this.waitForFlush(ownerId);
    const stored = await this.repository.turnsSince(ownerId, since);
    const pending = (this.pendingTurns.get(ownerId) ?? []).filter(
      (record) => new Date(record.at).getTime() >= since.getTime(),
    );
    return summarizeTurnPerformance(uniqueById([...stored, ...pending]));
  }

  async export(ownerId: string): Promise<TelemetryExport> {
    await this.waitForFlush(ownerId);
    const beginning = new Date(0);
    const [
      storedUsage,
      storedEvents,
      storedTurns,
      providerAttempts,
      entitlementEntries,
    ] = await Promise.all([
      this.repository.usageSince(ownerId, beginning),
      this.repository.eventsSince(ownerId, beginning),
      this.repository.turnsSince(ownerId, beginning),
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
      turns: uniqueById([
        ...storedTurns,
        ...(this.pendingTurns.get(ownerId) ?? []),
      ]),
      ...(providerAttempts.length > 0 ? { providerAttempts } : {}),
      ...(entitlementEntries.length > 0 ? { entitlementEntries } : {}),
    };
  }

  async forget(ownerId: string): Promise<void> {
    await this.lifecycleExclusive(ownerId, async () => {
      await this.exclusive(ownerId, async () => {
        this.generations.set(ownerId, (this.generations.get(ownerId) ?? 0) + 1);
        this.forgottenOwners.add(ownerId);
        this.reservations.delete(ownerId);
        this.pendingUsage.delete(ownerId);
        this.pendingEvents.delete(ownerId);
        this.pendingTurns.delete(ownerId);
        this.removeOwnerTurnState(ownerId);
        for (const [requestId, request] of this.requestGenerations) {
          if (request.ownerId === ownerId) {
            this.requestGenerations.delete(requestId);
          }
        }
      });
      try {
        await this.waitForFlush(ownerId);
        await this.repository.removeAll(ownerId);
        await this.relatedUsageLedger?.forgetOwner(ownerId);
        this.deletionFailures.delete(ownerId);
      } catch (error) {
        this.deletionFailures.set(ownerId, error);
        throw error;
      }
    });
  }

  /** Membuka generasi baru hanya setelah pengguna memberi persetujuan baru. */
  async allow(ownerId: string): Promise<void> {
    await this.lifecycleExclusive(ownerId, async () => {
      if (this.deletionFailures.has(ownerId)) {
        throw new Error(
          "Telemetry tidak dapat dibuka sebelum penghapusan owner berhasil.",
        );
      }
      await this.relatedUsageLedger?.allowOwner?.(ownerId);
      await this.exclusive(ownerId, async () => {
        this.forgottenOwners.delete(ownerId);
      });
    });
  }

  /** Menghapus atribusi teknis seorang anggota tanpa menghapus agregat grup. */
  async forgetActor(
    ownerId: string,
    actorAliases: readonly string[],
  ): Promise<boolean> {
    return this.relatedUsageLedger?.forgetActor?.(ownerId, actorAliases) ?? false;
  }

  async markDelivered(ownerId: string, turnId: string | null): Promise<void> {
    try {
      await this.relatedUsageLedger?.markDelivered?.(ownerId, turnId);
    } catch (error) {
      this.logger.warn(
        "entitlement_delivery_settlement_failed",
        "Delivery berhasil tetapi debit entitlement belum tersimpan; drain akan mencoba antrean yang sudah terbentuk.",
        { error },
      );
    }
  }

  async discardUndelivered(
    ownerId: string,
    turnId: string | null,
  ): Promise<void> {
    try {
      await this.relatedUsageLedger?.discardUndelivered?.(ownerId, turnId);
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
        ...this.pendingTurns.keys(),
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
        this.pendingEvents.size === 0 &&
        this.pendingTurns.size === 0
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
      (this.pendingEvents.get(ownerId)?.length ?? 0) === 0 &&
      (this.pendingTurns.get(ownerId)?.length ?? 0) === 0
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

      const turn = this.pendingTurns.get(ownerId)?.[0];
      if (turn) {
        await this.repository.appendTurn(turn);
        this.removePendingById(this.pendingTurns, ownerId, turn.id);
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
      (this.pendingEvents.get(ownerId)?.length ?? 0) > 0 ||
      (this.pendingTurns.get(ownerId)?.length ?? 0) > 0;
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

  private accumulateTurnRequest(context: AiUsageContext): void {
    if (!context.turnId) return;
    const key = turnKey(context.ownerId, context.turnId);
    if (!this.openTurns.has(key) || this.closedTurns.has(key)) return;
    const accumulator = this.turnAccumulators.get(key) ?? emptyTurnAccumulator();
    accumulator.modelCallCount += 1;
    switch (context.purpose) {
      case "turn-boundary":
        accumulator.boundaryCallCount += 1;
        break;
      case "understanding":
      case "group-ingress":
        accumulator.understandingCallCount += 1;
        break;
      case "risk-triage":
        accumulator.riskTriageCallCount += 1;
        break;
      case "reply":
      case "session":
      case "group-reply":
        accumulator.replyCallCount += 1;
        break;
      case "reply-review":
        accumulator.replyReviewCallCount += 1;
        break;
      case "agent":
      case "research":
        accumulator.agentCallCount += 1;
        break;
    }
    this.turnAccumulators.set(key, accumulator);
  }

  private accumulateTurnOutcome(record: AiUsageRecord): void {
    if (!record.turnId || record.succeeded) return;
    const key = turnKey(record.ownerId, record.turnId);
    if (!this.openTurns.has(key) || this.closedTurns.has(key)) return;
    const accumulator = this.turnAccumulators.get(key) ?? emptyTurnAccumulator();
    accumulator.failedModelCallCount += 1;
    this.turnAccumulators.set(key, accumulator);
  }

  private markTurnClosed(key: string): void {
    this.closedTurns.set(key, this.now().getTime());
    this.pruneTurnState();
  }

  private pruneTurnState(): void {
    const cutoff = this.now().getTime() - DAY_MS;
    for (const [key, openedAt] of this.openTurns) {
      if (openedAt >= cutoff) continue;
      this.openTurns.delete(key);
      this.turnAccumulators.delete(key);
      this.turnResponseTimes.delete(key);
    }
    for (const [key, closedAt] of this.closedTurns) {
      if (closedAt < cutoff) this.closedTurns.delete(key);
    }
    while (this.closedTurns.size > 4_096) {
      const oldest = this.closedTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.closedTurns.delete(oldest);
    }
  }

  private removeOwnerTurnState(ownerId: string): void {
    const prefix = `${ownerId}\u0000`;
    for (const key of this.openTurns.keys()) {
      if (key.startsWith(prefix)) this.openTurns.delete(key);
    }
    for (const key of this.turnAccumulators.keys()) {
      if (key.startsWith(prefix)) this.turnAccumulators.delete(key);
    }
    for (const key of this.turnResponseTimes.keys()) {
      if (key.startsWith(prefix)) this.turnResponseTimes.delete(key);
    }
    for (const key of this.closedTurns.keys()) {
      if (key.startsWith(prefix)) this.closedTurns.delete(key);
    }
  }

  private async limitForOwner(ownerId: string): Promise<number> {
    const resolved = this.options.limitForOwner
      ? await this.options.limitForOwner(ownerId)
      : this.options.rollingTokenLimit;
    return Number.isSafeInteger(resolved) && resolved >= 0
      ? resolved
      : this.options.rollingTokenLimit;
  }

  private releaseReservation(
    ownerId: string,
    requested: number,
    safetyCritical: boolean,
  ): void {
    if (safetyCritical) return;
    const reserved = this.reservations.get(ownerId) ?? 0;
    const remaining = Math.max(0, reserved - requested);
    if (remaining > 0) this.reservations.set(ownerId, remaining);
    else this.reservations.delete(ownerId);
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

  private async lifecycleExclusive<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleQueues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.lifecycleQueues.get(ownerId) === settled) {
        this.lifecycleQueues.delete(ownerId);
      }
    }
  }
}

function emptyTurnAccumulator(): TurnAccumulator {
  return {
    modelCallCount: 0,
    failedModelCallCount: 0,
    boundaryCallCount: 0,
    understandingCallCount: 0,
    riskTriageCallCount: 0,
    replyCallCount: 0,
    replyReviewCallCount: 0,
    agentCallCount: 0,
    deterministicFastPathCount: 0,
    riskTriageUnavailableCount: 0,
    safetyFallbackCount: 0,
    safeActionBlockedCount: 0,
    urgentAcknowledgementCount: 0,
  };
}

function turnKey(ownerId: string, turnId: string): string {
  return `${ownerId}\u0000${turnId}`;
}

function turnRecordId(ownerId: string, turnId: string): string {
  return createHash("sha256")
    .update(turnKey(ownerId, turnId))
    .digest("hex")
    .slice(0, 24);
}

export function summarizeTurnPerformance(
  records: readonly TurnTelemetryRecord[],
): TurnPerformanceSummary {
  const turnCount = records.length;
  const rate = (predicate: (record: TurnTelemetryRecord) => boolean): number =>
    turnCount === 0 ? 0 : records.filter(predicate).length / turnCount;
  return {
    turnCount,
    completedCount: records.filter((record) => record.outcome === "completed").length,
    failedCount: records.filter((record) => record.outcome === "failed").length,
    cancelledCount: records.filter((record) => record.outcome === "cancelled").length,
    totalLatencyMs: percentiles(records.map((record) => record.totalLatencyMs)),
    batchWaitMs: percentiles(records.map((record) => record.batchWaitMs)),
    queueWaitMs: percentiles(records.map((record) => record.queueWaitMs)),
    handlingLatencyMs: percentiles(
      records.map((record) => record.handlingLatencyMs),
    ),
    timeToFirstResponseMs: percentiles(
      records.flatMap((record) =>
        record.timeToFirstResponseMs === null ? [] : [record.timeToFirstResponseMs]
      ),
    ),
    timeToFinalResponseMs: percentiles(
      records.flatMap((record) =>
        record.timeToFinalResponseMs === null ? [] : [record.timeToFinalResponseMs]
      ),
    ),
    averageModelCalls: turnCount === 0
      ? 0
      : records.reduce((sum, record) => sum + record.modelCallCount, 0) /
        turnCount,
    boundaryClassifierRate: rate((record) => record.boundaryCallCount > 0),
    riskTriageRate: rate((record) => record.riskTriageCallCount > 0),
    replyReviewRate: rate((record) => record.replyReviewCallCount > 0),
    riskTriageUnavailableRate: rate(
      (record) => record.riskTriageUnavailableCount > 0,
    ),
    safetyFallbackRate: rate((record) => record.safetyFallbackCount > 0),
    safeActionBlockedRate: rate((record) => record.safeActionBlockedCount > 0),
    deterministicFastPathRate: rate(
      (record) => record.deterministicFastPathCount > 0,
    ),
    urgentAcknowledgementRate: rate(
      (record) => record.urgentAcknowledgementCount > 0,
    ),
  };
}

function percentiles(values: readonly number[]): PercentileSummary {
  if (values.length === 0) return { p50: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
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
    context.purpose === "memory-privacy" ||
    context.purpose === "group-ingress" ||
    context.purpose === "reply-review" ||
    context.purpose === "summary" ||
    context.purpose === "insight" ||
    context.purpose === "group-participation"
  );
}
