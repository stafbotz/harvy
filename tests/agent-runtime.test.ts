import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ParallelDelegationExecutor,
  type AgentWorker,
} from "../src/agent/parallel-delegation.js";
import {
  canUseDirectTimeFastPath,
  deterministicTimeReply,
  isDirectTimeQuestion,
} from "../src/agent/time-fast-path.js";
import {
  agentNativeTools,
  agentPlannerPrompt,
  liveStateRequirement,
  parseAgentAutoDecision,
  parseAgentNativeDecision,
} from "../src/ai/agent.js";
import { selectAgentMode } from "../src/ai/model-policy.js";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentExecutionContext,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope } from "../src/harness/scope.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { deriveReplyStructureContract } from "../src/core/reply-structure-contract.js";

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

  it("native tools hanya berasal dari registry callable dan parser gagal tertutup", () => {
    const callable = [{
      id: "settings.time.get",
      version: "1",
      effect: "read" as const,
      description: "Baca pengaturan waktu.",
      nativeTool: {
        name: "harvy_settings_time_get_v1",
        description: "Baca pengaturan waktu.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    }];
    const tools = agentNativeTools(callable);
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      [
        "harvy_final_v1",
        "harvy_need_input_v1",
        "harvy_settings_time_get_v1",
      ],
    );
    assert.equal(
      tools.some((tool) => tool.function.name.includes("task_manage")),
      false,
    );
    assert.deepEqual(
      parseAgentNativeDecision([nativeCall(
        "harvy_settings_time_get_v1",
        {},
      )], callable),
      {
        kind: "action",
        capabilityId: "settings.time.get",
        capabilityVersion: "1",
        input: {},
      },
    );
    assert.equal(
      parseAgentNativeDecision([nativeCall("harvy_task_manage_v1", {})], callable),
      null,
    );
    assert.equal(
      parseAgentNativeDecision([
        nativeCall("harvy_final_v1", { reply: "ok" }),
        nativeCall("harvy_settings_time_get_v1", {}),
      ], callable),
      null,
    );
    assert.equal(
      parseAgentNativeDecision([{
        ...nativeCall("harvy_final_v1", { reply: "ok" }),
        function: {
          name: "harvy_final_v1",
          arguments: '{"reply":"ok","tool":"fake"}',
        },
      }], callable),
      null,
    );
    assert.equal(
      parseAgentNativeDecision([nativeCall("harvy_final_v1", { reply: "  " })], callable),
      null,
    );
    assert.equal(
      parseAgentNativeDecision([
        nativeCall("harvy_need_input_v1", { prompt: "\n" }),
      ], callable),
      null,
    );
  });

  it("mengganti final bebas dengan final langkah terstruktur saat kontrak exact ada", () => {
    const contract = deriveReplyStructureContract(
      "Susun mendalam tepat dua langkah. Pada setiap langkah, tulis: Tindakan dan Kriteria lulus.",
    );
    assert.ok(contract);
    const tools = agentNativeTools([], contract);
    assert.deepEqual(tools.map((tool) => tool.function.name), [
      "harvy_structured_steps_v1",
      "harvy_need_input_v1",
    ]);
    const decision = parseAgentNativeDecision([
      nativeCall("harvy_structured_steps_v1", {
        steps: [
          {
            title: "Periksa alur utama",
            field_1: "Jalankan alur utama menggunakan akun acceptance nyata dari awal sampai terminal.\n2. Catat subaktivitas sebagai bagian field yang sama.",
            field_2: "Lulus bila seluruh tahap muncul satu kali dan urutannya sesuai kontrak produk.",
          },
          {
            title: "Periksa pemulihan",
            field_1: "Mulai pekerjaan lalu nyalakan ulang runtime sebelum status terminal tercapai.",
            field_2: "Lulus bila pekerjaan pulih tanpa hasil ganda dan anchor lama tetap digunakan.",
          },
        ],
      }),
    ], [], contract);

    assert.equal(decision?.kind, "final");
    if (decision?.kind === "final") {
      assert.match(decision.reply, /^1\. Periksa alur utama/mu);
      assert.match(decision.reply, /Tindakan:/u);
      assert.match(decision.reply, /Kriteria lulus:/u);
      assert.match(decision.reply, /^2\. Periksa pemulihan/mu);
      assert.equal((decision.reply.match(/^\d+[.)]\s/gmu) ?? []).length, 2);
    }
    assert.equal(
      parseAgentNativeDecision([
        nativeCall("harvy_final_v1", { reply: "Jawaban dangkal." }),
      ], [], contract),
      null,
    );
  });

  it("kontrak auto menerima teks sebagai final dan tetap menolak yang kosong", () => {
    const callable = [{
      id: "task.list_active",
      version: "1",
      effect: "read" as const,
      description: "Baca tugas aktif.",
      nativeTool: {
        name: "harvy_task_list_active_v1",
        description: "Baca tugas aktif.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    }];

    assert.deepEqual(
      parseAgentAutoDecision(
        { kind: "text", content: "  Aku di sini.  " },
        callable,
      ),
      { kind: "final", reply: "Aku di sini." },
    );
    assert.equal(
      parseAgentAutoDecision({ kind: "text", content: "   " }, callable),
      null,
    );

    const calls = [nativeCall("harvy_task_list_active_v1", {})];
    assert.deepEqual(
      parseAgentAutoDecision({
        kind: "tool_calls",
        toolCalls: calls,
        assistant: { role: "assistant", content: null, tool_calls: calls },
      }, callable),
      {
        kind: "action",
        capabilityId: "task.list_active",
        capabilityVersion: "1",
        input: {},
      },
    );

    // Kontrak bentuk terstruktur tidak dapat dipenuhi teks bebas; kode harus
    // dapat memvalidasi jumlah langkah dan fieldnya.
    const contract = deriveReplyStructureContract(
      "Susun mendalam tepat dua langkah. Pada setiap langkah, tulis: Tindakan dan Kriteria lulus.",
    );
    assert.ok(contract);
    assert.equal(
      parseAgentAutoDecision(
        { kind: "text", content: "1. Langkah pertama" },
        callable,
        contract,
      ),
      null,
    );
  });

  it("prompt planner auto mengizinkan jawaban teks tanpa memanggil function", () => {
    const auto = agentPlannerPrompt([], null, "auto");
    assert.match(auto, /Seluruh tool di bawah tersedia pada setiap giliran/u);
    assert.match(
      auto,
      /jawab langsung dengan teks biasa tanpa memanggil function apa pun/u,
    );
    const required = agentPlannerPrompt([], null, "required");
    assert.match(required, /Pilih tepat satu langkah melalui satu native function call/u);
    assert.doesNotMatch(required, /tanpa memanggil function apa pun/u);
  });

  it("fast path waktu hanya menangkap pertanyaan yang berdiri sendiri", () => {
    assert.equal(isDirectTimeQuestion("Sekarang jam berapa?"), true);
    assert.equal(isDirectTimeQuestion("Sekarang tanggal berapa?"), true);
    assert.equal(isDirectTimeQuestion("harvy sekarang jam berapa"), true);
    assert.equal(isDirectTimeQuestion("Harvy, sekarang jam berapa?"), true);
    assert.equal(isDirectTimeQuestion("sekarang jam berapa, Harvy?"), true);
    assert.equal(isDirectTimeQuestion("HARVY: jam berapa sekarang?"), true);
    assert.equal(isDirectTimeQuestion("jam berapa final bolanya?"), false);
    assert.equal(isDirectTimeQuestion("Harvy, jam berapa final bolanya?"), false);
    assert.equal(
      isDirectTimeQuestion("Harvy sekarang jam berapa dan cuacanya?"),
      false,
    );
    assert.equal(isDirectTimeQuestion("menurut Harvy sekarang jam berapa?"), false);
    assert.equal(isDirectTimeQuestion("Harvy Harvy sekarang jam berapa?"), false);
    assert.equal(isDirectTimeQuestion("Harvy sekarang jam berapa untuk meeting?"), false);
    assert.equal(canUseDirectTimeFastPath("jam berapa?", []), true);
    assert.equal(
      canUseDirectTimeFastPath(
        "jam berapa?",
        [{ at: "2026-08-08T09:50:00.000Z" }],
        new Date("2026-08-08T10:00:00.000Z"),
      ),
      false,
    );
    assert.equal(
      canUseDirectTimeFastPath(
        "jam berapa?",
        [{ at: "2026-08-08T09:00:00.000Z" }],
        new Date("2026-08-08T10:00:00.000Z"),
      ),
      true,
    );
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

  it("mengikat nama dan schema native executor ke checkpoint callable", async () => {
    const harness = new AgentHarness(createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
    }));
    const firstExecutor = fakeNativeExecutor("settings.time.get", {
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    let exposedName = "";
    const paused = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "cek waktu",
      executors: [firstExecutor],
      planner: async (input) => {
        exposedName = input.callableCapabilities[0]?.nativeTool?.name ?? "";
        return { kind: "need_input", prompt: "Lanjut?" };
      },
    });
    assert.equal(paused.status, "needs_input");
    assert.equal(exposedName, "harvy_settings_time_get_v1");
    if (paused.status !== "needs_input") return;

    let planned = false;
    const resumed = await harness.run({
      scope: privateAgentScope("telegram", "student"),
      request: "cek waktu",
      executors: [fakeNativeExecutor("settings.time.get", {
        type: "object",
        additionalProperties: false,
        properties: { unexpected: { type: "string" } },
      })],
      checkpoint: paused.checkpoint,
      answer: "ya",
      planner: async () => {
        planned = true;
        return { kind: "final", reply: "tidak boleh" };
      },
    });
    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") {
      assert.equal(resumed.reason, "capability_changed");
    }
    assert.equal(planned, false);
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

  it("menjalankan delegasi yang sama pada WhatsApp privat", async () => {
    const owners: string[] = [];
    const channels: string[] = [];
    const executor = new ParallelDelegationExecutor(async (_task, context) => {
      owners.push(context.ownerId);
      channels.push(context.channel);
      return "ok";
    });
    const input = executor.validate({ tasks: [
      { id: "satu", instruction: "bandingkan opsi", tier: "cheap" },
      { id: "dua", instruction: "cek risiko", tier: "efficient" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;
    const waContext: AgentExecutionContext = {
      ...executionContext(),
      scope: privateAgentScope("whatsapp", "whatsapp-user:test"),
    };

    const result = await executor.execute(input.value, waContext);
    assert.equal(result.status, "ok");
    assert.deepEqual(owners, ["whatsapp-user:test", "whatsapp-user:test"]);
    assert.deepEqual(channels, ["whatsapp", "whatsapp"]);
  });

  it("mengikuti batas concurrency worker milik RunBudget", async () => {
    let active = 0;
    let maximum = 0;
    const executor = new ParallelDelegationExecutor(async (task) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `hasil ${task.id}`;
    }, 3);
    const input = executor.validate({ tasks: [
      { id: "satu", instruction: "satu", tier: "cheap" },
      { id: "dua", instruction: "dua", tier: "efficient" },
      { id: "tiga", instruction: "tiga", tier: "cheap" },
    ] });
    assert.equal(input.ok, true);
    if (!input.ok) return;
    const budget = new RunBudgetAccount({
      limits: { maxConcurrentWorkers: 1 },
    });

    const result = await executor.execute(
      input.value,
      executionContext(0, budget),
    );

    assert.equal(result.status, "ok");
    assert.equal(maximum, 1);

    active = 0;
    maximum = 0;
    const wideBudget = new RunBudgetAccount({
      limits: { maxConcurrentWorkers: 32 },
    });
    const wideResult = await executor.execute(
      input.value,
      executionContext(0, wideBudget),
    );
    assert.equal(wideResult.status, "ok");
    assert.equal(maximum, 3);
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

function fakeNativeExecutor(
  capabilityId: string,
  inputSchema: Readonly<Record<string, unknown>>,
): AgentCapabilityExecutor<Record<string, never>> {
  return {
    ...fakeExecutor(capabilityId),
    nativeTool: {
      name: `harvy_${capabilityId.replaceAll(".", "_")}_v1`,
      description: `Baca ${capabilityId}.`,
      inputSchema,
    },
  };
}

function executionContext(
  step = 0,
  runBudget = new RunBudgetAccount(),
): AgentExecutionContext {
  return {
    runId: "run",
    step,
    scope: privateAgentScope("telegram", "student"),
    idempotencyKey: "idempotent",
    signal: new AbortController().signal,
    runBudget,
  };
}

function nativeCall(
  name: string,
  input: Record<string, unknown>,
) {
  return {
    id: `call-${name}`,
    type: "function" as const,
    function: {
      name,
      arguments: JSON.stringify(input),
    },
  };
}
