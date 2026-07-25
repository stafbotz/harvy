import { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import {
  parseAddTask,
  parseReminder,
} from "../core/input-parser.js";
import type { TaskService } from "../core/task-service.js";
import { formatTask, HELP_MESSAGE } from "./messages.js";

export function createBot(config: AppConfig, tasks: TaskService): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private") {
      await next();
      return;
    }

    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply(
        "Harvy Capybara versi ini khusus chat pribadi. Kirim pesan langsung ke akun bot, ya.",
      );
    }
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Hai, aku Harvy 👋",
        "Aku bantu kamu mencatat dan merapikan tugas tanpa mengambil alih keputusanmu.",
        "",
        HELP_MESSAGE,
      ].join("\n"),
    );
  });

  bot.command("bantuan", async (ctx) => {
    await ctx.reply(HELP_MESSAGE);
  });

  bot.command("tambah", async (ctx) => {
    try {
      const parsed = parseAddTask(ctx.match, config.defaultUtcOffset);
      const task = await tasks.create({
        ownerId: String(ctx.from?.id ?? ctx.chat.id),
        chatId: String(ctx.chat.id),
        ...parsed,
      });

      await ctx.reply(
        [
          "Tugas tersimpan.",
          formatTask(task, config.defaultTimezone),
          "",
          `Jika perlu, pasang pengingat dengan /ingatkan ${task.id} | YYYY-MM-DD HH:mm`,
        ].join("\n"),
      );
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  });

  bot.command("tugas", async (ctx) => {
    const activeTasks = await tasks.listActive(
      String(ctx.from?.id ?? ctx.chat.id),
    );
    if (activeTasks.length === 0) {
      await ctx.reply("Belum ada tugas aktif. Tambahkan dengan /tambah.");
      return;
    }

    await ctx.reply(
      [
        "Urutan tugasmu sekarang:",
        "",
        ...activeTasks.map((task) =>
          formatTask(task, config.defaultTimezone),
        ),
      ].join("\n"),
    );
  });

  bot.command("selesai", async (ctx) => {
    const id = ctx.match.trim();
    if (!id) {
      await ctx.reply("Gunakan /selesai ID.");
      return;
    }

    const completed = await tasks.complete(
      String(ctx.from?.id ?? ctx.chat.id),
      id,
    );
    if (!completed) {
      await ctx.reply("Tugas aktif dengan ID itu tidak ditemukan.");
      return;
    }

    await ctx.reply(`Selesai ✓ ${completed.title}`);
  });

  bot.command("ingatkan", async (ctx) => {
    try {
      const { id, reminderAt } = parseReminder(
        ctx.match,
        config.defaultUtcOffset,
      );
      if (reminderAt.getTime() <= Date.now()) {
        await ctx.reply("Waktu pengingat harus berada di masa depan.");
        return;
      }

      const updated = await tasks.setReminder(
        String(ctx.from?.id ?? ctx.chat.id),
        id,
        reminderAt,
      );
      if (!updated) {
        await ctx.reply("Tugas aktif dengan ID itu tidak ditemukan.");
        return;
      }

      await ctx.reply(
        [
          "Pengingat dipasang dengan izinmu.",
          formatTask(updated, config.defaultTimezone),
        ].join("\n"),
      );
    } catch (error) {
      await ctx.reply(errorMessage(error));
    }
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply(
      "Aku belum memahami pesan bebas pada versi ini. Gunakan /bantuan untuk melihat perintah.",
    );
  });

  bot.catch(({ error }) => {
    console.error("Telegram update gagal:", error);
  });

  return bot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terjadi kesalahan.";
}
