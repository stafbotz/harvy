import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("perintah development", () => {
  it("memakai watcher Harvy yang memberi waktu child melepas lock", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: { dev?: string } };

    assert.equal(
      packageJson.scripts?.dev,
      "node --import tsx scripts/dev-runner.ts",
    );
    assert.doesNotMatch(packageJson.scripts.dev, /tsx\s+watch/u);
  });
});
