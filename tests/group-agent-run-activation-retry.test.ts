import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startGroupAgentRunActivationRetry,
  type GroupAgentRunActivationLease,
  type GroupAgentRunLiveMembershipResult,
} from "../src/core/group-agent-run-activation-retry.js";
import type { OperationalLogger } from
  "../src/observability/operational-logger.js";

describe("GroupAgentRun activation retry", () => {
  it("mengantre exact scope+account dan coalesce target identik", async () => {
    const revalidated: string[] = [];
    const activated: string[] = [];
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async (target) => {
        revalidated.push(`${target.scopeKey}/${target.accountId}`);
        return liveMember();
      },
      reconcileAndActivate: async (target, lease) => {
        assert.equal(lease.isCurrent(), true);
        activated.push(`${target.scopeKey}/${target.accountId}`);
        return "activated";
      },
    });

    assert.equal(worker.enqueue("whatsapp:group:12", "account-a"), "scheduled");
    assert.equal(worker.enqueue("whatsapp:group:12", "account-a"), "coalesced");
    assert.equal(worker.enqueue("whatsapp:group:1", "2account-a"), "scheduled");

    const first = worker.runNow();
    assert.equal(worker.runNow(), first);
    assert.deepEqual(await first, {
      attempted: 2,
      activated: 2,
      pending: 0,
      denied: 0,
      retrying: 0,
      exhausted: 0,
      cancelled: 0,
    });
    assert.deepEqual(revalidated.sort(), [
      "whatsapp:group:1/2account-a",
      "whatsapp:group:12/account-a",
    ]);
    assert.deepEqual(activated.sort(), revalidated);
  });

  it("gagal tertutup, retry failure secara bounded, dan tidak membocorkan target ke log", async () => {
    const logged: unknown[] = [];
    let revalidateCalls = 0;
    const privateScope = "whatsapp:group:private-123@g.us";
    const privateAccount = "private-account";
    const logger = {
      warn: (...args: unknown[]) => logged.push(args),
      error: (...args: unknown[]) => logged.push(args),
    } as unknown as OperationalLogger;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => {
        revalidateCalls += 1;
        throw new Error(`${privateScope}/${privateAccount}`);
      },
      reconcileAndActivate: async () => {
        assert.fail("aktivasi tidak boleh dipanggil ketika revalidation gagal");
      },
    }, { maxFailureAttempts: 2, logger });

    assert.equal(worker.enqueue(privateScope, privateAccount), "scheduled");
    assert.deepEqual(await worker.runNow(), {
      attempted: 1,
      activated: 0,
      pending: 1,
      denied: 0,
      retrying: 1,
      exhausted: 0,
      cancelled: 0,
    });
    assert.deepEqual(await worker.runNow(), {
      attempted: 1,
      activated: 0,
      pending: 0,
      denied: 0,
      retrying: 0,
      exhausted: 1,
      cancelled: 0,
    });
    assert.equal((await worker.runNow()).attempted, 0);
    assert.equal(revalidateCalls, 2);
    assert.equal(JSON.stringify(logged).includes(privateScope), false);
    assert.equal(JSON.stringify(logged).includes(privateAccount), false);
  });

  it("mempertahankan pending reconciliation tanpa menghabiskan failure budget", async () => {
    let reconcileCalls = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async () => {
        reconcileCalls += 1;
        return reconcileCalls === 1 ? "pending" : "activated";
      },
    }, { maxFailureAttempts: 1 });

    worker.enqueue("whatsapp:group:pending", "account-a");
    assert.equal((await worker.runNow()).pending, 1);
    const completed = await worker.runNow();
    assert.equal(completed.activated, 1);
    assert.equal(completed.pending, 0);
  });

  it("mencoba ulang failure transient lalu menyelesaikan aktivasi", async () => {
    let reconcileCalls = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async (_target, lease) => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) throw new Error("private callback failure");
        assert.equal(lease.isCurrent(), true);
        return "activated";
      },
    }, { maxFailureAttempts: 2 });

    worker.enqueue("whatsapp:group:transient", "account-a");
    const failed = await worker.runNow();
    assert.equal(failed.retrying, 1);
    assert.equal(failed.pending, 1);
    const recovered = await worker.runNow();
    assert.equal(recovered.activated, 1);
    assert.equal(recovered.pending, 0);
    assert.equal(reconcileCalls, 2);
  });

  it("mencoba ulang membership unavailable lalu aktif setelah refresh sukses", async () => {
    let revalidationCalls = 0;
    let activations = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => {
        revalidationCalls += 1;
        return revalidationCalls === 1
          ? { status: "unavailable" }
          : liveMember();
      },
      reconcileAndActivate: async (_target, lease) => {
        assert.equal(lease.isCurrent(), true);
        activations += 1;
        return "activated";
      },
    }, { maxFailureAttempts: 2 });

    worker.enqueue("whatsapp:group:metadata-transient", "account-a");
    const unavailable = await worker.runNow();
    assert.equal(unavailable.retrying, 1);
    assert.equal(unavailable.denied, 0);
    assert.equal(unavailable.pending, 1);

    const recovered = await worker.runNow();
    assert.equal(recovered.activated, 1);
    assert.equal(recovered.pending, 0);
    assert.equal(revalidationCalls, 2);
    assert.equal(activations, 1);
  });

  it("kegagalan notice permanen menghabiskan budget dan tidak menjadi pending sehat", async () => {
    let noticeAttempts = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async () => {
        noticeAttempts += 1;
        throw new Error("notice transport unavailable");
      },
    }, { maxFailureAttempts: 2 });

    worker.enqueue("whatsapp:group:notice-failure", "account-a");
    const first = await worker.runNow();
    assert.equal(first.retrying, 1);
    assert.equal(first.pending, 1);
    const second = await worker.runNow();
    assert.equal(second.exhausted, 1);
    assert.equal(second.pending, 0);
    assert.equal(noticeAttempts, 2);
    assert.equal((await worker.runNow()).attempted, 0);
  });

  it("pending cleanup tidak mereset failure budget notice sebelumnya", async () => {
    let calls = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async () => {
        calls += 1;
        if (calls === 2) return "pending";
        throw new Error("notice transport unavailable");
      },
    }, { maxFailureAttempts: 2 });

    worker.enqueue("whatsapp:group:notice-with-cleanup", "account-a");
    assert.equal((await worker.runNow()).retrying, 1);
    const cleanupPending = await worker.runNow();
    assert.equal(cleanupPending.retrying, 0);
    assert.equal(cleanupPending.pending, 1);
    const exhausted = await worker.runNow();
    assert.equal(exhausted.exhausted, 1);
    assert.equal(exhausted.pending, 0);
    assert.equal(calls, 3);
  });

  it("cancel lalu re-add membuat generation lama stale sebelum activation", async () => {
    const oldRevalidation = deferred<GroupAgentRunLiveMembershipResult>();
    let revalidateCalls = 0;
    let activations = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: () => {
        revalidateCalls += 1;
        return revalidateCalls === 1
          ? oldRevalidation.promise
          : Promise.resolve(liveMember());
      },
      reconcileAndActivate: async (_target, lease) => {
        if (lease.isCurrent()) activations += 1;
        return "activated";
      },
    });

    worker.enqueue("whatsapp:group:race", "account-a");
    const stalePass = worker.runNow();
    await immediate();
    assert.equal(worker.cancel("whatsapp:group:race", "account-a"), true);
    assert.equal(worker.enqueue("whatsapp:group:race", "account-a"), "scheduled");
    oldRevalidation.resolve(liveMember());
    const staleReport = await stalePass;
    assert.equal(staleReport.cancelled, 1);
    assert.equal(staleReport.pending, 1);
    assert.equal(activations, 0);

    const freshReport = await worker.runNow();
    assert.equal(freshReport.activated, 1);
    assert.equal(activations, 1);
  });

  it("lease lama membatalkan commit ketika cancel/re-add terjadi saat reconcile", async () => {
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    let first = true;
    let committed = 0;
    let staleLease: GroupAgentRunActivationLease | null = null;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async (_target, lease) => {
        if (first) {
          first = false;
          staleLease = lease;
          reconcileStarted.resolve();
          await releaseReconcile.promise;
        }
        if (lease.isCurrent()) committed += 1;
        return "activated";
      },
    });

    worker.enqueue("whatsapp:group:commit-race", "account-a");
    const stalePass = worker.runNow();
    await reconcileStarted.promise;
    worker.cancel("whatsapp:group:commit-race", "account-a");
    worker.enqueue("whatsapp:group:commit-race", "account-a");
    const leaseAfterReadd = staleLease as GroupAgentRunActivationLease | null;
    assert.ok(leaseAfterReadd);
    assert.equal(leaseAfterReadd.isCurrent(), false);
    releaseReconcile.resolve();
    assert.equal((await stalePass).cancelled, 1);
    assert.equal(committed, 0);

    assert.equal((await worker.runNow()).activated, 1);
    assert.equal(committed, 1);
  });

  it("self-missing authoritative menghapus target tanpa memanggil callback", async () => {
    let callbacks = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => ({ status: "self-missing" }),
      reconcileAndActivate: async () => {
        callbacks += 1;
        return "activated";
      },
    });
    worker.enqueue("whatsapp:group:removed", "account-a");
    const report = await worker.runNow();
    assert.equal(report.denied, 1);
    assert.equal(report.pending, 0);
    assert.equal(callbacks, 0);
  });

  it("lease membership yang berubah membatalkan commit aktivasi", async () => {
    let authorityCurrent = true;
    const reconcileStarted = deferred<void>();
    const releaseReconcile = deferred<void>();
    let committed = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: async () => liveMember(
        () => authorityCurrent,
      ),
      reconcileAndActivate: async (_target, lease) => {
        reconcileStarted.resolve();
        await releaseReconcile.promise;
        if (lease.isCurrent()) committed += 1;
        return "activated";
      },
    });

    worker.enqueue("whatsapp:group:membership-race", "account-a");
    const running = worker.runNow();
    await reconcileStarted.promise;
    authorityCurrent = false;
    releaseReconcile.resolve();

    const report = await running;
    assert.equal(report.retrying, 1);
    assert.equal(report.pending, 1);
    assert.equal(committed, 0);
  });

  it("stop menginvalidasi lease sinkron dan drain menunggu pekerjaan in-flight", async () => {
    const membership = deferred<GroupAgentRunLiveMembershipResult>();
    let callbacks = 0;
    const worker = startGroupAgentRunActivationRetry({
      revalidateLiveMembership: () => membership.promise,
      reconcileAndActivate: async () => {
        callbacks += 1;
        return "activated";
      },
    });
    worker.enqueue("whatsapp:group:shutdown", "account-a");
    const running = worker.runNow();
    await immediate();
    worker.stop();
    assert.equal(worker.enqueue("whatsapp:group:new", "account-a"), "stopped");
    assert.equal(worker.cancel("whatsapp:group:shutdown", "account-a"), false);

    let drained = false;
    const drain = worker.drain().then(() => {
      drained = true;
    });
    await immediate();
    assert.equal(drained, false);
    membership.resolve(liveMember());
    assert.equal((await running).cancelled, 1);
    await drain;
    assert.equal(callbacks, 0);
    assert.deepEqual(await worker.runNow(), {
      attempted: 0,
      activated: 0,
      pending: 0,
      denied: 0,
      retrying: 0,
      exhausted: 0,
      cancelled: 0,
    });
  });

  it("menolak konfigurasi dan target tidak sah", () => {
    const ports = {
      revalidateLiveMembership: async () => liveMember(),
      reconcileAndActivate: async () => "activated" as const,
    };
    assert.throws(
      () => startGroupAgentRunActivationRetry(ports, { maxFailureAttempts: 0 }),
      /max failure attempts reaktivasi GroupAgentRun tidak sah/iu,
    );
    const worker = startGroupAgentRunActivationRetry(ports);
    assert.throws(
      () => worker.enqueue("", "account-a"),
      /target scope reaktivasi GroupAgentRun tidak sah/iu,
    );
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function immediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function liveMember(
  isCurrent: () => boolean = () => true,
): GroupAgentRunLiveMembershipResult {
  return { status: "member", lease: { isCurrent } };
}
