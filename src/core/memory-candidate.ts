import type { MemoryKind, NewMemory } from "../domain/memory.js";

export type DerivedMemoryMetadata = Pick<
  NewMemory,
  "subject" | "predicate" | "value" | "correction" | "provenance" |
    "graphProjection"
>;

export interface ExplicitResponsePreference {
  kind: "preference";
  content: string;
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

const CORRECTION_PATTERNS = [
  /\b(koreksi|ralat|sebenarnya|bukan lagi|sudah pindah|sekarang bukan)\b/u,
  /\bbukan\b.+\b(tapi|melainkan)\b/u,
  /\b(?:sudah|udah|sekarang)\s+(?:tidak|nggak|gak|ga)\b/u,
  /\b(?:tidak|nggak|gak|ga)\b.+\blagi\b/u,
  /\b(?:sudah|udah)\s+(?:tidak|nggak|gak|ga)\s+berlaku\b/u,
];
