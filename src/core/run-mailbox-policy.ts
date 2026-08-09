import type { ActiveAgentRun, RunMailboxMessageKind } from "../domain/agent-run.js";

export type RunMailboxRelation =
  | "independent_chat"
  | "status_query"
  | "cancel"
  | "run_constraint"
  | "correction"
  | "scope_expansion"
  | "answer_to_run";

export interface RunMailboxRoutingInput {
  text: string;
  run: ActiveAgentRun;
  quotedMessageId?: string | null;
}

/**
 * Closed-set lokal untuk routing run. Ambiguitas selalu tetap menjadi chat;
 * classifier sempit dapat ditambahkan kemudian tanpa menjadikan "next message"
 * sebagai jawaban otomatis.
 */
export function classifyRunMailboxLocally(
  input: RunMailboxRoutingInput,
): RunMailboxRelation {
  const text = normalize(input.text);
  if (!text) return "independent_chat";
  if (isStatusQuery(text)) return "status_query";

  const quoted = input.quotedMessageId ?? null;
  const targetsAnchor = quoted !== null &&
    quoted === input.run.anchor.messageId;
  const targetsQuestion = quoted !== null &&
    quoted === input.run.pendingQuestion?.messageId;
  const explicitTarget = targetsAnchor || targetsQuestion ||
    /^(?:untuk|soal|tentang) (?:pekerjaan|rencana|run) (?:yang )?tadi\b/iu
      .test(text);

  if (isCancellation(text, explicitTarget)) return "cancel";
  if (!explicitTarget) return "independent_chat";
  if (/\b(?:ralat|koreksi|maksud(?:ku| saya)|bukan|jangan|ubah|ganti)\b/iu.test(text)) {
    return "correction";
  }
  if (/\b(?:sekalian|tambahkan|tambah|juga sertakan|masukkan juga)\b/iu.test(text)) {
    return "scope_expansion";
  }
  if (
    input.run.status === "waiting_input" &&
    input.run.pendingQuestion &&
    (targetsQuestion || targetsAnchor)
  ) {
    return "answer_to_run";
  }
  return "run_constraint";
}

export function mailboxKindForRelation(
  relation: RunMailboxRelation,
): RunMailboxMessageKind | null {
  switch (relation) {
    case "cancel":
      return "cancel";
    case "run_constraint":
      return "constraint";
    case "correction":
      return "correction";
    case "scope_expansion":
      return "scope_change";
    case "answer_to_run":
      return "answer";
    case "independent_chat":
    case "status_query":
      return null;
  }
}

function isStatusQuery(text: string): boolean {
  return /^(?:(?:harvy[, ]+)?(?:udah|sudah|sekarang)\s+)?(?:sampai mana|sampai mana\?|udah sampai mana|sudah sampai mana|status(?:nya)?(?: apa)?|gimana (?:status|progres)(?:nya)?|progress(?:nya)?(?: gimana)?|progres(?:nya)?(?: gimana)?)[?.!]*$/iu
    .test(text);
}

function isCancellation(text: string, explicitlyTargetsRun: boolean): boolean {
  if (
    /^(?:stop|berhenti|batal|batalkan|gausah|gak usah|nggak usah)[!. ]*$/iu
      .test(text)
  ) {
    return explicitlyTargetsRun;
  }
  return /^(?:tolong )?(?:stop|hentikan|batal(?:kan|in)?|gausah|gak usah|nggak usah)\s+(?:(?:pekerjaan|rencana|run)(?: (?:yang )?tadi)?|kerjain(?:nya)?)[!. ]*$/iu
    .test(text);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}
