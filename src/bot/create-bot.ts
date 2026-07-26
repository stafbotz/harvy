import { Bot, type Context, type InlineKeyboard } from "grammy";
import type { HarvyContext } from "../ai/context.js";
import type { Conversation } from "../ai/conversation.js";
import type {
  ExtractedMemory,
  ExtractedTask,
  Understanding,
} from "../ai/understand.js";
import type { AppConfig } from "../config.js";
import type { HistoryService } from "../core/history-service.js";
import { isSensitiveKind } from "../core/memory-policy.js";
import type { MemoryService } from "../core/memory-service.js";
import type { TaskService } from "../core/task-service.js";
import type { StudentTask } from "../domain/task.js";
import {
  confirmActions,
  formatMemories,
  formatTask,
  HELP_MESSAGE,
  memoryConsentActions,
  memoryListActions,
  memorySavedActions,
  memorySavedNote,
  memoryWipeConfirmActions,
  taskActions,
  taskListActions,
  understandingNote,
} from "./messages.js";
import { PendingStore } from "./pending.js";

/** Jarak bawaan antara pengingat dan tenggat. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;

const AI_FAILURE_MESSAGE = [
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku bermasalah.",
  "Coba kirim lagi sebentar lagi, ya.",
].join("\n");

export function createBot(
  config: AppConfig,
  tasks: TaskService,
  conversation: Conversation,
  memories: MemoryService,
  history: HistoryService,
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const pending = new PendingStore();

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private") {
      await next();
      return;
    }

    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply(
        "Harvy versi ini khusus chat pribadi. Kirim pesan langsung ke akun bot, ya.",
      );
    }
  });

  bot.command("start", async (ctx) => {
    pending.clear(ownerOf(ctx));
    await ctx.reply(
      [
        "Hai, aku Harvy 👋",
        "Aku bantu merapikan apa yang harus kamu kerjakan, dan siap dengerin",
        "kalau lagi berat. Keputusannya tetap punyamu.",
        "",
        HELP_MESSAGE,
      ].join("\n"),
    );
  });

  bot.command("bantuan", async (ctx) => {
    pending.clear(ownerOf(ctx));
    await ctx.reply(HELP_MESSAGE);
  });

  bot.command("tugas", async (ctx) => {
    const ownerId = ownerOf(ctx);
    pending.clear(ownerId);
    await sendTaskList(ctx, ownerId);
  });

  bot.on("message:text", async (ctx) => {
    const ownerId = ownerOf(ctx);
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      await ctx.reply(
        ["Aku belum punya perintah itu.", "", HELP_MESSAGE].join("\n"),
      );
      return;
    }

    await ctx.replyWithChatAction("typing");

    const waiting = pending.peek(ownerId);
    if (waiting?.kind === "edit-due") {
      await applyNewDue(ctx, ownerId, waiting.taskId, text);
      return;
    }

    await handleFreeText(ctx, ownerId, text);
  });

  bot.on("callback_query:data", async (ctx) => {
    const ownerId = String(ctx.from.id);
    const [action = "", target = ""] = ctx.callbackQuery.data.split(":");

    try {
      await routeAction(ctx, ownerId, action, target);
    } catch (error) {
      console.error("Tombol gagal diproses:", error);
      await ctx.answerCallbackQuery({ text: "Ada yang gagal. Coba lagi, ya." });
    }
  });

  bot.catch(({ error }) => {
    console.error("Telegram update gagal:", error);
  });

  return bot;

  /**
   * Setiap pesan bebas dibaca model lebih dulu. Tugas hanya dicatat ketika
   * maksudnya memang mencatat pekerjaan; selebihnya Harvy menjawab sebagai
   * teman bicara dan hanya *menawarkan* pencatatan.
   */
  async function handleFreeText(
    ctx: Context,
    ownerId: string,
    text: string,
  ): Promise<void> {
    // Konteks disusun sebelum pesan ini ikut tercatat, supaya giliran yang
    // sedang ditangani tidak muncul dua kali di dalam promptnya sendiri.
    const context = await contextFor(ownerId, text);

    let understanding: Understanding | null;

    try {
      understanding = await conversation.understand(text, context);
    } catch (error) {
      console.error("Pemahaman pesan gagal:", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      return;
    }

    await history.append(ownerId, "user", text);

    if (!understanding) {
      await ctx.reply(
        "Aku belum menangkap maksudnya. Coba tulis ulang dengan kalimat lain, ya.",
      );
      return;
    }

    if (understanding.intent === "memory") {
      pending.clear(ownerId);
      await showMemories(ctx, ownerId);
      return;
    }

    if (understanding.intent === "task" && understanding.task) {
      pending.clear(ownerId);
      await saveTask(ctx, ownerId, understanding.task);
      await offerSensitive(ctx, ownerId, understanding.memories);
      return;
    }

    let reply: string;
    try {
      reply = await conversation.reply(text, understanding, context);
    } catch (error) {
      console.error("Balasan model gagal:", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      return;
    }

    await ctx.reply(reply);
    await history.append(ownerId, "harvy", reply);
    await memories.markUsed(context.memories);

    // Pekerjaan yang tersirat di balik cerita ditawarkan, tidak dicatat diam-diam.
    if (understanding.task) {
      pending.set(ownerId, { kind: "confirm-task", task: understanding.task });
      await ctx.reply(
        `Mau aku catat “${understanding.task.title}” biar nggak perlu kamu ingat-ingat?`,
        { reply_markup: confirmActions() },
      );
      await absorbMemories(ctx, ownerId, understanding.memories);
      return;
    }

    await offerSensitive(ctx, ownerId, understanding.memories);
  }

  async function contextFor(
    ownerId: string,
    message: string,
  ): Promise<HarvyContext> {
    const [relevant, conversationContext] = await Promise.all([
      memories.relevantTo(ownerId, message),
      history.context(ownerId),
    ]);

    return {
      summary: conversationContext.summary,
      turns: conversationContext.turns,
      memories: relevant,
    };
  }

  /**
   * Menyimpan memori biasa dan mengembalikan yang sensitif untuk ditawarkan.
   *
   * Yang biasa disimpan tanpa bertanya, tetapi tidak diam-diam: setiap
   * penyimpanan diumumkan berikut tombol Lupakan, sesuai Pasal 4 nomor 2. Yang
   * sensitif tidak pernah lewat jalur ini — Pasal 4 nomor 3.
   */
  async function absorbMemories(
    ctx: Context,
    ownerId: string,
    items: ExtractedMemory[],
  ): Promise<ExtractedMemory | null> {
    let sensitive: ExtractedMemory | null = null;

    for (const item of items) {
      if (isSensitiveKind(item.kind)) {
        sensitive ??= item;
        continue;
      }

      const saved = await memories.remember({
        ownerId,
        kind: item.kind,
        content: item.content,
      });
      if (!saved) continue;

      await ctx.reply(memorySavedNote(saved), {
        reply_markup: memorySavedActions(saved),
      });
    }

    return sensitive;
  }

  /**
   * Hanya satu langkah tertunda yang dapat hidup sekaligus per pengguna.
   *
   * Ketika sebuah pesan melahirkan tawaran tugas sekaligus memori sensitif,
   * tawaran tugas menang dan memorinya dilewatkan. Menumpuk dua pertanyaan
   * sekaligus membuat pengguna harus menjawab kuis, dan Pasal 3.11 meminta
   * pilihan yang tidak berlebihan.
   */
  async function offerSensitive(
    ctx: Context,
    ownerId: string,
    items: ExtractedMemory[],
  ): Promise<void> {
    const sensitive = await absorbMemories(ctx, ownerId, items);

    if (!sensitive) {
      pending.clear(ownerId);
      return;
    }

    pending.set(ownerId, { kind: "confirm-memory", memory: sensitive });
    await ctx.reply(
      [
        `Boleh aku ingat ini? “${sensitive.content}”`,
        "",
        "Kalau iya, aku tidak perlu kamu ceritakan ulang nanti. Kalau tidak,",
        "aku tetap mendengarkan hari ini dan tidak menyimpannya.",
      ].join("\n"),
      { reply_markup: memoryConsentActions() },
    );
  }

  async function showMemories(ctx: Context, ownerId: string): Promise<void> {
    const items = await memories.list(ownerId);
    const text = formatMemories(items);

    await ctx.reply(
      text,
      items.length > 0 ? { reply_markup: memoryListActions(items) } : {},
    );
    await history.append(ownerId, "harvy", text);
  }

  async function saveTask(
    ctx: Context,
    ownerId: string,
    extracted: ExtractedTask,
  ): Promise<void> {
    const task = await tasks.create({
      ownerId,
      chatId: String(ctx.chat?.id ?? ownerId),
      title: extracted.title,
      dueAt: extracted.dueAt,
      remindAt: extracted.remindAt,
      importance: extracted.importance,
    });

    await ctx.reply(
      [
        "Sudah aku catat.",
        "",
        formatTask(task, config.defaultTimezone),
        understandingNote(task),
      ].join("\n"),
      { reply_markup: taskActions(task) },
    );
  }

  async function applyNewDue(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
  ): Promise<void> {
    let understanding: Understanding | null;

    try {
      understanding = await conversation.understand(`ubah tenggat jadi ${text}`);
    } catch (error) {
      console.error("Pembacaan tenggat baru gagal:", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      return;
    }

    const dueAt = understanding?.task?.dueAt ?? null;
    if (!dueAt) {
      await ctx.reply(
        "Aku belum menangkap waktunya. Coba tulis seperti “besok jam 7 malam” atau “senin depan”.",
      );
      return;
    }

    pending.clear(ownerId);
    const updated = await tasks.setDue(ownerId, taskId, dueAt);

    if (!updated) {
      await ctx.reply("Tugas itu sudah tidak ada.");
      return;
    }

    await ctx.reply(
      [
        "Tenggatnya sudah aku ubah.",
        "",
        formatTask(updated, config.defaultTimezone),
      ].join("\n"),
      { reply_markup: taskActions(updated) },
    );
  }

  async function routeAction(
    ctx: Context,
    ownerId: string,
    action: string,
    target: string,
  ): Promise<void> {
    switch (action) {
      case "save": {
        const waiting = pending.peek(ownerId);
        pending.clear(ownerId);

        if (waiting?.kind !== "confirm-task") {
          await ctx.answerCallbackQuery({ text: "Sudah tidak berlaku." });
          return;
        }

        await ctx.answerCallbackQuery();
        await dropKeyboard(ctx);
        await saveTask(ctx, ownerId, waiting.task);
        return;
      }

      case "nosave": {
        pending.clear(ownerId);
        await ctx.answerCallbackQuery({ text: "Oke, nggak aku catat." });
        await safeEdit(ctx, "Oke, nggak aku catat.");
        return;
      }

      case "done": {
        const completed = await tasks.complete(ownerId, target);
        await ctx.answerCallbackQuery({
          text: completed ? "Mantap, selesai ✓" : "Tugas itu sudah tidak ada.",
        });
        await refreshAfterChange(ctx, ownerId, completed?.title);
        return;
      }

      case "drop": {
        const removed = await tasks.remove(ownerId, target);
        await ctx.answerCallbackQuery({
          text: removed ? "Dibatalkan." : "Tugas itu sudah tidak ada.",
        });
        await refreshAfterChange(ctx, ownerId);
        return;
      }

      case "edit": {
        pending.set(ownerId, { kind: "edit-due", taskId: target });
        await ctx.answerCallbackQuery();
        await ctx.reply(
          "Mau diubah jadi kapan? Tulis saja, misalnya “besok jam 7 malam” atau “senin depan”.",
        );
        return;
      }

      case "remind":
      case "snooze": {
        await scheduleReminder(ctx, ownerId, target, action);
        return;
      }

      case "memsave": {
        const waiting = pending.peek(ownerId);
        pending.clear(ownerId);

        if (waiting?.kind !== "confirm-memory") {
          await ctx.answerCallbackQuery({ text: "Sudah tidak berlaku." });
          return;
        }

        const saved = await memories.remember({
          ownerId,
          kind: waiting.memory.kind,
          content: waiting.memory.content,
        });

        await ctx.answerCallbackQuery({ text: "Oke, aku ingat." });
        await safeEdit(
          ctx,
          saved
            ? `📎 Aku ingat ini: ${saved.content}`
            : "Ternyata sudah aku ingat sebelumnya.",
          saved ? memorySavedActions(saved) : undefined,
        );
        return;
      }

      case "memskip": {
        pending.clear(ownerId);
        await ctx.answerCallbackQuery({ text: "Oke, nggak aku simpan." });
        await safeEdit(
          ctx,
          "Oke, itu nggak aku simpan. Aku tetap di sini kalau kamu mau cerita.",
        );
        return;
      }

      case "memforget": {
        const forgotten = await memories.forget(ownerId, target);
        await ctx.answerCallbackQuery({
          text: forgotten ? "Sudah aku lupakan." : "Itu sudah tidak ada.",
        });
        await refreshMemories(ctx, ownerId, forgotten?.content);
        return;
      }

      case "memall": {
        await ctx.answerCallbackQuery();
        await ctx.reply(
          [
            "Yakin? Aku akan melupakan semua catatan tentang kamu sekaligus",
            "seluruh riwayat obrolan kita. Ini tidak bisa dibatalkan.",
          ].join("\n"),
          { reply_markup: memoryWipeConfirmActions() },
        );
        return;
      }

      case "memallyes": {
        const removed = await memories.forgetAll(ownerId);
        await history.forget(ownerId);
        pending.clear(ownerId);

        await ctx.answerCallbackQuery({ text: "Sudah bersih." });
        await safeEdit(
          ctx,
          [
            `Sudah aku lupakan semuanya — ${removed} catatan dan seluruh riwayat obrolan kita.`,
            "",
            "Tugasmu tidak ikut terhapus. Kalau mau itu juga hilang, batalkan",
            "satu per satu lewat daftarnya.",
          ].join("\n"),
        );
        return;
      }

      case "memallno": {
        await ctx.answerCallbackQuery({ text: "Nggak jadi." });
        await safeEdit(ctx, "Nggak jadi. Semuanya masih aku ingat.");
        return;
      }

      default:
        await ctx.answerCallbackQuery();
    }
  }

  async function refreshMemories(
    ctx: Context,
    ownerId: string,
    forgotten?: string,
  ): Promise<void> {
    const remaining = await memories.list(ownerId);
    const heading = forgotten
      ? `Sudah aku lupakan: ${forgotten}`
      : "Sudah aku lupakan.";

    if (remaining.length === 0) {
      await safeEdit(ctx, `${heading}\n\nSekarang tidak ada lagi yang aku ingat tentang kamu.`);
      return;
    }

    await safeEdit(
      ctx,
      [heading, "", formatMemories(remaining)].join("\n"),
      memoryListActions(remaining),
    );
  }

  async function scheduleReminder(
    ctx: Context,
    ownerId: string,
    taskId: string,
    action: "remind" | "snooze",
  ): Promise<void> {
    const task = await tasks.find(ownerId, taskId);
    if (!task || task.status === "completed") {
      await ctx.answerCallbackQuery({ text: "Tugas itu sudah tidak ada." });
      return;
    }

    const now = Date.now();
    const target =
      action === "snooze"
        ? new Date(now + REMINDER_LEAD_MS)
        : dueMinusLead(task);

    if (!target || target.getTime() <= now) {
      await ctx.answerCallbackQuery({
        text: "Tenggatnya sudah terlalu dekat untuk diingatkan lebih awal.",
      });
      return;
    }

    const updated = await tasks.setReminder(ownerId, taskId, target);
    await ctx.answerCallbackQuery({ text: "Pengingat dipasang 🔔" });

    if (updated) {
      await ctx.reply(
        [
          "Oke, nanti aku ingatkan.",
          "",
          formatTask(updated, config.defaultTimezone),
        ].join("\n"),
      );
    }
  }

  async function refreshAfterChange(
    ctx: Context,
    ownerId: string,
    completedTitle?: string,
  ): Promise<void> {
    const remaining = await tasks.listActive(ownerId);
    const heading = completedTitle
      ? `Selesai ✓ ${completedTitle}`
      : "Sudah aku batalkan.";

    if (remaining.length === 0) {
      await safeEdit(ctx, `${heading}\n\nSemua beres. Nikmati waktumu 🌿`);
      return;
    }

    await safeEdit(
      ctx,
      [
        heading,
        "",
        "Sisanya:",
        "",
        ...remaining.map((task) => formatTask(task, config.defaultTimezone)),
      ].join("\n"),
      taskListActions(remaining),
    );
  }

  async function sendTaskList(ctx: Context, ownerId: string): Promise<void> {
    const active = await tasks.listActive(ownerId);

    if (active.length === 0) {
      await ctx.reply(
        "Belum ada yang perlu dikerjakan. Tulis saja kalau ada yang muncul.",
      );
      return;
    }

    await ctx.reply(
      [
        "Ini urutan yang aku sarankan, dari yang paling mendesak:",
        "",
        ...active.map((task) => formatTask(task, config.defaultTimezone)),
      ].join("\n"),
      { reply_markup: taskListActions(active) },
    );
  }
}

function ownerOf(ctx: Context): string {
  return String(ctx.from?.id ?? ctx.chat?.id ?? "tidak-dikenal");
}

function dueMinusLead(task: StudentTask): Date | null {
  if (!task.dueAt) return null;
  return new Date(new Date(task.dueAt).getTime() - REMINDER_LEAD_MS);
}

async function dropKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // Pesan mungkin sudah berubah di sisi Telegram; bukan kegagalan nyata.
  }
}

async function safeEdit(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const options = keyboard ? { reply_markup: keyboard } : {};

  try {
    await ctx.editMessageText(text, options);
  } catch {
    await ctx.reply(text, options);
  }
}
