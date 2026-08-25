import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { CodingRuntimeDeploymentConfig } from "../src/core/coding-runtime-composition.js";
import { acquireLocalRuntimeLock } from "../src/core/local-runtime-lock.js";
import {
  createLocalBackup,
  createRuntimeBackupPlan,
  restoreLocalBackup,
  verifyLocalBackup,
  type LocalBackupPlan,
} from "../src/operations/local-backup.js";
import { primaryChannelCredentialPaths } from "../src/operations/primary-channel-credentials.js";

describe("backup lokal terenkripsi", () => {
  it("memasukkan key dan ciphertext credential kanal utama sebagai slot terpisah", () => {
    const root = join(tmpdir(), "harvy-runtime-backup-plan");
    const primaryPaths = primaryChannelCredentialPaths(root);
    const plan = createRuntimeBackupPlan(
      minimalRuntimeConfig(root),
      { enabled: false, stateRoot: null } as CodingRuntimeDeploymentConfig,
      { primaryCredentialPaths: primaryPaths },
    );

    assert.deepEqual(
      plan.targets.filter((target) => target.id.startsWith("primary-channel")),
      [
        {
          id: "primary-channel-credential-key",
          kind: "file",
          sourcePath: primaryPaths.keyFile,
          environmentVariable: null,
          classification: "credentials",
        },
        {
          id: "primary-channel-credentials",
          kind: "file",
          sourcePath: primaryPaths.secretFile,
          environmentVariable: null,
          classification: "credentials",
        },
      ],
    );
  });

  it("membuat, mengautentikasi, dan memulihkan seluruh slot tanpa plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-backup-"));
    const state = join(root, "state");
    const memory = join(state, "memories");
    const keyFile = join(memory, "backup.key");
    const archive = join(root, "backups", "snapshot.harvy");
    const recovery = join(root, "recovery");
    const key = randomBytes(32);
    try {
      await mkdir(join(memory, "nested"), { recursive: true });
      await writeFile(join(state, "tasks.json"), '{"task":"rahasia tugas"}\n');
      await writeFile(join(memory, "nested", "profile.md"), "catatan pribadi");
      await writeFile(keyFile, key.toString("base64url"));
      await writeFile(join(state, "memory.sqlite"), "sqlite-main");
      await writeFile(join(state, "memory.sqlite-wal"), "sqlite-wal");

      const plan = fixturePlan(root, keyFile);
      const created = await createLocalBackup({
        plan,
        destination: archive,
        key,
        now: new Date("2026-08-23T01:02:03.000Z"),
      });
      assert.deepEqual(created, {
        protocol: "harvy-local-backup/1",
        createdAt: "2026-08-23T01:02:03.000Z",
        targetCount: 4,
        presentTargetCount: 3,
        entryCount: 4,
        plaintextBytes:
          Buffer.byteLength('{"task":"rahasia tugas"}\n') +
          Buffer.byteLength("catatan pribadi") +
          Buffer.byteLength("sqlite-main") +
          Buffer.byteLength("sqlite-wal"),
        encrypted: true,
      });
      const encrypted = await readFile(archive);
      assert.equal(encrypted.includes(Buffer.from("rahasia tugas")), false);
      assert.equal(encrypted.includes(Buffer.from("catatan pribadi")), false);
      assert.equal(encrypted.includes(Buffer.from(key.toString("base64url"))), false);

      assert.deepEqual(await verifyLocalBackup({ archive, key }), created);
      assert.deepEqual(
        await restoreLocalBackup({
          archive,
          destinationDirectory: recovery,
          key,
        }),
        created,
      );
      assert.equal(
        await readFile(join(recovery, "targets", "tasks", "data"), "utf8"),
        '{"task":"rahasia tugas"}\n',
      );
      assert.equal(
        await readFile(
          join(recovery, "targets", "memories", "nested", "profile.md"),
          "utf8",
        ),
        "catatan pribadi",
      );
      assert.equal(
        await readFile(join(recovery, "targets", "long-term", "data-wal"), "utf8"),
        "sqlite-wal",
      );
      await assert.rejects(
        access(join(recovery, "targets", "memories", "backup.key")),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ENOENT",
      );
      const restoreMap = JSON.parse(
        await readFile(join(recovery, "RESTORE-MAP.json"), "utf8"),
      ) as { targets: Array<{ id: string; environmentVariable: string | null }> };
      assert.equal(
        restoreMap.targets.find((target) => target.id === "tasks")?.environmentVariable,
        "DATA_FILE",
      );
    } finally {
      key.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menolak snapshot saat runtime memegang lock yang sama", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-backup-lock-"));
    const key = randomBytes(32);
    const plan = fixturePlan(root);
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "tasks.json"), "{}\n");
    const runtime = await acquireLocalRuntimeLock(plan.lockPath, "runtime");
    try {
      await assert.rejects(
        createLocalBackup({
          plan,
          destination: join(root, "snapshot.harvy"),
          key,
        }),
        (error: unknown) =>
          error instanceof Error && "code" in error &&
          error.code === "LOCAL_DATA_LOCKED",
      );
    } finally {
      await runtime.release();
      key.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menolak kunci salah, arsip yang diubah, dan restore yang menimpa", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-backup-auth-"));
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const plan = fixturePlan(root);
    const archive = join(root, "snapshot.harvy");
    try {
      await mkdir(join(root, "state"), { recursive: true });
      await writeFile(join(root, "state", "tasks.json"), "{}\n");
      await createLocalBackup({ plan, destination: archive, key });
      await assert.rejects(
        verifyLocalBackup({ archive, key: wrongKey }),
        hasCode("BACKUP_AUTHENTICATION_FAILED"),
      );

      const existing = join(root, "existing");
      await mkdir(existing);
      await assert.rejects(
        restoreLocalBackup({
          archive,
          destinationDirectory: existing,
          key,
        }),
        hasCode("BACKUP_RESTORE_DESTINATION_EXISTS"),
      );

      await appendFile(archive, Buffer.from([0]));
      await assert.rejects(
        verifyLocalBackup({ archive, key }),
        hasCode("BACKUP_AUTHENTICATION_FAILED"),
      );
    } finally {
      key.fill(0);
      wrongKey.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function minimalRuntimeConfig(root: string): AppConfig {
  const file = (name: string): string => join(root, `${name}.json`);
  return {
    dataFile: file("tasks"),
    memoryFile: file("legacy-memories"),
    memoryFolder: join(root, "memories"),
    historyFile: file("history"),
    longTermMemoryFile: join(root, "long-term.sqlite"),
    profileFile: file("profiles"),
    sessionFile: file("sessions"),
    agentRunFile: file("agent-runs"),
    telemetryFile: file("telemetry"),
    controlPlane: {
      file: file("control-plane"),
      usageLedgerFile: file("usage-ledger"),
      entitlementLedgerFile: file("entitlement-ledger"),
      economy: null,
    },
    whatsapp: {
      authFolder: join(root, "whatsapp-auth"),
      groupFile: file("whatsapp-groups"),
    },
  } as unknown as AppConfig;
}

function fixturePlan(root: string, excluded?: string): LocalBackupPlan {
  const state = join(root, "state");
  return {
    lockPath: join(root, "runtime.lock"),
    targets: [
      {
        id: "tasks",
        kind: "file",
        sourcePath: join(state, "tasks.json"),
        environmentVariable: "DATA_FILE",
        classification: "user-data",
      },
      {
        id: "memories",
        kind: "directory",
        sourcePath: join(state, "memories"),
        environmentVariable: "MEMORY_FOLDER",
        classification: "user-data",
      },
      {
        id: "long-term",
        kind: "sqlite",
        sourcePath: join(state, "memory.sqlite"),
        environmentVariable: "LONG_TERM_MEMORY_FILE",
        classification: "user-data",
      },
      {
        id: "missing",
        kind: "file",
        sourcePath: join(state, "missing.json"),
        environmentVariable: null,
        classification: "operational-state",
      },
    ],
    ...(excluded ? { excludedPaths: [excluded] } : {}),
  };
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === expected;
}
