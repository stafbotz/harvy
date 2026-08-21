import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { telegramCommands } from "../src/bot/commands.js";

describe("menu command Telegram", () => {
  it("mendaftarkan /memori dengan deskripsi manusiawi", () => {
    const commands = telegramCommands({
      codingRuntime: false,
      githubPublishing: false,
    });
    const memory = commands.find((item) => item.command === "memori");

    assert.deepEqual(memory, {
      command: "memori",
      description: "Lihat yang aku ingat tentang kamu",
    });
    assert.ok(commands.some((item) => item.command === "tugas"));
    assert.ok(commands.some((item) => item.command === "bantuan"));
  });

  it("mempertahankan command coding ketika runtime tersedia", () => {
    const commands = telegramCommands({
      codingRuntime: true,
      githubPublishing: true,
    }).map((item) => item.command);

    for (const command of [
      "memori",
      "project",
      "code",
      "code_status",
      "code_cancel",
      "github",
      "publish",
    ]) assert.ok(commands.includes(command), command);
  });
});
