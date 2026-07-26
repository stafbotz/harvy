import type { ConversationTurn } from "../domain/history.js";
import type { MemoryItem } from "../domain/memory.js";

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
    context.memories.length === 0
  );
}
