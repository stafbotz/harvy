import type { HarvyBot } from "../bot/create-bot.js";
import type { AppConfig } from "../config.js";
import type { ProfileService } from "../core/profile-service.js";
import type { TaskService } from "../core/task-service.js";
import { isInQuietHours } from "../core/time-policy.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export function startReminderWorker(
  bot: HarvyBot,
  tasks: TaskService,
  profiles: ProfileService,
  config: AppConfig,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.reminder"),
): { stop(): void; drain(): Promise<void> } {
  let stopped = false;
  let running: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    const startedAt = Date.now();
    const reminders = await tasks.dueReminders();
    for (const task of reminders) {
      const context = logger.newTraceContext(
        "system",
        "reminder_delivery",
      );
      await logger.runWithContext(context, async () => {
        try {
          const profile = await profiles.load(task.ownerId);
          if (profile.deletionRequestedAt !== null) return;
          const timeZone = profile.timeZone ?? config.defaultTimezone;
          if (isInQuietHours(new Date(), timeZone, profile.quietHours)) {
            return;
          }
          await bot.sendReminder(task);
          logger.info(
            "reminder_sent",
            "Satu pengingat berhasil dikirim.",
          );
        } catch (error) {
          logger.error(
            "reminder_delivery_failed",
            "Pengingat gagal dikirim.",
            error,
          );
        }
      });
    }
    logger.debug(
      "reminder_cycle_completed",
      "Putaran worker pengingat selesai.",
      {
        candidateCount: reminders.length,
        durationMs: Date.now() - startedAt,
      },
    );
  };

  const trigger = (): void => {
    if (stopped || running) return;
    running = runOnce()
      .catch((error: unknown) => {
        // Kegagalan membaca daftar kandidat tidak boleh menjadi unhandled
        // rejection yang menghentikan seluruh bot. Putaran berikutnya tetap
        // boleh mencoba lagi.
        logger.error(
          "reminder_cycle_failed",
          "Daftar kandidat pengingat gagal dibaca.",
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
