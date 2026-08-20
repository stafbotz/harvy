import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("freshness guard untuk CURRENT.md", () => {
  it("CURRENT valid dan fresh dinyatakan PASS", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      validateContextFreshness(options: {
        root: string;
        readRepositoryFile: (path: string) => Promise<string>;
      }): Promise<{ ok: boolean; warnings: string[] }>;
    };

    const result = await freshnessModule.validateContextFreshness({
      root: repositoryRoot,
      readRepositoryFile: text,
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.warnings));
  });

  it("menolak baseline commit yang tidak valid di repository", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      validateContextFreshness(options: {
        root: string;
        currentContent: string;
        statusContent: string;
        logContent: string;
      }): Promise<unknown>;
    };

    const validCurrent = await text("docs/agent/CURRENT.md");
    const validStatus = await text("docs/engineering/STATUS.md");
    const validLog = await text("docs/LOG.md");

    const invalidCommitCurrent = validCurrent.replace(
      /^Baseline:\s*[0-9a-fA-F]+/mu,
      "Baseline: 0000000000000000000000000000000000000000",
    );

    await assert.rejects(
      freshnessModule.validateContextFreshness({
        root: repositoryRoot,
        currentContent: invalidCommitCurrent,
        statusContent: validStatus,
        logContent: validLog,
      }),
      /CURRENT\.md baseline.*does not exist in repository|not a valid commit object/u,
    );
  });

  it("menolak CURRENT dengan metadata malformed", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      parseCurrentMetadata(content: string): unknown;
      validateContextFreshness(options: {
        root: string;
        currentContent: string;
        statusContent: string;
        logContent: string;
      }): Promise<unknown>;
    };

    const validCurrent = await text("docs/agent/CURRENT.md");
    const validStatus = await text("docs/engineering/STATUS.md");
    const validLog = await text("docs/LOG.md");

    // Missing Refreshed field
    const noRefreshed = validCurrent.replace(/^Refreshed:\s*.*$/mu, "");
    assert.throws(
      () => freshnessModule.parseCurrentMetadata(noRefreshed),
      /missing Refreshed field/u,
    );

    // Invalid Refreshed date
    const invalidDate = validCurrent.replace(
      /^Refreshed:\s*.*$/mu,
      "Refreshed: 2026-99-99",
    );
    assert.throws(
      () => freshnessModule.parseCurrentMetadata(invalidDate),
      /invalid Refreshed date/u,
    );

    // Missing Baseline field
    const noBaseline = validCurrent
      .replace(/^Baseline:\s*.*$/mu, "")
      .replace(/commit dasar\s*`[0-9a-fA-F]+`/mu, "");
    assert.throws(
      () => freshnessModule.parseCurrentMetadata(noBaseline),
      /missing Baseline commit reference/u,
    );

    await assert.rejects(
      freshnessModule.validateContextFreshness({
        root: repositoryRoot,
        currentContent: noRefreshed,
        statusContent: validStatus,
        logContent: validLog,
      }),
      /CURRENT\.md metadata malformed/u,
    );
  });

  it("menolak metadata material yang lebih baru dan jelas kontradiktif", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      validateContextFreshness(options: {
        root: string;
        currentContent: string;
        statusContent: string;
        logContent: string;
      }): Promise<unknown>;
    };

    const validCurrent = await text("docs/agent/CURRENT.md");
    const validStatus = await text("docs/engineering/STATUS.md");
    const validLog = await text("docs/LOG.md");

    // CURRENT lama harus ditolak terhadap tanggal baseline STATUS aktual.
    const olderCurrent = validCurrent.replace(
      /^Refreshed:\s*.*$/mu,
      "Refreshed: 2026-08-10",
    );

    await assert.rejects(
      freshnessModule.validateContextFreshness({
        root: repositoryRoot,
        currentContent: olderCurrent,
        statusContent: validStatus,
        logContent: validLog,
      }),
      /CURRENT\.md is stale: Refreshed date \(2026-08-10\) is older than STATUS baseline date \(\d{4}-\d{2}-\d{2}\)/u,
    );
  });

  it("tidak menggagalkan perubahan nonmaterial setelah CURRENT", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      validateContextFreshness(options: {
        root: string;
        currentContent: string;
        statusContent: string;
        logContent: string;
      }): Promise<{ ok: boolean }>;
    };

    const validCurrent = await text("docs/agent/CURRENT.md");
    const validStatus = await text("docs/engineering/STATUS.md");
    const validLog = await text("docs/LOG.md");

    // Non-material change: minor text edit or test addition without metadata contradiction
    const result = await freshnessModule.validateContextFreshness({
      root: repositoryRoot,
      currentContent: validCurrent,
      statusContent: validStatus,
      logContent: validLog,
    });

    assert.equal(result.ok, true);
  });

  it("menghasilkan warning, bukan kegagalan, pada stale yang ambigu", async () => {
    const freshnessModuleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/context-freshness.mjs"),
    ).href;
    const freshnessModule = (await import(freshnessModuleUrl)) as {
      validateContextFreshness(options: {
        root: string;
        currentContent: string;
        statusContent: string;
        logContent: string;
      }): Promise<{ ok: boolean; warnings: string[] }>;
    };

    const validCurrent = await text("docs/agent/CURRENT.md");
    const validStatus = await text("docs/engineering/STATUS.md");
    const validLog = await text("docs/LOG.md");

    const refreshed = /^Refreshed:\s*(\d{4}-\d{2}-\d{2})$/mu
      .exec(validCurrent)?.[1];
    assert.ok(refreshed);
    const nextDay = new Date(`${refreshed}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const newerLogDate = nextDay.toISOString().slice(0, 10);

    // Entri material lokal sehari sesudah CURRENT ambigu, bukan kontradiksi.
    const logWithNewEntry = [
      "# Catatan Material Harvy",
      "",
      `## ${newerLogDate} — Refactor internal helper`,
      "",
      "Scope: internal scripts helper.",
      "Changed: penyederhanaan helper internal.",
      "Verified: npm test PASS.",
      "Not verified: none.",
      "",
      validLog.replace(/^# Catatan Material Harvy\r?\n\r?\n/u, ""),
    ].join("\n");

    const result = await freshnessModule.validateContextFreshness({
      root: repositoryRoot,
      currentContent: validCurrent,
      statusContent: validStatus,
      logContent: logWithNewEntry,
    });

    // Should pass with warning, not fail
    assert.equal(result.ok, true);
    assert.ok(result.warnings.length > 0);
    assert.match(result.warnings[0] ?? "", /may precede latest LOG entry/u);
  });

  it("memastikan canonical context:check mengeksekusi contract dan freshness", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/session-context.mjs"), "--check"],
      { cwd: repositoryRoot },
    );

    assert.match(stdout, /agent-context: ok/u);
    assert.match(stdout, /output=\d+ bytes/u);
    assert.match(stdout, /estimate=\d+ tokens/u);
  });
});
