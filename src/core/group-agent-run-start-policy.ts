import type { GroupMessage } from "../domain/group.js";
import { hasExplicitImmediateDangerSignal } from "./safety-policy.js";

const START_PREFIX = /^(?:harvy,\s*)?mulai pekerjaan:\s*(\S[\s\S]*)$/iu;
const START_INTENT_ENVELOPE =
  /\bmulai(?:[\s,:;.!?-]+)pekerjaan\b/iu;
const MAX_START_REQUEST_CHARACTERS = 8_000;

export interface GroupAgentRunStartCommand {
  request: string;
}

/** Karantina bentuk berniat-start yang tidak memenuhi grammar exact. */
export function hasGroupAgentRunStartIntent(text: string): boolean {
  return START_INTENT_ENVELOPE.test(text.trim());
}

/**
 * Grammar start sengaja closed-set. Mention/reply biasa tidak boleh berubah
 * menjadi pekerjaan durable hanya karena model atau heuristic menebak niat.
 */
export function parseGroupAgentRunStart(
  message: Pick<
    GroupMessage,
    | "scope"
    | "text"
    | "mentionsHarvy"
    | "repliesToHarvy"
    | "quotedMessageId"
    | "quotedParticipantId"
    | "ingressRevision"
    | "parts"
  >,
): GroupAgentRunStartCommand | null {
  if (
    message.scope.channel !== "whatsapp" ||
    !Number.isSafeInteger(message.ingressRevision) ||
    (message.ingressRevision ?? 0) <= 0 ||
    !message.mentionsHarvy ||
    message.repliesToHarvy ||
    message.quotedMessageId ||
    message.quotedParticipantId ||
    (message.parts?.length ?? 0) > 1 ||
    hasExplicitImmediateDangerSignal(message.text)
  ) return null;

  const match = START_PREFIX.exec(message.text.trim());
  const request = match?.[1]?.trim() ?? "";
  if (
    !request || request.length > MAX_START_REQUEST_CHARACTERS ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(request) ||
    // Prefix command bukan bagian ujaran bahaya. Periksa payload terpisah agar
    // grammar safety yang berjangkar di awal tetap melihat "aku mau ...".
    hasExplicitImmediateDangerSignal(request)
  ) return null;
  return { request };
}
