import { readFile } from "node:fs/promises";
import type { EconomyRepository, EconomyState } from "../domain/economy.js";
import { writeDurableFileAtomic } from "./durable-file.js";

interface EconomyStateV1 {
  version: 1;
  /** Prototype lama tidak mempunyai ledger; migrasi sengaja tidak menebak uang. */
  subjects?: unknown[];
}

export class FileEconomyRepository implements EconomyRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private state: Promise<EconomyState> | null = null;

  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<EconomyState> {
    return structuredClone(await this.readState());
  }

  async mutate<T>(operation: (draft: EconomyState) => T): Promise<T> {
    return this.exclusive(async () => {
      const draft = structuredClone(await this.readState());
      const result = operation(draft);
      await this.writeState(draft);
      return result;
    });
  }

  private async readState(): Promise<EconomyState> {
    this.state ??= this.loadState();
    return this.state;
  }

  private async loadState(): Promise<EconomyState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as
        | Partial<EconomyState>
        | EconomyStateV1;
      const migrated = migrateEconomyState(parsed);
      if (parsed.version === 1 || shouldPersistMigration(parsed, migrated)) {
        await this.persistState(migrated);
      }
      return migrated;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyEconomyState();
      throw error;
    }
  }

  private async writeState(state: EconomyState): Promise<void> {
    await this.persistState(state);
    this.state = Promise.resolve(state);
  }

  private async persistState(state: EconomyState): Promise<void> {
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function emptyEconomyState(): EconomyState {
  return {
    version: 2,
    legacyOverlayCutoffAt: null,
    subscriptions: [],
    periods: [],
    sponsoredGrants: [],
    reservations: [],
    settlements: [],
    walletTransactions: [],
    walletAccounts: [],
    payments: [],
    contributions: [],
    credentials: [],
    preferences: [],
    notifications: [],
    supportPrompts: [],
    usageProjections: [],
    ledger: [],
  };
}

function migrateEconomyState(
  parsed: Partial<EconomyState> | EconomyStateV1,
): EconomyState {
  if (parsed.version === 1) {
    // State prototype tidak mempunyai semantics finansial yang dapat dipercaya.
    // Ledger token v1 tetap berada di entitlement-ledger dan tidak dikonversi.
    return emptyEconomyState();
  }
  const keys = [
    "subscriptions", "periods", "sponsoredGrants", "reservations",
    "settlements", "walletTransactions", "walletAccounts", "payments",
    "contributions", "credentials", "preferences", "notifications",
    "supportPrompts", "usageProjections", "ledger",
  ] as const;
  if (parsed.version !== 2) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
  const migrated = { ...(parsed as Partial<EconomyState>) } as Record<string, unknown>;
  // v2 was introduced before every projection field existed. Missing arrays
  // are safe empty projections; historical ledger entries are never rewritten.
  for (const key of keys) {
    if (migrated[key] === undefined) migrated[key] = [];
    if (!Array.isArray(migrated[key])) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
  }
  if (migrated.legacyOverlayCutoffAt === undefined) migrated.legacyOverlayCutoffAt = null;
  if (
    migrated.legacyOverlayCutoffAt !== null &&
    (typeof migrated.legacyOverlayCutoffAt !== "string" ||
      !Number.isFinite(Date.parse(migrated.legacyOverlayCutoffAt)))
  ) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
  const state = migrated as unknown as EconomyState;
  validateEconomyState(state);
  return state;
}

function validateEconomyState(state: EconomyState): void {
  for (const subscription of state.subscriptions) {
    if (![
      "none", "trial", "free", "active", "past_due",
      "cancel_at_period_end", "cancelled", "expired",
    ].includes(subscription.status)) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
    validateIso(subscription.currentPeriodStart);
    validateIso(subscription.currentPeriodEnd);
    validateIso(subscription.lastEventAt);
    validateIso(subscription.createdAt);
    validateIso(subscription.updatedAt);
    if (Date.parse(subscription.currentPeriodStart) >= Date.parse(subscription.currentPeriodEnd)) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
  }
  for (const period of state.periods) {
    validateCompute(period.includedGranted);
    validateCompute(period.includedUsed);
    validateCompute(period.includedReserved);
    validateIso(period.startsAt);
    validateIso(period.endsAt);
    if (Date.parse(period.startsAt) >= Date.parse(period.endsAt)) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
  }
  for (const grant of state.sponsoredGrants) {
    validateCompute(grant.amount);
    validateCompute(grant.used);
    validateCompute(grant.reserved);
    validateIso(grant.effectiveFrom);
    if (grant.expiresAt !== null) validateIso(grant.expiresAt);
  }
  for (const reservation of state.reservations) {
    validateCompute(reservation.estimatedComputeUnits);
    if (reservation.actualComputeUnits !== null) validateCompute(reservation.actualComputeUnits);
    if (
      reservation.walletComputeUnitsPerIdr !== undefined &&
      reservation.walletComputeUnitsPerIdr !== null
    ) {
      validateCompute(reservation.walletComputeUnitsPerIdr);
      if (BigInt(reservation.walletComputeUnitsPerIdr) <= 0n) {
        throw new Error("Format economy ledger tidak dikenali.");
      }
    }
    validateIso(reservation.reservedAt);
    validateIso(reservation.expiresAt);
    if (reservation.completedAt !== null) validateIso(reservation.completedAt);
    if (reservation.settledAt !== null) validateIso(reservation.settledAt);
  }
  for (const settlement of state.settlements) {
    validateCompute(settlement.billableComputeUnits);
    validateCompute(settlement.measuredComputeUnits);
    if (
      settlement.walletDebitIdrNanos !== undefined &&
      settlement.walletDebitIdrNanos !== null
    ) {
      validateCompute(settlement.walletDebitIdrNanos);
    }
    validateIso(settlement.settledAt);
  }
  for (const wallet of state.walletAccounts) {
    validateCompute(wallet.availableComputeUnits);
    validateCompute(wallet.reservedComputeUnits);
    if (!Number.isSafeInteger(wallet.lifetimeTopupIdr) || wallet.lifetimeTopupIdr < 0) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
  }
  for (const transaction of state.walletTransactions) {
    validateCompute(transaction.computeUnits);
    validateIdr(transaction.amountIdr, true);
    validateIso(transaction.createdAt);
  }
  for (const payment of state.payments) {
    validateIdr(payment.amountIdr, false);
    if (
      payment.subscriptionAction !== undefined &&
      payment.subscriptionAction !== null &&
      payment.subscriptionAction !== "activate" &&
      payment.subscriptionAction !== "renew"
    ) {
      throw new Error("Format economy ledger tidak dikenali.");
    }
    validateIso(payment.createdAt);
    validateIso(payment.updatedAt);
  }
  for (const contribution of state.contributions) {
    validateIdr(contribution.amountIdr, false);
    validateIso(contribution.createdAt);
    validateIso(contribution.updatedAt);
  }
  for (const entry of state.ledger) {
    validateSignedCompute(entry.amountComputeUnits);
    validateIdr(entry.amountIdr, true);
    validateIso(entry.at);
  }
}

function validateCompute(value: unknown): void {
  if (typeof value !== "string" || !/^\d+$/u.test(value) || value.length > 80) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
}

function validateSignedCompute(value: unknown): void {
  if (typeof value !== "string" || !/^-?\d+$/u.test(value) || value.length > 81) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
}

function validateIdr(value: unknown, allowNegative: boolean): void {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 2_000_000_000 || (!allowNegative && (value as number) <= 0)) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
}

function validateIso(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("Format economy ledger tidak dikenali.");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function shouldPersistMigration(
  parsed: Partial<EconomyState> | EconomyStateV1,
  migrated: EconomyState,
): boolean {
  if (parsed.version !== 2) return false;
  return [
    "legacyOverlayCutoffAt",
    "subscriptions", "periods", "sponsoredGrants", "reservations",
    "settlements", "walletTransactions", "walletAccounts", "payments",
    "contributions", "credentials", "preferences", "notifications",
    "supportPrompts", "usageProjections", "ledger",
  ].some((key) => !(key in parsed)) || migrated.version !== parsed.version;
}
