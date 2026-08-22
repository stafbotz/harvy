import type { TransientInteractionContext } from "../domain/interaction-context.js";
import type {
  SemanticDomain,
  SemanticOperationName,
} from "../domain/semantic-operation.js";

export interface InteractionScope {
  ownerId: string;
  channel: "telegram" | "whatsapp";
  conversationId: string;
}

export interface RecordInteraction {
  domain: SemanticDomain;
  operation: SemanticOperationName;
  reference?: "none" | "current" | "recent" | "all";
}

export interface TransientInteractionContextOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 3;

/**
 * Process-local, bounded follow-up context. Restart loss is intentional: this
 * is navigation state, not durable user memory or account state.
 */
export class TransientInteractionContextStore {
  private readonly entries = new Map<string, TransientInteractionContext[]>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private generation = 0;

  constructor(options: TransientInteractionContextOptions = {}) {
    this.ttlMs = boundedPositiveInteger(options.ttlMs, DEFAULT_TTL_MS, 60 * 60 * 1_000);
    this.maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 8);
    this.now = options.now ?? (() => new Date());
  }

  record(
    scope: InteractionScope,
    interaction: RecordInteraction,
  ): TransientInteractionContext {
    const key = scopeKey(scope);
    const now = this.now();
    const entry = Object.freeze({
      version: 1 as const,
      domain: interaction.domain,
      operation: interaction.operation,
      reference: interaction.reference ?? "current",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      generation: ++this.generation,
    });
    const current = this.read(scope);
    this.entries.set(key, [entry, ...current].slice(0, this.maxEntries));
    return entry;
  }

  read(scope: InteractionScope): TransientInteractionContext[] {
    const key = scopeKey(scope);
    const now = this.now().getTime();
    const current = (this.entries.get(key) ?? []).filter((entry) => {
      const expiry = Date.parse(entry.expiresAt);
      return Number.isFinite(expiry) && expiry > now;
    });
    if (current.length > 0) this.entries.set(key, current);
    else this.entries.delete(key);
    return [...current];
  }

  clear(scope: InteractionScope): void {
    this.entries.delete(scopeKey(scope));
  }
}

function scopeKey(scope: InteractionScope): string {
  const values = [scope.ownerId, scope.channel, scope.conversationId];
  if (values.some((value) => !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new Error("Scope transient interaction tidak sah.");
  }
  return JSON.stringify(values);
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error("Batas transient interaction tidak sah.");
  }
  return value;
}
