import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractSafeZip, inspectSafeZip } from "../src/core/safe-zip.js";
import { buildZip } from "./zip-test-fixture.js";

describe("safe ZIP ingestion", () => {
  it("menghapus tepat satu root sintetis untuk zipball GitHub", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-safe-zip-root-"));
    const destination = join(root, "snapshot");
    const archive = buildZip([
      { name: "owner-repo-deadbeef/", content: "" },
      { name: "owner-repo-deadbeef/src/", content: "" },
      {
        name: "owner-repo-deadbeef/src/index.ts",
        content: "export {};\n",
        unixMode: 0o100755,
      },
    ]);
    const result = await extractSafeZip(archive, destination, {
      stripSingleRoot: true,
      preserveRegularFileExecutability: true,
    });
    assert.deepEqual(result.manifest.files.map((file) => file.path), ["src/index.ts"]);
    assert.equal(result.manifest.files[0]?.executable, true);
    assert.equal(await readFile(join(destination, "src", "index.ts"), "utf8"), "export {};\n");
  });

  it("menolak mode zipball bila archive tidak mempunyai satu root bersama", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-safe-zip-multi-root-"));
    await assert.rejects(
      extractSafeZip(buildZip([
        { name: "first/a.txt", content: "a" },
        { name: "second/b.txt", content: "b" },
      ]), join(root, "snapshot"), { stripSingleRoot: true }),
      /tepat satu direktori root/iu,
    );
  });

  it("memvalidasi seluruh archive sebelum ekstraksi dan tidak mengeksekusi file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-safe-zip-"));
    const destination = join(root, "snapshot");
    const sentinel = join(root, "EXECUTED");
    const archive = buildZip([
      { name: "src/", content: "" },
      { name: "src/index.ts", content: "export const answer = 42;\n" },
      {
        name: "postinstall.sh",
        content: `touch ${sentinel}`,
        unixMode: 0o100755,
      },
    ]);

    const result = await extractSafeZip(archive, destination, {
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      makeId: () => "fixture",
    });

    assert.equal(
      await readFile(join(destination, "src", "index.ts"), "utf8"),
      "export const answer = 42;\n",
    );
    await assert.rejects(access(sentinel));
    assert.equal(result.manifest.files.length, 2);
    assert.equal(result.manifest.files[0]?.path, "postinstall.sh");
    assert.equal(result.manifest.files[0]?.executable, false);
    assert.equal(result.archiveSha256.length, 64);
  });

  it("menolak traversal, absolute path, metadata VCS, alias Windows, dan collision", () => {
    const malicious = [
      "../escape.txt",
      "/absolute.txt",
      "C:/drive.txt",
      "folder/../../escape.txt",
      ".git/config",
      "CON.txt",
      "COM¹.txt",
    ];
    for (const name of malicious) {
      assert.throws(() => inspectSafeZip(buildZip([{ name, content: "x" }])));
    }
    assert.throws(() =>
      inspectSafeZip(buildZip([
        { name: "Readme.md", content: "a" },
        { name: "README.md", content: "b" },
      ])),
    );
    assert.throws(() =>
      inspectSafeZip(buildZip([
        { name: "caf\u00e9.txt", content: "a" },
        { name: "cafe\u0301.txt", content: "b" },
      ])),
    );
  });

  it("menolak symlink, nested archive, checksum rusak, dan central/local mismatch", () => {
    assert.throws(() =>
      inspectSafeZip(buildZip([
        { name: "link", content: "../outside", unixMode: 0o120777 },
      ])),
      /Link atau special file/iu,
    );
    assert.throws(() =>
      inspectSafeZip(buildZip([{ name: "vendor.zip", content: "nested" }])),
      /bersarang/iu,
    );
    const badCrc = buildZip([{ name: "a.txt", content: "hello", crc32: 1 }]);
    const rootPromise = mkdtemp(join(tmpdir(), "harvy-bad-crc-"));
    return rootPromise.then(async (root) => {
      await assert.rejects(
        extractSafeZip(badCrc, join(root, "snapshot")),
        /Checksum/iu,
      );
      await assert.rejects(
        extractSafeZip(
          buildZip([{
            name: "payload.dat",
            content: buildZip([{ name: "nested.txt", content: "x" }]),
          }]),
          join(root, "nested-snapshot"),
        ),
        /bersarang tersamar/iu,
      );
      assert.throws(() =>
        inspectSafeZip(buildZip([
          { name: "local.txt", centralName: "central.txt", content: "x" },
        ])),
        /tidak cocok/iu,
      );
    });
  });

  it("menolak compression bomb dan batas file berdasarkan header maupun hasil inflate", () => {
    const bomb = buildZip([
      { name: "bomb.txt", content: Buffer.alloc(200_000), method: 8 },
    ]);
    assert.throws(() => inspectSafeZip(bomb), /Rasio kompresi/iu);

    const lied = buildZip([
      {
        name: "lied.txt",
        content: Buffer.alloc(1_000, 65),
        method: 8,
        declaredUncompressedSize: 10,
      },
    ]);
    const rootPromise = mkdtemp(join(tmpdir(), "harvy-size-lie-"));
    return rootPromise.then(async (root) => {
      await assert.rejects(
        extractSafeZip(lied, join(root, "snapshot")),
        /tidak sah|tidak cocok|melampaui/iu,
      );
    });
  });
});
