import { createHash } from "node:crypto";
import type { ConversationTurn } from "../domain/history.js";
import {
  groupScopeKey,
  type GroupMessage,
  type GroupMemberMemoryItem,
  type GroupMessagePart,
  type GroupParticipantActivity,
  type GroupRoomMemoryItem,
  type GroupRoomMemoryKind,
  type GroupTurn,
} from "../domain/group.js";
import type { HarvyContext } from "../ai/context.js";
import type {
  ExtractedMemory,
  Understanding,
} from "../ai/understand.js";
import type { ConversationRuntime } from "../ai/conversation.js";
import type {
  GroupConversationContext,
  GroupConversationPort,
  GroupParticipationPlan,
} from "../ai/group-conversation.js";
import {
  CAPYBARA_MODEL_REPLY,
  isPureModelIdentityQuestion,
} from "../ai/identity.js";
import {
  CALM_TRIAGE,
  resolveRiskAssessment,
  type RiskTriage,
} from "../ai/safety.js";
import {
  needsConditionalReplyReview,
  NO_RISK_HINT,
  safetyEffectPermissions,
  withImmediateDangerHint,
  type RiskHint,
} from "./safety-policy.js";
import {
  hasExplicitImmediateGroupDanger,
  type GroupRuntimeAdmission,
} from "./group-runtime-policy.js";
import type {
  GroupIngressAssessment,
} from "../ai/group-ingress.js";
import type {
  ConversationProgressLifecycle,
} from "./conversation-progress.js";
import { shouldHoldAmbientTurn } from "./group-turn-policy.js";
import {
  GroupMemoryService,
  ROOM_MEMORY_RETENTION_DAYS,
  SOCIAL_STAT_WINDOW_DAYS,
  type GroupActivationFence,
  type GroupMutationGuard,
} from "./group-memory-service.js";
import {
  explicitMemoryRememberAuthority,
  normalizeMemoryWriteEmoji,
  replyAcknowledgesMemoryWrite,
} from "./memory-explicit-consent.js";
import { containsForbiddenMemorySecret } from "./memory-policy.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { groupAgentScope } from "../harness/scope.js";
import {
  DENY_GROUP_AUTHORITY_RESOLVER,
  groupAuthorityAllows,
  type GroupAuthorityResolver,
  type GroupAuthoritySnapshot,
} from "./group-authority-policy.js";
import {
  parseUsageDashboardCommand,
  USAGE_GROUP_PRIVACY_MESSAGE,
} from "./usage-dashboard-renderer.js";

const MAX_CONTEXT_TURNS = 24;
const CONTEXT_RETENTION_MS = 2 * 60 * 60 * 1_000;
const AMBIENT_HIGH_VALUE_MIN_TURNS = 2;
const AMBIENT_ORDINARY_MIN_TURNS = 4;
const AMBIENT_HIGH_VALUE_MIN_MS = 8_000;
const AMBIENT_ORDINARY_MIN_MS = 20_000;
const CONTROL_CONFIRMATION_MS = 10 * 60 * 1_000;
const RISK_MARKER_RETENTION_MS = 30 * 60 * 1_000;
const MAX_OBSERVED_MESSAGE_IDS = 2_000;
const PRIORITY_RESERVATION_MS = 10 * 60 * 1_000;
const MAX_PRIORITY_TRIAGE_CONCURRENCY = 4;
const MAX_PRIORITY_TRIAGE_QUEUE = 32;
const PENDING_AMBIENT_QUIET_MS = 900;
const PENDING_AMBIENT_MAX_AGE_MS = 15_000;
const PENDING_AMBIENT_MAX_NEWER_TURNS = 4;

const GROUP_AI_FAILURE_REPLY =
  "Aku lagi nggak bisa memproses percakapan dengan benar. Coba panggil aku lagi sebentar ya.";
const GROUP_SUPPORT_FALLBACK_REPLY =
  "Aku ingin menanggapi ini dengan hati-hati. Jangan tulis nama lengkap, alamat, nomor, atau detail pribadi lain di grup. Kamu bisa meminta bantuan praktis dengan informasi sesedikit yang diperlukan.";
const GROUP_DANGER_FALLBACK_REPLY =
  "Kalau ada bahaya yang sedang terjadi, utamakan menjauh ke tempat yang lebih aman atau hubungi layanan darurat setempat bila memungkinkan. Jangan kirim nama, alamat, lokasi rinci, atau detail identitas di grup.";
const GROUP_URGENT_ACK =
  "Aku lihat ini mungkin mendesak. Jangan kirim nama, alamat, lokasi rinci, atau detail identitas di grup; aku akan menanggapinya secepatnya.";
const GROUP_MEMORY_SECRET_REJECTION =
  "Aku nggak akan menyimpan password, OTP, PIN, token, API key, atau credential lain sebagai ingatan. Simpan rahasia seperti itu di pengelola sandi yang aman.";

type PendingGroupControl = {
  kind: "forget-self" | "reset-group" | "remember-sensitive";
  expiresAt: number;
  identities: string[];
  authorityEpoch: number;
  timer: NodeJS.Timeout | null;
  memory: GroupMemoryConsentProposal | null;
};

type PendingRoomMemory = {
  proposalId: string;
  accountId: string;
  identities: string[];
  kind: GroupRoomMemoryKind;
  content: string;
  authorityEpoch: number;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
};

type GroupMemoryConsentProposal = {
  accountId: string;
  identities: string[];
  kind: Understanding["memories"][number]["kind"];
  content: string;
};

type GroupMemoryCandidateResult = {
  saved: GroupMemberMemoryItem[];
  consent: GroupMemoryConsentProposal | null;
  explicitlyRememberedIds: string[];
  explicitDuplicateContent: string | null;
  explicitSaveFailed: boolean;
  forbiddenSecret: boolean;
};

type GroupRiskMarker = {
  identities: string[];
  level: "dukungan" | "bahaya";
  alone: boolean;
  certain: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
};

type GroupSafetyPreflight = {
  ingress: GroupIngressAssessment | null;
  hint: RiskHint;
  triage: RiskTriage | null | undefined;
  triageAttempted: boolean;
};

type GroupControlReply = {
  text: string;
  retainContext: boolean;
  savedMemories: readonly GroupMemberMemoryItem[];
  savedMemoryIdentities: readonly string[] | null;
  pendingToClear: PendingGroupControl | null;
  pendingToSet: {
    kind: "forget-self" | "reset-group";
    identities: readonly string[];
    authorityEpoch: number;
  } | null;
  savedRoomMemories: readonly GroupRoomMemoryItem[];
  roomProposalToSet: PendingRoomMemory | null;
  roomProposalToClear: PendingRoomMemory | null;
};

type ActiveAmbientPlanner = {
  controller: AbortController;
  messageId: string;
  participantIds: Set<string>;
};

type PendingAmbientCandidate = {
  runtimeKey: string;
  scopeKey: string;
  generation: number;
  message: GroupMessage;
  plan: GroupParticipationPlan;
  retainContext: boolean;
  createdAt: number;
  lastObservedAt: number;
  newerTurns: number;
  timer: NodeJS.Timeout | null;
  taskScheduled: boolean;
  controller: AbortController | null;
};

export interface GroupUsageControlPort {
  allow(ownerId: string): Promise<void>;
  forget(ownerId: string): Promise<void>;
  forgetActor?(
    ownerId: string,
    actorAliases: readonly string[],
  ): Promise<boolean>;
  // Implementations may return an optional user-facing usage notice. Group
  // orchestration deliberately ignores that value, but keeping the return
  // type open lets the private-chat economy authority surface threshold
  // transitions without coupling this subsystem to billing domain types.
  markDelivered?(ownerId: string): Promise<unknown>;
  discardUndelivered?(ownerId: string): Promise<void>;
}

const NOOP_GROUP_USAGE_CONTROL: GroupUsageControlPort = {
  allow: async () => undefined,
  forget: async () => undefined,
  forgetActor: async () => false,
  markDelivered: async () => undefined,
  discardUndelivered: async () => undefined,
};

export const GROUP_NOTICE_VERSION = 9;
export function groupNotice(operationalLogRetentionDays = 14): string {
  return [
    "Halo, aku Harvy—AI yang ikut ngobrol sebagai anggota grup ini. Pesan live yang memicu pemberitahuan ini akan kuproses setelah pemberitahuan terkirim; sesudahnya, pesan baru di grup dapat diproses oleh satu atau lebih penyedia model AI pihak ketiga supaya aku bisa memahami konteks dan tahu kapan perlu nimbrung. Kalau penyedia utama gagal, permintaan yang sama dapat dikirim ulang ke penyedia cadangan. Aku tidak membaca riwayat dari sebelum aku hadir.",
    "",
    "Konteks chat mentah hanya berada di memori proses sampai 24 giliran atau 2 jam dan hilang saat proses dimulai ulang; pesan yang dinilai sensitif atau berisiko tidak dimasukkan ke konteks itu. Untuk kesinambungan grup ini, aku menyimpan nama grup dan julukanku selama masih aktif, serta ID teknis anggota pada kanal ini (termasuk pasangan identitas yang diketahui), nama tampilan/koreksinya, waktu terakhir terlihat, dan hitungan pesan harian paling lama 30 hari. ID pesan teknis untuk mencegah pemrosesan ulang disimpan paling lama 24 jam. Kalau kamu bicara langsung kepadaku, fakta biasa yang singkat dan berguna dapat kusimpan sebagai memori anggota yang hanya berlaku di grup ini; catatan sementara kedaluwarsa setelah 60 hari, sedangkan identitas, preferensi, dan rutinitas bertahan selama grup aktif sampai kamu menghapusnya. Hal yang dinilai sensitif tidak pernah kusimpan otomatis. Anggota juga dapat mengusulkan keputusan, agenda, kebiasaan, kegiatan, atau catatan bersama dengan perintah “ingat untuk grup: …”; catatan itu baru disimpan setelah admin mengonfirmasi preview persisnya, terlihat oleh seluruh anggota, dan kedaluwarsa setelah 60 hari. Kalau menyebut siapa paling aktif, jendelanya selalu 7 hari—bukan cap kepribadian. Catatan teknis pemakaian AI menyimpan model/tier, jumlah token, latensi, keberhasilan, dan perkiraan biaya tanpa isi percakapan, mengikuti masa retensi operasional.",
    "",
    "Bila suatu permintaan eksplisit diterima sebagai GroupAgentRun, record pekerjaan yang dapat disimpan memuat permintaan awal dan judul pekerjaan, input anggota yang teratribusi ke peserta dan pesan sumber, referensi Run Anchor, ledger teknis upaya kerja dan delivery, serta hasil akhir yang sudah terkirim. Record dengan audience grup ini berada di file lokal terpisah paling lama 7 hari; ia bukan memori privat, riwayat chat privat, atau transcript penyedia/model. Saat Harvy dinonaktifkan atau dikeluarkan dari grup, penghapusan record tersebut langsung dicoba; record tetap tunduk pada batas retensi 7 hari bila cleanup penyimpanan sementara gagal.",
    "",
    `Sistem juga membuat log operasional terpisah untuk mengevaluasi gangguan: waktu, komponen, tahap, durasi, status, kode error, dan fingerprint teknis. Log ini tidak berisi isi chat, prompt atau balasan AI, nama/ID grup dan anggota, nomor telepon, QR, kode pairing, token, atau kredensial. Trace acak hanya berlaku selama satu proses. File lokal Harvy dirotasi dan dihapus paling lama setelah ${operationalLogRetentionDays} hari; bila deployment meneruskan log aman ini ke collector perusahaan, retensi collector mengikuti kebijakan infrastruktur yang terpisah.`,
    "",
    'Semua itu terpisah per grup dan per anggota; tidak dibawa ke chat pribadi, grup lain, atau kanal lain. Memori sosial, memori bersama, memori anggota, dan catatan teknis pemakaian AI dihapus saat aku dikeluarkan atau dinonaktifkan; hanya pasangan ID grup, ID akun Harvy, dan waktu penonaktifan yang dipertahankan sebagai binding teknis agar akun lain tidak mengambil alih diam-diam. Tag atau balas pesanku lalu tulis “lihat memori grup” untuk memeriksanya, “lupakan tentang aku” untuk meminta penghapusan catatanmu, atau “reset memori grup” jika kamu admin; penghapusan diri dan reset perlu konfirmasi kedua. Admin dapat menghapus satu catatan bersama dengan “hapus catatan grup #ID”. Reset admin hanya menghapus state bersama dan tidak mengambil alih memori member-local milik anggota. Aku berhenti memproses pesan baru kalau dikeluarkan atau dinonaktifkan.',
  ].join("\n");
}

export const GROUP_NOTICE = groupNotice();

export interface GroupSafetyPort {
  triageRisk(
    message: string,
    ownerId?: string,
    context?: HarvyContext,
    signal?: AbortSignal,
  ): Promise<RiskTriage | null>;
  reviewReply(
    message: string,
    reply: string,
    triage?: Pick<RiskTriage, "level" | "alone" | "certain">,
    ownerId?: string,
    context?: HarvyContext,
  ): Promise<boolean | null>;
}

export interface GroupMemoryExtractionPort {
  understand(
    message: string,
    context?: HarvyContext,
    runtime?: ConversationRuntime,
  ): Promise<Understanding | null>;
  assessMemoryPrivacy?(
    candidates: readonly ExtractedMemory[],
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<boolean | null>;
}

export interface GroupIngressAssessmentPort {
  assessGroupIngress(
    message: string,
    context?: HarvyContext,
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<GroupIngressAssessment | null>;
}

export type GroupRuntimeAdmissionResolver = (
  message: GroupMessage,
) => Promise<GroupRuntimeAdmission>;

const ALLOW_GROUP_RUNTIME_ADMISSION: GroupRuntimeAdmissionResolver =
  async () => "process";

export type GroupNoticeTarget = Pick<GroupMessage, "scope" | "accountId">;

export interface GroupReplyDeliveryResult {
  /** Gabungan logical dari bubble yang benar-benar diakui transport. */
  text: string;
  bubbleCount: number;
  complete: boolean;
}

/**
 * Transport memakai error ini hanya ketika sebagian bubble sudah terkirim
 * sebelum kegagalan transport. Core tetap dapat mencatat kenyataan delivery
 * tanpa menganggap seluruh jawaban pernah sampai.
 */
export class GroupReplyPartialDeliveryError extends Error {
  readonly name = "GroupReplyPartialDeliveryError";

  constructor(
    readonly delivery: GroupReplyDeliveryResult,
    readonly deliveryCause: unknown,
  ) {
    super("Pengiriman balasan grup berhenti setelah sebagian bubble terkirim.");
  }
}

export interface GroupTransport {
  sendNotice(
    target: GroupNoticeTarget,
    text: string,
    runtimeFence?: GroupActivationFence,
  ): Promise<void>;
  sendReply(
    message: GroupMessage,
    text: string,
    runtimeFence?: GroupActivationFence,
  ): Promise<void | GroupReplyDeliveryResult>;
  sendTyping?(target: GroupNoticeTarget): Promise<void>;
  createProgress?(
    target: GroupNoticeTarget,
    seed: string,
    runtimeFence: GroupActivationFence,
  ): ConversationProgressLifecycle;
}

interface GroupProgressSlot {
  current: ConversationProgressLifecycle | null;
}

const ALLOW_GROUP_ACTIVATION_FENCE: GroupActivationFence = () => true;

export type GroupTurnOutcome =
  | "replied"
  | "silent"
  | "duplicate"
  | "before-join"
  | "inactive"
  | "binding-conflict"
  | "notice-failed"
  | "stopped";

/**
 * Pipeline sosial grup yang netral kanal. Adapter WhatsApp hanya mengubah event
 * Baileys menjadi `GroupMessage` dan menyediakan cara kirim.
 */
export class GroupTurnService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly context = new Map<string, GroupTurn[]>();
  private readonly contextTimers = new Map<string, NodeJS.Timeout>();
  private readonly generation = new Map<string, number>();
  private readonly observations = new Map<string, number>();
  private readonly settledObservations = new Map<string, number>();
  private readonly observedMessageIds =
    new Map<string, Map<string, { revision: number; generation: number }>>();
  private readonly joinedAtByRuntime = new Map<string, number>();
  private readonly aliasesByRuntime = new Map<string, string[]>();
  private readonly priorityReservations =
    new Map<string, Map<string, number>>();
  private readonly activeAmbient =
    new Map<string, ActiveAmbientPlanner>();
  private readonly pendingAmbient =
    new Map<string, PendingAmbientCandidate>();
  private readonly priorityQueue: (() => void)[] = [];
  private readonly priorityControllers =
    new Map<string, Set<AbortController>>();
  private priorityActive = 0;
  private readonly pendingControls = new Map<string, PendingGroupControl>();
  private readonly pendingRoomMemories = new Map<string, PendingRoomMemory>();
  private readonly riskMarkers = new Map<string, GroupRiskMarker>();
  private readonly priorityTasks = new Set<Promise<void>>();
  private readonly observationChains = new Map<string, Promise<void>>();
  private readonly noticeReady = new Set<string>();
  private accepting = true;

  constructor(
    private readonly memories: GroupMemoryService,
    private readonly conversation: GroupConversationPort,
    private readonly safety: GroupSafetyPort,
    private readonly transport: GroupTransport,
    private readonly noticeVersion = GROUP_NOTICE_VERSION,
    private readonly now: () => Date = () => new Date(),
    private readonly usageControl: GroupUsageControlPort =
      NOOP_GROUP_USAGE_CONTROL,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.group-turn"),
    private readonly operationalLogRetentionDays = 14,
    private readonly timeZone = "Asia/Jakarta",
    private readonly memoryExtractor: GroupMemoryExtractionPort | null = null,
    private readonly authority: GroupAuthorityResolver =
      DENY_GROUP_AUTHORITY_RESOLVER,
    private readonly ingressAssessment: GroupIngressAssessmentPort | null =
      null,
    private readonly runtimeAdmission: GroupRuntimeAdmissionResolver =
      ALLOW_GROUP_RUNTIME_ADMISSION,
  ) {}

  /**
   * Memvalidasi ingress sebelum observasinya boleh mengubah state supersession.
   * Adapter memanggil ini sebelum settle/batching; event tanpa `social.read`,
   * binding live, notice, atau bubble pasca-join ditolak tanpa efek.
   */
  async observeAuthorized(message: GroupMessage): Promise<GroupMessage | null> {
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    const previous = this.observationChains.get(runtimeKey) ?? Promise.resolve();
    const running = previous
      .catch(() => undefined)
      .then(() => this.resolveAuthorizedObservation(message));
    const barrier: Promise<void> = running.then(
      (): void => this.releaseObservation(runtimeKey, barrier),
      (): void => this.releaseObservation(runtimeKey, barrier),
    );
    this.observationChains.set(runtimeKey, barrier);
    return running;
  }

  private async resolveAuthorizedObservation(
    message: GroupMessage,
  ): Promise<GroupMessage | null> {
    if (!this.accepting) return null;
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    const generation = this.generationOf(runtimeKey);
    const authority = await this.currentAuthority(message);
    if (
      !this.accepting ||
      !authority ||
      !groupAuthorityAllows(authority.role, "social.read") ||
      !this.isCurrentGeneration(runtimeKey, generation)
    ) {
      return null;
    }
    const binding = await this.memories.binding(scopeKey);
    if (!this.accepting || !this.isCurrentGeneration(runtimeKey, generation)) {
      return null;
    }
    let aliases = this.aliasesByRuntime.get(runtimeKey);
    if (
      !aliases &&
      binding?.accountId === message.accountId &&
      binding.disabledAt === null
    ) {
      const memory = await this.memories.memory(scopeKey);
      if (!this.accepting || !this.isCurrentGeneration(runtimeKey, generation)) {
        return null;
      }
      aliases = [...(memory?.harvyAliases ?? ["Harvy"])];
      this.aliasesByRuntime.set(runtimeKey, aliases);
    }
    const authorized = this.decorateAddressing({
      ...message,
      isAdmin: authority.role === "admin",
      authorityEpoch: authority.authorityEpoch,
    }, runtimeKey, aliases);
    // Binding/notice yang belum siap tetap harus mencapai FIFO agar `process`
    // dapat mengaktivasi atau mengulang notice. Sentinel 0 berarti authority
    // sudah terbukti, tetapi state supersession belum boleh dimutasi.
    if (!binding) return { ...authorized, ingressRevision: 0 };
    if (binding.accountId !== message.accountId) {
      return { ...authorized, ingressRevision: 0 };
    }
    this.rememberJoinedAt(scopeKey, message.accountId, binding.joinedAt);
    const eligible = messageAfterJoin(authorized, binding.joinedAt);
    if (!eligible) return null;
    if (
      binding.disabledAt !== null ||
      binding.noticeVersion !== this.noticeVersion ||
      binding.noticeSentAt === null
    ) {
      return { ...eligible, ingressRevision: 0 };
    }
    this.noticeReady.add(scopeKey);
    return this.commitObservation(eligible);
  }

  private releaseObservation(
    runtimeKey: string,
    barrier: Promise<void>,
  ): void {
    if (this.observationChains.get(runtimeKey) === barrier) {
      this.observationChains.delete(runtimeKey);
    }
  }

  /** Nomor observasi hanya boleh dibuat setelah `observeAuthorized`. */
  private commitObservation(message: GroupMessage): GroupMessage {
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    message = this.decorateAddressing(message, runtimeKey);
    const previousRevision = this.observedMessageIds
      .get(runtimeKey)
      ?.get(message.messageId);
    if (previousRevision !== undefined) {
      return { ...message, ingressRevision: previousRevision.revision };
    }

    const currentRevision = this.observations.get(runtimeKey) ?? 0;
    const joinedAt = this.joinedAtByRuntime.get(runtimeKey);
    const messageAt = Date.parse(message.at);
    if (
      joinedAt !== undefined &&
      Number.isFinite(messageAt) &&
      messageAt < joinedAt
    ) {
      return { ...message, ingressRevision: currentRevision };
    }

    const revision = currentRevision + 1;
    this.abortSupersededAmbient(runtimeKey, message);
    this.observePendingAmbient(runtimeKey, message);
    this.observations.set(runtimeKey, revision);
    const ids =
      this.observedMessageIds.get(runtimeKey) ??
        new Map<string, { revision: number; generation: number }>();
    while (ids.size >= MAX_OBSERVED_MESSAGE_IDS) {
      const oldest = ids.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
    ids.set(message.messageId, {
      revision,
      generation: this.generationOf(runtimeKey),
    });
    this.observedMessageIds.set(runtimeKey, ids);
    return { ...message, ingressRevision: revision };
  }

  private decorateAddressing(
    message: GroupMessage,
    runtimeKey: string,
    aliases = this.aliasesByRuntime.get(runtimeKey) ?? ["Harvy"],
  ): GroupMessage {
    if (message.mentionsHarvy || !addressesAlias(message.text, aliases)) {
      return message;
    }
    // Hanya derivasi lokal setelah authority. Batcher memakai flag ini untuk
    // settle direct; keputusan akhir tetap dihitung lagi di full turn.
    return { ...message, mentionsHarvy: true };
  }

  /**
   * Watermark content-free sesudah delivery pertanyaan GroupAgentRun. Jawaban
   * hanya sah pada revision yang lebih baru dari nilai ini.
   */
  currentIngressRevision(scopeKey: string, accountId: string): number {
    return this.observations.get(groupRuntimeKey(scopeKey, accountId)) ?? 0;
  }

  /** Menutup watermark observasi yang sengaja ditolak sebelum full turn. */
  settleRejectedObservation(message: GroupMessage): void {
    const revision = message.ingressRevision ?? 0;
    if (revision <= 0) return;
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    const observed = this.observedMessageIds
      .get(runtimeKey)
      ?.get(message.messageId);
    if (
      !observed ||
      observed.revision !== revision ||
      observed.generation !== this.generationOf(runtimeKey)
    ) {
      return;
    }
    this.settledObservations.set(
      runtimeKey,
      Math.max(this.settledObservations.get(runtimeKey) ?? 0, revision),
    );
  }

  /**
   * Fixed ACK lokal sebelum debounce. Tidak menjalankan classifier, planner,
   * final reply, atau mutasi; full turn tetap masuk lewat `handle()` dan FIFO.
   */
  async preflightUrgent(message: GroupMessage): Promise<void> {
    if (!this.accepting) return;
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    if (message.ingressRevision === undefined) {
      const observed = await this.observeAuthorized(message);
      if (!observed) return;
      message = observed;
    }
    const generation = this.generationOf(runtimeKey);
    const ingressAuthority = await this.currentAuthority(message);
    if (
      !ingressAuthority ||
      !groupAuthorityAllows(ingressAuthority.role, "social.read") ||
      !this.isCurrentGeneration(runtimeKey, generation)
    ) {
      return;
    }
    message = {
      ...message,
      isAdmin: ingressAuthority.role === "admin",
      authorityEpoch: ingressAuthority.authorityEpoch,
    };
    const binding = await this.memories.binding(scopeKey);
    if (
      !binding ||
      binding.accountId !== message.accountId ||
      binding.disabledAt !== null ||
      binding.noticeVersion !== this.noticeVersion ||
      binding.noticeSentAt === null ||
      !this.isCurrentGeneration(runtimeKey, generation)
    ) {
      return;
    }
    this.rememberJoinedAt(
      scopeKey,
      message.accountId,
      binding.joinedAt,
    );
    this.noticeReady.add(scopeKey);
    const eligibleMessage = messageAfterJoin(message, binding.joinedAt);
    if (
      !eligibleMessage ||
      !hasExplicitImmediateGroupDanger(eligibleMessage)
    ) {
      return;
    }
    message = eligibleMessage;
    await this.acknowledgeUrgent(
      scopeKey,
      generation,
      message,
      Promise.resolve(null),
      true,
    );
  }

  async activateGroup(
    message: Pick<GroupMessage, "scope" | "accountId" | "groupName" | "at">,
    fence: GroupActivationFence = ALLOW_GROUP_ACTIVATION_FENCE,
  ): Promise<"active" | "binding-conflict" | "notice-failed" | "inactive"> {
    const scopeKey = groupScopeKey(message.scope);
    return this.enqueue(scopeKey, async () => {
      if (!fence()) return "inactive";
      const result = await this.memories.activate(
        message.scope,
        message.accountId,
        message.groupName,
        message.at,
        fence,
      );
      if (result.status === "inactive") return "inactive";
      if (result.status === "conflict") return "binding-conflict";
      const rollbackCreatedActivation = async (): Promise<void> => {
        if (result.created) {
          await this.memories.disable(scopeKey, message.accountId);
          await this.usageControl.forget(scopeKey);
        }
      };
      if (!fence()) {
        await rollbackCreatedActivation();
        return "inactive";
      }
      this.rememberJoinedAt(
        scopeKey,
        message.accountId,
        result.binding.joinedAt,
      );
      await this.usageControl.allow(scopeKey);
      if (!fence()) {
        await rollbackCreatedActivation();
        return "inactive";
      }
      const noticeReady = await this.ensureNotice(message, scopeKey, fence);
      if (!fence()) {
        await rollbackCreatedActivation();
        return "inactive";
      }
      return noticeReady ? "active" : "notice-failed";
    });
  }

  async handle(message: GroupMessage): Promise<GroupTurnOutcome> {
    if (!this.accepting) return "stopped";
    const scopeKey = groupScopeKey(message.scope);
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    if (message.ingressRevision === undefined) {
      const observed = await this.observeAuthorized(message);
      if (!observed) return "inactive";
      message = observed;
    }
    const capturedObservation = message.ingressRevision ?? 0;
    const observationState = { value: capturedObservation };
    const capturedGeneration = this.generationOf(runtimeKey);

    // Tidak ada isi pesan yang boleh mencapai classifier/model sebelum core
    // sendiri membuktikan membership. Adapter ingress tetap hanya hint.
    const ingressAuthority = await this.currentAuthority(message);
    if (
      !ingressAuthority ||
      !groupAuthorityAllows(ingressAuthority.role, "social.read") ||
      !this.isCurrentGeneration(runtimeKey, capturedGeneration)
    ) {
      this.settleRejectedObservation(message);
      return "inactive";
    }
    message = {
      ...message,
      isAdmin: ingressAuthority.role === "admin",
      authorityEpoch: ingressAuthority.authorityEpoch,
    };
    this.generation.set(runtimeKey, capturedGeneration);
    this.observations.set(
      runtimeKey,
      Math.max(
        this.observations.get(runtimeKey) ?? 0,
        capturedObservation,
      ),
    );

    const ingressBinding = await this.memories.binding(scopeKey);
    const liveNoticeReady = Boolean(
      ingressBinding &&
        ingressBinding.accountId === message.accountId &&
        ingressBinding.disabledAt === null &&
        ingressBinding.noticeVersion === this.noticeVersion &&
        ingressBinding.noticeSentAt !== null,
    );
    if (liveNoticeReady && ingressBinding) {
      this.rememberJoinedAt(
        scopeKey,
        message.accountId,
        ingressBinding.joinedAt,
      );
      this.noticeReady.add(scopeKey);
    } else {
      this.noticeReady.delete(scopeKey);
    }
    const queueBusy = this.queues.has(scopeKey) && liveNoticeReady;
    const priorityMessage = ingressBinding
      ? messageAfterJoin(message, ingressBinding.joinedAt)
      : null;
    const immediateDanger = priorityMessage
      ? hasExplicitImmediateGroupDanger(priorityMessage)
      : false;
    const directPriority = Boolean(
      priorityMessage?.mentionsHarvy || priorityMessage?.repliesToHarvy,
    );
    const priorityEligible =
      this.isCurrentGeneration(runtimeKey, capturedGeneration) &&
      liveNoticeReady &&
      priorityMessage !== null &&
      (immediateDanger || (queueBusy && directPriority)) &&
      this.reservePriorityAction(
        scopeKey,
        priorityMessage,
        "assessment",
      );
    const priorityContext = priorityMessage
      ? toSafetyContext(
          this.contextFor(scopeKey),
          participantIdentities(priorityMessage),
          this.riskMarker(
            scopeKey,
            participantIdentities(priorityMessage),
          ),
        )
      : { summary: null, turns: [], memories: [] };
    const preflight = priorityEligible
      ? this.schedulePriorityAssessment(
          runtimeKey,
          capturedGeneration,
          (signal) =>
          this.buildSafetyPreflight(
            priorityMessage.text,
            scopeKey,
            priorityContext,
            immediateDanger,
            signal,
            () =>
              this.accepting &&
              this.isCurrentGeneration(
                runtimeKey,
                capturedGeneration,
              ),
          ),
        )
      : Promise.resolve(null);
    if (priorityEligible) {
      this.trackPriorityTask(preflight.then(() => undefined));
      this.trackPriorityTask(
        this.acknowledgeUrgent(
          scopeKey,
          capturedGeneration,
          priorityMessage,
          preflight,
          immediateDanger,
        ),
      );
    }

    try {
      return await this.enqueue(scopeKey, async () => {
        if (
          !this.accepting
        ) {
          return "stopped";
        }
        if (capturedGeneration !== this.generationOf(runtimeKey)) {
          return "inactive";
        }
        return this.process(
          scopeKey,
          capturedGeneration,
          observationState,
          message,
          await preflight,
          false,
        );
      });
    } finally {
      if (
        this.accepting &&
        capturedGeneration === this.generationOf(runtimeKey)
      ) {
        this.settledObservations.set(
          runtimeKey,
          Math.max(
            this.settledObservations.get(runtimeKey) ?? 0,
            observationState.value,
          ),
        );
      }
    }
  }

  /**
   * Removal membatalkan balasan model yang masih aktif sebelum menunggu tulis
   * binding. Socket tidak boleh sempat mengirim reply lama setelah Harvy keluar.
   */
  async disableGroup(scopeKey: string, accountId: string): Promise<boolean> {
    const runtimeKey = groupRuntimeKey(scopeKey, accountId);
    // Barrier dipasang sebelum I/O pertama. Dengan begitu read binding yang
    // lambat tidak memberi balasan lama kesempatan melewati removal.
    this.generation.set(runtimeKey, this.generationOf(runtimeKey) + 1);
    this.observations.delete(runtimeKey);
    this.settledObservations.delete(runtimeKey);
    this.observedMessageIds.delete(runtimeKey);
    this.joinedAtByRuntime.delete(runtimeKey);
    this.aliasesByRuntime.delete(runtimeKey);
    this.priorityReservations.delete(runtimeKey);
    this.abortPriorityAssessments(runtimeKey);
    this.abortAmbient(runtimeKey);
    this.cancelPendingAmbient(runtimeKey);
    this.clearContext(scopeKey);
    this.clearPendingControls(scopeKey);
    this.clearRiskMarkers(scopeKey);
    this.noticeReady.delete(scopeKey);
    // Generation dibump sebelum I/O agar handler lama berhenti. Repository
    // sendiri menserialisasi disable dengan write memori yang sedang berjalan;
    // controlReply juga memeriksa generation tepat sebelum setiap mutasi.
    const disabled = await this.memories.disable(scopeKey, accountId);
    const binding = await this.memories.binding(scopeKey);
    if (
      binding?.accountId === accountId &&
      binding.disabledAt !== null
    ) {
      await this.usageControl.forget(scopeKey);
    }
    return disabled;
  }

  /**
   * Dipanggil adapter ketika metadata peserta/role berubah. Ini bukan disable:
   * konteks sosial tetap ada, tetapi semua proposal/handler yang membawa epoch
   * authority lama harus berhenti sebelum efek berikutnya.
   */
  invalidateAuthority(
    scopeKey: string,
    accountId: string,
    _authorityEpoch?: number,
  ): void {
    const runtimeKey = groupRuntimeKey(scopeKey, accountId);
    this.generation.set(runtimeKey, this.generationOf(runtimeKey) + 1);
    this.abortPriorityAssessments(runtimeKey);
    this.abortAmbient(runtimeKey);
    this.cancelPendingAmbient(runtimeKey);
    this.clearPendingControls(scopeKey);
    this.clearRiskMarkers(scopeKey);
  }

  stopIngress(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const runtimeKey of this.generation.keys()) {
      this.generation.set(
        runtimeKey,
        this.generationOf(runtimeKey) + 1,
      );
    }
    this.observations.clear();
    this.settledObservations.clear();
    this.observedMessageIds.clear();
    this.joinedAtByRuntime.clear();
    this.aliasesByRuntime.clear();
    this.priorityReservations.clear();
    for (const runtimeKey of this.priorityControllers.keys()) {
      this.abortPriorityAssessments(runtimeKey);
    }
    for (const runtimeKey of this.activeAmbient.keys()) {
      this.abortAmbient(runtimeKey);
    }
    for (const runtimeKey of this.pendingAmbient.keys()) {
      this.cancelPendingAmbient(runtimeKey);
    }
    for (const scopeKey of this.context.keys()) this.clearContext(scopeKey);
    for (const pending of new Set(this.pendingControls.values())) {
      this.clearPendingControl(pending);
    }
    for (const pending of new Set(this.pendingRoomMemories.values())) {
      this.clearPendingRoomMemory(pending);
    }
    for (const marker of new Set(this.riskMarkers.values())) {
      this.clearRiskMarker(marker);
    }
    this.noticeReady.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([
      ...this.observationChains.values(),
      ...this.queues.values(),
      ...this.priorityTasks,
    ]);
  }

  private async process(
    scopeKey: string,
    generation: number,
    observation: { value: number },
    message: GroupMessage,
    preflight: GroupSafetyPreflight | null,
    typingAlreadyStarted: boolean,
  ): Promise<GroupTurnOutcome> {
    const progress: GroupProgressSlot = { current: null };
    try {
      return await this.processTurn(
        scopeKey,
        generation,
        observation,
        message,
        preflight,
        typingAlreadyStarted,
        progress,
      );
    } finally {
      await progress.current?.finish();
    }
  }

  private async processTurn(
    scopeKey: string,
    generation: number,
    observation: { value: number },
    message: GroupMessage,
    preflight: GroupSafetyPreflight | null,
    typingAlreadyStarted: boolean,
    progressSlot: GroupProgressSlot,
  ): Promise<GroupTurnOutcome> {
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    // Adapter melakukan membership gate sedini mungkin, tetapi core tetap
    // tidak mempercayai flag ingress sebagai authority. Revalidate semua
    // pengirim sebelum binding, notice, aktivitas, konteks, atau memori ditulis.
    const ingressAuthority = await this.currentAuthority(message);
    if (
      !ingressAuthority ||
      !groupAuthorityAllows(ingressAuthority.role, "social.read")
    ) {
      return "inactive";
    }
    message = {
      ...message,
      isAdmin: ingressAuthority.role === "admin",
      authorityEpoch: ingressAuthority.authorityEpoch,
    };
    let binding = await this.memories.binding(scopeKey);
    if (!this.isCurrentGeneration(runtimeKey, generation)) {
      return "inactive";
    }
    const activationFence = () =>
      this.accepting && this.isCurrentGeneration(runtimeKey, generation);
    if (!binding) {
      const activation = await this.memories.activate(
        message.scope,
        message.accountId,
        message.groupName,
        earliestMessageAt(message),
        activationFence,
      );
      if (!this.isCurrentGeneration(runtimeKey, generation)) {
        return "inactive";
      }
      if (activation.status === "inactive") return "inactive";
      if (activation.status === "conflict") return "binding-conflict";
      binding = activation.binding;
      await this.usageControl.allow(scopeKey);
      if (!this.isCurrentGeneration(runtimeKey, generation)) {
        await this.usageControl.forget(scopeKey);
        return "inactive";
      }
    }

    if (binding.accountId !== message.accountId) return "binding-conflict";
    if (binding.disabledAt !== null) return "inactive";
    this.rememberJoinedAt(
      scopeKey,
      message.accountId,
      binding.joinedAt,
    );

    const noticeReady = await this.ensureNotice(
      message,
      scopeKey,
      activationFence,
    );
    if (!this.isCurrentGeneration(runtimeKey, generation)) {
      this.clearRuntimeState(scopeKey, runtimeKey);
      return "inactive";
    }
    if (!noticeReady) return "notice-failed";

    const eligibleMessage = messageAfterJoin(message, binding.joinedAt);
    if (!eligibleMessage) return "before-join";
    message = eligibleMessage;
    if (observation.value <= 0) {
      message = this.commitObservation(message);
      observation.value = message.ingressRevision ?? 0;
    }

    if (
      preflight === null &&
      hasExplicitImmediateGroupDanger(message)
    ) {
      this.trackPriorityTask(
        this.acknowledgeUrgent(
          scopeKey,
          generation,
          message,
          Promise.resolve(null),
          true,
        ),
      );
    }

    const recorded = await this.memories.recordIncoming(message);
    if (!this.isCurrentGeneration(runtimeKey, generation)) {
      this.clearRuntimeState(scopeKey, runtimeKey);
      return "inactive";
    }
    if (recorded.status === "duplicate") return "duplicate";
    if (recorded.status === "inactive") return "inactive";
    message = messageWithParts(message, recorded.parts);
    if (parseUsageDashboardCommand(message.text) !== null) {
      // Billing pribadi tidak pernah dibaca dari audience grup. Jalur ini juga
      // berhenti sebelum context/memory retrieval maupun model invocation.
      return this.deliver(
        scopeKey,
        generation,
        message,
        USAGE_GROUP_PRIVACY_MESSAGE,
        false,
        "control",
      );
    }
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      this.clearContext(scopeKey);
      return "inactive";
    }

    const memory = await this.memories.memory(scopeKey);
    const roomMemories = await this.memories.roomMemories(scopeKey);
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      this.clearRuntimeState(scopeKey, runtimeKey);
      return "inactive";
    }
    const storedPrior = this.contextFor(scopeKey);
    this.aliasesByRuntime.set(
      runtimeKey,
      [...(memory?.harvyAliases ?? ["Harvy"])],
    );
    message = resolvedParticipantMessage(message, memory, this.memories);
    const prior = resolvedParticipantTurns(
      storedPrior,
      memory,
      this.memories,
    );
    const direct =
      message.mentionsHarvy ||
      message.repliesToHarvy ||
      addressesAlias(
        message.text,
        memory?.harvyAliases ?? ["Harvy"],
      );
    if (direct && !progressSlot.current && this.transport.createProgress) {
      try {
        progressSlot.current = this.transport.createProgress(
          message,
          message.messageId,
          activationFence,
        );
        progressSlot.current.report({ phase: "reading", detail: "general" });
      } catch (error) {
        this.logger.debug(
          "group_progress_creation_failed",
          "Status kerja grup tidak dapat dibuat; giliran tetap diproses.",
          { error },
        );
      }
    }
    const progress = progressSlot.current;
    if (direct) this.cancelPendingAmbient(runtimeKey);
    const memberMemories = direct
      ? await this.memories.memberMemories(
          scopeKey,
          participantIdentities(message),
          message.text,
        )
      : [];
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      this.clearRuntimeState(scopeKey, runtimeKey);
      return "inactive";
    }
    const conversationContext: GroupConversationContext = {
      turns: prior,
      memberMemories,
      roomMemories,
      groupName: memory?.groupName ?? message.groupName,
      harvyAliases: memory?.harvyAliases ?? ["Harvy"],
      now: this.now().toISOString(),
      timeZone: this.timeZone,
      direct,
    };
    const riskMarker = this.riskMarker(
      scopeKey,
      participantIdentities(message),
    );
    if (
      direct &&
      riskMarker === null &&
      isPureModelIdentityQuestion(message.text)
    ) {
      this.pushTurn(scopeKey, {
        role: "member",
        participantId: message.participantId,
        participantName: message.participantName,
        text: message.text,
        at: message.at,
        messageId: message.messageId,
      });
      await progress?.responding?.();
      return this.deliver(
        scopeKey,
        generation,
        message,
        CAPYBARA_MODEL_REPLY,
        true,
        "direct",
      );
    }

    const safetyContinuation =
      riskMarker !== null && isShortSafetyContinuation(message);
    const safetyContext = toSafetyContext(
      prior,
      participantIdentities(message),
      riskMarker,
    );
    const immediateDanger = hasExplicitImmediateGroupDanger(message);

    let ingress = preflight?.ingress ?? null;
    let memoryUnderstanding: Understanding | null = null;
    let ambientPlan: GroupParticipationPlan | null = null;
    if (direct) {
      if (!typingAlreadyStarted && !progress) {
        this.trackPriorityTask(this.showTyping(message));
      }
      progress?.report({ phase: "checking", detail: "consistency" });
      const [ingressResult, understandingResult] = await Promise.all([
        preflight
          ? Promise.resolve(preflight.ingress)
          : this.safeAssessGroupIngress(
              message.text,
              scopeKey,
              safetyContext,
            ),
        this.memoryExtractor && !immediateDanger
          ? this.memoryExtractor
              .understand(
                message.text,
                memberMemoryContext(memberMemories, scopeKey),
                {
                  ownerId: scopeKey,
                  timeZone: this.timeZone,
                  scope: groupAgentScope(
                    message.scope.channel,
                    message.scope.groupId,
                    message.participantId,
                  ),
                },
              )
              .catch((error: unknown) => {
                this.logger.warn(
                  "group_member_memory_extraction_failed",
                  "Ekstraksi memori anggota grup gagal tanpa memengaruhi balasan.",
                  { error },
                );
                return null;
              })
          : Promise.resolve(null),
      ]);
      ingress = ingressResult;
      memoryUnderstanding = understandingResult;
    } else {
      const staleBeforePlanning = this.isAmbientSuperseded(
        runtimeKey,
        observation.value,
      ) || Boolean(
        !message.repliesToHarvy &&
          (message.quotedMessageId || message.quotedParticipantId),
      ) || shouldHoldAmbientTurn(message.text);
      let planner: ActiveAmbientPlanner | null = null;
      if (
        !staleBeforePlanning &&
        !immediateDanger &&
        preflight?.triage?.level !== "bahaya"
      ) {
        planner = {
          controller: new AbortController(),
          messageId: message.messageId,
          participantIds: new Set(participantIdentities(message)),
        };
        this.activeAmbient.set(runtimeKey, planner);
      }
      try {
        if (preflight?.triage?.level === "bahaya") {
          ambientPlan = null;
          ingress = preflight.ingress;
        } else if (
          planner &&
          !preflight
        ) {
          const assessment = await this.conversation
            .assessAmbient(
              message,
              conversationContext,
              scopeKey,
              planner.controller.signal,
            )
            .catch((error: unknown) => {
              if (!planner?.controller.signal.aborted) {
                this.logger.warn(
                  "group_participation_planner_failed",
                  "Planner partisipasi dan ingress grup gagal; Harvy memilih diam.",
                  { error },
                );
              }
              return null;
            });
          ambientPlan = assessment?.plan ?? null;
          ingress = assessment
            ? {
                riskHint: assessment.riskHint,
                contextPrivacy: assessment.contextPrivacy,
              }
            : null;
        } else {
          const [plan, ingressResult] = await Promise.all([
            planner
              ? this.conversation
                  .planAmbient(
                    message,
                    conversationContext,
                    scopeKey,
                    planner.controller.signal,
                  )
                  .catch((error: unknown) => {
                    if (!planner?.controller.signal.aborted) {
                      this.logger.warn(
                        "group_participation_planner_failed",
                        "Planner partisipasi grup gagal; Harvy memilih diam.",
                        { error },
                      );
                    }
                    return null;
                  })
              : Promise.resolve(null),
            preflight
              ? Promise.resolve(preflight.ingress)
              : this.safeAssessGroupIngress(
                  message.text,
                  scopeKey,
                  safetyContext,
                ),
          ]);
          ambientPlan = plan;
          ingress = ingressResult;
        }
      } finally {
        if (
          planner &&
          this.activeAmbient.get(runtimeKey) === planner
        ) {
          this.activeAmbient.delete(runtimeKey);
        }
      }
    }

    const rawRiskHint = ingress?.riskHint ?? null;
    let effectiveHint = rawRiskHint ?? NO_RISK_HINT;
    if (safetyContinuation && riskMarker) {
      effectiveHint = strongerRiskHint(effectiveHint, {
        level: riskMarker.level === "bahaya" ? "strong" : "possible",
        category: "acute_distress",
        confidence: riskMarker.level === "bahaya" ? 1 : 0.7,
      });
    }
    effectiveHint = withImmediateDangerHint(effectiveHint, immediateDanger);
    const triageRequired =
      immediateDanger ||
      safetyContinuation ||
      rawRiskHint === null ||
      effectiveHint.level !== "none";
    const triageResult = preflight?.triageAttempted
      ? preflight.triage
      : triageRequired
        ? await this.safeTriage(message.text, scopeKey, safetyContext)
        : undefined;
    const riskAssessment = resolveRiskAssessment(
      effectiveHint,
      triageResult,
    );
    // Field legacy ini hanya membantu prompt/fallback. Authority retensi tetap
    // `contextPrivacy` di bawah dan tidak berasal dari triase akut.
    riskAssessment.sensitive = ingress?.contextPrivacy !== "ordinary";

    if (!(await this.isCurrentTurn(scopeKey, generation, message.accountId))) {
      this.clearRuntimeState(scopeKey, runtimeKey);
      return "inactive";
    }
    if (riskAssessment.level !== "biasa") {
      this.cancelPendingAmbient(runtimeKey);
      this.setRiskMarker(
        scopeKey,
        participantIdentities(message),
        riskAssessment,
      );
    } else if (riskMarker && !safetyContinuation) {
      this.clearRiskMarker(riskMarker);
    }

    // Pesan sensitif/berisiko boleh dipahami untuk giliran ini, tetapi tidak
    // menjadi konteks otomatis yang diputar ulang pada percakapan grup nanti.
    const retainContext =
      ingress?.contextPrivacy === "ordinary" &&
      riskAssessment.disposition === "calm" &&
      riskAssessment.certain;
    const effectPermissions = safetyEffectPermissions(
      riskAssessment.routing,
      immediateDanger,
    );
    if (retainContext) {
      this.pushTurn(scopeKey, {
        role: "member",
        participantId: message.participantId,
        participantName: message.participantName,
        text: message.text,
        at: message.at,
        messageId: message.messageId,
      });
      this.noteAcceptedTurnForPending(runtimeKey, message);
    }

    if (
      !direct &&
      riskAssessment.level !== "bahaya" &&
      !immediateDanger
    ) {
      // Dukungan yang tidak meminta Harvy tetap privat bagi percakapan manusia.
      // Hanya bahaya dekat atau emergency lokal eksplisit yang boleh menembus
      // keputusan ambient.
      if (
        riskAssessment.level !== "biasa" ||
        safetyContinuation ||
        ambientPlan?.decision !== "speak" ||
        !ambientPlan.reply
      ) {
        return "silent";
      }
      if (this.isAmbientSuperseded(runtimeKey, observation.value)) {
        this.rememberPendingAmbient(
          runtimeKey,
          scopeKey,
          generation,
          message,
          ambientPlan,
          retainContext,
        );
        return "silent";
      }
      if (!ambientBudgetAllows(ambientPlan, prior, this.now())) {
        return "silent";
      }
    }

    const explicitDataControl = isExplicitGroupControl(message.text);
    if (
      direct &&
      (retainContext ||
        (effectPermissions.explicitControl && explicitDataControl))
    ) {
      const controlReply = await this.controlReply(
        scopeKey,
        generation,
        message,
        memory,
        () => this.isCurrentTurn(scopeKey, generation, message.accountId),
      );
      if (controlReply !== null) {
        if (
          !(await this.isCurrentTurn(
            scopeKey,
            generation,
            message.accountId,
          ))
        ) {
          this.clearRuntimeState(scopeKey, runtimeKey);
          return "inactive";
        }
        await progress?.responding?.();
        const outcome = await this.deliver(
          scopeKey,
          generation,
          message,
          controlReply.text,
          retainContext && controlReply.retainContext,
          "control",
          controlReply.savedMemories,
          null,
          controlReply.savedMemoryIdentities,
          controlReply.savedRoomMemories,
        );
        if (outcome === "replied") {
          if (controlReply.pendingToClear) {
            this.clearPendingControl(controlReply.pendingToClear);
          }
          if (controlReply.pendingToSet) {
            this.setPendingControl(
              scopeKey,
              controlReply.pendingToSet.identities,
              controlReply.pendingToSet.kind,
              controlReply.pendingToSet.authorityEpoch,
            );
          }
          if (controlReply.roomProposalToClear) {
            this.clearPendingRoomMemory(controlReply.roomProposalToClear);
          }
          if (controlReply.roomProposalToSet) {
            this.setPendingRoomMemory(
              scopeKey,
              controlReply.roomProposalToSet,
            );
          }
        }
        return outcome;
      }
    }

    let reply: string;
    if (
      !direct &&
      riskAssessment.level === "biasa" &&
      ambientPlan?.decision === "speak" &&
      ambientPlan.reply &&
      ambientPlan.reason !== "fact_correction"
    ) {
      reply = ambientPlan.reply;
    } else {
      try {
        reply = await this.conversation.reply(
          message,
          conversationContext,
          riskAssessment,
          scopeKey,
          undefined,
          progress ?? undefined,
        );
      } catch (error) {
        this.logger.error(
          "group_reply_generation_failed",
          "Penyusunan balasan grup gagal; balasan aman dipakai.",
          error,
        );
        reply =
          riskAssessment.level === "biasa"
            ? GROUP_AI_FAILURE_REPLY
            : groupSafetyFallback(riskAssessment.level);
      }
    }
    if (needsConditionalReplyReview(riskAssessment.routing)) {
      progress?.report({ phase: "checking", detail: "consistency" });
      const approved = await this.safety
        .reviewReply(
          message.text,
          reply,
          riskAssessment,
          scopeKey,
          safetyContext,
        )
        .catch((error: unknown) => {
          this.logger.error(
            "group_reply_review_failed",
            "Pemeriksaan balasan grup gagal; balasan aman dipakai.",
            error,
          );
          return null;
        });
      if (approved !== true) {
        reply = groupSafetyFallback(riskAssessment.level);
      }
    }

    if (
      riskAssessment.level === "biasa" &&
      !groupReplyPassesNarrowGuard(reply, direct ? "direct" : "ambient")
    ) {
      this.logger.warn(
        "group_reply_narrow_guard_rejected",
        "Balasan grup melanggar pagar output sempit.",
        { origin: direct ? "direct" : "ambient" },
      );
      if (!direct) return "silent";
      reply = GROUP_AI_FAILURE_REPLY;
    }

    const memoryCandidates =
      direct &&
      effectPermissions.generalState &&
      reply !== GROUP_AI_FAILURE_REPLY &&
      memoryUnderstanding
        ? await this.saveMemberMemoryCandidates(
            scopeKey,
            generation,
            message,
            memoryUnderstanding,
          )
        : {
            saved: [],
            consent: null,
            explicitlyRememberedIds: [],
            explicitDuplicateContent: null,
            explicitSaveFailed: false,
            forbiddenSecret: false,
          };
    const savedMemories = memoryCandidates.saved;
    if (memoryCandidates.forbiddenSecret) {
      reply = GROUP_MEMORY_SECRET_REJECTION;
    } else {
      if (
        savedMemories.length > 0 ||
        memoryCandidates.explicitDuplicateContent
      ) {
        reply = normalizeMemoryWriteEmoji(reply);
      }
      if (memoryCandidates.explicitSaveFailed) {
        reply = withGroupMemorySaveFailure(reply);
      }
      const replyAlreadyAcknowledges = replyAcknowledgesMemoryWrite(reply);
      const noticeItems = replyAlreadyAcknowledges ? [] : savedMemories;
      if (noticeItems.length > 0) {
        reply = withGroupMemoryNotes(reply, noticeItems);
      }
      if (
        memoryCandidates.explicitDuplicateContent &&
        !replyAlreadyAcknowledges
      ) {
        reply = withGroupMemoryDuplicateNote(
          reply,
        );
      }
      if (memoryCandidates.consent) {
        reply = withSensitiveMemoryConsentNote(reply);
      }
    }

    await progress?.responding?.();
    return this.deliver(
      scopeKey,
      generation,
      message,
      reply,
      retainContext,
      direct
        ? "direct"
        : riskAssessment.level !== "biasa"
          ? "safety"
          : "ambient",
      savedMemories,
      memoryCandidates.consent,
    );
  }

  private async saveMemberMemoryCandidates(
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    understanding: Understanding,
  ): Promise<GroupMemoryCandidateResult> {
    const saved: GroupMemberMemoryItem[] = [];
    const explicitlyRememberedIds: string[] = [];
    let explicitDuplicateContent: string | null = null;
    let explicitSaveFailed = false;
    let consent: GroupMemoryConsentProposal | null = null;
    const extracted = understanding.memories.slice(0, 2);
    const explicitRememberSignaled =
      understanding.memoryAction === "remember" &&
      understanding.taskAction === null &&
      understanding.task === null;
    const authority = explicitRememberSignaled
      ? explicitMemoryRememberAuthority(message.text, extracted)
      : null;
    if (authority?.forbiddenSecret) {
      return {
        saved,
        consent,
        explicitlyRememberedIds,
        explicitDuplicateContent,
        explicitSaveFailed,
        forbiddenSecret: true,
      };
    }
    if (
      explicitRememberSignaled &&
      authority &&
      authority.candidateIndexes.length === 0
    ) {
      return {
        saved,
        consent,
        explicitlyRememberedIds,
        explicitDuplicateContent,
        explicitSaveFailed: true,
        forbiddenSecret: false,
      };
    }
    if (explicitRememberSignaled && !authority) {
      return {
        saved,
        consent,
        explicitlyRememberedIds,
        explicitDuplicateContent,
        explicitSaveFailed,
        forbiddenSecret: false,
      };
    }
    const authorizedIndexes = new Set(authority?.candidateIndexes ?? []);
    const candidates = extracted
      .map((candidate, index) => ({
        candidate,
        explicitConsent: authorizedIndexes.has(index),
      }))
      .filter(({ candidate }) =>
        !containsForbiddenMemorySecret(candidate.content));
    if (candidates.length === 0) {
      return {
        saved,
        consent,
        explicitlyRememberedIds,
        explicitDuplicateContent,
        explicitSaveFailed,
        forbiddenSecret: false,
      };
    }

    let sensitive = candidates.some(
      ({ candidate }) => candidate.kind === "personal",
    );
    if (!sensitive) {
      try {
        // Classifier ini hanya melihat kandidat durable, bukan raw context.
        // Port hilang, parse error, dan outage semuanya gagal tertutup.
        sensitive =
          (await this.memoryExtractor?.assessMemoryPrivacy?.(
            candidates.map(({ candidate }) => candidate),
            scopeKey,
          )) ?? true;
      } catch (error) {
        sensitive = true;
        this.logger.warn(
          "group_member_memory_privacy_failed",
          "Penilaian privasi kandidat memori grup gagal; consent diwajibkan.",
          { error },
        );
      }
    }

    for (const { candidate, explicitConsent } of candidates) {
      try {
        const result = await this.memories.rememberParticipantMemory(
          scopeKey,
          message.accountId,
          participantIdentities(message),
          {
            kind: candidate.kind,
            content: candidate.content,
            sensitivity: sensitive ? "sensitive" : "ordinary",
            consent: explicitConsent ? "explicit" : "notice",
            source: explicitConsent ? "explicit" : "conversation",
          },
          this.authorityMutationGuard(
            scopeKey,
            generation,
            message,
            message.authorityEpoch ?? 0,
            "member.self.manage",
          ),
        );
        if (result.status === "saved") {
          saved.push(result.item);
          if (explicitConsent) explicitlyRememberedIds.push(result.item.id);
        }
        if (
          result.status === "duplicate" &&
          explicitConsent &&
          !explicitDuplicateContent
        ) {
          explicitDuplicateContent = candidate.content;
        }
        if (
          explicitConsent &&
          result.status !== "saved" &&
          result.status !== "duplicate"
        ) {
          explicitSaveFailed = true;
        }
        if (result.status === "requires-consent" && !consent) {
          consent = {
            accountId: message.accountId,
            identities: participantIdentities(message),
            kind: candidate.kind,
            content: candidate.content,
          };
        }
      } catch (error) {
        if (explicitConsent) explicitSaveFailed = true;
        this.logger.warn(
          "group_member_memory_save_failed",
          "Penyimpanan memori anggota grup gagal tanpa mengubah balasan.",
          { error },
        );
      }
    }
    return {
      saved,
      consent,
      explicitlyRememberedIds,
      explicitDuplicateContent,
      explicitSaveFailed,
      forbiddenSecret: false,
    };
  }

  private async controlReply(
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    currentMemory: Awaited<ReturnType<GroupMemoryService["memory"]>>,
    isCurrent: () => Promise<boolean>,
  ): Promise<GroupControlReply | null> {
    const normalized = normalize(message.text);
    const identities = linkedParticipantIdentities(
      currentMemory,
      participantIdentities(message),
      this.memories,
    );
    const pending = this.pendingControl(scopeKey, identities);
    const pendingRoom = this.pendingRoomMemory(scopeKey);

    if (confirmsSensitiveMemory(normalized)) {
      if (pending?.kind !== "remember-sensitive" || !pending.memory) {
        return controlReply(
          "Persetujuan memori itu sudah tidak ada atau kedaluwarsa. Sampaikan lagi hal yang ingin kamu minta kusimpan.",
        );
      }
      if (!(await isCurrent())) return null;
      const proposal = pending.memory;
      const result = await this.memories.rememberParticipantMemory(
        scopeKey,
        proposal.accountId,
        proposal.identities,
        {
          kind: proposal.kind,
          content: proposal.content,
          sensitivity: "sensitive",
          consent: "explicit",
          source: "explicit",
        },
        this.authorityMutationGuard(
          scopeKey,
          generation,
          message,
          message.authorityEpoch ?? 0,
          "member.self.manage",
        ),
      );
      return controlReply(
        result.status === "saved"
          ? "Sudah kusimpan sebagai memori anggota yang hanya berlaku di grup ini. Kamu bisa melihat, mengoreksi, atau menghapusnya kapan saja."
          : result.status === "duplicate"
            ? "Hal itu sudah ada di memori anggotamu untuk grup ini."
            : "Aku belum bisa menyimpan memori itu. Tidak ada data baru yang ditulis.",
        true,
        result.status === "saved" ? [result.item] : [],
        result.status === "saved" ? proposal.identities : null,
        result.status === "saved" || result.status === "duplicate"
          ? pending
          : null,
      );
    }

    const roomConfirmationId = confirmsRoomMemory(normalized);
    if (roomConfirmationId) {
      if (!pendingRoom || pendingRoom.proposalId !== roomConfirmationId) {
        return controlReply(
          "Proposal catatan grup itu sudah tidak ada, berbeda, atau kedaluwarsa. Minta preview baru sebelum menyimpan.",
        );
      }
      const authority = await this.currentAuthority(message);
      if (!authority) {
        return controlReply(
          "Catatan bersama hanya dapat dikonfirmasi admin grup dengan status yang masih berlaku.",
        );
      }
      if (authority.authorityEpoch !== pendingRoom.authorityEpoch) {
        this.clearPendingRoomMemory(pendingRoom);
        return controlReply(
          "Keanggotaan atau hak admin grup berubah sejak preview dibuat. Proposal dibatalkan; ajukan lagi agar otoritasnya diperiksa ulang.",
        );
      }
      if (!groupAuthorityAllows(authority.role, "room.confirm")) {
        return controlReply(
          "Catatan bersama hanya dapat dikonfirmasi admin grup dengan status yang masih berlaku.",
        );
      }
      if (!(await isCurrent())) return null;
      const authorityGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        authority.authorityEpoch,
        "room.confirm",
      );
      const result = await this.memories.rememberRoomMemory(
        scopeKey,
        pendingRoom.accountId,
        pendingRoom.identities,
        pendingRoom.kind,
        pendingRoom.content,
        true,
        authorityGuard,
      );
      const reply = controlReply(
        result.status === "saved"
          ? `Sudah kusimpan sebagai catatan bersama grup selama ${ROOM_MEMORY_RETENTION_DAYS} hari. Semua anggota dapat melihatnya dan admin dapat menghapusnya.`
          : result.status === "duplicate"
            ? "Catatan bersama yang sama sudah ada di grup ini."
            : "Catatan bersama belum dapat disimpan. Tidak ada data baru yang ditulis.",
        true,
      );
      if (result.status === "saved") {
        reply.savedRoomMemories = [result.item];
      }
      if (result.status === "saved" || result.status === "duplicate") {
        reply.roomProposalToClear = pendingRoom;
      }
      return reply;
    }

    const memoryEdit = extractMemberMemoryEdit(message.text);
    if (memoryEdit) {
      if (!(await isCurrent())) return null;
      const memberGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        message.authorityEpoch ?? 0,
        "member.self.manage",
      );
      const edited = await this.memories.editParticipantMemory(
        scopeKey,
        identities,
        memoryEdit.id,
        memoryEdit.content,
        message.accountId,
        memberGuard,
      );
      if (!edited && !(await memberGuard())) return null;
      return controlReply(
        edited
          ? "Sudah, memori anggota itu dikoreksi untuk grup ini."
          : "Aku tidak menemukan tepat satu memori milikmu dengan ID itu.",
      );
    }

    const memoryDeleteId = extractMemberMemoryDelete(message.text);
    if (memoryDeleteId) {
      if (!(await isCurrent())) return null;
      const memberGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        message.authorityEpoch ?? 0,
        "member.self.manage",
      );
      const removed = await this.memories.removeParticipantMemory(
        scopeKey,
        identities,
        memoryDeleteId,
        message.accountId,
        memberGuard,
      );
      if (!removed && !(await memberGuard())) return null;
      return controlReply(
        removed
          ? "Sudah, satu memori anggota itu kuhapus dari grup ini."
          : "Aku tidak menemukan tepat satu memori milikmu dengan ID itu.",
        false,
      );
    }

    const roomMemoryDeleteId = extractRoomMemoryDelete(message.text);
    if (roomMemoryDeleteId) {
      const authority = await this.currentAuthority(message);
      if (
        !authority ||
        !groupAuthorityAllows(authority.role, "room.delete")
      ) {
        return controlReply(
          "Catatan bersama grup hanya dapat dihapus admin dengan status yang masih berlaku.",
        );
      }
      if (!(await isCurrent())) return null;
      const authorityGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        authority.authorityEpoch,
        "room.delete",
      );
      const removed = await this.memories.removeRoomMemory(
        scopeKey,
        roomMemoryDeleteId,
        message.accountId,
        authorityGuard,
      );
      if (!removed && !(await authorityGuard())) return null;
      return controlReply(
        removed
          ? "Sudah, satu catatan bersama kuhapus dari grup ini."
          : "Aku tidak menemukan tepat satu catatan grup dengan ID itu.",
        false,
      );
    }

    if (confirmsForgetSelf(normalized)) {
      if (pending?.kind !== "forget-self") {
        return controlReply(
          "Konfirmasi hapusnya sudah tidak ada atau kedaluwarsa. Minta “lupakan tentang aku” lagi kalau masih ingin menghapusnya.",
        );
      }
      if (!(await isCurrent())) return null;
      const memberGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        message.authorityEpoch ?? 0,
        "member.self.manage",
      );
      let forgotten = false;
      try {
        forgotten = await this.memories.forgetParticipant(
          scopeKey,
          pending.identities,
          message.accountId,
          memberGuard,
        );
      } catch (error) {
        this.logger.error(
          "group_member_forget_failed",
          "Penghapusan data anggota grup gagal; proposal lama dibatalkan.",
          error,
        );
      }
      if (!forgotten && !(await memberGuard())) return null;
      let usageForgotten = false;
      try {
        usageForgotten = await this.usageControl.forgetActor?.(
          scopeKey,
          pending.identities,
        ) ?? false;
      } catch (error) {
        this.logger.warn(
          "group_usage_forget_failed",
          "Penghapusan atribusi pemakaian grup gagal; data percakapan tetap dihapus bila sudah berhasil.",
          { error },
        );
      }
      this.clearPendingControl(pending);
      const roomPendingForParticipant = this.pendingRoomMemory(scopeKey);
      if (
        roomPendingForParticipant &&
        roomPendingForParticipant.identities.some((identity) =>
          pending.identities.includes(identity),
        )
      ) {
        this.clearPendingRoomMemory(roomPendingForParticipant);
      }
      this.removeParticipantContext(scopeKey, pending.identities);
      this.clearRiskMarkersForIdentities(scopeKey, pending.identities);
      const forgetReply = usageForgotten
        ? "Sudah. Catatan aktivitasmu, memori tentangmu, dan atribusi teknis penggunaan AI-mu di grup ini kuhapus."
        : forgotten
          ? "Sudah. Catatan aktivitas dan memori tentangmu di grup ini kuhapus. Atribusi teknis pemakaian tidak dapat dihapus pada percobaan ini."
          : "Aku belum punya catatan tentangmu di grup ini.";
      return controlReply(
        forgetReply,
        false,
      );
    }

    if (confirmsResetGroup(normalized)) {
      if (pending?.kind !== "reset-group") {
        return controlReply(
          "Konfirmasi resetnya sudah tidak ada atau kedaluwarsa. Minta reset lagi kalau memang masih diperlukan.",
        );
      }
      const authority = await this.currentAuthority(message);
      if (!authority) {
        return controlReply(
          "Reset state bersama grup hanya bisa dikonfirmasi admin dengan status yang masih berlaku.",
        );
      }
      if (authority.authorityEpoch !== pending.authorityEpoch) {
        this.clearPendingControl(pending);
        return controlReply(
          "Keanggotaan atau hak admin berubah sejak permintaan reset. Konfirmasi lama dibatalkan; minta reset lagi.",
        );
      }
      if (!groupAuthorityAllows(authority.role, "social.reset")) {
        return controlReply(
          "Reset state bersama grup hanya bisa dikonfirmasi admin dengan status yang masih berlaku.",
        );
      }
      if (!(await isCurrent())) return null;
      const resetGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        authority.authorityEpoch,
        "social.reset",
      );
      const reset = await this.memories.resetMemory(
        scopeKey,
        message.accountId,
        resetGuard,
      );
      if (!reset) {
        if (!(await resetGuard())) return null;
        return controlReply(
          "Tidak ada julukan, statistik sosial, atau catatan bersama yang perlu direset.",
          false,
          [],
          null,
          pending,
        );
      }
      this.clearContext(scopeKey);
      const roomPending = this.pendingRoomMemory(scopeKey);
      if (roomPending) this.clearPendingRoomMemory(roomPending);
      this.aliasesByRuntime.set(
        groupRuntimeKey(scopeKey, message.accountId),
        ["Harvy"],
      );
      return controlReply(
        "Julukan, statistik sosial, dan catatan bersama grup ini sudah direset. Memori member-local tiap anggota tidak ikut dihapus; nama grup, binding akun, dan penanda pesan teknis tetap dipertahankan.",
        false,
        [],
        null,
        pending,
      );
    }

    if (asksForgetSelf(normalized)) {
      if (isNegatedOrTentative(normalized)) return null;
      const reply = controlReply(
        "Untuk memastikan ini memang permintaanmu, balas lagi dalam 10 menit dengan “ya, lupakan tentang aku”.",
      );
      reply.pendingToSet = {
        kind: "forget-self",
        identities,
        authorityEpoch: message.authorityEpoch ?? 0,
      };
      return reply;
    }

    if (asksResetGroup(normalized)) {
      if (isNegatedOrTentative(normalized)) return null;
      const authority = await this.currentAuthority(message);
      if (
        !authority ||
        !groupAuthorityAllows(authority.role, "social.reset")
      ) {
        return controlReply(
          "Reset state bersama grup hanya bisa diminta admin grup. Catatan tentang dirimu sendiri tetap bisa kamu hapus dengan bilang “lupakan tentang aku”.",
        );
      }
      const reply = controlReply(
        "Reset akan menghapus julukan, statistik sosial, dan catatan bersama. Memori member-local anggota tidak ikut dihapus. Kalau yakin, balas lagi dalam 10 menit dengan “ya, reset memori grup”.",
      );
      reply.pendingToSet = {
        kind: "reset-group",
        identities,
        authorityEpoch: authority.authorityEpoch,
      };
      return reply;
    }

    const correctedName = extractOwnNameCorrection(message.text);
    if (correctedName && !isNegatedOrTentative(normalized)) {
      if (!(await isCurrent())) return null;
      const memberGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        message.authorityEpoch ?? 0,
        "member.self.manage",
      );
      const corrected = await this.memories.correctParticipantName(
        scopeKey,
        message.accountId,
        identities,
        correctedName,
        memberGuard,
      );
      if (!corrected && !(await memberGuard())) return null;
      return controlReply(
        corrected
          ? `Oke, untuk memori grup ini aku akan menampilkan namamu sebagai “${correctedName}”.`
          : "Aku belum punya catatan aktivitasmu yang bisa dikoreksi. Setelah kamu mengirim pesan di grup ini, coba lagi.",
      );
    }

    const alias = extractAlias(message.text);
    if (alias && !isNegatedOrTentative(normalized)) {
      const authority = await this.currentAuthority(message);
      if (
        !authority ||
        !groupAuthorityAllows(authority.role, "alias.manage")
      ) {
        return controlReply(
          "Untuk mencegah satu anggota membuatku terpanggil di setiap obrolan, julukan Harvy di grup hanya bisa ditambahkan admin.",
        );
      }
      if (!(await isCurrent())) return null;
      const aliasGuard = this.authorityMutationGuard(
        scopeKey,
        generation,
        message,
        authority.authorityEpoch,
        "alias.manage",
      );
      const added = await this.memories.rememberHarvyAlias(
        scopeKey,
        message.accountId,
        alias,
        aliasGuard,
      );
      if (!added && !(await aliasGuard())) return null;
      if (added) {
        const runtimeKey = groupRuntimeKey(
          scopeKey,
          message.accountId,
        );
        this.aliasesByRuntime.set(runtimeKey, [
          ...new Set([
            ...(this.aliasesByRuntime.get(runtimeKey) ?? ["Harvy"]),
            alias,
          ]),
        ]);
      }
      return controlReply(
        added
          ? `Oke, di grup ini aku juga kenal panggilan “${alias}”.`
          : `Panggilan “${alias}” sudah kukenal di grup ini atau bentuknya belum bisa kusimpan.`,
      );
    }

    const roomProposal = extractRoomMemoryProposal(message.text);
    if (roomProposal && !isNegatedOrTentative(normalized)) {
      const authority = await this.currentAuthority(message);
      if (
        !authority ||
        !groupAuthorityAllows(authority.role, "room.propose")
      ) {
        return controlReply(
          "Aku belum bisa memverifikasi membership grup untuk membuat proposal catatan bersama. Coba lagi setelah metadata grup tersedia.",
        );
      }
      const proposalId = roomProposalId(
        scopeKey,
        message,
        roomProposal.kind,
        roomProposal.content,
        authority.authorityEpoch,
      );
      const proposal: PendingRoomMemory = {
        proposalId,
        accountId: message.accountId,
        identities,
        kind: roomProposal.kind,
        content: roomProposal.content,
        authorityEpoch: authority.authorityEpoch,
        expiresAt: this.now().getTime() + CONTROL_CONFIRMATION_MS,
        timer: null,
      };
      const reply = controlReply(
        `Preview catatan bersama [#${proposalId}] (${roomProposal.kind}): “${roomProposal.content}”\nCatatan ini terlihat oleh semua anggota dan kedaluwarsa setelah ${ROOM_MEMORY_RETENTION_DAYS} hari. Admin dapat menyimpannya dengan membalas dalam 10 menit: “ya, simpan catatan grup #${proposalId}”.`,
      );
      reply.roomProposalToSet = proposal;
      return reply;
    }

    if (asksMemoryList(normalized) || asksActivityRanking(normalized)) {
      const authority = await this.currentAuthority(message);
      if (!authority || !groupAuthorityAllows(authority.role, "room.read")) {
        return controlReply(
          "Aku belum bisa memverifikasi bahwa kamu masih menjadi anggota grup ini. Coba lagi setelah metadata grup tersedia.",
        );
      }
      const memory = currentMemory ?? (await this.memories.memory(scopeKey));
      if (!memory) {
        return controlReply("Belum ada memori sosial grup yang tersimpan.");
      }
      const memberMemories = await this.memories.memberMemories(
        scopeKey,
        identities,
      );
      const roomMemories = await this.memories.roomMemories(scopeKey);
      return controlReply(
        describeMemory(
          memory.groupName,
          memory.harvyAliases,
          this.memories.activityRanking(memory),
          this.memories.participantActivity(memory, identities),
          memberMemories,
          roomMemories,
        ),
      );
    }

    return null;
  }

  private async currentAuthority(
    message: GroupMessage,
  ): Promise<GroupAuthoritySnapshot | null> {
    try {
      return await this.authority.resolveGroupAuthority({
        scope: message.scope,
        accountId: message.accountId,
        participantIds: participantIdentities(message),
        claimedAdmin: message.isAdmin,
        claimedAuthorityEpoch: message.authorityEpoch ?? 0,
      });
    } catch (error) {
      this.logger.warn(
        "group_authority_resolution_failed",
        "Otoritas grup gagal direvalidasi; efek berprivilege ditolak.",
        { error },
      );
      return null;
    }
  }

  private async currentRuntimeAdmission(
    message: GroupMessage,
  ): Promise<GroupRuntimeAdmission> {
    try {
      return await this.runtimeAdmission(message);
    } catch (error) {
      this.logger.warn(
        "group_runtime_admission_failed",
        "Mode runtime grup gagal direvalidasi; work aktif ditolak.",
        { error },
      );
      return "inactive";
    }
  }

  /**
   * Guard yang dibawa sampai tepat sebelum repository write. Pemeriksaan awal
   * di `controlReply` saja masih membuka jendela ketika metadata otoritas
   * berubah saat repository sedang membaca/prune; guard ini mengikat mutasi
   * pada generation giliran dan epoch+role terbaru.
   */
  private authorityMutationGuard(
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    expectedEpoch: number,
    action: Parameters<typeof groupAuthorityAllows>[1],
  ): GroupMutationGuard {
    return async () => {
      if (!(await this.isCurrentTurn(scopeKey, generation, message.accountId))) {
        return false;
      }
      const current = await this.currentAuthority(message);
      return Boolean(
        current &&
          current.authorityEpoch === expectedEpoch &&
          groupAuthorityAllows(current.role, action),
      );
    };
  }

  private async deliver(
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    reply: string,
    retainContext: boolean,
    origin: "direct" | "ambient" | "control" | "safety",
    savedMemories: readonly GroupMemberMemoryItem[] = [],
    memoryConsent: GroupMemoryConsentProposal | null = null,
    savedMemoryIdentities: readonly string[] | null = null,
    savedRoomMemories: readonly GroupRoomMemoryItem[] = [],
  ): Promise<GroupTurnOutcome> {
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      await this.rollbackMemberMemories(
        scopeKey,
        message.accountId,
        savedMemoryIdentities ?? participantIdentities(message),
        savedMemories,
      );
      await this.rollbackRoomMemories(
        scopeKey,
        message.accountId,
        savedRoomMemories,
      );
      return "inactive";
    }
    const runtimeAdmission = await this.currentRuntimeAdmission(message);
    if (runtimeAdmission !== "process") {
      try {
        await this.usageControl.discardUndelivered?.(scopeKey);
      } catch (discardError) {
        this.logger.warn(
          "group_entitlement_discard_failed",
          "Kandidat entitlement grup gagal dibatalkan setelah mode runtime berubah.",
          { error: discardError },
        );
      }
      await this.rollbackMemberMemories(
        scopeKey,
        message.accountId,
        savedMemoryIdentities ?? participantIdentities(message),
        savedMemories,
      );
      await this.rollbackRoomMemories(
        scopeKey,
        message.accountId,
        savedRoomMemories,
      );
      if (origin === "ambient") {
        this.cancelPendingAmbient(runtimeKey);
      }
      return runtimeAdmission;
    }
    if (!this.isCurrentGeneration(runtimeKey, generation)) {
      await this.rollbackMemberMemories(
        scopeKey,
        message.accountId,
        savedMemoryIdentities ?? participantIdentities(message),
        savedMemories,
      );
      await this.rollbackRoomMemories(
        scopeKey,
        message.accountId,
        savedRoomMemories,
      );
      return "inactive";
    }
    if (
      origin === "ambient" &&
      this.isAmbientSuperseded(
        runtimeKey,
        message.ingressRevision ?? 0,
      )
    ) {
      return "silent";
    }
    if (origin === "ambient") {
      const pending = this.pendingAmbient.get(runtimeKey);
      if (
        pending &&
        pending.message.messageId !== message.messageId
      ) {
        this.cancelPendingAmbient(runtimeKey);
      }
    }

    const expectedObservation = message.ingressRevision ??
      (this.observations.get(runtimeKey) ?? 0);
    const deliveryFence = () =>
      this.isCurrentGeneration(runtimeKey, generation) &&
      (this.observations.get(runtimeKey) ?? 0) === expectedObservation;
    let delivery: GroupReplyDeliveryResult = {
      text: reply.trim(),
      bubbleCount: 1,
      complete: true,
    };
    let partialDeliveryFailure: unknown = null;
    try {
      const reported = await this.transport.sendReply(
        message,
        reply.trim(),
        deliveryFence,
      );
      if (reported) {
        delivery = {
          text: reported.text.trim(),
          bubbleCount: Math.max(0, Math.trunc(reported.bubbleCount)),
          complete: reported.complete === true,
        };
      }
    } catch (error) {
      if (
        error instanceof GroupReplyPartialDeliveryError &&
        error.delivery.text.trim().length > 0
      ) {
        delivery = {
          text: error.delivery.text.trim(),
          bubbleCount: Math.max(
            1,
            Math.trunc(error.delivery.bubbleCount),
          ),
          complete: false,
        };
        partialDeliveryFailure = error.deliveryCause;
      } else {
        try {
          await this.usageControl.discardUndelivered?.(scopeKey);
        } catch (discardError) {
          this.logger.warn(
            "group_entitlement_discard_failed",
            "Kandidat entitlement grup gagal dibatalkan setelah delivery gagal.",
            { error: discardError },
          );
        }
        await this.rollbackMemberMemories(
          scopeKey,
          message.accountId,
          savedMemoryIdentities ?? participantIdentities(message),
          savedMemories,
        );
        await this.rollbackRoomMemories(
          scopeKey,
          message.accountId,
          savedRoomMemories,
        );
        this.removeMessageContext(scopeKey, message);
        try {
          await this.memories.rollbackIncoming(message);
        } catch (rollbackError) {
          this.logger.error(
            "group_incoming_rollback_failed",
            "Rollback pencatatan pesan grup gagal setelah pengiriman balasan gagal.",
            rollbackError,
            { accountId: message.accountId },
          );
        }
        throw error;
      }
    }
    if (!delivery.text) {
      try {
        await this.usageControl.discardUndelivered?.(scopeKey);
      } catch (discardError) {
        this.logger.warn(
          "group_entitlement_discard_failed",
          "Kandidat entitlement grup gagal dibatalkan karena tidak ada bubble yang terkirim.",
          { error: discardError },
        );
      }
      await this.rollbackMemberMemories(
        scopeKey,
        message.accountId,
        savedMemoryIdentities ?? participantIdentities(message),
        savedMemories,
      );
      await this.rollbackRoomMemories(
        scopeKey,
        message.accountId,
        savedRoomMemories,
      );
      return "inactive";
    }
    try {
      await this.usageControl.markDelivered?.(scopeKey);
    } catch (settlementError) {
      this.logger.warn(
        "group_entitlement_delivery_failed",
        "Balasan grup terkirim tetapi settlement delivery belum selesai.",
        { error: settlementError },
      );
    }
    if (!delivery.complete) {
      // Mutasi yang disiapkan untuk respons final tidak boleh bertahan ketika
      // continuation-nya dipotong, kecuali bubble yang terlihat sudah benar-
      // benar mengakui write. Receipt delivery menang atas rencana final.
      const writeAcknowledged = replyAcknowledgesMemoryWrite(delivery.text);
      if (!writeAcknowledged) {
        await this.rollbackMemberMemories(
          scopeKey,
          message.accountId,
          savedMemoryIdentities ?? participantIdentities(message),
          savedMemories,
        );
        await this.rollbackRoomMemories(
          scopeKey,
          message.accountId,
          savedRoomMemories,
        );
      }
    }
    if (retainContext) {
      this.pushTurn(scopeKey, {
        role: "harvy",
        // Pada giliran Harvy, participantId adalah orang yang ditanggapi.
        participantId: message.participantId,
        participantName: message.participantName,
        text: delivery.text,
        at: this.now().toISOString(),
        messageId: message.messageId,
        origin,
      });
    }
    await this.memories.recordHarvyReply(scopeKey, message.accountId);
    if (partialDeliveryFailure !== null) throw partialDeliveryFailure;
    if (!delivery.complete) return "inactive";
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      return "inactive";
    }
    if (memoryConsent) {
      this.setPendingMemoryConsent(scopeKey, memoryConsent);
    }
    return "replied";
  }

  private async rollbackMemberMemories(
    scopeKey: string,
    accountId: string,
    identities: readonly string[],
    items: readonly GroupMemberMemoryItem[],
  ): Promise<void> {
    for (const item of items) {
      try {
        await this.memories.removeParticipantMemory(
          scopeKey,
          identities,
          item.id,
          accountId,
          async () => true,
        );
      } catch (error) {
        this.logger.error(
          "group_member_memory_rollback_failed",
          "Rollback memori anggota grup gagal.",
          error,
        );
      }
    }
  }

  private async rollbackRoomMemories(
    scopeKey: string,
    accountId: string,
    items: readonly GroupRoomMemoryItem[],
  ): Promise<void> {
    for (const item of items) {
      try {
        await this.memories.removeRoomMemory(
          scopeKey,
          item.id,
          accountId,
          async () => true,
        );
      } catch (error) {
        this.logger.error(
          "group_room_memory_rollback_failed",
          "Rollback memori bersama grup gagal.",
          error,
        );
      }
    }
  }

  private async isActive(
    scopeKey: string,
    accountId: string,
  ): Promise<boolean> {
    const binding = await this.memories.binding(scopeKey);
    return (
      binding?.accountId === accountId &&
      binding.disabledAt === null &&
      binding.noticeVersion === this.noticeVersion
    );
  }

  private async isCurrentTurn(
    scopeKey: string,
    generation: number,
    accountId: string,
  ): Promise<boolean> {
    const runtimeKey = groupRuntimeKey(scopeKey, accountId);
    if (
      !this.accepting ||
      generation !== this.generationOf(runtimeKey)
    ) {
      return false;
    }
    const active = await this.isActive(scopeKey, accountId);
    return (
      active &&
      this.accepting &&
      generation === this.generationOf(runtimeKey)
    );
  }

  private async ensureNotice(
    target: GroupNoticeTarget,
    scopeKey: string,
    fence: GroupActivationFence = ALLOW_GROUP_ACTIVATION_FENCE,
  ): Promise<boolean> {
    const binding = await this.memories.binding(scopeKey);
    if (
      !binding ||
      binding.accountId !== target.accountId ||
      binding.disabledAt !== null ||
      !fence()
    ) {
      return false;
    }
    if (
      binding.noticeVersion === this.noticeVersion &&
      binding.noticeSentAt !== null
    ) {
      if (!fence()) return false;
      this.rememberJoinedAt(
        scopeKey,
        target.accountId,
        binding.joinedAt,
      );
      this.noticeReady.add(scopeKey);
      return true;
    }

    try {
      if (!fence()) return false;
      await this.transport.sendNotice(
        target,
        groupNotice(this.operationalLogRetentionDays),
        fence,
      );
    } catch (error) {
      this.logger.error(
        "group_notice_delivery_failed",
        "Notice privasi grup gagal dikirim.",
        error,
        { accountId: target.accountId },
      );
      return false;
    }
    if (!fence()) return false;
    const marked = await this.memories.markNoticeSent(
      scopeKey,
      target.accountId,
      this.noticeVersion,
      fence,
    );
    if (marked && fence()) {
      this.rememberJoinedAt(
        scopeKey,
        target.accountId,
        binding.joinedAt,
      );
      this.noticeReady.add(scopeKey);
    }
    return marked && fence();
  }

  private async acknowledgeUrgent(
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    preflight: Promise<GroupSafetyPreflight | null>,
    immediateDanger: boolean,
  ): Promise<void> {
    const assessment = immediateDanger ? null : await preflight;
    if (
      (!immediateDanger && assessment?.triage?.level !== "bahaya") ||
      !this.accepting
    ) {
      return;
    }
    if (
      !(await this.isCurrentTurn(
        scopeKey,
        generation,
        message.accountId,
      ))
    ) {
      return;
    }
    if ((await this.currentRuntimeAdmission(message)) !== "process") return;
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    if (!this.isCurrentGeneration(runtimeKey, generation)) return;
    if (!this.reservePriorityAction(scopeKey, message, "ack")) return;
    await this.transport.sendReply(message, GROUP_URGENT_ACK);
  }

  private trackPriorityTask(task: Promise<void>): void {
    const handled = task.catch((error: unknown) => {
      this.logger.error(
        "group_priority_task_failed",
        "Tugas prioritas grup gagal.",
        error,
      );
    });
    this.priorityTasks.add(handled);
    void handled.then(() => {
      this.priorityTasks.delete(handled);
    });
  }

  private reservePriorityAction(
    scopeKey: string,
    message: GroupMessage,
    kind: "ack" | "assessment",
  ): boolean {
    const runtimeKey = groupRuntimeKey(scopeKey, message.accountId);
    const joinedAt = this.joinedAtByRuntime.get(runtimeKey);
    const messageAt = Date.parse(message.at);
    if (
      joinedAt === undefined ||
      !Number.isFinite(messageAt) ||
      messageAt < joinedAt - 999
    ) {
      return false;
    }

    const nowMs = this.now().getTime();
    const reservations =
      this.priorityReservations.get(runtimeKey) ??
      new Map<string, number>();
    for (const [messageId, expiresAt] of reservations) {
      if (expiresAt <= nowMs) reservations.delete(messageId);
    }
    const reservationKey = `${kind}:${message.messageId}`;
    if (reservations.has(reservationKey)) return false;
    while (reservations.size >= MAX_OBSERVED_MESSAGE_IDS) {
      const oldest = reservations.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      reservations.delete(oldest);
    }
    reservations.set(
      reservationKey,
      nowMs + PRIORITY_RESERVATION_MS,
    );
    this.priorityReservations.set(runtimeKey, reservations);
    return true;
  }

  private abortSupersededAmbient(
    runtimeKey: string,
    message: GroupMessage,
  ): void {
    const active = this.activeAmbient.get(runtimeKey);
    if (!active) return;
    const sameParticipant = [
      message.participantId,
      ...message.participantAliases,
    ].some((identity) => active.participantIds.has(identity));
    if (
      message.mentionsHarvy ||
      message.repliesToHarvy ||
      sameParticipant ||
      message.quotedMessageId === active.messageId
    ) {
      this.abortAmbient(runtimeKey);
    }
  }

  private abortAmbient(runtimeKey: string): void {
    const active = this.activeAmbient.get(runtimeKey);
    if (!active) return;
    this.activeAmbient.delete(runtimeKey);
    active.controller.abort();
  }

  private observePendingAmbient(
    runtimeKey: string,
    message: GroupMessage,
  ): void {
    const pending = this.pendingAmbient.get(runtimeKey);
    if (!pending) return;
    const targetIdentities = new Set(
      participantIdentities(pending.message),
    );
    const sameParticipant = participantIdentities(message).some(
      (identity) => targetIdentities.has(identity),
    );
    if (
      message.mentionsHarvy ||
      message.repliesToHarvy ||
      sameParticipant ||
      message.quotedMessageId === pending.message.messageId
    ) {
      this.cancelPendingAmbient(runtimeKey);
      return;
    }
    pending.lastObservedAt = this.now().getTime();
    this.schedulePendingAmbient(pending);
  }

  private noteAcceptedTurnForPending(
    runtimeKey: string,
    message: GroupMessage,
  ): void {
    const pending = this.pendingAmbient.get(runtimeKey);
    if (!pending || pending.message.messageId === message.messageId) {
      return;
    }
    pending.newerTurns += 1;
    pending.lastObservedAt = this.now().getTime();
    if (pending.newerTurns > PENDING_AMBIENT_MAX_NEWER_TURNS) {
      this.cancelPendingAmbient(runtimeKey);
      return;
    }
    this.schedulePendingAmbient(pending);
  }

  private rememberPendingAmbient(
    runtimeKey: string,
    scopeKey: string,
    generation: number,
    message: GroupMessage,
    plan: GroupParticipationPlan,
    retainContext: boolean,
  ): void {
    if (!this.conversation.revalidateAmbient || !plan.reply) return;
    this.cancelPendingAmbient(runtimeKey);
    const nowMs = this.now().getTime();
    const pending: PendingAmbientCandidate = {
      runtimeKey,
      scopeKey,
      generation,
      message,
      plan,
      retainContext,
      createdAt: nowMs,
      lastObservedAt: nowMs,
      newerTurns: 0,
      timer: null,
      taskScheduled: false,
      controller: null,
    };
    this.pendingAmbient.set(runtimeKey, pending);
    this.schedulePendingAmbient(pending);
  }

  private schedulePendingAmbient(
    pending: PendingAmbientCandidate,
  ): void {
    if (
      this.pendingAmbient.get(pending.runtimeKey) !== pending ||
      pending.taskScheduled
    ) {
      return;
    }
    const nowMs = this.now().getTime();
    if (
      nowMs - pending.createdAt > PENDING_AMBIENT_MAX_AGE_MS ||
      pending.newerTurns > PENDING_AMBIENT_MAX_NEWER_TURNS
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    const delay = Math.max(
      1,
      PENDING_AMBIENT_QUIET_MS -
        (nowMs - pending.lastObservedAt),
    );
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (
        !this.accepting ||
        this.pendingAmbient.get(pending.runtimeKey) !== pending
      ) {
        return;
      }
      pending.taskScheduled = true;
      const task = this.enqueue(pending.scopeKey, async () => {
        try {
          await this.revalidatePendingAmbient(pending);
        } finally {
          pending.taskScheduled = false;
        }
      });
      this.trackPriorityTask(task);
    }, delay);
    pending.timer.unref();
  }

  private async revalidatePendingAmbient(
    pending: PendingAmbientCandidate,
  ): Promise<void> {
    if (this.pendingAmbient.get(pending.runtimeKey) !== pending) return;
    const nowMs = this.now().getTime();
    if (
      !this.accepting ||
      nowMs - pending.createdAt > PENDING_AMBIENT_MAX_AGE_MS ||
      pending.newerTurns > PENDING_AMBIENT_MAX_NEWER_TURNS ||
      !(await this.isCurrentTurn(
        pending.scopeKey,
        pending.generation,
        pending.message.accountId,
      ))
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    if (
      (await this.currentRuntimeAdmission(pending.message)) !== "process"
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    if (
      nowMs - pending.lastObservedAt < PENDING_AMBIENT_QUIET_MS
    ) {
      pending.taskScheduled = false;
      this.schedulePendingAmbient(pending);
      return;
    }
    const latestObserved =
      this.observations.get(pending.runtimeKey) ??
      pending.message.ingressRevision ??
      0;
    const latestSettled =
      this.settledObservations.get(pending.runtimeKey) ?? 0;
    if (latestSettled < latestObserved) {
      // `observe` berjalan sebelum settle adapter. Jangan menganggap grup
      // hening sampai seluruh bubble yang sudah terlihat benar-benar selesai
      // menjalani pipeline dan masuk (atau ditolak dari) konteks.
      pending.lastObservedAt = nowMs;
      pending.taskScheduled = false;
      this.schedulePendingAmbient(pending);
      return;
    }

    const revalidate = this.conversation.revalidateAmbient;
    if (!revalidate) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    const observation = latestObserved;
    const memory = await this.memories.memory(pending.scopeKey);
    const roomMemories = await this.memories.roomMemories(pending.scopeKey);
    if (this.pendingAmbient.get(pending.runtimeKey) !== pending) return;
    if (
      (await this.currentRuntimeAdmission(pending.message)) !== "process"
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    if (
      !this.isCurrentGeneration(pending.runtimeKey, pending.generation) ||
      this.pendingAmbient.get(pending.runtimeKey) !== pending
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    const prior = resolvedParticipantTurns(
      this.contextFor(pending.scopeKey),
      memory,
      this.memories,
    );
    const context: GroupConversationContext = {
      turns: prior,
      roomMemories,
      groupName: memory?.groupName ?? pending.message.groupName,
      harvyAliases: memory?.harvyAliases ?? ["Harvy"],
      now: this.now().toISOString(),
      timeZone: this.timeZone,
      direct: false,
    };
    const revalidationController = new AbortController();
    pending.controller = revalidationController;
    const plan = await revalidate(
      pending.message,
      pending.plan,
      context,
      pending.scopeKey,
      revalidationController.signal,
    )
      .catch((error: unknown) => {
        if (!revalidationController.signal.aborted) {
          this.logger.warn(
            "group_pending_revalidation_failed",
            "Revalidasi kandidat ambient gagal; Harvy memilih diam.",
            { error },
          );
        }
        return null;
      })
      .finally(() => {
        if (pending.controller === revalidationController) {
          pending.controller = null;
        }
      });
    if (this.pendingAmbient.get(pending.runtimeKey) !== pending) return;
    const latestObservation =
      this.observations.get(pending.runtimeKey) ?? observation;
    if (latestObservation !== observation) {
      pending.lastObservedAt = this.now().getTime();
      pending.taskScheduled = false;
      this.schedulePendingAmbient(pending);
      return;
    }

    if (
      plan?.decision !== "speak" ||
      !plan.reply ||
      !ambientBudgetAllows(plan, prior, this.now())
    ) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    let reply = plan.reply;
    if (plan.reason === "fact_correction") {
      const replyController = new AbortController();
      pending.controller = replyController;
      try {
        reply = await this.conversation.reply(
          pending.message,
          context,
          CALM_TRIAGE,
          pending.scopeKey,
          replyController.signal,
        );
      } catch (error) {
        if (!replyController.signal.aborted) {
          this.logger.warn(
            "group_pending_fact_reply_failed",
            "Regenerasi koreksi fakta ambient gagal; Harvy memilih diam.",
            { error },
          );
        }
        this.cancelPendingAmbient(pending.runtimeKey);
        return;
      } finally {
        if (pending.controller === replyController) {
          pending.controller = null;
        }
      }
    }
    if (this.pendingAmbient.get(pending.runtimeKey) !== pending) return;
    if (!groupReplyPassesNarrowGuard(reply, "ambient")) {
      this.cancelPendingAmbient(pending.runtimeKey);
      return;
    }
    this.cancelPendingAmbient(pending.runtimeKey);
    await this.deliver(
      pending.scopeKey,
      pending.generation,
      {
        ...pending.message,
        ingressRevision: latestObservation,
      },
      reply,
      pending.retainContext,
      "ambient",
    );
  }

  private cancelPendingAmbient(runtimeKey: string): void {
    const pending = this.pendingAmbient.get(runtimeKey);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.controller?.abort();
    pending.controller = null;
    pending.timer = null;
    this.pendingAmbient.delete(runtimeKey);
  }

  private schedulePriorityAssessment(
    runtimeKey: string,
    generation: number,
    operation: (signal: AbortSignal) => Promise<GroupSafetyPreflight>,
  ): Promise<GroupSafetyPreflight | null> {
    if (
      this.priorityActive + this.priorityQueue.length >=
      MAX_PRIORITY_TRIAGE_CONCURRENCY + MAX_PRIORITY_TRIAGE_QUEUE
    ) {
      this.logger.warn(
        "group_priority_triage_saturated",
        "Antrean assessment safety grup penuh; giliran tetap diperiksa di FIFO.",
        { count: this.priorityQueue.length },
      );
      return Promise.resolve(null);
    }

    const controller = new AbortController();
    this.registerPriorityController(runtimeKey, controller);
    return new Promise<GroupSafetyPreflight | null>((resolve) => {
      let started = false;
      const run = () => {
        started = true;
        controller.signal.removeEventListener("abort", cancelQueued);
        if (
          controller.signal.aborted ||
          !this.accepting ||
          !this.isCurrentGeneration(runtimeKey, generation)
        ) {
          this.releasePriorityController(runtimeKey, controller);
          resolve(null);
          return;
        }
        this.priorityActive += 1;
        void operation(controller.signal)
          .then(
            (assessment) => {
              resolve(
                !controller.signal.aborted &&
                  this.accepting &&
                  this.isCurrentGeneration(runtimeKey, generation)
                  ? assessment
                  : null,
              );
            },
            () => resolve(null),
          )
          .finally(() => {
            this.releasePriorityController(runtimeKey, controller);
            this.priorityActive -= 1;
            this.pumpPriorityTriage();
          });
      };
      const cancelQueued = () => {
        if (started) return;
        const index = this.priorityQueue.indexOf(run);
        if (index >= 0) this.priorityQueue.splice(index, 1);
        this.releasePriorityController(runtimeKey, controller);
        resolve(null);
      };
      controller.signal.addEventListener("abort", cancelQueued, {
        once: true,
      });
      this.priorityQueue.push(run);
      this.pumpPriorityTriage();
    });
  }

  private registerPriorityController(
    runtimeKey: string,
    controller: AbortController,
  ): void {
    const controllers =
      this.priorityControllers.get(runtimeKey) ?? new Set<AbortController>();
    controllers.add(controller);
    this.priorityControllers.set(runtimeKey, controllers);
  }

  private releasePriorityController(
    runtimeKey: string,
    controller: AbortController,
  ): void {
    const controllers = this.priorityControllers.get(runtimeKey);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.priorityControllers.delete(runtimeKey);
  }

  private abortPriorityAssessments(runtimeKey: string): void {
    const controllers = this.priorityControllers.get(runtimeKey);
    if (!controllers) return;
    this.priorityControllers.delete(runtimeKey);
    for (const controller of controllers) controller.abort();
  }

  private pumpPriorityTriage(): void {
    while (
      this.priorityActive < MAX_PRIORITY_TRIAGE_CONCURRENCY &&
      this.priorityQueue.length > 0
    ) {
      const next = this.priorityQueue.shift();
      next?.();
    }
  }

  private rememberJoinedAt(
    scopeKey: string,
    accountId: string,
    joinedAt: string,
  ): void {
    const parsed = Date.parse(joinedAt);
    if (!Number.isFinite(parsed)) return;
    this.joinedAtByRuntime.set(
      groupRuntimeKey(scopeKey, accountId),
      parsed,
    );
  }

  private async showTyping(message: GroupMessage): Promise<void> {
    if (!this.transport.sendTyping) return;
    try {
      await this.transport.sendTyping(message);
    } catch (error) {
      this.logger.debug(
        "group_typing_indicator_failed",
        "Indikator mengetik grup gagal; pemrosesan tetap dilanjutkan.",
        { error },
      );
    }
  }

  private isAmbientSuperseded(
    runtimeKey: string,
    observation: number,
  ): boolean {
    return observation <
      (this.observations.get(runtimeKey) ?? observation);
  }

  private riskMarker(
    scopeKey: string,
    identities: readonly string[],
  ): GroupRiskMarker | null {
    const marker = identities
      .map((identity) =>
        this.riskMarkers.get(riskMarkerKey(scopeKey, identity)),
      )
      .find((candidate) => candidate !== undefined);
    if (!marker) return null;
    if (marker.expiresAt <= this.now().getTime()) {
      this.clearRiskMarker(marker);
      return null;
    }
    return marker;
  }

  private setRiskMarker(
    scopeKey: string,
    identities: readonly string[],
    triage: RiskTriage,
  ): void {
    const unique = [...new Set(identities)];
    for (const identity of unique) {
      const previous = this.riskMarkers.get(
        riskMarkerKey(scopeKey, identity),
      );
      if (previous) this.clearRiskMarker(previous);
    }
    const marker: GroupRiskMarker = {
      identities: unique,
      level: triage.level === "bahaya" ? "bahaya" : "dukungan",
      alone: triage.alone,
      certain: triage.certain,
      expiresAt: this.now().getTime() + RISK_MARKER_RETENTION_MS,
      timer: null,
    };
    marker.timer = setTimeout(() => {
      this.clearRiskMarker(marker);
    }, RISK_MARKER_RETENTION_MS);
    marker.timer.unref();
    for (const identity of unique) {
      this.riskMarkers.set(riskMarkerKey(scopeKey, identity), marker);
    }
  }

  private clearRiskMarker(marker: GroupRiskMarker): void {
    if (marker.timer) clearTimeout(marker.timer);
    marker.timer = null;
    for (const [key, stored] of this.riskMarkers) {
      if (stored === marker) this.riskMarkers.delete(key);
    }
  }

  private clearRiskMarkers(scopeKey: string): void {
    const prefix = `${scopeKey}\u0000`;
    const markers = new Set<GroupRiskMarker>();
    for (const [key, marker] of this.riskMarkers) {
      if (key.startsWith(prefix)) markers.add(marker);
    }
    for (const marker of markers) this.clearRiskMarker(marker);
  }

  private clearRiskMarkersForIdentities(
    scopeKey: string,
    identities: readonly string[],
  ): void {
    const wanted = new Set(identities);
    const markers = new Set<GroupRiskMarker>();
    for (const [key, marker] of this.riskMarkers) {
      if (
        key.startsWith(`${scopeKey}\u0000`) &&
        marker.identities.some((identity) => wanted.has(identity))
      ) {
        markers.add(marker);
      }
    }
    for (const marker of markers) this.clearRiskMarker(marker);
  }

  private async buildSafetyPreflight(
    message: string,
    scopeKey: string,
    context: HarvyContext,
    immediateDanger: boolean,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<GroupSafetyPreflight> {
    if (signal?.aborted || !isCurrent()) {
      throw new Error("Group priority assessment dibatalkan.");
    }
    if (immediateDanger) {
      const triage = await this.safeTriage(
        message,
        scopeKey,
        context,
        signal,
      );
      if (signal?.aborted || !isCurrent()) {
        throw new Error("Group priority assessment dibatalkan.");
      }
      return {
        ingress: null,
        hint: withImmediateDangerHint(NO_RISK_HINT, true),
        triage,
        triageAttempted: true,
      };
    }
    const assessedIngress = await this.safeAssessGroupIngress(
      message,
      scopeKey,
      context,
      signal,
    );
    if (signal?.aborted || !isCurrent()) {
      throw new Error("Group priority assessment dibatalkan.");
    }
    const rawHint = assessedIngress?.riskHint ?? null;
    // Snapshot pre-FIFO dapat menjadi stale terhadap turn yang masih aktif.
    // Risk hint tetap berguna untuk routing cepat, tetapi tidak pernah menjadi
    // authority retensi raw-context: privacy harus gagal tertutup.
    const ingress = assessedIngress
      ? { ...assessedIngress, contextPrivacy: null }
      : null;
    const hint = withImmediateDangerHint(
      rawHint ?? NO_RISK_HINT,
      immediateDanger,
    );
    const triageAttempted =
      immediateDanger || rawHint === null || hint.level !== "none";
    const triage = triageAttempted
      ? await this.safeTriage(message, scopeKey, context, signal)
      : undefined;
    if (signal?.aborted || !isCurrent()) {
      throw new Error("Group priority assessment dibatalkan.");
    }
    return { ingress, hint, triage, triageAttempted };
  }

  private async safeAssessGroupIngress(
    message: string,
    scopeKey: string,
    context: HarvyContext,
    signal?: AbortSignal,
  ): Promise<GroupIngressAssessment | null> {
    if (!this.ingressAssessment) return null;
    try {
      return await this.ingressAssessment.assessGroupIngress(
        message,
        context,
        scopeKey,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return null;
      this.logger.error(
        "group_ingress_assessment_failed",
        "Assessment ingress grup gagal; triase fallback dan no-retain dipakai.",
        error,
      );
      return null;
    }
  }

  private async safeTriage(
    message: string,
    scopeKey: string,
    context: HarvyContext,
    signal?: AbortSignal,
  ): Promise<RiskTriage | null> {
    try {
      return await this.safety.triageRisk(
        message,
        scopeKey,
        context,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return null;
      this.logger.error(
        "group_risk_triage_failed",
        "Triase keselamatan grup gagal.",
        error,
      );
      return null;
    }
  }

  private contextFor(scopeKey: string): GroupTurn[] {
    const nowMs = this.now().getTime();
    const turns = (this.context.get(scopeKey) ?? []).filter(
      (turn) => new Date(turn.at).getTime() >= nowMs - CONTEXT_RETENTION_MS,
    );
    if (turns.length === 0) {
      this.clearContext(scopeKey);
    } else {
      this.context.set(scopeKey, turns);
      this.scheduleContextExpiry(scopeKey, turns);
    }
    return [...turns];
  }

  private pushTurn(scopeKey: string, turn: GroupTurn): void {
    const turns = this.contextFor(scopeKey);
    turns.push(turn);
    if (turns.length > MAX_CONTEXT_TURNS) {
      turns.splice(0, turns.length - MAX_CONTEXT_TURNS);
    }
    this.context.set(scopeKey, turns);
    this.scheduleContextExpiry(scopeKey, turns);
  }

  private removeParticipantContext(
    scopeKey: string,
    participantIds: readonly string[],
  ): void {
    const identities = new Set(participantIds);
    const turns = (this.context.get(scopeKey) ?? []).filter(
      (turn) => !turn.participantId || !identities.has(turn.participantId),
    );
    if (turns.length === 0) this.clearContext(scopeKey);
    else {
      this.context.set(scopeKey, turns);
      this.scheduleContextExpiry(scopeKey, turns);
    }
  }

  private removeMessageContext(
    scopeKey: string,
    message: GroupMessage,
  ): void {
    const turns = [...(this.context.get(scopeKey) ?? [])];
    const index = turns.findLastIndex(
      (turn) =>
        turn.role === "member" &&
        turn.participantId === message.participantId &&
        turn.text === message.text &&
        turn.at === message.at,
    );
    if (index < 0) return;
    turns.splice(index, 1);
    if (turns.length === 0) this.clearContext(scopeKey);
    else {
      this.context.set(scopeKey, turns);
      this.scheduleContextExpiry(scopeKey, turns);
    }
  }

  private scheduleContextExpiry(
    scopeKey: string,
    turns: readonly GroupTurn[],
  ): void {
    const current = this.contextTimers.get(scopeKey);
    if (current) clearTimeout(current);
    const earliest = Math.min(
      ...turns.map(
        (turn) => new Date(turn.at).getTime() + CONTEXT_RETENTION_MS,
      ),
    );
    const delay = Math.max(1, earliest - this.now().getTime());
    const timer = setTimeout(() => {
      this.contextTimers.delete(scopeKey);
      this.contextFor(scopeKey);
    }, delay);
    timer.unref();
    this.contextTimers.set(scopeKey, timer);
  }

  private clearContext(scopeKey: string): void {
    this.context.delete(scopeKey);
    const timer = this.contextTimers.get(scopeKey);
    if (timer) clearTimeout(timer);
    this.contextTimers.delete(scopeKey);
  }

  private setPendingControl(
    scopeKey: string,
    identities: readonly string[],
    kind: PendingGroupControl["kind"],
    authorityEpoch: number,
  ): void {
    const unique = [...new Set(identities)];
    for (const identity of unique) {
      const previous = this.pendingControls.get(
        pendingControlKey(scopeKey, identity),
      );
      if (previous) this.clearPendingControl(previous);
    }
    const pending: PendingGroupControl = {
      kind,
      expiresAt: this.now().getTime() + CONTROL_CONFIRMATION_MS,
      identities: unique,
      authorityEpoch,
      timer: null,
      memory: null,
    };
    pending.timer = setTimeout(() => {
      this.clearPendingControl(pending);
    }, CONTROL_CONFIRMATION_MS);
    pending.timer.unref();
    for (const identity of unique) {
      this.pendingControls.set(
        pendingControlKey(scopeKey, identity),
        pending,
      );
    }
  }

  private setPendingMemoryConsent(
    scopeKey: string,
    proposal: GroupMemoryConsentProposal,
  ): void {
    const unique = [...new Set(proposal.identities)];
    for (const identity of unique) {
      const previous = this.pendingControls.get(
        pendingControlKey(scopeKey, identity),
      );
      if (previous) this.clearPendingControl(previous);
    }
    const pending: PendingGroupControl = {
      kind: "remember-sensitive",
      expiresAt: this.now().getTime() + CONTROL_CONFIRMATION_MS,
      identities: unique,
      authorityEpoch: 0,
      timer: null,
      memory: { ...proposal, identities: unique },
    };
    pending.timer = setTimeout(() => {
      this.clearPendingControl(pending);
    }, CONTROL_CONFIRMATION_MS);
    pending.timer.unref();
    for (const identity of unique) {
      this.pendingControls.set(
        pendingControlKey(scopeKey, identity),
        pending,
      );
    }
  }

  private pendingControl(
    scopeKey: string,
    identities: readonly string[],
  ): PendingGroupControl | null {
    const pending = identities
      .map((identity) =>
        this.pendingControls.get(pendingControlKey(scopeKey, identity)),
      )
      .find((candidate) => candidate !== undefined);
    if (!pending) return null;
    if (pending.expiresAt <= this.now().getTime()) {
      this.clearPendingControl(pending);
      return null;
    }
    return pending;
  }

  private clearPendingControl(pending: PendingGroupControl): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    for (const [key, stored] of this.pendingControls) {
      if (stored === pending) this.pendingControls.delete(key);
    }
  }

  private clearPendingControls(scopeKey: string): void {
    const prefix = `${scopeKey}\u0000`;
    const controls = new Set<PendingGroupControl>();
    for (const [key, pending] of this.pendingControls) {
      if (key.startsWith(prefix)) controls.add(pending);
    }
    for (const pending of controls) this.clearPendingControl(pending);
    const roomPending = this.pendingRoomMemories.get(scopeKey);
    if (roomPending) this.clearPendingRoomMemory(roomPending);
  }

  private setPendingRoomMemory(
    scopeKey: string,
    proposal: PendingRoomMemory,
  ): void {
    const previous = this.pendingRoomMemories.get(scopeKey);
    if (previous) this.clearPendingRoomMemory(previous);
    const pending: PendingRoomMemory = {
      ...proposal,
      identities: [...new Set(proposal.identities)],
      timer: null,
    };
    pending.timer = setTimeout(() => {
      this.clearPendingRoomMemory(pending);
    }, Math.max(1, pending.expiresAt - this.now().getTime()));
    pending.timer.unref();
    this.pendingRoomMemories.set(scopeKey, pending);
  }

  private pendingRoomMemory(scopeKey: string): PendingRoomMemory | null {
    const pending = this.pendingRoomMemories.get(scopeKey);
    if (!pending) return null;
    if (pending.expiresAt <= this.now().getTime()) {
      this.clearPendingRoomMemory(pending);
      return null;
    }
    return pending;
  }

  private clearPendingRoomMemory(pending: PendingRoomMemory): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    for (const [scopeKey, stored] of this.pendingRoomMemories) {
      if (stored === pending) this.pendingRoomMemories.delete(scopeKey);
    }
  }

  private generationOf(runtimeKey: string): number {
    return this.generation.get(runtimeKey) ?? 0;
  }

  private isCurrentGeneration(
    runtimeKey: string,
    generation: number,
  ): boolean {
    return (
      this.accepting &&
      generation === this.generationOf(runtimeKey)
    );
  }

  private clearRuntimeState(scopeKey: string, runtimeKey: string): void {
    this.clearContext(scopeKey);
    this.clearPendingControls(scopeKey);
    this.clearRiskMarkers(scopeKey);
    this.noticeReady.delete(scopeKey);
    this.aliasesByRuntime.delete(runtimeKey);
  }

  private async enqueue<T>(
    scopeKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(scopeKey) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(scopeKey, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(scopeKey) === tail) this.queues.delete(scopeKey);
    }
  }
}

function toSafetyContext(
  turns: readonly GroupTurn[],
  participantIds: readonly string[],
  marker: GroupRiskMarker | null,
): HarvyContext {
  const identities = new Set(participantIds);
  const recent: ConversationTurn[] = turns
    .filter(
      (turn) =>
        turn.participantId !== null &&
        identities.has(turn.participantId),
    )
    .slice(-4)
    .map((turn) => ({
      role: turn.role === "harvy" ? "harvy" : "user",
      text: turn.text,
      at: turn.at,
    }));
  if (marker) {
    recent.push({
      role: "harvy",
      text: `Catatan keselamatan sementara: giliran sebelumnya dari orang yang sama dinilai ${marker.level}; isi sensitifnya sengaja tidak disimpan. Perlakukan jawaban pendek sebagai kemungkinan lanjutan. Penilaian sebelumnya ${marker.certain ? "pasti" : "belum pasti"} dan status sendirian ${marker.alone ? "disebutkan" : "tidak diketahui"}.`,
      at: new Date(
        marker.expiresAt - RISK_MARKER_RETENTION_MS,
      ).toISOString(),
    });
  }
  return { summary: null, turns: recent, memories: [] };
}

function addressesAlias(text: string, aliases: readonly string[]): boolean {
  const normalized = normalize(text);
  return aliases.some((alias) => {
    const clean = normalize(alias);
    if (!clean) return false;
    if (normalized === clean) return true;
    const escaped = escapeRegex(clean);
    if (
      new RegExp(
        `\\b(?:jangan|ga ?usah|gak ?usah|nggak ?usah)\\s+` +
          `(?:panggil|tanya(?:in)?|minta)\\s+(?:ke\\s+)?${escaped}\\b`,
        "iu",
      ).test(normalized)
    ) {
      return false;
    }
    if (
      new RegExp(
        `^${escaped}(?:\\s*[,!?:-]+\\s*|\\s+)` +
          `(?!tadi\\b|kemarin\\b|itu\\b|adalah\\b|bilang\\b|` +
          `jawabannya\\b|balasannya\\b|punya\\b)`,
        "iu",
      ).test(normalized)
    ) {
      return true;
    }
    if (
      new RegExp(`[,;]\\s*${escaped}[.!?]*$`, "iu").test(normalized)
    ) {
      return true;
    }
    return new RegExp(
      `\\b(?:menurut|tanya(?:in)?\\s+ke|minta\\s+bantuan\\s+ke)\\s+` +
        `${escaped}\\b`,
      "iu",
    ).test(normalized);
  });
}

function extractAlias(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const match =
    /^(?:harvy[\s,:-]+)?(?:mulai sekarang\s+)?(?:di grup ini\s+)?(?:panggil(?:lah)?\s+(?:kamu|harvy)|nama\s+(?:kamu|harvy)|namamu|julukan\s+(?:kamu|harvy)|julukanmu)\s+(?:adalah\s+|jadi\s+)?["“]?([\p{L}\p{N}][\p{L}\p{N} _-]{1,23})["”]?\s*[.!?]?$/iu.exec(
      clean,
    );
  return match?.[1]?.trim() ?? null;
}

function extractOwnNameCorrection(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  const match =
    /\b(?:koreksi|ubah|ganti)\s+(?:nama|panggilan)\s+(?:aku|saya)(?:\s+di\s+(?:memori\s+)?grup\s+ini)?\s+(?:jadi|menjadi)\s+["“]?([^"”]{1,80})["”]?\s*[.!?]?$/iu.exec(
      clean,
    );
  return match?.[1]?.trim() ?? null;
}

function asksMemoryList(text: string): boolean {
  return (
    /\b(lihat|tampilkan|cek|apa)\b/.test(text) &&
    /\b(memori|catatan|ingat)\b/.test(text) &&
    /\b(grup|group|sini)\b/.test(text)
  );
}

function extractMemberMemoryEdit(
  text: string,
): { id: string; content: string } | null {
  const match = /\b(?:koreksi|ubah|edit)\s+memori\s+#?([a-z0-9-]{6,64})\s+(?:jadi|menjadi)\s+(.{3,200})\s*[.!]?$/iu.exec(
    text.trim(),
  );
  const id = match?.[1]?.trim();
  const content = match?.[2]?.trim();
  return id && content ? { id, content } : null;
}

function extractMemberMemoryDelete(text: string): string | null {
  return /\b(?:hapus|lupakan)\s+memori\s+#?([a-z0-9-]{6,64})\s*[.!]?$/iu.exec(
    text.trim(),
  )?.[1] ?? null;
}

function extractRoomMemoryProposal(
  text: string,
): { kind: GroupRoomMemoryKind; content: string } | null {
  const patterns: readonly [RegExp, GroupRoomMemoryKind][] = [
    [/\bingat\s+keputusan\s+grup\s*:\s*(.{3,300})$/iu, "decision"],
    [/\bingat\s+agenda\s+grup\s*:\s*(.{3,300})$/iu, "agenda"],
    [/\bingat\s+(?:aturan|norma|kebiasaan)\s+grup\s*:\s*(.{3,300})$/iu, "norm"],
    [/\bingat\s+kegiatan\s+grup\s*:\s*(.{3,300})$/iu, "activity"],
    [/\b(?:ingat|simpan)\s+(?:untuk|ke)\s+grup\s*:\s*(.{3,300})$/iu, "note"],
  ];
  for (const [pattern, kind] of patterns) {
    const content = pattern.exec(text.trim())?.[1]
      ?.replace(/\s+/gu, " ")
      .trim();
    if (content && !/\p{Cc}/u.test(content)) return { kind, content };
  }
  return null;
}

function confirmsRoomMemory(text: string): string | null {
  return /^(?:harvy\s+)?(?:ya|iya)\s+simpan\s+catatan\s+grup\s+#?([a-f0-9]{8})$/u.exec(
    text,
  )?.[1] ?? null;
}

function extractRoomMemoryDelete(text: string): string | null {
  return /\b(?:hapus|lupakan)\s+(?:catatan|memori)\s+grup\s+#?([a-z0-9-]{6,64})\s*[.!]?$/iu.exec(
    text.trim(),
  )?.[1] ?? null;
}

function asksForgetSelf(text: string): boolean {
  return (
    /\b(lupakan|hapus|buang)\b/.test(text) &&
    /\b(tentang aku|memori aku|catatan aku|aktivitas aku)\b/.test(text)
  );
}

function confirmsForgetSelf(text: string): boolean {
  return /^(?:harvy\s+)?(?:ya|iya)\s+(?:lupakan aktivitasku|lupakan tentang aku|hapus aktivitas aku)$/.test(
    text,
  );
}

function confirmsSensitiveMemory(text: string): boolean {
  return /^(?:harvy\s+)?(?:ya|iya)\s+simpan memori ini$/.test(text);
}

function asksResetGroup(text: string): boolean {
  return (
    /\b(reset|hapus|lupakan|bersihkan)\b/.test(text) &&
    /\b(memori grup|memori group|catatan grup|semua memori)\b/.test(text)
  );
}

function confirmsResetGroup(text: string): boolean {
  return /^(?:harvy\s+)?(?:ya|iya)\s+reset memori grup$/.test(text);
}

/**
 * Kontrol data eksplisit tetap boleh diproses ketika UX safety tertentu
 * menahan mutasi umum. Ini hanya klasifikasi intent; authority grup tetap
 * direvalidasi tepat sebelum setiap write.
 */
function isExplicitGroupControl(text: string): boolean {
  const normalized = normalize(text);
  return Boolean(
    asksMemoryList(normalized) ||
      asksActivityRanking(normalized) ||
      extractOwnNameCorrection(text) ||
      extractMemberMemoryEdit(text) ||
      extractMemberMemoryDelete(text) ||
      extractRoomMemoryDelete(text) ||
      extractAlias(text) ||
      extractRoomMemoryProposal(text) ||
      confirmsRoomMemory(normalized) ||
      asksForgetSelf(normalized) ||
      confirmsForgetSelf(normalized) ||
      confirmsSensitiveMemory(normalized) ||
      asksResetGroup(normalized) ||
      confirmsResetGroup(normalized),
  );
}

function strongerRiskHint(left: RiskHint, right: RiskHint): RiskHint {
  const rank: Readonly<Record<RiskHint["level"], number>> = {
    none: 0,
    possible: 1,
    strong: 2,
  };
  if (rank[right.level] > rank[left.level]) return right;
  if (rank[right.level] < rank[left.level]) return left;
  return right.confidence > left.confidence ? right : left;
}

function isNegatedOrTentative(text: string): boolean {
  return /\b(jangan|tidak usah|nggak usah|gak usah|ga usah|apakah|apa perlu|perlukah|boleh nggak|boleh gak)\b/.test(
    text,
  );
}

function asksActivityRanking(text: string): boolean {
  return /\b(paling aktif|paling cerewet|paling banyak (?:ngomong|chat))\b/.test(
    text,
  );
}

function describeMemory(
  groupName: string | null,
  aliases: readonly string[],
  ranking: readonly {
    participantId: string;
    displayName: string | null;
    messages: number;
  }[],
  own: GroupParticipantActivity | null,
  memberMemories: readonly GroupMemberMemoryItem[],
  roomMemories: readonly GroupRoomMemoryItem[],
): string {
  const lines = [
    `Yang kuingat hanya untuk grup ini: nama grup ${groupName ? `“${groupName}”` : "belum terbaca"}; panggilanku ${aliases.map((alias) => `“${alias}”`).join(", ")}.`,
  ];

  if (ranking.length === 0) {
    lines.push(
      `Belum ada statistik aktivitas untuk ${SOCIAL_STAT_WINDOW_DAYS} hari terakhir.`,
    );
  } else {
    lines.push(
      `Aktivitas ${SOCIAL_STAT_WINDOW_DAYS} hari terakhir:`,
      ...ranking
        .slice(0, 5)
        .map(
          (participant, index) =>
            `${index + 1}. ${participant.displayName ?? "Anggota"} — ${participant.messages} pesan`,
        ),
    );
  }

  if (own) {
    const daily = own.daily
      .map((bucket) => `${bucket.date}: ${bucket.messages}`)
      .join(", ");
    lines.push(
      `Tentang kamu sendiri: nama tampilan terakhir ${own.displayName ? `“${own.displayName}”` : "tidak ada"}${own.displayNameOverride ? `; koreksimu “${own.displayNameOverride}”` : ""}; terakhir terlihat ${own.lastSeenAt}; aktivitas harian tersimpan ${daily || "tidak ada"}.`,
      "Kalau namanya keliru, bilang “koreksi nama aku jadi …”.",
    );
  }

  if (roomMemories.length > 0) {
    lines.push(
      "Catatan bersama yang dikonfirmasi admin:",
      ...roomMemories.map(
        (item, index) =>
          `${index + 1}. [#${item.id.slice(0, 8)}] (${item.kind}) ${item.content} — kedaluwarsa ${item.expiresAt}`,
      ),
      "Admin dapat menghapus satu dengan “hapus catatan grup #ID”.",
    );
  } else {
    lines.push("Belum ada catatan bersama yang dikonfirmasi admin.");
  }

  if (memberMemories.length > 0) {
    lines.push(
      "Memori anggota tentang kamu di grup ini:",
      ...memberMemories.map(
        (item, index) =>
          `${index + 1}. [#${item.id.slice(0, 8)}] (${item.kind}) ${item.content} — kedaluwarsa ${item.expiresAt ?? "saat kamu menghapusnya atau grup dinonaktifkan"}`,
      ),
      "Untuk mengoreksi: “ubah memori #ID jadi …”. Untuk menghapus satu: “hapus memori #ID”.",
    );
  } else {
    lines.push("Belum ada memori anggota tentang kamu di grup ini.");
  }

  lines.push(
    "Ini hitungan pesan dalam jendela waktu, bukan penilaian sifat seseorang.",
  );
  return lines.join("\n");
}

function ambientBudgetAllows(
  plan: GroupParticipationPlan,
  turns: readonly GroupTurn[],
  now: Date,
): boolean {
  const lastAmbientIndex = turns.findLastIndex(
    (turn) =>
      turn.role === "harvy" && turn.origin === "ambient",
  );
  if (lastAmbientIndex < 0) return true;

  const lastAmbient = turns[lastAmbientIndex];
  if (!lastAmbient) return true;
  const memberTurns = turns
    .slice(lastAmbientIndex + 1)
    .filter((turn) => turn.role === "member").length + 1;
  if (memberTurns === 0) return false;

  const elapsedMs = Math.max(
    0,
    now.getTime() - new Date(lastAmbient.at).getTime(),
  );
  const highValue =
    plan.value === 3 &&
    (plan.reason === "unanswered_question" ||
      plan.reason === "fact_correction" ||
      plan.reason === "useful_context");
  return highValue
    ? memberTurns >= AMBIENT_HIGH_VALUE_MIN_TURNS &&
        (elapsedMs >= AMBIENT_HIGH_VALUE_MIN_MS ||
          memberTurns >= AMBIENT_HIGH_VALUE_MIN_TURNS + 1)
    : memberTurns >= AMBIENT_ORDINARY_MIN_TURNS &&
        (elapsedMs >= AMBIENT_ORDINARY_MIN_MS ||
          memberTurns >= AMBIENT_ORDINARY_MIN_TURNS + 2);
}

function groupReplyPassesNarrowGuard(
  reply: string,
  origin: "direct" | "ambient",
): boolean {
  const clean = reply.trim();
  const wordCount = clean.split(/\s+/u).filter(Boolean).length;
  if (wordCount === 0 || wordCount > (origin === "ambient" ? 80 : 160)) {
    return false;
  }
  return ![
    /\b(?:aku|gue|saya)\s+(?:juga\s+)?(?:pernah|lagi|sedang)\b/iu,
    /\b(?:(?:dm|japri|chat)\s+(?:aku|gue|saya|harvy)(?:\s+pribadi)?|(?:pindah|lanjut)\s+ke\s+(?:dm|japri|chat\s+pribadi)|(?:aku|gue|saya|harvy)\s+(?:dm|japri))\b/iu,
    /\b(?:pasti|jelas)\s+(?:depresi|narsis|psikopat|selingkuh)\b/iu,
    /\b(?:dijamin aman|pasti terpercaya|pasti benar|jelas dia pelakunya)\b/iu,
    /\b(?:aman|terpercaya)(?:\s+(?:kok|banget|pasti|jelas))?[,.]?\s+(?:langsung\s+)?(?:transfer|bayar|checkout)(?:\s+aja)?\b/iu,
    /\b(?:langsung\s+)?(?:transfer|bayar|checkout)(?:\s+aja)?[,.]?\s+(?:pasti\s+)?(?:aman|terpercaya)\b/iu,
  ].some((pattern) => pattern.test(clean));
}

function resolvedParticipantMessage(
  message: GroupMessage,
  memory: Awaited<ReturnType<GroupMemoryService["memory"]>>,
  memories: GroupMemoryService,
): GroupMessage {
  if (!memory) return message;
  const participant = memories.participantActivity(
    memory,
    participantIdentities(message),
  );
  const displayName =
    participant?.displayNameOverride ??
    participant?.displayName ??
    message.participantName;
  return displayName === message.participantName
    ? message
    : { ...message, participantName: displayName };
}

function resolvedParticipantTurns(
  turns: readonly GroupTurn[],
  memory: Awaited<ReturnType<GroupMemoryService["memory"]>>,
  memories: GroupMemoryService,
): GroupTurn[] {
  if (!memory) return [...turns];
  return turns.map((turn) => {
    if (!turn.participantId) return turn;
    const participant = memories.participantActivity(memory, [
      turn.participantId,
    ]);
    const displayName =
      participant?.displayNameOverride ??
      participant?.displayName ??
      turn.participantName;
    return displayName === turn.participantName
      ? turn
      : { ...turn, participantName: displayName };
  });
}

function isShortSafetyContinuation(message: GroupMessage): boolean {
  const words = normalize(message.text).split(" ").filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 8 &&
    (message.repliesToHarvy ||
      message.mentionsHarvy ||
      /^(masih|belum|sudah|udah|nggak|gak|ga|tidak|iya|ya|enggak|engga)\b/.test(
        normalize(message.text),
      ))
  );
}

function groupSafetyFallback(level: RiskTriage["level"]): string {
  return level === "bahaya"
    ? GROUP_DANGER_FALLBACK_REPLY
    : GROUP_SUPPORT_FALLBACK_REPLY;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("id-ID")
    .replace(/[?!.,:;()[\]{}"'`*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function participantIdentities(message: GroupMessage): string[] {
  return [
    ...new Set([message.participantId, ...message.participantAliases]),
  ];
}

function linkedParticipantIdentities(
  memory: Awaited<ReturnType<GroupMemoryService["memory"]>>,
  identities: readonly string[],
  memories: GroupMemoryService,
): string[] {
  const stored = memory
    ? memories.participantActivity(memory, identities)
    : null;
  return [
    ...new Set([
      ...identities,
      ...(stored
        ? [
            stored.participantId,
            ...(stored.identityAliases ?? []),
          ]
        : []),
    ]),
  ];
}

function controlReply(
  text: string,
  retainContext = true,
  savedMemories: readonly GroupMemberMemoryItem[] = [],
  savedMemoryIdentities: readonly string[] | null = null,
  pendingToClear: PendingGroupControl | null = null,
): GroupControlReply {
  return {
    text,
    retainContext,
    savedMemories,
    savedMemoryIdentities,
    pendingToClear,
    pendingToSet: null,
    savedRoomMemories: [],
    roomProposalToSet: null,
    roomProposalToClear: null,
  };
}

function roomProposalId(
  scopeKey: string,
  message: GroupMessage,
  kind: GroupRoomMemoryKind,
  content: string,
  authorityEpoch: number,
): string {
  return createHash("sha256")
    .update(scopeKey, "utf8")
    .update("\0", "utf8")
    .update(message.messageId, "utf8")
    .update("\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(content, "utf8")
    .update("\0", "utf8")
    .update(String(authorityEpoch), "utf8")
    .digest("hex")
    .slice(0, 8);
}

function memberMemoryContext(
  items: readonly GroupMemberMemoryItem[],
  ownerId: string,
): HarvyContext {
  return {
    summary: null,
    turns: [],
    memories: items.map((item) => ({
      id: item.id,
      ownerId,
      kind: item.kind,
      content: item.content,
      createdAt: item.createdAt,
      lastUsedAt: null,
      expiresAt: item.expiresAt,
    })),
  };
}

function withGroupMemoryNotes(
  reply: string,
  items: readonly GroupMemberMemoryItem[],
): string {
  const note = items.length > 1
    ? "Beberapa hal penting dari ceritamu juga aku ingat untuk percakapan di grup ini 📍"
    : "Yang ini juga aku ingat untuk percakapan di grup ini 📍";
  return [
    reply.trim(),
    "",
    note,
  ].join("\n");
}

function withSensitiveMemoryConsentNote(reply: string): string {
  return [
    reply.trim(),
    "",
    "Satu hal tadi tampak pribadi, jadi belum kusimpan. Kalau kamu memang ingin menyimpannya hanya untuk dirimu di grup ini, balas dalam 10 menit dengan “ya, simpan memori ini”.",
  ].join("\n");
}

function withGroupMemoryDuplicateNote(reply: string): string {
  return [
    reply.trim(),
    "",
    "Yang itu masih aku ingat untuk grup ini.",
  ].join("\n");
}

function withGroupMemorySaveFailure(reply: string): string {
  const note =
    "Aku belum bisa menyimpan yang itu sebagai ingatan untuk grup ini sekarang. Coba lagi nanti, ya.";
  if (replyAcknowledgesMemoryWrite(reply)) return note;
  return [reply.trim(), "", note].join("\n");
}

function messageParts(message: GroupMessage): GroupMessagePart[] {
  return message.parts?.length
    ? [...message.parts]
    : [{
        messageId: message.messageId,
        text: message.text,
        at: message.at,
        mentionsHarvy: message.mentionsHarvy,
        repliesToHarvy: message.repliesToHarvy,
        quotedMessageId: message.quotedMessageId ?? null,
        quotedParticipantId: message.quotedParticipantId ?? null,
        ingressRevision: message.ingressRevision,
      }];
}

function messageWithParts(
  message: GroupMessage,
  parts: readonly GroupMessagePart[],
): GroupMessage {
  const latest = parts.at(-1);
  if (!latest) return message;
  const quoted = parts.find(
    (part) => part.quotedMessageId || part.quotedParticipantId,
  );
  const ingressRevision = Math.max(
    ...parts.map((part) => part.ingressRevision ?? 0),
  );
  return {
    ...message,
    messageId: latest.messageId,
    text: parts.map((part) => part.text).join("\n"),
    at: latest.at,
    mentionsHarvy: parts.some((part) => part.mentionsHarvy),
    repliesToHarvy: parts.some((part) => part.repliesToHarvy),
    quotedMessageId: quoted?.quotedMessageId ?? null,
    quotedParticipantId: quoted?.quotedParticipantId ?? null,
    ingressRevision:
      ingressRevision > 0 ? ingressRevision : message.ingressRevision,
    parts: [...parts],
  };
}

function messageAfterJoin(
  message: GroupMessage,
  joinedAt: string,
): GroupMessage | null {
  const joinedMs = new Date(joinedAt).getTime();
  if (!Number.isFinite(joinedMs)) return null;
  // Timestamp pesan WhatsApp biasanya hanya presisi detik, sedangkan event
  // self-add dapat membawa milidetik. Toleransi ini hanya membuka detik join.
  const threshold = joinedMs - 999;
  const parts = messageParts(message).filter((part) => {
    const at = new Date(part.at).getTime();
    return Number.isFinite(at) && at >= threshold;
  });
  return parts.length > 0 ? messageWithParts(message, parts) : null;
}

function earliestMessageAt(message: GroupMessage): string {
  const timestamps = messageParts(message)
    .map((part) => new Date(part.at).getTime())
    .filter(Number.isFinite);
  return timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : message.at;
}

function pendingControlKey(scopeKey: string, participantId: string): string {
  return `${scopeKey}\u0000${participantId}`;
}

function groupRuntimeKey(scopeKey: string, accountId: string): string {
  return `${scopeKey}\u0000account:${accountId}`;
}

function riskMarkerKey(scopeKey: string, participantId: string): string {
  return `${scopeKey}\u0000${participantId}`;
}
