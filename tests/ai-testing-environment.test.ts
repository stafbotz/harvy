import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  migrateAiTestingEnvironmentContents,
} from "../src/operations/ai-testing-environment.js";

describe("migrasi environment testing GMI", () => {
  it("menghapus seluruh provider lama tanpa membawa secret dan menyiapkan GMI", () => {
    const source = [
      "# testing    = satu model gratis lewat Google AI Studio",
      "AI_MODE=testing",
      "# --- Mode testing: Google AI Studio ---",
      "# Boleh lebih dari satu kunci, dipisah koma. Kunci dipakai bergantian agar",
      "# kuota gratis tidak cepat habis saat pengembangan.",
      "GOOGLE_AI_STUDIO_API_KEYS=legacy-google-secret",
      "AI_MODEL_TESTING=legacy-model",
      "AI_TESTING_FALLBACK_BASE_URL=https://legacy.invalid/v1",
      "AI_TESTING_FALLBACK_API_KEY=legacy-fallback-secret",
      "AI_TESTING_FALLBACK_MODEL=legacy-fallback-model",
      "AI_TESTING_FALLBACK_PROVIDER_ID=legacy-fallback",
      "AI_TESTING_FALLBACK_COOLDOWN_MS=30000",
      "# Cadangan khusus testing; file ini diabaikan Git.",
      "AI_BASE_URL=",
      "KEEP_ME=value",
      "",
    ].join("\n");

    const result = migrateAiTestingEnvironmentContents(source);

    assert.equal(result.removedLegacyEntries, 6);
    assert.equal(result.rewrittenLegacyComments, 5);
    assert.equal(result.gmiKeyEntryCreated, true);
    assert.match(result.contents, /^GMI_API_KEY=$/mu);
    assert.match(result.contents, /^AI_MODEL_TESTING=MiniMaxAI\/MiniMax-M3$/mu);
    assert.match(result.contents, /^AI_BASE_URL=https:\/\/api\.gmi-serving\.com\/v1$/mu);
    assert.match(result.contents, /^KEEP_ME=value$/mu);
    assert.match(result.contents, /Mode testing: GMI Serving/u);
    assert.match(result.contents, /Endpoint OpenAI-compatible bawaan/u);
    assert.doesNotMatch(result.contents, /Cadangan khusus testing/u);
    assert.doesNotMatch(
      result.contents,
      /legacy-google-secret|legacy-fallback|AI_TESTING_FALLBACK|GOOGLE_AI_STUDIO/u,
    );
  });

  it("mempertahankan key GMI yang sudah ada dan bersifat idempoten", () => {
    const source = [
      "AI_MODE=testing",
      "GMI_API_KEY=existing-gmi-secret",
      "AI_MODEL_TESTING=MiniMaxAI/MiniMax-M3",
      "AI_BASE_URL=https://api.gmi-serving.com/v1",
      "",
    ].join("\r\n");

    const first = migrateAiTestingEnvironmentContents(source);
    const second = migrateAiTestingEnvironmentContents(first.contents);

    assert.equal(first.gmiKeyEntryCreated, false);
    assert.equal(first.rewrittenLegacyComments, 0);
    assert.equal(second.gmiKeyEntryCreated, false);
    assert.equal(second.rewrittenLegacyComments, 0);
    assert.equal(second.contents, first.contents);
    assert.match(second.contents, /GMI_API_KEY=existing-gmi-secret/u);
  });

  it("menolak mode production dan target ganda", () => {
    assert.throws(
      () => migrateAiTestingEnvironmentContents("AI_MODE=production\n"),
      hasCode("AI_TESTING_ENVIRONMENT_MODE_CONFLICT"),
    );
    assert.throws(
      () => migrateAiTestingEnvironmentContents([
        "AI_MODE=testing",
        "GMI_API_KEY=one",
        "GMI_API_KEY=two",
      ].join("\n")),
      hasCode("AI_TESTING_ENVIRONMENT_AMBIGUOUS"),
    );
  });
});

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string }).code === expected;
}
