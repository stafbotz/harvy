import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CalendarAgendaExecutor,
  SessionStatusExecutor,
  TaskGetExecutor,
  TaskListActiveExecutor,
  TimeSettingsExecutor,
} from "../src/agent/internal-executors.js";
import {
  VirtualTerminalExecutor,
  calculate,
} from "../src/agent/virtual-terminal.js";
import { ProfileService, emptyProfile } from "../src/core/profile-service.js";
import { SessionService } from "../src/core/session-service.js";
import { TaskService } from "../src/core/task-service.js";
import type { ProfileRepository, UserProfile } from "../src/domain/profile.js";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../src/domain/session.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";
import {
  MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS,
  type AgentExecutionContext,
} from "../src/harness/agent-harness.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { privateAgentScope } from "../src/harness/scope.js";

const NOW = new Date("2026-08-04T05:00:00.000Z");

describe("internal agent executors", () => {
  it("mengambil owner dari scope dan tidak membocorkan tugas owner lain", async () => {
    const repository = new MemoryTaskRepository();
    const tasks = new TaskService(repository, () => NOW);
    const alice = await tasks.create({
      ownerId: "alice",
      chatId: "a",
      title: "Ulangan biologi",
      dueAt: new Date("2026-08-05T02:00:00.000Z"),
      remindAt: null,
      importance: 3,
    });
    const bob = await tasks.create({
      ownerId: "bob",
      chatId: "b",
      title: "Rahasia Bob",
      dueAt: new Date("2026-08-05T03:00:00.000Z"),
      remindAt: null,
      importance: 3,
    });
    const list = new TaskListActiveExecutor(tasks);
    const validated = list.validate({ limit: 20 });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const result = await list.execute(validated.value, context("alice"));
    const payload = JSON.parse(result.summary) as {
      tasks: Array<{ id: string; title: string }>;
    };
    assert.deepEqual(payload.tasks, [{
      id: alice.id,
      title: "Ulangan biologi",
      dueAt: alice.dueAt,
      reminderAt: null,
      reminderSentAt: null,
      importance: 3,
      status: "active",
    }]);

    const get = new TaskGetExecutor(tasks);
    const getInput = get.validate({ taskId: bob.id });
    assert.equal(getInput.ok, true);
    if (!getInput.ok) return;
    const missing = JSON.parse(
      (await get.execute(getInput.value, context("alice"))).summary,
    ) as { found: boolean };
    assert.equal(missing.found, false);
  });

  it("memberi jam deterministik dan agenda internal dengan zona pengguna", async () => {
    const taskRepository = new MemoryTaskRepository();
    const profileRepository = new MemoryProfileRepository();
    const sessionRepository = new MemorySessionRepository();
    const tasks = new TaskService(taskRepository, () => NOW);
    const profiles = new ProfileService(profileRepository, () => NOW);
    const sessions = new SessionService(
      sessionRepository,
      sessionRepository,
      () => NOW,
    );
    await profileRepository.save({
      ...emptyProfile("alice"),
      timeZone: "Asia/Makassar",
      quietHours: { startMinute: 22 * 60, endMinute: 6 * 60 },
      quietHoursSetAt: NOW.toISOString(),
    });
    const task = await tasks.create({
      ownerId: "alice",
      chatId: "a",
      title: "Presentasi sejarah",
      dueAt: new Date("2026-08-06T01:00:00.000Z"),
      remindAt: new Date("2026-08-05T01:00:00.000Z"),
      importance: 2,
    });
    const session = await sessions.start({
      ownerId: "alice",
      chatId: "a",
      kind: "focus",
      goal: "Menyiapkan slide",
    });
    await sessions.scheduleCheckIn(
      "alice",
      new Date("2026-08-04T06:00:00.000Z"),
      session.id,
    );

    const time = new TimeSettingsExecutor(
      profiles,
      "Asia/Jakarta",
      () => NOW,
    );
    const timeResult = await time.execute({}, context("alice"));
    const clock = JSON.parse(timeResult.summary) as {
      isoUtc: string;
      timeZone: string;
      local: string;
      quietHours: { display: string };
    };
    assert.equal(clock.isoUtc, NOW.toISOString());
    assert.equal(clock.timeZone, "Asia/Makassar");
    assert.match(clock.local, /13[.:]00/u);
    assert.equal(clock.quietHours.display, "22.00–06.00");

    const agenda = new CalendarAgendaExecutor(
      tasks,
      sessions,
      profiles,
      "Asia/Jakarta",
      () => NOW,
    );
    const agendaInput = agenda.validate({ days: 7 });
    assert.equal(agendaInput.ok, true);
    if (!agendaInput.ok) return;
    const agendaResult = JSON.parse(
      (await agenda.execute(agendaInput.value, context("alice"))).summary,
    ) as {
      externalCalendar: boolean;
      timeZone: string;
      events: Array<{ kind: string; sourceId: string }>;
    };
    assert.equal(agendaResult.externalCalendar, false);
    assert.equal(agendaResult.timeZone, "Asia/Makassar");
    assert.deepEqual(
      new Set(agendaResult.events.map((event) => event.kind)),
      new Set(["checkin", "reminder", "due"]),
    );
    assert.ok(agendaResult.events.some((event) => event.sourceId === task.id));

    const status = new SessionStatusExecutor(sessions);
    const statusResult = JSON.parse(
      (await status.execute({}, context("alice"))).summary,
    ) as { active: boolean; session: { goal: string } };
    assert.equal(statusResult.active, true);
    assert.equal(statusResult.session.goal, "Menyiapkan slide");
  });

  it("menyaring agenda besok pada tanggal lokal sebelum observation sampai ke model", async () => {
    const taskRepository = new MemoryTaskRepository();
    const profileRepository = new MemoryProfileRepository();
    const sessionRepository = new MemorySessionRepository();
    const tasks = new TaskService(taskRepository, () => NOW);
    const profiles = new ProfileService(profileRepository, () => NOW);
    const sessions = new SessionService(sessionRepository, sessionRepository, () => NOW);
    for (const [title, dueAt] of [
      ["HARI_INI_CANARY", "2026-08-04T09:00:00.000Z"],
      ["BESOK_CANARY", "2026-08-05T02:00:00.000Z"],
      ["LUSA_CANARY", "2026-08-06T00:00:00.000Z"],
    ] as const) {
      await tasks.create({
        ownerId: "alice",
        chatId: "a",
        title,
        dueAt: new Date(dueAt),
        remindAt: null,
        importance: 2,
      });
    }
    const agenda = new CalendarAgendaExecutor(
      tasks,
      sessions,
      profiles,
      "Asia/Jakarta",
      () => NOW,
    );
    const validated = agenda.validate({ days: 2, localDate: "2026-08-05" });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const summary = (await agenda.execute(validated.value, context("alice"))).summary;
    const payload = JSON.parse(summary) as {
      localDate: string | null;
      total: number;
      events: Array<{ label: string; local: string }>;
    };
    assert.equal(payload.localDate, "2026-08-05");
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.events.map((event) => event.label), ["BESOK_CANARY"]);
    assert.match(payload.events[0]?.local ?? "", /5 Agustus 2026/u);
    assert.doesNotMatch(summary, /(?:HARI_INI|LUSA)_CANARY/u);
    assert.equal(agenda.validate({ days: 2, localDate: "2026-02-30" }).ok, false);
  });

  it("mengisolasi agenda antar-owner dan menolak horizon di atas 31 hari", async () => {
    const taskRepository = new MemoryTaskRepository();
    const profileRepository = new MemoryProfileRepository();
    const sessionRepository = new MemorySessionRepository();
    const tasks = new TaskService(taskRepository, () => NOW);
    const profiles = new ProfileService(profileRepository, () => NOW);
    const sessions = new SessionService(sessionRepository, sessionRepository, () => NOW);

    const aliceTask = await tasks.create({
      ownerId: "alice",
      chatId: "a",
      title: "Agenda Alice tiga minggu",
      dueAt: new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1_000),
      remindAt: null,
      importance: 2,
    });
    await tasks.create({
      ownerId: "bob",
      chatId: "b",
      title: "CANARY_AGENDA_BOB",
      dueAt: new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1_000),
      remindAt: null,
      importance: 3,
    });
    const bobSession = await sessions.start({
      ownerId: "bob",
      chatId: "b",
      kind: "focus",
      goal: "CANARY_CHECKIN_BOB",
    });
    await sessions.scheduleCheckIn(
      "bob",
      new Date(NOW.getTime() + 60 * 60 * 1_000),
      bobSession.id,
    );

    const agenda = new CalendarAgendaExecutor(
      tasks,
      sessions,
      profiles,
      "Asia/Jakarta",
      () => NOW,
    );
    const validated = agenda.validate({ days: 21 });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const summary = (await agenda.execute(validated.value, context("alice"))).summary;
    const payload = JSON.parse(summary) as {
      days: number;
      events: Array<{ sourceId: string; label: string }>;
    };
    assert.equal(payload.days, 21);
    assert.deepEqual(payload.events.map((event) => event.sourceId), [aliceTask.id]);
    assert.doesNotMatch(summary, /CANARY_(?:AGENDA|CHECKIN)_BOB/u);
    assert.equal(agenda.validate({ days: 32 }).ok, false);
  });

  it("menjaga daftar tugas dan agenda panjang sebagai JSON valid dalam budget", async () => {
    const taskRepository = new MemoryTaskRepository();
    const profileRepository = new MemoryProfileRepository();
    const sessionRepository = new MemorySessionRepository();
    const tasks = new TaskService(taskRepository, () => NOW);
    const profiles = new ProfileService(profileRepository, () => NOW);
    const sessions = new SessionService(sessionRepository, sessionRepository, () => NOW);
    for (let index = 0; index < 20; index += 1) {
      await tasks.create({
        ownerId: "alice",
        chatId: "a",
        title: `${index}-${"judul panjang ".repeat(30)}`,
        dueAt: new Date(NOW.getTime() + (index + 1) * 60 * 60 * 1_000),
        remindAt: new Date(NOW.getTime() + (index + 1) * 30 * 60 * 1_000),
        importance: 3,
      });
    }

    const list = new TaskListActiveExecutor(tasks);
    const listInput = list.validate({ limit: 20 });
    assert.equal(listInput.ok, true);
    if (!listInput.ok) return;
    const listSummary = (await list.execute(listInput.value, context("alice"))).summary;
    const listPayload = JSON.parse(listSummary) as {
      total: number;
      returned: number;
      truncated: boolean;
    };
    assert.ok(listSummary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS);
    assert.equal(listPayload.total, 20);
    assert.equal(listPayload.truncated, true);
    assert.ok(listPayload.returned > 0 && listPayload.returned < 20);

    const agenda = new CalendarAgendaExecutor(
      tasks,
      sessions,
      profiles,
      "Asia/Jakarta",
      () => NOW,
    );
    const agendaInput = agenda.validate({ days: 7 });
    assert.equal(agendaInput.ok, true);
    if (!agendaInput.ok) return;
    const agendaSummary = (await agenda.execute(
      agendaInput.value,
      context("alice"),
    )).summary;
    const agendaPayload = JSON.parse(agendaSummary) as {
      days: number;
      total: number;
      returned: number;
      truncated: boolean;
    };
    assert.ok(agendaSummary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS);
    assert.equal(agendaPayload.days, 7);
    assert.equal(agendaPayload.total, 40);
    assert.equal(agendaPayload.truncated, true);
    assert.ok(agendaPayload.returned > 0 && agendaPayload.returned < 40);
  });

  it("memprioritaskan agenda mendatang di atas backlog overdue", async () => {
    const taskRepository = new MemoryTaskRepository();
    const profileRepository = new MemoryProfileRepository();
    const sessionRepository = new MemorySessionRepository();
    const tasks = new TaskService(taskRepository, () => NOW);
    for (let index = 0; index < 41; index += 1) {
      await tasks.create({
        ownerId: "alice",
        chatId: "a",
        title: `Terlambat ${index}`,
        dueAt: new Date(NOW.getTime() - (index + 1) * 60 * 60 * 1_000),
        remindAt: null,
        importance: 2,
      });
    }
    const upcoming = await tasks.create({
      ownerId: "alice",
      chatId: "a",
      title: "Besok penting",
      dueAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
      remindAt: null,
      importance: 3,
    });
    const agenda = new CalendarAgendaExecutor(
      tasks,
      new SessionService(sessionRepository, sessionRepository, () => NOW),
      new ProfileService(profileRepository, () => NOW),
      "Asia/Jakarta",
      () => NOW,
    );
    const validated = agenda.validate({ days: 7 });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const payload = JSON.parse(
      (await agenda.execute(validated.value, context("alice"))).summary,
    ) as {
      truncated: boolean;
      events: Array<{ sourceId: string; overdue: boolean }>;
    };
    assert.equal(payload.truncated, true);
    assert.ok(payload.events.some((event) =>
      event.sourceId === upcoming.id && event.overdue === false
    ));
  });
});

describe("virtual terminal", () => {
  it("menghitung dan memakai filesystem kosong yang tidak bertahan lintas execute", async () => {
    const terminal = new VirtualTerminalExecutor(() => NOW);
    const validated = terminal.validate({
      commands: [
        { op: "calculate", expression: "(8 + 4) * 3" },
        { op: "write", path: "catatan.txt", content: "aman" },
        { op: "cat", path: "catatan.txt" },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const result = await terminal.execute(validated.value, context("alice"));
    const payload = JSON.parse(result.summary) as {
      environment: { hostShell: boolean; hostFiles: boolean; network: boolean };
      output: string;
    };
    assert.equal(result.status, "ok");
    assert.deepEqual(payload.environment, {
      ephemeral: true,
      hostShell: false,
      network: false,
      hostFiles: false,
      environmentVariables: false,
      workspace: "/workspace",
    });
    assert.match(payload.output, /36/u);
    assert.match(payload.output, /aman/u);

    const second = terminal.validate({ commands: [{ op: "cat", path: "catatan.txt" }] });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const isolated = await terminal.execute(second.value, context("alice"));
    assert.equal(isolated.status, "error");
    assert.match(isolated.summary, /tidak ada/u);
  });

  it("menolak host, process, environment, network, .env, dan resource bomb", () => {
    const terminal = new VirtualTerminalExecutor(() => NOW);
    assert.equal(
      terminal.validate({
        commands: [{ op: "cat", path: "../.env" }],
      }).ok,
      false,
    );
    assert.equal(
      terminal.validate({
        commands: [{ op: "cat", path: "C:/Users/secret" }],
      }).ok,
      false,
    );
    for (const path of [".env", "/workspace/.env", "fixtures/.env.local"]) {
      assert.equal(
        terminal.validate({ commands: [{ op: "cat", path }] }).ok,
        false,
      );
    }
    for (const op of ["exec", "process", "env", "network"]) {
      assert.equal(
        terminal.validate({ commands: [{ op }] }).ok,
        false,
      );
    }
    assert.equal(
      terminal.validate({
        commands: [{ op: "calculate", expression: "1; process.exit()" }],
      }).ok,
      false,
    );
    assert.throws(() => calculate("10 / 0"), /nol/u);
    assert.equal(
      terminal.validate({ commands: Array.from({ length: 13 }, () => ({ op: "pwd" })) }).ok,
      false,
    );
  });

  it("menjaga output escape-heavy sebagai JSON valid dalam budget", async () => {
    const terminal = new VirtualTerminalExecutor(() => NOW);
    const validated = terminal.validate({
      commands: [{ op: "echo", text: "\n".repeat(8_000) }],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const result = await terminal.execute(validated.value, context("alice"));
    const payload = JSON.parse(result.summary) as {
      output: string;
      truncated: boolean;
    };
    assert.ok(result.summary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS);
    assert.equal(payload.truncated, true);
    assert.ok(payload.output.length > 0);
  });
});

function context(ownerId: string): AgentExecutionContext {
  return {
    runId: "run",
    step: 0,
    scope: privateAgentScope("telegram", ownerId),
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
    const matches = [...this.tasks.keys()].filter((key) => key.startsWith(`${ownerId}:`));
    for (const key of matches) this.tasks.delete(key);
    return matches.length;
  }
}

class MemoryProfileRepository implements ProfileRepository {
  private readonly profiles = new Map<string, UserProfile>();
  async find(ownerId: string): Promise<UserProfile | null> {
    return this.profiles.get(ownerId) ?? null;
  }
  async save(profile: UserProfile): Promise<void> {
    this.profiles.set(profile.ownerId, structuredClone(profile));
  }
  async remove(ownerId: string): Promise<boolean> {
    return this.profiles.delete(ownerId);
  }
  async listDeletionRequested(): Promise<UserProfile[]> {
    return [...this.profiles.values()].filter((profile) => profile.deletionRequestedAt);
  }
}

class MemorySessionRepository implements SessionRepository, DueCheckInSource {
  private readonly sessions = new Map<string, ActiveSession>();
  async load(ownerId: string): Promise<ActiveSession | null> {
    return this.sessions.get(ownerId) ?? null;
  }
  async save(session: ActiveSession): Promise<void> {
    this.sessions.set(session.ownerId, structuredClone(session));
  }
  async remove(ownerId: string): Promise<boolean> {
    return this.sessions.delete(ownerId);
  }
  async listDueCheckIns(now: Date): Promise<ActiveSession[]> {
    return [...this.sessions.values()].filter((session) =>
      session.checkIn !== null && Date.parse(session.checkIn.at) <= now.getTime()
    );
  }
}
