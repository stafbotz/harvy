import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// Full-suite Windows runs compile/import hundreds of modules concurrently.
// On a two-core host the child can spend more than 30 s waiting for its cold
// module graph while another test worker is saturated. Keep readiness bounded,
// but do not classify pre-control import contention as a control-plane failure;
// the actual shutdown deadline below remains a strict 10 s.
const CONTROL_READY_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 10_000;

describe("application startup shutdown barrier", () => {
  it("tidak menjadi ready dan melepas lock ketika dev-stop tiba saat startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-app-startup-stop-"));
    const controlPlaneFile = join(root, "control-plane.json");
    const lockFile = `${controlPlaneFile}.runtime.lock`;
    const output: string[] = [];
    const child = spawn(process.execPath, [resolve("dist/src/app.js")], {
      cwd: process.cwd(),
      env: isolatedRuntimeEnvironment(root, controlPlaneFile),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(
          () => rejectReady(new Error(
            `Control startup tidak menjadi ready.\n${output.join("")}`,
          )),
          CONTROL_READY_TIMEOUT_MS,
        );
        child.once("message", (message: unknown) => {
          if (
            typeof message !== "object" || message === null ||
            !("type" in message) ||
            message.type !== "harvy-dev-control-ready"
          ) {
            clearTimeout(timer);
            rejectReady(new Error("Pesan control startup tidak dikenal."));
            return;
          }
          clearTimeout(timer);
          child.send({ type: "harvy-dev-shutdown", reason: "dev-stop" });
          resolveReady();
        });
      });

      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, rejectExit) => {
          const timer = setTimeout(
            () => rejectExit(new Error("Aplikasi tidak berhenti setelah dev-stop.")),
            10_000,
          );
          timer.unref();
        }),
      ]);
      assert.deepEqual(result, { code: 0, signal: null }, output.join(""));
      assert.doesNotMatch(output.join(""), /application_ready/u);
      await assert.rejects(
        access(lockFile),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ENOENT",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.send({ type: "harvy-dev-shutdown", reason: "dev-stop" });
        } catch {
          // Child sudah keluar di antara pemeriksaan dan send.
        }
        await Promise.race([
          exited,
          new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

function isolatedRuntimeEnvironment(
  root: string,
  controlPlaneFile: string,
): NodeJS.ProcessEnv {
  const file = (name: string): string => join(root, `${name}.json`);
  return {
    ...process.env,
    HARVY_DEV_RUNNER: "1",
    APP_ENV: "development",
    TELEGRAM_BOT_TOKEN: `123456789:${"t".repeat(32)}`,
    HARVY_TELEGRAM_TOKEN_EPHEMERAL: "live-acceptance-v1",
    AI_MODE: "testing",
    GOOGLE_AI_STUDIO_API_KEYS: "test-key",
    AI_MODEL_TESTING: "test-model",
    AI_MODEL_ROLE_BINDINGS: "",
    AI_SPECIALIST_DELEGATION_ENABLED: "false",
    AI_MODEL_PROFILES: "",
    AI_TESTING_FALLBACK_BASE_URL: "",
    AI_TESTING_FALLBACK_API_KEY: "",
    AI_TESTING_FALLBACK_MODEL: "",
    MEMORY_EMBEDDING_MODEL: "",
    WHATSAPP_ENABLED: "false",
    WHATSAPP_ACCOUNTS: "[]",
    WHATSAPP_GROUP_AGENT_RUN_ENABLED: "false",
    HARVY_CONSOLE_ENABLED: "false",
    HARVY_CONSOLE_TOKEN: "",
    LOG_CONSOLE: "true",
    LOG_CONSOLE_FORMAT: "json",
    LOG_FILE_REQUIRED: "false",
    LOG_FOLDER: join(root, "logs"),
    DATA_FILE: file("tasks"),
    MEMORY_FILE: file("legacy-memories"),
    MEMORY_FOLDER: join(root, "memories"),
    HISTORY_FILE: file("history"),
    PROFILE_FILE: file("profiles"),
    SESSION_FILE: file("sessions"),
    AGENT_RUN_FILE: file("agent-runs"),
    TELEMETRY_FILE: file("telemetry"),
    CONTROL_PLANE_FILE: controlPlaneFile,
    USAGE_LEDGER_FILE: file("usage-ledger"),
    ENTITLEMENT_LEDGER_FILE: file("entitlement-ledger"),
    WHATSAPP_AUTH_FOLDER: join(root, "whatsapp-auth"),
    WHATSAPP_GROUP_FILE: file("whatsapp-groups"),
    WHATSAPP_GROUP_AGENT_RUN_FILE: file("whatsapp-group-agent-runs"),
    WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE: file(
      "whatsapp-group-agent-run-cleanup",
    ),
  };
}
