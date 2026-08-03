import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AiUsageRecord,
  ProductEvent,
  TelemetryRepository,
} from "../domain/telemetry.js";

interface TelemetryDatabase {
  version: 2;
  usage: AiUsageRecord[];
  events: ProductEvent[];
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

      if (
        usage.length === database.usage.length &&
        events.length === database.events.length
      ) {
        return;
      }
      await this.writeDatabase({ ...database, usage, events });
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
      };
      if (
        !Array.isArray(parsed.usage) ||
        !Array.isArray(parsed.events) ||
        (parsed.version !== 1 && parsed.version !== 2)
      ) {
        throw new Error("Format basis observabilitas tidak dikenali.");
      }
      const database: TelemetryDatabase = {
        version: 2,
        usage: parsed.usage.map(normalizeUsageRecord),
        events: parsed.events as ProductEvent[],
      };
      if (parsed.version === 1) {
        await this.persistDatabase(database);
      }
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 2, usage: [], events: [] };
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
      "turn-boundary", "understanding", "due-date", "risk-triage",
      "reply", "reply-review", "summary", "research", "insight", "session",
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
      ownerId.startsWith("whatsapp:") ? "whatsapp" : "telegram",
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
