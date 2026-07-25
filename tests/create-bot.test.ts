import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Transformer } from "grammy";
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
  ELIGIBILITY_PROMPT,
  FIRST_WELCOME_MESSAGE,
  HELP_MESSAGE,
  INELIGIBLE_MESSAGE,
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
      FIRST_WELCOME_MESSAGE,
    );
    assert.equal(
      await fixture.eligibility.getStatus(String(USER_ID)),
      "eligible",
    );

    await fixture.bot.handleUpdate(messageUpdate("/bantuan", 3));
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

function makeFixture(): {
  bot: ReturnType<typeof createBot>;
  eligibility: EligibilityService;
  lastText(method: string): string | undefined;
} {
  const eligibility = new EligibilityService(new MemoryEligibilityRepository());
  const bot = createBot(
    {
      telegramBotToken: "000000:test-token",
      dataFile: "/tmp/tasks.json",
      eligibilityDataFile: "/tmp/eligibility.json",
      defaultTimezone: "Asia/Jakarta",
      defaultUtcOffset: "+07:00",
      reminderIntervalMs: 30_000,
    } satisfies AppConfig,
    new TaskService(new MemoryTaskRepository()),
    eligibility,
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
    lastText(method: string): string | undefined {
      const call = calls.findLast((item) => item.method === method);
      return typeof call?.payload.text === "string"
        ? call.payload.text
        : undefined;
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
      entities: [
        { offset: 0, length: text.length, type: "bot_command" as const },
      ],
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
