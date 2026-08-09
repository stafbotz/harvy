import type { ActiveAgentRun } from "../domain/agent-run.js";

const PHASE_COPY: Record<ActiveAgentRun["phase"], string> = {
  queued: "menyiapkan pekerjaan",
  reading_context: "membaca konteks yang relevan",
  planning: "menyusun pilihan",
  replanning: "menyesuaikan perubahanmu",
  checking: "memeriksa hasil yang sudah ada",
  waiting_input: "menunggu jawabanmu",
  finalizing: "menyiapkan hasil untuk dikirim",
  completed: "selesai",
  failed: "berhenti karena ada kendala",
  cancelled: "dibatalkan",
};

const STATUS_COPY: Record<ActiveAgentRun["status"], string> = {
  queued: "🟡 Menunggu giliran kerja",
  running: "🟡 Sedang dikerjakan",
  waiting_input: "🔵 Perlu jawabanmu",
  paused: "🟠 Dijeda dengan aman",
  completed: "🟢 Selesai",
  partial: "🟠 Selesai sebagian",
  failed: "🔴 Berhenti",
  cancelled: "⚪ Dibatalkan",
};

const MAX_RUN_ANCHOR_CHARACTERS = 3_900;

export function renderRunAnchor(run: ActiveAgentRun): string {
  const lines = [
    `📌 ${runTitle(run.initialRequest)}`,
    STATUS_COPY[run.status],
    "",
    `Sekarang: ${PHASE_COPY[run.phase]}`,
  ];
  const work = workSummary(run);
  if (work) lines.push(`Pekerjaan: ${work}`);
  lines.push(`Perubahan terakhir: ${lastChange(run)}`);
  if (run.status === "waiting_input" && run.pendingQuestion) {
    lines.push("", run.pendingQuestion.prompt);
  }
  if (run.status === "partial" || run.status === "failed") {
    lines.push("", runFailureCopy(run));
  }
  if (!isTerminal(run)) {
    lines.push(
      "",
      "Kamu tetap bisa ngobrol. Balas pesan ini kalau ingin mengubah pekerjaan ini.",
    );
  }
  const rendered = lines.join("\n");
  return rendered.length <= MAX_RUN_ANCHOR_CHARACTERS
    ? rendered
    : `${rendered.slice(0, MAX_RUN_ANCHOR_CHARACTERS - 1).trimEnd()}…`;
}

export function runUpdateAcknowledgement(
  relation: "run_constraint" | "correction" | "scope_expansion" | "answer_to_run",
): string {
  switch (relation) {
    case "correction":
      return "Oke, koreksinya masuk. Hasil dari instruksi lama tidak akan kukirim sebagai hasil terbaru.";
    case "scope_expansion":
      return "Oke, tambahan scope-nya masuk. Aku menyesuaikan pekerjaan yang masih aktif.";
    case "answer_to_run":
      return "Sip, jawabanmu sudah terikat ke pertanyaan pekerjaan tadi. Aku lanjutkan dari checkpoint-nya.";
    case "run_constraint":
      return "Oke, batasan barunya masuk. Aku akan memakainya sebelum hasil dikirim.";
  }
}

export function runCancellationAcknowledgement(committedEffects: number): string {
  return committedEffects > 0
    ? "Pekerjaannya kubatalkan. Ada efek yang sudah sempat terkirim sebelum pembatalan; aku tidak akan berpura-pura efek itu terurungkan."
    : "Pekerjaannya kubatalkan sebelum hasil baru dikirim.";
}

export function runMailboxCapacityNotice(): string {
  return "Perubahan ini belum masuk karena terlalu banyak update run yang belum diproses. Tunggu status pekerjaan bergerak, lalu kirim lagi perubahan ini.";
}

export function runFailureCopy(run: ActiveAgentRun): string {
  if (run.status === "partial") {
    return "Sebagian pekerjaan sempat berjalan, tetapi hasil pengiriman terakhir tidak dapat dipastikan. Aku tidak akan mengirim ulang otomatis karena itu bisa menduplikasi hasil.";
  }
  return run.lastError?.code === "input_expired"
    ? "Pekerjaan berhenti karena pertanyaan yang dibutuhkan tidak terjawab sebelum checkpoint kedaluwarsa."
    : "Pekerjaan berhenti sebelum menghasilkan jawaban yang dapat dipercaya. Aku tidak akan mengarang hasilnya.";
}

function runTitle(request: string): string {
  const clean = request.replace(/\s+/gu, " ").trim();
  if (clean.length <= 64) return clean;
  return `${clean.slice(0, 61).trimEnd()}…`;
}

function workSummary(run: ActiveAgentRun): string | null {
  if (run.workUnits.length === 0) return null;
  const completed = run.workUnits.filter((unit) => unit.status === "completed").length;
  const active = run.workUnits.filter((unit) => unit.status === "running").length;
  const waiting = run.workUnits.filter((unit) =>
    unit.status === "queued" || unit.status === "waiting"
  ).length;
  const stopped = run.workUnits.filter((unit) =>
    unit.status === "stale" || unit.status === "failed"
  ).length;
  return [
    completed > 0 ? `${completed} selesai` : null,
    active > 0 ? `${active} aktif` : null,
    waiting > 0 ? `${waiting} menunggu` : null,
    stopped > 0 ? `${stopped} dihentikan` : null,
  ].filter((part): part is string => part !== null).join(" · ") || null;
}

function lastChange(run: ActiveAgentRun): string {
  const latest = run.mailbox.at(-1);
  if (!latest) return "belum ada";
  switch (latest.kind) {
    case "constraint":
      return "batasan baru diterima";
    case "correction":
      return "koreksi diterima";
    case "scope_change":
      return "scope ditambah";
    case "answer":
      return "jawaban diterima";
    case "cancel":
      return "pembatalan diterima";
  }
}

function isTerminal(run: ActiveAgentRun): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(run.status);
}
