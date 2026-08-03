import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shutdownGracefully } from "../src/core/shutdown-service.js";

describe("shutdown Harvy", () => {
  it("menguras bot sesudah worker selesai menambahkan pekerjaan terakhir", async () => {
    const order: string[] = [];
    const worker = {
      stop(): void {
        order.push("worker-stop");
      },
      async drain(): Promise<void> {
        order.push("worker-event");
      },
    };
    const bot = {
      async stop(): Promise<void> {
        order.push("bot-stop");
      },
      async drainPending(): Promise<void> {
        order.push("bot-drain");
      },
    };

    await shutdownGracefully(bot, worker);

    assert.deepEqual(order, [
      "worker-stop",
      "bot-stop",
      "worker-event",
      "bot-drain",
    ]);
  });
});
