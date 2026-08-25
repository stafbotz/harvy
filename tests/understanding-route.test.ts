import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Understanding } from "../src/ai/understand.js";
import { immediateUnderstandingRoute, taskToOffer } from "../src/bot/understanding-route.js";
import type {
  SemanticDomain,
  SemanticExplicitness,
  SemanticOperationName,
  SemanticReference,
} from "../src/domain/semantic-operation.js";

describe("routing hasil pemahaman di adapter bot", () => {
  it("membawa permintaan hasil langsung ke percakapan, bukan tugas", () => {
    const understanding = sample({
      intent: "request",
      taskAction: "offer",
      task: task("Buat kode tic-tac-toe"),
    });
    assert.deepEqual(immediateUnderstandingRoute(understanding), { kind: "conversation" });
    assert.equal(taskToOffer(understanding), null);
  });

  it("menyimpan task hanya dari semantic save eksplisit dengan evidence konkret", () => {
    const cases = [
      ["tolong catat kumpulkan matematika", "kumpulkan matematika"],
      ["Remind me to send the form tomorrow", "send the form tomorrow"],
      ["punten émutkeun abdi ngirim tugas énjing", "ngirim tugas énjing"],
      ["tulung cathet ngirim tugas sesuk", "ngirim tugas sesuk"],
    ] as const;
    for (const [message, target] of cases) {
      const extracted = task(target);
      assert.deepEqual(
        immediateUnderstandingRoute(sample({
          intent: "task",
          taskAction: "save",
          task: extracted,
          semanticOperation: semantic(
            "task",
            "save",
            message,
            target,
            "explicit",
          ),
        }), message),
        { kind: "save-task", task: extracted },
      );
    }

    const shouldOnly = "I should send the form tomorrow";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "task",
        taskAction: "save",
        task: task("send the form tomorrow"),
        semanticOperation: semantic(
          "task",
          "save",
          shouldOnly,
          "send the form tomorrow",
          "implicit",
        ),
      }), shouldOnly),
      { kind: "conversation" },
    );
  });

  it("membawa perubahan jadwal task eksplisit tanpa membuat task kedua", () => {
    const message =
      "ubah tugas peninjauan itu menjadi besok pukul 10.30 dan ingatkan satu jam sebelumnya";
    const extracted = {
      title: "Tugas peninjauan",
      dueAt: new Date("2026-08-25T03:30:00.000Z"),
      remindAt: new Date("2026-08-25T02:30:00.000Z"),
      importance: 2 as const,
    };
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "task",
        taskAction: "save",
        task: extracted,
        semanticOperation: semantic(
          "task",
          "update",
          message,
          "tugas peninjauan",
          "explicit",
          "recent",
        ),
      }), message),
      {
        kind: "update-task",
        target: "tugas peninjauan",
        task: extracted,
      },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "task",
        taskAction: "save",
        task: extracted,
        semanticOperation: semantic(
          "task",
          "update",
          message,
          "tugas peninjauan",
          "implicit",
          "recent",
        ),
      }), message),
      { kind: "conversation" },
    );
  });

  it("membawa penyelesaian task natural ke mutasi state yang eksplisit", () => {
    const message = "Tandai tugas mencatat hasil restart itu selesai.";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "request",
        semanticOperation: semantic(
          "task",
          "complete",
          message,
          "mencatat hasil restart",
          "explicit",
          "recent",
        ),
      }), message),
      { kind: "complete-task", target: "mencatat hasil restart" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "request",
        semanticOperation: semantic(
          "task",
          "complete",
          message,
          "mencatat hasil restart",
          "implicit",
          "recent",
        ),
      }), message),
      { kind: "conversation" },
    );
  });

  it("membawa permintaan natural membaca task ke surface state", () => {
    const message =
      "Sekarang sebutkan tugas aktifku dan kapan pengingatnya.";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "request",
        routingAssessment: {
          complexity: "mechanical",
          ambiguity: "low",
          planningRequired: false,
          emotionalNuance: "low",
          executionSize: "small",
          factualStakes: "low",
          transformationMechanical: true,
          toolNeed: "internal_state",
          confidence: 0.98,
        },
        semanticOperation: semantic("task", "list", message, null),
      }), message),
      { kind: "show-tasks" },
    );
  });

  it("memerlukan intent, action, dan semantic operation yang sejalan", () => {
    const listMessage = "show me what you remember about me";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "memory",
        memoryAction: "list",
        semanticOperation: semantic("memory", "list", listMessage),
      }), listMessage),
      { kind: "memory-control", action: "list" },
    );

    const forgetMessage = "forget Sohit";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "memory",
        memoryAction: "forget",
        memoryTarget: "legacy-target",
        semanticOperation: semantic(
          "memory",
          "forget",
          forgetMessage,
          "Sohit",
          "explicit",
        ),
      }), forgetMessage),
      {
        kind: "memory-control",
        action: "forget",
        target: "Sohit",
        reference: "none",
      },
    );

    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "memory",
        memoryAction: "forget",
        semanticOperation: semantic("usage", "show-summary", "forget Sohit"),
      }), "forget Sohit"),
      { kind: "conversation" },
    );
  });

  it("membawa kontrol data hanya dengan semantic evidence yang cukup", () => {
    const message = "export my data";
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "export",
        semanticOperation: semantic("data", "export", message),
      }), message),
      { kind: "control", action: "export" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "export",
        semanticOperation: semantic("data", "export", "different words"),
      }), message),
      { kind: "conversation" },
    );
  });

  it("memulihkan pengaturan waktu eksplisit tanpa melonggarkan kontrol data", () => {
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "timezone",
      }), "ubah zona waktuku ke WITA"),
      { kind: "control", action: "timezone" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "quiet-hours",
      }), "atur jam tenangku 21.30-06.00"),
      { kind: "control", action: "quiet-hours" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "timezone",
      }), "bagaimana cara mengubah zona waktuku ke WITA?"),
      { kind: "conversation" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(sample({
        intent: "control",
        controlAction: "delete-all",
      }), "hapus semua dataku"),
      { kind: "conversation" },
    );
  });

  it("hanya menawarkan tugas yang tersirat pada cerita pengguna", () => {
    const extractedTask = task("Belajar untuk ulangan biologi");
    assert.equal(taskToOffer(sample({
      intent: "feeling",
      taskAction: "offer",
      task: extractedTask,
    })), extractedTask);
  });

  it("menjaga obrolan biasa sebagai percakapan, bukan operasi", () => {
    for (const message of ["wkwk", "aku lagi cerita tentang tugas sekolah"]) {
      assert.deepEqual(
        immediateUnderstandingRoute(sample({
          intent: "smalltalk",
          semanticOperation: null,
        }), message),
        { kind: "conversation" },
      );
    }
  });
});

function sample(overrides: Partial<Understanding>): Understanding {
  return {
    intent: "smalltalk",
    taskAction: null,
    memoryAction: null,
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    task: null,
    memories: [],
    semanticOperation: null,
    ...overrides,
  };
}

function semantic(
  domain: SemanticDomain,
  operation: SemanticOperationName,
  evidence: string,
  target: string | null = null,
  explicitness: SemanticExplicitness = "explicit",
  reference: SemanticReference = "none",
) {
  return {
    version: 1 as const,
    domain,
    operation,
    target,
    subject: "self" as const,
    reference,
    explicitness,
    evidence,
    confidence: 0.95,
  };
}

function task(title: string) {
  return { title, dueAt: null, remindAt: null, importance: 2 as const };
}
