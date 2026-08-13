import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  CodingDiffSummary,
  CodingRun,
  CodingRunConstraint,
  CodingRepositoryMapReceipt,
  CodingRunPlan,
  CodingTaskBrief,
  CodingValidationCommand,
  CodingValidatorKind,
  CodingValidatorReceipt,
  CodingTaskReviewReceipt,
} from "../domain/coding-run.js";
import type { BoundReadOnlyRepositoryTools } from "./repository-tools.js";
import type { ProjectWorkingCopy } from "../core/project-workspace-service.js";
import { resolveProjectPath } from "../core/project-files.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";

export { containsSecretLikeValue } from "../security/credential-like.js";

export interface CodingValidationFinding {
  code:
    | "empty-diff"
    | "too-many-files"
    | "too-many-bytes"
    | "unexpected-binary"
    | "large-generated-artifact"
    | "secret-like-content"
    | "sensitive-file";
  path: string | null;
}

export interface CodingValidationReport {
  passed: boolean;
  workingSnapshot: string;
  findings: CodingValidationFinding[];
}

export interface CodingValidatorPolicy {
  /** Stable code-owned identity; changing it invalidates old review receipts. */
  readonly taskReviewer: {
    id: string;
    version: string;
  };
  commandsFor(input: {
    projectId: string;
    baseSnapshot: string;
    instructionRevision: number;
    taskBrief: CodingTaskBrief;
    constraints: readonly CodingRunConstraint[];
  }): Promise<readonly CodingValidationCommand[]>;
  reviewTask(
    input: CodingTaskReviewInput,
    signal?: AbortSignal,
  ): Promise<CodingTaskReviewAssessment>;
}

export interface CodingTaskReviewRequirement {
  kind: "request" | "objective" | "acceptance" | "constraint";
  digest: string;
  text: string;
}

export interface CodingTaskReviewInput {
  projectId: string;
  instructionRevision: number;
  taskBrief: CodingTaskBrief;
  constraints: readonly CodingRunConstraint[];
  diff: CodingDiffSummary;
  validators: readonly CodingValidatorReceipt[];
  requirements: readonly CodingTaskReviewRequirement[];
  /** Closed, code-owned evidence references accepted in the assessment. */
  availableEvidenceRefs: readonly string[];
  repositoryMap: CodingRepositoryMapReceipt;
  plan: CodingRunPlan;
  /** Immutable snapshot view; implementation never receives a host path. */
  workspace: BoundReadOnlyRepositoryTools;
}

export interface CodingTaskReviewAssessment {
  decision: "approved" | "changes_requested";
  requirementEvidence: Array<{
    requirementDigest: string;
    status: "evidenced" | "not_evidenced";
    evidenceRefs: string[];
  }>;
  publicApi: CodingTaskReviewReceipt["publicApi"];
  unrelatedChanges: CodingTaskReviewReceipt["unrelatedChanges"];
}

export async function validateCodingDiff(
  diff: CodingDiffSummary,
  working: ProjectWorkingCopy,
  options: {
    maxChangedFiles: number;
    maxChangedBytes: number;
    allowBinaryPaths?: readonly string[];
    allowSensitivePaths?: readonly string[];
  },
): Promise<CodingValidationReport> {
  const findings: CodingValidationFinding[] = [];
  if (diff.files.length === 0) findings.push({ code: "empty-diff", path: null });
  if (diff.files.length > options.maxChangedFiles) {
    findings.push({ code: "too-many-files", path: null });
  }
  if (diff.addedBytes + diff.removedBytes > options.maxChangedBytes) {
    findings.push({ code: "too-many-bytes", path: null });
  }
  const allowedBinary = new Set(options.allowBinaryPaths ?? []);
  const allowedSensitive = new Set(options.allowSensitivePaths ?? []);
  for (const file of diff.files) {
    if (file.binary && !allowedBinary.has(file.path)) {
      findings.push({ code: "unexpected-binary", path: file.path });
    }
    if (
      file.status !== "deleted" &&
      (file.afterSize ?? 0) > 5 * 1024 * 1024 &&
      /(?:^|\/)(?:dist|build|coverage|vendor|node_modules|target)(?:\/|$)/iu.test(
        file.path,
      )
    ) {
      findings.push({ code: "large-generated-artifact", path: file.path });
    }
    if (file.status === "deleted" || allowedSensitive.has(file.path)) continue;
    if (isSensitiveProjectPath(file.path)) {
      findings.push({ code: "sensitive-file", path: file.path });
      continue;
    }
    // The run-level changed-byte budget already bounds total input. Skipping a
    // large text file would let a credential placed after the old scan cutoff
    // bypass the completion gate, so every non-binary changed file is scanned.
    if (file.binary) continue;
    const content = await readFile(
      resolveProjectPath(working.internalPath, file.path),
      "utf8",
    );
    if (containsSecretLikeValue(content)) {
      findings.push({ code: "secret-like-content", path: file.path });
    }
  }
  return {
    passed: findings.length === 0,
    workingSnapshot: diff.workingSnapshot,
    findings,
  };
}

export function assertRequiredValidators(
  run: CodingRun,
  commands: readonly CodingValidationCommand[],
  workingSnapshot: string,
): void {
  const required = new Set(
    commands.filter((command) => command.required).map((command) => command.kind),
  );
  for (const kind of required) {
    const receipt = latestReceipt(run, kind);
    if (
      !receipt ||
      receipt.status !== "passed" ||
      receipt.instructionRevision !== run.instructionRevision ||
      receipt.workingSnapshot !== workingSnapshot ||
      receipt.commandDigest !== validatorCommandDigest(
        validatorCommand(commands, kind),
      ) ||
      receipt.taskContractDigest !== taskContractDigest(run)
    ) {
      throw new Error(`Validator wajib ${kind} belum lulus untuk snapshot terbaru.`);
    }
  }
}

export function validatorCommandDigest(command: CodingValidationCommand): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: command.kind,
      argv: [...command.argv],
      cwd: command.cwd,
      purpose: command.purpose,
      timeoutMs: command.timeoutMs,
      required: command.required,
    }), "utf8")
    .digest("hex");
}

export function taskContractDigest(run: CodingRun): string {
  return createHash("sha256")
    .update(JSON.stringify({
      taskBrief: run.taskBrief,
      constraints: run.constraints.map((constraint) => ({
        kind: constraint.kind,
        content: constraint.content,
        instructionRevision: constraint.instructionRevision,
      })),
      instructionRevision: run.instructionRevision,
    }), "utf8")
    .digest("hex");
}

export function codingDiffDigest(diff: CodingDiffSummary): string {
  return createHash("sha256")
    .update(JSON.stringify({
      baseSnapshot: diff.baseSnapshot,
      workingSnapshot: diff.workingSnapshot,
      files: diff.files,
      addedBytes: diff.addedBytes,
      removedBytes: diff.removedBytes,
    }), "utf8")
    .digest("hex");
}

export function taskReviewPolicyDigest(policy: CodingValidatorPolicy): string {
  const id = boundedPolicyPart(policy.taskReviewer?.id, "task reviewer id");
  const version = boundedPolicyPart(
    policy.taskReviewer?.version,
    "task reviewer version",
  );
  return createHash("sha256")
    .update(JSON.stringify({ id, version }), "utf8")
    .digest("hex");
}

export function taskReviewRequirements(
  run: CodingRun,
): CodingTaskReviewRequirement[] {
  const requirements: CodingTaskReviewRequirement[] = [
    {
      kind: "request",
      digest: requirementDigest("request", 0, run.taskBrief.request),
      text: run.taskBrief.request,
    },
    {
      kind: "objective",
      digest: requirementDigest("objective", 0, run.taskBrief.objective),
      text: run.taskBrief.objective,
    },
  ];
  run.taskBrief.acceptanceCriteria.forEach((text, index) => {
    requirements.push({
      kind: "acceptance",
      digest: requirementDigest("acceptance", index, text),
      text,
    });
  });
  run.taskBrief.initialConstraints.forEach((text, index) => {
    requirements.push({
      kind: "constraint",
      digest: requirementDigest("initial-constraint", index, text),
      text,
    });
  });
  run.constraints.forEach((constraint, index) => {
    requirements.push({
      kind: "constraint",
      digest: requirementDigest(
        `revision-${constraint.instructionRevision}-${constraint.kind}`,
        index,
        constraint.content,
      ),
      text: constraint.content,
    });
  });
  return requirements;
}

export function validatorCommand(
  commands: readonly CodingValidationCommand[],
  kind: CodingValidatorKind,
): CodingValidationCommand {
  const matches = commands.filter((command) => command.kind === kind);
  if (matches.length !== 1) {
    throw new Error(`Policy validator ${kind} harus mempunyai tepat satu command.`);
  }
  const command = matches[0]!;
  if (command.purpose !== kind && !(kind === "test" && command.purpose === "test")) {
    throw new Error(`Purpose validator ${kind} tidak cocok.`);
  }
  return structuredClone(command);
}

function latestReceipt(run: CodingRun, kind: CodingValidatorKind) {
  return [...run.validatorReceipts]
    .reverse()
    .find((receipt) => receipt.kind === kind) ?? null;
}

function requirementDigest(kind: string, index: number, text: string): string {
  return createHash("sha256")
    .update(`${kind}\0${index}\0${text}`, "utf8")
    .digest("hex");
}

function boundedPolicyPart(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}
