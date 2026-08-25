import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  superviseRuntime,
  type RuntimeSupervisorEvent,
} from "../src/operations/runtime-supervisor.js";

describe("runtime supervisor", () => {
  it("memulai ulang child yang crash lalu meneruskan shutdown bersih", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-supervisor-restart-"));
    const entry = join(root, "child.mjs");
    const count = join(root, "count.txt");
    const ready = join(root, "ready.txt");
    const cleaned = join(root, "cleaned.txt");
    await writeFile(entry, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `const countFile = ${JSON.stringify(count)};`,
      `const readyFile = ${JSON.stringify(ready)};`,
      'let count = 0; try { count = Number(readFileSync(countFile, "utf8")); } catch {}',
      'writeFileSync(countFile, String(count + 1));',
      'if (count === 0) process.exit(9);',
      'writeFileSync(readyFile, "ready");',
      `const cleanedFile = ${JSON.stringify(cleaned)};`,
      'process.on("message", (message) => {',
      '  if (message?.type !== "harvy-dev-shutdown") return;',
      '  writeFileSync(cleanedFile, "clean");',
      '  process.exit(0);',
      '});',
      'process.send?.({ type: "harvy-dev-control-ready" });',
      'process.send?.({ type: "harvy-runtime-channel-status", channel: "whatsapp", accountId: "harvy", status: "connecting", reason: null });',
      'process.send?.({ type: "harvy-runtime-channel-status", channel: "whatsapp", accountId: "harvy", status: "open", reason: null, messageText: "reject me" });',
      'process.send?.({ type: "harvy-runtime-channel-ready", channel: "whatsapp", accountId: "harvy" });',
      'process.send?.({ type: "harvy-live-acceptance-trace", channel: "whatsapp", accountId: "harvy", stage: "private-normalized" });',
      'process.send?.({ type: "harvy-live-acceptance-trace", channel: "whatsapp", accountId: "628000000000", stage: "private-normalized" });',
      'setInterval(() => undefined, 60_000);',
    ].join("\n"));
    const controller = new AbortController();
    const events: RuntimeSupervisorEvent[] = [];
    try {
      const result = superviseRuntime({
        entry,
        cwd: root,
        signal: controller.signal,
        restartBaseMs: 10,
        restartMaxMs: 20,
        stableResetMs: 5_000,
        crashWindowMs: 5_000,
        maxCrashes: 4,
        shutdownTimeoutMs: 2_000,
        onEvent: (event) => events.push(event),
      });
      await waitForFile(ready, 5_000);
      controller.abort();
      assert.equal(await result, 0);
      assert.equal(await readFile(count, "utf8"), "2");
      assert.equal(await readFile(cleaned, "utf8"), "clean");
      assert.equal(
        events.some((event) => event.type === "child-restart-scheduled"),
        true,
      );
      assert.equal(
        events.filter((event) => event.type === "child-started").length,
        2,
      );
      assert.deepEqual(
        events.filter((event) => event.type === "child-ready"),
        [{ type: "child-ready", attempt: 2 }],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "channel-status"),
        [{
          type: "channel-status",
          attempt: 2,
          channel: "whatsapp",
          accountId: "harvy",
          status: "connecting",
          reason: null,
        }],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "channel-ready"),
        [{
          type: "channel-ready",
          attempt: 2,
          channel: "whatsapp",
          accountId: "harvy",
        }],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "acceptance-trace"),
        [{
          type: "acceptance-trace",
          attempt: 2,
          channel: "whatsapp",
          accountId: "harvy",
          stage: "private-normalized",
        }],
      );
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("membuka circuit setelah crash loop bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-supervisor-loop-"));
    const entry = join(root, "crash.mjs");
    const events: RuntimeSupervisorEvent[] = [];
    await writeFile(entry, "process.exit(7);\n");
    try {
      const code = await superviseRuntime({
        entry,
        cwd: root,
        restartBaseMs: 5,
        restartMaxMs: 5,
        stableResetMs: 5_000,
        crashWindowMs: 5_000,
        maxCrashes: 3,
        shutdownTimeoutMs: 1_000,
        onEvent: (event) => events.push(event),
      });
      assert.equal(code, 1);
      assert.equal(
        events.filter((event) => event.type === "child-started").length,
        3,
      );
      assert.deepEqual(events.at(-1), { type: "crash-loop-open", crashes: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menjalankan fault acceptance satu kali lalu pulih pada child kedua", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-supervisor-fault-"));
    const entry = join(root, "child.mjs");
    const count = join(root, "count.txt");
    await writeFile(entry, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `const countFile = ${JSON.stringify(count)};`,
      'let count = 0; try { count = Number(readFileSync(countFile, "utf8")); } catch {}',
      'writeFileSync(countFile, String(count + 1));',
      'process.on("message", (message) => {',
      '  if (message?.type === "harvy-dev-shutdown") process.exit(0);',
      '});',
      'process.send?.({ type: "harvy-dev-control-ready" });',
      'setInterval(() => undefined, 60_000);',
    ].join("\n"));
    const controller = new AbortController();
    const fault = new AbortController();
    const events: RuntimeSupervisorEvent[] = [];
    let markFirstReady!: () => void;
    let markSecondReady!: () => void;
    const firstReady = new Promise<void>((resolveReady) => {
      markFirstReady = resolveReady;
    });
    const secondReady = new Promise<void>((resolveReady) => {
      markSecondReady = resolveReady;
    });
    try {
      const result = superviseRuntime({
        entry,
        cwd: root,
        signal: controller.signal,
        acceptanceFaultSignal: fault.signal,
        restartBaseMs: 10,
        restartMaxMs: 20,
        stableResetMs: 5_000,
        crashWindowMs: 5_000,
        maxCrashes: 4,
        shutdownTimeoutMs: 2_000,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "child-ready" && event.attempt === 1) {
            markFirstReady();
          } else if (event.type === "child-ready" && event.attempt === 2) {
            markSecondReady();
          }
        },
      });
      await firstReady;
      fault.abort();
      await secondReady;
      controller.abort();
      assert.equal(await result, 0);
      assert.equal(await readFile(count, "utf8"), "2");
      assert.deepEqual(
        events.filter((event) => event.type === "acceptance-fault-injected"),
        [{ type: "acceptance-fault-injected", attempt: 1 }],
      );
      assert.equal(
        events.filter((event) => event.type === "child-restart-scheduled")
          .length,
        1,
      );
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error("File ready supervisor tidak muncul.");
}
