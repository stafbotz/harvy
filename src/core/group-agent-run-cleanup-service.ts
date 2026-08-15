import type {
  GroupAgentRunCleanupIntent,
  GroupAgentRunCleanupIntentRepository,
} from "../domain/group-agent-run-cleanup.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { GroupAgentRunLifecycleCoordinator } from "./group-agent-run-lifecycle-coordinator.js";

/** Kedua operasi wajib idempoten; nilai return bukan penanda kegagalan. */
export interface GroupAgentRunCleanupExecutor {
  disableGroup(scopeKey: string, accountId: string): Promise<unknown>;
  forgetScope(scopeKey: string, accountId: string): Promise<unknown>;
}

export interface GroupAgentRunCleanupRecoveryResult {
  attempted: number;
  completed: number;
  pending: number;
}

export type GroupAgentRunCleanupRequestResult = "completed" | "pending";
export type GroupAgentRunCleanupActivationResult<T> =
  | { status: "activated"; value: T }
  | { status: "pending" };

/**
 * Menulis intent sebelum efek pertama. Intent baru dihapus setelah tombstone
 * binding dan penghapusan GroupAgentRun sama-sama fulfilled pada satu attempt.
 */
export class GroupAgentRunCleanupService {
  constructor(
    private readonly intents: GroupAgentRunCleanupIntentRepository,
    private readonly executor: GroupAgentRunCleanupExecutor,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.group-agent-run-cleanup"),
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle: GroupAgentRunLifecycleCoordinator =
      new GroupAgentRunLifecycleCoordinator(),
  ) {}

  async request(
    scopeKey: string,
    accountId: string,
  ): Promise<GroupAgentRunCleanupRequestResult> {
    // Error enqueue sengaja dipropagasi: callback tidak boleh dianggap selesai
    // bila source of truth retry belum durable.
    const persisted = this.intents.enqueue(
      scopeKey,
      accountId,
      this.now().toISOString(),
    );
    void persisted.catch(() => undefined);
    return this.lifecycle.run(scopeKey, accountId, async () =>
      this.attempt(await persisted)
    );
  }

  async recoverPending(): Promise<GroupAgentRunCleanupRecoveryResult> {
    const pending = await this.intents.listPending();
    let completed = 0;
    for (const intent of pending) {
      const outcome = await this.lifecycle.run(
        intent.scopeKey,
        intent.accountId,
        async () => this.attempt(intent),
      );
      if (outcome === "completed") completed += 1;
    }
    if (completed > 0) {
      this.logger.info(
        "group_agent_run_cleanup_completed",
        "Cleanup GroupAgentRun tertunda selesai.",
        { count: completed },
      );
    }
    return {
      attempted: pending.length,
      completed,
      pending: pending.length - completed,
    };
  }

  async isPending(scopeKey: string, accountId: string): Promise<boolean> {
    return this.intents.hasPending(scopeKey, accountId);
  }

  async activateWhenClean<T>(
    scopeKey: string,
    accountId: string,
    activate: () => Promise<T>,
  ): Promise<GroupAgentRunCleanupActivationResult<T>> {
    return this.lifecycle.run(scopeKey, accountId, async () => {
      const intent = (await this.intents.listPending()).find(
        (candidate) =>
          candidate.scopeKey === scopeKey && candidate.accountId === accountId,
      );
      if (intent && await this.attempt(intent) === "pending") {
        return { status: "pending" };
      }
      // Request removal baru dapat mulai persist di luar queue sambil menunggu
      // turn ini. Jangan aktifkan bila intent itu sudah terlihat.
      if (await this.intents.hasPending(scopeKey, accountId)) {
        return { status: "pending" };
      }
      return { status: "activated", value: await activate() };
    });
  }

  private async attempt(
    intent: GroupAgentRunCleanupIntent,
  ): Promise<GroupAgentRunCleanupRequestResult> {
    if (!await this.intents.matchesPending(
      intent.scopeKey,
      intent.accountId,
      intent.revision,
      intent.intentId,
    )) {
      return await this.intents.hasPending(intent.scopeKey, intent.accountId)
        ? "pending"
        : "completed";
    }
    // allSettled menjamin kegagalan satu repository tidak melewatkan repository
    // lain. Exact scope+account dibawa langsung tanpa wildcard/prefix matching.
    const [binding, runs] = await Promise.allSettled([
      Promise.resolve().then(() =>
        this.executor.disableGroup(intent.scopeKey, intent.accountId)
      ),
      Promise.resolve().then(() =>
        this.executor.forgetScope(intent.scopeKey, intent.accountId)
      ),
    ]);
    if (binding.status === "rejected" || runs.status === "rejected") {
      this.logger.error(
        "group_agent_run_cleanup_attempt_failed",
        "Cleanup GroupAgentRun belum lengkap dan akan dicoba lagi.",
        sanitizedCleanupError(),
      );
      return "pending";
    }

    try {
      return await this.intents.complete(
          intent.scopeKey,
          intent.accountId,
          intent.revision,
          intent.intentId,
        )
        ? "completed"
        : "pending";
    } catch {
      // Ambiguitas write completion aman: intent yang masih ada akan mengulang
      // kedua operasi idempoten, sedangkan intent yang sudah hilang sudah tuntas.
      this.logger.error(
        "group_agent_run_cleanup_completion_failed",
        "Finalisasi intent cleanup GroupAgentRun gagal dan akan direkonsiliasi.",
        sanitizedCleanupError(),
      );
      return "pending";
    }
  }
}

function sanitizedCleanupError(): Error {
  return Object.assign(
    new Error("Operasi cleanup GroupAgentRun gagal."),
    { name: "GroupAgentRunCleanupError", code: "GROUP_RUN_CLEANUP_FAILED" },
  );
}
