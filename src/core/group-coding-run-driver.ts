import type { CodingRun } from "../domain/coding-run.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import type { CodingRunEngine } from "./coding-run-engine.js";
import type { CodingRunScheduler } from "./coding-run-scheduler.js";
import type { LocalGitService } from "./local-git-service.js";

/** Process-local driver; durable run/ref CAS remains the authority on restart. */
export class GroupCodingRunDriver {
  readonly #tasks = new Set<Promise<void>>();
  readonly #active = new Set<string>();
  #accepting = false;

  constructor(
    private readonly scheduler: Pick<CodingRunScheduler, "advance">,
    private readonly runs: Pick<CodingRunEngine, "get">,
    private readonly localGit: Pick<LocalGitService, "commit">,
    private readonly logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
  ) {}

  start(): void {
    this.#accepting = true;
  }

  stop(): void {
    this.#accepting = false;
  }

  schedule(scope: WorkspaceAgentScope, initialRun: CodingRun): void {
    if (!this.#accepting) {
      throw new Error("Driver Group CodingRun belum menerima admission.");
    }
    const key = `${scope.workspaceKey}\0${initialRun.runId}`;
    if (this.#active.has(key)) return;
    this.#active.add(key);
    const task = this.#drive(structuredClone(scope), structuredClone(initialRun))
      .catch((error: unknown) => {
        this.logger.error(
          "group_coding_drive_failed",
          "Group-origin CodingRun berhenti sebelum local-git completion.",
          error,
          { runId: initialRun.runId },
        );
      })
      .finally(() => {
        this.#active.delete(key);
      });
    const tracked = task.then(() => undefined, () => undefined);
    this.#tasks.add(tracked);
    void tracked.finally(() => this.#tasks.delete(tracked));
  }

  async drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  activeCount(): number {
    return this.#active.size;
  }

  async #drive(scope: WorkspaceAgentScope, initialRun: CodingRun): Promise<void> {
    let run = initialRun;
    while (!terminalCodingRun(run) && this.#accepting) {
      const result = await this.scheduler.advance(scope, {
        runId: run.runId,
        expectedStateRevision: run.stateRevision,
      });
      run = result.run;
      if (result.outcome === "yielded") break;
      if (result.outcome === "action_budget") {
        if (
          run.counters.coordinatorDecisions >=
          run.limits.maxCoordinatorDecisions
        ) break;
        await nextTurn();
      }
    }
    const current = await this.runs.get(scope, run.runId);
    if (!current || current.binding.ownerWorkspaceKey !== scope.workspaceKey) return;
    if (current.status === "completed" && current.result) {
      await this.localGit.commit(
        scope,
        current.binding.projectId,
        current.result.projectRevision,
      );
    }
  }
}

function terminalCodingRun(run: { status: string }): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
