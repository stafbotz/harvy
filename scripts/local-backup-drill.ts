import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadCodingRuntimeDeploymentConfig } from
  "../src/core/coding-runtime-composition.js";
import {
  createLocalBackup,
  createRuntimeBackupPlan,
  restoreLocalBackup,
  verifyLocalBackup,
  type LocalBackupSummary,
} from "../src/operations/local-backup.js";

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (
      !(error instanceof Error) || !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) throw error;
  }
}

async function main(): Promise<void> {
  loadEnvironment();
  const key = randomBytes(32);
  const root = await mkdtemp(join(tmpdir(), "harvy-backup-drill-"));
  const archive = join(root, "backup.harvy");
  const restoreRoot = join(root, "restored");
  try {
    const plan = createRuntimeBackupPlan(
      loadConfig(),
      loadCodingRuntimeDeploymentConfig(),
    );
    const created = await createLocalBackup({
      plan,
      destination: archive,
      key,
    });
    const verified = await verifyLocalBackup({ archive, key });
    const restored = await restoreLocalBackup({
      archive,
      destinationDirectory: restoreRoot,
      key,
    });
    assertSameInventory(created, verified, "verify");
    assertSameInventory(created, restored, "restore");
    await access(join(restoreRoot, "RESTORE-MAP.json"));
    await rm(root, { recursive: true, force: true });
    process.stdout.write(`${JSON.stringify({
      protocol: "harvy-local-backup-drill/1",
      status: "passed",
      keyScope: "ephemeral-in-memory",
      sourceState: "current-configured-runtime",
      targetCount: created.targetCount,
      presentTargetCount: created.presentTargetCount,
      entryCount: created.entryCount,
      plaintextBytes: created.plaintextBytes,
      encrypted: created.encrypted,
      restoreMapPresent: true,
      artifactsRemoved: true,
      outputPrivacy: "no-key-path-content-or-user-data",
    }, null, 2)}\n`);
  } finally {
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}

function assertSameInventory(
  expected: LocalBackupSummary,
  observed: LocalBackupSummary,
  phase: "verify" | "restore",
): void {
  for (const field of [
    "protocol",
    "createdAt",
    "targetCount",
    "presentTargetCount",
    "entryCount",
    "plaintextBytes",
    "encrypted",
  ] as const) {
    if (observed[field] !== expected[field]) {
      throw Object.assign(new Error(`Inventory ${phase} berbeda pada ${field}.`), {
        code: `BACKUP_DRILL_${phase.toUpperCase()}_MISMATCH`,
      });
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,96}$/u.test(code)) return code;
  }
  return "BACKUP_DRILL_FAILED";
}

await main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    protocol: "harvy-local-backup-drill/1",
    status: "failed",
    code: safeErrorCode(error),
    outputPrivacy: "no-key-path-content-or-user-data",
  })}\n`);
  process.exitCode = 1;
});
