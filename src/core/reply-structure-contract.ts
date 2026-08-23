export interface NumberedStepsReplyContract {
  kind: "numbered_steps";
  exactSteps: number;
  perStepFields: readonly string[];
  detail: "normal" | "detailed";
  minimumFieldCharacters: number;
}

export type ReplyStructureContract = NumberedStepsReplyContract;

export interface ReplyStructureAssessment {
  passed: boolean;
  numberedSteps: number;
  missingFields: readonly string[];
  shortFields: readonly string[];
}

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  delapan: 8,
  sembilan: 9,
  sepuluh: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

const MAX_STRUCTURED_STEPS = 10;
const MAX_PER_STEP_FIELDS = 6;
const NORMAL_FIELD_CHARACTERS = 8;
const DETAILED_FIELD_CHARACTERS = 32;

/**
 * Menurunkan hanya constraint bentuk berpresisi tinggi. Isi permintaan tetap
 * diperlakukan sebagai data pengguna; kode tidak mencoba menafsirkan tujuan
 * substantif atau menambah field yang tidak diminta.
 */
export function deriveReplyStructureContract(
  request: string,
): ReplyStructureContract | null {
  const exactSteps = requestedExactStepCount(request);
  if (exactSteps === null) return null;
  const perStepFields = requestedPerStepFields(request);
  const detail = /\b(?:mendalam|terperinci|rinci|detail(?:ed)?|in[- ]depth|tanpa\s+menebak)\b/iu
      .test(request)
    ? "detailed"
    : "normal";
  return Object.freeze({
    kind: "numbered_steps",
    exactSteps,
    perStepFields: Object.freeze(perStepFields),
    detail,
    minimumFieldCharacters: detail === "detailed"
      ? DETAILED_FIELD_CHARACTERS
      : NORMAL_FIELD_CHARACTERS,
  });
}

export function assessReplyStructure(
  reply: string,
  contract: ReplyStructureContract,
): ReplyStructureAssessment {
  const sections = numberedSections(reply);
  const missingFields: string[] = [];
  const shortFields: string[] = [];
  for (const [stepIndex, section] of sections.entries()) {
    if (contract.perStepFields.length === 0) {
      if (section.body.trim().length < contract.minimumFieldCharacters) {
        shortFields.push(`${stepIndex + 1}:content`);
      }
      continue;
    }
    for (const field of contract.perStepFields) {
      const value = fieldValue(section.body, field, contract.perStepFields);
      if (value === null) {
        missingFields.push(`${stepIndex + 1}:${field}`);
      } else if (value.length < contract.minimumFieldCharacters) {
        shortFields.push(`${stepIndex + 1}:${field}`);
      }
    }
  }
  const sequenceMatches = sections.length === contract.exactSteps &&
    sections.every((section, index) => section.number === index + 1);
  return {
    passed: sequenceMatches && missingFields.length === 0 &&
      shortFields.length === 0,
    numberedSteps: sections.length,
    missingFields,
    shortFields,
  };
}

export function replySatisfiesStructureContract(
  reply: string,
  contract: ReplyStructureContract,
): boolean {
  return assessReplyStructure(reply, contract).passed;
}

function requestedExactStepCount(request: string): number | null {
  const match = request.match(
    /\b(?:tepat|persis|exactly)\s+(?:sebanyak\s+)?(\d{1,2}|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:langkah|tahap|steps?)\b/iu,
  );
  if (!match?.[1]) return null;
  const normalized = match[1].toLowerCase();
  const count = /^\d+$/u.test(normalized)
    ? Number(normalized)
    : NUMBER_WORDS[normalized];
  if (
    typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 ||
    count > MAX_STRUCTURED_STEPS
  ) return null;
  return count;
}

function requestedPerStepFields(request: string): string[] {
  const match = request.match(
    /\b(?:pada|di)\s+(?:setiap|tiap)\s+(?:langkah|tahap)[^:\n]{0,96}:\s*([^.!?\n]{3,360})/iu,
  );
  if (!match?.[1]) return [];
  const fields = match[1]
    .replace(/\s+(?:dan|serta|and)\s+/giu, ",")
    .split(/[,;]/u)
    .map((field) => field.trim().replace(/^[\s–—-]+|[\s:–—-]+$/gu, ""))
    .filter((field) =>
      field.length >= 2 && field.length <= 60 &&
      /^[\p{L}\p{N}][\p{L}\p{N}\s()/\-]*$/u.test(field)
    );
  const unique: string[] = [];
  const normalized = new Set<string>();
  for (const field of fields) {
    const key = normalizeLabel(field);
    if (!key || normalized.has(key)) continue;
    unique.push(field);
    normalized.add(key);
    if (unique.length >= MAX_PER_STEP_FIELDS) break;
  }
  return unique;
}

function numberedSections(
  text: string,
): Array<{ number: number; body: string }> {
  const matches = [...text.matchAll(/^\s*(\d{1,2})[.)]\s+(.+)$/gmu)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    return {
      number: Number(match[1]),
      body: text.slice(start, end).trim(),
    };
  });
}

function fieldValue(
  section: string,
  field: string,
  allFields: readonly string[],
): string | null {
  const startPattern = new RegExp(`${escapeRegExp(field)}\\s*:\\s*`, "iu");
  const start = startPattern.exec(section);
  if (!start) return null;
  const valueStart = (start.index ?? 0) + start[0].length;
  let valueEnd = section.length;
  for (const candidate of allFields) {
    if (normalizeLabel(candidate) === normalizeLabel(field)) continue;
    const nextPattern = new RegExp(`${escapeRegExp(candidate)}\\s*:\\s*`, "giu");
    nextPattern.lastIndex = valueStart;
    const next = nextPattern.exec(section);
    if (next && next.index < valueEnd) valueEnd = next.index;
  }
  return section.slice(valueStart, valueEnd).trim();
}

function normalizeLabel(value: string): string {
  return value.toLocaleLowerCase("id-ID").replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
