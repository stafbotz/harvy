import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT,
  HISTORY_SEARCH_RESULT_LIMIT,
  searchConversationEpisodes,
} from "../src/core/history-search.js";
import {
  EPISODE_CLAIM_FIELDS,
  HISTORY_EPISODE_CONTEXT_LIMIT,
  renderEpisodeContext,
} from "../src/core/episodic-compaction.js";
import type {
  ConversationEpisode,
  EpisodeSummaryDraft,
} from "../src/domain/history.js";

describe("history full-text search", () => {
  it("menemukan episode lama relevan tanpa mengutamakan episode baru yang tidak cocok", () => {
    const oldRelevant = episode("old", 1, {
      facts: [claim("Ujian biología membahas matriks dan aljabar.", 1)],
      goals: [claim("Mempelajari aljabar sebelum ujian.", 2)],
    }, "2026-07-01T00:00:00.000Z");
    const newerPartial = episode("newer", 3, {
      facts: [claim("Jadwal matematika diumumkan besok.", 3)],
    }, "2026-08-01T00:00:00.000Z");
    const recentIrrelevant = episode("recent", 5, {
      facts: [claim("Latihan basket berlangsung Jumat sore.", 5)],
    }, "2026-08-08T00:00:00.000Z");

    const matches = searchConversationEpisodes(
      [oldRelevant, newerPartial, recentIrrelevant],
      "BIOLOGIA aljabar",
    );

    assert.equal(matches[0]?.episodeId, "episode_old");
    assert.deepEqual(matches[0]?.source, oldRelevant.source);
    assert.deepEqual(matches[0]?.claims[0]?.sourceSequences, [1]);
    assert.equal(matches.some((match) => match.episodeId === "episode_recent"), false);
  });

  it("mengembalikan hanya klaim cocok dan menjaga field provenance", () => {
    const source = episode("mixed", 10, {
      corrections: [claim("Ujian dipindah ke tanggal 17 Agustus.", 10)],
      facts: [
        claim("Topik ujian adalah fungsi kuadrat.", 11),
        claim("Nama kucingnya Moka.", 12),
      ],
    });

    const matches = searchConversationEpisodes([source], "ujian fungsi");

    assert.equal(matches.length, 1);
    assert.deepEqual(
      matches[0]?.claims.map(({ field, claimIndex, text, sourceSequences }) => ({
        field,
        claimIndex,
        text,
        sourceSequences,
      })),
      [
        {
          field: "facts",
          claimIndex: 0,
          text: "Topik ujian adalah fungsi kuadrat.",
          sourceSequences: [11],
        },
        {
          field: "corrections",
          claimIndex: 0,
          text: "Ujian dipindah ke tanggal 17 Agustus.",
          sourceSequences: [10],
        },
      ],
    );
    assert.equal(matches[0]?.claims.some((item) => item.text.includes("Moka")), false);
  });

  it("membatasi query, jumlah hasil, dan klaim per episode", () => {
    const episodes = Array.from({ length: HISTORY_SEARCH_RESULT_LIMIT + 3 }, (_, index) =>
      episode(`bounded_${index}`, index * 10 + 1, {
        facts: Array.from({ length: 4 }, (__, claimIndex) =>
          claim(`aljabar fakta ${claimIndex}`, index * 10 + claimIndex + 1)),
        goals: Array.from({ length: 4 }, (__, claimIndex) =>
          claim(`aljabar tujuan ${claimIndex}`, index * 10 + claimIndex + 5)),
      }));

    const matches = searchConversationEpisodes(episodes, "aljabar", { limit: 99 });
    assert.equal(matches.length, HISTORY_SEARCH_RESULT_LIMIT);
    assert.ok(matches.every(
      (match) => match.claims.length <= HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT,
    ));
    assert.deepEqual(searchConversationEpisodes(episodes, "aljabar", { limit: 0 }), []);
    assert.deepEqual(searchConversationEpisodes(episodes, "yang tadi itu"), []);

    const boundedQueryEpisode = episode("query_bounds", 200, {
      facts: [claim("penanda batas query khusus", 200)],
    });
    const overCharacterLimit = `${"x".repeat(500)} penanda`;
    assert.deepEqual(
      searchConversationEpisodes([boundedQueryEpisode], overCharacterLimit),
      [],
    );

    const firstSixteenTerms = Array.from(
      { length: 16 },
      (__, index) => `istilah${index}`,
    ).join(" ");
    assert.deepEqual(
      searchConversationEpisodes(
        [boundedQueryEpisode],
        `${firstSixteenTerms} penanda`,
      ),
      [],
    );
  });

  it("memisahkan batas penyimpanan pencarian dari attention context otomatis", () => {
    const episodes = Array.from({ length: HISTORY_EPISODE_CONTEXT_LIMIT + 1 }, (_, index) =>
      episode(`context_${index}`, index + 1, {
        facts: [claim(`Penanda episode ${index}.`, index + 1)],
      }));

    const context = renderEpisodeContext(episodes, 20_000) ?? "";
    assert.doesNotMatch(context, /Penanda episode 0\./u);
    assert.match(context, new RegExp(
      `Penanda episode ${HISTORY_EPISODE_CONTEXT_LIMIT}\\.`,
      "u",
    ));
    assert.equal(
      searchConversationEpisodes(episodes, "penanda episode 0")[0]?.episodeId,
      "episode_context_0",
    );
  });

  it("memecahkan skor seri dengan urutan ordinal yang stabil", () => {
    const laterId = episode("zeta", 1, {
      facts: [claim("aljabar dasar", 1)],
    });
    const earlierId = episode("alpha", 2, {
      facts: [claim("aljabar dasar", 2)],
    });

    assert.deepEqual(
      searchConversationEpisodes([laterId, earlierId], "aljabar")
        .map((match) => match.episodeId),
      ["episode_alpha", "episode_zeta"],
    );
  });
});

function episode(
  id: string,
  fromSequence: number,
  fields: Partial<EpisodeSummaryDraft>,
  createdAt = "2026-08-01T00:00:00.000Z",
): ConversationEpisode {
  const draft = emptyDraft();
  for (const [field, claims] of Object.entries(fields) as [
    keyof EpisodeSummaryDraft,
    EpisodeSummaryDraft[keyof EpisodeSummaryDraft] | undefined,
  ][]) {
    if (claims) draft[field] = claims;
  }
  const sequences = EPISODE_CLAIM_FIELDS
    .flatMap((field) => draft[field])
    .flatMap((item) => item.sourceSequences);
  const throughSequence = Math.max(fromSequence, ...sequences);
  return {
    schemaVersion: 2,
    episodeId: `episode_${id}`,
    source: {
      kind: "turn-range",
      fromSequence,
      throughSequence,
      turnCount: throughSequence - fromSequence + 1,
      sourceHash: "a".repeat(64),
    },
    summarizerVersion: "test",
    createdAt,
    ...draft,
  };
}

function claim(text: string, sourceSequence: number) {
  return { text, sourceSequences: [sourceSequence] };
}

function emptyDraft(): EpisodeSummaryDraft {
  return {
    topics: [],
    facts: [],
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}
