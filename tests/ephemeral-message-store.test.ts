import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EphemeralMessageStore } from "../src/bot/ephemeral-message-store.js";

describe("EphemeralMessageStore", () => {
  it("mengambil seluruh notifikasi milik satu pengguna saja", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });
    store.add("a", { chatId: 1, messageId: 11 });
    store.add("b", { chatId: 2, messageId: 20 });

    assert.deepEqual(store.takeAll("a"), [
      { chatId: 1, messageId: 10 },
      { chatId: 1, messageId: 11 },
    ]);
    assert.deepEqual(store.takeAll("a"), []);
    assert.deepEqual(store.takeAll("b"), [{ chatId: 2, messageId: 20 }]);
  });

  it("menghapus satu notifikasi yang sudah ditanggapi", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });
    store.add("a", { chatId: 1, messageId: 11 });

    store.remove("a", 10);
    assert.deepEqual(store.takeAll("a"), [{ chatId: 1, messageId: 11 }]);
  });

  it("tidak menggandakan referensi yang akan dicoba ulang", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });
    const [leased] = store.takeAll("a");
    assert.ok(leased);
    store.retry("a", leased);
    store.add("a", { chatId: 1, messageId: 10 });

    assert.deepEqual(store.takeAll("a"), [
      { chatId: 1, messageId: 10, failedAttempts: 1 },
    ]);
  });

  it("tidak menghidupkan ref yang dihapus saat request masih berjalan", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });
    const [leased] = store.takeAll("a");
    assert.ok(leased);

    store.remove("a", 10);
    store.retry("a", leased);

    assert.deepEqual(store.takeAll("a"), []);
  });

  it("berhenti mencoba setelah tiga kegagalan penghapusan", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [leased] = store.takeAll("a");
      assert.ok(leased);
      store.retry("a", leased);
    }

    assert.deepEqual(store.takeAll("a"), []);
  });

  it("menyelesaikan lease tanpa meninggalkan tombstone", () => {
    const store = new EphemeralMessageStore();
    store.add("a", { chatId: 1, messageId: 10 });
    store.takeAll("a");
    store.remove("a", 10);
    store.complete("a", 10);

    store.add("a", { chatId: 1, messageId: 10 });
    assert.deepEqual(store.takeAll("a"), [{ chatId: 1, messageId: 10 }]);
  });
});
