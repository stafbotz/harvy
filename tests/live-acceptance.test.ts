import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyTelegramPrivateStartSurface,
  createIsolatedRuntimeRoot,
  isolatedRuntimeEnvironment,
  liveAcceptancePaths,
  loadTelegramLiveAcceptanceCredential,
  removeIsolatedRuntimeRoot,
  saveTelegramLiveAcceptanceCredential,
} from "../src/operations/live-acceptance.js";

const CREDENTIAL = {
  version: 1 as const,
  apiId: 123456,
  apiHash: "0123456789abcdef0123456789abcdef",
  session: "session-value-that-must-stay-encrypted",
  botToken: "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE",
};

describe("live acceptance credential boundary", () => {
  it("menyimpan credential Telegram terenkripsi di namespace yang diabaikan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-live-vault-test-"));
    const paths = liveAcceptancePaths(root);
    try {
      await saveTelegramLiveAcceptanceCredential(CREDENTIAL, paths);
      assert.deepEqual(
        await loadTelegramLiveAcceptanceCredential(paths),
        CREDENTIAL,
      );
      const raw = await readFile(paths.secretFile, "utf8");
      assert.equal(raw.includes(CREDENTIAL.apiHash), false);
      assert.equal(raw.includes(CREDENTIAL.session), false);
      assert.equal(raw.includes(CREDENTIAL.botToken), false);
      assert.equal((await readFile(paths.keyFile, "utf8")).trim().length, 43);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menolak record Telegram tidak sah dan ciphertext yang dirusak", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-live-vault-invalid-"));
    const paths = liveAcceptancePaths(root);
    try {
      await assert.rejects(
        () => saveTelegramLiveAcceptanceCredential({
          ...CREDENTIAL,
          apiHash: "not-a-hash",
        }, paths),
        /LIVE_ACCEPTANCE_TELEGRAM_CREDENTIAL_INVALID/u,
      );
      await saveTelegramLiveAcceptanceCredential(CREDENTIAL, paths);
      const raw = await readFile(paths.secretFile, "utf8");
      const state = JSON.parse(raw) as Record<string, string>;
      const ref = Object.keys(state)[0]!;
      const encoded = state[ref]!;
      state[ref] = `${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}`;
      await writeFile(paths.secretFile, `${JSON.stringify(state)}\n`, "utf8");
      await assert.rejects(
        () => loadTelegramLiveAcceptanceCredential(paths),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("isolated live acceptance runtime", () => {
  it("menunggu terminal onboarding Telegram alih-alih menebak dari jeda bubble", () => {
    assert.equal(classifyTelegramPrivateStartSurface("👋", []), null);
    assert.equal(
      classifyTelegramPrivateStartSurface("Haloo Dimas, aku Harvy.", []),
      null,
    );
    assert.equal(
      classifyTelegramPrivateStartSurface(
        "Pesanmu bakal diproses oleh AI.",
        ["Lihat dulu", "Okei, mulai."],
      ),
      "onboarding",
    );
    assert.equal(
      classifyTelegramPrivateStartSurface(
        "Haloo lagi,\n\nAda apa hari ini?",
        [],
      ),
      "returning",
    );
  });

  it("membuang path state production dan menutup capability eksternal", () => {
    const env = isolatedRuntimeEnvironment({
      DATA_FILE: "C:/production/tasks.json",
      MEMORY_FOLDER: "C:/production/memory",
      CONTROL_PLANE_FILE: "C:/production/control.json",
      LOG_FOLDER: "C:/production/logs",
      HARVY_CODING_RUNTIME_ENABLED: "true",
      HARVY_GITHUB_RUNTIME_ENABLED: "true",
      HARVY_CONSOLE_ENABLED: "true",
      HARVY_BYOK_MASTER_KEY_B64: "must-not-reach-test-runtime",
      WHATSAPP_ENABLED: "true",
      WHATSAPP_ACCOUNTS: "production-account",
    }, {
      telegramBotToken: CREDENTIAL.botToken,
    });
    assert.equal(env.DATA_FILE, undefined);
    assert.equal(env.MEMORY_FOLDER, undefined);
    assert.equal(env.CONTROL_PLANE_FILE, undefined);
    assert.equal(env.LOG_FOLDER, undefined);
    assert.equal(env.HARVY_CODING_RUNTIME_ENABLED, "false");
    assert.equal(env.HARVY_GITHUB_RUNTIME_ENABLED, "false");
    assert.equal(env.HARVY_CONSOLE_ENABLED, "false");
    assert.equal(env.HARVY_BYOK_MASTER_KEY_B64, undefined);
    assert.equal(env.WHATSAPP_ENABLED, "false");
    assert.equal(env.WHATSAPP_ACCOUNTS, undefined);
    assert.equal(env.TELEGRAM_BOT_TOKEN, CREDENTIAL.botToken);
  });

  it("mengikat WhatsApp hanya ke auth root dan alias uji yang diberikan", () => {
    const env = isolatedRuntimeEnvironment({}, {
      telegramBotToken: CREDENTIAL.botToken,
      whatsapp: {
        authRoot: "./data/whatsapp-auth/live-acceptance",
        accountAlias: "harvy",
        phoneNumber: "628123456789",
      },
    });
    assert.equal(env.WHATSAPP_ENABLED, "true");
    assert.equal(env.WHATSAPP_PRIVATE_ENABLED, "true");
    assert.deepEqual(JSON.parse(env.WHATSAPP_ACCOUNTS ?? "null"), [{
      id: "harvy",
      phoneNumber: "628123456789",
    }]);
    assert.match(env.WHATSAPP_AUTH_FOLDER ?? "", /live-acceptance$/u);
  });

  it("hanya menghapus root sementara dengan prefix acceptance yang sah", async () => {
    const root = await createIsolatedRuntimeRoot();
    await writeFile(join(root, "probe.txt"), "probe", "utf8");
    await removeIsolatedRuntimeRoot(root);
    await assert.rejects(() => access(root));

    const unrelated = await mkdtemp(join(tmpdir(), "harvy-unrelated-"));
    try {
      await assert.rejects(
        () => removeIsolatedRuntimeRoot(unrelated),
        /LIVE_ACCEPTANCE_ISOLATED_ROOT_INVALID/u,
      );
      await access(unrelated);
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }
  });
});
