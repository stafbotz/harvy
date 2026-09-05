import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEARNING_TRACE_TOPIC_MAX_CHARACTERS,
  LearningTraceService,
} from "../src/core/learning-trace-service.js";
import { SessionService } from "../src/core/session-service.js";
import type {
  LearningTrace,
  LearningTraceRepository,
} from "../src/domain/learning-trace.js";
import type {
  ActiveSession,
  SessionKind,
  SessionRepository,
  SessionStage,
} from "../src/domain/session.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");

class TraceStore implements LearningTraceRepository {
  rows: LearningTrace[] = [];

  async save(trace: LearningTrace): Promise<void> {
    this.rows.push(trace);
  }

  async list(ownerId: string): Promise<LearningTrace[]> {
    return this.rows.filter((row) => row.ownerId === ownerId);
  }

  async removeAll(ownerId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.ownerId !== ownerId);
    return before - this.rows.length;
  }
}

class SessionStore implements SessionRepository {
  session: ActiveSession | null = null;

  async load(): Promise<ActiveSession | null> {
    return this.session;
  }

  async save(session: ActiveSession): Promise<void> {
    this.session = session;
  }

  async remove(): Promise<boolean> {
    const had = this.session !== null;
    this.session = null;
    return had;
  }

  async listDueCheckIns(): Promise<ActiveSession[]> {
    return [];
  }
}

function session(
  kind: SessionKind,
  stage: SessionStage,
  goal = "Turunan fungsi aljabar",
): ActiveSession {
  return {
    id: "sesi-1",
    ownerId: "ayu",
    chatId: "123",
    kind,
    goal,
    stage,
    taskId: null,
    checkIn: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  };
}

describe("jejak sesi belajar", () => {
  it("mencatat sesi tutor yang selesai beserta kedalaman bantuannya", async () => {
    const store = new TraceStore();
    await new LearningTraceService(store, () => NOW)
      .recordCompleted(session("tutor", "attempt"));

    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.topic, "Turunan fungsi aljabar");
    assert.equal(store.rows[0]?.depth, "mandiri");
    assert.equal(store.rows[0]?.deepestStage, "attempt");
  });

  it("mencatat sesi yang perlu dijelaskan sebagai bantuan terdalam", async () => {
    const store = new TraceStore();
    await new LearningTraceService(store, () => NOW)
      .recordCompleted(session("tutor", "explain"));
    assert.equal(store.rows[0]?.depth, "dijelaskan");
  });

  it("tidak mencatat kind selain tutor", async () => {
    // Tahap kind lain bukan tangga kedalaman; mencatatnya menghasilkan angka
    // yang terlihat berarti padahal tidak.
    const store = new TraceStore();
    const service = new LearningTraceService(store, () => NOW);
    for (const kind of ["clarify", "prioritize", "focus", "plan"] as const) {
      await service.recordCompleted(session(kind, "act"));
    }
    assert.deepEqual(store.rows, []);
  });

  it("memotong topik yang terlalu panjang", async () => {
    const store = new TraceStore();
    await new LearningTraceService(store, () => NOW).recordCompleted(
      session("tutor", "attempt", "a".repeat(400)),
    );
    assert.equal(
      store.rows[0]?.topic.length,
      LEARNING_TRACE_TOPIC_MAX_CHARACTERS,
    );
  });

  it("tidak pernah menahan penutupan sesi ketika penyimpanan gagal", async () => {
    const rusak: LearningTraceRepository = {
      save: async () => {
        throw new Error("disk penuh");
      },
      list: async () => {
        throw new Error("disk penuh");
      },
      removeAll: async () => {
        throw new Error("disk penuh");
      },
    };
    const service = new LearningTraceService(rusak, () => NOW);
    await service.recordCompleted(session("tutor", "attempt"));
    assert.deepEqual(await service.list("ayu"), []);
    assert.equal(await service.forgetOwner("ayu"), 0);
  });
});

describe("sesi yang selesai meninggalkan jejak", () => {
  function services() {
    const traces = new TraceStore();
    const sessions = new SessionStore();
    return {
      traces,
      sessions,
      service: new SessionService(
        sessions,
        sessions,
        () => NOW,
        new LearningTraceService(traces, () => NOW),
      ),
    };
  }

  it("mencatat ketika sesi tutor ditutup dengan done", async () => {
    const { traces, sessions, service } = services();
    sessions.session = session("tutor", "attempt");

    assert.equal(await service.progress("ayu", "done"), null);
    assert.equal(sessions.session, null);
    assert.equal(traces.rows.length, 1);
    assert.equal(traces.rows[0]?.depth, "mandiri");
  });

  it("tidak mencatat ketika sesi dibatalkan", async () => {
    // Membatalkan bukan menyelesaikan. Menghitungnya sebagai kemajuan akan
    // membuat Harvy mundur dari bantuan justru ketika pelajarnya menyerah.
    const { traces, sessions, service } = services();
    sessions.session = session("tutor", "attempt");

    assert.equal(await service.progress("ayu", "cancel"), null);
    assert.equal(sessions.session, null);
    assert.deepEqual(traces.rows, []);
  });
});

describe("bantuan yang memudar pada sesi berikutnya", () => {
  it("membuka dari assess ketika belum ada jejak", async () => {
    const traces = new TraceStore();
    const sessions = new SessionStore();
    const service = new SessionService(
      sessions,
      sessions,
      () => NOW,
      new LearningTraceService(traces, () => NOW),
    );

    const started = await service.start({
      ownerId: "ayu",
      chatId: "123",
      kind: "tutor",
      goal: "Turunan fungsi aljabar",
    });
    assert.equal(started.stage, "assess");
  });

  it("melewati assess setelah tiga kali diselesaikan sendiri", async () => {
    const traces = new TraceStore();
    const sessions = new SessionStore();
    const learning = new LearningTraceService(traces, () => NOW);
    const service = new SessionService(sessions, sessions, () => NOW, learning);

    for (let index = 0; index < 3; index += 1) {
      await learning.recordCompleted(session("tutor", "attempt"));
    }

    const started = await service.start({
      ownerId: "ayu",
      chatId: "123",
      kind: "tutor",
      goal: "Turunan fungsi aljabar",
    });
    assert.equal(started.stage, "attempt");
  });

  it("tidak memudar untuk topik lain", async () => {
    const traces = new TraceStore();
    const sessions = new SessionStore();
    const learning = new LearningTraceService(traces, () => NOW);
    const service = new SessionService(sessions, sessions, () => NOW, learning);

    for (let index = 0; index < 3; index += 1) {
      await learning.recordCompleted(session("tutor", "attempt"));
    }

    const started = await service.start({
      ownerId: "ayu",
      chatId: "123",
      kind: "tutor",
      goal: "Integral tentu",
    });
    assert.equal(started.stage, "assess");
  });

  it("tidak mengubah kind selain tutor", async () => {
    const traces = new TraceStore();
    const sessions = new SessionStore();
    const service = new SessionService(
      sessions,
      sessions,
      () => NOW,
      new LearningTraceService(traces, () => NOW),
    );

    const started = await service.start({
      ownerId: "ayu",
      chatId: "123",
      kind: "focus",
      goal: "Mulai dari soal termudah",
    });
    assert.notEqual(started.stage, "attempt");
  });

  it("mempertahankan perilaku lama tanpa layanan jejak", async () => {
    const sessions = new SessionStore();
    const service = new SessionService(sessions, sessions, () => NOW);

    const started = await service.start({
      ownerId: "ayu",
      chatId: "123",
      kind: "tutor",
      goal: "Turunan fungsi aljabar",
    });
    assert.equal(started.stage, "assess");
  });
});
