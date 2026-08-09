import type { GroupRuntimeMode } from "../domain/control-plane.js";
import type { GroupMessage } from "../domain/group.js";
import { hasExplicitImmediateDangerSignal } from "./safety-policy.js";

export type GroupRuntimeAdmission = "process" | "inactive" | "silent";

/** Gate paket/runtime sebelum pipeline grup menerima isi pesan. */
export function groupRuntimeAdmission(
  mode: GroupRuntimeMode,
  message: Pick<
    GroupMessage,
    "mentionsHarvy" | "repliesToHarvy" | "text" | "parts"
  >,
): GroupRuntimeAdmission {
  if (mode === "disabled") return "inactive";
  if (mode === "paused") return "silent";
  if (
    mode === "direct_only" &&
    !message.mentionsHarvy &&
    !message.repliesToHarvy &&
    !hasExplicitImmediateGroupDanger(message)
  ) {
    return "silent";
  }
  return "process";
}

export function hasExplicitImmediateGroupDanger(
  message: Pick<GroupMessage, "text" | "parts">,
): boolean {
  const texts = message.parts?.length
    ? message.parts.map((part) => part.text)
    : [message.text];
  return texts.some(hasExplicitImmediateDangerSignal);
}
