import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Transformer } from "grammy";
import type {
  ConversationRequest,
  ConversationService,
} from "../src/ai/conversation-service.js";
import { createBot } from "../src/bot/create-bot.js";
import type { AppConfig } from "../src/config.js";
import { EligibilityService } from "../src/core/eligibility-service.js";
import { TaskService } from "../src/core/task-service.js";
import type {
  EligibilityRecord,
  EligibilityRepository,
} from "../src/domain/user-profile.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";
import {
  AI_CONSENT_DECLINED_MESSAGE,
  AI_CONSENT_PROMPT,
  AI_UNAVAILABLE_MESSAGE,
  CONVERSATION_CLEARED_MESSAGE,
  ELIGIBILITY_PROMPT,
  FIRST_WELCOME_MESSAGE,
  HELP_MESSAGE,
  HIGH_RISK_MESSAGE,
  INELIGIBLE_MESSAGE,
  INPUT_TOO_LONG_MESSAGE,
  PRIVACY_GRANTED_MESSAGE,
} from "../src/bot/messages.js";

const USER_ID = 42;
const BOT_ID = 999;

describe("gerbang kelayakan bot", () => {
  it("meminta status kelas sebelum membuka fitur", async () => {
    const fixture = makeFixture();

    await fixture.bot.handleUpdate(messageUpdate("/bantuan", 1));

    assert.equal(fixture.lastText("sendMessage"), ELIGIBILITY_PROMPT);
    assert.equal(await fixture.eligibility.getStatus(String(USER_ID)), null);
  });

  it("membuka fitur setelah pengguna menyatakan sudah kelas 8+", async () => {
    const fixture = makeFixture();
    await fixture.bot.handleUpdate(messageUpdate("/start", 1));
    await fixture.bot.handleUpdate(
      callbackUpdate("eligibility:eligible", 2),
    );

    assert.equal(
      fixture.lastText("editMessageText"),
      AI_CONSENT_PROMPT,
    );
    assert.equal(
      await fixture.eligibility.getStatus(String(USER_ID)),
      "eligible",
    );

    await fixture.bot.handleUpdate(
      callbackUpdate("ai-consent:granted", 3),
    );
    assert.equal(fixture.lastText("editMessageText"), FIRST_WELCOME_MESSAGE);
    assert.equal(
      await fixture.eligibility.getAiConsent(String(USER_ID)),
      "granted",
    );

    await fixture.bot.handleUpdate(messageUpdate("/bantuan", 4));
    assert.equal(fixture.lastText("sendMessage"), HELP_MESSAGE);
  });

  it("menolak dengan ramah dan mengizinkan koreksi jawaban", async () => {
    const fixture = makeFixture();
    await fixture.bot.handleUpdate(messageUpdate("/start", 1));
    await fixture.bot.handleUpdate(
      callbackUpdate("eligibility:ineligible", 2),
    );

    assert.equal(fixture.lastText("editMessageText"), INELIGIBLE_MESSAGE);
    assert.equal(
      await fixture.eligibility.getStatus(String(USER_ID)),
      "ineligible",
    );

    await fixture.bot.handleUpdate(messageUpdate("/tugas", 3));
    assert.equal(fixture.lastText("sendMessage"), INELIGIBLE_MESSAGE);

    await fixture.bot.handleUpdate(callbackUpdate("eligibility:reset", 4));
    assert.equal(fixture.lastText("editMessageText"), ELIGIBILITY_PROMPT);
    assert.equal(await fixture.eligibility.getStatus(String(USER_ID)), null);
  });
});

describe("percakapan AI bot", () => {
  it("tidak mengirim pesan bebas ke model sebelum persetujuan", async () => {
    const fixture = makeFixture();
    await fixture.bot.handleUpdate(messageUpdate("/start", 1));
    await fixture.bot.handleUpdate(
      callbackUpdate("eligibility:eligible", 2),
    );

    await fixture.bot.handleUpdate(
      messageUpdate("Hari ini berantakan banget", 3),
    );

    assert.deepEqual(fixture.conversations.requests, []);
    assert.equal(fixture.lastText("sendMessage"), AI_CONSENT_PROMPT);
  });

  it("mengirim pesan bebas ke model setelah persetujuan", async () => {
    const fixture = makeFixture({ response: "Kita urai satu hal dulu." });
    await makeEligibleWithConsent(fixture);

    await fixture.bot.handleUpdate(
      messageUpdate("Besok banyak tugas dan aku bingung mulai dari mana", 4),
    );

    assert.deepEqual(fixture.conversations.requests, [
      {
        message: "Besok banyak tugas dan aku bingung mulai dari mana",
        history: [],
      },
    ]);
    assert.equal(fixture.lastText("sendMessage"), "Kita urai satu hal dulu.");
    assert.equal(fixture.callCount("sendChatAction"), 1);
  });

  it("menghormati penolakan dan menampilkan status lewat /privasi", async () => {
    const fixture = makeFixture();
    await fixture.bot.handleUpdate(messageUpdate("/start", 1));
    await fixture.bot.handleUpdate(
      callbackUpdate("eligibility:eligible", 2),
    );
    await fixture.bot.handleUpdate(
      callbackUpdate("ai-consent:declined", 3),
    );

    await fixture.bot.handleUpdate(messageUpdate("Tolong bantu aku", 4));
    assert.deepEqual(fixture.conversations.requests, []);
    assert.equal(
      fixture.lastText("sendMessage"),
      AI_CONSENT_DECLINED_MESSAGE,
    );

    await fixture.bot.handleUpdate(
      callbackUpdate("ai-consent:granted", 5),
    );
    await fixture.bot.handleUpdate(messageUpdate("/privasi", 6));
    assert.equal(fixture.lastText("sendMessage"), PRIVACY_GRANTED_MESSAGE);
  });

  it("menangani risiko serius eksplisit tanpa memanggil model", async () => {
    const fixture = makeFixture();
    await fixture.bot.handleUpdate(messageUpdate("/start", 1));
    await fixture.bot.handleUpdate(
      callbackUpdate("eligibility:eligible", 2),
    );

    await fixture.bot.handleUpdate(
      messageUpdate("Aku mau bunuh diri malam ini", 3),
    );

    assert.deepEqual(fixture.conversations.requests, []);
    assert.equal(fixture.lastText("sendMessage"), HIGH_RISK_MESSAGE);
  });

  it("menolak masukan terlalu panjang sebelum memanggil model", async () => {
    const fixture = makeFixture();
    await makeEligibleWithConsent(fixture);

    await fixture.bot.handleUpdate(messageUpdate("a".repeat(6_001), 4));

    assert.deepEqual(fixture.conversations.requests, []);
    assert.equal(fixture.lastText("sendMessage"), INPUT_TOO_LONG_MESSAGE);
  });

  it("memberi fallback aman ketika layanan AI gagal", async () => {
    const fixture = makeFixture({ error: new Error("secret detail") });
    await makeEligibleWithConsent(fixture);
    const errorLog = mock.method(console, "error", () => undefined);

    await fixture.bot.handleUpdate(messageUpdate("Bantu aku mulai", 4));

    assert.equal(fixture.lastText("sendMessage"), AI_UNAVAILABLE_MESSAGE);
    assert.equal(errorLog.mock.callCount(), 1);
    assert.deepEqual(errorLog.mock.calls[0]?.arguments, [
      "Respons AI gagal:",
      "Error",
    ]);
    errorLog.mock.restore();
  });

  it("membawa konteks aktif ke balasan berikutnya", async () => {
    const fixture = makeFixture({ response: "Jawaban Harvy" });
    await makeEligibleWithConsent(fixture);

    await fixture.bot.handleUpdate(messageUpdate("Aku punya dua tugas", 4));
    await fixture.bot.handleUpdate(messageUpdate("Yang pertama besok", 5));

    assert.deepEqual(fixture.conversations.requests[1], {
      message: "Yang pertama besok",
      history: [
        { role: "user", content: "Aku punya dua tugas" },
        { role: "assistant", content: "Jawaban Harvy" },
      ],
    });
  });

  it("menghapus konteks aktif atas perintah pengguna", async () => {
    const fixture = makeFixture({ response: "Jawaban Harvy" });
    await makeEligibleWithConsent(fixture);
    await fixture.bot.handleUpdate(messageUpdate("Pesan pertama", 4));

    await fixture.bot.handleUpdate(messageUpdate("/hapuspercakapan", 5));
    assert.equal(
      fixture.lastText("sendMessage"),
      CONVERSATION_CLEARED_MESSAGE,
    );

    await fixture.bot.handleUpdate(messageUpdate("Mulai lagi", 6));
    assert.deepEqual(fixture.conversations.requests[1], {
      message: "Mulai lagi",
      history: [],
    });
  });

  it("membersihkan konteks aktif ketika izin AI ditarik", async () => {
    const fixture = makeFixture({ response: "Jawaban Harvy" });
    await makeEligibleWithConsent(fixture);
    await fixture.bot.handleUpdate(messageUpdate("Pesan pertama", 4));
    await fixture.bot.handleUpdate(
      callbackUpdate("ai-consent:declined", 5),
    );
    await fixture.bot.handleUpdate(
      callbackUpdate("ai-consent:granted", 6),
    );

    await fixture.bot.handleUpdate(messageUpdate("Mulai baru", 7));

    assert.deepEqual(fixture.conversations.requests[1], {
      message: "Mulai baru",
      history: [],
    });
  });
});

type Fixture = ReturnType<typeof makeFixture>;

function makeFixture(options: {
  response?: string;
  error?: Error;
} = {}): {
  bot: ReturnType<typeof createBot>;
  eligibility: EligibilityService;
  conversations: MemoryConversationService;
  lastText(method: string): string | undefined;
  callCount(method: string): number;
} {
  const eligibility = new EligibilityService(new MemoryEligibilityRepository());
  const conversations = new MemoryConversationService(
    options.response ?? "Respons AI",
    options.error,
  );
  const bot = createBot(
    {
      telegramBotToken: "000000:test-token",
      dataFile: "/tmp/tasks.json",
      eligibilityDataFile: "/tmp/eligibility.json",
      openaiModel: "gpt-5.6-luna",
      openaiTimeoutMs: 30_000,
      defaultTimezone: "Asia/Jakarta",
      defaultUtcOffset: "+07:00",
      reminderIntervalMs: 30_000,
    } satisfies AppConfig,
    new TaskService(new MemoryTaskRepository()),
    eligibility,
    conversations,
  );
  bot.botInfo = botUser();

  const calls: Array<{
    method: string;
    payload: Record<string, unknown>;
  }> = [];
  bot.api.config.use(
    (async (_previous, method, payload) => {
      calls.push({
        method,
        payload: payload as Record<string, unknown>,
      });
      return { ok: true, result: true };
    }) as Transformer,
  );

  return {
    bot,
    eligibility,
    conversations,
    lastText(method: string): string | undefined {
      const call = calls.findLast((item) => item.method === method);
      return typeof call?.payload.text === "string"
        ? call.payload.text
        : undefined;
    },
    callCount(method: string): number {
      return calls.filter((item) => item.method === method).length;
    },
  };
}

function messageUpdate(text: string, updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_785_100_000,
      chat: privateChat(),
      from: studentUser(),
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              {
                offset: 0,
                length: text.length,
                type: "bot_command" as const,
              },
            ],
          }
        : {}),
    },
  };
}

function callbackUpdate(data: string, updateId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: studentUser(),
      chat_instance: "test-chat",
      data,
      message: {
        message_id: 100,
        date: 1_785_100_000,
        chat: privateChat(),
        from: botUser(),
        text: ELIGIBILITY_PROMPT,
      },
    },
  };
}

function privateChat() {
  return {
    id: USER_ID,
    type: "private" as const,
    first_name: "Pelajar",
  };
}

function studentUser() {
  return {
    id: USER_ID,
    is_bot: false,
    first_name: "Pelajar",
  };
}

function botUser() {
  return {
    id: BOT_ID,
    is_bot: true as const,
    first_name: "Harvy",
    username: "harvy_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

class MemoryEligibilityRepository implements EligibilityRepository {
  private records: EligibilityRecord[] = [];

  async find(ownerId: string): Promise<EligibilityRecord | null> {
    return this.records.find((record) => record.ownerId === ownerId) ?? null;
  }

  async save(record: EligibilityRecord): Promise<void> {
    const index = this.records.findIndex(
      (item) => item.ownerId === record.ownerId,
    );
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }

  async delete(ownerId: string): Promise<void> {
    this.records = this.records.filter(
      (record) => record.ownerId !== ownerId,
    );
  }
}

class MemoryConversationService implements ConversationService {
  readonly requests: ConversationRequest[] = [];

  constructor(
    private readonly response: string,
    private readonly error?: Error,
  ) {}

  async reply(request: ConversationRequest): Promise<string> {
    this.requests.push({
      message: request.message,
      history: request.history.map((message) => ({ ...message })),
    });
    if (this.error) throw this.error;
    return this.response;
  }
}

class MemoryTaskRepository implements TaskRepository {
  async save(_task: StudentTask): Promise<void> {}

  async findById(
    _ownerId: string,
    _id: string,
  ): Promise<StudentTask | null> {
    return null;
  }

  async listActive(_ownerId: string): Promise<StudentTask[]> {
    return [];
  }

  async listDueReminders(_now: Date): Promise<StudentTask[]> {
    return [];
  }
}

async function makeEligibleWithConsent(fixture: Fixture): Promise<void> {
  await fixture.bot.handleUpdate(messageUpdate("/start", 1));
  await fixture.bot.handleUpdate(
    callbackUpdate("eligibility:eligible", 2),
  );
  await fixture.bot.handleUpdate(
    callbackUpdate("ai-consent:granted", 3),
  );
}
