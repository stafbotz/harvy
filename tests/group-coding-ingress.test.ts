import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GroupCodingIngressRouter,
  parseGroupCodingCommand,
} from "../src/core/group-coding-ingress.js";
import type { GroupCodingDeliveryService } from
  "../src/core/group-coding-delivery-service.js";
import type {
  AuthenticatedGroupCodingActor,
  GroupWorkspaceCodingController,
} from "../src/core/group-workspace-coding-controller.js";
import type { GroupMessage } from "../src/domain/group.js";
import type { GroupSafeCodingRunView } from "../src/domain/group-coding.js";
import type { CodingRun } from "../src/domain/coding-run.js";
import { CodingRunProgressHub } from "../src/core/coding-run-progress-hub.js";

describe("GroupCodingIngressRouter", () => {
  it("keeps ambient chatter and urgent danger in their independent lanes", async () => {
    const fixture = createFixture();
    assert.equal(
      await fixture.router.handleObserved(message({
        text: "coding: perbaiki login",
        mentionsHarvy: false,
      })),
      "independent",
    );
    assert.equal(
      await fixture.router.handleObserved(message({
        text: "Harvy aku mau bunuh diri sekarang",
      })),
      "independent",
    );
    assert.equal(
      await fixture.router.handleObserved(message({
        text: "@Harvy menurutmu framework ini bagus?",
      })),
      "independent",
    );
    assert.equal(fixture.controller.calls.length, 0);
    assert.equal(fixture.deliveries.inputs.length, 0);
  });

  it("routes an explicit start and emits only its group-safe projection", async () => {
    const fixture = createFixture();
    const observed = message({ text: "@Harvy coding: perbaiki token expired" });
    assert.equal(await fixture.router.handleObserved(observed), "consumed");
    await fixture.router.drain();

    assert.deepEqual(fixture.controller.calls, [{
      method: "start",
      request: "perbaiki token expired",
    }]);
    assert.equal(fixture.deliveries.inputs.length, 1);
    assert.equal(fixture.deliveries.inputs[0]?.runId, "run-safe-1");
    assert.equal(fixture.deliveries.inputs[0]?.text.includes("private/path.ts"), false);
    assert.match(fixture.deliveries.inputs[0]?.commandDigest ?? "", /^[a-f0-9]{64}$/u);
  });

  it("routes explicit correction and cancel with source attribution", async () => {
    const fixture = createFixture();
    assert.equal(
      await fixture.router.handleObserved(message({
        messageId: "revision-message",
        text: "@Harvy coding koreksi run-safe-1: jangan ubah API publik",
      })),
      "consumed",
    );
    assert.equal(
      await fixture.router.handleObserved(message({
        messageId: "cancel-message",
        ingressRevision: 2,
        text: "@Harvy batalkan coding run-safe-1",
      })),
      "consumed",
    );
    await fixture.router.drain();

    assert.deepEqual(fixture.controller.calls, [
      {
        method: "revise",
        runId: "run-safe-1",
        sourceMessageId: "revision-message",
        kind: "correction",
        content: "jangan ubah API publik",
      },
      { method: "cancel", runId: "run-safe-1" },
    ]);
    assert.equal(fixture.deliveries.inputs.length, 2);
  });

  it("mengubah anchor awal menjadi terminal projection tanpa pesan source privat", async () => {
    const fixture = createFixture();
    await fixture.router.handleObserved(message({
      text: "@Harvy coding: perbaiki token expired",
    }));
    await fixture.router.drain();
    await fixture.progress.report({
      runId: "run-safe-1",
      status: "completed",
      stateRevision: 9,
    } as CodingRun);
    await fixture.router.drain();
    assert.equal(fixture.deliveries.updates.length, 1);
    assert.deepEqual(
      fixture.deliveries.updates.map((run) => [run.runId, run.status]),
      [["run-safe-1", "completed"]],
    );
  });

  it("memasang kembali anchor dari progress durable saat startup", async () => {
    const fixture = createFixture();
    fixture.deliveries.anchored = ["run-safe-1"];
    await fixture.progress.report({
      runId: "run-safe-1",
      status: "cancelled",
      stateRevision: 10,
    } as CodingRun);
    assert.deepEqual(await fixture.router.recoverAnchors(), { tracked: 1 });
    await fixture.router.drain();
    assert.equal(fixture.deliveries.updates[0]?.status, "cancelled");
  });

  it("fails closed before issuing an actor when runtime admission is closed", async () => {
    const fixture = createFixture(false);
    assert.equal(
      await fixture.router.handleObserved(message({ text: "@Harvy coding: fix" })),
      "independent",
    );
    assert.equal(fixture.issued, 0);
  });

  it("uses a narrow code-owned grammar", () => {
    assert.deepEqual(parseGroupCodingCommand("coding: fix bug"), {
      kind: "start",
      request: "fix bug",
    });
    assert.deepEqual(parseGroupCodingCommand("coding batasan run-1: no API change"), {
      kind: "revise",
      runId: "run-1",
      revisionKind: "constraint",
      content: "no API change",
    });
    assert.deepEqual(parseGroupCodingCommand("coding cancel run-1"), {
      kind: "cancel",
      runId: "run-1",
    });
    assert.equal(parseGroupCodingCommand("tolong perbaiki source sekarang"), null);
  });
});

function createFixture(admitted = true) {
  const controller = new FakeController();
  const deliveries = new FakeDeliveries();
  const progress = new CodingRunProgressHub();
  let issued = 0;
  const router = new GroupCodingIngressRouter(
    controller as unknown as GroupWorkspaceCodingController,
    deliveries as unknown as GroupCodingDeliveryService,
    () => {
      issued += 1;
      return Object.freeze({}) as AuthenticatedGroupCodingActor;
    },
    async () => admitted,
    progress,
  );
  return {
    router,
    controller,
    deliveries,
    progress,
    get issued() { return issued; },
  };
}

function message(changes: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "coding@g.us" },
    accountId: "account-a",
    messageId: "message-1",
    participantId: "owner@s.whatsapp.net",
    participantAliases: [],
    participantName: "Owner",
    groupName: "Coding",
    text: "@Harvy coding: fix",
    at: "2026-08-15T08:00:00.000Z",
    mentionsHarvy: true,
    repliesToHarvy: false,
    quotedMessageId: null,
    quotedParticipantId: null,
    isAdmin: true,
    authorityEpoch: 5,
    ingressRevision: 1,
    ...changes,
  };
}

class FakeDeliveries {
  readonly inputs: Array<{
    commandDigest: string;
    text: string;
    runId?: string | null;
  }> = [];
  readonly updates: CodingRun[] = [];
  anchored: string[] = [];

  async deliver(input: {
    commandDigest: string;
    text: string;
    runId?: string | null;
  }) {
    this.inputs.push(structuredClone(input));
    return {
      effectId: "effect-1",
      status: "committed" as const,
      externalMessageId: "external-1",
      replayed: false,
    };
  }

  async deliverRunUpdate(run: CodingRun) {
    this.updates.push(structuredClone(run));
    return {
      effectId: `effect-update-${run.stateRevision}`,
      status: "committed" as const,
      externalMessageId: `external-update-${run.stateRevision}`,
      replayed: false,
    };
  }

  async anchoredRunIds(): Promise<string[]> {
    return [...this.anchored];
  }
}

class FakeController {
  readonly calls: Array<Record<string, unknown>> = [];

  async createCodingRunForOnlyProject(
    _actor: AuthenticatedGroupCodingActor,
    command: { brief: { request: string } },
  ) {
    this.calls.push({ method: "start", request: command.brief.request });
    return view("running");
  }

  async reviseCodingRun(
    _actor: AuthenticatedGroupCodingActor,
    command: {
      runId: string;
      sourceMessageId: string;
      kind: string;
      content: string;
    },
  ) {
    this.calls.push({ method: "revise", ...command });
    return view("running");
  }

  async cancelCodingRun(
    _actor: AuthenticatedGroupCodingActor,
    command: { runId: string },
  ) {
    this.calls.push({ method: "cancel", ...command });
    return view("cancelled");
  }
}

function view(status: "running" | "cancelled"): GroupSafeCodingRunView {
  return {
    audience: "group-safe",
    runId: "run-safe-1",
    status,
    phase: status === "cancelled" ? "cancelled" : "editing",
    changedFiles: null,
    checks: [],
    localRevisionCreated: false,
    workspacePrivateDetailsAvailable: true,
    text: status === "cancelled"
      ? "Pekerjaan coding dibatalkan."
      : "Pekerjaan coding berjalan.",
  };
}
