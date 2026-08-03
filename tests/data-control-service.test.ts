import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataControlService } from "../src/core/data-control-service.js";
import { emptyProfile } from "../src/core/profile-service.js";
import type { HistoryService } from "../src/core/history-service.js";
import type { InsightService } from "../src/core/insight-service.js";
import type { MemoryService } from "../src/core/memory-service.js";
import type { ProfileService } from "../src/core/profile-service.js";
import type { SessionService } from "../src/core/session-service.js";
import type { TaskService } from "../src/core/task-service.js";
import type { TelemetryService } from "../src/core/telemetry-service.js";

function cast<T>(value: object): T {
  return value as T;
}

describe("DataControlService", () => {
  it("memasang tombstone pertama dan menghapus profil terakhir", async () => {
    const calls: string[] = [];
    const service = new DataControlService(
      cast<TaskService>({
        async removeAll(): Promise<number> {
          calls.push("tasks");
          return 1;
        },
      }),
      cast<MemoryService>({
        async forgetAll(): Promise<number> {
          calls.push("memories");
          return 1;
        },
      }),
      cast<HistoryService>({
        async forget(): Promise<void> {
          calls.push("history");
        },
      }),
      cast<ProfileService>({
        async markDeletionRequested(): Promise<void> {
          calls.push("tombstone");
        },
        async remove(): Promise<boolean> {
          calls.push("profile");
          return true;
        },
      }),
      cast<InsightService>({
        async forget(): Promise<void> {
          calls.push("insight");
        },
      }),
      cast<SessionService>({
        async forget(): Promise<void> {
          calls.push("session");
        },
      }),
      cast<TelemetryService>({
        async forget(): Promise<void> {
          calls.push("telemetry");
        },
      }),
    );

    await service.deleteAll("student");
    assert.equal(calls[0], "tombstone");
    assert.equal(calls.at(-1), "profile");
    assert.deepEqual(new Set(calls), new Set([
      "tombstone",
      "session",
      "tasks",
      "history",
      "insight",
      "memories",
      "telemetry",
      "profile",
    ]));
  });

  it("tidak menghapus tombstone bila satu penyimpanan gagal", async () => {
    let profileRemoved = false;
    const service = deletionFixture({
      tasks: {
        async removeAll(): Promise<number> {
          throw new Error("disk gagal");
        },
      },
      profiles: {
        async markDeletionRequested(): Promise<void> {},
        async remove(): Promise<boolean> {
          profileRemoved = true;
          return true;
        },
      },
    });

    await assert.rejects(service.deleteAll("student"), /disk gagal/u);
    assert.equal(profileRemoved, false);
  });

  it("melanjutkan owner lain ketika satu tombstone gagal dipulihkan", async () => {
    const removed: string[] = [];
    const service = deletionFixture({
      tasks: {
        async removeAll(ownerId: string): Promise<number> {
          if (ownerId === "a") throw new Error("a gagal");
          return 0;
        },
      },
      profiles: {
        async deletionRequests() {
          return [
            { ...emptyProfile("a"), deletionRequestedAt: "2026-07-27T00:00:00Z" },
            { ...emptyProfile("b"), deletionRequestedAt: "2026-07-27T00:00:00Z" },
          ];
        },
        async markDeletionRequested(): Promise<void> {},
        async remove(ownerId: string): Promise<boolean> {
          removed.push(ownerId);
          return true;
        },
      },
    });

    await assert.rejects(service.resumePendingDeletions(), AggregateError);
    assert.deepEqual(removed, ["b"]);
  });

  it("mengekspor semua telemetry terlihat tetapi tidak membuka insight", async () => {
    let insightRead = false;
    const service = new DataControlService(
      cast<TaskService>({
        async listAll() {
          return [];
        },
      }),
      cast<MemoryService>({
        async list() {
          return [];
        },
      }),
      cast<HistoryService>({
        async snapshot() {
          return null;
        },
      }),
      cast<ProfileService>({
        async load() {
          return emptyProfile("student");
        },
      }),
      cast<InsightService>({
        async load() {
          insightRead = true;
          return null;
        },
      }),
      cast<SessionService>({
        async active() {
          return null;
        },
      }),
      cast<TelemetryService>({
        async summary() {
          return {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            estimatedCostUsd: 0,
            limit: 100,
          };
        },
        async export() {
          return {
            usage: [],
            events: [
              {
                id: "event",
                ownerId: "student",
                kind: "data_exported",
                at: "2026-07-27T00:00:00.000Z",
              },
            ],
          };
        },
      }),
      () => new Date("2026-07-27T10:00:00.000Z"),
    );

    const exported = await service.export("student");
    assert.equal(exported.aiTelemetryRetained.events.length, 1);
    assert.equal(exported.hiddenSafetyData.included, false);
    assert.equal(insightRead, false);
  });
});

function deletionFixture(overrides: {
  tasks?: object;
  profiles?: object;
}): DataControlService {
  return new DataControlService(
    cast<TaskService>({
      async removeAll(): Promise<number> {
        return 0;
      },
      ...overrides.tasks,
    }),
    cast<MemoryService>({
      async forgetAll(): Promise<number> {
        return 0;
      },
    }),
    cast<HistoryService>({
      async forget(): Promise<void> {},
    }),
    cast<ProfileService>({
      async deletionRequests() {
        return [];
      },
      async markDeletionRequested(): Promise<void> {},
      async remove(): Promise<boolean> {
        return true;
      },
      ...overrides.profiles,
    }),
    cast<InsightService>({
      async forget(): Promise<void> {},
    }),
    cast<SessionService>({
      async forget(): Promise<void> {},
    }),
    cast<TelemetryService>({
      async forget(): Promise<void> {},
    }),
  );
}
