import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { scanProjectTree } from "../src/core/project-files.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import { extractProjectSnapshotBundle } from "../src/sandbox/snapshot-bundle-codec.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot bundle codec", () => {
  it("mengekstrak hanya file manifest exact dan menolak trailing bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bundle-codec-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(sourceRoot, "src"), { recursive: true }));
    await writeFile(join(sourceRoot, "src", "index.js"), "export const value = 42;\n", "utf8");
    const manifest = await scanProjectTree(sourceRoot, {
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const source = await createSandboxSnapshotSource(sourceRoot, manifest);
    const bundle = Buffer.concat(await collect(source.open()));
    const bundlePath = join(root, "snapshot.bundle");
    await writeFile(bundlePath, bundle);

    const extracted = join(root, "extracted");
    const result = await extractProjectSnapshotBundle(
      bundlePath,
      extracted,
      source.descriptor,
      { maxExtractedBytes: 1024 * 1024 },
    );
    assert.equal(result.snapshotId, manifest.snapshotId);
    assert.equal(await readFile(join(extracted, "src", "index.js"), "utf8"),
      "export const value = 42;\n");

    const tainted = join(root, "tainted.bundle");
    await writeFile(tainted, Buffer.concat([bundle, Buffer.from("x")]));
    await assert.rejects(
      () => extractProjectSnapshotBundle(
        tainted,
        join(root, "tainted-output"),
        { ...source.descriptor, size: source.descriptor.size + 1 },
        { maxExtractedBytes: 1024 * 1024 },
      ),
      /trailing bytes/u,
    );
  });
});

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for await (const chunk of chunks) output.push(Buffer.from(chunk));
  return output;
}
