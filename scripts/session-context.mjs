#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validateContractFiles } from "./context-contract.mjs";
import { validateContextFreshness } from "./context-freshness.mjs";

export const MAX_CURRENT_BYTES = 5_120;
export const MAX_OUTPUT_BYTES = 8_192;
export const MAX_AGENTS_BYTES = 12_288;
export const START_MARKER = "<!-- SESSION_CONTEXT_START -->";
export const END_MARKER = "<!-- SESSION_CONTEXT_END -->";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const readStagedSnapshot = process.argv.includes("--check-staged");
const stagedRoot = process.env.HARVY_CONTEXT_ROOT;
const root = readStagedSnapshot && stagedRoot
  ? resolve(stagedRoot)
  : resolve(scriptDir, "..");
const execFileAsync = promisify(execFile);

export function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export async function readRepositoryFile(relativePath) {
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

export function extractBootstrapContract(agents) {
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

export async function buildSessionContext(options = {}) {
  const fileReader = options.readRepositoryFile || readRepositoryFile;
  const [agents, current] = await Promise.all([
    fileReader("AGENTS.md"),
    fileReader("docs/agent/CURRENT.md"),
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

export async function runContextCheck(options = {}) {
  const contextOptions = {
    root,
    readRepositoryFile,
    execFileAsync,
    readStagedSnapshot,
    ...options,
  };

  const output = await buildSessionContext(contextOptions);
  await validateContractFiles(contextOptions);
  const freshness = await validateContextFreshness(contextOptions);

  if (freshness?.warnings?.length > 0) {
    for (const warning of freshness.warnings) {
      process.stderr.write(`agent-context warning: ${warning}\n`);
    }
  }

  const bytes = byteLength(output);
  process.stdout.write(
    `agent-context: ok; output=${bytes} bytes; estimate=${Math.ceil(bytes / 4)} tokens\n`,
  );
  return { output, freshness };
}

async function main() {
  if (process.argv.includes("--check") || process.argv.includes("--check-staged")) {
    await runContextCheck();
    return;
  }
  const output = await buildSessionContext();
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
