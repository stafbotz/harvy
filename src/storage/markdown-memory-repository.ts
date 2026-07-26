import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  MemoryItem,
  MemoryKind,
  MemoryRepository,
} from "../domain/memory.js";

/**
 * Memori sebagai berkas Markdown, satu folder per pengguna.
 *
 * Bentuk ini dipilih karena dua alasan yang berbeda sifatnya. Yang pertama
 * teknis: isi berkasnya dapat langsung disisipkan ke prompt tanpa diterjemahkan
 * lebih dulu, karena model memang membaca Markdown dengan baik. Yang kedua soal
 * hak — Pasal 4 nomor 4 memberi pengguna hak melihat dan menghapus apa yang
 * diingat tentang dirinya, dan berkas yang dapat dibuka manusia jauh lebih
 * jujur daripada satu JSON besar berisi semua orang sekaligus.
 *
 * Satu folder per `ownerId` juga membuat batas isolasi datanya terlihat dari
 * struktur direktori, bukan hanya dari filter di dalam kode.
 *
 *   data/memori/<ownerId>/tentang-kamu.md
 *   data/memori/<ownerId>/cara-belajar.md
 *   ...
 *
 * Satu memori adalah satu butir daftar, dengan metadatanya disembunyikan di
 * komentar HTML supaya tidak ikut terbaca ketika berkasnya dipandang manusia:
 *
 *   - Kelas 11 IPA di SMAN 3 Bandung <!-- id:ab12cd34 dibuat:… -->
 */
const FILE_OF: Record<MemoryKind, string> = {
  profile: "tentang-kamu.md",
  preference: "cara-belajar.md",
  routine: "kebiasaan.md",
  context: "yang-sedang-berjalan.md",
  personal: "pribadi.md",
};

const HEADING_OF: Record<MemoryKind, string> = {
  profile: "Tentang kamu",
  preference: "Cara belajarmu",
  routine: "Kebiasaanmu",
  context: "Yang sedang berjalan",
  personal: "Hal pribadi",
};

const KIND_OF = new Map<string, MemoryKind>(
  (Object.keys(FILE_OF) as MemoryKind[]).map((kind) => [FILE_OF[kind], kind]),
);

export class MarkdownMemoryRepository implements MemoryRepository {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `legacyFile` adalah berkas JSON dari bentuk penyimpanan sebelumnya. Ia
   * dibaca sekali per pengguna, hanya ketika foldernya belum ada, lalu tidak
   * pernah ditulis lagi. Tanpa ini, berpindah bentuk penyimpanan berarti
   * membuang ingatan orang tanpa memberitahunya.
   */
  constructor(
    private readonly root: string,
    private readonly legacyFile?: string,
  ) {}

  async save(item: MemoryItem): Promise<void> {
    await this.exclusive(async () => {
      const items = await this.readAll(item.ownerId);
      const index = items.findIndex((stored) => stored.id === item.id);

      if (index >= 0) {
        items[index] = item;
      } else {
        items.push(item);
      }

      await this.writeKind(item.ownerId, item.kind, items);
    });
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    return this.readAll(ownerId);
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const items = await this.readAll(ownerId);
      const target = items.find((item) => item.id === id);
      if (!target) return false;

      await this.writeKind(
        ownerId,
        target.kind,
        items.filter((item) => item.id !== id),
      );
      return true;
    });
  }

  async removeAll(ownerId: string): Promise<number> {
    return this.exclusive(async () => {
      const items = await this.readAll(ownerId);
      if (items.length === 0) return 0;

      for (const kind of new Set(items.map((item) => item.kind))) {
        await this.writeKind(ownerId, kind, []);
      }
      return items.length;
    });
  }

  /** Nama berkas yang benar-benar ada, untuk ditunjukkan kepada pengguna. */
  async files(ownerId: string): Promise<string[]> {
    try {
      const names = await readdir(this.folderOf(ownerId));
      return names.filter((name) => KIND_OF.has(name)).sort();
    } catch {
      return [];
    }
  }

  private async readAll(ownerId: string): Promise<MemoryItem[]> {
    await this.importLegacyOnce(ownerId);

    const items: MemoryItem[] = [];

    for (const [kind, file] of Object.entries(FILE_OF) as [
      MemoryKind,
      string,
    ][]) {
      const raw = await this.readFileOrEmpty(join(this.folderOf(ownerId), file));
      items.push(...parseMemoryFile(raw, ownerId, kind));
    }

    return items;
  }

  private async writeKind(
    ownerId: string,
    kind: MemoryKind,
    all: MemoryItem[],
  ): Promise<void> {
    const folder = this.folderOf(ownerId);
    await mkdir(folder, { recursive: true });

    const path = join(folder, FILE_OF[kind]);
    const body = renderMemoryFile(
      HEADING_OF[kind],
      all.filter((item) => item.kind === kind),
    );

    const temporary = `${path}.tmp`;
    await writeFile(temporary, body, "utf8");
    await rename(temporary, path);
  }

  /**
   * Memindahkan isi berkas JSON lama ke folder pengguna, sekali saja.
   *
   * Penanda selesainya adalah keberadaan foldernya sendiri, bukan berkas
   * tambahan: begitu satu berkas Markdown tertulis, impor tidak pernah berjalan
   * lagi untuk pengguna itu.
   */
  private async importLegacyOnce(ownerId: string): Promise<void> {
    if (!this.legacyFile) return;

    try {
      await readdir(this.folderOf(ownerId));
      return;
    } catch {
      // Folder belum ada. Lanjut mengimpor.
    }

    const raw = await this.readFileOrEmpty(this.legacyFile);
    if (!raw) return;

    let stored: MemoryItem[] = [];
    try {
      const parsed = JSON.parse(raw) as { memories?: MemoryItem[] };
      stored = (parsed.memories ?? []).filter(
        (item) => item.ownerId === ownerId,
      );
    } catch {
      return;
    }

    if (stored.length === 0) {
      await mkdir(this.folderOf(ownerId), { recursive: true });
      return;
    }

    for (const kind of new Set(stored.map((item) => item.kind))) {
      await this.writeKind(ownerId, kind, stored);
    }
  }

  private folderOf(ownerId: string): string {
    return join(this.root, safeFolderName(ownerId));
  }

  private async readFileOrEmpty(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * `ownerId` berasal dari Telegram dan selalu berupa angka, tetapi ia tetap
 * dibersihkan sebelum menjadi nama folder. Nilai yang tidak terduga tidak boleh
 * bisa keluar dari direktori datanya.
 */
export function safeFolderName(ownerId: string): string {
  const clean = ownerId.replaceAll(/[^a-zA-Z0-9_-]/g, "");
  return clean || "tidak-dikenal";
}

const ITEM_LINE =
  /^- (.*?)\s*<!--\s*id:(\S+)\s+dibuat:(\S+)\s+dipakai:(\S+)\s+kedaluwarsa:(\S+)\s*-->\s*$/u;

export function parseMemoryFile(
  raw: string,
  ownerId: string,
  kind: MemoryKind,
): MemoryItem[] {
  const items: MemoryItem[] = [];

  for (const line of raw.split("\n")) {
    const match = ITEM_LINE.exec(line.trim());
    if (!match) continue;

    const [, content = "", id = "", createdAt = "", lastUsedAt = "-", expiresAt = "-"] =
      match;
    if (!content || !id) continue;

    items.push({
      id,
      ownerId,
      kind,
      content,
      createdAt,
      lastUsedAt: lastUsedAt === "-" ? null : lastUsedAt,
      expiresAt: expiresAt === "-" ? null : expiresAt,
    });
  }

  return items;
}

export function renderMemoryFile(
  heading: string,
  items: MemoryItem[],
): string {
  const lines = [`# ${heading}`, ""];

  if (items.length === 0) {
    lines.push("_Belum ada._", "");
    return lines.join("\n");
  }

  for (const item of items) {
    lines.push(
      `- ${item.content} <!-- id:${item.id} dibuat:${item.createdAt} ` +
        `dipakai:${item.lastUsedAt ?? "-"} kedaluwarsa:${item.expiresAt ?? "-"} -->`,
    );
  }

  lines.push("");
  return lines.join("\n");
}
