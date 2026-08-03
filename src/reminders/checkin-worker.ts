import type { HarvyBot } from "../bot/create-bot.js";
import type { AppConfig } from "../config.js";
import type { ProfileService } from "../core/profile-service.js";
import type { SessionService } from "../core/session-service.js";
import type { TelemetryService } from "../core/telemetry-service.js";
import { isInQuietHours } from "../core/time-policy.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export interface WorkerHandle {
  stop(): void;
  drain(): Promise<void>;
}

/**
 * Mengirim check-in satu kali yang sebelumnya dipilih pengguna.
 *
 * Waktu yang jatuh di jam tenang tidak digeser diam-diam. Record tetap
 * menunggu dan akan dikirim pada putaran pertama setelah jam tenang selesai.
 */
export function startCheckInWorker(
  bot: HarvyBot,
  sessions: SessionService,
  profiles: ProfileService,
  telemetry: TelemetryService,
  config: AppConfig,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.checkin"),
): WorkerHandle {
  let stopped = false;
  let running: Promise<void> | null = null;

  const trigger = (): void => {
    if (stopped || running) return;
    running = runCheckInsOnce(
      bot,
      sessions,
      profiles,
      telemetry,
      config,
      new Date(),
      logger,
    )
      .catch((error: unknown) => {
        logger.error(
          "checkin_cycle_failed",
          "Daftar kandidat check-in gagal dibaca.",
          error,
        );
      })
      .finally(() => {
        running = null;
      });
  };

  trigger();
  const timer = setInterval(trigger, config.reminderIntervalMs);
  timer.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
  };
}

export async function runCheckInsOnce(
  bot: Pick<HarvyBot, "sendCheckIn">,
  sessions: SessionService,
  profiles: ProfileService,
  telemetry: Pick<TelemetryService, "event">,
  config: Pick<AppConfig, "defaultTimezone">,
  now = new Date(),
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.checkin"),
): Promise<void> {
  const startedAt = Date.now();
  const candidates = await sessions.dueCheckIns(now);
  for (const candidate of candidates) {
    const context = logger.newTraceContext("system", "checkin_delivery");
    await logger.runWithContext(context, async () => {
      try {
        const profile = await profiles.load(candidate.ownerId);
        if (profile.deletionRequestedAt !== null) return;
        if (await profiles.needsOnboarding(candidate.ownerId)) return;

        const timeZone = profile.timeZone ?? config.defaultTimezone;
        if (isInQuietHours(now, timeZone, profile.quietHours)) return;

        const sent = await bot.sendCheckIn(candidate);
        if (sent) {
          logger.info("checkin_sent", "Satu check-in berhasil dikirim.");
          try {
            await telemetry.event(candidate.ownerId, "checkin_sent");
          } catch (error) {
            logger.warn(
              "checkin_metric_failed",
              "Metrik check-in gagal dicatat.",
              { error },
            );
          }
        }
      } catch (error) {
        logger.error(
          "checkin_delivery_failed",
          "Check-in gagal dikirim.",
          error,
        );
      }
    });
  }
  logger.debug(
    "checkin_cycle_completed",
    "Putaran worker check-in selesai.",
    {
      candidateCount: candidates.length,
      durationMs: Date.now() - startedAt,
    },
  );
}
