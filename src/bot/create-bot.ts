import { Bot, type Context, type InlineKeyboard } from "grammy";
import type { HarvyContext } from "../ai/context.js";
import type { Conversation } from "../ai/conversation.js";
import type {
  ExtractedMemory,
  ExtractedTask,
  Understanding,
} from "../ai/understand.js";
import type { AppConfig } from "../config.js";
import { HISTORY_WINDOW } from "../core/history-policy.js";
import type { HistoryService } from "../core/history-service.js";
import type { InsightService } from "../core/insight-service.js";
import { isSensitiveMemory } from "../core/memory-policy.js";
import type { MemoryService } from "../core/memory-service.js";
import { ProfileService, shouldAskStyle } from "../core/profile-service.js";
import { needsReplyReview } from "../core/safety-policy.js";
import type { TaskService } from "../core/task-service.js";
import {
  CALM_TRIAGE,
  SAFE_FALLBACK_REPLY,
  type RiskTriage,
} from "../ai/safety.js";
import type { MemoryItem } from "../domain/memory.js";
import type { StudentTask } from "../domain/task.js";
import {
  bubblePauseMs,
  confirmActions,
  formatMemories,
  formatTask,
  HELP_MESSAGE,
  memoryConsentActions,
  memoryListActions,
  memoryNoteActions,
  memoryNoteLines,
  memoryWipeConfirmActions,
  splitReplyBubbles,
  taskActions,
  taskListActions,
  understandingNote,
  withMemoryNotes,
  withoutMemoryNote,
} from "./messages.js";
import { MessageBatcher } from "./message-batcher.js";
import {
  CONSENT_ACCEPTED,
  CONSENT_ACCEPTED_HELD,
  CONSENT_DETAIL,
  consentActions,
  HeldMessageStore,
  HOLD_REMINDER,
  introBubbles,
  PRE_CONSENT_SAFETY,
  STYLE_QUESTION,
  styleAck,
  styleActions,
  welcomeBack,
} from "./onboarding.js";
import { PendingStore } from "./pending.js";
import {
  emptyListNote,
  notUnderstoodNote,
  nothingLeftNote,
  taskCompletedHeading,
  taskDeclinedNote,
  taskDroppedHeading,
  taskListLead,
  taskMissingNote,
  taskSavedHeading,
} from "./phrasing.js";
import {
  immediateUnderstandingRoute,
  taskToOffer,
} from "./understanding-route.js";

/** Jarak bawaan antara pengingat dan tenggat. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;

const AI_FAILURE_MESSAGE =
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku lagi bermasalah. Coba kirim lagi sebentar lagi, ya.";

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
  profiles: ProfileService,
  insights: InsightService,
): HarvyBot {
  const bot = new Bot(config.telegramBotToken);
  const pending = new PendingStore();
  const held = new HeldMessageStore();
  const messageBatcher = new MessageBatcher<Context>(
    (text) => conversation.classifyTurnBoundary(text),
    (ownerId, batch) => handleFreeText(batch.carrier, ownerId, batch.text),
  );

  /**
   * Status persetujuan yang sudah dibaca, satu promise per pengguna.
   *
   * Bubble yang datang beruntun memakai promise yang sama, sehingga berkasnya
   * dibaca sekali dan urutan `then` mengikuti urutan pesannya. Tanpa itu, dua
   * bubble pertama setelah proses restart dapat masuk ke batcher terbalik.
   */
  const consentChecks = new Map<string, Promise<boolean>>();

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

        // `/start` hanyalah salah satu pintu masuk perkenalan, bukan syaratnya.
        // Yang belum pernah menyetujui apa pun tetap berkenalan dulu di sini.
        if (await profiles.needsOnboarding(ownerId)) {
          await beginOnboarding(ctx, ownerId, "", true);
          return;
        }

        // Pengguna lama tidak mengulang perkenalan. Sapaannya memakai keadaan
        // yang benar-benar ada di datanya, bukan ingatan yang dikarang.
        const active = await tasks.listActive(ownerId);
        await ctx.reply(welcomeBack(active.length));
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
        await sendTaskList(ctx, ownerId);
      },
    );
  });

  bot.on("message:text", (ctx) => {
    const ownerId = ownerOf(ctx);
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Perintah tak dikenal gagal ditanggapi:",
        async () => {
          await ctx.reply(
            ["Aku belum punya perintah itu.", "", HELP_MESSAGE].join("\n"),
          );
        },
      );
      return;
    }

    // Gerbang persetujuan wajib berada di sini, sebelum `enqueue`.
    // `MessageBatcher` memanggil `classifyTurnBoundary` untuk menentukan batas
    // giliran, dan panggilan itu sudah mengirim teks pengguna ke penyedia model.
    // Gerbang yang dipasang lebih dalam berarti izinnya ditanyakan setelah
    // isinya telanjur keluar.
    void consentGate(ownerId)
      .then(async (allowed) => {
        if (allowed) {
          messageBatcher.enqueue(ownerId, text, ctx);
          return;
        }
        await beginOnboarding(ctx, ownerId, text);
      })
      .catch((error: unknown) => {
        console.error("Gerbang kenalan gagal:", error);
      });
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
   * Membaca status persetujuan sekali per pengguna, lalu mengingatnya.
   *
   * Gagal membaca dianggap belum menyetujui. Akibat terburuknya perkenalan
   * muncul sekali lagi kepada pengguna lama; sebaliknya, menganggap sudah
   * setuju ketika berkasnya tidak terbaca berarti mengirim pesannya ke luar
   * tanpa izin.
   */
  function consentGate(ownerId: string): Promise<boolean> {
    let check = consentChecks.get(ownerId);
    if (check) return check;

    check = profiles
      .needsOnboarding(ownerId)
      .then((needs) => !needs)
      .catch((error: unknown) => {
        console.error("Status kenalan gagal dibaca:", error);
        consentChecks.delete(ownerId);
        return false;
      });

    consentChecks.set(ownerId, check);
    return check;
  }

  /**
   * Perkenalan pada kontak pertama, apa pun bentuk kontaknya.
   *
   * Pesan yang sudah telanjur dikirim ditahan lokal — tidak dibaca, tidak
   * dikirim ke mana pun — lalu diproses sendiri setelah pengguna menekan
   * tombolnya. Menyuruhnya mengetik ulang berarti menghukum orang yang langsung
   * bercerita.
   */
  async function beginOnboarding(
    ctx: Context,
    ownerId: string,
    text: string,
    force = false,
  ): Promise<void> {
    if (text) held.hold(ownerId, text);

    // Bahaya dijawab lebih dulu, dan penilaiannya memakai model. Konstitusi
    // v0.3 Pasal 3.9 mengizinkan pemeriksaan ini berjalan sebelum persetujuan,
    // khusus untuk keselamatan — dan naskah perkenalan mengatakannya apa adanya
    // alih-alih mengaku belum membaca apa pun.
    if (text && (await looksDangerous(text)) && held.markSafetyShown(ownerId)) {
      await ctx.reply(PRE_CONSENT_SAFETY);
    }

    const first = held.markIntroduced(ownerId);
    if (!first && !force) {
      if (held.markReminded(ownerId)) await ctx.reply(HOLD_REMINDER);
      return;
    }

    const bubbles = introBubbles(ctx.from?.first_name ?? null, held.has(ownerId));

    for (const [index, bubble] of bubbles.entries()) {
      const last = index === bubbles.length - 1;
      await ctx.reply(bubble, last ? { reply_markup: consentActions() } : {});

      if (!last) {
        await bestEffortTyping(ctx);
        await sleep(bubblePauseMs(bubbles[index + 1] ?? ""));
      }
    }
  }

  /**
   * Pemeriksaan bahaya atas pesan yang belum disetujui pemrosesannya.
   *
   * Kegagalannya tidak boleh menghentikan perkenalan: yang hilang hanya
   * kesempatan menjawab lebih dulu, dan itu lebih baik daripada pengguna baru
   * yang tidak mendapat sapaan sama sekali.
   */
  async function looksDangerous(text: string): Promise<boolean> {
    try {
      return (await conversation.triageRisk(text))?.level === "bahaya";
    } catch (error) {
      console.error("Triase pra-persetujuan gagal:", error);
      return false;
    }
  }

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
    const [context, profile, insight] = await Promise.all([
      contextFor(ownerId, text),
      profiles.load(ownerId),
      insights.load(ownerId),
    ]);

    let understanding: Understanding | null;
    let triage: RiskTriage;

    try {
      // Triase berjalan berbarengan dengan ekstraksi, bukan sesudahnya.
      // Keduanya memakai model termurah, jadi giliran ini menunggu yang
      // terlama dari dua — bukan jumlah keduanya.
      const [read, risk] = await Promise.all([
        conversation.understand(text, context),
        conversation.triageRisk(text).catch((error: unknown) => {
          console.error("Triase risiko gagal:", error);
          return null;
        }),
      ]);
      understanding = read;
      // Triase yang gagal tidak boleh terlihat seperti percakapan yang
      // baik-baik saja. Field lama dari ekstraksi tetap menjadi jaring
      // terakhirnya di dalam `Conversation.reply`.
      triage = risk ?? CALM_TRIAGE;
    } catch (error) {
      console.error("Pemahaman pesan gagal:", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      return;
    }

    await history.append(ownerId, "user", text);

    try {
      if (!understanding) {
        await ctx.reply(notUnderstoodNote());
        return;
      }

      const route = immediateUnderstandingRoute(understanding);

      if (route.kind === "memory-control") {
        pending.clear(ownerId);
        await showMemories(ctx, ownerId);
        return;
      }

      // Balasan disusun lebih dulu, termasuk untuk pesan yang berisi tugas.
      // Kalimat yang membawa perasaan sekaligus pekerjaan pernah dijawab hanya
      // dengan struk pencatatan, dan bagian perasaannya hilang tanpa jejak.
      const raiseHelp = await insights.shouldRaiseHelp(ownerId, triage.level);

      let reply: string | null = null;
      try {
        reply = await conversation.reply(
          text,
          understanding,
          context,
          profile.stylePreference,
          triage,
          insight,
          raiseHelp,
        );
        reply = await guardReply(text, reply, triage);
      } catch (error) {
        console.error("Balasan model gagal:", error);
        if (route.kind !== "save-task") {
          await ctx.reply(AI_FAILURE_MESSAGE);
          return;
        }
        // Untuk tugas, pencatatannya tetap diteruskan. Kehilangan kalimat
        // pembuka jauh lebih ringan daripada kehilangan pekerjaan pengguna.
      }

      if (raiseHelp) await insights.markHelpSuggested(ownerId);

      // Giliran berisiko dicatat seketika, bukan di latar: kalau proses
      // berhenti, justru catatan inilah yang paling mahal kalau hilang.
      await insights.record(
        ownerId,
        triage.level,
        triage.summary,
        reply ? reply.slice(0, 160) : "(balasan gagal disusun)",
      );

      const remembered = await storeOrdinaryMemories(
        ownerId,
        understanding.memories,
        triage.sensitive,
      );

      if (reply) {
        await sendReply(ctx, reply, remembered.saved);
        await history.append(ownerId, "harvy", reply.trim());
        await memories.markUsed(context.memories);
      }

      if (route.kind === "save-task") {
        pending.clear(ownerId);
        // Kartu tugas menyusul balasan, tanpa kalimat pembuka kedua. Kalau
        // balasannya gagal dibuat, kartunya yang membawa kalimatnya.
        await saveTask(ctx, ownerId, route.task, reply ? undefined : taskSavedHeading());
        if (!reply) await sendMemoryNotes(ctx, remembered.saved);
        await askSensitive(ctx, ownerId, remembered.sensitive);
        return;
      }

      // Pekerjaan yang tersirat di balik cerita ditawarkan, tidak dicatat diam-diam.
      const offeredTask = taskToOffer(understanding);
      if (offeredTask) {
        pending.set(ownerId, { kind: "confirm-task", task: offeredTask });
        const offerText =
          `Mau aku catat “${offeredTask.title}” biar nggak perlu kamu ingat-ingat?`;
        await ctx.reply(offerText, { reply_markup: confirmActions() });
        await history.append(ownerId, "harvy", offerText);
        return;
      }

      await askSensitive(ctx, ownerId, remembered.sensitive);

      // Ditanyakan setelah percakapan punya isi, bukan setelah giliran pertama.
      // Pada uji pertama pesan pembukanya cuma "p", dan pertanyaan gaya sudah
      // muncul di detik berikutnya — pengguna belum punya bahan menjawabnya.
      await askStyleOnce(
        ctx,
        ownerId,
        shouldAskStyle(profile) && context.turns.length >= HISTORY_WINDOW,
      );
    } finally {
      // Model peringkas berjalan setelah balasan utama selesai. Tidak di-await:
      // kegagalan atau timeout-nya tidak boleh membuat pengguna menunggu.
      void history.compact(ownerId);
      // Pemahaman tentang penggunanya menumpang jadwal yang sama. Ia dipakai
      // pada giliran berikutnya, jadi tertinggal satu putaran tidak apa-apa.
      void refreshInsight(ownerId);
    }
  }

  /**
   * Memeriksa rancangan balasan untuk giliran yang berisiko.
   *
   * Pemeriksaan yang gagal tidak membatalkan balasan. Menghukum pengguna karena
   * pemeriksaan Harvy sendiri tidak berjalan akan membuat orang yang sedang
   * berat menerima pesan baku, padahal balasannya mungkin baik-baik saja.
   */
  async function guardReply(
    message: string,
    reply: string,
    triage: RiskTriage,
  ): Promise<string> {
    if (!needsReplyReview(triage.level)) return reply;

    let verdict: boolean | null = null;
    try {
      verdict = await conversation.reviewReply(message, reply);
    } catch (error) {
      console.error("Pemeriksaan balasan gagal:", error);
      return reply;
    }

    if (verdict === false) {
      console.warn(
        "Balasan ditolak pemeriksaan keselamatan; memakai balasan pengganti.",
      );
      return SAFE_FALLBACK_REPLY;
    }
    return reply;
  }

  async function refreshInsight(ownerId: string): Promise<void> {
    try {
      const conversationContext = await history.context(ownerId);
      await insights.refresh(
        ownerId,
        conversationContext.summary,
        conversationContext.turns,
      );
    } catch (error) {
      console.warn("Pemahaman pengguna gagal disegarkan:", error);
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
   * Mengirim balasan sebagai beberapa bubble, dengan jeda kecil di antaranya.
   *
   * Tiga bubble yang tiba serentak terbaca seperti notifikasi beruntun. Jedanya
   * pendek dan berplafon: ini soal keterbacaan, bukan soal membuat percakapan
   * terasa lebih lama.
   */
  async function sendReply(
    ctx: Context,
    text: string,
    notes: MemoryItem[] = [],
  ): Promise<void> {
    const bubbles = splitReplyBubbles(text);
    if (bubbles.length === 0) return;

    for (const [index, bubble] of bubbles.entries()) {
      const last = index === bubbles.length - 1;

      await ctx.reply(
        last ? withMemoryNotes(bubble, notes) : bubble,
        last && notes.length > 0
          ? { reply_markup: memoryNoteActions(notes) }
          : {},
      );

      if (!last) {
        await bestEffortTyping(ctx);
        await sleep(bubblePauseMs(bubbles[index + 1] ?? ""));
      }
    }
  }

  /** Jalur mundur ketika tidak ada balasan yang bisa ditempeli catatan. */
  async function sendMemoryNotes(
    ctx: Context,
    items: MemoryItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    await ctx.reply(memoryNoteLines(items), {
      reply_markup: memoryNoteActions(items),
    });
  }

  /**
   * Menyimpan memori biasa dan menyisihkan yang sensitif untuk ditawarkan.
   *
   * Yang biasa disimpan tanpa bertanya, tetapi tidak diam-diam: setiap
   * penyimpanan diumumkan di balasan yang sama berikut jalan keluarnya, sesuai
   * Pasal 4 nomor 2. Yang sensitif tidak pernah lewat jalur ini — Pasal 4
   * nomor 3.
   */
  async function storeOrdinaryMemories(
    ownerId: string,
    items: ExtractedMemory[],
    sensitiveByModel = false,
  ): Promise<{ saved: MemoryItem[]; sensitive: ExtractedMemory | null }> {
    const saved: MemoryItem[] = [];
    let sensitive: ExtractedMemory | null = null;

    for (const item of items) {
      if (isSensitiveMemory(item, sensitiveByModel)) {
        sensitive ??= item;
        continue;
      }

      const stored = await memories.remember({
        ownerId,
        kind: item.kind,
        content: item.content,
      });
      if (stored) saved.push(stored);
    }

    return { saved, sensitive };
  }

  /**
   * Hanya satu langkah tertunda yang dapat hidup sekaligus per pengguna.
   *
   * Ketika sebuah pesan melahirkan tawaran tugas sekaligus memori sensitif,
   * tawaran tugas menang dan memorinya dilewatkan. Menumpuk dua pertanyaan
   * sekaligus membuat pengguna harus menjawab kuis, dan Pasal 3.11 meminta
   * pilihan yang tidak berlebihan.
   */
  async function askSensitive(
    ctx: Context,
    ownerId: string,
    sensitive: ExtractedMemory | null,
  ): Promise<void> {
    if (!sensitive) {
      pending.clear(ownerId);
      return;
    }

    pending.set(ownerId, { kind: "confirm-memory", memory: sensitive });
    await ctx.reply(
      [
        `Boleh aku inget ini? “${sensitive.content}”`,
        "",
        "Kalau boleh, kamu nggak perlu cerita ulang nanti. Kalau nggak, aku tetap dengerin hari ini dan nggak nyimpen apa-apa.",
      ].join("\n"),
      { reply_markup: memoryConsentActions() },
    );
  }

  /**
   * Satu pertanyaan gaya, sesudah percakapan pertama benar-benar terjadi.
   *
   * Tidak diajukan ketika ada pertanyaan lain yang sedang menunggu jawaban:
   * dua pertanyaan sekaligus mengubah percakapan menjadi formulir.
   */
  async function askStyleOnce(
    ctx: Context,
    ownerId: string,
    eligible: boolean,
  ): Promise<void> {
    if (!eligible || pending.peek(ownerId)) return;

    await profiles.markStyleAsked(ownerId);
    await ctx.reply(STYLE_QUESTION, { reply_markup: styleActions() });
    await history.append(ownerId, "harvy", STYLE_QUESTION);
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
    heading?: string,
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
      ...(heading ? [heading, ""] : []),
      formatTask(task, config.defaultTimezone),
      understandingNote(task),
    ].join("\n");

    await ctx.reply(response, { reply_markup: taskActions(task) });
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
        "Aku belum nangkep waktunya. Coba tulis seperti “besok jam 7 malam” atau “senin depan”.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    pending.clear(ownerId);
    const updated = await tasks.setDue(ownerId, taskId, dueAt);

    if (!updated) {
      const response = taskMissingNote();
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    const response = [
      "Tenggatnya udah aku ubah.",
      "",
      formatTask(updated, config.defaultTimezone),
    ].join("\n");
    await ctx.reply(response, { reply_markup: taskActions(updated) });
    await history.append(ownerId, "harvy", response);
  }

  async function routeAction(
    ctx: Context,
    ownerId: string,
    action: string,
    target: string,
  ): Promise<void> {
    switch (action) {
      case "consent": {
        await acceptConsent(ctx, ownerId, target);
        return;
      }

      case "style": {
        if (target !== "listen" && target !== "advice") return;

        await profiles.rememberStyle(ownerId, target);
        await safeEdit(ctx, styleAck(target));
        await history.append(ownerId, "harvy", styleAck(target));
        return;
      }

      case "save": {
        const waiting = pending.peek(ownerId);
        pending.clear(ownerId);

        if (waiting?.kind !== "confirm-task") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }

        await dropKeyboard(ctx);
        await saveTask(ctx, ownerId, waiting.task, taskSavedHeading());
        return;
      }

      case "nosave": {
        pending.clear(ownerId);
        await safeEdit(ctx, taskDeclinedNote());
        return;
      }

      case "done": {
        const completed = await tasks.complete(ownerId, target);
        if (!completed) {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await refreshAfterChange(ctx, ownerId, completed.title);
        return;
      }

      case "drop": {
        const removed = await tasks.remove(ownerId, target);
        if (!removed) {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await refreshAfterChange(ctx, ownerId);
        return;
      }

      case "edit": {
        pending.set(ownerId, { kind: "edit-due", taskId: target });
        await ctx.reply(
          "Mau diubah jadi kapan? Tulis aja, misalnya “besok jam 7 malam” atau “senin depan”.",
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
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }

        const saved = await memories.remember({
          ownerId,
          kind: waiting.memory.kind,
          content: waiting.memory.content,
        });

        await safeEdit(
          ctx,
          saved ? memoryNoteLines([saved]) : "Ternyata udah aku inget sebelumnya.",
          saved ? memoryNoteActions([saved]) : undefined,
        );
        return;
      }

      case "memskip": {
        pending.clear(ownerId);
        await safeEdit(
          ctx,
          "Oke, itu nggak aku simpen. Aku tetap di sini kalau kamu mau cerita.",
        );
        return;
      }

      // Tombol pada catatan yang menempel di balasan. Balasannya pesan
      // sungguhan, jadi yang dibuang cukup barisnya — bukan seluruh pesannya,
      // dan bukan diganti daftar memori.
      case "memdrop": {
        const forgotten = await memories.forget(ownerId, target);
        await safeEdit(
          ctx,
          withoutMemoryNote(
            ctx.callbackQuery?.message?.text ?? "",
            forgotten?.content ?? null,
          ),
        );
        return;
      }

      case "memforget": {
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
            "Yakin? Aku bakal ngelupain semua catatan tentang kamu sekaligus seluruh riwayat obrolan kita. Ini nggak bisa dibatalin.",
          ].join("\n"),
          { reply_markup: memoryWipeConfirmActions() },
        );
        return;
      }

      case "memallyes": {
        const removed = await memories.forgetAll(ownerId);
        await history.forget(ownerId);
        // Pasal 4 nomor 6: catatan tersembunyi ikut terhapus bersama sisanya.
        await insights.forget(ownerId);
        // Persetujuan tidak ikut terhapus: kalau ikut, memakai hak melupakan
        // berarti dipaksa berkenalan ulang, dan Pasal 4 nomor 5 melarang
        // penarikan izin dipersulit.
        await profiles.forgetPersonal(ownerId);
        pending.clear(ownerId);

        await safeEdit(
          ctx,
          [
            `Udah aku lupain semuanya — ${removed} catatan dan seluruh riwayat obrolan kita.`,
            "",
            "Tugasmu nggak ikut kehapus. Kalau mau itu juga hilang, batalin satu per satu lewat daftarnya.",
          ].join("\n"),
        );
        return;
      }

      case "memallno": {
        await safeEdit(ctx, "Nggak jadi. Semuanya masih aku inget.");
        return;
      }

      default:
        return;
    }
  }

  async function acceptConsent(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    if (target === "info") {
      // Tombolnya dipindahkan ke pesan terbaru, bukan digandakan. Kalau papan
      // lama dibiarkan hidup, setiap ketukan menambah satu salinan penjelasan
      // yang sama — dan itu yang terjadi pada uji pertama.
      await dropKeyboard(ctx);
      await ctx.reply(CONSENT_DETAIL, { reply_markup: consentActions() });
      return;
    }

    if (target !== "yes") return;

    await profiles.acceptConsent(ownerId);
    consentChecks.set(ownerId, Promise.resolve(true));
    await dropKeyboard(ctx);

    const waiting = held.take(ownerId);
    held.clear(ownerId);

    await ctx.reply(waiting ? CONSENT_ACCEPTED_HELD : CONSENT_ACCEPTED);

    // Diproses langsung, bukan lewat batcher: pesannya sudah selesai ditulis
    // jauh sebelum tombol ditekan, jadi tidak ada batas giliran yang perlu
    // ditebak. Ini tetap berada di dalam antrean pengguna yang sama.
    if (waiting) await handleFreeText(ctx, ownerId, waiting);
  }

  async function refreshMemories(
    ctx: Context,
    ownerId: string,
    forgotten?: string,
    missing = false,
  ): Promise<void> {
    const remaining = await memories.list(ownerId);
    const heading = missing
      ? "Itu udah nggak ada."
      : forgotten
      ? `Udah aku lupain: ${forgotten}`
      : "Udah aku lupain.";

    if (remaining.length === 0) {
      await safeEdit(
        ctx,
        `${heading}\n\nSekarang nggak ada lagi yang aku inget tentang kamu.`,
      );
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
      await safeEdit(ctx, taskMissingNote());
      return;
    }

    const now = Date.now();
    const target =
      action === "snooze"
        ? new Date(now + REMINDER_LEAD_MS)
        : dueMinusLead(task);

    if (!target || target.getTime() <= now) {
      await ctx.reply(
        "Tenggatnya udah kelewat dekat buat diingetin lebih awal.",
      );
      return;
    }

    const updated = await tasks.setReminder(ownerId, taskId, target);

    if (updated) {
      await ctx.reply(
        [
          "Oke, nanti aku ingetin.",
          "",
          formatTask(updated, config.defaultTimezone),
        ].join("\n"),
      );
      return;
    }
    await safeEdit(ctx, taskMissingNote());
  }

  async function refreshAfterChange(
    ctx: Context,
    ownerId: string,
    completedTitle?: string,
  ): Promise<void> {
    const remaining = await tasks.listActive(ownerId);
    const heading = completedTitle
      ? taskCompletedHeading(completedTitle)
      : taskDroppedHeading();

    if (remaining.length === 0) {
      await safeEdit(ctx, `${heading}\n\n${nothingLeftNote()}`);
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
      await ctx.reply(emptyListNote());
      return;
    }

    await ctx.reply(
      [
        taskListLead(),
        "",
        ...active.map((task) => formatTask(task, config.defaultTimezone)),
      ].join("\n"),
      { reply_markup: taskListActions(active) },
    );
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref?.();
  });
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
