import { resolve } from "node:path";
import {
  superviseRuntime,
  type RuntimeSupervisorEvent,
} from "../src/operations/runtime-supervisor.js";

const controller = new AbortController();
let stopping = false;

function stop(): void {
  if (stopping) return;
  stopping = true;
  controller.abort();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

function log(event: RuntimeSupervisorEvent): void {
  const at = new Date().toISOString();
  switch (event.type) {
    case "child-started":
      process.stdout.write(`${at} INFO supervisor child_started attempt=${event.attempt}\n`);
      break;
    case "child-restart-scheduled":
      process.stderr.write(
        `${at} WARN supervisor restart_scheduled attempt=${event.attempt} ` +
          `delay_ms=${event.delayMs} code=${event.code ?? "null"} ` +
          `signal=${event.signal ?? "none"}\n`,
      );
      break;
    case "crash-loop-open":
      process.stderr.write(
        `${at} ERROR supervisor crash_loop_open crashes=${event.crashes}\n`,
      );
      break;
    case "shutdown-timeout":
      process.stderr.write(`${at} ERROR supervisor shutdown_timeout\n`);
      break;
  }
}

const code = await superviseRuntime({
  entry: resolve("dist/src/app.js"),
  cwd: process.cwd(),
  signal: controller.signal,
  restartBaseMs: boundedNumber("HARVY_RESTART_BASE_MS", 500, 100, 60_000),
  restartMaxMs: boundedNumber("HARVY_RESTART_MAX_MS", 30_000, 100, 300_000),
  stableResetMs: boundedNumber(
    "HARVY_RESTART_STABLE_RESET_MS",
    5 * 60_000,
    1_000,
    24 * 60 * 60_000,
  ),
  crashWindowMs: boundedNumber(
    "HARVY_RESTART_CRASH_WINDOW_MS",
    5 * 60_000,
    1_000,
    24 * 60 * 60_000,
  ),
  maxCrashes: boundedNumber("HARVY_RESTART_MAX_CRASHES", 8, 2, 100),
  shutdownTimeoutMs: boundedNumber(
    "HARVY_RESTART_SHUTDOWN_TIMEOUT_MS",
    65_000,
    1_000,
    10 * 60_000,
  ),
  onEvent: log,
});
process.off("SIGINT", stop);
process.off("SIGTERM", stop);
process.exitCode = code;

function boundedNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} berada di luar batas aman.`);
  }
  return value;
}
