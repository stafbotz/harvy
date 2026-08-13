import type { GroupAgentRun, GroupRunInputKind } from "../domain/group-agent-run.js";
import type { GroupMessage } from "../domain/group.js";

export type GroupRunTargetKind =
  | "none"
  | "anchor"
  | "assigned-question"
  | "explicit-reference"
  | "privileged-command";

export type GroupRunPolicyDecision =
  | { relation: "independent_chat"; target: "none" }
  | { relation: "status_query"; target: Exclude<GroupRunTargetKind, "none"> }
  | {
      relation: "forbidden";
      target: Exclude<GroupRunTargetKind, "none">;
      reason:
        | "run_terminal"
        | "initiator_or_admin_required"
        | "assigned_to_other_participant"
        | "admin_override_must_be_explicit";
    }
  | {
      relation: "mutation";
      target: Exclude<GroupRunTargetKind, "none">;
      kind: GroupRunInputKind;
      disposition: "applied" | "proposal";
      questionId: string | null;
      assignedOverride: boolean;
    };

export interface GroupRunPolicyInput {
  message: Pick<
    GroupMessage,
    | "participantId"
    | "participantAliases"
    | "text"
    | "mentionsHarvy"
    | "quotedMessageId"
  > & Partial<Pick<GroupMessage, "parts">>;
  run: GroupAgentRun;
  role: "member" | "admin";
}

/**
 * Targeting selalu lokal dan closed-set. Mention Harvy saja tidak cukup:
 * pesan juga harus menyebut run/pekerjaan/rencana yang aktif.
 */
export function groupRunTarget(
  message: GroupRunPolicyInput["message"],
  run: GroupAgentRun,
  privileged: boolean,
): GroupRunTargetKind {
  if ((message.parts?.length ?? 0) > 1) return "none";
  const quoted = message.quotedMessageId ?? null;
  if (quoted && run.questions.some((question) => question.messageId === quoted)) {
    return "assigned-question";
  }
  if (quoted && quoted === run.anchor.messageId) return "anchor";

  const text = normalize(message.text);
  if (message.mentionsHarvy && hasExplicitRunReference(text)) {
    return "explicit-reference";
  }
  if (privileged && isExplicitPrivilegedCommand(text)) {
    return "privileged-command";
  }
  return "none";
}

export function decideGroupRunInput(
  input: GroupRunPolicyInput,
): GroupRunPolicyDecision {
  const initiator = participantMatches(
    input.message.participantId,
    input.message.participantAliases,
    input.run.initiator,
  );
  const privileged = initiator || input.role === "admin";
  const target = groupRunTarget(input.message, input.run, privileged);
  if (target === "none") {
    return { relation: "independent_chat", target };
  }

  const text = normalize(input.message.text);
  if (isStatusQuery(text)) return { relation: "status_query", target };
  if (isUnsupportedLifecycleCommand(text)) {
    return { relation: "independent_chat", target: "none" };
  }
  if (isTerminal(input.run)) {
    return { relation: "forbidden", target, reason: "run_terminal" };
  }

  if (isCancellation(text)) {
    if (!privileged) {
      return {
        relation: "forbidden",
        target,
        reason: "initiator_or_admin_required",
      };
    }
    return {
      relation: "mutation",
      target,
      kind: "cancel",
      disposition: "applied",
      questionId: null,
      assignedOverride: false,
    };
  }

  const open = openQuestion(input.run);
  const quotedQuestion = input.message.quotedMessageId
    ? input.run.questions.find((candidate) =>
        candidate.messageId === input.message.quotedMessageId
      ) ?? null
    : null;
  const assigned = open
    ? participantMatches(
        input.message.participantId,
        input.message.participantAliases,
        open.assignee,
      )
    : false;
  const anchorAnswer = target === "anchor" && open &&
    !isCorrectionOrScopeChange(text) &&
    (assigned || (input.role === "admin" && isExplicitAssignedOverride(text)));
  const question = target === "assigned-question"
    ? quotedQuestion?.status === "open" && !isCorrectionOrScopeChange(text)
      ? quotedQuestion
      : null
    : anchorAnswer ? open : null;
  if (
    target === "assigned-question" && quotedQuestion?.status !== "open"
  ) {
    return { relation: "independent_chat", target: "none" };
  }
  if (question) {
    if (assigned) {
      if (!isExplicitAssignedAnswer(text)) {
        return { relation: "independent_chat", target: "none" };
      }
      return {
        relation: "mutation",
        target,
        kind: "answer",
        disposition: "applied",
        questionId: question.questionId,
        assignedOverride: false,
      };
    }
    if (input.role !== "admin") {
      return {
        relation: "forbidden",
        target,
        reason: "assigned_to_other_participant",
      };
    }
    if (!isExplicitAssignedOverride(text)) {
      return {
        relation: "forbidden",
        target,
        reason: "admin_override_must_be_explicit",
      };
    }
    if (!isExplicitAssignedAnswer(text)) {
      return { relation: "independent_chat", target: "none" };
    }
    return {
      relation: "mutation",
      target,
      kind: "answer",
      disposition: "applied",
      questionId: question.questionId,
      assignedOverride: true,
    };
  }

  const kind = classifyMutationKind(text);
  const disposition = kind === "self_info" || privileged
    ? "applied"
    : "proposal";
  return {
    relation: "mutation",
    target,
    kind,
    disposition,
    questionId: null,
    assignedOverride: false,
  };
}

function classifyMutationKind(text: string): GroupRunInputKind {
  if (/\b(?:ralat|koreksi|maksud(?:ku| saya)|bukan|ubah tujuan|ganti tujuan)\b/iu.test(text)) {
    return "correction";
  }
  if (/\b(?:sekalian|tambahkan|tambah|juga sertakan|masukkan juga|perluas)\b/iu.test(text)) {
    return "scope_change";
  }
  if (isExplicitSelfInfo(text)) {
    return "self_info";
  }
  return "constraint";
}

function isExplicitSelfInfo(text: string): boolean {
  if (/\b(?:menetapkan|menentukan|memutuskan|mewajibkan|melarang|mengubah|mengganti|deadline|tujuan|scope|kelompok|grup)\b/iu.test(text)) {
    return false;
  }
  return /^(?:aku|saya|gue|gw)\s+(?:(?:cuma|hanya|masih|sudah|udah)\s+)?(?:tidak bisa|tak bisa|nggak bisa|gak bisa|ga bisa|bisa|kosong|sibuk|tersedia|available|berhalangan)(?:\s+(?:(?:hari\s+)?(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu)|pagi|siang|sore|malam|besok|lusa|jam\s*\d{1,2}(?::\d{2})?|setelah\s+jam\s*\d{1,2}(?::\d{2})?|sebelum\s+jam\s*\d{1,2}(?::\d{2})?|tanggal\s+\d{1,2})(?:\s+(?:pagi|siang|sore|malam|jam\s*\d{1,2}(?::\d{2})?))?)?[.!]*$/iu
    .test(text) ||
    /^(?:aku|saya|gue|gw)\s+(?:ada (?:kelas|ujian|latihan|acara|jadwal)|punya jadwal)(?:\s+(?:(?:hari\s+)?(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu)|pagi|siang|sore|malam|besok|lusa|jam\s*\d{1,2}(?::\d{2})?))?[.!]*$/iu
      .test(text) ||
    /^(?:jadwal|waktu|ketersediaan)(?:ku| saya| gue)\s*[:,-]\s*(?:kosong|sibuk|tersedia|tidak tersedia|senin|selasa|rabu|kamis|jumat|sabtu|minggu)(?:\s+(?:pagi|siang|sore|malam|jam\s*\d{1,2}(?::\d{2})?))?[.!]*$/iu
      .test(text);
}

function isCorrectionOrScopeChange(text: string): boolean {
  return /\b(?:ralat|koreksi|maksud(?:ku| saya)|bukan|ubah tujuan|ganti tujuan|sekalian|tambahkan|tambah|juga sertakan|masukkan juga|perluas)\b/iu
    .test(text);
}

function hasExplicitRunReference(text: string): boolean {
  return /\b(?:run|pekerjaan|kerjaan|rencana|jadwal|tugas)\s+(?:ini|itu|yang (?:aktif|tadi))\b/iu
    .test(text) ||
    /\b(?:run|pekerjaan|kerjaan)\s+aktif\b/iu.test(text);
}

function isExplicitPrivilegedCommand(text: string): boolean {
  return isStatusQuery(text) ||
    /^(?:tolong\s+)?(?:batalkan|batal|hentikan|stop)\s+(?:run|pekerjaan|kerjaan|rencana)(?:\s+(?:ini|yang tadi))?[.!?]*$/iu
      .test(text);
}

function isExplicitAssignedAnswer(text: string): boolean {
  const answer = text.replace(
    /^(?:sebagai admin[, :]*)?(?:override|jawaban override)\s*[:,-]\s*/iu,
    "",
  );
  if (
    /[?？]/u.test(answer) ||
    /\b(?:belum tahu|belum tau|tidak tahu|nggak tahu|gak tahu|ga tahu|cek dulu|nanti (?:ku)?kabar(?:i)?|sebentar|mungkin|kayaknya|sepertinya|jelasin|jelaskan|maksud(?:nya)?|atau)\b/iu
      .test(answer)
  ) {
    return false;
  }
  const subject = "(?:(?:aku|saya|gue|gw)\\s+)?";
  const availability = "(?:iya|ya|bisa|tidak bisa|tak bisa|nggak bisa|gak bisa|ga bisa|kosong|sibuk|tersedia|available|berhalangan|setuju|tidak setuju|nggak setuju|gak setuju)";
  const time = "(?:(?:hari\\s+)?(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu)|pagi|siang|sore|malam|besok|lusa|jam\\s*\\d{1,2}(?::\\d{2})?)";
  return new RegExp(
    `^${subject}${availability}(?:\\s+${time})?[.!]*$`,
    "iu",
  ).test(answer) || new RegExp(
    `^${subject}${time}(?:\\s+${time})?\\s+${availability}[.!]*$`,
    "iu",
  ).test(answer);
}

function isStatusQuery(text: string): boolean {
  return /^(?:(?:harvy[, ]+)?(?:udah|sudah|sekarang)\s+)?(?:sampai mana|status(?:nya)?(?: apa)?|gimana (?:status|progres)(?:nya)?|progress(?:nya)?(?: gimana)?|progres(?:nya)?(?: gimana)?)(?:\s+(?:run|pekerjaan|kerjaan|rencana)(?:\s+(?:ini|yang tadi))?)?[?.!]*$/iu
    .test(text);
}

function isUnsupportedLifecycleCommand(text: string): boolean {
  return /^(?:tolong\s+)?(?:jeda|pause|lanjutkan|resume)\s+(?:run|pekerjaan|kerjaan|rencana)(?:\s+(?:ini|yang tadi))?[.!?]*$/iu
    .test(text);
}

function isCancellation(text: string): boolean {
  return /^(?:tolong\s+)?(?:stop|hentikan|batal(?:kan|in)?|gausah|gak usah|nggak usah)(?:\s+(?:run|pekerjaan|kerjaan|rencana)(?:\s+(?:ini|yang tadi))?)?[!. ]*$/iu
    .test(text);
}

function isExplicitAssignedOverride(text: string): boolean {
  return /^(?:sebagai admin[, :]*)?(?:override|jawaban override)\s*[:,-]/iu
    .test(text);
}

function participantMatches(
  participantId: string,
  aliases: readonly string[],
  target: { participantId: string; identityAliases: readonly string[] },
): boolean {
  const actor = new Set([participantId, ...aliases]);
  return [target.participantId, ...target.identityAliases].some((identity) =>
    actor.has(identity)
  );
}

function openQuestion(run: GroupAgentRun) {
  return run.questions.find((question) => question.status === "open") ?? null;
}

function isTerminal(run: GroupAgentRun): boolean {
  return run.status === "completed" || run.status === "partial" ||
    run.status === "failed" || run.status === "cancelled";
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("id-ID").replace(/\s+/gu, " ").trim();
}
