import type { CodingRun } from "../domain/coding-run.js";

export interface CodingRunAnchorView {
  title: string;
  status: string;
  phase: string;
  details: string[];
  text: string;
}

/** User-facing progress is rendered only from durable code-owned facts. */
export function renderCodingRunAnchor(run: CodingRun): CodingRunAnchorView {
  const title = titleFor(run);
  const status = statusFor(run);
  const phase = phaseFor(run.phase);
  const details: string[] = [];
  if (run.instructionRevision > 0) {
    details.push(`Revisi instruksi: ${run.instructionRevision}`);
  }
  if (run.diff) {
    details.push(`${run.diff.files.length} file berubah`);
  }
  const latestValidators = new Map<string, string>();
  for (const receipt of run.validatorReceipts) {
    if (
      receipt.instructionRevision !== run.instructionRevision ||
      !run.diff ||
      receipt.workingSnapshot !== run.diff.workingSnapshot
    ) continue;
    latestValidators.set(receipt.kind, receipt.status);
  }
  for (const [kind, validatorStatus] of latestValidators) {
    details.push(`${validatorLabel(kind)}: ${validatorStatusLabel(validatorStatus)}`);
  }
  if (run.status === "completed" && run.result) {
    details.push(`Snapshot: ${run.result.snapshotId.slice(0, 12)}`);
    details.push("Belum dipush ke GitHub");
  }
  if (run.status === "partial") {
    details.push("Efek commit perlu direkonsiliasi sebelum dilanjutkan");
  }
  const lines = [title, "", status, `Fase: ${phase}`];
  if (details.length > 0) lines.push("", ...details.map((detail) => `• ${detail}`));
  return { title, status, phase, details, text: lines.join("\n") };
}

function titleFor(run: CodingRun): string {
  if (run.status === "completed") return "✅ Coding selesai";
  if (run.status === "cancelled") return "⏹️ Coding dibatalkan";
  if (run.status === "failed" || run.status === "partial") {
    return "⚠️ Coding perlu perhatian";
  }
  if (run.status === "waiting_input") return "❓ Coding menunggu jawaban";
  return "🛠️ Coding sedang berjalan";
}

function statusFor(run: CodingRun): string {
  switch (run.status) {
    case "queued": return "Menunggu giliran kerja.";
    case "running": return "Pekerjaan aktif; chat lain tetap bisa berjalan.";
    case "waiting_input": return "Menunggu input yang terikat ke run ini.";
    case "validating": return "Memeriksa bukti sebelum menyimpan hasil.";
    case "completed": return "Perubahan tersimpan sebagai revision project baru.";
    case "failed": return "Pekerjaan berhenti pada tahap yang tercatat.";
    case "cancelled": return "Pekerjaan dihentikan tanpa publish remote.";
    case "stale": return "Base project berubah; hasil lama tidak diterapkan.";
    case "partial": return "Sebagian efek mungkin sudah terjadi dan tidak diulang otomatis.";
  }
}

function phaseFor(phase: CodingRun["phase"]): string {
  switch (phase) {
    case "queued": return "menunggu";
    case "mapping": return "membaca struktur project";
    case "planning": return "menyusun atau memperbarui rencana";
    case "editing": return "mengubah file";
    case "testing": return "menjalankan pemeriksaan";
    case "reviewing": return "meninjau diff dan bukti";
    case "waiting_input": return "menunggu input";
    case "finalizing": return "menyimpan snapshot terbaru";
    case "completed": return "selesai";
    case "failed": return "gagal";
    case "cancelled": return "dibatalkan";
  }
}

function validatorLabel(kind: string): string {
  switch (kind) {
    case "test": return "Test";
    case "lint": return "Lint";
    case "typecheck": return "Typecheck";
    case "build": return "Build";
    default: return kind;
  }
}

function validatorStatusLabel(status: string): string {
  switch (status) {
    case "passed": return "lulus";
    case "failed": return "gagal";
    case "stale": return "basi setelah revisi";
    case "infrastructure_error": return "runner tidak tersedia";
    default: return status;
  }
}
