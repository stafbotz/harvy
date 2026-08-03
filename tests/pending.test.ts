import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingStore } from "../src/bot/pending.js";

describe("langkah tertunda bertoken", () => {
  it("menolak tombol lama, pemilik lain, kedaluwarsa, dan klik ganda", () => {
    let now = 0;
    const store = new PendingStore(100, () => now);
    const first = store.set("a", {
      kind: "confirm-task",
      task: task("Pertama"),
    });
    const second = store.set("a", {
      kind: "confirm-task",
      task: task("Kedua"),
    });

    assert.equal(store.take("a", first), null);
    assert.equal(store.take("b", second), null);
    assert.equal(store.take("a", second)?.kind, "confirm-task");
    assert.equal(store.take("a", second), null);

    const expiring = store.set("a", {
      kind: "confirm-task",
      task: task("Ketiga"),
    });
    now = 100;
    assert.equal(store.take("a", expiring), null);
  });
});

function task(title: string) {
  return {
    title,
    dueAt: null,
    remindAt: null,
    importance: 2 as const,
  };
}
