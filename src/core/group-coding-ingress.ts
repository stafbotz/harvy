import { createHash } from "node:crypto";
import { groupScopeKey, type GroupMessage } from "../domain/group.js";
import type { AuthenticatedGroupCodingActor } from
  "./group-workspace-coding-controller.js";
import type { CodingRun } from "../domain/coding-run.js";
import {
  GroupWorkspaceCodingController,
  GroupWorkspaceCodingError,
} from "./group-workspace-coding-controller.js";
import type { GroupRunDeliveryAuthorityExpectation } from
  "./group-agent-run-service.js";
import { hasExplicitImmediateDangerSignal } from "./safety-policy.js";
import { GroupCodingDeliveryService } from "./group-coding-delivery-service.js";
import type { CodingRunProgressHub } from "./coding-run-progress-hub.js";

export type GroupCodingIngressOutcome = "independent" | "consumed";

export interface GroupCodingIngressTransport {
  sendGroupRunMessage(
    target: Pick<GroupMessage, "scope" | "accountId">,
    text: string,
    quoteMessageId: string | undefined,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: () => Promise<boolean>,
  ): Promise<{ messageId: string }>;
  editGroupRunMessage(
    target: Pick<GroupMessage, "scope" | "accountId">,
    text: string,
    targetMessageId: string,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: () => Promise<boolean>,
  ): Promise<{ messageId: string }>;
}

export interface GroupCodingRuntimeAdmission {
  (binding: { scopeKey: string; accountId: string }): Promise<boolean>;
}

type ParsedGroupCodingCommand =
  | { kind: "link" }
  | { kind: "unlink" }
  | { kind: "start"; request: string }
  | { kind: "status"; runId: string }
  | {
      kind: "revise";
      runId: string;
      revisionKind: "constraint" | "correction" | "scope_change";
      content: string;
    }
  | { kind: "cancel"; runId: string }
  | { kind: "publish"; runId: string };

/** Explicit, code-owned group coding grammar before ordinary chat batching. */
export class GroupCodingIngressRouter {
  readonly #queues = new Map<string, Promise<void>>();
  readonly #tasks = new Set<Promise<void>>();
  #accepting = true;
  readonly #anchors = new Map<string, {
    unsubscribe: () => void;
    pending: CodingRun | null;
    timer: NodeJS.Timeout | null;
    sending: boolean;
    lastDeliveredRevision: number;
  }>();

  constructor(
    private readonly controller: GroupWorkspaceCodingController,
    private readonly deliveries: GroupCodingDeliveryService,
    private readonly issueActor: (message: GroupMessage) => AuthenticatedGroupCodingActor,
    private readonly runtimeAdmission: GroupCodingRuntimeAdmission,
    private readonly progress: Pick<CodingRunProgressHub, "subscribe" | "latest"> | null = null,
  ) {}

  async handleObserved(message: GroupMessage): Promise<GroupCodingIngressOutcome> {
    if (
      !this.#accepting ||
      !Number.isSafeInteger(message.ingressRevision) ||
      (message.ingressRevision ?? 0) < 1 ||
      hasExplicitImmediateDangerSignal(message.text) ||
      (!message.mentionsHarvy && !message.repliesToHarvy)
    ) return "independent";
    const command = parseGroupCodingCommand(message.text);
    if (!command) return "independent";
    const binding = {
      scopeKey: groupScopeKey(message.scope),
      accountId: message.accountId,
    };
    if (!await this.runtimeAdmission(binding)) return "independent";
    this.#enqueue(binding, async () => {
      const actor = this.issueActor(message);
      let text: string;
      let runId: string | null = null;
      try {
        switch (command.kind) {
          case "link":
            text = (await this.controller.linkOnlyWorkspace(actor, {})).text;
            break;
          case "unlink":
            text = (await this.controller.unlinkWorkspace(actor, {})).text;
            break;
          case "start":
            {
              const view = await this.controller.createCodingRunForOnlyProject(actor, {
              brief: {
                request: command.request,
                objective: command.request,
                acceptanceCriteria: [
                  "Perubahan memenuhi permintaan dan validator code-owned lulus.",
                ],
                initialConstraints: [],
              },
              });
              text = view.text;
              runId = view.runId;
            }
            break;
          case "status":
            {
              const view = await this.controller.getCodingRun(actor, {
              runId: command.runId,
              });
              text = view.text;
              runId = view.runId;
            }
            break;
          case "revise":
            {
              const view = await this.controller.reviseCodingRun(actor, {
              runId: command.runId,
              sourceMessageId: message.messageId,
              kind: command.revisionKind,
              content: command.content,
              });
              text = view.text;
              runId = view.runId;
            }
            break;
          case "cancel":
            {
              const view = await this.controller.cancelCodingRun(actor, {
              runId: command.runId,
              });
              text = view.text;
              runId = view.runId;
            }
            break;
          case "publish": {
            const offer = await this.controller.requestPublish(actor, {
              runId: command.runId,
              action: "github.push_branch",
            });
            runId = offer.runId;
            text = `${offer.text}\nKode pekerjaan: ${offer.runId}\nDi chat privat Workspace, gunakan /publish ${offer.runId}`;
            break;
          }
        }
      } catch (error) {
        text = groupSafeError(error);
      }
      await this.deliveries.deliver({
        message,
        commandDigest: sha256(canonicalJson(command)),
        purpose: "command_reply",
        text,
        runId,
      });
      if (command.kind === "start" && runId) this.trackAnchor(runId);
    });
    return "consumed";
  }

  stopIngress(): void {
    this.#accepting = false;
    for (const anchor of this.#anchors.values()) {
      if (anchor.timer) clearTimeout(anchor.timer);
      anchor.unsubscribe();
    }
    this.#anchors.clear();
  }

  async drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  async recoverAnchors(): Promise<{ tracked: number }> {
    if (!this.progress) return { tracked: 0 };
    for (const runId of await this.deliveries.anchoredRunIds()) {
      this.trackAnchor(runId);
    }
    return { tracked: this.#anchors.size };
  }

  private trackAnchor(runId: string): void {
    if (!this.progress || this.#anchors.has(runId) || !this.#accepting) return;
    const anchor = {
      unsubscribe: (): void => undefined,
      pending: null as CodingRun | null,
      timer: null as NodeJS.Timeout | null,
      sending: false,
      lastDeliveredRevision: 0,
    };
    anchor.unsubscribe = this.progress.subscribe(runId, (run) => {
      this.queueAnchorUpdate(run);
    });
    this.#anchors.set(runId, anchor);
    const latest = this.progress.latest(runId);
    if (latest) this.queueAnchorUpdate(latest);
  }

  private queueAnchorUpdate(run: CodingRun): void {
    const anchor = this.#anchors.get(run.runId);
    if (!anchor || !this.#accepting || run.stateRevision <= anchor.lastDeliveredRevision) return;
    if (!anchor.pending || run.stateRevision >= anchor.pending.stateRevision) {
      anchor.pending = structuredClone(run);
    }
    if (anchor.sending) return;
    if (terminalCodingRun(run)) {
      if (anchor.timer) clearTimeout(anchor.timer);
      anchor.timer = null;
      this.launchAnchorUpdate(run.runId);
      return;
    }
    if (anchor.timer) return;
    anchor.timer = setTimeout(() => {
      anchor.timer = null;
      this.launchAnchorUpdate(run.runId);
    }, 750);
    anchor.timer.unref?.();
  }

  private launchAnchorUpdate(runId: string): void {
    const anchor = this.#anchors.get(runId);
    if (!anchor || anchor.sending || !anchor.pending || !this.#accepting) return;
    const run = anchor.pending;
    anchor.pending = null;
    anchor.sending = true;
    const task = this.deliveries.deliverRunUpdate(run)
      .then(() => {
        anchor.lastDeliveredRevision = Math.max(
          anchor.lastDeliveredRevision,
          run.stateRevision,
        );
      })
      .then(() => undefined, () => undefined)
      .finally(() => {
        anchor.sending = false;
        if (terminalCodingRun(run)) {
          anchor.unsubscribe();
          this.#anchors.delete(runId);
        } else if (anchor.pending) {
          this.launchAnchorUpdate(runId);
        }
      });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  #enqueue(
    binding: { scopeKey: string; accountId: string },
    operation: () => Promise<void>,
  ): void {
    const key = `${binding.scopeKey}\0${binding.accountId}`;
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(() => undefined, () => undefined);
    this.#queues.set(key, tail);
    this.#tasks.add(tail);
    void tail.finally(() => {
      this.#tasks.delete(tail);
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
  }
}

function terminalCodingRun(run: Pick<CodingRun, "status">): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

export function parseGroupCodingCommand(textInput: string): ParsedGroupCodingCommand | null {
  const text = textInput.trim()
    .replace(/^@\S+\s+/u, "")
    .replace(/^harvy[,:]?\s+/iu, "")
    .trim();
  if (/^(?:hubungkan|link)\s+workspace$/iu.test(text)) return { kind: "link" };
  if (/^(?:lepas|unlink)\s+workspace$/iu.test(text)) return { kind: "unlink" };
  const start = /^(?:coding|kerjakan\s+coding)\s*:\s*(.+)$/isu.exec(text);
  if (start?.[1]) {
    const request = boundedText(start[1], 12_000);
    return request ? { kind: "start", request } : null;
  }
  const status = /^(?:status\s+coding|coding\s+status)\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,511})$/iu.exec(text);
  if (status?.[1]) return { kind: "status", runId: status[1] };
  const revision = /^(?:coding\s+)?(batasan|constraint|koreksi|correction|ubah\s+scope)\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,511})\s*:\s*(.+)$/isu.exec(text);
  if (revision?.[1] && revision[2] && revision[3]) {
    const content = boundedText(revision[3], 8_192);
    if (!content) return null;
    const label = revision[1].toLocaleLowerCase("en-US");
    return {
      kind: "revise",
      runId: revision[2],
      revisionKind: label.includes("scope")
        ? "scope_change"
        : label === "koreksi" || label === "correction"
        ? "correction"
        : "constraint",
      content,
    };
  }
  const cancel = /^(?:batalkan\s+coding|coding\s+(?:cancel|batalkan))\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,511})$/iu.exec(text);
  if (cancel?.[1]) return { kind: "cancel", runId: cancel[1] };
  const publish = /^(?:publish\s+coding|coding\s+publish)\s+([A-Za-z0-9][A-Za-z0-9._:@/-]{0,511})$/iu.exec(text);
  return publish?.[1] ? { kind: "publish", runId: publish[1] } : null;
}

function groupSafeError(error: unknown): string {
  if (error instanceof GroupWorkspaceCodingError) {
    switch (error.code) {
      case "group_workspace_selection_required":
      case "group_coding_project_selection_required":
        return "Workspace atau project harus dipilih melalui jalur privat sebelum coding dari grup.";
      case "group_coding_run_not_ready":
        return "Pekerjaan coding belum mempunyai hasil lokal tervalidasi.";
      case "group_coding_foreground_exists":
        return "Grup ini sudah mempunyai satu pekerjaan coding aktif. Gunakan status, koreksi, atau batalkan run tersebut.";
      case "group_coding_runtime_unavailable":
        return "Runtime coding grup belum tersedia; tidak ada perubahan yang dijalankan.";
      case "group_workspace_link_conflict":
        return "Link Workspace grup berubah atau sudah terhubung ke Workspace lain.";
      default:
        return "Aksi coding grup ditolak karena authority, binding, atau revision tidak lagi current.";
    }
  }
  return "Aksi coding grup belum dapat dijalankan. Coba lagi setelah status Workspace diperiksa secara privat.";
}

function boundedText(value: string, maximum: number): string | null {
  const clean = value.trim();
  return clean && clean.length <= maximum && !/\p{Cc}/u.test(
      clean.replace(/[\r\n\t]/gu, ""),
    )
    ? clean
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
