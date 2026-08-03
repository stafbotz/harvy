import { createHash, randomUUID } from "node:crypto";
import {
  groupScopeKey,
  type GroupBinding,
  type GroupMemberMemory,
  type GroupMemberMemoryItem,
  type GroupMemory,
  type GroupMessage,
  type GroupMessagePart,
  type GroupParticipantActivity,
  type GroupRepository,
  type GroupRoomMemory,
  type GroupRoomMemoryItem,
  type GroupRoomMemoryKind,
  type GroupScope,
} from "../domain/group.js";
import type { MemoryItem, MemoryKind } from "../domain/memory.js";
import {
  expiryFor,
  selectRelevantMemories,
} from "./memory-policy.js";

const ACTIVITY_RETENTION_DAYS = 30;
const SEEN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_SEEN_MESSAGES = 500;
const MAX_MEMBER_MEMORIES = 12;
const MAX_ROOM_MEMORIES = 20;
export const SOCIAL_STAT_WINDOW_DAYS = 7;
export const ROOM_MEMORY_RETENTION_DAYS = 60;

export type GroupMutationGuard = () => Promise<boolean>;

export type ActivationResult =
  | { status: "active"; binding: GroupBinding; created: boolean }
  | { status: "conflict"; binding: GroupBinding };

export interface ActivityRank {
  participantId: string;
  displayName: string | null;
  messages: number;
}

export type RecordIncomingResult =
  | { status: "recorded"; parts: GroupMessagePart[] }
  | { status: "duplicate" }
  | { status: "inactive" };

export interface NewGroupMemberMemory {
  kind: MemoryKind;
  content: string;
  sensitivity: "ordinary" | "sensitive";
  consent: "notice" | "explicit";
  source: "conversation" | "explicit";
}

export type RememberGroupMemberMemoryResult =
  | { status: "saved"; item: GroupMemberMemoryItem }
  | { status: "duplicate" }
  | { status: "requires-consent" }
  | { status: "limit" }
  | { status: "inactive" }
  | { status: "invalid" };

export type RememberGroupRoomMemoryResult =
  | { status: "saved"; item: GroupRoomMemoryItem }
  | { status: "duplicate" | "limit" | "inactive" | "invalid" }
  | { status: "requires-admin-confirmation" };

/**
 * Semua operasi mutasi diserialisasi per ruang. Repository juga mempunyai
 * antrean global karena beberapa ruang masih berbagi satu berkas JSON.
 */
export class GroupMemoryService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: GroupRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async activate(
    scope: GroupScope,
    accountId: string,
    groupName: string | null,
    joinedAt = this.now().toISOString(),
  ): Promise<ActivationResult> {
    const scopeKey = groupScopeKey(scope);
    return this.exclusive(scopeKey, async () => {
      const existing = await this.repository.loadBinding(scopeKey);
      if (existing && existing.accountId !== accountId) {
        return { status: "conflict", binding: existing };
      }

      if (existing && !existing.disabledAt) {
        if (groupName && groupName !== existing.groupName) {
          const updated = { ...existing, groupName };
          await this.repository.saveBinding(updated);
          return { status: "active", binding: updated, created: false };
        }
        return { status: "active", binding: existing, created: false };
      }

      const binding: GroupBinding = {
        scopeKey,
        channel: scope.channel,
        groupId: scope.groupId,
        accountId,
        groupName,
        joinedAt,
        noticeVersion: null,
        noticeSentAt: null,
        disabledAt: null,
      };
      await this.repository.saveBinding(binding);
      return { status: "active", binding, created: true };
    });
  }

  async binding(scopeKey: string): Promise<GroupBinding | null> {
    return this.repository.loadBinding(scopeKey);
  }

  async markNoticeSent(
    scopeKey: string,
    accountId: string,
    noticeVersion: number,
  ): Promise<boolean> {
    return this.exclusive(scopeKey, async () => {
      const binding = await this.repository.loadBinding(scopeKey);
      if (
        !binding ||
        binding.accountId !== accountId ||
        binding.disabledAt !== null
      ) {
        return false;
      }

      await this.repository.saveBinding({
        ...binding,
        noticeVersion,
        noticeSentAt: this.now().toISOString(),
      });
      return true;
    });
  }

  async disable(
    scopeKey: string,
    accountId: string,
    at = this.now().toISOString(),
  ): Promise<boolean> {
    return this.exclusive(scopeKey, async () => {
      if (this.repository.disableAndRemoveScope) {
        return this.repository.disableAndRemoveScope(
          scopeKey,
          accountId,
          at,
        );
      }
      const binding = await this.repository.loadBinding(scopeKey);
      if (!binding || binding.accountId !== accountId) {
        return false;
      }
      const wasActive = binding.disabledAt === null;
      if (wasActive) {
        await this.repository.saveBinding({
          ...binding,
          groupName: null,
          joinedAt: at,
          noticeVersion: null,
          noticeSentAt: null,
          disabledAt: at,
        });
      }
      // Memori sosial hanya hidup selama Harvy menjadi anggota aktif. Binding
      // dinonaktifkan tetap dipertahankan agar re-add akun yang sama dapat
      // dibedakan dari perpindahan akun diam-diam.
      await this.repository.removeMemory(scopeKey);
      await this.repository.removeMemberMemories?.(scopeKey);
      await this.repository.removeRoomMemory?.(scopeKey);
      return wasActive;
    });
  }

  /**
   * Mencatat satu pesan baru dan aktivitas pengirim. `false` berarti pesan itu
   * sudah pernah dilihat dan tidak boleh diproses atau dihitung lagi.
   */
  async recordIncoming(message: GroupMessage): Promise<RecordIncomingResult> {
    const scopeKey = groupScopeKey(message.scope);
    return this.exclusive(scopeKey, async () => {
      const binding = await this.repository.loadBinding(scopeKey);
      if (
        !binding ||
        binding.accountId !== message.accountId ||
        binding.disabledAt !== null
      ) {
        return { status: "inactive" };
      }

      const current = await this.loadOrCreateMemory(
        scopeKey,
        message.groupName,
      );
      const nowMs = this.now().getTime();
      pruneMemory(current, nowMs);
      const knownIds = new Set(
        current.recentMessageIds.map((seen) => seen.messageId),
      );
      const parts = message.parts?.length
        ? message.parts
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
      const newParts = parts.filter((part) => {
        if (knownIds.has(part.messageId)) return false;
        knownIds.add(part.messageId);
        return true;
      });
      if (newParts.length === 0) return { status: "duplicate" };

      for (const part of newParts) {
        current.recentMessageIds.push({
          messageId: part.messageId,
          seenAt: safeDate(part.at, this.now()),
        });
      }
      if (current.recentMessageIds.length > MAX_SEEN_MESSAGES) {
        current.recentMessageIds.splice(
          0,
          current.recentMessageIds.length - MAX_SEEN_MESSAGES,
        );
      }

      const participant = participantOf(current, message);
      for (const part of newParts) {
        const date = safeDate(part.at, this.now()).slice(0, 10);
        const bucket = participant.daily.find((item) => item.date === date);
        if (bucket) bucket.messages += 1;
        else participant.daily.push({ date, messages: 1 });
      }

      participant.lastSeenAt = newParts
        .map((part) => safeDate(part.at, this.now()))
        .sort()
        .at(-1) ?? participant.lastSeenAt;
      if (message.participantName) {
        participant.displayName = message.participantName;
      }
      if (message.groupName) current.groupName = message.groupName;
      current.updatedAt = this.now().toISOString();

      await this.repository.saveMemory(current);
      return { status: "recorded", parts: newParts };
    });
  }

  /**
   * Mengembalikan dedupe dan hitungan bila balasan gagal dikirim. Pemanggil
   * wajib memberi hanya part yang benar-benar baru pada percobaan tersebut.
   */
  async rollbackIncoming(message: GroupMessage): Promise<boolean> {
    const scopeKey = groupScopeKey(message.scope);
    return this.exclusive(scopeKey, async () => {
      const memory = await this.repository.loadMemory(scopeKey);
      if (!memory) return false;
      const parts = message.parts?.length
        ? message.parts
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
      const ids = new Set(parts.map((part) => part.messageId));
      if (
        !memory.recentMessageIds.some((seen) => ids.has(seen.messageId))
      ) {
        return false;
      }

      memory.recentMessageIds = memory.recentMessageIds.filter(
        (seen) => !ids.has(seen.messageId),
      );
      const participant = this.participantActivity(
        memory,
        participantIdentitiesFromMessage(message),
      );
      if (participant) {
        for (const part of parts) {
          const date = safeDate(part.at, this.now()).slice(0, 10);
          const bucket = participant.daily.find((item) => item.date === date);
          if (bucket) bucket.messages = Math.max(0, bucket.messages - 1);
        }
        participant.daily = participant.daily.filter(
          (bucket) => bucket.messages > 0,
        );
        if (participant.daily.length === 0) {
          memory.participants = memory.participants.filter(
            (candidate) => candidate !== participant,
          );
        }
      }
      memory.updatedAt = this.now().toISOString();
      await this.repository.saveMemory(memory);
      return true;
    });
  }

  async recordHarvyReply(
    scopeKey: string,
    accountId: string,
  ): Promise<boolean> {
    return this.exclusive(scopeKey, async () => {
      if (!(await this.isActiveBinding(scopeKey, accountId))) return false;
      const memory = await this.loadOrCreateMemory(scopeKey, null);
      memory.lastHarvyMessageAt = this.now().toISOString();
      memory.updatedAt = this.now().toISOString();
      await this.repository.saveMemory(memory);
      return true;
    });
  }

  async memory(scopeKey: string): Promise<GroupMemory | null> {
    return this.exclusive(scopeKey, async () => {
      const memory = await this.repository.loadMemory(scopeKey);
      if (!memory) return null;

      if (pruneMemory(memory, this.now().getTime())) {
        memory.updatedAt = this.now().toISOString();
        await this.repository.saveMemory(memory);
      }
      return memory;
    });
  }

  /** Menghapus aktivitas kedaluwarsa juga pada grup yang sedang tidak aktif. */
  async purgeExpired(): Promise<void> {
    const memories = await this.repository.listMemories();
    const memberScopes = this.repository.listMemberMemoryScopes
      ? await this.repository.listMemberMemoryScopes()
      : [];
    const roomScopes = this.repository.listRoomMemoryScopes
      ? await this.repository.listRoomMemoryScopes()
      : [];
    await Promise.all(
      memories.map((memory) =>
        this.exclusive(memory.scopeKey, async () => {
          const current = await this.repository.loadMemory(memory.scopeKey);
          if (!current || !pruneMemory(current, this.now().getTime())) return;
          current.updatedAt = this.now().toISOString();
          await this.repository.saveMemory(current);
        }),
      ),
    );
    if (this.repository.loadMemberMemories && this.repository.saveMemberMemories) {
      await Promise.all(
        [...new Set([
          ...memories.map((memory) => memory.scopeKey),
          ...memberScopes,
        ])].map((scopeKey) =>
          this.exclusive(scopeKey, async () => {
            const records = await this.repository.loadMemberMemories!(
              scopeKey,
            );
            if (!pruneMemberMemories(records, this.now())) return;
            await this.repository.saveMemberMemories!(scopeKey, records);
          }),
        ),
      );
    }
    if (this.repository.loadRoomMemory && this.repository.saveRoomMemory) {
      await Promise.all(
        roomScopes.map((scopeKey) =>
          this.exclusive(scopeKey, async () => {
            const memory = await this.repository.loadRoomMemory!(scopeKey);
            if (!memory || !pruneRoomMemory(memory, this.now())) return;
            if (memory.items.length === 0 && this.repository.removeRoomMemory) {
              await this.repository.removeRoomMemory(scopeKey);
            } else {
              await this.repository.saveRoomMemory!(memory);
            }
          }),
        ),
      );
    }
  }

  async roomMemories(scopeKey: string): Promise<GroupRoomMemoryItem[]> {
    if (!this.repository.loadRoomMemory) return [];
    return this.exclusive(scopeKey, async () => {
      const memory = await this.repository.loadRoomMemory!(scopeKey);
      if (!memory) return [];
      if (pruneRoomMemory(memory, this.now())) {
        if (memory.items.length === 0 && this.repository.removeRoomMemory) {
          await this.repository.removeRoomMemory(scopeKey);
        } else if (this.repository.saveRoomMemory) {
          await this.repository.saveRoomMemory(memory);
        }
      }
      return [...memory.items].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt, "en"),
      );
    });
  }

  async rememberRoomMemory(
    scopeKey: string,
    accountId: string,
    participantIds: readonly string[],
    kind: GroupRoomMemoryKind,
    content: string,
    adminConfirmed: boolean,
    guard: GroupMutationGuard,
  ): Promise<RememberGroupRoomMemoryResult> {
    if (!adminConfirmed) return { status: "requires-admin-confirmation" };
    if (!this.repository.loadRoomMemory || !this.repository.saveRoomMemory) {
      return { status: "inactive" };
    }
    const clean = cleanRoomMemoryContent(content);
    if (!clean || participantIds.length === 0) return { status: "invalid" };

    return this.exclusive(scopeKey, async () => {
      if (!(await this.isActiveBinding(scopeKey, accountId))) {
        return { status: "inactive" };
      }
      const at = this.now();
      const memory = (await this.repository.loadRoomMemory!(scopeKey)) ?? {
        scopeKey,
        items: [],
        generation: 0,
        updatedAt: at.toISOString(),
      };
      pruneRoomMemory(memory, at);
      if (
        memory.items.some(
          (item) =>
            item.kind === kind &&
            normalizeMemoryContent(item.content) === normalizeMemoryContent(clean),
        )
      ) {
        return { status: "duplicate" };
      }
      if (memory.items.length >= MAX_ROOM_MEMORIES) {
        return { status: "limit" };
      }
      // Re-check immediately before constructing the durable mutation. The
      // caller's authority may have been invalidated while the repository
      // read/prune was in flight.
      if (guard && !(await guard())) return { status: "inactive" };
      const item: GroupRoomMemoryItem = {
        id: this.makeId(),
        kind,
        content: clean,
        proposedByAliasKeys: [
          ...new Set(
            participantIds.map((id) => memberAliasKey(scopeKey, id)),
          ),
        ],
        visibility: "room",
        consent: "admin-confirmed",
        source: "explicit",
        createdAt: at.toISOString(),
        expiresAt: new Date(
          at.getTime() + ROOM_MEMORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
        ).toISOString(),
      };
      memory.items.push(item);
      memory.generation += 1;
      memory.updatedAt = at.toISOString();
      await this.repository.saveRoomMemory!(memory);
      return { status: "saved", item };
    });
  }

  async removeRoomMemory(
    scopeKey: string,
    memoryId: string,
    accountId: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    if (!this.repository.loadRoomMemory || !this.repository.saveRoomMemory) {
      return false;
    }
    return this.exclusive(scopeKey, async () => {
      if (accountId && !(await this.isActiveBinding(scopeKey, accountId))) {
        return false;
      }
      const memory = await this.repository.loadRoomMemory!(scopeKey);
      if (!memory) return false;
      const matches = memory.items.filter((item) =>
        memoryIdMatches(item.id, memoryId),
      );
      if (matches.length !== 1) return false;
      memory.items = memory.items.filter((item) => item.id !== matches[0]?.id);
      memory.generation += 1;
      memory.updatedAt = this.now().toISOString();
      if (guard && !(await guard())) return false;
      if (memory.items.length === 0 && this.repository.removeRoomMemory) {
        await this.repository.removeRoomMemory(scopeKey);
      } else {
        await this.repository.saveRoomMemory!(memory);
      }
      return true;
    });
  }

  /**
   * Mengambil memori semantik hanya untuk anggota lokal ini di grup ini.
   * Room context tetap terpisah dan dibangun `GroupTurnService`.
   */
  async memberMemories(
    scopeKey: string,
    participantIds: readonly string[],
    message?: string,
  ): Promise<GroupMemberMemoryItem[]> {
    if (!this.repository.loadMemberMemories) return [];
    return this.exclusive(scopeKey, async () => {
      const records = await this.repository.loadMemberMemories!(scopeKey);
      const changed = pruneMemberMemories(records, this.now());
      if (changed && this.repository.saveMemberMemories) {
        await this.repository.saveMemberMemories(scopeKey, records);
      }
      const keys = new Set(
        participantIds.map((id) => memberAliasKey(scopeKey, id)),
      );
      const matched = records.filter((record) =>
        record.aliasKeys.some((key) => keys.has(key)),
      );
      const all = matched.flatMap((record) => record.items);
      if (message === undefined) {
        return all
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt, "en"),
          )
          .slice(0, MAX_MEMBER_MEMORIES);
      }
      const byId = new Map(all.map((item) => [item.id, item]));
      const selected = selectRelevantMemories(
        all.map((item): MemoryItem => ({
          id: item.id,
          ownerId: scopeKey,
          kind: item.kind,
          content: item.content,
          createdAt: item.createdAt,
          lastUsedAt: null,
          expiresAt: item.expiresAt,
        })),
        message,
        this.now(),
      );
      return selected
        .map((item) => byId.get(item.id))
        .filter((item): item is GroupMemberMemoryItem => Boolean(item));
    });
  }

  async rememberParticipantMemory(
    scopeKey: string,
    accountId: string,
    participantIds: readonly string[],
    candidate: NewGroupMemberMemory,
    guard: GroupMutationGuard,
  ): Promise<RememberGroupMemberMemoryResult> {
    if (
      !this.repository.loadMemberMemories ||
      !this.repository.saveMemberMemories
    ) {
      return { status: "inactive" };
    }
    const content = cleanMemberMemoryContent(candidate.content);
    if (!content || participantIds.length === 0) return { status: "invalid" };
    const sensitive =
      candidate.kind === "personal" || candidate.sensitivity === "sensitive";
    if (sensitive && candidate.consent !== "explicit") {
      return { status: "requires-consent" };
    }

    return this.exclusive(scopeKey, async () => {
      if (!(await this.isActiveBinding(scopeKey, accountId))) {
        return { status: "inactive" };
      }
      const records = await this.repository.loadMemberMemories!(scopeKey);
      pruneMemberMemories(records, this.now());
      const incomingKeys = new Set(
        participantIds.map((id) => memberAliasKey(scopeKey, id)),
      );
      const matched = records.filter((record) =>
        record.aliasKeys.some((key) => incomingKeys.has(key)),
      );
      const existingItems = matched.flatMap((record) => record.items);
      if (
        existingItems.some(
          (item) =>
            item.kind === candidate.kind &&
            normalizeMemoryContent(item.content) === normalizeMemoryContent(content),
        )
      ) {
        return { status: "duplicate" };
      }
      if (existingItems.length >= MAX_MEMBER_MEMORIES) {
        return { status: "limit" };
      }

      const at = this.now().toISOString();
      const item: GroupMemberMemoryItem = {
        id: this.makeId(),
        kind: candidate.kind,
        content,
        sensitivity: sensitive ? "sensitive" : "ordinary",
        visibility: "member-local",
        consent: candidate.consent,
        source: candidate.source,
        createdAt: at,
        lastConfirmedAt: at,
        expiresAt: expiryFor(candidate.kind, this.now())?.toISOString() ?? null,
      };
      const merged: GroupMemberMemory = {
        scopeKey,
        memberId: matched[0]?.memberId ?? this.makeId(),
        aliasKeys: [
          ...new Set([
            ...matched.flatMap((record) => record.aliasKeys),
            ...incomingKeys,
          ]),
        ],
        items: [...existingItems, item],
        generation:
          Math.max(0, ...matched.map((record) => record.generation)) + 1,
        updatedAt: at,
      };
      const matchedIds = new Set(matched.map((record) => record.memberId));
      if (guard && !(await guard())) return { status: "inactive" };
      await this.repository.saveMemberMemories!(scopeKey, [
        ...records.filter((record) => !matchedIds.has(record.memberId)),
        merged,
      ]);
      return { status: "saved", item };
    });
  }

  async removeParticipantMemory(
    scopeKey: string,
    participantIds: readonly string[],
    memoryId: string,
    accountId: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    if (!this.repository.loadMemberMemories || !this.repository.saveMemberMemories) {
      return false;
    }
    return this.exclusive(scopeKey, async () => {
      if (accountId && !(await this.isActiveBinding(scopeKey, accountId))) {
        return false;
      }
      const records = await this.repository.loadMemberMemories!(scopeKey);
      const keys = new Set(
        participantIds.map((id) => memberAliasKey(scopeKey, id)),
      );
      const matchingItems = records
        .filter((record) => record.aliasKeys.some((key) => keys.has(key)))
        .flatMap((record) => record.items)
        .filter((item) => memoryIdMatches(item.id, memoryId));
      if (matchingItems.length !== 1) return false;
      const exactId = matchingItems[0]?.id;
      let removed = false;
      for (const record of records) {
        if (!record.aliasKeys.some((key) => keys.has(key))) continue;
        const before = record.items.length;
        record.items = record.items.filter((item) => item.id !== exactId);
        if (record.items.length !== before) {
          removed = true;
          record.generation += 1;
          record.updatedAt = this.now().toISOString();
        }
      }
      if (removed) {
        if (guard && !(await guard())) return false;
        await this.repository.saveMemberMemories!(scopeKey, records);
      }
      return removed;
    });
  }

  async editParticipantMemory(
    scopeKey: string,
    participantIds: readonly string[],
    memoryId: string,
    content: string,
    accountId: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    if (!this.repository.loadMemberMemories || !this.repository.saveMemberMemories) {
      return false;
    }
    const clean = cleanMemberMemoryContent(content);
    if (!clean) return false;
    return this.exclusive(scopeKey, async () => {
      if (accountId && !(await this.isActiveBinding(scopeKey, accountId))) {
        return false;
      }
      const records = await this.repository.loadMemberMemories!(scopeKey);
      const keys = new Set(
        participantIds.map((id) => memberAliasKey(scopeKey, id)),
      );
      const matches = records
        .filter((record) => record.aliasKeys.some((key) => keys.has(key)))
        .flatMap((record) => record.items)
        .filter((item) => memoryIdMatches(item.id, memoryId));
      if (matches.length !== 1) return false;
      const targetId = matches[0]?.id;
      for (const record of records) {
        if (!record.aliasKeys.some((key) => keys.has(key))) continue;
        const item = record.items.find((candidate) => candidate.id === targetId);
        if (!item) continue;
        item.content = clean;
        item.lastConfirmedAt = this.now().toISOString();
        record.generation += 1;
        record.updatedAt = this.now().toISOString();
        if (guard && !(await guard())) return false;
        await this.repository.saveMemberMemories!(scopeKey, records);
        return true;
      }
      return false;
    });
  }

  async rememberHarvyAlias(
    scopeKey: string,
    accountId: string,
    alias: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    const clean = cleanAlias(alias);
    if (!clean) return false;

    return this.exclusive(scopeKey, async () => {
      if (!(await this.isActiveBinding(scopeKey, accountId))) return false;
      const memory = await this.loadOrCreateMemory(scopeKey, null);
      if (
        memory.harvyAliases.some(
          (stored) => stored.toLocaleLowerCase("id-ID") === clean.toLocaleLowerCase("id-ID"),
        )
      ) {
        return false;
      }
      memory.harvyAliases.push(clean);
      memory.updatedAt = this.now().toISOString();
      if (guard && !(await guard())) return false;
      await this.repository.saveMemory(memory);
      return true;
    });
  }

  async forgetParticipant(
    scopeKey: string,
    participantIds: readonly string[],
    accountId: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    return this.exclusive(scopeKey, async () => {
      if (accountId && !(await this.isActiveBinding(scopeKey, accountId))) {
        return false;
      }
      const identities = new Set(participantIds);
      const aliasKeys = participantIds.map((id) =>
        memberAliasKey(scopeKey, id),
      );
      const at = this.now().toISOString();

      // Guard hanya sekali, sesudah binding aktif dibuktikan dan tepat sebelum
      // deletion commit. Sesudah pengguna mengonfirmasi penghapusan, perubahan
      // authority yang datang di tengah cleanup tidak boleh meninggalkan tiga
      // store pada keadaan separuh terhapus.
      if (guard && !(await guard())) return false;
      if (this.repository.forgetParticipantState) {
        return this.repository.forgetParticipantState(
          scopeKey,
          participantIds,
          aliasKeys,
          at,
        );
      }

      const memory = await this.repository.loadMemory(scopeKey);
      const records = this.repository.loadMemberMemories
        ? await this.repository.loadMemberMemories(scopeKey)
        : [];
      const room = this.repository.loadRoomMemory
        ? await this.repository.loadRoomMemory(scopeKey)
        : null;
      const keys = new Set(aliasKeys);
      let socialChanged = false;
      let membersChanged = false;
      let roomChanged = false;

      if (memory) {
        const retained = memory.participants.filter(
          (participant) =>
            !participantIdentities(participant).some((identity) =>
              identities.has(identity),
            ),
        );
        if (retained.length !== memory.participants.length) {
          memory.participants = retained;
          memory.updatedAt = at;
          socialChanged = true;
        }
      }
      const retainedRecords = records.filter(
        (record) => !record.aliasKeys.some((key) => keys.has(key)),
      );
      membersChanged = retainedRecords.length !== records.length;
      if (room) {
        room.items = room.items.map((item) => {
          const retained = item.proposedByAliasKeys.filter(
            (key) => !keys.has(key),
          );
          if (retained.length === item.proposedByAliasKeys.length) return item;
          roomChanged = true;
          return { ...item, proposedByAliasKeys: retained };
        });
        if (roomChanged) {
          room.generation += 1;
          room.updatedAt = at;
        }
      }

      // Fallback adapter lama tidak menjanjikan satu-file atomic commit, tetapi
      // tidak lagi berhenti di tengah hanya karena authority epoch berubah.
      if (socialChanged && memory) await this.repository.saveMemory(memory);
      if (membersChanged && this.repository.saveMemberMemories) {
        await this.repository.saveMemberMemories(scopeKey, retainedRecords);
      }
      if (roomChanged && room && this.repository.saveRoomMemory) {
        await this.repository.saveRoomMemory(room);
      }
      return socialChanged || membersChanged || roomChanged;
    });
  }

  async correctParticipantName(
    scopeKey: string,
    accountId: string,
    participantIds: readonly string[],
    displayName: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    const clean = cleanDisplayName(displayName);
    if (!clean) return false;

    return this.exclusive(scopeKey, async () => {
      if (!(await this.isActiveBinding(scopeKey, accountId))) return false;
      const memory = await this.repository.loadMemory(scopeKey);
      if (!memory) return false;
      const participant = this.participantActivity(memory, participantIds);
      if (!participant) return false;

      participant.displayNameOverride = clean;
      memory.updatedAt = this.now().toISOString();
      if (guard && !(await guard())) return false;
      await this.repository.saveMemory(memory);
      return true;
    });
  }

  participantActivity(
    memory: GroupMemory,
    participantIds: readonly string[],
  ): GroupParticipantActivity | null {
    const identities = new Set(participantIds);
    return (
      memory.participants.find((participant) =>
        participantIdentities(participant).some((identity) =>
          identities.has(identity),
        ),
      ) ?? null
    );
  }

  /**
   * Reset admin hanya menguasai state bersama. Member-local dan dedupe teknis
   * tidak ikut dihapus; anggota tetap menguasai datanya sendiri.
   */
  async resetMemory(
    scopeKey: string,
    accountId: string,
    guard: GroupMutationGuard,
  ): Promise<boolean> {
    return this.exclusive(scopeKey, async () => {
      if (accountId && !(await this.isActiveBinding(scopeKey, accountId))) {
        return false;
      }
      if (guard && !(await guard())) return false;
      if (this.repository.resetSharedMemory) {
        return this.repository.resetSharedMemory(
          scopeKey,
          this.now().toISOString(),
        );
      }
      const memory = await this.repository.loadMemory(scopeKey);
      let changed = false;
      if (memory) {
        memory.harvyAliases = ["Harvy"];
        memory.participants = [];
        memory.lastHarvyMessageAt = null;
        memory.updatedAt = this.now().toISOString();
        if (guard && !(await guard())) return false;
        await this.repository.saveMemory(memory);
        changed = true;
      }
      const removed = await this.repository.removeRoomMemory?.(scopeKey);
      return changed || Boolean(removed);
    });
  }

  activityRanking(
    memory: GroupMemory,
    days = SOCIAL_STAT_WINDOW_DAYS,
  ): ActivityRank[] {
    const threshold = new Date(
      this.now().getTime() - Math.max(0, days - 1) * 24 * 60 * 60 * 1_000,
    )
      .toISOString()
      .slice(0, 10);

    return memory.participants
      .map((participant) => ({
        participantId: participant.participantId,
        displayName:
          participant.displayNameOverride ?? participant.displayName,
        messages: participant.daily
          .filter((bucket) => bucket.date >= threshold)
          .reduce((total, bucket) => total + bucket.messages, 0),
      }))
      .filter((participant) => participant.messages > 0)
      .sort(
        (left, right) =>
          right.messages - left.messages ||
          (left.displayName ?? left.participantId).localeCompare(
            right.displayName ?? right.participantId,
            "id-ID",
          ),
      );
  }

  private async loadOrCreateMemory(
    scopeKey: string,
    groupName: string | null,
  ): Promise<GroupMemory> {
    return (
      (await this.repository.loadMemory(scopeKey)) ?? {
        scopeKey,
        groupName,
        harvyAliases: ["Harvy"],
        participants: [],
        recentMessageIds: [],
        lastHarvyMessageAt: null,
        updatedAt: this.now().toISOString(),
      }
    );
  }

  private async isActiveBinding(
    scopeKey: string,
    accountId: string,
  ): Promise<boolean> {
    const binding = await this.repository.loadBinding(scopeKey);
    return (
      binding?.accountId === accountId &&
      binding.disabledAt === null
    );
  }

  private async exclusive<T>(
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

function participantOf(
  memory: GroupMemory,
  message: GroupMessage,
): GroupParticipantActivity {
  const incomingIdentities = new Set([
    message.participantId,
    ...message.participantAliases,
  ]);
  const matches = memory.participants.filter(
    (participant) =>
      participantIdentities(participant).some((identity) =>
        incomingIdentities.has(identity),
      ),
  );
  const existing = matches[0];
  if (existing) {
    // PN dan LID dapat terlihat terpisah sebelum satu event membawa keduanya.
    // Event penghubung wajib menyatukan semua record yang overlap, bukan hanya
    // mengambil record pertama dan meninggalkan identitas ganda.
    for (const duplicate of matches.slice(1)) {
      mergeParticipantActivity(existing, duplicate);
      const index = memory.participants.indexOf(duplicate);
      if (index >= 0) memory.participants.splice(index, 1);
    }
    existing.identityAliases = [
      ...new Set([
        ...(existing.identityAliases ?? []),
        ...incomingIdentities,
      ]),
    ];
    return existing;
  }

  const participant: GroupParticipantActivity = {
    participantId: message.participantId,
    identityAliases: [...incomingIdentities],
    displayName: message.participantName,
    displayNameOverride: null,
    daily: [],
    lastSeenAt: safeDate(message.at, new Date()),
  };
  memory.participants.push(participant);
  return participant;
}

function mergeParticipantActivity(
  target: GroupParticipantActivity,
  source: GroupParticipantActivity,
): void {
  target.identityAliases = [
    ...new Set([
      ...(target.identityAliases ?? []),
      ...participantIdentities(source),
    ]),
  ];
  if (!target.displayNameOverride && source.displayNameOverride) {
    target.displayNameOverride = source.displayNameOverride;
  }
  if (!target.displayName && source.displayName) {
    target.displayName = source.displayName;
  }
  const daily = new Map(target.daily.map((bucket) => [bucket.date, bucket.messages]));
  for (const bucket of source.daily) {
    daily.set(bucket.date, (daily.get(bucket.date) ?? 0) + bucket.messages);
  }
  target.daily = [...daily]
    .map(([date, messages]) => ({ date, messages }))
    .sort((left, right) => left.date.localeCompare(right.date, "en"));
  if (Date.parse(source.lastSeenAt) > Date.parse(target.lastSeenAt)) {
    target.lastSeenAt = source.lastSeenAt;
  }
}

function pruneMemory(memory: GroupMemory, nowMs: number): boolean {
  const seenCount = memory.recentMessageIds.length;
  const seenThreshold = nowMs - SEEN_RETENTION_MS;
  memory.recentMessageIds = memory.recentMessageIds.filter(
    (seen) => new Date(seen.seenAt).getTime() >= seenThreshold,
  );

  const activityThreshold = new Date(
    nowMs - (ACTIVITY_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000,
  )
    .toISOString()
    .slice(0, 10);
  let activityPruned = false;
  for (const participant of memory.participants) {
    const bucketCount = participant.daily.length;
    participant.daily = participant.daily.filter(
      (bucket) => bucket.date >= activityThreshold,
    );
    if (participant.daily.length !== bucketCount) activityPruned = true;
  }
  const participantCount = memory.participants.length;
  memory.participants = memory.participants.filter(
    (participant) => participant.daily.length > 0,
  );

  return (
    seenCount !== memory.recentMessageIds.length ||
    participantCount !== memory.participants.length ||
    activityPruned
  );
}

function pruneMemberMemories(
  records: GroupMemberMemory[],
  now: Date,
): boolean {
  let changed = false;
  for (const record of records) {
    const before = record.items.length;
    record.items = record.items.filter(
      (item) =>
        item.expiresAt === null ||
        Date.parse(item.expiresAt) > now.getTime(),
    );
    if (record.items.length !== before) {
      record.generation += 1;
      record.updatedAt = now.toISOString();
      changed = true;
    }
  }
  return changed;
}

function memberAliasKey(scopeKey: string, participantId: string): string {
  return createHash("sha256")
    .update(scopeKey, "utf8")
    .update("\u0000", "utf8")
    .update(participantId, "utf8")
    .digest("hex");
}

function cleanRoomMemoryContent(value: string): string | null {
  const clean = value.trim().replace(/\s+/gu, " ");
  if (
    clean.length < 3 ||
    clean.length > 300 ||
    /\p{Cc}/u.test(clean)
  ) {
    return null;
  }
  return clean;
}

function pruneRoomMemory(memory: GroupRoomMemory, now: Date): boolean {
  const before = memory.items.length;
  memory.items = memory.items.filter(
    (item) => Date.parse(item.expiresAt) > now.getTime(),
  );
  if (memory.items.length !== before) {
    memory.generation += 1;
    memory.updatedAt = now.toISOString();
    return true;
  }
  return false;
}

function cleanMemberMemoryContent(value: string): string | null {
  const clean = value
    .replace(/[\u0000\r\n<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length >= 3 && clean.length <= 200 ? clean : null;
}

function normalizeMemoryContent(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function memoryIdMatches(stored: string, requested: string): boolean {
  const clean = requested.replace(/^#/u, "").trim();
  return stored === clean || (clean.length >= 6 && stored.startsWith(clean));
}

function cleanAlias(value: string): string | null {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < 3 || clean.length > 24) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(clean)) return null;
  if (
    new Set([
      "aku",
      "kamu",
      "dia",
      "kami",
      "kita",
      "mereka",
      "grup",
      "group",
      "game",
      "teman",
      "admin",
      "semua",
    ]).has(clean.toLocaleLowerCase("id-ID"))
  ) {
    return null;
  }
  return clean;
}

function cleanDisplayName(value: string): string | null {
  const clean = value
    .replace(/[\u0000\r\n<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length >= 1 && clean.length <= 80 ? clean : null;
}

function participantIdentities(
  participant: GroupParticipantActivity,
): string[] {
  return [
    participant.participantId,
    ...(participant.identityAliases ?? []),
  ];
}

function participantIdentitiesFromMessage(message: GroupMessage): string[] {
  return [
    message.participantId,
    ...message.participantAliases,
  ];
}

function safeDate(value: string, fallback: Date): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : fallback.toISOString();
}
