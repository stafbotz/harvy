import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  GroupBinding,
  GroupMemberMemory,
  GroupMemory,
  GroupRepository,
  GroupRoomMemory,
} from "../domain/group.js";

interface GroupDatabase {
  version: 3;
  bindings: GroupBinding[];
  memories: GroupMemory[];
  memberMemories: GroupMemberMemory[];
  roomMemories: GroupRoomMemory[];
}

/**
 * Penyimpanan binding akun dan memori grup dalam satu berkas atomik.
 *
 * Seluruh nomor Baileys masih hidup dalam satu proses. Antrean global di sini
 * mencegah dua grup menimpa perubahan satu sama lain ketika menyimpan serentak.
 */
export class FileGroupRepository implements GroupRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async loadBinding(scopeKey: string): Promise<GroupBinding | null> {
    const database = await this.readDatabase();
    return (
      database.bindings.find((binding) => binding.scopeKey === scopeKey) ?? null
    );
  }

  async saveBinding(binding: GroupBinding): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.bindings.findIndex(
        (stored) => stored.scopeKey === binding.scopeKey,
      );

      if (index >= 0) database.bindings[index] = binding;
      else database.bindings.push(binding);

      await this.writeDatabase(database);
    });
  }

  async loadMemory(scopeKey: string): Promise<GroupMemory | null> {
    const database = await this.readDatabase();
    return (
      database.memories.find((memory) => memory.scopeKey === scopeKey) ?? null
    );
  }

  async listMemories(): Promise<GroupMemory[]> {
    return (await this.readDatabase()).memories;
  }

  async saveMemory(memory: GroupMemory): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.memories.findIndex(
        (stored) => stored.scopeKey === memory.scopeKey,
      );

      if (index >= 0) database.memories[index] = memory;
      else database.memories.push(memory);

      await this.writeDatabase(database);
    });
  }

  async removeMemory(scopeKey: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.memories.findIndex(
        (memory) => memory.scopeKey === scopeKey,
      );
      if (index < 0) return false;

      database.memories.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async loadMemberMemories(scopeKey: string): Promise<GroupMemberMemory[]> {
    return (await this.readDatabase()).memberMemories.filter(
      (memory) => memory.scopeKey === scopeKey,
    );
  }

  async saveMemberMemories(
    scopeKey: string,
    memories: GroupMemberMemory[],
  ): Promise<void> {
    if (memories.some((memory) => memory.scopeKey !== scopeKey)) {
      throw new Error("Scope memori anggota grup tidak cocok.");
    }
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      database.memberMemories = [
        ...database.memberMemories.filter(
          (memory) => memory.scopeKey !== scopeKey,
        ),
        ...memories,
      ];
      await this.writeDatabase(database);
    });
  }

  async removeMemberMemories(scopeKey: string): Promise<number> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const before = database.memberMemories.length;
      database.memberMemories = database.memberMemories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      const removed = before - database.memberMemories.length;
      if (removed > 0) await this.writeDatabase(database);
      return removed;
    });
  }

  async listMemberMemoryScopes(): Promise<string[]> {
    return [
      ...new Set(
        (await this.readDatabase()).memberMemories.map(
          (memory) => memory.scopeKey,
        ),
      ),
    ];
  }

  async loadRoomMemory(scopeKey: string): Promise<GroupRoomMemory | null> {
    return (await this.readDatabase()).roomMemories.find(
      (memory) => memory.scopeKey === scopeKey,
    ) ?? null;
  }

  async saveRoomMemory(memory: GroupRoomMemory): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.roomMemories.findIndex(
        (stored) => stored.scopeKey === memory.scopeKey,
      );
      if (index >= 0) database.roomMemories[index] = memory;
      else database.roomMemories.push(memory);
      await this.writeDatabase(database);
    });
  }

  async removeRoomMemory(scopeKey: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const before = database.roomMemories.length;
      database.roomMemories = database.roomMemories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      if (database.roomMemories.length === before) return false;
      await this.writeDatabase(database);
      return true;
    });
  }

  async resetSharedMemory(scopeKey: string, at = new Date().toISOString()): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const memoryIndex = database.memories.findIndex(
        (memory) => memory.scopeKey === scopeKey,
      );
      const hadRoom = database.roomMemories.some(
        (memory) => memory.scopeKey === scopeKey,
      );
      if (memoryIndex < 0 && !hadRoom) return false;
      if (memoryIndex >= 0) {
        const memory = database.memories[memoryIndex]!;
        database.memories[memoryIndex] = {
          ...memory,
          harvyAliases: ["Harvy"],
          participants: [],
          lastHarvyMessageAt: null,
          updatedAt: at,
        };
      }
      database.roomMemories = database.roomMemories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      await this.writeDatabase(database);
      return true;
    });
  }

  async forgetParticipantState(
    scopeKey: string,
    participantIds: readonly string[],
    aliasKeys: readonly string[],
    at: string,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const identities = new Set(participantIds);
      const digests = new Set(aliasKeys);
      let changed = false;

      const social = database.memories.find(
        (memory) => memory.scopeKey === scopeKey,
      );
      if (social) {
        const retained = social.participants.filter((participant) =>
          ![participant.participantId, ...(participant.identityAliases ?? [])]
            .some((identity) => identities.has(identity)),
        );
        if (retained.length !== social.participants.length) {
          social.participants = retained;
          social.updatedAt = at;
          changed = true;
        }
      }

      const beforeMembers = database.memberMemories.length;
      database.memberMemories = database.memberMemories.filter(
        (memory) =>
          memory.scopeKey !== scopeKey ||
          !memory.aliasKeys.some((key) => digests.has(key)),
      );
      if (database.memberMemories.length !== beforeMembers) changed = true;

      const room = database.roomMemories.find(
        (memory) => memory.scopeKey === scopeKey,
      );
      if (room) {
        let roomChanged = false;
        room.items = room.items.map((item) => {
          const retained = item.proposedByAliasKeys.filter(
            (key) => !digests.has(key),
          );
          if (retained.length === item.proposedByAliasKeys.length) return item;
          roomChanged = true;
          return { ...item, proposedByAliasKeys: retained };
        });
        if (roomChanged) {
          room.generation += 1;
          room.updatedAt = at;
          changed = true;
        }
      }

      if (changed) await this.writeDatabase(database);
      return changed;
    });
  }

  async listRoomMemoryScopes(): Promise<string[]> {
    return (await this.readDatabase()).roomMemories.map(
      (memory) => memory.scopeKey,
    );
  }

  async disableAndRemoveScope(
    scopeKey: string,
    accountId: string,
    at: string,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.bindings.findIndex(
        (binding) =>
          binding.scopeKey === scopeKey && binding.accountId === accountId,
      );
      if (index < 0) return false;
      const binding = database.bindings[index];
      if (!binding) return false;
      const wasActive = binding.disabledAt === null;
      if (wasActive) {
        database.bindings[index] = {
          ...binding,
          groupName: null,
          joinedAt: at,
          noticeVersion: null,
          noticeSentAt: null,
          disabledAt: at,
        };
      }
      database.memories = database.memories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      database.memberMemories = database.memberMemories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      database.roomMemories = database.roomMemories.filter(
        (memory) => memory.scopeKey !== scopeKey,
      );
      await this.writeDatabase(database);
      return wasActive;
    });
  }

  private async readDatabase(): Promise<GroupDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        bindings?: unknown;
        memories?: unknown;
        memberMemories?: unknown;
        roomMemories?: unknown;
      };
      if (
        (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
        !Array.isArray(parsed.bindings) ||
        !Array.isArray(parsed.memories)
      ) {
        throw new Error("Format basis data grup tidak dikenali.");
      }
      return {
        version: 3,
        bindings: parsed.bindings as GroupBinding[],
        memories: parsed.memories as GroupMemory[],
        memberMemories:
          (parsed.version === 2 || parsed.version === 3) &&
            Array.isArray(parsed.memberMemories)
            ? parsed.memberMemories as GroupMemberMemory[]
            : [],
        roomMemories:
          parsed.version === 3 && Array.isArray(parsed.roomMemories)
            ? parsed.roomMemories as GroupRoomMemory[]
            : [],
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          version: 3,
          bindings: [],
          memories: [],
          memberMemories: [],
          roomMemories: [],
        };
      }
      throw error;
    }
  }

  private async writeDatabase(database: GroupDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
