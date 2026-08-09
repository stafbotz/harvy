import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdaptiveDebouncePolicy,
} from "../src/core/adaptive-debounce-policy.js";

describe("AdaptiveDebouncePolicy", () => {
  it("memakai fallback sampai sampel minimum tersedia", () => {
    const policy = new AdaptiveDebouncePolicy({ minSamples: 3 });
    policy.observe("ayu", 800);
    policy.observe("ayu", 800);

    assert.deepEqual(policy.estimate("ayu", 650), {
      adaptive: false,
      sampleCount: 2,
      p90GapMs: null,
      settleMs: 650,
    });
  });

  it("mengubah p90 800 ms menjadi 1 detik dan 1,6 detik menjadi 1,9 detik", () => {
    const policy = new AdaptiveDebouncePolicy({ minSamples: 3 });
    for (let index = 0; index < 3; index += 1) {
      policy.observe("cepat", 800);
      policy.observe("pelan", 1_600);
    }

    assert.deepEqual(policy.estimate("cepat", 650), {
      adaptive: true,
      sampleCount: 3,
      p90GapMs: 800,
      settleMs: 1_000,
    });
    assert.deepEqual(policy.estimate("pelan", 650), {
      adaptive: true,
      sampleCount: 3,
      p90GapMs: 1_600,
      settleMs: 1_900,
    });
  });

  it("mempelajari gap arrival meski batch sebelumnya sudah ter-flush", () => {
    let now = 1_000;
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 0,
      maxDelayMs: 5_000,
      maxGapMs: 5_000,
    }, () => now);

    policy.observeArrival("pelan");
    now += 1_600;
    policy.observeArrival("pelan");

    assert.deepEqual(policy.estimate("pelan", 650), {
      adaptive: true,
      sampleCount: 1,
      p90GapMs: 1_600,
      settleMs: 1_900,
    });
  });

  it("mengisolasi subjek, mengabaikan outlier, dan hanya menyimpan sampel terbaru", () => {
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 2,
      maxSamples: 3,
      maxGapMs: 2_000,
      minDelayMs: 0,
      maxDelayMs: 5_000,
    });
    [100, 200, 300, 400, 9_000, -1].forEach((gap) => {
      policy.observe("ayu", gap);
    });
    policy.observe("bima", 1_500);

    assert.deepEqual(policy.estimate("ayu", 650), {
      adaptive: true,
      sampleCount: 3,
      p90GapMs: 400,
      settleMs: 600,
    });
    assert.equal(policy.estimate("bima", 650).adaptive, false);
  });

  it("kedaluwarsa, forget, dan eviction tidak membawa timing lama", () => {
    let now = 1_000;
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      retentionMs: 100,
      maxSubjects: 2,
    }, () => now);
    policy.observe("scope-a\u0000ayu", 500);
    now += 1;
    policy.observe("scope-a\u0000bima", 600);
    now += 1;
    policy.observe("scope-b\u0000cici", 700);

    assert.equal(policy.estimate("scope-a\u0000ayu", 650).adaptive, false);
    assert.equal(policy.estimate("scope-a\u0000bima", 650).adaptive, true);

    policy.forgetPrefix("scope-a\u0000");
    assert.equal(policy.estimate("scope-a\u0000bima", 650).adaptive, false);

    now += 200;
    assert.equal(policy.estimate("scope-b\u0000cici", 650).adaptive, false);
  });

  it("akses estimate tidak memperpanjang TTL observasi", () => {
    let now = 1_000;
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      retentionMs: 100,
    }, () => now);
    policy.observeArrival("ayu");
    now = 1_050;
    policy.observeArrival("ayu");
    assert.equal(policy.estimate("ayu", 650).adaptive, true);

    now = 1_100;
    assert.equal(policy.estimate("ayu", 650).adaptive, true);
    now = 1_151;
    assert.equal(policy.estimate("ayu", 650).adaptive, false);
  });
});
