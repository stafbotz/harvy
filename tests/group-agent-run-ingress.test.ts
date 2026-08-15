import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GroupAgentRunIngressRouter,
  type GroupAgentRunIngressScheduler,
  type GroupAgentRunIngressTransport,
} from "../src/core/group-agent-run-ingress.js";
import {
  GroupAgentRunService,
  type GroupRunDeliveryAuthorityExpectation,
} from "../src/core/group-agent-run-service.js";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T06:00:00.000Z");

interface DeliveryRecord {
  target: Pick<GroupMessage, "scope" | "accountId">;
  text: string;
  quoteMessageId: string | undefined;
  idempotencyKey: string;
  authorityExpectation: GroupRunDeliveryAuthorityExpectation;
}

describe("GroupAgentRun guarded pre-batch ingress", () => {
  it("meneruskan mention/reply biasa, notice sentinel, dan bahaya tanpa mutasi", async () => {
    const fixture = await makeFixture();
    const active = await startAnchoredRun(fixture.service);

    for (const candidate of [
      message({
        messageId: "ambient-direct",
        text: "Harvy, besok kantin buka?",
        mentionsHarvy: true,
      }),
      message({
        messageId: "ordinary-reply",
        text: "terima kasih",
        repliesToHarvy: true,
        quotedMessageId: "unrelated-harvy-message",
      }),
      message({
        messageId: "notice-not-ready",
        text: "status pekerjaan ini?",
        mentionsHarvy: true,
        ingressRevision: 0,
      }),
      message({
        messageId: "danger-targeted",
        text: "aku mau bunuh diri sekarang",
        repliesToHarvy: true,
        quotedMessageId: active.anchor.messageId,
      }),
      message({
        messageId: "danger-inside-start",
        text: "Harvy, mulai pekerjaan: aku mau bunuh diri sekarang",
        mentionsHarvy: true,
      }),
    ]) {
      assert.equal(await fixture.router.handleObserved(candidate), "independent");
    }

    assert.equal((await fixture.repository.load(active.runId))?.inputs.length, 0);
    assert.deepEqual(fixture.attempts, []);
    assert.deepEqual(fixture.deliveries, []);
  });

  it("mengarantina envelope start cacat tanpa memutasi foreground aktif", async () => {
    const fixture = await makeFixture();
    const active = await startAnchoredRun(fixture.service);
    const malformed = message({
      messageId: "malformed-start-envelope",
      text: "Harvy, tolong mulai pekerjaan: ubah pekerjaan ini",
      mentionsHarvy: true,
    });

    assert.equal(await fixture.router.handleObserved(malformed), "independent");
    assert.equal((await fixture.repository.load(active.runId))?.inputs.length, 0);
    assert.deepEqual(fixture.attempts, []);
    assert.deepEqual(fixture.deliveries, []);
  });

  it("mengonsumsi target sebelum network, menyimpan input, dan replay tanpa ack kedua", async () => {
    const fixture = await makeFixture();
    const active = await startAnchoredRun(fixture.service);
    const gate = deferred();
    fixture.runtime.deliveryGate = gate.promise;
    const targeted = message({
      participantId: "p2",
      participantAliases: ["p2:device"],
      participantName: "Bima",
      messageId: "targeted-self-info",
      text: "aku tidak bisa Jumat sore",
      repliesToHarvy: true,
      quotedMessageId: active.anchor.messageId,
      ingressRevision: 2,
    });

    assert.equal(
      await settlesBeforeNetwork(fixture.router.handleObserved(targeted)),
      "consumed",
    );
    assert.equal(
      (await fixture.repository.load(active.runId))?.inputs.length,
      1,
    );
    assert.equal(fixture.deliveries.length, 0);

    gate.resolve();
    await fixture.router.drain();
    assert.equal(fixture.deliveries.length, 1);
    assert.match(fixture.deliveries[0]!.text, /terikat ke pekerjaan grup/iu);
    assert.equal(fixture.deliveries[0]!.quoteMessageId, targeted.messageId);
    assert.deepEqual(fixture.deliveries[0]!.authorityExpectation, {
      expectedAuthorityEpoch: 9,
      actors: [{
        participantIds: ["p2", "p2:device"],
        expectedRole: "member",
      }],
    });

    fixture.runtime.deliveryGate = null;
    assert.equal(await fixture.router.handleObserved(targeted), "consumed");
    await fixture.router.drain();
    assert.equal(fixture.deliveries.length, 1);
    assert.equal(
      (await fixture.repository.load(active.runId))?.inputs.length,
      1,
    );
  });

  it("mengirim status code-owned dengan key deterministik dan menjaga failure consumed", async () => {
    const fixture = await makeFixture();
    const active = await startAnchoredRun(fixture.service);
    const status = message({
      participantId: "admin-1",
      participantAliases: ["admin-1:device"],
      participantName: "Admin",
      isAdmin: true,
      messageId: "status-run",
      text: "status pekerjaan ini?",
      mentionsHarvy: true,
      ingressRevision: 3,
    });

    assert.equal(await fixture.router.handleObserved(status), "consumed");
    await fixture.router.drain();
    assert.match(fixture.deliveries[0]!.text, /^📌 /u);
    assert.doesNotMatch(
      fixture.deliveries[0]!.text,
      /model|tool|ETA|persen/iu,
    );
    assert.deepEqual(fixture.deliveries[0]!.authorityExpectation, {
      expectedAuthorityEpoch: 9,
      actors: [{
        participantIds: ["admin-1", "admin-1:device"],
        expectedRole: "admin",
      }],
    });
    const firstKey = fixture.deliveries[0]!.idempotencyKey;
    assert.match(firstKey, /^group-run-control-[a-f0-9]{64}$/u);

    assert.equal(await fixture.router.handleObserved(status), "consumed");
    await fixture.router.drain();
    assert.equal(fixture.deliveries[1]!.idempotencyKey, firstKey);

    fixture.runtime.failTransport = true;
    assert.equal(
      await fixture.router.handleObserved(message({
        participantId: "p3",
        participantName: "Citra",
        messageId: "forbidden-cancel",
        text: "batalkan pekerjaan ini",
        repliesToHarvy: true,
        quotedMessageId: active.anchor.messageId,
        ingressRevision: 4,
      })),
      "consumed",
    );
    await fixture.router.drain();
  });

  it("hanya exact start yang membuka foreground dan anchor memakai effect durable", async () => {
    const fixture = await makeFixture();
    const start = message({
      participantAliases: ["p1:device"],
      messageId: "exact-start",
      text: "Harvy, mulai pekerjaan: Atur jadwal presentasi",
      mentionsHarvy: true,
    });

    assert.equal(
      await fixture.router.handleObserved(message({
        messageId: "not-exact-start",
        text: "Harvy, tolong mulai pekerjaan presentasi",
        mentionsHarvy: true,
      })),
      "independent",
    );
    assert.equal(await fixture.router.handleObserved(start), "consumed");
    await fixture.router.drain();

    const active = await fixture.repository.loadLatestByScope(
      "whatsapp:ingress@g.us",
      "utama",
    );
    assert.ok(active);
    assert.equal(active.initialRequest, "Atur jadwal presentasi");
    assert.ok(active.anchor.messageId);
    assert.equal(fixture.deliveries.length, 1);
    assert.equal(
      fixture.deliveries[0]!.idempotencyKey,
      active.receipts[0]!.effectId,
    );
    assert.equal(fixture.deliveries[0]!.quoteMessageId, undefined);
    assert.deepEqual(fixture.deliveries[0]!.target, {
      scope: start.scope,
      accountId: start.accountId,
    });
    assert.deepEqual(fixture.deliveries[0]!.authorityExpectation, {
      expectedAuthorityEpoch: 9,
      actors: [{
        participantIds: ["p1", "p1:device"],
        expectedRole: "member",
      }],
    });
    assert.deepEqual(fixture.schedulerEvents, [{
      kind: "wake",
      runId: active.runId,
    }]);
  });

  it("memberi sinyal work hanya setelah anchor/applied dan interrupt saat cancel", async () => {
    const fixture = await makeFixture();
    const active = await startAnchoredRun(fixture.service);

    assert.equal(await fixture.router.handleObserved(message({
      messageId: "applied-correction",
      text: "ubah pekerjaan ini agar selesai hari Senin",
      repliesToHarvy: true,
      quotedMessageId: active.anchor.messageId,
      ingressRevision: 20,
    })), "consumed");
    assert.deepEqual(fixture.schedulerEvents, [
      { kind: "interrupt", runId: active.runId },
      { kind: "wake", runId: active.runId },
    ]);

    assert.equal(await fixture.router.handleObserved(message({
      messageId: "cancel-active-run",
      text: "batalkan pekerjaan ini",
      repliesToHarvy: true,
      quotedMessageId: active.anchor.messageId,
      ingressRevision: 21,
    })), "consumed");
    assert.deepEqual(fixture.schedulerEvents.at(-1), {
      kind: "interrupt",
      runId: active.runId,
    });
  });

  it("menyatukan start identik concurrent menjadi satu anchor", async () => {
    const fixture = await makeFixture();
    const start = message({
      messageId: "concurrent-same-start",
      text: "Harvy, mulai pekerjaan: Susun agenda rapat",
      mentionsHarvy: true,
    });

    assert.deepEqual(
      await Promise.all([
        fixture.router.handleObserved(start),
        fixture.router.handleObserved(structuredClone(start)),
      ]),
      ["consumed", "consumed"],
    );
    await fixture.router.drain();

    assert.equal(fixture.deliveries.length, 1);
    assert.equal((await fixture.repository.listActive()).length, 1);
  });

  it("menolak start distinct concurrent tanpa membocorkan detail foreground", async () => {
    const fixture = await makeFixture();
    const first = message({
      messageId: "concurrent-start-a",
      text: "Harvy, mulai pekerjaan: Agenda rahasia alfa",
      mentionsHarvy: true,
    });
    const second = message({
      messageId: "concurrent-start-b",
      text: "Harvy, mulai pekerjaan: Agenda rahasia beta",
      mentionsHarvy: true,
    });

    assert.deepEqual(
      await Promise.all([
        fixture.router.handleObserved(first),
        fixture.router.handleObserved(second),
      ]),
      ["consumed", "consumed"],
    );
    await fixture.router.drain();

    assert.equal((await fixture.repository.listActive()).length, 1);
    assert.equal(
      fixture.deliveries.filter((delivery) => delivery.text.startsWith("📌 "))
        .length,
      1,
    );
    const refusal = fixture.deliveries.find((delivery) =>
      delivery.text.includes("Sudah ada satu pekerjaan grup yang aktif")
    );
    assert.ok(refusal);
    assert.doesNotMatch(refusal.text, /alfa|beta|agenda rahasia/iu);
  });

  it("fail closed saat admission awal gagal dan fence akhir memblokir send", async () => {
    const denied = await makeFixture();
    denied.runtime.active = false;
    assert.equal(
      await denied.router.handleObserved(message({
        messageId: "runtime-denied",
        text: "Harvy, mulai pekerjaan: Tidak boleh dibuat",
        mentionsHarvy: true,
      })),
      "independent",
    );
    assert.equal((await denied.repository.listActive()).length, 0);

    const flipped = await makeFixture();
    flipped.runtime.beforeFinalFence = () => {
      flipped.runtime.active = false;
    };
    assert.equal(
      await flipped.router.handleObserved(message({
        messageId: "runtime-flip",
        text: "Harvy, mulai pekerjaan: Fence pengiriman",
        mentionsHarvy: true,
      })),
      "consumed",
    );
    await flipped.router.drain();
    assert.equal(flipped.attempts.length, 1);
    assert.equal(flipped.deliveries.length, 0);

    flipped.router.stopIngress();
    assert.equal(
      await flipped.router.handleObserved(message({
        messageId: "after-stop",
        text: "Harvy, mulai pekerjaan: Sesudah stop",
        mentionsHarvy: true,
      })),
      "independent",
    );
  });
});

async function makeFixture(): Promise<{
  service: GroupAgentRunService;
  repository: FileGroupAgentRunRepository;
  router: GroupAgentRunIngressRouter;
  attempts: DeliveryRecord[];
  deliveries: DeliveryRecord[];
  runtime: {
    active: boolean;
    beforeFinalFence: (() => void) | null;
    deliveryGate: Promise<void> | null;
    failTransport: boolean;
  };
  schedulerEvents: Array<{ kind: "wake" | "interrupt"; runId: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-ingress-"));
  const repository = new FileGroupAgentRunRepository(join(root, "runs.json"));
  const runtime = {
    active: true,
    beforeFinalFence: null as (() => void) | null,
    deliveryGate: null as Promise<void> | null,
    failTransport: false,
  };
  let sequence = 0;
  const admission = async () => runtime.active;
  const service = new GroupAgentRunService(
    repository,
    authorityResolver(),
    () => NOW,
    () => `ingress-${++sequence}`,
    admission,
  );
  const attempts: DeliveryRecord[] = [];
  const deliveries: DeliveryRecord[] = [];
  const schedulerEvents: Array<{
    kind: "wake" | "interrupt";
    runId: string;
  }> = [];
  const scheduler: GroupAgentRunIngressScheduler = {
    wake: (runId) => schedulerEvents.push({ kind: "wake", runId }),
    interrupt: (runId) =>
      schedulerEvents.push({ kind: "interrupt", runId }),
  };
  const transport: GroupAgentRunIngressTransport = {
    sendGroupRunMessage: async (
      target,
      text,
      quoteMessageId,
      idempotencyKey,
      authorityExpectation,
      runtimeFence,
    ) => {
      const record = {
        target: structuredClone(target),
        text,
        quoteMessageId,
        idempotencyKey,
        authorityExpectation: structuredClone(authorityExpectation),
      };
      attempts.push(record);
      if (runtime.deliveryGate) await runtime.deliveryGate;
      runtime.beforeFinalFence?.();
      if (!await runtimeFence()) throw new Error("runtime fence closed");
      if (runtime.failTransport) throw new Error("delivery unavailable");
      deliveries.push(record);
      return { messageId: `outbound-${deliveries.length}` };
    },
  };
  return {
    service,
    repository,
    router: new GroupAgentRunIngressRouter(
      service,
      transport,
      admission,
      undefined,
      scheduler,
    ),
    attempts,
    deliveries,
    runtime,
    schedulerEvents,
  };
}

async function startAnchoredRun(service: GroupAgentRunService) {
  const started = await service.start({
    message: message({
      messageId: "fixture-start-run",
      text: "Harvy, atur jadwal presentasi ini",
      mentionsHarvy: true,
    }),
  });
  return await service.commitAnchor(
    started.run.runId,
    started.run.stateRevision,
    "📌 Atur jadwal presentasi ini",
    async () => ({ messageId: "anchor-ingress" }),
  );
}

function authorityResolver(): GroupAuthorityResolver {
  return {
    resolveGroupAuthority: async (request: GroupAuthorityRequest) => ({
      role: request.claimedAdmin ? "admin" : "member",
      authorityEpoch: 9,
    }),
  };
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "ingress@g.us" },
    accountId: "utama",
    messageId: "message-ingress",
    participantId: "p1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup ingress",
    text: "halo",
    at: NOW.toISOString(),
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 9,
    ingressRevision: 1,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesBeforeNetwork(
  operation: Promise<"independent" | "consumed">,
): Promise<"independent" | "consumed"> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("ingress menunggu network")),
      3_000,
    );
    void operation.then(
      (outcome) => {
        clearTimeout(timeout);
        resolve(outcome);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
