import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import type { ProfileService } from "../src/core/profile-service.js";
import type { TaskService } from "../src/core/task-service.js";
import { startReminderWorker } from "../src/reminders/reminder-worker.js";

describe("worker pengingat", () => {
  it("tidak mengirim reminder setelah consent AI ditarik", async () => {
    let sends = 0;
    const worker = startReminderWorker(
      {
        async sendReminder(): Promise<boolean> {
          sends += 1;
          return true;
        },
      } as never,
      {
        async dueReminders(): Promise<unknown[]> {
          return [{ ownerId: "student" }];
        },
      } as unknown as TaskService,
      {
        async load(): Promise<{ deletionRequestedAt: null }> {
          return { deletionRequestedAt: null };
        },
        async needsOnboarding(): Promise<boolean> {
          return true;
        },
      } as unknown as ProfileService,
      {
        reminderIntervalMs: 60_000,
        defaultTimezone: "Asia/Jakarta",
      } as AppConfig,
    );

    worker.stop();
    await worker.drain();

    assert.equal(sends, 0);
  });

  it("menangani kegagalan baca kandidat dan mencoba lagi pada tick berikutnya", async () => {
    let reads = 0;
    const worker = startReminderWorker(
      {
        async sendReminder(): Promise<boolean> {
          return true;
        },
      } as never,
      {
        async dueReminders(): Promise<never[]> {
          reads += 1;
          if (reads === 1) throw new Error("disk sementara gagal");
          return [];
        },
      } as unknown as TaskService,
      {} as ProfileService,
      {
        reminderIntervalMs: 10,
        defaultTimezone: "Asia/Jakarta",
      } as AppConfig,
    );

    await delay(45);
    worker.stop();
    await worker.drain();

    assert.ok(reads >= 2);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
