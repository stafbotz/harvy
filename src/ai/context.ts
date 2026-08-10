import type { ConversationTurn } from "../domain/history.js";
import type { MemoryItem } from "../domain/memory.js";
import type { RetrievedMemoryEvidence } from "../domain/memory-knowledge.js";

/** Scope penyimpanan tidak pernah ikut masuk ke prompt. */
export type HarvyContextMemory = Pick<MemoryItem, "kind" | "content">;

/**
 * Konteks yang dibawa Harvy ke dalam satu giliran percakapan.
 *
 * Tiga lapis, dari yang paling ringkas ke yang paling mentah: ringkasan
 * percakapan lama, beberapa giliran terakhir apa adanya, dan catatan
 * terstruktur tentang penggunanya.
 *
 * Seluruh isinya berasal dari perkataan pengguna sendiri, sehingga ia masuk
 * prompt sebagai data yang tidak tepercaya — lihat `ADR-006` bagian 6.
 */
export interface HarvyContext {
  summary: string | null;
  turns: ConversationTurn[];
  memories: MemoryItem[];
  /** Evidence lama terpilih; tetap terpisah dari user-facing memory. */
  retrieved?: RetrievedMemoryEvidence[];
}

export const EMPTY_CONTEXT: HarvyContext = {
  summary: null,
  turns: [],
  memories: [],
};

export function isEmptyContext(context: HarvyContext): boolean {
  return (
    !context.summary &&
    context.turns.length === 0 &&
    context.memories.length === 0 &&
    (context.retrieved?.length ?? 0) === 0
  );
}
