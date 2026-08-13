import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitHubConnectionRepository,
  GitHubConnectionSaveResult,
  GitHubConnectionState,
  GitHubExactEffect,
  GitHubInstallationConnection,
  GitHubInstallationConnectionSaveResult,
  GitHubInstallationRepository,
  GitHubRepositoryArchiveReference,
  GitHubRepositorySelection,
  GitHubRepositorySelectionSaveResult,
  GitHubSelectionBindResult,
  GitHubUnknownEffectPage,
  GitHubUnknownEffectReference,
} from "../domain/github.js";
import { validateLocalGitObjectBundleReference } from "../domain/local-git.js";
import type {
  GitHubProjectProvisioningBinding,
} from "../domain/project-workspace.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";
import type { ProjectDeletionGitHubLifecycle } from "../domain/project-deletion.js";

const FILE_QUEUES = new Map<string, Promise<void>>();

interface GitHubConnectionDatabaseV1 {
  version: 1;
  connections: GitHubConnectionState[];
}

interface GitHubConnectionDatabase {
  version: 2;
  connections: GitHubConnectionState[];
  installations: GitHubInstallationConnection[];
  selections: GitHubRepositorySelection[];
}

/** Metadata/receipt adapter only. App keys and installation tokens are invalid. */
export class FileGitHubConnectionRepository
  implements GitHubConnectionRepository, GitHubInstallationRepository,
    ProjectDeletionGitHubLifecycle
{
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async loadByProject(projectId: string): Promise<GitHubConnectionState | null> {
    const cleanId = safeText(projectId, "projectId", 512);
    const state = (await this.readDatabase()).connections.find(
      (candidate) => candidate.binding.projectId === cleanId,
    );
    return state ? structuredClone(state) : null;
  }

  async listUnknownEffects(input: {
    cursor: string | null;
    limit: number;
  }): Promise<GitHubUnknownEffectPage> {
    assertExactKeys(input, ["cursor", "limit"], "unknown effect query");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Limit rekonsiliasi GitHub harus 1..100.");
    }
    const after = input.cursor === null ? null : decodeUnknownCursor(input.cursor);
    const references = (await this.readDatabase()).connections.flatMap((state) =>
      state.receipts
        .filter((receipt) => receipt.status === "unknown")
        .map((receipt): GitHubUnknownEffectReference => ({
          version: 1,
          ownerWorkspaceKey: state.binding.ownerWorkspaceKey,
          projectId: state.binding.projectId,
          effectId: receipt.effectId,
          effectDigest: receipt.effectDigest,
        }))
    ).sort((left, right) => compareUnknownReferences(left, right));
    const pending = after === null
      ? references
      : references.filter((reference) =>
          compareUnknownReferences(reference, after) > 0
        );
    const selected = pending.slice(0, input.limit).map((reference) =>
      structuredClone(reference)
    );
    return {
      references: selected,
      nextCursor: pending.length > selected.length && selected.length > 0
        ? encodeUnknownCursor(selected[selected.length - 1]!)
        : null,
    };
  }

  async isProjectSelectionBound(
    input: GitHubProjectProvisioningBinding,
  ): Promise<boolean> {
    const database = await this.readDatabase();
    const state = database.connections.find(
      (candidate) => candidate.binding.projectId === input.projectId,
    );
    const selection = database.selections.find(
      (candidate) => candidate.selectionId === input.selectionId,
    );
    const installation = database.installations.find(
      (candidate) => candidate.connectionId === input.installationConnectionId,
    );
    return Boolean(
      state &&
      selection &&
      installation &&
      state.binding.revokedAt === null &&
      state.binding.bindingId === input.bindingId &&
      state.binding.ownerWorkspaceKey === input.ownerWorkspaceKey &&
      state.binding.repositorySelectionId === input.selectionId &&
      state.binding.installationConnectionId === input.installationConnectionId &&
      state.binding.installationId === input.installationId &&
      state.binding.repositoryId === input.repositoryId &&
      selection.status === "bound" &&
      selection.projectId === input.projectId &&
      selection.bindingId === input.bindingId &&
      selection.ownerWorkspaceKey === input.ownerWorkspaceKey &&
      installation.status === "active" &&
      installation.ownerWorkspaceKey === input.ownerWorkspaceKey &&
      installation.installationId === input.installationId
    );
  }

  async create(
    state: GitHubConnectionState,
  ): Promise<GitHubConnectionSaveResult> {
    const record = structuredClone(state);
    validateState(record);
    if (record.binding.revision !== 1) {
      throw new Error("Revision awal GitHub binding harus 1.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (
        database.connections.some(
          (candidate) =>
            candidate.binding.projectId === record.binding.projectId ||
            candidate.binding.bindingId === record.binding.bindingId,
        )
      ) {
        return { status: "conflict" };
      }
      database.connections.push(record);
      await this.writeDatabase(database);
      return { status: "saved", state: structuredClone(record) };
    });
  }

  async save(
    state: Omit<GitHubConnectionState, "binding"> & {
      binding: Omit<GitHubConnectionState["binding"], "revision">;
    },
    expectedRevision: number,
  ): Promise<GitHubConnectionSaveResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Expected revision GitHub binding tidak sah.");
    }
    const record: GitHubConnectionState = {
      ...structuredClone(state),
      binding: {
        ...structuredClone(state.binding),
        revision: expectedRevision + 1,
      },
    };
    validateState(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.connections.findIndex(
        (candidate) =>
          candidate.binding.projectId === record.binding.projectId,
      );
      if (
        index < 0 ||
        database.connections[index]!.binding.revision !== expectedRevision
      ) {
        return { status: "conflict" };
      }
      validateAppendOnly(database.connections[index]!, record);
      database.connections[index] = record;
      await this.writeDatabase(database);
      return { status: "saved", state: structuredClone(record) };
    });
  }

  async remove(projectId: string, expectedRevision: number): Promise<boolean> {
    const cleanId = safeText(projectId, "projectId", 512);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.connections.findIndex(
        (candidate) => candidate.binding.projectId === cleanId,
      );
      if (
        index < 0 ||
        database.connections[index]!.binding.revision !== expectedRevision
      ) return false;
      database.connections.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async detachLocalProject(
    ownerWorkspaceKey: string,
    projectId: string,
    deletionId: string,
  ): Promise<"detached" | "missing" | "blocked_unknown"> {
    const owner = safeText(ownerWorkspaceKey, "ownerWorkspaceKey", 512);
    const cleanProjectId = safeText(projectId, "projectId", 512);
    safeText(deletionId, "deletionId", 512);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const state = database.connections.find(
        (candidate) => candidate.binding.projectId === cleanProjectId,
      );
      if (state && state.binding.ownerWorkspaceKey !== owner) {
        throw new Error("GitHub binding deletion berada di workspace lain.");
      }
      if (state?.receipts.some((receipt) => receipt.status === "unknown")) {
        return "blocked_unknown";
      }
      const selections = database.selections.filter(
        (candidate) => candidate.projectId === cleanProjectId,
      );
      if (!state && selections.length === 0) return "missing";
      if (selections.some((selection) => selection.ownerWorkspaceKey !== owner)) {
        throw new Error("GitHub selection deletion berada di workspace lain.");
      }
      // Project deletion purges repository-selection metadata locally. The
      // installation connection is retained because it may authorize other
      // projects; no remote repository or GitHub installation is deleted.
      for (const selection of selections) {
        database.selections.splice(database.selections.indexOf(selection), 1);
      }
      if (state) {
        database.connections.splice(database.connections.indexOf(state), 1);
      }
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return "detached";
    });
  }

  async loadInstallation(
    connectionId: string,
  ): Promise<GitHubInstallationConnection | null> {
    const cleanId = safeText(connectionId, "connectionId", 512);
    const connection = (await this.readDatabase()).installations.find(
      (candidate) => candidate.connectionId === cleanId,
    );
    return connection ? structuredClone(connection) : null;
  }

  async loadInstallationByConfirmation(
    confirmationId: string,
  ): Promise<GitHubInstallationConnection | null> {
    const cleanId = safeText(confirmationId, "confirmationId", 512);
    const connection = (await this.readDatabase()).installations.find(
      (candidate) => candidate.confirmationId === cleanId,
    );
    return connection ? structuredClone(connection) : null;
  }

  async listInstallationsByWorkspace(
    ownerWorkspaceKey: string,
  ): Promise<GitHubInstallationConnection[]> {
    const cleanKey = safeText(
      ownerWorkspaceKey,
      "ownerWorkspaceKey",
      512,
    );
    return (await this.readDatabase()).installations
      .filter((candidate) => candidate.ownerWorkspaceKey === cleanKey)
      .map((candidate) => structuredClone(candidate));
  }

  async createInstallation(
    connection: GitHubInstallationConnection,
  ): Promise<GitHubInstallationConnectionSaveResult> {
    const record = structuredClone(connection);
    validateInstallation(record);
    if (record.revision !== 1 || record.status !== "pending") {
      throw new Error("GitHub installation awal harus pending revision 1.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (
        database.installations.some((candidate) =>
          candidate.connectionId === record.connectionId ||
          candidate.sessionId === record.sessionId ||
          candidate.confirmationId === record.confirmationId
        ) || confirmationUsed(database, record.confirmationId)
      ) {
        return { status: "conflict" };
      }
      database.installations.push(record);
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return { status: "saved", connection: structuredClone(record) };
    });
  }

  async saveInstallation(
    connection: Omit<GitHubInstallationConnection, "revision">,
    expectedRevision: number,
  ): Promise<GitHubInstallationConnectionSaveResult> {
    positive(expectedRevision, "expected installation revision");
    const record: GitHubInstallationConnection = {
      ...structuredClone(connection),
      revision: expectedRevision + 1,
    };
    validateInstallation(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.installations.findIndex(
        (candidate) => candidate.connectionId === record.connectionId,
      );
      const current = database.installations[index];
      if (!current || current.revision !== expectedRevision) {
        return { status: "conflict" };
      }
      validateInstallationTransition(current, record);
      if (
        record.revocationAuthorityId !== null &&
        record.revocationAuthorityId !== current.revocationAuthorityId &&
        confirmationUsed(
          database,
          record.revocationAuthorityId,
          record.connectionId,
        )
      ) {
        return { status: "conflict" };
      }
      database.installations[index] = record;
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return { status: "saved", connection: structuredClone(record) };
    });
  }

  async loadSelection(
    selectionId: string,
  ): Promise<GitHubRepositorySelection | null> {
    const cleanId = safeText(selectionId, "selectionId", 512);
    const selection = (await this.readDatabase()).selections.find(
      (candidate) => candidate.selectionId === cleanId,
    );
    return selection ? structuredClone(selection) : null;
  }

  async loadSelectionByConfirmation(
    confirmationId: string,
  ): Promise<GitHubRepositorySelection | null> {
    const cleanId = safeText(confirmationId, "confirmationId", 512);
    const selection = (await this.readDatabase()).selections.find(
      (candidate) => candidate.confirmationId === cleanId,
    );
    return selection ? structuredClone(selection) : null;
  }

  async createSelection(
    selection: GitHubRepositorySelection,
  ): Promise<GitHubRepositorySelectionSaveResult> {
    const record = structuredClone(selection);
    validateSelection(record);
    if (record.revision !== 1 || record.status !== "selected") {
      throw new Error("GitHub repository selection awal harus selected revision 1.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (
        database.selections.some((candidate) =>
          candidate.selectionId === record.selectionId ||
          candidate.confirmationId === record.confirmationId
        ) || confirmationUsed(database, record.confirmationId)
      ) {
        return { status: "conflict" };
      }
      database.selections.push(record);
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return { status: "saved", selection: structuredClone(record) };
    });
  }

  async saveSelection(
    selection: Omit<GitHubRepositorySelection, "revision">,
    expectedRevision: number,
  ): Promise<GitHubRepositorySelectionSaveResult> {
    positive(expectedRevision, "expected selection revision");
    const record: GitHubRepositorySelection = {
      ...structuredClone(selection),
      revision: expectedRevision + 1,
    };
    validateSelection(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.selections.findIndex(
        (candidate) => candidate.selectionId === record.selectionId,
      );
      const current = database.selections[index];
      if (!current || current.revision !== expectedRevision) {
        return { status: "conflict" };
      }
      validateSelectionTransition(current, record);
      database.selections[index] = record;
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return { status: "saved", selection: structuredClone(record) };
    });
  }

  async bindSelection(
    state: GitHubConnectionState,
    selectionId: string,
    expectedSelectionRevision: number,
    updatedAt: string,
  ): Promise<GitHubSelectionBindResult> {
    const record = structuredClone(state);
    validateState(record);
    safeText(selectionId, "selectionId", 512);
    positive(expectedSelectionRevision, "expected selection revision");
    validIso(updatedAt, "selection bound updatedAt");
    if (
      record.binding.revision !== 1 ||
      record.approvals.length !== 0 ||
      record.receipts.length !== 0
    ) {
      throw new Error("Binding awal GitHub selection tidak sah.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.selections.findIndex(
        (candidate) => candidate.selectionId === selectionId,
      );
      const selection = database.selections[index];
      if (
        !selection ||
        selection.revision !== expectedSelectionRevision ||
        selection.status !== "project_created" ||
        Date.parse(updatedAt) >= Date.parse(selection.expiresAt) ||
        (selection.archive !== null &&
          Date.parse(updatedAt) >= Date.parse(selection.archive.expiresAt))
      ) {
        return { status: "conflict" };
      }
      const installation = database.installations.find(
        (candidate) =>
          candidate.connectionId === selection.installationConnectionId,
      );
      if (
        !installation ||
        installation.status !== "active" ||
        installation.installationId !== selection.installationId ||
        record.binding.projectId !== selection.projectId ||
        record.binding.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
        record.binding.installationConnectionId !==
          selection.installationConnectionId ||
        record.binding.repositorySelectionId !== selection.selectionId ||
        record.binding.installationId !== selection.installationId ||
        record.binding.repositoryId !== selection.repositoryId ||
        record.binding.repositoryFullName !== selection.repositoryFullName ||
        record.binding.visibility !== selection.visibility ||
        record.binding.defaultBranch !== selection.defaultBranch ||
        record.binding.revokedAt !== null ||
        database.connections.some((candidate) =>
          candidate.binding.projectId === record.binding.projectId ||
          candidate.binding.bindingId === record.binding.bindingId ||
          candidate.binding.repositorySelectionId === selection.selectionId
        )
      ) {
        return { status: "conflict" };
      }
      const nextSelection: GitHubRepositorySelection = {
        ...selection,
        status: "bound",
        bindingId: record.binding.bindingId,
        revision: selection.revision + 1,
        updatedAt,
      };
      validateSelection(nextSelection);
      validateSelectionTransition(selection, nextSelection);
      database.connections.push(record);
      database.selections[index] = nextSelection;
      validateDatabaseCrossReferences(database);
      await this.writeDatabase(database);
      return {
        status: "saved",
        selection: structuredClone(nextSelection),
        state: structuredClone(record),
      };
    });
  }

  private async readDatabase(): Promise<GitHubConnectionDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as
        | Partial<GitHubConnectionDatabaseV1>
        | Partial<GitHubConnectionDatabase>;
      rejectCredentialKeys(parsed);
      if (parsed.version === 1) {
        assertExactKeys(parsed, ["version", "connections"], "database v1");
        if (!Array.isArray(parsed.connections)) {
          throw new Error("Format basis data GitHub connection tidak dikenali.");
        }
        const migrated = parsed.connections.map(migrateLegacyConnectionState);
        const database: GitHubConnectionDatabase = {
          version: 2,
          connections: structuredClone(migrated),
          installations: [],
          selections: [],
        };
        validateDatabaseCrossReferences(database);
        return database;
      }
      assertExactKeys(
        parsed,
        ["version", "connections", "installations", "selections"],
        "database v2",
      );
      if (
        parsed.version !== 2 ||
        !Array.isArray(parsed.connections) ||
        !Array.isArray(parsed.installations) ||
        !Array.isArray(parsed.selections)
      ) {
        throw new Error("Format basis data GitHub connection tidak dikenali.");
      }
      for (const connection of parsed.connections) validateState(connection);
      for (const installation of parsed.installations) {
        validateInstallation(installation);
      }
      for (const selection of parsed.selections) validateSelection(selection);
      const database: GitHubConnectionDatabase = {
        version: 2,
        connections: structuredClone(parsed.connections),
        installations: structuredClone(parsed.installations),
        selections: structuredClone(parsed.selections),
      };
      validateDatabaseCrossReferences(database);
      return database;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          version: 2,
          connections: [],
          installations: [],
          selections: [],
        };
      }
      throw error;
    }
  }

  private async writeDatabase(database: GitHubConnectionDatabase): Promise<void> {
    validateDatabaseCrossReferences(database);
    rejectCredentialKeys(database);
    const payload = `${JSON.stringify(database, null, 2)}\n`;
    await writeDurableFileAtomic(this.filePath, payload);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) {
        FILE_QUEUES.delete(this.filePath);
      }
    }
  }
}

function migrateLegacyConnectionState(value: unknown): GitHubConnectionState {
  assertExactKeys(value, ["version", "binding", "approvals", "receipts"], "legacy state");
  const state = value as Omit<GitHubConnectionState, "binding"> & {
    binding: Omit<
      GitHubConnectionState["binding"],
      "installationConnectionId" | "repositorySelectionId"
    >;
  };
  assertExactKeys(state.binding, [
    "bindingId", "projectId", "ownerWorkspaceKey", "installationId",
    "repositoryId", "repositoryFullName", "visibility", "defaultBranch",
    "revision", "createdAt", "updatedAt", "revokedAt",
  ], "legacy binding");
  const migratedReceipts = structuredClone(state.receipts).map((receipt) => {
    const effect = receipt.effect as unknown as Record<string, unknown>;
    if (
      !("installationConnectionId" in effect) &&
      !("repositoryBindingId" in effect)
    ) {
      return {
        ...receipt,
        effect: {
          ...effect,
          installationConnectionId: null,
          repositoryBindingId: null,
        } as unknown as GitHubExactEffect,
      };
    }
    return receipt;
  });
  const migrated: GitHubConnectionState = {
    ...structuredClone(state),
    binding: {
      ...structuredClone(state.binding),
      installationConnectionId: null,
      repositorySelectionId: null,
    },
    receipts: migratedReceipts,
  };
  validateState(migrated);
  return migrated;
}

function validateInstallation(
  value: unknown,
): asserts value is GitHubInstallationConnection {
  rejectCredentialKeys(value);
  assertExactKeys(value, [
    "version", "connectionId", "ownerWorkspaceKey", "sessionId",
    "confirmationId", "requestedByMembershipId", "requestedAclEpoch",
    "status", "installationId", "revocationAuthorityId", "revision",
    "createdAt", "expiresAt", "activatedAt", "revokedAt", "updatedAt",
  ], "installation");
  const connection = value as GitHubInstallationConnection;
  if (connection.version !== 1) {
    throw new Error("Versi GitHub installation tidak sah.");
  }
  safeText(connection.connectionId, "connectionId", 512);
  safeText(connection.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
  safeText(connection.sessionId, "sessionId", 512);
  safeText(connection.confirmationId, "confirmationId", 512);
  safeText(
    connection.requestedByMembershipId,
    "requestedByMembershipId",
    512,
  );
  positive(connection.requestedAclEpoch, "requestedAclEpoch");
  positive(connection.revision, "installation revision");
  validIso(connection.createdAt, "installation.createdAt");
  validIso(connection.expiresAt, "installation.expiresAt");
  validIso(connection.updatedAt, "installation.updatedAt");
  if (Date.parse(connection.expiresAt) <= Date.parse(connection.createdAt)) {
    throw new Error("Expiry GitHub installation tidak sah.");
  }
  if (Date.parse(connection.updatedAt) < Date.parse(connection.createdAt)) {
    throw new Error("updatedAt GitHub installation mendahului create.");
  }
  if (connection.installationId !== null) {
    safeText(connection.installationId, "installationId", 128);
  }
  if (connection.revocationAuthorityId !== null) {
    safeText(
      connection.revocationAuthorityId,
      "revocationAuthorityId",
      512,
    );
  }
  if (connection.activatedAt !== null) {
    validIso(connection.activatedAt, "installation.activatedAt");
  }
  if (connection.revokedAt !== null) {
    validIso(connection.revokedAt, "installation.revokedAt");
  }
  const commonPending =
    connection.installationId === null &&
    connection.activatedAt === null &&
    connection.revokedAt === null &&
    connection.revocationAuthorityId === null;
  if (
    (connection.status === "pending" || connection.status === "expired") &&
    !commonPending
  ) {
    throw new Error("State pending/expired GitHub installation tidak konsisten.");
  }
  if (
    connection.status === "active" &&
    (connection.installationId === null ||
      connection.activatedAt === null ||
      connection.revokedAt !== null ||
      connection.revocationAuthorityId !== null)
  ) {
    throw new Error("State active GitHub installation tidak konsisten.");
  }
  if (
    connection.status === "revoked" &&
    (connection.revokedAt === null ||
      connection.revocationAuthorityId === null)
  ) {
    throw new Error("State revoked GitHub installation tidak konsisten.");
  }
  if (
    connection.status !== "pending" &&
    connection.status !== "active" &&
    connection.status !== "expired" &&
    connection.status !== "revoked"
  ) {
    throw new Error("Status GitHub installation tidak sah.");
  }
}

function validateInstallationTransition(
  current: GitHubInstallationConnection,
  next: GitHubInstallationConnection,
): void {
  const immutableCurrent = {
    ...current,
    status: "pending",
    installationId: null,
    revocationAuthorityId: null,
    revision: 0,
    activatedAt: null,
    revokedAt: null,
    updatedAt: "",
  };
  const immutableNext = {
    ...next,
    status: "pending",
    installationId: null,
    revocationAuthorityId: null,
    revision: 0,
    activatedAt: null,
    revokedAt: null,
    updatedAt: "",
  };
  if (!sameValue(immutableCurrent, immutableNext)) {
    throw new Error("Field immutable GitHub installation berubah.");
  }
  const allowed =
    (current.status === "pending" &&
      ["pending", "active", "expired", "revoked"].includes(next.status)) ||
    (current.status === "active" &&
      ["active", "revoked"].includes(next.status)) ||
    (current.status === "expired" && next.status === "expired") ||
    (current.status === "revoked" && next.status === "revoked");
  if (!allowed || Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("Transisi GitHub installation tidak sah.");
  }
  if (
    current.installationId !== null &&
    next.installationId !== current.installationId
  ) {
    throw new Error("Installation id GitHub tidak boleh berubah.");
  }
  if (
    current.revocationAuthorityId !== null &&
    next.revocationAuthorityId !== current.revocationAuthorityId
  ) {
    throw new Error("Confirmation revoke GitHub tidak boleh berubah.");
  }
  if (
    current.activatedAt !== null &&
    next.activatedAt !== current.activatedAt
  ) {
    throw new Error("Waktu aktivasi GitHub installation tidak boleh berubah.");
  }
  if (
    current.status === "pending" &&
    next.status === "revoked" &&
    (next.installationId !== null || next.activatedAt !== null)
  ) {
    throw new Error("Revoke session pending tidak boleh mengarang installation aktif.");
  }
}

function validateSelection(
  value: unknown,
): asserts value is GitHubRepositorySelection {
  rejectCredentialKeys(value);
  assertExactKeys(value, [
    "version", "selectionId", "confirmationId", "ownerWorkspaceKey",
    "installationConnectionId", "installationId", "repositoryId",
    "repositoryFullName", "visibility", "defaultBranch", "baseCommit",
    "selectedByMembershipId", "selectedAclEpoch", "status", "archive",
    "projectId", "bindingId", "revision", "selectedAt", "expiresAt",
    "updatedAt",
  ], "repository selection");
  const selection = value as GitHubRepositorySelection;
  if (selection.version !== 1) {
    throw new Error("Versi GitHub repository selection tidak sah.");
  }
  safeText(selection.selectionId, "selectionId", 512);
  safeText(selection.confirmationId, "confirmationId", 512);
  safeText(selection.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
  safeText(
    selection.installationConnectionId,
    "installationConnectionId",
    512,
  );
  safeText(selection.installationId, "installationId", 128);
  safeText(selection.repositoryId, "repositoryId", 128);
  repositoryFullName(selection.repositoryFullName);
  visibility(selection.visibility);
  validBranch(selection.defaultBranch);
  gitCommit(selection.baseCommit, "selection baseCommit");
  safeText(
    selection.selectedByMembershipId,
    "selectedByMembershipId",
    512,
  );
  positive(selection.selectedAclEpoch, "selectedAclEpoch");
  positive(selection.revision, "selection revision");
  validIso(selection.selectedAt, "selection.selectedAt");
  validIso(selection.expiresAt, "selection.expiresAt");
  validIso(selection.updatedAt, "selection.updatedAt");
  if (Date.parse(selection.expiresAt) <= Date.parse(selection.selectedAt)) {
    throw new Error("Expiry GitHub repository selection tidak sah.");
  }
  if (selection.archive !== null) {
    validateArchiveReference(selection.archive);
    if (
      selection.archive.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
      selection.archive.operationId !== selection.selectionId ||
      selection.archive.installationId !== selection.installationId ||
      selection.archive.repositoryId !== selection.repositoryId ||
      selection.archive.repositoryFullName !== selection.repositoryFullName ||
      selection.archive.defaultBranch !== selection.defaultBranch ||
      selection.archive.commit !== selection.baseCommit ||
      Date.parse(selection.archive.expiresAt) < Date.parse(selection.expiresAt)
    ) {
      throw new Error("Archive GitHub tidak cocok repository selection.");
    }
  }
  if (selection.projectId !== null) {
    safeText(selection.projectId, "selection projectId", 512);
  }
  if (selection.bindingId !== null) {
    safeText(selection.bindingId, "selection bindingId", 512);
  }
  const coherent =
    (selection.status === "selected" &&
      selection.archive === null &&
      selection.projectId === null &&
      selection.bindingId === null) ||
    (selection.status === "archive_ready" &&
      selection.archive !== null &&
      selection.projectId === null &&
      selection.bindingId === null) ||
    (selection.status === "project_created" &&
      selection.archive !== null &&
      selection.projectId !== null &&
      selection.bindingId === null) ||
    (selection.status === "bound" &&
      selection.archive !== null &&
      selection.projectId !== null &&
      selection.bindingId !== null) ||
    selection.status === "cleanup_required" ||
    selection.status === "cancelled";
  if (!coherent) {
    throw new Error("State GitHub repository selection tidak konsisten.");
  }
}

function validateSelectionTransition(
  current: GitHubRepositorySelection,
  next: GitHubRepositorySelection,
): void {
  const immutableCurrent = {
    ...current,
    status: "selected",
    archive: null,
    projectId: null,
    bindingId: null,
    revision: 0,
    updatedAt: "",
  };
  const immutableNext = {
    ...next,
    status: "selected",
    archive: null,
    projectId: null,
    bindingId: null,
    revision: 0,
    updatedAt: "",
  };
  if (!sameValue(immutableCurrent, immutableNext)) {
    throw new Error("Field immutable GitHub repository selection berubah.");
  }
  const transitions: Record<GitHubRepositorySelection["status"], readonly string[]> = {
    selected: ["selected", "archive_ready", "cleanup_required", "cancelled"],
    archive_ready: [
      "archive_ready", "project_created", "cleanup_required", "cancelled",
    ],
    project_created: ["project_created", "bound", "cleanup_required", "cancelled"],
    bound: ["bound", "cancelled"],
    cleanup_required: ["cleanup_required", "cancelled"],
    cancelled: ["cancelled"],
  };
  if (
    !transitions[current.status].includes(next.status) ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new Error("Transisi GitHub repository selection tidak sah.");
  }
  if (
    current.archive !== null &&
    !sameValue(current.archive, next.archive)
  ) {
    throw new Error("Archive GitHub selection tidak boleh berubah.");
  }
  if (current.projectId !== null && current.projectId !== next.projectId) {
    throw new Error("Project GitHub selection tidak boleh berubah.");
  }
  if (current.bindingId !== null && current.bindingId !== next.bindingId) {
    throw new Error("Binding GitHub selection tidak boleh berubah.");
  }
  if (
    current.archive === null &&
    next.archive !== null &&
    next.status !== "archive_ready"
  ) {
    throw new Error("Archive selection hanya boleh ditambahkan saat archive_ready.");
  }
  if (
    current.projectId === null &&
    next.projectId !== null &&
    next.status !== "project_created" &&
    next.status !== "cleanup_required"
  ) {
    throw new Error("Project selection hanya boleh ditambahkan saat project_created.");
  }
  if (
    current.bindingId === null &&
    next.bindingId !== null &&
    next.status !== "bound"
  ) {
    throw new Error("Binding selection hanya boleh ditambahkan saat bound.");
  }
}

function validateArchiveReference(value: unknown): void {
  assertExactKeys(value, [
    "version", "operationId", "archiveId", "ownerWorkspaceKey", "installationId",
    "repositoryId", "repositoryFullName", "defaultBranch", "commit",
    "mediaType", "sha256", "size", "createdAt", "expiresAt",
  ], "repository archive");
  const reference = value as GitHubRepositoryArchiveReference;
  if (reference.version !== 1 || reference.mediaType !== "application/zip") {
    throw new Error("Versi/media archive GitHub tidak sah.");
  }
  safeText(reference.operationId, "archive operationId", 512);
  safeText(reference.archiveId, "archiveId", 512);
  safeText(reference.ownerWorkspaceKey, "archive ownerWorkspaceKey", 512);
  safeText(reference.installationId, "archive installationId", 128);
  safeText(reference.repositoryId, "archive repositoryId", 128);
  repositoryFullName(reference.repositoryFullName);
  validBranch(reference.defaultBranch);
  gitCommit(reference.commit, "archive commit");
  digest(reference.sha256);
  positive(reference.size, "archive size");
  validIso(reference.createdAt, "archive.createdAt");
  validIso(reference.expiresAt, "archive.expiresAt");
  if (Date.parse(reference.expiresAt) <= Date.parse(reference.createdAt)) {
    throw new Error("Expiry archive GitHub tidak sah.");
  }
}

function validateDatabaseCrossReferences(
  database: GitHubConnectionDatabase,
): void {
  const connectionIds = new Set<string>();
  const sessionIds = new Set<string>();
  const confirmationIds = new Set<string>();
  const activeInstallationIds = new Set<string>();
  for (const connection of database.installations) {
    validateInstallation(connection);
    if (
      connectionIds.has(connection.connectionId) ||
      sessionIds.has(connection.sessionId) ||
      confirmationIds.has(connection.confirmationId)
    ) {
      throw new Error("GitHub installation id/confirmation duplikat.");
    }
    connectionIds.add(connection.connectionId);
    sessionIds.add(connection.sessionId);
    confirmationIds.add(connection.confirmationId);
    if (connection.revocationAuthorityId !== null) {
      if (confirmationIds.has(connection.revocationAuthorityId)) {
        throw new Error("GitHub confirmation dipakai lebih dari sekali.");
      }
      confirmationIds.add(connection.revocationAuthorityId);
    }
    if (connection.status === "active") {
      const key = connection.installationId!;
      if (activeInstallationIds.has(key)) {
        throw new Error("GitHub installation aktif terikat ganda.");
      }
      activeInstallationIds.add(key);
    }
  }
  const selectionIds = new Set<string>();
  for (const selection of database.selections) {
    validateSelection(selection);
    if (
      selectionIds.has(selection.selectionId) ||
      confirmationIds.has(selection.confirmationId)
    ) {
      throw new Error("GitHub repository selection/confirmation duplikat.");
    }
    selectionIds.add(selection.selectionId);
    confirmationIds.add(selection.confirmationId);
    const connection = database.installations.find(
      (candidate) =>
        candidate.connectionId === selection.installationConnectionId,
    );
    if (
      !connection ||
      connection.ownerWorkspaceKey !== selection.ownerWorkspaceKey ||
      connection.installationId !== selection.installationId
    ) {
      throw new Error("GitHub repository selection kehilangan installation authority.");
    }
  }
  const boundSelections = new Set<string>();
  for (const state of database.connections) {
    validateState(state);
    for (const approval of state.approvals) {
      if (confirmationIds.has(approval.confirmationId)) {
        throw new Error("GitHub confirmation dipakai lebih dari sekali secara global.");
      }
      confirmationIds.add(approval.confirmationId);
    }
    const binding = state.binding;
    if (binding.repositorySelectionId === null) continue;
    if (boundSelections.has(binding.repositorySelectionId)) {
      throw new Error("GitHub repository selection terikat lebih dari sekali.");
    }
    const selection = database.selections.find(
      (candidate) => candidate.selectionId === binding.repositorySelectionId,
    );
    if (
      !selection ||
      (binding.revokedAt === null
        ? selection.status !== "bound"
        : selection.status !== "bound" && selection.status !== "cancelled") ||
      selection.bindingId !== binding.bindingId ||
      selection.projectId !== binding.projectId ||
      selection.ownerWorkspaceKey !== binding.ownerWorkspaceKey ||
      selection.installationConnectionId !== binding.installationConnectionId ||
      selection.installationId !== binding.installationId ||
      selection.repositoryId !== binding.repositoryId ||
      selection.repositoryFullName !== binding.repositoryFullName ||
      selection.visibility !== binding.visibility ||
      selection.defaultBranch !== binding.defaultBranch
    ) {
      throw new Error("GitHub repository binding kehilangan exact selection authority.");
    }
    boundSelections.add(binding.repositorySelectionId);
  }
}

function confirmationUsed(
  database: GitHubConnectionDatabase,
  confirmationId: string,
  excludingConnectionId?: string,
): boolean {
  return database.installations.some((candidate) =>
    candidate.connectionId !== excludingConnectionId &&
    (candidate.confirmationId === confirmationId ||
      candidate.revocationAuthorityId === confirmationId)
  ) || database.selections.some(
    (candidate) => candidate.confirmationId === confirmationId,
  ) || database.connections.some((state) =>
    state.approvals.some((approval) => approval.confirmationId === confirmationId)
  );
}

function repositoryFullName(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    throw new Error("Nama penuh repository GitHub tidak sah.");
  }
}

function visibility(value: unknown): void {
  if (value !== "public" && value !== "private" && value !== "internal") {
    throw new Error("Visibility repository GitHub tidak sah.");
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

function validateState(value: unknown): asserts value is GitHubConnectionState {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub connection state tidak sah.");
  }
  rejectCredentialKeys(value);
  assertExactKeys(value, ["version", "binding", "approvals", "receipts"], "state");
  const state = value as GitHubConnectionState;
  if (state.version !== 1 || !state.binding) {
    throw new Error("Versi GitHub connection tidak sah.");
  }
  const binding = state.binding;
  assertExactKeys(binding, [
    "bindingId", "projectId", "ownerWorkspaceKey", "installationId",
    "installationConnectionId", "repositorySelectionId", "repositoryId",
    "repositoryFullName", "visibility", "defaultBranch", "revision",
    "createdAt", "updatedAt", "revokedAt",
  ], "binding");
  safeText(binding.bindingId, "bindingId", 512);
  safeText(binding.projectId, "projectId", 512);
  safeText(binding.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
  if (binding.installationConnectionId !== null) {
    safeText(binding.installationConnectionId, "installationConnectionId", 512);
  }
  if (binding.repositorySelectionId !== null) {
    safeText(binding.repositorySelectionId, "repositorySelectionId", 512);
  }
  if (
    (binding.installationConnectionId === null) !==
      (binding.repositorySelectionId === null)
  ) {
    throw new Error("Authority provisioning GitHub binding harus lengkap atau legacy.");
  }
  safeText(binding.installationId, "installationId", 128);
  safeText(binding.repositoryId, "repositoryId", 128);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(binding.repositoryFullName)) {
    throw new Error("Nama penuh repository GitHub tidak sah.");
  }
  if (
    binding.visibility !== "public" &&
    binding.visibility !== "private" &&
    binding.visibility !== "internal"
  ) {
    throw new Error("Visibility repository GitHub tidak sah.");
  }
  validBranch(binding.defaultBranch);
  positive(binding.revision, "binding revision");
  validIso(binding.createdAt, "binding.createdAt");
  validIso(binding.updatedAt, "binding.updatedAt");
  if (binding.revokedAt !== null) validIso(binding.revokedAt, "binding.revokedAt");
  if (!Array.isArray(state.approvals) || !Array.isArray(state.receipts)) {
    throw new Error("Ledger GitHub connection tidak sah.");
  }
  const approvalIds = new Set<string>();
  const confirmationIds = new Set<string>();
  for (const approval of state.approvals) {
    assertExactKeys(approval, [
      "approvalId", "confirmationId", "effectDigest", "capability",
      "approvedByMembershipId", "approvedAclEpoch", "approvedAt",
      "expiresAt", "consumedAt",
    ], "approval");
    safeText(approval.approvalId, "approvalId", 512);
    safeText(approval.confirmationId, "confirmationId", 512);
    digest(approval.effectDigest);
    capability(approval.capability);
    safeText(approval.approvedByMembershipId, "membershipId", 512);
    positive(approval.approvedAclEpoch, "approval aclEpoch");
    validIso(approval.approvedAt, "approval.approvedAt");
    validIso(approval.expiresAt, "approval.expiresAt");
    if (approval.consumedAt !== null) validIso(approval.consumedAt, "approval.consumedAt");
    if (approvalIds.has(approval.approvalId)) throw new Error("Approval GitHub duplikat.");
    if (confirmationIds.has(approval.confirmationId)) {
      throw new Error("Confirmation GitHub dipakai lebih dari sekali.");
    }
    approvalIds.add(approval.approvalId);
    confirmationIds.add(approval.confirmationId);
  }
  const receiptEffects = new Set<string>();
  for (const receipt of state.receipts) {
    assertExactKeys(receipt, [
      "receiptId", "effectId", "effectDigest", "capability", "branch",
      "commit", "baseCommit", "workspaceRevision", "status", "effect",
      "externalId", "url", "committedAt",
    ], "receipt");
    safeText(receipt.receiptId, "receiptId", 512);
    safeText(receipt.effectId, "effectId", 512);
    digest(receipt.effectDigest);
    capability(receipt.capability);
    validBranch(receipt.branch);
    gitCommit(receipt.commit, "receipt commit");
    gitCommit(receipt.baseCommit, "receipt baseCommit");
    positive(receipt.workspaceRevision, "receipt workspaceRevision");
    if (
      receipt.status !== "committed" &&
      receipt.status !== "unknown" &&
      receipt.status !== "not_committed"
    ) {
      throw new Error("Status receipt GitHub tidak sah.");
    }
    validateStoredEffect(receipt.effect);
    if (
      receipt.effect.effectId !== receipt.effectId ||
      receipt.effect.capability !== receipt.capability ||
      receipt.effect.branch !== receipt.branch ||
      receipt.effect.commit !== receipt.commit ||
      receipt.effect.baseCommit !== receipt.baseCommit ||
      receipt.effect.workspaceRevision !== receipt.workspaceRevision ||
      receipt.effect.projectId !== state.binding.projectId ||
      receipt.effect.ownerWorkspaceKey !== state.binding.ownerWorkspaceKey ||
      receipt.effect.installationConnectionId !==
        state.binding.installationConnectionId ||
      (state.binding.installationConnectionId === null
        ? receipt.effect.repositoryBindingId !== null
        : receipt.effect.repositoryBindingId !== state.binding.bindingId) ||
      receipt.effect.installationId !== state.binding.installationId ||
      receipt.effect.repositoryId !== state.binding.repositoryId
    ) {
      throw new Error("Canonical effect receipt GitHub tidak cocok.");
    }
    if (receipt.externalId !== null) safeText(receipt.externalId, "externalId", 512);
    if (receipt.url !== null && !/^https:\/\/github\.com\//u.test(receipt.url)) {
      throw new Error("URL receipt GitHub tidak sah.");
    }
    if (
      receipt.status !== "committed" &&
      (receipt.externalId !== null || receipt.url !== null)
    ) {
      throw new Error("Receipt GitHub non-committed tidak boleh membawa metadata eksternal.");
    }
    validIso(receipt.committedAt, "receipt.committedAt");
    if (receiptEffects.has(receipt.effectId)) throw new Error("Effect receipt GitHub duplikat.");
    receiptEffects.add(receipt.effectId);
  }
}

function validateAppendOnly(
  current: GitHubConnectionState,
  next: GitHubConnectionState,
): void {
  if (
    current.binding.bindingId !== next.binding.bindingId ||
    current.binding.projectId !== next.binding.projectId ||
    current.binding.ownerWorkspaceKey !== next.binding.ownerWorkspaceKey ||
    current.binding.installationConnectionId !==
      next.binding.installationConnectionId ||
    current.binding.repositorySelectionId !==
      next.binding.repositorySelectionId ||
    current.binding.installationId !== next.binding.installationId ||
    current.binding.repositoryId !== next.binding.repositoryId ||
    current.binding.createdAt !== next.binding.createdAt ||
    current.binding.repositoryFullName !== next.binding.repositoryFullName ||
    current.binding.visibility !== next.binding.visibility ||
    current.binding.defaultBranch !== next.binding.defaultBranch ||
    (current.binding.revokedAt !== next.binding.revokedAt &&
      !(current.binding.revokedAt === null && next.binding.revokedAt !== null)) ||
    next.approvals.length < current.approvals.length ||
    next.receipts.length < current.receipts.length
  ) {
    throw new Error("Field immutable/append-only GitHub connection berubah.");
  }
  for (let index = 0; index < current.approvals.length; index += 1) {
    const before = current.approvals[index]!;
    const after = next.approvals[index]!;
    const beforeBase = { ...before, consumedAt: null };
    const afterBase = { ...after, consumedAt: null };
    if (
      JSON.stringify(beforeBase) !== JSON.stringify(afterBase) ||
      (before.consumedAt !== null && after.consumedAt !== before.consumedAt) ||
      (before.consumedAt === null && after.consumedAt !== null &&
        Date.parse(after.consumedAt) < Date.parse(before.approvedAt))
    ) {
      throw new Error("Approval GitHub lama berubah di luar transisi consume.");
    }
  }
  for (let index = 0; index < current.receipts.length; index += 1) {
    const before = current.receipts[index]!;
    const after = next.receipts[index]!;
    const immutableBefore = {
      ...before,
      status: "unknown",
      externalId: null,
      url: null,
      committedAt: "",
    };
    const immutableAfter = {
      ...after,
      status: "unknown",
      externalId: null,
      url: null,
      committedAt: "",
    };
    const exactBefore = JSON.stringify(before);
    const exactAfter = JSON.stringify(after);
    const unknownToTerminal = before.status === "unknown" &&
      (after.status === "committed" || after.status === "not_committed");
    if (
      (before.status === "unknown" && after.status === "unknown" &&
        exactBefore !== exactAfter) ||
      (unknownToTerminal &&
        JSON.stringify(immutableBefore) !== JSON.stringify(immutableAfter)) ||
      (!unknownToTerminal && before.status !== "unknown" &&
        exactBefore !== exactAfter) ||
      (before.status === "unknown" && after.status !== "unknown" &&
        !unknownToTerminal)
    ) {
      throw new Error("Receipt GitHub lama berubah di luar rekonsiliasi unknown.");
    }
  }
}

function validateStoredEffect(effect: GitHubExactEffect): void {
  const expected = [
    "effectId", "attempt", "capability", "projectId", "runId",
    "ownerWorkspaceKey", "installationConnectionId", "repositoryBindingId",
    "installationId", "repositoryId",
    "workspaceRevision", "instructionRevision", "branch", "commit",
    "baseCommit", "expectedTargetHead", "baseBranch", "title", "body",
    "draft", "objectBundle",
  ].sort();
  if (
    !effect ||
    typeof effect !== "object" ||
    JSON.stringify(Object.keys(effect).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error("Canonical effect GitHub tidak sah.");
  }
  safeText(effect.effectId, "effect.effectId", 512);
  positive(effect.attempt, "effect.attempt");
  capability(effect.capability);
  safeText(effect.projectId, "effect.projectId", 512);
  safeText(effect.runId, "effect.runId", 512);
  safeText(effect.ownerWorkspaceKey, "effect.ownerWorkspaceKey", 512);
  if (
    (effect.installationConnectionId === null) !==
      (effect.repositoryBindingId === null)
  ) {
    throw new Error("Authority provisioning canonical effect harus lengkap atau legacy.");
  }
  if (effect.installationConnectionId !== null) {
    safeText(
      effect.installationConnectionId,
      "effect.installationConnectionId",
      512,
    );
    safeText(effect.repositoryBindingId, "effect.repositoryBindingId", 512);
  }
  safeText(effect.installationId, "effect.installationId", 128);
  safeText(effect.repositoryId, "effect.repositoryId", 128);
  positive(effect.workspaceRevision, "effect.workspaceRevision");
  positive(effect.instructionRevision, "effect.instructionRevision", true);
  validBranch(effect.branch);
  validBranch(effect.baseBranch);
  gitCommit(effect.commit, "effect.commit");
  gitCommit(effect.baseCommit, "effect.baseCommit");
  if (effect.expectedTargetHead !== null) {
    gitCommit(effect.expectedTargetHead, "effect.expectedTargetHead");
  }
  if (effect.capability === "github.pr.create") {
    if (effect.draft !== true || typeof effect.title !== "string" || !effect.title) {
      throw new Error("Canonical draft PR effect GitHub tidak sah.");
    }
  } else if (effect.title !== null || effect.body !== null || effect.draft !== null) {
    throw new Error("Canonical non-PR effect GitHub memuat metadata PR.");
  }
  const pushesObjects =
    effect.capability === "github.push_branch" ||
    effect.capability === "github.workflow.write";
  if (pushesObjects) {
    if (effect.objectBundle === null) {
      throw new Error("Canonical push effect GitHub tidak mempunyai object bundle.");
    }
    const bundle = validateLocalGitObjectBundleReference(effect.objectBundle);
    if (
      bundle.commit !== effect.commit ||
      bundle.parentCommit !== effect.expectedTargetHead
    ) throw new Error("Canonical object bundle GitHub tidak mengikat commit/target parent.");
  } else if (effect.objectBundle !== null) {
    throw new Error("Canonical non-push effect GitHub memuat object bundle.");
  }
  const expectedTarget = effect.capability === "github.branch.create"
    ? null
    : pushesObjects
      ? effect.objectBundle!.parentCommit
      : effect.commit;
  if (effect.expectedTargetHead !== expectedTarget) {
    throw new Error("Canonical target head GitHub tidak cocok capability.");
  }
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    throw new Error(`Schema metadata GitHub ${label} memuat field asing atau hilang.`);
  }
}

function rejectCredentialKeys(value: unknown): void {
  if (typeof value === "string") {
    if (containsSecretLikeValue(value)) {
      throw new Error("Credential-like value tidak boleh masuk metadata GitHub Harvy.");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentialKeys(item);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:private.?key|client.?secret|access.?token|installation.?token|pat|credential)/iu.test(key)) {
      throw new Error("Credential tidak boleh masuk metadata GitHub Harvy.");
    }
    rejectCredentialKeys(nested);
  }
}

function capability(value: unknown): void {
  if (
    value !== "github.branch.create" &&
    value !== "github.push_branch" &&
    value !== "github.workflow.write" &&
    value !== "github.pr.create"
  ) throw new Error("Capability GitHub tidak sah.");
}

function validBranch(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[~^:?*[\\\p{Cc}\s]/u.test(value)
  ) throw new Error("Branch GitHub tidak sah.");
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Digest GitHub effect tidak sah.");
  }
}

function gitCommit(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
  ) throw new Error(`${field} GitHub tidak sah.`);
}

function compareUnknownReferences(
  left: Pick<GitHubUnknownEffectReference, "ownerWorkspaceKey" | "projectId" | "effectId">,
  right: Pick<GitHubUnknownEffectReference, "ownerWorkspaceKey" | "projectId" | "effectId">,
): number {
  const leftKey = JSON.stringify([
    left.ownerWorkspaceKey,
    left.projectId,
    left.effectId,
  ]);
  const rightKey = JSON.stringify([
    right.ownerWorkspaceKey,
    right.projectId,
    right.effectId,
  ]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function encodeUnknownCursor(reference: GitHubUnknownEffectReference): string {
  return Buffer.from(JSON.stringify([
    1,
    reference.ownerWorkspaceKey,
    reference.projectId,
    reference.effectId,
  ]), "utf8").toString("base64url");
}

function decodeUnknownCursor(cursor: string): GitHubUnknownEffectReference {
  if (
    cursor.length < 1 ||
    cursor.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw new Error("Cursor rekonsiliasi GitHub tidak sah.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new Error("non-canonical cursor");
    }
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Cursor rekonsiliasi GitHub tidak sah.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== 1
  ) {
    throw new Error("Cursor rekonsiliasi GitHub tidak sah.");
  }
  return {
    version: 1,
    ownerWorkspaceKey: safeText(parsed[1], "cursor ownerWorkspaceKey", 512),
    projectId: safeText(parsed[2], "cursor projectId", 512),
    effectId: safeText(parsed[3], "cursor effectId", 512),
    // Cursor ordering does not use the digest; a valid placeholder keeps the
    // comparator type closed without treating the cursor as an effect record.
    effectDigest: "0".repeat(64),
  };
}

function safeText(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) throw new Error(`${field} GitHub tidak sah.`);
  return value;
}

function positive(value: unknown, field: string, allowZero = false): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${field} GitHub tidak sah.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} GitHub tidak sah.`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
