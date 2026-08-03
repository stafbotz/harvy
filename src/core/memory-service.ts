import { randomUUID } from "node:crypto";
import type {
  MemoryItem,
  MemoryRepository,
  NewMemory,
} from "../domain/memory.js";
import {
  expiryFor,
  isExpired,
  selectRelevantMemories,
} from "./memory-policy.js";

/**
 * Mengurus apa yang Harvy ingat tentang seorang pengguna.
 *
 * Seluruh metode menerima `ownerId`. Itu batas isolasi data yang sama dengan
 * tugas, dan tidak ada kueri memori yang boleh berjalan tanpanya.
 */
export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async remember(input: NewMemory): Promise<MemoryItem | null> {
    const content = input.content.trim();
    if (!content) return null;

    const existing = await this.list(input.ownerId);

    // Model mengusulkan memori pada setiap giliran, sehingga hal yang sama akan
    // diusulkan berulang kali. Tanpa penjagaan ini, "kelas 11 IPA" akan tercatat
    // sepuluh kali dan daftar memori menjadi tidak bisa dibaca penggunanya.
    const duplicate = existing.find(
      (item) => item.content.toLowerCase() === content.toLowerCase(),
    );
    if (duplicate) return null;

    const now = this.now();
    const item: MemoryItem = {
      id: randomUUID().replaceAll("-", "").slice(0, 8),
      ownerId: input.ownerId,
      kind: input.kind,
      content,
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt: expiryFor(input.kind, now)?.toISOString() ?? null,
    };

    await this.repository.save(item);
    return item;
  }

  /**
   * Memori milik pengguna, yang kedaluwarsa sudah dibuang.
   *
   * Pembuangan terjadi saat dibaca, bukan lewat pekerja terjadwal. Satu proses
   * dengan satu berkas tidak cukup ramai untuk membenarkan penyapu tersendiri,
   * dan memori kedaluwarsa yang masih terbaca lebih berbahaya daripada memori
   * kedaluwarsa yang masih memakai tempat.
   */
  async list(ownerId: string): Promise<MemoryItem[]> {
    const now = this.now();
    const stored = await this.repository.list(ownerId);
    const alive: MemoryItem[] = [];

    for (const item of stored) {
      if (isExpired(item, now)) {
        await this.repository.remove(ownerId, item.id);
        continue;
      }
      alive.push(item);
    }

    return alive;
  }

  /** Memori yang pantas dibawa ke dalam prompt untuk sebuah pesan. */
  async relevantTo(ownerId: string, message: string): Promise<MemoryItem[]> {
    const items = await this.list(ownerId);
    return selectRelevantMemories(items, message, this.now());
  }

  async forget(ownerId: string, id: string): Promise<MemoryItem | null> {
    const items = await this.repository.list(ownerId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return null;

    return (await this.repository.remove(ownerId, id)) ? item : null;
  }

  async edit(
    ownerId: string,
    id: string,
    content: string,
  ): Promise<MemoryItem | null> {
    const clean = content.trim().replaceAll(/\s+/g, " ");
    if (!clean || clean.length > 200) return null;

    const items = await this.repository.list(ownerId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return null;

    const duplicate = items.find(
      (candidate) =>
        candidate.id !== id &&
        candidate.content.toLowerCase() === clean.toLowerCase(),
    );
    if (duplicate) return null;

    const updated = { ...item, content: clean };
    await this.repository.save(updated);
    return updated;
  }

  async forgetAll(ownerId: string): Promise<number> {
    return this.repository.removeAll(ownerId);
  }

  /** Menandai memori yang benar-benar ikut membantu sebuah balasan. */
  async markUsed(items: MemoryItem[]): Promise<void> {
    const usedAt = this.now().toISOString();

    for (const item of items) {
      await this.repository.save({ ...item, lastUsedAt: usedAt });
    }
  }
}
