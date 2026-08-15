/**
 * Intent penghapusan ini sengaja hanya membawa binding teknis exact. Ia tidak
 * pernah menyimpan isi percakapan, participant, atau message identifier.
 */
export interface GroupAgentRunCleanupIntent {
  version: 1;
  /** Token fresh mencegah completion lama menghapus intent baru (ABA). */
  intentId: string;
  scopeKey: string;
  accountId: string;
  revision: number;
  requestedAt: string;
}

export interface GroupAgentRunCleanupIntentRepository {
  /** Upsert durable; request ulang menaikkan revision agar completion basi gagal. */
  enqueue(
    scopeKey: string,
    accountId: string,
    requestedAt: string,
  ): Promise<GroupAgentRunCleanupIntent>;
  listPending(): Promise<GroupAgentRunCleanupIntent[]>;
  hasPending(scopeKey: string, accountId: string): Promise<boolean>;
  /** Fence exact sebelum efek agar snapshot recovery basi tidak menyentuh binding baru. */
  matchesPending(
    scopeKey: string,
    accountId: string,
    expectedRevision: number,
    expectedIntentId: string,
  ): Promise<boolean>;
  /** Menghapus intent hanya bila tidak ada request lebih baru untuk binding itu. */
  complete(
    scopeKey: string,
    accountId: string,
    expectedRevision: number,
    expectedIntentId: string,
  ): Promise<boolean>;
}

export function validateGroupAgentRunCleanupTarget(
  scopeKey: unknown,
  accountId: unknown,
): { scopeKey: string; accountId: string } {
  return {
    scopeKey: cleanupKey(scopeKey, "scopeKey"),
    accountId: cleanupKey(accountId, "accountId"),
  };
}

export function validateGroupAgentRunCleanupIntentId(value: unknown): string {
  return cleanupKey(value, "intentId");
}

export function validateGroupAgentRunCleanupIntent(
  value: unknown,
): asserts value is GroupAgentRunCleanupIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Record cleanup GroupAgentRun tidak sah.");
  }
  const keys = Object.keys(value);
  const expected = [
    "version",
    "intentId",
    "scopeKey",
    "accountId",
    "revision",
    "requestedAt",
  ];
  if (
    expected.some((key) => !keys.includes(key)) ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new Error("Schema cleanup GroupAgentRun tidak sah.");
  }
  const intent = value as GroupAgentRunCleanupIntent;
  if (intent.version !== 1) {
    throw new Error("Versi cleanup GroupAgentRun tidak sah.");
  }
  validateGroupAgentRunCleanupIntentId(intent.intentId);
  validateGroupAgentRunCleanupTarget(intent.scopeKey, intent.accountId);
  if (!Number.isSafeInteger(intent.revision) || intent.revision < 1) {
    throw new Error("Revision cleanup GroupAgentRun tidak sah.");
  }
  cleanupTimestamp(intent.requestedAt);
}

export function cleanupTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error("Waktu cleanup GroupAgentRun tidak sah.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Waktu cleanup GroupAgentRun tidak sah.");
  }
  return value;
}

function cleanupKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} cleanup GroupAgentRun tidak sah.`);
  }
  return value;
}
