import { Bot, Context, InlineKeyboard } from "grammy";
import type { AppConfig } from "../config.js";
import type { EligibilityService } from "../core/eligibility-service.js";
import { parseAddTask, parseReminder } from "../core/input-parser.js";
import type { TaskService } from "../core/task-service.js";
import type { EligibilityStatus } from "../domain/user-profile.js";
import {
  ELIGIBILITY_PROMPT,
  FIRST_WELCOME_MESSAGE,
  formatTask,
  FREE_TEXT_LIMIT_MESSAGE,
  HELP_MESSAGE,
  INELIGIBLE_MESSAGE,
  RETURNING_WELCOME_MESSAGE,
} from "./messages.js";

export function createBot(
  config: AppConfig,
  tasks: TaskService,
  eligibility: EligibilityService,
): Bot {
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

  bot.use(async (ctx, next) => {
    if (isStartCommand(ctx) || isEligibilityCallback(ctx)) {
      await next();
      return;
    }

    const status = await eligibility.getStatus(userId(ctx));
    if (status === "eligible") {
      await next();
      return;
    }

    await replyForStatus(ctx, status);
  });

  bot.command("start", async (ctx) => {
    const status = await eligibility.getStatus(userId(ctx));

    if (status === "eligible") {
      await ctx.reply(RETURNING_WELCOME_MESSAGE, {
        reply_markup: correctionKeyboard(),
      });
      return;
    }

    await replyForStatus(ctx, status);
  });

  bot.callbackQuery("eligibility:eligible", async (ctx) => {
    await eligibility.setStatus(userId(ctx), "eligible");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(FIRST_WELCOME_MESSAGE, {
      reply_markup: correctionKeyboard(),
    });
  });

  bot.callbackQuery("eligibility:ineligible", async (ctx) => {
    await eligibility.setStatus(userId(ctx), "ineligible");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(INELIGIBLE_MESSAGE, {
      reply_markup: correctionKeyboard(),
    });
  });

  bot.callbackQuery("eligibility:reset", async (ctx) => {
    await eligibility.clearStatus(userId(ctx));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ELIGIBILITY_PROMPT, {
      reply_markup: eligibilityKeyboard(),
    });
  });

  bot.command("bantuan", async (ctx) => {
    await ctx.reply(HELP_MESSAGE);
  });

  bot.command("tambah", async (ctx) => {
    try {
      const parsed = parseAddTask(ctx.match, config.defaultUtcOffset);
      const task = await tasks.create({
        ownerId: userId(ctx),
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
    const activeTasks = await tasks.listActive(userId(ctx));
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

    const completed = await tasks.complete(userId(ctx), id);
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
        userId(ctx),
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
    await ctx.reply(FREE_TEXT_LIMIT_MESSAGE);
  });

  bot.catch(({ error }) => {
    console.error("Telegram update gagal:", error);
  });

  return bot;
}

async function replyForStatus(
  ctx: Context,
  status: EligibilityStatus | null,
): Promise<void> {
  if (status === "ineligible") {
    await ctx.reply(INELIGIBLE_MESSAGE, {
      reply_markup: correctionKeyboard(),
    });
    return;
  }

  await ctx.reply(ELIGIBILITY_PROMPT, {
    reply_markup: eligibilityKeyboard(),
  });
}

function eligibilityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, sudah kelas 8+", "eligibility:eligible")
    .row()
    .text("Belum", "eligibility:ineligible");
}

function correctionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(
    "Koreksi jawaban kelas",
    "eligibility:reset",
  );
}

function isStartCommand(ctx: Context): boolean {
  return /^\/start(?:@\w+)?(?:\s|$)/.test(ctx.message?.text ?? "");
}

function isEligibilityCallback(ctx: Context): boolean {
  return ctx.callbackQuery?.data?.startsWith("eligibility:") ?? false;
}

function userId(ctx: Context): string {
  const id = ctx.from?.id ?? ctx.chat?.id;
  if (id === undefined) {
    throw new Error("Identitas pengguna Telegram tidak tersedia.");
  }
  return String(id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Terjadi kesalahan.";
}
