import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { TaskService } from "../core/task-service.js";
import { reminderActions } from "../bot/messages.js";

export function startReminderWorker(
  bot: Bot,
  tasks: TaskService,
  config: AppConfig,
): () => void {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const reminders = await tasks.dueReminders();
      for (const task of reminders) {
        try {
          await bot.api.sendMessage(
            task.chatId,
            [`🔔 Pengingat`, "", `• ${task.title}`].join("\n"),
            { reply_markup: reminderActions(task) },
          );
          await tasks.markReminderSent(task);
        } catch (error) {
          console.error(`Pengingat ${task.id} gagal dikirim:`, error);
        }
      }
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), config.reminderIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
