import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import makeWASocket, {
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
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

const GROUP_ACCEPTANCE_TIMEOUT_MS = 15 * 60_000;
const WHATSAPP_READY_TIMEOUT_MS = 120_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 75_000;
const repositoryRequire = createRequire(import.meta.url);

async function main(): Promise<void> {
  if (!process.argv.includes("--create-disposable-group")) {
    throw blocked("WHATSAPP_GROUP_MANAGED_REQUIRES_DISPOSABLE_GROUP_FLAG");
  }
  const repositoryRoot = process.cwd();
  loadRepositoryEnvironment(repositoryRoot);
  const paths = liveAcceptancePaths(repositoryRoot);
  const lock = await acquireLocalRuntimeLock(paths.setupLockFile, "evaluation");
  try {
    await runManagedGroupAcceptance(repositoryRoot, paths);
  } finally {
    await lock.release();
  }
}

async function runManagedGroupAcceptance(
  repositoryRoot: string,
  paths: ReturnType<typeof liveAcceptancePaths>,
): Promise<void> {
  const telegram = await loadTelegramBotCredential(paths);
  if (!telegram) {
    throw blocked("WHATSAPP_GROUP_MANAGED_TELEGRAM_TEST_BOT_NOT_PAIRED");
  }
  await assertAuthDirectory(paths.whatsappHarvyAuth, "HARVY");
  await assertAuthDirectory(paths.whatsappTesterAuth, "TESTER");
  const harvyAuth = await useMultiFileAuthState(paths.whatsappHarvyAuth);
  const testerAuth = await useMultiFileAuthState(paths.whatsappTesterAuth);
  if (!isWhatsAppCredentialReady(harvyAuth.state.creds)) {
    throw blocked("WHATSAPP_GROUP_MANAGED_HARVY_NOT_PAIRED");
  }
  if (!isWhatsAppCredentialReady(testerAuth.state.creds)) {
    throw blocked("WHATSAPP_GROUP_MANAGED_TESTER_NOT_PAIRED");
  }
  const harvyIdentities = whatsAppCredentialJids(harvyAuth.state.creds);
  const testerIdentities = whatsAppCredentialJids(testerAuth.state.creds);
  const harvyJid = pnJid(harvyIdentities);
  if (!harvyJid || !pnJid(testerIdentities)) {
    throw blocked("WHATSAPP_GROUP_MANAGED_IDENTITY_MISSING");
  }
  if (harvyIdentities.some((jid) => testerIdentities.includes(jid))) {
    throw blocked("WHATSAPP_GROUP_MANAGED_IDENTITIES_MUST_DIFFER");
  }
  const acceptanceHarvyJid = harvyJid;
  const staleGroupsCleaned = await cleanupRecentManagedGroups(
    paths.whatsappTesterAuth,
    acceptanceHarvyJid,
    harvyIdentities,
  );
  const harvyPhone = acceptanceHarvyJid.slice(
    0,
    acceptanceHarvyJid.indexOf("@"),
  );
  const entry = resolve(repositoryRoot, "dist", "src", "app.js");
  const acceptanceScript = resolve(
    repositoryRoot,
    "scripts",
    "whatsapp-live-acceptance.ts",
  );
  const tsxImport = pathToFileURL(repositoryRequire.resolve("tsx")).href;
  if (!(await lstat(entry).catch(() => null))?.isFile()) {
    throw blocked("WHATSAPP_GROUP_MANAGED_BUILD_REQUIRED");
  }

  let groupJid: string | null = null;
  let groupCreated = false;
  let harvyRemovedDuringCleanup = false;
  let testerLeftGroup = false;
  let runtimeCode = 1;
  let acceptanceCode = 2;
  let isolatedProductStateRemoved = false;
  let runError: unknown;
  const root = await createIsolatedRuntimeRoot();
  const controller = new AbortController();
  try {
    const creator = await connectAccount(paths.whatsappTesterAuth);
    try {
      const group = await creator.groupCreate(
        `Harvy acceptance ${randomBytes(4).toString("hex")}`,
        [acceptanceHarvyJid],
      );
      groupJid = group.id;
      if (!isJidGroup(group.id) || !/^[0-9-]{5,80}@g\.us$/u.test(group.id)) {
        throw blocked("WHATSAPP_GROUP_MANAGED_GROUP_ID_INVALID");
      }
      groupCreated = true;
      if (!participantPresent(group.participants, harvyIdentities)) {
        throw blocked("WHATSAPP_GROUP_MANAGED_HARVY_ADD_FAILED");
      }
    } finally {
      await creator.end(undefined).catch(() => undefined);
    }

    const runtimeEnv = isolatedRuntimeEnvironment(process.env, {
      telegramBotToken: telegram.botToken,
      whatsapp: {
        authRoot: paths.whatsappAuthRoot,
        accountAlias: "harvy",
        phoneNumber: harvyPhone,
      },
    });
    runtimeEnv.WHATSAPP_GROUP_AGENT_RUN_ENABLED = "true";
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
      shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
      onEvent: (event) => {
        if (
          event.type === "channel-ready" &&
          event.channel === "whatsapp" && event.accountId === "harvy"
        ) markWhatsAppReady();
      },
    });
    try {
      await waitForWhatsAppReady(whatsappReady, runtime);
      const child = spawn(
        process.execPath,
        ["--import", tsxImport, acceptanceScript],
        {
          cwd: root,
          env: {
            ...runtimeEnv,
            HARVY_WHATSAPP_ACCEPTANCE_CONFIRM:
              "RUN_NONCRITICAL_WHATSAPP_GROUP",
            HARVY_WHATSAPP_ACCEPTANCE_TESTER_AUTH_FOLDER:
              paths.whatsappTesterAuth,
            HARVY_WHATSAPP_ACCEPTANCE_GROUP_JID: groupJid,
            HARVY_WHATSAPP_ACCEPTANCE_HARVY_JID: acceptanceHarvyJid,
            HARVY_WHATSAPP_ACCEPTANCE_HARVY_IDENTITIES:
              JSON.stringify(harvyIdentities),
            HARVY_WHATSAPP_ACCEPTANCE_TESTER_IDENTITIES:
              JSON.stringify(testerIdentities),
            HARVY_WHATSAPP_ACCEPTANCE_RUN_LABEL:
              `live-${randomBytes(8).toString("hex")}`,
            HARVY_WHATSAPP_ACCEPTANCE_STAGE_TIMEOUT_MS: "120000",
            HARVY_WHATSAPP_ACCEPTANCE_MANAGED_SCOPE:
              "DISPOSABLE_PARTIAL_GROUP",
          },
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      acceptanceCode = await waitForExit(child, GROUP_ACCEPTANCE_TIMEOUT_MS);
    } finally {
      controller.abort();
      runtimeCode = await runtime.catch(() => 1);
    }
  } catch (error) {
    runError = error;
  } finally {
    controller.abort();
    if (groupJid) {
      try {
        const cleanup = await connectAccount(paths.whatsappTesterAuth);
        try {
          const metadata = await cleanup.groupMetadata(groupJid);
          if (participantPresent(metadata.participants, harvyIdentities)) {
            await cleanup.groupParticipantsUpdate(
              groupJid,
              [acceptanceHarvyJid],
              "remove",
            );
            harvyRemovedDuringCleanup = true;
          } else {
            harvyRemovedDuringCleanup = true;
          }
          await cleanup.groupLeave(groupJid);
          testerLeftGroup = true;
        } finally {
          await cleanup.end(undefined).catch(() => undefined);
        }
      } catch (error) {
        runError ??= error;
      }
    }
    try {
      await removeIsolatedRuntimeRoot(root);
      isolatedProductStateRemoved = true;
    } catch (error) {
      runError ??= error;
    }
  }

  const passed = !runError && groupCreated && acceptanceCode === 0 &&
    runtimeCode === 0 && harvyRemovedDuringCleanup && testerLeftGroup &&
    isolatedProductStateRemoved;
  process.stdout.write(`${JSON.stringify({
    protocol: "harvy-whatsapp-group-managed-live-acceptance/1",
    status: passed ? "passed_partial_live_scope" : "failed",
    testedAt: new Date().toISOString(),
    groupCreated,
    staleGroupsCleaned,
    acceptanceExitCode: acceptanceCode,
    runtimeShutdown: runtimeCode === 0 ? "clean" : "failed",
    cleanup: {
      harvyRemoved: harvyRemovedDuringCleanup,
      testerLeft: testerLeftGroup,
      isolatedProductStateRemoved,
    },
    ...(runError ? { code: safeErrorCode(runError) } : {}),
    deliberatelyNotProven: [
      "second_human_participant",
      "crash_between_group_send_and_receipt_commit",
      "group_coding_workspace_publish",
    ],
    outputPrivacy: "no_group_jid_phone_message_text_token_auth_or_path",
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 2;
}

async function cleanupRecentManagedGroups(
  authFolder: string,
  harvyJid: string,
  harvyIdentities: readonly string[],
): Promise<number> {
  const socket = await connectAccount(authFolder);
  let cleaned = 0;
  try {
    const groups = Object.values(await socket.groupFetchAllParticipating());
    const earliest = Math.floor(Date.now() / 1_000) - 60 * 60;
    const candidates = groups.filter((group) =>
      /^Harvy acceptance [a-f0-9]{8}$/u.test(group.subject) &&
      (group.creation ?? 0) >= earliest &&
      (group.participants.length <= 3) &&
      participantPresent(group.participants, harvyIdentities)
    );
    for (const group of candidates) {
      await socket.groupParticipantsUpdate(group.id, [harvyJid], "remove");
      await socket.groupLeave(group.id);
      cleaned += 1;
    }
    return cleaned;
  } finally {
    await socket.end(undefined).catch(() => undefined);
  }
}

async function connectAccount(authFolder: string): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  if (!isWhatsAppCredentialReady(state.creds)) {
    throw blocked("WHATSAPP_GROUP_MANAGED_TESTER_NOT_PAIRED");
  }
  const logger = silentBaileysLogger();
  const socket = makeWASocket({
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
  });
  socket.ev.on("creds.update", saveCreds);
  await waitForOpen(socket, WHATSAPP_READY_TIMEOUT_MS);
  return socket;
}

function participantPresent(
  participants: readonly {
    id: string;
    lid?: string;
    phoneNumber?: string;
  }[],
  identities: readonly string[],
): boolean {
  return participants.some((participant) =>
    [participant.id, participant.lid, participant.phoneNumber].some((value) =>
      Boolean(value) && identities.includes(jidNormalizedUser(value ?? ""))
    )
  );
}

function waitForOpen(socket: WASocket, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(blocked("WHATSAPP_GROUP_MANAGED_CONNECTION_TIMEOUT"));
    }, timeoutMs);
    const handler = (update: { connection?: string }) => {
      if (update.connection === "open") {
        cleanup();
        resolvePromise();
      } else if (update.connection === "close") {
        cleanup();
        reject(blocked("WHATSAPP_GROUP_MANAGED_CONNECTION_CLOSED"));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.ev.off("connection.update", handler);
    };
    socket.ev.on("connection.update", handler);
  });
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
        throw blocked("WHATSAPP_GROUP_MANAGED_RUNTIME_STOPPED_BEFORE_READY");
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(blocked("WHATSAPP_GROUP_MANAGED_HARVY_READY_TIMEOUT")),
          WHATSAPP_READY_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once("error", () => {
      cleanup();
      reject(blocked("WHATSAPP_GROUP_MANAGED_PROCESS_FAILED"));
    });
    child.once("exit", (code) => {
      cleanup();
      if (timedOut) reject(blocked("WHATSAPP_GROUP_MANAGED_TIMEOUT"));
      else resolvePromise(code ?? 2);
    });
  });
}

function pnJid(identities: readonly string[]): string | null {
  return identities.find((jid) => jid.endsWith("@s.whatsapp.net")) ?? null;
}

async function assertAuthDirectory(path: string, role: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked(`WHATSAPP_GROUP_MANAGED_${role}_AUTH_INVALID`);
  }
}

function silentBaileysLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error &&
      typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : error instanceof Error && /^[A-Z0-9_]{1,160}$/u.test(error.message)
      ? error.message
      : "WHATSAPP_GROUP_MANAGED_FAILED";
}

await main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({
    protocol: "harvy-whatsapp-group-managed-live-acceptance/1",
    status: "blocked_or_failed",
    testedAt: new Date().toISOString(),
    code: safeErrorCode(error),
    outputPrivacy: "no_group_jid_phone_message_text_token_auth_or_path",
  }, null, 2)}\n`);
  process.exitCode = 2;
});
