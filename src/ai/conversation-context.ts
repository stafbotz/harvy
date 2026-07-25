import type { ConversationMessage } from "./conversation-service.js";

const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_MESSAGES = 6;
const DEFAULT_MAX_CHARS = 12_000;

interface StoredConversation {
  messages: ConversationMessage[];
  updatedAt: number;
}

export interface ConversationContextOptions {
  ttlMs?: number;
  maxMessages?: number;
  maxChars?: number;
  now?: () => number;
}

export class InMemoryConversationContext {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly expirationTimers = new Map<string, NodeJS.Timeout>();
  private readonly ttlMs: number;
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly now: () => number;

  constructor(options: ConversationContextOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.now = options.now ?? Date.now;
  }

  get(ownerId: string): ConversationMessage[] {
    const stored = this.conversations.get(ownerId);
    if (!stored) return [];

    if (this.now() - stored.updatedAt >= this.ttlMs) {
      this.clear(ownerId);
      return [];
    }

    return stored.messages.map((message) => ({ ...message }));
  }

  appendExchange(
    ownerId: string,
    userMessage: string,
    assistantMessage: string,
  ): void {
    const messages = [
      ...this.get(ownerId),
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantMessage },
    ];

    const updatedAt = this.now();
    this.conversations.set(ownerId, {
      messages: trimMessages(messages, this.maxMessages, this.maxChars),
      updatedAt,
    });
    this.scheduleExpiration(ownerId, updatedAt);
  }

  clear(ownerId: string): void {
    this.conversations.delete(ownerId);
    const timer = this.expirationTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    this.expirationTimers.delete(ownerId);
  }

  private scheduleExpiration(ownerId: string, updatedAt: number): void {
    const previousTimer = this.expirationTimers.get(ownerId);
    if (previousTimer) clearTimeout(previousTimer);

    const timer = setTimeout(() => {
      if (this.conversations.get(ownerId)?.updatedAt === updatedAt) {
        this.conversations.delete(ownerId);
        this.expirationTimers.delete(ownerId);
      }
    }, this.ttlMs);
    timer.unref();
    this.expirationTimers.set(ownerId, timer);
  }
}

function trimMessages(
  messages: ConversationMessage[],
  maxMessages: number,
  maxChars: number,
): ConversationMessage[] {
  const kept: ConversationMessage[] = [];
  let characters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (kept.length >= maxMessages) break;
    if (characters + message.content.length > maxChars) break;

    kept.unshift(message);
    characters += message.content.length;
  }

  return kept;
}
