import type { StoredConversationTurn } from "../domain/history.js";

/**
 * Fakta persis yang dipanen mesin, bukan dipercayakan kepada peringkas.
 *
 * Satu episode Harvy dipadatkan menjadi paling banyak 24 klaim
 * (`EPISODE_TOTAL_CLAIMS_LIMIT`), empat per field, masing-masing ≤280
 * karakter—dan **semuanya ditulis model**. `temporalAnchors` memang ada, tetapi
 * ia salah satu field model itu dan berplafon empat. Akibatnya sebuah
 * percakapan panjang menyisakan paling banyak empat penanda waktu, dan mana
 * yang selamat adalah pilihan model.
 *
 * Untuk pendamping pelajar, yang paling mudah hilang di situ justru yang paling
 * operasional. "Ujian Selasa 16 September jam 07.00" menjadi "ujian minggu
 * depan"; "bab 7 sampai 9, soal nomor 12–20" menjadi "beberapa bab terakhir";
 * "nilai 68, KKM-nya 75" menjadi "nilainya di bawah KKM". Ketiganya masih benar
 * dan ketiganya tidak lagi dapat dipakai.
 *
 * Modul ini murni dan deterministik: tidak ada panggilan model, sehingga tidak
 * ada yang dapat diparafrasekan hilang.
 *
 * Asalnya `hermes/agent/context_compressor.py`, yang menyebut alasannya persis
 * begitu—*"No LLM in the loop, so nothing can be paraphrased away — this is the
 * defense for needle-facts that honest summarization at 10:1 always loses."*
 * Pada scorecard mereka, satu transkrip naik dari 23,3% menjadi 60,0% recall
 * closed-book setelah identifier diindeks secara mekanis. Polanya di sini
 * berbeda—bukan SHA dan path, melainkan tanggal, bab, dan nilai—tetapi
 * kelas masalahnya sama.
 *
 * Anchor **bukan pengganti** klaim naratif. Klaim memberi konteks ("ulangan
 * biologi"); anchor menjamin token persisnya selamat ("16 September", "bab 7").
 * Keduanya bekerja berpasangan, dan itulah sebab berkas ini tidak mencoba
 * menyusun kalimat.
 */

export type EpisodeAnchorKind = "waktu" | "materi" | "angka" | "kelas";

export interface EpisodeAnchor {
  kind: EpisodeAnchorKind;
  /** Token persis seperti tertulis di sumber, dinormalisasi spasinya saja. */
  text: string;
  /** Berapa kali muncul; frekuensi adalah perkiraan kasar seberapa penting. */
  count: number;
  /**
   * Giliran tempat ia muncul, terbatas.
   *
   * Membuat anchor dapat ditelusuri balik ke sumbernya lewat pencarian
   * riwayat, dan menjaga disiplin provenance yang sama dengan klaim episode.
   */
  sourceSequences: number[];
}

/** Panjang maksimum satu token anchor. */
export const EPISODE_ANCHOR_MAX_CHARS = 64;

/** Berapa banyak anchor yang disimpan per jenis. */
export const EPISODE_ANCHORS_PER_KIND_LIMIT = 6;

/** Batas keseluruhan agar bagian ini tidak pernah menyaingi klaimnya. */
export const EPISODE_ANCHORS_LIMIT = 16;

/** Berapa banyak sequence yang dicatat per anchor. */
const ANCHOR_SEQUENCES_LIMIT = 4;

interface AnchorPattern {
  kind: EpisodeAnchorKind;
  pattern: RegExp;
}

const BULAN =
  "januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember";

/**
 * Pola yang benar-benar muncul di percakapan pelajar Indonesia.
 *
 * Sengaja sempit. Regex atas teks bebas berbahasa Indonesia selalu perkiraan;
 * yang dipilih di sini adalah bentuk yang jarang salah tangkap, dengan biaya
 * melewatkan sebagian. Arah kegagalan itu dipilih sadar—anchor palsu ikut ke
 * dalam konteks setiap giliran dan menyesatkan, sedangkan anchor yang terlewat
 * hanya mengembalikan keadaan ke sebelum berkas ini ada.
 *
 * `minggu` sengaja tidak dihitung sebagai nama hari: dalam bahasa Indonesia ia
 * jauh lebih sering berarti satuan waktu ("minggu depan") daripada hari.
 */
const ANCHOR_PATTERNS: readonly AnchorPattern[] = [
  // 16 September, 16 September 2026
  {
    kind: "waktu",
    pattern: new RegExp(`\\b\\d{1,2}\\s+(?:${BULAN})(?:\\s+\\d{4})?\\b`, "giu"),
  },
  // Senin, Selasa, ... (tanpa Minggu)
  {
    kind: "waktu",
    pattern: /\b(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu)\b/giu,
  },
  // jam 7, pukul 15.30
  { kind: "waktu", pattern: /\b(?:jam|pukul)\s+\d{1,2}(?:[.:]\d{2})?\b/giu },
  // 07.00, 15:30 — hanya bentuk berdigit dua di belakang, agar "1.5" tidak ikut
  { kind: "waktu", pattern: /\b\d{1,2}[.:]\d{2}\b/giu },
  // 16/9, 16-09-2026
  { kind: "waktu", pattern: /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/giu },
  // bab 7, bab II
  { kind: "materi", pattern: /\bbab\s+(?:\d{1,3}|[ivxlc]{1,6})\b/giu },
  // halaman 142, hal. 142
  { kind: "materi", pattern: /\b(?:halaman|hal\.)\s*\d{1,4}\b/giu },
  // soal nomor 12, no. 5, nomor 12-20
  {
    kind: "materi",
    pattern:
      /\b(?:soal\s+)?(?:nomor|no\.)\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?\b/giu,
  },
  // KKM 75, nilai 68
  { kind: "angka", pattern: /\b(?:kkm|nilai|skor)\s+\d{1,3}\b/giu },
  // 80/100
  { kind: "angka", pattern: /\b\d{1,3}\s*\/\s*\d{1,3}\b/giu },
  // kelas 11 IPA 3, kelas XII MIPA 2
  {
    kind: "kelas",
    pattern: /\bkelas\s+(?:\d{1,2}|[ivx]{1,4})(?:\s+[a-z]{2,5})?(?:\s+\d{1,2})?\b/giu,
  },
];

/**
 * Memanen fakta persis dari giliran yang akan dipadatkan.
 *
 * Peringkatnya per jenis: yang paling sering muncul lebih dulu, seri diputus
 * oleh yang paling akhir terlihat. Frekuensi adalah perkiraan kasar seberapa
 * penting sesuatu, dan kebaruan memutus seri karena percakapan bergerak maju.
 */
export function harvestEpisodeAnchors(
  turns: readonly StoredConversationTurn[],
): EpisodeAnchor[] {
  const found = new Map<
    string,
    {
      kind: EpisodeAnchorKind;
      text: string;
      count: number;
      sequences: Set<number>;
      lastSeen: number;
    }
  >();
  let order = 0;

  for (const turn of turns) {
    for (const { kind, pattern } of ANCHOR_PATTERNS) {
      // Regex global dipakai berulang di seluruh giliran; `lastIndex` harus
      // dinolkan agar giliran berikutnya tidak dilewati sebagian.
      pattern.lastIndex = 0;
      for (const match of turn.text.matchAll(pattern)) {
        const text = normalizeAnchor(match[0]);
        if (!text) continue;
        const key = `${kind}:${text.toLocaleLowerCase("id-ID")}`;
        order += 1;
        const existing = found.get(key);
        if (existing) {
          existing.count += 1;
          existing.lastSeen = order;
          if (existing.sequences.size < ANCHOR_SEQUENCES_LIMIT) {
            existing.sequences.add(turn.sequence);
          }
          continue;
        }
        found.set(key, {
          kind,
          text,
          count: 1,
          sequences: new Set([turn.sequence]),
          lastSeen: order,
        });
      }
    }
  }

  const byKind = new Map<EpisodeAnchorKind, EpisodeAnchor[]>();
  const ranked = [...found.values()].sort((left, right) =>
    right.count - left.count || right.lastSeen - left.lastSeen
  );
  for (const item of ranked) {
    const bucket = byKind.get(item.kind) ?? [];
    if (bucket.length >= EPISODE_ANCHORS_PER_KIND_LIMIT) continue;
    bucket.push({
      kind: item.kind,
      text: item.text,
      count: item.count,
      sourceSequences: [...item.sequences].sort((a, b) => a - b),
    });
    byKind.set(item.kind, bucket);
  }

  // Urutan jenis tetap agar keluarannya deterministik dan mudah dibaca.
  const ordered: EpisodeAnchor[] = [];
  for (const kind of ["waktu", "materi", "angka", "kelas"] as const) {
    ordered.push(...(byKind.get(kind) ?? []));
  }
  return ordered.slice(0, EPISODE_ANCHORS_LIMIT);
}

/** Merender anchor untuk konteks prompt, atau `null` bila tidak ada. */
export function renderEpisodeAnchors(
  anchors: readonly EpisodeAnchor[],
): string | null {
  if (anchors.length === 0) return null;
  const labels: Record<EpisodeAnchorKind, string> = {
    waktu: "waktu",
    materi: "materi",
    angka: "angka",
    kelas: "kelas",
  };
  const byKind = new Map<EpisodeAnchorKind, string[]>();
  for (const anchor of anchors) {
    const bucket = byKind.get(anchor.kind) ?? [];
    bucket.push(anchor.text);
    byKind.set(anchor.kind, bucket);
  }
  const lines: string[] = [];
  for (const [kind, values] of byKind) {
    lines.push(`- ${labels[kind]} persis: ${values.join(", ")}`);
  }
  return lines.join("\n");
}

function normalizeAnchor(raw: string): string | null {
  const text = raw.trim().replaceAll(/\s+/gu, " ");
  if (!text || text.length > EPISODE_ANCHOR_MAX_CHARS) return null;
  if (/\p{C}/u.test(text)) return null;
  return text;
}
