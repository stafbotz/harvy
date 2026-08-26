import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import {
  loadPrimaryTelegramBotCredential,
  loadPrimaryWhatsAppFleetCredential,
  primaryChannelCredentialPaths,
} from "../src/operations/primary-channel-credentials.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
const PRIMARY_BOT_TOKEN = `987654321:${"p".repeat(32)}`;
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
      ...isolatedPrimaryChannelOptions(root),
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

  it("memigrasikan token Telegram utama dari .env ke store Console tanpa refleksi", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-primary-migrate-"));
    const paths = liveAcceptancePaths(root);
    const primaryPaths = primaryChannelCredentialPaths(root);
    const environment: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: PRIMARY_BOT_TOKEN,
    };
    await writeFile(
      primaryPaths.environmentFile,
      `AI_MODE=testing\nTELEGRAM_BOT_TOKEN=${PRIMARY_BOT_TOKEN}\n`,
      "utf8",
    );
    const telegram = new ControlledTelegramAdapter();
    const service = new ChannelSetupService({
      paths,
      primaryCredentialPaths: primaryPaths,
      environment,
      telegramAdapter: telegram,
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      const before = await service.snapshot();
      assert.deepEqual(before.identityBoundary.primary.telegram, {
        declared: true,
        configured: true,
        source: "environment",
        legacyEnvironment: true,
        migrationAvailable: true,
        runtimeActive: false,
        restartRequired: false,
        phase: "unchecked",
        errorCode: null,
      });
      assert.equal(JSON.stringify(before).includes(PRIMARY_BOT_TOKEN), false);

      await service.migratePrimaryTelegramBotToken();

      assert.equal(environment.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(
        (await readFile(primaryPaths.environmentFile, "utf8")).includes(
          "TELEGRAM_BOT_TOKEN",
        ),
        false,
      );
      assert.equal(
        (await loadPrimaryTelegramBotCredential(primaryPaths))?.botToken,
        PRIMARY_BOT_TOKEN,
      );
      const after = await service.snapshot();
      assert.deepEqual(after.identityBoundary.primary.telegram, {
        declared: true,
        configured: true,
        source: "console",
        legacyEnvironment: false,
        migrationAvailable: false,
        runtimeActive: false,
        restartRequired: false,
        phase: "ready",
        errorCode: null,
      });
      assert.deepEqual(telegram.validatedTokens, [PRIMARY_BOT_TOKEN]);

      await assert.rejects(
        service.setTelegramBotToken(PRIMARY_BOT_TOKEN),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "CHANNEL_TELEGRAM_BOT_MUST_DIFFER_FROM_PRIMARY",
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menandai restart bila credential Console berbeda dari runtime Telegram utama", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-primary-restart-"));
    const service = new ChannelSetupService({
      paths: liveAcceptancePaths(root),
      ...isolatedPrimaryChannelOptions(root),
      primaryRuntimeActive: true,
      primaryTelegramRuntimeToken: BOT_TOKEN,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: new ControlledWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      await service.setPrimaryTelegramBotToken(PRIMARY_BOT_TOKEN);
      const telegram = (await service.snapshot()).identityBoundary.primary.telegram;
      assert.equal(telegram?.source, "console");
      assert.equal(telegram?.phase, "ready");
      assert.equal(telegram?.runtimeActive, true);
      assert.equal(telegram?.restartRequired, true);
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
      ...isolatedPrimaryChannelOptions(root),
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
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.harvy.phase === "paired"
      );
      assert.deepEqual(whatsapp.events.slice(-2), [
        "pair:ready:harvy",
        "probe:harvy",
      ]);
      assert.equal((await service.snapshot()).whatsapp.tester.configured, false);

      service.startWhatsAppRevoke("harvy");
      await waitUntil(async () => !(await service.snapshot()).whatsapp.harvy.configured);
      assert.deepEqual(whatsapp.revokedRoles, ["harvy"]);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tidak menandai pairing WhatsApp siap sebelum sesi tersimpan lolos koneksi ulang", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-whatsapp-pair-probe-"));
    const paths = liveAcceptancePaths(root);
    const whatsapp = new ControlledWhatsAppAdapter();
    const service = new ChannelSetupService({
      paths,
      ...isolatedPrimaryChannelOptions(root),
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
      whatsapp.setProbeOutcome(paths.whatsappTesterAuth, "rejected");
      whatsapp.finishPairing("tester");
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.tester.phase === "error"
      );

      const tester = (await service.snapshot()).whatsapp.tester;
      assert.equal(tester.configured, true);
      assert.equal(tester.phase, "error");
      assert.equal(tester.errorCode, "CHANNEL_WHATSAPP_SESSION_REJECTED");
      assert.equal(tester.session.status, "rejected");
      assert.ok(tester.session.checkedAt);
      assert.equal(
        tester.session.errorCode,
        "CHANNEL_WHATSAPP_SESSION_REJECTED",
      );
      assert.equal((await service.snapshot()).whatsapp.ready, false);
      assert.deepEqual(whatsapp.events.slice(-2), [
        "pair:ready:tester",
        "probe:tester",
      ]);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mengelola armada WhatsApp layanan multi-akun melalui state pending lalu active", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-primary-whatsapp-"));
    const authRoot = join(root, "service-auth");
    const whatsapp = new ManagedWhatsAppAdapter();
    const service = new ChannelSetupService({
      paths: liveAcceptancePaths(root),
      ...isolatedPrimaryChannelOptions(root),
      primaryWhatsAppAuthRoot: authRoot,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      await service.updatePrimaryWhatsAppSettings({
        enabled: false,
        privateEnabled: false,
      });
      const initialPairing = service.startPrimaryWhatsAppAccount("layanan");
      await assert.rejects(
        service.startPrimaryWhatsAppAccount("kelas"),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PRIMARY_WHATSAPP_MUTATION_ACTIVE",
      );
      await initialPairing;
      await waitUntil(async () =>
        (await service.snapshot()).identityBoundary.primary.whatsapp
          .accounts?.[0]?.phase === "awaiting_scan"
      );
      const scanning = await service.snapshot();
      assert.equal(JSON.stringify(scanning).includes(whatsapp.qr), false);
      assert.equal(JSON.stringify(scanning).includes("628123456789"), false);
      assert.doesNotMatch(
        service.primaryWhatsAppQrSvg("LAYANAN"),
        new RegExp(whatsapp.qr, "u"),
      );

      whatsapp.finishPairing("layanan", "628123456789");
      await waitUntil(
        async () =>
          (await service.snapshot()).identityBoundary.primary.whatsapp
            .accounts?.[0]?.lifecycle === "active",
        () => describePrimaryWhatsApp(service),
      );
      const pairedAccount = (await service.snapshot()).identityBoundary.primary
        .whatsapp.accounts?.[0];
      assert.equal(
        pairedAccount?.lifecycle,
        "active",
        JSON.stringify(pairedAccount),
      );
      assert.deepEqual(
        (await loadPrimaryWhatsAppFleetCredential(
          primaryChannelCredentialPaths(root),
        ))?.accounts,
        [{ id: "layanan", phoneNumber: "628123456789", state: "active" }],
      );
      assert.equal(
        (await loadPrimaryWhatsAppFleetCredential(
          primaryChannelCredentialPaths(root),
        ))?.privateEnabled,
        false,
      );

      whatsapp.configuredError = {
        folder: join(authRoot, "layanan"),
        code: "CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID",
      };
      const unreadable = (await service.snapshot()).identityBoundary.primary
        .whatsapp.accounts?.[0];
      assert.equal(unreadable?.phase, "error");
      assert.equal(
        unreadable?.errorCode,
        "CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID",
      );
      assert.equal(unreadable?.session.status, "unreachable");
      whatsapp.configuredError = null;

      await service.startPrimaryWhatsAppAccount("kelas");
      await waitUntil(async () =>
        (await service.snapshot()).identityBoundary.primary.whatsapp
          .accounts?.some((account) =>
            account.id === "kelas" && account.phase === "awaiting_scan"
          ) === true
      );
      await service.cancelPrimaryWhatsApp("KELAS");
      await service.startPrimaryWhatsAppAccount("KELAS");
      await waitUntil(async () =>
        (await service.snapshot()).identityBoundary.primary.whatsapp
          .accounts?.some((account) =>
            account.id === "kelas" && account.phase === "awaiting_scan"
          ) === true
      );
      whatsapp.finishPairing("kelas", "628111111111");
      await waitUntil(
        async () =>
          (await service.snapshot()).identityBoundary.primary.whatsapp
            .accountCount === 2,
        () => describePrimaryWhatsApp(service),
      );
      await service.updatePrimaryWhatsAppSettings({
        enabled: true,
        privateEnabled: false,
      });
      assert.equal(
        (await loadPrimaryWhatsAppFleetCredential(
          primaryChannelCredentialPaths(root),
        ))?.privateEnabled,
        false,
      );

      await service.startPrimaryWhatsAppRemoval("kelas");
      await waitUntil(
        async () =>
          (await service.snapshot()).identityBoundary.primary.whatsapp
            .accounts?.some((account) => account.id === "kelas") === false,
        () => describePrimaryWhatsApp(service),
      );
      const afterRemoval = (await service.snapshot()).identityBoundary.primary
        .whatsapp;
      assert.equal(
        afterRemoval.accounts?.some((account) => account.id === "kelas"),
        false,
        JSON.stringify(afterRemoval.accounts),
      );
      assert.equal(
        (await service.snapshot()).identityBoundary.primary.whatsapp.accountCount,
        1,
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("memigrasikan sesi WhatsApp layanan legacy hanya setelah identitas lokal cocok", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-primary-whatsapp-migrate-"));
    const authRoot = join(root, "service-auth");
    const primaryPaths = primaryChannelCredentialPaths(root);
    const accounts = JSON.stringify([
      { id: "utama", phoneNumber: "628123456789" },
    ]);
    const environment: NodeJS.ProcessEnv = {
      WHATSAPP_ENABLED: "true",
      WHATSAPP_PRIVATE_ENABLED: "true",
      WHATSAPP_ACCOUNTS: accounts,
      WHATSAPP_AUTH_FOLDER: authRoot,
    };
    await writeFile(
      primaryPaths.environmentFile,
      `WHATSAPP_ENABLED=true\nWHATSAPP_PRIVATE_ENABLED=true\nWHATSAPP_ACCOUNTS=${accounts}\n`,
      "utf8",
    );
    await writeWhatsAppCredential(join(authRoot, "utama"), "628123456789");
    const service = new ChannelSetupService({
      paths: liveAcceptancePaths(root),
      primaryCredentialPaths: primaryPaths,
      environment,
      primaryWhatsAppAuthRoot: authRoot,
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: new ManagedWhatsAppAdapter(),
      pairingTimeoutMs: 10_000,
    });
    try {
      await service.initialize();
      assert.equal(
        (await service.snapshot()).identityBoundary.primary.whatsapp.source,
        "environment",
      );
      await service.migratePrimaryWhatsAppFleet();
      const after = (await service.snapshot()).identityBoundary.primary.whatsapp;
      assert.equal(after.source, "console");
      assert.equal(after.accountCount, 1);
      assert.equal(environment.WHATSAPP_ACCOUNTS, undefined);
      assert.equal(
        (await readFile(primaryPaths.environmentFile, "utf8")).includes(
          "WHATSAPP_",
        ),
        false,
      );
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("membedakan credential lokal dari sesi WhatsApp yang benar-benar diterima", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-channel-whatsapp-probe-"));
    const paths = liveAcceptancePaths(root);
    const whatsapp = new ControlledWhatsAppAdapter();
    whatsapp.seedSession(paths.whatsappHarvyAuth, "rejected");
    whatsapp.seedSession(paths.whatsappTesterAuth, "accepted");
    const checkedAt = Date.parse("2026-08-25T12:00:00.000Z");
    const service = new ChannelSetupService({
      paths,
      ...isolatedPrimaryChannelOptions(root),
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
      whatsappVerificationTimeoutMs: 1_000,
      whatsappVerificationTtlMs: 60_000,
      now: () => checkedAt,
    });
    try {
      await service.initialize();
      await waitUntil(async () => {
        const snapshot = await service.snapshot();
        return snapshot.whatsapp.harvy.session.status === "rejected" &&
          snapshot.whatsapp.tester.session.status === "accepted";
      });

      const snapshot = await service.snapshot();
      assert.equal(snapshot.whatsapp.harvy.configured, true);
      assert.equal(snapshot.whatsapp.harvy.phase, "paired");
      assert.deepEqual(snapshot.whatsapp.harvy.session, {
        status: "rejected",
        checkedAt: "2026-08-25T12:00:00.000Z",
        errorCode: "CHANNEL_WHATSAPP_SESSION_REJECTED",
      });
      assert.equal(snapshot.whatsapp.tester.configured, true);
      assert.equal(snapshot.whatsapp.tester.session.status, "accepted");
      assert.equal(snapshot.whatsapp.ready, false);
      assert.equal(JSON.stringify(snapshot).includes("harvy-probe-identity"), false);

      const probesBeforeRefresh = whatsapp.events.filter((event) =>
        event.startsWith("probe:")
      ).length;
      await service.snapshot();
      await service.snapshot();
      assert.equal(
        whatsapp.events.filter((event) => event.startsWith("probe:")).length,
        probesBeforeRefresh,
        "Polling snapshot tidak boleh membuka handshake baru sebelum TTL habis.",
      );
      await service.verifyWhatsAppSessions();
      await waitUntil(async () =>
        whatsapp.events.filter((event) => event.startsWith("probe:")).length ===
          probesBeforeRefresh + 2 &&
        (await service.snapshot()).whatsapp.tester.session.status === "accepted"
      );

      whatsapp.setProbeOutcome(paths.whatsappHarvyAuth, "unreachable");
      await service.verifyWhatsAppSessions();
      await waitUntil(async () =>
        (await service.snapshot()).whatsapp.harvy.session.status === "unreachable"
      );
      const unavailable = await service.snapshot();
      assert.equal(unavailable.whatsapp.harvy.configured, true);
      assert.equal(
        unavailable.whatsapp.harvy.session.errorCode,
        "CHANNEL_WHATSAPP_VERIFICATION_UNAVAILABLE",
      );
      assert.equal(unavailable.whatsapp.ready, false);
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
      ...isolatedPrimaryChannelOptions(root),
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
      ...isolatedPrimaryChannelOptions(root),
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
      ...isolatedPrimaryChannelOptions(root),
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
      ...isolatedPrimaryChannelOptions(root),
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
      ...isolatedPrimaryChannelOptions(root),
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
      ...isolatedPrimaryChannelOptions(root),
      telegramAdapter: new ControlledTelegramAdapter(),
      whatsappAdapter: new ControlledWhatsAppAdapter(),
    });
    const second = new ChannelSetupService({
      paths,
      ...isolatedPrimaryChannelOptions(root),
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
      whatsappSetupCloseOutcome(DisconnectReason.badSession),
      "logged_out",
    );
    assert.equal(
      whatsappSetupCloseOutcome(DisconnectReason.multideviceMismatch),
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

function isolatedPrimaryChannelOptions(root: string) {
  return {
    primaryCredentialPaths: primaryChannelCredentialPaths(root),
    environment: {} as NodeJS.ProcessEnv,
  };
}

class ControlledTelegramAdapter implements TelegramPairingAdapter {
  readonly qr = "tg://login?token=secret-qr-payload";
  readonly scanned = deferred<void>();
  receivedPassword: string | null = null;
  aborted = false;
  failRevoke = false;
  readonly validatedTokens: string[] = [];

  async validateBotToken(token: string, _signal: AbortSignal): Promise<void> {
    this.validatedTokens.push(token);
    assert.match(token, /^\d{5,20}:[A-Za-z0-9_-]{20,160}$/u);
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
  private readonly probeOutcomes = new Map<
    string,
    "accepted" | "rejected" | "unreachable"
  >();
  private readonly pairing = new Map<string, ReturnType<typeof deferred<void>>>();

  async configured(authFolder: string): Promise<boolean> {
    return this.configuredFolders.has(authFolder);
  }

  async probe(input: {
    authFolder: string;
    signal: AbortSignal;
  }): Promise<"accepted" | "rejected"> {
    assert.equal(input.signal.aborted, false);
    this.events.push(
      `probe:${input.authFolder.endsWith("harvy") ? "harvy" : "tester"}`,
    );
    const outcome = this.probeOutcomes.get(input.authFolder) ?? "accepted";
    if (outcome === "unreachable") {
      throw Object.assign(
        new Error("CHANNEL_WHATSAPP_VERIFICATION_UNAVAILABLE"),
        { code: "CHANNEL_WHATSAPP_VERIFICATION_UNAVAILABLE" },
      );
    }
    return outcome;
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

  seedSession(
    authFolder: string,
    outcome: "accepted" | "rejected" | "unreachable",
  ): void {
    this.configuredFolders.add(authFolder);
    this.probeOutcomes.set(authFolder, outcome);
  }

  setProbeOutcome(
    authFolder: string,
    outcome: "accepted" | "rejected" | "unreachable",
  ): void {
    this.probeOutcomes.set(authFolder, outcome);
  }
}

class ManagedWhatsAppAdapter implements WhatsAppPairingAdapter {
  readonly qr = "primary-whatsapp-qr-secret";
  configuredError: { folder: string; code: string } | null = null;
  private readonly mutatingFolders = new Set<string>();
  private readonly pairing = new Map<string, {
    gate: ReturnType<typeof deferred<void>>;
    phoneNumber: string | null;
  }>();

  async configured(authFolder: string): Promise<boolean> {
    if (this.mutatingFolders.has(authFolder)) {
      throw Object.assign(new Error("TEST_CONFIGURED_DURING_MUTATION"), {
        code: "TEST_CONFIGURED_DURING_MUTATION",
      });
    }
    if (this.configuredError?.folder === authFolder) {
      throw Object.assign(new Error(this.configuredError.code), {
        code: this.configuredError.code,
      });
    }
    try {
      const value = JSON.parse(
        await readFile(join(authFolder, "creds.json"), "utf8"),
      ) as { registered?: boolean; me?: { id?: string } };
      return value.registered === true && Boolean(value.me?.id);
    } catch {
      return false;
    }
  }

  async probe(): Promise<"accepted"> {
    return "accepted";
  }

  async pair(input: {
    authFolder: string;
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void> {
    const entry = {
      gate: deferred<void>(),
      phoneNumber: null as string | null,
    };
    this.pairing.set(input.authFolder, entry);
    input.onQr(this.qr);
    await Promise.race([entry.gate.promise, abortPromise(input.signal)]);
    assert.ok(entry.phoneNumber);
    await writeWhatsAppCredential(input.authFolder, entry.phoneNumber);
  }

  async revoke(input: { authFolder: string }): Promise<void> {
    this.mutatingFolders.add(input.authFolder);
    try {
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
      await rm(input.authFolder, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      });
    } finally {
      this.mutatingFolders.delete(input.authFolder);
    }
  }

  finishPairing(alias: string, phoneNumber: string): void {
    const entry = [...this.pairing.entries()].find(([folder]) =>
      basename(folder).toLocaleLowerCase("en-US") ===
        alias.toLocaleLowerCase("en-US")
    )?.[1];
    assert.ok(entry);
    entry.phoneNumber = phoneNumber;
    entry.gate.resolve();
  }
}

async function writeWhatsAppCredential(
  folder: string,
  phoneNumber: string,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "creds.json"),
    JSON.stringify({
      registered: true,
      me: { id: `${phoneNumber}:1@s.whatsapp.net` },
    }),
    "utf8",
  );
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

async function waitUntil(
  predicate: () => Promise<boolean>,
  diagnostic?: () => Promise<string>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if (await predicate()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  } while (Date.now() < deadline);
  const detail = diagnostic ? ` ${await diagnostic()}` : "";
  throw new Error(`Kondisi test tidak tercapai.${detail}`);
}

async function describePrimaryWhatsApp(
  service: ChannelSetupService,
): Promise<string> {
  const whatsapp = (await service.snapshot()).identityBoundary.primary.whatsapp;
  return JSON.stringify({
    accountCount: whatsapp.accountCount,
    accounts: whatsapp.accounts?.map((account) => ({
      id: account.id,
      lifecycle: account.lifecycle,
      phase: account.phase,
      errorCode: account.errorCode,
      sessionStatus: account.session.status,
      sessionErrorCode: account.session.errorCode,
    })),
  });
}
