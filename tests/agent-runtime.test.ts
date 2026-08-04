import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ParallelDelegationExecutor,
  type AgentWorker,
} from "../src/agent/parallel-delegation.js";
import {
  deterministicTimeReply,
  isDirectTimeQuestion,
} from "../src/agent/time-fast-path.js";
import {
  liveStateRequirement,
  parseAgentPlannerDecision,
} from "../src/ai/agent.js";
import { selectAgentMode } from "../src/ai/model-policy.js";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentExecutionContext,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope } from "../src/harness/scope.js";

describe("agent routing dan planner contract", () => {
  it("memakai cheap tools untuk sederhana dan ambitious orchestrator untuk kompleks", () => {
    assert.equal(selectAgentMode({ intent: "question", messageLength: 30 }), "tools");
    assert.equal(selectAgentMode({
      intent: "request",
      messageLength: 30,
      needsStepByStep: true,
    }), "orchestrate");
    assert.equal(selectAgentMode({ intent: "question", messageLength: 281 }), "orchestrate");
  });

  it("hanya membaca state privat untuk frasa personal yang eksplisit", () => {
    assert.equal(liveStateRequirement("apa agendaku?")?.capabilityId, "calendar.agenda");
    assert.equal(
      liveStateRequirement("apa agenda internal Harvy-ku besok?")?.capabilityId,
      "calendar.agenda",
    );
    assert.equal(liveStateRequirement("cek tugas saya")?.capabilityId, "task.list_active");
    assert.equal(liveStateRequirement("jadwal besok?")?.capabilityId, "calendar.agenda");
    assert.deepEqual(liveStateRequirement("jadwal besok?")?.input, { days: 2 });
    assert.deepEqual(
      liveStateRequirement("jadwal besok?", {
        now: new Date("2026-08-04T16:30:00.000Z"),
        timeZone: "Asia/Jakarta",
      })?.input,
      { days: 2, localDate: "2026-08-05" },
    );
    assert.deepEqual(
      liveStateRequirement("jadwal besok?", {
        now: new Date("2026-08-04T16:30:00.000Z"),
        timeZone: "Asia/Jayapura",
      })?.input,
      { days: 2, localDate: "2026-08-06" },
    );
    assert.deepEqual(liveStateRequirement("cek agendaku 3 minggu")?.input, { days: 21 });
    assert.deepEqual(liveStateRequirement("cek agendaku beberapa minggu")?.input, {
      days: 21,
    });
    assert.deepEqual(liveStateRequirement("cek agendaku 30 hari")?.input, { days: 30 });
    assert.deepEqual(liveStateRequirement("agenda bulan ini")?.input, { days: 31 });
    assert.deepEqual(liveStateRequirement("cek agendaku 32 hari")?.input, { days: 31 });
    assert.match(
      liveStateRequirement("cek agendaku 32 hari")?.coverageNote ?? "",
      /31 hari/u,
    );
    assert.deepEqual(liveStateRequirement("cek agendaku 100 hari")?.input, { days: 31 });
    assert.match(
      liveStateRequirement("cek agendaku 100 hari")?.coverageNote ?? "",
      /31 hari/u,
    );
    assert.deepEqual(liveStateRequirement("cek agendaku 6 minggu")?.input, { days: 31 });
    assert.match(
      liveStateRequirement("cek agendaku 6 minggu")?.coverageNote ?? "",
      /31 hari/u,
    );
    assert.equal(liveStateRequirement("ada tugas apa?")?.capabilityId, "task.list_active");
    assert.equal(liveStateRequirement("deadline terdekat?")?.capabilityId, "task.list_active");
    assert.equal(
      liveStateRequirement("apa yang harus kukerjakan hari ini?")?.capabilityId,
      "task.list_active",
    );
    assert.equal(liveStateRequirement("apa itu agenda setting?"), null);
    assert.equal(liveStateRequirement("jelaskan kalender Gregorian"), null);
    assert.equal(liveStateRequirement("cek deadline pendaftaran 2027"), null);
    assert.equal(
      liveStateRequirement("deadline tugas Biologi aku kapan?")?.capabilityId,
      "task.list_active",
    );
    assert.equal(
      liveStateRequirement("status tugas biologi yang tadi gimana?")?.capabilityId,
      "task.list_active",
    );
    assert.equal(
      liveStateRequirement("pengingat Biologi sudah dikirim belum?")?.capabilityId,
      "task.list_active",
    );
    assert.equal(liveStateRequirement("jelaskan status sesi HTTP"), null);
  });

  it("parser hanya menerima action dari registry callable dan schema keputusan tertutup", () => {
    const allowed = new Set(["settings.time.get"]);
    assert.deepEqual(
      parseAgentPlannerDecision(
        '{"kind":"action","capabilityId":"settings.time.get","capabilityVersion":"1","input":{}}',
        allowed,
      ),
      {
        kind: "action",
        capabilityId: "settings.time.get",
        capabilityVersion: "1",
        input: {},
      },
    );
    assert.equal(
      parseAgentPlannerDecision(
        '{"kind":"action","capabilityId":"task.manage","capabilityVersion":"1","input":{}}',
        allowed,
      ),
      null,
    );
    assert.equal(
      parseAgentPlannerDecision('{"kind":"final","reply":"ok","tool":"fake"}'),
      null,
    );
  });

  it("fast path waktu hanya menangkap pertanyaan yang berdiri sendiri", () => {
    assert.equal(isDirectTimeQuestion("Sekarang jam berapa?"), true);
    assert.equal(isDirectTimeQuestion("Sekarang tanggal berapa?"), true);
    assert.equal(isDirectTimeQuestion("jam berapa final bolanya?"), false);
    const reply = deterministicTimeReply(
      new Date("2026-08-04T05:00:00.000Z"),
      "Asia/Jakarta",
    );
    assert.match(reply, /12[.:]00/u);
    assert.match(reply, /Asia\/Jakarta/u);

    const sameDayInWib = deterministicTimeReply(
      new Date("2026-08-04T16:30:00.000Z"),
      "Asia/Jakarta",
    );
    assert.match(sameDayInWib, /Selasa/iu);
    assert.match(sameDayInWib, /4 Agustus 2026/u);
    assert.match(sameDayInWib, /23[.:]30/u);

    const nextDayInWit = deterministicTimeReply(
      new Date("2026-08-04T16:30:00.000Z"),
      "Asia/Jayapura",
    );
    assert.match(nextDayInWit, /Rabu/iu);
    assert.match(nextDayInWit, /5 Agustus 2026/u);
    assert.match(nextDayInWit, /01[.:]30/u);
    assert.match(nextDayInWit, /Asia\/Jayapura/u);
  });
});

describe("agent harness runtime contract", () => {
  it("planner hanya melihat capability yang available sekaligus punya executor", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
      virtualTerminalInstalled: true,
    }));
    let callableIds: string[] = [];
    let taskFeatureAvailable = false;
    const result = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "cek",
      executors: [fakeExecutor("settings.time.get")],
      planner: async (input) => {
        callableIds = input.callableCapabilities.map((entry) => entry.id);
        taskFeatureAvailable = input.capabilities.entries.some(
          (entry) => entry.id === "task.list_active" && entry.available,
        );
        return { kind: "final", reply: "selesai" };
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(callableIds, ["settings.time.get"]);
    assert.equal(taskFeatureAvailable, true);
  });

  it("deadline absolut tidak dimulai ulang ketika checkpoint dilanjutkan", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog());
    let current = new Date("2026-08-04T05:00:00.000Z");
    const scope = privateAgentScope("telegram", "student");
    const paused = await harness.run({
      scope,
      request: "butuh jawaban",
      limits: { deadlineMs: 1_000 },
      now: () => current,
      planner: async () => ({ kind: "need_input", prompt: "Detailnya?" }),
    });
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;
    current = new Date("2026-08-04T05:00:02.000Z");
    let planned = false;
    const resumed = await harness.run({
      scope,
      request: "butuh jawaban",
      limits: { deadlineMs: 10_000 },
      now: () => current,
      checkpoint: paused.checkpoint,
      answer: "ini detailnya",
      planner: async () => {
        planned = true;
        return { kind: "final", reply: "tidak boleh tercapai" };
      },
    });
    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") assert.equal(resumed.reason, "deadline");
    assert.equal(planned, false);
  });

  it("memisahkan budget invocation dari jendela jawaban manusia", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog());
    let current = new Date("2026-08-04T05:00:00.000Z");
    const scope = privateAgentScope("telegram", "student");
    const paused = await harness.run({
      scope,
      request: "butuh jawaban",
      limits: { deadlineMs: 1_000, resumeWindowMs: 10_000 },
      now: () => current,
      planner: async () => ({ kind: "need_input", prompt: "Detailnya?" }),
    });
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;

    current = new Date("2026-08-04T05:00:02.000Z");
    const resumed = await harness.run({
      scope,
      request: "butuh jawaban",
      limits: { deadlineMs: 1_000, resumeWindowMs: 10_000 },
      now: () => current,
      checkpoint: paused.checkpoint,
      answer: "ini detailnya",
      planner: async () => ({ kind: "final", reply: "selesai" }),
    });
    assert.equal(resumed.status, "completed");
    assert.equal(
      paused.checkpoint.deadlineAt,
      "2026-08-04T05:00:10.000Z",
    );
  });

  it("mengikat checkpoint need_input ke owner dan horizon absolut sepuluh menit", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog());
    const startedAt = new Date("2026-08-04T05:00:00.000Z");
    const request = "butuh rentang";
    const paused = await harness.run({
      scope: privateAgentScope("telegram", "alice"),
      request,
      limits: { deadlineMs: 45_000, resumeWindowMs: 10 * 60 * 1_000 },
      now: () => startedAt,
      planner: async () => ({ kind: "need_input", prompt: "Berapa hari?" }),
    });
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;
    assert.equal(
      Date.parse(paused.checkpoint.deadlineAt) - Date.parse(paused.checkpoint.startedAt),
      10 * 60 * 1_000,
    );

    let planned = false;
    const foreignOwner = await harness.run({
      scope: privateAgentScope("telegram", "bob"),
      request,
      checkpoint: paused.checkpoint,
      answer: "21 hari",
      now: () => new Date("2026-08-04T05:01:00.000Z"),
      planner: async () => {
        planned = true;
        return { kind: "final", reply: "tidak boleh" };
      },
    });
    assert.equal(foreignOwner.status, "stopped");
    if (foreignOwner.status === "stopped") {
      assert.equal(foreignOwner.reason, "invalid_checkpoint");
    }
    assert.equal(planned, false);
  });

  it("tidak meminta input bila tidak ada langkah tersisa untuk memakainya", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog());
    const result = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "butuh detail",
      limits: { maxSteps: 1 },
      planner: async () => ({ kind: "need_input", prompt: "Detailnya?" }),
    });
    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "max_steps");
  });

  it("checkpoint tidak dapat memperoleh executor baru ketika dilanjutkan", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
      parallelDelegationInstalled: true,
    }));
    const paused = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "rencanakan",
      executors: [fakeExecutor("settings.time.get")],
      planner: async () => ({ kind: "need_input", prompt: "Bagian mana?" }),
    });
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;

    const resumed = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "rencanakan",
      executors: [
        fakeExecutor("settings.time.get"),
        fakeExecutor("agent.delegate.parallel"),
      ],
      planner: async () => ({ kind: "final", reply: "tidak boleh" }),
      checkpoint: paused.checkpoint,
      answer: "belajar",
    });
    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") {
      assert.equal(resumed.reason, "capability_changed");
    }
  });
});

describe("parallel delegation executor", () => {
  it("menjalankan tiga worker overlap dan mengikat tier pada cheap/efficient", async () => {
    let active = 0;
    let maximum = 0;
    const tiers: string[] = [];
    const worker: AgentWorker = async (task, context) => {
      assert.equal(context.ownerId, "student");
      active += 1;
      maximum = Math.max(maximum, active);
      tiers.push(task.tier);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return `hasil ${task.id}`;
    };
    const executor = new ParallelDelegationExecutor(worker, 3);
    const input = executor.validate({ tasks: [
      { id: "satu", instruction: "analisis satu", tier: "cheap" },
      { id: "dua", instruction: "analisis dua", tier: "efficient" },
      { id: "tiga", instruction: "analisis tiga", tier: "cheap" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;
    const result = await executor.execute(input.value, executionContext());
    const payload = JSON.parse(result.summary) as {
      depth: number;
      recursiveDelegation: boolean;
      succeeded: number;
    };
    assert.equal(result.status, "ok");
    assert.equal(maximum, 3);
    assert.deepEqual(tiers.sort(), ["cheap", "cheap", "efficient"]);
    assert.equal(payload.depth, 1);
    assert.equal(payload.recursiveDelegation, false);
    assert.equal(payload.succeeded, 3);
  });

  it("menjaga ringkasan tiga worker panjang tetap JSON valid dan adil", async () => {
    const executor = new ParallelDelegationExecutor(
      async (task) => `${task.id}:${"\\\n\u0000".repeat(1_000)}`,
    );
    const input = executor.validate({ tasks: [
      { id: "satu", instruction: "satu", tier: "cheap" },
      { id: "dua", instruction: "dua", tier: "efficient" },
      { id: "tiga", instruction: "tiga", tier: "cheap" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;

    const result = await executor.execute(input.value, executionContext());
    const summary = JSON.parse(result.summary) as {
      results: Array<{ id: string; output: string; truncated: boolean }>;
    };
    assert.equal(result.summary.length < 4_000, true);
    assert.deepEqual(summary.results.map((item) => item.id), ["satu", "dua", "tiga"]);
    assert.equal(summary.results.every((item) => item.truncated), true);
  });

  it("menyelesaikan sibling dan melaporkan hasil parsial dengan jujur", async () => {
    let siblingFinished = false;
    const executor = new ParallelDelegationExecutor(async (task) => {
      if (task.id === "gagal") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("provider timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      siblingFinished = true;
      return "berhasil";
    });
    const input = executor.validate({ tasks: [
      { id: "gagal", instruction: "satu", tier: "cheap" },
      { id: "aman", instruction: "dua", tier: "efficient" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;
    const result = await executor.execute(input.value, executionContext());
    const payload = JSON.parse(result.summary) as {
      partial: boolean;
      succeeded: number;
      results: Array<{ id: string; status: string }>;
    };
    assert.equal(result.status, "ok");
    assert.equal(siblingFinished, true);
    assert.equal(payload.partial, true);
    assert.equal(payload.succeeded, 1);
    assert.deepEqual(payload.results.map((entry) => [entry.id, entry.status]), [
      ["gagal", "error"],
      ["aman", "ok"],
    ]);
  });

  it("menolak fanout, ID duplikat, tier ambitious, dan field scope buatan", () => {
    const executor = new ParallelDelegationExecutor(async () => "ok");
    assert.equal(executor.validate({ tasks: [
      { id: "satu", instruction: "x", tier: "cheap" },
    ] }).ok, false);
    assert.equal(executor.validate({ tasks: [
      { id: "sama", instruction: "x", tier: "cheap" },
      { id: "sama", instruction: "y", tier: "efficient" },
    ] }).ok, false);
    assert.equal(executor.validate({ tasks: [
      { id: "satu", instruction: "x", tier: "ambitious" },
      { id: "dua", instruction: "y", tier: "cheap" },
    ] }).ok, false);
    assert.equal(executor.validate({
      tasks: [
        { id: "satu", instruction: "x", tier: "cheap" },
        { id: "dua", instruction: "y", tier: "cheap" },
      ],
      ownerId: "victim",
    }).ok, false);
  });

  it("menolak wave delegasi setelah langkah nol tanpa memanggil worker", async () => {
    let workerCalls = 0;
    const executor = new ParallelDelegationExecutor(async () => {
      workerCalls += 1;
      return "tidak boleh";
    });
    const input = executor.validate({ tasks: [
      { id: "satu", instruction: "x", tier: "cheap" },
      { id: "dua", instruction: "y", tier: "efficient" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;

    const result = await executor.execute(input.value, executionContext(1));
    assert.equal(result.status, "error");
    assert.equal(workerCalls, 0);
  });
});

function fakeExecutor(capabilityId: string): AgentCapabilityExecutor<Record<string, never>> {
  return {
    capabilityId,
    capabilityVersion: "1",
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ status: "ok", summary: "{}" }),
  };
}

function executionContext(step = 0): AgentExecutionContext {
  return {
    runId: "run",
    step,
    scope: privateAgentScope("telegram", "student"),
    idempotencyKey: "idempotent",
    signal: new AbortController().signal,
  };
}
