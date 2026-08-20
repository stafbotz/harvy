import type { CodingRun, CodingRunRepository } from "../domain/coding-run.js";
import type { GroupCodingRepository } from "../domain/group-coding.js";
import type {
  CodingRunAdmissionFenceResult,
} from "./coding-run-engine.js";

export interface GroupCodingLifecycleFenceInput {
  scopeKey: string;
  accountId: string;
  cause: "group_disabled" | "group_authority_changed";
}

export interface GroupCodingLifecycleFenceResult {
  revokedLink: boolean;
  revokedRequests: number;
  fencedRuns: number;
  pendingCommitRunIds: string[];
}

interface AdmissionFencer {
  cancelByAdmissionFence(input: {
    version: 1;
    source: "group";
    cause: GroupCodingLifecycleFenceInput["cause"];
    runId: string;
    ownerWorkspaceKey: string;
    projectId: string;
    effectId: string;
    authorityRef: string;
  }): Promise<CodingRunAdmissionFenceResult>;
}

interface InvocationFencer {
  interruptByBinding(workspaceKey: string, runId: string): Promise<void>;
}

interface ProgressReporter {
  report(run: CodingRun): Promise<void>;
}

/**
 * Code-owned bridge between a WhatsApp lifecycle event and durable CodingRun
 * state. It revokes future admission first, then fences exact historical run
 * references. No group message, model output, or stale ACL snapshot enters the
 * cancellation authority.
 */
export class GroupCodingLifecycleFenceService {
  constructor(
    private readonly repository: GroupCodingRepository,
    private readonly runRepository: Pick<CodingRunRepository, "load">,
    private readonly scheduler: InvocationFencer,
    private readonly runs: AdmissionFencer,
    private readonly progress: ProgressReporter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fence(
    input: GroupCodingLifecycleFenceInput,
  ): Promise<GroupCodingLifecycleFenceResult> {
    const scopeKey = lifecycleKey(input.scopeKey, "scopeKey");
    const accountId = lifecycleKey(input.accountId, "accountId");
    if (
      input.cause !== "group_disabled" &&
      input.cause !== "group_authority_changed"
    ) throw new Error("Cause group-coding lifecycle fence tidak sah.");
    const at = this.now().toISOString();
    const failures: unknown[] = [];
    let revokedLink = false;
    const link = await this.repository.loadLink(scopeKey, accountId);
    if (link?.status === "active") {
      try {
        const saved = await this.repository.saveLink({
          ...withoutStateRevision(link),
          status: "revoked",
          updatedAt: at,
          revokedAt: at,
        }, link.stateRevision);
        if (saved.status !== "saved") {
          const current = await this.repository.loadLink(scopeKey, accountId);
          if (current?.status !== "revoked") {
            throw new Error("Link group-coding berubah saat lifecycle fence.");
          }
        }
        revokedLink = true;
      } catch (error) {
        failures.push(error);
      }
    }
    let revokedRequests = 0;
    for (const request of await this.repository.listLinkRequests()) {
      if (
        request.scopeKey !== scopeKey || request.accountId !== accountId ||
        !["pending", "approving", "approved"].includes(request.status)
      ) continue;
      try {
        const saved = await this.repository.saveLinkRequest({
          ...withoutStateRevision(request),
          status: "revoked",
          revokedAt: at,
          updatedAt: at,
        }, request.stateRevision);
        if (saved.status === "saved") revokedRequests += 1;
        else {
          const current = await this.repository.loadLinkRequest(request.requestId);
          if (current?.status !== "revoked") {
            throw new Error("Request link group-coding berubah saat lifecycle fence.");
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    let fencedRuns = 0;
    const pendingCommitRunIds: string[] = [];
    const references = (await this.repository.listRunReferences()).filter(
      (reference) =>
        reference.scopeKey === scopeKey && reference.accountId === accountId,
    );
    for (const reference of references) {
      const durable = await this.runRepository.load(reference.runId);
      if (!durable || terminalCodingRun(durable)) continue;
      try {
        await this.scheduler.interruptByBinding(
          reference.workspaceKey,
          reference.runId,
        );
        const fenced = await this.runs.cancelByAdmissionFence({
          version: 1,
          source: "group",
          cause: input.cause,
          runId: reference.runId,
          ownerWorkspaceKey: reference.workspaceKey,
          projectId: reference.projectId,
          effectId: reference.effectId,
          authorityRef: reference.linkId,
        });
        await this.progress.report(fenced.run);
        fencedRuns += 1;
        if (fenced.pendingCommit) pendingCommitRunIds.push(reference.runId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (pendingCommitRunIds.length > 0) {
      failures.push(new Error(
        `Pending commit group-coding wajib direkonsiliasi: ${pendingCommitRunIds.join(",")}`,
      ));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Lifecycle fence group-coding belum menutup seluruh authority/effect.",
      );
    }
    return { revokedLink, revokedRequests, fencedRuns, pendingCommitRunIds };
  }
}

function withoutStateRevision<T extends { stateRevision: number }>(
  value: T,
): Omit<T, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = value;
  return rest;
}

function lifecycleKey(value: string, field: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean !== value || clean.length > 512 || /\p{Cc}/u.test(clean)) {
    throw new Error(`${field} group-coding lifecycle fence tidak sah.`);
  }
  return clean;
}

function terminalCodingRun(run: { status: string }): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}
