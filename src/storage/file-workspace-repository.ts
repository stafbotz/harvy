import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  WorkspaceAuthorityState,
  WorkspaceMembership,
  WorkspaceRecord,
  WorkspaceRepository,
} from "../domain/workspace.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();

interface WorkspaceDatabase {
  version: 1;
  workspaces: WorkspaceRecord[];
  memberships: WorkspaceMembership[];
}

/**
 * Adapter pengembangan satu proses. PostgreSQL tetap diperlukan sebelum
 * workspace atau durable run dibuka sebagai surface produksi.
 */
export class FileWorkspaceRepository implements WorkspaceRepository {
  private readonly filePath: string;
  readonly coordinationKey: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    const canonical = process.platform === "win32"
      ? this.filePath.toLowerCase()
      : this.filePath;
    this.coordinationKey = `file-workspace:${canonical}`;
  }

  async loadAuthorityState(
    workspaceKey: string,
  ): Promise<WorkspaceAuthorityState | null> {
    const database = await this.readDatabase();
    const workspace = database.workspaces.find(
      (candidate) => candidate.workspaceKey === workspaceKey,
    );
    if (!workspace) return null;
    return structuredClone({
      workspace,
      memberships: database.memberships.filter(
        (membership) => membership.workspaceKey === workspaceKey,
      ),
    });
  }

  async listAuthorityStatesByPrincipal(
    principal: { channel: WorkspaceMembership["channel"]; principalKey: string },
  ): Promise<WorkspaceAuthorityState[]> {
    const database = await this.readDatabase();
    const workspaceKeys = new Set(
      database.memberships
        .filter((membership) =>
          membership.channel === principal.channel &&
          membership.principalKey === principal.principalKey &&
          membership.revokedAt === null
        )
        .map((membership) => membership.workspaceKey),
    );
    return database.workspaces
      .filter((workspace) => workspaceKeys.has(workspace.workspaceKey))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"))
      .map((workspace) => ({
        workspace: structuredClone(workspace),
        memberships: database.memberships
          .filter((membership) => membership.workspaceKey === workspace.workspaceKey)
          .map((membership) => structuredClone(membership)),
      }));
  }

  async saveAuthorityState(
    state: WorkspaceAuthorityState,
    expectedAclEpoch: number | null,
  ): Promise<"saved" | "conflict"> {
    validateState(state);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.workspaces.findIndex(
        (workspace) =>
          workspace.workspaceKey === state.workspace.workspaceKey,
      );
      const current = index >= 0 ? database.workspaces[index]! : null;
      if (
        (expectedAclEpoch === null && current !== null) ||
        (expectedAclEpoch !== null &&
          (current === null || current.aclEpoch !== expectedAclEpoch))
      ) {
        return "conflict";
      }
      if (
        expectedAclEpoch !== null &&
        state.workspace.aclEpoch !== expectedAclEpoch + 1
      ) {
        throw new Error("Epoch authority workspace harus naik tepat satu.");
      }
      const workspace = structuredClone(state.workspace);
      if (index >= 0) database.workspaces[index] = workspace;
      else database.workspaces.push(workspace);
      database.memberships = [
        ...database.memberships.filter(
          (membership) =>
            membership.workspaceKey !== state.workspace.workspaceKey,
        ),
        ...structuredClone(state.memberships),
      ];
      await this.writeDatabase(database);
      return "saved";
    });
  }

  private async readDatabase(): Promise<WorkspaceDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<WorkspaceDatabase>;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.workspaces) ||
        !Array.isArray(parsed.memberships)
      ) {
        throw new Error("Format basis data workspace tidak dikenali.");
      }
      return {
        version: 1,
        workspaces: parsed.workspaces,
        memberships: parsed.memberships,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, workspaces: [], memberships: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: WorkspaceDatabase): Promise<void> {
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.filePath;
    const previous = FILE_QUEUES.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    FILE_QUEUES.set(key, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(key) === tail) FILE_QUEUES.delete(key);
    }
  }
}

function validateState(state: WorkspaceAuthorityState): void {
  if (!state.workspace.workspaceKey) {
    throw new Error("Workspace key tidak boleh kosong.");
  }
  if (
    state.memberships.some(
      (membership) =>
        membership.workspaceKey !== state.workspace.workspaceKey,
    )
  ) {
    throw new Error("Scope membership workspace tidak cocok.");
  }
  const membershipIds = new Set<string>();
  const activePrincipals = new Set<string>();
  for (const membership of state.memberships) {
    if (membershipIds.has(membership.membershipId)) {
      throw new Error("Membership workspace duplikat.");
    }
    membershipIds.add(membership.membershipId);
    if (membership.revokedAt !== null) continue;
    const principal = `${membership.channel}\0${membership.principalKey}`;
    if (activePrincipals.has(principal)) {
      throw new Error("Principal aktif workspace duplikat.");
    }
    activePrincipals.add(principal);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
