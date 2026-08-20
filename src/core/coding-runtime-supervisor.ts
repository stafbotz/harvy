import type { CodingRunScheduler } from "./coding-run-scheduler.js";
import type {
  GitHubReconciliationCycleReport,
  GitHubReconciliationWorker,
} from "./github-reconciliation-worker.js";
import type {
  ProjectDeletionRecoveryCycleReport,
  ProjectDeletionRecoveryWorker,
} from "./project-deletion-recovery-worker.js";
import type {
  SandboxHealth,
  SandboxRunnerLifecycle,
} from "../domain/sandbox.js";

export type CodingRuntimeState =
  | "idle"
  | "starting"
  | "maintenance_ready"
  | "runtime_ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export interface CodingRuntimeStartupReport {
  version: 1;
  state: "maintenance_ready" | "runtime_ready" | "degraded";
  codingAdmission: "open" | "closed";
  sandbox: Pick<SandboxHealth, "available" | "runtime" | "checkedAt">;
  githubInitialPass: GitHubReconciliationCycleReport;
  projectDeletionInitialPass: ProjectDeletionRecoveryCycleReport;
}

export interface CodingRuntimeStatus {
  version: 1;
  state: CodingRuntimeState;
  codingAdmission: "open" | "closed";
}

export interface CodingRuntimeSupervisorDependencies {
  sandbox: SandboxRunnerLifecycle;
  scheduler: Pick<CodingRunScheduler, "stop" | "drain"> &
    Partial<Pick<CodingRunScheduler, "start">>;
  createGitHubRecoveryWorker(): GitHubReconciliationWorker;
  createProjectDeletionRecoveryWorker(): ProjectDeletionRecoveryWorker;
  /** Health/conformance checks for local-git, broker, and other required ports. */
  verifyProductionDependencies?(): Promise<void>;
  /** Reconcile commit barriers and launch resumable durable runs before ingress. */
  recoverCodingRuns?(): Promise<void>;
  /** Background application drivers that must seal and drain with the scheduler. */
  runLifecycle?: {
    stop(): void;
    drain(): Promise<void>;
  };
}

/**
 * App-owned, default-off lifecycle for the production coding stack. Startup
 * fences sandbox leases, observes one bounded GitHub page, then resumes one
 * bounded deletion page. Coding admission stays closed throughout maintenance
 * and opens only when explicitly enabled after every production dependency,
 * exact conformance check, and durable run recovery succeeds.
 */
export class CodingRuntimeSupervisor {
  private state: CodingRuntimeState = "idle";
  private githubWorker: GitHubReconciliationWorker | null = null;
  private deletionWorker: ProjectDeletionRecoveryWorker | null = null;
  private startPromise: Promise<CodingRuntimeStartupReport> | null = null;
  private drainPromise: Promise<void> | null = null;
  private report: CodingRuntimeStartupReport | null = null;
  private stopRequested = false;
  private stopFailures: unknown[] = [];
  private schedulerStopped = false;
  private runLifecycleStopped = false;
  private githubStopped = false;
  private deletionStopped = false;
  private sandboxStopped = false;
  private codingAdmission: "open" | "closed" = "closed";

  constructor(
    private readonly dependencies: CodingRuntimeSupervisorDependencies,
    private readonly options: { enableCodingAdmission?: boolean } = {},
  ) {}

  async start(): Promise<CodingRuntimeStartupReport> {
    if (
      this.state === "stopping" ||
      this.state === "stopped" ||
      this.state === "failed"
    ) {
      throw new Error("Coding runtime yang dihentikan tidak dapat dimulai ulang.");
    }
    if (this.report) return structuredClone(this.report);
    if (!this.startPromise) {
      this.state = "starting";
      this.startPromise = this.startInternal();
    }
    return structuredClone(await this.startPromise);
  }

  stop(): void {
    if (
      this.state === "stopping" ||
      this.state === "stopped" ||
      this.state === "failed"
    ) return;
    this.stopRequested = true;
    this.state = "stopping";
    this.stopComponents();
  }

  async drain(): Promise<void> {
    this.stop();
    if (!this.drainPromise) this.drainPromise = this.drainInternal();
    const pending = this.drainPromise;
    try {
      await pending;
    } finally {
      if (this.drainPromise === pending) this.drainPromise = null;
    }
  }

  status(): CodingRuntimeStatus {
    return {
      version: 1,
      state: this.state,
      codingAdmission: this.codingAdmission,
    };
  }

  private async startInternal(): Promise<CodingRuntimeStartupReport> {
    try {
      const sandbox = validateSandboxHealth(await this.dependencies.sandbox.start());
      this.assertStillStarting();
      if (this.options.enableCodingAdmission === true && !sandbox.available) {
        throw new Error("Sandbox production tidak tersedia; coding admission ditutup.");
      }
      await this.dependencies.verifyProductionDependencies?.();
      this.assertStillStarting();

      this.githubWorker = this.dependencies.createGitHubRecoveryWorker();
      this.assertStillStarting();
      const githubInitialPass = await this.githubWorker.runNow();
      if (!githubInitialPass) throw new Error("Initial pass GitHub recovery dibatalkan.");
      this.assertStillStarting();

      this.deletionWorker = this.dependencies.createProjectDeletionRecoveryWorker();
      this.assertStillStarting();
      const projectDeletionInitialPass = await this.deletionWorker.runNow();
      if (!projectDeletionInitialPass) {
        throw new Error("Initial pass project deletion recovery dibatalkan.");
      }
      this.assertStillStarting();

      const githubReport = validateCounterReport(
        githubInitialPass,
        ["discovered", "terminal", "unresolved", "missing", "failed"],
        "GitHub recovery report",
      ) as GitHubReconciliationCycleReport;
      const githubOutcomes =
        githubReport.terminal + githubReport.unresolved + githubReport.missing;
      if (
        githubOutcomes > githubReport.discovered ||
        githubOutcomes + githubReport.failed < githubReport.discovered
      ) {
        throw new Error("GitHub recovery report tidak konservatif.");
      }
      const deletionReport = validateCounterReport(
        projectDeletionInitialPass,
        ["discovered", "completed", "blocked", "missing", "failed"],
        "project deletion recovery report",
      ) as ProjectDeletionRecoveryCycleReport;
      const deletionOutcomes =
        deletionReport.completed + deletionReport.blocked + deletionReport.missing;
      if (
        deletionOutcomes > deletionReport.discovered ||
        deletionOutcomes + deletionReport.failed < deletionReport.discovered
      ) {
        throw new Error("Project deletion recovery report tidak konservatif.");
      }

      const degraded =
        !sandbox.available ||
        githubReport.failed > 0 ||
        githubReport.unresolved > 0 ||
        deletionReport.failed > 0 ||
        deletionReport.blocked > 0;
      if (!degraded && this.options.enableCodingAdmission === true) {
        if (!this.dependencies.scheduler.start) {
          throw new Error("Scheduler coding production tidak memiliki start().");
        }
        this.dependencies.scheduler.start();
        await this.dependencies.recoverCodingRuns?.();
        this.assertStillStarting();
        this.codingAdmission = "open";
      }
      const report: CodingRuntimeStartupReport = {
        version: 1,
        state: degraded
          ? "degraded"
          : this.codingAdmission === "open"
            ? "runtime_ready"
            : "maintenance_ready",
        codingAdmission: this.codingAdmission,
        sandbox: {
          available: sandbox.available,
          runtime: sandbox.runtime,
          checkedAt: sandbox.checkedAt,
        },
        githubInitialPass: githubReport,
        projectDeletionInitialPass: deletionReport,
      };
      this.report = report;
      this.state = report.state;
      return structuredClone(report);
    } catch (error) {
      this.stopRequested = true;
      this.stopComponents();
      const cleanup = await this.cleanupStartedComponents();
      this.state = "failed";
      if (cleanup.length > 0) {
        throw new AggregateError(
          [error, ...cleanup],
          "Startup coding runtime gagal dan cleanup tidak lengkap.",
        );
      }
      throw error;
    }
  }

  private assertStillStarting(): void {
    if (this.stopRequested || this.state !== "starting") {
      throw abortError();
    }
  }

  private stopComponents(): void {
    this.codingAdmission = "closed";
    const attempts: Array<{
      stopped: () => boolean;
      markStopped: () => void;
      stop: () => void;
    }> = [
      {
        stopped: () => this.schedulerStopped,
        markStopped: () => { this.schedulerStopped = true; },
        stop: () => this.dependencies.scheduler.stop(),
      },
      {
        stopped: () => this.runLifecycleStopped,
        markStopped: () => { this.runLifecycleStopped = true; },
        stop: () => this.dependencies.runLifecycle?.stop(),
      },
      {
        stopped: () => this.githubStopped,
        markStopped: () => { this.githubStopped = true; },
        stop: () => {
          if (!this.githubWorker) return;
          this.githubWorker.stop();
        },
      },
      {
        stopped: () => this.deletionStopped,
        markStopped: () => { this.deletionStopped = true; },
        stop: () => {
          if (!this.deletionWorker) return;
          this.deletionWorker.stop();
        },
      },
      {
        stopped: () => this.sandboxStopped,
        markStopped: () => { this.sandboxStopped = true; },
        stop: () => this.dependencies.sandbox.stop(),
      },
    ];
    for (const attempt of attempts) {
      if (attempt.stopped()) continue;
      try {
        if (
          (attempt === attempts[1] && !this.dependencies.runLifecycle) ||
          (attempt === attempts[2] && !this.githubWorker) ||
          (attempt === attempts[3] && !this.deletionWorker)
        ) continue;
        attempt.stop();
        attempt.markStopped();
      } catch (error) {
        this.stopFailures.push(error);
      }
    }
  }

  private async drainInternal(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    // Retry every synchronous seal before accepting any drain proof. A prior
    // stop failure must not leave a timer/admission open while status becomes
    // stopped.
    this.stopComponents();
    const failures = await this.cleanupStartedComponents();
    if (failures.length > 0) {
      if (this.state !== "failed") this.state = "stopping";
      throw new AggregateError(
        failures,
        "Coding runtime belum dapat dihentikan secara fail-closed.",
      );
    }
    if (this.state !== "failed") this.state = "stopped";
  }

  private async cleanupStartedComponents(): Promise<unknown[]> {
    const failures: unknown[] = this.stopFailures.splice(0);
    try {
      await this.dependencies.scheduler.drain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.dependencies.runLifecycle?.drain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.githubWorker?.drain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.deletionWorker?.drain();
    } catch (error) {
      failures.push(error);
    }
    // Sandbox close seals maintenance. Never cross it while a higher-level
    // coordinator/recovery worker still has unquiesced cleanup work.
    if (failures.length === 0) {
      try {
        await this.dependencies.sandbox.drain();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 0) {
      try {
        await this.dependencies.sandbox.close();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}

function validateSandboxHealth(input: SandboxHealth): SandboxHealth {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.available !== "boolean" ||
    (input.runtime !== "isolated-linux" && input.runtime !== null) ||
    (input.available && input.runtime !== "isolated-linux") ||
    (!input.available && input.runtime !== null) ||
    (input.available && (
      !input.identity ||
      !/^[a-f0-9]{64}$/u.test(input.identity.serviceIdentityDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.identity.runtimeImageDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.identity.policyDigest)
    )) ||
    (!input.available && input.identity !== null) ||
    typeof input.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(input.checkedAt)) ||
    (input.reason !== null && typeof input.reason !== "string")
  ) {
    throw new Error("Sandbox health coding runtime tidak sah.");
  }
  return structuredClone(input);
}

function validateCounterReport<T extends string>(
  input: Record<T, number>,
  fields: readonly T[],
  name: string,
): Record<T, number> {
  if (typeof input !== "object" || input === null) {
    throw new Error(`${name} tidak sah.`);
  }
  const keys = Object.keys(input).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${name} tidak sah.`);
  }
  const clone = {} as Record<T, number>;
  for (const field of fields) {
    const value = input[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} tidak sah.`);
    }
    clone[field] = value;
  }
  return clone;
}

function abortError(): Error {
  const error = new Error("Startup coding runtime dibatalkan.");
  error.name = "AbortError";
  return error;
}
