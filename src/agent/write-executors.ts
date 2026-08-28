import type { TaskService } from "../core/task-service.js";
import type { StudentTask, TaskImportance } from "../domain/task.js";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";
import { MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS } from "../harness/agent-harness.js";
import type { PrivateAgentScope } from "../harness/scope.js";

const MAX_TITLE_CHARACTERS = 200;

/**
 * Tool tulis untuk state tugas milik pengguna sendiri.
 *
 * Sebelum ini seluruh capability yang dapat dipanggil model bersifat read-only,
 * sehingga permintaan seperti "catat tugas ini" hanya bisa dilayani classifier
 * `understand()` yang membuang aksinya secara diam-diam ketika confidence-nya
 * kurang. Executor ini memberi model jalan langsung yang hasilnya terbukti,
 * bukan diklaim. Effect-nya tetap `write`, jadi harness masih memutuskan
 * otorisasinya lewat policy run.
 */
const TASK_MANAGE_NATIVE_TOOL = {
  name: "harvy_task_manage_v1",
  description:
    "Buat, selesaikan, jadwalkan ulang, atau hapus satu tugas milik pemilik scope. Semua waktu memakai ISO 8601 dengan offset zona waktu.",
  inputSchema: objectSchema({
    op: {
      type: "string",
      enum: ["create", "complete", "reschedule", "remove"],
      description: "Operasi tugas yang dijalankan.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TITLE_CHARACTERS,
      description: "Judul tugas; wajib untuk create, memakai kata pengguna.",
    },
    taskId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description:
        "ID tugas dari observation tepercaya; wajib untuk complete, reschedule, dan remove.",
    },
    dueAt: {
      type: "string",
      description:
        "Tenggat ISO 8601 beroffset, contoh 2026-08-28T17:00:00+07:00. String kosong menghapus tenggat.",
    },
    remindAt: {
      type: "string",
      description:
        "Waktu pengingat ISO 8601 beroffset dan harus di masa depan. String kosong menghapus pengingat.",
    },
    importance: {
      type: "integer",
      minimum: 1,
      maximum: 3,
      description: "1 biasa, 2 penting, 3 mendesak. Default 1.",
    },
  }, ["op"]),
} satisfies AgentNativeToolDefinition;

/**
 * Pengingat berdiri sendiri di luar `task.manage` karena capability-nya
 * `external`: ia menghasilkan pesan keluar pada jam tertentu, bukan sekadar
 * mengubah baris state.
 */
const REMINDER_SCHEDULE_NATIVE_TOOL = {
  name: "harvy_reminder_schedule_v1",
  description:
    "Pasang atau lepas pengingat pada satu tugas yang sudah ada. Waktu memakai ISO 8601 beroffset dan harus di masa depan.",
  inputSchema: objectSchema({
    op: {
      type: "string",
      enum: ["set", "clear"],
      description: "Memasang atau melepas pengingat.",
    },
    taskId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "ID tugas dari observation tepercaya.",
    },
    remindAt: {
      type: "string",
      description: "Waktu pengingat ISO 8601 beroffset; wajib untuk op set.",
    },
  }, ["op", "taskId"]),
} satisfies AgentNativeToolDefinition;

export interface WriteAgentDependencies {
  tasks: TaskService;
  now?: () => Date;
}

export function createWriteAgentExecutors(
  dependencies: WriteAgentDependencies,
): AgentCapabilityExecutor[] {
  const now = dependencies.now ?? (() => new Date());
  return [
    new TaskManageExecutor(dependencies.tasks, now),
    new ReminderScheduleExecutor(dependencies.tasks, now),
  ];
}

interface TaskManageInput {
  op: "create" | "complete" | "reschedule" | "remove";
  title?: string;
  taskId?: string;
  dueAt?: Date | null;
  remindAt?: Date | null;
  importance?: TaskImportance;
}

export class TaskManageExecutor
implements AgentCapabilityExecutor<TaskManageInput> {
  readonly capabilityId = "task.manage";
  readonly capabilityVersion = "1";
  readonly nativeTool = TASK_MANAGE_NATIVE_TOOL;

  constructor(
    private readonly tasks: TaskService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validate(input: unknown) {
    if (
      !isExactRecord(input, ["op"], [
        "title",
        "taskId",
        "dueAt",
        "remindAt",
        "importance",
      ])
    ) {
      return {
        ok: false as const,
        reason: "Input hanya boleh memuat op, title, taskId, dueAt, remindAt, importance.",
      };
    }
    const op = input.op;
    if (
      op !== "create" && op !== "complete" && op !== "reschedule" &&
      op !== "remove"
    ) {
      return {
        ok: false as const,
        reason: "op harus create, complete, reschedule, atau remove.",
      };
    }

    const value: TaskManageInput = { op };

    if (op === "create") {
      if (typeof input.title !== "string" || !boundedTitle(input.title)) {
        return {
          ok: false as const,
          reason: `title wajib untuk create dan maksimal ${MAX_TITLE_CHARACTERS} karakter.`,
        };
      }
      value.title = boundedTitle(input.title);
      if (input.taskId !== undefined) {
        return { ok: false as const, reason: "create tidak menerima taskId." };
      }
    } else {
      if (typeof input.taskId !== "string" || !isTaskId(input.taskId)) {
        return { ok: false as const, reason: `taskId wajib untuk op ${op}.` };
      }
      value.taskId = input.taskId;
      if (input.title !== undefined) {
        return {
          ok: false as const,
          reason: "Mengganti judul belum didukung; buat tugas baru bila judulnya berbeda.",
        };
      }
    }

    if (op === "complete" || op === "remove") {
      if (
        input.dueAt !== undefined || input.remindAt !== undefined ||
        input.importance !== undefined
      ) {
        return {
          ok: false as const,
          reason: `op ${op} tidak menerima dueAt, remindAt, atau importance.`,
        };
      }
      return { ok: true as const, value };
    }

    const due = readOptionalMoment(input.dueAt);
    if (!due.ok) return { ok: false as const, reason: `dueAt ${due.reason}` };
    if (due.present) value.dueAt = due.value;

    const remind = readOptionalMoment(input.remindAt);
    if (!remind.ok) {
      return { ok: false as const, reason: `remindAt ${remind.reason}` };
    }
    if (remind.present) value.remindAt = remind.value;

    if (input.importance !== undefined) {
      if (
        input.importance !== 1 && input.importance !== 2 && input.importance !== 3
      ) {
        return { ok: false as const, reason: "importance harus 1, 2, atau 3." };
      }
      value.importance = input.importance;
    }

    if (op === "reschedule" && !due.present && !remind.present) {
      return {
        ok: false as const,
        reason: "reschedule membutuhkan dueAt atau remindAt.",
      };
    }
    return { ok: true as const, value };
  }

  async execute(
    input: TaskManageInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const ownerId = scope.value.userId;

    switch (input.op) {
      case "create": {
        // Pengingat yang sudah lewat ditolak di sini agar model menerima
        // penolakan yang dapat dijelaskan, bukan tugas yang diam-diam
        // kehilangan pengingatnya di dalam TaskService.
        if (input.remindAt && input.remindAt.getTime() <= this.now().getTime()) {
          return errorSummary(
            "task.manage.rejected",
            "Waktu pengingat sudah lewat. Minta waktu baru pada pengguna atau hilangkan pengingatnya.",
          );
        }
        const task = await this.tasks.create({
          ownerId,
          chatId: scope.value.deliveryChatId ?? ownerId,
          title: input.title!,
          dueAt: input.dueAt ?? null,
          remindAt: input.remindAt ?? null,
          importance: input.importance ?? 1,
        });
        return okSummary({
          kind: "task.manage.result",
          op: "create",
          changed: true,
          task: publicTask(task),
        });
      }
      case "complete": {
        const task = await this.tasks.complete(ownerId, input.taskId!);
        return task
          ? okSummary({
              kind: "task.manage.result",
              op: "complete",
              changed: true,
              task: publicTask(task),
            })
          : errorSummary(
              "task.manage.not_applied",
              "Tugas itu tidak ditemukan atau sudah selesai; tidak ada yang diubah.",
            );
      }
      case "remove": {
        const task = await this.tasks.remove(ownerId, input.taskId!);
        return task
          ? okSummary({
              kind: "task.manage.result",
              op: "remove",
              changed: true,
              task: publicTask(task),
            })
          : errorSummary(
              "task.manage.not_applied",
              "Tugas itu tidak ditemukan; tidak ada yang dihapus.",
            );
      }
      case "reschedule": {
        try {
          const task = await this.tasks.updateSchedule(ownerId, input.taskId!, {
            ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
            ...(input.remindAt !== undefined
              ? { reminderAt: input.remindAt }
              : {}),
          });
          return task
            ? okSummary({
                kind: "task.manage.result",
                op: "reschedule",
                changed: true,
                task: publicTask(task),
              })
            : errorSummary(
                "task.manage.not_applied",
                "Tugas itu tidak ditemukan atau sudah selesai; jadwalnya tidak diubah.",
              );
        } catch (error) {
          return errorSummary(
            "task.manage.rejected",
            error instanceof Error ? error.message : "Jadwal tugas ditolak.",
          );
        }
      }
      default:
        return errorSummary("task.manage.rejected", "Operasi tugas tidak dikenal.");
    }
  }
}

interface ReminderScheduleInput {
  op: "set" | "clear";
  taskId: string;
  remindAt?: Date;
}

export class ReminderScheduleExecutor
implements AgentCapabilityExecutor<ReminderScheduleInput> {
  readonly capabilityId = "reminder.schedule";
  readonly capabilityVersion = "1";
  readonly nativeTool = REMINDER_SCHEDULE_NATIVE_TOOL;

  constructor(
    private readonly tasks: TaskService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  validate(input: unknown) {
    if (!isExactRecord(input, ["op", "taskId"], ["remindAt"])) {
      return {
        ok: false as const,
        reason: "Input hanya boleh memuat op, taskId, dan remindAt.",
      };
    }
    if (input.op !== "set" && input.op !== "clear") {
      return { ok: false as const, reason: "op harus set atau clear." };
    }
    if (typeof input.taskId !== "string" || !isTaskId(input.taskId)) {
      return { ok: false as const, reason: "taskId tidak sah." };
    }
    if (input.op === "clear") {
      return input.remindAt === undefined
        ? { ok: true as const, value: { op: "clear" as const, taskId: input.taskId } }
        : { ok: false as const, reason: "op clear tidak menerima remindAt." };
    }
    const remind = readOptionalMoment(input.remindAt);
    if (!remind.ok) {
      return { ok: false as const, reason: `remindAt ${remind.reason}` };
    }
    if (!remind.present || remind.value === null) {
      return { ok: false as const, reason: "remindAt wajib untuk op set." };
    }
    return {
      ok: true as const,
      value: { op: "set" as const, taskId: input.taskId, remindAt: remind.value },
    };
  }

  async execute(
    input: ReminderScheduleInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = privateScope(context);
    if (!scope.ok) return scope.result;
    const ownerId = scope.value.userId;

    if (input.op === "clear") {
      const task = await this.tasks.updateSchedule(ownerId, input.taskId, {
        reminderAt: null,
      });
      return task
        ? okSummary({
            kind: "reminder.schedule.result",
            op: "clear",
            changed: true,
            task: publicTask(task),
          })
        : errorSummary(
            "reminder.schedule.not_applied",
            "Tugas itu tidak ditemukan atau sudah selesai; pengingatnya tidak diubah.",
          );
    }

    if (input.remindAt!.getTime() <= this.now().getTime()) {
      return errorSummary(
        "reminder.schedule.rejected",
        "Waktu pengingat sudah lewat. Tanyakan waktu baru kepada pengguna.",
      );
    }
    const task = await this.tasks.setReminder(
      ownerId,
      input.taskId,
      input.remindAt!,
    );
    return task
      ? okSummary({
          kind: "reminder.schedule.result",
          op: "set",
          changed: true,
          task: publicTask(task),
        })
      : errorSummary(
          "reminder.schedule.not_applied",
          "Tugas itu tidak ditemukan atau sudah selesai; pengingatnya tidak dipasang.",
        );
  }
}

/**
 * Menerima ISO 8601 beroffset saja. Waktu tanpa offset akan dibaca sebagai UTC
 * oleh `Date`, yang menggeser pengingat pengguna Indonesia tujuh jam tanpa
 * pesan kesalahan — kegagalan diam yang persis ingin dihindari di sini.
 */
function readOptionalMoment(
  raw: unknown,
):
  | { ok: true; present: false }
  | { ok: true; present: true; value: Date | null }
  | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, present: false };
  if (typeof raw !== "string") {
    return { ok: false, reason: "harus berupa string ISO 8601." };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, present: true, value: null };
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u
      .test(trimmed)
  ) {
    return {
      ok: false,
      reason: "harus ISO 8601 lengkap dengan offset zona waktu, contoh 2026-08-28T17:00:00+07:00.",
    };
  }
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    return { ok: false, reason: "bukan waktu kalender yang sah." };
  }
  return { ok: true, present: true, value: parsed };
}

function isTaskId(value: string): boolean {
  return /^[\p{L}\p{N}_.:-]{1,64}$/u.test(value);
}

function boundedTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARACTERS);
}

function publicTask(task: StudentTask) {
  return {
    id: task.id,
    title: boundedTitle(task.title),
    dueAt: task.dueAt,
    reminderAt: task.reminderAt,
    reminderSentAt: task.reminderSentAt,
    importance: task.importance,
    status: task.status,
  };
}

function privateScope(
  context: AgentExecutionContext,
):
  | { ok: true; value: PrivateAgentScope }
  | { ok: false; result: AgentExecutorResult } {
  if (context.scope.kind !== "private") {
    return {
      ok: false,
      result: errorSummary(
        "write_tool.denied",
        "Tool tulis tugas hanya tersedia pada ruang privat Harvy.",
      ),
    };
  }
  return { ok: true, value: context.scope };
}

/**
 * Kegagalan dikembalikan sebagai observation `error` yang dapat dibaca model,
 * bukan exception. Planner perlu tahu apa yang tidak terjadi supaya dapat
 * bertanya atau mencoba jalan lain.
 */
function errorSummary(kind: string, reason: string): AgentExecutorResult {
  return {
    status: "error",
    summary: JSON.stringify({ kind, changed: false, reason }),
  };
}

function okSummary(value: unknown): AgentExecutorResult {
  const summary = JSON.stringify(value);
  return summary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS
    ? { status: "ok", summary }
    : {
        status: "ok",
        summary: JSON.stringify({
          kind: "write_tool.result",
          truncated: true,
          reason: "result_exceeded_observation_budget",
        }),
      };
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
