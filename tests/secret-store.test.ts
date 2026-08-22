import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EncryptedFileSecretStore,
  MemorySecretStore,
} from "../src/core/secret-store.js";

describe("SecretStore durability boundary", () => {
  it("tidak mengekspos cache baru ketika write durable gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-secret-store-failure-"));
    const file = join(root, "secrets.json");
    try {
      const store = new EncryptedFileSecretStore(
        file,
        new Uint8Array(32).fill(7),
      );
      assert.equal(await store.get("credential_probe"), null);

      // Target directory membuat final rename file gagal secara deterministik,
      // setelah cache kosong sudah diload oleh instance yang sama.
      await mkdir(file);
      await assert.rejects(
        () => store.put("credential_probe", "secret-probe-value"),
      );
      assert.equal(await store.get("credential_probe"), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("menolak reference prototype dan record lokal yang dirusak", async () => {
    const memory = new MemorySecretStore();
    for (const ref of ["__proto__", "prototype", "constructor"]) {
      await assert.rejects(
        () => memory.put(ref, "secret-probe-value"),
        /Reference secret store/u,
      );
    }

    const root = await mkdtemp(join(tmpdir(), "harvy-secret-store-tamper-"));
    const file = join(root, "secrets.json");
    try {
      await writeFile(
        file,
        '{"constructor":"v1.invalid.invalid.invalid"}\n',
        "utf8",
      );
      const store = new EncryptedFileSecretStore(
        file,
        new Uint8Array(32).fill(9),
      );
      await assert.rejects(
        () => store.get("credential_probe"),
        /Reference secret store/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
