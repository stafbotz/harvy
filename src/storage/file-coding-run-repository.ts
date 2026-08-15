import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CodingRepositoryMapReceipt,
  CodingRun,
  CodingRunPlan,
  CodingRunRepository,
  CodingRunSaveResult,
  CodingTaskReviewReceipt,
  NewCodingRun,
} from "../domain/coding-run.js";
import {
  codingDiffDigest,
  containsSecretLikeValue,
  taskContractDigest,
  taskReviewRequirements,
} from "../coding/coding-validators.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_DURABLE_EVENTS = 512;
const MAX_RUNS_PER_PROJECT = 1_024;
const TERMINAL = new Set<CodingRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "stale",
  "partial",
]);

interface CodingRunDatabase {
  version: 1;
  runs: CodingRun[];
}

/** Development adapter with CAS and one active mutable writer per project. */
export class FileCodingRunRepository implements CodingRunRepository {
  private readonly filePath: string;
  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async load(runId: string): Promise<CodingRun | null> {
    const cleanId = safeKey(runId, "runId");
    const run = (await this.readDatabase()).runs.find(
      (candidate) => candidate.runId === cleanId,
    );
    return run ? structuredClone(run) : null;
  }

  async loadActiveByProject(projectId: string): Promise<CodingRun | null> {
    const cleanProjectId = safeKey(projectId, "projectId");
    const run = (await this.readDatabase()).runs.find(
      (candidate) =>
        candidate.binding.projectId === cleanProjectId &&
        !TERMINAL.has(candidate.status),
    );
    return run ? structuredClone(run) : null;
  }

  async listActive(): Promise<CodingRun[]> {
    return structuredClone(
      (await this.readDatabase()).runs
        .filter((run) => !TERMINAL.has(run.status))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async listByProject(projectId: string): Promise<CodingRun[]> {
    const cleanProjectId = safeKey(projectId, "projectId");
    return structuredClone((await this.readDatabase()).runs
      .filter((run) => run.binding.projectId === cleanProjectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async create(run: NewCodingRun): Promise<CodingRunSaveResult> {
    const record: CodingRun = { ...structuredClone(run), stateRevision: 1 };
    validateRun(record);
    validateInitialState(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      if (database.runs.some((candidate) => candidate.runId === record.runId)) {
        return { status: "conflict" };
      }
      if (
        database.runs.filter(
          (candidate) => candidate.binding.projectId === record.binding.projectId,
        ).length >= MAX_RUNS_PER_PROJECT
      ) {
        throw new Error("Batas histori CodingRun per project tercapai.");
      }
      if (
        !TERMINAL.has(record.status) &&
        database.runs.some(
          (candidate) =>
            candidate.binding.projectId === record.binding.projectId &&
            !TERMINAL.has(candidate.status),
        )
      ) {
        return { status: "active-run-exists" };
      }
      database.runs.push(record);
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(record) };
    });
  }

  async save(
    run: Omit<CodingRun, "stateRevision">,
    expectedStateRevision: number,
  ): Promise<CodingRunSaveResult> {
    if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1) {
      throw new Error("Expected state revision CodingRun tidak sah.");
    }
    const record: CodingRun = {
      ...structuredClone(run),
      stateRevision: expectedStateRevision + 1,
    };
    validateRun(record);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (candidate) => candidate.runId === record.runId,
      );
      if (
        index < 0 ||
        database.runs[index]!.stateRevision !== expectedStateRevision
      ) {
        return { status: "conflict" };
      }
      const current = database.runs[index]!;
      validateImmutableState(current, record);
      validateStateTransition(current, record);
      database.runs[index] = record;
      await this.writeDatabase(database);
      return { status: "saved", run: structuredClone(record) };
    });
  }

  async remove(runId: string, expectedStateRevision: number): Promise<boolean> {
    const cleanId = safeKey(runId, "runId");
    if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1) {
      throw new Error("Expected state revision CodingRun tidak sah.");
    }
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.runs.findIndex(
        (candidate) => candidate.runId === cleanId,
      );
      if (
        index < 0 ||
        database.runs[index]!.stateRevision !== expectedStateRevision
      ) {
        return false;
      }
      database.runs.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  private async readDatabase(): Promise<CodingRunDatabase> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<CodingRunDatabase>;
      if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
        throw new Error("Format basis data CodingRun tidak dikenali.");
      }
      for (const run of parsed.runs) validateRun(run);
      assertSingleWriters(parsed.runs);
      return { version: 1, runs: structuredClone(parsed.runs) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, runs: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: CodingRunDatabase): Promise<void> {
    assertSingleWriters(database.runs);
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
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

function validateRun(value: unknown): asserts value is CodingRun {
  if (!value || typeof value !== "object") throw new Error("CodingRun tidak sah.");
  assertObjectKeys(value, [
    "version", "runId", "binding", "taskBrief", "status", "phase",
    "instructionRevision", "appliedInstructionRevision", "stateRevision",
    "workingCopyId", "writer", "constraints", "changeSets", "events",
    "validatorReceipts", "diff", "limits", "counters", "pendingCommit",
    "commitReceipts", "result", "lastError", "createdAt", "startedAt",
    "updatedAt", "completedAt", "expiresAt",
  ], ["taskReviewReceipts", "repositoryMap", "plan", "admission"], "run");
  const run = value as CodingRun;
  if (run.version !== 1 && run.version !== 2) throw new Error("Versi CodingRun tidak sah.");
  if (!validStatusPhase(run.status, run.phase)) {
    throw new Error("Status/phase CodingRun tidak sah atau tidak konsisten.");
  }
  safeKey(run.runId, "runId");
  assertObjectKeys(run.binding, [
    "projectId", "ownerWorkspaceKey", "workspaceRevision", "baseSnapshot",
  ], [], "binding");
  safeKey(run.binding?.projectId, "projectId");
  safeKey(run.binding?.ownerWorkspaceKey, "ownerWorkspaceKey");
  sha256(run.binding?.baseSnapshot, "baseSnapshot");
  positive(run.binding?.workspaceRevision, "workspaceRevision");
  positive(run.stateRevision, "stateRevision");
  positive(run.instructionRevision, "instructionRevision", true);
  positive(run.appliedInstructionRevision, "appliedInstructionRevision", true);
  if (run.appliedInstructionRevision > run.instructionRevision) {
    throw new Error("Applied revision CodingRun melampaui instruction revision.");
  }
  safeKey(run.workingCopyId, "workingCopyId");
  assertObjectKeys(run.writer, ["writerId", "acquiredAt", "expiresAt"], [], "writer");
  safeKey(run.writer?.writerId, "writerId");
  validIso(run.writer?.acquiredAt, "writer.acquiredAt");
  validIso(run.writer?.expiresAt, "writer.expiresAt");
  if (Date.parse(run.writer.expiresAt) <= Date.parse(run.writer.acquiredAt)) {
    throw new Error("Writer lease CodingRun tidak sah.");
  }
  const taskBrief = run.taskBrief;
  assertObjectKeys(taskBrief, [
    "request", "objective", "acceptanceCriteria", "initialConstraints",
  ], [], "taskBrief");
  if (
    !taskBrief ||
    typeof taskBrief.request !== "string" ||
    typeof taskBrief.objective !== "string" ||
    !Array.isArray(taskBrief.acceptanceCriteria) ||
    !Array.isArray(taskBrief.initialConstraints) ||
    [
      taskBrief.request,
      taskBrief.objective,
      ...taskBrief.acceptanceCriteria,
      ...taskBrief.initialConstraints,
    ].some((text) => typeof text !== "string" || containsSecretLikeValue(text))
  ) {
    throw new Error("TaskBrief CodingRun tidak sah atau menyerupai credential.");
  }
  if (run.admission !== undefined) {
    assertObjectKeys(run.admission, [
      "source", "effectId", "audience", "authorityRef", "interactionDigest",
    ], [], "admission");
    if (
      run.admission.source !== "group" ||
      run.admission.audience !== "group-safe" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(run.admission.effectId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(run.admission.authorityRef) ||
      !/^[a-f0-9]{64}$/u.test(run.admission.interactionDigest) ||
      containsSecretLikeValue(run.admission.effectId) ||
      containsSecretLikeValue(run.admission.authorityRef)
    ) {
      throw new Error("Admission provenance CodingRun tidak sah.");
    }
  }
  if (!Array.isArray(run.constraints) || !Array.isArray(run.changeSets)) {
    throw new Error("Constraint CodingRun tidak sah.");
  }
  if (run.constraints.length !== run.changeSets.length) {
    throw new Error("Constraint dan ChangeSet CodingRun tidak berpasangan.");
  }
  for (let index = 0; index < run.constraints.length; index += 1) {
    const constraint = run.constraints[index]!;
    const change = run.changeSets[index]!;
    assertObjectKeys(constraint, [
      "id", "sourceMessageId", "kind", "content", "instructionRevision",
      "receivedAt",
    ], [], "constraint");
    assertObjectKeys(change, [
      "instructionRevision", "sourceMessageId", "kind", "affectedStages",
      "receivedAt",
    ], [], "changeSet");
    if (
      typeof constraint.content !== "string" ||
      containsSecretLikeValue(constraint.content) ||
      containsSecretLikeValue(constraint.sourceMessageId) ||
      constraint.instructionRevision !== index + 1 ||
      change.instructionRevision !== index + 1 ||
      constraint.sourceMessageId !== change.sourceMessageId ||
      constraint.kind !== change.kind
    ) {
      throw new Error("Ledger revision CodingRun tidak berurutan.");
    }
  }
  if (run.instructionRevision !== run.constraints.length) {
    throw new Error("Instruction revision CodingRun tidak cocok dengan ledger.");
  }
  if (
    !Array.isArray(run.events) ||
    run.events.length > MAX_DURABLE_EVENTS ||
    !Array.isArray(run.validatorReceipts) ||
    (run.taskReviewReceipts !== undefined && !Array.isArray(run.taskReviewReceipts))
  ) {
    throw new Error("Event atau receipt CodingRun tidak sah.");
  }
  for (const receipt of run.validatorReceipts) {
    assertObjectKeys(receipt, [
      "receiptId", "kind", "status", "instructionRevision",
      "workingSnapshot", "commandDigest", "taskContractDigest",
      "sandboxOperationId", "sandboxRequestDigest", "sandboxExecutionId",
      "exitCode", "evidenceArtifactIds", "completedAt",
    ], [], "validator receipt");
    safeKey(receipt.receiptId, "validator receiptId");
    if (
      !["test", "lint", "typecheck", "build"].includes(receipt.kind) ||
      !["passed", "failed", "stale", "infrastructure_error"].includes(
        receipt.status,
      ) ||
      !Number.isSafeInteger(receipt.instructionRevision) ||
      receipt.instructionRevision < 0 ||
      receipt.instructionRevision > run.instructionRevision ||
      (receipt.status === "passed" && receipt.exitCode !== 0) ||
      (receipt.status === "failed" &&
        (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode === 0))
    ) throw new Error("Status/evidence validator CodingRun tidak sah.");
    sha256(receipt.workingSnapshot, "validator workingSnapshot");
    sha256(receipt.commandDigest, "validator commandDigest");
    sha256(receipt.taskContractDigest, "validator taskContractDigest");
    safeCredentialFreeOpaqueId(
      receipt.sandboxOperationId,
      "validator sandboxOperationId",
    );
    sha256(receipt.sandboxRequestDigest, "validator sandboxRequestDigest");
    safeCredentialFreeOpaqueId(
      receipt.sandboxExecutionId,
      "validator sandboxExecutionId",
    );
    if (!Array.isArray(receipt.evidenceArtifactIds) || receipt.evidenceArtifactIds.length > 32) {
      throw new Error("Artifact evidence validator CodingRun tidak sah.");
    }
    if (
      run.version === 2 &&
      receipt.status === "passed" &&
      receipt.evidenceArtifactIds.length < 1
    ) {
      throw new Error("Validator passed wajib mempunyai artifact evidence durable.");
    }
    if (new Set(receipt.evidenceArtifactIds).size !== receipt.evidenceArtifactIds.length) {
      throw new Error("Artifact evidence validator CodingRun duplikat.");
    }
    for (const artifactId of receipt.evidenceArtifactIds) {
      if (!/^evidence-[a-f0-9]{64}$/u.test(artifactId)) {
        throw new Error("Artifact evidence validator bukan content-addressed id.");
      }
    }
    validIso(receipt.completedAt, "validator completedAt");
  }
  for (const receipt of run.taskReviewReceipts ?? []) {
    assertObjectKeys(receipt, [
      "receiptId", "status", "instructionRevision", "workingSnapshot",
      "diffDigest", "taskContractDigest", "policyDigest",
      "repositoryMapDigest", "planDigest", "requirementEvidence",
      "publicApi", "unrelatedChanges", "completedAt",
    ], [], "task review receipt");
    safeKey(receipt.receiptId, "task review receiptId");
    if (
      receipt.status !== "approved" &&
      receipt.status !== "changes_requested" &&
      receipt.status !== "stale" &&
      receipt.status !== "infrastructure_error"
    ) throw new Error("Status task review CodingRun tidak sah.");
    positive(receipt.instructionRevision, "task review instructionRevision", true);
    sha256(receipt.workingSnapshot, "task review workingSnapshot");
    sha256(receipt.diffDigest, "task review diffDigest");
    sha256(receipt.taskContractDigest, "task review taskContractDigest");
    sha256(receipt.policyDigest, "task review policyDigest");
    sha256(receipt.repositoryMapDigest, "task review repositoryMapDigest");
    sha256(receipt.planDigest, "task review planDigest");
    if (!Array.isArray(receipt.requirementEvidence)) {
      throw new Error("Requirement evidence task review tidak sah.");
    }
    const requirements = new Set<string>();
    for (const evidence of receipt.requirementEvidence) {
      assertObjectKeys(evidence, [
        "kind", "requirementDigest", "status", "evidenceRefs",
      ], [], "task review evidence");
      if (
        evidence.kind !== "request" &&
        evidence.kind !== "objective" &&
        evidence.kind !== "acceptance" &&
        evidence.kind !== "constraint"
      ) {
        throw new Error("Jenis requirement task review tidak sah.");
      }
      sha256(evidence.requirementDigest, "task review requirementDigest");
      if (
        requirements.has(evidence.requirementDigest) ||
        (evidence.status !== "evidenced" && evidence.status !== "not_evidenced") ||
        !Array.isArray(evidence.evidenceRefs) ||
        evidence.evidenceRefs.length > 32 ||
        evidence.evidenceRefs.some(
          (item) => !validReviewEvidenceReference(run, receipt, item),
        ) ||
        (evidence.status === "evidenced" && evidence.evidenceRefs.length === 0)
      ) {
        throw new Error("Requirement evidence task review tidak sah atau duplikat.");
      }
      requirements.add(evidence.requirementDigest);
    }
    if (
      receipt.publicApi !== "preserved" &&
      receipt.publicApi !== "changed" &&
      receipt.publicApi !== "not_applicable"
    ) throw new Error("Evidence public API task review tidak sah.");
    if (
      receipt.unrelatedChanges !== "minimized" &&
      receipt.unrelatedChanges !== "not_minimized"
    ) throw new Error("Evidence unrelated changes task review tidak sah.");
    validIso(receipt.completedAt, "task review completedAt");
  }
  if (run.repositoryMap !== undefined && run.repositoryMap !== null) {
    validateRepositoryMap(run.repositoryMap);
    if (run.repositoryMap.instructionRevision !== run.instructionRevision) {
      throw new Error("Repository map tidak cocok dengan instruction revision CodingRun.");
    }
  }
  if (run.plan !== undefined && run.plan !== null) {
    validatePlan(run.plan);
    if (
      !run.repositoryMap ||
      run.plan.instructionRevision !== run.instructionRevision ||
      run.plan.repositoryMapDigest !== run.repositoryMap.mapDigest ||
      run.plan.taskContractDigest !== taskContractDigest(run)
    ) {
      throw new Error("Coding plan tidak cocok dengan repository map atau task contract.");
    }
  }
  if (
    run.diff &&
    run.diff.files.some(
      (file) => typeof file.path !== "string" || containsSecretLikeValue(file.path),
    )
  ) {
    throw new Error("Path diff CodingRun tidak sah atau menyerupai credential.");
  }
  if (run.diff) {
    assertObjectKeys(run.diff, [
      "baseSnapshot", "workingSnapshot", "files", "addedBytes",
      "removedBytes", "generatedAt",
    ], [], "diff");
    for (const file of run.diff.files) {
      assertObjectKeys(file, [
        "path", "status", "beforeSha256", "afterSha256", "beforeSize",
        "afterSize", "binary",
      ], [], "diff file");
      if (
        !["added", "modified", "deleted"].includes(file.status) ||
        typeof file.binary !== "boolean" ||
        !validNullableDigest(file.beforeSha256) ||
        !validNullableDigest(file.afterSha256) ||
        !validNullableSize(file.beforeSize) ||
        !validNullableSize(file.afterSize)
      ) throw new Error("Entry diff CodingRun tidak sah.");
    }
    sha256(run.diff.baseSnapshot, "diff baseSnapshot");
    sha256(run.diff.workingSnapshot, "diff workingSnapshot");
    positive(run.diff.addedBytes, "diff addedBytes", true);
    positive(run.diff.removedBytes, "diff removedBytes", true);
    validIso(run.diff.generatedAt, "diff generatedAt");
    if (run.diff.baseSnapshot !== run.binding.baseSnapshot) {
      throw new Error("Diff CodingRun tidak terikat base snapshot.");
    }
  }
  assertObjectKeys(run.limits, [
    "maxPatches", "maxSandboxCalls", "maxChangedFiles", "maxChangedBytes",
    "maxActiveMs", "maxCoordinatorDecisions",
  ], [], "limits");
  assertObjectKeys(run.counters, [
    "patches", "sandboxCalls", "activeElapsedMs", "coordinatorDecisions",
  ], [], "counters");
  positive(run.limits?.maxPatches, "maxPatches");
  positive(run.limits?.maxSandboxCalls, "maxSandboxCalls");
  positive(run.limits?.maxChangedFiles, "maxChangedFiles");
  positive(run.limits?.maxChangedBytes, "maxChangedBytes");
  positive(run.limits?.maxActiveMs, "maxActiveMs");
  positive(run.limits?.maxCoordinatorDecisions, "maxCoordinatorDecisions");
  positive(run.counters?.patches, "patches", true);
  positive(run.counters?.sandboxCalls, "sandboxCalls", true);
  positive(run.counters?.activeElapsedMs, "activeElapsedMs", true);
  positive(run.counters?.coordinatorDecisions, "coordinatorDecisions", true);
  if (
    run.counters.patches > run.limits.maxPatches ||
    run.counters.sandboxCalls > run.limits.maxSandboxCalls ||
    run.counters.coordinatorDecisions > run.limits.maxCoordinatorDecisions
  ) {
    throw new Error("Counter CodingRun melampaui limit.");
  }
  validIso(run.createdAt, "createdAt");
  validIso(run.startedAt, "startedAt");
  validIso(run.updatedAt, "updatedAt");
  validIso(run.expiresAt, "expiresAt");
  if (run.completedAt !== null) validIso(run.completedAt, "completedAt");
  if (TERMINAL.has(run.status) !== (run.completedAt !== null)) {
    throw new Error("Terminal state CodingRun tidak konsisten.");
  }
  if (run.status === "completed" && (!run.result || !run.diff)) {
    throw new Error("CodingRun completed tanpa hasil atau diff.");
  }
  if (run.pendingCommit && run.status !== "validating") {
    throw new Error("Pending commit CodingRun hanya sah saat validating.");
  }
  if (run.version === 2 && (run.status === "validating") !== Boolean(run.pendingCommit)) {
    throw new Error("CodingRun validating wajib mempunyai exact pending commit.");
  }
  if (run.pendingCommit) {
    assertObjectKeys(run.pendingCommit, [
      "effectId", "instructionRevision", "sourceWorkspaceRevision",
      "workingSnapshot", "validatorEvidence", "preparedAt",
    ], ["taskReviewEvidence"], "pending commit");
    safeKey(run.pendingCommit.effectId, "pending effectId");
    positive(run.pendingCommit.instructionRevision, "pending instructionRevision", true);
    positive(run.pendingCommit.sourceWorkspaceRevision, "pending source revision");
    sha256(run.pendingCommit.workingSnapshot, "pending workingSnapshot");
    validIso(run.pendingCommit.preparedAt, "pending preparedAt");
    if (
      run.pendingCommit.instructionRevision !== run.instructionRevision ||
      run.pendingCommit.sourceWorkspaceRevision !== run.binding.workspaceRevision ||
      !Array.isArray(run.pendingCommit.validatorEvidence) ||
      run.pendingCommit.validatorEvidence.length < 1
    ) {
      throw new Error("Binding pending commit CodingRun tidak sah.");
    }
    const evidenceKinds = new Set<string>();
    for (const evidence of run.pendingCommit.validatorEvidence) {
      assertObjectKeys(evidence, [
        "receiptId", "kind", "commandDigest", "taskContractDigest",
        "sandboxOperationId", "sandboxRequestDigest", "sandboxExecutionId",
      ], [], "pending validator evidence");
      safeKey(evidence.receiptId, "pending validator receiptId");
      safeCredentialFreeOpaqueId(
        evidence.sandboxOperationId,
        "pending sandboxOperationId",
      );
      sha256(evidence.sandboxRequestDigest, "pending sandboxRequestDigest");
      safeCredentialFreeOpaqueId(evidence.sandboxExecutionId, "pending sandboxExecutionId");
      sha256(evidence.commandDigest, "pending commandDigest");
      sha256(evidence.taskContractDigest, "pending taskContractDigest");
      if (evidenceKinds.has(evidence.kind)) {
        throw new Error("Validator evidence pending commit duplikat.");
      }
      evidenceKinds.add(evidence.kind);
      const receipt = run.validatorReceipts.find(
        (candidate) =>
          candidate.receiptId === evidence.receiptId &&
          candidate.kind === evidence.kind &&
          candidate.status === "passed" &&
          candidate.instructionRevision === run.pendingCommit!.instructionRevision &&
          candidate.workingSnapshot === run.pendingCommit!.workingSnapshot &&
          candidate.commandDigest === evidence.commandDigest &&
          candidate.taskContractDigest === evidence.taskContractDigest &&
          candidate.sandboxOperationId === evidence.sandboxOperationId &&
          candidate.sandboxRequestDigest === evidence.sandboxRequestDigest &&
          candidate.sandboxExecutionId === evidence.sandboxExecutionId,
      );
      if (!receipt) throw new Error("Validator evidence pending commit tidak ditemukan.");
    }
    const reviewEvidence = run.pendingCommit.taskReviewEvidence;
    if (run.version === 2 && !reviewEvidence) {
      throw new Error("Pending commit tidak mempunyai task review evidence.");
    }
    if (reviewEvidence) {
    assertObjectKeys(reviewEvidence, [
      "receiptId", "diffDigest", "taskContractDigest", "policyDigest",
      "repositoryMapDigest", "planDigest",
    ], [], "pending task review evidence");
    safeKey(reviewEvidence.receiptId, "pending task review receiptId");
    sha256(reviewEvidence.diffDigest, "pending task review diffDigest");
    sha256(reviewEvidence.taskContractDigest, "pending task review taskContractDigest");
    sha256(reviewEvidence.policyDigest, "pending task review policyDigest");
    sha256(reviewEvidence.repositoryMapDigest, "pending task review repositoryMapDigest");
    sha256(reviewEvidence.planDigest, "pending task review planDigest");
    const review = (run.taskReviewReceipts ?? []).find(
      (candidate) =>
        candidate.receiptId === reviewEvidence.receiptId &&
        candidate.status === "approved" &&
        candidate.instructionRevision === run.pendingCommit!.instructionRevision &&
        candidate.workingSnapshot === run.pendingCommit!.workingSnapshot &&
        candidate.diffDigest === reviewEvidence.diffDigest &&
        candidate.taskContractDigest === reviewEvidence.taskContractDigest &&
        candidate.policyDigest === reviewEvidence.policyDigest &&
        candidate.repositoryMapDigest === reviewEvidence.repositoryMapDigest &&
        candidate.planDigest === reviewEvidence.planDigest,
    );
    if (
      !review ||
      !run.diff ||
      review.diffDigest !== codingDiffDigest(run.diff) ||
      review.taskContractDigest !== taskContractDigest(run) ||
      review.repositoryMapDigest !== run.repositoryMap?.mapDigest ||
      review.planDigest !== run.plan?.planDigest ||
      !approvedReviewEvidence(run, review)
    ) throw new Error("Task review evidence pending commit tidak ditemukan atau tidak sah.");
    }
  }
  for (const receipt of run.commitReceipts) {
    assertObjectKeys(receipt, [
      "effectId", "status", "sourceWorkspaceRevision",
      "committedWorkspaceRevision", "snapshotId", "committedAt",
    ], [], "commit receipt");
    safeKey(receipt.effectId, "commit effectId");
    if (receipt.status !== "committed" && receipt.status !== "unknown") {
      throw new Error("Status commit receipt CodingRun tidak sah.");
    }
    positive(receipt.sourceWorkspaceRevision, "commit source revision");
    if (receipt.committedWorkspaceRevision !== null) {
      positive(receipt.committedWorkspaceRevision, "commit workspace revision");
    }
    if (
      (receipt.status === "committed") !==
        (receipt.committedWorkspaceRevision !== null)
    ) throw new Error("Outcome commit receipt CodingRun tidak konsisten.");
    sha256(receipt.snapshotId, "commit snapshotId");
    validIso(receipt.committedAt, "commit committedAt");
  }
  for (const event of run.events) {
    assertObjectKeys(event, [
      "id", "type", "at", "instructionRevision", "summaryCode",
    ], [], "event");
  }
  if (run.lastError) {
    assertObjectKeys(run.lastError, ["stage", "code", "at"], [], "lastError");
  }
  if (run.result) {
    assertObjectKeys(run.result, [
      "instructionRevision", "projectRevision", "snapshotId", "changedFiles",
      "validators", "completedAt",
      ...(run.version === 2 ? ["taskReview"] : []),
    ], run.version === 1 ? ["taskReview"] : [], "result");
    for (const validator of run.result.validators) {
      assertObjectKeys(validator, [
        "kind", "status", "sandboxOperationId", "sandboxRequestDigest",
        "sandboxExecutionId",
      ], [], "result validator");
    }
    if (run.result.taskReview) {
      assertObjectKeys(run.result.taskReview, [
        "receiptId", "policyDigest", "repositoryMapDigest", "planDigest",
      ], [], "result task review");
    }
    positive(run.result.instructionRevision, "result instructionRevision", true);
    positive(run.result.projectRevision, "result projectRevision");
    sha256(run.result.snapshotId, "result snapshotId");
    positive(run.result.changedFiles, "result changedFiles", true);
    validIso(run.result.completedAt, "result completedAt");
  }
  if (run.version === 2 && run.status === "completed") {
    if (!run.result || !Array.isArray(run.result.validators) || run.result.validators.length < 1) {
      throw new Error("CodingRun completed tanpa validator result evidence.");
    }
    const resultKinds = new Set<string>();
    for (const validator of run.result.validators) {
      if (validator.status !== "passed" || resultKinds.has(validator.kind)) {
        throw new Error("Validator result CodingRun completed tidak sah atau duplikat.");
      }
      resultKinds.add(validator.kind);
      safeCredentialFreeOpaqueId(
        validator.sandboxOperationId,
        "result sandboxOperationId",
      );
      sha256(validator.sandboxRequestDigest, "result sandboxRequestDigest");
      safeCredentialFreeOpaqueId(
        validator.sandboxExecutionId,
        "result sandboxExecutionId",
      );
      const evidence = run.validatorReceipts.find(
        (candidate) =>
          candidate.kind === validator.kind &&
          candidate.status === "passed" &&
          candidate.instructionRevision === run.instructionRevision &&
          candidate.workingSnapshot === run.result!.snapshotId &&
          candidate.sandboxOperationId === validator.sandboxOperationId &&
          candidate.sandboxRequestDigest === validator.sandboxRequestDigest &&
          candidate.sandboxExecutionId === validator.sandboxExecutionId,
      );
      if (!evidence) {
        throw new Error("Validator result CodingRun completed tidak mempunyai receipt exact.");
      }
    }
    const resultReview = run.result?.taskReview;
    const receipt = (run.taskReviewReceipts ?? []).find(
      (candidate) =>
        candidate.receiptId === resultReview?.receiptId &&
        candidate.status === "approved" &&
        candidate.policyDigest === resultReview?.policyDigest &&
        candidate.repositoryMapDigest === resultReview?.repositoryMapDigest &&
        candidate.planDigest === resultReview?.planDigest,
    );
    if (
      !resultReview ||
      !receipt ||
      !run.diff ||
      run.result?.instructionRevision !== run.instructionRevision ||
      run.result.snapshotId !== run.diff.workingSnapshot ||
      receipt.workingSnapshot !== run.diff.workingSnapshot ||
      receipt.diffDigest !== codingDiffDigest(run.diff) ||
      receipt.taskContractDigest !== taskContractDigest(run) ||
      receipt.repositoryMapDigest !== run.repositoryMap?.mapDigest ||
      receipt.planDigest !== run.plan?.planDigest ||
      !approvedReviewEvidence(run, receipt)
    ) {
      throw new Error("CodingRun completed tanpa task review evidence.");
    }
    const commit = [...run.commitReceipts].reverse().find(
      (candidate) =>
        candidate.status === "committed" &&
        candidate.sourceWorkspaceRevision === run.binding.workspaceRevision &&
        candidate.committedWorkspaceRevision === run.result!.projectRevision &&
        candidate.snapshotId === run.result!.snapshotId &&
        candidate.committedAt === run.result!.completedAt,
    );
    const completionEvent = run.events.at(-1);
    if (
      !commit ||
      run.result.changedFiles !== run.diff.files.length ||
      run.result.completedAt !== run.completedAt ||
      completionEvent?.type !== "run.completed" ||
      completionEvent.at !== run.completedAt ||
      completionEvent.instructionRevision !== run.instructionRevision
    ) throw new Error("CodingRun completed tanpa exact workspace commit manifest.");
  }
}

function validateImmutableState(current: CodingRun, next: CodingRun): void {
  if (TERMINAL.has(current.status)) {
    throw new Error("CodingRun terminal tidak dapat diubah.");
  }
  if (
    current.version !== next.version ||
    JSON.stringify(current.binding) !== JSON.stringify(next.binding) ||
    JSON.stringify(current.taskBrief) !== JSON.stringify(next.taskBrief) ||
    JSON.stringify(current.admission) !== JSON.stringify(next.admission) ||
    current.runId !== next.runId ||
    current.workingCopyId !== next.workingCopyId ||
    current.createdAt !== next.createdAt ||
    current.startedAt !== next.startedAt ||
    JSON.stringify(current.limits) !== JSON.stringify(next.limits) ||
    next.counters.patches < current.counters.patches ||
    next.counters.sandboxCalls < current.counters.sandboxCalls ||
    next.counters.activeElapsedMs < current.counters.activeElapsedMs ||
    next.counters.coordinatorDecisions <
      current.counters.coordinatorDecisions ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    next.instructionRevision < current.instructionRevision ||
    next.constraints.length < current.constraints.length ||
    next.validatorReceipts.length < current.validatorReceipts.length ||
    (next.taskReviewReceipts ?? []).length <
      (current.taskReviewReceipts ?? []).length ||
    next.commitReceipts.length < current.commitReceipts.length ||
    JSON.stringify(current.constraints) !== JSON.stringify(
      next.constraints.slice(0, current.constraints.length),
    ) ||
    JSON.stringify(current.changeSets) !== JSON.stringify(
      next.changeSets.slice(0, current.changeSets.length),
    ) ||
    !validEventTransition(current.events, next.events) ||
    JSON.stringify(current.validatorReceipts) !== JSON.stringify(
      next.validatorReceipts.slice(0, current.validatorReceipts.length),
    ) ||
    JSON.stringify(current.taskReviewReceipts ?? []) !== JSON.stringify(
      (next.taskReviewReceipts ?? []).slice(
        0,
        (current.taskReviewReceipts ?? []).length,
      ),
    ) ||
    JSON.stringify(current.commitReceipts) !== JSON.stringify(
      next.commitReceipts.slice(0, current.commitReceipts.length),
    ) ||
    (current.pendingCommit !== null && next.pendingCommit !== null &&
      JSON.stringify(current.pendingCommit) !== JSON.stringify(next.pendingCommit)) ||
    (current.result !== null && JSON.stringify(current.result) !== JSON.stringify(next.result))
  ) {
    throw new Error("Field immutable/append-only CodingRun berubah.");
  }
  if (
    current.writer.writerId !== next.writer.writerId &&
    current.status !== "waiting_input" &&
    Date.parse(current.writer.expiresAt) > Date.parse(next.updatedAt)
  ) {
    throw new Error("Writer lease CodingRun belum dapat diambil alih.");
  }
}

function validateInitialState(run: CodingRun): void {
  if (
    run.version !== 2 ||
    run.stateRevision !== 1 ||
    run.status !== "running" ||
    run.phase !== "mapping" ||
    run.instructionRevision !== 0 ||
    run.appliedInstructionRevision !== 0 ||
    run.constraints.length !== 0 ||
    run.changeSets.length !== 0 ||
    run.validatorReceipts.length !== 0 ||
    (run.taskReviewReceipts?.length ?? 0) !== 0 ||
    run.repositoryMap !== null ||
    run.plan !== null ||
    run.diff !== null ||
    run.pendingCommit !== null ||
    run.commitReceipts.length !== 0 ||
    run.result !== null ||
    run.lastError !== null ||
    run.completedAt !== null ||
    run.counters.patches !== 0 ||
    run.counters.sandboxCalls !== 0 ||
    run.counters.activeElapsedMs !== 0 ||
    run.counters.coordinatorDecisions !== 0 ||
    run.events.length !== 1 ||
    run.events[0]?.type !== "run.started"
  ) throw new Error("State awal CodingRun v2 tidak canonical.");
}

function validateStateTransition(current: CodingRun, next: CodingRun): void {
  const allowed: Record<CodingRun["status"], readonly CodingRun["status"][]> = {
    queued: ["queued", "running", "cancelled", "failed", "stale"],
    running: ["running", "waiting_input", "validating", "cancelled", "failed", "stale"],
    waiting_input: ["waiting_input", "running", "cancelled", "failed", "stale"],
    validating: ["validating", "completed", "partial", "failed"],
    completed: [],
    failed: [],
    cancelled: [],
    stale: [],
    partial: [],
  };
  if (!allowed[current.status].includes(next.status)) {
    throw new Error("Transisi status CodingRun tidak sah.");
  }
  if (next.status === "completed") {
    const pending = current.pendingCommit;
    const appended = next.commitReceipts.slice(current.commitReceipts.length);
    if (
      current.status !== "validating" ||
      !pending ||
      next.pendingCommit !== null ||
      appended.length !== 1 ||
      appended[0]?.status !== "committed" ||
      appended[0].effectId !== pending.effectId ||
      appended[0].sourceWorkspaceRevision !== pending.sourceWorkspaceRevision ||
      appended[0].snapshotId !== pending.workingSnapshot
    ) throw new Error("Completion CodingRun tidak berasal dari exact commit barrier.");
  }
  if (next.status === "partial") {
    const pending = current.pendingCommit;
    const appended = next.commitReceipts.slice(current.commitReceipts.length);
    if (
      current.status !== "validating" ||
      !pending ||
      next.pendingCommit !== null ||
      appended.length !== 1 ||
      appended[0]?.status !== "unknown" ||
      appended[0].effectId !== pending.effectId
    ) throw new Error("Partial CodingRun tidak berasal dari outcome commit ambigu.");
  }
}

function validStatusPhase(
  status: CodingRun["status"],
  phase: CodingRun["phase"],
): boolean {
  const phases: Record<CodingRun["status"], readonly CodingRun["phase"][]> = {
    queued: ["queued"],
    running: ["mapping", "planning", "editing", "testing", "reviewing"],
    waiting_input: ["waiting_input"],
    validating: ["finalizing"],
    completed: ["completed"],
    failed: ["failed"],
    cancelled: ["cancelled"],
    stale: ["failed"],
    partial: ["failed"],
  };
  return Object.prototype.hasOwnProperty.call(phases, status) &&
    phases[status].includes(phase);
}

function validNullableDigest(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function validNullableSize(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validateRepositoryMap(map: CodingRepositoryMapReceipt): void {
  assertObjectKeys(map, [
    "instructionRevision", "workingSnapshot", "treeDigest", "symbolDigest",
    "entryCount", "symbolCount", "treeComplete", "symbolsComplete",
    "mapDigest", "completedAt",
  ], [], "repository map");
  positive(map.instructionRevision, "repository map instructionRevision", true);
  sha256(map.workingSnapshot, "repository map workingSnapshot");
  sha256(map.treeDigest, "repository map treeDigest");
  sha256(map.symbolDigest, "repository map symbolDigest");
  positive(map.entryCount, "repository map entryCount", true);
  positive(map.symbolCount, "repository map symbolCount", true);
  if (map.treeComplete !== true || map.symbolsComplete !== true) {
    throw new Error("Repository map CodingRun harus membuktikan traversal lengkap.");
  }
  sha256(map.mapDigest, "repository map digest");
  validIso(map.completedAt, "repository map completedAt");
  const expected = digestJson({
    instructionRevision: map.instructionRevision,
    workingSnapshot: map.workingSnapshot,
    treeDigest: map.treeDigest,
    symbolDigest: map.symbolDigest,
    entryCount: map.entryCount,
    symbolCount: map.symbolCount,
    treeComplete: map.treeComplete,
    symbolsComplete: map.symbolsComplete,
  });
  if (map.mapDigest !== expected) throw new Error("Digest repository map CodingRun tidak cocok.");
}

function validatePlan(plan: CodingRunPlan): void {
  assertObjectKeys(plan, [
    "revision", "instructionRevision", "repositoryMapDigest",
    "taskContractDigest", "steps", "planDigest", "createdAt",
  ], [], "plan");
  positive(plan.revision, "plan revision");
  positive(plan.instructionRevision, "plan instructionRevision", true);
  sha256(plan.repositoryMapDigest, "plan repositoryMapDigest");
  sha256(plan.taskContractDigest, "plan taskContractDigest");
  sha256(plan.planDigest, "plan digest");
  validIso(plan.createdAt, "plan createdAt");
  if (!Array.isArray(plan.steps) || plan.steps.length < 4 || plan.steps.length > 32) {
    throw new Error("Langkah coding plan tidak sah.");
  }
  const stages = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    assertObjectKeys(step, [
      "stepId", "stage", "description", "paths",
    ], [], "plan step");
    if (
      step.stepId !== `plan-step-${index + 1}` ||
      !["inspect", "edit", "test", "review"].includes(step.stage) ||
      typeof step.description !== "string" ||
      !step.description.trim() ||
      step.description.length > 1_000 ||
      containsSecretLikeValue(step.description) ||
      !Array.isArray(step.paths) ||
      step.paths.length > 32 ||
      step.paths.some(
        (path) => !validProjectPath(path) || containsSecretLikeValue(path),
      )
    ) throw new Error("Langkah coding plan tidak sah.");
    stages.add(step.stage);
  }
  if (["inspect", "edit", "test", "review"].some((stage) => !stages.has(stage))) {
    throw new Error("Coding plan tidak mencakup seluruh stage wajib.");
  }
  const expected = digestJson({
    revision: plan.revision,
    instructionRevision: plan.instructionRevision,
    repositoryMapDigest: plan.repositoryMapDigest,
    taskContractDigest: plan.taskContractDigest,
    steps: plan.steps,
  });
  if (plan.planDigest !== expected) throw new Error("Digest coding plan tidak cocok.");
}

function approvedReviewEvidence(
  run: CodingRun,
  receipt: CodingTaskReviewReceipt,
): boolean {
  const requirements = taskReviewRequirements(run);
  if (
    receipt.status !== "approved" ||
    receipt.publicApi === "changed" ||
    receipt.unrelatedChanges !== "minimized" ||
    receipt.requirementEvidence.length !== requirements.length
  ) return false;
  const evidence = new Map(
    receipt.requirementEvidence.map((item) => [item.requirementDigest, item]),
  );
  const complete = requirements.every((requirement) => {
    const item = evidence.get(requirement.digest);
    return item?.kind === requirement.kind &&
      item.status === "evidenced" &&
      item.evidenceRefs.length > 0 &&
      item.evidenceRefs.every((reference) =>
        validReviewEvidenceReference(run, receipt, reference)
      );
  });
  const publicApiRequired = requirements.some(
    (item) =>
      item.kind === "constraint" &&
      /(?:\bapi\b|\bpublic\b|\bpublik\b)/iu.test(item.text),
  );
  return complete && (!publicApiRequired || receipt.publicApi === "preserved");
}

function validReviewEvidenceReference(
  run: CodingRun,
  receipt: CodingTaskReviewReceipt,
  value: unknown,
): boolean {
  if (typeof value !== "string" || value.length > 512) return false;
  if (value === `diff:${receipt.diffDigest}`) return true;
  const match = /^validator:([A-Za-z0-9_-]{1,512})$/u.exec(value);
  if (!match) return false;
  return run.validatorReceipts.some(
    (candidate) =>
      candidate.receiptId === match[1] &&
      candidate.status === "passed" &&
      candidate.instructionRevision === receipt.instructionRevision &&
      candidate.workingSnapshot === receipt.workingSnapshot,
  );
}

function validProjectPath(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /\p{Cc}/u.test(value)
  ) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function assertObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Schema CodingRun ${label} bukan object.`);
  }
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error(`Schema CodingRun ${label} memuat field asing atau hilang.`);
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validEventTransition(
  current: CodingRun["events"],
  next: CodingRun["events"],
): boolean {
  if (JSON.stringify(current) === JSON.stringify(next)) return true;
  if (current.length < MAX_DURABLE_EVENTS) {
    return next.length === current.length + 1 &&
      JSON.stringify(current) === JSON.stringify(next.slice(0, current.length));
  }
  return next.length === MAX_DURABLE_EVENTS &&
    JSON.stringify(current.slice(1)) === JSON.stringify(next.slice(0, -1));
}

function assertSingleWriters(runs: readonly CodingRun[]): void {
  const active = new Set<string>();
  const runIds = new Set<string>();
  const admissionEffects = new Set<string>();
  for (const run of runs) {
    if (runIds.has(run.runId)) {
      throw new Error("Run ID CodingRun duplikat.");
    }
    runIds.add(run.runId);
    if (run.admission) {
      if (admissionEffects.has(run.admission.effectId)) {
        throw new Error("Admission effect CodingRun duplikat.");
      }
      admissionEffects.add(run.admission.effectId);
    }
    if (TERMINAL.has(run.status)) continue;
    if (active.has(run.binding.projectId)) {
      throw new Error("Lebih dari satu writer aktif untuk satu project.");
    }
    active.add(run.binding.projectId);
  }
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${field} CodingRun tidak sah.`);
  }
  return value;
}

function safeCredentialFreeOpaqueId(value: unknown, field: string): string {
  const clean = safeKey(value, field);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(clean) ||
    containsSecretLikeValue(clean)
  ) {
    throw new Error(`${field} CodingRun bukan opaque ID yang aman.`);
  }
  return clean;
}

function sha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} CodingRun tidak sah.`);
  }
}

function positive(value: unknown, field: string, zero = false): void {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) {
    throw new Error(`${field} CodingRun tidak sah.`);
  }
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} CodingRun tidak sah.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
