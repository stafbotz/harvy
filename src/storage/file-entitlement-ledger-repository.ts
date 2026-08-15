import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalPlanId } from "../domain/control-plane.js";
import type {
  EntitlementCandidateStageResult,
  EntitlementDeliveryDecision,
  EntitlementDeliveryScope,
  EntitlementDeliverySettlement,
  EntitlementEntry,
  EntitlementLedgerRepository,
  EntitlementScopeSettlementResult,
  PendingEntitlementCandidate,
} from "../domain/entitlement.js";

interface EntitlementDatabaseV1 {
  version: 1;
  entries: EntitlementEntry[];
}

interface EntitlementDatabase {
  version: 2;
  entries: EntitlementEntry[];
  candidates: PendingEntitlementCandidate[];
  settlements: EntitlementDeliverySettlement[];
}

export class FileEntitlementLedgerRepository
implements EntitlementLedgerRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private database: Promise<EntitlementDatabase> | null = null;

  constructor(private readonly filePath: string) {}

  async append(entry: EntitlementEntry): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readDatabase();
      if (
        current.entries.some(
          (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
        )
      ) {
        // Kontrak legacy/non-scoped memang idempoten berdasarkan requestId.
        return;
      }
      const database = structuredClone(current);
      database.entries.push(canonicalEntry(entry));
      await this.writeDatabase(database);
    });
  }

  async stageCandidate(
    input: PendingEntitlementCandidate,
  ): Promise<EntitlementCandidateStageResult> {
    return this.exclusive(async () => {
      const candidate = normalizeCandidate(input);
      const current = await this.readDatabase();

      const committed = current.entries.find(
        (entry) => entry.idempotencyKey === candidate.entry.idempotencyKey,
      );
      if (committed) {
        if (isExactCommittedCandidate(committed, candidate)) return "committed";
        throw idempotencyCollision(candidate.entry.idempotencyKey);
      }

      const staged = current.candidates.find(
        (item) =>
          item.entry.idempotencyKey === candidate.entry.idempotencyKey,
      );
      if (staged) {
        if (
          sameScope(staged.scope, candidate.scope) &&
          sameEntitlementPayload(staged.entry, candidate.entry)
        ) {
          return "replayed";
        }
        throw idempotencyCollision(candidate.entry.idempotencyKey);
      }

      const stagedScope = current.candidates.find((item) =>
        sameUsageScope(item.scope, candidate.scope)
      );
      if (
        stagedScope !== undefined &&
        stagedScope.scope.subjectRef !== candidate.scope.subjectRef
      ) {
        throw subjectCollision(candidate.scope);
      }
      const terminal = current.settlements.find((settlement) =>
        sameUsageScope(settlement.scope, candidate.scope)
      );
      if (
        terminal !== undefined &&
        terminal.scope.subjectRef !== candidate.scope.subjectRef
      ) {
        throw subjectCollision(candidate.scope);
      }
      if (terminal?.outcome === "discarded") return "discarded";

      const database = structuredClone(current);
      if (terminal?.outcome === "committed") {
        const effectId = requireCommittedEffect(terminal.effectId);
        appendPromotedCandidate(database, candidate, effectId);
        await this.writeDatabase(database);
        return "committed";
      }

      database.candidates.push(candidate);
      await this.writeDatabase(database);
      return "staged";
    });
  }

  async settleScope(
    inputScope: EntitlementDeliveryScope,
    inputDecision: EntitlementDeliveryDecision,
  ): Promise<EntitlementScopeSettlementResult> {
    return this.exclusive(async () => {
      const scope = normalizeScope(inputScope);
      const decision = normalizeDecision(inputDecision);
      const current = await this.readDatabase();
      const terminal = current.settlements.find((settlement) =>
        sameUsageScope(settlement.scope, scope)
      );
      if (terminal) {
        if (terminal.scope.subjectRef !== scope.subjectRef) {
          throw subjectCollision(scope);
        }
        if (
          terminal.outcome === decision.outcome &&
          terminal.effectId === decision.effectId
        ) {
          return "replayed";
        }
        throw new Error(
          "Settlement delivery scope bertabrakan dengan keputusan terminal yang sudah tersimpan.",
        );
      }

      assertEffectNotBoundToAnotherScope(current, scope, decision.effectId);
      if (
        current.candidates.some(
          (candidate) =>
            sameUsageScope(candidate.scope, scope) &&
            candidate.scope.subjectRef !== scope.subjectRef,
        )
      ) {
        throw subjectCollision(scope);
      }
      const database = structuredClone(current);
      const matching = database.candidates.filter((candidate) =>
        sameScope(candidate.scope, scope)
      );

      if (decision.outcome === "committed") {
        const effectId = requireCommittedEffect(decision.effectId);
        for (const candidate of matching) {
          appendPromotedCandidate(database, candidate, effectId);
        }
      }
      database.candidates = database.candidates.filter(
        (candidate) => !sameScope(candidate.scope, scope),
      );
      database.settlements.push({ scope, ...decision });
      await this.writeDatabase(database);
      return "settled";
    });
  }

  async listPendingScopes(
    subjectRef?: string,
  ): Promise<EntitlementDeliveryScope[]> {
    const database = await this.readDatabase();
    const scopes = new Map<string, EntitlementDeliveryScope>();
    for (const candidate of database.candidates) {
      if (
        subjectRef !== undefined &&
        candidate.scope.subjectRef !== subjectRef
      ) {
        continue;
      }
      scopes.set(scopeKey(candidate.scope), candidate.scope);
    }
    return [...scopes.values()].map((scope) => structuredClone(scope));
  }

  async pendingDebitTokens(subjectRef: string, since: Date): Promise<number> {
    const database = await this.readDatabase();
    const threshold = since.getTime();
    return database.candidates
      .filter(
        (candidate) =>
          candidate.scope.subjectRef === subjectRef &&
          Date.parse(candidate.entry.at) >= threshold,
      )
      .reduce(
        (sum, candidate) =>
          sum + nonNegativeInteger(candidate.entry.debitedTokens),
        0,
      );
  }

  async list(subjectRef?: string): Promise<EntitlementEntry[]> {
    const database = await this.readDatabase();
    return database.entries
      .filter((entry) => subjectRef === undefined || entry.subjectRef === subjectRef)
      .map((entry) => structuredClone(entry));
  }

  async removeBefore(before: Date): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readDatabase();
      const threshold = before.getTime();
      const database: EntitlementDatabase = {
        ...structuredClone(current),
        entries: current.entries.filter(
          (entry) => Date.parse(entry.at) >= threshold,
        ),
        candidates: current.candidates.filter(
          (candidate) => Date.parse(candidate.entry.at) >= threshold,
        ),
        settlements: current.settlements.filter(
          (settlement) => Date.parse(settlement.settledAt) >= threshold,
        ),
      };
      if (sameDatabaseSizes(current, database)) return;
      await this.writeDatabase(database);
    });
  }

  async removeSubject(subjectRef: string): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readDatabase();
      const database: EntitlementDatabase = {
        ...structuredClone(current),
        entries: current.entries.filter(
          (entry) => entry.subjectRef !== subjectRef,
        ),
        candidates: current.candidates.filter(
          (candidate) => candidate.scope.subjectRef !== subjectRef,
        ),
        settlements: current.settlements.filter(
          (settlement) => settlement.scope.subjectRef !== subjectRef,
        ),
      };
      if (sameDatabaseSizes(current, database)) return;
      await this.writeDatabase(database);
    });
  }

  private async readDatabase(): Promise<EntitlementDatabase> {
    this.database ??= this.loadDatabase();
    return this.database;
  }

  private async loadDatabase(): Promise<EntitlementDatabase> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as {
        version?: unknown;
        entries?: unknown;
        candidates?: unknown;
        settlements?: unknown;
      };
      const database = migrateDatabase(parsed);
      const migratedPlanIds = migrateLegacyPlanIds(database);
      if (parsed.version === 1 || migratedPlanIds) {
        await this.persistDatabase(database);
      }
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyDatabase();
      }
      throw error;
    }
  }

  private async writeDatabase(database: EntitlementDatabase): Promise<void> {
    await this.persistDatabase(database);
    this.database = Promise.resolve(database);
  }

  private async persistDatabase(database: EntitlementDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function migrateDatabase(parsed: {
  version?: unknown;
  entries?: unknown;
  candidates?: unknown;
  settlements?: unknown;
}): EntitlementDatabase {
  if (parsed.version === 1 && Array.isArray(parsed.entries)) {
    const legacy = parsed as EntitlementDatabaseV1;
    return {
      version: 2,
      entries: structuredClone(legacy.entries),
      candidates: [],
      settlements: [],
    };
  }
  if (
    parsed.version !== 2 ||
    !Array.isArray(parsed.entries) ||
    !Array.isArray(parsed.candidates) ||
    !Array.isArray(parsed.settlements)
  ) {
    throw new Error("Format entitlement ledger tidak dikenali.");
  }
  return parsed as EntitlementDatabase;
}

function emptyDatabase(): EntitlementDatabase {
  return { version: 2, entries: [], candidates: [], settlements: [] };
}

function migrateLegacyPlanIds(database: EntitlementDatabase): boolean {
  let changed = false;
  for (const entry of [
    ...database.entries,
    ...database.candidates.map((candidate) => candidate.entry),
  ]) {
    const migrated = canonicalPlanId(entry.planId);
    if (migrated === entry.planId) continue;
    entry.planId = migrated;
    changed = true;
  }
  return changed;
}

function normalizeCandidate(
  input: PendingEntitlementCandidate,
): PendingEntitlementCandidate {
  const scope = normalizeScope(input.scope);
  const entry = canonicalEntry(input.entry);
  if (scope.subjectRef !== entry.subjectRef) {
    throw new Error("Subject kandidat entitlement tidak cocok dengan delivery scope.");
  }
  if (
    entry.type !== "debit" ||
    entry.disposition !== "charge" ||
    entry.delivery !== undefined
  ) {
    throw new Error("Hanya kandidat debit yang belum committed boleh di-stage.");
  }
  return { scope, entry };
}

function normalizeScope(
  scope: EntitlementDeliveryScope,
): EntitlementDeliveryScope {
  if (scope.kind !== "group_agent_run_attempt") {
    throw new Error("Jenis delivery scope entitlement tidak dikenali.");
  }
  return {
    kind: scope.kind,
    subjectRef: cleanRef(scope.subjectRef, "subjectRef"),
    runId: cleanRef(scope.runId, "runId"),
    attemptId: cleanRef(scope.attemptId, "attemptId"),
  };
}

function normalizeDecision(
  decision: EntitlementDeliveryDecision,
): EntitlementDeliveryDecision {
  if (decision.outcome !== "committed" && decision.outcome !== "discarded") {
    throw new Error("Outcome settlement delivery tidak dikenali.");
  }
  const settledAt = cleanTimestamp(decision.settledAt, "settledAt");
  const effectId = decision.effectId === null
    ? null
    : cleanRef(decision.effectId, "effectId");
  if (decision.outcome === "committed" && effectId === null) {
    throw new Error("Settlement committed wajib memiliki effectId.");
  }
  return { outcome: decision.outcome, effectId, settledAt };
}

function canonicalEntry(entry: EntitlementEntry): EntitlementEntry {
  const cloned = structuredClone(entry);
  cloned.planId = canonicalPlanId(cloned.planId);
  cleanTimestamp(cloned.at, "entry.at");
  cleanRef(cloned.idempotencyKey, "idempotencyKey");
  cleanRef(cloned.requestId, "requestId");
  cleanRef(cloned.subjectRef, "entry.subjectRef");
  return cloned;
}

function appendPromotedCandidate(
  database: EntitlementDatabase,
  candidate: PendingEntitlementCandidate,
  effectId: string,
): void {
  const existing = database.entries.find(
    (entry) => entry.idempotencyKey === candidate.entry.idempotencyKey,
  );
  const promoted: EntitlementEntry = {
    ...candidate.entry,
    delivery: {
      scope: {
        kind: candidate.scope.kind,
        runId: candidate.scope.runId,
        attemptId: candidate.scope.attemptId,
      },
      effectId,
    },
  };
  if (existing) {
    if (sameCommittedEntry(existing, promoted)) return;
    throw idempotencyCollision(candidate.entry.idempotencyKey);
  }
  database.entries.push(promoted);
}

function isExactCommittedCandidate(
  entry: EntitlementEntry,
  candidate: PendingEntitlementCandidate,
): boolean {
  return entry.delivery !== undefined &&
    sameUsageScope(entry.delivery.scope, candidate.scope) &&
    sameEntitlementPayload(entry, candidate.entry);
}

function sameCommittedEntry(
  left: EntitlementEntry,
  right: EntitlementEntry,
): boolean {
  return sameEntitlementPayload(left, right) &&
    left.delivery?.effectId === right.delivery?.effectId &&
    left.delivery !== undefined &&
    right.delivery !== undefined &&
    sameUsageScope(left.delivery.scope, right.delivery.scope);
}

function sameEntitlementPayload(
  left: EntitlementEntry,
  right: EntitlementEntry,
): boolean {
  return JSON.stringify(entitlementPayload(left)) ===
    JSON.stringify(entitlementPayload(right));
}

function entitlementPayload(entry: EntitlementEntry): readonly unknown[] {
  return [
    entry.schemaVersion,
    entry.idempotencyKey,
    entry.requestId,
    entry.turnId,
    entry.subjectRef,
    canonicalPlanId(entry.planId),
    entry.cohort,
    entry.tier,
    entry.purpose,
    entry.modelId,
    entry.type,
    entry.disposition,
    entry.measuredTokens,
    entry.debitedTokens,
    entry.succeeded,
  ];
}

function assertEffectNotBoundToAnotherScope(
  database: EntitlementDatabase,
  scope: EntitlementDeliveryScope,
  effectId: string | null,
): void {
  if (effectId === null) return;
  const settlementCollision = database.settlements.some(
    (settlement) =>
      settlement.effectId === effectId && !sameScope(settlement.scope, scope),
  );
  const entryCollision = database.entries.some(
    (entry) =>
      entry.delivery?.effectId === effectId &&
      !sameUsageScope(entry.delivery.scope, scope),
  );
  if (settlementCollision || entryCollision) {
    throw new Error("effectId delivery sudah terikat ke scope entitlement lain.");
  }
}

function sameScope(
  left: EntitlementDeliveryScope,
  right: EntitlementDeliveryScope,
): boolean {
  return left.subjectRef === right.subjectRef && sameUsageScope(left, right);
}

function sameUsageScope(
  left: { kind: string; runId: string; attemptId: string },
  right: { kind: string; runId: string; attemptId: string },
): boolean {
  return left.kind === right.kind &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId;
}

function scopeKey(scope: EntitlementDeliveryScope): string {
  return JSON.stringify([
    scope.kind,
    scope.subjectRef,
    scope.runId,
    scope.attemptId,
  ]);
}

function requireCommittedEffect(effectId: string | null): string {
  if (effectId === null) {
    throw new Error("Settlement committed tanpa effectId tersimpan tidak sah.");
  }
  return effectId;
}

function cleanRef(value: string, label: string): string {
  const cleaned = value.trim();
  if (
    cleaned.length === 0 ||
    cleaned.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    throw new Error(`${label} delivery entitlement tidak sah.`);
  }
  return cleaned;
}

function cleanTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} delivery entitlement tidak sah.`);
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function sameDatabaseSizes(
  left: EntitlementDatabase,
  right: EntitlementDatabase,
): boolean {
  return left.entries.length === right.entries.length &&
    left.candidates.length === right.candidates.length &&
    left.settlements.length === right.settlements.length;
}

function idempotencyCollision(idempotencyKey: string): Error {
  return new Error(
    `Idempotency key entitlement bertabrakan: ${idempotencyKey}`,
  );
}

function subjectCollision(scope: EntitlementDeliveryScope): Error {
  return new Error(
    `Delivery scope ${scope.runId}/${scope.attemptId} bertabrakan dengan subject lain.`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
