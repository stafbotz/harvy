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
  CodingRuntimeSetupService,
  codingRuntimeSetupPaths,
  type CodingRuntimeSetupProbes,
} from "../src/operations/coding-runtime-setup.js";
import {
  liveAcceptancePaths,
  loadRepositoryEnvironment,
  saveTelegramBotCredential,
  saveTelegramTesterCredential,
} from "../src/operations/live-acceptance.js";
import {
  primaryChannelCredentialPaths,
  savePrimaryTelegramBotCredential,
  savePrimaryWhatsAppFleetCredential,
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
  if (process.argv.includes("--external-setup-service")) {
    await auditExternalSetupService(
      process.argv.includes("--migrate-primary-whatsapp"),
    );
    return;
  }
  if (process.argv.includes("--external-setup-qr")) {
    await auditExternalSetupQr();
    return;
  }
  const liveReadonly = process.argv.includes("--live-readonly");
  const traceCleanup = (stage: string): void => {
    if (liveReadonly && process.env.HARVY_CONSOLE_SMOKE_DEBUG === "1") {
      process.stderr.write(`CONSOLE_BROWSER_LIVE_CLEANUP ${stage}\n`);
    }
  };
  const root = await mkdtemp(join(tmpdir(), "harvy-console-browser-"));
  let browser: ChildProcess | null = null;
  let client: CdpClient | null = null;
  let server: ConsoleServer | null = null;
  let whatsapp: EmptyWhatsAppAdapter | null = null;
  try {
    const fixture = liveReadonly
      ? await createLiveConsole(root)
      : await createConsole(root);
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
    await client.send("Network.enable");
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
      liveReadonly
        ? `(() => {
            const app=document.getElementById("app-view");
            const primary=document.getElementById("primary-telegram-status");
            const whatsappHarvy=document.getElementById("whatsapp-harvy-status");
            const whatsappTester=document.getElementById("whatsapp-tester-status");
            return app && !app.classList.contains("hidden") &&
              primary?.textContent !== "Memeriksa" &&
              whatsappHarvy?.textContent !== "Memeriksa sesi" &&
              whatsappTester?.textContent !== "Memeriksa sesi";
          })()`
        : `(() => {
            const app=document.getElementById("app-view");
            const whatsappHarvy=document.getElementById("whatsapp-harvy-status");
            const whatsappTester=document.getElementById("whatsapp-tester-status");
            return app && !app.classList.contains("hidden") &&
              whatsappHarvy?.textContent === "Sesi valid" &&
              whatsappTester?.textContent === "Sesi valid";
          })()`,
      "CONSOLE_BROWSER_CHANNEL_RENDER_TIMEOUT",
    );

    if (liveReadonly) {
      const result = await auditLiveConsole(client);
      process.stdout.write(
        `CONSOLE_BROWSER_LIVE_READONLY_OK browser=${basename(launched.executable)} ` +
          `viewports=desktop,mobile telegram=${result.telegram} whatsapp=${result.whatsapp}\n`,
      );
      return;
    }
    assert.ok(whatsapp);

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
      telegramFlow: string;
      whatsappFlow: string;
      legacyRoleLabelsVisible: boolean;
      settingsHidden: boolean;
      settingsContext: string;
      activeSettingsPanel: string | null;
      activeSettingsPanels: number;
      activeEnvironment: string | null;
      environmentTabs: number;
      environmentTabWidthDelta: number;
      setupSidebarHidden: boolean;
      privacyFooterPresent: boolean;
      skipLinkOffscreen: boolean;
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
      telegramFlow:[...document.querySelectorAll("#telegram-route .route-map small,#telegram-route .route-map b")].map((item)=>item.textContent.trim()).join("|"),
      whatsappFlow:[...document.querySelectorAll("#whatsapp-route .route-map small,#whatsapp-route .route-map b")].map((item)=>item.textContent.trim()).join("|"),
      legacyRoleLabelsVisible:/Nomor (?:A|B)|Harvy uji A|tester B/u.test(document.getElementById("tab-channels").innerText),
      settingsHidden:document.getElementById("channel-settings").classList.contains("hidden"),
      settingsContext:document.getElementById("settings-context-label").textContent,
      activeSettingsPanel:document.querySelector(".settings-panel.active")?.id||null,
      activeSettingsPanels:document.querySelectorAll(".settings-panel.active").length,
      activeEnvironment:document.querySelector(".channel-environment-view.active")?.id||null,
      environmentTabs:document.querySelectorAll("[data-channel-environment]").length,
      environmentTabWidthDelta:(()=>{const tabs=[...document.querySelectorAll("[data-channel-environment]")].map((item)=>item.getBoundingClientRect().width);return Math.abs(tabs[0]-tabs[1])})(),
      setupSidebarHidden:getComputedStyle(document.querySelector(".sidebar")).display==="none",
      privacyFooterPresent:Boolean(document.querySelector(".sidebar-foot")),
      skipLinkOffscreen:document.querySelector(".skip-link").getBoundingClientRect().bottom<=0,
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
    assert.equal(desktopState.primaryWhatsApp, "Siap");
    assert.equal(desktopState.telegramBot, "Tersimpan");
    assert.equal(desktopState.telegramTester, "Credential tersimpan");
    assert.equal(desktopState.whatsappHarvy, "Sesi valid");
    assert.equal(desktopState.whatsappTester, "Sesi valid");
    assert.equal(desktopState.progress, "4 dari 4 siap");
    assert.equal(desktopState.pageTitle, "Kanal");
    assert.equal(desktopState.readinessTitle, "Siap untuk pengujian langsung");
    assert.equal(desktopState.telegramRoute, "Siap");
    assert.equal(desktopState.whatsappRoute, "Sesi valid");
    assert.equal(desktopState.telegramFlow, "PENGUJI|Akun Telegram|HARVY|Bot Telegram");
    assert.equal(desktopState.whatsappFlow, "PENGUJI|Akun WhatsApp|HARVY|Akun WhatsApp");
    assert.equal(desktopState.legacyRoleLabelsVisible, false);
    assert.equal(desktopState.settingsHidden, true);
    assert.match(desktopState.settingsContext, /^(?:Telegram|WhatsApp) · Pengujian$/u);
    assert.ok(
      desktopState.activeSettingsPanel === "telegram-settings" ||
      desktopState.activeSettingsPanel === "whatsapp-settings",
    );
    assert.equal(desktopState.activeSettingsPanels, 1);
    assert.equal(desktopState.activeEnvironment, "channel-environment-service-panel");
    assert.equal(desktopState.environmentTabs, 2);
    assert.ok(desktopState.environmentTabWidthDelta <= 1);
    assert.equal(desktopState.setupSidebarHidden, true);
    assert.equal(desktopState.privacyFooterPresent, false);
    assert.equal(desktopState.skipLinkOffscreen, true);
    assert.equal(desktopState.readyMode, true);
    assert.equal(desktopState.readyCards, 5);
    assert.equal(desktopState.botEditorOpen, false);
    assert.equal(desktopState.telegramTesterFormHidden, true);
    assert.equal(desktopState.telegramTesterManageHidden, false);
    assert.equal(desktopState.whatsappHarvySetupHidden, true);
    assert.equal(desktopState.whatsappTesterSetupHidden, true);
    assert.equal(desktopState.whatsappHarvyManageHidden, false);
    assert.equal(desktopState.whatsappTesterManageHidden, false);
    assert.deepEqual(desktopState.browserErrors, []);
    assert.deepEqual(client.runtimeFailures, []);

    await auditCodingSetup(client);

    await evaluate(client, `document.getElementById("primary-manage-open").click()`);
    await waitForEvaluation(
      client,
      `!document.getElementById("channel-settings").classList.contains("hidden") &&
        document.activeElement?.id === "channel-settings-close" &&
        document.querySelector(".channel-environment-view.active")?.id === "channel-environment-service-panel" &&
        document.querySelector(".settings-panel.active")?.id === "primary-settings"`,
      "CONSOLE_BROWSER_PRIMARY_MANAGEMENT_TIMEOUT",
    );
    const primaryFleetState = await evaluate<{
      accountCount: number;
      alias: string | null;
      phoneVisible: boolean;
      settingsEnabled: boolean;
      privateEnabled: boolean;
      addFormVisible: boolean;
      cardWidthDelta: number;
    }>(client, `(() => {
      const telegram=document.getElementById("primary-telegram-bot-card").getBoundingClientRect();
      const whatsapp=document.getElementById("primary-whatsapp-card").getBoundingClientRect();
      return {
        accountCount:document.querySelectorAll("#primary-whatsapp-account-list .service-account").length,
        alias:document.querySelector("#primary-whatsapp-account-list .service-account-copy strong")?.textContent||null,
        phoneVisible:/628123456789/u.test(document.getElementById("primary-settings").innerText),
        settingsEnabled:document.getElementById("primary-whatsapp-enabled").checked,
        privateEnabled:document.getElementById("primary-whatsapp-private-enabled").checked,
        addFormVisible:!document.getElementById("primary-whatsapp-account-form").classList.contains("hidden"),
        cardWidthDelta:Math.abs(telegram.width-whatsapp.width),
      };
    })()`);
    assert.equal(primaryFleetState.accountCount, 1);
    assert.equal(primaryFleetState.alias, "layanan");
    assert.equal(primaryFleetState.phoneVisible, false);
    assert.equal(primaryFleetState.settingsEnabled, true);
    assert.equal(primaryFleetState.privateEnabled, true);
    assert.equal(primaryFleetState.addFormVisible, true);
    assert.ok(primaryFleetState.cardWidthDelta <= 1);
    await evaluate(client, `(() => {
      const input=document.getElementById("primary-whatsapp-private-enabled");
      input.checked=false;
      document.getElementById("primary-whatsapp-settings-form").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `document.getElementById("notice")?.textContent.includes("Pengaturan WhatsApp layanan tersimpan") &&
        document.getElementById("primary-whatsapp-settings-save")?.disabled===false &&
        document.getElementById("primary-whatsapp-private-enabled")?.checked===false`,
      "CONSOLE_BROWSER_PRIMARY_WHATSAPP_SETTINGS_TIMEOUT",
    );
    await evaluate(client, `(() => {
      const input=document.getElementById("primary-whatsapp-private-enabled");
      input.checked=true;
      document.getElementById("primary-whatsapp-settings-form").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `document.getElementById("primary-whatsapp-settings-save")?.disabled===false &&
        document.getElementById("primary-whatsapp-private-enabled")?.checked===true`,
      "CONSOLE_BROWSER_PRIMARY_WHATSAPP_SETTINGS_RESTORE_TIMEOUT",
    );
    await evaluate(client, `document.getElementById("channel-settings-close").click()`);
    await waitForEvaluation(
      client,
      `document.getElementById("channel-settings").classList.contains("hidden") &&
        document.activeElement?.id === "primary-manage-open"`,
      "CONSOLE_BROWSER_SETTINGS_CLOSE_TIMEOUT",
    );
    await evaluate(client, `(() => {
      const tab=document.getElementById("channel-environment-service");
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `document.activeElement?.id === "channel-environment-testing" &&
        document.querySelector(".channel-environment-view.active")?.id === "channel-environment-testing-panel" &&
        document.getElementById("channel-environment-service-panel").hidden === true`,
      "CONSOLE_BROWSER_ENVIRONMENT_KEYBOARD_TIMEOUT",
    );
    await evaluate(client, `document.getElementById("telegram-manage-open").click()`);
    await waitForEvaluation(
      client,
      `document.activeElement?.id === "channel-settings-close" &&
        !document.getElementById("channel-settings").classList.contains("hidden") &&
        document.querySelector(".settings-panel.active")?.id === "telegram-settings" &&
        document.querySelectorAll(".settings-panel.active").length === 1`,
      "CONSOLE_BROWSER_TELEGRAM_MANAGEMENT_TIMEOUT",
    );
    await evaluate(client, `document.getElementById("channel-settings-close").click()`);
    await evaluate(client, `document.getElementById("whatsapp-manage-open").click()`);
    await waitForEvaluation(
      client,
      `document.activeElement?.id === "channel-settings-close" &&
        !document.getElementById("channel-settings").classList.contains("hidden") &&
        document.querySelector(".settings-panel.active")?.id === "whatsapp-settings"`,
      "CONSOLE_BROWSER_WHATSAPP_MANAGEMENT_TIMEOUT",
    );

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
          route?.textContent==="Sesi ditolak" && manage?.open===true &&
          document.querySelector(".settings-panel.active")?.id==="whatsapp-settings" &&
          document.getElementById("channels-refresh")?.disabled===false;
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_REJECTED_STATE_TIMEOUT",
    );
    const rejectedState = await evaluate<{
      readyMode: boolean;
      setupHidden: boolean;
      manageHidden: boolean;
      internalCodeVisible: boolean;
      activeSettingsPanel: string | null;
      noticeWarning: boolean;
      noticeText: string;
    }>(client, `(() => ({
      readyMode:document.getElementById("tab-channels").classList.contains("ready-mode"),
      setupHidden:document.getElementById("whatsapp-harvy-setup").classList.contains("hidden"),
      manageHidden:document.getElementById("whatsapp-harvy-manage").classList.contains("hidden"),
      internalCodeVisible:document.getElementById("whatsapp-harvy-detail").textContent.includes("CHANNEL_WHATSAPP"),
      activeSettingsPanel:document.querySelector(".settings-panel.active")?.id||null,
      noticeWarning:document.getElementById("notice").classList.contains("warning"),
      noticeText:document.getElementById("notice").textContent,
    }))()`);
    assert.equal(rejectedState.readyMode, false);
    assert.equal(rejectedState.setupHidden, true);
    assert.equal(rejectedState.manageHidden, false);
    assert.equal(rejectedState.internalCodeVisible, false);
    assert.equal(rejectedState.activeSettingsPanel, "whatsapp-settings");
    assert.equal(rejectedState.noticeWarning, true);
    assert.match(rejectedState.noticeText, /perlu perhatian/u);

    whatsapp.setProbeOutcome("harvy", "accepted");
    await evaluate(client, `document.getElementById("channels-refresh").click()`);
    try {
      await waitForEvaluation(
        client,
        `document.getElementById("whatsapp-harvy-status")?.textContent==="Sesi valid" &&
          document.getElementById("whatsapp-route-status")?.textContent==="Sesi valid" &&
          document.getElementById("channels-refresh")?.disabled===false &&
          !document.getElementById("notice")?.classList.contains("warning")`,
        "CONSOLE_BROWSER_WHATSAPP_REVERIFIED_STATE_TIMEOUT",
      );
    } catch (error) {
      const state = await evaluate(client, `(() => ({
        status:document.getElementById("whatsapp-harvy-status")?.textContent,
        route:document.getElementById("whatsapp-route-status")?.textContent,
        buttonDisabled:document.getElementById("channels-refresh")?.disabled,
        notice:document.getElementById("notice")?.textContent,
        warning:document.getElementById("notice")?.classList.contains("warning"),
        globalError:document.getElementById("global-error-text")?.textContent,
        globalErrorHidden:document.getElementById("global-error")?.classList.contains("hidden"),
      }))()`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}:${JSON.stringify(state)}`);
    }

    const screenshotPath = process.env.HARVY_CONSOLE_SCREENSHOT?.trim();
    if (screenshotPath) {
      await nextBrowserPaint(client);
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
      `!document.getElementById("channel-settings").classList.contains("hidden") &&
        document.activeElement?.id === "channel-settings-close" &&
        document.querySelector(".settings-panel.active")?.id === "telegram-settings"`,
      "CONSOLE_BROWSER_CHANNEL_MANAGEMENT_TIMEOUT",
    );
    const managementScreenshotPath = process.env.HARVY_CONSOLE_MANAGEMENT_SCREENSHOT?.trim();
    if (managementScreenshotPath) {
      await nextBrowserPaint(client);
      const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(managementScreenshotPath, Buffer.from(screenshot.data, "base64"));
    }
    await evaluate(client, `document.getElementById("channel-settings-close").click()`);

    await setViewport(client, 390, 844, 1);
    const mobileState = await evaluate<{
      overflow: boolean;
      panelVisible: boolean;
      activeEnvironment: string | null;
      sidebarHidden: boolean;
    }>(
      client,
      `(() => ({
        overflow:document.documentElement.scrollWidth>window.innerWidth+1,
        panelVisible:!document.getElementById("tab-channels").classList.contains("hidden"),
        activeEnvironment:document.querySelector(".channel-environment-view.active")?.id||null,
        sidebarHidden:getComputedStyle(document.querySelector(".sidebar")).display==="none",
      }))()`,
    );
    assert.equal(mobileState.overflow, false);
    assert.equal(mobileState.panelVisible, true);
    assert.equal(mobileState.activeEnvironment, "channel-environment-testing-panel");
    assert.equal(mobileState.sidebarHidden, true);
    assert.deepEqual(client.runtimeFailures, []);

    const mobileScreenshotPath = process.env.HARVY_CONSOLE_MOBILE_SCREENSHOT?.trim();
    if (mobileScreenshotPath) {
      await nextBrowserPaint(client);
      const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });
      await writeFile(mobileScreenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    await evaluate(client, `(() => {
      document.getElementById("whatsapp-manage-open").click();
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
          !manage?.classList.contains("hidden") && summary?.textContent==="Pulihkan sesi penguji" &&
          !detail?.textContent.includes("CHANNEL_WHATSAPP");
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_RECOVERY_STATE_TIMEOUT",
    );
    await client.send("Network.setBlockedURLs", {
      urls: ["*channel-setup/whatsapp/tester/qr.svg*"],
    });
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
    await waitForEvaluation(
      client,
      `(() => {
        const image=document.getElementById("whatsapp-tester-qr");
        const status=document.getElementById("whatsapp-tester-qr-load-status");
        const retry=document.getElementById("whatsapp-tester-qr-retry");
        return image?.classList.contains("qr-failed") &&
          status?.textContent==="QR gagal dimuat. Pairing tetap berjalan." &&
          !retry?.classList.contains("hidden");
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_QR_ERROR_STATE_TIMEOUT",
    );
    await client.send("Network.setBlockedURLs", { urls: [] });
    await evaluate(client, `document.getElementById("whatsapp-tester-qr-retry").click()`);
    await waitForEvaluation(
      client,
      `(() => {
        const surface=document.getElementById("whatsapp-tester-qr");
        const svg=surface?.querySelector("svg");
        const path=svg?.querySelector("path");
        const rect=surface?.getBoundingClientRect();
        return surface?.dataset.loadState==="ready" && svg && path &&
          (path.getAttribute("d")||"").length>1000 && rect?.width>0 && rect?.height>0 &&
          document.getElementById("whatsapp-tester-qr-load-status")?.textContent==="QR siap dipindai." &&
          document.getElementById("whatsapp-tester-qr-retry")?.classList.contains("hidden") &&
          document.getElementById("setup-progress-badge")?.textContent==="3 dari 4 siap";
      })()`,
      "CONSOLE_BROWSER_WHATSAPP_QR_IMAGE_LOAD_TIMEOUT",
    );
    await captureBrowserScreenshot(
      client,
      process.env.HARVY_CONSOLE_QR_SCREENSHOT?.trim(),
    );
    const recoveryMobile = await evaluate<{
      overflow: boolean;
      activePanel: string | null;
      qrWithinViewport: boolean;
    }>(client, `(() => {
      const qr=document.getElementById("whatsapp-tester-qr-stage").getBoundingClientRect();
      return {
        overflow:document.documentElement.scrollWidth>window.innerWidth+1,
        activePanel:document.querySelector(".settings-panel.active")?.id||null,
        qrWithinViewport:qr.left>=0&&qr.right<=window.innerWidth+1,
      };
    })()`);
    assert.equal(recoveryMobile.overflow, false);
    assert.equal(recoveryMobile.activePanel, "whatsapp-settings");
    assert.equal(recoveryMobile.qrWithinViewport, true);
    assert.deepEqual(client.runtimeFailures, []);

    process.stdout.write(
      `CONSOLE_BROWSER_SMOKE_OK browser=${basename(launched.executable)} viewports=desktop,mobile\n`,
    );
  } finally {
    traceCleanup("browser_start");
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
    traceCleanup("browser_done");
    await server?.close().catch(() => undefined);
    traceCleanup("server_done");
    await removeTemporaryRoot(root);
    traceCleanup("temp_done");
  }
}

async function auditExternalSetupService(migrate: boolean): Promise<void> {
  loadRepositoryEnvironment();
  const token = process.env.HARVY_CONSOLE_TOKEN?.trim();
  if (!token) throw new Error("CONSOLE_BROWSER_EXTERNAL_TOKEN_MISSING");
  const port = process.env.HARVY_CONSOLE_PORT?.trim() || "3210";
  const origin = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), "harvy-console-external-service-"));
  let browser: ChildProcess | null = null;
  let client: CdpClient | null = null;
  try {
    const launched = await launchBrowser(join(root, "browser-profile"));
    browser = launched.process;
    const targetUrl = await pageDebuggerUrl(launched.endpoint);
    client = await CdpClient.connect(targetUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await setViewport(client, 1440, 1000, 1);
    await client.send("Page.navigate", { url: origin });
    await waitForEvaluation(
      client,
      `document.readyState==="complete" && document.getElementById("operator-token")!==null`,
      "CONSOLE_BROWSER_EXTERNAL_LOGIN_FORM_TIMEOUT",
    );
    await evaluate(client, `(() => {
      const input=document.getElementById("operator-token");
      input.value=${JSON.stringify(token)};
      document.getElementById("login-form").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `(() => {
        const app=document.getElementById("app-view");
        const status=document.getElementById("primary-whatsapp-status");
        return app&&!app.classList.contains("hidden")&&status?.textContent!=="Memeriksa";
      })()`,
      "CONSOLE_BROWSER_EXTERNAL_SERVICE_RENDER_TIMEOUT",
    );
    await evaluate(client, `document.getElementById("primary-manage-open").click()`);
    await waitForEvaluation(
      client,
      `!document.getElementById("channel-settings").classList.contains("hidden") &&
        document.querySelector(".settings-panel.active")?.id==="primary-settings"`,
      "CONSOLE_BROWSER_EXTERNAL_SERVICE_PANEL_TIMEOUT",
    );
    const result = await evaluate<{
      sourceCopy: string;
      migrationVisible: boolean;
      managedVisible: boolean;
      migrationEnabled: boolean;
      widthDelta: number;
      overflow: boolean;
      browserErrors: string[];
    }>(client, `(() => {
      const telegram=document.getElementById("primary-telegram-bot-card").getBoundingClientRect();
      const whatsapp=document.getElementById("primary-whatsapp-card").getBoundingClientRect();
      const migrate=document.getElementById("primary-whatsapp-migrate-zone");
      const managed=document.getElementById("primary-whatsapp-managed-zone");
      return {
        sourceCopy:document.getElementById("primary-config-source").textContent,
        migrationVisible:!migrate.classList.contains("hidden"),
        managedVisible:!managed.classList.contains("hidden"),
        migrationEnabled:!document.getElementById("primary-whatsapp-migrate").disabled,
        widthDelta:Math.abs(telegram.width-whatsapp.width),
        overflow:document.documentElement.scrollWidth>window.innerWidth+1,
        browserErrors:window.__harvyBrowserErrors||[],
      };
    })()`);
    assert.ok(result.migrationVisible !== result.managedVisible);
    assert.ok(result.widthDelta <= 1);
    assert.equal(result.overflow, false);
    assert.deepEqual(result.browserErrors, []);
    assert.deepEqual(client.runtimeFailures, []);
    await setViewport(client, 390, 844, 1);
    const mobileOverflow = await evaluate<boolean>(
      client,
      `document.documentElement.scrollWidth>window.innerWidth+1`,
    );
    assert.equal(mobileOverflow, false);
    let state = result.migrationVisible
      ? result.migrationEnabled ? "legacy_migratable" : "legacy_attention"
      : "console_managed";
    if (migrate) {
      if (!result.migrationVisible || !result.migrationEnabled) {
        throw new Error("CONSOLE_BROWSER_EXTERNAL_SERVICE_NOT_MIGRATABLE");
      }
      await evaluate(client, `(() => {
        document.getElementById("primary-whatsapp-migrate-confirm").checked=true;
        document.getElementById("primary-whatsapp-migrate").click();
        return true;
      })()`);
      await waitForEvaluation(
        client,
        `(() => {
          const migrate=document.getElementById("primary-whatsapp-migrate-zone");
          const managed=document.getElementById("primary-whatsapp-managed-zone");
          const notice=document.getElementById("notice");
          return migrate.classList.contains("hidden") &&
            !managed.classList.contains("hidden") &&
            notice?.textContent.includes("dipindahkan ke Console");
        })()`,
        "CONSOLE_BROWSER_EXTERNAL_SERVICE_MIGRATION_TIMEOUT",
      );
      const migrated = await evaluate<{
        sourceCopy: string;
        accountCards: number;
        internalIdentityVisible: boolean;
        browserErrors: string[];
      }>(client, `(() => ({
        sourceCopy:document.getElementById("primary-config-source").textContent,
        accountCards:document.querySelectorAll("#primary-whatsapp-account-list .service-account").length,
        internalIdentityVisible:/@s\\.whatsapp\\.net|@lid/u.test(document.getElementById("primary-settings").innerText),
        browserErrors:window.__harvyBrowserErrors||[],
      }))()`);
      assert.match(migrated.sourceCopy, /dikelola Console/u);
      assert.ok(migrated.accountCards > 0);
      assert.equal(migrated.internalIdentityVisible, false);
      assert.deepEqual(migrated.browserErrors, []);
      state = "console_managed";
    }
    if (state === "console_managed") {
      await waitForEvaluation(
        client,
        `document.getElementById("primary-whatsapp-card-status")?.textContent!=="Memeriksa"`,
        "CONSOLE_BROWSER_EXTERNAL_SERVICE_SESSION_TIMEOUT",
      );
    }
    const connection = await evaluate<string>(
      client,
      `document.getElementById("primary-whatsapp-card-status")?.textContent||"Tidak diketahui"`,
    );
    const connectionState = connection === "Siap" || connection === "Sedang digunakan"
      ? "ready"
      : connection === "Perlu tindakan" ? "attention" : "unchecked";
    process.stdout.write(
      `CONSOLE_BROWSER_EXTERNAL_SERVICE_OK state=${state} connection=${connectionState} viewports=desktop,mobile\n`,
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
    await removeTemporaryRoot(root);
  }
}

async function auditExternalSetupQr(): Promise<void> {
  loadRepositoryEnvironment();
  const token = process.env.HARVY_CONSOLE_TOKEN?.trim();
  if (!token) throw new Error("CONSOLE_BROWSER_EXTERNAL_TOKEN_MISSING");
  const port = process.env.HARVY_CONSOLE_PORT?.trim() || "3210";
  const origin = `http://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), "harvy-console-external-qr-"));
  let browser: ChildProcess | null = null;
  let client: CdpClient | null = null;
  try {
    const launched = await launchBrowser(join(root, "browser-profile"));
    browser = launched.process;
    const targetUrl = await pageDebuggerUrl(launched.endpoint);
    client = await CdpClient.connect(targetUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await setViewport(client, 1440, 1000, 1);
    await client.send("Page.navigate", { url: origin });
    await waitForEvaluation(
      client,
      `document.readyState === "complete" && document.getElementById("operator-token") !== null`,
      "CONSOLE_BROWSER_EXTERNAL_LOGIN_FORM_TIMEOUT",
    );
    await evaluate(client, `(() => {
      const input=document.getElementById("operator-token");
      input.value=${JSON.stringify(token)};
      document.getElementById("login-form").requestSubmit();
      return true;
    })()`);
    await waitForEvaluation(
      client,
      `(() => {
        const app=document.getElementById("app-view");
        return app && !app.classList.contains("hidden") &&
          document.getElementById("whatsapp-manage-open")?.disabled===false;
      })()`,
      "CONSOLE_BROWSER_EXTERNAL_CHANNEL_RENDER_TIMEOUT",
    );
    await evaluate(client, `document.getElementById("whatsapp-manage-open").click()`);
    await waitForEvaluation(
      client,
      `(() => {
        const settings=document.getElementById("channel-settings");
        const panel=document.getElementById("whatsapp-settings");
        return settings && !settings.classList.contains("hidden") &&
          panel?.classList.contains("active");
      })()`,
      "CONSOLE_BROWSER_EXTERNAL_WHATSAPP_PANEL_TIMEOUT",
    );
    await waitForEvaluation(
      client,
      `(() => {
        const stage=document.getElementById("whatsapp-harvy-qr-stage");
        const surface=document.getElementById("whatsapp-harvy-qr");
        const status=document.getElementById("whatsapp-harvy-qr-load-status");
        return stage && !stage.classList.contains("hidden") && surface &&
          (status?.textContent==="QR siap dipindai." ||
            status?.textContent==="QR gagal dimuat. Pairing tetap berjalan.");
      })()`,
      "CONSOLE_BROWSER_EXTERNAL_QR_RENDER_TIMEOUT",
    );
    await delay(250);
    const result = await evaluate<{
      stageVisible: boolean;
      svgPresent: boolean;
      renderedWidth: number;
      renderedHeight: number;
      display: string;
      opacity: string;
      loadState: string | null;
      loadStatus: string;
      requestPath: string | null;
      darkModules: number;
      pathFill: string | null;
      backgroundFill: string | null;
      pathBoxWidth: number;
      pathBoxHeight: number;
    }>(client, `(async() => {
      const stage=document.getElementById("whatsapp-harvy-qr-stage");
      const surface=document.getElementById("whatsapp-harvy-qr");
      const svg=surface.querySelector("svg");
      const status=document.getElementById("whatsapp-harvy-qr-load-status");
      const style=getComputedStyle(surface);
      const rect=surface.getBoundingClientRect();
      const path=svg?.querySelector("path"),background=svg?.querySelector("rect"),pathBox=path?.getBBox();
      const darkModules=(path?.getAttribute("d")?.match(/M/g)||[]).length;
      return {
        stageVisible:!stage.classList.contains("hidden"),
        svgPresent:Boolean(svg),
        renderedWidth:Math.round(rect.width),
        renderedHeight:Math.round(rect.height),
        display:style.display,
        opacity:style.opacity,
        loadState:surface.dataset.loadState||null,
        loadStatus:status?.textContent||"",
        requestPath:surface.dataset.path||null,darkModules,
        pathFill:path?getComputedStyle(path).fill:null,
        backgroundFill:background?getComputedStyle(background).fill:null,
        pathBoxWidth:pathBox?.width||0,pathBoxHeight:pathBox?.height||0,
      };
    })()`);
    process.stdout.write(`CONSOLE_BROWSER_EXTERNAL_QR ${JSON.stringify(result)}\n`);
    assert.equal(result.stageVisible, true);
    assert.equal(result.svgPresent, true);
    assert.equal(result.loadState, "ready");
    assert.ok(result.renderedWidth > 0 && result.renderedHeight > 0);
    assert.ok(result.darkModules > 100);
    assert.equal(result.pathFill, "rgb(0, 0, 0)");
    assert.equal(result.backgroundFill, "rgb(255, 255, 255)");
    assert.ok(result.pathBoxWidth > 0 && result.pathBoxHeight > 0);
    assert.deepEqual(client.runtimeFailures, []);
    process.stdout.write("CONSOLE_BROWSER_EXTERNAL_QR_OK\n");
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
    await removeTemporaryRoot(root);
  }
}

async function auditCodingSetup(client: CdpClient): Promise<void> {
  const sandboxSecret = "s".repeat(43);
  const localGitSecret = "l".repeat(43);
  const brokerSecret = "g".repeat(43);
  const clientSecret = "github-client-secret-browser-smoke";
  const privateKey = browserPrivateKeyPem();
  const receipt = JSON.stringify(browserConformanceReceipt());

  await evaluate(
    client,
    `document.querySelector('[data-setup-tab="compute"]').click()`,
  );
  await waitForEvaluation(
    client,
    `(() => {
      const panel=document.getElementById("tab-compute");
      return panel && !panel.classList.contains("hidden") &&
        document.getElementById("page-title")?.textContent==="Komputer kerja" &&
        document.getElementById("compute-status")?.textContent==="Belum diatur" &&
        document.getElementById("compute-editor")?.open===true;
    })()`,
    "CONSOLE_BROWSER_COMPUTE_INITIAL_STATE_TIMEOUT",
  );
  await evaluate(client, `(() => {
    document.getElementById("compute-sandbox-origin-input").value="http://127.0.0.1:8443";
    document.getElementById("compute-sandbox-key-id").value="sandbox-browser-v1";
    document.getElementById("compute-sandbox-secret").value=${JSON.stringify(sandboxSecret)};
    document.getElementById("compute-git-origin-input").value="http://127.0.0.1:8444";
    document.getElementById("compute-git-key-id").value="local-git-browser-v1";
    document.getElementById("compute-git-secret").value=${JSON.stringify(localGitSecret)};
    document.getElementById("compute-receipt").value=${JSON.stringify(receipt)};
    document.getElementById("compute-privacy-domain").value="workspace.private";
    document.getElementById("compute-insecure-loopback").checked=true;
    document.getElementById("compute-form").requestSubmit();
    return true;
  })()`);
  await waitForEvaluation(
    client,
    `document.getElementById("compute-status")?.textContent==="Menunggu verifikasi" &&
      document.getElementById("compute-verify")?.disabled===false &&
      document.getElementById("compute-sandbox-secret")?.value==="" &&
      document.getElementById("compute-git-secret")?.value==="" &&
      document.getElementById("compute-receipt")?.value===""`,
    "CONSOLE_BROWSER_COMPUTE_SAVED_STATE_TIMEOUT",
  );
  await evaluate(client, `document.getElementById("compute-verify").click()`);
  await waitForEvaluation(
    client,
    `document.getElementById("compute-status")?.textContent==="Aktif" &&
      document.getElementById("compute-disable")?.classList.contains("hidden")===false &&
      document.getElementById("compute-verify")?.disabled===false`,
    "CONSOLE_BROWSER_COMPUTE_VERIFY_TIMEOUT",
  );
  const compute = await evaluate<{
    activeStep: string | null;
    browserErrors: string[];
    overflow: boolean;
    origins: string[];
    secretInputsEmpty: boolean;
    stepWidthDelta: number;
  }>(client, `(() => {
    const steps=[...document.querySelectorAll("[data-setup-tab]")]
      .map((item)=>item.getBoundingClientRect().width);
    return {
      activeStep:document.querySelector("[data-setup-tab].active")?.dataset.setupTab||null,
      browserErrors:window.__harvyBrowserErrors||[],
      overflow:document.documentElement.scrollWidth>window.innerWidth+1,
      origins:[
        document.getElementById("compute-sandbox-origin").textContent,
        document.getElementById("compute-git-origin").textContent,
      ],
      secretInputsEmpty:[...document.querySelectorAll("#compute-form input[type=password]")]
        .every((input)=>input.value===""),
      stepWidthDelta:Math.max(...steps)-Math.min(...steps),
    };
  })()`);
  assert.equal(compute.activeStep, "compute");
  assert.equal(compute.overflow, false);
  assert.deepEqual(compute.origins, [
    "http://127.0.0.1:8443",
    "http://127.0.0.1:8444",
  ]);
  assert.equal(compute.secretInputsEmpty, true);
  assert.ok(compute.stepWidthDelta <= 1);
  assert.deepEqual(compute.browserErrors, []);

  await evaluate(
    client,
    `document.querySelector('[data-setup-tab="github"]').click()`,
  );
  await waitForEvaluation(
    client,
    `(() => {
      const panel=document.getElementById("tab-github");
      return panel && !panel.classList.contains("hidden") &&
        document.getElementById("page-title")?.textContent==="GitHub" &&
        document.getElementById("github-status")?.textContent==="Belum diatur" &&
        document.getElementById("github-editor")?.open===true;
    })()`,
    "CONSOLE_BROWSER_GITHUB_INITIAL_STATE_TIMEOUT",
  );
  await evaluate(client, `(() => {
    document.getElementById("github-app-id").value="123456";
    document.getElementById("github-app-slug").value="harvy-browser-smoke";
    document.getElementById("github-client-id").value="Iv1.harvy-browser";
    document.getElementById("github-client-secret").value=${JSON.stringify(clientSecret)};
    document.getElementById("github-private-key").value=${JSON.stringify(privateKey)};
    document.getElementById("github-callback-url").value="https://github.harvy.example/v1/github-app/callback";
    document.getElementById("github-broker-origin-input").value="http://127.0.0.1:8445";
    document.getElementById("github-broker-key-id").value="github-browser-v1";
    document.getElementById("github-broker-secret").value=${JSON.stringify(brokerSecret)};
    document.getElementById("github-form").requestSubmit();
    return true;
  })()`);
  await waitForEvaluation(
    client,
    `document.getElementById("github-status")?.textContent==="Menunggu Broker" &&
      document.getElementById("github-credential-status")?.textContent==="Tersimpan" &&
      document.getElementById("github-verify")?.disabled===false &&
      document.getElementById("github-client-secret")?.value==="" &&
      document.getElementById("github-private-key")?.value==="" &&
      document.getElementById("github-broker-secret")?.value===""`,
    "CONSOLE_BROWSER_GITHUB_SAVED_STATE_TIMEOUT",
  );
  await evaluate(client, `document.getElementById("github-verify").click()`);
  await waitForEvaluation(
    client,
    `document.getElementById("github-status")?.textContent==="Aktif" &&
      document.getElementById("github-broker-status")?.textContent==="Terhubung" &&
      document.getElementById("github-disable")?.classList.contains("hidden")===false &&
      document.getElementById("github-verify")?.disabled===false`,
    "CONSOLE_BROWSER_GITHUB_VERIFY_TIMEOUT",
  );
  const github = await evaluate<{
    activeStep: string | null;
    appName: string;
    browserErrors: string[];
    callback: string;
    overflow: boolean;
    secretInputsEmpty: boolean;
  }>(client, `(() => ({
    activeStep:document.querySelector("[data-setup-tab].active")?.dataset.setupTab||null,
    appName:document.getElementById("github-app-name").textContent,
    browserErrors:window.__harvyBrowserErrors||[],
    callback:document.getElementById("github-callback-origin").textContent,
    overflow:document.documentElement.scrollWidth>window.innerWidth+1,
    secretInputsEmpty:[...document.querySelectorAll("#github-form input[type=password],#github-private-key")]
      .every((input)=>input.value===""),
  }))()`);
  assert.equal(github.activeStep, "github");
  assert.equal(github.appName, "GitHub App · harvy-browser-smoke");
  assert.equal(github.callback, "Callback: https://github.harvy.example");
  assert.equal(github.overflow, false);
  assert.equal(github.secretInputsEmpty, true);
  assert.deepEqual(github.browserErrors, []);

  await setViewport(client, 390, 844, 1);
  await nextBrowserPaint(client);
  const mobile = await evaluate<{
    overflow: boolean;
    setupSteps: number;
    visiblePanels: number;
  }>(client, `(() => ({
    overflow:document.documentElement.scrollWidth>window.innerWidth+1,
    setupSteps:document.querySelectorAll("[data-setup-tab]").length,
    visiblePanels:[...document.querySelectorAll(".tabpanel")]
      .filter((item)=>!item.classList.contains("hidden")).length,
  }))()`);
  assert.equal(mobile.overflow, false);
  assert.equal(mobile.setupSteps, 3);
  assert.equal(mobile.visiblePanels, 1);
  await setViewport(client, 1440, 1000, 1);

  await evaluate(
    client,
    `document.querySelector('[data-setup-tab="channels"]').click()`,
  );
  await waitForEvaluation(
    client,
    `!document.getElementById("tab-channels")?.classList.contains("hidden") &&
      document.getElementById("page-title")?.textContent==="Kanal"`,
    "CONSOLE_BROWSER_CHANNEL_RETURN_TIMEOUT",
  );
  assert.deepEqual(client.runtimeFailures, []);
}

function browserCodingSetupProbes(): CodingRuntimeSetupProbes {
  return {
    async compute() {
      return {
        sandbox: {
          available: true,
          runtime: "isolated-linux",
          identity: {
            serviceIdentityDigest: "1".repeat(64),
            runtimeImageDigest: "2".repeat(64),
            policyDigest: "3".repeat(64),
          },
          checkedAt: "2026-08-26T09:00:00.000Z",
          reason: null,
        },
        localGit: {
          available: true,
          protocol: "harvy-local-git/1",
          checkedAt: "2026-08-26T09:00:00.000Z",
          reason: null,
        },
      };
    },
    async github() {
      return {
        available: true,
        protocol: "harvy-github-broker/1",
        checkedAt: "2026-08-26T09:00:00.000Z",
        reason: null,
      };
    },
  };
}

function browserConformanceReceipt() {
  return {
    version: 1,
    serviceIdentityDigest: "1".repeat(64),
    runtimeImageDigest: "2".repeat(64),
    policyDigest: "3".repeat(64),
    suiteDigest: "4".repeat(64),
    verifiedAt: "2026-08-26T08:55:00.000Z",
    expiresAt: "2026-09-02T08:55:00.000Z",
  };
}

function browserPrivateKeyPem(): string {
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    "ZmFrZS1wcml2YXRlLWtleS1mb3VuZGFyeQ==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
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
  await savePrimaryWhatsAppFleetCredential({
    version: 1,
    enabled: true,
    privateEnabled: true,
    accounts: [{
      id: "layanan",
      phoneNumber: "628123456789",
      state: "active",
    }],
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
  const codingSetup = new CodingRuntimeSetupService({
    paths: codingRuntimeSetupPaths(join(root, "coding-setup")),
    probes: browserCodingSetupProbes(),
    now: () => new Date("2026-08-26T09:00:00.000Z"),
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
    codingSetup,
  );
  return { server, whatsapp };
}

async function createLiveConsole(root: string): Promise<{
  server: ConsoleServer;
  whatsapp: null;
}> {
  loadRepositoryEnvironment();
  const control = new ControlPlaneService(
    new FileControlPlaneRepository(join(root, "live-control.json")),
    {
      fallbackRollingTokenLimit: 100,
      betaQuotaMultiplier: 4,
      configuredModels: [{
        providerId: "browser-live-audit",
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
    new FileUsageLedgerRepository(join(root, "live-usage.json")),
    control,
    { retentionDays: 1 },
  );
  const channels = new ChannelSetupService();
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
  return { server, whatsapp: null };
}

async function auditLiveConsole(client: CdpClient): Promise<{
  telegram: string;
  whatsapp: string;
}> {
  const initial = await evaluate<{
    globalErrorHidden: boolean;
    overflow: boolean;
    activePanels: number;
    activeEnvironments: number;
    environmentTabs: number;
    setupSidebarHidden: boolean;
    secretInputsEmpty: boolean;
    browserErrors: string[];
  }>(client, `(() => ({
    globalErrorHidden:document.getElementById("global-error").classList.contains("hidden"),
    overflow:document.documentElement.scrollWidth>window.innerWidth+1,
    activePanels:document.querySelectorAll(".settings-panel.active").length,
    activeEnvironments:document.querySelectorAll(".channel-environment-view.active").length,
    environmentTabs:document.querySelectorAll("[data-channel-environment]").length,
    setupSidebarHidden:getComputedStyle(document.querySelector(".sidebar")).display==="none",
    secretInputsEmpty:[...document.querySelectorAll('input[type="password"]')].every((input)=>input.value===""),
    browserErrors:window.__harvyBrowserErrors||[],
  }))()`);
  assert.equal(initial.globalErrorHidden, true);
  assert.equal(initial.overflow, false);
  assert.equal(initial.activePanels, 1);
  assert.equal(initial.activeEnvironments, 1);
  assert.equal(initial.environmentTabs, 2);
  assert.equal(initial.setupSidebarHidden, true);
  assert.equal(initial.secretInputsEmpty, true);
  assert.deepEqual(initial.browserErrors, []);

  await nextBrowserPaint(client);
  await captureBrowserScreenshot(client, process.env.HARVY_CONSOLE_SCREENSHOT?.trim());

  for (const channel of ["primary", "telegram", "whatsapp"] as const) {
    const trigger = channel === "primary" ? "primary-manage-open" : `${channel}-manage-open`;
    const environment = channel === "primary" ? "service" : "testing";
    await evaluate(client, `document.getElementById(${JSON.stringify(trigger)}).click()`);
    await waitForEvaluation(
      client,
      `!document.getElementById("channel-settings").classList.contains("hidden") &&
        document.activeElement?.id === "channel-settings-close" &&
        document.querySelector(".channel-environment-view.active")?.id === ${JSON.stringify(`channel-environment-${environment}-panel`)} &&
        document.querySelector(".settings-panel.active")?.id === ${JSON.stringify(`${channel}-settings`)} &&
        document.querySelectorAll(".settings-panel.active").length === 1`,
      `CONSOLE_BROWSER_LIVE_${channel.toUpperCase()}_MANAGEMENT_TIMEOUT`,
    );
    if (channel !== "whatsapp") {
      await evaluate(client, `document.getElementById("channel-settings-close").click()`);
    }
  }

  await evaluate(client, `document.getElementById("channel-settings").scrollIntoView({
    behavior:"auto",block:"start"
  });true`);
  await nextBrowserPaint(client);
  await captureBrowserScreenshot(
    client,
    process.env.HARVY_CONSOLE_MANAGEMENT_SCREENSHOT?.trim(),
    false,
  );

  await evaluate(client, `document.getElementById("channels-refresh").click()`);
  await waitForEvaluation(
    client,
    `(() => {
      const button=document.getElementById("channels-refresh");
      const primary=document.getElementById("primary-telegram-status");
      const harvy=document.getElementById("whatsapp-harvy-status");
      const tester=document.getElementById("whatsapp-tester-status");
      return button?.disabled===false && primary?.textContent!=="Memverifikasi" &&
        harvy?.textContent!=="Memeriksa sesi" && tester?.textContent!=="Memeriksa sesi";
    })()`,
    "CONSOLE_BROWSER_LIVE_CONNECTION_CHECK_TIMEOUT",
  );
  const checked = await evaluate<{
    telegram: string;
    whatsapp: string;
    globalErrorHidden: boolean;
    globalErrorText: string;
    browserErrors: string[];
  }>(client, `(() => ({
    telegram:document.getElementById("telegram-route-status").textContent,
    whatsapp:document.getElementById("whatsapp-route-status").textContent,
    globalErrorHidden:document.getElementById("global-error").classList.contains("hidden"),
    globalErrorText:document.getElementById("global-error-text").textContent,
    browserErrors:window.__harvyBrowserErrors||[],
  }))()`);
  assert.equal(
    checked.globalErrorHidden,
    true,
    `Console connection refresh exposed a global error: ${checked.globalErrorText}`,
  );
  assert.deepEqual(checked.browserErrors, []);
  assert.deepEqual(client.runtimeFailures, []);

  await evaluate(client, `document.getElementById("channel-settings-close").click()`);
  await setViewport(client, 390, 844, 1);
  await evaluate(client, `window.scrollTo(0,0);true`);
  await nextBrowserPaint(client);
  const mobile = await evaluate<{
    overflow: boolean;
    environments: number;
    activeEnvironments: number;
    setupSidebarHidden: boolean;
  }>(
    client,
    `(() => ({
      overflow:document.documentElement.scrollWidth>window.innerWidth+1,
      environments:document.querySelectorAll("#tab-channels .environment-card").length,
      activeEnvironments:document.querySelectorAll(".channel-environment-view.active").length,
      setupSidebarHidden:getComputedStyle(document.querySelector(".sidebar")).display==="none",
    }))()`,
  );
  assert.equal(mobile.overflow, false);
  assert.equal(mobile.environments, 2);
  assert.equal(mobile.activeEnvironments, 1);
  assert.equal(mobile.setupSidebarHidden, true);
  await captureBrowserScreenshot(client, process.env.HARVY_CONSOLE_MOBILE_SCREENSHOT?.trim());
  return {
    telegram:checked.telegram.replace(/\s+/gu, "_"),
    whatsapp:checked.whatsapp.replace(/\s+/gu, "_"),
  };
}

async function nextBrowserPaint(client: CdpClient): Promise<void> {
  await evaluate(client, `new Promise((resolve)=>requestAnimationFrame(
    ()=>requestAnimationFrame(()=>resolve(true))
  ))`);
}

async function captureBrowserScreenshot(
  client: CdpClient,
  path: string | undefined,
  fullPage = true,
): Promise<void> {
  if (!path) return;
  const screenshot = await client.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
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
    input.onQr([
      "browser-smoke-whatsapp-replacement-qr",
      "A".repeat(180),
      "B".repeat(180),
      "C".repeat(180),
    ].join(","));
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
if (process.argv.includes("--live-readonly")) {
  // Transport live dapat meninggalkan timer library setelah socket dan lock
  // ditutup. Audit adalah proses sekali jalan, jadi keluar eksplisit hanya
  // setelah seluruh cleanup di finally selesai.
  process.exit(process.exitCode ?? 0);
}
