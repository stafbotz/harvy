import { createBot } from "./bot/create-bot.js";
import { loadConfig } from "./config.js";
import { EligibilityService } from "./core/eligibility-service.js";
import { TaskService } from "./core/task-service.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileEligibilityRepository } from "./storage/file-eligibility-repository.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";

const config = loadConfig();
const taskRepository = new FileTaskRepository(config.dataFile);
const eligibilityRepository = new FileEligibilityRepository(
  config.eligibilityDataFile,
);
const tasks = new TaskService(taskRepository);
const eligibility = new EligibilityService(eligibilityRepository);
const bot = createBot(config, tasks, eligibility);
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
  allowed_updates: ["message", "callback_query"],
});
