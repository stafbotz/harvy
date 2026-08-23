import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderCommandCategory,
  renderCommandMenu,
  renderHelpMessage,
  telegramCommands,
  userCommandCatalog,
} from "../src/bot/commands.js";

const OFF = { codingRuntime: false, githubPublishing: false };
const ON = { codingRuntime: true, githubPublishing: true };

describe("katalog command user-facing", () => {
  it("menyinkronkan /menu, /penggunaan, help, dan registrasi Telegram", () => {
    const commands = telegramCommands(OFF);
    const names = commands.map((item) => item.command);
    for (const name of ["menu", "tugas", "memori", "penggunaan", "dukung", "bantuan"]) {
      assert.ok(names.includes(name), name);
    }
    assert.deepEqual(commands.find((item) => item.command === "memori"), {
      command: "memori",
      description: "Lihat yang aku ingat tentang kamu",
    });

    const menu = renderCommandMenu(OFF, "telegram");
    const help = renderHelpMessage(OFF, "telegram");
    assert.match(menu, /Menu Harvy/u);
    assert.match(menu, /Penggunaan & paket/u);
    assert.match(help, /Contoh:/u);
    assert.match(help, /\/menu/u);
    assert.notEqual(menu, help);
  });

  it("memfilter command berdasarkan availability dari sumber yang sama", () => {
    const off = telegramCommands(OFF).map((item) => item.command);
    const on = telegramCommands(ON).map((item) => item.command);
    for (const command of [
      "project",
      "code",
      "code_status",
      "code_cancel",
      "github",
      "publish",
    ]) {
      assert.ok(!off.includes(command), command);
      assert.ok(on.includes(command), command);
    }
    assert.equal(renderCommandCategory("coding", OFF, "telegram"), null);
    assert.match(renderCommandCategory("coding", ON, "telegram") ?? "", /\/publish/u);
  });

  it("memberi WhatsApp privat kemampuan personal dan coding yang setara", () => {
    const names = userCommandCatalog(OFF, "whatsapp").map((item) => item.command);
    for (const name of [
      "menu",
      "tugas",
      "penggunaan",
      "dukung",
      "memori",
      "sesi",
      "checkin",
      "ekspor",
      "zona",
      "jam-tenang",
      "izin",
      "tarik-izin",
      "hapus-data",
      "bantuan",
    ]) {
      assert.ok(names.includes(name), name);
    }
    const help = renderHelpMessage(OFF, "whatsapp");
    assert.doesNotMatch(help, /\/project|\/publish/u);
    assert.match(help, /ingatkan aku|Tugas,/u);

    const codingNames = userCommandCatalog(ON, "whatsapp")
      .map((item) => item.command);
    for (const name of ["project", "code", "code_status", "code_cancel", "github", "publish"]) {
      assert.ok(codingNames.includes(name), name);
    }
  });

  it("tidak mengekspos command internal/operator", () => {
    const rendered = [
      ...userCommandCatalog(ON, "telegram"),
      ...userCommandCatalog(ON, "whatsapp"),
    ].map((item) => `${item.command} ${item.description} ${item.detail}`).join("\n");
    assert.doesNotMatch(
      rendered,
      /agent\.delegate|parallel\.delegate|terminal\.run|worker #|provider|credential|operator/iu,
    );
  });
});
