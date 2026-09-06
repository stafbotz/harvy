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
  // Peringkat leksikal murni menjawab "episode mana", bukan "bagian mana dari
  // episode itu". Pengukuran 29 Agustus 2026: pertanyaan tentang hal yang masih
  // menggantung mengembalikan topik, fakta, dan penanda waktu di urutan atas
  // sementara klaim `unresolved` yang justru ditanyakan tenggelam, sehingga
  // Harvy menjawab benar soal topik lalu meleset pada yang diminta.
  it("menaikkan klaim yang jenisnya ditanyakan pertanyaan", () => {
    const target = episode("ujian", 1, {
      topics: [claim("Persiapan ujian biologi bab sistem pernapasan", 1)],
      facts: [claim("Ujian biologi diadakan hari Rabu pagi", 2)],
      unresolved: [claim("Belum tahu apakah soal ujian pilihan ganda atau uraian", 3)],
      progress: [claim("Belum tahu apakah soal ujian pilihan ganda atau uraian", 3)],
    });

    const fields = searchConversationEpisodes(
      [target],
      "apa yang belum jelas soal ujian biologi",
    )[0]?.claims.map((entry) => entry.field);

    assert.equal(fields?.[0], "unresolved");
  });

  // Planner membuang isyarat pengguna dari query: 4 dari 5 pencarian untuk
  // "ada satu hal yang masih belum jelas soal ujian biologi" dikirim sebagai
  // "ujian biologi persiapan" saja. Deskripsi tool sudah memintanya dan tidak
  // dipatuhi, jadi isyaratnya diberi slot tersendiri.
  //
  // Query di sini sengaja tidak muncul utuh di klaim mana pun. Kecocokan frasa
  // persis bernilai +3, lebih besar daripada bonus aspek, jadi fixture yang
  // memberi bonus itu kepada klaim pesaing akan menutup pengaruh aspek
  // seluruhnya—dan menguji sesuatu yang memang tidak dijanjikan.
  it("membaca isyarat jenis klaim dari aspect ketika query tidak memuatnya", () => {
    const target = episode("ujian", 1, {
      facts: [claim("Ujian biologi diadakan hari Rabu pagi", 1)],
      unresolved: [claim("Belum tahu apakah soal ujian pilihan ganda atau uraian", 2)],
      progress: [claim("Belum tahu apakah soal ujian pilihan ganda atau uraian", 2)],
    });

    const tanpaAspek = searchConversationEpisodes([target], "ujian pagi")[0]
      ?.claims.map((entry) => entry.field);
    const denganAspek = searchConversationEpisodes([target], "ujian pagi", {
      aspect: "belum jelas",
    })[0]?.claims.map((entry) => entry.field);

    assert.equal(tanpaAspek?.[0], "facts");
    assert.equal(denganAspek?.[0], "unresolved");
  });
  // Klaim `unresolved` jarang mengulang kata topiknya. "Belum tahu apakah
  // soalnya pilihan ganda atau uraian" tidak memuat "ujian" maupun "biologi",
  // jadi ia gugur sebelum bonus jenis sempat berlaku—dan justru itu yang
  // ditanyakan. Terukur pada model sungguhan, 24 run pertanyaan yang sama:
  // enam kegagalannya semua memakai kueri tanpa kata pengguna sendiri.
  it("membawa klaim yang jenisnya diminta walau tidak berbagi satu kata pun", () => {
    const target = episode("ujian", 1, {
      topics: [claim("Persiapan ujian biologi bab sistem pernapasan", 1)],
      facts: [claim("Ujian biologi diadakan hari Rabu pagi", 2)],
      unresolved: [claim("Belum tahu apakah soalnya pilihan ganda atau uraian", 3)],
    });

    const tanpaAspek = searchConversationEpisodes(
      [target],
      "ujian biologi persiapan",
    )[0];
    const denganAspek = searchConversationEpisodes(
      [target],
      "ujian biologi persiapan",
      { aspect: "belum jelas" },
    )[0];

    assert.equal(
      tanpaAspek?.claims.some((entry) => entry.field === "unresolved"),
      false,
    );
    assert.equal(
      denganAspek?.claims.some((entry) => entry.field === "unresolved"),
      true,
    );
    // Skornya nol dan tempatnya paling belakang: ia melengkapi hasil, bukan
    // mengaku paling relevan.
    const dibawa = denganAspek?.claims.at(-1);
    assert.equal(dibawa?.field, "unresolved");
    assert.equal(dibawa?.score, 0);
    // Peringkat episode dihitung dari klaim yang benar-benar cocok kata, jadi
    // menambah isi hasil tidak boleh menggeser episode mana yang menang.
    assert.equal(denganAspek?.score, tanpaAspek?.score);
  });

  it("tidak menarik episode yang memang tidak cocok, walau jenisnya diminta", () => {
    const target = episode("ujian", 1, {
      topics: [claim("Persiapan ujian biologi bab sistem pernapasan", 1)],
      unresolved: [claim("Belum tahu apakah soalnya pilihan ganda atau uraian", 2)],
    });
    const lain = episode("tidur", 1, {
      topics: [claim("Jam tidur berantakan menjelang pekan sibuk", 1)],
      unresolved: [claim("Belum jelas apakah sulit fokus karena kurang tidur", 2)],
    });

    const hasil = searchConversationEpisodes(
      [target, lain],
      "ujian biologi persiapan",
      { aspect: "belum jelas" },
    );

    assert.equal(hasil.length, 1);
    assert.equal(hasil[0]?.episodeId, "episode_ujian");
  });

  // Pembobotan hanya menata ulang klaim yang sudah cocok secara leksikal. Ia
  // tidak boleh mengubah hasil ketika pertanyaannya tidak menyebut jenis
  // apa pun, dan tidak boleh menyeret klaim tak berkaitan ke dalam hasil.
  it("tidak mengubah urutan ketika pertanyaan tidak menyebut jenis klaim", () => {
    const target = episode("ujian", 1, {
      topics: [claim("Persiapan ujian biologi bab sistem pernapasan", 1)],
      facts: [claim("Ujian biologi diadakan hari Rabu pagi", 2)],
      unresolved: [claim("Belum tahu apakah soalnya pilihan ganda atau uraian", 3)],
      progress: [claim("Belum tahu apakah soalnya pilihan ganda atau uraian", 3)],
    });

    const fields = searchConversationEpisodes([target], "ujian biologi")[0]
      ?.claims.map((entry) => entry.field);

    assert.equal(fields?.includes("unresolved"), false);
    assert.equal(fields?.[0], "facts");
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
    schemaVersion: 3,
    episodeId: `episode_${id}`,
    source: {
      kind: "turn-range",
      fromSequence,
      throughSequence,
      turnCount: throughSequence - fromSequence + 1,
      sourceHash: "a".repeat(64),
    },
    summarizerVersion: "test",
    anchors: [],
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
    progress: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}
