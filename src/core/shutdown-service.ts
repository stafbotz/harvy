export interface DrainableWorker {
  stop(): void;
  drain(): Promise<void>;
}

export interface DrainableBot {
  stop(): Promise<void>;
  drainPending(): Promise<void>;
}

/**
 * Menutup sumber pekerjaan lebih dulu, menunggu worker aktif, lalu menguras
 * antrean bot/telemetry sebagai gerbang terakhir.
 *
 * Urutan terakhir penting: worker dapat menulis riwayat atau telemetry sesudah
 * Telegram berhenti menerima update baru.
 */
export async function shutdownGracefully(
  bot: DrainableBot,
  ...workers: DrainableWorker[]
): Promise<void> {
  for (const worker of workers) worker.stop();
  await bot.stop();
  await Promise.all(workers.map((worker) => worker.drain()));
  await bot.drainPending();
}
