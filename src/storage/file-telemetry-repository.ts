import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
  TurnTelemetryRecord,
} from "../domain/telemetry.js";

interface TelemetryDatabase {
  version: 4;
  usage: AiUsageRecord[];
  events: ProductEvent[];
  turns: TurnTelemetryRecord[];
}

export class FileTelemetryRepository implements TelemetryRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private database: Promise<TelemetryDatabase> | null = null;

  constructor(private readonly filePath: string) {}

  async appendUsage(record: AiUsageRecord): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      database.usage.push(record);
      await this.writeDatabase(database);
    });
  }

  async appendEvent(event: ProductEvent): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      database.events.push(event);
      await this.writeDatabase(database);
    });
  }

  async appendTurn(record: TurnTelemetryRecord): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      if (
        database.turns.some(
          (stored) =>
            stored.ownerId === record.ownerId &&
            stored.turnId === record.turnId,
        )
      ) {
        return;
      }
      database.turns.push(record);
      await this.writeDatabase(database);
    });
  }

  async usageSince(ownerId: string, since: Date): Promise<AiUsageRecord[]> {
    const database = await this.readDatabase();
    const threshold = since.getTime();
    return database.usage.filter(
      (record) =>
        record.ownerId === ownerId &&
        new Date(record.at).getTime() >= threshold,
    );
  }

  async eventsSince(ownerId: string, since: Date): Promise<ProductEvent[]> {
    const database = await this.readDatabase();
    const threshold = since.getTime();
    return database.events.filter(
      (event) =>
        event.ownerId === ownerId &&
        new Date(event.at).getTime() >= threshold,
    );
  }

  async turnsSince(
    ownerId: string,
    since: Date,
  ): Promise<TurnTelemetryRecord[]> {
    const database = await this.readDatabase();
    const threshold = since.getTime();
    return database.turns.filter(
      (record) =>
        record.ownerId === ownerId &&
        new Date(record.at).getTime() >= threshold,
    );
  }

  async removeBefore(before: Date): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const threshold = before.getTime();
      const usage = database.usage.filter(
        (record) => new Date(record.at).getTime() >= threshold,
      );
      const events = database.events.filter(
        (event) => new Date(event.at).getTime() >= threshold,
      );
      const turns = database.turns.filter(
        (record) => new Date(record.at).getTime() >= threshold,
      );

      if (
        usage.length === database.usage.length &&
        events.length === database.events.length &&
        turns.length === database.turns.length
      ) {
        return;
      }
      await this.writeDatabase({ ...database, usage, events, turns });
    });
  }

  async removeAll(ownerId: string): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      await this.writeDatabase({
        ...database,
        usage: database.usage.filter(
          (record) => record.ownerId !== ownerId,
        ),
        events: database.events.filter(
          (event) => event.ownerId !== ownerId,
        ),
        turns: database.turns.filter(
          (record) => record.ownerId !== ownerId,
        ),
      });
    });
  }

  private async readDatabase(): Promise<TelemetryDatabase> {
    this.database ??= this.loadDatabase();
    return this.database;
  }

  private async loadDatabase(): Promise<TelemetryDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        usage?: unknown;
        events?: unknown;
        turns?: unknown;
      };
      if (
        !Array.isArray(parsed.usage) ||
        !Array.isArray(parsed.events) ||
        (parsed.version !== 1 &&
          parsed.version !== 2 &&
          parsed.version !== 3 && parsed.version !== 4) ||
        ((parsed.version === 3 || parsed.version === 4) && !Array.isArray(parsed.turns))
      ) {
        throw new Error("Format basis observabilitas tidak dikenali.");
      }
      const database: TelemetryDatabase = {
        version: 4,
        usage: parsed.usage.map(normalizeUsageRecord),
        events: parsed.events as ProductEvent[],
        turns: Array.isArray(parsed.turns)
          ? parsed.turns.map(normalizeTurnRecord)
          : [],
      };
      if (parsed.version !== 4) {
        await this.persistDatabase(database);
      }
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 4, usage: [], events: [], turns: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: TelemetryDatabase): Promise<void> {
    await this.persistDatabase(database);
    this.database = Promise.resolve(database);
  }

  private async persistDatabase(database: TelemetryDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function normalizeTurnRecord(value: unknown, index: number): TurnTelemetryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Record turn telemetry ${index} tidak dikenali.`);
  }
  const record = value as Record<string, unknown>;
  const at = requiredString(record.at, "at", index);
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error(`Waktu turn telemetry ${index} tidak sah.`);
  }
  return {
    id: requiredString(record.id, "id", index),
    at,
    turnId: requiredString(record.turnId, "turnId", index),
    ownerId: requiredString(record.ownerId, "ownerId", index),
    subjectKind: oneOf(record.subjectKind, ["private", "group"] as const, "private"),
    channel: oneOf(
      record.channel,
      ["telegram", "whatsapp", "system"] as const,
      "telegram",
    ),
    outcome: oneOf(
      record.outcome,
      ["completed", "failed", "cancelled"] as const,
      "failed",
    ),
    bubbleCount: count(record.bubbleCount),
    batchWaitMs: count(record.batchWaitMs),
    queueWaitMs: count(record.queueWaitMs),
    handlingLatencyMs: count(record.handlingLatencyMs),
    totalLatencyMs: count(record.totalLatencyMs),
    timeToFirstResponseMs: nullableCount(record.timeToFirstResponseMs),
    timeToFinalResponseMs: nullableCount(record.timeToFinalResponseMs),
    modelCallCount: count(record.modelCallCount),
    failedModelCallCount: count(record.failedModelCallCount),
    boundaryCallCount: count(record.boundaryCallCount),
    understandingCallCount: count(record.understandingCallCount),
    riskTriageCallCount: count(record.riskTriageCallCount),
    replyCallCount: count(record.replyCallCount),
    replyReviewCallCount: count(record.replyReviewCallCount),
    agentCallCount: count(record.agentCallCount),
    deterministicFastPathCount: count(record.deterministicFastPathCount),
    riskTriageUnavailableCount: count(record.riskTriageUnavailableCount),
    safetyFallbackCount: count(record.safetyFallbackCount),
    safeActionBlockedCount: count(record.safeActionBlockedCount),
    urgentAcknowledgementCount: count(record.urgentAcknowledgementCount),
  };
}

function normalizeUsageRecord(value: unknown, index: number): AiUsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Record usage telemetry ${index} tidak dikenali.`);
  }
  const record = value as Record<string, unknown>;
  const ownerId = requiredString(record.ownerId, "ownerId", index);
  const id = requiredString(record.id, "id", index);
  const at = requiredString(record.at, "at", index);
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error(`Waktu usage telemetry ${index} tidak sah.`);
  }
  const inputTokens = count(record.inputTokens);
  const outputTokens = count(record.outputTokens);
  const purpose = oneOf(
    record.purpose,
    [
      "turn-boundary", "understanding", "due-date", "risk-triage", "memory-privacy",
      "group-ingress",
      "reply", "reply-review", "summary", "agent", "research", "insight", "session",
      "group-participation", "group-reply",
    ] as const,
    "reply",
  );
  return {
    id,
    at,
    requestId:
      typeof record.requestId === "string" && record.requestId.length > 0
        ? record.requestId
        : `legacy_${id}`,
    turnId:
      typeof record.turnId === "string" && record.turnId.length > 0
        ? record.turnId
        : null,
    ownerId,
    subjectKind: oneOf(record.subjectKind, ["private", "group"] as const, "private"),
    channel: oneOf(
      record.channel,
      ["telegram", "whatsapp", "system"] as const,
      ownerId.startsWith("whatsapp:") || ownerId.startsWith("whatsapp-user:")
        ? "whatsapp"
        : "telegram",
    ),
    tier: oneOf(record.tier, ["cheap", "efficient", "ambitious"] as const, "cheap"),
    purpose,
    model: typeof record.model === "string" && record.model.length > 0
      ? record.model
      : "legacy-unknown",
    maxTokens: count(record.maxTokens),
    inputTokenEstimate: count(record.inputTokenEstimate),
    safetyCritical: record.safetyCritical === true,
    // Telemetry v1 memang mendebit seluruh request. Migrasi mempertahankan
    // semantik historis itu; ia tidak menebak ulang kategori entitlement.
    billable: typeof record.billable === "boolean" ? record.billable : true,
    inputTokens,
    outputTokens,
    totalTokens: Math.max(count(record.totalTokens), inputTokens + outputTokens),
    estimated: record.estimated === true,
    estimatedCostUsd: finiteNonNegative(record.estimatedCostUsd),
    succeeded: record.succeeded === true,
    latencyMs: count(record.latencyMs),
  };
}

function requiredString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Field ${field} telemetry ${index} tidak sah.`);
  }
  return value;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && allowed.includes(value)
    ? value as T[number]
    : fallback;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
