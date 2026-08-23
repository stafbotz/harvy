import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadCodingRuntimeDeploymentConfig } from
  "../src/core/coding-runtime-composition.js";
import {
  createLocalBackup,
  createRuntimeBackupPlan,
  environmentFileContainsBackupKey,
  loadBackupKey,
  restoreLocalBackup,
  verifyLocalBackup,
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

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  if (!value) {
    throw Object.assign(new Error(`Argumen --${name} wajib diisi.`), {
      code: "BACKUP_ARGUMENT_MISSING",
    });
  }
  return value;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,96}$/u.test(code)) return code;
  }
  return "BACKUP_OPERATION_FAILED";
}

async function main(): Promise<void> {
  loadEnvironment();
  const command = process.argv[2] ?? "";
  const keyMaterial = await loadBackupKey();
  try {
    if (command === "create") {
      const includeEnvironment = process.argv.includes("--include-env");
      const environmentFile = includeEnvironment ? resolve(".env") : null;
      if (
        environmentFile &&
        await environmentFileContainsBackupKey(environmentFile)
      ) {
        throw Object.assign(
          new Error(
            ".env memuat kunci backup sendiri; pindahkan kunci ke environment proses atau file di luar target backup.",
          ),
          { code: "BACKUP_ENVIRONMENT_CONTAINS_KEY" },
        );
      }
      const config = loadConfig();
      const coding = loadCodingRuntimeDeploymentConfig();
      const plan = createRuntimeBackupPlan(config, coding, {
        environmentFile,
        excludedPaths: keyMaterial.sourcePath ? [keyMaterial.sourcePath] : [],
      });
      const summary = await createLocalBackup({
        plan,
        destination: argument("output"),
        key: keyMaterial.key,
      });
      console.log(JSON.stringify({ status: "passed", operation: "create", ...summary }, null, 2));
      return;
    }
    if (command === "verify") {
      const summary = await verifyLocalBackup({
        archive: argument("input"),
        key: keyMaterial.key,
      });
      console.log(JSON.stringify({ status: "passed", operation: "verify", ...summary }, null, 2));
      return;
    }
    if (command === "restore") {
      const summary = await restoreLocalBackup({
        archive: argument("input"),
        destinationDirectory: argument("output-dir"),
        key: keyMaterial.key,
      });
      console.log(JSON.stringify({ status: "passed", operation: "restore", ...summary }, null, 2));
      return;
    }
    throw Object.assign(
      new Error("Gunakan create, verify, atau restore."),
      { code: "BACKUP_COMMAND_INVALID" },
    );
  } finally {
    keyMaterial.key.fill(0);
  }
}

await main().catch((error: unknown) => {
  console.error(JSON.stringify({
    status: "failed",
    code: safeErrorCode(error),
    outputPrivacy: "no-secret-path-content-or-user-data",
  }));
  process.exitCode = 1;
});
