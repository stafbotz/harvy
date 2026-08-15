import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import {
  GroupAgentRunRuntimeAdmissionError,
  GroupAgentRunService,
  type GroupAgentRunRuntimeAdmissionRequest,
  type GroupAgentRunRuntimeAdmissionResolver,
} from "../src/core/group-agent-run-service.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T08:00:00.000Z");

describe("GroupAgentRun runtime mutation admission", () => {
  it("menolak start tanpa menulis record dan tidak memberikan isi bubble ke resolver", async () => {
    const requests: GroupAgentRunRuntimeAdmissionRequest[] = [];
    const fixture = await makeFixture(async (request) => {
      requests.push(structuredClone(request));
      return false;
    });

    await assertRuntimeInactive(
      fixture.service.start({ message: message({ text: "rahasia bubble" }) }),
    );

    assert.deepEqual(requests, [{
      scopeKey: "whatsapp:runtime-admission@g.us",
      accountId: "utama",
    }]);
    assert.deepEqual(await fixture.repository.listActive(), []);
  });

  it("merevalidasi admission di dalam create guard", async () => {
    let checks = 0;
    const fixture = await makeFixture(async () => ++checks === 1);

    await assertRuntimeInactive(
      fixture.service.start({ message: message() }),
    );

    assert.equal(checks, 2);
    assert.deepEqual(await fixture.repository.listActive(), []);
  });

  it("menolak route mutation yang berubah sebelum save tanpa menambah input", async () => {
    let phase: "start" | "route" = "start";
    let routeChecks = 0;
    const fixture = await makeFixture(async () =>
      phase === "start" ? true : ++routeChecks === 1
    );
    const run = await startRun(fixture.service);
    phase = "route";

    const routed = await fixture.service.routeMessage(message({
      messageId: "cancel-runtime-race",
      text: "batalkan pekerjaan ini",
      mentionsHarvy: false,
      ingressRevision: 2,
    }));

    assert.equal(routed.status, "forbidden");
    if (routed.status !== "forbidden") assert.fail("route harus ditolak");
    assert.equal(routed.reason, "runtime_inactive");
    assert.equal(routeChecks, 2);
    const stored = await fixture.repository.load(run.runId);
    assert.equal(stored?.inputs.length, 0);
    assert.equal(stored?.status, "queued");
  });

  it("merevalidasi admission di prepare guard sebelum membuat pending effect", async () => {
    let phase: "start" | "delivery" = "start";
    let deliveryChecks = 0;
    const fixture = await makeFixture(async () =>
      phase === "start" ? true : ++deliveryChecks === 1
    );
    const run = await startRun(fixture.service);
    phase = "delivery";
    let sends = 0;

    await assertRuntimeInactive(fixture.service.commitAnchor(
      run.runId,
      run.stateRevision,
      "📌 Pekerjaan runtime admission",
      async () => {
        sends += 1;
        return { messageId: "tidak-boleh-terkirim" };
      },
    ));

    assert.equal(deliveryChecks, 2);
    assert.equal(sends, 0);
    const stored = await fixture.repository.load(run.runId);
    assert.equal(stored?.pendingEffect, null);
    assert.deepEqual(stored?.receipts, []);
  });

  it("menandai pending delivery not_committed bila admission padam sebelum transport", async () => {
    let phase: "start" | "delivery" = "start";
    let deliveryChecks = 0;
    const fixture = await makeFixture(async () =>
      phase === "start" ? true : ++deliveryChecks < 3
    );
    const run = await startRun(fixture.service);
    phase = "delivery";
    let sends = 0;

    await assertRuntimeInactive(fixture.service.commitAnchor(
      run.runId,
      run.stateRevision,
      "📌 Pekerjaan runtime admission",
      async () => {
        sends += 1;
        return { messageId: "tidak-boleh-terkirim" };
      },
    ));

    assert.equal(deliveryChecks, 3);
    assert.equal(sends, 0);
    const stored = await fixture.repository.load(run.runId);
    assert.equal(stored?.pendingEffect, null);
    assert.equal(stored?.anchor.messageId, null);
    assert.equal(stored?.receipts.length, 1);
    assert.equal(stored?.receipts[0]?.status, "not_committed");
  });

  it("gagal tertutup ketika resolver admission melempar error", async () => {
    const fixture = await makeFixture(async () => {
      throw new Error("control plane unavailable");
    });

    await assertRuntimeInactive(
      fixture.service.start({ message: message() }),
    );
    assert.deepEqual(await fixture.repository.listActive(), []);
  });
});

async function makeFixture(
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver,
): Promise<{
  service: GroupAgentRunService;
  repository: FileGroupAgentRunRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-runtime-"));
  const repository = new FileGroupAgentRunRepository(join(root, "runs.json"));
  let sequence = 0;
  return {
    repository,
    service: new GroupAgentRunService(
      repository,
      authorityResolver(),
      () => NOW,
      () => `runtime-${++sequence}`,
      runtimeAdmission,
    ),
  };
}

async function startRun(service: GroupAgentRunService) {
  const started = await service.start({ message: message() });
  assert.equal(started.status, "started");
  return started.run;
}

async function assertRuntimeInactive(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof GroupAgentRunRuntimeAdmissionError &&
      error.code === "runtime_inactive",
  );
}

function authorityResolver(): GroupAuthorityResolver {
  return {
    resolveGroupAuthority: async (_request: GroupAuthorityRequest) => ({
      role: "member",
      authorityEpoch: 11,
    }),
  };
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "runtime-admission@g.us" },
    accountId: "utama",
    messageId: "start-runtime-admission",
    participantId: "p1",
    participantAliases: ["p1-alt"],
    participantName: "Ayu",
    groupName: "Grup runtime admission",
    text: "Harvy, mulai pekerjaan untuk menyusun jadwal presentasi",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 11,
    ingressRevision: 1,
    ...overrides,
  };
}
