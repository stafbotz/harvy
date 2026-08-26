import { ConsoleServer } from "../src/console/console-server.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import {
  createIsolatedRuntimeRoot,
  loadRepositoryEnvironment,
  removeIsolatedRuntimeRoot,
} from "../src/operations/live-acceptance.js";
import { ChannelSetupService } from "../src/operations/channel-setup.js";
import { CodingRuntimeSetupService } from
  "../src/operations/coding-runtime-setup.js";
import {
  acquireLocalRuntimeLock,
  localRuntimeLockPath,
  type LocalRuntimeLock,
} from "../src/core/local-runtime-lock.js";
import {
  operatorSecretChannelAvailable,
  presentOperatorSecret,
} from "../src/observability/operator-secret.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";
import { join, resolve } from "node:path";

async function main(): Promise<void> {
  loadRepositoryEnvironment();
  const temporaryRoot = await createIsolatedRuntimeRoot();
  let server: ConsoleServer | null = null;
  let runtimeLock: LocalRuntimeLock | null = null;
  try {
    runtimeLock = await acquireLocalRuntimeLock(
      localRuntimeLockPath(resolve(
        process.env.CONTROL_PLANE_FILE ?? "./data/control-plane.json",
      )),
      "setup",
    );
    const controlPlane = new ControlPlaneService(
      new FileControlPlaneRepository(join(temporaryRoot, "console-control.json")),
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [{
          providerId: "setup-console",
          modelId: "setup-only",
          active: true,
          sources: [{
            environmentVariable: "CHANNEL_SETUP_ONLY",
            mode: "testing",
            origin: "primary",
            tiers: ["cheap", "efficient", "ambitious"],
            active: true,
          }],
        }],
        priceBootstraps: [],
      },
    );
    const usageLedger = new UsageLedgerService(
      new FileUsageLedgerRepository(join(temporaryRoot, "console-usage.json")),
      controlPlane,
      { retentionDays: 1 },
    );
    const setup = new ChannelSetupService();
    const codingSetup = new CodingRuntimeSetupService();
    server = new ConsoleServer(
      controlPlane,
      usageLedger,
      {
        host: "127.0.0.1",
        port: consolePort(process.env.HARVY_CONSOLE_PORT),
        operatorToken: process.env.HARVY_CONSOLE_TOKEN?.trim() || null,
        setupOnly: true,
      },
      undefined,
      undefined,
      null,
      setup,
      codingSetup,
    );

    const started = await server.start();
    server.markReady();
    const channel = {
      environment: process.env.APP_ENV?.trim() || "development",
      interactive: process.stdout.isTTY === true,
      stream: process.stdout,
    };
    if (started.generatedOperatorToken) {
      if (
        !operatorSecretChannelAvailable(channel.environment, channel.interactive) ||
        !presentOperatorSecret(
          [
            `Harvy Console pairing: ${started.origin}/#channels`,
            `Token operator sekali tampil: ${started.generatedOperatorToken}`,
          ].join("\n"),
          channel,
        )
      ) {
        throw blocked("CHANNEL_SETUP_OPERATOR_CHANNEL_UNAVAILABLE");
      }
    } else {
      process.stdout.write(`Harvy Console pairing: ${started.origin}/#channels\n`);
    }
    process.stdout.write("QR, token, dan session tidak ditulis ke output ini. Tekan Ctrl+C setelah pairing selesai.\n");
    await waitForShutdown();
  } finally {
    await server?.close().catch(() => undefined);
    await runtimeLock?.release().catch(() => undefined);
    await removeIsolatedRuntimeRoot(temporaryRoot);
  }
}

function consolePort(value: string | undefined): number {
  const normalized = value?.trim() || "3210";
  if (!/^\d{1,5}$/u.test(normalized)) {
    throw blocked("CHANNEL_SETUP_CONSOLE_PORT_INVALID");
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw blocked("CHANNEL_SETUP_CONSOLE_PORT_INVALID");
  }
  return port;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveShutdown();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}

await main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      /^[A-Z][A-Z0-9_]{2,159}$/u.test((error as { code: string }).code)
    ? (error as { code: string }).code
    : "CHANNEL_SETUP_CONSOLE_FAILED";
  process.stderr.write(`Console pairing gagal secara aman: ${code}\n`);
  process.exitCode = 2;
});
