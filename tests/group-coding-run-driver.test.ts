import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroupCodingRunDriver } from "../src/core/group-coding-run-driver.js";
import type { CodingRun } from "../src/domain/coding-run.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";

const SCOPE = {
  kind: "workspace",
  workspaceKey: "workspace-1",
  channel: "whatsapp",
  principalKey: "a".repeat(64),
  membershipId: "membership-1",
  role: "editor",
  aclEpoch: 1,
  permissions: ["code.read", "code.write", "git.commit"],
  conversationKey: "workspace-conversation-1",
  sharedMemoryKey: "workspace-memory-1",
  artifactKey: "workspace-artifact-1",
  authorityKey: "workspace-authority-1",
} satisfies WorkspaceAgentScope;

describe("GroupCodingRunDriver", () => {
  it("requires admission and drains local commit before shutdown completes", async () => {
    let run = fakeRun("running", 1);
    let commitReleased!: () => void;
    const commitGate = new Promise<void>((resolve) => { commitReleased = resolve; });
    const scheduler = {
      advance: async () => {
        run = fakeRun("completed", 2);
        return { outcome: "terminal" as const, actions: 1, run };
      },
    };
    let commits = 0;
    const driver = new GroupCodingRunDriver(
      scheduler,
      { get: async () => structuredClone(run) },
      {
        commit: async () => {
          commits += 1;
          await commitGate;
          return {} as never;
        },
      },
    );
    assert.throws(() => driver.schedule(SCOPE, run), /admission/iu);

    driver.start();
    driver.schedule(SCOPE, run);
    await waitFor(() => commits === 1);
    driver.stop();
    let drained = false;
    const drain = driver.drain().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    commitReleased();
    await drain;
    assert.equal(driver.activeCount(), 0);
  });

  it("deduplicates concurrent schedules for one exact workspace/run", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = fakeRun("running", 1);
    const driver = new GroupCodingRunDriver(
      {
        advance: async () => {
          calls += 1;
          await gate;
          return { outcome: "yielded" as const, actions: 1, run: running, reasonCode: "wait" };
        },
      },
      { get: async () => running },
      { commit: async () => assert.fail("commit tidak boleh dipanggil") },
    );
    driver.start();
    driver.schedule(SCOPE, running);
    driver.schedule(SCOPE, running);
    await waitFor(() => calls === 1);
    release();
    await driver.drain();
    assert.equal(calls, 1);
  });
});

function fakeRun(status: "running" | "completed", stateRevision: number): CodingRun {
  return {
    runId: "group-run-1",
    status,
    stateRevision,
    binding: { projectId: "project-1", ownerWorkspaceKey: SCOPE.workspaceKey },
    result: status === "completed" ? { projectRevision: 2 } : null,
  } as CodingRun;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition tidak terpenuhi");
}
