/**
 * Korpus recall sintetis untuk probe.
 *
 * Tiga capability recall (`history.search`, `memory.list`, `memory.remember`)
 * hanya dapat diukur bila ada sesuatu untuk diingat. Probe tidak boleh
 * menyentuh folder memori nyata maupun riwayat pengguna sungguhan, jadi
 * datanya dibuat di sini: sintetis, deterministik, dan jelas bukan milik siapa
 * pun.
 *
 * `history.search` membaca episode terkompaksi, bukan giliran mentah. Probe
 * satu giliran tidak pernah menjalankan compaction, sehingga tanpa korpus ini
 * pencariannya selalu mengembalikan nol dan tool tersebut tampak tidak berguna
 * padahal belum pernah diberi kesempatan.
 *
 * Semua isi episode di bawah adalah karangan. Jangan menaruh kutipan pengguna
 * nyata di sini.
 */
import { createHash } from "node:crypto";
import {
  EPISODE_SCHEMA_VERSION,
  type ConversationEpisode,
  type EpisodeClaim,
} from "../src/domain/history.js";
import { searchConversationEpisodes } from "../src/core/history-search.js";
import type {
  AgentConsentReader,
  AgentHistorySearch,
  AgentMemoryStore,
} from "../src/agent/memory-executors.js";
import type { MemoryItem, NewMemory } from "../src/domain/memory.js";

/** Versi parser ringkasan, bukan ID model penyedia. */
const SYNTHETIC_SUMMARIZER_VERSION = "probe-sintetis-1";

function claims(...texts: readonly string[]): EpisodeClaim[] {
  return texts.map((text, index) => ({
    text,
    sourceSequences: [index + 1],
  }));
}

function episode(
  episodeId: string,
  createdAt: string,
  fromSequence: number,
  turnCount: number,
  draft: Partial<
    Record<
      | "topics"
      | "facts"
      | "goals"
      | "decisions"
      | "corrections"
      | "commitments"
      | "unresolved"
      | "temporalAnchors"
      | "uncertainties",
      EpisodeClaim[]
    >
  >,
): ConversationEpisode {
  const body = {
    topics: draft.topics ?? [],
    facts: draft.facts ?? [],
    goals: draft.goals ?? [],
    decisions: draft.decisions ?? [],
    corrections: draft.corrections ?? [],
    commitments: draft.commitments ?? [],
    unresolved: draft.unresolved ?? [],
    temporalAnchors: draft.temporalAnchors ?? [],
    uncertainties: draft.uncertainties ?? [],
  };
  return {
    ...body,
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId,
    source: {
      kind: "turn-range",
      fromSequence,
      throughSequence: fromSequence + turnCount - 1,
      turnCount,
      sourceHash: createHash("sha256")
        .update(JSON.stringify([episodeId, body]))
        .digest("hex"),
    },
    summarizerVersion: SYNTHETIC_SUMMARIZER_VERSION,
    createdAt,
  };
}

/**
 * Tiga episode dengan tema berbeda supaya pencarian bisa salah.
 *
 * Korpus satu tema membuat setiap query terlihat berhasil: apa pun yang
 * ditanyakan akan cocok dengan satu-satunya episode yang ada. Tema yang
 * terpisah membuat query yang salah sasaran benar-benar mengembalikan nol,
 * sehingga hasil probe punya arti.
 */
export const SYNTHETIC_EPISODES: readonly ConversationEpisode[] = [
  episode("sintetis-ujian-biologi", "2026-08-14T09:20:00.000Z", 1, 12, {
    topics: claims("Persiapan ujian biologi bab sistem pernapasan"),
    facts: claims(
      "Ujian biologi diadakan hari Rabu pagi di jam pertama",
      "Materi yang diuji hanya bab sistem pernapasan dan peredaran darah",
    ),
    goals: claims("Bisa menjelaskan alur pertukaran gas tanpa membuka catatan"),
    decisions: claims(
      "Belajar bab pernapasan dulu karena soalnya paling banyak",
    ),
    commitments: claims("Membuat ringkasan satu halaman sebelum Selasa malam"),
    unresolved: claims("Belum tahu apakah soalnya pilihan ganda atau uraian"),
    temporalAnchors: claims("Dua minggu sebelum ujian tengah semester"),
  }),
  episode("sintetis-tugas-kelompok", "2026-08-19T13:05:00.000Z", 13, 9, {
    topics: claims("Pembagian tugas presentasi kelompok sejarah"),
    facts: claims(
      "Kelompoknya berisi empat orang dan presentasi dijadwalkan Jumat",
      "Bagian yang dipegang sendiri adalah latar belakang dan kesimpulan",
    ),
    goals: claims("Slide selesai sebelum hari presentasi, bukan malam sebelumnya"),
    decisions: claims("Memakai satu berkas slide bersama supaya versinya tidak pecah"),
    corrections: claims(
      "Awalnya dikira presentasinya Kamis, ternyata Jumat",
    ),
    unresolved: claims("Satu anggota kelompok belum mengirim bagiannya"),
  }),
  episode("sintetis-jam-tidur", "2026-08-23T21:40:00.000Z", 22, 7, {
    topics: claims("Jam tidur yang berantakan menjelang ujian"),
    facts: claims(
      "Beberapa malam terakhir baru tidur lewat pukul dua dini hari",
      "Paginya sulit fokus di dua jam pelajaran pertama",
    ),
    goals: claims("Kembali tidur sebelum tengah malam"),
    decisions: claims("Berhenti belajar pukul sebelas walau materinya belum habis"),
    uncertainties: claims(
      "Belum jelas apakah sulit fokus itu karena kurang tidur atau karena cemas",
    ),
  }),
];

/** Pencarian episode di atas korpus sintetis; kontraknya sama dengan `HistoryService`. */
export function createSyntheticHistorySearch(
  episodes: readonly ConversationEpisode[] = SYNTHETIC_EPISODES,
): AgentHistorySearch {
  return {
    async search(_ownerId, query, options) {
      return searchConversationEpisodes(episodes, query, options ?? {});
    },
  };
}

/**
 * Penyimpan catatan dalam memori proses.
 *
 * `MemoryService` sungguhan menulis Markdown per pengguna, dan probe tidak
 * boleh menyentuh folder memori nyata. Batas yang penting tetap ditegakkan di
 * sini: isi kosong dan duplikat ditolak, dan penolakan dikembalikan sebagai
 * `null` persis seperti service aslinya.
 */
export function createSyntheticMemoryStore(
  notes: MemoryItem[],
  idPrefix = "probe",
): AgentMemoryStore {
  return {
    async remember(input: NewMemory): Promise<MemoryItem | null> {
      const content = input.content.trim();
      if (!content) return null;
      const duplicate = notes.some(
        (note) => note.content.toLowerCase() === content.toLowerCase(),
      );
      if (duplicate) return null;
      const note: MemoryItem = {
        id: `${idPrefix}-${notes.length + 1}`,
        ownerId: input.ownerId,
        kind: input.kind,
        content,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
      };
      notes.push(note);
      return note;
    },
    async list(): Promise<MemoryItem[]> {
      return [...notes];
    },
  };
}

/**
 * Consent yang sudah selesai.
 *
 * Tool catatan gagal tertutup tanpa consent onboarding. Probe memakai profil
 * sintetis, jadi persetujuannya dinyatakan eksplisit alih-alih menumpang
 * keadaan penyimpanan nyata.
 */
export const SYNTHETIC_CONSENT: AgentConsentReader = {
  async needsOnboarding(): Promise<boolean> {
    return false;
  },
};
