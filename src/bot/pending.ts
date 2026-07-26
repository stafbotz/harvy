/**
 * Menyimpan satu langkah percakapan yang sedang menunggu jawaban pengguna.
 *
 * Dipakai untuk dua hal: menunggu konfirmasi sebelum sebuah pesan dicatat
 * sebagai tugas, dan menunggu tenggat baru setelah tombol "Ubah" ditekan.
 *
 * Sengaja hanya di memori. Isinya adalah niat sesaat, bukan data pengguna yang
 * perlu disimpan; Konstitusi Pasal 3.9 meminta Harvy mengumpulkan sedikit
 * mungkin. Konsekuensinya, langkah yang menggantung hilang saat proses
 * restart, dan itu ditangani sebagai keadaan normal, bukan galat.
 */
import type { ExtractedMemory, ExtractedTask } from "../ai/understand.js";

export type Pending =
  | { kind: "confirm-task"; task: ExtractedTask }
  | { kind: "confirm-memory"; memory: ExtractedMemory }
  | { kind: "edit-due"; taskId: string };

interface Entry {
  value: Pending;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PendingStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  set(ownerId: string, value: Pending): void {
    this.entries.set(ownerId, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Membaca tanpa menghapus, agar pengguna boleh mencoba menjawab lagi. */
  peek(ownerId: string): Pending | null {
    const entry = this.entries.get(ownerId);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(ownerId);
      return null;
    }

    return entry.value;
  }

  clear(ownerId: string): void {
    this.entries.delete(ownerId);
  }
}
