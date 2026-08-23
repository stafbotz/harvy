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
