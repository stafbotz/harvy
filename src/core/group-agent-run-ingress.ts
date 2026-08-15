import { createHash } from "node:crypto";
import {
  groupRunInputAcknowledgement,
  renderGroupRunAnchor,
} from "../bot/group-run-anchor.js";
import { groupScopeKey, type GroupMessage } from "../domain/group.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { hasExplicitImmediateDangerSignal } from "./safety-policy.js";
import {
  GroupAgentRunConflictError,
  GroupAgentRunMessageCollisionError,
  GroupAgentRunRuntimeAdmissionError,
  type GroupAgentRunRuntimeAdmissionRequest,
  type GroupAgentRunRuntimeAdmissionResolver,
  type GroupAgentRunService,
  type GroupRunDelivery,
  type GroupRunDeliveryAuthorityExpectation,
  type GroupRunDeliveryRequest,
  type RouteGroupAgentRunResult,
} from "./group-agent-run-service.js";
import {
  hasGroupAgentRunStartIntent,
  parseGroupAgentRunStart,
} from "./group-agent-run-start-policy.js";

export type GroupAgentRunIngressOutcome = "independent" | "consumed";

type GroupRunDeliveryTarget = Pick<GroupMessage, "scope" | "accountId">;
type GroupRunRuntimeFence = () => Promise<boolean>;

/**
 * Port ini sengaja identik secara struktural dengan boundary WhatsApp. Controller
 * tidak boleh kembali ke `sendReply`, karena setiap copy GroupRun membutuhkan
 * idempotency key, authority fence, dan pemeriksaan runtime tepat sebelum send.
 */
export interface GroupAgentRunIngressTransport {
  sendGroupRunMessage(
    target: GroupRunDeliveryTarget,
    text: string,
    quoteMessageId: string | undefined,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: GroupRunRuntimeFence,
  ): Promise<GroupRunDelivery>;
}

/**
 * Hook code-owned ke work coordinator. Router hanya memberi sinyal lifecycle;
 * claim, authority, checkpoint, model, dan commit tetap dimiliki host worker.
 */
export interface GroupAgentRunIngressScheduler {
  wake(runId: string): unknown;
  interrupt(runId: string): unknown;
}

const NOOP_GROUP_AGENT_RUN_INGRESS_SCHEDULER:
  GroupAgentRunIngressScheduler = Object.freeze({
    wake: () => undefined,
    interrupt: () => undefined,
  });

type GroupAgentRunIngressPort = Pick<
  GroupAgentRunService,
  "routeMessage" | "start" | "commitAnchor"
>;

const REJECTION_COPY: Record<
  Extract<RouteGroupAgentRunResult, { status: "rejected" }>["reason"],
  string
> = {
  mailbox_full:
    "Pekerjaan grup ini sudah mencapai batas input dan tidak menerima perubahan tambahan.",
  ambiguous_batch:
    "Pisahkan pesan untuk pekerjaan grup dari chat biasa, lalu kirim sebagai bubble tersendiri.",
  delivery_in_progress:
    "Status pekerjaan grup ini sedang diperbarui. Coba lagi setelah pembaruan selesai.",
};

const FORBIDDEN_COPY =
  "Pesan ini tidak dapat diterapkan ke pekerjaan grup yang dituju.";
const COLLISION_COPY =
  "Pesan ini tidak dapat diproses karena identitas kirimannya bertabrakan.";
const CONFLICT_COPY =
  "Pekerjaan grup berubah bersamaan. Kirim ulang inputmu setelah melihat status terbarunya.";
const ACTIVE_RUN_COPY =
  "Sudah ada satu pekerjaan grup yang aktif. Selesaikan atau batalkan pekerjaan itu sebelum memulai yang baru.";

/**
 * Controller satu-bubble sesudah authority/binding/notice/observation gate dan
 * sebelum message batcher. Exact start ditangani code-owned, sedangkan model dan
 * work lane tetap tidak dibuka oleh controller ini.
 */
export class GroupAgentRunIngressRouter {
  private accepting = true;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    private readonly runs: GroupAgentRunIngressPort,
    private readonly transport: GroupAgentRunIngressTransport,
    private readonly runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver =
      async () => false,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.group-agent-run-ingress"),
    private readonly scheduler: GroupAgentRunIngressScheduler =
      NOOP_GROUP_AGENT_RUN_INGRESS_SCHEDULER,
  ) {}

  async handleObserved(
    message: GroupMessage,
  ): Promise<GroupAgentRunIngressOutcome> {
    if (
      !this.accepting ||
      !Number.isSafeInteger(message.ingressRevision) ||
      (message.ingressRevision ?? 0) <= 0 ||
      hasExplicitImmediateDangerSignal(message.text)
    ) {
      return "independent";
    }

    const binding = runtimeBinding(message);
    if (!await this.runtimeAllowed(binding, "initial")) return "independent";

    // Exact start harus dipisahkan sebelum route existing: frasa "pekerjaan"
    // sendiri merupakan explicit run reference dan tidak boleh termutasi sebagai
    // constraint untuk foreground lama.
    const start = parseGroupAgentRunStart(message);
    if (start) {
      this.enqueue(binding, async () => {
        await this.startAndAttachAnchor(message, start.request, binding);
      });
      return "consumed";
    }
    // Parser juga menolak payload bahaya dan envelope start yang cacat. Jangan
    // biarkan bentuk command itu jatuh ke policy run existing hanya karena kata
    // "pekerjaan" tampak seperti explicit reference.
    if (hasGroupAgentRunStartIntent(message.text)) return "independent";

    let result: RouteGroupAgentRunResult;
    try {
      result = await this.runs.routeMessage(message);
    } catch (error) {
      if (error instanceof GroupAgentRunRuntimeAdmissionError) {
        return "consumed";
      }
      if (error instanceof GroupAgentRunMessageCollisionError) {
        this.scheduleControl(
          message,
          COLLISION_COPY,
          "collision",
          binding,
        );
        return "consumed";
      }
      if (error instanceof GroupAgentRunConflictError) {
        this.scheduleControl(message, CONFLICT_COPY, "conflict", binding);
        return "consumed";
      }
      throw error;
    }

    if (result.status === "independent") return "independent";
    if (
      result.status === "forbidden" &&
      result.reason === "runtime_inactive"
    ) {
      return "consumed";
    }

    if (result.status === "status") {
      this.scheduleControl(
        message,
        renderGroupRunAnchor(result.run),
        "status",
        binding,
      );
    } else if (
      result.status === "applied" || result.status === "proposed" ||
      result.status === "cancelled"
    ) {
      if (result.status === "applied") {
        // Koreksi/jawaban membatalkan lease model lama sebelum generasi baru
        // dijadwalkan. Wake tetap idempoten untuk replay setelah crash.
        this.scheduler.interrupt(result.run.runId);
        this.scheduler.wake(result.run.runId);
      } else if (result.status === "cancelled") {
        this.scheduler.interrupt(result.run.runId);
      }
      if (!result.replayed) {
        this.scheduleControl(
          message,
          groupRunInputAcknowledgement(result.status),
          result.status,
          binding,
        );
      }
    } else if (result.status === "rejected") {
      this.scheduleControl(
        message,
        REJECTION_COPY[result.reason],
        result.reason,
        binding,
      );
    } else {
      this.scheduleControl(message, FORBIDDEN_COPY, "forbidden", binding);
    }

    this.logger.info(
      "group_agent_run_ingress_consumed",
      "Bubble target dipisahkan dari chat ambient untuk GroupAgentRun.",
      { outcome: result.status },
    );
    return "consumed";
  }

  stopIngress(): void {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  private async startAndAttachAnchor(
    message: GroupMessage,
    request: string,
    binding: GroupAgentRunRuntimeAdmissionRequest,
  ): Promise<void> {
    try {
      const started = await this.runs.start({ message, request });
      if (started.status === "active-run-exists") {
        await this.deliverControl(
          message,
          ACTIVE_RUN_COPY,
          "active-run-exists",
          binding,
        );
        return;
      }
      // Replay yang anchor-nya sudah committed tidak boleh mempersiapkan efek
      // baru dengan stateRevision terbaru.
      if (started.status === "replayed" && started.run.anchor.messageId) {
        this.scheduler.wake(started.run.runId);
        return;
      }

      const anchored = await this.runs.commitAnchor(
        started.run.runId,
        started.run.stateRevision,
        renderGroupRunAnchor(started.run),
        async (delivery) => this.deliverPrepared(message, delivery, binding),
      );
      // Work baru tidak pernah boleh berjalan sebelum anchor canonical sudah
      // mempunyai receipt committed.
      this.scheduler.wake(anchored.runId);
    } catch (error) {
      if (error instanceof GroupAgentRunRuntimeAdmissionError) return;
      if (error instanceof GroupAgentRunMessageCollisionError) {
        await this.deliverControl(
          message,
          COLLISION_COPY,
          "start-collision",
          binding,
        );
        return;
      }
      throw error;
    }
  }

  private async deliverPrepared(
    message: GroupMessage,
    request: GroupRunDeliveryRequest,
    binding: GroupAgentRunRuntimeAdmissionRequest,
  ): Promise<GroupRunDelivery> {
    return await this.transport.sendGroupRunMessage(
      deliveryTarget(message),
      request.content,
      request.quoteMessageId ?? undefined,
      request.effectId,
      request.authorityExpectation,
      this.runtimeFence(binding),
    );
  }

  private scheduleControl(
    message: GroupMessage,
    text: string,
    outcome: string,
    binding: GroupAgentRunRuntimeAdmissionRequest,
  ): void {
    this.enqueue(binding, async () => {
      await this.deliverControl(message, text, outcome, binding);
    });
  }

  private async deliverControl(
    message: GroupMessage,
    text: string,
    outcome: string,
    binding: GroupAgentRunRuntimeAdmissionRequest,
  ): Promise<void> {
    const expectation = messageAuthorityExpectation(message);
    if (!expectation) {
      this.logger.error(
        "group_agent_run_control_authority_missing",
        "Control-copy GroupAgentRun tidak dikirim karena fence ingress tidak sah.",
        new Error("Fence authority ingress tidak sah."),
        { outcome },
      );
      return;
    }
    await this.transport.sendGroupRunMessage(
      deliveryTarget(message),
      text,
      message.messageId,
      controlIdempotencyKey(message, outcome),
      expectation,
      this.runtimeFence(binding),
    );
  }

  private enqueue(
    binding: GroupAgentRunRuntimeAdmissionRequest,
    operation: () => Promise<void>,
  ): void {
    const key = runtimeQueueKey(binding);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    let handled!: Promise<void>;
    handled = task
      .catch((error: unknown) => {
        // Bubble sudah consumed sebelum task dijalankan. Kegagalan tidak boleh
        // menjatuhkannya kembali ke model sosial.
        this.logger.error(
          "group_agent_run_ingress_task_failed",
          "Tugas ingress GroupAgentRun gagal.",
          error,
        );
      })
      .finally(() => {
        this.tasks.delete(handled);
        if (this.queues.get(key) === handled) this.queues.delete(key);
      });
    this.queues.set(key, handled);
    this.tasks.add(handled);
  }

  private runtimeFence(
    binding: GroupAgentRunRuntimeAdmissionRequest,
  ): GroupRunRuntimeFence {
    return async () =>
      this.accepting && await this.runtimeAllowed(binding, "delivery");
  }

  private async runtimeAllowed(
    binding: GroupAgentRunRuntimeAdmissionRequest,
    stage: "initial" | "delivery",
  ): Promise<boolean> {
    try {
      return await this.runtimeAdmission(binding) === true;
    } catch (error) {
      this.logger.error(
        "group_agent_run_runtime_admission_failed",
        "Pemeriksaan runtime GroupAgentRun gagal tertutup.",
        error,
        { stage },
      );
      return false;
    }
  }
}

function runtimeBinding(
  message: GroupMessage,
): GroupAgentRunRuntimeAdmissionRequest {
  return {
    scopeKey: groupScopeKey(message.scope),
    accountId: message.accountId,
  };
}

function runtimeQueueKey(
  binding: GroupAgentRunRuntimeAdmissionRequest,
): string {
  return `${binding.scopeKey}\u0000${binding.accountId}`;
}

function deliveryTarget(message: GroupMessage): GroupRunDeliveryTarget {
  return { scope: structuredClone(message.scope), accountId: message.accountId };
}

function messageAuthorityExpectation(
  message: GroupMessage,
): GroupRunDeliveryAuthorityExpectation | null {
  if (
    !Number.isSafeInteger(message.authorityEpoch) ||
    (message.authorityEpoch ?? -1) < 0
  ) return null;
  const participantIds = [...new Set([
    message.participantId,
    ...message.participantAliases,
  ].map((value) => value.trim()).filter(Boolean))];
  if (participantIds.length === 0) return null;
  return {
    expectedAuthorityEpoch: message.authorityEpoch!,
    actors: [{
      participantIds,
      expectedRole: message.isAdmin ? "admin" : "member",
    }],
  };
}

function controlIdempotencyKey(
  message: GroupMessage,
  outcome: string,
): string {
  const digest = createHash("sha256")
    .update(groupScopeKey(message.scope), "utf8")
    .update("\u0000", "utf8")
    .update(message.accountId, "utf8")
    .update("\u0000", "utf8")
    .update(message.messageId, "utf8")
    .update("\u0000", "utf8")
    .update(outcome, "utf8")
    .digest("hex");
  return `group-run-control-${digest}`;
}
