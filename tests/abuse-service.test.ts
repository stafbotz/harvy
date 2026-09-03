import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AbuseService, type AbuseReport } from "../src/core/abuse-service.js";
import { FileAbuseRepository } from "../src/storage/file-abuse-repository.js";
import type { AbuseSignal } from "../src/core/abuse-policy.js";

const JAM = 60 * 60 * 1000;

async function withFolder<T>(run: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "harvy-abuse-"));
  try {
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

function sinyal(over: Partial<AbuseSignal> = {}): AbuseSignal {
  return { category: "directed-abuse", distress: false, grounded: true, ...over };
}

describe("layanan pencegahan penyalahgunaan", () => {
  it("menegur dua kali lalu menangguhkan, dan menyimpannya", async () => {
    await withFolder(async (folder) => {
      let now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const repo = new FileAbuseRepository(join(folder, "abuse.json"));
      const service = new AbuseService(repo, () => now);

      assert.equal((await service.observe("1", sinyal())).kind, "warn");
      assert.equal((await service.observe("1", sinyal())).kind, "warn");
      const ketiga = await service.observe("1", sinyal());
      assert.equal(ketiga.kind, "suspend");

      // Bertahan lintas instance: catatan ini hidup di berkas, bukan di memori.
      const lain = new AbuseService(
        new FileAbuseRepository(join(folder, "abuse.json")),
        () => now,
      );
      assert.equal(await lain.allowsTurn("1", false), false);

      now += 2 * JAM;
      assert.equal(
        await lain.allowsTurn("1", false),
        true,
        "pulih sendiri sesudah satu jam pertama",
      );
    });
  });

  // Aturan yang tidak boleh ditawar. Anak yang kemarin memaki lalu hari ini
  // menulis sesuatu tentang menyakiti diri harus tetap dijawab.
  it("tetap membuka giliran bersinyal keselamatan saat ditangguhkan", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const service = new AbuseService(
        new FileAbuseRepository(join(folder, "abuse.json")),
        () => now,
      );

      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      await service.observe("1", sinyal());

      assert.equal(await service.allowsTurn("1", false), false);
      assert.equal(await service.allowsTurn("1", true), true);
    });
  });

  it("tidak mencatat apa pun ketika gilirannya membawa distres", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const path = join(folder, "abuse.json");
      const service = new AbuseService(new FileAbuseRepository(path), () => now);

      for (let i = 0; i < 5; i += 1) {
        assert.equal(
          (await service.observe("1", sinyal({ distress: true }))).kind,
          "record",
        );
      }
      assert.equal(await service.allowsTurn("1", false), true);
    });
  });

  // Pemberitahuan yang terlalu sering akan dibisukan pengelolanya, dan sesudah
  // itu yang penting ikut tidak terbaca.
  it("melapor hanya saat penangguhan, tidak saat peringatan", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const laporan: AbuseReport[] = [];
      const service = new AbuseService(
        new FileAbuseRepository(join(folder, "abuse.json")),
        () => now,
        undefined,
        async (report) => {
          laporan.push(report);
        },
      );

      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      assert.equal(laporan.length, 0, "peringatan tidak dilaporkan");

      await service.observe("1", sinyal());
      assert.equal(laporan.length, 1);
      assert.equal(laporan[0]?.action.kind, "suspend");
    });
  });

  // Laporan yang gagal terkirim tidak boleh membatalkan penangguhannya.
  it("tetap menangguhkan meski laporannya gagal", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const service = new AbuseService(
        new FileAbuseRepository(join(folder, "abuse.json")),
        () => now,
        undefined,
        async () => {
          throw new Error("Telegram tidak terjangkau");
        },
      );

      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      assert.equal((await service.observe("1", sinyal())).kind, "suspend");
      assert.equal(await service.allowsTurn("1", false), false);
    });
  });

  // Pasal 2: data ini ikut terhapus bersama data penggunanya.
  it("melupakan catatan bersama penghapusan data", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const service = new AbuseService(
        new FileAbuseRepository(join(folder, "abuse.json")),
        () => now,
      );

      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      assert.equal(await service.allowsTurn("1", false), false);

      await service.forget("1");
      assert.equal(await service.allowsTurn("1", false), true);
    });
  });

  it("tidak menyimpan satu pun potongan pesan pengguna", async () => {
    await withFolder(async (folder) => {
      const now = Date.UTC(2026, 8, 3, 12, 0, 0);
      const path = join(folder, "abuse.json");
      const service = new AbuseService(new FileAbuseRepository(path), () => now);

      await service.observe("1", sinyal());
      await service.observe("1", sinyal());
      await service.observe("1", sinyal());

      const isi = await (await import("node:fs/promises")).readFile(
        path,
        "utf8",
      );
      assert.doesNotMatch(isi, /[a-z]{4,}\s+[a-z]{4,}/u);
    });
  });
});
