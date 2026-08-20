#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const MAX_STATUS_INDEX_BYTES = 8_192;
const MAX_ACTIVE_LOG_BYTES = 24 * 1_024;
const MAX_SESSION_CONTEXT_BYTES = 6_144;
const MAX_CONTEXT_CONTRACT_BYTES = 12_288;
const MAX_CONTEXT_FRESHNESS_BYTES = 8_192;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const execFileAsyncDefault = promisify(execFile);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function assertStagedExecutable(
  relativePath,
  { root, readStagedSnapshot, execFileAsync = execFileAsyncDefault } = {},
) {
  if (!readStagedSnapshot) {
    return;
  }
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--stage", "--", relativePath],
    { cwd: root, encoding: "utf8" },
  );
  assert(
    stdout.startsWith("100755 "),
    `${relativePath} must remain executable in the staged snapshot`,
  );
}

export async function validateContractFiles({
  root = resolve(scriptDir, ".."),
  readRepositoryFile,
  execFileAsync = execFileAsyncDefault,
  readStagedSnapshot = false,
} = {}) {
  const paths = {
    agents: "AGENTS.md",
    claude: "CLAUDE.md",
    antigravity: ".agent/rules/00-harvy-bootstrap.md",
    settings: ".claude/settings.json",
    shell: "scripts/session-context.sh",
    workflow: "docs/operations/WORKFLOW.md",
    index: "docs/INDEX.md",
    status: "docs/engineering/STATUS.md",
    log: "docs/LOG.md",
    hook: ".githooks/pre-commit",
    generator: "scripts/session-context.mjs",
    contractScript: "scripts/context-contract.mjs",
    freshnessScript: "scripts/context-freshness.mjs",
    contractTest: "tests/agent-context-contract.test.ts",
    package: "package.json",
  };

  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await readRepositoryFile(path)]),
  );
  const files = Object.fromEntries(entries);

  await Promise.all([
    assertStagedExecutable(".githooks/pre-commit", { root, readStagedSnapshot, execFileAsync }),
    assertStagedExecutable("scripts/session-context.sh", { root, readStagedSnapshot, execFileAsync }),
  ]);

  // 1. Adapters check
  assert(files.claude.includes("@AGENTS.md"), "CLAUDE.md must import AGENTS.md");
  assert(byteLength(files.claude) <= 1_024, "CLAUDE.md is not a thin adapter");
  assert(
    files.antigravity.includes("@../../AGENTS.md"),
    "Antigravity rule must import AGENTS.md",
  );
  assert(byteLength(files.antigravity) <= 512, "Antigravity rule is not thin");

  // 2. Settings check
  const settings = JSON.parse(files.settings);
  const sessionStart = settings?.hooks?.SessionStart;
  assert(
    Array.isArray(sessionStart) && sessionStart.length === 1,
    "Claude must define exactly one SessionStart bootstrap group",
  );
  const sessionHooks = sessionStart[0]?.hooks;
  assert(
    Array.isArray(sessionHooks) && sessionHooks.length === 1,
    "Claude must define exactly one SessionStart bootstrap hook",
  );
  const sessionHook = sessionHooks[0];
  assert(
    sessionHook?.type === "command" &&
      sessionHook.command === "node" &&
      Array.isArray(sessionHook.args) &&
      sessionHook.args.length === 1 &&
      sessionHook.args[0] === "${CLAUDE_PROJECT_DIR}/scripts/session-context.mjs",
    "Claude SessionStart must call the portable context generator",
  );

  // 3. Shell wrapper check
  assert(
    !/docs\/(?:LOG|PROJECT|CONSTITUTION)|docs\/engineering\/STATUS|\b(?:cat|awk)\b/u.test(
      files.shell,
    ),
    "shell wrapper must not read or print large documents",
  );

  // 4. Adaptive writing coordination
  assert(
    /Koordinasikan penulisan secara adaptif/iu.test(files.agents) &&
      /berurutan,\s*paralel,\s*atau\s*terisolasi/iu.test(files.agents) &&
      /peran agent\s+tidak otomatis menentukan hak edit/iu.test(files.agents),
    "AGENTS.md must describe adaptive writing coordination",
  );
  assert(
    /Tidak ada mandat satu penulis untuk seluruh working tree/iu.test(files.workflow) &&
      /Worktree\/clone adalah alat opsional/iu.test(files.workflow),
    "workflow must preserve adaptive repository writing coordination",
  );

  // 5. Retired mandates check
  const activeContract = [
    files.agents,
    files.claude,
    files.antigravity,
    files.workflow,
    files.index,
    files.shell,
    files.log,
    files.hook,
  ].join("\n");

  const retiredMandates = [
    /~15 entri terbaru/iu,
    /termasuk sesi yang hanya berdiskusi/iu,
    /Baca konteks sebelum menjawab:\s*docs\/PROJECT\.md/iu,
    /Commit ditahan:\s*docs\/LOG\.md/iu,
    /docs\/LOG\.md tidak ikut berubah/iu,
  ];
  assert(
    !retiredMandates.some((pattern) => pattern.test(activeContract)),
    "retired mandatory-bootstrap or LOG rule remains active",
  );

  const retiredWritingMandates = [
    /Satu penulis aktif per working tree/iu,
    /Satu pihak menulis pada satu working tree/iu,
    /Hanya satu pihak menulis file pada satu waktu/iu,
    /agent lain boleh audit\/QA\s+baca-saja/iu,
    /Bila dua penulis benar-benar diperlukan,\s*gunakan worktree\/clone terpisah/iu,
    /Kerja paralel hanya\s+diizinkan untuk paket dan folder kerja yang benar-benar terisolasi/iu,
  ];
  assert(
    !retiredWritingMandates.some((pattern) => pattern.test(activeContract)),
    "retired repository writing coordination rule remains active",
  );

  // 6. Hook assertions
  assert(
    !/Commit ditahan:.*LOG|LOG.*tidak ikut berubah|grep\s+-q.*LOG/iu.test(files.hook),
    "pre-commit must not force LOG updates",
  );

  // 7. Size and limits assertions
  assert(
    byteLength(files.status) <= MAX_STATUS_INDEX_BYTES,
    "STATUS.md summary exceeds 8 KiB",
  );
  assert(byteLength(files.log) <= MAX_ACTIVE_LOG_BYTES, "active LOG.md exceeds 24 KiB");
  const materialLogEntries = files.log.match(/^## \d{4}-\d{2}-\d{2} — /gmu)?.length ?? 0;
  assert(materialLogEntries <= 12, "active LOG.md exceeds 12 material entries");

  assert(
    byteLength(files.generator) <= MAX_SESSION_CONTEXT_BYTES,
    "session context generator exceeds 6 KiB",
  );
  assert(
    byteLength(files.contractScript) <= MAX_CONTEXT_CONTRACT_BYTES,
    "context contract validator exceeds 12 KiB",
  );
  assert(
    byteLength(files.freshnessScript) <= MAX_CONTEXT_FRESHNESS_BYTES,
    "context freshness validator exceeds 8 KiB",
  );

  assert(
    files.contractTest.includes("kontrak konteks coding agent"),
    "agent context contract test source is missing or invalid",
  );

  const packageJson = JSON.parse(files.package);
  assert(
    packageJson?.scripts?.["context:check"] === "node scripts/session-context.mjs --check",
    "package.json must expose the canonical context:check command",
  );

  // 8. Subsystem status links
  const subsystemFiles = [
    "agent-runtime.md",
    "telegram.md",
    "whatsapp.md",
    "tasks.md",
    "memory.md",
    "safety-privacy.md",
    "console.md",
    "platform.md",
    "coding.md",
  ];
  for (const name of subsystemFiles) {
    assert(files.status.includes(`status/${name}`), `STATUS.md does not link ${name}`);
    await readRepositoryFile(`docs/engineering/status/${name}`);
  }
}
