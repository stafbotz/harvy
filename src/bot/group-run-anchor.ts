import type { GroupAgentRun } from "../domain/group-agent-run.js";

const STATUS_COPY: Record<GroupAgentRun["status"], string> = {
  queued: "🟡 Menunggu giliran kerja",
  running: "🟡 Sedang dikerjakan",
  waiting_input: "🔵 Menunggu jawaban anggota",
  paused: "🟠 Dijeda dengan aman",
  completed: "🟢 Selesai",
  partial: "🟠 Selesai sebagian",
  failed: "🔴 Berhenti",
  cancelled: "⚪ Dibatalkan",
};

const PHASE_COPY: Record<GroupAgentRun["phase"], string> = {
  queued: "menyiapkan pekerjaan",
  reading_context: "membaca konteks grup yang diizinkan",
  planning: "menyusun pekerjaan",
  replanning: "menyesuaikan input terbaru",
  checking: "memeriksa hasil",
  waiting_input: "menunggu input yang ditugaskan",
  finalizing: "menyiapkan hasil grup",
  completed: "selesai",
  failed: "berhenti karena kendala",
  cancelled: "dibatalkan",
};

const MAX_ANCHOR_CHARACTERS = 3_900;

/** Copy berasal dari state code-owned; tidak memuat ETA/persentase/model. */
export function renderGroupRunAnchor(run: GroupAgentRun): string {
  const initiator = run.initiator.displayName ?? "Anggota grup";
  const applied = run.inputs.filter((input) => input.disposition === "applied").length;
  const proposals = run.inputs.filter((input) => input.disposition === "proposal").length;
  const lines = [
    `📌 ${run.title}`,
    `Diminta oleh: ${initiator}`,
    STATUS_COPY[run.status],
    "",
    `Sekarang: ${PHASE_COPY[run.phase]}`,
  ];
  if (applied > 0 || proposals > 0) {
    lines.push([
      applied > 0 ? `${applied} input diterapkan` : null,
      proposals > 0 ? `${proposals} proposal menunggu keputusan` : null,
    ].filter((part): part is string => part !== null).join(" · "));
  }
  const question = run.questions.find((candidate) => candidate.status === "open");
  if (question) {
    const assignee = question.assignee.displayName ?? "anggota yang ditugaskan";
    lines.push("", `Untuk ${assignee}: ${question.prompt}`);
  }
  if (!isTerminal(run)) {
    lines.push(
      "",
      "Untuk mengubah pekerjaan ini, balas pesan ini atau tag Harvy dan sebut pekerjaan ini.",
    );
  }
  const rendered = lines.join("\n");
  return rendered.length <= MAX_ANCHOR_CHARACTERS
    ? rendered
    : `${rendered.slice(0, MAX_ANCHOR_CHARACTERS - 1).trimEnd()}…`;
}

export function groupRunInputAcknowledgement(
  status: "applied" | "proposed" | "cancelled",
): string {
  if (status === "cancelled") {
    return "Pekerjaan grup ini dibatalkan oleh pihak yang berwenang.";
  }
  if (status === "proposed") {
    return "Usulanmu sudah tercatat dengan atribusi, tetapi belum mengubah instruksi utama.";
  }
  return "Inputmu sudah terikat ke pekerjaan grup yang aktif.";
}

function isTerminal(run: GroupAgentRun): boolean {
  return run.status === "completed" || run.status === "partial" ||
    run.status === "failed" || run.status === "cancelled";
}
