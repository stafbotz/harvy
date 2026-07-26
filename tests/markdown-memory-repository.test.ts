import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InsightService } from "../src/core/insight-service.js";
import { MarkdownInsightRepository } from "../src/storage/markdown-insight-repository.js";
import {
  MarkdownMemoryRepository,
  safeFolderName,
} from "../src/storage/markdown-memory-repository.js";
import type { MemoryItem } from "../src/domain/memory.js";

const NOW = new Date("2026-07-27T10:00:00.000Z");

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "harvy-memori-"));
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "ab12cd34",
    ownerId: "student",
    kind: "profile",
    content: "Kelas 11 IPA di SMAN 3 Bandung",
    createdAt: NOW.toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("memori sebagai berkas Markdown", () => {
  it("menulis satu folder per pengguna, satu berkas per jenis", async () => {
    const root = await workspace();
    const repository = new MarkdownMemoryRepository(root);

    await repository.save(memory());
    await repository.save(
      memory({ id: "ef56", kind: "preference", content: "Suka belajar malam" }),
    );

    assert.deepEqual(await repository.files("student"), [
      "cara-belajar.md",
      "tentang-kamu.md",
    ]);

    const raw = await readFile(
      join(root, "student", "tentang-kamu.md"),
      "utf8",
    );
    // Berkasnya harus dapat dibaca manusia. Hak melihat apa yang diingat
    // tentang dirinya (Pasal 4 nomor 4) jauh lebih jujur ketika bentuk
    // simpanannya memang bisa dibuka.
    assert.match(raw, /^# Tentang kamu/);
    assert.match(raw, /- Kelas 11 IPA di SMAN 3 Bandung/);
  });

  it("membaca kembali persis seperti yang ditulis", async () => {
    const root = await workspace();
    const repository = new MarkdownMemoryRepository(root);
    const item = memory({ expiresAt: "2026-09-01T00:00:00.000Z" });

    await repository.save(item);

    assert.deepEqual(await repository.list("student"), [item]);
  });

  it("memisahkan pengguna lewat folder, bukan lewat filter saja", async () => {
    const root = await workspace();
    const repository = new MarkdownMemoryRepository(root);

    await repository.save(memory());
    await repository.save(
      memory({ ownerId: "murid-lain", id: "zz99", content: "Kelas 9" }),
    );

    assert.equal((await repository.list("student")).length, 1);
    assert.equal((await repository.list("murid-lain")).length, 1);
    assert.equal((await repository.list("student"))[0]?.content?.includes("9"), false);
  });

  it("menghapus satu memori dan seluruhnya", async () => {
    const root = await workspace();
    const repository = new MarkdownMemoryRepository(root);

    await repository.save(memory());
    await repository.save(memory({ id: "kedua", content: "Suka roti" }));

    assert.equal(await repository.remove("student", "kedua"), true);
    assert.equal(await repository.remove("student", "kedua"), false);
    assert.equal((await repository.list("student")).length, 1);

    assert.equal(await repository.removeAll("student"), 1);
    assert.deepEqual(await repository.list("student"), []);
  });

  it("memindahkan berkas JSON lama sekali, tanpa membuang ingatan orang", async () => {
    const root = await workspace();
    const legacy = join(root, "memories.json");
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        memories: [memory(), memory({ ownerId: "orang-lain", id: "xx" })],
      }),
      "utf8",
    );

    const repository = new MarkdownMemoryRepository(
      join(root, "memori"),
      legacy,
    );

    const items = await repository.list("student");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.content, "Kelas 11 IPA di SMAN 3 Bandung");

    // Impor kedua tidak boleh menghidupkan kembali apa yang sudah dihapus.
    await repository.removeAll("student");
    assert.deepEqual(await repository.list("student"), []);
  });

  it("tidak membiarkan ownerId keluar dari direktori datanya", () => {
    assert.equal(safeFolderName("../../etc"), "etc");
    assert.equal(safeFolderName("12345"), "12345");
    assert.equal(safeFolderName("///"), "tidak-dikenal");
  });
});

describe("catatan pemahaman dan keselamatan", () => {
  it("menyimpan catatan berisiko dan membatasi jumlahnya", async () => {
    const root = await workspace();
    const insights = new InsightService(
      new MarkdownInsightRepository(root),
      async () => null,
      () => NOW,
    );

    await insights.record("student", "biasa", "males", "diabaikan");
    assert.deepEqual((await insights.load("student")).catatan, []);

    for (let index = 0; index < 25; index += 1) {
      await insights.record("student", "dukungan", `berat ke-${index}`, "ditemani");
    }

    const stored = await insights.load("student");
    assert.equal(stored.catatan.length, 20);
    assert.equal(stored.catatan.at(-1)?.ringkasan, "berat ke-24");
  });

  it("menyatakan di berkasnya sendiri bahwa isinya tidak ditampilkan", async () => {
    const root = await workspace();
    const insights = new InsightService(
      new MarkdownInsightRepository(root),
      async () => null,
      () => NOW,
    );

    await insights.record("student", "bahaya", "ingin menyakiti diri", "ditemani");
    const raw = await readFile(
      join(root, "student", "pemahaman-dan-keselamatan.md"),
      "utf8",
    );

    // Pengecualian terhadap Larangan Mutlak hanya dapat dipertanggungjawabkan
    // kalau ia terlihat jelas oleh siapa pun yang membuka datanya.
    assert.match(raw, /tidak ditampilkan kepada penggunanya/i);
    assert.match(raw, /Pasal 4 nomor 6/);
    assert.match(raw, /ingin menyakiti diri/);
  });

  it("ikut terhapus ketika pengguna menghapus seluruh datanya", async () => {
    const root = await workspace();
    const repository = new MarkdownInsightRepository(root);
    const insights = new InsightService(repository, async () => null, () => NOW);

    await insights.record("student", "dukungan", "berat", "ditemani");
    await insights.forget("student");

    assert.deepEqual((await insights.load("student")).catatan, []);
  });

  it("menahan diri mengangkat bantuan sampai jaraknya cukup", async () => {
    const root = await workspace();
    const insights = new InsightService(
      new MarkdownInsightRepository(root),
      async () => null,
      () => NOW,
    );

    await mkdir(join(root, "student"), { recursive: true });
    await insights.record("student", "dukungan", "berat", "ditemani");

    // Baru saja terjadi: bukan saatnya merujuk ke mana pun.
    assert.equal(await insights.shouldRaiseHelp("student", "biasa"), false);
  });
});
