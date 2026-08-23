const GUARDED_METHODS = ["debug", "info", "log", "warn", "error"] as const;

type GuardedMethod = (typeof GUARDED_METHODS)[number];
type ConsoleTarget = Record<GuardedMethod, (...values: unknown[]) => void>;
type StackProvider = () => string | undefined;

const installedTargets = new WeakSet<object>();

/**
 * Libsignal masih menulis object session langsung ke global console dan
 * melewati logger Baileys. Object itu membawa material ratchet rahasia, jadi
 * seluruh direct console call yang berasal dari package tersebut dibuang.
 */
export function installThirdPartyConsoleSecretGuard(
  target: ConsoleTarget = console,
  stackProvider: StackProvider = () => new Error().stack,
): void {
  if (installedTargets.has(target)) return;
  for (const method of GUARDED_METHODS) {
    const original = target[method].bind(target);
    target[method] = (...values: unknown[]): void => {
      if (isSensitiveThirdPartyConsoleStack(stackProvider())) return;
      original(...values);
    };
  }
  installedTargets.add(target);
}

export function isSensitiveThirdPartyConsoleStack(
  stack: string | undefined,
): boolean {
  if (!stack) return false;
  const normalized = stack.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/node_modules/libsignal/") ||
    normalized.includes("/node_modules/@whiskeysockets/libsignal/");
}
