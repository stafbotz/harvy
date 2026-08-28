import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeExplorerAttributionBoundary,
  executeExplorerTransportCommand,
  explorerTransportRejection,
  isExplorerEvidenceCommitError,
  startObservedWhatsAppRuntime,
  takeScriptedCommands,
  WhatsAppObserverConnectionGuard,
  type ExplorerSentRecord,
} from "../scripts/live-exploratory-tester.js";
import {
  LiveTurnAttribution,
  type LiveExplorationTurnEvidence,
} from "../src/operations/live-exploration.js";

describe("live exploratory runner transport", () => {
  it("mengonsumsi command JSONL sementara sebelum runtime child dibuat", () => {
    const env: NodeJS.ProcessEnv = {
      HARVY_LIVE_EXPLORATION_COMMANDS_JSONL:
        '{"type":"send","text":"halo"}\n{"type":"settle"}',
    };
    assert.equal(
      takeScriptedCommands(env),
      '{"type":"send","text":"halo"}\n{"type":"settle"}\n',
    );
    assert.equal(env.HARVY_LIVE_EXPLORATION_COMMANDS_JSONL, undefined);
    assert.throws(
      () => takeScriptedCommands({
        HARVY_LIVE_EXPLORATION_COMMANDS_JSONL: "\n\n",
      }),
      /LIVE_EXPLORATION_SCRIPTED_COMMANDS_INVALID/u,
    );
  });

  it("mengirim fixture gambar bawaan tanpa path dan merekam caption saja", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    const turns: Array<{
      turn: number;
      startedAt: number;
      firstResponseMs: number | null;
      responseEvents: number;
    }> = [];
    const evidence: LiveExplorationTurnEvidence[] = [];
    let signature = "";

    await executeExplorerTransportCommand({
      command: { type: "image", color: "blue" },
      commandSequence: 1,
      runId: "run-visual",
      driver: {
        async send() {},
        async sendImage(image, caption) {
          signature = `${image.subarray(1, 4).toString("ascii")}:${caption}`;
        },
        async reply() {},
        async click() {},
      },
      evidence: {
        async recordBoundary() {},
        async recordTurn(value) {
          evidence.push(value);
        },
      },
      attribution,
      turns,
      now: () => 25,
    });

    assert.match(signature, /^PNG:/u);
    assert.doesNotMatch(signature, /\bblue\b/iu);
    assert.equal(evidence[0]?.kind, "image");
    assert.equal(evidence[0]?.texts.length, 1);
    assert.equal(turns.length, 1);
  });

  it("tidak membuat turn/evidence dan menutup attribution saat send ditolak", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    const turns: Array<{
      turn: number;
      startedAt: number;
      firstResponseMs: number | null;
      responseEvents: number;
    }> = [];
    const evidence: LiveExplorationTurnEvidence[] = [];
    const sent: ExplorerSentRecord[] = [];

    await assert.rejects(
      executeExplorerTransportCommand({
        command: { type: "send", text: "tidak terkirim" },
        commandSequence: 4,
        runId: "run-transport-rejected",
        driver: {
          async send() {
            throw new Error("TEST_TRANSPORT_REJECTED");
          },
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {},
          async recordTurn(value) {
            evidence.push(value);
          },
        },
        attribution,
        turns,
        now: () => 10,
        onSent: (record) => sent.push(record),
      }),
      (error: unknown) => {
        assert.deepEqual(explorerTransportRejection(error), {
          sentMessageCount: 0,
          rejectedMessageCount: 1,
          failedMessageIndex: 1,
        });
        return true;
      },
    );

    assert.deepEqual(turns, []);
    assert.deepEqual(evidence, []);
    assert.deepEqual(sent, []);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });

  it("merekam hanya prefix burst yang sukses dan melaporkan sisa ditolak", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    const turns: Array<{
      turn: number;
      startedAt: number;
      firstResponseMs: number | null;
      responseEvents: number;
    }> = [];
    const attempts: string[] = [];
    const gaps: number[] = [];
    const evidence: LiveExplorationTurnEvidence[] = [];
    const sent: ExplorerSentRecord[] = [];

    await assert.rejects(
      executeExplorerTransportCommand({
        command: {
          type: "burst",
          messages: ["satu", "dua", "tiga", "empat"],
          gapMs: 25,
        },
        commandSequence: 8,
        runId: "run-partial-burst",
        driver: {
          async send(text) {
            attempts.push(text);
            if (text === "tiga") throw new Error("TEST_BURST_INTERRUPTED");
          },
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {},
          async recordTurn(value) {
            evidence.push({ ...value, texts: [...value.texts] });
          },
        },
        attribution,
        turns,
        now: () => 1_000,
        pause: async (ms) => {
          gaps.push(ms);
        },
        onSent: (record) => sent.push(record),
      }),
      (error: unknown) => {
        assert.deepEqual(explorerTransportRejection(error), {
          sentMessageCount: 2,
          rejectedMessageCount: 2,
          failedMessageIndex: 3,
        });
        return true;
      },
    );

    assert.deepEqual(attempts, ["satu", "dua", "tiga"]);
    assert.deepEqual(gaps, [25, 25]);
    assert.deepEqual(evidence, [{
      runId: "run-partial-burst",
      turn: 1,
      kind: "burst",
      texts: ["satu", "dua"],
    }]);
    assert.deepEqual(sent, [{
      commandSequence: 8,
      turn: 1,
      kind: "burst",
      messageCount: 2,
      partial: true,
    }]);
    assert.deepEqual(turns, [{
      turn: 1,
      startedAt: 1_000,
      firstResponseMs: null,
      responseEvents: 0,
    }]);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });

  it("mengaktifkan dan menyimpan turn hanya setelah transport sukses", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    const turns: Array<{
      turn: number;
      startedAt: number;
      firstResponseMs: number | null;
      responseEvents: number;
    }> = [];
    const order: string[] = [];

    await executeExplorerTransportCommand({
      command: { type: "reply", surface: "surface-3", text: "lanjut" },
      commandSequence: 9,
      runId: "run-success",
      driver: {
        async send() {},
        async reply() {
          assert.deepEqual(attribution.current(), {
            phase: "idle",
            turn: null,
          });
          order.push("transport");
        },
        async click() {},
      },
      evidence: {
        async recordBoundary() {},
        async recordTurn(value) {
          order.push("evidence");
          assert.deepEqual(value, {
            runId: "run-success",
            turn: 1,
            kind: "reply",
            texts: ["lanjut"],
            replySurface: "surface-3",
          });
          assert.deepEqual(attribution.current(), {
            phase: "turn",
            turn: 1,
          });
        },
      },
      attribution,
      turns,
      now: () => 2_000,
      onSent: () => order.push("sent"),
    });

    assert.deepEqual(order, ["transport", "evidence", "sent"]);
    assert.equal(turns.length, 1);
    assert.deepEqual(attribution.current(), { phase: "turn", turn: 1 });
  });

  it("menolak send biasa sampai turn aktif di-settle", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(1, 100);
    let attempted = false;

    await assert.rejects(
      executeExplorerTransportCommand({
        command: { type: "send", text: "terlalu cepat" },
        commandSequence: 2,
        runId: "run-active",
        driver: {
          async send() {
            attempted = true;
          },
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {},
          async recordTurn() {},
        },
        attribution,
        turns: [{
          turn: 1,
          startedAt: 100,
          firstResponseMs: null,
          responseEvents: 0,
        }],
      }),
      /LIVE_EXPLORATION_TURN_ACTIVE_SETTLE_OR_INTERRUPT_REQUIRED/u,
    );
    assert.equal(attempted, false);
    assert.deepEqual(attribution.current(), { phase: "turn", turn: 1 });
  });

  it("interrupt memotong turn aktif dan merekam boundary tanpa isi mentah", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(1, 100);
    const turns = [{
      turn: 1,
      startedAt: 100,
      firstResponseMs: 20,
      responseEvents: 1,
    }];
    const order: string[] = [];
    const boundaries: unknown[] = [];
    const evidence: LiveExplorationTurnEvidence[] = [];

    await executeExplorerTransportCommand({
      command: { type: "interrupt", text: "Bukan itu, ganti arah." },
      commandSequence: 3,
      runId: "run-interrupt",
      boundarySequence: 1,
      driver: {
        async send(text) {
          assert.equal(text, "Bukan itu, ganti arah.");
          assert.deepEqual(attribution.current(), { phase: "turn", turn: 1 });
          order.push("transport");
        },
        async reply() {},
        async click() {},
      },
      evidence: {
        async recordBoundary(value) {
          boundaries.push(value);
          order.push("boundary");
        },
        async recordTurn(value) {
          evidence.push(value);
          order.push("turn");
        },
      },
      attribution,
      turns,
      now: () => 200,
    });

    assert.deepEqual(order, ["transport", "boundary", "turn"]);
    assert.deepEqual(boundaries, [{
      runId: "run-interrupt",
      boundary: 1,
      kind: "interrupt",
      fromTurn: 1,
      toTurn: 2,
      observationFlushTimedOut: null,
    }]);
    assert.equal(JSON.stringify(boundaries).includes("Bukan itu"), false);
    assert.deepEqual(evidence, [{
      runId: "run-interrupt",
      turn: 2,
      kind: "interrupt",
      texts: ["Bukan itu, ganti arah."],
    }]);
    assert.deepEqual(attribution.current(), { phase: "turn", turn: 2 });
  });

  it("interrupt yang ditolak transport mempertahankan turn sebelumnya", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(1, 100);
    const turns = [{
      turn: 1,
      startedAt: 100,
      firstResponseMs: null,
      responseEvents: 0,
    }];

    await assert.rejects(
      executeExplorerTransportCommand({
        command: { type: "interrupt", text: "koreksi" },
        commandSequence: 4,
        runId: "run-interrupt-rejected",
        boundarySequence: 1,
        driver: {
          async send() {
            throw new Error("TEST_INTERRUPT_REJECTED");
          },
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {},
          async recordTurn() {},
        },
        attribution,
        turns,
      }),
      /TEST_INTERRUPT_REJECTED/u,
    );
    assert.equal(turns.length, 1);
    assert.deepEqual(attribution.current(), { phase: "turn", turn: 1 });
  });

  it("mengubah kegagalan evidence setelah side effect menjadi fatal dan menutup turn", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    const turns: Array<{
      turn: number;
      startedAt: number;
      firstResponseMs: number | null;
      responseEvents: number;
    }> = [];
    let sent = false;

    await assert.rejects(
      executeExplorerTransportCommand({
        command: { type: "send", text: "sudah terkirim" },
        commandSequence: 5,
        runId: "run-evidence-failed",
        driver: {
          async send() {
            sent = true;
          },
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {},
          async recordTurn() {
            throw new Error("TEST_EVIDENCE_WRITE_FAILED");
          },
        },
        attribution,
        turns,
      }),
      (error: unknown) => {
        assert.equal(isExplorerEvidenceCommitError(error), true);
        assert.match(String(error), /LIVE_EXPLORATION_EVIDENCE_COMMIT_FAILED/u);
        return true;
      },
    );
    assert.equal(sent, true);
    assert.equal(turns.length, 1);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });

  it("menghentikan interrupt bila boundary evidence gagal sesudah send", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(1, 100);
    const turns = [{
      turn: 1,
      startedAt: 100,
      firstResponseMs: null,
      responseEvents: 0,
    }];
    let turnRecorded = false;

    await assert.rejects(
      executeExplorerTransportCommand({
        command: { type: "interrupt", text: "ubah arah" },
        commandSequence: 6,
        runId: "run-boundary-failed",
        boundarySequence: 1,
        driver: {
          async send() {},
          async reply() {},
          async click() {},
        },
        evidence: {
          async recordBoundary() {
            throw new Error("TEST_BOUNDARY_WRITE_FAILED");
          },
          async recordTurn() {
            turnRecorded = true;
          },
        },
        attribution,
        turns,
      }),
      (error: unknown) => isExplorerEvidenceCommitError(error),
    );
    assert.equal(turnRecorded, false);
    assert.equal(turns.length, 2);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });
});

describe("live exploratory runner lifecycle boundaries", () => {
  it("flush dan drain mendahului penutupan attribution restart/stop", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(3, 100);
    const order: string[] = [];

    const result = await closeExplorerAttributionBoundary({
      attribution,
      flushObservation: async () => {
        assert.deepEqual(attribution.current(), { phase: "turn", turn: 3 });
        order.push("flush");
        return { timedOut: false };
      },
      drainObservation: async () => {
        assert.deepEqual(attribution.current(), { phase: "turn", turn: 3 });
        order.push("drain");
      },
    });

    assert.deepEqual(result, { timedOut: false });
    assert.deepEqual(order, ["flush", "drain"]);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });

  it("tetap menutup attribution ketika observation flush gagal", async () => {
    const attribution = new LiveTurnAttribution();
    attribution.markReady();
    attribution.start(5, 100);
    let drained = false;

    await assert.rejects(
      closeExplorerAttributionBoundary({
        attribution,
        flushObservation: async () => {
          throw new Error("TEST_FLUSH_FAILED");
        },
        drainObservation: async () => {
          drained = true;
        },
      }),
      /TEST_FLUSH_FAILED/u,
    );
    assert.equal(drained, true);
    assert.deepEqual(attribution.current(), { phase: "idle", turn: null });
  });
});

describe("live exploratory runner WhatsApp startup", () => {
  it("mempertahankan close observer setelah startup open", () => {
    const connection = new WhatsAppObserverConnectionGuard();
    assert.deepEqual(connection.observe({ connection: "open" }), {
      status: "open",
      reason: null,
    });
    assert.doesNotThrow(() => connection.assertOpen());

    assert.deepEqual(connection.observe({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    }), {
      status: "closed",
      reason: 401,
    });
    assert.throws(
      () => connection.assertOpen(),
      /LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_CLOSED_401/u,
    );
  });

  it("membedakan observer yang belum open dari close tanpa reason", () => {
    const connection = new WhatsAppObserverConnectionGuard();
    assert.throws(
      () => connection.assertOpen(),
      /LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_NOT_OPEN/u,
    );
    connection.observe({ connection: "close" });
    assert.throws(
      () => connection.assertOpen(),
      /LIVE_EXPLORATION_WHATSAPP_TESTER_CONNECTION_CLOSED$/u,
    );
  });

  it("menunggu observer ready sebelum runtime dan baru kemudian mengekspos driver", async () => {
    const order = ["observer-attached"];
    let ready = false;
    let runtimeReady = false;
    const driver = fakeDriver(() => order.push("driver-closed"));

    const setup = await startObservedWhatsAppRuntime({
      driver,
      waitForObserverReady: async () => {
        order.push("observer-ready");
        ready = true;
      },
      startRuntime: async () => {
        assert.equal(ready, true);
        order.push("runtime-started");
        runtimeReady = true;
        return { id: "runtime" };
      },
    });

    assert.equal(runtimeReady, true);
    assert.equal(setup.driver, driver);
    assert.deepEqual(setup.runtime, { id: "runtime" });
    assert.deepEqual(order, [
      "observer-attached",
      "observer-ready",
      "runtime-started",
    ]);
  });

  it("menutup observer bila runtime gagal setelah observer siap", async () => {
    const order: string[] = [];
    const driver = fakeDriver(() => order.push("driver-closed"));

    await assert.rejects(
      startObservedWhatsAppRuntime({
        driver,
        waitForObserverReady: async () => {
          order.push("observer-ready");
        },
        startRuntime: async () => {
          order.push("runtime-failed");
          throw new Error("TEST_RUNTIME_FAILED");
        },
      }),
      /TEST_RUNTIME_FAILED/u,
    );
    assert.deepEqual(order, [
      "observer-ready",
      "runtime-failed",
      "driver-closed",
    ]);
  });
});

function fakeDriver(onClose: () => void) {
  return {
    async send() {},
    async reply() {},
    async click() {},
    async flushObservation() {
      return { timedOut: false };
    },
    async close() {
      onClose();
    },
  };
}
