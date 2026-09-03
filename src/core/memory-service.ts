import { randomUUID } from "node:crypto";
import type {
  MemoryItem,
  MemoryRepository,
  MemoryKind,
  NewMemory,
} from "../domain/memory.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  containsForbiddenMemorySecret,
  expiryFor,
  isExpired,
  selectRelevantMemories,
} from "./memory-policy.js";
import { deriveMemoryMetadata } from "./memory-candidate.js";

export const MEMORY_STORAGE_LIMIT = 128;

/**
 * Mengurus apa yang Harvy ingat tentang seorang pengguna.
 *
 * Seluruh metode menerima `ownerId`. Itu batas isolasi data yang sama dengan
 * tugas, dan tidak ada kueri memori yang boleh berjalan tanpanya. Untuk jenis
 * personal, `sensitiveConsent` berarti adapter telah membuktikan authority
 * penyimpanan—consent onboarding privat atau perintah explicit pada scope lain.
 */
export class MemoryService {
  private readonly derivations = new Map<string, Promise<void>>();
  private readonly learnings = new Map<string, Promise<void>>();
  private readonly blockedOwners = new Set<string>();
  private readonly sourceQueues = new Map<string, Promise<void>>();
  private readonly ownerGenerations = new Map<string, number>();

  constructor(
    private readonly repository: MemoryRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle: MemoryDerivationLifecycle | null = null,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.memory"),
    private readonly learning: MemoryLearningLifecycle | null = null,
  ) {}

  /**
   * Mencatat hasil satu percobaan menulis memori.
   *
   * Sampai 3 September 2026 berkas ini tidak punya satu pun catatan
   * keberhasilan—hanya tiga `logger.error`. Padahal `remember` dapat menolak
   * diam-diam karena enam sebab berbeda, dan semuanya mengembalikan `null` yang
   * sama persis. Akibatnya pertanyaan paling wajar tentang Harvy, "apakah dia
   * benar-benar belajar tentang penggunanya", tidak dapat dijawab: satu catatan
   * tersimpan setelah 430 panggilan model bisa berarti tidak ada yang layak
   * diingat, atau berarti semuanya ditolak, dan dari luar keduanya identik.
   *
   * Isi catatannya TIDAK pernah ikut. Yang keluar hanya hasil, jenis, dan
   * jumlah—cukup untuk menghitung, tidak cukup untuk membaca ulang percakapan
   * siapa pun.
   */
  private noteWriteOutcome(
    outcome: string,
    kind: MemoryKind,
    storedCount?: number,
  ): void {
    try {
      this.logger.info(
        "memory_write_outcome",
        "Percobaan menulis memori selesai.",
        {
          outcome,
          memoryKind: kind,
          ...(storedCount === undefined ? {} : { storedCount }),
        },
      );
    } catch {
      // Pengumpulan bukti tidak boleh menjadi sebab tulis memori gagal.
    }
  }

  async remember(input: NewMemory): Promise<MemoryItem | null> {
    return this.exclusiveSource(input.ownerId, async () => {
      const content = input.content.trim();
      // Satu gerbang per sebab, bukan satu rantai `||`.
      //
      // Perilakunya persis sama dan urutannya tidak berubah; yang berubah
      // hanyalah setiap penolakan kini menyebutkan alasannya. Dalam bentuk
      // lama keenamnya mengembalikan `null` yang tak terbedakan.
      const reject = (outcome: string): null => {
        this.noteWriteOutcome(outcome, input.kind);
        return null;
      };
      if (!content) return reject("kosong");
      if (containsForbiddenMemorySecret(content)) return reject("rahasia");
      if (this.blockedOwners.has(input.ownerId)) return reject("terkunci");
      if (input.kind === "personal" && input.sensitiveConsent !== true) {
        return reject("butuh_persetujuan");
      }

      const existing = await this.listUnlocked(input.ownerId);
      if (this.blockedOwners.has(input.ownerId)) return reject("terkunci");
      await this.lifecycle?.reconcileSources?.(existing);
      if (this.blockedOwners.has(input.ownerId)) return reject("terkunci");

      // Model mengusulkan memori pada setiap giliran, sehingga hal yang sama
      // akan diusulkan berulang kali. Tanpa penjagaan ini, "kelas 11 IPA" akan
      // tercatat sepuluh kali dan daftar memori menjadi tidak bisa dibaca.
      const duplicate = existing.find(
        (item) => item.content.toLowerCase() === content.toLowerCase(),
      );
      if (duplicate) return reject("duplikat");
      if (existing.length >= MEMORY_STORAGE_LIMIT) return reject("penuh");

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
      if (this.blockedOwners.has(input.ownerId)) {
        await this.repository.remove(input.ownerId, item.id);
        return reject("terkunci_setelah_simpan");
      }
      this.scheduleDerivation(input.ownerId, () =>
        this.lifecycle?.rememberSource(item, input) ?? Promise.resolve());
      this.scheduleLearning(input.ownerId, () =>
        this.learning?.rememberSource(item, input) ?? Promise.resolve());
      this.noteWriteOutcome("tersimpan", item.kind, existing.length + 1);
      return item;
    });
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
    return this.exclusiveSource(ownerId, () => this.listUnlocked(ownerId));
  }

  private async listUnlocked(ownerId: string): Promise<MemoryItem[]> {
    const now = this.now();
    const stored = await this.repository.list(ownerId);
    const alive: MemoryItem[] = [];

    for (const item of stored) {
      if (isExpired(item, now)) {
        await this.drainOwner(ownerId);
        await this.lifecycle?.forgetSource(item, "expired");
        await this.learning?.forgetSource(item);
        await this.repository.remove(ownerId, item.id);
        continue;
      }
      alive.push(item);
    }

    return alive;
  }

  /** Memori yang pantas dibawa ke dalam prompt untuk sebuah pesan. */
  async relevantTo(ownerId: string, message: string): Promise<MemoryItem[]> {
    const generation = this.generationOf(ownerId);
    if (this.blockedOwners.has(ownerId)) return [];
    return this.exclusiveSource(ownerId, async () => {
      if (
        this.blockedOwners.has(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return [];
      const items = await this.listUnlocked(ownerId);
      try {
        await this.lifecycle?.reconcileSources?.(items);
      } catch (error) {
        this.logger.error(
          "memory_reconciliation_failed",
          "Migrasi semantic memory lama gagal; prompt memory ditutup.",
          error,
        );
        return [];
      }
      if (
        this.blockedOwners.has(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return [];
      return selectRelevantMemories(items, message, this.now());
    });
  }

  async forget(ownerId: string, id: string): Promise<MemoryItem | null> {
    return this.exclusiveSource(ownerId, async () => {
      const items = await this.repository.list(ownerId);
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return null;

      await this.drainOwner(ownerId);
      await this.lifecycle?.forgetSource(item, "forgotten");
      await this.learning?.forgetSource(item);
      return (await this.repository.remove(ownerId, id)) ? item : null;
    });
  }

  async edit(
    ownerId: string,
    id: string,
    content: string,
  ): Promise<MemoryItem | null> {
    const clean = content.trim().replaceAll(/\s+/g, " ");
    if (
      !clean ||
      clean.length > 200 ||
      containsForbiddenMemorySecret(clean)
    ) return null;

    return this.exclusiveSource(ownerId, async () => {
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
      try {
        await this.drainOwner(ownerId);
        await this.lifecycle?.editSource(item, updated, {
          ownerId,
          kind: updated.kind,
          content: updated.content,
          ...deriveMemoryMetadata(
            updated.kind,
            updated.content,
            updated.content,
          ),
          correction: true,
        });
        this.scheduleLearning(ownerId, () =>
          this.learning?.editSource(item, updated, {
            ownerId,
            kind: updated.kind,
            content: updated.content,
            ...deriveMemoryMetadata(
              updated.kind,
              updated.content,
              updated.content,
            ),
            correction: true,
          }) ?? Promise.resolve());
      } catch (error) {
        await this.repository.save(item);
        throw error;
      }
      return updated;
    });
  }

  async forgetAll(ownerId: string): Promise<number> {
    const keepBlocked = this.blockedOwners.has(ownerId);
    if (!keepBlocked) this.suspend(ownerId);
    try {
      return await this.exclusiveSource(ownerId, async () => {
        await this.drainOwner(ownerId);
        await this.learning?.forgetPrivateOwner(ownerId);
        await this.lifecycle?.forgetPrivateOwner(ownerId);
        return this.repository.removeAll(ownerId);
      });
    } finally {
      if (!keepBlocked) this.allow(ownerId);
    }
  }

  /** Menutup retrieval/consolidation segera ketika consent ditarik. */
  suspend(ownerId: string): void {
    this.blockedOwners.add(ownerId);
    this.ownerGenerations.set(ownerId, this.generationOf(ownerId) + 1);
    this.lifecycle?.suspendPrivateOwner(ownerId);
    this.learning?.suspendPrivateOwner(ownerId);
  }

  /** Hanya dipanggil sesudah persetujuan baru benar-benar tersimpan. */
  allow(ownerId: string): void {
    this.blockedOwners.delete(ownerId);
    this.lifecycle?.allowPrivateOwner(ownerId);
    this.learning?.allowPrivateOwner(ownerId);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.sourceQueues.values()].map((operation) =>
      operation.catch(() => undefined)));
    await Promise.all([...this.derivations.values()].map((derivation) =>
      derivation.catch(() => undefined)));
    await this.lifecycle?.drain();
    await Promise.all([...this.learnings.values()].map((learning) =>
      learning.catch(() => undefined)));
    await this.learning?.drain();
  }

  /** Menandai memori yang benar-benar ikut membantu sebuah balasan. */
  async markUsed(items: MemoryItem[]): Promise<void> {
    const usedAt = this.now().toISOString();
    const byOwner = new Map<string, MemoryItem[]>();
    for (const item of items) {
      const ownerItems = byOwner.get(item.ownerId) ?? [];
      ownerItems.push(item);
      byOwner.set(item.ownerId, ownerItems);
    }
    await Promise.all([...byOwner].map(([ownerId, ownerItems]) =>
      this.exclusiveSource(ownerId, async () => {
        if (this.blockedOwners.has(ownerId)) return;
        const current = new Map(
          (await this.repository.list(ownerId)).map((item) => [item.id, item]),
        );
        if (this.blockedOwners.has(ownerId)) return;
        for (const requested of ownerItems) {
          const item = current.get(requested.id);
          if (!item || this.blockedOwners.has(ownerId)) continue;
          // Pakai record live agar completion lama tidak mengembalikan content
          // sebelum edit atau membuat ulang item yang sudah dihapus.
          await this.repository.save({ ...item, lastUsedAt: usedAt });
        }
      })));
  }

  private scheduleDerivation(
    ownerId: string,
    operation: () => Promise<void>,
  ): void {
    if (!this.lifecycle) return;
    const previous = this.derivations.get(ownerId) ?? Promise.resolve();
    const next = previous.then(operation, operation).catch((error: unknown) => {
      this.logger.error(
        "memory_derivation_failed",
        "Konsolidasi semantic memory gagal.",
        error,
      );
    });
    this.derivations.set(ownerId, next);
    void next.finally(() => {
      if (this.derivations.get(ownerId) === next) {
        this.derivations.delete(ownerId);
      }
    });
  }

  private async drainOwner(ownerId: string): Promise<void> {
    await this.derivations.get(ownerId)?.catch(() => undefined);
    await this.learnings.get(ownerId)?.catch(() => undefined);
  }

  private scheduleLearning(
    ownerId: string,
    operation: () => Promise<void>,
  ): void {
    if (!this.learning) return;
    const previous = this.learnings.get(ownerId) ?? Promise.resolve();
    const next = previous.then(operation, operation).catch((error: unknown) => {
      this.logger.error(
        "memory_learning_enqueue_failed",
        "Learning turunan memory gagal dipersistenkan.",
        error,
      );
    });
    this.learnings.set(ownerId, next);
    void next.finally(() => {
      if (this.learnings.get(ownerId) === next) this.learnings.delete(ownerId);
    });
  }

  private async exclusiveSource<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sourceQueues.get(ownerId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.sourceQueues.set(ownerId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.sourceQueues.get(ownerId) === tail) {
        this.sourceQueues.delete(ownerId);
      }
    }
  }

  private generationOf(ownerId: string): number {
    return this.ownerGenerations.get(ownerId) ?? 0;
  }
}

/** Lifecycle turunan; implementasi wajib idempoten dan owner-scoped. */
export interface MemoryDerivationLifecycle {
  reconcileSources?(items: readonly MemoryItem[]): Promise<void>;
  rememberSource(item: MemoryItem, input: NewMemory): Promise<void>;
  editSource(
    previous: MemoryItem,
    updated: MemoryItem,
    input?: NewMemory,
  ): Promise<void>;
  forgetSource(
    item: MemoryItem,
    reason?: "forgotten" | "edited" | "expired",
  ): Promise<void>;
  forgetPrivateOwner(ownerId: string): Promise<void>;
  suspendPrivateOwner(ownerId: string): void;
  allowPrivateOwner(ownerId: string): void;
  drain(): Promise<void>;
}

/** Secondary learned views; primary memory remains user-controlled authority. */
export interface MemoryLearningLifecycle {
  rememberSource(item: MemoryItem, input: NewMemory): Promise<void>;
  editSource(
    previous: MemoryItem,
    updated: MemoryItem,
    input?: NewMemory,
  ): Promise<void>;
  forgetSource(item: MemoryItem): Promise<void>;
  forgetPrivateOwner(ownerId: string): Promise<void>;
  suspendPrivateOwner(ownerId: string): void;
  allowPrivateOwner(ownerId: string): void;
  drain(): Promise<void>;
}
