import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestEffortTyping } from "../src/bot/create-bot.js";

describe("indikator mengetik", () => {
  it("tidak membatalkan giliran ketika Telegram gagal", async () => {
    let called = false;
    const originalWarn = console.warn;
    console.warn = () => undefined;

    try {
      await assert.doesNotReject(() =>
        bestEffortTyping({
          replyWithChatAction: async () => {
            called = true;
            throw new Error("Telegram tidak tersedia");
          },
        }),
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(called, true);
  });
});
