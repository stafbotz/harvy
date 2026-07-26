import { AiClient } from "./ai/client.js";
import { Conversation } from "./ai/conversation.js";
import { createBot } from "./bot/create-bot.js";
import { loadConfig } from "./config.js";
import { HistoryService } from "./core/history-service.js";
import { InsightService } from "./core/insight-service.js";
import { MemoryService } from "./core/memory-service.js";
import { ProfileService } from "./core/profile-service.js";
import { TaskService } from "./core/task-service.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileHistoryRepository } from "./storage/file-history-repository.js";
import { FileProfileRepository } from "./storage/file-profile-repository.js";
import { MarkdownInsightRepository } from "./storage/markdown-insight-repository.js";
import { MarkdownMemoryRepository } from "./storage/markdown-memory-repository.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";

const config = loadConfig();
const repository = new FileTaskRepository(config.dataFile);
const tasks = new TaskService(repository);

const conversation = new Conversation(
  new AiClient({ baseUrl: config.ai.baseUrl, keys: config.ai.keys }),
  config.ai,
  config.defaultTimezone,
);

// Memori berupa berkas Markdown, satu folder per pengguna. Berkas JSON lama
// hanya dibaca sekali sebagai bahan impor, lalu tidak pernah ditulis lagi.
const memories = new MemoryService(
  new MarkdownMemoryRepository(config.memoryFolder, config.memoryFile),
);

// Peringkasnya memanggil model, tetapi `HistoryService` sendiri tidak tahu
// apa-apa soal itu — ia hanya memegang fungsi. Itu yang membuat aturan
// pemadatan dapat diuji tanpa kunci API.
const history = new HistoryService(
  new FileHistoryRepository(config.historyFile),
  (previousSummary, turns) => conversation.summarize(previousSummary, turns),
);

// Status kenalan sengaja terpisah dari memori dan riwayat: menghapus ingatan
// adalah hak pengguna, dan hak itu tidak boleh berubah menjadi perkenalan ulang.
const profiles = new ProfileService(
  new FileProfileRepository(config.profileFile),
);

// Catatan tersembunyi tinggal di folder yang sama dengan memori pengguna,
// supaya "hapus semua data" berarti satu tempat. Konstitusi v0.3 Pasal 4
// nomor 6 mengizinkannya justru dengan syarat batas-batasnya jelas.
const insights = new InsightService(
  new MarkdownInsightRepository(config.memoryFolder),
  (summary, turns) => conversation.readInsight(summary, turns),
);

const bot = createBot(
  config,
  tasks,
  conversation,
  memories,
  history,
  profiles,
  insights,
);
const stopReminders = startReminderWorker(bot, tasks, config);
const SHUTDOWN_GRACE_MS = 60_000;

// Sedikit perintah saja. Cara utama memakai Harvy adalah menulis biasa.
await bot.api.setMyCommands([
  { command: "tugas", description: "Lihat yang harus dikerjakan" },
  { command: "bantuan", description: "Lihat cara pakai" },
]);

let shutdownPromise: Promise<void> | undefined;

const shutdown = (): void => {
  shutdownPromise ??= (async () => {
    const forcedExit = setTimeout(() => {
      console.error(
        "Harvy melewati batas shutdown 60 detik; proses dihentikan paksa.",
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forcedExit.unref();

    try {
      stopReminders();
      await bot.stop();
      await bot.drainPending();
    } finally {
      clearTimeout(forcedExit);
    }
  })();
  void shutdownPromise.catch((error: unknown) => {
    console.error("Harvy gagal berhenti dengan bersih:", error);
  });
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

// `bot.stop()` membuat start selesai sebelum antrean MessageBatcher habis.
// Tahan proses untuk batch, action, dan evaluator utama; ACK callback,
// pembersihan kosmetik, serta pemadatan riwayat mempunyai lifecycle sendiri.
if (shutdownPromise) {
  await shutdownPromise;
}
