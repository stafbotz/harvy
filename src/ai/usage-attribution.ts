import { AsyncLocalStorage } from "node:async_hooks";

export interface RuntimeUsageAttribution {
  turnId: string | null;
  subjectKind: "private" | "group";
  channel: "telegram" | "whatsapp" | "system";
  actorAliases: readonly string[];
}

const storage = new AsyncLocalStorage<RuntimeUsageAttribution>();

export function withUsageAttribution<T>(
  attribution: RuntimeUsageAttribution,
  operation: () => T,
): T {
  return storage.run(attribution, operation);
}

export function currentUsageAttribution(): RuntimeUsageAttribution | null {
  return storage.getStore() ?? null;
}
