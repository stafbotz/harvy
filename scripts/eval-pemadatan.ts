import { loadConfig } from "../src/config.js";
import { resolveModel } from "../src/ai/model-policy.js";
import { resolveModelProfile } from "../src/ai/model-profile.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import {
  createConversationEpisode,
  renderEpisodeContext,
} from "../src/core/episodic-compaction.js";
import { Conversation } from "../src/ai/conversation.js";
import { searchConversationEpisodes } from "../src/core/history-search.js";
import {
  COMPACTION_EVAL_TRANSCRIPTS,
  type CompactionEvalQuestion,
  type CompactionEvalTranscript,
} from "./compaction-eval-corpus.js";
import type {
  ConversationEpisode,
  StoredConversationTurn,
} from "../src/domain/history.js";
import {
  HISTORY_COMPACTION_CHUNK_MAX_TURNS,
  HISTORY_WINDOW,
} from "../src/core/history-policy.js";

/**
 * Mengukur apa yang pemadatan episode benar-benar biayai dalam **recall**,
 * bukan hanya dalam token.
 *
 * `eval:conversation` menjawab "apakah Harvy membalas dengan benar". Yang ini
 * menjawab pertanyaan berbeda dan selama ini tidak pernah diukur: sesudah satu
 * percakapan dipadatkan menjadi paling banyak 24 klaim, berapa banyak fakta
 * yang masih dapat diambil kembali dari konteksnya?
 *
 * Bentuknya meniru `hermes/evals/compaction/`, dan empat sifatnya yang
 * membuat angkanya berarti dibawa utuh—AGENTS.md sudah mencatat masalah yang
 * mereka pecahkan: "tiga run penuh pernah memberi 50, 55, dan 53 lulus pada
 * corpus yang sama. Selisih beberapa kasus bukan sinyal."
 *
 * 1. **Bank pertanyaannya tetap.** Ditulis tangan di
 *    `compaction-eval-corpus.ts`, bukan dikarang model tiap run. Varians di
 *    bank dimatikan, bukan dirata-ratakan.
 * 2. **Pertanyaannya menyasar apa yang justru dibuang pemadatan.** Setiap
 *    transkrip memuat lebih banyak fakta persis daripada yang muat di 24
 *    klaim; yang diukur adalah mana yang selamat.
 * 3. **Ada arm kendali.** `utuh` menjawab dari seluruh giliran mentah. Tanpa
 *    langit-langit itu, angka arm lain tidak berarti apa-apa—50% bisa berarti
 *    pemadatan buruk atau pertanyaannya yang memang sulit.
 * 4. **Dua sumbu.** Recall dilaporkan **pada** jumlah karakter konteks, karena
 *    pemadatan yang lebih akurat dengan biaya dua kali lipat bukan kemenangan.
 *
 * Arm `episode+cari` menambahkan hasil `searchConversationEpisodes` ke konteks,
 * karena konteks otomatis sendirian hanya setengah gambar produksi: Harvy juga
 * punya jalur pencarian. Tanpa arm itu, harness melaporkan pemadatan jauh lebih
 * buruk daripada yang benar-benar dialami pengguna.
 *
 * Arm `tanpa-anchor` sempat ada untuk mengisolasi anchor index, lalu dibuang
 * ketika penyuntikan anchor ke konteks dicabut—arm yang tidak lagi mengisolasi
 * apa pun hanya menyesatkan pembacanya.
 *
 * Menghabiskan token sungguhan: satu panggilan peringkas per transkrip, lalu
 * satu panggilan jawab per pertanyaan per arm, plus satu penilai per jawaban.
 *
 * ```bash
 * npx tsx scripts/eval-pemadatan.ts
 * npx tsx scripts/eval-pemadatan.ts --reps=3 --transcript=ujian-biologi
 * npx tsx scripts/eval-pemadatan.ts --arms=utuh,episode --dump
 * ```
 */

type ArmName = "utuh" | "episode" | "episode+cari";
const ALL_ARMS: readonly ArmName[] = ["utuh", "episode", "episode+cari"];

/**
 * Berapa kali seluruh pipa diulang.
 *
 * Run 4 September 2026 menunjukkan kenapa ini wajib ada: transkrip yang sama,
 * arm yang sama, korpus yang sama memberi 6,3% lalu 43,8% pada dua run
 * berurutan. Satu angka dari satu run tidak dapat dibandingkan dengan apa pun.
 * AGENTS.md sudah mencatat masalah yang sama pada `eval:conversation`—"tiga run
 * penuh pernah memberi 50, 55, dan 53 lulus pada corpus yang sama"—dan
 * jawabannya bukan mempercayai satu angka, melainkan melaporkan sebarannya.
 */
const reps = readReps();

const LINE_BREAK = String.fromCharCode(10);
const requestedArms = readArms();
const config = loadConfig();
const client = await createInstrumentedAiClient(config, "evaluation");
// Lewat `Conversation`, bukan client mentah. Jalur produksi mencoba ulang
// peringkasan sampai tiga kali ketika model mengeluarkan JSON yang tidak sah;
// memanggil client langsung berarti mengukur sesuatu yang **lebih buruk**
// daripada yang benar-benar dijalankan Harvy.
const conversation = new Conversation(client, config.ai, config.defaultTimezone);
const model = resolveModel("ambitious", config.ai);
const profile = resolveModelProfile("ambitious", config.ai);
const maxOutputTokens = Math.min(1_024, profile?.maxOutputTokens ?? 1_024);

interface ArmResult {
  arm: ArmName;
  contextCharacters: number;
  scored: number;
  possible: number;
  recallPercent: number;
  wrong: string[];
}

const perTranscript: Array<{
  transcript: string;
  arms: ArmResult[];
}> = [];

/**
 * Memastikan korpusnya masih mengukur pemadatan.
 *
 * `HISTORY_WINDOW` giliran terakhir tidak pernah dipadatkan. Kalau sebuah
 * fakta emas juga diucapkan di sana, pertanyaannya dapat dijawab dari teks
 * mentah dan berhenti mengukur apa pun—arm `episode` akan terlihat bagus tanpa
 * pemadatannya berkontribusi sama sekali. Diperiksa sebelum satu token pun
 * dipakai, karena korpus dapat bergeser diam-diam saat disunting.
 */
function auditKeepWindow(transcript: CompactionEvalTranscript): string[] {
  const tail = transcript.turns
    .slice(-HISTORY_WINDOW)
    .map((item) => item.text)
    .join(" ")
    .toLocaleLowerCase("id-ID");
  const bocor: string[] = [];
  for (const question of transcript.questions) {
    const kata = distinctiveWords(question.gold);
    if (kata.length === 0) continue;
    const cocok = kata.filter((word) => tail.includes(word)).length;
    if (cocok >= Math.ceil(kata.length / 2)) bocor.push(question.id);
  }
  return bocor;
}

/**
 * Konektor yang muncul di hampir setiap kalimat bahasa Indonesia.
 *
 * Versi pertama penjaga ini menghitungnya sebagai fakta, lalu menandai
 * "Bab 7 sampai bab 9" bocor karena penutup percakapan berbunyi "Sampai
 * nanti." Penjaga yang salah tuduh sama merugikannya dengan penjaga yang
 * tidak ada: ia menghentikan pengukuran atas sebab yang bukan.
 */
const KONEKTOR = new Set([
  "sampai", "padahal", "dengan", "untuk", "yang", "dari", "pada", "atau",
  "juga", "akan", "sudah", "belum", "tidak", "seperti", "sekitar", "setelah",
  "sebelum", "karena", "tentang", "adalah", "aja", "sini", "sana", "nanti",
]);

/**
 * Kata yang benar-benar membawa fakta.
 *
 * Apa pun yang memuat angka ikut berapa pun panjangnya—angka adalah bentuk
 * fakta paling khas dan paling mudah hilang saat diringkas.
 */
function distinctiveWords(gold: string): string[] {
  return gold
    .toLocaleLowerCase("id-ID")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) =>
      /\p{N}/u.test(word) || (word.length > 3 && !KONEKTOR.has(word))
    );
}

let korpusSehat = true;
for (const transcript of COMPACTION_EVAL_TRANSCRIPTS) {
  const bocor = auditKeepWindow(transcript);
  if (bocor.length > 0) {
    korpusSehat = false;
    console.error(
      `Korpus ${transcript.id}: fakta emas ${bocor.join(", ")} juga ada di ` +
        `${HISTORY_WINDOW} giliran terakhir yang tidak pernah dipadatkan. ` +
        "Pertanyaan itu berhenti mengukur pemadatan.",
    );
  }
}
if (!korpusSehat) {
  throw new Error(
    "Korpus tidak sah: perbaiki dulu sebelum angkanya dipercaya.",
  );
}

const onlyTranscript = process.argv
  .find((value) => value.startsWith("--transcript="))
  ?.slice("--transcript=".length);

for (let rep = 1; rep <= reps; rep += 1) {
  for (const transcript of COMPACTION_EVAL_TRANSCRIPTS) {
    if (onlyTranscript && transcript.id !== onlyTranscript) continue;
    const compacted = await compact(transcript);
    if (!compacted) {
      console.error(`Transkrip ${transcript.id} dilewati.`);
      continue;
    }

    const raw = (turns: readonly StoredConversationTurn[]) =>
      turns
        .map((item) => `${item.role === "user" ? "Pengguna" : "Harvy"}: ${item.text}`)
        .join(LINE_BREAK);
    const tail = raw(compacted.keep);
    const withTail = (episodes: readonly ConversationEpisode[]) =>
      `${renderEpisodeContext(episodes) ?? ""}${LINE_BREAK}${LINE_BREAK}${tail}`;
    if (process.argv.includes("--dump")) {
      const rendered = withTail(compacted.episodes);
      const hilang = compacted.episodes
        .filter((episode) => episode.source.kind === "turn-range")
        .map((episode) =>
          episode.source.kind === "turn-range"
            ? `${episode.source.fromSequence}-${episode.source.throughSequence}`
            : ""
        )
        .filter((label) => !rendered.includes(`Episode ${label}`));
      console.error(
        `===== ${transcript.id}: ${compacted.episodes.length} episode, ` +
          `${rendered.length} karakter, terpotong: ${
            hilang.length === 0 ? "tidak ada" : hilang.join(" ")
          } =====`,
      );
    }
    const contexts: Record<ArmName, string> = {
      utuh: raw(transcript.turns),
      episode: withTail(compacted.episodes),
      // Diisi per pertanyaan; pencarian bergantung pada apa yang ditanyakan.
      "episode+cari": "",
    };

    const arms: ArmResult[] = [];
    for (const arm of requestedArms) {
      let scored = 0;
      let characters = 0;
      const wrong: string[] = [];
      for (const question of transcript.questions) {
        const context = arm === "episode+cari"
          ? withRecovery(contexts["episode"], compacted.episodes, question)
          : contexts[arm];
        characters += context.length;
        const point = await scoreQuestion(context, question);
        scored += point;
        if (point < 2) wrong.push(`${question.id}(${point})`);
      }
      arms.push({
        arm,
        contextCharacters: Math.round(
          characters / transcript.questions.length,
        ),
        scored,
        possible: transcript.questions.length * 2,
        recallPercent: Math.round(
          (scored / (transcript.questions.length * 2)) * 1_000,
        ) / 10,
        wrong,
      });
    }
      perTranscript.push({ transcript: `${transcript.id}#${rep}`, arms });
  }
}

console.log(JSON.stringify(
  {
    mode: config.ai.mode,
    model,
    catatan:
      "Recall dilaporkan pada jumlah karakter konteks. Arm `utuh` adalah " +
      "langit-langit, bukan target. Selisih antar arm yang lebih kecil " +
      "daripada sebaran satu arm bukan temuan; pakai --reps.",
    perTranscript,
    ringkasan: summarizeArms(),
  },
  null,
  2,
));

/**
 * Merangkum per arm sebagai rata-rata **beserta sebarannya**.
 *
 * Rata-rata sendirian menyembunyikan hal yang paling perlu diketahui pembaca:
 * seberapa jauh dua run pada masukan yang sama dapat berbeda. Selisih antar
 * arm yang lebih kecil daripada sebaran satu arm bukan temuan.
 */
function summarizeArms(): Array<{
  arm: ArmName;
  recallPercent: number;
  recallTerendah: number;
  recallTertinggi: number;
  contextCharacters: number;
  run: number;
}> {
  return requestedArms.map((arm) => {
    const rows = perTranscript.flatMap((entry) =>
      entry.arms.filter((item) => item.arm === arm)
    );
    const scored = rows.reduce((total, row) => total + row.scored, 0);
    const possible = rows.reduce((total, row) => total + row.possible, 0);
    const characters = rows.reduce(
      (total, row) => total + row.contextCharacters,
      0,
    );
    const persen = rows.map((row) => row.recallPercent);
    return {
      arm,
      recallPercent: possible === 0
        ? 0
        : Math.round((scored / possible) * 1_000) / 10,
      recallTerendah: persen.length === 0 ? 0 : Math.min(...persen),
      recallTertinggi: persen.length === 0 ? 0 : Math.max(...persen),
      contextCharacters: rows.length === 0
        ? 0
        : Math.round(characters / rows.length),
      run: rows.length,
    };
  });
}

function readReps(): number {
  const flag = process.argv.find((value) => value.startsWith("--reps="));
  if (!flag) return 1;
  const value = Number.parseInt(flag.slice("--reps=".length), 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("--reps harus bilangan bulat 1 sampai 10.");
  }
  return value;
}

/**
 * Memadatkan seperti produksi memadatkan.
 *
 * Dua sifat jalur sungguhan yang wajib ditiru, keduanya ditemukan run kedua
 * ketika seluruh transkrip ditolak peringkas:
 *
 * 1. **Sekali padat memakan paling banyak `HISTORY_COMPACTION_CHUNK_MAX_TURNS`
 *    giliran.** Menyuapkan 34 giliran sekaligus adalah tiga kali lipat jendela
 *    produksi, jauh di luar distribusi prompt yang disetel menghasilkan paling
 *    banyak empat klaim per field. Model melampaui plafon, parser menolak
 *    keras, dan seluruh transkrip hilang—bukan karena pemadatannya buruk,
 *    melainkan karena harness-nya mengukur hal yang tidak pernah terjadi.
 * 2. **`HISTORY_WINDOW` giliran terakhir tidak pernah dipadatkan.** Fakta yang
 *    diucapkan di ujung percakapan masih ada mentah-mentah di konteks. Tidak
 *    menirunya berarti mengukur kasus yang lebih sulit daripada kenyataan.
 *
 * Lewat `Conversation.summarizeEpisode`, bukan client mentah: jalur produksi
 * mencoba ulang sampai tiga kali ketika model mengeluarkan JSON tidak sah.
 */
async function compact(
  transcript: CompactionEvalTranscript,
): Promise<
  { episodes: ConversationEpisode[]; keep: StoredConversationTurn[] } | null
> {
  const keepFrom = Math.max(0, transcript.turns.length - HISTORY_WINDOW);
  const keep = transcript.turns.slice(keepFrom);
  const evict = transcript.turns.slice(0, keepFrom);

  const episodes: ConversationEpisode[] = [];
  for (
    let start = 0;
    start < evict.length;
    start += HISTORY_COMPACTION_CHUNK_MAX_TURNS
  ) {
    const chunk = evict.slice(start, start + HISTORY_COMPACTION_CHUNK_MAX_TURNS);
    if (chunk.length === 0) continue;
    let draft;
    try {
      draft = await conversation.summarizeEpisode(chunk);
    } catch (error) {
      console.error(
        `Peringkas menyerah untuk ${transcript.id} pada giliran ${
          chunk[0]?.sequence
        }-${chunk.at(-1)?.sequence}: ` +
          (error instanceof Error ? error.message : "sebab tidak dikenali"),
      );
      return null;
    }
    const episode = createConversationEpisode(
      draft,
      chunk,
      new Date().toISOString(),
    );
    if (!episode) {
      console.error(
        `Episode tidak sah untuk ${transcript.id} pada giliran ${chunk[0]?.sequence}.`,
      );
      return null;
    }
    episodes.push(episode);
  }
  return { episodes, keep };
}

/**
 * Menambahkan hasil pencarian riwayat ke konteks, seperti yang produksi
 * lakukan lewat `memory-context-compiler`.
 *
 * Arm `episode` sendirian hanya setengah gambar: konteks otomatis memang
 * kehilangan sebagian besar fakta spesifik, dan justru karena itulah jalur
 * pencarian ada. Tanpa arm ini, harness melaporkan pemadatan jauh lebih buruk
 * daripada yang benar-benar dialami pengguna.
 *
 * Pencariannya murni—tidak ada panggilan model—sehingga arm ini nyaris gratis.
 */
function withRecovery(
  base: string,
  episodes: readonly ConversationEpisode[],
  question: CompactionEvalQuestion,
): string {
  const matches = searchConversationEpisodes(episodes, question.question);
  const lines = matches.flatMap((match) =>
    match.claims.map((claim) => `- ${claim.text}`)
  );
  if (lines.length === 0) return base;
  return `${base}${LINE_BREAK}${LINE_BREAK}Hasil pencarian riwayat:${LINE_BREAK}${
    lines.join(LINE_BREAK)
  }`;
}

/**
 * Menilai satu jawaban 2/1/0.
 *
 * Penjawab tidak pernah melihat jawaban benar; penilai melihat keduanya.
 * Pemisahan itu yang membuat angkanya bukan sekadar model menyetujui dirinya
 * sendiri.
 */
async function scoreQuestion(
  context: string,
  question: CompactionEvalQuestion,
): Promise<number> {
  const answered = await ask(
    [
      "Jawab HANYA dari konteks di bawah. Jangan menebak dan jangan memakai",
      "pengetahuan luar. Bila konteksnya tidak memuat jawabannya, tulis persis:",
      "TIDAK ADA DI KONTEKS.",
      "",
      "<konteks>",
      context,
      "</konteks>",
      "",
      `Pertanyaan: ${question.question}`,
    ].join("\n"),
  );

  const verdict = await ask(
    [
      "Nilai jawaban terhadap jawaban benar. Keluarkan HANYA satu angka:",
      "2 bila seluruh fakta pentingnya benar dan lengkap,",
      "1 bila sebagian benar tetapi ada yang hilang atau kabur,",
      "0 bila salah atau menyatakan tidak ada di konteks.",
      "Perbedaan susunan kata bukan kesalahan; perbedaan angka, tanggal, atau",
      "nama adalah kesalahan.",
      "",
      `Pertanyaan: ${question.question}`,
      `Jawaban benar: ${question.gold}`,
      `Jawaban yang dinilai: ${answered}`,
    ].join("\n"),
  );

  const point = Number.parseInt(verdict.trim().slice(0, 1), 10);
  return Number.isInteger(point) && point >= 0 && point <= 2 ? point : 0;
}

async function ask(prompt: string): Promise<string> {
  return client.complete({
    model,
    temperature: 0,
    maxTokens: maxOutputTokens,
    messages: [{ role: "user", content: prompt }],
    usage: evaluationUsage(),
  });
}


function evaluationUsage() {
  return {
    ownerId: "evaluation-pemadatan",
    channel: "system",
    subjectKind: "private",
    tier: "ambitious",
    purpose: "research",
    safetyCritical: false,
  } as const;
}

function readArms(): ArmName[] {
  const flag = process.argv.find((value) => value.startsWith("--arms="));
  if (!flag) return [...ALL_ARMS];
  const names = flag.slice("--arms=".length).split(",").map((v) => v.trim());
  const chosen = names.filter((name): name is ArmName =>
    (ALL_ARMS as readonly string[]).includes(name)
  );
  if (chosen.length === 0) {
    throw new Error(`Arm tidak dikenali. Pilihan: ${ALL_ARMS.join(", ")}.`);
  }
  return chosen;
}
