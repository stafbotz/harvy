const MAX_OBSERVATION_KIND_CHARACTERS = 120;
const MAX_ARTIFACT_REFERENCE_CHARACTERS = 512;

export interface ObservationCompactionOptions {
  reason?: string;
}

/**
 * Memadatkan observation tanpa berpura-pura bahwa potongannya adalah hasil
 * lengkap. Head/tail mempertahankan petunjuk awal dan akhir, sedangkan ukuran
 * asli serta artifact reference (bila memang diberikan executor) membuat
 * kehilangan detail dapat diukur dan ditelusuri.
 */
export function compactObservationSummary(
  value: string,
  maxCharacters: number,
  options: ObservationCompactionOptions = {},
): string {
  validateMaximum(maxCharacters);
  const clean = value.trim();
  if (clean.length <= maxCharacters) return clean;
  if (maxCharacters === 0) return "";

  const metadata = observationMetadata(clean);
  const fullBase = {
    kind: metadata.kind,
    truncated: true,
    reason: boundedReason(options.reason),
    originalCharacters: clean.length,
    ...(metadata.artifactRef ? { artifactRef: metadata.artifactRef } : {}),
  };
  const bases = [
    fullBase,
    {
      kind: metadata.kind,
      truncated: true,
      reason: boundedReason(options.reason),
      originalCharacters: clean.length,
    },
    {
      kind: metadata.kind,
      truncated: true,
      originalCharacters: clean.length,
    },
    { truncated: true, originalCharacters: clean.length },
  ];
  const base = bases.find((candidate) =>
    JSON.stringify({
      ...candidate,
      preview: { head: "", tail: "" },
    }).length <= maxCharacters
  );
  if (!base) {
    return metadata.structured
      ? minimalValidJson(maxCharacters)
      : headTailText(clean, maxCharacters);
  }
  const emptyEnvelope = JSON.stringify({
    ...base,
    preview: { head: "", tail: "" },
  });

  let low = 0;
  let high = clean.length;
  let best = emptyEnvelope;
  while (low <= high) {
    const previewCharacters = Math.floor((low + high) / 2);
    const headCharacters = Math.ceil(previewCharacters / 2);
    const tailCharacters = Math.floor(previewCharacters / 2);
    const candidate = JSON.stringify({
      ...base,
      preview: {
        head: clean.slice(0, headCharacters),
        tail: tailCharacters > 0
          ? clean.slice(clean.length - tailCharacters)
          : "",
      },
    });
    if (candidate.length <= maxCharacters) {
      best = candidate;
      low = previewCharacters + 1;
    } else {
      high = previewCharacters - 1;
    }
  }
  return best;
}

/** Head/tail clipping untuk data non-observation yang tetap harus terlihat. */
export function headTailText(value: string, maxCharacters: number): string {
  validateMaximum(maxCharacters);
  const clean = value.trim();
  if (clean.length <= maxCharacters) return clean;
  if (maxCharacters === 0) return "";
  if (maxCharacters === 1) return "…";

  const marker = "\n…[dipadatkan]…\n";
  if (marker.length >= maxCharacters) {
    return `${clean.slice(0, maxCharacters - 1)}…`;
  }
  const available = maxCharacters - marker.length;
  const headCharacters = Math.ceil(available / 2);
  const tailCharacters = Math.floor(available / 2);
  return `${clean.slice(0, headCharacters)}${marker}${clean.slice(
    clean.length - tailCharacters,
  )}`;
}

function observationMetadata(value: string): {
  kind: string;
  artifactRef: string | null;
  structured: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "agent.observation.text",
        artifactRef: null,
        structured: true,
      };
    }
    const record = parsed as Record<string, unknown>;
    const kind = typeof record["kind"] === "string"
      ? cleanMetadata(record["kind"], MAX_OBSERVATION_KIND_CHARACTERS) ??
        "agent.observation.result"
      : "agent.observation.result";
    const directArtifact = cleanMetadata(
      record["artifactRef"],
      MAX_ARTIFACT_REFERENCE_CHARACTERS,
    );
    const nestedArtifact = record["artifact"] &&
        typeof record["artifact"] === "object" &&
        !Array.isArray(record["artifact"])
      ? cleanMetadata(
          (record["artifact"] as Record<string, unknown>)["ref"],
          MAX_ARTIFACT_REFERENCE_CHARACTERS,
        )
      : null;
    return {
      kind,
      artifactRef: directArtifact ?? nestedArtifact,
      structured: true,
    };
  } catch {
    return {
      kind: "agent.observation.text",
      artifactRef: null,
      structured: false,
    };
  }
}

function minimalValidJson(maxCharacters: number): string {
  const variants = [
    JSON.stringify({ truncated: true }),
    "{}",
    "0",
  ];
  return variants.find((candidate) => candidate.length <= maxCharacters) ?? "";
}

function cleanMetadata(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || /[\u0000-\u001f\u007f]/u.test(clean)) return null;
  return clean.slice(0, maximum);
}

function boundedReason(value: string | undefined): string {
  return cleanMetadata(value, 120) ?? "observation_exceeded_context_budget";
}

function validateMaximum(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Batas pemadatan observation tidak sah.");
  }
}
