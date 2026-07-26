import { AiClient } from "./ai/client.js";
import { Conversation } from "./ai/conversation.js";
import { createBot } from "./bot/create-bot.js";
import { loadConfig } from "./config.js";
import { HistoryService } from "./core/history-service.js";
import { MemoryService } from "./core/memory-service.js";
import { TaskService } from "./core/task-service.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileHistoryRepository } from "./storage/file-history-repository.js";
import { FileMemoryRepository } from "./storage/file-memory-repository.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";

const config = loadConfig();
const repository = new FileTaskRepository(config.dataFile);
const tasks = new TaskService(repository);

const conversation = new Conversation(
  new AiClient({ baseUrl: config.ai.baseUrl, keys: config.ai.keys }),
  config.ai,
  config.defaultTimezone,
);

const memories = new MemoryService(new FileMemoryRepository(config.memoryFile));

// Peringkasnya memanggil model, tetapi `HistoryService` sendiri tidak tahu
// apa-apa soal itu — ia hanya memegang fungsi. Itu yang membuat aturan
// pemadatan dapat diuji tanpa kunci API.
const history = new HistoryService(
  new FileHistoryRepository(config.historyFile),
  (previousSummary, turns) => conversation.summarize(previousSummary, turns),
);

const bot = createBot(config, tasks, conversation, memories, history);
const stopReminders = startReminderWorker(bot, tasks, config);

// Sedikit perintah saja. Cara utama memakai Harvy adalah menulis biasa.
await bot.api.setMyCommands([
  { command: "tugas", description: "Lihat yang harus dikerjakan" },
  { command: "bantuan", description: "Lihat cara pakai" },
]);

const shutdown = (): void => {
  stopReminders();
  bot.stop();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Harvy Capybara mulai berjalan.");
// Tombol inline adalah satu-satunya cara pengguna menindaklanjuti tugas, jadi
// `callback_query` wajib ikut diminta. Tanpa itu Telegram tidak pernah
// mengirimkannya dan semua tombol mati.
await bot.start({
  allowed_updates: ["message", "callback_query"],
});
