import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

describe("dev runner", () => {
  it("menunggu child melepas lock saat reload dan saat dihentikan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-dev-runner-"));
    const fakeApp = join(directory, "fake-app.mjs");
    const watched = join(directory, "watched.txt");
    const lock = join(directory, "runtime.lock");
    await writeFile(watched, "awal", "utf8");
    await writeFile(
      fakeApp,
      `
import { rmSync, writeFileSync } from "node:fs";

const lockPath = process.env.HARVY_FAKE_LOCK;
if (!lockPath) throw new Error("HARVY_FAKE_LOCK wajib ada");
writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    rmSync(lockPath, { force: true });
    process.exit(0);
  }, 30);
};

process.on("message", (message) => {
  if (message?.type === "harvy-dev-shutdown") stop();
});
process.send?.({ type: "harvy-dev-control-ready" });
setInterval(() => undefined, 1_000);
`,
      "utf8",
    );

    const output: string[] = [];
    const runner = spawn(
      process.execPath,
      [
        resolve(process.cwd(), "dist/scripts/dev-runner.js"),
        `--entry=${fakeApp}`,
        `--watch=${watched}`,
        "--shutdown-timeout-ms=2000",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HARVY_FAKE_LOCK: lock },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    runner.stdout!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    runner.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        runner.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );

    try {
      const firstPid = await waitForFileValue(lock);
      await writeFile(watched, "berubah", "utf8");
      const secondPid = await waitForFileValue(lock, firstPid);
      assert.notEqual(secondPid, firstPid);

      runner.send({ type: "harvy-dev-runner-stop" });
      const result = await exited;
      assert.deepEqual(result, { code: 0, signal: null }, output.join(""));
      await assert.rejects(
        access(lock),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT",
      );
      assert.match(output.join(""), /menunggu aplikasi melepas lock/u);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        try {
          runner.send({ type: "harvy-dev-runner-stop" });
        } catch {
          // Runner sudah keluar di antara pemeriksaan dan send.
        }
        await Promise.race([
          exited,
          new Promise((resolveWait) => setTimeout(resolveWait, 2_500)),
        ]);
      }
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGKILL");
      }
      try {
        const fakePid = Number(await readFile(lock, "utf8"));
        if (Number.isSafeInteger(fakePid)) process.kill(fakePid, "SIGKILL");
      } catch {
        // Lock sudah dibersihkan oleh child normal.
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitForFileValue(
  path: string,
  differentFrom?: string,
): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (value && value !== differentFrom) return value;
    } catch {
      // Child lama dapat sudah melepas lock sebelum child baru menulisnya.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Tidak melihat nilai lock baru untuk ${path}.`);
}
