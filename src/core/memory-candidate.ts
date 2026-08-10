import type { MemoryKind, NewMemory } from "../domain/memory.js";

export type DerivedMemoryMetadata = Pick<
  NewMemory,
  "subject" | "predicate" | "value" | "correction" | "provenance" |
    "graphProjection"
>;

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
];
