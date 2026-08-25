import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConsoleServer } from "../src/console/console-server.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import {
  ChannelSetupService,
  type TelegramPairingAdapter,
  type WhatsAppPairingAdapter,
} from "../src/operations/channel-setup.js";
import {
  liveAcceptancePaths,
  saveTelegramBotCredential,
  saveTelegramTesterCredential,
} from "../src/operations/live-acceptance.js";
import {
  primaryChannelCredentialPaths,
  savePrimaryTelegramBotCredential,
} from "../src/operations/primary-channel-credentials.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";

const OPERATOR_TOKEN = "console-browser-smoke-token-with-safe-length";
const WAIT_TIMEOUT_MS = 30_000;

interface CdpEnvelope {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface CdpRuntimeResult<T> {
  result: { value?: T };
  exceptionDetails?: unknown;
}

interface DebugTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

class CdpClient {
  readonly runtimeFailures: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: Error): void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CONSOLE_BROWSER_CDP_CLOSED"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveConnection, rejectConnection) => {
      const timer = setTimeout(
        () => rejectConnection(new Error("CONSOLE_BROWSER_CDP_CONNECT_TIMEOUT")),
        WAIT_TIMEOUT_MS,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConnection();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectConnection(new Error("CONSOLE_BROWSER_CDP_CONNECT_FAILED"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CONSOLE_BROWSER_CDP_TIMEOUT:${method}`));
      }, WAIT_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolveCommand(value as T),
        reject: rejectCommand,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    const envelope = JSON.parse(event.data) as CdpEnvelope;
    if (envelope.method === "Runtime.exceptionThrown") {
      this.runtimeFailures.push("Runtime.exceptionThrown");
    }
    if (envelope.method === "Inspector.targetCrashed") {
      this.runtimeFailures.push("Inspector.targetCrashed");
    }
    if (envelope.id === undefined) return;
    const entry = this.pending.get(envelope.id);
    if (!entry) return;
    this.pending.delete(envelope.id);
    clearTimeout(entry.timer);
    if (envelope.error) {
      entry.reject(new Error(envelope.error.message || "CONSOLE_BROWSER_CDP_ERROR"));
    } else {
      entry.resolve(envelope.result);
    }
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "harvy-console-browser-"));
  let browser: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let server: ConsoleServer | null = null;
  let whatsapp: EmptyWhatsAppAdapter | null = null;
  try {
    const fixture = await createConsole(root);
    server = fixture.server;
    whatsapp = fixture.whatsapp;
    const started = await server.start();
    server.markReady();
    const launched = await launchBrowser(join(root, "browser-profile"));
    browser = launched.process;
    const targetUrl = await pageDebuggerUrl(launched.endpoint);
    client = await CdpClient.connect(targetUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__harvyBrowserErrors=[];
        addEventListener("error",()=>window.__harvyBrowserErrors.push("error"));
        addEventListener("unhandledrejection",()=>window.__harvyBrowserErrors.push("rejection"));`,
    });
    await setViewport(client, 1440, 1000, 1);
    await client.send("Page.navigate", { url: started.origin });
    await waitForEvaluation(
      client,
      `document.readyState === "complete" && document.getElementById("operator-token") !== null`,
      "CONSOLE_BROWSER_LOGIN_FORM_TIMEOUT",
    );
    await evaluate(client, `(() => {
      const input=document.getElementById("operator-token");
      input.value=${JSON.stringify(OPERATOR_TOKEN)};
      document.getElementById("login-form").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `(() => {
        const app=document.getElementById("app-view");
        const whatsappHarvy=document.getElementById("whatsapp-harvy-status");
        const whatsappTester=document.getElementById("whatsapp-tester-status");
        return app && !app.classList.contains("hidden") &&
          whatsappHarvy?.textContent === "Sesi valid" &&
          whatsappTester?.textContent === "Sesi valid";
      })()`,
      "CONSOLE_BROWSER_CHANNEL_RENDER_TIMEOUT",
    );

    const desktopState = await evaluate<{
      activePanel: boolean;
      globalErrorHidden: boolean;
      primaryTelegram: string;
      primaryWhatsApp: string;
      telegramBot: string;
      telegramTester: string;
      whatsappHarvy: string;
      whatsappTester: string;
      progress: string;
      pageTitle: string;
      readinessTitle: string;
      telegramRoute: string;
      whatsappRoute: string;
      settingsOpen: boolean;
      readyMode: boolean;
      readyCards: number;
      botEditorOpen: boolean;
      telegramTesterFormHidden: boolean;
      telegramTesterManageHidden: boolean;
      whatsappHarvySetupHidden: boolean;
      whatsappTesterSetupHidden: boolean;
      whatsappHarvyManageHidden: boolean;
      whatsappTesterManageHidden: boolean;
      browserErrors: string[];
    }>(client, `(() => ({
      activePanel:!document.getElementById("tab-channels").classList.contains("hidden"),
      globalErrorHidden:document.getElementById("global-error").classList.contains("hidden"),
      primaryTelegram:document.getElementById("primary-telegram-status").textContent,
      primaryWhatsApp:document.getElementById("primary-whatsapp-status").textContent,
      telegramBot:document.getElementById("telegram-bot-status").textContent,
      telegramTester:document.getElementById("telegram-tester-status").textContent,
      whatsappHarvy:document.getElementById("whatsapp-harvy-status").textContent,
      whatsappTester:document.getElementById("whatsapp-tester-status").textContent,
      progress:document.getElementById("setup-progress-badge").textContent,
      pageTitle:document.getElementById("page-title").textContent,
      readinessTitle:document.getElementById("channel-readiness-title").textContent,
      telegramRoute:document.getElementById("telegram-route-status").textContent,
      whatsappRoute:document.getElementById("whatsapp-route-status").textContent,
      settingsOpen:document.getElementById("channel-settings").open,
      readyMode:document.getElementById("tab-channels").classList.contains("ready-mode"),
      readyCards:document.querySelectorAll(".channel-card.ready").length,
      botEditorOpen:document.getElementById("telegram-bot-editor").open,
      telegramTesterFormHidden:document.getElementById("telegram-tester-form").classList.contains("hidden"),
      telegramTesterManageHidden:document.getElementById("telegram-tester-manage").classList.contains("hidden"),
      whatsappHarvySetupHidden:document.getElementById("whatsapp-harvy-setup").classList.contains("hidden"),
      whatsappTesterSetupHidden:document.getElementById("whatsapp-tester-setup").classList.contains("hidden"),
      whatsappHarvyManageHidden:document.getElementById("whatsapp-harvy-manage").classList.contains("hidden"),
      whatsappTesterManageHidden:document.getElementById("whatsapp-tester-manage").classList.contains("hidden"),
      browserErrors:window.__harvyBrowserErrors||[],
    }))()`);
    assert.equal(desktopState.activePanel, true);
    assert.equal(desktopState.globalErrorHidden, true);
    assert.equal(desktopState.primaryTelegram, "Credential tersimpan");
    assert.equal(desktopState.primaryWhatsApp, "1 akun dideklarasikan");
    assert.equal(desktopState.telegramBot, "Tersimpan");
    assert.equal(desktopState.telegramTester, "Credential tersimpan");
    assert.equal(desktopState.whatsappHarvy, "Sesi valid");
    assert.equal(desktopState.whatsappTester, "Sesi valid");
    assert.equal(desktopState.progress, "4 dari 4 siap");
    assert.equal(desktopState.pageTitle, "Kanal Harvy");
    assert.equal(desktopState.readinessTitle, "Harvy siap diuji");
    assert.equal(desktopState.telegramRoute, "Siap");
    assert.equal(desktopState.whatsappRoute, "Sesi valid");
    assert.equal(desktopState.settingsOpen, false);
    assert.equal(desktopState.readyMode, true);
    assert.equal(desktopState.readyCards, 4);
    assert.equal(desktopState.botEditorOpen, false);
    assert.equal(desktopState.telegramTesterFormHidden, true);
    assert.equal(desktopState.telegramTesterManageHidden, false);
    assert.equal(desktopState.whatsappHarvySetupHidden, true);
    assert.equal(desktopState.whatsappTesterSetupHidden, true);
    assert.equal(desktopState.whatsappHarvyManageHidden, false);
    assert.equal(desktopState.whatsappTesterManageHidden, false);
    assert.deepEqual(desktopState.browserErrors, []);
    assert.deepEqual(client.runtimeFailures, []);

    whatsapp.setProbeOutcome("harvy", "rejected");
    await evaluate(client, `document.getElementById("channels-refresh").click()`);
    await waitForEvaluation(
      client,
      `(() => {
        const status=document.getElementById("whatsapp-harvy-status");
        const detail=document.getElementById("whatsapp-harvy-detail");
        const route=document.getElementById("whatsapp-route-status");
        const manage=document.getElementById("whatsapp-harvy-manage");
        return status?.textContent==="Sesi ditolak" &&
          detail?.textContent.includes("WhatsApp menolaknya") &&
          route?.textContent==="Sesi ditolak" && manage?.open===true;
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_REJECTED_STATE_TIMEOUT",
    );
    const rejectedState = await evaluate<{
      readyMode: boolean;
      setupHidden: boolean;
      manageHidden: boolean;
      internalCodeVisible: boolean;
    }>(client, `(() => ({
      readyMode:document.getElementById("tab-channels").classList.contains("ready-mode"),
      setupHidden:document.getElementById("whatsapp-harvy-setup").classList.contains("hidden"),
      manageHidden:document.getElementById("whatsapp-harvy-manage").classList.contains("hidden"),
      internalCodeVisible:document.getElementById("whatsapp-harvy-detail").textContent.includes("CHANNEL_WHATSAPP"),
    }))()`);
    assert.equal(rejectedState.readyMode, false);
    assert.equal(rejectedState.setupHidden, true);
    assert.equal(rejectedState.manageHidden, false);
    assert.equal(rejectedState.internalCodeVisible, false);

    whatsapp.setProbeOutcome("harvy", "accepted");
    await evaluate(client, `document.getElementById("channels-refresh").click()`);
    await waitForEvaluation(
      client,
      `document.getElementById("whatsapp-harvy-status")?.textContent==="Sesi valid" &&
        document.getElementById("whatsapp-route-status")?.textContent==="Sesi valid"`,
      "CONSOLE_BROWSER_WHATSAPP_REVERIFIED_STATE_TIMEOUT",
    );

    const screenshotPath = process.env.HARVY_CONSOLE_SCREENSHOT?.trim();
    if (screenshotPath) {
      const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    await evaluate(client, `document.getElementById("telegram-manage-open").click()`);
    await waitForEvaluation(
      client,
      `document.getElementById("channel-settings").open && document.activeElement?.id === "telegram-settings"`,
      "CONSOLE_BROWSER_CHANNEL_MANAGEMENT_TIMEOUT",
    );
    const managementScreenshotPath = process.env.HARVY_CONSOLE_MANAGEMENT_SCREENSHOT?.trim();
    if (managementScreenshotPath) {
      const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(managementScreenshotPath, Buffer.from(screenshot.data, "base64"));
    }
    await evaluate(client, `document.getElementById("channel-settings").open=false`);

    await setViewport(client, 390, 844, 1);
    const mobileState = await evaluate<{ overflow: boolean; panelVisible: boolean }>(
      client,
      `(() => ({
        overflow:document.documentElement.scrollWidth>window.innerWidth+1,
        panelVisible:!document.getElementById("tab-channels").classList.contains("hidden"),
      }))()`,
    );
    assert.equal(mobileState.overflow, false);
    assert.equal(mobileState.panelVisible, true);
    assert.deepEqual(client.runtimeFailures, []);

    const mobileScreenshotPath = process.env.HARVY_CONSOLE_MOBILE_SCREENSHOT?.trim();
    if (mobileScreenshotPath) {
      const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(mobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    await evaluate(client, `(() => {
      document.getElementById("channel-settings").open=true;
      const manage=document.getElementById("whatsapp-tester-manage");
      manage.open=true;
      document.getElementById("whatsapp-tester-replace-confirm").checked=true;
      document.getElementById("whatsapp-tester-replace").click();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `(() => {
        const status=document.getElementById("whatsapp-tester-status");
        const detail=document.getElementById("whatsapp-tester-detail");
        const manage=document.getElementById("whatsapp-tester-manage");
        const summary=document.getElementById("whatsapp-tester-manage-summary");
        return status?.textContent==="Perlu tindakan" && manage?.open===true &&
          !manage?.classList.contains("hidden") && summary?.textContent==="Pulihkan sesi tester" &&
          !detail?.textContent.includes("CHANNEL_WHATSAPP");
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_RECOVERY_STATE_TIMEOUT",
    );
    await evaluate(client, `(() => {
      document.getElementById("whatsapp-tester-replace-confirm").checked=true;
      document.getElementById("whatsapp-tester-replace").click();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `(() => {
        const status=document.getElementById("whatsapp-tester-status");
        const qr=document.getElementById("whatsapp-tester-qr-stage");
        const manage=document.getElementById("whatsapp-tester-manage");
        const cancel=document.getElementById("whatsapp-tester-cancel");
        return status?.textContent==="Menunggu scan" &&
          !qr?.classList.contains("hidden") && manage?.classList.contains("hidden") &&
          !cancel?.classList.contains("hidden");
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_REPLACE_TIMEOUT",
    );
    assert.deepEqual(client.runtimeFailures, []);

    process.stdout.write(
      `CONSOLE_BROWSER_SMOKE_OK browser=${basename(launched.executable)} viewports=desktop,mobile\n`,
    );
  } finally {
    if (client) {
      await client.send("Browser.close").catch(() => undefined);
      client.close();
    }
    if (browser && browser.exitCode === null) {
      await waitForExit(browser, 4_000);
      if (browser.exitCode === null) {
        browser.kill();
        await waitForExit(browser, 4_000);
      }
    }
    await server?.close().catch(() => undefined);
    await removeTemporaryRoot(root);
  }
}

async function createConsole(root: string): Promise<{
  server: ConsoleServer;
  whatsapp: EmptyWhatsAppAdapter;
}> {
  const paths = liveAcceptancePaths(join(root, "acceptance"));
  const primaryPaths = primaryChannelCredentialPaths(root);
  await savePrimaryTelegramBotCredential({
    version: 1,
    botToken: `987654321:${"p".repeat(32)}`,
  }, primaryPaths);
  await saveTelegramBotCredential({
    version: 1,
    botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE",
  }, paths);
  await saveTelegramTesterCredential({
    version: 1,
    apiId: 123456,
    apiHash: "0123456789abcdef0123456789abcdef",
    session: "browser-smoke-session",
  }, paths);
  const control = new ControlPlaneService(
    new FileControlPlaneRepository(join(root, "control.json")),
    {
      fallbackRollingTokenLimit: 100,
      betaQuotaMultiplier: 4,
      configuredModels: [{
        providerId: "browser-smoke",
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
  const ledger = new UsageLedgerService(
    new FileUsageLedgerRepository(join(root, "usage.json")),
    control,
    { retentionDays: 1 },
  );
  const whatsapp = new EmptyWhatsAppAdapter();
  const channels = new ChannelSetupService({
    paths,
    primaryCredentialPaths: primaryPaths,
    environment: {},
    telegramAdapter: new EmptyTelegramAdapter(),
    whatsappAdapter: whatsapp,
    primaryChannels: {
      telegram: { declared: true },
      whatsapp: {
        configurationValid: true,
        enabled: true,
        privateEnabled: true,
        accountCount: 1,
        declared: true,
      },
    },
  });
  const server = new ConsoleServer(
    control,
    ledger,
    {
      host: "127.0.0.1",
      port: 0,
      operatorToken: OPERATOR_TOKEN,
      setupOnly: true,
    },
    undefined,
    undefined,
    null,
    channels,
  );
  return { server, whatsapp };
}

class EmptyTelegramAdapter implements TelegramPairingAdapter {
  async validateBotToken(): Promise<void> {}
  async pairTester(): Promise<string> {
    throw new Error("CONSOLE_BROWSER_PAIRING_NOT_EXPECTED");
  }
  async revokeTester(): Promise<void> {}
}

class EmptyWhatsAppAdapter implements WhatsAppPairingAdapter {
  private revokeAttempts = 0;
  private readonly probeOutcomes = new Map<
    "harvy" | "tester",
    "accepted" | "rejected"
  >();
  async configured(): Promise<boolean> {
    return true;
  }
  async probe(input: {
    authFolder: string;
  }): Promise<"accepted" | "rejected"> {
    const role = input.authFolder.endsWith("harvy") ? "harvy" : "tester";
    return this.probeOutcomes.get(role) ?? "accepted";
  }
  async pair(input: {
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void> {
    input.onQr("browser-smoke-whatsapp-replacement-qr");
    return new Promise<void>((_, rejectPairing) => {
      const reject = (): void => rejectPairing(Object.assign(
        new Error("aborted"),
        { name: "AbortError" },
      ));
      if (input.signal.aborted) reject();
      else input.signal.addEventListener("abort", reject, { once: true });
    });
  }
  async revoke(): Promise<void> {
    this.revokeAttempts += 1;
    if (this.revokeAttempts === 1) {
      throw Object.assign(new Error("CHANNEL_WHATSAPP_CONNECTION_CLOSED"), {
        code: "CHANNEL_WHATSAPP_CONNECTION_CLOSED",
      });
    }
  }

  setProbeOutcome(
    role: "harvy" | "tester",
    outcome: "accepted" | "rejected",
  ): void {
    this.probeOutcomes.set(role, outcome);
  }
}

async function launchBrowser(profile: string): Promise<{
  process: ChildProcess;
  endpoint: string;
  executable: string;
}> {
  const executable = browserExecutable();
  const processHandle = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const endpoint = await new Promise<string>((resolveEndpoint, rejectEndpoint) => {
    let stderr = "";
    const timer = setTimeout(() => {
      rejectEndpoint(new Error("CONSOLE_BROWSER_DEVTOOLS_TIMEOUT"));
    }, WAIT_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_768);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
      if (!match?.[1]) return;
      clearTimeout(timer);
      processHandle.stderr?.off("data", onData);
      resolveEndpoint(match[1]);
    };
    processHandle.stderr?.on("data", onData);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      rejectEndpoint(new Error("CONSOLE_BROWSER_EXITED_EARLY"));
    });
    processHandle.once("error", () => {
      clearTimeout(timer);
      rejectEndpoint(new Error("CONSOLE_BROWSER_START_FAILED"));
    });
  });
  return { process: processHandle, endpoint, executable };
}

function browserExecutable(): string {
  const candidates = [
    process.env.HARVY_BROWSER_BIN?.trim(),
    process.env["PROGRAMFILES(X86)"]
      ? join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
      : undefined,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const selected = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!selected) throw new Error("CONSOLE_BROWSER_EXECUTABLE_NOT_FOUND");
  return selected;
}

async function pageDebuggerUrl(browserEndpoint: string): Promise<string> {
  const port = new URL(browserEndpoint).port;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as DebugTarget[];
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // DevTools can announce its endpoint just before the target list is ready.
    }
    await delay(50);
  }
  throw new Error("CONSOLE_BROWSER_PAGE_TARGET_NOT_FOUND");
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send<CdpRuntimeResult<T>>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error("CONSOLE_BROWSER_EVALUATION_FAILED");
  return response.result.value as T;
}

async function waitForEvaluation(
  client: CdpClient,
  expression: string,
  timeoutCode: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    if (await evaluate<boolean>(client, expression)) return;
    await delay(50);
  }
  if (timeoutCode === "CONSOLE_BROWSER_CHANNEL_RENDER_TIMEOUT") {
    const diagnostic = await evaluate<{
      appVisible: boolean;
      globalErrorVisible: boolean;
      whatsappStatus: string | null;
      browserErrorCount: number;
    }>(client, `(() => ({
      appVisible:!document.getElementById("app-view")?.classList.contains("hidden"),
      globalErrorVisible:!document.getElementById("global-error")?.classList.contains("hidden"),
      whatsappStatus:document.getElementById("whatsapp-tester-status")?.textContent||null,
      browserErrorCount:(window.__harvyBrowserErrors||[]).length,
    }))()`);
    throw new Error(`${timeoutCode}:${JSON.stringify(diagnostic)}`);
  }
  throw new Error(timeoutCode);
}

async function setViewport(
  client: CdpClient,
  width: number,
  height: number,
  deviceScaleFactor: number,
): Promise<void> {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile: width < 600,
  });
}

async function waitForExit(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
  if (processHandle.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => processHandle.once("exit", () => resolveExit())),
    delay(timeoutMs),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function removeTemporaryRoot(root: string): Promise<void> {
  let consecutiveAbsentChecks = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (existsSync(root)) {
      consecutiveAbsentChecks = 0;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      consecutiveAbsentChecks += 1;
      if (consecutiveAbsentChecks >= 3) return;
    }
    await delay(200);
  }
  if (existsSync(root)) throw new Error("CONSOLE_BROWSER_TEMP_CLEANUP_FAILED");
}

await main().catch((error: unknown) => {
  if (process.env.HARVY_CONSOLE_SMOKE_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  const code = error instanceof Error && /^[A-Z][A-Z0-9_:.-]{2,199}$/u.test(error.message)
    ? error.message
    : "CONSOLE_BROWSER_SMOKE_FAILED";
  process.stderr.write(`Console browser smoke gagal: ${code}\n`);
  process.exitCode = 2;
});
