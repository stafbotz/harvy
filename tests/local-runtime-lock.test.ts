import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { acquireLocalRuntimeLock } from "../src/core/local-runtime-lock.js";

describe("local runtime lock", () => {
  it("menolak proses kedua dan dapat dipakai lagi setelah release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-lock-"));
    const path = join(directory, "control.runtime.lock");
    try {
      const first = await acquireLocalRuntimeLock(path, "runtime");
      await assert.rejects(
        acquireLocalRuntimeLock(path, "probe"),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { code?: string }).code === "LOCAL_DATA_LOCKED",
      );
      await first.release();
      const next = await acquireLocalRuntimeLock(path, "evaluation");
      await next.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("mereklamasi lock dari PID yang terbukti sudah mati", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-lock-stale-"));
    const path = join(directory, "control.runtime.lock");
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        pid: 999_999_999,
        token: "stale-token",
        role: "runtime",
        startedAt: "2026-08-01T00:00:00.000Z",
      }));
      const recovered = await acquireLocalRuntimeLock(path, "probe");
      await recovered.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tetap gagal tertutup pada payload lock yang tidak dapat diverifikasi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-lock-invalid-"));
    const path = join(directory, "control.runtime.lock");
    try {
      await writeFile(path, "bukan-json");
      await assert.rejects(
        acquireLocalRuntimeLock(path, "probe"),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { code?: string }).code === "LOCAL_DATA_LOCKED",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dapat hidup lagi setelah pemilik lock mati paksa", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-lock-crash-"));
    const path = join(directory, "control.runtime.lock");
    const moduleUrl = pathToFileURL(
      resolve("dist/src/core/local-runtime-lock.js"),
    ).href;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `const { acquireLocalRuntimeLock } = await import(${JSON.stringify(moduleUrl)});`,
        `await acquireLocalRuntimeLock(${JSON.stringify(path)}, "runtime");`,
        'process.send?.("locked");',
        "setInterval(() => undefined, 60_000);",
      ].join("\n"),
    ], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    try {
      await new Promise<void>((resolveLocked, rejectLocked) => {
        const timeout = setTimeout(
          () => rejectLocked(new Error("Child tidak memperoleh runtime lock.")),
          5_000,
        );
        child.once("message", (message) => {
          if (message !== "locked") return;
          clearTimeout(timeout);
          resolveLocked();
        });
      });
      child.kill("SIGKILL");
      await exited;
      const restarted = await acquireLocalRuntimeLock(path, "runtime");
      await restarted.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
