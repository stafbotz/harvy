import { randomUUID } from "node:crypto";
import type { ControlPlaneService } from "./control-plane-service.js";
import type {
  ModelPriceRates,
  ModelPriceVersion,
} from "../domain/control-plane.js";
import {
  tokenCostNanos,
  usdDecimalToNanos,
} from "./money.js";
import type {
  ProviderAttemptFinish,
  ProviderAttemptObserver,
  ProviderAttemptRecord,
  ProviderAttemptStart,
  ProviderTokenUsage,
  UsageLedgerFilter,
  UsageLedgerRepository,
} from "../domain/usage-ledger.js";
import type {
  EntitlementEntry,
  EntitlementLedgerRepository,
} from "../domain/entitlement.js";
import type {
  AiUsageContext,
  TokenUsage,
} from "../domain/telemetry.js";

export interface UsageLedgerSummary {
  attempts: number;
  logicalRequests: number;
  completedAttempts: number;
  fallbackAttempts: number;
  estimatedAttempts: number;
  unpricedAttempts: number;
  pendingAttempts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenEstimateRequested: number;
  maxOutputTokensRequested: number;
  effectiveCostUsdNanos: string | null;
  costCompleteness: "complete" | "partial" | "unknown";
  indicativeCostUsdNanos: string | null;
  currentPriceEstimateUsdNanos: string;
  currentPriceEstimatedAttempts: number;
  unavailableCostAttempts: number;
  historicalPriceGapAttempts: number;
  missingUsageAttempts: number;
  costCoverage: "complete" | "estimated" | "partial" | "unavailable";
  providerReportedUsdNanos: string;
  localCalculatedUsdNanos: string;
}

export interface UsageCostView {
  costUsdNanos: string | null;
  source: "recorded" | "current_catalog_estimate" | "unavailable";
  reason:
    | "recorded"
    | "historical_price_missing"
    | "current_price_missing"
    | "usage_missing";
  priceVersionId: string | null;
}

export interface EntitlementSummary {
  entries: number;
  debitedTokens: number;
  includedTokens: number;
  safetyExemptTokens: number;
}

export interface UsageLedgerBreakdown {
  byCohort: { cohort: "standard" | "beta"; summary: UsageLedgerSummary }[];
  byPlan: { planId: string; summary: UsageLedgerSummary }[];
}

export interface UsageLedgerOptions {
  retentionDays: number;
  entitlementRepository?: EntitlementLedgerRepository;
}

/** Ledger detail provider tanpa prompt, balasan, atau ID platform mentah. */
export class UsageLedgerService implements ProviderAttemptObserver {
  private readonly pendingAttempts = new Map<string, ProviderAttemptRecord>();
  private attemptQueue: Promise<void> = Promise.resolve();
  private readonly pendingEntitlements = new Map<string, EntitlementEntry>();
  private readonly pendingDeliveryCandidates = new Map<
    string,
    { ownerId: string; entry: EntitlementEntry }
  >();
  private readonly terminalTurns = new Map<
    string,
    Map<string, { state: "delivered" | "discarded"; at: number }>
  >();
  private entitlementQueue: Promise<void> = Promise.resolve();
  private readonly ownerQueues = new Map<string, Promise<void>>();
  private readonly blockedOwners = new Set<string>();
  private readonly ownerGenerations = new Map<string, number>();
  private readonly attemptLifecycle = new Map<
    string,
    { ownerId: string; generation: number }
  >();

  constructor(
    private readonly repository: UsageLedgerRepository,
    private readonly controlPlane: ControlPlaneService,
    private readonly options: UsageLedgerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) {
      throw new Error("Retensi usage ledger tidak sah.");
    }
  }

  async startAttempt(context: ProviderAttemptStart): Promise<void> {
    await this.exclusiveOwner(context.ownerId, async () => {
      if (this.blockedOwners.has(context.ownerId)) return;
      const generation = this.ownerGenerations.get(context.ownerId) ?? 0;
      this.attemptLifecycle.set(context.attemptId, {
        ownerId: context.ownerId,
        generation,
      });
      const record = await this.newAttemptRecord(context);
      if (
        this.blockedOwners.has(context.ownerId) ||
        generation !== (this.ownerGenerations.get(context.ownerId) ?? 0)
      ) {
        this.attemptLifecycle.delete(context.attemptId);
        return;
      }
      this.pendingAttempts.set(record.attemptId, record);
      await this.flushAttempts();
    });
  }

  private async newAttemptRecord(
    context: ProviderAttemptStart,
  ): Promise<ProviderAttemptRecord> {
    const effective = await this.controlPlane.effectiveEnrollment(context.ownerId);
    const actorRef = context.subjectKind === "group"
      ? await this.controlPlane.resolvePrincipal(
          effective.enrollment.subjectRef,
          context.actorAliases,
        )
      : effective.enrollment.subjectRef;
    const price = await this.controlPlane.priceAt(
      context.providerId,
      context.modelId,
      context.startedAt,
    );
    return {
      schemaVersion: 1,
      attemptId: context.attemptId,
      requestId: context.requestId,
      turnId: cleanOptionalRef(context.turnId),
      attemptNo: nonNegativeInteger(context.attemptNo),
      startedAt: context.startedAt,
      finishedAt: null,
      environment: context.environment,
      costCenter: context.costCenter,
      subjectRef: effective.enrollment.subjectRef,
      subjectKind: context.subjectKind,
      channel: context.channel,
      actorRef,
      cohort: effective.effectiveCohort,
      planId: effective.enrollment.planId,
      providerId: cleanCatalogValue(context.providerId),
      origin: context.origin,
      modelId: cleanCatalogValue(context.modelId),
      tier: context.tier,
      purpose: context.purpose,
      maxOutputTokens: nonNegativeInteger(context.maxOutputTokens),
      inputTokenEstimate: nonNegativeInteger(context.inputTokenEstimate),
      safetyCritical: context.safetyCritical,
      status: "started",
      httpStatus: null,
      responseOutcome: "not_checked",
      finishReason: null,
      latencyMs: null,
      usage: emptyUsage(),
      providerGenerationId: null,
      priceVersionId: price?.id ?? null,
      priceSnapshot: price ? structuredClone(price.rates) : null,
      cost: {
        providerReportedUsdNanos: null,
        localCalculatedUsdNanos: null,
        effectiveUsdNanos: null,
        effectiveSource: "unpriced",
        reconciliation: "pending",
      },
    };
  }

  async finishAttempt(
    context: ProviderAttemptStart,
    result: ProviderAttemptFinish,
  ): Promise<void> {
    await this.exclusiveOwner(context.ownerId, async () => {
      const lifecycle = this.attemptLifecycle.get(context.attemptId);
      if (
        !lifecycle ||
        lifecycle.ownerId !== context.ownerId ||
        lifecycle.generation !== (this.ownerGenerations.get(context.ownerId) ?? 0) ||
        this.blockedOwners.has(context.ownerId)
      ) {
        return;
      }
      const record =
        this.pendingAttempts.get(context.attemptId) ??
        await this.repository.attempt(context.attemptId) ??
        await this.newAttemptRecord(context);

      const usage = normalizeProviderUsage(result.usage);
      const providerCost = result.usage.providerCostUsd === null
        ? null
        : usdDecimalToNanos(result.usage.providerCostUsd);
      const localCost = calculateLocalCost(record, usage);
      const effectiveCost = providerCost ?? localCost;
      const reconciliation = reconciliationState(
        result.status,
        providerCost,
        localCost,
      );
      const finished: ProviderAttemptRecord = {
        ...record,
        finishedAt: result.finishedAt,
        status: result.status,
        httpStatus:
          result.httpStatus === null ? null : nonNegativeInteger(result.httpStatus),
        responseOutcome: result.responseOutcome,
        finishReason: cleanFinishReason(result.finishReason),
        latencyMs: nonNegativeInteger(result.latencyMs),
        usage,
        providerGenerationId: cleanProviderReference(
          result.usage.providerGenerationId,
        ),
        cost: {
          providerReportedUsdNanos: providerCost?.toString() ?? null,
          localCalculatedUsdNanos: localCost?.toString() ?? null,
          effectiveUsdNanos: effectiveCost?.toString() ?? null,
          effectiveSource: providerCost !== null
            ? "provider"
            : localCost !== null
              ? "catalog"
              : "unpriced",
          reconciliation,
        },
      };
      this.pendingAttempts.set(finished.attemptId, finished);
      await this.flushAttempts();
    });
  }

  async attempts(filter: UsageLedgerFilter = {}): Promise<ProviderAttemptRecord[]> {
    await this.flushAttempts();
    const limit = Math.max(1, Math.min(10_000, filter.limit ?? 1_000));
    const records = await this.readCanonicalAttempts({ ...filter, limit });
    return records.slice(0, limit);
  }

  /**
   * Membaca seluruh record yang cocok untuk agregasi dan ekspor. Batas HTTP
   * tetap diterapkan oleh `attempts`; total finansial tidak boleh terpotong
   * hanya karena tabel Console memakai pagination/batas tampilan.
   */
  async allAttempts(
    filter: Omit<UsageLedgerFilter, "limit"> = {},
  ): Promise<ProviderAttemptRecord[]> {
    await this.flushAttempts();
    return this.readCanonicalAttempts({
      ...filter,
      limit: Number.MAX_SAFE_INTEGER,
    });
  }

  async summary(filter: UsageLedgerFilter = {}): Promise<UsageLedgerSummary> {
    const { limit: _displayLimit, ...aggregateFilter } = filter;
    const attempts = await this.allAttempts(aggregateFilter);
    return summarizeAttempts(attempts, await this.costViews(attempts));
  }

  async breakdown(
    filter: Omit<UsageLedgerFilter, "limit" | "cohort" | "planId"> = {},
  ): Promise<UsageLedgerBreakdown> {
    const attempts = await this.allAttempts(filter);
    const costViews = await this.costViews(attempts);
    const byCohort = new Map<"standard" | "beta", ProviderAttemptRecord[]>();
    const byPlan = new Map<string, ProviderAttemptRecord[]>();
    for (const attempt of attempts) {
      const cohortRecords = byCohort.get(attempt.cohort) ?? [];
      cohortRecords.push(attempt);
      byCohort.set(attempt.cohort, cohortRecords);
      const planRecords = byPlan.get(attempt.planId) ?? [];
      planRecords.push(attempt);
      byPlan.set(attempt.planId, planRecords);
    }
    return {
      byCohort: (["standard", "beta"] as const)
        .filter((cohort) => byCohort.has(cohort))
        .map((cohort) => ({
          cohort,
          summary: summarizeAttempts(byCohort.get(cohort) ?? [], costViews),
        })),
      byPlan: [...byPlan]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([planId, records]) => ({
          planId,
          summary: summarizeAttempts(records, costViews),
        })),
    };
  }

  /**
   * Tampilan biaya read-only. Attempt lama tanpa snapshot tidak diubah; bila
   * usage tersedia, Console boleh memperlihatkan estimasi dengan tarif katalog
   * yang berlaku sekarang dan wajib membedakannya dari biaya tercatat.
   */
  async costViews(
    attempts: readonly ProviderAttemptRecord[],
  ): Promise<Map<string, UsageCostView>> {
    const currentPrices = currentPriceIndex(
      await this.controlPlane.prices(),
      this.now().toISOString(),
    );
    const views = new Map<string, UsageCostView>();
    for (const attempt of attempts) {
      if (attempt.cost.effectiveUsdNanos !== null) {
        views.set(attempt.attemptId, {
          costUsdNanos: attempt.cost.effectiveUsdNanos,
          source: "recorded",
          reason: "recorded",
          priceVersionId: attempt.priceVersionId,
        });
        continue;
      }
      if (attempt.usage.source === "none") {
        views.set(attempt.attemptId, {
          costUsdNanos: null,
          source: "unavailable",
          reason: "usage_missing",
          priceVersionId: null,
        });
        continue;
      }
      const price = currentPrices.get(priceKey(attempt.providerId, attempt.modelId));
      if (price === undefined) {
        views.set(attempt.attemptId, {
          costUsdNanos: null,
          source: "unavailable",
          reason: "current_price_missing",
          priceVersionId: null,
        });
        continue;
      }
      const estimate = calculateCostWithRates(price.rates, attempt.usage);
      views.set(attempt.attemptId, estimate === null
        ? {
            costUsdNanos: null,
            source: "unavailable",
            reason: "usage_missing",
            priceVersionId: null,
          }
        : {
            costUsdNanos: estimate.toString(),
            source: "current_catalog_estimate",
            reason: "historical_price_missing",
            priceVersionId: price.id,
          });
    }
    return views;
  }

  async exportOwner(ownerId: string): Promise<ProviderAttemptRecord[]> {
    const subjectRef = await this.controlPlane.subjectRef(ownerId);
    return this.allAttempts({ subjectRef });
  }

  async exportEntitlements(ownerId: string): Promise<EntitlementEntry[]> {
    await this.flushEntitlements();
    const subjectRef = await this.controlPlane.subjectRef(ownerId);
    return this.options.entitlementRepository?.list(subjectRef) ?? [];
  }

  async entitlementSummary(since?: string): Promise<EntitlementSummary> {
    await this.flushEntitlements();
    const entries = await this.options.entitlementRepository?.list() ?? [];
    const threshold = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const selected = entries.filter((entry) => Date.parse(entry.at) >= threshold);
    return {
      entries: selected.length,
      debitedTokens: selected.reduce((sum, entry) => sum + entry.debitedTokens, 0),
      includedTokens: selected
        .filter((entry) => entry.disposition === "included_overhead")
        .reduce((sum, entry) => sum + entry.measuredTokens, 0),
      safetyExemptTokens: selected
        .filter((entry) => entry.disposition === "safety_exempt")
        .reduce((sum, entry) => sum + entry.measuredTokens, 0),
    };
  }

  /**
   * Sumber otoritas kapasitas paket untuk satu subject. Provider usage tetap
   * dicatat terpisah, tetapi hanya debit yang sudah melewati konfirmasi
   * delivery yang boleh ikut ke gerbang kuota.
   */
  async debitedTokens(ownerId: string, since: Date): Promise<number | null> {
    const queued = this.ownerQueues.get(ownerId);
    if (queued) await queued;
    await this.flushEntitlements();
    const repository = this.options.entitlementRepository;
    if (!repository) return null;
    const threshold = since.getTime();
    const subjectRef = await this.controlPlane.subjectRef(ownerId);
    const entries = await repository.list(subjectRef);
    return entries
      .filter((entry) => Date.parse(entry.at) >= threshold)
      .reduce((sum, entry) => sum + nonNegativeInteger(entry.debitedTokens), 0);
  }

  /** Debit yang sudah diukur tetapi masih menunggu konfirmasi delivery. */
  async pendingDebitTokens(ownerId: string, since: Date): Promise<number> {
    const queued = this.ownerQueues.get(ownerId);
    if (queued) await queued;
    const threshold = since.getTime();
    return [...this.pendingDeliveryCandidates.values()]
      .filter((candidate) =>
        candidate.ownerId === ownerId &&
        Date.parse(candidate.entry.at) >= threshold
      )
      .reduce(
        (sum, candidate) =>
          sum + nonNegativeInteger(candidate.entry.debitedTokens),
        0,
      );
  }

  async settleEntitlement(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean },
  ): Promise<void> {
    await this.exclusiveOwner(context.ownerId, async () => {
      const repository = this.options.entitlementRepository;
      if (!repository || this.blockedOwners.has(context.ownerId)) return;
      const effective = await this.controlPlane.effectiveEnrollment(context.ownerId);
      const measuredTokens = Math.max(
        nonNegativeInteger(usage.totalTokens),
        nonNegativeInteger(usage.inputTokens) + nonNegativeInteger(usage.outputTokens),
      );
      const disposition = entitlementDisposition(context, outcome.succeeded);
      const entry: EntitlementEntry = {
        schemaVersion: 1,
        entryId: `entitlement_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        idempotencyKey: context.requestId,
        requestId: context.requestId,
        turnId: context.turnId,
        subjectRef: effective.enrollment.subjectRef,
        planId: effective.enrollment.planId,
        cohort: effective.effectiveCohort,
        tier: context.tier,
        purpose: context.purpose,
        modelId: cleanCatalogValue(context.model),
        type:
          disposition === "charge"
            ? "debit"
            : disposition === "safety_exempt"
              ? "safety_exempt"
              : "included",
        disposition,
        measuredTokens,
        debitedTokens: disposition === "charge" ? measuredTokens : 0,
        succeeded: outcome.succeeded,
        at: this.now().toISOString(),
      };
      if (disposition === "charge") {
        this.pendingDeliveryCandidates.set(entry.idempotencyKey, {
          ownerId: context.ownerId,
          entry,
        });
        const terminal = this.terminalTurn(context.ownerId, context.turnId);
        if (terminal === "discarded") {
          this.pendingDeliveryCandidates.delete(entry.idempotencyKey);
          return;
        }
        if (terminal === "delivered") {
          this.pendingEntitlements.set(entry.idempotencyKey, entry);
          await this.flushEntitlements();
          if (!this.pendingEntitlements.has(entry.idempotencyKey)) {
            this.pendingDeliveryCandidates.delete(entry.idempotencyKey);
          }
        }
        return;
      }
      this.pendingEntitlements.set(entry.idempotencyKey, entry);
      await this.flushEntitlements();
    });
  }

  /** Debit baru dibuat setelah adapter menyatakan balasan berhasil dikirim. */
  async markDelivered(ownerId: string, turnId: string | null): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      this.setTerminalTurn(ownerId, turnId, "delivered");
      const candidates = [...this.pendingDeliveryCandidates]
        .filter(([, candidate]) =>
          candidate.ownerId === ownerId &&
          candidate.entry.turnId === turnId
        );
      for (const [key, candidate] of candidates) {
        this.pendingEntitlements.set(key, candidate.entry);
      }
      await this.flushEntitlements();
      for (const [key] of candidates) {
        if (!this.pendingEntitlements.has(key)) {
          this.pendingDeliveryCandidates.delete(key);
        }
      }
    });
  }

  /** Balasan yang gagal dikirim atau diganti tidak boleh mengurangi paket. */
  async discardUndelivered(
    ownerId: string,
    turnId: string | null,
  ): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      this.setTerminalTurn(ownerId, turnId, "discarded");
      for (const [key, candidate] of this.pendingDeliveryCandidates) {
        if (
          candidate.ownerId === ownerId &&
          candidate.entry.turnId === turnId
        ) {
          this.pendingDeliveryCandidates.delete(key);
          this.pendingEntitlements.delete(key);
        }
      }
    });
  }

  async forgetOwner(ownerId: string): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      this.blockedOwners.add(ownerId);
      this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
      const subjectRef = await this.controlPlane.subjectRef(ownerId);
      for (const [key, attempt] of this.pendingAttempts) {
        if (attempt.subjectRef === subjectRef) this.pendingAttempts.delete(key);
      }
      for (const [attemptId, lifecycle] of this.attemptLifecycle) {
        if (lifecycle.ownerId === ownerId) this.attemptLifecycle.delete(attemptId);
      }
      await this.attemptQueue.catch(() => undefined);
      for (const [key, entry] of this.pendingEntitlements) {
        if (entry.subjectRef === subjectRef) this.pendingEntitlements.delete(key);
      }
      for (const [key, candidate] of this.pendingDeliveryCandidates) {
        if (candidate.ownerId === ownerId) {
          this.pendingDeliveryCandidates.delete(key);
        }
      }
      this.terminalTurns.delete(ownerId);
      await this.entitlementQueue.catch(() => undefined);
      await this.repository.removeSubject(subjectRef);
      await this.options.entitlementRepository?.removeSubject(subjectRef);
      await this.controlPlane.forgetOwner(ownerId);
    });
  }

  async allowOwner(ownerId: string): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      this.blockedOwners.delete(ownerId);
    });
  }

  async forgetActor(
    ownerId: string,
    actorAliases: readonly string[],
  ): Promise<boolean> {
    return this.exclusiveOwner(ownerId, async () => {
      const subjectRef = await this.controlPlane.subjectRef(ownerId);
      const principalRefs = await this.controlPlane.principalRefsForAliases(
        subjectRef,
        actorAliases,
      );
      if (principalRefs.length === 0) return false;
      const targets = new Set(principalRefs);
      let pendingRemoved = 0;
      for (const [key, attempt] of this.pendingAttempts) {
        if (
          attempt.subjectRef === subjectRef &&
          attempt.actorRef !== null &&
          targets.has(attempt.actorRef)
        ) {
          this.pendingAttempts.delete(key);
          this.attemptLifecycle.delete(attempt.attemptId);
          pendingRemoved += 1;
        }
      }
      await this.attemptQueue.catch(() => undefined);
      const storedRemoved = await this.repository.removeActors(
        subjectRef,
        principalRefs,
      );
      await this.controlPlane.removePrincipalRefs(subjectRef, principalRefs);
      return pendingRemoved + storedRemoved > 0;
    });
  }

  async purgeExpired(): Promise<void> {
    await this.flushAttempts();
    await this.flushEntitlements();
    const before = new Date(
      this.now().getTime() - this.options.retentionDays * 24 * 60 * 60 * 1_000,
    );
    await Promise.all([
      this.repository.removeBefore(before),
      this.options.entitlementRepository?.removeBefore(before) ?? Promise.resolve(),
    ]);
  }

  async drain(): Promise<void> {
    while (this.ownerQueues.size > 0) {
      await Promise.allSettled([...this.ownerQueues.values()]);
    }
    // Kandidat tanpa promotion memang belum delivered. Kandidat yang sudah
    // dipromosikan tetap dihitung dan dipertahankan sampai append berhasil.
    for (const [key] of this.pendingDeliveryCandidates) {
      if (!this.pendingEntitlements.has(key)) {
        this.pendingDeliveryCandidates.delete(key);
      }
    }
    await Promise.all([this.flushAttempts(), this.flushEntitlements()]);
    for (const [key] of this.pendingDeliveryCandidates) {
      if (!this.pendingEntitlements.has(key)) {
        this.pendingDeliveryCandidates.delete(key);
      }
    }
    this.terminalTurns.clear();
  }

  private async flushAttempts(): Promise<void> {
    if (this.pendingAttempts.size === 0) return;
    const run = this.attemptQueue.then(async () => {
      for (const [key, attempt] of this.pendingAttempts) {
        if (attempt.status === "started") {
          await this.repository.startAttempt(attempt);
        } else {
          await this.repository.finishAttempt(attempt);
        }
        this.pendingAttempts.delete(key);
        if (attempt.status !== "started") {
          this.attemptLifecycle.delete(attempt.attemptId);
        }
      }
    });
    this.attemptQueue = run.catch(() => undefined);
    await run;
  }

  private async flushEntitlements(): Promise<void> {
    const repository = this.options.entitlementRepository;
    if (!repository || this.pendingEntitlements.size === 0) return;
    const run = this.entitlementQueue.then(async () => {
      for (const [key, entry] of this.pendingEntitlements) {
        await repository.append(entry);
        this.pendingEntitlements.delete(key);
        this.pendingDeliveryCandidates.delete(key);
      }
    });
    this.entitlementQueue = run.catch(() => undefined);
    await run;
  }

  private async readCanonicalAttempts(
    filter: UsageLedgerFilter,
  ): Promise<ProviderAttemptRecord[]> {
    const requestedActor = filter.actorRef;
    const repositoryFilter: UsageLedgerFilter = { ...filter };
    delete repositoryFilter.actorRef;
    const records = await this.repository.list(repositoryFilter);
    const canonical = await Promise.all(records.map(async (record) => ({
      ...record,
      actorRef: record.actorRef
        ? await this.controlPlane.canonicalPrincipalRef(record.actorRef)
        : null,
    })));
    return requestedActor
      ? canonical.filter((record) => record.actorRef === requestedActor)
      : canonical;
  }

  private async exclusiveOwner<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerQueues.set(ownerId, settled);
    void settled.then(() => {
      if (this.ownerQueues.get(ownerId) === settled) {
        this.ownerQueues.delete(ownerId);
      }
    });
    return result;
  }

  private terminalTurn(
    ownerId: string,
    turnId: string | null,
  ): "delivered" | "discarded" | null {
    if (turnId === null) return null;
    this.pruneTerminalTurns(ownerId);
    return this.terminalTurns.get(ownerId)?.get(turnId)?.state ?? null;
  }

  private setTerminalTurn(
    ownerId: string,
    turnId: string | null,
    state: "delivered" | "discarded",
  ): void {
    if (turnId === null) return;
    this.pruneTerminalTurns(ownerId);
    const turns = this.terminalTurns.get(ownerId) ?? new Map();
    turns.set(turnId, { state, at: this.now().getTime() });
    this.terminalTurns.set(ownerId, turns);
  }

  private pruneTerminalTurns(ownerId: string): void {
    const turns = this.terminalTurns.get(ownerId);
    if (!turns) return;
    const before = this.now().getTime() - 24 * 60 * 60 * 1_000;
    for (const [turnId, terminal] of turns) {
      if (terminal.at < before) turns.delete(turnId);
    }
    if (turns.size === 0) this.terminalTurns.delete(ownerId);
  }
}

function entitlementDisposition(
  context: AiUsageContext,
  succeeded: boolean,
): EntitlementEntry["disposition"] {
  if (context.safetyCritical) return "safety_exempt";
  if (
    !succeeded ||
    context.purpose === "turn-boundary" ||
    context.purpose === "understanding" ||
    context.purpose === "due-date" ||
    context.purpose === "risk-triage" ||
    context.purpose === "reply-review" ||
    context.purpose === "summary" ||
    context.purpose === "insight" ||
    context.purpose === "group-participation"
  ) {
    return "included_overhead";
  }
  return "charge";
}

function summarizeAttempts(
  attempts: readonly ProviderAttemptRecord[],
  costViews: ReadonlyMap<string, UsageCostView>,
): UsageLedgerSummary {
  const requestIds = new Set(attempts.map((attempt) => attempt.requestId));
  const pricedAttempts = attempts.filter(
    (attempt) => attempt.cost.effectiveUsdNanos !== null,
  );
  const unpricedAttempts = attempts.length - pricedAttempts.length;
  const views = attempts.map((attempt) =>
    costViews.get(attempt.attemptId) ?? {
      costUsdNanos: null,
      source: "unavailable" as const,
      reason: "usage_missing" as const,
      priceVersionId: null,
    }
  );
  const reportableViews = views.filter((view) => view.costUsdNanos !== null);
  const estimatedViews = views.filter(
    (view) => view.source === "current_catalog_estimate",
  );
  const unavailableCostAttempts = views.filter(
    (view) => view.source === "unavailable",
  ).length;
  return {
    attempts: attempts.length,
    logicalRequests: requestIds.size,
    completedAttempts: attempts.filter((attempt) => attempt.status === "completed").length,
    fallbackAttempts: attempts.filter((attempt) => attempt.origin === "fallback").length,
    estimatedAttempts: attempts.filter((attempt) => attempt.usage.source === "estimated").length,
    unpricedAttempts,
    pendingAttempts: attempts.filter(
      (attempt) =>
        attempt.status === "started" || attempt.cost.reconciliation === "pending",
    ).length,
    inputTokens: attempts.reduce((sum, attempt) => sum + attempt.usage.inputTokens, 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0),
    totalTokens: attempts.reduce((sum, attempt) => sum + attempt.usage.totalTokens, 0),
    inputTokenEstimateRequested: attempts.reduce(
      (sum, attempt) => sum + attempt.inputTokenEstimate,
      0,
    ),
    maxOutputTokensRequested: attempts.reduce(
      (sum, attempt) => sum + attempt.maxOutputTokens,
      0,
    ),
    effectiveCostUsdNanos:
      attempts.length > 0 && pricedAttempts.length === 0
        ? null
        : sumNanos(pricedAttempts.map((attempt) => attempt.cost.effectiveUsdNanos)),
    costCompleteness:
      unpricedAttempts === 0
        ? "complete"
        : pricedAttempts.length === 0
          ? "unknown"
          : "partial",
    indicativeCostUsdNanos:
      attempts.length > 0 && reportableViews.length === 0
        ? null
        : sumNanos(reportableViews.map((view) => view.costUsdNanos)),
    currentPriceEstimateUsdNanos: sumNanos(
      estimatedViews.map((view) => view.costUsdNanos),
    ),
    currentPriceEstimatedAttempts: estimatedViews.length,
    unavailableCostAttempts,
    historicalPriceGapAttempts: views.filter(
      (view) => view.reason === "historical_price_missing",
    ).length,
    missingUsageAttempts: views.filter(
      (view) => view.reason === "usage_missing",
    ).length,
    costCoverage:
      attempts.length === 0 ||
        (estimatedViews.length === 0 && unavailableCostAttempts === 0)
        ? "complete"
        : unavailableCostAttempts === 0
          ? "estimated"
          : reportableViews.length > 0
            ? "partial"
            : "unavailable",
    providerReportedUsdNanos: sumNanos(
      attempts.map((attempt) => attempt.cost.providerReportedUsdNanos),
    ),
    localCalculatedUsdNanos: sumNanos(
      attempts.map((attempt) => attempt.cost.localCalculatedUsdNanos),
    ),
  };
}

function normalizeProviderUsage(
  usage: ProviderTokenUsage,
): ProviderAttemptRecord["usage"] {
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const totalTokens = Math.max(
    nonNegativeInteger(usage.totalTokens),
    inputTokens + outputTokens,
  );
  const reasoningTokens = optionalTokenCount(usage.reasoningTokens, outputTokens);
  const cacheReadTokens = optionalTokenCount(usage.cacheReadTokens, inputTokens);
  const cacheWriteTokens = optionalTokenCount(
    usage.cacheWriteTokens,
    Math.max(0, inputTokens - (cacheReadTokens ?? 0)),
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: usage.estimated === true,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    source:
      inputTokens === 0 && outputTokens === 0
        ? "none"
        : usage.estimated
          ? "estimated"
          : "provider",
  };
}

function calculateLocalCost(
  record: ProviderAttemptRecord,
  usage: ProviderAttemptRecord["usage"],
): bigint | null {
  const rates = record.priceSnapshot;
  return rates ? calculateCostWithRates(rates, usage) : null;
}

function calculateCostWithRates(
  rates: ModelPriceRates,
  usage: ProviderAttemptRecord["usage"],
): bigint | null {
  if (usage.source === "none") return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const reasoning = usage.reasoningTokens ?? 0;
  const regularOutput = Math.max(0, usage.outputTokens - reasoning);
  const parts = [
    tokenCostNanos(uncachedInput, rates.inputPerMillionUsd),
    tokenCostNanos(
      cacheRead,
      rates.cacheReadPerMillionUsd ?? rates.inputPerMillionUsd,
    ),
    tokenCostNanos(
      cacheWrite,
      rates.cacheWritePerMillionUsd ?? rates.inputPerMillionUsd,
    ),
    tokenCostNanos(regularOutput, rates.outputPerMillionUsd),
    tokenCostNanos(
      reasoning,
      rates.reasoningPerMillionUsd ?? rates.outputPerMillionUsd,
    ),
    rates.perRequestUsd === null
      ? 0n
      : usdDecimalToNanos(rates.perRequestUsd),
  ];
  if (parts.some((part) => part === null)) return null;
  return parts.reduce<bigint>((sum, part) => sum + (part ?? 0n), 0n);
}

function currentPriceIndex(
  prices: readonly ModelPriceVersion[],
  at: string,
): Map<string, ModelPriceVersion> {
  const index = new Map<string, ModelPriceVersion>();
  for (const price of prices) {
    const key = priceKey(price.providerId, price.modelId);
    if (
      index.has(key) ||
      price.status === "retired" ||
      price.effectiveFrom > at ||
      (price.effectiveTo !== null && price.effectiveTo <= at)
    ) {
      continue;
    }
    index.set(key, price);
  }
  return index;
}

function priceKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function reconciliationState(
  status: ProviderAttemptFinish["status"],
  provider: bigint | null,
  local: bigint | null,
): ProviderAttemptRecord["cost"]["reconciliation"] {
  if (provider !== null && local !== null) {
    return provider === local ? "matched" : "adjusted";
  }
  if (provider !== null || local !== null) return "unavailable";
  return status === "timeout" ||
    status === "unknown" ||
    status === "http_error" ||
    status === "response_rejected"
    ? "pending"
    : "unavailable";
}

function emptyUsage(): ProviderAttemptRecord["usage"] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimated: true,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    source: "none",
  };
}

function optionalTokenCount(value: number | null, maximum: number): number | null {
  if (value === null) return null;
  return Math.min(maximum, nonNegativeInteger(value));
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function cleanCatalogValue(value: string): string {
  const clean = value.replace(/[\u0000-\u001f<>]/gu, "").slice(0, 160);
  return clean || "unknown";
}

function cleanOptionalRef(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 96);
  return clean || null;
}

function cleanProviderReference(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.replace(/[^a-zA-Z0-9_.:-]/gu, "").slice(0, 128);
  return clean || null;
}

function cleanFinishReason(value: string | null): string | null {
  if (value === null) return null;
  return (["stop", "length", "tool_calls", "content_filter"] as const).includes(
    value as "stop" | "length" | "tool_calls" | "content_filter",
  )
    ? value
    : "other";
}

function sumNanos(values: readonly (string | null)[]): string {
  return values.reduce<bigint>((sum, value) => {
    if (value === null || !/^\d+$/u.test(value)) return sum;
    return sum + BigInt(value);
  }, 0n).toString();
}
