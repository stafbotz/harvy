import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import makeWASocket, {
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import { Bot } from "grammy";
import { Api, Logger, TelegramClient } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import { StringSession } from "teleproto/sessions/index.js";
import {
  assertLiveExplorationGate,
  assertLiveExplorationAssessmentAllowed,
  createLiveExplorationWhatsAppScope,
  LIVE_EXPLORATION_PAUSE_THRESHOLD_MS,
  LiveExplorationEvidenceWriter,
  liveExplorationCoverageFromEvidence,
  liveExplorationCoverageSnapshot,
  liveExplorationHasReadyRun,
  liveExplorationRunId,
  LiveSurfaceAliasLedger,
  LiveTurnAttribution,
  liveExplorationWhatsAppMessageId,
  isLiveExplorationWhatsAppMessageId,
  parseLiveExplorationCommand,
  parseLiveExplorationOptions,
  prepareLiveExplorationJourney,
  readLiveExplorationEvidence,
  removeLiveExplorationJourney,
  type LiveExplorationAssessment,
  type LiveExplorationChannel,
  type LiveExplorationCommand,
  type LiveExplorationCoverageMarker,
  type LiveExplorationCoverageSource,
  type LiveExplorationCoverageTrigger,
  type LiveExplorationRunMode,
  type LiveExplorationTurnEvidence,
} from "../src/operations/live-exploration.js";
import {
  isolatedRuntimeEnvironment,
  liveAcceptancePaths,
  loadRepositoryEnvironment,
  loadTelegramBotCredential,
  loadTelegramLiveAcceptanceCredential,
} from "../src/operations/live-acceptance.js";
import { acquireLocalRuntimeLock } from "../src/core/local-runtime-lock.js";
import {
  superviseRuntime,
  type RuntimeSupervisorEvent,
} from "../src/operations/runtime-supervisor.js";
import { installThirdPartyConsoleSecretGuard } from
  "../src/observability/third-party-console-guard.js";
import { isWhatsAppCredentialReady } from
  "../src/whatsapp/auth-credential.js";
import { whatsAppCredentialJids } from
  "../src/whatsapp/auth-credential.js";
import { parseWhatsAppSurfaceEvent } from
  "../src/operations/whatsapp-surface-evidence.js";
import { createVisualAcceptanceFixtureForColor } from
  "./live-visual-acceptance-fixture.js";

const RUNTIME_READY_TIMEOUT_MS = 120_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 75_000;
const TELEGRAM_POLL_MS = 500;
const WHATSAPP_OBSERVATION_QUIET_MS = 750;
const WHATSAPP_OBSERVATION_FLUSH_MAX_MS = 5_000;
const SCRIPTED_COMMANDS_ENV = "HARVY_LIVE_EXPLORATION_COMMANDS_JSONL";
const MAX_SCRIPTED_COMMANDS = 32;
/**
 * Diam selama ini berarti balasan sudah utuh.
 *
 * Angkanya bagian dari anggaran delapan detik, bukan sekadar ambang teknis:
 * jeda ini ditambah `settle` dan pengiriman berikutnya harus tetap muat di
 * dalam jendela yang membuat sambungan dikenali sebagai potongan. Pada 2.500 ms
 * marginnya terlalu tipis—satu sesi mendapat pengakuannya dan sesi berikutnya
 * tidak, dengan bentuk giliran yang sama persis.
 *
 * Tetap jauh lebih panjang daripada granularitas polling 500 ms, dan jarak
 * antara status "sedang memikirkan" dengan jawaban akhir terukur belasan detik,
 * jadi tidak ada risiko berhenti di tengah balasan.
 */
const MAX_SCRIPTED_COMMAND_BYTES = 256 * 1024;

interface ExplorerSurfaceEvent {
  operation: "create" | "edit" | "delete" | "pin" | "unpin";
  technicalId: string;
  text: string;
  buttons: string[];
  hasDocument: boolean;
}

interface ExplorerDriver {
  send(text: string): Promise<void>;
  sendImage?(image: Buffer, caption: string): Promise<void>;
  reply(surface: string, text: string): Promise<void>;
  click(surface: string, label: string): Promise<void>;
  flushObservation(): Promise<{ timedOut: boolean }>;
  close(): Promise<void>;
}

interface WhatsAppConnectionUpdate {
  connection?: string;
  lastDisconnect?: { error?: unknown } | null;
}

export type WhatsAppObserverConnectionStatus =
  | { status: "connecting" | "open"; reason: null }
  | { status: "closed"; reason: number | null };

/**
 * Status `open` saat startup bukan jaminan socket observer tetap hidup.
 * Guard ini mempertahankan close berikutnya agar send/flush tidak berubah
 * menjadi kegagalan generik atau, lebih buruk, settle tanpa response.
 */
export class WhatsAppObserverConnectionGuard {
  private current: WhatsAppObserverConnectionStatus = {
    status: "connecting",
    reason: null,
  };

  observe(
    update: WhatsAppConnectionUpdate,
  ): WhatsAppObserverConnectionStatus | null {
    if (update.connection === "open") {
      this.current = { status: "open", reason: null };
      return this.snapshot();
    }
    if (update.connection === "connecting") {
      this.current = { status: "connecting", reason: null };
      return this.snapshot();
    }
    if (update.connection === "close") {
      this.current = {
        status: "closed",
        reason: whatsAppDisconnectReason(update.lastDisconnect?.error),
      };
      return this.snapshot();
    }
    return null;
  }

  snapshot(): WhatsAppObserverConnectionStatus {
    return { ...this.current };
  }

  assertOpen(): void {
    if (this.current.status === "open") return;
    if (this.current.status === "closed") {
      throw blocked(this.current.reason === null
        ? "LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_CLOSED"
        : `LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_CLOSED_${this.current.reason}`);
    }
    throw blocked("LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_NOT_OPEN");
  }
}

interface RuntimeHandle {
  restart(): Promise<void>;
  stop(): Promise<number>;
  snapshot(): {
    readyAttempts: number[];
    restarts: number;
    faultInjected: number;
    crashLoopOpened: boolean;
    shutdownTimedOut: boolean;
  };
}

export interface TurnObservation {
  turn: number;
  startedAt: number;
  firstResponseMs: number | null;
  responseEvents: number;
}

interface ExplorationMetrics {
  turns: TurnObservation[];
  surfaceEvents: number;
  operations: Record<ExplorerSurfaceEvent["operation"], number>;
  assessments: LiveExplorationAssessment[];
  quarantinedSurfaces: number;
  boundaries: number;
  coverage: Set<LiveExplorationCoverageMarker>;
}

type ExplorerTransportCommand = Extract<
  LiveExplorationCommand,
  {
    type:
      | "send"
      | "image"
      | "reply"
      | "click"
      | "burst"
      | "interrupt";
  }
>;

export interface ExplorerSentRecord {
  commandSequence: number;
  turn: number;
  kind: ExplorerTransportCommand["type"];
  messageCount: number;
  partial: boolean;
}

export interface ExplorerTransportRejection {
  sentMessageCount: number;
  rejectedMessageCount: number;
  failedMessageIndex: number;
}

class ExplorerTransportRejectedError extends Error {
  readonly rejection: ExplorerTransportRejection;

  constructor(error: unknown, rejection: ExplorerTransportRejection) {
    super(safeErrorCode(error), { cause: error });
    this.name = "ExplorerTransportRejectedError";
    this.rejection = rejection;
  }
}

class ExplorerEvidenceCommitError extends Error {
  constructor(error: unknown) {
    super("LIVE_EXPLORATION_EVIDENCE_COMMIT_FAILED", { cause: error });
    this.name = "ExplorerEvidenceCommitError";
  }
}

export function isExplorerEvidenceCommitError(
  error: unknown,
): boolean {
  return error instanceof ExplorerEvidenceCommitError;
}

function evidenceCommitFailure(error: unknown): ExplorerEvidenceCommitError {
  return error instanceof ExplorerEvidenceCommitError
    ? error
    : new ExplorerEvidenceCommitError(error);
}

async function commitExplorerEvidence<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw evidenceCommitFailure(error);
  }
}

export function explorerTransportRejection(
  error: unknown,
): ExplorerTransportRejection | null {
  return error instanceof ExplorerTransportRejectedError
    ? { ...error.rejection }
    : null;
}

export interface ExplorerTransportExecutionOptions {
  command: ExplorerTransportCommand;
  commandSequence: number;
  runId: string;
  driver: Pick<ExplorerDriver, "send" | "reply" | "click"> &
    Partial<Pick<ExplorerDriver, "sendImage">>;
  evidence: Pick<
    LiveExplorationEvidenceWriter,
    "recordBoundary" | "recordTurn"
  >;
  attribution: LiveTurnAttribution;
  turns: TurnObservation[];
  boundarySequence?: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  onSent?: (record: ExplorerSentRecord) => void;
}

export async function executeExplorerTransportCommand(
  options: ExplorerTransportExecutionOptions,
): Promise<void> {
  const { command } = options;
  const activeTurn = options.attribution.current().turn;
  if (command.type === "interrupt") {
    if (activeTurn === null) {
      throw blocked("LIVE_EXPLORATION_INTERRUPT_REQUIRES_ACTIVE_TURN");
    }
    if (!Number.isSafeInteger(options.boundarySequence) ||
      (options.boundarySequence ?? 0) < 1) {
      throw blocked("LIVE_EXPLORATION_BOUNDARY_INVALID");
    }
  } else if (activeTurn !== null) {
    throw blocked("LIVE_EXPLORATION_TURN_ACTIVE_SETTLE_OR_INTERRUPT_REQUIRED");
  }
  const visualFixture = command.type === "image"
    ? createVisualAcceptanceFixtureForColor(command.color)
    : null;
  const texts = command.type === "send" || command.type === "reply" ||
      command.type === "interrupt"
    ? [command.text]
    : command.type === "image"
    ? [visualFixture!.prompt]
    : command.type === "click"
    ? [command.label]
    : [...command.messages];
  if (texts.length === 0) throw blocked("LIVE_EXPLORATION_BURST_EMPTY");

  // A new turn is committed only after its first message is accepted by the
  // transport, so a rejected first message cannot create phantom evidence. An
  // interrupt keeps the old attribution active until that acceptance point.
  const turn = options.turns.length + 1;
  const startedAt = (options.now ?? Date.now)();
  const sentTexts: string[] = [];
  const pause = options.pause ?? delay;
  const recordSentPrefix = async (): Promise<void> => {
    const value: LiveExplorationTurnEvidence = {
      runId: options.runId,
      turn,
      kind: command.type,
      texts: sentTexts,
      ...((command.type === "reply" || command.type === "click")
        ? { replySurface: command.surface }
        : {}),
    };
    await options.evidence.recordTurn(value);
  };
  const sendAt = async (index: number): Promise<void> => {
    if (command.type === "image") {
      if (!options.driver.sendImage || !visualFixture) {
        throw blocked("LIVE_EXPLORATION_IMAGE_UNAVAILABLE");
      }
      await options.driver.sendImage(
        visualFixture.data,
        visualFixture.prompt,
      );
    } else if (command.type === "reply") {
      await options.driver.reply(command.surface, command.text);
    } else if (command.type === "click") {
      await options.driver.click(command.surface, command.label);
    } else {
      await options.driver.send(texts[index]!);
    }
  };

  for (let index = 0; index < texts.length; index += 1) {
    try {
      await sendAt(index);
    } catch (transportError) {
      let reportingError: unknown = null;
      try {
        if (sentTexts.length > 0) {
          await recordSentPrefix();
          options.onSent?.({
            commandSequence: options.commandSequence,
            turn,
            kind: command.type,
            messageCount: sentTexts.length,
            partial: true,
          });
        }
      } catch (error) {
        reportingError = error;
      } finally {
        // A partial burst may still receive delayed responses, but once its
        // transport rejects they must be background output, not a live turn.
        // A rejected interrupt, however, leaves the preceding turn active.
        if (sentTexts.length > 0) options.attribution.close();
      }
      if (reportingError) throw evidenceCommitFailure(reportingError);
      throw new ExplorerTransportRejectedError(
        transportError,
        {
          sentMessageCount: sentTexts.length,
          rejectedMessageCount: texts.length - sentTexts.length,
          failedMessageIndex: sentTexts.length + 1,
        },
      );
    }

    sentTexts.push(texts[index]!);
    if (sentTexts.length === 1) {
      if (command.type === "interrupt") options.attribution.close();
      const observation: TurnObservation = {
        turn,
        startedAt,
        firstResponseMs: null,
        responseEvents: 0,
      };
      options.turns.push(observation);
      options.attribution.start(turn, startedAt);
      if (command.type === "interrupt") {
        try {
          await options.evidence.recordBoundary({
            runId: options.runId,
            boundary: options.boundarySequence!,
            kind: "interrupt",
            fromTurn: activeTurn!,
            toTurn: turn,
            observationFlushTimedOut: null,
          });
        } catch (error) {
          options.attribution.close();
          throw evidenceCommitFailure(error);
        }
      }
    }
    if (
      command.type === "burst" && index < texts.length - 1 &&
      command.gapMs > 0
    ) {
      await pause(command.gapMs);
    }
  }

  try {
    await recordSentPrefix();
  } catch (error) {
    options.attribution.close();
    throw evidenceCommitFailure(error);
  }
  options.onSent?.({
    commandSequence: options.commandSequence,
    turn,
    kind: command.type,
    messageCount: sentTexts.length,
    partial: false,
  });
}

export interface ExplorerAttributionBoundaryOptions {
  attribution: LiveTurnAttribution;
  flushObservation: () => Promise<{ timedOut: boolean }>;
  drainObservation: () => Promise<void>;
}

export async function closeExplorerAttributionBoundary(
  options: ExplorerAttributionBoundaryOptions,
): Promise<{ timedOut: boolean }> {
  let flush: { timedOut: boolean } | null = null;
  let flushError: unknown = null;
  try {
    flush = await options.flushObservation();
  } catch (error) {
    flushError = error;
  }
  try {
    await options.drainObservation();
    if (flushError) throw flushError;
    return flush!;
  } finally {
    options.attribution.close();
  }
}

export interface ObservedWhatsAppStartupOptions<TRuntime> {
  driver: ExplorerDriver;
  waitForObserverReady: () => Promise<void>;
  startRuntime: () => Promise<TRuntime>;
}

export async function startObservedWhatsAppRuntime<TRuntime>(
  options: ObservedWhatsAppStartupOptions<TRuntime>,
): Promise<{ runtime: TRuntime; driver: ExplorerDriver }> {
  try {
    // The observer must be connected before Harvy can resume queued/proactive
    // work. The driver remains private until both sides report ready.
    await options.waitForObserverReady();
    const runtime = await options.startRuntime();
    return { runtime, driver: options.driver };
  } catch (error) {
    await options.driver.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  installThirdPartyConsoleSecretGuard();
  const repositoryRoot = process.cwd();
  loadRepositoryEnvironment(repositoryRoot);
  assertLiveExplorationGate(process.env);
  const options = parseLiveExplorationOptions(process.argv.slice(2));
  const scriptedCommands = takeScriptedCommands(process.env);
  const paths = liveAcceptancePaths(repositoryRoot);
  const lock = await acquireLocalRuntimeLock(paths.setupLockFile, "evaluation");
  try {
    await runExplorer(
      repositoryRoot,
      options.channel,
      options.journeyId,
      options.runMode,
      scriptedCommands,
    );
  } finally {
    await lock.release();
  }
}

async function runExplorer(
  repositoryRoot: string,
  channel: LiveExplorationChannel,
  journeyId: string,
  runMode: LiveExplorationRunMode,
  scriptedCommands: string | null,
): Promise<void> {
  const entry = resolve(repositoryRoot, "dist", "src", "app.js");
  if (!(await lstat(entry).catch(() => null))?.isFile()) {
    throw blocked("LIVE_EXPLORATION_BUILD_REQUIRED");
  }
  const journey = await prepareLiveExplorationJourney(
    repositoryRoot,
    channel,
    journeyId,
  );
  const previousEvidence = await readLiveExplorationEvidence(
    journey.evidenceFile,
  );
  const priorCoverage = liveExplorationCoverageFromEvidence(
    previousEvidence,
    runMode,
  );
  const hasPriorReadyRun = liveExplorationHasReadyRun(
    previousEvidence,
    runMode,
  );
  const runId = liveExplorationRunId();
  const whatsappScope = channel === "whatsapp"
    ? createLiveExplorationWhatsAppScope()
    : null;
  const evidence = new LiveExplorationEvidenceWriter(
    journey.evidenceFile,
    channel,
  );
  const aliases = new LiveSurfaceAliasLedger();
  const metrics: ExplorationMetrics = {
    turns: [],
    surfaceEvents: 0,
    operations: { create: 0, edit: 0, delete: 0, pin: 0, unpin: 0 },
    assessments: [],
    quarantinedSurfaces: 0,
    boundaries: 0,
    coverage: new Set(priorCoverage),
  };
  let surfaceSequence = 0;
  let surfaceTail: Promise<void> = Promise.resolve();
  let runtimeTraceSequence = 0;
  let runtimeTraceTail: Promise<void> = Promise.resolve();
  let coverageSequence = 0;
  let boundarySequence = 0;
  let fatalSurfaceError: unknown = null;
  const attribution = new LiveTurnAttribution();

  await evidence.recordLifecycle(runId, "started", {
    resumed: journey.resumed,
    runMode,
  });

  const onSurface = (surface: ExplorerSurfaceEvent): void => {
    const observed = attribution.observe(Date.now());
    surfaceTail = surfaceTail.then(async () => {
      const alias = aliases.aliasFor(surface.technicalId);
      if (observed.turn !== null && observed.latencyMs !== null) {
        const turn = metrics.turns[observed.turn - 1];
        if (turn) {
          turn.responseEvents += 1;
          turn.firstResponseMs ??= observed.latencyMs;
        }
      }
      surfaceSequence += 1;
      metrics.surfaceEvents += 1;
      metrics.operations[surface.operation] += 1;
      await evidence.recordSurface({
        runId,
        sequence: surfaceSequence,
        operation: surface.operation,
        surface: alias,
        text: surface.text,
        buttons: surface.buttons,
        hasDocument: surface.hasDocument,
        latencyMs: observed.latencyMs,
        phase: observed.phase,
        turn: observed.turn,
      });
      emit({
        type: "surface",
        channel,
        sequence: surfaceSequence,
        operation: surface.operation,
        surface: alias,
        text: surface.text,
        buttons: surface.buttons,
        hasDocument: surface.hasDocument,
        latencyMs: observed.latencyMs,
        phase: observed.phase,
        turn: observed.turn,
        attribution: observed.turn === null ? "background" : "turn",
        transientContent: true,
      });
    }).catch((error) => {
      fatalSurfaceError ??= error;
      emit({
        type: "runner_error",
        code: safeErrorCode(error),
      });
    });
  };

  const onRuntimeTrace = (
    event: Extract<RuntimeSupervisorEvent, { type: "acceptance-trace" }>,
  ): void => {
    const observed = attribution.current();
    runtimeTraceSequence += 1;
    const sequence = runtimeTraceSequence;
    runtimeTraceTail = runtimeTraceTail.then(async () => {
      await evidence.recordRuntimeTrace({
        runId,
        sequence,
        attempt: event.attempt,
        stage: event.stage,
        phase: observed.phase,
        turn: observed.turn,
      });
      emit({
        type: "runtime_trace",
        channel,
        sequence,
        attempt: event.attempt,
        stage: event.stage,
        phase: observed.phase,
        turn: observed.turn,
        contentPersistence: "none",
      });
    }).catch((error) => {
      fatalSurfaceError ??= error;
      emit({ type: "runner_error", code: safeErrorCode(error) });
    });
  };

  const onQuarantinedSurface = (
    operation: ExplorerSurfaceEvent["operation"],
  ): void => {
    const observed = attribution.current();
    metrics.quarantinedSurfaces += 1;
    emit({
      type: "surface_quarantined",
      channel,
      operation,
      phase: observed.phase,
      turn: observed.turn,
      reason: "outside-current-run-scope",
      transientContent: false,
    });
  };

  let setup: { runtime: RuntimeHandle; driver: ExplorerDriver };
  try {
    setup = channel === "telegram"
      ? await startTelegram(
        repositoryRoot,
        journey.root,
        entry,
        aliases,
        onSurface,
        onRuntimeTrace,
      )
      : await startWhatsApp(
        repositoryRoot,
        journey.root,
        entry,
        aliases,
        onSurface,
        onRuntimeTrace,
        whatsappScope!,
        onQuarantinedSurface,
      );
  } catch (error) {
    await Promise.all([surfaceTail, runtimeTraceTail]).catch(() => undefined);
    const code = safeErrorCode(error);
    let evidenceClean = true;
    await evidence.recordLifecycle(runId, "startup_failed", { code })
      .catch(() => {
        evidenceClean = false;
      });
    await evidence.close().catch(() => {
      evidenceClean = false;
    });
    emit({
      type: "startup_failed",
      channel,
      journey: journeyId,
      code,
      evidenceClean,
      transcriptPersistence: "none",
    });
    throw error;
  }
  const { runtime, driver } = setup;
  let deleteJourney = false;
  let stopped = false;
  let commandSequence = 0;
  const reader = scriptedCommands === null
    ? createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    })
    : null;
  const commandLines: AsyncIterable<string> | Iterable<string> = reader ??
    scriptedCommands!.split("\n");
  const closeInput = (): void => reader?.close();
  if (reader) {
    process.once("SIGINT", closeInput);
    process.once("SIGTERM", closeInput);
  }

  try {
    attribution.markReady();
    await evidence.recordLifecycle(runId, "ready", {
      resumed: journey.resumed,
      runMode,
    });
    if (journey.resumed && hasPriorReadyRun) {
      await recordCoverage("derived", "resumed", ["re-entry"]);
    }
    emit({
      type: "ready",
      channel,
      journey: journeyId,
      resumed: journey.resumed,
      runMode,
      commands: [
        "send", "image", "reply", "click", "burst", "interrupt", "settle", "wait",
        "restart", "mark", "assess", "status", "stop",
      ],
      coverage: liveExplorationCoverageSnapshot(metrics.coverage),
      transcriptPersistence: "none",
      evidencePersistence: "content-free",
      commandSource: scriptedCommands === null ? "stdin" : "ephemeral-jsonl",
      scriptedCommandCount: scriptedCommands === null
        ? 0
        : scriptedCommands.split("\n").filter(Boolean).length,
    });

    for await (const line of commandLines) {
      if (!line.trim()) continue;
      commandSequence += 1;
      if (fatalSurfaceError) {
        throw evidenceCommitFailure(fatalSurfaceError);
      }
      try {
        const command = parseLiveExplorationCommand(line);
        const result = await executeCommand(command, commandSequence);
        if (result === "stop") {
          deleteJourney = command.type === "stop" && command.deleteJourney;
          stopped = true;
          break;
        }
      } catch (error) {
        if (isExplorerEvidenceCommitError(error)) throw error;
        const transport = explorerTransportRejection(error);
        emit({
          type: "command_rejected",
          commandSequence,
          code: safeErrorCode(error),
          ...(transport ?? {}),
        });
      }
    }
  } finally {
    if (reader) {
      process.off("SIGINT", closeInput);
      process.off("SIGTERM", closeInput);
      reader.close();
    }
    let shutdownError: unknown = null;
    const rememberShutdownError = (error: unknown): void => {
      shutdownError ??= error;
    };
    const beforeStopFlush = await closeAttributionWindow().catch((error) => {
      rememberShutdownError(error);
      emit({ type: "driver_flush_failed", code: safeErrorCode(error) });
      return { timedOut: true };
    });
    const runtimeCode = await runtime.stop().catch((error) => {
      rememberShutdownError(error);
      return 1;
    });
    const afterStopFlush = await driver.flushObservation().catch((error) => {
      rememberShutdownError(error);
      emit({ type: "driver_flush_failed", code: safeErrorCode(error) });
      return { timedOut: true };
    });
    await Promise.all([surfaceTail, runtimeTraceTail]).catch((error) => {
      rememberShutdownError(error);
    });
    let driverClean = true;
    await driver.close().catch((error) => {
      driverClean = false;
      rememberShutdownError(error);
      emit({ type: "driver_close_failed", code: safeErrorCode(error) });
    });
    await Promise.all([surfaceTail, runtimeTraceTail]).catch((error) => {
      rememberShutdownError(error);
    });
    let evidenceClean = true;
    await evidence.recordLifecycle(runId, "stopped", {
      graceful: runtimeCode === 0,
      driverClean,
      observationFlushTimedOut:
        beforeStopFlush.timedOut || afterStopFlush.timedOut,
      deleteRequested: deleteJourney,
      quarantinedSurfaces: metrics.quarantinedSurfaces,
    }).catch((error) => {
      evidenceClean = false;
      rememberShutdownError(error);
    });
    await evidence.close().catch((error) => {
      evidenceClean = false;
      rememberShutdownError(error);
    });
    let journeyDeleted = false;
    if (deleteJourney) {
      await removeLiveExplorationJourney(
        repositoryRoot,
        channel,
        journeyId,
      ).then(() => {
        journeyDeleted = true;
      }).catch((error) => {
        rememberShutdownError(error);
        emit({ type: "journey_delete_failed", code: safeErrorCode(error) });
      });
    }
    emit({
      type: "stopped",
      channel,
      journey: journeyId,
      runtimeClean: runtimeCode === 0,
      driverClean,
      observationFlushTimedOut:
        beforeStopFlush.timedOut || afterStopFlush.timedOut,
      evidenceClean,
      journeyDeleted,
      journeyPreserved: !journeyDeleted,
      explicitStop: stopped,
      metrics: metricsSnapshot(metrics),
      runtime: runtime.snapshot(),
    });
    if (runtimeCode !== 0 || shutdownError) process.exitCode = 2;
  }

  async function executeCommand(
    command: LiveExplorationCommand,
    sequence: number,
  ): Promise<"continue" | "stop"> {
    if (command.type === "status") {
      await surfaceTail;
      emit({
        type: "status",
        commandSequence: sequence,
        channel,
        journey: journeyId,
        metrics: metricsSnapshot(metrics),
        runtime: runtime.snapshot(),
        knownSurfaces: aliases.size,
        activeTurn: attribution.current().turn,
        runMode,
        coverage: liveExplorationCoverageSnapshot(metrics.coverage),
      });
      return "continue";
    }
    if (command.type === "settle") {
      const fromTurn = requireActiveTurn();
      boundarySequence += 1;
      const flush = await closeAttributionWindow();
      await commitExplorerEvidence(evidence.recordBoundary({
        runId,
        boundary: boundarySequence,
        kind: "settle",
        fromTurn,
        toTurn: null,
        observationFlushTimedOut: flush.timedOut,
      }));
      metrics.boundaries += 1;
      emit({
        type: "turn_settled",
        commandSequence: sequence,
        turn: fromTurn,
        observationFlushTimedOut: flush.timedOut,
      });
      return "continue";
    }
    if (command.type === "mark") {
      requireIdleTurn();
      await recordCoverage("operator", "mark", command.markers);
      emit({
        type: "coverage_recorded",
        commandSequence: sequence,
        runMode,
        coverage: liveExplorationCoverageSnapshot(metrics.coverage),
      });
      return "continue";
    }
    if (command.type === "assess") {
      requireIdleTurn();
      await surfaceTail;
      const coverage = liveExplorationCoverageSnapshot(metrics.coverage);
      assertLiveExplorationAssessmentAllowed(
        runMode,
        command.completion,
        coverage.markers,
      );
      const assessment = metrics.assessments.length + 1;
      const value: LiveExplorationAssessment = {
        scores: { ...command.scores },
        completion: command.completion,
        defects: [...command.defects],
      };
      await commitExplorerEvidence(evidence.recordAssessment({
        runId,
        assessment,
        runMode,
        coverage: coverage.markers,
        ...value,
      }));
      metrics.assessments.push(value);
      emit({
        type: "assessment_recorded",
        commandSequence: sequence,
        assessment,
        runMode,
        coverage,
      });
      return "continue";
    }
    if (command.type === "wait") {
      // Scripted live exploration must be able to wait for a slow real model
      // without closing attribution first. Closing before the final bubble
      // made late responses look like background output and allowed the next
      // user turn to race an unfinished Harvy turn.
      const activeTurn = attribution.current().turn;
      await delay(command.ms);
      await surfaceTail;
      if (
        activeTurn === null &&
        command.ms >= LIVE_EXPLORATION_PAUSE_THRESHOLD_MS
      ) {
        await recordCoverage("derived", "wait-threshold", ["pause"]);
      }
      emit({
        type: "wait_completed",
        commandSequence: sequence,
        waitedMs: command.ms,
        activeTurn,
        pauseThresholdMet:
          activeTurn === null &&
          command.ms >= LIVE_EXPLORATION_PAUSE_THRESHOLD_MS,
      });
      return "continue";
    }
    if (command.type === "restart") {
      requireIdleTurn();
      await commitExplorerEvidence(
        evidence.recordLifecycle(runId, "restart_requested"),
      );
      await runtime.restart();
      await commitExplorerEvidence(
        evidence.recordLifecycle(runId, "restarted"),
      );
      await recordCoverage("derived", "restart", ["restart"]);
      emit({ type: "restart_completed", commandSequence: sequence });
      return "continue";
    }
    if (command.type === "stop") {
      requireIdleTurn();
      return "stop";
    }
    const interrupt = command.type === "interrupt";
    if (interrupt) {
      requireActiveTurn();
      boundarySequence += 1;
    } else {
      requireIdleTurn();
    }
    await executeExplorerTransportCommand({
      command,
      commandSequence: sequence,
      runId,
      driver,
      evidence,
      attribution,
      turns: metrics.turns,
      ...(interrupt ? { boundarySequence } : {}),
      onSent: (record) => emitSent(
        record.commandSequence,
        record.turn,
        record.kind,
        record.messageCount,
        record.partial,
      ),
    });
    if (interrupt) metrics.boundaries += 1;
    if (command.type === "burst") {
      await recordCoverage("derived", "burst", ["multi-bubble"]);
    }
    return "continue";
  }

  async function closeAttributionWindow(): Promise<{ timedOut: boolean }> {
    return await closeExplorerAttributionBoundary({
      attribution,
      flushObservation: () => driver.flushObservation(),
      drainObservation: async () => {
        await Promise.all([surfaceTail, runtimeTraceTail]);
      },
    });
  }

  function requireActiveTurn(): number {
    const turn = attribution.current().turn;
    if (turn === null) {
      throw blocked("LIVE_EXPLORATION_ACTIVE_TURN_REQUIRED");
    }
    return turn;
  }

  function requireIdleTurn(): void {
    if (attribution.current().turn !== null) {
      throw blocked("LIVE_EXPLORATION_TURN_ACTIVE_SETTLE_OR_INTERRUPT_REQUIRED");
    }
  }

  async function recordCoverage(
    source: LiveExplorationCoverageSource,
    trigger: LiveExplorationCoverageTrigger,
    markers: readonly LiveExplorationCoverageMarker[],
  ): Promise<void> {
    const additions = markers.filter((marker) => !metrics.coverage.has(marker));
    if (additions.length === 0) return;
    coverageSequence += 1;
    await commitExplorerEvidence(evidence.recordCoverage({
      runId,
      sequence: coverageSequence,
      runMode,
      source,
      trigger,
      markers: additions,
    }));
    for (const marker of additions) metrics.coverage.add(marker);
  }
}

/**
 * Fallback non-interaktif untuk host Windows yang tidak dapat mempertahankan
 * stdin PTY. Nilai dihapus sebelum runtime Harvy dibuat, tidak diteruskan ke
 * child process, dan tidak pernah masuk evidence/transcript.
 */
export function takeScriptedCommands(env: NodeJS.ProcessEnv): string | null {
  const raw = env[SCRIPTED_COMMANDS_ENV];
  delete env[SCRIPTED_COMMANDS_ENV];
  if (raw === undefined) return null;
  if (
    Buffer.byteLength(raw, "utf8") > MAX_SCRIPTED_COMMAND_BYTES ||
    raw.includes("\0")
  ) {
    throw blocked("LIVE_EXPLORATION_SCRIPTED_COMMANDS_INVALID");
  }
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length < 1 || lines.length > MAX_SCRIPTED_COMMANDS) {
    throw blocked("LIVE_EXPLORATION_SCRIPTED_COMMANDS_INVALID");
  }
  // Parser authority tetap satu: setiap baris menjalani kontrak JSON tertutup
  // yang sama ketika loop membacanya.
  return `${lines.join("\n")}\n`;
}

async function startTelegram(
  repositoryRoot: string,
  journeyRoot: string,
  entry: string,
  aliases: LiveSurfaceAliasLedger,
  onSurface: (surface: ExplorerSurfaceEvent) => void,
  onRuntimeTrace: (
    event: Extract<RuntimeSupervisorEvent, { type: "acceptance-trace" }>,
  ) => void,
): Promise<{ runtime: RuntimeHandle; driver: ExplorerDriver }> {
  const credential = await loadTelegramLiveAcceptanceCredential(
    liveAcceptancePaths(repositoryRoot),
  );
  if (!credential) throw blocked("LIVE_EXPLORATION_TELEGRAM_NOT_PAIRED");
  const botIdentity = await new Bot(credential.botToken).api.getMe().catch(() => {
    throw blocked("LIVE_EXPLORATION_TELEGRAM_BOT_REJECTED");
  });
  if (!botIdentity.is_bot || !botIdentity.username) {
    throw blocked("LIVE_EXPLORATION_TELEGRAM_BOT_INVALID");
  }
  const runtime = await startRuntime(
    entry,
    journeyRoot,
    isolatedRuntimeEnvironment(process.env, {
      telegramBotToken: credential.botToken,
    }),
    "telegram",
    onRuntimeTrace,
  );

  const logger = new Logger();
  logger.handler = () => undefined;
  const client = new TelegramClient(
    new StringSession(credential.session),
    credential.apiId,
    credential.apiHash,
    {
      baseLogger: logger,
      connectionRetries: 3,
      reconnectRetries: 3,
      autoReconnect: true,
    },
  );
  try {
    await client.connect();
    if (!await client.checkAuthorization()) {
      throw blocked("LIVE_EXPLORATION_TELEGRAM_SESSION_EXPIRED");
    }
    const tester = await client.getMe();
    if (tester.bot === true) {
      throw blocked("LIVE_EXPLORATION_TELEGRAM_TESTER_MUST_BE_USER");
    }
    const driver = await createTelegramDriver(
      client,
      `@${botIdentity.username}`,
      aliases,
      onSurface,
    );
    return { runtime, driver };
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    await runtime.stop().catch(() => 1);
    throw error;
  }
}

async function createTelegramDriver(
  client: TelegramClient,
  botPeer: string,
  aliases: LiveSurfaceAliasLedger,
  onSurface: (surface: ExplorerSurfaceEvent) => void,
): Promise<ExplorerDriver> {
  const known = new Map<number, { digest: string; pinned: boolean }>();
  const messages = new Map<number, Api.Message>();
  const tracked = new Set<number>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  for (const message of await telegramIncomingMessages(client, botPeer)) {
    known.set(telegramMessageId(message), telegramSnapshot(message));
    messages.set(telegramMessageId(message), message);
  }

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const current = await telegramIncomingMessages(client, botPeer);
      const currentIds = new Set(current.map(telegramMessageId));
      const oldestCurrent = current.reduce(
        (oldest, message) => Math.min(oldest, telegramMessageId(message)),
        Number.POSITIVE_INFINITY,
      );
      for (const message of [...current].sort((left, right) =>
        telegramMessageId(left) - telegramMessageId(right)
      )) {
        const id = telegramMessageId(message);
        const snapshot = telegramSnapshot(message);
        const before = known.get(id);
        known.set(id, snapshot);
        messages.set(id, message);
        if (!before) {
          tracked.add(id);
          onSurface(telegramSurface("create", message));
          if (snapshot.pinned) onSurface(telegramSurface("pin", message));
          continue;
        }
        if (before.digest !== snapshot.digest) {
          onSurface(telegramSurface("edit", message));
        }
        if (before.pinned !== snapshot.pinned) {
          onSurface(telegramSurface(snapshot.pinned ? "pin" : "unpin", message));
        }
      }
      for (const id of [...tracked]) {
        if (
          currentIds.has(id) || !Number.isFinite(oldestCurrent) ||
          id < oldestCurrent
        ) continue;
        tracked.delete(id);
        const previous = messages.get(id);
        if (previous) onSurface(telegramSurface("delete", previous));
        known.delete(id);
        messages.delete(id);
      }
    } catch (error) {
      emit({ type: "transport_warning", code: safeErrorCode(error) });
    } finally {
      polling = false;
      if (!stopped) timer = setTimeout(() => void poll(), TELEGRAM_POLL_MS);
    }
  };
  timer = setTimeout(() => void poll(), TELEGRAM_POLL_MS);

  return {
    async send(text) {
      await client.sendMessage(botPeer, { message: text });
    },
    async sendImage(image, caption) {
      await client.sendFile(botPeer, {
        file: new CustomFile(
          "harvy-exploration-visual.png",
          image.byteLength,
          "",
          image,
        ),
        caption,
        forceDocument: false,
      });
    },
    async reply(surface, text) {
      const technical = aliases.technicalIdFor(surface);
      const id = telegramTechnicalId(technical);
      const anchor = messages.get(id);
      if (!anchor) throw blocked("LIVE_EXPLORATION_SURFACE_NOT_REPLYABLE");
      await client.sendMessage(botPeer, { message: text, replyTo: anchor });
    },
    async click(surface, label) {
      const technical = aliases.technicalIdFor(surface);
      const id = telegramTechnicalId(technical);
      const anchor = messages.get(id);
      if (!anchor) throw blocked("LIVE_EXPLORATION_SURFACE_NOT_CLICKABLE");
      const button = anchor.buttons?.flat().find((candidate) =>
        candidate.text === label
      );
      if (!button) throw blocked("LIVE_EXPLORATION_BUTTON_NOT_FOUND");
      await button.click({});
    },
    async flushObservation() {
      await delay(TELEGRAM_POLL_MS * 2);
      await poll();
      while (polling) await delay(25);
      return { timedOut: false };
    },
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      while (polling) await delay(25);
      await client.disconnect().catch(() => undefined);
    },
  };
}

async function startWhatsApp(
  repositoryRoot: string,
  journeyRoot: string,
  entry: string,
  aliases: LiveSurfaceAliasLedger,
  onSurface: (surface: ExplorerSurfaceEvent) => void,
  onRuntimeTrace: (
    event: Extract<RuntimeSupervisorEvent, { type: "acceptance-trace" }>,
  ) => void,
  messageScope: string,
  onQuarantinedSurface: (
    operation: ExplorerSurfaceEvent["operation"],
  ) => void,
): Promise<{ runtime: RuntimeHandle; driver: ExplorerDriver }> {
  const paths = liveAcceptancePaths(repositoryRoot);
  const telegram = await loadTelegramBotCredential(paths);
  if (!telegram) {
    throw blocked("LIVE_EXPLORATION_TELEGRAM_TEST_BOT_NOT_PAIRED");
  }
  await assertDirectory(paths.whatsappHarvyAuth, "HARVY");
  await assertDirectory(paths.whatsappTesterAuth, "TESTER");
  const harvyAuth = await useMultiFileAuthState(paths.whatsappHarvyAuth);
  const testerAuth = await useMultiFileAuthState(paths.whatsappTesterAuth);
  if (!isWhatsAppCredentialReady(harvyAuth.state.creds)) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_HARVY_NOT_PAIRED");
  }
  if (!isWhatsAppCredentialReady(testerAuth.state.creds)) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_TESTER_NOT_PAIRED");
  }
  const harvyIdentities = whatsAppCredentialJids(harvyAuth.state.creds);
  const testerIdentities = whatsAppCredentialJids(testerAuth.state.creds);
  if (harvyIdentities.some((jid) => testerIdentities.includes(jid))) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_IDENTITIES_MUST_DIFFER");
  }
  const harvyPn = harvyIdentities.find((jid) =>
    jid.endsWith("@s.whatsapp.net")
  );
  if (!harvyPn) throw blocked("LIVE_EXPLORATION_WHATSAPP_HARVY_IDENTITY_MISSING");
  const destination = harvyIdentities.find((jid) => jid.endsWith("@lid")) ??
    harvyIdentities[0];
  if (!destination) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_HARVY_IDENTITY_MISSING");
  }
  const logger = silentBaileysLogger();
  const socket = makeWASocket({
    logger,
    auth: {
      creds: testerAuth.state.creds,
      keys: makeCacheableSignalKeyStore(testerAuth.state.keys, logger),
    },
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
  });
  let saveTail = Promise.resolve();
  socket.ev.on("creds.update", () => {
    saveTail = saveTail.then(testerAuth.saveCreds);
  });
  const driver = createWhatsAppDriver(
    socket,
    destination,
    harvyIdentities,
    aliases,
    onSurface,
    () => saveTail,
    messageScope,
    onQuarantinedSurface,
    (status) => {
      emit({
        type: "observer_channel_status",
        channel: "whatsapp",
        status: status.status,
        reason: status.reason,
        contentPersistence: "none",
      });
    },
  );
  return await startObservedWhatsAppRuntime({
    driver,
    waitForObserverReady: async () => {
      await waitForWhatsAppOpen(socket, RUNTIME_READY_TIMEOUT_MS);
      const self = jidNormalizedUser(socket.user?.id ?? "");
      if (!self || harvyIdentities.includes(self)) {
        throw blocked("LIVE_EXPLORATION_WHATSAPP_TESTER_MUST_DIFFER");
      }
    },
    startRuntime: () => startRuntime(
      entry,
      journeyRoot,
      isolatedRuntimeEnvironment(process.env, {
        telegramBotToken: telegram.botToken,
        whatsapp: {
          authRoot: paths.whatsappAuthRoot,
          accountAlias: "harvy",
          phoneNumber: harvyPn.slice(0, harvyPn.indexOf("@")),
          messageScope,
        },
      }),
      "whatsapp",
      onRuntimeTrace,
    ),
  });
}

function createWhatsAppDriver(
  socket: WASocket,
  destination: string,
  harvyIdentities: readonly string[],
  aliases: LiveSurfaceAliasLedger,
  onSurface: (surface: ExplorerSurfaceEvent) => void,
  saveTail: () => Promise<void>,
  messageScope: string,
  onQuarantinedSurface: (
    operation: ExplorerSurfaceEvent["operation"],
  ) => void,
  onConnectionStatus: (status: WhatsAppObserverConnectionStatus) => void,
): ExplorerDriver {
  const replyable = new Map<string, WAMessage>();
  let lastObservedAt = 0;
  const connection = new WhatsAppObserverConnectionGuard();
  const onConnection = (update: WhatsAppConnectionUpdate): void => {
    const status = connection.observe(update);
    if (status) onConnectionStatus(status);
  };
  socket.ev.on("connection.update", onConnection);
  const onMessages = (event: { messages: WAMessage[]; type: string }): void => {
    if (event.type !== "notify") return;
    for (const raw of event.messages) {
      if (raw.key.fromMe) continue;
      const parsed = parseWhatsAppSurfaceEvent(raw);
      if (parsed.operation === "other" || !parsed.surfaceMessageId) continue;
      if (!isLiveExplorationWhatsAppMessageId(
        parsed.surfaceMessageId,
        messageScope,
        "harvy",
      )) {
        // Identity aliases can legitimately shift between PN and LID, but an
        // unscoped surface must never be attributed to this run. Report only
        // traffic that otherwise looks like it came from the paired Harvy
        // account so unrelated chats remain invisible to the runner.
        if (messageComesFromHarvy(raw, harvyIdentities)) {
          onQuarantinedSurface(parsed.operation);
        }
        continue;
      }
      // The random per-run message scope is the causal authority here. It is
      // stronger than a cached PN/LID alias and remains stable across the
      // addressing-mode changes that previously hid real Harvy replies.
      lastObservedAt = Date.now();
      const technicalId = `wa:${parsed.surfaceMessageId}`;
      if (parsed.operation === "create") replyable.set(technicalId, raw);
      onSurface({
        operation: parsed.operation,
        technicalId,
        text: parsed.text,
        buttons: [],
        hasDocument: parsed.hasDocument,
      });
    }
  };
  socket.ev.on("messages.upsert", onMessages);

  return {
    async send(text) {
      connection.assertOpen();
      try {
        await sendWhatsApp(socket, destination, text, messageScope);
      } catch (error) {
        const reason = whatsAppDisconnectReason(error);
        if (reason !== null) {
          onConnection({
            connection: "close",
            lastDisconnect: { error },
          });
          connection.assertOpen();
        }
        throw error;
      }
    },
    async sendImage(image, caption) {
      connection.assertOpen();
      try {
        await sendWhatsAppImage(
          socket,
          destination,
          image,
          caption,
          messageScope,
        );
      } catch (error) {
        const reason = whatsAppDisconnectReason(error);
        if (reason !== null) {
          onConnection({
            connection: "close",
            lastDisconnect: { error },
          });
          connection.assertOpen();
        }
        throw error;
      }
    },
    async reply(surface, text) {
      connection.assertOpen();
      const technical = aliases.technicalIdFor(surface);
      const anchor = technical ? replyable.get(technical) : undefined;
      if (!anchor) throw blocked("LIVE_EXPLORATION_SURFACE_NOT_REPLYABLE");
      try {
        await sendWhatsApp(socket, destination, text, messageScope, anchor);
      } catch (error) {
        const reason = whatsAppDisconnectReason(error);
        if (reason !== null) {
          onConnection({
            connection: "close",
            lastDisconnect: { error },
          });
          connection.assertOpen();
        }
        throw error;
      }
    },
    async click() {
      throw blocked("LIVE_EXPLORATION_WHATSAPP_CLICK_UNAVAILABLE");
    },
    async flushObservation() {
      connection.assertOpen();
      const startedAt = Date.now();
      lastObservedAt = Math.max(lastObservedAt, startedAt);
      while (Date.now() - startedAt < WHATSAPP_OBSERVATION_FLUSH_MAX_MS) {
        connection.assertOpen();
        const quietFor = Date.now() - lastObservedAt;
        if (quietFor >= WHATSAPP_OBSERVATION_QUIET_MS) {
          return { timedOut: false };
        }
        await delay(Math.min(50, WHATSAPP_OBSERVATION_QUIET_MS - quietFor));
      }
      return { timedOut: true };
    },
    async close() {
      socket.ev.off("connection.update", onConnection);
      socket.ev.off("messages.upsert", onMessages);
      await socket.end(undefined).catch(() => undefined);
      await saveTail();
    },
  };
}

async function startRuntime(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  channel: LiveExplorationChannel,
  onRuntimeTrace: (
    event: Extract<RuntimeSupervisorEvent, { type: "acceptance-trace" }>,
  ) => void,
): Promise<RuntimeHandle> {
  const controller = new AbortController();
  const fault = new AbortController();
  let markInitialReady!: () => void;
  let failInitialReady!: (error: Error) => void;
  let markRestartReady!: () => void;
  let failRestartReady!: (error: Error) => void;
  const initialReady = new Promise<void>((resolveReady, rejectReady) => {
    markInitialReady = resolveReady;
    failInitialReady = rejectReady;
  });
  const restartReady = new Promise<void>((resolveReady, rejectReady) => {
    markRestartReady = resolveReady;
    failRestartReady = rejectReady;
  });
  const readyAttempts = new Set<number>();
  let restarts = 0;
  let faultInjected = 0;
  let crashLoopOpened = false;
  let shutdownTimedOut = false;
  let restartUsed = false;
  let stopPromise: Promise<number> | null = null;

  const runtime = superviseRuntime({
    entry,
    cwd,
    env: {
      ...env,
      HARVY_LIVE_ACCEPTANCE_TRACE: "content-free-v1",
    },
    signal: controller.signal,
    acceptanceFaultSignal: fault.signal,
    restartBaseMs: 500,
    restartMaxMs: 2_000,
    stableResetMs: 60_000,
    crashWindowMs: 60_000,
    maxCrashes: 3,
    shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
    onEvent: (event) => {
      if (runtimeReadyEvent(event, channel)) {
        readyAttempts.add(event.attempt);
        markInitialReady();
        if (event.attempt >= 2) markRestartReady();
        emit({
          type: "runtime_ready",
          channel,
          attempt: event.attempt,
        });
      } else if (event.type === "child-restart-scheduled") {
        restarts += 1;
        emit({
          type: "runtime_restart_scheduled",
          attempt: event.attempt,
          delayMs: event.delayMs,
        });
      } else if (event.type === "acceptance-fault-injected") {
        faultInjected += 1;
        emit({ type: "runtime_fault_injected", attempt: event.attempt });
      } else if (event.type === "crash-loop-open") {
        crashLoopOpened = true;
        emit({ type: "runtime_crash_loop_open" });
      } else if (event.type === "shutdown-timeout") {
        shutdownTimedOut = true;
        emit({ type: "runtime_shutdown_timeout" });
      } else if (
        event.type === "channel-status" && event.channel === "whatsapp" &&
        event.accountId === "harvy"
      ) {
        emit({
          type: "runtime_channel_status",
          channel,
          attempt: event.attempt,
          status: event.status,
          reason: event.reason,
          contentPersistence: "none",
        });
        if (event.status === "needs-operator") {
          const error = blocked(
            "LIVE_EXPLORATION_WHATSAPP_HARVY_NEEDS_OPERATOR",
          );
          failInitialReady(error);
          if (restartUsed && event.attempt >= 2) failRestartReady(error);
        }
      } else if (
        event.type === "acceptance-trace" && event.channel === "whatsapp" &&
        event.accountId === "harvy"
      ) {
        onRuntimeTrace(event);
      }
    },
  });
  try {
    await waitForReady(
      initialReady,
      runtime,
      "LIVE_EXPLORATION_RUNTIME_READY_TIMEOUT",
    );
  } catch (error) {
    // startRuntime belum dapat mengembalikan handle kepada caller. Karena itu
    // kegagalan startup wajib menghentikan supervisor di sini; kalau tidak,
    // child tetap hidup dan CLI menggantung setelah melaporkan timeout.
    controller.abort();
    await runtime.catch(() => 1);
    throw error;
  }

  return {
    async restart() {
      if (restartUsed) throw blocked("LIVE_EXPLORATION_RESTART_ALREADY_USED");
      restartUsed = true;
      fault.abort();
      await waitForReady(
        restartReady,
        runtime,
        "LIVE_EXPLORATION_RUNTIME_RESTART_TIMEOUT",
      );
    },
    stop() {
      if (!stopPromise) {
        controller.abort();
        stopPromise = runtime.catch(() => 1);
      }
      return stopPromise;
    },
    snapshot() {
      return {
        readyAttempts: [...readyAttempts].sort((left, right) => left - right),
        restarts,
        faultInjected,
        crashLoopOpened,
        shutdownTimedOut,
      };
    },
  };
}

function runtimeReadyEvent(
  event: RuntimeSupervisorEvent,
  channel: LiveExplorationChannel,
): event is Extract<RuntimeSupervisorEvent, { type: "child-ready" | "channel-ready" }> {
  return channel === "telegram"
    ? event.type === "child-ready"
    : event.type === "channel-ready" && event.channel === "whatsapp" &&
      event.accountId === "harvy";
}

async function waitForReady(
  ready: Promise<void>,
  runtime: Promise<number>,
  timeoutCode: string,
): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      ready,
      runtime.then(() => {
        throw blocked("LIVE_EXPLORATION_RUNTIME_STOPPED_BEFORE_READY");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(blocked(timeoutCode)),
          RUNTIME_READY_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function telegramIncomingMessages(
  client: TelegramClient,
  botPeer: string,
): Promise<Api.Message[]> {
  const values = await client.getMessages(botPeer, { limit: 50 });
  return values.filter((message): message is Api.Message =>
    message instanceof Api.Message && message.out !== true
  );
}

function telegramMessageId(message: Api.Message): number {
  const value = Number(message.id);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw blocked("LIVE_EXPLORATION_TELEGRAM_MESSAGE_ID_INVALID");
  }
  return value;
}

function telegramSnapshot(
  message: Api.Message,
): { digest: string; pinned: boolean } {
  const buttons = telegramButtons(message).join("\0");
  return {
    digest: createHash("sha256").update([
      message.message,
      buttons,
      message.media?.className ?? "none",
    ].join("\0"), "utf8").digest("hex"),
    pinned: message.pinned === true,
  };
}

function telegramSurface(
  operation: ExplorerSurfaceEvent["operation"],
  message: Api.Message,
): ExplorerSurfaceEvent {
  return {
    operation,
    technicalId: `tg:${telegramMessageId(message)}`,
    text: operation === "delete" || operation === "pin" || operation === "unpin"
      ? ""
      : message.message,
    buttons: operation === "create" || operation === "edit"
      ? telegramButtons(message)
      : [],
    hasDocument: Boolean(message.media),
  };
}

function telegramButtons(message: Api.Message): string[] {
  return message.buttons?.flat().map((button) => button.text) ?? [];
}

function telegramTechnicalId(value: string | null): number {
  if (!value || !/^tg:[1-9]\d*$/u.test(value)) {
    throw blocked("LIVE_EXPLORATION_SURFACE_CHANNEL_MISMATCH");
  }
  const id = Number(value.slice(3));
  if (!Number.isSafeInteger(id)) {
    throw blocked("LIVE_EXPLORATION_SURFACE_CHANNEL_MISMATCH");
  }
  return id;
}

async function sendWhatsApp(
  socket: WASocket,
  destination: string,
  text: string,
  messageScope: string,
  quoted?: WAMessage,
): Promise<void> {
  const messageId = liveExplorationWhatsAppMessageId(
    messageScope,
    "tester",
  );
  const sent = await socket.sendMessage(
    destination,
    { text },
    quoted ? { messageId, quoted } : { messageId },
  );
  if (sent?.key.id !== messageId) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_MESSAGE_ID_NOT_PRESERVED");
  }
}

async function sendWhatsAppImage(
  socket: WASocket,
  destination: string,
  image: Buffer,
  caption: string,
  messageScope: string,
): Promise<void> {
  const messageId = liveExplorationWhatsAppMessageId(
    messageScope,
    "tester",
  );
  const sent = await socket.sendMessage(
    destination,
    { image, caption, mimetype: "image/png" },
    { messageId },
  );
  if (sent?.key.id !== messageId) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_MESSAGE_ID_NOT_PRESERVED");
  }
}

function waitForWhatsAppOpen(
  socket: WASocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(blocked("LIVE_EXPLORATION_WHATSAPP_CONNECTION_TIMEOUT"));
    }, timeoutMs);
    const handler = (update: {
      connection?: string;
      lastDisconnect?: { error?: unknown } | null;
    }) => {
      if (update.connection === "open") {
        cleanup();
        resolvePromise();
      } else if (update.connection === "close") {
        cleanup();
        const reason = whatsAppDisconnectReason(update.lastDisconnect?.error);
        reject(blocked(
          reason === null
            ? "LIVE_EXPLORATION_WHATSAPP_CONNECTION_CLOSED"
            : `LIVE_EXPLORATION_WHATSAPP_CONNECTION_CLOSED_${reason}`,
        ));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.ev.off("connection.update", handler);
    };
    socket.ev.on("connection.update", handler);
  });
}

function whatsAppDisconnectReason(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  const value = candidate.output?.statusCode ?? candidate.statusCode;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function messageComesFromHarvy(
  message: WAMessage,
  harvyIdentities: readonly string[],
): boolean {
  const key = message.key as typeof message.key & {
    remoteJidAlt?: string | null;
  };
  return [key.remoteJid, key.remoteJidAlt].some((value) =>
    Boolean(value) && harvyIdentities.includes(jidNormalizedUser(value ?? ""))
  );
}

async function assertDirectory(path: string, role: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked(`LIVE_EXPLORATION_WHATSAPP_${role}_AUTH_INVALID`);
  }
}

function silentBaileysLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function metricsSnapshot(metrics: ExplorationMetrics) {
  const latencies = metrics.turns.map((turn) => turn.firstResponseMs).filter(
    (value): value is number => value !== null,
  ).sort((left, right) => left - right);
  return {
    turns: metrics.turns.length,
    turnsWithResponse: latencies.length,
    surfaceEvents: metrics.surfaceEvents,
    operations: { ...metrics.operations },
    firstResponseMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.at(-1) ?? null,
    },
    assessments: assessmentSnapshot(metrics.assessments),
    quarantinedSurfaces: metrics.quarantinedSurfaces,
    boundaries: metrics.boundaries,
    coverage: liveExplorationCoverageSnapshot(metrics.coverage),
  };
}

function assessmentSnapshot(
  assessments: readonly LiveExplorationAssessment[],
) {
  const scoreKeys = [
    "usefulness",
    "naturalness",
    "initiative",
    "nonRepetition",
    "uiClarity",
    "contextCoherence",
    "correctionHandling",
  ] as const;
  const averageScores = Object.fromEntries(scoreKeys.map((key) => {
    if (assessments.length === 0) return [key, null];
    const total = assessments.reduce((sum, item) => sum + item.scores[key], 0);
    return [key, Math.round((total / assessments.length) * 100) / 100];
  }));
  const completion = { completed: 0, partial: 0, failed: 0 };
  const defects: Record<string, number> = {};
  for (const assessment of assessments) {
    completion[assessment.completion] += 1;
    for (const defect of assessment.defects) {
      defects[defect] = (defects[defect] ?? 0) + 1;
    }
  }
  return {
    count: assessments.length,
    averageScores,
    completion,
    defects,
  };
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  return values[Math.ceil(values.length * ratio) - 1] ?? null;
}

function emitSent(
  commandSequence: number,
  turn: number,
  kind: "send" | "image" | "reply" | "click" | "burst" | "interrupt",
  messageCount: number,
  partial = false,
): void {
  emit({
    type: "sent",
    commandSequence,
    turn,
    kind,
    messageCount,
    ...(partial ? { partial: true } : {}),
  });
}

function emit(record: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify({
    protocol: "harvy-live-exploration/1",
    at: new Date().toISOString(),
    ...record,
  })}\n`);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,160}$/u.test(error.message)) {
    return error.message;
  }
  if (
    error instanceof Error && "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    /^[A-Z0-9_]{1,80}$/u.test((error as NodeJS.ErrnoException).code ?? "")
  ) {
    return (error as NodeJS.ErrnoException).code!;
  }
  return "LIVE_EXPLORATION_FAILED";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined &&
    import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  await main().catch((error: unknown) => {
    emit({
      type: "blocked_or_failed",
      code: safeErrorCode(error),
      outputPrivacy: "no_account_identifier_token_session_auth_path_or_persisted_transcript",
    });
    process.exitCode = 2;
  });
}
