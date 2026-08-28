import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReminderScheduleExecutor,
  TaskManageExecutor,
} from "../src/agent/write-executors.js";
import { privateConversationAuthorizationPolicy } from "../src/ai/conversation.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { TaskService } from "../src/core/task-service.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";
import type { AgentExecutionContext } from "../src/harness/agent-harness.js";
import type { CapabilitySnapshotEntry } from "../src/harness/capabilities.js";
import {
  groupAgentScope,
  privateAgentScope,
} from "../src/harness/scope.js";

const NOW = new Date("2026-08-27T05:00:00.000Z");

describe("write agent executors", () => {
  it("membuat tugas dengan chat pengiriman dari scope, bukan dari userId", async () => {
    const { tasks, repository } = service();
    const executor = new TaskManageExecutor(tasks, () => NOW);
    const validated = executor.validate({
      op: "create",
      title: "Ulangan fisika bab 3",
      dueAt: "2026-08-28T09:00:00+07:00",
      remindAt: "2026-08-28T07:00:00+07:00",
      importance: 3,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(
      validated.value,
      context("wa-user", "whatsapp", "akun:wa-user"),
    );
    assert.equal(result.status, "ok");
    const payload = JSON.parse(result.summary) as {
      changed: boolean;
      task: { id: string; title: string; importance: number };
    };
    assert.equal(payload.changed, true);
    assert.equal(payload.task.title, "Ulangan fisika bab 3");
    assert.equal(payload.task.importance, 3);

    const stored = await repository.findById("wa-user", payload.task.id);
    // Pengingat dikirim ke chat kanal, bukan ke userId yang kebetulan berbeda.
    assert.equal(stored?.chatId, "akun:wa-user");
  });

  it("menolak waktu tanpa offset agar pengingat tidak bergeser diam-diam", () => {
    const { tasks } = service();
    const executor = new TaskManageExecutor(tasks, () => NOW);
    const validated = executor.validate({
      op: "create",
      title: "Ulangan fisika",
      remindAt: "2026-08-28T07:00:00",
    });
    assert.equal(validated.ok, false);
    if (validated.ok) return;
    assert.match(validated.reason, /offset zona waktu/u);
  });

  it("mengembalikan error terbaca ketika pengingat sudah lewat", async () => {
    const { tasks } = service();
    const executor = new TaskManageExecutor(tasks, () => NOW);
    const validated = executor.validate({
      op: "create",
      title: "Ulangan fisika",
      remindAt: "2026-08-27T11:00:00+07:00",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context("siswa"));
    assert.equal(result.status, "error");
    const payload = JSON.parse(result.summary) as {
      changed: boolean;
      reason: string;
    };
    assert.equal(payload.changed, false);
    assert.match(payload.reason, /sudah lewat/u);
  });

  it("melaporkan tugas yang tidak ada sebagai error, bukan sebagai berhasil", async () => {
    const { tasks } = service();
    const executor = new TaskManageExecutor(tasks, () => NOW);
    const validated = executor.validate({ op: "complete", taskId: "tidakada" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context("siswa"));
    assert.equal(result.status, "error");
    assert.match(
      (JSON.parse(result.summary) as { reason: string }).reason,
      /tidak ditemukan/u,
    );
  });

  it("menyelesaikan dan menjadwalkan ulang tugas milik pemilik scope", async () => {
    const { tasks } = service();
    const created = await tasks.create({
      ownerId: "siswa",
      chatId: "siswa",
      title: "PR matematika",
      dueAt: null,
      remindAt: null,
      importance: 1,
    });
    const executor = new TaskManageExecutor(tasks, () => NOW);

    const reschedule = executor.validate({
      op: "reschedule",
      taskId: created.id,
      dueAt: "2026-08-29T10:00:00+07:00",
    });
    assert.equal(reschedule.ok, true);
    if (!reschedule.ok) return;
    const rescheduled = await executor.execute(
      reschedule.value,
      context("siswa"),
    );
    assert.equal(rescheduled.status, "ok");
    assert.equal(
      (JSON.parse(rescheduled.summary) as { task: { dueAt: string } }).task.dueAt,
      "2026-08-29T03:00:00.000Z",
    );

    const complete = executor.validate({ op: "complete", taskId: created.id });
    assert.equal(complete.ok, true);
    if (!complete.ok) return;
    const completed = await executor.execute(complete.value, context("siswa"));
    assert.equal(
      (JSON.parse(completed.summary) as { task: { status: string } }).task.status,
      "completed",
    );
  });

  it("menolak tool tulis di luar ruang privat", async () => {
    const { tasks } = service();
    const executor = new TaskManageExecutor(tasks, () => NOW);
    const validated = executor.validate({ op: "create", title: "Rahasia" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, {
      runId: "run",
      step: 0,
      scope: groupAgentScope("telegram", "grup", "anggota"),
      idempotencyKey: "key",
      signal: new AbortController().signal,
      runBudget: new RunBudgetAccount(),
    });
    assert.equal(result.status, "error");
    assert.match(
      (JSON.parse(result.summary) as { reason: string }).reason,
      /ruang privat/u,
    );
  });

  it("memasang dan melepas pengingat pada tugas yang sudah ada", async () => {
    const { tasks } = service();
    const created = await tasks.create({
      ownerId: "siswa",
      chatId: "siswa",
      title: "Presentasi sejarah",
      dueAt: null,
      remindAt: null,
      importance: 2,
    });
    const executor = new ReminderScheduleExecutor(tasks, () => NOW);

    const set = executor.validate({
      op: "set",
      taskId: created.id,
      remindAt: "2026-08-28T08:00:00+07:00",
    });
    assert.equal(set.ok, true);
    if (!set.ok) return;
    const applied = await executor.execute(set.value, context("siswa"));
    assert.equal(applied.status, "ok");
    assert.equal(
      (JSON.parse(applied.summary) as { task: { reminderAt: string } })
        .task.reminderAt,
      "2026-08-28T01:00:00.000Z",
    );

    const clear = executor.validate({ op: "clear", taskId: created.id });
    assert.equal(clear.ok, true);
    if (!clear.ok) return;
    const cleared = await executor.execute(clear.value, context("siswa"));
    assert.equal(
      (JSON.parse(cleared.summary) as { task: { reminderAt: string | null } })
        .task.reminderAt,
      null,
    );
  });

  it("menolak set tanpa waktu dan clear yang membawa waktu", () => {
    const { tasks } = service();
    const executor = new ReminderScheduleExecutor(tasks, () => NOW);
    assert.equal(executor.validate({ op: "set", taskId: "abc" }).ok, false);
    assert.equal(
      executor.validate({
        op: "clear",
        taskId: "abc",
        remindAt: "2026-08-28T08:00:00+07:00",
      }).ok,
      false,
    );
  });
});

describe("otorisasi tool tulis percakapan privat", () => {
  const policy = privateConversationAuthorizationPolicy();

  it("mengizinkan create, complete, dan reschedule tanpa giliran approval", async () => {
    for (const op of ["create", "complete", "reschedule"]) {
      const decision = await policy({
        scope: privateAgentScope("telegram", "siswa"),
        capability: capability("task.manage", "write"),
        value: { op },
        runId: "run",
        step: 0,
        signal: new AbortController().signal,
      });
      assert.equal(decision.decision, "allow", `op ${op} seharusnya allow`);
    }
  });

  it("menolak penghapusan dengan alasan yang dapat dibaca model", async () => {
    const decision = await policy({
      scope: privateAgentScope("telegram", "siswa"),
      capability: capability("task.manage", "write"),
      value: { op: "remove" },
      runId: "run",
      step: 0,
      signal: new AbortController().signal,
    });
    assert.equal(decision.decision, "deny");
    if (decision.decision !== "deny") return;
    // Run tetap berjalan setelah deny, jadi alasannya harus menuntun tindakan.
    assert.match(decision.reason, /konfirmasi eksplisit/u);
  });

  it("tidak mengizinkan tool tulis di luar ruang privat", async () => {
    const decision = await policy({
      scope: groupAgentScope("telegram", "grup", "anggota"),
      capability: capability("task.manage", "write"),
      value: { op: "create" },
      runId: "run",
      step: 0,
      signal: new AbortController().signal,
    });
    assert.equal(decision.decision, "approval");
  });

  it("mempertahankan izin baca dan approval untuk capability lain", async () => {
    const read = await policy({
      scope: privateAgentScope("telegram", "siswa"),
      capability: {
        ...capability("task.list_active", "read"),
        confirmation: "none",
      },
      value: {},
      runId: "run",
      step: 0,
      signal: new AbortController().signal,
    });
    assert.equal(read.decision, "allow");

    const external = await policy({
      scope: privateAgentScope("telegram", "siswa"),
      capability: capability("external.act", "external"),
      value: { op: "create" },
      runId: "run",
      step: 0,
      signal: new AbortController().signal,
    });
    assert.equal(external.decision, "approval");
  });
});

function service(): { tasks: TaskService; repository: MemoryTaskRepository } {
  const repository = new MemoryTaskRepository();
  return { tasks: new TaskService(repository, () => NOW), repository };
}

function capability(
  id: string,
  effect: CapabilitySnapshotEntry["effect"],
): CapabilitySnapshotEntry {
  return {
    id,
    version: "1",
    title: id,
    description: id,
    effect,
    confirmation: "contextual",
    idempotency: "keyed",
    available: true,
    unavailableReason: null,
  };
}

function context(
  ownerId: string,
  channel: "telegram" | "whatsapp" = "telegram",
  deliveryChatId?: string,
): AgentExecutionContext {
  return {
    runId: "run",
    step: 0,
    scope: privateAgentScope(channel, ownerId, deliveryChatId),
    idempotencyKey: "key",
    signal: new AbortController().signal,
    runBudget: new RunBudgetAccount(),
  };
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, StudentTask>();

  async save(task: StudentTask): Promise<void> {
    this.tasks.set(`${task.ownerId}:${task.id}`, structuredClone(task));
  }
  async findById(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.tasks.get(`${ownerId}:${id}`) ?? null;
  }
  async list(ownerId: string): Promise<StudentTask[]> {
    return [...this.tasks.values()].filter((task) => task.ownerId === ownerId);
  }
  async listActive(ownerId: string): Promise<StudentTask[]> {
    return (await this.list(ownerId)).filter((task) => task.status === "active");
  }
  async listDueReminders(now: Date): Promise<StudentTask[]> {
    return [...this.tasks.values()].filter((task) =>
      task.reminderAt !== null && Date.parse(task.reminderAt) <= now.getTime()
    );
  }
  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.tasks.delete(`${ownerId}:${id}`);
  }
  async removeAll(ownerId: string): Promise<number> {
    const matches = [...this.tasks.keys()].filter((key) =>
      key.startsWith(`${ownerId}:`)
    );
    for (const key of matches) this.tasks.delete(key);
    return matches.length;
  }
}
