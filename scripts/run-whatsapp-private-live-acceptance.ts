import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { useMultiFileAuthState } from "baileys";
import {
  createIsolatedRuntimeRoot,
  isolatedRuntimeEnvironment,
  liveAcceptancePaths,
  loadRepositoryEnvironment,
  loadTelegramBotCredential,
  removeIsolatedRuntimeRoot,
} from "../src/operations/live-acceptance.js";
import { acquireLocalRuntimeLock } from "../src/core/local-runtime-lock.js";
import { superviseRuntime } from "../src/operations/runtime-supervisor.js";
import {
  isWhatsAppCredentialReady,
  whatsAppCredentialJids,
} from "../src/whatsapp/auth-credential.js";

const ACCEPTANCE_TIMEOUT_MS = 15 * 60_000;
const WHATSAPP_READY_TIMEOUT_MS = 120_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 75_000;
const TRACE_STAGES = [
  "private-upsert-notify",
  "private-upsert-append",
  "private-candidate",
  "private-normalized",
  "private-handler-returned",
  "private-pipeline-failed",
  "private-delivery-attempted",
  "private-delivery-succeeded",
  "private-delivery-failed",
] as const;
const repositoryRequire = createRequire(import.meta.url);

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  loadRepositoryEnvironment(repositoryRoot);
  const paths = liveAcceptancePaths(repositoryRoot);
  const lock = await acquireLocalRuntimeLock(paths.setupLockFile, "evaluation");
  try {
    await runManagedAcceptance(repositoryRoot, paths);
  } finally {
    await lock.release();
  }
}

async function runManagedAcceptance(
  repositoryRoot: string,
  paths: ReturnType<typeof liveAcceptancePaths>,
): Promise<void> {
  const telegram = await loadTelegramBotCredential(paths);
  if (!telegram) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_TELEGRAM_TEST_BOT_NOT_PAIRED");
  }
  await assertAuthDirectory(paths.whatsappHarvyAuth, "HARVY");
  await assertAuthDirectory(paths.whatsappTesterAuth, "TESTER");
  const harvyAuth = await useMultiFileAuthState(paths.whatsappHarvyAuth);
  const testerAuth = await useMultiFileAuthState(paths.whatsappTesterAuth);
  if (!isWhatsAppCredentialReady(harvyAuth.state.creds)) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_HARVY_NOT_PAIRED");
  }
  if (!isWhatsAppCredentialReady(testerAuth.state.creds)) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_TESTER_NOT_PAIRED");
  }
  const harvyIdentities = whatsAppCredentialJids(harvyAuth.state.creds);
  const testerIdentities = whatsAppCredentialJids(testerAuth.state.creds);
  const harvyJid = pnJid(harvyIdentities);
  const testerJid = pnJid(testerIdentities);
  if (!harvyJid || !testerJid) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_IDENTITY_MISSING");
  }
  if (harvyIdentities.some((jid) => testerIdentities.includes(jid))) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_IDENTITIES_MUST_DIFFER");
  }
  const harvyPhone = harvyJid.slice(0, harvyJid.indexOf("@"));
  const harvyDestination = preferredChatJid(harvyIdentities);

  const entry = resolve(repositoryRoot, "dist", "src", "app.js");
  const acceptanceScript = resolve(
    repositoryRoot,
    "scripts",
    "whatsapp-private-live-acceptance.ts",
  );
  const tsxImport = pathToFileURL(repositoryRequire.resolve("tsx")).href;
  if (!(await lstat(entry).catch(() => null))?.isFile()) {
    throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_BUILD_REQUIRED");
  }

  const root = await createIsolatedRuntimeRoot();
  const controller = new AbortController();
  const mode = managedAcceptanceMode(process.env);
  const runtimeEnv = isolatedRuntimeEnvironment(process.env, {
    telegramBotToken: telegram.botToken,
    whatsapp: {
      authRoot: paths.whatsappAuthRoot,
      accountAlias: "harvy",
      phoneNumber: harvyPhone,
    },
  });
  runtimeEnv.HARVY_LIVE_ACCEPTANCE_TRACE = "content-free-v1";
  const trace = Object.fromEntries(
    TRACE_STAGES.map((stage) => [stage, 0]),
  ) as Record<(typeof TRACE_STAGES)[number], number>;
  const runtimeTrace = {
    restartScheduled: 0,
    crashLoopOpened: false,
    shutdownTimedOut: false,
  };
  let markWhatsAppReady!: () => void;
  const whatsappReady = new Promise<void>((resolveReady) => {
    markWhatsAppReady = resolveReady;
  });
  const runtime = superviseRuntime({
    entry,
    cwd: root,
    env: runtimeEnv,
    signal: controller.signal,
    restartBaseMs: 500,
    restartMaxMs: 2_000,
    stableResetMs: 60_000,
    crashWindowMs: 60_000,
    maxCrashes: 3,
    // App memiliki grace shutdown 60 detik. Parent wajib memberi ruang lebih
    // panjang agar drain aktif tidak dipotong lalu meninggalkan file Windows.
    shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
    onEvent: (event) => {
      if (
        event.type === "channel-ready" &&
        event.channel === "whatsapp" &&
        event.accountId === "harvy"
      ) {
        markWhatsAppReady();
      }
      if (
        event.type === "acceptance-trace" &&
        event.channel === "whatsapp" &&
        event.accountId === "harvy" &&
        Object.hasOwn(trace, event.stage)
      ) {
        const stage = event.stage as keyof typeof trace;
        trace[stage] += 1;
      }
      if (event.type === "child-restart-scheduled") {
        runtimeTrace.restartScheduled += 1;
      } else if (event.type === "crash-loop-open") {
        runtimeTrace.crashLoopOpened = true;
      } else if (event.type === "shutdown-timeout") {
        runtimeTrace.shutdownTimedOut = true;
      }
    },
  });
  let runtimeCode = 1;
  let acceptanceCode = 2;
  let runError: unknown;
  let isolatedProductStateRemoved = false;
  try {
    await waitForWhatsAppReady(whatsappReady, runtime);
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, acceptanceScript],
      {
        cwd: root,
        env: {
          ...runtimeEnv,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_CONFIRM:
            "RUN_NONCRITICAL_WHATSAPP_PRIVATE",
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_ACCOUNT: "DEDICATED_TEST_ACCOUNT",
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_TESTER_AUTH_FOLDER:
            paths.whatsappTesterAuth,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_HARVY_JID: harvyJid,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_HARVY_IDENTITIES:
            JSON.stringify(harvyIdentities),
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_HARVY_DESTINATION:
            harvyDestination,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_MODE: mode,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_RUN_LABEL:
            `live-${randomBytes(8).toString("hex")}`,
          HARVY_WHATSAPP_PRIVATE_ACCEPTANCE_TIMEOUT_MS:
            mode === "probe" ? "30000" : "120000",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    acceptanceCode = await waitForExit(child, ACCEPTANCE_TIMEOUT_MS);
  } catch (error) {
    runError = error;
  } finally {
    controller.abort();
    runtimeCode = await runtime.catch(() => 1);
    try {
      await removeIsolatedRuntimeRootWithRetry(root);
      isolatedProductStateRemoved = true;
    } catch {
      runError ??= blocked("WHATSAPP_MANAGED_ACCEPTANCE_ISOLATED_CLEANUP_FAILED");
    }
  }

  const passed = !runError && acceptanceCode === 0 && runtimeCode === 0 &&
    isolatedProductStateRemoved;
  process.stdout.write(`${JSON.stringify({
    protocol: "harvy-whatsapp-private-managed-live-acceptance/1",
    status: passed ? "passed" : "failed",
    testedAt: new Date().toISOString(),
    mode,
    acceptanceExitCode: acceptanceCode,
    runtimeShutdown: runtimeCode === 0 ? "clean" : "failed",
    isolatedProductStateRemoved,
    runtimeTrace,
    productTrace: trace,
    ...(runError ? { code: safeErrorCode(runError) } : {}),
    outputPrivacy: "no_jid_phone_message_text_token_auth_or_path",
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 2;
}

async function removeIsolatedRuntimeRootWithRetry(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await removeIsolatedRuntimeRoot(root);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
  }
  throw lastError;
}

function managedAcceptanceMode(env: NodeJS.ProcessEnv): "full" | "probe" {
  const value = env.HARVY_WHATSAPP_PRIVATE_MANAGED_MODE?.trim() || "full";
  if (value === "full" || value === "probe") return value;
  throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_MODE_INVALID");
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    const onError = (): void => {
      cleanup();
      reject(blocked("WHATSAPP_MANAGED_ACCEPTANCE_PROCESS_FAILED"));
    };
    const onExit = (code: number | null): void => {
      cleanup();
      if (timedOut) reject(blocked("WHATSAPP_MANAGED_ACCEPTANCE_TIMEOUT"));
      else resolvePromise(code ?? 2);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function pnJid(identities: readonly string[]): string | null {
  return identities.find((jid) => jid.endsWith("@s.whatsapp.net")) ?? null;
}

function preferredChatJid(identities: readonly string[]): string {
  return identities.find((jid) => jid.endsWith("@lid")) ?? identities[0]!;
}

async function assertAuthDirectory(path: string, role: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked(`WHATSAPP_MANAGED_ACCEPTANCE_${role}_AUTH_INVALID`);
  }
}

async function waitForWhatsAppReady(
  ready: Promise<void>,
  runtime: Promise<number>,
): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      ready,
      runtime.then(() => {
        throw blocked("WHATSAPP_MANAGED_ACCEPTANCE_RUNTIME_STOPPED_BEFORE_READY");
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(blocked("WHATSAPP_MANAGED_ACCEPTANCE_HARVY_READY_TIMEOUT")),
          WHATSAPP_READY_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{1,160}$/u.test(error.message)
    ? error.message
    : "WHATSAPP_MANAGED_ACCEPTANCE_FAILED";
}

await main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({
    protocol: "harvy-whatsapp-private-managed-live-acceptance/1",
    status: "blocked_or_failed",
    testedAt: new Date().toISOString(),
    code: safeErrorCode(error),
    outputPrivacy: "no_jid_phone_message_text_token_auth_or_path",
  }, null, 2)}\n`);
  process.exitCode = 2;
});
