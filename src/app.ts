import { createBot } from "./bot/create-bot.js";
import { loadConfig } from "./config.js";
import { TaskService } from "./core/task-service.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";

const config = loadConfig();
const repository = new FileTaskRepository(config.dataFile);
const tasks = new TaskService(repository);
const bot = createBot(config, tasks);
const stopReminders = startReminderWorker(bot, tasks, config);

await bot.api.setMyCommands([
  { command: "tambah", description: "Catat tugas baru" },
  { command: "tugas", description: "Lihat tugas aktif" },
  { command: "selesai", description: "Tandai tugas selesai" },
  { command: "ingatkan", description: "Pasang pengingat tugas" },
  { command: "bantuan", description: "Lihat panduan" },
]);

const shutdown = (): void => {
  stopReminders();
  bot.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Harvy Capybara mulai berjalan.");
await bot.start({
  allowed_updates: ["message"],
});
