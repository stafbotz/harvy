import type { CodingRun } from "./coding-run.js";
import type { GroupScope } from "./group.js";

export interface GroupWorkspaceLink {
  version: 1;
  linkId: string;
  scopeKey: string;
  scope: GroupScope;
  accountId: string;
  /** Prevents a remove/re-add cycle from inheriting the previous link. */
  groupJoinedAt: string;
  workspaceKey: string;
  linkedByMembershipId: string;
  linkedByParticipantId: string;
  linkedAtAuthorityEpoch: number;
  stateRevision: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

/**
 * Immutable audience binding for a CodingRun initiated from a group. It is
 * deliberately stored outside CodingRun output so group delivery can expose a
 * small projection without source, diff, project, or repository metadata.
 */
export interface GroupCodingRunReference {
  version: 1;
  referenceId: string;
  effectId: string;
  interactionDigest: string;
  commandDigest: string;
  runId: string;
  linkId: string;
  linkStateRevision: number;
  scopeKey: string;
  accountId: string;
  groupJoinedAt: string;
  workspaceKey: string;
  projectId: string;
  initiatedByMembershipId: string;
  initiatedByParticipantId: string;
  createdAt: string;
}

export type GroupWorkspaceLinkSaveResult =
  | { status: "saved"; link: GroupWorkspaceLink }
  | { status: "conflict" };

export type GroupCodingRunReferenceSaveResult =
  | { status: "saved"; reference: GroupCodingRunReference }
  | { status: "conflict" };

export interface GroupCodingRepository {
  readonly coordinationKey?: string;
  loadLink(scopeKey: string, accountId: string): Promise<GroupWorkspaceLink | null>;
  saveLink(
    link: Omit<GroupWorkspaceLink, "stateRevision">,
    expectedStateRevision: number | null,
  ): Promise<GroupWorkspaceLinkSaveResult>;
  loadRunReference(runId: string): Promise<GroupCodingRunReference | null>;
  loadRunReferenceByEffect(effectId: string): Promise<GroupCodingRunReference | null>;
  saveRunReference(
    reference: GroupCodingRunReference,
  ): Promise<GroupCodingRunReferenceSaveResult>;
}

export interface GroupSafeCodingCheck {
  kind: "test" | "lint" | "typecheck" | "build";
  status: "passed" | "failed" | "stale" | "infrastructure_error";
}

export interface GroupSafeCodingRunView {
  audience: "group-safe";
  runId: string;
  status: CodingRun["status"];
  phase: CodingRun["phase"];
  changedFiles: number | null;
  checks: readonly GroupSafeCodingCheck[];
  localRevisionCreated: boolean;
  workspacePrivateDetailsAvailable: boolean;
  text: string;
}

export interface GroupSafePublishOffer {
  audience: "group-safe";
  runId: string;
  action: "github.push_branch" | "github.pr.create";
  status: "workspace-private-confirmation-required";
  text: string;
}

/** Only durable, code-owned facts enter the shared-room projection. */
export function renderGroupSafeCodingRun(run: CodingRun): GroupSafeCodingRunView {
  const currentChecks = new Map<GroupSafeCodingCheck["kind"], GroupSafeCodingCheck["status"]>();
  for (const receipt of run.validatorReceipts) {
    if (
      receipt.instructionRevision !== run.instructionRevision ||
      (run.diff && receipt.workingSnapshot !== run.diff.workingSnapshot)
    ) continue;
    currentChecks.set(receipt.kind, receipt.status);
  }
  const checks = [...currentChecks].map(([kind, status]) => ({ kind, status }));
  const changedFiles = run.result?.changedFiles ?? run.diff?.files.length ?? null;
  const localRevisionCreated = run.status === "completed" && run.result !== null;
  const lines = [groupSafeTitle(run), groupSafePhase(run.phase)];
  if (changedFiles !== null) lines.push(`${changedFiles} file berubah.`);
  for (const check of checks) {
    lines.push(`${groupSafeCheckLabel(check.kind)}: ${groupSafeCheckStatus(check.status)}.`);
  }
  if (localRevisionCreated) {
    lines.push("Perubahan sudah tersimpan sebagai revisi project lokal.");
    lines.push("Belum ada aksi GitHub dari status ini.");
  }
  if (run.status === "partial") {
    lines.push("Ada efek yang perlu direkonsiliasi di Workspace sebelum dilanjutkan.");
  }
  if (run.status === "failed") {
    lines.push("Detail kegagalan tersedia hanya di Workspace.");
  }
  return Object.freeze({
    audience: "group-safe" as const,
    runId: run.runId,
    status: run.status,
    phase: run.phase,
    changedFiles,
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
    localRevisionCreated,
    workspacePrivateDetailsAvailable:
      Boolean(run.diff || run.result || run.lastError || run.validatorReceipts.length > 0),
    text: lines.join("\n"),
  });
}

function groupSafeTitle(run: CodingRun): string {
  switch (run.status) {
    case "completed": return "✅ Perbaikan coding selesai";
    case "failed":
    case "partial": return "⚠️ Pekerjaan coding perlu perhatian";
    case "cancelled": return "⏹️ Pekerjaan coding dibatalkan";
    case "waiting_input": return "❓ Pekerjaan coding menunggu input";
    default: return "🛠️ Pekerjaan coding sedang berjalan";
  }
}

function groupSafePhase(phase: CodingRun["phase"]): string {
  switch (phase) {
    case "queued": return "Fase: menunggu giliran.";
    case "mapping": return "Fase: membaca struktur project.";
    case "planning": return "Fase: menyusun rencana.";
    case "editing": return "Fase: menerapkan perubahan.";
    case "testing": return "Fase: menjalankan pemeriksaan.";
    case "reviewing": return "Fase: meninjau hasil dan bukti.";
    case "waiting_input": return "Fase: menunggu input yang ditargetkan.";
    case "finalizing": return "Fase: menyimpan revisi project.";
    case "completed": return "Fase: selesai.";
    case "failed": return "Fase: gagal.";
    case "cancelled": return "Fase: dibatalkan.";
  }
}

function groupSafeCheckLabel(kind: GroupSafeCodingCheck["kind"]): string {
  switch (kind) {
    case "test": return "Test";
    case "lint": return "Lint";
    case "typecheck": return "Typecheck";
    case "build": return "Build";
  }
}

function groupSafeCheckStatus(status: GroupSafeCodingCheck["status"]): string {
  switch (status) {
    case "passed": return "lulus";
    case "failed": return "gagal";
    case "stale": return "basi setelah revisi";
    case "infrastructure_error": return "runner tidak tersedia";
  }
}
