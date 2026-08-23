import { spawn, type ChildProcess } from "node:child_process";

const CONTROL_READY = "harvy-dev-control-ready";
const CONTROL_SHUTDOWN = "harvy-dev-shutdown";
const CHANNEL_READY = "harvy-runtime-channel-ready";
const ACCEPTANCE_TRACE = "harvy-live-acceptance-trace";
const PRIVATE_TRACE_STAGES = new Set([
  "private-upsert-notify",
  "private-upsert-append",
  "private-candidate",
  "private-normalized",
  "private-handler-returned",
  "private-pipeline-failed",
  "private-delivery-attempted",
  "private-delivery-succeeded",
  "private-delivery-failed",
] as const);

export interface RuntimeSupervisorOptions {
  entry: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  restartBaseMs?: number;
  restartMaxMs?: number;
  stableResetMs?: number;
  crashWindowMs?: number;
  maxCrashes?: number;
  shutdownTimeoutMs?: number;
  onEvent?: (event: RuntimeSupervisorEvent) => void;
}

export type RuntimeSupervisorEvent =
  | { type: "child-started"; attempt: number }
  | { type: "child-ready"; attempt: number }
  | {
      type: "channel-ready";
      attempt: number;
      channel: "whatsapp";
      accountId: string;
    }
  | {
      type: "acceptance-trace";
      attempt: number;
      channel: "whatsapp";
      accountId: string;
      stage: string;
    }
  | {
      type: "child-restart-scheduled";
      attempt: number;
      delayMs: number;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | { type: "crash-loop-open"; crashes: number }
  | { type: "shutdown-timeout" };

/**
 * Small single-child supervisor for the local deployment. It complements the
 * app's own graceful drain: unexpected exits restart with bounded backoff,
 * while a crash loop opens instead of hammering providers or corrupt config.
 */
export function superviseRuntime(
  options: RuntimeSupervisorOptions,
): Promise<number> {
  const restartBaseMs = positive(options.restartBaseMs, 500, "restartBaseMs");
  const restartMaxMs = positive(options.restartMaxMs, 30_000, "restartMaxMs");
  const stableResetMs = positive(options.stableResetMs, 5 * 60_000, "stableResetMs");
  const crashWindowMs = positive(options.crashWindowMs, 5 * 60_000, "crashWindowMs");
  const maxCrashes = positiveInteger(options.maxCrashes, 8, "maxCrashes");
  const shutdownTimeoutMs = positive(
    options.shutdownTimeoutMs,
    65_000,
    "shutdownTimeoutMs",
  );
  if (restartMaxMs < restartBaseMs) {
    throw new Error("restartMaxMs tidak boleh lebih kecil daripada restartBaseMs.");
  }

  let child: ChildProcess | null = null;
  let childControlReady = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let shutdownTimer: NodeJS.Timeout | null = null;
  let stopping = options.signal?.aborted === true;
  let finished = false;
  let attempt = 0;
  let crashTimes: number[] = [];
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((resolvePromise) => {
    resolveResult = resolvePromise;
  });

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    restartTimer = null;
    shutdownTimer = null;
    options.signal?.removeEventListener("abort", stop);
    resolveResult(code);
  };

  const stop = (): void => {
    if (stopping || finished) return;
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const active = child;
    if (!active) {
      finish(0);
      return;
    }
    requestChildShutdown(active);
    shutdownTimer = setTimeout(() => {
      if (child !== active || active.exitCode !== null || active.signalCode !== null) return;
      options.onEvent?.({ type: "shutdown-timeout" });
      active.kill("SIGKILL");
      finish(1);
    }, shutdownTimeoutMs);
    shutdownTimer.unref();
  };

  const requestChildShutdown = (active: ChildProcess): void => {
    if (child !== active || active.exitCode !== null || active.signalCode !== null) {
      return;
    }
    if (active.connected && childControlReady) {
      try {
        active.send({ type: CONTROL_SHUTDOWN, reason: "dev-stop" });
        return;
      } catch {
        // IPC dapat tertutup di antara pemeriksaan dan send. Fallback signal
        // hanya dipakai ketika channel benar-benar tidak lagi tersedia.
      }
    }
    if (!active.connected) active.kill("SIGTERM");
  };

  const scheduleAfterExit = (
    startedAt: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (stopping) {
      finish(0);
      return;
    }
    const now = Date.now();
    if (now - startedAt >= stableResetMs) crashTimes = [];
    crashTimes = crashTimes.filter((time) => now - time <= crashWindowMs);
    crashTimes.push(now);
    if (crashTimes.length >= maxCrashes) {
      options.onEvent?.({ type: "crash-loop-open", crashes: crashTimes.length });
      finish(1);
      return;
    }
    const exponent = Math.max(0, crashTimes.length - 1);
    const delayMs = Math.min(restartMaxMs, restartBaseMs * 2 ** exponent);
    options.onEvent?.({
      type: "child-restart-scheduled",
      attempt,
      delayMs,
      code,
      signal,
    });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, delayMs);
  };

  const launch = (): void => {
    if (stopping || finished) {
      finish(0);
      return;
    }
    attempt += 1;
    const startedAt = Date.now();
    const launched = spawn(process.execPath, [options.entry], {
      cwd: options.cwd,
      env: {
        ...(options.env ?? process.env),
        HARVY_RUNTIME_SUPERVISOR: "1",
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    child = launched;
    childControlReady = false;
    options.onEvent?.({ type: "child-started", attempt });
    launched.on("message", (message: unknown) => {
      if (
        child !== launched ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      ) {
        return;
      }
      if (message.type === CONTROL_READY) {
        childControlReady = true;
        options.onEvent?.({ type: "child-ready", attempt });
        if (stopping) requestChildShutdown(launched);
        return;
      }
      if (isChannelReadyMessage(message)) {
        options.onEvent?.({
          type: "channel-ready",
          attempt,
          channel: message.channel,
          accountId: message.accountId,
        });
        return;
      }
      if (isAcceptanceTraceMessage(message)) {
        options.onEvent?.({
          type: "acceptance-trace",
          attempt,
          channel: message.channel,
          accountId: message.accountId,
          stage: message.stage,
        });
      }
    });
    let closed = false;
    const conclude = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (closed || child !== launched) return;
      closed = true;
      child = null;
      childControlReady = false;
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      scheduleAfterExit(startedAt, code, signal);
    };
    launched.once("error", () => conclude(1, null));
    launched.once("exit", conclude);
  };

  options.signal?.addEventListener("abort", stop, { once: true });
  if (stopping) finish(0);
  else launch();
  return result;
}

function isAcceptanceTraceMessage(message: object & { type: unknown }): message is {
  type: typeof ACCEPTANCE_TRACE;
  channel: "whatsapp";
  accountId: string;
  stage: string;
} {
  return message.type === ACCEPTANCE_TRACE &&
    "channel" in message &&
    message.channel === "whatsapp" &&
    "accountId" in message &&
    typeof message.accountId === "string" &&
    /^[a-z][a-z0-9_-]{0,31}$/iu.test(message.accountId) &&
    "stage" in message &&
    typeof message.stage === "string" &&
    PRIVATE_TRACE_STAGES.has(
      message.stage as typeof PRIVATE_TRACE_STAGES extends Set<infer T> ? T : never,
    );
}

function isChannelReadyMessage(message: object & { type: unknown }): message is {
  type: typeof CHANNEL_READY;
  channel: "whatsapp";
  accountId: string;
} {
  if (
    message.type !== CHANNEL_READY ||
    !("channel" in message) ||
    message.channel !== "whatsapp" ||
    !("accountId" in message) ||
    typeof message.accountId !== "string"
  ) {
    return false;
  }
  return /^[a-z][a-z0-9_-]{0,31}$/iu.test(message.accountId);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${name} harus berupa angka positif.`);
  }
  return resolved;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = positive(value, fallback, name);
  if (!Number.isSafeInteger(resolved)) throw new Error(`${name} harus berupa integer.`);
  return resolved;
}
