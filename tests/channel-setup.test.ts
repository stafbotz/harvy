import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DisconnectReason } from "baileys";
import {
  ChannelSetupService,
  LiveWhatsAppPairingAdapter,
  primaryChannelConfigurationFromEnvironment,
  whatsappSetupCloseOutcome,
  type TelegramPairingAdapter,
  type WhatsAppPairingAdapter,
} from "../src/operations/channel-setup.js";
import {
  liveAcceptancePaths,
  loadTelegramBotCredential,
  loadTelegramTesterCredential,
  saveTelegramTesterCredential,
} from "../src/operations/live-acceptance.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
const API_HASH = "0123456789abcdef0123456789abcdef";
const SESSION = "session-value-that-must-stay-encrypted";

describe("ChannelSetupService", () => {
  it("memisahkan token bot, session tester, password 2FA, dan QR dari snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-telegram-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new ControlledTelegramAdapter();
    const whatsapp = new ControlledWhatsAppAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      await service.setTelegramBotToken(BOT_TOKEN);
      service.startTelegramTester({ apiId: 123456, apiHash: API_HASH });
      await waitUntil(async () => (await service.snapshot()).telegram.tester.phase === "awaiting_scan");

      const scanning = await service.snapshot();
      const serialized = JSON.stringify(scanning);
      assert.equal(serialized.includes(BOT_TOKEN), false);
      assert.equal(serialized.includes(API_HASH), false);
      assert.equal(serialized.includes(telegram.qr), false);
      const svg = service.qrSvg("telegram");
      assert.match(svg, /^<svg/u);
      assert.doesNotMatch(svg, new RegExp(telegram.qr, "u"));

      telegram.scanned.resolve();
      await waitUntil(async () => (await service.snapshot()).telegram.tester.phase === "awaiting_password");
      await assert.rejects(
        async () => service.qrSvg("telegram"),
        /QR tidak tersedia/u,
      );
      service.submitTelegramPassword("two-factor-password");
      await waitUntil(async () => (await service.snapshot()).telegram.tester.phase === "paired");

      assert.equal(telegram.receivedPassword, "two-factor-password");
      assert.deepEqual(await loadTelegramBotCredential(paths), {
        version: 1,
        botToken: BOT_TOKEN,
      });
      assert.deepEqual(await loadTelegramTesterCredential(paths), {
        version: 1,
        apiId: 123456,
        apiHash: API_HASH,
        session: SESSION,
      });

      await service.deleteTelegramBotToken();
      assert.equal(await loadTelegramBotCredential(paths), null);
      assert.ok(await loadTelegramTesterCredential(paths));
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mengelola dua role WhatsApp tanpa memantulkan QR atau identitas", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-whatsapp-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new ControlledTelegramAdapter();
    const whatsapp = new ControlledWhatsAppAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startWhatsApp("harvy");
      await waitUntil(async () => (await service.snapshot()).whatsapp.harvy.phase === "awaiting_scan");
      assert.throws(
        () => service.startWhatsApp("tester"),
        /Selesaikan satu operasi WhatsApp/u,
      );
      const snapshot = await service.snapshot();
      assert.equal(JSON.stringify(snapshot).includes(whatsapp.qr), false);
      assert.doesNotMatch(service.qrSvg("whatsapp", "harvy"), new RegExp(whatsapp.qr, "u"));

      whatsapp.finishPairing("harvy");
      await waitUntil(async () => (await service.snapshot()).whatsapp.harvy.configured);
      assert.equal((await service.snapshot()).whatsapp.tester.configured, false);

      service.startWhatsAppRevoke("harvy");
      await waitUntil(async () => !(await service.snapshot()).whatsapp.harvy.configured);
      assert.deepEqual(whatsapp.revokedRoles, ["harvy"]);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mengganti sesi WhatsApp secara logout-first lalu membuka QR baru", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-whatsapp-replace-"));
    const paths = liveAcceptancePaths(root);
    const whatsapp = new ControlledWhatsAppAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startWhatsApp("tester");
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.tester.phase === "awaiting_scan"
      );
      whatsapp.finishPairing("tester");
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.tester.phase === "paired"
      );

      service.startWhatsAppReplace("tester");
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.tester.phase === "awaiting_scan"
      );
      const replacing = await service.snapshot();
      assert.equal(replacing.whatsapp.tester.configured, false);
      assert.equal(replacing.whatsapp.tester.qrAvailable, true);
      assert.equal(JSON.stringify(replacing).includes(whatsapp.qr), false);
      assert.deepEqual(whatsapp.events.slice(-2), [
        "revoke:tester",
        "pair:start:tester",
      ]);

      whatsapp.finishPairing("tester");
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.tester.phase === "paired"
      );
      assert.equal((await service.snapshot()).whatsapp.tester.configured, true);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("membatalkan pairing dan membuang QR aktif", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-cancel-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new ControlledTelegramAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startTelegramTester({ apiId: 123456, apiHash: API_HASH });
      await waitUntil(async () => (await service.snapshot()).telegram.tester.phase === "awaiting_scan");
      await service.cancelTelegramTester();
      const snapshot = await service.snapshot();
      assert.equal(snapshot.telegram.tester.phase, "idle");
      assert.equal(snapshot.telegram.tester.qrAvailable, false);
      assert.equal(telegram.aborted, true);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("memagari QR dan commit session yang datang setelah pembatalan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-late-cancel-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new LateTelegramAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startTelegramTester({ apiId: 123456, apiHash: API_HASH });
      await waitUntil(async () =>
        (await service.snapshot()).telegram.tester.phase === "awaiting_scan"
      );
      const cancellation = service.cancelTelegramTester();
      telegram.finishAfterCancellation.resolve();
      await cancellation;

      const snapshot = await service.snapshot();
      assert.equal(snapshot.telegram.tester.phase, "idle");
      assert.equal(snapshot.telegram.tester.qrAvailable, false);
      assert.equal(await loadTelegramTesterCredential(paths), null);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mempertahankan session Telegram bila logout platform gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-revoke-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new ControlledTelegramAdapter();
    telegram.failRevoke = true;
    await saveTelegramTesterCredential({
      version: 1,
      apiId: 123456,
      apiHash: API_HASH,
      session: SESSION,
    }, paths);
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startTelegramTesterRevoke();
      await waitUntil(async () => (await service.snapshot()).telegram.tester.phase === "error");
      assert.ok(await loadTelegramTesterCredential(paths));
      assert.equal(
        (await service.snapshot()).telegram.tester.errorCode,
        "CHANNEL_TELEGRAM_REVOKE_REJECTED",
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menserialkan commit token bot dan session tester yang selesai bersamaan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-credential-race-"));
    const paths = liveAcceptancePaths(root);
    const telegram = new ControlledTelegramAdapter();
    const service = new ChannelSetupService({
      paths,
      telegramAdapter: telegram,
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      service.startTelegramTester({ apiId: 123456, apiHash: API_HASH });
      await waitUntil(async () =>
        (await service.snapshot()).telegram.tester.phase === "awaiting_scan"
      );
      telegram.scanned.resolve();
      await waitUntil(async () =>
        (await service.snapshot()).telegram.tester.phase === "awaiting_password"
      );

      const tokenWrite = service.setTelegramBotToken(BOT_TOKEN);
      service.submitTelegramPassword("two-factor-password");
      await tokenWrite;
      await waitUntil(async () =>
        (await service.snapshot()).telegram.tester.phase === "paired"
      );

      assert.ok(await loadTelegramBotCredential(paths));
      assert.ok(await loadTelegramTesterCredential(paths));
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menolak writer Console kedua lalu melepas lock saat ditutup", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-lock-"));
    const paths = liveAcceptancePaths(root);
    const first = new ChannelSetupService({
      paths,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: new ControlledWhatsAppAdapter(),
    });
    const second = new ChannelSetupService({
      paths,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: new ControlledWhatsAppAdapter(),
    });
    try {
      await first.initialize();
      await assert.rejects(() => second.initialize(), /Data lokal Harvy sedang dikunci/u);
      await first.close();
      await second.initialize();
      assert.equal((await second.snapshot()).telegram.ready, false);
    } finally {
      await first.close();
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("meringkas konfigurasi kanal utama tanpa memantulkan credential atau identitas", () => {
    const token = "main-token-that-must-not-be-reflected";
    const phoneNumber = "6281234567890";
    const snapshot = primaryChannelConfigurationFromEnvironment({
      TELEGRAM_BOT_TOKEN: token,
      WHATSAPP_ENABLED: "true",
      WHATSAPP_PRIVATE_ENABLED: "true",
      WHATSAPP_ACCOUNTS: JSON.stringify([{ id: "utama", phoneNumber }]),
    });

    assert.deepEqual(snapshot, {
      telegram: { declared: true },
      whatsapp: {
        configurationValid: true,
        enabled: true,
        privateEnabled: true,
        accountCount: 1,
        declared: true,
      },
    });
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(JSON.stringify(snapshot).includes(phoneNumber), false);

    assert.deepEqual(
      primaryChannelConfigurationFromEnvironment({
        WHATSAPP_ENABLED: "true",
        WHATSAPP_ACCOUNTS: "not-json",
      }).whatsapp,
      {
        configurationValid: false,
        enabled: false,
        privateEnabled: false,
        accountCount: 0,
        declared: false,
      },
    );
  });

  it("mengenali credential QR Baileys yang lengkap tanpa bergantung pada flag registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-qr-status-"));
    const authFolder = join(root, "harvy");
    const adapter = new LiveWhatsAppPairingAdapter();
    try {
      await mkdir(authFolder, { recursive: true });
      await writeFile(join(authFolder, "creds.json"), JSON.stringify({
        registered: false,
        me: { id: "628123456789:1@s.whatsapp.net" },
        account: {
          details: Buffer.from([1]),
          accountSignatureKey: Buffer.from([2]),
          accountSignature: Buffer.from([3]),
          deviceSignature: Buffer.from([4]),
        },
        signalIdentities: [{
          identifier: { name: "628123456789", deviceId: 1 },
          identifierKey: Buffer.from([5]),
        }],
      }), { encoding: "utf8", mode: 0o600 });
      assert.equal(await adapter.configured(authFolder), true);

      await writeFile(join(authFolder, "creds.json"), JSON.stringify({
        registered: false,
        me: { id: "628123456789:1@s.whatsapp.net" },
      }), { encoding: "utf8", mode: 0o600 });
      assert.equal(await adapter.configured(authFolder), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("membedakan bukti logged out dari gangguan koneksi biasa", () => {
    assert.equal(
      whatsappSetupCloseOutcome(DisconnectReason.loggedOut),
      "logged_out",
    );
    assert.equal(
      whatsappSetupCloseOutcome(DisconnectReason.restartRequired),
      "restart",
    );
    assert.equal(
      whatsappSetupCloseOutcome(DisconnectReason.connectionLost),
      "closed",
    );
    assert.equal(whatsappSetupCloseOutcome(null), "closed");
  });
});

class ControlledTelegramAdapter implements TelegramPairingAdapter {
  readonly qr = "tg://login?token=secret-qr-payload";
  readonly scanned = deferred<void>();
  receivedPassword: string | null = null;
  aborted = false;
  failRevoke = false;

  async validateBotToken(token: string, _signal: AbortSignal): Promise<void> {
    assert.equal(token, BOT_TOKEN);
  }

  async pairTester(input: {
    apiId: number;
    apiHash: string;
    signal: AbortSignal;
    onQr(value: string, expiresAt: number): void;
    requestPassword(): Promise<string>;
  }): Promise<string> {
    assert.equal(input.apiId, 123456);
    assert.equal(input.apiHash, API_HASH);
    input.onQr(this.qr, Date.now() + 60_000);
    await Promise.race([
      this.scanned.promise,
      abortPromise(input.signal).catch((error) => {
        this.aborted = true;
        throw error;
      }),
    ]);
    this.receivedPassword = await input.requestPassword();
    return SESSION;
  }

  async revokeTester(): Promise<void> {
    if (this.failRevoke) {
      throw Object.assign(new Error("CHANNEL_TELEGRAM_REVOKE_REJECTED"), {
        code: "CHANNEL_TELEGRAM_REVOKE_REJECTED",
      });
    }
  }
}

class LateTelegramAdapter implements TelegramPairingAdapter {
  readonly finishAfterCancellation = deferred<void>();

  async validateBotToken(): Promise<void> {}

  async pairTester(input: {
    apiId: number;
    apiHash: string;
    signal: AbortSignal;
    onQr(value: string, expiresAt: number): void;
    requestPassword(): Promise<string>;
  }): Promise<string> {
    input.onQr("tg://login?token=initial-qr", Date.now() + 60_000);
    await this.finishAfterCancellation.promise;
    input.onQr("tg://login?token=late-qr", Date.now() + 60_000);
    return SESSION;
  }

  async revokeTester(): Promise<void> {}
}

class ControlledWhatsAppAdapter implements WhatsAppPairingAdapter {
  readonly qr = "whatsapp-secret-qr-payload";
  readonly revokedRoles: string[] = [];
  readonly events: string[] = [];
  private readonly configuredFolders = new Set<string>();
  private readonly pairing = new Map<string, ReturnType<typeof deferred<void>>>();

  async configured(authFolder: string): Promise<boolean> {
    return this.configuredFolders.has(authFolder);
  }

  async pair(input: {
    authFolder: string;
    otherAuthFolder: string;
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void> {
    assert.notEqual(input.authFolder, input.otherAuthFolder);
    const role = input.authFolder.endsWith("harvy") ? "harvy" : "tester";
    this.events.push(`pair:start:${role}`);
    const gate = deferred<void>();
    this.pairing.set(input.authFolder, gate);
    input.onQr(this.qr);
    await Promise.race([gate.promise, abortPromise(input.signal)]);
    this.configuredFolders.add(input.authFolder);
    this.events.push(`pair:ready:${role}`);
  }

  async revoke(input: {
    authFolder: string;
    authRoot: string;
    signal: AbortSignal;
  }): Promise<void> {
    assert.equal(input.signal.aborted, false);
    assert.ok(input.authFolder.startsWith(input.authRoot));
    this.configuredFolders.delete(input.authFolder);
    const role = input.authFolder.endsWith("harvy") ? "harvy" : "tester";
    this.revokedRoles.push(role);
    this.events.push(`revoke:${role}`);
  }

  finishPairing(role: "harvy" | "tester"): void {
    const entry = [...this.pairing.entries()].find(([path]) => path.endsWith(role));
    assert.ok(entry);
    entry[1].resolve();
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, rejectAbort) => {
    const reject = (): void => rejectAbort(Object.assign(new Error("aborted"), {
      name: "AbortError",
    }));
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
  });
}

function deferred<T>() {
  let resolveValue!: (value: T | PromiseLike<T>) => void;
  let rejectValue!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise;
    rejectValue = rejectPromise;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  throw new Error("Kondisi test tidak tercapai.");
}
