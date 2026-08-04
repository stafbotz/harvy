import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ActiveSessionError,
  SessionService,
} from "../src/core/session-service.js";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../src/domain/session.js";
import { FileSessionRepository } from "../src/storage/file-session-repository.js";

class MemorySessionRepository
  implements SessionRepository, DueCheckInSource
{
  private readonly sessions = new Map<string, ActiveSession>();

  async load(ownerId: string): Promise<ActiveSession | null> {
    return this.sessions.get(ownerId) ?? null;
  }

  async save(session: ActiveSession): Promise<void> {
    this.sessions.set(session.ownerId, structuredClone(session));
  }

  async remove(ownerId: string): Promise<boolean> {
    return this.sessions.delete(ownerId);
  }

  async listDueCheckIns(now: Date): Promise<ActiveSession[]> {
    return [...this.sessions.values()].filter(
      (session) =>
        new Date(session.expiresAt).getTime() > now.getTime() &&
        session.checkIn !== null &&
        session.checkIn.sentAt === null &&
        new Date(session.checkIn.at).getTime() <= now.getTime(),
    );
  }
}

function fixture(): {
  repository: MemorySessionRepository;
  service: SessionService;
  setNow(value: string): void;
} {
  const repository = new MemorySessionRepository();
  let now = new Date("2026-07-27T10:00:00.000Z");
  return {
    repository,
    service: new SessionService(repository, repository, () => now),
    setNow(value: string): void {
      now = new Date(value);
    },
  };
}

describe("SessionService", () => {
  it("menjamin hanya satu start serentak per pemilik", async () => {
    const { service } = fixture();
    const input = {
      ownerId: "student",
      chatId: "chat",
      kind: "focus" as const,
      goal: "mulai laporan",
    };

    const results = await Promise.allSettled([
      service.start(input),
      service.start({ ...input, goal: "tujuan lain" }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    assert.ok(rejected?.reason instanceof ActiveSessionError);
  });

  it("inspectActive tidak mengubah storage ketika sesi sudah kedaluwarsa", async () => {
    const { service, repository, setNow } = fixture();
    const session = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "mengerjakan laporan",
    });
    setNow(session.expiresAt);

    assert.equal(await service.inspectActive("student"), null);
    assert.notEqual(await repository.load("student"), null);
    assert.equal(await service.active("student"), null);
    assert.equal(await repository.load("student"), null);
  });

  it("tidak menyimpan sesi bila giliran pertamanya gagal dikirim", async () => {
    const { service } = fixture();
    const input = {
      ownerId: "student",
      chatId: "chat",
      kind: "focus" as const,
      goal: "mulai laporan",
    };

    await assert.rejects(
      service.startAfterDelivery(input, async () => {
        throw new Error("Telegram putus");
      }),
      /Telegram putus/u,
    );

    assert.equal(await service.active("student"), null);
    const started = await service.startAfterDelivery(
      input,
      async () => undefined,
    );
    assert.equal((await service.active("student"))?.id, started.id);
  });

  it("membersihkan state parsial dan UI bila simpan gagal sesudah delivery", async () => {
    let stored: ActiveSession | null = null;
    let compensated = 0;
    const repository: SessionRepository & DueCheckInSource = {
      async load(ownerId): Promise<ActiveSession | null> {
        return stored?.ownerId === ownerId ? stored : null;
      },
      async save(session): Promise<void> {
        stored = structuredClone(session);
        throw new Error("save sesi gagal");
      },
      async remove(ownerId): Promise<boolean> {
        if (stored?.ownerId !== ownerId) return false;
        stored = null;
        return true;
      },
      async listDueCheckIns(): Promise<ActiveSession[]> {
        return [];
      },
    };
    const service = new SessionService(repository, repository);

    await assert.rejects(
      service.startAfterDelivery(
        {
          ownerId: "student",
          chatId: "chat",
          kind: "focus",
          goal: "mulai laporan",
        },
        async () => undefined,
        async () => {
          compensated += 1;
        },
      ),
      /save sesi gagal/u,
    );

    assert.equal(stored, null);
    assert.equal(compensated, 1);
  });

  it("menjalankan lima tahap tutor tanpa memajukan sinyal kosong", async () => {
    const { service } = fixture();
    const session = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "tutor",
      goal: "paham fotosintesis",
    });

    assert.equal(session.stage, "assess");
    assert.equal(
      (await service.progress("student", null, session.id))?.stage,
      "assess",
    );
    assert.equal(
      (await service.progress("student", "continue", session.id))?.stage,
      "attempt",
    );
    assert.equal(
      (await service.progress("student", "stuck", session.id))?.stage,
      "hint",
    );
    assert.equal(
      (await service.progress("student", "stuck", session.id))?.stage,
      "explain",
    );
    assert.equal(
      (await service.progress("student", "continue", session.id))?.stage,
      "retry",
    );
  });

  it("menolak callback sesi lama mengubah sesi baru", async () => {
    const { service } = fixture();
    const old = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "lama",
    });
    await service.stop("student");
    const current = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "baru",
    });

    assert.equal(
      await service.progress("student", "done", old.id),
      null,
    );
    assert.equal((await service.active("student"))?.id, current.id);
  });

  it("baru mengomit transisi setelah kiriman berhasil", async () => {
    const { service } = fixture();
    const session = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "satu langkah",
    });

    await assert.rejects(
      service.progressAfterDelivery(
        "student",
        "stuck",
        session.id,
        async () => {
          throw new Error("Telegram gagal");
        },
      ),
    );
    assert.equal((await service.active("student"))?.stage, "act");
  });

  it("menjadwalkan waktu sah dan mengirim check-in tepat sekali", async () => {
    const { service, setNow } = fixture();
    const session = await service.start({
      ownerId: "student",
      chatId: "chat",
      kind: "focus",
      goal: "satu langkah",
    });

    assert.equal(
      await service.scheduleCheckIn(
        "student",
        new Date(Number.NaN),
        session.id,
      ),
      null,
    );
    const scheduled = await service.scheduleCheckIn(
      "student",
      new Date("2026-07-27T11:00:00.000Z"),
      session.id,
    );
    assert.equal(scheduled?.checkIn?.sentAt, null);

    setNow("2026-07-27T11:00:00.000Z");
    const due = await service.dueCheckIns();
    assert.equal(due.length, 1);
    let deliveries = 0;
    assert.equal(
      await service.deliverCheckIn(due[0]!, async () => {
        deliveries += 1;
      }),
      true,
    );
    assert.equal(
      await service.deliverCheckIn(due[0]!, async () => {
        deliveries += 1;
      }),
      false,
    );
    assert.equal(deliveries, 1);
  });
});

describe("FileSessionRepository", () => {
  it("bertahan setelah adapter dibuat ulang tanpa mencampur pemilik", async () => {
    const folder = await mkdtemp(join(tmpdir(), "harvy-session-"));
    const path = join(folder, "sessions.json");
    try {
      const first = new FileSessionRepository(path);
      const service = new SessionService(first, first, () =>
        new Date("2026-07-27T10:00:00.000Z"),
      );
      const saved = await service.start({
        ownerId: "a",
        chatId: "chat-a",
        kind: "plan",
        goal: "rencana ujian",
      });

      const reopened = new FileSessionRepository(path);
      assert.equal((await reopened.load("a"))?.id, saved.id);
      assert.equal(await reopened.load("b"), null);
      assert.match(await readFile(path, "utf8"), /rencana ujian/u);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
