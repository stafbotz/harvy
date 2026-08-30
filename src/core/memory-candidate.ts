import type { MemoryKind, NewMemory } from "../domain/memory.js";

export type DerivedMemoryMetadata = Pick<
  NewMemory,
  "subject" | "predicate" | "value" | "correction" | "provenance" |
    "graphProjection"
>;

/**
 * Meneruskan field pengetahuan kandidat memori apa adanya.
 *
 * Sebelumnya tinggal di dalam `create-bot.ts` sebagai closure, sehingga jalur
 * auto-memory tidak dapat ditiru di luar adapter. Probe yang tidak dapat
 * menirunya juga tidak dapat menilai klaim "sudah kucatat": giliran yang
 * membalas begitu tanpa perubahan jumlah catatan tampak seperti klaim palsu,
 * padahal jalur yang menyimpannya memang absen dari probe.
 *
 * Bentuknya sengaja diketik lewat `DerivedMemoryMetadata` alih-alih
 * `ExtractedMemory`, karena modul core tidak boleh bergantung pada `ai/`.
 */
export function knowledgeFields(
  item: Partial<DerivedMemoryMetadata>,
): DerivedMemoryMetadata {
  return {
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.correction !== undefined ? { correction: item.correction } : {}),
    ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
    ...(item.graphProjection !== undefined
      ? { graphProjection: item.graphProjection }
      : {}),
  };
}

export interface ExplicitResponsePreference {
  kind: "preference";
  content: string;
}

export interface AuthorizedMemoryRetractionEvidence {
  sourceEvidence: string;
}

/**
 * Menolak satu span write bila span yang sama sudah diotorisasi sebagai
 * pencabutan pada current turn.
 *
 * Extractor dapat menghasilkan field terstruktur yang saling bertentangan:
 * klausa "ini bukan preferensi permanen" sekaligus muncul sebagai retraction
 * dan candidate/semantic remember. Authority delete harus menang. Pagar ini
 * hanya membandingkan evidence current-turn; ia tidak menebak intent atau
 * memperluas target deletion ke candidate lain pada kalimat yang sama.
 */
export function memoryEvidenceConflictsWithRetractions(
  value: string | null | undefined,
  retractions: readonly AuthorizedMemoryRetractionEvidence[],
): boolean {
  const candidate = normalizeRetractionEvidence(value ?? "");
  if (candidate.length < 8) return false;
  return retractions.some((retraction) => {
    const evidence = normalizeRetractionEvidence(retraction.sourceEvidence);
    if (evidence.length < 8) return false;
    return candidate === evidence || candidate.includes(evidence) ||
      evidence.includes(candidate);
  });
}

export function memoryCandidateConflictsWithRetractions(
  candidate: { content: string; sourceEvidence?: string },
  retractions: readonly AuthorizedMemoryRetractionEvidence[],
): boolean {
  return memoryEvidenceConflictsWithRetractions(
    candidate.sourceEvidence,
    retractions,
  ) || memoryEvidenceConflictsWithRetractions(candidate.content, retractions);
}

/**
 * Pagar grounding untuk kandidat auto-memory dari model.
 *
 * Ini sengaja tidak mencoba memahami bahasa lewat daftar kata. Model harus
 * menyebut span current turn, subjek, dan horizon secara terstruktur; kode
 * hanya memverifikasi bahwa buktinya benar-benar ada dan bahwa kandidat itu
 * tentang pengguna serta masih berguna melewati keadaan sesaat. Perintah
 * remember yang explicit memiliki authority item-scoped sendiri dan tidak
 * memakai pagar automatic ini.
 */
export function automaticMemoryCandidateAuthorized(
  rawTurn: string,
  candidate: {
    sourceEvidence?: string;
    sourceSubject?: "self" | "other" | "work";
    durability?: "durable" | "bounded" | "transient";
  },
): boolean {
  if (
    candidate.sourceSubject !== "self" ||
    (candidate.durability !== "durable" &&
      candidate.durability !== "bounded")
  ) return false;
  const evidence = compact(candidate.sourceEvidence ?? "");
  if (!evidence) return false;
  if (isTurnScopedMemoryInstruction(evidence)) return false;
  if (isHypotheticalMemoryEvidence(rawTurn, evidence)) return false;
  return normalizeEvidence(rawTurn).includes(normalizeEvidence(evidence));
}

/**
 * Isi auto-memory harus berasal dari evidence user, bukan parafrasa model.
 *
 * Extractor tetap memilih apakah satu klausa layak menjadi kandidat dan jenis
 * memorinya. Namun begitu consent onboarding dipakai sebagai authority write,
 * model tidak boleh memperluas “lanjut dalam bahasa Inggris” menjadi “selalu
 * memilih coding dalam bahasa Inggris”. Menyimpan span yang sudah lolos pagar
 * provenance menutup celah itu tanpa membuat router bahasa baru.
 */
export function groundedAutomaticMemoryContent(
  rawTurn: string,
  candidate: {
    sourceEvidence?: string;
    sourceSubject?: "self" | "other" | "work";
    durability?: "durable" | "bounded" | "transient";
  },
): string | null {
  if (!automaticMemoryCandidateAuthorized(rawTurn, candidate)) return null;
  const evidence = compact(candidate.sourceEvidence ?? "");
  return evidence || null;
}

/**
 * Menolak auto-memory dari klausa bersyarat atau skenario andaian.
 *
 * Ini bukan router intent berbasis kata. Model tetap mengusulkan isi dan
 * metadata semantik; pagar lokal ini hanya menolak persistence saat exact
 * source evidence berada di bawah pembuka hipotetis pada current turn. False
 * negative lebih aman daripada mengubah pertanyaan "kalau aku..." menjadi
 * fakta durable tentang pengguna.
 */
export function isHypotheticalMemoryEvidence(
  rawTurn: string,
  sourceEvidence: string,
): boolean {
  const raw = normalizeEvidence(rawTurn);
  const evidence = normalizeEvidence(sourceEvidence);
  if (!raw || !evidence) return false;
  const index = raw.indexOf(evidence);
  if (index < 0) return false;
  const clauseStart = Math.max(
    raw.lastIndexOf(".", index - 1),
    raw.lastIndexOf("?", index - 1),
    raw.lastIndexOf("!", index - 1),
    raw.lastIndexOf(";", index - 1),
    raw.lastIndexOf(":", index - 1),
  ) + 1;
  const prefix = raw.slice(clauseStart, index + evidence.length).trimStart();
  const conditional = /^(?:kalau|jika|seandainya|andaikan|misalnya|anggap(?:lah)?|if|suppose|assuming|imagine)\b/iu
    .test(prefix);
  if (!conditional) return false;

  // “Kalau penjelasan panjang, aku sering kehilangan inti” menyatakan pola
  // habitual, bukan skenario rekaan. Marker harus berada pada klausa akibat,
  // bukan sekadar di premis (“kalau aku selalu memakai…”), agar pengecualian
  // ini tetap sempit dan fail-closed.
  const comma = evidence.indexOf(",");
  const habitualConsequence = /\b(?:aku|saya|i)\s+(?:sering|biasanya|selalu|cenderung|often|usually|always|tend(?:s)?\s+to)\b/iu
    .exec(evidence);
  if (
    (comma >= 0 &&
      /\b(?:sering|biasanya|selalu|cenderung|often|usually|always|tend(?:s)?\s+to)\b/iu
        .test(evidence.slice(comma + 1))) ||
    (habitualConsequence?.index ?? -1) > 10
  ) return false;
  return true;
}

/**
 * Veto sempit untuk arahan yang jelas dibatasi pada pekerjaan/percakapan ini.
 *
 * Model tetap memahami makna lintas bahasa dan mengusulkan kandidat; kode
 * tidak mencoba menggantikannya dengan router kata kunci. Pagar ini hanya
 * menolak kontradiksi durability yang dapat dibuktikan dari deiksis current-
 * scope. Penanda horizon durable yang eksplisit selalu menang.
 */
export function isTurnScopedMemoryInstruction(value: string): boolean {
  const clean = normalizeEvidence(value);
  if (
    /\b(?:mulai sekarang|ke depan(?:nya)?|untuk seterusnya|selalu|biasanya|from now on|going forward|always|usually|a partir de ahora|siempre|habitualmente|désormais|toujours)\b/iu
      .test(clean)
  ) return false;
  return /\b(?:percakapan|obrolan|pekerjaan|tugas|permintaan|kasus|chat|conversation|task|request|case)\s+(?:yang\s+)?(?:ini|this)\b/iu
      .test(clean) ||
    /\b(?:kali ini|untuk ini|for this (?:chat|conversation|task|request|case))\b/iu
      .test(clean) ||
    isCurrentLanguageInstruction(clean);
}

/** Peralihan bahasa pada giliran/bagian sekarang bukan preferensi durable. */
function isCurrentLanguageInstruction(value: string): boolean {
  return /^(?:let'?s\s+)?(?:continue|switch|reply|answer|respond)\b.{0,80}\b(?:in|to|using)\s+(?:the\s+)?(?:[\p{L}-]+\s+)?(?:language|english|indonesian|spanish|french|german|japanese|korean|arabic)\b/iu
      .test(value) ||
    /^(?:lanjut(?:kan)?|beralih|ganti|balas|jawab|gunakan|pakai)\b.{0,80}\b(?:(?:dalam|ke|dengan|pakai|gunakan)\s+)?(?:bahasa\s+[\p{L}-]+|inggris|indonesia|spanyol|prancis|jerman|jepang|korea|arab)\b/iu
      .test(value) ||
    /^(?:ahora|now)\b.{0,80}\b(?:en|in)\s+[\p{L}-]+\b/iu.test(value);
}

/**
 * Fallback bebas-keyword untuk satu permintaan remember yang sudah mempunyai
 * evidence exact dari current user turn. Model hanya mengusulkan kind; isi
 * durable tetap span yang benar-benar diotorisasi pengguna, bukan parafrasa
 * model. Lebih dari satu kandidat dibiarkan unresolved agar item scope tidak
 * melebar diam-diam.
 */
export function exactExplicitMemoryCandidate(
  requestedText: string,
  candidates: readonly { kind: MemoryKind; content: string }[],
): { kind: MemoryKind; content: string } | null {
  const content = compact(requestedText);
  if (
    candidates.length !== 1 || !content || content.length > 500 ||
    FORBIDDEN_TEXT_CONTROL.test(content)
  ) return null;
  return { kind: candidates[0]!.kind, content };
}

/**
 * Authority lokal yang sengaja sangat sempit untuk instruksi pengguna tentang
 * bentuk seluruh jawaban Harvy ke depan. Turn seperti ini bukan cerita tentang
 * pengguna: menerapkannya lintas giliran adalah isi perintah itu sendiri.
 *
 * Hasilnya tetap kandidat item-scoped dan masih melewati larangan credential,
 * primary MemoryService, commit receipt, serta rollback delivery. Preferensi
 * personal seperti "mulai sekarang aku lebih suka belajar malam" tidak masuk
 * boundary ini; ia tetap kandidat percakapan biasa dengan authority onboarding
 * pada kanal privat.
 */
export function inferExplicitResponsePreference(
  rawTurn: string,
): ExplicitResponsePreference | null {
  const clean = compact(rawTurn);
  if (
    clean.length < 12 || clean.length > 500 || clean.endsWith("?") ||
    /\b(?:ingat|simpan|catat)\b/iu.test(clean)
  ) {
    return null;
  }
  const body = clean.replace(/[.!]+$/gu, "").trim();
  // Boundary ini hanya mengotorisasi satu instruksi presentasi. Kalimat kedua
  // harus dinilai sendiri agar fakta lain tidak ikut memperoleh authority.
  if (!body || /[.!?]/u.test(body)) return null;
  const patterns = [
    /^(?:mulai sekarang|ke depannya|untuk seterusnya),?\s+(?:aku|saya)\s+lebih suka\s+((?:semua|setiap)\s+(?:jawaban|balasan)(?:mu)?\b.+)$/iu,
    /^(?:aku|saya)\s+lebih suka\s+((?:semua|setiap)\s+(?:jawaban|balasan)(?:mu)?\b.+)$/iu,
  ];
  const value = captureValue(body, patterns);
  if (!value || value.length < 6 || value.length > 240) return null;
  return {
    kind: "preference",
    content: `Lebih suka ${value}.`,
  };
}

/**
 * Membentuk slot factual dan graph projection dengan parser lokal sempit.
 * Keluaran model tetap hanya content/kind; model tidak diberi kuasa membuat
 * subject, edge, atau menandai koreksi sendiri.
 */
export function deriveMemoryMetadata(
  kind: MemoryKind,
  content: string,
  rawTurn: string,
): DerivedMemoryMetadata {
  const clean = compact(content);
  const normalized = normalize(clean);
  const correctionSignal = CORRECTION_PATTERNS.some((pattern) =>
    pattern.test(normalize(rawTurn)));

  const teacher = teacherFact(clean);
  if (teacher) {
    return {
      subject: teacher.course,
      predicate: "taught_by",
      value: teacher.teacher,
      correction: correctionSignal,
      provenance: "asserted",
      graphProjection: {
        from: { type: "course", canonicalName: teacher.course },
        relation: "taught_by",
        to: { type: "person", canonicalName: teacher.teacher },
      },
    };
  }

  const formerPartner = captureValue(clean, [
    /^(.+?)\s+(?:sudah\s+|udah\s+)?(?:bukan|tidak lagi menjadi|nggak lagi jadi)\s+pacar(?:ku| saya)?(?:\s+lagi)?$/iu,
    /^(?:aku\s+)?(?:sudah|udah)?\s*(?:tidak|nggak|gak|ga)\s+(?:lagi\s+)?(?:berpacaran|pacaran)\s+(?:dengan\s+)?(.+)$/iu,
    /^tidak lagi berpacaran dengan\s+(.+)$/iu,
  ]);
  if (formerPartner) {
    return {
      subject: "user",
      predicate: "romantic_partner",
      value: `tidak:${formerPartner}`,
      correction: true,
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "no_longer_partner_of",
        to: { type: "person", canonicalName: formerPartner },
      },
    };
  }

  const partner = captureValue(clean, [
    /^(.+?)\s+(?:adalah|merupakan)\s+pacar(?:ku| saya)$/iu,
    /^pacar(?:ku| saya)(?: sekarang)?(?: adalah)?\s+(.+)$/iu,
    /^(?:aku\s+)?(?:berpacaran|pacaran)\s+dengan\s+(.+)$/iu,
  ]);
  if (partner) {
    return {
      subject: "user",
      predicate: "romantic_partner",
      value: partner,
      correction: correctionSignal,
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "partner_of",
        to: { type: "person", canonicalName: partner },
      },
    };
  }

  const school = captureValue(clean, [
    /^(?:sekolah di|sekolah(?:ku)?(?: sekarang)?(?: adalah)?)\s+(.+)$/iu,
    /^(?:aku\s+)?(?:sekolah|pindah sekolah)\s+(?:di|ke)\s+(.+)$/iu,
  ]);
  if (school) {
    return {
      subject: "user",
      predicate: "studies_at",
      value: school,
      correction: correctionSignal,
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: school },
      },
    };
  }

  const grade = captureValue(clean, [
    /^(?:aku\s+)?(?:sekarang\s+)?(?:di\s+)?(?:kelas|tingkat)\s+(.+)$/iu,
    /^(?:kelas|tingkat)(?:ku)?(?: sekarang)?(?: adalah)?\s+(.+)$/iu,
  ]);
  if (grade) return scalar("grade_level", grade, correctionSignal);

  const major = captureValue(clean, [
    /^(?:jurusan(?:ku)?|aku mengambil jurusan)(?: adalah)?\s+(.+)$/iu,
  ]);
  if (major) return scalar("major", major, correctionSignal);

  const stoppedConsidering = captureValue(clean, [
    /^(?:aku\s+)?(?:sudah|udah|sekarang)?\s*(?:tidak|nggak|gak|ga)\s+(?:lagi\s+)?(?:mempertimbangkan|condong ke|memilih)\s+(.+?)(?:\s+lagi)?$/iu,
    /^(.+?)\s+(?:sudah|udah)\s+(?:tidak|nggak|gak|ga)\s+berlaku$/iu,
  ]);
  if (stoppedConsidering) {
    return scalar(
      "college_preference",
      `tidak:${stoppedConsidering}`,
      true,
    );
  }

  const collegePreference = captureValue(clean, [
    /^(?:aku\s+)?(?:sekarang\s+)?(?:lebih\s+)?(?:condong|tertarik)\s+(?:ke|pada)\s+(.+)$/iu,
    /^(?:aku\s+)?(?:sedang\s+)?mempertimbangkan\s+(.+)$/iu,
    /^(?:pilihan\s+)?kampus(?:ku)?(?: sekarang)?(?: adalah)?\s+(.+)$/iu,
  ]);
  if (collegePreference) {
    return scalar("college_preference", collegePreference, correctionSignal);
  }

  const favorite = /^(warna|makanan|minuman|pelajaran|musik|genre|olahraga)\s+favorit(?:ku)?(?: adalah)?\s+(.+)$/iu.exec(clean);
  if (favorite?.[1] && favorite[2]) {
    const category = normalize(favorite[1]).replaceAll(" ", "_");
    return scalar(`favorite_${category}`, compact(favorite[2]), correctionSignal);
  }

  if (/\b(visual|diagram|gambar|skema)\b/iu.test(normalized)) {
    return scalar("prefers_learning_style", "visual", correctionSignal);
  }
  if (/\b(audio|mendengar|didengarkan)\b/iu.test(normalized)) {
    return scalar("prefers_learning_style", "audio", correctionSignal);
  }
  if (/\b(pagi|siang|sore|malam)\b/iu.test(normalized) && kind === "preference") {
    const time = /\b(pagi|siang|sore|malam)\b/iu.exec(normalized)?.[1] ?? clean;
    return scalar("preferred_learning_time", time, correctionSignal);
  }

  return {
    subject: "user",
    predicate: predicateForKind(kind),
    value: clean,
    correction: false,
    provenance: "asserted",
    graphProjection: {
      from: { type: "person", canonicalName: "Pengguna" },
      relation: predicateForKind(kind),
      scalarValue: clean,
    },
  };
}

function scalar(
  predicate: string,
  value: string,
  correction: boolean,
): DerivedMemoryMetadata {
  return {
    subject: "user",
    predicate,
    value,
    correction,
    provenance: "asserted",
    graphProjection: {
      from: { type: "person", canonicalName: "Pengguna" },
      relation: predicate,
      scalarValue: value,
    },
  };
}

function teacherFact(content: string): { course: string; teacher: string } | null {
  const patterns = [
    /^(.+?)\s+(?:diajar|diajarkan)\s+oleh\s+(.+)$/iu,
    /^guru\s+(.+?)\s+(?:adalah|namanya)\s+(.+)$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[1] && match[2]) {
      return { course: compact(match[1]), teacher: compact(match[2]) };
    }
  }
  return null;
}

function captureValue(content: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const value = pattern.exec(content)?.[1];
    if (value) return compact(value);
  }
  return null;
}

function predicateForKind(kind: MemoryKind): string {
  switch (kind) {
    case "profile": return "profile_fact";
    case "preference": return "preference_fact";
    case "routine": return "routine_fact";
    case "context": return "context_fact";
    case "personal": return "personal_fact";
  }
}

function compact(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function normalize(value: string): string {
  return compact(value)
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID");
}

function normalizeEvidence(value: string): string {
  return compact(value).normalize("NFKC").toLocaleLowerCase("und");
}

function normalizeRetractionEvidence(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CORRECTION_PATTERNS = [
  /\b(koreksi|ralat|sebenarnya|bukan lagi|sudah pindah|sekarang bukan)\b/u,
  /\bbukan\b.+\b(tapi|melainkan)\b/u,
  /\b(?:sudah|udah|sekarang)\s+(?:tidak|nggak|gak|ga)\b/u,
  /\b(?:tidak|nggak|gak|ga)\b.+\blagi\b/u,
  /\b(?:sudah|udah)\s+(?:tidak|nggak|gak|ga)\s+berlaku\b/u,
];

const FORBIDDEN_TEXT_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
