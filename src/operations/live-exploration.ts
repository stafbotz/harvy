import { createHash, randomBytes } from "node:crypto";
import { constants as FS_CONSTANTS, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const LIVE_EXPLORATION_CONFIRMATION =
  "RUN_NONCRITICAL_LIVE_EXPLORATION";
export const LIVE_EXPLORATION_ACCOUNT = "DEDICATED_TEST_ACCOUNT";
export const LIVE_EXPLORATION_DELETE_CONFIRMATION =
  "DELETE_EXPLORATION_JOURNEY";
const WHATSAPP_SCOPE_PREFIX = "HARVYEXP";
const WHATSAPP_SCOPE_PATTERN = /^HARVYEXP[A-F0-9]{12}$/u;

const EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
const EVIDENCE_VERSION = 3;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARACTERS = 3_500;
const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export const LIVE_EXPLORATION_PAUSE_THRESHOLD_MS = 30_000;
const RUNTIME_TRACE_STAGES = new Set([
  "private-upsert-notify",
  "private-upsert-append",
  "private-candidate",
  "private-causal-fence-rejected",
  "private-normalized",
  "private-handler-returned",
  "private-pipeline-failed",
  "private-delivery-attempted",
  "private-delivery-succeeded",
  "private-delivery-failed",
] as const);

export type LiveExplorationChannel = "telegram" | "whatsapp";
export type LiveExplorationObservationPhase = "startup" | "idle" | "turn";
export type LiveExplorationWhatsAppRole = "harvy" | "tester";
export type LiveExplorationRunMode = "full" | "focused";
export type LiveExplorationVisualColor = "red" | "green" | "blue";

export const LIVE_EXPLORATION_COVERAGE_MARKERS = [
  "real-task",
  "correction",
  "topic-shift",
  "multi-bubble",
  "pause",
  "re-entry",
  "context-return",
  "task-completed",
  "restart",
] as const;

export const LIVE_EXPLORATION_MANUAL_COVERAGE_MARKERS = [
  "real-task",
  "correction",
  "topic-shift",
  "context-return",
  "task-completed",
] as const;

export const LIVE_EXPLORATION_FULL_REQUIRED_MARKERS = [
  "real-task",
  "correction",
  "topic-shift",
  "multi-bubble",
  "pause",
  "re-entry",
  "context-return",
  "task-completed",
] as const;

export type LiveExplorationCoverageMarker =
  typeof LIVE_EXPLORATION_COVERAGE_MARKERS[number];
export type LiveExplorationManualCoverageMarker =
  typeof LIVE_EXPLORATION_MANUAL_COVERAGE_MARKERS[number];
export type LiveExplorationCoverageSource = "derived" | "operator";
export type LiveExplorationCoverageTrigger =
  | "burst"
  | "wait-threshold"
  | "resumed"
  | "restart"
  | "mark";

export const LIVE_EXPLORATION_DEFECT_TAGS = [
  "wrong-route",
  "stale-work",
  "false-memory-claim",
  "irrelevant-surface",
  "context-attribution",
  "generic-output",
  "incomplete-work",
  "bubble-topology",
  "reminder-delivery",
  "restart-recovery",
  "duplicate-delivery",
  "safety-overreach",
  "safety-underreach",
  "task-state",
  "other-observed",
] as const;

export type LiveExplorationDefectTag =
  typeof LIVE_EXPLORATION_DEFECT_TAGS[number];
export type LiveExplorationCompletion = "completed" | "partial" | "failed";

export interface LiveExplorationScores {
  usefulness: number;
  naturalness: number;
  initiative: number;
  nonRepetition: number;
  uiClarity: number;
  contextCoherence: number;
  correctionHandling: number;
}

export interface LiveExplorationAssessment {
  scores: LiveExplorationScores;
  completion: LiveExplorationCompletion;
  defects: LiveExplorationDefectTag[];
}

export type LiveExplorationCommand =
  | { type: "send"; text: string }
  | { type: "image"; color: LiveExplorationVisualColor }
  | { type: "reply"; surface: string; text: string }
  | { type: "click"; surface: string; label: string }
  | { type: "burst"; messages: string[]; gapMs: number }
  | { type: "interrupt"; text: string }
  | { type: "settle" }
  | { type: "wait"; ms: number }
  | { type: "restart" }
  | { type: "status" }
  | { type: "mark"; markers: LiveExplorationManualCoverageMarker[] }
  | ({ type: "assess" } & LiveExplorationAssessment)
  | {
      type: "stop";
      deleteJourney: boolean;
      confirmation: string | null;
    };

export interface LiveExplorationOptions {
  channel: LiveExplorationChannel;
  journeyId: string;
  runMode: LiveExplorationRunMode;
}

export interface LiveExplorationTurnEvidence {
  runId: string;
  turn: number;
  kind: "send" | "image" | "reply" | "burst" | "click" | "interrupt";
  texts: readonly string[];
  replySurface?: string;
}

export interface LiveExplorationSurfaceEvidence {
  runId: string;
  sequence: number;
  operation: "create" | "edit" | "delete" | "pin" | "unpin";
  surface: string;
  text: string;
  buttons: readonly string[];
  hasDocument: boolean;
  latencyMs: number | null;
  phase: LiveExplorationObservationPhase;
  turn: number | null;
}

export interface LiveExplorationAssessmentEvidence
  extends LiveExplorationAssessment {
  runId: string;
  assessment: number;
  runMode: LiveExplorationRunMode;
  coverage: readonly LiveExplorationCoverageMarker[];
}

export interface LiveExplorationCoverageEvidence {
  runId: string;
  sequence: number;
  runMode: LiveExplorationRunMode;
  source: LiveExplorationCoverageSource;
  trigger: LiveExplorationCoverageTrigger;
  markers: readonly LiveExplorationCoverageMarker[];
}

export interface LiveExplorationBoundaryEvidence {
  runId: string;
  boundary: number;
  kind: "settle" | "interrupt";
  fromTurn: number;
  toTurn: number | null;
  observationFlushTimedOut: boolean | null;
}

export interface LiveExplorationCoverageSnapshot {
  markers: LiveExplorationCoverageMarker[];
  missingForFullCompletion: LiveExplorationCoverageMarker[];
}

export interface LiveExplorationRuntimeTraceEvidence {
  runId: string;
  sequence: number;
  attempt: number;
  stage: string;
  phase: LiveExplorationObservationPhase;
  turn: number | null;
}

export class LiveSurfaceAliasLedger {
  private readonly aliases = new Map<string, string>();
  private readonly technicalIds = new Map<string, string>();
  private next = 1;

  aliasFor(technicalId: string): string {
    const existing = this.aliases.get(technicalId);
    if (existing) return existing;
    const alias = `surface-${this.next}`;
    this.next += 1;
    this.aliases.set(technicalId, alias);
    this.technicalIds.set(alias, technicalId);
    return alias;
  }

  technicalIdFor(alias: string): string | null {
    return this.technicalIds.get(surfaceAlias(alias)) ?? null;
  }

  get size(): number {
    return this.aliases.size;
  }
}

/**
 * Keeps response attribution explicit. A surface is never silently attached to
 * the last command forever: startup and idle output remain background output,
 * while a turn stays open only until the runner deliberately closes it.
 */
export class LiveTurnAttribution {
  private ready = false;
  private active: { turn: number; startedAt: number } | null = null;

  markReady(): void {
    this.ready = true;
  }

  start(turn: number, startedAt: number): void {
    if (
      !Number.isSafeInteger(turn) || turn < 1 ||
      !Number.isSafeInteger(startedAt) || startedAt < 0
    ) {
      throw blocked("LIVE_EXPLORATION_TURN_ATTRIBUTION_INVALID");
    }
    this.active = { turn, startedAt };
  }

  close(): void {
    this.active = null;
  }

  current(): {
    phase: LiveExplorationObservationPhase;
    turn: number | null;
  } {
    if (this.active) return { phase: "turn", turn: this.active.turn };
    return { phase: this.ready ? "idle" : "startup", turn: null };
  }

  observe(now: number): {
    phase: LiveExplorationObservationPhase;
    turn: number | null;
    latencyMs: number | null;
  } {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw blocked("LIVE_EXPLORATION_TURN_ATTRIBUTION_INVALID");
    }
    if (!this.active) return { ...this.current(), latencyMs: null };
    return {
      phase: "turn",
      turn: this.active.turn,
      latencyMs: Math.max(0, now - this.active.startedAt),
    };
  }
}

export function createLiveExplorationWhatsAppScope(): string {
  return `${WHATSAPP_SCOPE_PREFIX}${randomBytes(6).toString("hex").toUpperCase()}`;
}

export function liveExplorationWhatsAppMessageId(
  scope: string,
  role: LiveExplorationWhatsAppRole,
): string {
  const validated = liveExplorationWhatsAppScope(scope);
  const marker = role === "harvy" ? "H" : role === "tester" ? "T" : null;
  if (!marker) throw blocked("LIVE_EXPLORATION_WHATSAPP_ROLE_INVALID");
  return `${validated}${marker}${randomBytes(6).toString("hex").slice(0, 11).toUpperCase()}`;
}

export function isLiveExplorationWhatsAppMessageId(
  value: unknown,
  scope: string,
  role: LiveExplorationWhatsAppRole,
): boolean {
  const marker = role === "harvy" ? "H" : role === "tester" ? "T" : null;
  return typeof value === "string" && marker !== null &&
    value.length === 32 &&
    value.startsWith(`${liveExplorationWhatsAppScope(scope)}${marker}`) &&
    /^[A-F0-9]{11}$/u.test(value.slice(21));
}

export function liveExplorationWhatsAppScope(value: unknown): string {
  if (typeof value !== "string" || !WHATSAPP_SCOPE_PATTERN.test(value)) {
    throw blocked("LIVE_EXPLORATION_WHATSAPP_SCOPE_INVALID");
  }
  return value;
}

export class LiveExplorationEvidenceWriter {
  private tail: Promise<void> = Promise.resolve();
  private failed: unknown = null;

  constructor(
    private readonly file: string,
    private readonly channel: LiveExplorationChannel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordLifecycle(
    runId: string,
    event:
      | "started"
      | "startup_failed"
      | "ready"
      | "restart_requested"
      | "restarted"
      | "stopped",
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ): Promise<void> {
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "lifecycle",
      at: this.now().toISOString(),
      runId: runIdentifier(runId),
      channel: this.channel,
      event,
      details: safeDetails(details),
    });
  }

  recordTurn(value: LiveExplorationTurnEvidence): Promise<void> {
    if (!Number.isSafeInteger(value.turn) || value.turn < 1) {
      return Promise.reject(blocked("LIVE_EXPLORATION_TURN_INVALID"));
    }
    const texts = value.texts.map(messageText);
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "turn",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      turn: value.turn,
      kind: value.kind,
      messageCount: texts.length,
      messages: texts.map((text) => ({
        characters: Array.from(text).length,
        digest: textDigest(text),
      })),
      ...(value.replySurface
        ? { replySurface: surfaceAlias(value.replySurface) }
        : {}),
    });
  }

  recordSurface(value: LiveExplorationSurfaceEvidence): Promise<void> {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
      return Promise.reject(blocked("LIVE_EXPLORATION_SURFACE_SEQUENCE_INVALID"));
    }
    const text = value.text ? surfaceText(value.text) : "";
    const buttons = value.buttons.map(buttonLabel);
    const latencyMs = value.latencyMs;
    if (
      latencyMs !== null &&
      (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 86_400_000)
    ) {
      return Promise.reject(blocked("LIVE_EXPLORATION_LATENCY_INVALID"));
    }
    if (
      value.phase !== "startup" && value.phase !== "idle" &&
      value.phase !== "turn"
    ) {
      return Promise.reject(blocked("LIVE_EXPLORATION_SURFACE_PHASE_INVALID"));
    }
    if (
      (value.phase === "turn" &&
        (!Number.isSafeInteger(value.turn) || (value.turn ?? 0) < 1 ||
          latencyMs === null)) ||
      (value.phase !== "turn" &&
        (value.turn !== null || latencyMs !== null))
    ) {
      return Promise.reject(blocked("LIVE_EXPLORATION_SURFACE_TURN_INVALID"));
    }
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "surface",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      sequence: value.sequence,
      operation: value.operation,
      surface: surfaceAlias(value.surface),
      textCharacters: Array.from(text).length,
      textDigest: text ? textDigest(text) : null,
      buttonCount: buttons.length,
      buttonDigests: buttons.map(textDigest),
      hasDocument: value.hasDocument,
      latencyMs,
      phase: value.phase,
      turn: value.turn,
    });
  }

  recordRuntimeTrace(
    value: LiveExplorationRuntimeTraceEvidence,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 ||
      !RUNTIME_TRACE_STAGES.has(
        value.stage as typeof RUNTIME_TRACE_STAGES extends Set<infer T>
          ? T
          : never,
      ) ||
      (value.phase !== "startup" && value.phase !== "idle" &&
        value.phase !== "turn") ||
      (value.phase === "turn" &&
        (!Number.isSafeInteger(value.turn) || (value.turn ?? 0) < 1)) ||
      (value.phase !== "turn" && value.turn !== null)
    ) {
      return Promise.reject(blocked("LIVE_EXPLORATION_RUNTIME_TRACE_INVALID"));
    }
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "runtime_trace",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      sequence: value.sequence,
      attempt: value.attempt,
      stage: value.stage,
      phase: value.phase,
      turn: value.turn,
    });
  }

  recordBoundary(value: LiveExplorationBoundaryEvidence): Promise<void> {
    if (
      !Number.isSafeInteger(value.boundary) || value.boundary < 1 ||
      !Number.isSafeInteger(value.fromTurn) || value.fromTurn < 1 ||
      (value.kind === "settle" &&
        (value.toTurn !== null ||
          typeof value.observationFlushTimedOut !== "boolean")) ||
      (value.kind === "interrupt" &&
        (value.toTurn !== value.fromTurn + 1 ||
          value.observationFlushTimedOut !== null))
    ) {
      return Promise.reject(blocked("LIVE_EXPLORATION_BOUNDARY_INVALID"));
    }
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "boundary",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      boundary: value.boundary,
      kind: value.kind,
      fromTurn: value.fromTurn,
      toTurn: value.toTurn,
      observationFlushTimedOut: value.observationFlushTimedOut,
    });
  }

  recordCoverage(value: LiveExplorationCoverageEvidence): Promise<void> {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
      return Promise.reject(blocked("LIVE_EXPLORATION_COVERAGE_INVALID"));
    }
    const runMode = liveExplorationRunMode(value.runMode);
    const markers = coverageMarkers(value.markers);
    assertCoverageSource(value.source, value.trigger, markers);
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "coverage",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      sequence: value.sequence,
      runMode,
      source: value.source,
      trigger: value.trigger,
      markers,
    });
  }

  recordAssessment(value: LiveExplorationAssessmentEvidence): Promise<void> {
    if (!Number.isSafeInteger(value.assessment) || value.assessment < 1) {
      return Promise.reject(blocked("LIVE_EXPLORATION_ASSESSMENT_INVALID"));
    }
    const assessment = validateAssessment({
      scores: value.scores,
      completion: value.completion,
      defects: value.defects,
    });
    const runMode = liveExplorationRunMode(value.runMode);
    const coverage = liveExplorationCoverageSnapshot(value.coverage);
    assertLiveExplorationAssessmentAllowed(
      runMode,
      assessment.completion,
      coverage.markers,
    );
    return this.enqueue({
      version: EVIDENCE_VERSION,
      type: "assessment",
      at: this.now().toISOString(),
      runId: runIdentifier(value.runId),
      channel: this.channel,
      assessment: value.assessment,
      runMode,
      coverage: coverage.markers,
      missingForFullCompletion: coverage.missingForFullCompletion,
      ...assessment,
    });
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.failed) throw this.failed;
  }

  private enqueue(record: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    const line = `${JSON.stringify(record)}\n`;
    this.tail = this.tail.then(async () => {
      if (this.failed) throw this.failed;
      try {
        const handle = await openEvidenceTarget(this.file, "append");
        try {
          const existing = await readEvidenceHandle(handle);
          validateEvidenceText(existing.value);
          const separator = existing.value && !existing.value.endsWith("\n")
            ? "\n"
            : "";
          const appended = `${separator}${line}`;
          if (
            existing.size + Buffer.byteLength(appended, "utf8") >
              EVIDENCE_MAX_BYTES
          ) {
            throw blocked("LIVE_EXPLORATION_EVIDENCE_LIMIT_REACHED");
          }
          assertRegularEvidence(await handle.stat());
          await handle.chmod(0o600).catch(() => undefined);
          await handle.appendFile(appended, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
      } catch (error) {
        this.failed = error;
        throw error;
      }
    });
    return this.tail;
  }
}

export function assertLiveExplorationGate(env: NodeJS.ProcessEnv): void {
  if (env.HARVY_LIVE_EXPLORATION_CONFIRM !== LIVE_EXPLORATION_CONFIRMATION) {
    throw blocked(
      `LIVE_EXPLORATION_REQUIRES_${LIVE_EXPLORATION_CONFIRMATION}`,
    );
  }
  if (env.HARVY_LIVE_EXPLORATION_ACCOUNT !== LIVE_EXPLORATION_ACCOUNT) {
    throw blocked("LIVE_EXPLORATION_REQUIRES_DEDICATED_TEST_ACCOUNT");
  }
}

export function parseLiveExplorationOptions(
  argv: readonly string[],
): LiveExplorationOptions {
  const allowed = new Set(["--channel", "--journey", "--mode"]);
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^(--[a-z]+)=(.*)$/u.exec(argument);
    if (!match || !allowed.has(match[1]!)) {
      throw blocked("LIVE_EXPLORATION_ARGUMENT_INVALID");
    }
    const name = match[1]!;
    if (values.has(name)) {
      throw blocked("LIVE_EXPLORATION_ARGUMENT_DUPLICATE");
    }
    values.set(name, match[2]!);
  }
  if (values.size !== allowed.size) {
    throw blocked("LIVE_EXPLORATION_ARGUMENT_MISSING");
  }
  const channel = values.get("--channel");
  if (channel !== "telegram" && channel !== "whatsapp") {
    throw blocked("LIVE_EXPLORATION_CHANNEL_INVALID");
  }
  const runMode = values.get("--mode");
  if (runMode !== "full" && runMode !== "focused") {
    throw blocked("LIVE_EXPLORATION_MODE_INVALID");
  }
  return {
    channel,
    journeyId: journeyIdentifier(values.get("--journey") ?? ""),
    runMode,
  };
}

export function parseLiveExplorationCommand(
  line: string,
): LiveExplorationCommand {
  if (
    !line || Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES ||
    FORBIDDEN_TEXT_CONTROL.test(line)
  ) {
    throw blocked("LIVE_EXPLORATION_COMMAND_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw blocked("LIVE_EXPLORATION_COMMAND_JSON_INVALID");
  }
  const record = strictRecord(parsed, "LIVE_EXPLORATION_COMMAND_INVALID");
  const type = record["type"];
  if (type === "send") {
    exactKeys(record, ["text", "type"]);
    return { type, text: messageText(record["text"]) };
  }
  if (type === "image") {
    exactKeys(record, ["color", "type"]);
    const color = record["color"];
    if (color !== "red" && color !== "green" && color !== "blue") {
      throw blocked("LIVE_EXPLORATION_IMAGE_COLOR_INVALID");
    }
    return { type, color };
  }
  if (type === "reply") {
    exactKeys(record, ["surface", "text", "type"]);
    return {
      type,
      surface: surfaceAlias(record["surface"]),
      text: messageText(record["text"]),
    };
  }
  if (type === "click") {
    exactKeys(record, ["label", "surface", "type"]);
    return {
      type,
      surface: surfaceAlias(record["surface"]),
      label: buttonLabel(record["label"]),
    };
  }
  if (type === "burst") {
    exactKeys(record, ["gapMs", "messages", "type"]);
    if (
      !Array.isArray(record["messages"]) || record["messages"].length < 2 ||
      record["messages"].length > 8
    ) {
      throw blocked("LIVE_EXPLORATION_BURST_INVALID");
    }
    const gapMs = integerInRange(
      record["gapMs"],
      0,
      15_000,
      "LIVE_EXPLORATION_BURST_GAP_INVALID",
    );
    return {
      type,
      messages: record["messages"].map(messageText),
      gapMs,
    };
  }
  if (type === "interrupt") {
    exactKeys(record, ["text", "type"]);
    return { type, text: messageText(record["text"]) };
  }
  if (type === "wait") {
    exactKeys(record, ["ms", "type"]);
    return {
      type,
      ms: integerInRange(
        record["ms"],
        100,
        300_000,
        "LIVE_EXPLORATION_WAIT_INVALID",
      ),
    };
  }
  if (type === "restart" || type === "settle" || type === "status") {
    exactKeys(record, ["type"]);
    return { type };
  }
  if (type === "mark") {
    exactKeys(record, ["markers", "type"]);
    return {
      type,
      markers: manualCoverageMarkers(record["markers"]),
    };
  }
  if (type === "assess") {
    exactKeys(record, ["completion", "defects", "scores", "type"]);
    return { type, ...validateAssessment(record) };
  }
  if (type === "stop") {
    const deleteJourney = record["deleteJourney"] ?? false;
    const confirmation = record["confirmation"] ?? null;
    exactKeys(
      record,
      deleteJourney === false && confirmation === null
        ? ["type"]
        : ["confirmation", "deleteJourney", "type"],
    );
    if (typeof deleteJourney !== "boolean") {
      throw blocked("LIVE_EXPLORATION_STOP_INVALID");
    }
    if (
      deleteJourney && confirmation !== LIVE_EXPLORATION_DELETE_CONFIRMATION
    ) {
      throw blocked("LIVE_EXPLORATION_DELETE_CONFIRMATION_REQUIRED");
    }
    if (!deleteJourney && confirmation !== null) {
      throw blocked("LIVE_EXPLORATION_STOP_INVALID");
    }
    return {
      type,
      deleteJourney,
      confirmation: typeof confirmation === "string" ? confirmation : null,
    };
  }
  throw blocked("LIVE_EXPLORATION_COMMAND_TYPE_INVALID");
}

export async function prepareLiveExplorationJourney(
  repositoryRoot: string,
  channel: LiveExplorationChannel,
  journeyId: string,
): Promise<{ root: string; evidenceFile: string; resumed: boolean }> {
  const repository = resolve(repositoryRoot);
  const data = join(repository, "data");
  const exploration = join(data, "live-exploration");
  const channelRoot = join(exploration, channel);
  const root = join(channelRoot, journeyIdentifier(journeyId));
  const resumed = await lstat(root).then(() => true).catch(() => false);
  for (const path of [data, exploration, channelRoot, root]) {
    await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw blocked("LIVE_EXPLORATION_JOURNEY_PATH_INVALID");
    }
    await chmod(path, 0o700).catch(() => undefined);
  }
  if (dirname(root) !== channelRoot || basename(root) !== journeyId) {
    throw blocked("LIVE_EXPLORATION_JOURNEY_PATH_INVALID");
  }
  const evidenceFile = join(root, "exploration-evidence.ndjson");
  await readLiveExplorationEvidence(evidenceFile);
  return {
    root,
    evidenceFile,
    resumed,
  };
}

export async function removeLiveExplorationJourney(
  repositoryRoot: string,
  channel: LiveExplorationChannel,
  journeyId: string,
): Promise<void> {
  const expected = resolve(
    repositoryRoot,
    "data",
    "live-exploration",
    channel,
    journeyIdentifier(journeyId),
  );
  const root = resolve(expected);
  const expectedParent = resolve(
    repositoryRoot,
    "data",
    "live-exploration",
    channel,
  );
  if (dirname(root) !== expectedParent || basename(root) !== journeyId) {
    throw blocked("LIVE_EXPLORATION_JOURNEY_PATH_INVALID");
  }
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked("LIVE_EXPLORATION_JOURNEY_PATH_INVALID");
  }
  await rm(root, { recursive: true, force: false });
}

export async function readLiveExplorationEvidence(
  file: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const handle = await openEvidenceTarget(file, "read");
  if (!handle) return [];
  let value: string;
  try {
    value = (await readEvidenceHandle(handle)).value;
  } finally {
    await handle.close();
  }
  return validateEvidenceText(value);
}

export function liveExplorationCoverageFromEvidence(
  records: readonly Readonly<Record<string, unknown>>[],
  requestedMode: LiveExplorationRunMode,
): LiveExplorationCoverageMarker[] {
  const runMode = liveExplorationRunMode(requestedMode);
  const recordedModes = new Set<LiveExplorationRunMode>();
  const markers = new Set<LiveExplorationCoverageMarker>();
  let hasLegacyRecords = false;
  for (const record of records) {
    if (record["version"] !== EVIDENCE_VERSION) {
      hasLegacyRecords = true;
      continue;
    }
    if (record["type"] === "lifecycle" && record["event"] === "started") {
      const details = strictRecord(
        record["details"],
        "LIVE_EXPLORATION_JOURNEY_MODE_INVALID",
      );
      recordedModes.add(liveExplorationRunMode(details["runMode"]));
    } else if (
      record["type"] === "coverage" || record["type"] === "assessment"
    ) {
      recordedModes.add(liveExplorationRunMode(record["runMode"]));
    }
    if (record["type"] === "coverage") {
      for (const marker of coverageMarkers(record["markers"])) {
        markers.add(marker);
      }
    }
  }
  if (recordedModes.size > 1 ||
    (recordedModes.size === 1 && !recordedModes.has(runMode))) {
    throw blocked("LIVE_EXPLORATION_JOURNEY_MODE_MISMATCH");
  }
  if (hasLegacyRecords && recordedModes.size === 0 && runMode === "full") {
    throw blocked("LIVE_EXPLORATION_LEGACY_JOURNEY_FULL_MODE_UNAVAILABLE");
  }
  return liveExplorationCoverageSnapshot(markers).markers;
}

export function liveExplorationHasReadyRun(
  records: readonly Readonly<Record<string, unknown>>[],
  requestedMode: LiveExplorationRunMode,
): boolean {
  const runMode = liveExplorationRunMode(requestedMode);
  // Reuse the journey-mode and legacy policy before interpreting lifecycle.
  liveExplorationCoverageFromEvidence(records, runMode);
  const started = new Set<string>();
  for (const record of records) {
    if (
      record["version"] === EVIDENCE_VERSION &&
      record["type"] === "lifecycle" && record["event"] === "started"
    ) {
      const details = strictRecord(
        record["details"],
        "LIVE_EXPLORATION_JOURNEY_MODE_INVALID",
      );
      if (liveExplorationRunMode(details["runMode"]) === runMode) {
        started.add(runIdentifier(record["runId"]));
      }
    }
  }
  return records.some((record) =>
    record["version"] === EVIDENCE_VERSION &&
    record["type"] === "lifecycle" && record["event"] === "ready" &&
    typeof record["runId"] === "string" && started.has(record["runId"])
  );
}

export function liveExplorationCoverageSnapshot(
  values: Iterable<LiveExplorationCoverageMarker>,
): LiveExplorationCoverageSnapshot {
  const markers = coverageMarkers([...new Set(values)]);
  const present = new Set(markers);
  return {
    markers,
    missingForFullCompletion: LIVE_EXPLORATION_FULL_REQUIRED_MARKERS.filter(
      (marker) => !present.has(marker),
    ),
  };
}

export function assertLiveExplorationAssessmentAllowed(
  runMode: LiveExplorationRunMode,
  completion: LiveExplorationCompletion,
  values: Iterable<LiveExplorationCoverageMarker>,
): void {
  liveExplorationRunMode(runMode);
  if (completion !== "completed") return;
  const snapshot = liveExplorationCoverageSnapshot(values);
  if (runMode === "full" && snapshot.missingForFullCompletion.length > 0) {
    throw blocked("LIVE_EXPLORATION_FULL_COMPLETION_COVERAGE_INCOMPLETE");
  }
}

function validateEvidenceText(
  value: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!value) return [];
  return value.trimEnd().split("\n").map((line) => {
    try {
      return validateEvidenceRecord(JSON.parse(line) as unknown);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("LIVE_EXPLORATION_")
      ) {
        throw error;
      }
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
  });
}

async function openEvidenceTarget(
  file: string,
  access: "append",
): Promise<FileHandle>;
async function openEvidenceTarget(
  file: string,
  access: "read",
): Promise<FileHandle | null>;
async function openEvidenceTarget(
  file: string,
  access: "append" | "read",
): Promise<FileHandle | null> {
  const before = await evidencePathMetadata(file);
  if (before) assertRegularEvidence(before);
  if (!before && access === "read") return null;

  const noFollow = FS_CONSTANTS.O_NOFOLLOW ?? 0;
  const flags = access === "read"
    ? FS_CONSTANTS.O_RDONLY | noFollow
    : before
      ? FS_CONSTANTS.O_RDWR | FS_CONSTANTS.O_APPEND | noFollow
      : FS_CONSTANTS.O_RDWR | FS_CONSTANTS.O_APPEND | FS_CONSTANTS.O_CREAT |
        FS_CONSTANTS.O_EXCL | noFollow;
  let handle: FileHandle;
  try {
    handle = await open(file, flags, 0o600);
  } catch {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }

  try {
    const opened = await handle.stat();
    const current = await evidencePathMetadata(file);
    if (!current) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    assertRegularEvidence(opened);
    assertRegularEvidence(current);
    if (
      (before !== null && !sameEvidenceFile(before, opened)) ||
      !sameEvidenceFile(current, opened)
    ) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function evidencePathMetadata(file: string): Promise<Stats | null> {
  return await lstat(file).catch((error) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
}

function assertRegularEvidence(metadata: Stats): void {
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.nlink !== 1 || metadata.size > EVIDENCE_MAX_BYTES
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function sameEvidenceFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readEvidenceHandle(
  handle: FileHandle,
): Promise<{ value: string; size: number }> {
  const before = await handle.stat();
  assertRegularEvidence(before);
  const value = await handle.readFile({ encoding: "utf8" });
  const after = await handle.stat();
  assertRegularEvidence(after);
  if (
    !sameEvidenceFile(before, after) || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    Buffer.byteLength(value, "utf8") !== after.size
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
  return { value, size: after.size };
}

export function liveExplorationRunId(): string {
  return `run-${randomBytes(12).toString("hex")}`;
}

export function textDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function journeyIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,48}$/u.test(value)
  ) {
    throw blocked("LIVE_EXPLORATION_JOURNEY_INVALID");
  }
  return value;
}

function runIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^run-[a-f0-9]{24}$/u.test(value)) {
    throw blocked("LIVE_EXPLORATION_RUN_ID_INVALID");
  }
  return value;
}

function messageText(value: unknown): string {
  if (typeof value !== "string") {
    throw blocked("LIVE_EXPLORATION_MESSAGE_INVALID");
  }
  const normalized = value.trim();
  if (
    !normalized || Array.from(normalized).length > MAX_MESSAGE_CHARACTERS ||
    FORBIDDEN_TEXT_CONTROL.test(normalized)
  ) {
    throw blocked("LIVE_EXPLORATION_MESSAGE_INVALID");
  }
  return normalized;
}

function surfaceText(value: unknown): string {
  if (
    typeof value !== "string" || Array.from(value).length > 32_000 ||
    FORBIDDEN_TEXT_CONTROL.test(value)
  ) {
    throw blocked("LIVE_EXPLORATION_SURFACE_TEXT_INVALID");
  }
  return value;
}

function buttonLabel(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() ||
    Array.from(value.trim()).length > 160 || FORBIDDEN_TEXT_CONTROL.test(value)
  ) {
    throw blocked("LIVE_EXPLORATION_BUTTON_INVALID");
  }
  return value.trim();
}

function surfaceAlias(value: unknown): string {
  if (typeof value !== "string" || !/^surface-[1-9]\d{0,5}$/u.test(value)) {
    throw blocked("LIVE_EXPLORATION_SURFACE_INVALID");
  }
  return value;
}

function strictRecord(
  value: unknown,
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blocked(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw blocked(code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw blocked("LIVE_EXPLORATION_COMMAND_FIELDS_INVALID");
  }
}

function validateEvidenceRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const record = strictRecord(value, "LIVE_EXPLORATION_EVIDENCE_INVALID");
  const version = record["version"];
  if (version !== 1 && version !== 2 && version !== EVIDENCE_VERSION) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
  isoTimestamp(record["at"]);
  runIdentifier(record["runId"]);
  const channel = record["channel"];
  if (channel !== "telegram" && channel !== "whatsapp") {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }

  if (record["type"] === "lifecycle") {
    evidenceExactKeys(record, [
      "at", "channel", "details", "event", "runId", "type", "version",
    ]);
    if (
      record["event"] !== "started" &&
      record["event"] !== "startup_failed" &&
      record["event"] !== "ready" &&
      record["event"] !== "restart_requested" &&
      record["event"] !== "restarted" && record["event"] !== "stopped"
    ) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    const details = strictRecord(
      record["details"],
      "LIVE_EXPLORATION_EVIDENCE_INVALID",
    ) as Record<string, string | number | boolean | null>;
    safeDetails(details);
    if (version === 3 && record["event"] === "started") {
      evidenceExactKeys(details, ["resumed", "runMode"]);
      if (typeof details["resumed"] !== "boolean") {
        throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
      }
      liveExplorationRunMode(details["runMode"]);
    }
    return record;
  }

  if (record["type"] === "turn") {
    evidenceExactKeys(record, record["replySurface"] === undefined
      ? [
        "at", "channel", "kind", "messageCount", "messages", "runId",
        "turn", "type", "version",
      ]
      : [
        "at", "channel", "kind", "messageCount", "messages", "replySurface",
        "runId", "turn", "type", "version",
      ]);
    integerInRange(record["turn"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    if (
      record["kind"] !== "send" && record["kind"] !== "reply" &&
      record["kind"] !== "burst" && record["kind"] !== "click" &&
      (version !== 3 ||
        (record["kind"] !== "interrupt" && record["kind"] !== "image"))
    ) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    if (!Array.isArray(record["messages"])) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    const messageCount = integerInRange(
      record["messageCount"],
      1,
      8,
      "LIVE_EXPLORATION_EVIDENCE_INVALID",
    );
    if (record["messages"].length !== messageCount) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    for (const message of record["messages"]) {
      const item = strictRecord(message, "LIVE_EXPLORATION_EVIDENCE_INVALID");
      evidenceExactKeys(item, ["characters", "digest"]);
      integerInRange(
        item["characters"],
        1,
        MAX_MESSAGE_CHARACTERS,
        "LIVE_EXPLORATION_EVIDENCE_INVALID",
      );
      digest(item["digest"]);
    }
    if (record["replySurface"] !== undefined) {
      surfaceAlias(record["replySurface"]);
    }
    return record;
  }

  if (record["type"] === "surface") {
    const legacy = version === 1 && record["phase"] === undefined &&
      record["turn"] === undefined;
    evidenceExactKeys(record, legacy
      ? [
        "at", "buttonCount", "buttonDigests", "channel", "hasDocument",
        "latencyMs", "operation", "runId", "sequence", "surface",
        "textCharacters", "textDigest", "type", "version",
      ]
      : [
        "at", "buttonCount", "buttonDigests", "channel", "hasDocument",
        "latencyMs", "operation", "phase", "runId", "sequence", "surface",
        "textCharacters", "textDigest", "turn", "type", "version",
      ]);
    integerInRange(record["sequence"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    if (
      record["operation"] !== "create" && record["operation"] !== "edit" &&
      record["operation"] !== "delete" && record["operation"] !== "pin" &&
      record["operation"] !== "unpin"
    ) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    surfaceAlias(record["surface"]);
    const textCharacters = integerInRange(
      record["textCharacters"],
      0,
      32_000,
      "LIVE_EXPLORATION_EVIDENCE_INVALID",
    );
    if (textCharacters === 0) {
      if (record["textDigest"] !== null) {
        throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
      }
    } else {
      digest(record["textDigest"]);
    }
    if (!Array.isArray(record["buttonDigests"])) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    const buttonCount = integerInRange(
      record["buttonCount"],
      0,
      100,
      "LIVE_EXPLORATION_EVIDENCE_INVALID",
    );
    if (record["buttonDigests"].length !== buttonCount) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    for (const value of record["buttonDigests"]) digest(value);
    if (typeof record["hasDocument"] !== "boolean") {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    nullableLatency(record["latencyMs"]);
    if (!legacy) observation(record["phase"], record["turn"], record["latencyMs"]);
    return record;
  }

  if (record["type"] === "runtime_trace") {
    evidenceExactKeys(record, [
      "at", "attempt", "channel", "phase", "runId", "sequence", "stage",
      "turn", "type", "version",
    ]);
    integerInRange(record["sequence"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    integerInRange(record["attempt"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    if (!RUNTIME_TRACE_STAGES.has(record["stage"] as never)) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    observation(record["phase"], record["turn"],
      record["phase"] === "turn" ? 0 : null);
    return record;
  }

  if (record["type"] === "boundary" && version === 3) {
    evidenceExactKeys(record, [
      "at", "boundary", "channel", "fromTurn", "kind",
      "observationFlushTimedOut", "runId", "toTurn", "type", "version",
    ]);
    integerInRange(record["boundary"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    const fromTurn = integerInRange(record["fromTurn"], 1,
      Number.MAX_SAFE_INTEGER, "LIVE_EXPLORATION_EVIDENCE_INVALID");
    if (record["kind"] === "settle") {
      if (
        record["toTurn"] !== null ||
        typeof record["observationFlushTimedOut"] !== "boolean"
      ) {
        throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
      }
    } else if (record["kind"] === "interrupt") {
      if (
        record["toTurn"] !== fromTurn + 1 ||
        record["observationFlushTimedOut"] !== null
      ) {
        throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
      }
    } else {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    return record;
  }

  if (record["type"] === "coverage" && version === 3) {
    evidenceExactKeys(record, [
      "at", "channel", "markers", "runId", "runMode", "sequence", "source",
      "trigger", "type", "version",
    ]);
    integerInRange(record["sequence"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    liveExplorationRunMode(record["runMode"]);
    const markers = coverageMarkers(record["markers"]);
    if (
      (record["source"] !== "derived" && record["source"] !== "operator") ||
      (record["trigger"] !== "burst" &&
        record["trigger"] !== "wait-threshold" &&
        record["trigger"] !== "resumed" &&
        record["trigger"] !== "restart" && record["trigger"] !== "mark")
    ) {
      throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
    }
    assertCoverageSource(
      record["source"],
      record["trigger"],
      markers,
    );
    return record;
  }

  if (record["type"] === "assessment") {
    evidenceExactKeys(record, version === 3
      ? [
        "assessment", "at", "channel", "completion", "coverage", "defects",
        "missingForFullCompletion", "runId", "runMode", "scores", "type",
        "version",
      ]
      : [
        "assessment", "at", "channel", "completion", "defects", "runId",
        "scores", "type", "version",
      ]);
    integerInRange(record["assessment"], 1, Number.MAX_SAFE_INTEGER,
      "LIVE_EXPLORATION_EVIDENCE_INVALID");
    const assessment = validateAssessment(record);
    if (version === 3) {
      const runMode = liveExplorationRunMode(record["runMode"]);
      const snapshot = liveExplorationCoverageSnapshot(
        coverageMarkers(record["coverage"]),
      );
      if (!Array.isArray(record["missingForFullCompletion"]) ||
        JSON.stringify(record["missingForFullCompletion"]) !==
          JSON.stringify(snapshot.missingForFullCompletion)) {
        throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
      }
      assertLiveExplorationAssessmentAllowed(
        runMode,
        assessment.completion,
        snapshot.markers,
      );
    }
    return record;
  }

  throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
}

function evidenceExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function isoTimestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function nullableLatency(value: unknown): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || (value as number) < 0 ||
      (value as number) > 86_400_000)
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function observation(
  phase: unknown,
  turn: unknown,
  latencyMs: unknown,
): void {
  if (phase !== "startup" && phase !== "idle" && phase !== "turn") {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
  nullableLatency(latencyMs);
  if (
    (phase === "turn" &&
      (!Number.isSafeInteger(turn) || (turn as number) < 1 || latencyMs === null)) ||
    (phase !== "turn" && (turn !== null || latencyMs !== null))
  ) {
    throw blocked("LIVE_EXPLORATION_EVIDENCE_INVALID");
  }
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw blocked(code);
  }
  return value as number;
}

function liveExplorationRunMode(value: unknown): LiveExplorationRunMode {
  if (value !== "full" && value !== "focused") {
    throw blocked("LIVE_EXPLORATION_MODE_INVALID");
  }
  return value;
}

function coverageMarkers(value: unknown): LiveExplorationCoverageMarker[] {
  if (!Array.isArray(value) || value.length > LIVE_EXPLORATION_COVERAGE_MARKERS.length) {
    throw blocked("LIVE_EXPLORATION_COVERAGE_INVALID");
  }
  const allowed = new Set<string>(LIVE_EXPLORATION_COVERAGE_MARKERS);
  const markers = value.map((marker) => {
    if (typeof marker !== "string" || !allowed.has(marker)) {
      throw blocked("LIVE_EXPLORATION_COVERAGE_INVALID");
    }
    return marker as LiveExplorationCoverageMarker;
  });
  if (new Set(markers).size !== markers.length) {
    throw blocked("LIVE_EXPLORATION_COVERAGE_INVALID");
  }
  const present = new Set(markers);
  return LIVE_EXPLORATION_COVERAGE_MARKERS.filter((marker) =>
    present.has(marker)
  );
}

function manualCoverageMarkers(
  value: unknown,
): LiveExplorationManualCoverageMarker[] {
  const markers = coverageMarkers(value);
  const allowed = new Set<string>(LIVE_EXPLORATION_MANUAL_COVERAGE_MARKERS);
  if (markers.length === 0 || markers.some((marker) => !allowed.has(marker))) {
    throw blocked("LIVE_EXPLORATION_MANUAL_COVERAGE_INVALID");
  }
  return markers as LiveExplorationManualCoverageMarker[];
}

function assertCoverageSource(
  source: LiveExplorationCoverageSource,
  trigger: LiveExplorationCoverageTrigger,
  markers: readonly LiveExplorationCoverageMarker[],
): void {
  if (source === "operator" && trigger === "mark") {
    manualCoverageMarkers(markers);
    return;
  }
  const derived = source === "derived"
    ? ({
      burst: "multi-bubble",
      "wait-threshold": "pause",
      resumed: "re-entry",
      restart: "restart",
    } as const)[trigger as Exclude<LiveExplorationCoverageTrigger, "mark">]
    : undefined;
  if (!derived || markers.length !== 1 || markers[0] !== derived) {
    throw blocked("LIVE_EXPLORATION_COVERAGE_SOURCE_INVALID");
  }
}

function validateAssessment(value: Readonly<Record<string, unknown>>): LiveExplorationAssessment {
  const scores = strictRecord(
    value["scores"],
    "LIVE_EXPLORATION_ASSESSMENT_SCORES_INVALID",
  );
  const scoreKeys = [
    "contextCoherence",
    "correctionHandling",
    "initiative",
    "naturalness",
    "nonRepetition",
    "uiClarity",
    "usefulness",
  ] as const;
  exactKeys(scores, scoreKeys);
  const completion = value["completion"];
  if (completion !== "completed" && completion !== "partial" && completion !== "failed") {
    throw blocked("LIVE_EXPLORATION_ASSESSMENT_COMPLETION_INVALID");
  }
  const rawDefects = value["defects"];
  if (!Array.isArray(rawDefects) || rawDefects.length > LIVE_EXPLORATION_DEFECT_TAGS.length) {
    throw blocked("LIVE_EXPLORATION_ASSESSMENT_DEFECTS_INVALID");
  }
  const allowedDefects = new Set<string>(LIVE_EXPLORATION_DEFECT_TAGS);
  const defects = rawDefects.map((tag) => {
    if (typeof tag !== "string" || !allowedDefects.has(tag)) {
      throw blocked("LIVE_EXPLORATION_ASSESSMENT_DEFECTS_INVALID");
    }
    return tag as LiveExplorationDefectTag;
  });
  if (new Set(defects).size !== defects.length) {
    throw blocked("LIVE_EXPLORATION_ASSESSMENT_DEFECTS_INVALID");
  }
  return {
    scores: {
      usefulness: integerInRange(scores["usefulness"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      naturalness: integerInRange(scores["naturalness"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      initiative: integerInRange(scores["initiative"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      nonRepetition: integerInRange(scores["nonRepetition"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      uiClarity: integerInRange(scores["uiClarity"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      contextCoherence: integerInRange(scores["contextCoherence"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
      correctionHandling: integerInRange(scores["correctionHandling"], 1, 5, "LIVE_EXPLORATION_ASSESSMENT_SCORE_INVALID"),
    },
    completion,
    defects,
  };
}

function safeDetails(
  value: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-zA-Z0-9]{0,47}$/u.test(key)) {
      throw blocked("LIVE_EXPLORATION_LIFECYCLE_DETAILS_INVALID");
    }
    if (
      typeof item === "string" &&
      (!/^[A-Za-z0-9_.:-]{0,96}$/u.test(item) || FORBIDDEN_TEXT_CONTROL.test(item))
    ) {
      throw blocked("LIVE_EXPLORATION_LIFECYCLE_DETAILS_INVALID");
    }
    if (typeof item === "number" && !Number.isSafeInteger(item)) {
      throw blocked("LIVE_EXPLORATION_LIFECYCLE_DETAILS_INVALID");
    }
    if (
      item !== null && typeof item !== "string" && typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw blocked("LIVE_EXPLORATION_LIFECYCLE_DETAILS_INVALID");
    }
    output[key] = item;
  }
  return output;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}
