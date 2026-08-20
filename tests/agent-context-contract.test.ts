import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

async function text(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("kontrak konteks coding agent", () => {
  it("memvalidasi bootstrap portable dan melaporkan ukuran aktual", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/session-context.mjs"), "--check"],
      { cwd: resolve(repositoryRoot, "..") },
    );

    const measurement = /output=(\d+) bytes; estimate=(\d+) tokens/u.exec(stdout);
    assert.ok(measurement, stdout);
    assert.ok(Number(measurement[1]) <= 8_192, stdout);
    assert.equal(
      Number(measurement[2]),
      Math.ceil(Number(measurement[1]) / 4),
    );
  });

  it("hanya mencetak kontrak ringkas dan CURRENT, bukan dokumen besar", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/session-context.mjs")],
      { cwd: resolve(repositoryRoot, "..") },
    );

    assert.match(stdout, /Harvy compact session context/u);
    assert.match(stdout, /# Current Context/u);
    assert.match(stdout, /Koordinasikan penulisan secara adaptif/u);
    assert.ok(Buffer.byteLength(stdout, "utf8") <= 8_192);
    assert.doesNotMatch(
      stdout,
      /# (?:Catatan Material Harvy|Status Kemampuan Harvy|Peta Konteks Harvy)|Cacat yang diketahui/u,
    );
    assert.doesNotMatch(
      stdout,
      /Authorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu,
    );
  });

  it("menjaga bootstrap Claude dan Antigravity sebagai adaptor tipis", async () => {
    const [claude, antigravity, settings, shell] = await Promise.all([
      text("CLAUDE.md"),
      text(".agent/rules/00-harvy-bootstrap.md"),
      text(".claude/settings.json"),
      text("scripts/session-context.sh"),
    ]);

    assert.match(claude, /@AGENTS\.md/u);
    assert.ok(Buffer.byteLength(claude, "utf8") <= 1_024);
    assert.match(antigravity, /@\.\.\/\.\.\/AGENTS\.md/u);
    assert.ok(Buffer.byteLength(antigravity, "utf8") <= 512);
    const sessionHook = (JSON.parse(settings) as {
      hooks?: {
        SessionStart?: Array<{
          hooks?: Array<{ type?: string; command?: string; args?: string[] }>;
        }>;
      };
    }).hooks?.SessionStart?.[0]?.hooks?.[0];
    assert.equal(sessionHook?.type, "command");
    assert.equal(sessionHook?.command, "node");
    assert.deepEqual(sessionHook?.args, [
      "${CLAUDE_PROJECT_DIR}/scripts/session-context.mjs",
    ]);
    assert.match(shell, /session-context\.mjs/u);
    assert.doesNotMatch(shell, /docs\/(?:LOG|PROJECT|CONSTITUTION)|engineering\/STATUS|\b(?:cat|awk)\b/u);
  });

  it("mengunci code-first, context budget, dan klasifikasi task", async () => {
    const agents = await text("AGENTS.md");

    for (const className of [
      "coding",
      "bug investigation",
      "review",
      "architecture",
      "product behavior",
      "privacy/safety",
      "documentation",
      "research",
      "release/operations",
    ]) {
      assert.match(agents, new RegExp(`\\b${className.replace("/", "\\/")}\\b`, "u"));
    }
    assert.match(agents, /sekitar 15%/u);
    assert.match(agents, /maksimal tiga entri LOG/u);
    assert.match(agents, /git status/u);
    assert.match(agents, /kode dan tes yang benar-benar berjalan/u);
    assert.doesNotMatch(agents, /~15 entri terbaru|seluruh `docs\/` sebagai orientasi/u);
  });

  it("tidak menyisakan mandat bootstrap dan LOG lama pada sumber aktif", async () => {
    const active = (
      await Promise.all([
        "AGENTS.md",
        "docs/operations/WORKFLOW.md",
        "docs/INDEX.md",
        "docs/LOG.md",
        "scripts/session-context.sh",
        ".githooks/pre-commit",
      ].map(text))
    ).join("\n");

    assert.doesNotMatch(active, /~15 entri terbaru/iu);
    assert.doesNotMatch(active, /termasuk sesi yang hanya berdiskusi/iu);
    assert.doesNotMatch(active, /Baca konteks sebelum menjawab:\s*docs\/PROJECT\.md/iu);
    assert.doesNotMatch(active, /Commit ditahan:\s*docs\/LOG\.md/iu);
  });

  it("mengunci koordinasi penulisan adaptif tanpa mengubah review eksplisit", async () => {
    const [agents, workflow] = await Promise.all([
      text("AGENTS.md"),
      text("docs/operations/WORKFLOW.md"),
    ]);
    const active = `${agents}\n${workflow}`;

    assert.match(agents, /Koordinasikan penulisan secara adaptif/iu);
    assert.match(agents, /berurutan,\s*paralel,\s*atau\s*terisolasi/iu);
    assert.match(agents, /peran agent\s+tidak otomatis menentukan hak edit/iu);
    assert.match(agents, /review\/diskusi eksplisit tetap read-only/iu);
    assert.match(workflow, /Tidak ada mandat satu penulis untuk seluruh working tree/iu);
    assert.match(workflow, /Worktree\/clone adalah alat opsional/iu);

    for (const retired of [
      /Satu penulis aktif per working tree/iu,
      /Satu pihak menulis pada satu working tree/iu,
      /Hanya satu pihak menulis file pada satu waktu/iu,
      /agent lain boleh audit\/QA\s+baca-saja/iu,
      /Bila dua penulis benar-benar diperlukan,\s*gunakan worktree\/clone terpisah/iu,
    ]) {
      assert.doesNotMatch(active, retired);
    }
  });

  it("membatasi CURRENT dan menyediakan status per subsystem", async () => {
    const [current, statusIndex] = await Promise.all([
      text("docs/agent/CURRENT.md"),
      text("docs/engineering/STATUS.md"),
    ]);
    assert.ok(Buffer.byteLength(current, "utf8") <= 5_120);
    assert.ok(Buffer.byteLength(statusIndex, "utf8") <= 8_192);

    for (const name of [
      "agent-runtime.md",
      "telegram.md",
      "whatsapp.md",
      "tasks.md",
      "memory.md",
      "safety-privacy.md",
      "console.md",
      "platform.md",
      "coding.md",
    ]) {
      assert.match(statusIndex, new RegExp(`status/${name.replace(".", "\\.")}`, "u"));
      assert.ok((await stat(resolve(repositoryRoot, "docs/engineering/status", name))).isFile());
    }
  });

  it("membuat hook struktural tanpa memaksa LOG untuk commit kecil", async () => {
    const [hook, generator, contractScript, freshnessScript] = await Promise.all([
      text(".githooks/pre-commit"),
      text("scripts/session-context.mjs"),
      text("scripts/context-contract.mjs"),
      text("scripts/context-freshness.mjs"),
    ]);

    assert.doesNotMatch(hook, /Commit ditahan:.*LOG|LOG.*tidak ikut berubah|grep\s+-q.*LOG/iu);
    assert.match(hook, /git diff --cached --name-status/u);
    assert.doesNotMatch(hook, /--diff-filter=ACMR/u);
    assert.match(hook, /git show :scripts\/session-context\.mjs/u);
    assert.match(hook, /--check-staged/u);
    assert.match(hook, /AGENTS/u);
    assert.match(hook, /agent\/CURRENT\\\.md/u);
    assert.match(hook, /LOG\\\.md/u);
    assert.match(contractScript, /tests\/agent-context-contract\.test\.ts/u);
    assert.match(generator, /buildSessionContext|runContextCheck/u);
    assert.match(freshnessScript, /validateContextFreshness/u);
  });

  it("memvalidasi snapshot staged dan menolak kontrak usang atau dihapus", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "harvy-context-index-"));
    const indexPath = resolve(temporaryDirectory, "index");
    const stagedGenerator = resolve(temporaryDirectory, "session-context.mjs");
    const gitEnvironment = { ...process.env, GIT_INDEX_FILE: indexPath };
    const contractPaths = [
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/settings.json",
      ".agent/rules/00-harvy-bootstrap.md",
      ".githooks/pre-commit",
      "scripts/session-context.mjs",
      "scripts/context-contract.mjs",
      "scripts/context-freshness.mjs",
      "scripts/session-context.sh",
      "docs/LOG.md",
      "docs/agent/CURRENT.md",
      "docs/engineering/STATUS.md",
      "docs/engineering/status/agent-runtime.md",
      "docs/engineering/status/telegram.md",
      "docs/engineering/status/whatsapp.md",
      "docs/engineering/status/tasks.md",
      "docs/engineering/status/memory.md",
      "docs/engineering/status/safety-privacy.md",
      "docs/engineering/status/console.md",
      "docs/engineering/status/platform.md",
      "docs/engineering/status/coding.md",
      "docs/operations/WORKFLOW.md",
      "docs/INDEX.md",
      "tests/agent-context-contract.test.ts",
      "tests/agent-context-freshness.test.ts",
      "package.json",
    ];

    try {
      await execFileAsync("git", ["read-tree", "HEAD"], {
        cwd: repositoryRoot,
        env: gitEnvironment,
      });
      await execFileAsync("git", ["add", "--", ...contractPaths], {
        cwd: repositoryRoot,
        env: gitEnvironment,
      });

      for (const scriptName of [
        "session-context.mjs",
        "context-contract.mjs",
        "context-freshness.mjs",
      ]) {
        const { stdout: scriptSource } = await execFileAsync(
          "git",
          ["show", `:scripts/${scriptName}`],
          { cwd: repositoryRoot, env: gitEnvironment },
        );
        await writeFile(resolve(temporaryDirectory, scriptName), scriptSource, "utf8");
      }

      const stagedEnvironment = {
        ...gitEnvironment,
        HARVY_CONTEXT_ROOT: repositoryRoot,
      };
      const valid = await execFileAsync(
        process.execPath,
        [stagedGenerator, "--check-staged"],
        { cwd: repositoryRoot, env: stagedEnvironment },
      );
      assert.match(valid.stdout, /agent-context: ok/u);

      const { stdout: stagedAgents } = await execFileAsync(
        "git",
        ["show", ":AGENTS.md"],
        { cwd: repositoryRoot, env: gitEnvironment },
      );
      const legacyAgentsPath = resolve(temporaryDirectory, "AGENTS.legacy.md");
      const legacyAgents = stagedAgents.replace(
        "<!-- SESSION_CONTEXT_END -->",
        [
          "- Satu penulis aktif per working tree. Review dan diskusi tidak mengedit.",
          "<!-- SESSION_CONTEXT_END -->",
        ].join("\n"),
      );
      assert.notEqual(legacyAgents, stagedAgents);
      await writeFile(legacyAgentsPath, legacyAgents, "utf8");
      const { stdout: legacyBlob } = await execFileAsync(
        "git",
        ["hash-object", "-w", "--", legacyAgentsPath],
        { cwd: repositoryRoot },
      );
      await execFileAsync(
        "git",
        ["update-index", "--cacheinfo", "100644", legacyBlob.trim(), "AGENTS.md"],
        { cwd: repositoryRoot, env: gitEnvironment },
      );
      await assert.rejects(
        execFileAsync(process.execPath, [stagedGenerator, "--check-staged"], {
          cwd: repositoryRoot,
          env: stagedEnvironment,
        }),
        /retired repository writing coordination rule remains active/u,
      );
      await execFileAsync("git", ["add", "--", "AGENTS.md"], {
        cwd: repositoryRoot,
        env: gitEnvironment,
      });

      await execFileAsync(
        "git",
        ["update-index", "--chmod=-x", ".githooks/pre-commit"],
        { cwd: repositoryRoot, env: gitEnvironment },
      );
      await assert.rejects(
        execFileAsync(process.execPath, [stagedGenerator, "--check-staged"], {
          cwd: repositoryRoot,
          env: stagedEnvironment,
        }),
        /\.githooks\/pre-commit must remain executable/u,
      );
      await execFileAsync(
        "git",
        ["update-index", "--chmod=+x", ".githooks/pre-commit"],
        { cwd: repositoryRoot, env: gitEnvironment },
      );

      await execFileAsync(
        "git",
        ["update-index", "--force-remove", "--", "AGENTS.md"],
        { cwd: repositoryRoot, env: gitEnvironment },
      );
      await assert.rejects(
        execFileAsync(process.execPath, [stagedGenerator, "--check-staged"], {
          cwd: repositoryRoot,
          env: stagedEnvironment,
        }),
        /AGENTS\.md missing from staged snapshot/u,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("menolak format credential dan identifier yang dipakai Harvy", async () => {
    const moduleUrl = pathToFileURL(
      resolve(repositoryRoot, "scripts/session-context.mjs"),
    ).href;
    const contextModule = (await import(moduleUrl)) as {
      assertNoCredentialLikeText(value: string): void;
    };
    const fixtures = [
      `123456789:${"A".repeat(24)}`,
      `TELEGRAM_BOT_TOKEN=${"t".repeat(24)}`,
      `HARVY_CONSOLE_TOKEN=${"c".repeat(24)}`,
      `WEB_SEARCH_API_KEY=${"k".repeat(24)}`,
      `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
      `628123456789@s.whatsapp.net`,
      `+628123456789`,
    ];

    for (const fixture of fixtures) {
      assert.throws(
        () => contextModule.assertNoCredentialLikeText(fixture),
        /credential-like text/u,
      );
    }
    assert.doesNotThrow(() =>
      contextModule.assertNoCredentialLikeText("No credentials or user identifiers here."),
    );
  });

  it("mempertahankan histori dan meredaksi credential-like value", async () => {
    const [archivedLog, archivedStatus] = await Promise.all([
      text("docs/log/2026-08-02-sampai-2026-08-06.md"),
      text("docs/engineering/status/archive/2026-08-06-monolith.md"),
    ]);

    assert.equal(archivedLog.match(/^## /gmu)?.length, 47);
    assert.ok(Buffer.byteLength(archivedStatus, "utf8") > 60_000);
    assert.doesNotMatch(
      archivedLog,
      /Authorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu,
    );
  });
});
