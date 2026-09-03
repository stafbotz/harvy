import { readFile } from "node:fs/promises";
import type { AbuseRecord, AbuseRepository } from "../domain/abuse.js";
import { writeDurableFileAtomic } from "./durable-file.js";

/**
 * Penyimpanan catatan penyalahgunaan, satu berkas untuk semua pemilik.
 *
 * Isinya hanya kategori dan waktu—tidak ada satu pun kutipan pesan pengguna,
 * sesuai ADR-045 keputusan 7. Berkasnya kecil dan jarang berubah, jadi satu
 * berkas cukup dan tidak perlu satu berkas per pengguna seperti memori.
 *
 * Tulisannya diserialisasi lewat satu antrean promise. Dua penangguhan yang
 * tiba bersamaan dari dua pengguna berbeda akan saling menimpa tanpa itu,
 * karena keduanya membaca-ubah-tulis berkas yang sama.
 */
interface StoredShape {
  version: 1;
  records: Record<string, Omit<AbuseRecord, "ownerId">>;
}

export class FileAbuseRepository implements AbuseRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(ownerId: string): Promise<AbuseRecord> {
    const store = await this.read();
    const found = store.records[ownerId];
    return {
      ownerId,
      warnings: found?.warnings ?? [],
      suspensions: found?.suspensions ?? [],
    };
  }

  async save(record: AbuseRecord): Promise<void> {
    await this.exclusive(async () => {
      const store = await this.read();
      store.records[record.ownerId] = {
        warnings: record.warnings,
        suspensions: record.suspensions,
      };
      await this.write(store);
    });
  }

  async forget(ownerId: string): Promise<void> {
    await this.exclusive(async () => {
      const store = await this.read();
      if (!(ownerId in store.records)) return;
      delete store.records[ownerId];
      await this.write(store);
    });
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    // Kegagalan satu tulisan tidak boleh mengunci antreannya selamanya.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoredShape> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredShape>;
      if (parsed.version !== 1 || typeof parsed.records !== "object") {
        return { version: 1, records: {} };
      }
      return { version: 1, records: parsed.records ?? {} };
    } catch {
      // Berkas belum ada atau tidak terbaca. Memulai dari kosong berarti
      // seseorang kehilangan riwayat peringatannya, dan itu arah yang benar:
      // gagal ke arah tidak menghukum.
      return { version: 1, records: {} };
    }
  }

  private async write(store: StoredShape): Promise<void> {
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(store, null, 2)}\n`,
    );
  }
}
