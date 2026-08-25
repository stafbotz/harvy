import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentHarness,
  type AgentCapabilityExecutor,
  type AgentPlanner,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope } from "../src/harness/scope.js";
import { UsageLimitError } from "../src/core/telemetry-service.js";

const FIXED_NOW = () => new Date("2026-07-31T10:00:00.000Z");

describe("agent harness", () => {
  it("menolak budget observation yang tidak dapat memuat evidence envelope", async () => {
    await assert.rejects(
      harness().run({
        scope: privateAgentScope("telegram", "1"),
        request: "buat rencana",
        planner: async () => ({ kind: "final", reply: "selesai" }),
        limits: { maxObservationCharacters: 95 },
        now: FIXED_NOW,
      }),
      /Batas observation agent minimal 96 karakter/u,
    );
  });

  it("menanam input code-owned ke checkpoint pertama", async () => {
    const seen: string[] = [];
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana belajar",
      initialUserInputs: [{
        step: 0,
        prompt: "Perubahan instruksi sampai revision 2",
        text: "constraint: Jumat sore ada basket.",
      }],
      planner: async ({ userInputs }) => {
        seen.push(...userInputs.map((input) => input.text));
        return { kind: "final", reply: "Rencana sudah disesuaikan." };
      },
      now: FIXED_NOW,
      makeRunId: () => "run-seeded-input",
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(seen, ["constraint: Jumat sore ada basket."]);
    assert.deepEqual(result.checkpoint.userInputs, [{
      step: 0,
      prompt: "Perubahan instruksi sampai revision 2",
      text: "constraint: Jumat sore ada basket.",
    }]);
  });

  it("menolak capability yang tidak tersedia lalu memberi model satu observasi", async () => {
    let executed = false;
    const planner: AgentPlanner = async ({ observations }) =>
      observations.length === 0
        ? {
            kind: "action",
            capabilityId: "external.act",
            capabilityVersion: "1",
            input: { query: "berita" },
          }
        : { kind: "final", reply: "Aku belum bisa mencari web langsung." };

    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "cari berita",
      planner,
      executors: [
        {
          capabilityId: "external.act",
          capabilityVersion: "1",
          validate: () => ({ ok: true, value: {} }),
          execute: async () => {
            executed = true;
            return { status: "ok", summary: "tidak boleh terjadi" };
          },
        },
      ],
      now: FIXED_NOW,
      makeRunId: () => "run-1",
    });

    assert.equal(result.status, "completed");
    assert.equal(executed, false);
    assert.equal(result.checkpoint.observations[0]?.status, "unavailable");
  });

  it("pause dan resume approval mengikat aksi persis serta mengeksekusi sekali", async () => {
    const idempotencyKeys: string[] = [];
    const executor: AgentCapabilityExecutor<{ content: string }> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: (input) =>
        typeof (input as { content?: unknown })?.content === "string"
          ? {
              ok: true,
              value: { content: (input as { content: string }).content },
            }
          : { ok: false, reason: "content wajib string" },
      execute: async (_value, context) => {
        idempotencyKeys.push(context.idempotencyKey);
        return { status: "ok", summary: "Memori tersimpan." };
      },
    };
    const planner: AgentPlanner = async ({ observations }) =>
      observations.length === 0
        ? {
            kind: "action",
            capabilityId: "memory.scoped",
            capabilityVersion: "1",
            input: { content: "Suka biologi" },
          }
        : { kind: "final", reply: "Sudah kuingat." };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat aku suka biologi",
      planner,
      executors: [executor],
      now: FIXED_NOW,
      makeRunId: () => "run-approval",
    } as const;

    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;

    const tampered = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: `${paused.approval.binding}-beda`,
        approvedAt: FIXED_NOW().toISOString(),
      },
    });
    assert.equal(tampered.status, "needs_approval");
    assert.equal(idempotencyKeys.length, 0);

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
    });
    assert.equal(resumed.status, "completed");
    assert.equal(idempotencyKeys.length, 1);
    assert.equal(idempotencyKeys[0]?.length, 64);
  });

  it("menolak timestamp approval yang rusak atau berasal dari masa depan", async () => {
    const planner: AgentPlanner = async () => ({
      kind: "action",
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      input: { content: "Suka biologi" },
    });
    const executor: AgentCapabilityExecutor<{ content: string }> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: () => ({ ok: true, value: { content: "Suka biologi" } }),
      execute: async () => ({ status: "ok", summary: "tersimpan" }),
    };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      executors: [executor],
      now: FIXED_NOW,
      makeRunId: () => "run-time-binding",
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;

    for (const approvedAt of ["bukan-tanggal", "2026-08-01T10:00:00.000Z"]) {
      const result = await harness().run({
        ...common,
        checkpoint: paused.checkpoint,
        approval: { binding: paused.approval.binding, approvedAt },
      });
      assert.equal(result.status, "needs_approval");
    }
  });

  it("menolak checkpoint approval bila input aksinya diubah setelah pause", async () => {
    let executions = 0;
    const planner: AgentPlanner = async () => ({
      kind: "action",
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      input: { content: "asli" },
    });
    const executor: AgentCapabilityExecutor<{ content: string }> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: (input) => ({
        ok: true,
        value: input as { content: string },
      }),
      execute: async () => {
        executions += 1;
        return { status: "ok", summary: "tersimpan" };
      },
    };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      executors: [executor],
      now: FIXED_NOW,
      makeRunId: () => "run-tamper",
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;
    const checkpoint = structuredClone(paused.checkpoint);
    if (checkpoint.pending) checkpoint.pending.proposal.input = { content: "diubah" };

    const result = await harness().run({
      ...common,
      checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "invalid_checkpoint");
    }
    assert.equal(executions, 0);
  });

  it("mengeksekusi nilai tervalidasi yang persis disetujui tanpa validasi ulang", async () => {
    let validations = 0;
    let executed = "";
    const executor: AgentCapabilityExecutor<{ content: string }> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: () => {
        validations += 1;
        return {
          ok: true,
          value: { content: validations === 1 ? "nilai-disetujui" : "berubah" },
        };
      },
      execute: async (value) => {
        executed = value.content;
        return { status: "ok", summary: "tersimpan" };
      },
    };
    const planner: AgentPlanner = async ({ observations }) =>
      observations.length === 0
        ? {
            kind: "action",
            capabilityId: "memory.scoped",
            capabilityVersion: "1",
            input: { content: "mentah" },
          }
        : { kind: "final", reply: "selesai" };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      executors: [executor],
      now: FIXED_NOW,
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
    });

    assert.equal(resumed.status, "completed");
    assert.equal(validations, 1);
    assert.equal(executed, "nilai-disetujui");
  });

  it("tidak membiarkan policy memutasi nilai yang kemudian dieksekusi", async () => {
    let executed = "";
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner: async ({ observations }) =>
        observations.length === 0
          ? {
              kind: "action",
              capabilityId: "memory.scoped",
              capabilityVersion: "1",
              input: { content: "mentah" },
            }
          : { kind: "final", reply: "selesai" },
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: { content: "tervalidasi" } }),
        execute: async (value: { content: string }) => {
          executed = value.content;
          return { status: "ok", summary: "tersimpan" };
        },
      }],
      policy: ({ value }) => {
        (value as { content: string }).content = "dimutasi-policy";
        return { decision: "allow" };
      },
      now: FIXED_NOW,
    });

    assert.equal(result.status, "completed");
    assert.equal(executed, "tervalidasi");
  });

  it("memeriksa generation lagi setelah policy sebelum executor dimulai", async () => {
    let current = true;
    let executions = 0;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner: async () => ({
        kind: "action",
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        input: {},
      }),
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: {} }),
        execute: async () => {
          executions += 1;
          return { status: "ok", summary: "tidak boleh" };
        },
      }],
      policy: () => {
        current = false;
        return { decision: "allow" };
      },
      isCurrent: () => current,
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "stale");
    assert.equal(executions, 0);
  });

  it("tidak memulai executor bila freshness check membatalkan signal", async () => {
    const controller = new AbortController();
    let freshnessChecks = 0;
    let executions = 0;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner: async () => ({
        kind: "action",
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        input: {},
      }),
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: {} }),
        execute: async () => {
          executions += 1;
          return { status: "ok", summary: "tidak boleh" };
        },
      }],
      policy: () => ({ decision: "allow" }),
      isCurrent: () => {
        freshnessChecks += 1;
        if (freshnessChecks >= 4) controller.abort();
        return true;
      },
      signal: controller.signal,
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "cancelled");
    }
    assert.equal(executions, 0);
  });

  it("menolak resume approval yang basi sebelum executor dipanggil", async () => {
    let executions = 0;
    const executor: AgentCapabilityExecutor<Record<string, never>> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        executions += 1;
        return { status: "ok", summary: "tersimpan" };
      },
    };
    const planner: AgentPlanner = async () => ({
      kind: "action",
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      input: {},
    });
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      executors: [executor],
      now: FIXED_NOW,
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
      isCurrent: () => false,
    });

    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") assert.equal(resumed.reason, "stale");
    assert.equal(executions, 0);
  });

  it("menolak resume yang sudah dibatalkan sebelum executor dipanggil", async () => {
    let executions = 0;
    const executor: AgentCapabilityExecutor<Record<string, never>> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => {
        executions += 1;
        return { status: "ok", summary: "tersimpan" };
      },
    };
    const planner: AgentPlanner = async () => ({
      kind: "action",
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      input: {},
    });
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      executors: [executor],
      now: FIXED_NOW,
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;
    const controller = new AbortController();
    controller.abort();

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
      signal: controller.signal,
    });

    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") {
      assert.equal(resumed.reason, "cancelled");
    }
    assert.equal(executions, 0);
  });

  it("tidak menukar executor ke versi lain ketika approval dilanjutkan", async () => {
    let executions = 0;
    const planner: AgentPlanner = async ({ observations }) =>
      observations.length === 0
        ? {
            kind: "action",
            capabilityId: "memory.scoped",
            capabilityVersion: "1",
            input: {},
          }
        : { kind: "final", reply: "executor berubah" };
    const firstExecutor: AgentCapabilityExecutor<Record<string, never>> = {
      capabilityId: "memory.scoped",
      capabilityVersion: "1",
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ status: "ok", summary: "tersimpan" }),
    };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner,
      now: FIXED_NOW,
    } as const;
    const paused = await harness().run({
      ...common,
      executors: [firstExecutor],
    });
    assert.equal(paused.status, "needs_approval");
    if (paused.status !== "needs_approval") return;

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      approval: {
        binding: paused.approval.binding,
        approvedAt: FIXED_NOW().toISOString(),
      },
      executors: [{
        ...firstExecutor,
        capabilityVersion: "2",
        execute: async () => {
          executions += 1;
          return { status: "ok", summary: "tidak boleh" };
        },
      }],
    });

    assert.equal(resumed.status, "stopped");
    if (resumed.status === "stopped") {
      assert.equal(resumed.reason, "capability_changed");
    }
    assert.equal(executions, 0);
  });

  it("menolak input planner yang bukan nilai JSON", async () => {
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "tes input",
      planner: async () => ({
        kind: "action",
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        input: { callback: () => undefined },
      }),
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "invalid_planner_output");
    }
  });

  it("tidak menyamarkan penolakan kapasitas sebagai output planner rusak", async () => {
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana panjang",
      planner: async () => {
        throw new UsageLimitError("anti_abuse");
      },
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "usage_anti_abuse");
    }
  });

  it("menganggap hasil policy rusak sebagai penolakan, bukan izin", async () => {
    let executed = false;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner: async ({ observations }) =>
        observations.length === 0
          ? {
              kind: "action",
              capabilityId: "memory.scoped",
              capabilityVersion: "1",
              input: {},
            }
          : { kind: "final", reply: "ditolak" },
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: {} }),
        execute: async () => {
          executed = true;
          return { status: "ok", summary: "tidak boleh" };
        },
      }],
      policy: (async () => undefined) as never,
      now: FIXED_NOW,
    });

    assert.equal(result.status, "completed");
    assert.equal(executed, false);
    assert.equal(result.checkpoint.observations[0]?.status, "denied");
  });

  it("membatasi policy yang menggantung dengan deadline run", async () => {
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ingat ini",
      planner: async () => ({
        kind: "action",
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        input: {},
      }),
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({ status: "ok", summary: "tidak boleh" }),
      }],
      policy: async () => new Promise<never>(() => undefined),
      limits: { deadlineMs: 10 },
      now: () => new Date(),
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "deadline");
  });

  it("melanjutkan need_input pada checkpoint yang sama", async () => {
    let resumedInput: { step: number; prompt?: string; text: string } | undefined;
    const planner: AgentPlanner = async ({ userInputs }) => {
      if (userInputs.length === 0) {
        return { kind: "need_input", prompt: "Jam berapa?" };
      }
      resumedInput = userInputs[0];
      return { kind: "final", reply: `Oke, ${userInputs[0]?.text}.` };
    };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "ingatkan aku",
      planner,
      now: FIXED_NOW,
      makeRunId: () => "run-input",
    } as const;
    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;

    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      answer: "jam delapan",
    });
    assert.equal(resumed.status, "completed");
    if (resumed.status === "completed") {
      assert.equal(resumed.reply, "Oke, jam delapan.");
    }
    assert.deepEqual(resumedInput, {
      step: 0,
      prompt: "Jam berapa?",
      text: "jam delapan",
    });
  });

  it("menghentikan proposal identik agar loop tidak berputar", async () => {
    const planner: AgentPlanner = async () => ({
      kind: "action",
      capabilityId: "external.act",
      capabilityVersion: "1",
      input: { query: "sama" },
    });
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "ulang terus",
      planner,
      now: FIXED_NOW,
      makeRunId: () => "run-cycle",
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "cycle");
  });

  it("membuang hasil yang datang setelah generation guard menjadi basi", async () => {
    let current = true;
    const planner: AgentPlanner = async () => {
      current = false;
      return { kind: "final", reply: "hasil lama" };
    };
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "tes",
      planner,
      isCurrent: () => current,
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "stale");
  });

  it("menghentikan tool sebelum executor ketika budget tool-call habis", async () => {
    let executed = false;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "simpan",
      planner: async () => ({
        kind: "action",
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        input: { content: "uji" },
      }),
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: { content: "uji" } }),
        execute: async () => {
          executed = true;
          return { status: "ok", summary: "tersimpan" };
        },
      }],
      policy: () => ({ decision: "allow" }),
      runBudget: { limits: { maxToolCalls: 0 } },
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "budget_tool_calls");
    }
    assert.equal(executed, false);
    assert.equal(result.checkpoint.runBudget?.toolCalls, 0);
  });

  it("tidak mengotorisasi atau menjalankan tool setelah usage aktual over budget", async () => {
    let authorized = false;
    let executed = false;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "simpan",
      planner: async (_input, _signal, budget) => {
        budget.reserveModelCall({
          tier: "cheap",
          inputTokenEstimate: 1,
          maxOutputTokens: 1,
        }).settle({
          inputTokens: 10,
          outputTokens: 1,
          totalTokens: 11,
          estimated: false,
        });
        return {
          kind: "action",
          capabilityId: "memory.scoped",
          capabilityVersion: "1",
          input: { content: "uji" },
        };
      },
      executors: [{
        capabilityId: "memory.scoped",
        capabilityVersion: "1",
        validate: () => ({ ok: true, value: { content: "uji" } }),
        execute: async () => {
          executed = true;
          return { status: "ok", summary: "tersimpan" };
        },
      }],
      policy: () => {
        authorized = true;
        return { decision: "allow" };
      },
      runBudget: { limits: { maxTotalTokens: 10 } },
      now: FIXED_NOW,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "budget_tokens");
    }
    assert.equal(authorized, false);
    assert.equal(executed, false);
  });

  it("membawa token kumulatif melewati checkpoint waiting-input", async () => {
    const remaining: number[] = [];
    const planner: AgentPlanner = async (input, _signal, budget) => {
      remaining.push(input.budget.remainingTokens);
      if (remaining.length === 1) {
        budget.reserveModelCall({
          tier: "cheap",
          inputTokenEstimate: 5,
          maxOutputTokens: 15,
        }).settle({
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
          estimated: false,
        });
        return { kind: "need_input", prompt: "Topik apa?" };
      }
      return { kind: "final", reply: "Selesai." };
    };
    const common = {
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana",
      planner,
      runBudget: {
        limits: {
          maxTotalTokens: 100,
          maxModelCalls: 4,
        },
      },
      now: FIXED_NOW,
    } as const;

    const paused = await harness().run(common);
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;
    assert.equal(paused.checkpoint.runBudget?.consumedTokens, 10);
    const resumed = await harness().run({
      ...common,
      checkpoint: paused.checkpoint,
      answer: "Matematika",
    });

    assert.equal(resumed.status, "completed");
    assert.deepEqual(remaining, [100, 90]);
    assert.equal(resumed.checkpoint.runBudget?.consumedTokens, 10);
  });

  it("memigrasikan checkpoint lama dengan charge konservatif", async () => {
    const paused = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana",
      planner: async () => ({ kind: "need_input", prompt: "Topik apa?" }),
      now: FIXED_NOW,
    });
    assert.equal(paused.status, "needs_input");
    if (paused.status !== "needs_input") return;
    const missingBudget = structuredClone(paused.checkpoint);
    delete missingBudget.runBudget;
    const rejected = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana",
      planner: async () => ({ kind: "final", reply: "tidak boleh" }),
      checkpoint: missingBudget,
      answer: "Matematika",
      now: FIXED_NOW,
    });
    assert.equal(rejected.status, "stopped");
    if (rejected.status === "stopped") {
      assert.equal(rejected.reason, "invalid_checkpoint");
    }
    const legacy = structuredClone(paused.checkpoint);
    legacy.version = 1;
    delete legacy.runBudget;

    const resumed = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana",
      planner: async () => ({ kind: "need_input", prompt: "Jenjang apa?" }),
      checkpoint: legacy,
      answer: "Matematika",
      limits: { maxSteps: 3 },
      now: FIXED_NOW,
    });

    assert.equal(resumed.status, "needs_input");
    assert.equal(resumed.checkpoint.runBudget?.modelCalls, 1);
    assert.equal(resumed.checkpoint.maxSteps, 3);
    assert.equal(resumed.checkpoint.runBudget?.limits.maxSteps, 3);
    assert.equal(resumed.checkpoint.runBudget?.consumedTokens, 8_192);
    assert.equal(resumed.checkpoint.runBudget?.unknownUsageAttempts, 1);
    if (resumed.status !== "needs_input") return;

    const completed = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "buat rencana",
      planner: async () => ({ kind: "final", reply: "Selesai." }),
      checkpoint: resumed.checkpoint,
      answer: "SMA",
      limits: { maxSteps: 3 },
      now: FIXED_NOW,
    });
    assert.equal(completed.status, "completed");
  });

  it("mengatribusikan batas aktif yang lebih ketat ke RunBudget", async () => {
    const base = Date.parse("2026-07-31T10:00:00.000Z");
    let elapsed = 0;
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "tes budget deadline",
      planner: async () => {
        elapsed = 11;
        return { kind: "final", reply: "terlambat" };
      },
      limits: { deadlineMs: 1_000 },
      runBudget: { limits: { deadlineMs: 10 } },
      now: () => new Date(base + elapsed),
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "budget_deadline");
    }
  });

  it("menghentikan planner yang melewati deadline run", async () => {
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "tes deadline",
      planner: async () => new Promise<never>(() => undefined),
      limits: { deadlineMs: 10 },
      now: () => new Date(),
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.reason, "deadline");
  });

  it("mengatribusikan watchdog planner ke deadline RunBudget yang lebih ketat", async () => {
    const base = new Date("2026-07-31T10:00:00.000Z");
    const result = await harness().run({
      scope: privateAgentScope("telegram", "1"),
      request: "tes budget watchdog",
      planner: async () => new Promise<never>(() => undefined),
      limits: { deadlineMs: 1_000 },
      runBudget: { limits: { deadlineMs: 10 } },
      // Clock wall sengaja tidak maju; AbortSignal memakai clock monotonic.
      now: () => base,
    });

    assert.equal(result.status, "stopped");
    if (result.status === "stopped") {
      assert.equal(result.reason, "budget_deadline");
    }
  });
});

function harness(): AgentHarness {
  return new AgentHarness(createHarvyCapabilityCatalog());
}
