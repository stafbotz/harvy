import { randomUUID } from "node:crypto";
import type {
  LogChannel,
  LogContext,
  LogLevel,
  OperationalLogger,
} from "../src/observability/operational-logger.js";

const ORDER: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

/**
 * Sink log operasional untuk probe dan evaluator.
 *
 * Runtime menulis NDJSON ke berkas; probe tidak memasang sink sama sekali dan
 * karena itu memakai `NOOP_OPERATIONAL_LOGGER`. Akibatnya setiap keputusan yang
 * hanya menjelaskan dirinya lewat log—penolakan bentuk jawaban, perbaikan tool,
 * run agent yang berhenti—tidak terlihat pada alat yang justru dipakai untuk
 * menyelidikinya, dan penyelidiknya menebak.
 *
 * Keluarannya ke stderr supaya stdout tetap murni JSON hasil probe.
 */
export function createStderrOperationalLogger(
  component = "probe",
  minimumLevel: LogLevel = "warn",
): OperationalLogger {
  return new StderrOperationalLogger(component, minimumLevel);
}

class StderrOperationalLogger implements OperationalLogger {
  constructor(
    private readonly component: string,
    private readonly minimumLevel: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(component: string, bindings?: Record<string, unknown>): OperationalLogger {
    return new StderrOperationalLogger(
      `${this.component}.${component}`,
      this.minimumLevel,
      { ...this.bindings, ...bindings },
    );
  }

  runWithContext<T>(_context: LogContext, action: () => T): T {
    return action();
  }

  newTraceContext(
    channel: LogChannel,
    operation?: string,
    accountId?: string,
  ): LogContext {
    return {
      traceId: randomUUID(),
      channel,
      ...(operation ? { operation } : {}),
      ...(accountId ? { accountId } : {}),
    };
  }

  trace(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write("trace", event, message, fields);
  }

  debug(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write("debug", event, message, fields);
  }

  info(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write("info", event, message, fields);
  }

  warn(event: string, message: string, fields?: Record<string, unknown>): void {
    this.write("warn", event, message, fields);
  }

  error(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void {
    this.write("error", event, message, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  fatal(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void {
    this.write("fatal", event, message, {
      ...fields,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private write(
    level: LogLevel,
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (ORDER.indexOf(level) < ORDER.indexOf(this.minimumLevel)) return;
    const merged = { ...this.bindings, ...fields };
    const payload = Object.keys(merged).length > 0
      ? ` ${JSON.stringify(merged)}`
      : "";
    process.stderr.write(
      `[${level}] ${this.component} ${event}: ${message}${payload}\n`,
    );
  }
}
