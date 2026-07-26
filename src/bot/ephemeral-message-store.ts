/** Pesan Telegram yang boleh dibersihkan setelah pengguna lanjut mengobrol. */
export interface EphemeralMessageRef {
  chatId: string | number;
  messageId: number;
  failedAttempts?: number;
}

const MAX_DELETE_ATTEMPTS = 3;

export class EphemeralMessageStore {
  private readonly messages = new Map<string, EphemeralMessageRef[]>();
  private readonly leased = new Map<string, Set<number>>();
  private readonly removedWhileLeased = new Map<string, Set<number>>();

  add(ownerId: string, message: EphemeralMessageRef): void {
    const existing = this.messages.get(ownerId) ?? [];
    if (
      existing.some(
        (item) =>
          item.chatId === message.chatId && item.messageId === message.messageId,
      )
    ) {
      return;
    }
    existing.push(message);
    this.messages.set(ownerId, existing);
  }

  remove(ownerId: string, messageId: number): void {
    const existing = this.messages.get(ownerId);
    if (existing) {
      const remaining = existing.filter(
        (message) => message.messageId !== messageId,
      );
      if (remaining.length === 0) {
        this.messages.delete(ownerId);
      } else {
        this.messages.set(ownerId, remaining);
      }
    }

    // takeAll melepas ref dari `messages` selama request delete berjalan.
    // Tombstone mencegah hasil gagal menghidupkannya lagi setelah pengguna
    // menekan Oke/Lupakan pada saat yang sama.
    if (this.leased.get(ownerId)?.has(messageId)) {
      const removed = this.removedWhileLeased.get(ownerId) ?? new Set<number>();
      removed.add(messageId);
      this.removedWhileLeased.set(ownerId, removed);
    }
  }

  takeAll(ownerId: string): EphemeralMessageRef[] {
    const existing = this.messages.get(ownerId) ?? [];
    this.messages.delete(ownerId);
    if (existing.length > 0) {
      const leased = this.leased.get(ownerId) ?? new Set<number>();
      for (const message of existing) leased.add(message.messageId);
      this.leased.set(ownerId, leased);
    }
    return existing;
  }

  complete(ownerId: string, messageId: number): void {
    this.finishLease(ownerId, messageId);
  }

  retry(ownerId: string, message: EphemeralMessageRef): void {
    const removed = this.removedWhileLeased.get(ownerId);
    const wasRemoved = removed?.delete(message.messageId) ?? false;
    if (removed?.size === 0) this.removedWhileLeased.delete(ownerId);
    this.removeLease(ownerId, message.messageId);

    const failedAttempts = (message.failedAttempts ?? 0) + 1;
    if (!wasRemoved && failedAttempts < MAX_DELETE_ATTEMPTS) {
      this.add(ownerId, { ...message, failedAttempts });
    }
  }

  private finishLease(ownerId: string, messageId: number): void {
    this.removeLease(ownerId, messageId);
    const removed = this.removedWhileLeased.get(ownerId);
    removed?.delete(messageId);
    if (removed?.size === 0) this.removedWhileLeased.delete(ownerId);
  }

  private removeLease(ownerId: string, messageId: number): void {
    const leased = this.leased.get(ownerId);
    leased?.delete(messageId);
    if (leased?.size === 0) this.leased.delete(ownerId);
  }
}
