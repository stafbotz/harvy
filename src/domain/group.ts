/**
 * Identitas ruang grup. Seluruh state selalu dikunci ke `scopeKey`, bukan ke
 * peserta, supaya apa yang dipelajari di satu grup tidak dapat muncul di ruang
 * lain yang kebetulan mempunyai anggota sama.
 */
export type GroupChannel = "whatsapp" | "telegram";

export interface GroupScope {
  channel: GroupChannel;
  groupId: string;
}

export function groupScopeKey(scope: GroupScope): string {
  return `${scope.channel}:${scope.groupId}`;
}

export interface GroupBinding {
  scopeKey: string;
  channel: GroupChannel;
  groupId: string;
  accountId: string;
  groupName: string | null;
  joinedAt: string;
  noticeVersion: number | null;
  noticeSentAt: string | null;
  disabledAt: string | null;
}

export interface DailyActivity {
  /** Tanggal UTC YYYY-MM-DD; statistik selalu menyebut jendelanya. */
  date: string;
  messages: number;
}

export interface GroupParticipantActivity {
  participantId: string;
  /** PN/LID lain yang diketahui milik peserta yang sama dalam grup ini. */
  identityAliases?: string[];
  displayName: string | null;
  /** Koreksi eksplisit anggota; tidak ditimpa pushName event berikutnya. */
  displayNameOverride?: string | null;
  daily: DailyActivity[];
  lastSeenAt: string;
}

export interface SeenGroupMessage {
  messageId: string;
  seenAt: string;
}

/**
 * Memori grup MVP hanya memuat konteks sosial biasa yang dapat diperiksa:
 * metadata grup, julukan Harvy, identitas teknis PN/LID untuk menyatukan satu
 * anggota, dan statistik aktivitas berjendela. Isi percakapan mentah tidak
 * ditulis ke repository ini.
 */
export interface GroupMemory {
  scopeKey: string;
  groupName: string | null;
  harvyAliases: string[];
  participants: GroupParticipantActivity[];
  recentMessageIds: SeenGroupMessage[];
  lastHarvyMessageAt: string | null;
  updatedAt: string;
}

/**
 * Memori semantik satu anggota di satu grup. `memberId` internal tidak pernah
 * menjadi identitas global; alias teknis disimpan sebagai digest berscope
 * (pseudonim, bukan anonimitas kriptografis).
 */
export interface GroupMemberMemory {
  scopeKey: string;
  memberId: string;
  aliasKeys: string[];
  items: GroupMemberMemoryItem[];
  generation: number;
  updatedAt: string;
}

export interface GroupMemberMemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  sensitivity: "ordinary" | "sensitive";
  visibility: "member-local";
  consent: "notice" | "explicit";
  source: "conversation" | "explicit";
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt: string | null;
}

export type GroupRoomMemoryKind =
  | "decision"
  | "agenda"
  | "norm"
  | "activity"
  | "note";

/**
 * Catatan semantik yang memang ditujukan untuk seluruh ruang. Ia tidak boleh
 * dipakai sebagai memori pribadi salah satu anggota.
 */
export interface GroupRoomMemoryItem {
  id: string;
  kind: GroupRoomMemoryKind;
  content: string;
  /** Digest alias berscope milik pengusul; ini pseudonim, bukan anonimitas. */
  proposedByAliasKeys: string[];
  visibility: "room";
  consent: "admin-confirmed";
  source: "explicit";
  createdAt: string;
  expiresAt: string;
}

export interface GroupRoomMemory {
  scopeKey: string;
  items: GroupRoomMemoryItem[];
  generation: number;
  updatedAt: string;
}

export interface GroupRepository {
  loadBinding(scopeKey: string): Promise<GroupBinding | null>;
  saveBinding(binding: GroupBinding): Promise<void>;
  loadMemory(scopeKey: string): Promise<GroupMemory | null>;
  listMemories(): Promise<GroupMemory[]>;
  saveMemory(memory: GroupMemory): Promise<void>;
  removeMemory(scopeKey: string): Promise<boolean>;
  /** Opsional agar adapter lama dapat dimigrasikan tanpa fail-open. */
  loadMemberMemories?(scopeKey: string): Promise<GroupMemberMemory[]>;
  /** Mengganti seluruh subject memory satu ruang secara atomik. */
  saveMemberMemories?(
    scopeKey: string,
    memories: GroupMemberMemory[],
  ): Promise<void>;
  removeMemberMemories?(scopeKey: string): Promise<number>;
  loadRoomMemory?(scopeKey: string): Promise<GroupRoomMemory | null>;
  saveRoomMemory?(memory: GroupRoomMemory): Promise<void>;
  removeRoomMemory?(scopeKey: string): Promise<boolean>;
  /** Menghapus profil sosial + shared room memory dalam satu commit. */
  resetSharedMemory?(scopeKey: string, at?: string): Promise<boolean>;
  /**
   * Menghapus state milik satu anggota dan atribusi pengusul room dalam satu
   * commit. `aliasKeys` sudah berupa digest berscope yang dibuat core.
   */
  forgetParticipantState?(
    scopeKey: string,
    participantIds: readonly string[],
    aliasKeys: readonly string[],
    at: string,
  ): Promise<boolean>;
  listRoomMemoryScopes?(): Promise<string[]>;
  /** Tombstone binding + penghapusan seluruh data grup dalam satu commit. */
  disableAndRemoveScope?(
    scopeKey: string,
    accountId: string,
    at: string,
  ): Promise<boolean>;
  /** Untuk maintenance record semantik orphan dari versi/gagal tulis lama. */
  listMemberMemoryScopes?(): Promise<string[]>;
}

export interface GroupMessage {
  scope: GroupScope;
  accountId: string;
  messageId: string;
  participantId: string;
  participantAliases: string[];
  participantName: string | null;
  groupName: string | null;
  text: string;
  at: string;
  mentionsHarvy: boolean;
  repliesToHarvy: boolean;
  /**
   * Metadata thread dari pesan saat ini. Isi pesan yang dikutip sengaja tidak
   * dibawa: kutipan dapat berasal dari waktu sebelum Harvy hadir. ID dan aktor
   * cukup untuk membedakan balasan kepada Harvy dari percakapan antaranggota.
   */
  quotedMessageId?: string | null;
  quotedParticipantId?: string | null;
  isAdmin: boolean;
  /** Epoch cache otoritas dari ingress; selalu direvalidasi sebelum efek admin. */
  authorityEpoch?: number;
  /**
   * Nomor observasi in-memory yang dipasang sebelum batching. Kandidat ambient
   * yang selesai setelah pesan lebih baru terlihat dibatalkan sebagai basi.
   */
  ingressRevision?: number | undefined;
  /**
   * Bubble WhatsApp yang digabung menjadi satu giliran. Adapter tunggal boleh
   * mengosongkannya; layanan memori lalu memakai messageId/text/at utama.
   */
  parts?: GroupMessagePart[];
}

export interface GroupMessagePart {
  messageId: string;
  text: string;
  at: string;
  /**
   * Disimpan per bubble supaya batch yang melintasi waktu bergabung dapat
   * membuang bubble lama tanpa mewarisi tag/reply dari bubble yang dibuang.
   */
  mentionsHarvy: boolean;
  repliesToHarvy: boolean;
  quotedMessageId?: string | null;
  quotedParticipantId?: string | null;
  ingressRevision?: number | undefined;
}

export interface GroupTurn {
  role: "member" | "harvy";
  /**
   * Untuk member: pengirim. Untuk Harvy: anggota yang sedang ditanggapi. Ini
   * membuat penghapusan diri dan konteks keselamatan tidak menyeret anggota
   * lain atau meninggalkan parafrasa Harvy tanpa atribusi.
   */
  participantId: string | null;
  participantName: string | null;
  text: string;
  at: string;
  /** ID pesan sumber/target untuk menjaga threading tanpa menyimpan payload. */
  messageId?: string | null;
  /** Hanya relevan untuk giliran Harvy; dipakai budget partisipasi ambient. */
  origin?: "direct" | "ambient" | "control" | "safety" | null;
}
import type { MemoryKind } from "./memory.js";
