import type {
  WorkspacePermission,
  WorkspaceRole,
} from "../domain/workspace.js";

/**
 * Scope agent adalah batas data, izin, antrean, dan memori. Ia bukan identitas
 * global seseorang. Orang yang sama di dua kanal atau dua grup tetap dua
 * principal lokal sampai ada account linking yang terverifikasi dan disetujui.
 */
export type AgentChannel = "telegram" | "whatsapp";

export type AgentScope =
  | PrivateAgentScope
  | GroupAgentScope
  | WorkspaceAgentScope;

export interface PrivateAgentScope {
  kind: "private";
  channel: AgentChannel;
  userId: string;
  /** Kunci percakapan dan memori hanya berlaku pada kanal ini. */
  conversationKey: string;
  memoryKey: string;
  /**
   * Tujuan pengiriman pengingat pada kanal ini. Telegram memakai chat id,
   * WhatsApp memakai kunci akun+pengguna, jadi nilainya tidak selalu sama
   * dengan `userId`. Tidak ikut ke `scopeKey` sehingga checkpoint lama tetap
   * sah; adapter yang tidak mengisinya jatuh ke `userId` seperti sebelumnya.
   */
  deliveryChatId?: string;
}

export interface GroupAgentScope {
  kind: "group";
  channel: AgentChannel;
  groupId: string;
  participantId: string;
  /** Konteks ruang bersama. Tidak pernah dipakai sebagai memori pribadi. */
  conversationKey: string;
  /** Memori bersama yang memang disahkan untuk ruang ini. */
  sharedMemoryKey: string;
  /** Memori anggota yang hanya sah di ruang ini. */
  memoryKey: string;
}

/**
 * Scope ini tidak mempunyai constructor publik dari ID mentah. Ia hanya
 * dibentuk `WorkspaceAuthorityService` setelah membership tepercaya dibaca.
 */
export interface WorkspaceAgentScope {
  kind: "workspace";
  channel: AgentChannel;
  workspaceKey: string;
  principalKey: string;
  membershipId: string;
  role: WorkspaceRole;
  aclEpoch: number;
  permissions: readonly WorkspacePermission[];
  /** Percakapan lokal satu member di workspace. */
  conversationKey: string;
  /** Memori bersama hanya untuk workspace ini. */
  sharedMemoryKey: string;
  /** Namespace artifact bersama yang kelak selalu diperiksa ACL. */
  artifactKey: string;
  /** Mengikat run/checkpoint ke membership dan ACL epoch saat ini. */
  authorityKey: string;
}

const MAX_PLATFORM_ID_CHARACTERS = 512;

export function privateAgentScope(
  channel: AgentChannel,
  userId: string,
  deliveryChatId?: string,
): PrivateAgentScope {
  const safeUserId = platformId(userId, "userId");
  const encodedUser = encodeURIComponent(safeUserId);
  const base = `v1:private:${channel}:user:${encodedUser}`;
  return {
    kind: "private",
    channel,
    userId: safeUserId,
    conversationKey: `${base}:conversation`,
    memoryKey: `${base}:memory`,
    ...(deliveryChatId ? { deliveryChatId } : {}),
  };
}

export function groupAgentScope(
  channel: AgentChannel,
  groupId: string,
  participantId: string,
): GroupAgentScope {
  const safeGroupId = platformId(groupId, "groupId");
  const safeParticipantId = platformId(participantId, "participantId");
  const room = `v1:group:${channel}:room:${encodeURIComponent(safeGroupId)}`;
  const member = `${room}:member:${encodeURIComponent(safeParticipantId)}`;
  return {
    kind: "group",
    channel,
    groupId: safeGroupId,
    participantId: safeParticipantId,
    conversationKey: `${room}:conversation`,
    sharedMemoryKey: `${room}:memory`,
    memoryKey: `${member}:memory`,
  };
}

export function scopeKey(scope: AgentScope): string {
  switch (scope.kind) {
    case "private":
      return scope.conversationKey;
    case "group":
      return scope.memoryKey;
    case "workspace":
      return scope.authorityKey;
    default:
      return assertNever(scope);
  }
}

/**
 * Label aman untuk prompt dan telemetry. ID platform sengaja tidak ikut.
 */
export function scopeLabel(scope: AgentScope): string {
  return `${scope.kind}:${scope.channel}`;
}

function platformId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} tidak boleh kosong.`);
  if (normalized.length > MAX_PLATFORM_ID_CHARACTERS) {
    throw new Error(`${field} terlalu panjang.`);
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new Error(`${field} memuat karakter kontrol.`);
  }
  return normalized;
}

function assertNever(value: never): never {
  throw new Error(`Jenis scope tidak dikenali: ${String(value)}.`);
}
