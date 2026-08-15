import assert from "node:assert/strict";
import test from "node:test";
import { GroupAgentRunLifecycleCoordinator } from "../src/core/group-agent-run-lifecycle-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes lifecycle work for an exact group binding", async () => {
  const coordinator = new GroupAgentRunLifecycleCoordinator();
  const latch = deferred();
  const started = deferred();
  const events: string[] = [];
  const active = coordinator.run("whatsapp:group:1", "account-a", async () => {
    events.push("active:start");
    started.resolve();
    await latch.promise;
    events.push("active:end");
  });
  const disabled = coordinator.run(
    "whatsapp:group:1",
    "account-a",
    async () => {
      events.push("disabled");
    },
  );

  await started.promise;
  assert.deepEqual(events, ["active:start"]);
  latch.resolve();
  await Promise.all([active, disabled]);
  assert.deepEqual(events, ["active:start", "active:end", "disabled"]);
});

test("does not serialize unrelated group bindings", async () => {
  const coordinator = new GroupAgentRunLifecycleCoordinator();
  const latch = deferred();
  const events: string[] = [];
  const first = coordinator.run("whatsapp:group:1", "account-a", async () => {
    await latch.promise;
    events.push("first");
  });
  const second = coordinator.run("whatsapp:group:2", "account-a", async () => {
    events.push("second");
  });

  await second;
  assert.deepEqual(events, ["second"]);
  latch.resolve();
  await first;
});

test("a rejection does not poison the next lifecycle task", async () => {
  const coordinator = new GroupAgentRunLifecycleCoordinator();
  await assert.rejects(
    coordinator.run("whatsapp:group:1", "account-a", async () => {
      throw new Error("expected");
    }),
    /expected/,
  );
  assert.equal(
    await coordinator.run(
      "whatsapp:group:1",
      "account-a",
      async () => "continued",
    ),
    "continued",
  );
});
