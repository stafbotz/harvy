import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("tidak menghapus lock stale secara otomatis tanpa verifikasi operator", async () => {
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
      await assert.rejects(
        acquireLocalRuntimeLock(path, "probe"),
        /hapus lock stale secara manual/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
