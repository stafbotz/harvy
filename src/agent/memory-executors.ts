import {
  HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT,
  type HistorySearchOptions,
} from "../core/history-search.js";
import type { HistoricalEpisodeMatch } from "../domain/history.js";
import type { MemoryItem, MemoryKind, NewMemory } from "../domain/memory.js";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";
import { MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS } from "../harness/agent-harness.js";
import type { PrivateAgentScope } from "../harness/scope.js";

const MAX_QUERY_CHARACTERS = 300;
const MAX_HISTORY_MATCHES = 6;
/**
 * Sengaja sama dengan `HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT`.
 *
 * Sebelumnya 4, sementara pencariannya sendiri sudah memilih 6 klaim terbaik
 * per episode. Selisih dua itu memotong justru bagian yang paling sering
 * ditanyakan: pengukuran 29 Agustus 2026 menunjukkan klaim `unresolved`
 * ("belum tahu apakah soalnya pilihan ganda atau uraian") jatuh di urutan
 * keempat ke bawah, sehingga jawaban Harvy benar soal topik dan tanggal tetapi
 * meleset pada hal yang benar-benar ditanyakan.
 *
 * Menyamakannya menambah dua klaim pendek per episode, bukan mekanisme baru.
 */
const MAX_CLAIMS_PER_MATCH = HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT;
const MAX_NOTE_CHARACTERS = 300;
const MAX_LISTED_NOTES = 32;

/**
 * Jenis catatan yang boleh ditulis model.
 *
 * `personal` sengaja tidak ada di sini. Konstitusi menuntut curhat tidak
 * disimpan diam-diam, dan `MemoryService` memang menolaknya tanpa
 * `sensitiveConsent`. Menyertakannya di schema hanya akan membuat model
 * mencobanya lalu menerima penolakan yang tidak dapat ia perbaiki.
 */
const WRITABLE_NOTE_KINDS: readonly MemoryKind[] = [
  "profile",
  "preference",
  "routine",
  "context",
];

const HISTORY_SEARCH_NATIVE_TOOL = {
  name: "harvy_history_search_v1",
  // Peringkat leksikal berarti percakapan bertema lain ikut muncul hanya
  // karena berbagi satu kata. Probe 2026-08-29: pencarian soal ujian biologi
  // mengembalikan juga obrolan jam tidur, dan model menjawab bahwa hal yang
  // belum jelas soal ujian itu adalah jam tidur yang berantakan—dua percakapan
  // berbeda dijahit menjadi satu ingatan yang tidak pernah terjadi.
  //
  // Kalimatnya sengaja bebas kosakata internal. Versi sebelumnya menyebut
  // "episode" dua kali dan "episodeId" sekali, dan itu justru memberi model
  // contoh kata yang dilarang dipakai di jawabannya oleh aturan planner. Yang
  // dilarang tidak boleh muncul di tempat model membacanya.
  description:
    "Cari percakapan lama pemilik scope ini berdasarkan kata kunci. Sumbernya hanya riwayat Harvy sendiri, bukan web atau aplikasi lain. Hasilnya diurutkan berdasarkan kecocokan kata, jadi obrolan yang tidak berkaitan bisa ikut muncul: nomor sumber membedakannya, dan isi dari dua sumber berbeda tidak boleh digabung menjadi satu ingatan.",
  inputSchema: objectSchema({
    query: {
      type: "string",
      minLength: 2,
      maxLength: MAX_QUERY_CHARACTERS,
      // Pencariannya leksikal atas teks klaim episode, bukan semantik. Probe
      // 2026-08-29 memperlihatkan akibatnya: query "ujian biologi" saja
      // mengembalikan topik, fakta, dan penanda waktu, tetapi bukan klaim
      // `unresolved` yang justru ditanyakan—dan model menjawab dari yang ada
      // sambil terdengar seperti mengingat. Menyertakan kata pengguna sendiri
      // mengubah hasilnya: dengan "belum jelas" di dalam query, klaim itu ikut
      // terambil.
      description:
        "Kata kunci pencarian dalam bahasa pengguna. Sertakan kata yang dipakai pengguna untuk menyebut hal yang dicarinya, bukan hanya topiknya.",
    },
    aspect: {
      type: "string",
      maxLength: MAX_QUERY_CHARACTERS,
      description:
        "Kata pengguna untuk menyebut jenis hal yang dicari, bukan topiknya. Contoh: \"belum jelas\", \"keputusan\", \"janji\", \"koreksi\". Isi bila pengguna menyebutnya; ini yang menentukan bagian mana dari percakapan lama yang diangkat.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_HISTORY_MATCHES,
      description: "Jumlah maksimum episode yang dikembalikan.",
    },
  }, ["query"]),
} satisfies AgentNativeToolDefinition;

const MEMORY_LIST_NATIVE_TOOL = {
  name: "harvy_memory_list_v1",
  description:
    "Baca seluruh catatan durable yang Harvy simpan tentang pemilik scope ini.",
  inputSchema: objectSchema({
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LISTED_NOTES,
      description: "Jumlah maksimum catatan yang dikembalikan.",
    },
  }),
} satisfies AgentNativeToolDefinition;

/**
 * Tool tulis catatan durable.
 *
 * Sebelum ini satu-satunya jalur penyimpanan adalah kandidat yang diusulkan
 * classifier `understand()` pada tiap giliran. Model tidak pernah dapat
 * memutuskan sendiri bahwa sesuatu layak diingat, dan tidak pernah menerima
 * bukti bahwa penyimpanannya berhasil. Executor ini memberi jalur langsung yang
 * hasilnya berupa observation, bukan klaim di teks balasan.
 */
const MEMORY_REMEMBER_NATIVE_TOOL = {
  name: "harvy_memory_remember_v1",
  // Larangan menulis ulang ditambahkan 29 Agustus 2026 dari kejadian nyata:
  // dalam satu run, planner memanggil tool ini pada langkah 1 dan langkah 2
  // untuk fakta yang sama, tampaknya untuk memperbaiki kata yang keliru pada
  // tulisan pertama. Keduanya mendarat. Dedupe `MemoryService` hanya
  // membandingkan isi persis, jadi dua kalimat yang berbeda satu kata lolos
  // berdua dan pengguna melihat catatan kembar di daftar memorinya.
  description:
    "Simpan satu catatan durable tentang pemilik scope. Tulis satu kalimat pendek dan faktual, bukan salinan percakapan. Satu fakta cukup disimpan sekali per giliran: jika kamu sudah menyimpannya di langkah sebelumnya, jangan menulis ulang walau ingin memperbaiki kalimatnya.",
  inputSchema: objectSchema({
    kind: {
      type: "string",
      enum: [...WRITABLE_NOTE_KINDS],
      description:
        "profile untuk identitas stabil, preference untuk cara ditemani, routine untuk kebiasaan, context untuk keadaan yang akan usang.",
    },
    content: {
      type: "string",
      minLength: 3,
      maxLength: MAX_NOTE_CHARACTERS,
      description: "Satu kalimat catatan dalam bahasa pengguna.",
    },
  }, ["kind", "content"]),
} satisfies AgentNativeToolDefinition;

/** Irisan `HistoryService` yang benar-benar dipakai tool ini. */
export interface AgentHistorySearch {
  search(
    ownerId: string,
    query: string,
    options?: HistorySearchOptions,
  ): Promise<HistoricalEpisodeMatch[]>;
}

/** Irisan `MemoryService` yang benar-benar dipakai tool ini. */
export interface AgentMemoryStore {
  remember(input: NewMemory): Promise<MemoryItem | null>;
  list(ownerId: string): Promise<MemoryItem[]>;
}

/** Consent onboarding adalah authority penyimpanan pada ruang privat. */
export interface AgentConsentReader {
  needsOnboarding(ownerId: string): Promise<boolean>;
}

export interface MemoryAgentDependencies {
  /**
   * Diselesaikan saat tool dipanggil. `HistoryService` dibentuk setelah
   * `Conversation` karena peringkasnya memanggil model, sehingga executor tidak
   * dapat memegang instance-nya pada waktu composition.
   */
  history: () => AgentHistorySearch;
  memories: AgentMemoryStore;
  profiles: AgentConsentReader;
}

export function createMemoryAgentExecutors(
  dependencies: MemoryAgentDependencies,
): AgentCapabilityExecutor[] {
  return [
    new HistorySearchExecutor(dependencies.history, dependencies.profiles),
    new MemoryListExecutor(dependencies.memories, dependencies.profiles),
    new MemoryRememberExecutor(dependencies.memories, dependencies.profiles),
  ];
}

interface HistorySearchInput {
  query: string;
  limit: number;
  aspect?: string;
}

export class HistorySearchExecutor
implements AgentCapabilityExecutor<HistorySearchInput> {
  readonly capabilityId = "history.search";
  readonly capabilityVersion = "1";
  readonly nativeTool = HISTORY_SEARCH_NATIVE_TOOL;

  constructor(
    private readonly history: () => AgentHistorySearch,
    private readonly profiles: AgentConsentReader,
  ) {}

  validate(input: unknown) {
    if (!isExactRecord(input, ["query"], ["aspect", "limit"])) {
      return {
        ok: false as const,
        reason: "Input hanya boleh memuat query, aspect, dan limit opsional.",
      };
    }
    if (input.aspect !== undefined && typeof input.aspect !== "string") {
      return { ok: false as const, reason: "aspect harus berupa string." };
    }
    if (typeof input.query !== "string") {
      return { ok: false as const, reason: "query harus berupa string." };
    }
    const query = boundedUserText(input.query, MAX_QUERY_CHARACTERS);
    if (query.length < 2) {
      return { ok: false as const, reason: "query terlalu pendek." };
    }
    const limit = input.limit === undefined ? 4 : input.limit;
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > MAX_HISTORY_MATCHES
    ) {
      return {
        ok: false as const,
        reason: `limit harus bilangan 1–${MAX_HISTORY_MATCHES}.`,
      };
    }
    const aspect = input.aspect === undefined
      ? undefined
      : boundedUserText(input.aspect, MAX_QUERY_CHARACTERS);
    return {
      ok: true as const,
      value: {
        query,
        limit: limit as number,
        ...(aspect ? { aspect } : {}),
      },
    };
  }

  async execute(
    input: HistorySearchInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = await consentedPrivateScope(context, this.profiles);
    if (!scope.ok) return scope.result;
    const matches = await this.history().search(
      scope.value.userId,
      input.query,
      {
        limit: input.limit,
        ...(input.aspect ? { aspect: input.aspect } : {}),
      },
    );
    // Nomor urut, bukan identifier. Model hanya perlu membedakan sumber, dan
    // `episodeId` sungguhan berawalan `episode_`—kata yang dilarang muncul di
    // jawaban, tetapi dulu terbaca model pada setiap hasil pencarian. Melarang
    // sebuah kata sambil menyodorkannya adalah aturan yang tidak dapat
    // dipatuhi.
    const visible = matches.slice(0, input.limit).map((match, index) => ({
      sumber: index + 1,
      createdAt: match.createdAt,
      claims: match.claims.slice(0, MAX_CLAIMS_PER_MATCH).map((claim) => ({
        field: claim.field,
        text: boundedUserText(claim.text, MAX_NOTE_CHARACTERS),
      })),
    }));
    return collectionSummary({
      kind: "history.search.result",
      source: "harvy_conversation_history",
      externalSearch: false,
      // Isi ringkasan ditulis model peringkas dari giliran pengguna. Ia bahan
      // ingatan, bukan bukti bahwa isinya benar.
      trust: "user-authored-data",
      query: input.query,
      total: matches.length,
    }, "matches", visible, matches.length > input.limit);
  }
}

export class MemoryListExecutor
implements AgentCapabilityExecutor<{ limit: number }> {
  readonly capabilityId = "memory.list";
  readonly capabilityVersion = "1";
  readonly nativeTool = MEMORY_LIST_NATIVE_TOOL;

  constructor(
    private readonly memories: AgentMemoryStore,
    private readonly profiles: AgentConsentReader,
  ) {}

  validate(input: unknown) {
    if (!isExactRecord(input, [], ["limit"])) {
      return { ok: false as const, reason: "Input hanya boleh memuat limit opsional." };
    }
    const limit = input.limit === undefined ? MAX_LISTED_NOTES : input.limit;
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > MAX_LISTED_NOTES
    ) {
      return {
        ok: false as const,
        reason: `limit harus bilangan 1–${MAX_LISTED_NOTES}.`,
      };
    }
    return { ok: true as const, value: { limit: limit as number } };
  }

  async execute(
    input: { limit: number },
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = await consentedPrivateScope(context, this.profiles);
    if (!scope.ok) return scope.result;
    const notes = await this.memories.list(scope.value.userId);
    return collectionSummary({
      kind: "memory.list.result",
      trust: "user-authored-data",
      total: notes.length,
    }, "notes", notes.slice(0, input.limit).map(publicNote),
      notes.length > input.limit);
  }
}

interface MemoryRememberInput {
  kind: MemoryKind;
  content: string;
}

export class MemoryRememberExecutor
implements AgentCapabilityExecutor<MemoryRememberInput> {
  readonly capabilityId = "memory.remember";
  readonly capabilityVersion = "1";
  readonly nativeTool = MEMORY_REMEMBER_NATIVE_TOOL;

  constructor(
    private readonly memories: AgentMemoryStore,
    private readonly profiles: AgentConsentReader,
  ) {}

  validate(input: unknown) {
    if (!isExactRecord(input, ["kind", "content"])) {
      return {
        ok: false as const,
        reason: "Input hanya boleh memuat kind dan content.",
      };
    }
    if (
      typeof input.kind !== "string" ||
      !WRITABLE_NOTE_KINDS.includes(input.kind as MemoryKind)
    ) {
      return {
        ok: false as const,
        reason: `kind harus salah satu dari ${WRITABLE_NOTE_KINDS.join(", ")}. Catatan sensitif tidak dapat disimpan lewat tool.`,
      };
    }
    if (typeof input.content !== "string") {
      return { ok: false as const, reason: "content harus berupa string." };
    }
    const content = boundedUserText(input.content, MAX_NOTE_CHARACTERS);
    if (content.length < 3) {
      return { ok: false as const, reason: "content terlalu pendek." };
    }
    return {
      ok: true as const,
      value: { kind: input.kind as MemoryKind, content },
    };
  }

  async execute(
    input: MemoryRememberInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const scope = await consentedPrivateScope(context, this.profiles);
    if (!scope.ok) return scope.result;
    const ownerId = scope.value.userId;
    // `sensitiveConsent` sengaja tidak pernah diisi di sini. Authority itu milik
    // boundary adapter yang benar-benar melihat jawaban pengguna.
    const stored = await this.memories.remember({
      ownerId,
      kind: input.kind,
      content: input.content,
    });
    if (stored) {
      return okSummary({
        kind: "memory.remember.result",
        changed: true,
        note: publicNote(stored),
      });
    }
    // `remember` mengembalikan null untuk beberapa sebab yang berbeda maknanya
    // bagi pengguna. Model perlu tahu yang mana supaya balasannya jujur.
    const existing = await this.memories.list(ownerId);
    const duplicate = existing.find(
      (note) =>
        note.content.toLocaleLowerCase("id-ID") ===
          input.content.toLocaleLowerCase("id-ID"),
    );
    if (duplicate) {
      return okSummary({
        kind: "memory.remember.result",
        changed: false,
        reason: "already_known",
        note: publicNote(duplicate),
      });
    }
    return errorSummary(
      "memory.remember.not_applied",
      "Catatan itu tidak disimpan. Penyebab yang mungkin: isinya menyerupai credential, penyimpanan memori penuh, atau penyimpanan sedang diblokir. Jangan menyatakan sudah mengingatnya.",
    );
  }
}

function publicNote(note: MemoryItem) {
  return {
    id: note.id,
    kind: note.kind,
    content: boundedUserText(note.content, MAX_NOTE_CHARACTERS),
    createdAt: note.createdAt,
    expiresAt: note.expiresAt,
  };
}

/**
 * Ruang privat saja, dan hanya setelah consent onboarding aktif.
 *
 * Gerbang consent adapter berada jauh dari executor, jadi pemeriksaannya
 * diulang di sini. Gagal tertutup: kalau statusnya tidak dapat dibaca, tool
 * tidak menulis dan tidak membaca apa pun.
 */
async function consentedPrivateScope(
  context: AgentExecutionContext,
  profiles: AgentConsentReader,
): Promise<
  | { ok: true; value: PrivateAgentScope }
  | { ok: false; result: AgentExecutorResult }
> {
  if (context.scope.kind !== "private") {
    return {
      ok: false,
      result: errorSummary(
        "memory_tool.denied",
        "Tool catatan dan riwayat hanya tersedia pada ruang privat Harvy.",
      ),
    };
  }
  const scope = context.scope;
  try {
    if (await profiles.needsOnboarding(scope.userId)) {
      return {
        ok: false,
        result: errorSummary(
          "memory_tool.denied",
          "Persetujuan penyimpanan belum aktif untuk pengguna ini.",
        ),
      };
    }
  } catch {
    return {
      ok: false,
      result: {
        status: "unknown",
        summary: JSON.stringify({
          kind: "memory_tool.unknown",
          changed: false,
          reason: "Status persetujuan tidak dapat dibaca; tidak ada yang dibaca atau ditulis.",
        }),
      },
    };
  }
  return { ok: true, value: scope };
}

function errorSummary(kind: string, reason: string): AgentExecutorResult {
  return {
    status: "error",
    summary: JSON.stringify({ kind, changed: false, reason }),
  };
}

function okSummary(value: unknown): AgentExecutorResult {
  const summary = JSON.stringify(value);
  return summary.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS
    ? { status: "ok", summary }
    : {
        status: "ok",
        summary: JSON.stringify({
          kind: "memory_tool.result",
          truncated: true,
          reason: "result_exceeded_observation_budget",
        }),
      };
}

function collectionSummary(
  base: Record<string, unknown>,
  field: string,
  items: readonly unknown[],
  sourceTruncated: boolean,
): AgentExecutorResult {
  const included: unknown[] = [];
  for (const item of items) {
    const candidate = {
      ...base,
      returned: included.length + 1,
      truncated: sourceTruncated || included.length + 1 < items.length,
      [field]: [...included, item],
    };
    if (JSON.stringify(candidate).length > MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
      break;
    }
    included.push(item);
  }
  return okSummary({
    ...base,
    returned: included.length,
    truncated: sourceTruncated || included.length < items.length,
    [field]: included,
  });
}

function boundedUserText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function isExactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}
