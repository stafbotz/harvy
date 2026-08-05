import type { ProfileService } from "../core/profile-service.js";
import type { SessionService } from "../core/session-service.js";
import type { TaskService } from "../core/task-service.js";
import type { QuietHours } from "../domain/profile.js";
import type { ActiveSession } from "../domain/session.js";
import type { StudentTask } from "../domain/task.js";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";
import { MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS } from "../harness/agent-harness.js";
import type { PrivateAgentScope } from "../harness/scope.js";

const MAX_TASKS = 20;
const MAX_AGENDA_EVENTS = 40;

const TASK_LIST_ACTIVE_NATIVE_TOOL = {
  name: "harvy_task_list_active_v1",
  description: "Baca daftar tugas aktif pemilik scope Harvy.",
  inputSchema: objectSchema({
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TASKS,
      description: "Jumlah maksimum tugas yang dikembalikan.",
    },
  }),
} satisfies AgentNativeToolDefinition;

const TASK_GET_NATIVE_TOOL = {
  name: "harvy_task_get_v1",
  description: "Baca satu tugas Harvy berdasarkan ID hasil observation tepercaya.",
  inputSchema: objectSchema({
    taskId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "ID tugas dari state Harvy, bukan ID pemilik atau scope.",
    },
  }, ["taskId"]),
} satisfies AgentNativeToolDefinition;

const SESSION_STATUS_NATIVE_TOOL = {
  name: "harvy_session_status_v1",
  description: "Baca status sesi aktif pemilik scope Harvy.",
  inputSchema: objectSchema({}),
} satisfies AgentNativeToolDefinition;

const TIME_SETTINGS_NATIVE_TOOL = {
  name: "harvy_settings_time_get_v1",
  description: "Baca clock runtime, timezone, dan jam tenang pemilik scope.",
  inputSchema: objectSchema({}),
} satisfies AgentNativeToolDefinition;

const CALENDAR_AGENDA_NATIVE_TOOL = {
  name: "harvy_calendar_agenda_v1",
  description: "Baca agenda internal Harvy selama 1–31 hari; bukan kalender eksternal.",
  inputSchema: objectSchema({
    days: {
      type: "integer",
      minimum: 1,
      maximum: 31,
      description: "Horizon agenda dari sekarang dalam hari.",
    },
    localDate: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Filter tanggal lokal YYYY-MM-DD bila pengguna meminta hari tertentu.",
    },
  }),
} satisfies AgentNativeToolDefinition;

export interface InternalAgentDependencies {
  tasks: TaskService;
  profiles: ProfileService;
  sessions: SessionService;
  defaultTimeZone: string;
  now?: () => Date;
}

export function createInternalAgentExecutors(
  dependencies: InternalAgentDependencies,
): AgentCapabilityExecutor[] {
  const now = dependencies.now ?? (() => new Date());
  return [
    new TaskListActiveExecutor(dependencies.tasks),
    new TaskGetExecutor(dependencies.tasks),
    new SessionStatusExecutor(dependencies.sessions),
    new TimeSettingsExecutor(
      dependencies.profiles,
      dependencies.defaultTimeZone,
      now,
    ),
    new CalendarAgendaExecutor(
      dependencies.tasks,
      dependencies.sessions,
      dependencies.profiles,
      dependencies.defaultTimeZone,
      now,
    ),
  ];
}

export class TaskListActiveExecutor
implements AgentCapabilityExecutor<{ limit: number }> {
  readonly capabilityId = "task.list_active";
  readonly capabilityVersion = "1";
  readonly nativeTool = TASK_LIST_ACTIVE_NATIVE_TOOL;

  constructor(private readonly tasks: TaskService) {}

  validate(input: unknown) {
    if (!isExactRecord(input, [], ["limit"])) {
      return { ok: false as const, reason: "Input hanya boleh memuat limit opsional." };
    }
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_TASKS) {
      return { ok: false as const, reason: `limit harus bilangan 1–${MAX_TASKS}.` };
    }
    return { ok: true as const, value: { limit: limit as number } };
  }

  async execute(
    input: { limit: number },
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const tasks = await this.tasks.listActive(scope.value.userId);
    return collectionSummary({
      kind: "task.list_active.result",
      trust: "user-authored-data",
      limit: input.limit,
      total: tasks.length,
    }, "tasks", tasks.slice(0, input.limit).map(publicTask), tasks.length > input.limit);
  }
}

export class TaskGetExecutor
implements AgentCapabilityExecutor<{ taskId: string }> {
  readonly capabilityId = "task.get";
  readonly capabilityVersion = "1";
  readonly nativeTool = TASK_GET_NATIVE_TOOL;

  constructor(private readonly tasks: TaskService) {}

  validate(input: unknown) {
    if (
      !isExactRecord(input, ["taskId"]) ||
      typeof input.taskId !== "string" ||
      !/^[\p{L}\p{N}_.:-]{1,64}$/u.test(input.taskId)
    ) {
      return { ok: false as const, reason: "taskId tidak sah." };
    }
    return { ok: true as const, value: { taskId: input.taskId } };
  }

  async execute(
    input: { taskId: string },
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const task = await this.tasks.find(scope.value.userId, input.taskId);
    return okSummary({
      kind: "task.get.result",
      trust: "user-authored-data",
      found: task !== null,
      task: task ? publicTask(task) : null,
    });
  }
}

export class SessionStatusExecutor
implements AgentCapabilityExecutor<Record<string, never>> {
  readonly capabilityId = "session.status";
  readonly capabilityVersion = "1";
  readonly nativeTool = SESSION_STATUS_NATIVE_TOOL;

  constructor(private readonly sessions: SessionService) {}

  validate(input: unknown) {
    return isExactRecord(input, [])
      ? { ok: true as const, value: {} }
      : { ok: false as const, reason: "session.status tidak menerima argumen." };
  }

  async execute(
    _input: Record<string, never>,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const session = await this.sessions.inspectActive(scope.value.userId);
    return okSummary({
      kind: "session.status.result",
      trust: "user-authored-data",
      active: session !== null,
      session: session ? publicSession(session) : null,
    });
  }
}

export class TimeSettingsExecutor
implements AgentCapabilityExecutor<Record<string, never>> {
  readonly capabilityId = "settings.time.get";
  readonly capabilityVersion = "1";
  readonly nativeTool = TIME_SETTINGS_NATIVE_TOOL;

  constructor(
    private readonly profiles: ProfileService,
    private readonly defaultTimeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validate(input: unknown) {
    return isExactRecord(input, [])
      ? { ok: true as const, value: {} }
      : { ok: false as const, reason: "settings.time.get tidak menerima argumen." };
  }

  async execute(
    _input: Record<string, never>,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const profile = await this.profiles.load(scope.value.userId);
    const timeZone = profile.timeZone ?? this.defaultTimeZone;
    const current = this.now();
    return okSummary({
      kind: "settings.time.get.result",
      source: "harvy_runtime_clock",
      isoUtc: current.toISOString(),
      timeZone,
      local: formatLocalDateTime(current, timeZone),
      quietHours: publicQuietHours(profile.quietHours),
    });
  }
}

export class CalendarAgendaExecutor
implements AgentCapabilityExecutor<CalendarAgendaInput> {
  readonly capabilityId = "calendar.agenda";
  readonly capabilityVersion = "1";
  readonly nativeTool = CALENDAR_AGENDA_NATIVE_TOOL;

  constructor(
    private readonly tasks: TaskService,
    private readonly sessions: SessionService,
    private readonly profiles: ProfileService,
    private readonly defaultTimeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validate(input: unknown) {
    if (!isExactRecord(input, [], ["days", "localDate"])) {
      return {
        ok: false as const,
        reason: "Input hanya boleh memuat days dan localDate opsional.",
      };
    }
    const days = input.days === undefined ? 7 : input.days;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 31) {
      return { ok: false as const, reason: "days harus bilangan 1–31." };
    }
    if (
      input.localDate !== undefined &&
      (typeof input.localDate !== "string" || !isIsoLocalDate(input.localDate))
    ) {
      return {
        ok: false as const,
        reason: "localDate harus tanggal kalender YYYY-MM-DD yang sah.",
      };
    }
    return {
      ok: true as const,
      value: {
        days: days as number,
        ...(typeof input.localDate === "string"
          ? { localDate: input.localDate }
          : {}),
      },
    };
  }

  async execute(
    input: CalendarAgendaInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const current = this.now();
    const through = new Date(current.getTime() + input.days * 24 * 60 * 60 * 1_000);
    const [tasks, session, profile] = await Promise.all([
      this.tasks.listActive(scope.value.userId),
      this.sessions.inspectActive(scope.value.userId),
      this.profiles.load(scope.value.userId),
    ]);
    const timeZone = profile.timeZone ?? this.defaultTimeZone;
    const events: AgendaEvent[] = [];
    for (const task of tasks) {
      addTaskEvent(events, task, "due", task.dueAt, current, through);
      if (!task.reminderSentAt) {
        addTaskEvent(events, task, "reminder", task.reminderAt, current, through);
      }
    }
    if (session?.checkIn && !session.checkIn.sentAt) {
      addEvent(events, {
        kind: "checkin",
        at: session.checkIn.at,
        sourceId: session.id,
        label: boundedUserText(session.goal),
        overdue: Date.parse(session.checkIn.at) < current.getTime(),
      }, current, through);
    }
    const selectedEvents = input.localDate
      ? events.filter((event) =>
          formatLocalDateKey(new Date(event.at), timeZone) === input.localDate
        )
      : events;
    // Agenda adalah alat untuk bertindak ke depan. Item mendatang selalu
    // diprioritaskan; overdue tetap terlihat setelahnya, yang terbaru dulu.
    selectedEvents.sort((left, right) => {
      if (left.overdue !== right.overdue) return left.overdue ? 1 : -1;
      return left.overdue
        ? Date.parse(right.at) - Date.parse(left.at)
        : Date.parse(left.at) - Date.parse(right.at);
    });
    const visible = selectedEvents.slice(0, MAX_AGENDA_EVENTS).map((event) => ({
      ...event,
      local: formatLocalDateTime(new Date(event.at), timeZone),
    }));
    return collectionSummary({
      kind: "calendar.agenda.result",
      source: "harvy_internal_state",
      externalCalendar: false,
      trust: "labels-are-user-authored-data",
      days: input.days,
      localDate: input.localDate ?? null,
      timeZone,
      from: current.toISOString(),
      through: through.toISOString(),
      total: selectedEvents.length,
    }, "events", visible, selectedEvents.length > MAX_AGENDA_EVENTS);
  }
}

interface CalendarAgendaInput {
  days: number;
  localDate?: string;
}

interface AgendaEvent {
  kind: "due" | "reminder" | "checkin";
  at: string;
  sourceId: string;
  label: string;
  overdue: boolean;
}

function isIsoLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatLocalDateKey(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(moment);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

function addTaskEvent(
  events: AgendaEvent[],
  task: StudentTask,
  kind: "due" | "reminder",
  at: string | null,
  current: Date,
  through: Date,
): void {
  if (!at) return;
  addEvent(events, {
    kind,
    at,
    sourceId: task.id,
    label: boundedUserText(task.title),
    overdue: Date.parse(at) < current.getTime(),
  }, current, through);
}

function addEvent(
  events: AgendaEvent[],
  event: AgendaEvent,
  current: Date,
  through: Date,
): void {
  const at = Date.parse(event.at);
  if (!Number.isFinite(at) || at >= through.getTime()) return;
  // Agenda tetap menampilkan item terlambat, tetapi tidak event lama lebih dari
  // 31 hari agar output tidak menjadi arsip tersembunyi.
  if (at < current.getTime() - 31 * 24 * 60 * 60 * 1_000) return;
  events.push(event);
}

function publicTask(task: StudentTask) {
  return {
    id: task.id,
    title: boundedUserText(task.title),
    dueAt: task.dueAt,
    reminderAt: task.reminderAt,
    reminderSentAt: task.reminderSentAt,
    importance: task.importance,
    status: task.status,
  };
}

function publicSession(session: ActiveSession) {
  return {
    id: session.id,
    kind: session.kind,
    goal: boundedUserText(session.goal),
    stage: session.stage,
    taskId: session.taskId,
    checkIn: session.checkIn,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  };
}

function publicQuietHours(quietHours: QuietHours | null) {
  if (!quietHours) return null;
  return {
    startMinute: quietHours.startMinute,
    endMinute: quietHours.endMinute,
    display: `${minuteLabel(quietHours.startMinute)}–${minuteLabel(quietHours.endMinute)}`,
  };
}

function minuteLabel(minute: number): string {
  const hour = Math.floor(minute / 60).toString().padStart(2, "0");
  const remainder = (minute % 60).toString().padStart(2, "0");
  return `${hour}.${remainder}`;
}

function formatLocalDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
    hourCycle: "h23",
  }).format(value);
}

function boundedUserText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 300);
}

function privateScope(
  context: AgentExecutionContext,
):
  | { ok: true; value: PrivateAgentScope }
  | { ok: false; result: AgentExecutorResult } {
  if (context.scope.kind !== "private" || context.scope.channel !== "telegram") {
    return {
      ok: false,
      result: {
        status: "error",
        summary: JSON.stringify({
          kind: "internal_tool.denied",
          reason: "Tool internal hanya tersedia pada ruang privat Telegram.",
        }),
      },
    };
  }
  return { ok: true, value: context.scope };
}

function okSummary(value: unknown): AgentExecutorResult {
  const summary = JSON.stringify(value);
  if (summary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
    return { status: "ok", summary };
  }
  const kind = value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).kind === "string"
    ? (value as Record<string, unknown>).kind
    : "internal_tool.result";
  return {
    status: "ok",
    summary: JSON.stringify({
      kind,
      truncated: true,
      reason: "result_exceeded_observation_budget",
    }),
  };
}

function collectionSummary(
  base: Record<string, unknown>,
  field: string,
  items: readonly unknown[],
  sourceTruncated: boolean,
): AgentExecutorResult {
  const included: unknown[] = [];
  for (const item of items) {
    const candidate = {
      ...base,
      returned: included.length + 1,
      truncated: sourceTruncated || included.length + 1 < items.length,
      [field]: [...included, item],
    };
    if (JSON.stringify(candidate).length > MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
      break;
    }
    included.push(item);
  }
  return okSummary({
    ...base,
    returned: included.length,
    truncated: sourceTruncated || included.length < items.length,
    [field]: included,
  });
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function isExactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}
