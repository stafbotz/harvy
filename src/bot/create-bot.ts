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
import { isSensitiveMemory } from "../core/memory-policy.js";
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
  splitReplyBubbles,
  taskActions,
  taskListActions,
  understandingNote,
} from "./messages.js";
import { EphemeralMessageStore } from "./ephemeral-message-store.js";
import { MessageBatcher } from "./message-batcher.js";
import { PendingStore } from "./pending.js";
import {
  immediateUnderstandingRoute,
  taskToOffer,
} from "./understanding-route.js";

/** Jarak bawaan antara pengingat dan tenggat. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;

const AI_FAILURE_MESSAGE = [
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku bermasalah.",
  "Coba kirim lagi sebentar lagi, ya.",
].join("\n");

export type HarvyBot = Bot & {
  drainPending: () => Promise<void>;
};

export interface TypingContext {
  replyWithChatAction: (action: "typing") => Promise<unknown>;
}

export async function bestEffortTyping(ctx: TypingContext): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch (error) {
    // Indikator ini kosmetik. Kegagalan Telegram tidak boleh membuang pesan
    // pengguna atau menghentikan giliran percakapan.
    console.warn("Indikator mengetik gagal dikirim:", error);
  }
}

export function createBot(
  config: AppConfig,
  tasks: TaskService,
  conversation: Conversation,
  memories: MemoryService,
  history: HistoryService,
): HarvyBot {
  const bot = new Bot(config.telegramBotToken);
  const pending = new PendingStore();
  const memoryNotices = new EphemeralMessageStore();
  const messageBatcher = new MessageBatcher<Context>(
    (text) => conversation.classifyTurnBoundary(text),
    (ownerId, batch) => handleFreeText(batch.carrier, ownerId, batch.text),
  );

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

  bot.command("start", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /start gagal:",
      async () => {
        pending.clear(ownerId);
        await dismissMemoryNotices(ownerId);
        await ctx.reply(
          [
            "Hai, aku Harvy 👋",
            "Aku bantu merapikan apa yang harus kamu kerjakan, dan siap dengerin",
            "kalau lagi berat. Keputusannya tetap punyamu.",
            "",
            HELP_MESSAGE,
          ].join("\n"),
        );
      },
    );
  });

  bot.command("bantuan", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /bantuan gagal:",
      async () => {
        pending.clear(ownerId);
        await dismissMemoryNotices(ownerId);
        await ctx.reply(HELP_MESSAGE);
      },
    );
  });

  bot.command("tugas", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Perintah /tugas gagal:",
      async () => {
        pending.clear(ownerId);
        await dismissMemoryNotices(ownerId);
        await sendTaskList(ctx, ownerId);
      },
    );
  });

  bot.on("message:text", (ctx) => {
    const ownerId = ownerOf(ctx);
    const text = ctx.message.text.trim();

    // Referensi diambil sekarang; panggilan API penghapusannya tidak perlu
    // menahan long-polling Telegram.
    void dismissMemoryNotices(ownerId);

    if (text.startsWith("/")) {
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Perintah tak dikenal gagal ditanggapi:",
        async () => {
          await dismissMemoryNotices(ownerId);
          await ctx.reply(
            ["Aku belum punya perintah itu.", "", HELP_MESSAGE].join("\n"),
          );
        },
      );
      return;
    }

    messageBatcher.enqueue(ownerId, text, ctx);
  });

  bot.on("callback_query:data", (ctx) => {
    const ownerId = String(ctx.from.id);
    const [action = "", target = ""] = ctx.callbackQuery.data.split(":");

    // Tutup spinner segera. Tindakannya tetap mengantre di belakang chat milik
    // pengguna ini, tetapi handler update kembali agar polling pengguna lain
    // tidak ikut tertahan oleh generasi model yang panjang.
    void ctx.answerCallbackQuery().catch((error: unknown) => {
      console.error("Callback Telegram gagal diakui:", error);
    });
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Tombol gagal diproses:",
      () => routeAction(ctx, ownerId, action, target),
    );
  });

  bot.catch(({ error }) => {
    console.error("Telegram update gagal:", error);
  });

  return Object.assign(bot, {
    drainPending: () => messageBatcher.drainAll(),
  });

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
    // Bubble ini mungkin tiba ketika batch sebelumnya masih membuat notifikasi
    // memori. Ulangi pembersihan setelah chain sampai pada giliran ini.
    await dismissMemoryNotices(ownerId);

    // Pending diperiksa saat batch mendapat gilirannya, bukan ketika update
    // masuk. Callback Ubah tenggat mungkin masih mengantre di belakang balasan
    // lama ketika pengguna sudah mengetik tanggal barunya.
    const waiting = pending.peek(ownerId);
    if (waiting?.kind === "edit-due") {
      await bestEffortTyping(ctx);
      await applyNewDue(ctx, ownerId, waiting.taskId, text);
      return;
    }

    // Indikator muncul ketika Harvy benar-benar mulai menangani satu giliran,
    // bukan pada setiap bubble saat ia masih menyimak.
    await bestEffortTyping(ctx);

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

    try {
      if (!understanding) {
        await ctx.reply(
          "Aku belum menangkap maksudnya. Coba tulis ulang dengan kalimat lain, ya.",
        );
        return;
      }

      const immediateRoute = immediateUnderstandingRoute(understanding);

      if (immediateRoute.kind === "memory-control") {
        pending.clear(ownerId);
        await showMemories(ctx, ownerId);
        return;
      }

      if (immediateRoute.kind === "save-task") {
        pending.clear(ownerId);
        await saveTask(ctx, ownerId, immediateRoute.task);
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

      const bubbles = splitReplyBubbles(reply);
      for (const bubble of bubbles) {
        await ctx.reply(bubble);
      }
      // Riwayat menyimpan satu balasan logis asli. Batas ukuran Telegram boleh
      // memotong sebuah blok kode di tengah; menggabungkan bubble dengan baris
      // baru akan mengubah kode yang sebenarnya ditulis model.
      await history.append(ownerId, "harvy", reply.trim());
      await memories.markUsed(context.memories);

      // Pekerjaan yang tersirat di balik cerita ditawarkan, tidak dicatat diam-diam.
      const offeredTask = taskToOffer(understanding);
      if (offeredTask) {
        pending.set(ownerId, { kind: "confirm-task", task: offeredTask });
        const offerText =
          `Mau aku catat “${offeredTask.title}” biar nggak perlu kamu ingat-ingat?`;
        await ctx.reply(
          offerText,
          { reply_markup: confirmActions() },
        );
        await history.append(ownerId, "harvy", offerText);
        await absorbMemories(ctx, ownerId, understanding.memories);
        return;
      }

      await offerSensitive(ctx, ownerId, understanding.memories);
    } finally {
      // Model peringkas berjalan setelah balasan utama selesai. Tidak di-await:
      // kegagalan atau timeout-nya tidak boleh membuat pengguna menunggu.
      void history.compact(ownerId);
    }
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
   * penyimpanan diumumkan berikut tombol Oke/Lupakan, sesuai Pasal 4 nomor 2.
   * Yang sensitif tidak pernah lewat jalur ini — Pasal 4 nomor 3.
   */
  async function absorbMemories(
    ctx: Context,
    ownerId: string,
    items: ExtractedMemory[],
  ): Promise<ExtractedMemory | null> {
    let sensitive: ExtractedMemory | null = null;

    for (const item of items) {
      if (isSensitiveMemory(item)) {
        sensitive ??= item;
        continue;
      }

      const saved = await memories.remember({
        ownerId,
        kind: item.kind,
        content: item.content,
      });
      if (!saved) continue;

      const notice = await ctx.reply(memorySavedNote(saved), {
        reply_markup: memorySavedActions(saved),
      });
      memoryNotices.add(ownerId, {
        chatId: notice.chat.id,
        messageId: notice.message_id,
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

    const response = [
      "Sudah aku catat.",
      "",
      formatTask(task, config.defaultTimezone),
      understandingNote(task),
    ].join("\n");

    await ctx.reply(
      response,
      { reply_markup: taskActions(task) },
    );
    await history.append(ownerId, "harvy", response);
  }

  async function applyNewDue(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
  ): Promise<void> {
    await history.append(ownerId, "user", text);

    let dueAt: Date | null;

    try {
      dueAt = await conversation.understandDueDate(text);
    } catch (error) {
      console.error("Pembacaan tenggat baru gagal:", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      return;
    }

    if (!dueAt) {
      const response =
        "Aku belum menangkap waktunya. Coba tulis seperti “besok jam 7 malam” atau “senin depan”.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    pending.clear(ownerId);
    const updated = await tasks.setDue(ownerId, taskId, dueAt);

    if (!updated) {
      const response = "Tugas itu sudah tidak ada.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    const response = [
      "Tenggatnya sudah aku ubah.",
      "",
      formatTask(updated, config.defaultTimezone),
    ].join("\n");
    await ctx.reply(
      response,
      { reply_markup: taskActions(updated) },
    );
    await history.append(ownerId, "harvy", response);
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
          await safeEdit(ctx, "Tombol ini sudah tidak berlaku.");
          return;
        }

        await dropKeyboard(ctx);
        await saveTask(ctx, ownerId, waiting.task);
        return;
      }

      case "nosave": {
        pending.clear(ownerId);
        await safeEdit(ctx, "Oke, nggak aku catat.");
        return;
      }

      case "done": {
        const completed = await tasks.complete(ownerId, target);
        if (!completed) {
          await safeEdit(ctx, "Tugas itu sudah tidak ada.");
          return;
        }
        await refreshAfterChange(ctx, ownerId, completed.title);
        return;
      }

      case "drop": {
        const removed = await tasks.remove(ownerId, target);
        if (!removed) {
          await safeEdit(ctx, "Tugas itu sudah tidak ada.");
          return;
        }
        await refreshAfterChange(ctx, ownerId);
        return;
      }

      case "edit": {
        pending.set(ownerId, { kind: "edit-due", taskId: target });
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
          await safeEdit(ctx, "Tombol ini sudah tidak berlaku.");
          return;
        }

        const saved = await memories.remember({
          ownerId,
          kind: waiting.memory.kind,
          content: waiting.memory.content,
        });

        await safeEdit(
          ctx,
          saved
            ? `📎 Aku ingat ini: ${saved.content}`
            : "Ternyata sudah aku ingat sebelumnya.",
          saved ? memorySavedActions(saved) : undefined,
        );
        if (saved) trackCurrentMemoryNotice(ctx, ownerId);
        return;
      }

      case "memack": {
        forgetCurrentMemoryNotice(ctx, ownerId);
        await safeDelete(ctx);
        return;
      }

      case "memskip": {
        pending.clear(ownerId);
        await safeEdit(
          ctx,
          "Oke, itu nggak aku simpan. Aku tetap di sini kalau kamu mau cerita.",
        );
        return;
      }

      case "memforget": {
        forgetCurrentMemoryNotice(ctx, ownerId);
        const forgotten = await memories.forget(ownerId, target);
        await refreshMemories(
          ctx,
          ownerId,
          forgotten?.content,
          forgotten === null,
        );
        return;
      }

      case "memall": {
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
        await safeEdit(ctx, "Nggak jadi. Semuanya masih aku ingat.");
        return;
      }

      default:
        return;
    }
  }

  async function refreshMemories(
    ctx: Context,
    ownerId: string,
    forgotten?: string,
    missing = false,
  ): Promise<void> {
    const remaining = await memories.list(ownerId);
    const heading = missing
      ? "Itu sudah tidak ada."
      : forgotten
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
      await safeEdit(ctx, "Tugas itu sudah tidak ada.");
      return;
    }

    const now = Date.now();
    const target =
      action === "snooze"
        ? new Date(now + REMINDER_LEAD_MS)
        : dueMinusLead(task);

    if (!target || target.getTime() <= now) {
      await ctx.reply(
        "Tenggatnya sudah terlalu dekat untuk diingatkan lebih awal.",
      );
      return;
    }

    const updated = await tasks.setReminder(ownerId, taskId, target);

    if (updated) {
      await ctx.reply(
        [
          "Oke, nanti aku ingatkan.",
          "",
          formatTask(updated, config.defaultTimezone),
        ].join("\n"),
      );
      return;
    }
    await safeEdit(ctx, "Tugas itu sudah tidak ada.");
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

  async function dismissMemoryNotices(ownerId: string): Promise<void> {
    const notices = memoryNotices.takeAll(ownerId);
    const failed = await Promise.all(
      notices.map(async (notice) => {
        try {
          await bot.api.deleteMessage(notice.chatId, notice.messageId);
          memoryNotices.complete(ownerId, notice.messageId);
          return null;
        } catch {
          return notice;
        }
      }),
    );
    for (const notice of failed) {
      // Error Telegram dapat bersifat sementara. Simpan referensinya agar chat
      // berikutnya mencoba lagi, kecuali pengguna sudah menekan Oke/Lupakan
      // ketika request delete masih berjalan.
      if (notice) memoryNotices.retry(ownerId, notice);
    }
  }

  function trackCurrentMemoryNotice(ctx: Context, ownerId: string): void {
    const message = ctx.callbackQuery?.message;
    if (!message) return;

    memoryNotices.add(ownerId, {
      chatId: message.chat.id,
      messageId: message.message_id,
    });
  }

  function forgetCurrentMemoryNotice(ctx: Context, ownerId: string): void {
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (messageId !== undefined) {
      memoryNotices.remove(ownerId, messageId);
    }
  }

  function enqueueBotAction(
    ctx: Context,
    ownerId: string,
    mode: "cancel" | "drain",
    errorLabel: string,
    action: () => Promise<void>,
  ): void {
    const guarded = async (): Promise<void> => {
      try {
        await action();
      } catch (error) {
        console.error(errorLabel, error);
        try {
          await ctx.reply("Ada yang gagal diproses. Coba lagi sebentar, ya.");
        } catch (replyError) {
          console.error("Pemberitahuan kegagalan juga tidak terkirim:", replyError);
        }
      }
    };

    if (mode === "cancel") {
      messageBatcher.cancelAndEnqueue(ownerId, guarded);
      return;
    }
    messageBatcher.drainAndEnqueue(ownerId, guarded);
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

async function safeDelete(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch {
    await dropKeyboard(ctx);
  }
}
