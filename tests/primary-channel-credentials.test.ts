import assert from "node:assert/strict";
import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  deletePrimaryTelegramBotCredential,
  loadPrimaryTelegramBotCredential,
  loadPrimaryTelegramBotCredentialSync,
  migratePrimaryTelegramBotCredentialFromEnvironment,
  primaryChannelCredentialPaths,
  primaryTelegramEnvironmentStatus,
  resolvePrimaryTelegramBotToken,
  savePrimaryTelegramBotCredential,
} from "../src/operations/primary-channel-credentials.js";

const TOKEN_A = `123456789:${"a".repeat(32)}`;
const TOKEN_B = `987654321:${"b".repeat(32)}`;

describe("credential kanal utama", () => {
  it("menyimpan token Telegram terenkripsi dan membacanya saat bootstrap sinkron", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-primary-channel-"));
    const paths = primaryChannelCredentialPaths(root);

    await savePrimaryTelegramBotCredential({ version: 1, botToken: TOKEN_A }, paths);

    assert.deepEqual(await loadPrimaryTelegramBotCredential(paths), {
      version: 1,
      botToken: TOKEN_A,
    });
    assert.deepEqual(loadPrimaryTelegramBotCredentialSync(paths), {
      version: 1,
      botToken: TOKEN_A,
    });
    assert.doesNotMatch(await readFile(paths.secretFile, "utf8"), new RegExp(TOKEN_A, "u"));
    assert.equal(resolvePrimaryTelegramBotToken({}, paths), TOKEN_A);

    await deletePrimaryTelegramBotCredential(paths);
    assert.equal(await loadPrimaryTelegramBotCredential(paths), null);
    assert.equal(loadPrimaryTelegramBotCredentialSync(paths), null);
  });

  it("memigrasikan satu token .env secara durable tanpa memantulkannya", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-primary-migrate-"));
    const paths = primaryChannelCredentialPaths(root);
    await writeFile(
      paths.environmentFile,
      `AI_MODE=testing\r\nTELEGRAM_BOT_TOKEN=${TOKEN_A}\r\nDEFAULT_TIMEZONE=Asia/Jakarta\r\n`,
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: TOKEN_A };

    assert.deepEqual(
      await primaryTelegramEnvironmentStatus(environment, paths),
      { declared: true, migratable: true, entryCount: 1 },
    );
    await migratePrimaryTelegramBotCredentialFromEnvironment({
      environment,
      paths,
    });

    const rewritten = await readFile(paths.environmentFile, "utf8");
    assert.equal(rewritten, "AI_MODE=testing\r\nDEFAULT_TIMEZONE=Asia/Jakarta\r\n");
    assert.equal(environment.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(
      (await loadPrimaryTelegramBotCredential(paths))?.botToken,
      TOKEN_A,
    );
  });

  it("menolak konflik sumber tetapi memberi override sempit untuk runtime acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-primary-source-"));
    const paths = primaryChannelCredentialPaths(root);
    await savePrimaryTelegramBotCredential({ version: 1, botToken: TOKEN_A }, paths);

    assert.throws(
      () => resolvePrimaryTelegramBotToken({ TELEGRAM_BOT_TOKEN: TOKEN_B }, paths),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CONFIG_TELEGRAM_CREDENTIAL_SOURCE_CONFLICT",
    );
    assert.equal(
      resolvePrimaryTelegramBotToken({
        TELEGRAM_BOT_TOKEN: TOKEN_B,
        HARVY_TELEGRAM_TOKEN_EPHEMERAL: "live-acceptance-v1",
      }, paths),
      TOKEN_B,
    );
  });

  it("menolak migrasi bila token proses tidak sama dengan satu entri .env", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-primary-ambiguous-"));
    const paths = primaryChannelCredentialPaths(root);
    await writeFile(paths.environmentFile, `TELEGRAM_BOT_TOKEN=${TOKEN_A}\n`, "utf8");

    await assert.rejects(
      migratePrimaryTelegramBotCredentialFromEnvironment({
        environment: { TELEGRAM_BOT_TOKEN: TOKEN_B },
        paths,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "PRIMARY_TELEGRAM_ENVIRONMENT_AMBIGUOUS",
    );
    assert.equal(loadPrimaryTelegramBotCredentialSync(paths), null);
  });

  it("menolak hard link ciphertext pada bootstrap sync maupun async", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-primary-hardlink-"));
    const paths = primaryChannelCredentialPaths(root);
    await savePrimaryTelegramBotCredential({ version: 1, botToken: TOKEN_A }, paths);
    await link(paths.secretFile, join(root, "credential-copy.json"));

    assert.throws(
      () => loadPrimaryTelegramBotCredentialSync(paths),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
    );
    await assert.rejects(
      loadPrimaryTelegramBotCredential(paths),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
    );
  });
});
