export interface ActiveRunIngressReservation {
  runId: string;
  token: number;
}

/**
 * Barrier proses-lokal antara ingress reply-to-Anchor dan commit hasil run.
 *
 * Ia sengaja tidak menyimpan isi pesan. Adapter memasang reservation ketika
 * transport sudah membuktikan quote exact ke Run Anchor, lalu baru menjalankan
 * compiler dan safety. Worker menunggu reservation selesai sebelum commit;
 * bila pesan diterima sebagai koreksi, revision durable membuat hasil lama
 * stale. Bila pesan ditolak atau gagal diproses, release di `finally` membuat
 * pekerjaan lama tidak menggantung.
 */
export class ActiveRunIngressBarrier {
  private readonly pending = new Map<string, Set<number>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private nextToken = 1;

  reserve(runId: string): ActiveRunIngressReservation {
    const clean = runId.trim();
    if (!clean) throw new Error("Run ingress barrier memerlukan runId.");
    const token = this.nextToken;
    this.nextToken += 1;
    const tokens = this.pending.get(clean) ?? new Set<number>();
    tokens.add(token);
    this.pending.set(clean, tokens);
    return Object.freeze({ runId: clean, token });
  }

  release(reservation: ActiveRunIngressReservation): void {
    const tokens = this.pending.get(reservation.runId);
    if (!tokens || !tokens.delete(reservation.token)) return;
    if (tokens.size > 0) return;
    this.pending.delete(reservation.runId);
    this.resolveWaiters(reservation.runId);
  }

  async waitForIdle(runId: string): Promise<void> {
    while ((this.pending.get(runId)?.size ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const callbacks = this.waiters.get(runId) ?? new Set<() => void>();
        callbacks.add(resolve);
        this.waiters.set(runId, callbacks);
        // Reservation dapat selesai tepat sebelum callback dipasang.
        if ((this.pending.get(runId)?.size ?? 0) === 0) {
          callbacks.delete(resolve);
          if (callbacks.size === 0) this.waiters.delete(runId);
          resolve();
        }
      });
    }
  }

  releaseAll(): void {
    const runIds = new Set([...this.pending.keys(), ...this.waiters.keys()]);
    this.pending.clear();
    for (const runId of runIds) this.resolveWaiters(runId);
  }

  private resolveWaiters(runId: string): void {
    const callbacks = this.waiters.get(runId);
    if (!callbacks) return;
    this.waiters.delete(runId);
    for (const resolve of callbacks) resolve();
  }
}
