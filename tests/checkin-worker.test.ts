import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProfileService } from "../src/core/profile-service.js";
import { SessionService } from "../src/core/session-service.js";
import type { AppConfig } from "../src/config.js";
import type { TelemetryService } from "../src/core/telemetry-service.js";
import type { UserProfile, ProfileRepository } from "../src/domain/profile.js";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../src/domain/session.js";
import {
  runCheckInsOnce,
  startCheckInWorker,
} from "../src/reminders/checkin-worker.js";

class SessionMemory implements SessionRepository, DueCheckInSource {
  value: ActiveSession | null = null;

  async load(ownerId: string): Promise<ActiveSession | null> {
    return this.value?.ownerId === ownerId ? structuredClone(this.value) : null;
  }

  async save(session: ActiveSession): Promise<void> {
    this.value = structuredClone(session);
  }

  async remove(ownerId: string): Promise<boolean> {
    if (this.value?.ownerId !== ownerId) return false;
    this.value = null;
    return true;
  }

  async listDueCheckIns(now: Date): Promise<ActiveSession[]> {
    return this.value?.checkIn &&
      this.value.checkIn.sentAt === null &&
      new Date(this.value.checkIn.at).getTime() <= now.getTime()
      ? [structuredClone(this.value)]
      : [];
  }
}

class ProfileMemory implements ProfileRepository {
  value: UserProfile | null = null;

  async find(ownerId: string): Promise<UserProfile | null> {
    return this.value?.ownerId === ownerId ? this.value : null;
  }

  async save(profile: UserProfile): Promise<void> {
    this.value = structuredClone(profile);
  }

  async remove(ownerId: string): Promise<boolean> {
    if (this.value?.ownerId !== ownerId) return false;
    this.value = null;
    return true;
  }

  async listDeletionRequested(): Promise<UserProfile[]> {
    return this.value?.deletionRequestedAt ? [this.value] : [];
  }
}

describe("worker check-in", () => {
  it("menunggu jam tenang berakhir, lalu mengirim tepat sekali", async () => {
    const sessionRepository = new SessionMemory();
    let serviceNow = new Date("2026-07-27T10:00:00.000Z");
    const sessions = new SessionService(
      sessionRepository,
      sessionRepository,
      () => serviceNow,
    );
    const session = await sessions.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "langkah kecil",
    });
    await sessions.scheduleCheckIn(
      "student",
      new Date("2026-07-27T14:30:00.000Z"),
      session.id,
    );

    const profileRepository = new ProfileMemory();
    const profiles = new ProfileService(profileRepository);
    await profiles.acceptConsent("student");
    await profiles.setTimeZone("student", "Asia/Jakarta");
    await profiles.setQuietHours("student", {
      startMinute: 21 * 60,
      endMinute: 6 * 60,
    });

    let sent = 0;
    const events: string[] = [];
    const bot = {
      async sendCheckIn(candidate: ActiveSession): Promise<boolean> {
        return sessions.deliverCheckIn(candidate, async () => {
          sent += 1;
        });
      },
    };
    const telemetry = {
      async event(_ownerId: string, kind: string): Promise<void> {
        events.push(kind);
      },
    };
    const config = { defaultTimezone: "Asia/Jakarta" };

    serviceNow = new Date("2026-07-27T14:30:00.000Z");
    await runCheckInsOnce(
      bot,
      sessions,
      profiles,
      telemetry,
      config,
      serviceNow,
    );
    assert.equal(sent, 0);

    serviceNow = new Date("2026-07-27T23:00:00.000Z");
    await runCheckInsOnce(
      bot,
      sessions,
      profiles,
      telemetry,
      config,
      serviceNow,
    );
    await runCheckInsOnce(
      bot,
      sessions,
      profiles,
      telemetry,
      config,
      serviceNow,
    );
    assert.equal(sent, 1);
    assert.deepEqual(events, ["checkin_sent"]);
  });

  it("melewati profil yang sedang dihapus", async () => {
    const sessionRepository = new SessionMemory();
    let now = new Date("2026-07-27T10:00:00.000Z");
    const sessions = new SessionService(
      sessionRepository,
      sessionRepository,
      () => now,
    );
    const session = await sessions.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "langkah",
    });
    await sessions.scheduleCheckIn(
      "student",
      new Date("2026-07-27T11:00:00.000Z"),
      session.id,
    );
    now = new Date("2026-07-27T12:00:00.000Z");

    const profileRepository = new ProfileMemory();
    const profiles = new ProfileService(profileRepository, () => now);
    await profiles.acceptConsent("student");
    await profiles.markDeletionRequested("student");

    let sent = 0;
    await runCheckInsOnce(
      {
        async sendCheckIn(): Promise<boolean> {
          sent += 1;
          return true;
        },
      },
      sessions,
      profiles,
      { async event(): Promise<void> {} },
      { defaultTimezone: "Asia/Jakarta" },
      now,
    );
    assert.equal(sent, 0);
  });

  it("menahan check-in selama izin AI ditarik tanpa menghapus sesinya", async () => {
    const sessionRepository = new SessionMemory();
    const now = new Date("2026-07-27T12:00:00.000Z");
    const sessions = new SessionService(
      sessionRepository,
      sessionRepository,
      () => now,
    );
    const session = await sessions.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "langkah",
    });
    await sessions.scheduleCheckIn(
      "student",
      new Date("2026-07-27T11:00:00.000Z"),
      session.id,
    );

    const profileRepository = new ProfileMemory();
    const profiles = new ProfileService(profileRepository, () => now);
    await profiles.acceptConsent("student");
    await profiles.withdrawConsent("student");

    let sent = 0;
    await runCheckInsOnce(
      {
        async sendCheckIn(): Promise<boolean> {
          sent += 1;
          return true;
        },
      },
      sessions,
      profiles,
      { async event(): Promise<void> {} },
      { defaultTimezone: "Asia/Jakarta" },
      now,
    );

    assert.equal(sent, 0);
    assert.equal((await sessions.active("student"))?.id, session.id);
  });

  it("menangani kegagalan baca kandidat dan mencoba lagi", async () => {
    let reads = 0;
    const worker = startCheckInWorker(
      {
        async sendCheckIn(): Promise<boolean> {
          return true;
        },
      } as never,
      {
        async dueCheckIns(): Promise<ActiveSession[]> {
          reads += 1;
          if (reads === 1) throw new Error("repository sementara gagal");
          return [];
        },
      } as unknown as SessionService,
      {} as ProfileService,
      {} as TelemetryService,
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
