import { performance } from "node:perf_hooks";

export class TransportDeadlineError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} melewati client watchdog timeout.`);
    this.name = "TransportDeadlineError";
  }
}

/**
 * Bounded trust-domain call with a monotonic acceptance fence. A result that
 * races the timeout/abort boundary is discarded even if its promise resolves.
 */
export async function callTransportWithDeadline<T>(
  operation: string,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) {
    throw new Error("Timeout trust-domain transport tidak sah.");
  }
  if (externalSignal?.aborted) throw abortError();
  const controller = new AbortController();
  let accepting = true;
  let timedOut = false;
  const deadline = performance.now() + timeoutMs;
  const forwardAbort = () => {
    accepting = false;
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    accepting = false;
    timedOut = true;
    controller.abort(new TransportDeadlineError(operation));
  }, timeoutMs);
  timer.unref?.();
  const pending = Promise.resolve().then(() => call(controller.signal));
  pending.catch(() => undefined);
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(timedOut ? new TransportDeadlineError(operation) : abortError()),
          { once: true },
        );
      }),
    ]);
    if (performance.now() >= deadline) {
      accepting = false;
      timedOut = true;
      controller.abort(new TransportDeadlineError(operation));
    }
    if (
      !accepting ||
      timedOut ||
      controller.signal.aborted ||
      externalSignal?.aborted
    ) {
      throw timedOut ? new TransportDeadlineError(operation) : abortError();
    }
    return result;
  } catch (error) {
    if (timedOut) throw new TransportDeadlineError(operation);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

function abortError(): Error {
  const error = new Error("Trust-domain transport dibatalkan.");
  error.name = "AbortError";
  return error;
}
