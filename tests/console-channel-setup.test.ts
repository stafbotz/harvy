import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConsoleServer } from "../src/console/console-server.js";
import { CONSOLE_HTML, CONSOLE_JS } from "../src/console/assets.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import {
  ChannelSetupService,
  type TelegramPairingAdapter,
  type WhatsAppPairingAdapter,
} from "../src/operations/channel-setup.js";
import { liveAcceptancePaths } from "../src/operations/live-acceptance.js";
import { primaryChannelCredentialPaths } from "../src/operations/primary-channel-credentials.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";

const OPERATOR_TOKEN = "token-operator-channel-setup-yang-lebih-dari-32";
const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";
const PRIMARY_BOT_TOKEN = `987654321:${"p".repeat(32)}`;
const API_HASH = "0123456789abcdef0123456789abcdef";
const QR_PAYLOAD = "tg://login?token=must-not-be-reflected";
const WHATSAPP_QR_PAYLOAD = "whatsapp-qr-must-not-be-reflected";

describe("Harvy Console channel setup", () => {
  it("menjaga auth, CSRF, konfirmasi, dan non-reflection credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-console-channels-"));
    const control = new ControlPlaneService(
      new FileControlPlaneRepository(join(directory, "control.json")),
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
    const ledger = new UsageLedgerService(
      new FileUsageLedgerRepository(join(directory, "usage.json")),
      control,
      { retentionDays: 1 },
    );
    const whatsapp = new EmptyWhatsAppAdapter();
    const primaryPaths = primaryChannelCredentialPaths(directory);
    const environment: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: PRIMARY_BOT_TOKEN,
    };
    await writeFile(
      primaryPaths.environmentFile,
      `AI_MODE=testing\nTELEGRAM_BOT_TOKEN=${PRIMARY_BOT_TOKEN}\n`,
      "utf8",
    );
    const channels = new ChannelSetupService({
      paths: liveAcceptancePaths(directory),
      primaryCredentialPaths: primaryPaths,
      environment,
      telegramAdapter: new WaitingTelegramAdapter(),
      whatsappAdapter: whatsapp,
      pairingTimeoutMs: 10_000,
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
    const started = await server.start();
    server.markReady();
    try {
      const page = await (await fetch(started.origin)).text();
      assert.match(page, /id="tab-channels"/u);
      assert.match(page, /id="telegram-bot-token" type="password"/u);

      const unauthenticated = await fetch(`${started.origin}/api/v1/channel-setup`);
      assert.equal(unauthenticated.status, 401);

      const login = await fetch(`${started.origin}/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: started.origin },
        body: JSON.stringify({ token: OPERATOR_TOKEN }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const csrf = (await login.json() as { csrfToken: string }).csrfToken;
      assert.ok(cookie);
      const initialStatus = await authenticatedJson(
        started.origin,
        cookie,
        "/api/v1/channel-setup",
      );
      assert.deepEqual(initialStatus.identityBoundary, {
        mode: "isolated_acceptance",
        primary: {
          telegram: {
            declared: true,
            configured: true,
            source: "environment",
            legacyEnvironment: true,
            migrationAvailable: true,
            runtimeActive: false,
            restartRequired: false,
            phase: "unchecked",
            errorCode: null,
          },
          whatsapp: {
            configurationValid: true,
            enabled: true,
            privateEnabled: true,
            accountCount: 1,
            declared: true,
          },
        },
      });
      assert.equal(JSON.stringify(initialStatus).includes(PRIMARY_BOT_TOKEN), false);

      const rejectedMigration = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/primary/telegram/migrate",
        { method: "POST", body: { confirmation: "wrong" } },
      );
      assert.equal(rejectedMigration.response.status, 400);
      const migrated = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/primary/telegram/migrate",
        {
          method: "POST",
          body: { confirmation: "MIGRATE_PRIMARY_TELEGRAM_TO_CONSOLE" },
        },
      );
      assert.equal(migrated.response.status, 200);
      assert.equal(migrated.raw.includes(PRIMARY_BOT_TOKEN), false);
      const primaryVerification = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/primary/telegram/verify",
        { method: "POST", body: {} },
      );
      assert.equal(primaryVerification.response.status, 200);
      const managedStatus = await authenticatedJson(
        started.origin,
        cookie,
        "/api/v1/channel-setup",
      );
      assert.equal(managedStatus.identityBoundary.primary.telegram.source, "console");
      assert.equal(managedStatus.identityBoundary.primary.telegram.phase, "ready");
      assert.equal(JSON.stringify(managedStatus).includes(PRIMARY_BOT_TOKEN), false);
      const verification = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/whatsapp/verify",
        { method: "POST", body: {} },
      );
      assert.equal(verification.response.status, 202);
      assert.equal(whatsapp.events.includes("probe"), false);
      assert.equal(
        (await fetch(`${started.origin}/api/v1/dashboard`, { headers: { cookie } })).status,
        404,
      );

      const missingCsrf = await fetch(`${started.origin}/api/v1/channel-setup/telegram/bot-token`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: started.origin, cookie },
        body: JSON.stringify({ token: BOT_TOKEN }),
      });
      assert.equal(missingCsrf.status, 403);

      const saved = await mutation(started.origin, cookie, csrf, "/api/v1/channel-setup/telegram/bot-token", {
        method: "POST",
        body: { token: BOT_TOKEN },
      });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.raw.includes(BOT_TOKEN), false);

      const pairing = await mutation(started.origin, cookie, csrf, "/api/v1/channel-setup/telegram/tester/pair", {
        method: "POST",
        body: {
          apiId: 123456,
          apiHash: API_HASH,
          confirmation: "DEDICATED_TEST_ACCOUNT",
        },
      });
      assert.equal(pairing.response.status, 202);
      await waitUntil(async () => {
        const value = await authenticatedJson(started.origin, cookie, "/api/v1/channel-setup");
        return value.telegram.tester.phase === "awaiting_scan";
      });

      const statusResponse = await fetch(`${started.origin}/api/v1/channel-setup`, {
        headers: { cookie },
      });
      const statusRaw = await statusResponse.text();
      assert.equal(statusRaw.includes(BOT_TOKEN), false);
      assert.equal(statusRaw.includes(API_HASH), false);
      assert.equal(statusRaw.includes(QR_PAYLOAD), false);

      const qrResponse = await fetch(`${started.origin}/api/v1/channel-setup/telegram/qr.svg`, {
        headers: { cookie },
      });
      assert.equal(qrResponse.status, 200);
      assert.match(qrResponse.headers.get("content-type") ?? "", /image\/svg\+xml/u);
      assert.equal((await qrResponse.text()).includes(QR_PAYLOAD), false);
      assert.equal(
        (await fetch(`${started.origin}/api/v1/channel-setup/telegram/qr.svg`)).status,
        401,
      );

      const rejectedReplace = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/whatsapp/tester/replace",
        { method: "POST", body: { confirmation: "wrong" } },
      );
      assert.equal(rejectedReplace.response.status, 400);
      const replacement = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/whatsapp/tester/replace",
        {
          method: "POST",
          body: { confirmation: "REPLACE_WHATSAPP_TESTER_SESSION" },
        },
      );
      assert.equal(replacement.response.status, 202);
      await waitUntil(async () => {
        const value = await authenticatedJson(started.origin, cookie, "/api/v1/channel-setup");
        return value.whatsapp.tester.phase === "awaiting_scan";
      });
      const whatsappStatus = JSON.stringify(await authenticatedJson(
        started.origin,
        cookie,
        "/api/v1/channel-setup",
      ));
      assert.equal(whatsappStatus.includes(WHATSAPP_QR_PAYLOAD), false);
      assert.deepEqual(whatsapp.events, ["revoke", "pair"]);

      const cancelReplacement = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/channel-setup/whatsapp/tester/cancel",
        { method: "POST", body: {} },
      );
      assert.equal(cancelReplacement.response.status, 200);

      const rejectedDelete = await mutation(started.origin, cookie, csrf, "/api/v1/channel-setup/telegram/bot-token", {
        method: "DELETE",
        body: { confirmation: "wrong" },
      });
      assert.equal(rejectedDelete.response.status, 400);
      const audits = await control.audits();
      assert.ok(audits.some((record) =>
        record.action === "channel_connection_verify" &&
        record.targetRef === "whatsapp_acceptance" &&
        record.outcome === "succeeded"
      ));
      assert.ok(audits.some((record) =>
        record.action === "channel_credential_revoke" &&
        record.targetRef === "telegram_bot" &&
        record.outcome === "rejected" &&
        record.reasonCode === "confirmation_rejected"
      ));
      assert.ok(audits.some((record) =>
        record.action === "channel_credential_update" &&
        record.targetRef === "primary_telegram_bot" &&
        record.outcome === "succeeded"
      ));
      assert.ok(audits.some((record) =>
        record.action === "channel_connection_verify" &&
        record.targetRef === "primary_telegram_bot" &&
        record.outcome === "succeeded"
      ));
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("menjaga kontrak id DOM yang dipakai renderer kanal", () => {
    const allHtmlIds = [...CONSOLE_HTML.matchAll(/\bid="([^"]+)"/gu)]
      .map((match) => match[1]);
    const htmlIds = new Set(allHtmlIds);
    assert.equal(htmlIds.size, allHtmlIds.length, "ID HTML Console wajib unik.");
    const literalReferences = [
      ...CONSOLE_JS.matchAll(/\bbyId\("([^"]+)"\)/gu),
    ].map((match) => match[1]);
    const missingLiteralIds = [...new Set(literalReferences)]
      .filter((id) => !htmlIds.has(id));
    assert.deepEqual(missingLiteralIds, []);

    const pairingPrefixes = [
      ...CONSOLE_JS.matchAll(/\brenderPairing\("([^"]+)"/gu),
    ].map((match) => match[1]);
    for (const prefix of pairingPrefixes) {
      for (const suffix of [
        "status",
        "detail",
        "qr-stage",
        "qr",
        "cancel",
        "pair",
        "card",
        "manage",
      ]) {
        assert.ok(
          htmlIds.has(`${prefix}-${suffix}`),
          `Elemen #${prefix}-${suffix} wajib tersedia untuk renderPairing().`,
        );
      }
      assert.ok(
        htmlIds.has(`${prefix}-setup`) || htmlIds.has(`${prefix}-form`),
        `Kontrol setup ${prefix} wajib mempunyai container state-aware.`,
      );
    }
    for (const prefix of ["whatsapp-harvy", "whatsapp-tester"]) {
      for (const suffix of ["manage-summary", "replace", "replace-confirm"]) {
        assert.ok(
          htmlIds.has(`${prefix}-${suffix}`),
          `Elemen recovery #${prefix}-${suffix} wajib tersedia.`,
        );
      }
    }
    assert.match(
      CONSOLE_JS,
      /setup\.classList\.toggle\("hidden",stored\|\|active\)/u,
      "Kontrol setup harus hilang setelah credential tersimpan atau pairing aktif.",
    );
    assert.match(
      CONSOLE_JS,
      /item\.session\?\.status==="rejected"/u,
      "Credential lokal yang ditolak platform harus mempunyai state visual tersendiri.",
    );
    assert.match(
      CONSOLE_JS,
      /channels\.whatsapp\.ready===true/u,
      "Readiness WhatsApp harus berasal dari hasil pemeriksaan backend.",
    );
    assert.match(
      CONSOLE_JS,
      /channel-setup\/whatsapp\/verify/u,
      "Segarkan kanal harus meminta handshake WhatsApp baru.",
    );
    assert.match(
      CONSOLE_JS,
      /else if\(!botWasReady\)botEditor\.open=false/u,
      "Editor token harus tertutup ketika credential pertama kali menjadi siap.",
    );
    assert.match(
      CONSOLE_HTML,
      /<details id="channel-settings" class="channel-settings">/u,
      "Pengaturan credential harus menjadi progressive disclosure tertutup.",
    );
    assert.match(
      CONSOLE_JS,
      /if\(!allReady\|\|primaryNeedsAction\)settings\.open=true;else if\(!wasReady\)settings\.open=false/u,
      "Setup harus terbuka saat belum lengkap dan menutup setelah seluruh identitas tersedia.",
    );
    assert.match(
      CONSOLE_JS,
      /root\.classList\.toggle\("ready-mode",allReady\)/u,
      "Keadaan operasional harus berbeda dari keadaan setup.",
    );
  });
});

class WaitingTelegramAdapter implements TelegramPairingAdapter {
  async validateBotToken(token: string, _signal: AbortSignal): Promise<void> {
    assert.ok(token === BOT_TOKEN || token === PRIMARY_BOT_TOKEN);
  }

  async pairTester(input: {
    apiId: number;
    apiHash: string;
    signal: AbortSignal;
    onQr(value: string, expiresAt: number): void;
    requestPassword(): Promise<string>;
  }): Promise<string> {
    input.onQr(QR_PAYLOAD, Date.now() + 60_000);
    return new Promise<string>((_, rejectPairing) => {
      input.signal.addEventListener("abort", () => rejectPairing(Object.assign(
        new Error("aborted"),
        { name: "AbortError" },
      )), { once: true });
    });
  }

  async revokeTester(): Promise<void> {}
}

class EmptyWhatsAppAdapter implements WhatsAppPairingAdapter {
  readonly events: string[] = [];
  async configured(): Promise<boolean> {
    return false;
  }
  async probe(): Promise<"accepted"> {
    this.events.push("probe");
    return "accepted";
  }
  async pair(input: {
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void> {
    this.events.push("pair");
    input.onQr(WHATSAPP_QR_PAYLOAD);
    return new Promise<void>((_, rejectPairing) => {
      input.signal.addEventListener("abort", () => rejectPairing(Object.assign(
        new Error("aborted"),
        { name: "AbortError" },
      )), { once: true });
    });
  }
  async revoke(): Promise<void> {
    this.events.push("revoke");
  }
}

async function mutation(
  origin: string,
  cookie: string,
  csrf: string,
  path: string,
  input: { method: "POST" | "DELETE"; body: Record<string, unknown> },
): Promise<{ response: Response; raw: string }> {
  const response = await fetch(`${origin}${path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify(input.body),
  });
  return { response, raw: await response.text() };
}

async function authenticatedJson(
  origin: string,
  cookie: string,
  path: string,
): Promise<{
  telegram: { tester: { phase: string } };
  whatsapp: { tester: { phase: string } };
  identityBoundary: {
    mode: string;
    primary: {
      telegram: {
        declared: boolean;
        source?: "console" | "environment" | "missing" | "conflict";
        phase?: "missing" | "unchecked" | "validating" | "ready" | "error";
      };
      whatsapp: {
        configurationValid: boolean;
        enabled: boolean;
        privateEnabled: boolean;
        accountCount: number;
        declared: boolean;
      };
    };
  };
}> {
  const response = await fetch(`${origin}${path}`, { headers: { cookie } });
  return response.json() as ReturnType<typeof authenticatedJson>;
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  throw new Error("Kondisi test tidak tercapai.");
}
