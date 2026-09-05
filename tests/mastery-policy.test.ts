import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LearningTrace, ScaffoldDepth } from "../src/domain/learning-trace.js";
import {
  MASTERY_INDEPENDENT_RUNS,
  MASTERY_TRACE_MAX_AGE_DAYS,
  openingTutorStage,
  sameTopic,
  supportLevelFor,
  tracesForTopic,
} from "../src/core/mastery-policy.js";
import { scaffoldDepthOf } from "../src/core/learning-trace-service.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function trace(
  topic: string,
  depth: ScaffoldDepth,
  daysAgo = 1,
  id = `${topic}-${daysAgo}-${depth}`,
): LearningTrace {
  return {
    id,
    ownerId: "ayu",
    kind: "tutor",
    topic,
    depth,
    deepestStage: depth === "mandiri" ? "attempt" : "explain",
    completedAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
  };
}

function mandiri(topic: string, count: number): LearningTrace[] {
  return Array.from(
    { length: count },
    (_unused, index) => trace(topic, "mandiri", index + 1),
  );
}

describe("kedalaman bantuan dari tahap sesi", () => {
  it("membaca tangga tutor sebagai kedalaman", () => {
    assert.equal(scaffoldDepthOf("assess"), "mandiri");
    assert.equal(scaffoldDepthOf("attempt"), "mandiri");
    assert.equal(scaffoldDepthOf("hint"), "berpetunjuk");
    assert.equal(scaffoldDepthOf("explain"), "dijelaskan");
    assert.equal(scaffoldDepthOf("retry"), "dijelaskan");
  });
});

describe("pencocokan topik", () => {
  it("menyamakan tulisan yang berbeda untuk hal yang sama", () => {
    assert.equal(
      sameTopic("Turunan fungsi aljabar", "turunan fungsi aljabar dasar"),
      true,
    );
  });

  it("tidak menyamakan topik yang berbeda", () => {
    // Salah menganggap sama berarti mundur pada topik yang belum pernah
    // dikerjakan—kesalahan yang merugikan pelajarnya.
    assert.equal(sameTopic("Turunan fungsi aljabar", "Integral tentu"), false);
    assert.equal(sameTopic("Fotosintesis", "Respirasi sel"), false);
  });

  it("tidak menyamakan apa pun dengan topik tanpa kata berarti", () => {
    assert.equal(sameTopic("ini itu", "Turunan fungsi"), false);
    assert.equal(sameTopic("", "Turunan fungsi"), false);
  });
});

describe("tingkat bantuan", () => {
  it("membuka penuh ketika belum ada jejak", () => {
    assert.equal(supportLevelFor([], "Turunan fungsi", NOW), "penuh");
  });

  it("membuka penuh sebelum ambang tercapai", () => {
    const traces = mandiri("Turunan fungsi", MASTERY_INDEPENDENT_RUNS - 1);
    assert.equal(supportLevelFor(traces, "Turunan fungsi", NOW), "penuh");
  });

  it("memendekkan pembuka setelah berulang kali dikerjakan sendiri", () => {
    const traces = mandiri("Turunan fungsi", MASTERY_INDEPENDENT_RUNS);
    assert.equal(supportLevelFor(traces, "Turunan fungsi", NOW), "ringkas");
  });

  it("kembali penuh begitu satu sesi terakhir perlu dijelaskan", () => {
    // Kesulitan yang baru muncul lebih berarti daripada keberhasilan bulan
    // lalu.
    const traces = [
      trace("Turunan fungsi", "dijelaskan", 1),
      ...mandiri("Turunan fungsi", MASTERY_INDEPENDENT_RUNS).map((item, index) => ({
        ...item,
        completedAt: new Date(NOW.getTime() - (index + 5) * DAY_MS).toISOString(),
      })),
    ];
    assert.equal(supportLevelFor(traces, "Turunan fungsi", NOW), "penuh");
  });

  it("tidak memakai jejak yang sudah terlalu lama", () => {
    const lama = mandiri("Turunan fungsi", MASTERY_INDEPENDENT_RUNS).map((item) => ({
      ...item,
      completedAt: new Date(
        NOW.getTime() - (MASTERY_TRACE_MAX_AGE_DAYS + 5) * DAY_MS,
      ).toISOString(),
    }));
    assert.equal(supportLevelFor(lama, "Turunan fungsi", NOW), "penuh");
  });

  it("tidak memindahkan penguasaan satu topik ke topik lain", () => {
    const traces = mandiri("Turunan fungsi", MASTERY_INDEPENDENT_RUNS);
    assert.equal(supportLevelFor(traces, "Integral tentu", NOW), "penuh");
  });

  it("mengurutkan jejak terbaru lebih dulu", () => {
    const traces = [
      trace("Turunan fungsi", "mandiri", 30, "lama"),
      trace("Turunan fungsi", "dijelaskan", 1, "baru"),
    ];
    assert.deepEqual(
      tracesForTopic(traces, "Turunan fungsi", NOW).map((item) => item.id),
      ["baru", "lama"],
    );
  });
});

describe("tahap pembuka sesi tutor", () => {
  it("memulai dari assess pada bantuan penuh", () => {
    assert.equal(openingTutorStage("penuh"), "assess");
  });

  it("melewati assess ketika bantuan diringkas", () => {
    // Yang berubah hanya titik mulainya. Seluruh tangga tetap ada, dan sinyal
    // `stuck` tetap membawanya ke hint lalu explain seperti biasa—Pasal 3
    // melarang mempersulit dengan dalih kemandirian.
    assert.equal(openingTutorStage("ringkas"), "attempt");
  });
});
