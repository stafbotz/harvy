import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  type WriteFileOptions,
} from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  stat,
  truncate,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { join, parse, resolve } from "node:path";

export const OPERATIONAL_LOG_SCHEMA = "harvy.operational-log.v1";

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

export type LogChannel = "telegram" | "whatsapp" | "system";

export interface LogContext {
  traceId: string;
  channel: LogChannel;
  operation?: string;
  accountId?: string;
}

export interface OperationalLogOptions {
  directory: string;
  level: LogLevel;
  environment: string;
  release: string;
  retentionDays: number;
  maxSegmentBytes: number;
  maxTotalBytes: number;
  maxQueueRecords: number;
  maxQueueBytes: number;
  consoleEnabled: boolean;
  consoleFormat: "pretty" | "json";
  fileRequired: boolean;
  maintenanceIntervalMs?: number;
  now?: () => Date;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
}

export interface OperationalLogHealth {
  fileEnabled: boolean;
  fileHealthy: boolean;
  writeHealthy: boolean;
  retentionHealthy: boolean;
  queuedRecords: number;
  droppedRecords: number;
  consoleDroppedRecords: number;
  lastFileErrorAt: string | null;
}

export interface OperationalLogger {
  child(component: string, bindings?: Record<string, unknown>): OperationalLogger;
  runWithContext<T>(context: LogContext, action: () => T): T;
  newTraceContext(
    channel: LogChannel,
    operation?: string,
    accountId?: string,
  ): LogContext;
  trace(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  debug(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  info(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  warn(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void;
  error(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void;
  fatal(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void;
}

export interface OperationalLogSystem {
  logger: OperationalLogger;
  flush(): Promise<void>;
  close(): Promise<void>;
  maintain(): Promise<void>;
  health(): OperationalLogHealth;
  fatalSync(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void;
}

class NoopOperationalLogger implements OperationalLogger {
  child(): OperationalLogger {
    return this;
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

  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
}

/** Default untuk unit test/pure core yang belum memasang sink operasional. */
export const NOOP_OPERATIONAL_LOGGER: OperationalLogger =
  new NoopOperationalLogger();

interface LogRecord {
  schema: typeof OPERATIONAL_LOG_SCHEMA;
  timestamp: string;
  level: LogLevel;
  service: "harvy";
  release: string;
  environment: string;
  runId: string;
  sequence: number;
  pid: number;
  host: string;
  component: string;
  event: string;
  context?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: NormalizedError;
}

interface NormalizedError {
  type: string;
  fingerprint: string;
  code?: string | number;
  status?: string | number;
  stack?: string;
  cause?: NormalizedError;
}

interface QueueItem {
  line: string;
  level: LogLevel;
  bytes: number;
}

interface RetentionResult {
  expiredDeleted: number;
  capDeleted: number;
  bytesRemaining: number;
  partialLinesRecovered: number;
  retentionSucceeded: boolean;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
const LOG_FILE_PATTERN = /^harvy-(\d{8})-(\d{4})\.ndjson$/;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_STRING_LENGTH = 2_048;
const MAX_STACK_LENGTH = 12_000;
const MAX_OBJECT_KEYS = 40;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SAFE_ERROR_TYPES = new Set([
  "aborterror",
  "aggregateerror",
  "aierror",
  "configurationerror",
  "error",
  "evalerror",
  "operationallogerror",
  "rangeerror",
  "referenceerror",
  "syntaxerror",
  "typeerror",
  "urierror",
  "usagelimiterror",
]);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "apikey",
  "key",
  "secret",
  "password",
  "credential",
  "credentials",
  "creds",
  "auth",
  "qr",
  "pairingcode",
  "mediakey",
  "directpath",
  "noise",
  "signal",
  "prekey",
  "text",
  "body",
  "content",
  "prompt",
  "reply",
  "history",
  "summary",
  "caption",
  "message",
  "conversation",
  "extendedtextmessage",
  "imagemessage",
  "videomessage",
  "documentmessage",
  "groupname",
  "subject",
  "displayname",
  "firstname",
  "lastname",
  "username",
  "pushname",
  "request",
  "response",
  "payload",
  "update",
  "raw",
  "input",
  "output",
]);

const PRIVATE_IDENTIFIER_KEYS = new Set([
  "ownerid",
  "userid",
  "chatid",
  "groupid",
  "scopekey",
  "participant",
  "participantid",
  "jid",
  "phone",
  "phonenumber",
  "messageid",
  "taskid",
  "sessionid",
  "id",
  "remotejid",
  "sender",
  "recipient",
  "from",
  "to",
]);

const ALLOWED_DATA_KEYS = new Set([
  "accountcount",
  "accountid",
  "aimode",
  "attempt",
  "batchwaitms",
  "bubblecount",
  "bytesremaining",
  "candidatecount",
  "clarificationneeded",
  "capdeleted",
  "charactercount",
  "code",
  "confidencebucket",
  "count",
  "contextbudgetbasis",
  "contextbudgetcharacters",
  "contextestimatedtokens",
  "contextincludedcharacters",
  "contextmanifestversion",
  "contextmaxmemories",
  "contextmaxmemorycharacters",
  "contextmaxsummarycharacters",
  "contextmaxturncharacters",
  "contextmaxturns",
  "contexttokenestimatemethod",
  "contextutilizationpercent",
  "durationms",
  "deterministic",
  "decision",
  "duepresent",
  "error",
  "errortype",
  "eventkind",
  "expireddeleted",
  "fileenabled",
  "filerequired",
  "gracems",
  "handlinglatencyms",
  "inputtokens",
  "inputtokenestimate",
  "inputtokenestimateerrortokens",
  "inputtokenestimateratiopermille",
  "jsonmode",
  "lane",
  "latencyms",
  "level",
  "maxattempts",
  "maxqueuebytes",
  "maxqueuerecords",
  "maxsegmentbytes",
  "maxtokens",
  "maxtotalbytes",
  "model",
  "nativetoolchoice",
  "nativetoolcount",
  "operation",
  "origin",
  "outcome",
  "outputtokens",
  "paralleltoolcalls",
  "planningrequired",
  "partiallinesrecovered",
  "previousstatus",
  "purpose",
  "proposedroute",
  "proposedrouteallowed",
  "queuewaitms",
  "reason",
  "recentcontextkind",
  "recentcontextused",
  "retentiondays",
  "retentionsucceeded",
  "route",
  "routeallowed",
  "semanticdomain",
  "semanticexplicitness",
  "semanticfallback",
  "semanticoperation",
  "semanticreference",
  "selectedroute",
  "status",
  "succeeded",
  "taskpayloadpresent",
  "tier",
  "timeoutms",
  "tokenusageestimated",
  "totaltokens",
  "updatekind",
  "requiresagentplanning",
  "requireslivestate",
  // Bukti jalur kode saat percakapan nyata. Sampai 29 Agustus 2026 run agent
  // yang berhasil tidak meninggalkan jejak apa pun—hanya kegagalan yang
  // dicatat—sehingga tidak ada cara membuktikan giliran mana yang benar-benar
  // masuk Agent Runtime, apalagi capability mana yang dipanggil. Seluruhnya
  // bebas isi: nama capability, mode planner, dan cacahan, bukan observation
  // maupun teks pengguna.
  // Bukti turn-taking. Keempatnya dicatat `message-batcher` sejak lama tetapi
  // dibuang allowlist, sehingga penggabungan bubble dan klasifikasi interupsi
  // tidak dapat diperiksa dari luar sama sekali—dua subsistem yang justru
  // paling sulit dinilai dari transkrip. Seluruhnya bebas isi: label tertutup,
  // angka, dan boolean.
  "boundarystate",
  "boundaryconfidence",
  "adaptivetimingused",
  "interruptionrelation",
  "agentused",
  "capabilities",
  "capabilitycount",
  "plannermode",
  "stepcount",
  "intent",
  "toolneed",
  "reminderpresent",
  "version",
  "warningtype",
  "whatsappaccountcount",
  "whatsappenabled",
]);

class RuntimeLogger implements OperationalLogger {
  constructor(
    private readonly runtime: OperationalLogRuntime,
    private readonly component: string,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(
    component: string,
    bindings: Record<string, unknown> = {},
  ): OperationalLogger {
    return new RuntimeLogger(this.runtime, component, {
      ...this.bindings,
      ...bindings,
    });
  }

  runWithContext<T>(context: LogContext, action: () => T): T {
    return this.runtime.context.run(context, action);
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

  trace(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "trace",
      this.component,
      event,
      message,
      this.merge(fields),
    );
  }

  debug(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "debug",
      this.component,
      event,
      message,
      this.merge(fields),
    );
  }

  info(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "info",
      this.component,
      event,
      message,
      this.merge(fields),
    );
  }

  warn(
    event: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "warn",
      this.component,
      event,
      message,
      this.merge(fields),
    );
  }

  error(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "error",
      this.component,
      event,
      message,
      this.merge(fields),
      error,
    );
  }

  fatal(
    event: string,
    message: string,
    error: unknown,
    fields?: Record<string, unknown>,
  ): void {
    this.runtime.emit(
      "fatal",
      this.component,
      event,
      message,
      this.merge(fields),
      error,
    );
  }

  private merge(
    fields: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return fields ? { ...this.bindings, ...fields } : this.bindings;
  }
}

class OperationalLogRuntime {
  readonly context = new AsyncLocalStorage<LogContext>();
  private sequence = 0;
  private reportedDroppedRecords = 0;
  private consoleDroppedRecords = 0;
  private stdoutDroppedPending = 0;
  private stderrDroppedPending = 0;
  private stdoutBackpressured = false;
  private stderrBackpressured = false;

  constructor(
    private readonly options: OperationalLogOptions,
    private readonly sink: SegmentedJsonlSink | null,
    private readonly runId: string,
    private readonly droppedCount: () => number,
  ) {}

  emit(
    level: LogLevel,
    component: string,
    event: string,
    message: string,
    fields: Record<string, unknown>,
    error?: unknown,
  ): void {
    if (!this.enabled(level)) return;
    this.reportDropsIfPossible();
    const record = this.makeRecord(
      level,
      component,
      event,
      message,
      fields,
      error,
    );
    const line = serializeRecord(record);
    this.writeConsole(record, line);
    if (!this.sink) return;

    const accepted = this.sink.enqueue({
      line,
      level,
      bytes: Buffer.byteLength(line),
    });
    if (!accepted) {
      if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.warn) {
        if (!this.sink.appendEmergency(line)) this.sink.markDropped();
      }
    }
  }

  fatalSync(
    event: string,
    message: string,
    error: unknown,
    fields: Record<string, unknown> = {},
  ): void {
    const record = this.makeRecord(
      "fatal",
      "process",
      event,
      message,
      fields,
      error,
    );
    const line = serializeRecord(record);
    this.writeConsole(record, line, true);
    if (this.sink && !this.sink.appendEmergency(line)) {
      this.sink.markDropped();
    }
  }

  health(): OperationalLogHealth {
    const sinkHealth = this.sink?.health();
    return {
      fileEnabled: this.sink !== null,
      fileHealthy: sinkHealth?.healthy ?? false,
      writeHealthy: sinkHealth?.writeHealthy ?? false,
      retentionHealthy: sinkHealth?.retentionHealthy ?? false,
      queuedRecords: sinkHealth?.queuedRecords ?? 0,
      droppedRecords: this.droppedCount(),
      consoleDroppedRecords: this.consoleDroppedRecords,
      lastFileErrorAt: sinkHealth?.lastErrorAt ?? null,
    };
  }

  async flush(): Promise<void> {
    this.reportDropsIfPossible();
    await this.sink?.flush();
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.options.level];
  }

  private makeRecord(
    level: LogLevel,
    component: string,
    event: string,
    _message: string,
    fields: Record<string, unknown>,
    error?: unknown,
  ): LogRecord {
    const currentContext = this.context.getStore();
    const safeContext = currentContext
      ? compactObject({
          traceId: scrubString(currentContext.traceId, 96),
          channel: normalizeLabel(currentContext.channel, "system"),
          operation: currentContext.operation
            ? normalizeLabel(currentContext.operation, "operation")
            : undefined,
          accountId: currentContext.accountId
            ? safeOperationalAccountId(currentContext.accountId)
            : undefined,
        })
      : undefined;
    const safeData = sanitizeObject(fields);
    const normalizedError =
      error === undefined ? undefined : normalizeError(error);
    return {
      schema: OPERATIONAL_LOG_SCHEMA,
      timestamp: this.options.now?.().toISOString() ?? new Date().toISOString(),
      level,
      service: "harvy",
      release: scrubString(this.options.release),
      environment: scrubString(this.options.environment),
      runId: this.runId,
      sequence: ++this.sequence,
      pid: process.pid,
      host: scrubString(hostname()),
      component: normalizeLabel(component, "unknown"),
      event: normalizeLabel(event, "unknown_event"),
      ...(safeContext && Object.keys(safeContext).length > 0
        ? { context: safeContext }
        : {}),
      ...(Object.keys(safeData).length > 0 ? { data: safeData } : {}),
      ...(normalizedError ? { error: normalizedError } : {}),
    };
  }

  private reportDropsIfPossible(): void {
    if (
      !this.sink ||
      this.droppedCount() <= this.reportedDroppedRecords ||
      !this.sink.hasCapacity()
    ) {
      return;
    }
    const droppedRecords = this.droppedCount();
    const count = droppedRecords - this.reportedDroppedRecords;
    const record = this.makeRecord(
      "warn",
      "observability",
      "log_records_dropped",
      "Sebagian log prioritas rendah dibuang karena antrean penulis penuh.",
      { count },
    );
    const line = serializeRecord(record);
    const queued = this.sink.enqueue({
      line,
      level: "warn",
      bytes: Buffer.byteLength(line),
    });
    if (queued || this.sink.appendEmergency(line)) {
      this.reportedDroppedRecords = droppedRecords;
      this.writeConsole(record, line);
    }
  }

  private writeConsole(
    record: LogRecord,
    jsonLine: string,
    forceStderr = false,
  ): void {
    const sinkFallback = this.sink === null;
    const stderr =
      forceStderr ||
      sinkFallback ||
      LEVEL_WEIGHT[record.level] >= LEVEL_WEIGHT.warn;
    if (!this.options.consoleEnabled && !forceStderr && !sinkFallback) {
      return;
    }
    const stream = stderr
      ? (this.options.stderr ?? process.stderr)
      : (this.options.stdout ?? process.stdout);
    if (stderr ? this.stderrBackpressured : this.stdoutBackpressured) {
      this.consoleDroppedRecords += 1;
      if (stderr) {
        this.stderrDroppedPending += 1;
      } else {
        this.stdoutDroppedPending += 1;
      }
      return;
    }
    const write = (value: string): void => {
      try {
        const accepted = stream.write(value);
        if (accepted !== false) return;
        if (stderr) {
          this.stderrBackpressured = true;
        } else {
          this.stdoutBackpressured = true;
        }
        this.writeFileOnlyRecord(
          "console_backpressure_started",
          "Console log mengalami backpressure; record berikutnya akan dibuang sampai stream pulih.",
          { origin: stderr ? "stderr" : "stdout" },
        );
        if ("once" in stream && typeof stream.once === "function") {
          stream.once("drain", () => {
            const dropped = stderr
              ? this.stderrDroppedPending
              : this.stdoutDroppedPending;
            if (stderr) {
              this.stderrBackpressured = false;
              this.stderrDroppedPending = 0;
            } else {
              this.stdoutBackpressured = false;
              this.stdoutDroppedPending = 0;
            }
            this.writeFileOnlyRecord(
              "console_backpressure_recovered",
              "Console log pulih dari backpressure.",
              {
                origin: stderr ? "stderr" : "stdout",
                count: dropped,
              },
            );
          });
        }
      } catch {
        this.consoleDroppedRecords += 1;
        if (stderr) {
          this.stderrBackpressured = true;
          this.stderrDroppedPending += 1;
        } else {
          this.stdoutBackpressured = true;
          this.stdoutDroppedPending += 1;
        }
        this.writeFileOnlyRecord(
          "console_write_failed",
          "Penulisan console log gagal; record berikutnya akan dibuang.",
          { origin: stderr ? "stderr" : "stdout" },
        );
      }
    };
    if (this.options.consoleFormat === "json") {
      write(jsonLine);
      return;
    }

    const context = record.context?.["traceId"];
    const suffix = context ? ` trace=${String(context)}` : "";
    const errorSuffix = record.error
      ? ` error=${record.error.type}` +
        (record.error.code !== undefined
          ? ` code=${String(record.error.code)}`
          : "") +
        (record.error.status !== undefined
          ? ` status=${String(record.error.status)}`
          : "") +
        ` fingerprint=${record.error.fingerprint}`
      : "";
    write(
      `${record.timestamp} ${record.level.toUpperCase()} ` +
        `${record.component} ${record.event}` +
        `${suffix}${errorSuffix}\n`,
    );
  }

  private writeFileOnlyRecord(
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    if (!this.sink) return;
    const record = this.makeRecord(
      "warn",
      "observability",
      event,
      message,
      fields,
    );
    const line = serializeRecord(record);
    const accepted = this.sink.enqueue({
      line,
      level: "warn",
      bytes: Buffer.byteLength(line),
    });
    if (!accepted && !this.sink.appendEmergency(line)) {
      this.sink.markDropped();
    }
  }
}

class SegmentedJsonlSink {
  private queue: QueueItem[] = [];
  private queueBytes = 0;
  private handle: FileHandle | null = null;
  private currentPath: string | null = null;
  private currentDate = "";
  private currentSegment = 0;
  private currentBytes = 0;
  private knownTotalBytes: number | null = null;
  private reservedWriteBytes = 0;
  private emergencyBlocked = false;
  private draining: Promise<void> | null = null;
  private maintenance: Promise<RetentionResult> | null = null;
  private fileOperation: Promise<void> = Promise.resolve();
  private accepting = true;
  private writeHealthy = true;
  private retentionHealthy = true;
  private lastErrorAt: string | null = null;
  private lastErrorReportAt = 0;
  private suppressedErrorReports = 0;
  private partialLinesRecovered = 0;

  constructor(
    private readonly options: OperationalLogOptions,
    private readonly onDrop: () => void,
  ) {}

  async initialize(): Promise<RetentionResult> {
    await mkdir(this.options.directory, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    await secureDirectory(this.options.directory);
    await this.openCurrentSegment();
    let result: RetentionResult;
    try {
      result = await this.purge();
    } catch (error) {
      this.reportFileError(
        "sink_initial_retention_failed",
        error,
        "retention",
      );
      if (this.options.fileRequired) throw error;
      result = {
        expiredDeleted: 0,
        capDeleted: 0,
        bytesRemaining: this.currentBytes,
        partialLinesRecovered: 0,
        retentionSucceeded: false,
      };
    }
    return {
      ...result,
      partialLinesRecovered: this.takePartialLinesRecovered(),
    };
  }

  async abandonAfterInitializationFailure(): Promise<void> {
    this.accepting = false;
    if (!this.handle) return;
    try {
      await this.handle.close();
    } catch {
      // Error awal yang sebenarnya tetap dilaporkan oleh pemanggil.
    } finally {
      this.handle = null;
    }
  }

  enqueue(item: QueueItem): boolean {
    if (!this.accepting) return false;
    if (
      item.bytes > this.options.maxQueueBytes ||
      item.bytes > MAX_RECORD_BYTES
    ) {
      if (LEVEL_WEIGHT[item.level] < LEVEL_WEIGHT.warn) this.onDrop();
      return false;
    }

    while (
      this.queue.length >= this.options.maxQueueRecords ||
      this.queueBytes + item.bytes > this.options.maxQueueBytes
    ) {
      if (LEVEL_WEIGHT[item.level] < LEVEL_WEIGHT.warn) {
        this.onDrop();
        return false;
      }
      const disposableIndex = this.queue.findIndex(
        (queued) => LEVEL_WEIGHT[queued.level] < LEVEL_WEIGHT.warn,
      );
      if (disposableIndex < 0) {
        return false;
      }
      const [removed] = this.queue.splice(disposableIndex, 1);
      if (removed) {
        this.queueBytes -= removed.bytes;
        this.onDrop();
      }
    }

    this.queue.push(item);
    this.queueBytes += item.bytes;
    this.scheduleDrain();
    return true;
  }

  hasCapacity(): boolean {
    return (
      this.accepting &&
      this.queue.length < this.options.maxQueueRecords &&
      this.queueBytes < this.options.maxQueueBytes
    );
  }

  health(): {
    healthy: boolean;
    writeHealthy: boolean;
    retentionHealthy: boolean;
    queuedRecords: number;
    lastErrorAt: string | null;
  } {
    return {
      healthy: this.writeHealthy && this.retentionHealthy,
      writeHealthy: this.writeHealthy,
      retentionHealthy: this.retentionHealthy,
      queuedRecords: this.queue.length,
      lastErrorAt: this.lastErrorAt,
    };
  }

  async flush(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
    await this.withFileOperation(async () => {
      if (this.handle) {
        try {
          await this.handle.sync();
          this.markWriteHealthy();
        } catch (error) {
          this.reportFileError("sink_flush_failed", error);
        }
      }
    });
    if (
      this.options.fileRequired &&
      (!this.writeHealthy || !this.retentionHealthy)
    ) {
      throw operationalLogError(
        "LOG_SINK_REQUIRED_UNHEALTHY",
        "LOG_FILE_REQUIRED aktif, tetapi penulisan log operasional gagal.",
      );
    }
  }

  async close(): Promise<void> {
    if (!this.accepting && !this.handle) return;
    this.accepting = false;
    let failure: unknown;
    try {
      await this.flush();
    } catch (error) {
      failure = error;
    }
    try {
      await this.maintenance;
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.withFileOperation(async () => {
        if (this.handle) {
          try {
            await this.handle.close();
          } catch (error) {
            this.reportFileError("sink_close_failed", error);
            throw error;
          } finally {
            this.handle = null;
          }
        }
      });
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  async maintain(): Promise<RetentionResult> {
    if (this.maintenance) return this.maintenance;
    const running = this.withFileOperation(async () => {
      const result = await this.purge();
      this.retentionHealthy = true;
      return {
        ...result,
        partialLinesRecovered: this.takePartialLinesRecovered(),
      };
    }).catch((error: unknown) => {
      this.reportFileError("sink_retention_failed", error, "retention");
      throw error;
    });
    this.maintenance = running.finally(() => {
      this.maintenance = null;
    });
    return this.maintenance;
  }

  appendEmergency(line: string): boolean {
    const bytes = Buffer.byteLength(line);
    if (
      !this.accepting ||
      !this.currentPath ||
      this.emergencyBlocked ||
      this.knownTotalBytes === null ||
      bytes > MAX_RECORD_BYTES ||
      this.currentBytes + this.reservedWriteBytes + bytes >
        this.options.maxSegmentBytes ||
      this.knownTotalBytes + this.reservedWriteBytes + bytes >
        this.options.maxTotalBytes
    ) {
      return false;
    }
    try {
      const options: WriteFileOptions = {
        encoding: "utf8",
        mode: FILE_MODE,
        flush: true,
      };
      appendFileSync(this.currentPath, line, options);
      this.currentBytes += bytes;
      this.knownTotalBytes += bytes;
      this.markWriteHealthy();
      return true;
    } catch (error) {
      // append sinkron dapat gagal setelah menulis sebagian. Paksa jalur
      // berikutnya menghitung ulang ukuran sebelum menulis lagi.
      this.knownTotalBytes = null;
      this.reportFileError("emergency_append_failed", error);
      return false;
    }
  }

  markDropped(): void {
    this.onDrop();
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = this.drainLoop().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.scheduleDrain();
    });
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) continue;
      this.queueBytes -= item.bytes;
      if (
        item.bytes > this.options.maxSegmentBytes ||
        item.bytes > this.options.maxTotalBytes
      ) {
        this.onDrop();
        continue;
      }
      try {
        await this.withFileOperation(async () => {
          this.reservedWriteBytes += item.bytes;
          try {
            // Reservasi dipasang sebelum await pertama agar emergency append
            // yang datang di sela pemeriksaan rotasi/cap ikut menghitung item
            // normal yang sedang menuju disk.
            await this.rotateIfNeeded(item.bytes);
            if (!this.handle) await this.openCurrentSegment();
            await this.ensureDiskCapacity(item.bytes);
            await this.handle?.appendFile(item.line, {
              encoding: "utf8",
            });
            this.currentBytes += item.bytes;
            if (this.knownTotalBytes !== null) {
              this.knownTotalBytes += item.bytes;
            }
          } finally {
            this.reservedWriteBytes -= item.bytes;
          }
          this.markWriteHealthy();
        });
      } catch (error) {
        // Error append/rotasi dapat membuat ukuran yang kita pegang tidak lagi
        // pasti. Emergency append ditolak sampai purge menghitungnya ulang.
        this.knownTotalBytes = null;
        this.reportFileError("sink_write_failed", error);
        const recovered =
          LEVEL_WEIGHT[item.level] >= LEVEL_WEIGHT.warn &&
          this.appendEmergency(item.line);
        if (!recovered) this.onDrop();
      }
    }
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    const date = utcDate(this.options.now?.() ?? new Date());
    if (
      date === this.currentDate &&
      (this.currentBytes === 0 ||
        this.currentBytes + nextBytes <= this.options.maxSegmentBytes)
    ) {
      return;
    }

    const alreadyBlocked = this.emergencyBlocked;
    this.emergencyBlocked = true;
    try {
      if (this.handle) {
        await this.handle.sync();
        await this.handle.close();
        this.handle = null;
      }
      if (date !== this.currentDate) {
        this.currentDate = date;
        this.currentSegment = 0;
      } else {
        this.currentSegment += 1;
      }
      await this.openSegment(this.currentDate, this.currentSegment);
      try {
        await this.purge(nextBytes);
      } catch (error) {
        // Retensi tidak boleh membuat record yang memicu rotasi ikut hilang.
        // Scheduler pemeliharaan akan mencoba lagi.
        this.reportFileError(
          "sink_rotation_retention_failed",
          error,
          "retention",
        );
      }
    } finally {
      this.emergencyBlocked = alreadyBlocked;
    }
  }

  private async ensureDiskCapacity(nextBytes: number): Promise<void> {
    if (
      this.knownTotalBytes !== null &&
      this.knownTotalBytes + nextBytes <= this.options.maxTotalBytes
    ) {
      return;
    }
    const result = await this.purge(nextBytes);
    if (
      result.bytesRemaining + nextBytes >
      this.options.maxTotalBytes
    ) {
      throw operationalLogError(
        "LOG_DISK_CAP_REACHED",
        "Batas total disk log operasional sudah tercapai.",
      );
    }
  }

  private async openCurrentSegment(): Promise<void> {
    const date = utcDate(this.options.now?.() ?? new Date());
    const files = await listLogFiles(this.options.directory);
    const sameDay = files
      .filter((file) => file.date === date)
      .sort((left, right) => right.segment - left.segment);
    const latest = sameDay[0];
    const segment =
      latest && latest.size < this.options.maxSegmentBytes
        ? latest.segment
        : (latest?.segment ?? -1) + 1;
    await this.openSegment(date, segment);
  }

  private async openSegment(date: string, segment: number): Promise<void> {
    const filename = segmentFilename(date, segment);
    const path = join(this.options.directory, filename);
    let handle = await open(path, "a+", FILE_MODE);
    try {
      await secureFile(path);
      const info = await handle.stat();
      let repairedSize = info.size;
      if (info.size > 0) {
        const repaired = await repairTrailingLine(path, handle, info.size);
        handle = repaired.handle;
        repairedSize = repaired.size;
        if (repairedSize !== info.size) {
          this.partialLinesRecovered += 1;
        }
      }
      this.handle = handle;
      this.currentPath = path;
      this.currentDate = date;
      this.currentSegment = segment;
      this.currentBytes = repairedSize;
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Error pembukaan asli lebih berguna daripada error close susulan.
      }
      throw error;
    }
  }

  private async purge(reservedBytes = 0): Promise<RetentionResult> {
    const alreadyBlocked = this.emergencyBlocked;
    this.emergencyBlocked = true;
    try {
      return await this.purgeWhileEmergencyBlocked(reservedBytes);
    } finally {
      this.emergencyBlocked = alreadyBlocked;
    }
  }

  private async purgeWhileEmergencyBlocked(
    reservedBytes: number,
  ): Promise<RetentionResult> {
    const files = await listLogFiles(this.options.directory);
    const activePath = this.currentPath;
    const now = this.options.now?.() ?? new Date();
    const oldestRetainedDate = utcDate(
      new Date(
        now.getTime() -
          (this.options.retentionDays - 1) * 24 * 60 * 60 * 1_000,
      ),
    );
    let expiredDeleted = 0;
    let capDeleted = 0;
    let bytesRemaining = files.reduce(
      (total, file) => total + file.size,
      0,
    );
    this.knownTotalBytes = bytesRemaining;
    const active = files.find((file) => file.path === activePath);
    if (active) this.currentBytes = active.size;

    for (const file of files) {
      if (file.path === activePath || file.date >= oldestRetainedDate) {
        continue;
      }
      await unlinkIfPresent(file.path);
      file.deleted = true;
      bytesRemaining -= file.size;
      this.knownTotalBytes = bytesRemaining;
      expiredDeleted += 1;
    }

    const oldestFirst = files
      .filter((file) => !file.deleted && file.path !== activePath)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.segment - right.segment ||
          left.filename.localeCompare(right.filename),
      );
    for (const file of oldestFirst) {
      if (
        bytesRemaining + reservedBytes <=
        this.options.maxTotalBytes
      ) {
        break;
      }
      await unlinkIfPresent(file.path);
      file.deleted = true;
      bytesRemaining -= file.size;
      this.knownTotalBytes = bytesRemaining;
      capDeleted += 1;
    }

    return {
      expiredDeleted,
      capDeleted,
      bytesRemaining,
      partialLinesRecovered: 0,
      retentionSucceeded: true,
    };
  }

  private reportFileError(
    event: string,
    error: unknown,
    kind: "write" | "retention" = "write",
  ): void {
    if (kind === "write") {
      this.writeHealthy = false;
    } else {
      this.retentionHealthy = false;
    }
    const now = this.options.now?.() ?? new Date();
    this.lastErrorAt = now.toISOString();
    if (now.getTime() - this.lastErrorReportAt < 30_000) {
      this.suppressedErrorReports += 1;
      return;
    }
    const normalized = normalizeError(error);
    const stream = this.options.stderr ?? process.stderr;
    const suppressed = this.suppressedErrorReports;
    this.lastErrorReportAt = now.getTime();
    this.suppressedErrorReports = 0;
    safeWrite(
      stream,
      `${this.lastErrorAt} ERROR observability ${event}: ` +
        `${normalized.type} fingerprint=${normalized.fingerprint}` +
        `${suppressed > 0 ? ` suppressed=${suppressed}` : ""}\n`,
    );
  }

  private markWriteHealthy(): void {
    this.writeHealthy = true;
  }

  private takePartialLinesRecovered(): number {
    const count = this.partialLinesRecovered;
    this.partialLinesRecovered = 0;
    return count;
  }

  private async withFileOperation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.fileOperation;
    let release: () => void = () => undefined;
    this.fileOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

export async function createOperationalLogSystem(
  options: OperationalLogOptions,
): Promise<OperationalLogSystem> {
  validateOptions(options);
  let droppedBySink = 0;
  let sink: SegmentedJsonlSink | null = null;
  let retention: RetentionResult | null = null;

  const candidate = new SegmentedJsonlSink(options, () => {
    droppedBySink += 1;
  });
  try {
    retention = await candidate.initialize();
    sink = candidate;
  } catch (error) {
    await candidate.abandonAfterInitializationFailure();
    const normalized = normalizeError(error);
    safeWrite(
      options.stderr ?? process.stderr,
      `${new Date().toISOString()} ERROR observability sink_start_failed: ` +
        `${normalized.type} fingerprint=${normalized.fingerprint}\n`,
    );
    if (options.fileRequired) throw error;
  }

  const runtime = new OperationalLogRuntime(
    options,
    sink,
    randomUUID(),
    () => droppedBySink,
  );
  const logger = new RuntimeLogger(runtime, "app");
  let maintenanceTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;

  if (sink) {
    maintenanceTimer = setInterval(() => {
      void sink?.maintain().catch((error: unknown) => {
        logger.warn(
          "log_retention_failed",
          "Retensi log operasional gagal dijalankan.",
          { error },
        );
      });
    }, options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref();
  }

  logger.info(
    "operational_logging_ready",
    "Pencatatan operasional aktif.",
    {
      fileEnabled: sink !== null,
      level: options.level,
      retentionDays: options.retentionDays,
      maxSegmentBytes: options.maxSegmentBytes,
      maxTotalBytes: options.maxTotalBytes,
      expiredDeleted: retention?.expiredDeleted ?? 0,
      capDeleted: retention?.capDeleted ?? 0,
      partialLinesRecovered: retention?.partialLinesRecovered ?? 0,
      retentionSucceeded: retention?.retentionSucceeded ?? false,
    },
  );

  return {
    logger,
    async flush(): Promise<void> {
      await runtime.flush();
    },
    async close(): Promise<void> {
      if (closing) return closing;
      if (closed) return;
      closed = true;
      closing = (async () => {
        if (maintenanceTimer) {
          clearInterval(maintenanceTimer);
          maintenanceTimer = null;
        }
        let failure: unknown;
        try {
          await runtime.flush();
        } catch (error) {
          failure = error;
        }
        try {
          await sink?.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      })();
      return closing;
    },
    async maintain(): Promise<void> {
      const result = await sink?.maintain();
      if (result) {
        logger.info(
          "log_retention_completed",
          "Retensi log operasional selesai.",
          { ...result },
        );
      }
    },
    health(): OperationalLogHealth {
      return runtime.health();
    },
    fatalSync(
      event: string,
      message: string,
      error: unknown,
      fields: Record<string, unknown> = {},
    ): void {
      runtime.fatalSync(event, message, error, fields);
    },
  };
}

function serializeRecord(record: LogRecord): string {
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line;

  const shortened: LogRecord = {
    ...record,
    ...(record.data ? { data: { recordTruncated: true } } : {}),
    ...(record.error
      ? {
          error: {
            type: record.error.type,
            fingerprint: record.error.fingerprint,
            ...(record.error.code !== undefined
              ? { code: record.error.code }
              : {}),
            ...(record.error.status !== undefined
              ? { status: record.error.status }
              : {}),
            ...(record.error.stack
              ? { stack: record.error.stack.slice(0, 2_048) }
              : {}),
          },
        }
      : {}),
  };
  line = `${JSON.stringify(shortened)}\n`;
  return line;
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const result: Record<string, unknown> = {};
    let omitted = 0;
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      const normalizedKey = normalizeKey(key);
      const fieldName = normalizeFieldName(key);
      if (SENSITIVE_KEYS.has(normalizedKey)) {
        result[fieldName] = "[REDACTED]";
        continue;
      }
      if (PRIVATE_IDENTIFIER_KEYS.has(normalizedKey)) {
        result[fieldName] = "[PRIVATE_IDENTIFIER]";
        continue;
      }
      if (normalizedKey === "accountid") {
        result[fieldName] =
          typeof item === "string" || typeof item === "number"
            ? safeOperationalAccountId(String(item))
            : "[PRIVATE_IDENTIFIER]";
        continue;
      }
      if (!ALLOWED_DATA_KEYS.has(normalizedKey)) {
        omitted += 1;
        continue;
      }
      const sanitized = sanitizeAllowedValue(item, normalizedKey);
      if (sanitized !== undefined) result[fieldName] = sanitized;
    }
    omitted += Math.max(0, entries.length - MAX_OBJECT_KEYS);
    if (omitted > 0) result["fieldsOmitted"] = omitted;
    return result;
  } catch {
    return { sanitizationFailed: true };
  }
}

function sanitizeAllowedValue(
  value: unknown,
  key: string,
): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error && key === "error") return normalizeError(value);
  if (typeof value === "string") {
    const safe = scrubString(value, 160);
    if (/^\[[A-Z_]+\]$/.test(safe)) return safe;
    return /^[A-Za-z0-9_./:@+\-]{1,160}$/.test(safe)
      ? safe
      : "[REDACTED_SCALAR]";
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return "[OBJECT_OMITTED]";
}

function normalizeError(error: unknown, depth = 0): NormalizedError {
  const source = error instanceof Error ? error : undefined;
  const record = source as
    | (Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    cause?: unknown;
      })
    | undefined;
  const candidateType = source
    ? normalizeLabel(source.name || "Error", "error")
    : normalizeLabel(`non_error_${typeof error}`, "non_error");
  const type =
    !source || SAFE_ERROR_TYPES.has(candidateType)
      ? candidateType
      : "error";
  const code = safeErrorScalar(record?.code);
  const status = safeErrorScalar(record?.statusCode ?? record?.status);
  const stack = source?.stack
    ? scrubString(
        source.stack
          .split("\n")
          .slice(1)
          .filter((line) => /^\s*at\s/.test(line))
          .slice(0, 16)
          .join("\n"),
        MAX_STACK_LENGTH,
      )
    : undefined;
  const fingerprintSource = [
    type,
    code === undefined ? "" : String(code),
    status === undefined ? "" : String(status),
    stack
      ?.split("\n")
      .slice(0, 5)
      .map((line) => line.replace(/:\d+:\d+/g, ":#:#"))
      .join("|") ?? "",
  ].join("|");
  const fingerprint = createHash("sha256")
    .update(fingerprintSource)
    .digest("hex")
    .slice(0, 16);
  const cause =
    depth < 2 && record?.cause !== undefined
      ? normalizeError(record.cause, depth + 1)
      : undefined;

  return {
    type,
    fingerprint,
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(stack ? { stack } : {}),
    ...(cause ? { cause } : {}),
  };
}

function safeErrorScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    /^(?:[A-Z][A-Z0-9_]{1,79}|[0-9]{3,6})$/.test(value)
  ) {
    return value;
  }
  return undefined;
}

function scrubString(value: string, maxLength = MAX_STRING_LENGTH): string {
  let safe = value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, "[TELEGRAM_TOKEN]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[API_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[API_KEY]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[JWT]",
    )
    .replace(
      /(?<![A-Za-z0-9])[\d-]+(?::\d+)?@(s\.whatsapp\.net|g\.us|lid|broadcast)\b/gi,
      "[WHATSAPP_ID]",
    )
    .replace(
      /([?&](?:token|key|api_?key|secret|password|code)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(?<!\d)\+?\d{8,15}(?!\d)/g, "[PHONE_OR_ID]")
    .replace(/(?<!\d)\d{16,18}(?!\d)/g, "[LONG_ID]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[BASE64]");

  const workspace = process.cwd();
  const userHome = homedir();
  if (workspace) {
    safe = safe.replace(
      new RegExp(escapeRegExp(workspace), "gi"),
      "[WORKSPACE]",
    );
  }
  if (userHome) {
    safe = safe.replace(
      new RegExp(escapeRegExp(userHome), "gi"),
      "[HOME]",
    );
  }
  if (safe.length > maxLength) return `${safe.slice(0, maxLength)}…`;
  return safe;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function normalizeLabel(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function normalizeFieldName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .slice(0, 80) || "field";
}

function normalizeKey(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeOperationalAccountId(value: string): string {
  const normalized = value.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(normalized)
    ? normalized
    : "[PRIVATE_IDENTIFIER]";
}

function safeWrite(
  stream: Pick<NodeJS.WritableStream, "write">,
  value: string,
): void {
  try {
    stream.write(value);
  } catch {
    // Logger tidak boleh menjatuhkan operasi aplikasi karena console rusak.
  }
}

async function repairTrailingLine(
  path: string,
  handle: FileHandle,
  size: number,
): Promise<{ handle: FileHandle; size: number }> {
  const lastByte = Buffer.alloc(1);
  await handle.read(lastByte, 0, 1, size - 1);
  if (lastByte[0] === 0x0a) return { handle, size };

  const lastNewline = await findLastNewline(handle, size);
  const fragmentStart = lastNewline + 1;
  const fragmentLength = size - fragmentStart;
  if (fragmentLength > 0 && fragmentLength <= MAX_RECORD_BYTES) {
    const fragment = Buffer.alloc(fragmentLength);
    await handle.read(fragment, 0, fragmentLength, fragmentStart);
    try {
      const parsed = JSON.parse(fragment.toString("utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["schema"] ===
          OPERATIONAL_LOG_SCHEMA
      ) {
        await handle.appendFile("\n", { encoding: "utf8" });
        return { handle, size: size + 1 };
      }
    } catch {
      // Fragmen crash yang bukan record lengkap dibuang di bawah.
    }
  }

  // Windows tidak selalu mengizinkan ftruncate pada handle O_APPEND.
  await handle.close();
  await truncate(path, fragmentStart);
  return {
    handle: await open(path, "a+", FILE_MODE),
    size: fragmentStart,
  };
}

async function findLastNewline(
  handle: FileHandle,
  size: number,
): Promise<number> {
  const chunkSize = 64 * 1024;
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunkSize);
    const chunk = Buffer.alloc(end - start);
    await handle.read(chunk, 0, chunk.length, start);
    const index = chunk.lastIndexOf(0x0a);
    if (index >= 0) return start + index;
    end = start;
  }
  return -1;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function segmentFilename(date: string, segment: number): string {
  return `harvy-${date}-${String(segment + 1).padStart(4, "0")}.ndjson`;
}

async function listLogFiles(directory: string): Promise<
  Array<{
    filename: string;
    path: string;
    date: string;
    segment: number;
    size: number;
    deleted: boolean;
  }>
> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LOG_FILE_PATTERN.exec(entry.name);
    if (!match?.[1] || !match[2]) continue;
    const path = join(directory, entry.name);
    const info = await stat(path);
    files.push({
      filename: entry.name,
      path,
      date: match[1],
      segment: Number(match[2]) - 1,
      size: info.size,
      deleted: false,
    });
  }
  return files;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function secureDirectory(path: string): Promise<void> {
  try {
    await chmod(path, DIRECTORY_MODE);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function secureFile(path: string): Promise<void> {
  try {
    await chmod(path, FILE_MODE);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function validateOptions(options: OperationalLogOptions): void {
  if (!(options.level in LEVEL_WEIGHT)) {
    throw operationalLogError(
      "LOG_LEVEL_INVALID",
      "Level log operasional tidak sah.",
    );
  }
  if (!options.directory.trim()) {
    throw operationalLogError(
      "LOG_DIRECTORY_EMPTY",
      "Folder log operasional tidak boleh kosong.",
    );
  }
  const resolvedDirectory = resolve(options.directory);
  if (parse(resolvedDirectory).root === resolvedDirectory) {
    throw operationalLogError(
      "LOG_DIRECTORY_ROOT",
      "Folder log operasional tidak boleh menunjuk ke akar filesystem.",
    );
  }
  for (const [name, value] of [
    ["retentionDays", options.retentionDays],
    ["maxSegmentBytes", options.maxSegmentBytes],
    ["maxTotalBytes", options.maxTotalBytes],
    ["maxQueueRecords", options.maxQueueRecords],
    ["maxQueueBytes", options.maxQueueBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw operationalLogError(
        "LOG_LIMIT_INVALID",
        `${name} harus berupa bilangan bulat positif.`,
      );
    }
  }
  if (options.maxTotalBytes < options.maxSegmentBytes) {
    throw operationalLogError(
      "LOG_TOTAL_BELOW_SEGMENT",
      "Batas total log tidak boleh lebih kecil daripada satu segmen.",
    );
  }
  if (
    options.maintenanceIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.maintenanceIntervalMs) ||
      options.maintenanceIntervalMs <= 0)
  ) {
    throw operationalLogError(
      "LOG_MAINTENANCE_INTERVAL_INVALID",
      "Interval maintenance log harus berupa bilangan bulat positif.",
    );
  }
}

function operationalLogError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "OperationalLogError",
    code,
  });
}
