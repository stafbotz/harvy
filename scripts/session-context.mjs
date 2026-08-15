#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const MAX_CURRENT_BYTES = 5_120;
const MAX_OUTPUT_BYTES = 8_192;
const MAX_AGENTS_BYTES = 12_288;
const MAX_STATUS_INDEX_BYTES = 8_192;
const MAX_ACTIVE_LOG_BYTES = 24 * 1_024;
const START_MARKER = "<!-- SESSION_CONTEXT_START -->";
const END_MARKER = "<!-- SESSION_CONTEXT_END -->";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const readStagedSnapshot = process.argv.includes("--check-staged");
const stagedRoot = process.env.HARVY_CONTEXT_ROOT;
const root = readStagedSnapshot && stagedRoot
  ? resolve(stagedRoot)
  : resolve(scriptDir, "..");
const execFileAsync = promisify(execFile);

async function readRepositoryFile(relativePath) {
  if (readStagedSnapshot) {
    assert(stagedRoot !== undefined, "HARVY_CONTEXT_ROOT is required for staged checks");
    try {
      const { stdout } = await execFileAsync("git", ["show", `:${relativePath}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 2 * 1_024 * 1_024,
      });
      return stdout;
    } catch {
      throw new Error(`${relativePath} missing from staged snapshot`);
    }
  }
  return readFile(resolve(root, relativePath), "utf8");
}

async function assertStagedExecutable(relativePath) {
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

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractBootstrapContract(agents) {
  const start = agents.indexOf(START_MARKER);
  const end = agents.indexOf(END_MARKER);
  assert(start >= 0 && end > start, "bootstrap markers missing from AGENTS.md");
  return agents.slice(start + START_MARKER.length, end).trim();
}

export function assertNoCredentialLikeText(value) {
  const patterns = [
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u,
    /\bsk-[A-Za-z0-9_-]{16,}\b/u,
    /\bAIza[A-Za-z0-9_-]{20,}\b/u,
    /Authorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}/iu,
    /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/u,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
    /(?<![A-Za-z0-9])[\d-]+(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|broadcast)\b/iu,
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"']{8,}/u,
    /[?&](?:token|key|api_?key|secret|password|code)=(?!\[REDACTED\])[^&\s]+/iu,
    /(?<![A-Za-z0-9])(?:\+62|62|08)\d{7,13}(?!\d)/u,
    /\b(?:user|owner|chat|account|group)[_-]?id\s*[:=]\s*\d{6,}\b/iu,
    /[A-Za-z0-9+/]{80,}={0,2}/u,
  ];
  assert(
    !patterns.some((pattern) => pattern.test(value)),
    "credential-like text found in bootstrap sources",
  );
}

export async function buildSessionContext() {
  const [agents, current] = await Promise.all([
    readRepositoryFile("AGENTS.md"),
    readRepositoryFile("docs/agent/CURRENT.md"),
  ]);

  assert(byteLength(agents) <= MAX_AGENTS_BYTES, "AGENTS.md exceeds 12 KiB");
  assert(
    byteLength(current) <= MAX_CURRENT_BYTES,
    "docs/agent/CURRENT.md exceeds 5,120 bytes",
  );

  const contract = extractBootstrapContract(agents);
  const output = [
    "=== Harvy compact session context ===",
    contract,
    "--- Current verified snapshot (not authority) ---",
    current.trim(),
    "=== End Harvy context; inspect code before loading more docs ===",
    "",
  ].join("\n\n");

  assertNoCredentialLikeText(output);
  assert(byteLength(output) <= MAX_OUTPUT_BYTES, "bootstrap output exceeds 8,192 bytes");
  return output;
}

async function validateContractFiles() {
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
    contractTest: "tests/agent-context-contract.test.ts",
    package: "package.json",
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, path]) => [key, await readRepositoryFile(path)]),
  );
  const files = Object.fromEntries(entries);

  await Promise.all([
    assertStagedExecutable(".githooks/pre-commit"),
    assertStagedExecutable("scripts/session-context.sh"),
  ]);

  assert(files.claude.includes("@AGENTS.md"), "CLAUDE.md must import AGENTS.md");
  assert(byteLength(files.claude) <= 1_024, "CLAUDE.md is not a thin adapter");
  assert(
    files.antigravity.includes("@../../AGENTS.md"),
    "Antigravity rule must import AGENTS.md",
  );
  assert(byteLength(files.antigravity) <= 512, "Antigravity rule is not thin");

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
  assert(
    !/docs\/(?:LOG|PROJECT|CONSTITUTION)|docs\/engineering\/STATUS|\b(?:cat|awk)\b/u.test(
      files.shell,
    ),
    "shell wrapper must not read or print large documents",
  );

  const bootstrapContract = extractBootstrapContract(files.agents);
  assert(
    /Koordinasikan penulisan secara adaptif/iu.test(bootstrapContract) &&
      /berurutan,\s*paralel,\s*atau\s*terisolasi/iu.test(bootstrapContract) &&
      /peran agent\s+tidak otomatis menentukan hak edit/iu.test(bootstrapContract),
    "AGENTS.md bootstrap must describe adaptive writing coordination",
  );
  assert(
    /Tidak ada mandat satu penulis untuk seluruh working tree/iu.test(files.workflow) &&
      /Worktree\/clone adalah alat opsional/iu.test(files.workflow),
    "workflow must preserve adaptive repository writing coordination",
  );

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
  assert(
    !/Commit ditahan:.*LOG|LOG.*tidak ikut berubah|grep\s+-q.*LOG/iu.test(files.hook),
    "pre-commit must not force LOG updates",
  );

  assert(
    byteLength(files.status) <= MAX_STATUS_INDEX_BYTES,
    "STATUS.md summary exceeds 8 KiB",
  );
  assert(byteLength(files.log) <= MAX_ACTIVE_LOG_BYTES, "active LOG.md exceeds 24 KiB");
  const materialLogEntries = files.log.match(/^## \d{4}-\d{2}-\d{2} — /gmu)?.length ?? 0;
  assert(materialLogEntries <= 12, "active LOG.md exceeds 12 material entries");
  assert(byteLength(files.generator) <= 12_288, "session context generator exceeds 12 KiB");
  assert(
    files.contractTest.includes("kontrak konteks coding agent"),
    "agent context contract test source is missing or invalid",
  );
  const packageJson = JSON.parse(files.package);
  assert(
    packageJson?.scripts?.["context:check"] === "node scripts/session-context.mjs --check",
    "package.json must expose the canonical context:check command",
  );
  const subsystemFiles = [
    "agent-runtime.md",
    "telegram.md",
    "whatsapp.md",
    "tasks.md",
    "memory.md",
    "safety-privacy.md",
    "console.md",
    "platform.md",
  ];
  for (const name of subsystemFiles) {
    assert(files.status.includes(`status/${name}`), `STATUS.md does not link ${name}`);
    await readRepositoryFile(`docs/engineering/status/${name}`);
  }
}

async function main() {
  const output = await buildSessionContext();
  if (process.argv.includes("--check") || process.argv.includes("--check-staged")) {
    await validateContractFiles();
    const bytes = byteLength(output);
    process.stdout.write(
      `agent-context: ok; output=${bytes} bytes; estimate=${Math.ceil(bytes / 4)} tokens\n`,
    );
    return;
  }
  process.stdout.write(output);
}

const directRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (directRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown validation failure";
    process.stderr.write(`agent-context: ${message}\n`);
    process.exitCode = 1;
  });
}
