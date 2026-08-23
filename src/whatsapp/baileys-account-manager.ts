import { createHash } from "node:crypto";
import { resolve } from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  extractMessageContent,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  toNumber,
  useMultiFileAuthState,
  type BaileysEventMap,
  type GroupMetadata,
  type GroupParticipant,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "baileys";
import { groupScopeKey, type GroupMessage } from "../domain/group.js";
import type {
  GroupAuthorityRequest,
  GroupAuthoritySnapshot,
} from "../core/group-authority-policy.js";
import type {
  GroupCodingAuthorityExpectation,
  GroupCodingAuthorityGuard,
} from "../core/group-workspace-coding-controller.js";
import {
  GroupReplyPartialDeliveryError,
  type GroupNoticeTarget,
  type GroupTransport,
  type GroupReplyDeliveryResult,
} from "../core/group-turn-service.js";
import { GroupAgentRunDeliveryNotCommittedError } from
  "../core/group-agent-run-service.js";
import { planResponsePresentation } from "../core/response-presentation.js";
import { TransientConversationProgress } from
  "../core/conversation-progress.js";
import type {
  WhatsAppAccountConfig,
  WhatsAppConfig,
} from "./config.js";
import {
  normalizeBaileysGroupMessage,
  normalizeBaileysPrivateMessage,
  whatsAppPrivatePresentationBubbles,
  type WhatsAppPrivateMessage,
  type WhatsAppPrivateReply,
  type WhatsAppPrivateReplyResult,
  type WhatsAppPrivateTransport,
} from "./baileys-message-normalizer.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { createBaileysLogger } from "../observability/baileys-logger.js";
import { isWhatsAppCredentialReady } from "./auth-credential.js";

const OUTBOUND_MESSAGE_CACHE_MS = 2 * 60 * 60 * 1_000;
export const GROUP_INCOMING_QUOTE_CACHE_MS = 60_000;
export const GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES = 1_000;
const MAX_OUTBOUND_MESSAGES = 2_000;
const DEFAULT_METADATA_TIMEOUT_MS = 2_000;
const GROUP_AUTHORITY_METADATA_MAX_AGE_MS = 30_000;

export type WhatsAppAccountStatus =
  | "connecting"
  | "open"
  | "retrying"
  | "pairing"
  | "stopped"
  | "needs-operator";

export interface BaileysAccountEvents {
  onMessage(message: GroupMessage): Promise<void>;
  /** Tidak dipasang ketika ingress privat default-off. */
  onPrivateMessage?(
    message: WhatsAppPrivateMessage,
    transport: WhatsAppPrivateTransport,
  ): Promise<WhatsAppPrivateReplyResult>;
  onGroupActive(
    message: Pick<GroupMessage, "scope" | "accountId" | "groupName" | "at">,
    authorityFence: () => boolean,
  ): Promise<void>;
  onGroupDisabled(scopeKey: string, accountId: string): Promise<void>;
  /** Dipanggil sinkron ketika epoch metadata authority naik. */
  onGroupAuthorityChanged?(
    scopeKey: string,
    accountId: string,
    authorityEpoch: number,
  ): void;
  onPairingCode(accountId: string, code: string): void | Promise<void>;
  onQr?(accountId: string, qr: string): void | Promise<void>;
  onStatus?(
    accountId: string,
    status: WhatsAppAccountStatus,
    reason?: number,
  ): void;
  /** Metadata lifecycle content-free untuk acceptance/observability lokal. */
  onPrivateLifecycle?(
    accountId: string,
    stage: WhatsAppPrivateLifecycleStage,
  ): void;
  onError?(accountId: string, error: unknown): void;
}

export type WhatsAppPrivateLifecycleStage =
  | "private-upsert-notify"
  | "private-upsert-append"
  | "private-candidate"
  | "private-normalized"
  | "private-handler-returned"
  | "private-pipeline-failed"
  | "private-delivery-attempted"
  | "private-delivery-succeeded"
  | "private-delivery-failed";

export interface BaileysAccountManagerDependencies {
  createSocket?: (config: UserFacingSocketConfig) => WASocket;
  loadAuthState?: typeof useMultiFileAuthState;
  random?: () => number;
  now?: () => Date;
  logger?: OperationalLogger;
  metadataTimeoutMs?: number;
  downloadContent?: typeof downloadContentFromMessage;
}

export interface GroupRunDeliveryActorExpectation {
  participantIds: readonly string[];
  expectedRole: "member" | "admin";
}

/** Fence authority yang wajib dibawa oleh setiap efek outbound GroupRun. */
export interface GroupRunDeliveryAuthorityExpectation {
  expectedAuthorityEpoch: number;
  actors: readonly GroupRunDeliveryActorExpectation[];
}

/**
 * Fence runtime yang dibentuk caller dari binding delivery saat ini. Callback
 * sengaja tidak menerima content, effect ID, atau message ID.
 */
export type GroupRunDeliveryRuntimeFence = () => Promise<boolean>;
export type GroupNoticeRuntimeFence = () => boolean;

export interface GroupLiveMembershipLease {
  isCurrent(): boolean;
}

export type GroupLiveMembershipResult =
  | { status: "member"; lease: GroupLiveMembershipLease }
  | { status: "self-missing" }
  | { status: "unavailable" };

interface CachedMessage {
  groupId: string;
  message: WAMessage;
  expiresAt: number;
  expiryTimer?: NodeJS.Timeout;
}

interface MetadataRefreshToken {
  generation: number;
  groupEpoch: number;
}

interface AccountRuntime {
  config: WhatsAppAccountConfig;
  socket: WASocket | null;
  generation: number;
  stopping: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  pairingRequested: boolean;
  status: WhatsAppAccountStatus;
  authWrite: Promise<void>;
  eventTasks: Set<Promise<void>>;
  groupQueues: Map<string, Promise<void>>;
  groups: Map<string, GroupMetadata>;
  groupMetadataAt: Map<string, number>;
  groupEpochs: Map<string, number>;
  /** Grup yang sudah diberi sinyal self-missing agar callback disable tidak
   * dipanggil berulang-ulang pada setiap read authority. */
  selfMissingNotified: Set<string>;
  metadataRefreshes: Map<string, MetadataRefreshToken>;
  /** Deduplikasi ingress private yang hanya menyimpan ID teknis, tanpa body. */
  privateMessageIds: Map<string, number>;
  incoming: Map<string, CachedMessage>;
  outbound: Map<string, CachedMessage>;
}

/**
 * Mengelola banyak nomor dalam satu proses: satu runtime, auth namespace, socket,
 * reconnect supervisor, dan cache per akun. Tidak ada failover grup ke akun
 * lain; binding domain yang memutuskan akun mana yang sah.
 */
export class BaileysAccountManager
  implements GroupTransport, GroupCodingAuthorityGuard
{
  private readonly accounts = new Map<string, AccountRuntime>();
  private readonly createSocket: (config: UserFacingSocketConfig) => WASocket;
  private readonly loadAuthState: typeof useMultiFileAuthState;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly logger: OperationalLogger;
  private readonly metadataTimeoutMs: number;
  private readonly downloadContent: typeof downloadContentFromMessage;
  private acceptingEvents = true;
  private stopping = false;

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly events: BaileysAccountEvents,
    dependencies: BaileysAccountManagerDependencies = {},
  ) {
    this.createSocket = dependencies.createSocket ?? makeWASocket;
    this.loadAuthState =
      dependencies.loadAuthState ?? useMultiFileAuthState;
    this.random = dependencies.random ?? Math.random;
    this.now = dependencies.now ?? (() => new Date());
    this.logger =
      dependencies.logger ??
      NOOP_OPERATIONAL_LOGGER.child("whatsapp.account-manager");
    this.metadataTimeoutMs =
      dependencies.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
    this.downloadContent =
      dependencies.downloadContent ?? downloadContentFromMessage;

    for (const account of config.accounts) {
      this.accounts.set(account.id, {
        config: account,
        socket: null,
        generation: 0,
        stopping: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        pairingRequested: false,
        status: "stopped",
        authWrite: Promise.resolve(),
        eventTasks: new Set(),
        groupQueues: new Map(),
        groups: new Map(),
        groupMetadataAt: new Map(),
        groupEpochs: new Map(),
        selfMissingNotified: new Set(),
        metadataRefreshes: new Map(),
        privateMessageIds: new Map(),
        incoming: new Map(),
        outbound: new Map(),
      });
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.accounts.size === 0) return;
    this.acceptingEvents = true;
    this.stopping = false;
    this.logger.info(
      "whatsapp_manager_starting",
      "Manajer akun WhatsApp mulai dijalankan.",
      { accountCount: this.accounts.size },
    );
    await Promise.all(
      [...this.accounts.values()].map((runtime) => this.connect(runtime)),
    );
  }

  async resolveGroupAuthority(
    request: GroupAuthorityRequest,
  ): Promise<GroupAuthoritySnapshot | null> {
    if (request.scope.channel !== "whatsapp") return null;
    const runtime = this.accounts.get(request.accountId);
    if (!runtime || runtime.status !== "open") return null;
    let metadata = runtime.groups.get(request.scope.groupId);
    if (!metadata) return null;
    const metadataAt = runtime.groupMetadataAt.get(request.scope.groupId) ?? 0;
    if (this.now().getTime() - metadataAt > GROUP_AUTHORITY_METADATA_MAX_AGE_MS) {
      const socket = runtime.socket;
      const beforeEpoch = this.groupEpoch(runtime, request.scope.groupId);
      const beforeGeneration = runtime.generation;
      const beforeFingerprint = metadataAuthorityFingerprint(metadata);
      if (!socket) return null;
      try {
        const refreshed = await withTimeout(
          socket.groupMetadata(request.scope.groupId),
          this.metadataTimeoutMs,
        );
        if (
          runtime.status !== "open" ||
          runtime.socket !== socket ||
          runtime.generation !== beforeGeneration ||
          this.groupEpoch(runtime, request.scope.groupId) !== beforeEpoch
        ) {
          return null;
        }
        if (beforeFingerprint !== metadataAuthorityFingerprint(refreshed)) {
          this.bumpGroupEpoch(runtime, request.scope.groupId);
        }
        runtime.groups.set(request.scope.groupId, refreshed);
        runtime.groupMetadataAt.set(
          request.scope.groupId,
          this.now().getTime(),
        );
        metadata = refreshed;
      } catch (error) {
        this.logger.warn(
          "whatsapp_group_authority_refresh_failed",
          "Refresh metadata untuk otorisasi grup gagal; aksi admin ditolak.",
          { accountId: request.accountId, error },
        );
        return null;
      }
    }
    if (!this.metadataContainsSelf(runtime, metadata)) {
      this.notifySelfMissing(runtime, request.scope.groupId);
      return null;
    }
    runtime.selfMissingNotified.delete(request.scope.groupId);
    const participant = metadata.participants.find((candidate) =>
      participantIs(candidate, request.participantIds),
    );
    if (!participant) return null;
    return {
      role: participantRole(participant),
      authorityEpoch: this.groupEpoch(runtime, request.scope.groupId),
    };
  }

  /**
   * Exact actor lease for group coding. The callback runs inside the same
   * per-group queue as membership events and is rejected if the epoch changes
   * while it is active.
   */
  async withCurrentActor<T>(
    expectation: GroupCodingAuthorityExpectation,
    operation: (authority: GroupAuthoritySnapshot) => Promise<T>,
  ): Promise<T> {
    if (
      expectation.scope.channel !== "whatsapp" ||
      !Array.isArray(expectation.participantIds) ||
      expectation.participantIds.length < 1 ||
      expectation.participantIds.length > 16 ||
      !Number.isSafeInteger(expectation.claimedAuthorityEpoch) ||
      expectation.claimedAuthorityEpoch < 1
    ) throw new Error("Expectation authority group-coding tidak sah.");
    const runtime = this.accounts.get(expectation.accountId);
    const socket = runtime?.socket ?? null;
    const generation = runtime?.generation ?? -1;
    if (
      !runtime || !socket || !this.acceptingEvents || runtime.status !== "open" ||
      !this.isCurrent(runtime, generation)
    ) throw new Error("Authority group-coding tidak tersedia.");
    const groupId = expectation.scope.groupId;
    const expectedEpoch = expectation.claimedAuthorityEpoch;
    return this.enqueueGroupOperation(runtime, groupId, async () => {
      if (
        runtime.socket !== socket || !this.isCurrent(runtime, generation) ||
        this.groupEpoch(runtime, groupId) !== expectedEpoch
      ) throw new Error("Authority group-coding sudah berubah.");
      const before = runtime.groups.get(groupId);
      let metadata: GroupMetadata;
      try {
        metadata = await withTimeout(
          socket.groupMetadata(groupId),
          this.metadataTimeoutMs,
        );
      } catch {
        throw new Error("Refresh authority group-coding gagal.");
      }
      if (
        runtime.socket !== socket || !this.isCurrent(runtime, generation) ||
        this.groupEpoch(runtime, groupId) !== expectedEpoch ||
        metadata.id !== groupId
      ) throw new Error("Authority group-coding tidak lagi current.");
      if (
        !before ||
        metadataAuthorityFingerprint(before) !== metadataAuthorityFingerprint(metadata)
      ) {
        this.bumpGroupEpoch(runtime, groupId);
        runtime.groups.set(groupId, metadata);
        runtime.groupMetadataAt.set(groupId, this.now().getTime());
        throw new Error("Metadata authority group-coding berubah; kirim ulang command.");
      }
      if (!this.metadataContainsSelf(runtime, metadata)) {
        this.notifySelfMissing(runtime, groupId);
        throw new Error("Harvy bukan anggota grup pada authority terbaru.");
      }
      const participant = metadata.participants.find((candidate) =>
        participantIs(candidate, expectation.participantIds)
      );
      if (!participant) throw new Error("Actor group-coding bukan anggota grup.");
      runtime.groups.set(groupId, metadata);
      runtime.groupMetadataAt.set(groupId, this.now().getTime());
      const authority: GroupAuthoritySnapshot = {
        role: participantRole(participant),
        authorityEpoch: expectedEpoch,
      };
      const value = await operation(authority);
      if (
        runtime.socket !== socket || !this.isCurrent(runtime, generation) ||
        this.groupEpoch(runtime, groupId) !== expectedEpoch
      ) throw new Error("Authority group-coding berubah selama operasi.");
      return value;
    });
  }

  async stop(): Promise<void> {
    this.stopIngress();
    await this.drainEvents();
    await this.close();
  }

  stopIngress(): void {
    this.acceptingEvents = false;
  }

  async drainEvents(): Promise<void> {
    while (true) {
      const pending = [...this.accounts.values()].flatMap((runtime) => [
        ...runtime.eventTasks,
        ...runtime.groupQueues.values(),
      ]);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    await Promise.all(
      [...this.accounts.values()].map(async (runtime) => {
        runtime.stopping = true;
        runtime.generation += 1;
        if (runtime.reconnectTimer) {
          clearTimeout(runtime.reconnectTimer);
          runtime.reconnectTimer = null;
        }

        const socket = runtime.socket;
        runtime.socket = null;
        runtime.privateMessageIds.clear();
        this.clearMessageCache(runtime.incoming);
        if (socket) {
          try {
            await socket.end(undefined);
          } catch (error) {
            this.reportError(runtime.config.id, error);
          }
        }
        await runtime.authWrite;
        this.setStatus(runtime, "stopped");
      }),
    );
    this.logger.info(
      "whatsapp_manager_stopped",
      "Seluruh socket WhatsApp sudah ditutup.",
      { accountCount: this.accounts.size },
    );
  }

  async sendNotice(
    target: GroupNoticeTarget,
    text: string,
    runtimeFence?: GroupNoticeRuntimeFence,
  ): Promise<void> {
    await this.sendText(
      target,
      text,
      undefined,
      undefined,
      false,
      runtimeFence,
    );
  }

  async sendReply(
    message: GroupMessage,
    text: string,
    runtimeFence?: GroupNoticeRuntimeFence,
  ): Promise<GroupReplyDeliveryResult> {
    const plan = planResponsePresentation(text, {
      maxSegmentCharacters: 12_000,
    });
    const delivered: string[] = [];
    for (const [index, segment] of plan.segments.entries()) {
      if (
        index > 0 &&
        !(await waitForGroupPresentation(
          segment.pauseBeforeMs,
          runtimeFence,
        ))
      ) {
        return groupReplyDelivery(delivered, false);
      }
      if (!groupRuntimeFenceAllows(runtimeFence)) {
        return groupReplyDelivery(delivered, false);
      }
      try {
        await this.sendText(
          message,
          segment.text,
          index === 0 ? message.messageId : undefined,
          undefined,
          false,
          runtimeFence,
        );
      } catch (error) {
        if (delivered.length > 0) {
          throw new GroupReplyPartialDeliveryError(
            groupReplyDelivery(delivered, false),
            error,
          );
        }
        throw error;
      }
      delivered.push(segment.text);
    }
    return groupReplyDelivery(delivered, true);
  }

  /**
   * Outbound privat untuk reminder, check-in, dan completion background.
   * Target selalu berasal dari chatId yang dibentuk ingress tepercaya; caller
   * tidak boleh membentuk userId dari keluaran model.
   */
  async sendPrivateText(
    accountId: string,
    userId: string,
    text: string,
  ): Promise<void> {
    await this.sendPrivateTextTracked(accountId, userId, text);
  }

  async sendPrivateTextTracked(
    accountId: string,
    userId: string,
    text: string,
  ): Promise<{ messageIds: string[] }> {
    const runtime = this.accounts.get(accountId);
    const socket = runtime?.socket ?? null;
    if (
      !runtime || runtime.stopping || runtime.status !== "open" || !socket
    ) {
      throw new Error(`Akun WhatsApp ${accountId} tidak tersambung.`);
    }
    const generation = runtime.generation;
    return this.enqueueGroupOperation(
      runtime,
      `private:${userId}`,
      async () => {
        const transport = this.privateTransport(
          runtime,
          socket,
          generation,
          userId,
        );
        const plan = planResponsePresentation(text, {
          maxSegmentCharacters: 12_000,
        });
        const messageIds: string[] = [];
        for (const segment of plan.segments) {
          const sent = await transport.send(segment.text);
          if (!sent.messageId) {
            throw new Error("Pengiriman WhatsApp privat tidak menghasilkan ID pesan.");
          }
          messageIds.push(sent.messageId);
        }
        return { messageIds };
      },
    );
  }

  async editPrivateText(
    accountId: string,
    userId: string,
    messageId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const runtime = this.accounts.get(accountId);
    const socket = runtime?.socket ?? null;
    if (
      !runtime || runtime.stopping || runtime.status !== "open" || !socket
    ) {
      throw new Error(`Akun WhatsApp ${accountId} tidak tersambung.`);
    }
    const generation = runtime.generation;
    return this.enqueueGroupOperation(
      runtime,
      `private:${userId}`,
      async () => {
        const transport = this.privateTransport(
          runtime,
          socket,
          generation,
          userId,
        );
        await transport.edit({ messageId }, text);
        return { messageId };
      },
    );
  }

  async removePrivateText(
    accountId: string,
    userId: string,
    messageId: string,
  ): Promise<void> {
    const runtime = this.accounts.get(accountId);
    const socket = runtime?.socket ?? null;
    if (
      !runtime || runtime.stopping || runtime.status !== "open" || !socket
    ) {
      throw new Error(`Akun WhatsApp ${accountId} tidak tersambung.`);
    }
    const generation = runtime.generation;
    await this.enqueueGroupOperation(
      runtime,
      `private:${userId}`,
      async () => {
        const transport = this.privateTransport(
          runtime,
          socket,
          generation,
          userId,
        );
        await transport.remove({ messageId });
      },
    );
  }

  async setPrivateMessagePinned(
    accountId: string,
    userId: string,
    messageId: string,
    pinned: boolean,
  ): Promise<void> {
    const runtime = this.accounts.get(accountId);
    const socket = runtime?.socket ?? null;
    if (
      !runtime || runtime.stopping || runtime.status !== "open" || !socket
    ) {
      throw new Error(`Akun WhatsApp ${accountId} tidak tersambung.`);
    }
    const generation = runtime.generation;
    await this.enqueueGroupOperation(
      runtime,
      `private:${userId}`,
      async () => {
        if (!this.isCurrent(runtime, generation)) {
          throw new Error("Generation akun WhatsApp sudah berubah.");
        }
        await socket.sendMessage(userId, {
          pin: {
            remoteJid: userId,
            fromMe: true,
            id: messageId,
          },
          type: pinned
            ? proto.PinInChat.Type.PIN_FOR_ALL
            : proto.PinInChat.Type.UNPIN_FOR_ALL,
          ...(pinned ? { time: 604_800 as const } : {}),
        });
      },
    );
  }

  /**
   * Revalidator live untuk retry reaktivasi. Cache tidak pernah menjadi bukti
   * membership: setiap pass masuk queue exact group dan membaca metadata dari
   * socket yang sama dengan generation yang ditangkap caller.
   */
  async hasLiveGroupMembership(target: GroupNoticeTarget): Promise<boolean> {
    const membership = await this.captureLiveGroupMembership(target);
    return membership.status === "member" && membership.lease.isCurrent();
  }

  async captureLiveGroupMembership(
    target: GroupNoticeTarget,
  ): Promise<GroupLiveMembershipResult> {
    if (
      target.scope.channel !== "whatsapp" ||
      !isJidGroup(target.scope.groupId)
    ) {
      return { status: "unavailable" };
    }
    const runtime = this.accounts.get(target.accountId);
    const socket = runtime?.socket ?? null;
    const generation = runtime?.generation ?? -1;
    if (
      !runtime || !socket || !this.acceptingEvents ||
      runtime.status !== "open" || !this.isCurrent(runtime, generation)
    ) {
      return { status: "unavailable" };
    }
    const groupId = target.scope.groupId;
    const expectedEpoch = this.groupEpoch(runtime, groupId);
    const runtimeIsCurrent = () =>
      this.acceptingEvents &&
      runtime.status === "open" &&
      runtime.socket === socket &&
      this.isCurrent(runtime, generation);

    try {
      return await this.enqueueGroupOperation(runtime, groupId, async () => {
        if (
          !runtimeIsCurrent() ||
          this.groupEpoch(runtime, groupId) !== expectedEpoch
        ) {
          return { status: "unavailable" };
        }
        const before = runtime.groups.get(groupId);
        const beforeFingerprint = before
          ? metadataAuthorityFingerprint(before)
          : null;

        let refreshed: GroupMetadata;
        try {
          refreshed = await withTimeout(
            socket.groupMetadata(groupId),
            this.metadataTimeoutMs,
          );
        } catch {
          this.logger.warn(
            "whatsapp_group_membership_revalidation_failed",
            "Refresh membership grup WhatsApp gagal; reaktivasi akan dicoba ulang.",
          );
          return { status: "unavailable" };
        }
        if (
          !runtimeIsCurrent() ||
          this.groupEpoch(runtime, groupId) !== expectedEpoch ||
          refreshed.id !== groupId
        ) {
          return { status: "unavailable" };
        }

        const fingerprintChanged =
          beforeFingerprint !== metadataAuthorityFingerprint(refreshed);
        const verifiedEpoch = fingerprintChanged
          ? this.bumpGroupEpoch(runtime, groupId)
          : expectedEpoch;
        if (selfJids(socket).length === 0) {
          return { status: "unavailable" };
        }
        if (!this.metadataContainsSelf(runtime, refreshed)) {
          this.notifySelfMissing(runtime, groupId);
          return { status: "self-missing" };
        }

        runtime.groups.set(groupId, refreshed);
        runtime.groupMetadataAt.set(groupId, this.now().getTime());
        runtime.selfMissingNotified.delete(groupId);
        const isCurrent = this.groupAuthorityFence(
          runtime,
          socket,
          generation,
          groupId,
          verifiedEpoch,
        );
        return isCurrent()
          ? { status: "member", lease: { isCurrent } }
          : { status: "unavailable" };
      });
    } catch {
      // Queue/refresh yang unavailable tetap fail-closed, tetapi dibedakan
      // dari absence supaya worker dapat mencoba lagi secara bounded.
      return { status: "unavailable" };
    }
  }

  async sendGroupRunMessage(
    target: GroupNoticeTarget,
    text: string,
    quoteMessageId: string | undefined,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: GroupRunDeliveryRuntimeFence,
  ): Promise<{ messageId: string }> {
    const expectation = validatedGroupRunAuthorityExpectation(
      authorityExpectation,
    );
    if (typeof runtimeFence !== "function") {
      throw groupRunRuntimeUnavailable();
    }
    if (target.scope.channel !== "whatsapp") {
      throw groupRunAuthorityUnavailable();
    }
    const runtime = this.accounts.get(target.accountId);
    const socket = runtime?.socket ?? null;
    const generation = runtime?.generation ?? -1;
    if (
      !runtime || !socket || !this.acceptingEvents ||
      runtime.status !== "open" || !this.isCurrent(runtime, generation)
    ) {
      throw groupRunAuthorityUnavailable();
    }
    const messageId = await this.enqueueGroupOperation(
      runtime,
      target.scope.groupId,
      async () => {
        await this.refreshGroupRunDeliveryAuthority(
          runtime,
          socket,
          generation,
          target.scope.groupId,
          expectation,
        );
        let runtimeAllowed = false;
        try {
          runtimeAllowed = await runtimeFence();
        } catch {
          throw groupRunRuntimeUnavailable();
        }
        if (runtimeAllowed !== true) throw groupRunRuntimeUnavailable();

        this.assertGroupRunDeliveryAuthority(
          runtime,
          socket,
          generation,
          target.scope.groupId,
          expectation,
        );
        // Tidak ada await antara recheck socket/generation/authority/runtime
        // terakhir dan pemanggilan socket di sendText. Event role/removal
        // sendiri menaikkan epoch secara sinkron sebelum dapat mengantre di
        // belakang operasi ini.
        return this.sendText(
          target,
          text,
          quoteMessageId,
          idempotencyKey,
          true,
        );
      },
    );
    if (!messageId) {
      throw new Error(
        `Pengiriman WhatsApp ${target.accountId} tidak menghasilkan ID pesan.`,
      );
    }
    return {
      messageId,
    };
  }

  async editGroupRunMessage(
    target: GroupNoticeTarget,
    text: string,
    targetMessageIdInput: string,
    idempotencyKey: string,
    authorityExpectation: GroupRunDeliveryAuthorityExpectation,
    runtimeFence: GroupRunDeliveryRuntimeFence,
  ): Promise<{ messageId: string }> {
    const targetMessageId = groupRunTargetMessageId(targetMessageIdInput);
    const expectation = validatedGroupRunAuthorityExpectation(
      authorityExpectation,
    );
    if (typeof runtimeFence !== "function") throw groupRunRuntimeUnavailable();
    if (target.scope.channel !== "whatsapp") throw groupRunAuthorityUnavailable();
    const runtime = this.accounts.get(target.accountId);
    const socket = runtime?.socket ?? null;
    const generation = runtime?.generation ?? -1;
    if (
      !runtime || !socket || !this.acceptingEvents ||
      runtime.status !== "open" || !this.isCurrent(runtime, generation)
    ) throw groupRunAuthorityUnavailable();
    const messageId = await this.enqueueGroupOperation(
      runtime,
      target.scope.groupId,
      async () => {
        await this.refreshGroupRunDeliveryAuthority(
          runtime,
          socket,
          generation,
          target.scope.groupId,
          expectation,
        );
        let runtimeAllowed = false;
        try {
          runtimeAllowed = await runtimeFence();
        } catch {
          throw groupRunRuntimeUnavailable();
        }
        if (runtimeAllowed !== true) throw groupRunRuntimeUnavailable();
        this.assertGroupRunDeliveryAuthority(
          runtime,
          socket,
          generation,
          target.scope.groupId,
          expectation,
        );
        return this.sendText(
          target,
          text,
          undefined,
          idempotencyKey,
          true,
          undefined,
          targetMessageId,
        );
      },
    );
    if (!messageId) {
      throw new Error(
        `Edit WhatsApp ${target.accountId} tidak menghasilkan ID pesan.`,
      );
    }
    return { messageId };
  }

  private async refreshGroupRunDeliveryAuthority(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    groupId: string,
    expectation: GroupRunDeliveryAuthorityExpectation,
  ): Promise<void> {
    const runtimeIsCurrent = () =>
      this.acceptingEvents &&
      runtime.status === "open" &&
      runtime.socket === socket &&
      this.isCurrent(runtime, generation);
    if (
      !runtimeIsCurrent() ||
      this.groupEpoch(runtime, groupId) !==
        expectation.expectedAuthorityEpoch
    ) {
      throw groupRunAuthorityUnavailable();
    }

    let metadata = runtime.groups.get(groupId);
    const metadataWasMissing = !metadata;
    const metadataAt = runtime.groupMetadataAt.get(groupId) ?? 0;
    if (
      !metadata ||
      this.now().getTime() - metadataAt >
        GROUP_AUTHORITY_METADATA_MAX_AGE_MS
    ) {
      metadata = await this.refreshGroupMetadata(
        runtime,
        socket,
        generation,
        groupId,
      );
      // Metadata yang baru muncul setelah cache authority kosong (misalnya
      // reconnect) adalah snapshot baru. Epoch lama tidak boleh hidup kembali.
      if (
        metadataWasMissing && metadata && runtimeIsCurrent() &&
        this.groupEpoch(runtime, groupId) ===
          expectation.expectedAuthorityEpoch
      ) {
        this.bumpGroupEpoch(runtime, groupId);
      }
    }
  }

  private assertGroupRunDeliveryAuthority(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    groupId: string,
    expectation: GroupRunDeliveryAuthorityExpectation,
  ): void {
    const metadata = runtime.groups.get(groupId);
    if (
      !metadata || metadata.id !== groupId || !this.acceptingEvents ||
      runtime.status !== "open" || runtime.socket !== socket ||
      !this.isCurrent(runtime, generation) ||
      this.groupEpoch(runtime, groupId) !==
        expectation.expectedAuthorityEpoch ||
      !this.metadataContainsSelf(runtime, metadata)
    ) throw groupRunAuthorityUnavailable();
    for (const actor of expectation.actors) {
      const participant = metadata.participants.find((candidate) =>
        participantIs(candidate, actor.participantIds)
      );
      if (
        !participant || participantRole(participant) !== actor.expectedRole
      ) {
        throw groupRunAuthorityUnavailable();
      }
    }
  }

  async sendTyping(target: GroupNoticeTarget): Promise<void> {
    const runtime = this.accounts.get(target.accountId);
    if (
      !runtime ||
      runtime.stopping ||
      runtime.status !== "open" ||
      !runtime.socket
    ) {
      return;
    }
    await runtime.socket.sendPresenceUpdate(
      "composing",
      target.scope.groupId,
    );
  }

  createProgress(
    target: GroupNoticeTarget,
    seed: string,
    runtimeFence: GroupNoticeRuntimeFence,
  ): TransientConversationProgress<{ messageId: string | null }> {
    const runtime = this.accounts.get(target.accountId);
    const socket = runtime?.socket ?? null;
    const generation = runtime?.generation ?? -1;
    const socketCurrent = (): boolean => Boolean(
      runtime && socket && !runtime.stopping && runtime.status === "open" &&
        runtime.socket === socket && this.isCurrent(runtime, generation),
    );
    const turnCurrent = (): boolean =>
      socketCurrent() && groupRuntimeFenceAllows(runtimeFence);

    return new TransientConversationProgress(
      {
        show: async (text) => ({
          messageId: await this.sendText(
            target,
            text,
            undefined,
            undefined,
            true,
            turnCurrent,
          ),
        }),
        update: async (reference, text) => {
          if (!reference.messageId) {
            throw new Error("Status grup WhatsApp tidak mempunyai ID pesan.");
          }
          await this.sendText(
            target,
            text,
            undefined,
            undefined,
            false,
            turnCurrent,
            reference.messageId,
          );
        },
        remove: async (reference) => {
          if (!reference.messageId || !socketCurrent() || !socket) return;
          await socket.sendMessage(target.scope.groupId, {
            delete: {
              remoteJid: target.scope.groupId,
              fromMe: true,
              id: reference.messageId,
            },
          });
        },
        typing: async () => {
          if (!turnCurrent() || !socket) {
            throw groupNoticeRuntimeUnavailable();
          }
          await socket.sendPresenceUpdate("composing", target.scope.groupId);
        },
      },
      {
        seed,
        onError: (operation, error) => {
          this.logger.debug(
            "whatsapp_group_progress_operation_failed",
            "Status kerja grup WhatsApp gagal diperbarui.",
            {
              operation,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          );
        },
      },
    );
  }

  accountStatus(accountId: string): WhatsAppAccountStatus | null {
    return this.accounts.get(accountId)?.status ?? null;
  }

  private async connect(runtime: AccountRuntime): Promise<void> {
    if (this.stopping || runtime.stopping) return;
    const generation = runtime.generation + 1;
    runtime.generation = generation;
    // Metadata hak admin hanya sah untuk satu generasi socket. Reconnect
    // dimulai fail-closed sampai socket baru memberikan upsert/refresh sendiri.
    runtime.groups.clear();
    runtime.groupMetadataAt.clear();
    runtime.selfMissingNotified.clear();
    // Quote raw dari generation lama tidak boleh dipakai socket baru.
    this.clearMessageCache(runtime.incoming);
    // Epoch authority tetap monoton di dalam proses. Menghapusnya saat
    // reconnect dapat membuat proposal dari socket lama terlihat segar lagi
    // ketika socket baru mulai menghitung dari nol.
    runtime.metadataRefreshes.clear();
    runtime.pairingRequested = false;
    this.setStatus(runtime, "connecting");

    try {
      try {
        await runtime.authWrite;
      } catch (error) {
        // Jangan membaca state di tengah save berantai. Kegagalan disampaikan
        // ke operator, lalu rantainya dipulihkan agar reconnect berikutnya
        // tidak terjebak pada rejected promise yang sama selamanya.
        this.reportError(runtime.config.id, error);
        runtime.authWrite = Promise.resolve();
      }
      if (!this.isCurrent(runtime, generation)) return;
      const authDirectory = resolve(
        this.config.authFolder,
        runtime.config.id,
      );
      const { state, saveCreds } = await this.loadAuthState(authDirectory);
      if (!this.isCurrent(runtime, generation)) return;
      const credentialReady = isWhatsAppCredentialReady(state.creds);
      if (
        this.config.pairingMode === "qr" &&
        !credentialReady &&
        state.creds.pairingCode
      ) {
        // Pairing-code yang ditolak meninggalkan state parsial. QR memerlukan
        // identitas companion segar. Jangan memakai `me` sebagai penanda:
        // pair-success QR memang mengisinya sebelum server menutup stream
        // dengan 515, dan identitas itu wajib bertahan untuk login berikutnya.
        state.creds.pairingCode = undefined;
        delete state.creds.me;
        runtime.authWrite = runtime.authWrite.then(saveCreds, saveCreds);
        await runtime.authWrite;
      }
      if (
        credentialReady &&
        !credentialsMatchConfiguredNumber(
          runtime.config.phoneNumber,
          state.creds.me,
        )
      ) {
        this.setStatus(runtime, "needs-operator");
        this.reportError(
          runtime.config.id,
          new Error(
            `Auth WhatsApp ${runtime.config.id} terdaftar untuk nomor lain; periksa namespace auth.`,
          ),
        );
        return;
      }

      const socket = this.createSocket({
        logger: createBaileysLogger(this.logger, runtime.config.id),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(
            state.keys,
            createBaileysLogger(this.logger, runtime.config.id),
          ),
        },
        syncFullHistory: false,
        shouldSyncHistoryMessage: shouldSyncProtocolHistory,
        markOnlineOnConnect: false,
        cachedGroupMetadata: async (jid) => runtime.groups.get(jid),
        getMessage: async (key) => {
          this.pruneMessageCaches(runtime);
          return key.id
            ? (runtime.outbound.get(key.id)?.message.message ?? undefined)
            : undefined;
        },
      });
      if (!this.isCurrent(runtime, generation)) {
        await socket.end(undefined);
        return;
      }

      runtime.socket = socket;
      this.attachListeners(
        runtime,
        socket,
        generation,
        credentialReady,
        saveCreds,
      );
    } catch (error) {
      this.reportError(runtime.config.id, error);
      this.scheduleReconnect(runtime, generation, "retry");
    }
  }

  private attachListeners(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    credentialReady: boolean,
    saveCreds: () => Promise<void>,
  ): void {
    socket.ev.on("creds.update", () => {
      if (!this.isCurrent(runtime, generation)) return;
      runtime.authWrite = runtime.authWrite.then(saveCreds, saveCreds);
      void runtime.authWrite.catch((error: unknown) => {
        this.reportError(runtime.config.id, error);
      });
    });

    socket.ev.on("connection.update", (update) => {
      if (!this.acceptingEvents) return;
      this.trackEvent(
        runtime,
        this.handleConnectionUpdate(
          runtime,
          socket,
          generation,
          credentialReady,
          update,
        ),
      );
    });

    socket.ev.on("groups.upsert", (groups) => {
      if (
        !this.acceptingEvents ||
        !this.isCurrent(runtime, generation)
      ) {
        return;
      }
      this.trackEvent(
        runtime,
        (async () => {
          const accepted: Array<{
            group: GroupMetadata;
            authorityEpoch: number;
          }> = [];
          for (const group of groups) {
            if (!this.isCurrent(runtime, generation)) return;
            // An upsert is not authority by itself. Do not activate a scope
            // until the metadata proves that this socket's own identity is a
            // participant; stale/non-member upserts must fail closed.
            if (!this.metadataContainsSelf(runtime, group)) {
              this.notifySelfMissing(runtime, group.id);
              continue;
            }
            const authorityEpoch = this.bumpGroupEpoch(runtime, group.id);
            // Publish metadata dan epoch dalam satu synchronous turn. Jika
            // cache lama dibiarkan sampai callback queue, resolver dapat
            // memasangkan role lama dengan epoch baru.
            runtime.metadataRefreshes.delete(group.id);
            runtime.groups.set(group.id, group);
            runtime.groupMetadataAt.set(group.id, this.now().getTime());
            runtime.selfMissingNotified.delete(group.id);
            accepted.push({ group, authorityEpoch });
          }
          await Promise.all(
            accepted.map(({ group, authorityEpoch }) =>
              this.enqueueGroupOperation(runtime, group.id, async () => {
              if (
                !this.isCurrent(runtime, generation) ||
                this.groupEpoch(runtime, group.id) !== authorityEpoch
              ) {
                return;
              }
              await this.events.onGroupActive(
                {
                  scope: { channel: "whatsapp", groupId: group.id },
                  accountId: runtime.config.id,
                  groupName: group.subject || null,
                  at: this.now().toISOString(),
                },
                this.groupAuthorityFence(
                  runtime,
                  socket,
                  generation,
                  group.id,
                  authorityEpoch,
                ),
              );
              }),
            ),
          );
        })(),
      );
    });

    socket.ev.on("groups.update", (updates) => {
      if (
        !this.acceptingEvents ||
        !this.isCurrent(runtime, generation)
      ) {
        return;
      }
      for (const update of updates) {
        if (!update.id) continue;
        const existing = runtime.groups.get(update.id);
        if (existing) {
          const merged = { ...existing, ...update };
          if (
            metadataAuthorityFingerprint(existing) !==
            metadataAuthorityFingerprint(merged)
          ) {
            this.bumpGroupEpoch(runtime, update.id);
          }
          if (this.metadataContainsSelf(runtime, merged)) {
            runtime.selfMissingNotified.delete(update.id);
          } else {
            this.notifySelfMissing(runtime, update.id);
            continue;
          }
          runtime.groups.set(update.id, merged);
          runtime.groupMetadataAt.set(update.id, this.now().getTime());
        }
      }
    });

    socket.ev.on("group-participants.update", (update) => {
      if (
        !this.acceptingEvents ||
        !this.isCurrent(runtime, generation)
      ) {
        return;
      }
      // Invalidate authority synchronously on event arrival, before the
      // per-group queue can be delayed by metadata/model work. A demotion or
      // removal therefore cannot race an admin control using the old epoch.
      if (
        update.action === "remove" &&
        update.participants.some((participant) =>
          isSelfParticipant(participant, selfJids(socket))
        )
      ) {
        this.clearIncomingQuotesForGroup(runtime, update.id);
      }
      const authorityEpoch = this.bumpGroupEpoch(runtime, update.id);
      runtime.groups.delete(update.id);
      runtime.groupMetadataAt.delete(update.id);
      runtime.metadataRefreshes.delete(update.id);
      this.trackEvent(
        runtime,
        this.enqueueGroupOperation(
          runtime,
          update.id,
          () =>
            this.handleGroupParticipantsUpdate(
              runtime,
              socket,
              generation,
              update,
              authorityEpoch,
            ),
        ),
      );
    });

    socket.ev.on("messages.upsert", (upsert) => {
      const hasInboundPrivate = upsert.messages.some((message) =>
        message.key.fromMe !== true &&
        Boolean(message.key.id) &&
        Boolean(message.key.remoteJid) &&
        !isJidGroup(message.key.remoteJid!)
      );
      if (hasInboundPrivate) {
        this.notifyPrivateLifecycle(
          runtime,
          upsert.type === "notify"
            ? "private-upsert-notify"
            : "private-upsert-append",
        );
      }
      if (
        !this.acceptingEvents ||
        !this.isCurrent(runtime, generation) ||
        upsert.type !== "notify"
      ) {
        return;
      }
      this.trackEvent(
        runtime,
        this.handleMessages(runtime, socket, generation, upsert),
      );
    });
  }

  private async handleConnectionUpdate(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    credentialReadyAtConnect: boolean,
    update: BaileysEventMap["connection.update"],
  ): Promise<void> {
    if (!this.isCurrent(runtime, generation)) return;

    if (
      update.qr &&
      this.config.pairingMode === "qr" &&
      this.events.onQr
    ) {
      this.setStatus(runtime, "pairing");
      await this.events.onQr(runtime.config.id, update.qr);
    }

    if (
      update.connection === "connecting" &&
      !credentialReadyAtConnect &&
      this.config.pairingMode === "code" &&
      !runtime.pairingRequested
    ) {
      runtime.pairingRequested = true;
      this.setStatus(runtime, "pairing");
      const code = await socket.requestPairingCode(
        runtime.config.phoneNumber,
      );
      if (this.isCurrent(runtime, generation)) {
        await this.events.onPairingCode(runtime.config.id, code);
      }
    }

    if (update.connection === "open") {
      runtime.reconnectAttempt = 0;
      this.setStatus(runtime, "open");
      return;
    }
    if (update.connection !== "close") return;

    // Raw quote dari socket yang sudah tertutup tidak boleh bertahan selama
    // backoff atau state needs-operator.
    this.clearMessageCache(runtime.incoming);
    runtime.socket = null;
    const reason = disconnectReason(update.lastDisconnect?.error);
    const decision = reconnectDecision(reason);
    if (decision === "stop") {
      runtime.generation += 1;
      this.setStatus(runtime, "needs-operator", reason ?? undefined);
      return;
    }
    this.scheduleReconnect(runtime, generation, decision, reason);
  }

  private async handleGroupParticipantsUpdate(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    update: BaileysEventMap["group-participants.update"],
    authorityEpoch: number,
  ): Promise<void> {
    if (
      !this.isCurrent(runtime, generation) ||
      this.groupEpoch(runtime, update.id) !== authorityEpoch
    ) {
      return;
    }
    const selfChanged = update.participants.some((participant) =>
      isSelfParticipant(participant, selfJids(socket)),
    );
    runtime.groups.delete(update.id);
    runtime.groupMetadataAt.delete(update.id);
    runtime.metadataRefreshes.delete(update.id);
    if (!selfChanged) return;

    if (update.action === "remove") {
      runtime.selfMissingNotified.add(update.id);
      try {
        await this.events.onGroupDisabled(
          groupScopeKey({ channel: "whatsapp", groupId: update.id }),
          runtime.config.id,
        );
      } catch (error) {
        runtime.selfMissingNotified.delete(update.id);
        throw error;
      }
      return;
    }
    if (update.action !== "add") return;
    runtime.selfMissingNotified.delete(update.id);

    let metadata: GroupMetadata | undefined;
    try {
      metadata = await withTimeout(
        socket.groupMetadata(update.id),
        this.metadataTimeoutMs,
      );
      if (!this.metadataContainsSelf(runtime, metadata)) {
        this.notifySelfMissing(runtime, update.id);
        return;
      }
      if (
        this.isCurrent(runtime, generation) &&
        this.groupEpoch(runtime, update.id) === authorityEpoch &&
        this.metadataContainsSelf(runtime, metadata)
      ) {
        runtime.groups.set(update.id, metadata);
        runtime.groupMetadataAt.set(update.id, this.now().getTime());
      }
    } catch (error) {
      // Aktivasi tetap sah dari event add diri sendiri. Metadata nama/admin
      // dapat dilengkapi ketika pesan live pertama tiba.
      this.logger.warn(
        "whatsapp_group_metadata_failed",
        "Metadata grup WhatsApp gagal dimuat; hak admin tetap fail-closed.",
        {
          accountId: runtime.config.id,
          error,
        },
      );
    }
    if (
      !this.isCurrent(runtime, generation) ||
      this.groupEpoch(runtime, update.id) !== authorityEpoch
    ) {
      return;
    }
    await this.events.onGroupActive(
      {
        scope: { channel: "whatsapp", groupId: update.id },
        accountId: runtime.config.id,
        groupName: metadata?.subject ?? null,
        at: this.now().toISOString(),
      },
      this.groupAuthorityFence(
        runtime,
        socket,
        generation,
        update.id,
        authorityEpoch,
      ),
    );
  }

  private async handleMessages(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    upsert: BaileysEventMap["messages.upsert"],
  ): Promise<void> {
    const processing: Promise<void>[] = [];
    for (const raw of upsert.messages) {
      if (!this.isCurrent(runtime, generation)) return;
      const groupId = raw.key.remoteJid ?? undefined;
      if (!groupId) continue;
      if (!isJidGroup(groupId)) {
        if (!this.config.privateEnabled) continue;
        if (raw.key.fromMe !== true && raw.key.id) {
          this.notifyPrivateLifecycle(runtime, "private-candidate");
        }
        const normalized = normalizeBaileysPrivateMessage(raw, {
          accountId: runtime.config.id,
          selfJids: selfJids(socket),
        });
        if (!normalized || !this.events.onPrivateMessage) continue;
        this.notifyPrivateLifecycle(runtime, "private-normalized");
        const duplicateKey = messageCacheKey(
          normalized.userId,
          normalized.messageId,
        );
        this.prunePrivateMessageIds(runtime);
        if (runtime.privateMessageIds.has(duplicateKey)) continue;
        this.rememberPrivateMessageId(runtime, duplicateKey);
        processing.push(
          this.enqueueGroupOperation(
            runtime,
            `private:${normalized.userId}`,
            async () => {
              let hydrated = normalized;
              if (normalized.document) {
                try {
                  hydrated = {
                    ...normalized,
                    document: {
                      ...normalized.document,
                      data: await downloadBoundedPrivateDocument(
                        raw,
                        this.downloadContent,
                      ),
                    },
                  };
                } catch (error) {
                  this.logger.warn(
                    "whatsapp_private_document_rejected",
                    "Dokumen privat WhatsApp ditolak sebelum callback.",
                    {
                      accountId: runtime.config.id,
                      errorType: error instanceof Error ? error.name : "unknown",
                    },
                  );
                  return;
                }
              }
              const task = this.handlePrivateMessage(
                runtime,
                socket,
                generation,
                hydrated,
              );
              // Callback ingress privat harus kembali cepat agar bubble baru
              // dapat menginterupsi model/delivery yang sedang berjalan.
              this.trackEvent(runtime, task);
            },
          ),
        );
        continue;
      }
      processing.push(
        this.enqueueGroupOperation(runtime, groupId, async () => {
          try {
            if (!this.isCurrent(runtime, generation)) return;
            let metadata = runtime.groups.get(groupId);
            const metadataAt = runtime.groupMetadataAt.get(groupId) ?? 0;
            if (
              !metadata ||
              this.now().getTime() - metadataAt >
                GROUP_AUTHORITY_METADATA_MAX_AGE_MS
            ) {
              // Membership adalah gerbang ingress, bukan enrichment. Tunggu
              // refresh yang tetap dibatasi timeout supaya event saat ini
              // tidak hilang hanya karena cache baru kedaluwarsa.
              metadata = await this.refreshGroupMetadata(
                runtime,
                socket,
                generation,
                groupId,
              );
              if (!metadata) return;
            }
            if (!this.metadataContainsSelf(runtime, metadata)) {
              this.notifySelfMissing(runtime, groupId);
              return;
            }
            const senderIds = [
              raw.key.participant,
              raw.key.participantAlt,
            ].filter((value): value is string => Boolean(value));
            if (
              senderIds.length === 0 ||
              !metadata.participants.some((participant) =>
                participantIs(participant, senderIds),
              )
            ) {
              // Event dari identitas yang belum ada pada membership snapshot
              // tidak boleh membuat profil/memori. Event participant/update
              // atau refresh berikutnya akan membuka ingress bila memang sah.
              return;
            }

            const normalized = normalizeBaileysGroupMessage(raw, {
              accountId: runtime.config.id,
              selfJids: selfJids(socket),
              groupName: metadata?.subject ?? null,
              ownMessageIds: new Set(
                [...runtime.outbound.values()]
                  .filter((item) => item.groupId === groupId)
                  .map((item) => item.message.key.id)
                  .filter((id): id is string => Boolean(id)),
              ),
              isAdmin: (participantJids) =>
                Boolean(
                  metadata?.participants.some(
                    (participant) =>
                      participantIs(participant, participantJids) &&
                      (participant.isAdmin === true ||
                        participant.isSuperAdmin === true ||
                        participant.admin === "admin" ||
                        participant.admin === "superadmin"),
                  ),
                ),
              authorityEpoch: this.groupEpoch(runtime, groupId),
            });
            if (!normalized) return;

            this.cacheMessage(
              runtime.incoming,
              groupId,
              normalized.messageId,
              raw,
              GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES,
              GROUP_INCOMING_QUOTE_CACHE_MS,
              true,
            );
            const trace = this.logger.newTraceContext(
              "whatsapp",
              "group_turn",
              runtime.config.id,
            );
            const task = Promise.resolve().then(() =>
              this.logger.runWithContext(trace, async () => {
                await this.events.onMessage(normalized);
              })
            );
            // Normalisasi/urutan event tetap memakai queue Baileys, tetapi
            // penyelesaian model tidak boleh menahan pesan grup berikutnya.
            // Raw quote punya TTL/cap sendiri dan tidak mengikuti lifetime
            // callback, karena control-copy dapat dijadwalkan sesudah callback.
            // Task tetap dilacak untuk error boundary dan drain.
            this.trackEvent(runtime, task);
          } catch (error) {
            // Satu pesan rusak/gagal tidak boleh menjatuhkan sisa array upsert.
            this.reportError(runtime.config.id, error);
          }
        }),
      );
    }
    await Promise.all(processing);
  }

  private async handlePrivateMessage(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    message: WhatsAppPrivateMessage,
  ): Promise<void> {
    const transport = this.privateTransport(
      runtime,
      socket,
      generation,
      message.userId,
    );
    try {
      const response = await this.events.onPrivateMessage?.(message, transport);
      this.notifyPrivateLifecycle(runtime, "private-handler-returned");
      const prepared = typeof response === "string"
        ? { text: response }
        : response;
      const text = prepared?.text.trim() ?? "";
      if (!text) {
        if (prepared) {
          await this.privateDeliveryFailed(prepared, {
            text: "",
            bubbleCount: 0,
            complete: false,
          });
        }
        return;
      }
      const bubbles = whatsAppPrivatePresentationBubbles(
        prepared!,
        12_000,
      );
      const delivered: string[] = [];
      try {
        for (const bubble of bubbles) {
          await transport.send(bubble);
          delivered.push(bubble);
        }
        if (prepared?.document) {
          await transport.sendDocument(prepared.document);
        }
      } catch (error) {
        await this.privateDeliveryFailed(prepared ?? undefined, {
          text: delivered.join("\n\n"),
          bubbleCount: delivered.length,
          complete: false,
        });
        throw error;
      }
      try {
        await prepared?.onDelivered?.({
          text: delivered.join("\n\n"),
          bubbleCount: delivered.length + (prepared?.document ? 1 : 0),
          complete: true,
        });
      } catch (error) {
        // Socket sudah mengakui send. Kegagalan commit lokal tidak boleh
        // diterjemahkan sebagai delivery failure lalu mendiscard usage.
        this.reportError(runtime.config.id, error);
      }
    } catch (error) {
      this.notifyPrivateLifecycle(runtime, "private-pipeline-failed");
      // Error boundary tetap content-free; callback tidak boleh membuat raw
      // private message masuk operational log.
      this.reportError(runtime.config.id, error);
    }
  }

  private async privateDeliveryFailed(
    response: WhatsAppPrivateReply | undefined,
    delivery?: {
      text: string;
      bubbleCount: number;
      complete: boolean;
    },
  ): Promise<void> {
    try {
      await response?.onDeliveryFailed?.(delivery);
    } catch (error) {
      this.logger.error(
        "whatsapp_private_delivery_failure_commit_failed",
        "Kegagalan delivery privat WhatsApp tidak dapat diselesaikan.",
        error,
      );
    }
  }

  private privateTransport(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    userId: string,
  ): WhatsAppPrivateTransport {
    const isCurrent = (): boolean =>
      !runtime.stopping &&
      runtime.status === "open" &&
      runtime.socket === socket &&
      this.isCurrent(runtime, generation);
    const assertCurrent = (): void => {
      if (!isCurrent()) {
        throw new Error("Transport privat WhatsApp tidak lagi current.");
      }
    };
    return {
      isCurrent,
      send: async (text) => {
        assertCurrent();
        this.notifyPrivateLifecycle(runtime, "private-delivery-attempted");
        try {
          const sent = await socket.sendMessage(userId, { text: text.trim() });
          this.notifyPrivateLifecycle(runtime, "private-delivery-succeeded");
          return { messageId: sent?.key.id ?? null };
        } catch (error) {
          this.notifyPrivateLifecycle(runtime, "private-delivery-failed");
          throw error;
        }
      },
      sendDocument: async (document) => {
        assertCurrent();
        this.notifyPrivateLifecycle(runtime, "private-delivery-attempted");
        try {
          const sent = await socket.sendMessage(userId, {
            document: document.data,
            fileName: document.fileName,
            mimetype: document.mimetype,
            ...(document.caption ? { caption: document.caption } : {}),
          });
          this.notifyPrivateLifecycle(runtime, "private-delivery-succeeded");
          return { messageId: sent?.key.id ?? null };
        } catch (error) {
          this.notifyPrivateLifecycle(runtime, "private-delivery-failed");
          throw error;
        }
      },
      edit: async (reference, text) => {
        assertCurrent();
        if (!reference.messageId) {
          throw new Error("Status WhatsApp tidak mempunyai ID untuk diedit.");
        }
        await socket.sendMessage(userId, {
          text: text.trim(),
          edit: {
            remoteJid: userId,
            fromMe: true,
            id: reference.messageId,
          },
        });
      },
      remove: async (reference) => {
        assertCurrent();
        if (!reference.messageId) return;
        await socket.sendMessage(userId, {
          delete: {
            remoteJid: userId,
            fromMe: true,
            id: reference.messageId,
          },
        });
      },
      typing: async () => {
        assertCurrent();
        await socket.sendPresenceUpdate("composing", userId);
      },
    };
  }

  private async sendText(
    target: GroupNoticeTarget,
    text: string,
    quoteMessageId?: string,
    idempotencyKey?: string,
    requireMessageId = false,
    runtimeFence?: GroupNoticeRuntimeFence,
    editMessageId?: string,
  ): Promise<string | null> {
    const runtime = this.accounts.get(target.accountId);
    const socket = runtime?.socket ?? null;
    if (
      !runtime ||
      runtime.stopping ||
      runtime.status !== "open" ||
      !socket
    ) {
      throw new Error(`Akun WhatsApp ${target.accountId} tidak tersambung.`);
    }

    this.pruneMessageCaches(runtime);
    const quoteKey = quoteMessageId
      ? messageCacheKey(target.scope.groupId, quoteMessageId)
      : null;
    const quoted = quoteKey
      ? runtime.incoming.get(quoteKey)?.message ??
        runtime.outbound.get(quoteKey)?.message
      : undefined;
    const requestedMessageId = idempotencyKey
      ? groupRunMessageId(idempotencyKey)
      : undefined;
    if (runtimeFence) {
      let allowed = false;
      try {
        allowed = runtimeFence() === true;
      } catch {
        throw groupNoticeRuntimeUnavailable();
      }
      if (!allowed) throw groupNoticeRuntimeUnavailable();
    }
    // Tidak ada await antara fence host terakhir dan invocation socket.
    const sent = await socket.sendMessage(
      target.scope.groupId,
      editMessageId
        ? {
            text: text.trim(),
            edit: {
              remoteJid: target.scope.groupId,
              fromMe: true,
              id: editMessageId,
            },
          }
        : { text: text.trim() },
      quoted || requestedMessageId
        ? { ...(quoted ? { quoted } : {}), ...(requestedMessageId
            ? { messageId: requestedMessageId }
            : {}) }
        : undefined,
    );
    const messageId = sent?.key.id;
    if (
      !sent ||
      typeof messageId !== "string" ||
      messageId.length === 0 ||
      messageId.trim().length === 0
    ) {
      if (requireMessageId) {
        throw new Error(
          `Pengiriman WhatsApp ${target.accountId} tidak menghasilkan ID pesan.`,
        );
      }
      return null;
    }
    if (requestedMessageId && messageId !== requestedMessageId) {
      throw new Error(
        `Pengiriman WhatsApp ${target.accountId} tidak mempertahankan ID idempotent.`,
      );
    }
    this.cacheMessage(
      runtime.outbound,
      target.scope.groupId,
      messageId,
      sent,
      MAX_OUTBOUND_MESSAGES,
      OUTBOUND_MESSAGE_CACHE_MS,
    );
    return messageId;
  }

  private scheduleReconnect(
    runtime: AccountRuntime,
    generation: number,
    decision: "restart" | "retry",
    reason?: number | null,
  ): void {
    if (!this.isCurrent(runtime, generation)) return;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);

    const delay =
      decision === "restart"
        ? 0
        : reconnectDelay(
            runtime.reconnectAttempt++,
            this.config.reconnectBaseMs,
            this.config.reconnectMaxMs,
            this.random(),
          );
    this.setStatus(runtime, "retrying", reason ?? undefined);
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void this.connect(runtime);
    }, delay);
    runtime.reconnectTimer.unref();
  }

  private async refreshGroupMetadata(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    groupId: string,
  ): Promise<GroupMetadata | undefined> {
    const groupEpoch = this.groupEpoch(runtime, groupId);
    const before = runtime.groups.get(groupId);
    const beforeFingerprint = before
      ? metadataAuthorityFingerprint(before)
      : null;
    const existing = runtime.metadataRefreshes.get(groupId);
    if (
      existing?.generation === generation &&
      existing.groupEpoch === groupEpoch
    ) {
      return undefined;
    }
    const token: MetadataRefreshToken = { generation, groupEpoch };
    runtime.metadataRefreshes.set(groupId, token);
    try {
      const metadata = await withTimeout(
        socket.groupMetadata(groupId),
        this.metadataTimeoutMs,
      );
      if (
        !this.isCurrent(runtime, generation) ||
        this.groupEpoch(runtime, groupId) !== groupEpoch ||
        runtime.metadataRefreshes.get(groupId) !== token
      ) {
        return undefined;
      }
      if (
        beforeFingerprint !== null &&
        beforeFingerprint !== metadataAuthorityFingerprint(metadata)
      ) {
        this.bumpGroupEpoch(runtime, groupId);
      }
      if (!this.metadataContainsSelf(runtime, metadata)) {
        runtime.groups.delete(groupId);
        runtime.groupMetadataAt.delete(groupId);
        this.notifySelfMissing(runtime, groupId);
        return undefined;
      }
      runtime.groups.set(groupId, metadata);
      runtime.groupMetadataAt.set(groupId, this.now().getTime());
      runtime.selfMissingNotified.delete(groupId);
      return metadata;
    } catch (error) {
      this.logger.warn(
        "whatsapp_group_metadata_failed",
        "Metadata grup WhatsApp gagal dimuat; ingress grup ditolak sampai membership dapat diverifikasi.",
        {
          accountId: runtime.config.id,
          error,
        },
      );
      return undefined;
    } finally {
      if (runtime.metadataRefreshes.get(groupId) === token) {
        runtime.metadataRefreshes.delete(groupId);
      }
    }
  }

  private metadataContainsSelf(
    runtime: AccountRuntime,
    metadata: GroupMetadata,
  ): boolean {
    const socket = runtime.socket;
    if (!socket) return false;
    const identities = selfJids(socket);
    return (
      identities.length > 0 &&
      metadata.participants.some((participant) =>
        participantIs(participant, identities),
      )
    );
  }

  private groupAuthorityFence(
    runtime: AccountRuntime,
    socket: WASocket,
    generation: number,
    groupId: string,
    authorityEpoch: number,
  ): GroupNoticeRuntimeFence {
    return () => {
      const metadata = runtime.groups.get(groupId);
      return Boolean(
        this.acceptingEvents &&
        runtime.status === "open" &&
        runtime.socket === socket &&
        this.isCurrent(runtime, generation) &&
        this.groupEpoch(runtime, groupId) === authorityEpoch &&
        metadata?.id === groupId &&
        this.metadataContainsSelf(runtime, metadata),
      );
    };
  }

  /**
   * Sinyal removal dari metadata dibuat one-shot. Jika identitas socket belum
   * tersedia, keadaan hanya dianggap unknown/fail-closed dan tidak disamakan
   * dengan bukti bahwa Harvy sudah dikeluarkan.
   */
  private notifySelfMissing(runtime: AccountRuntime, groupId: string): void {
    // Synchronous dan exact-group: callback cleanup yang tertunda tidak boleh
    // meninggalkan raw quote yang dapat dipakai setelah re-add.
    this.clearIncomingQuotesForGroup(runtime, groupId);
    const socket = runtime.socket;
    if (!socket || selfJids(socket).length === 0) return;
    runtime.groups.delete(groupId);
    runtime.groupMetadataAt.delete(groupId);
    runtime.metadataRefreshes.delete(groupId);
    if (runtime.selfMissingNotified.has(groupId)) return;
    runtime.selfMissingNotified.add(groupId);
    const disable = this.events
      .onGroupDisabled(
        groupScopeKey({ channel: "whatsapp", groupId }),
        runtime.config.id,
      )
      .catch((error: unknown) => {
        runtime.selfMissingNotified.delete(groupId);
        throw error;
      });
    this.trackEvent(
      runtime,
      disable,
    );
  }

  private groupEpoch(runtime: AccountRuntime, groupId: string): number {
    return runtime.groupEpochs.get(groupId) ?? 0;
  }

  private bumpGroupEpoch(runtime: AccountRuntime, groupId: string): number {
    const next = this.groupEpoch(runtime, groupId) + 1;
    runtime.groupEpochs.set(groupId, next);
    this.events.onGroupAuthorityChanged?.(
      groupScopeKey({ channel: "whatsapp", groupId }),
      runtime.config.id,
      next,
    );
    return next;
  }

  private isCurrent(runtime: AccountRuntime, generation: number): boolean {
    return (
      !this.stopping &&
      !runtime.stopping &&
      runtime.generation === generation
    );
  }

  private pruneMessageCaches(runtime: AccountRuntime): void {
    const now = this.now().getTime();
    for (const [id, item] of runtime.incoming) {
      if (item.expiresAt <= now) {
        this.deleteCachedMessage(runtime.incoming, id);
      }
    }
    for (const [id, item] of runtime.outbound) {
      if (item.expiresAt <= now) {
        this.deleteCachedMessage(runtime.outbound, id);
      }
    }
  }

  private prunePrivateMessageIds(runtime: AccountRuntime): void {
    const now = this.now().getTime();
    for (const [key, expiresAt] of runtime.privateMessageIds) {
      if (expiresAt <= now) runtime.privateMessageIds.delete(key);
    }
  }

  private rememberPrivateMessageId(
    runtime: AccountRuntime,
    key: string,
  ): void {
    while (runtime.privateMessageIds.size >= MAX_OUTBOUND_MESSAGES) {
      const oldest = runtime.privateMessageIds.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      runtime.privateMessageIds.delete(oldest);
    }
    runtime.privateMessageIds.set(
      key,
      this.now().getTime() + GROUP_INCOMING_QUOTE_CACHE_MS,
    );
  }

  private cacheMessage(
    cache: Map<string, CachedMessage>,
    groupId: string,
    id: string,
    message: WAMessage,
    limit: number,
    expiresAfterMs: number,
    eagerExpiry = false,
  ): void {
    const key = messageCacheKey(groupId, id);
    this.deleteCachedMessage(cache, key);
    while (cache.size >= limit) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deleteCachedMessage(cache, oldest);
    }
    const item: CachedMessage = {
      groupId,
      message,
      expiresAt: this.now().getTime() + expiresAfterMs,
    };
    if (eagerExpiry) {
      item.expiryTimer = setTimeout(() => {
        if (cache.get(key) === item) this.deleteCachedMessage(cache, key);
      }, expiresAfterMs);
      item.expiryTimer.unref();
    }
    cache.set(key, item);
  }

  private deleteCachedMessage(
    cache: Map<string, CachedMessage>,
    id: string,
  ): void {
    const existing = cache.get(id);
    if (existing?.expiryTimer) clearTimeout(existing.expiryTimer);
    cache.delete(id);
  }

  private clearMessageCache(cache: Map<string, CachedMessage>): void {
    for (const id of cache.keys()) this.deleteCachedMessage(cache, id);
  }

  private clearIncomingQuotesForGroup(
    runtime: AccountRuntime,
    groupId: string,
  ): void {
    for (const [key, item] of runtime.incoming) {
      if (item.groupId === groupId) {
        this.deleteCachedMessage(runtime.incoming, key);
      }
    }
  }

  private trackEvent(runtime: AccountRuntime, task: Promise<void>): void {
    const handled = task.catch((error: unknown) => {
      this.reportError(runtime.config.id, error);
    });
    runtime.eventTasks.add(handled);
    void handled.then(() => {
      runtime.eventTasks.delete(handled);
    });
  }

  private async enqueueGroupOperation<T>(
    runtime: AccountRuntime,
    groupId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = runtime.groupQueues.get(groupId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    runtime.groupQueues.set(groupId, tail);
    try {
      return await next;
    } finally {
      if (runtime.groupQueues.get(groupId) === tail) {
        runtime.groupQueues.delete(groupId);
      }
    }
  }

  private setStatus(
    runtime: AccountRuntime,
    status: WhatsAppAccountStatus,
    reason?: number,
  ): void {
    const previous = runtime.status;
    runtime.status = status;
    this.logger.info(
      "whatsapp_account_status_changed",
      "Status akun WhatsApp berubah.",
      {
        accountId: runtime.config.id,
        previousStatus: previous,
        status,
        reason,
      },
    );
    this.events.onStatus?.(runtime.config.id, status, reason);
  }

  private notifyPrivateLifecycle(
    runtime: AccountRuntime,
    stage: WhatsAppPrivateLifecycleStage,
  ): void {
    try {
      this.events.onPrivateLifecycle?.(runtime.config.id, stage);
    } catch {
      this.logger.warn(
        "whatsapp_private_lifecycle_observer_failed",
        "Observer lifecycle privat WhatsApp gagal dan diabaikan.",
        { accountId: runtime.config.id, stage },
      );
    }
  }

  private reportError(accountId: string, error: unknown): void {
    this.logger.error(
      "whatsapp_account_error",
      "Operasi akun WhatsApp gagal.",
      error,
      { accountId },
    );
    this.events.onError?.(accountId, error);
  }
}

function groupRunMessageId(idempotencyKey: string): string {
  const clean = idempotencyKey.trim();
  if (
    !clean || clean.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(clean)
  ) throw new Error("Idempotency key delivery GroupRun tidak sah.");
  return createHash("sha256")
    .update(`harvy-group-run\u0000${clean}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
}

function groupRunTargetMessageId(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error("Target message ID edit GroupRun tidak sah.");
  }
  return clean;
}

function messageCacheKey(groupId: string, messageId: string): string {
  // Length-prefix menjaga exact tuple dan mencegah collision concatenation.
  return `${groupId.length}:${groupId}${messageId.length}:${messageId}`;
}

function validatedGroupRunAuthorityExpectation(
  value: unknown,
): GroupRunDeliveryAuthorityExpectation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw groupRunDeliveryNotCommitted(
      "Fence authority delivery GroupRun tidak sah.",
    );
  }
  const record = value as Record<string, unknown>;
  const expectedAuthorityEpoch = record["expectedAuthorityEpoch"];
  const actorValues = record["actors"];
  if (
    !Number.isSafeInteger(expectedAuthorityEpoch) ||
    (expectedAuthorityEpoch as number) < 0 ||
    !Array.isArray(actorValues) || actorValues.length === 0 ||
    actorValues.length > 8
  ) {
    throw groupRunDeliveryNotCommitted(
      "Fence authority delivery GroupRun tidak sah.",
    );
  }
  const actors = actorValues.map((actorValue) => {
    if (
      typeof actorValue !== "object" || actorValue === null ||
      Array.isArray(actorValue)
    ) {
      throw groupRunDeliveryNotCommitted(
        "Aktor authority delivery GroupRun tidak sah.",
      );
    }
    const actor = actorValue as Record<string, unknown>;
    const participantValues = actor["participantIds"];
    const expectedRole = actor["expectedRole"];
    if (
      !Array.isArray(participantValues) || participantValues.length === 0 ||
      participantValues.length > 8 ||
      (expectedRole !== "member" && expectedRole !== "admin")
    ) {
      throw groupRunDeliveryNotCommitted(
        "Aktor authority delivery GroupRun tidak sah.",
      );
    }
    const participantIds = [...new Set(participantValues.map((participantId) => {
      if (
        typeof participantId !== "string" || !participantId.trim() ||
        participantId.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(participantId)
      ) {
        throw groupRunDeliveryNotCommitted(
          "Identitas aktor delivery GroupRun tidak sah.",
        );
      }
      return participantId.trim();
    }))];
    return {
      participantIds,
      expectedRole: expectedRole as GroupRunDeliveryActorExpectation["expectedRole"],
    };
  });
  return {
    expectedAuthorityEpoch: expectedAuthorityEpoch as number,
    actors,
  };
}

function groupRunAuthorityUnavailable(): GroupAgentRunDeliveryNotCommittedError {
  return groupRunDeliveryNotCommitted(
    "Authority delivery GroupRun berubah atau tidak tersedia.",
  );
}

function groupRunRuntimeUnavailable(): GroupAgentRunDeliveryNotCommittedError {
  return groupRunDeliveryNotCommitted(
    "Runtime delivery GroupRun tidak aktif atau berubah.",
  );
}

function groupRunDeliveryNotCommitted(
  message: string,
): GroupAgentRunDeliveryNotCommittedError {
  return new GroupAgentRunDeliveryNotCommittedError(message);
}

function groupNoticeRuntimeUnavailable(): Error {
  return new Error("Authority notice grup tidak aktif atau berubah.");
}

const MAX_PRIVATE_DOCUMENT_BYTES = 32 * 1024 * 1024;

async function downloadBoundedPrivateDocument(
  raw: WAMessage,
  downloadContent: typeof downloadContentFromMessage,
): Promise<Buffer> {
  const document = extractMessageContent(raw.message)?.documentMessage;
  if (!document) throw new Error("Dokumen WhatsApp tidak tersedia.");
  const fileName = document.fileName?.toLocaleLowerCase("en-US") ?? "";
  const mimetype = document.mimetype?.toLocaleLowerCase("en-US") ?? "";
  if (!fileName.endsWith(".zip") && mimetype !== "application/zip") {
    throw new Error("Hanya ZIP project yang diterima.");
  }
  const declared = document.fileLength == null
    ? null
    : toNumber(document.fileLength);
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) || declared < 1 ||
      declared > MAX_PRIVATE_DOCUMENT_BYTES)
  ) {
    throw new Error("Ukuran dokumen WhatsApp tidak sah atau terlalu besar.");
  }
  const stream = await downloadContent(document, "document");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PRIVATE_DOCUMENT_BYTES) {
      stream.destroy();
      throw new Error("Dokumen WhatsApp melewati batas 32 MiB.");
    }
    chunks.push(buffer);
  }
  if (total < 1) throw new Error("Dokumen WhatsApp kosong.");
  return Buffer.concat(chunks, total);
}

function groupReplyDelivery(
  delivered: readonly string[],
  complete: boolean,
): GroupReplyDeliveryResult {
  return {
    text: delivered.join("\n\n"),
    bubbleCount: delivered.length,
    complete,
  };
}

function groupRuntimeFenceAllows(
  runtimeFence?: GroupNoticeRuntimeFence,
): boolean {
  if (!runtimeFence) return true;
  try {
    return runtimeFence() === true;
  } catch {
    return false;
  }
}

async function waitForGroupPresentation(
  pauseMs: number,
  runtimeFence?: GroupNoticeRuntimeFence,
): Promise<boolean> {
  if (!groupRuntimeFenceAllows(runtimeFence)) return false;
  const deadline = Date.now() + Math.max(0, pauseMs);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(50, remaining));
      timer.unref?.();
    });
    if (!groupRuntimeFenceAllows(runtimeFence)) return false;
  }
  return groupRuntimeFenceAllows(runtimeFence);
}

export function reconnectDecision(
  reason: number | null,
): "restart" | "retry" | "stop" {
  if (reason === DisconnectReason.restartRequired) return "restart";
  if (
    reason === DisconnectReason.loggedOut ||
    reason === DisconnectReason.connectionReplaced ||
    reason === DisconnectReason.badSession ||
    reason === DisconnectReason.multideviceMismatch ||
    reason === DisconnectReason.forbidden
  ) {
    return "stop";
  }
  return "retry";
}

/**
 * Tidak mengunduh arsip pesan lama. Metadata bootstrap non-chat tetap
 * diizinkan agar mapping PN/LID dan sesi multi-device Baileys stabil.
 */
export const shouldSyncProtocolHistory: NonNullable<
  UserFacingSocketConfig["shouldSyncHistoryMessage"]
> = ({ syncType }) =>
  syncType === proto.Message.HistorySyncType.PUSH_NAME ||
  syncType === proto.Message.HistorySyncType.NON_BLOCKING_DATA ||
  syncType === proto.Message.HistorySyncType.INITIAL_STATUS_V3 ||
  syncType === proto.Message.HistorySyncType.NO_HISTORY ||
  syncType === proto.Message.HistorySyncType.MESSAGE_ACCESS_STATUS;

export function reconnectDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: number,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.75 + Math.min(1, Math.max(0, random)) * 0.5;
  return Math.min(maxMs, Math.round(exponential * jitter));
}

function disconnectReason(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  const status = candidate.output?.statusCode ?? candidate.statusCode;
  return typeof status === "number" ? status : null;
}

function credentialsMatchConfiguredNumber(
  configuredPhoneNumber: string,
  me: { id: string; phoneNumber?: string } | undefined,
): boolean {
  if (!me) return true;
  const candidates = [me.phoneNumber, me.id]
    .filter((value): value is string => Boolean(value))
    .map(phoneNumberFromJid)
    .filter((value): value is string => value !== null);
  return candidates.length === 0 || candidates.includes(configuredPhoneNumber);
}

function phoneNumberFromJid(jid: string): string | null {
  const normalized = jidNormalizedUser(jid);
  if (!normalized.endsWith("@s.whatsapp.net")) return null;
  const digits = normalized.slice(0, normalized.indexOf("@"));
  return /^\d+$/.test(digits) ? digits : null;
}

function selfJids(socket: WASocket): string[] {
  const user = socket.user;
  if (!user) return [];
  return [user.id, user.lid, user.phoneNumber].filter(
    (value): value is string => Boolean(value),
  );
}

function isSelfParticipant(
  participant: GroupParticipant,
  identities: readonly string[],
): boolean {
  return participantIs(participant, identities);
}

function participantIs(
  participant: GroupParticipant,
  identities: readonly string[],
): boolean {
  const expected = new Set(identities.map(normalizedJid));
  return [participant.id, participant.lid, participant.phoneNumber]
    .filter((value): value is string => Boolean(value))
    .some((value) => expected.has(normalizedJid(value)));
}

function participantRole(
  participant: GroupParticipant,
): "member" | "admin" {
  return participant.isAdmin === true ||
      participant.isSuperAdmin === true ||
      participant.admin === "admin" ||
      participant.admin === "superadmin"
    ? "admin"
    : "member";
}

function normalizedJid(value: string): string {
  return jidNormalizedUser(value);
}

function metadataAuthorityFingerprint(metadata: GroupMetadata): string {
  return metadata.participants
    .map((participant) => ({
      id: participant.id,
      lid: participant.lid,
      phoneNumber: participant.phoneNumber,
      admin: participant.admin,
      isAdmin: participant.isAdmin,
      isSuperAdmin: participant.isSuperAdmin,
    }))
    .sort((left, right) =>
      `${left.id}\u0000${left.lid ?? ""}`.localeCompare(
        `${right.id}\u0000${right.lid ?? ""}`,
      ),
    )
    .map((participant) => JSON.stringify(participant))
    .join("\u0001");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Batas waktu metadata WhatsApp terlampaui.")),
          Math.max(1, timeoutMs),
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
