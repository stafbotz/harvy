import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactObservationSummary,
  headTailText,
} from "../src/harness/observation-compaction.js";

describe("observation compaction", () => {
  it("mempertahankan head/tail, ukuran asli, dan artifact reference bila muat", () => {
    const source = JSON.stringify({
      kind: "terminal.result",
      artifactRef: "artifact://run/evidence-1",
      output: `HEAD-${"x".repeat(3_000)}-TAIL`,
    });

    const compacted = compactObservationSummary(source, 900);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const preview = parsed["preview"] as Record<string, unknown>;

    assert.ok(compacted.length <= 900);
    assert.equal(parsed["kind"], "terminal.result");
    assert.equal(parsed["truncated"], true);
    assert.equal(parsed["originalCharacters"], source.length);
    assert.equal(parsed["artifactRef"], "artifact://run/evidence-1");
    assert.match(String(preview["head"]), /^\{"kind":"terminal/u);
    assert.match(String(preview["tail"]), /TAIL"\}$/u);
  });

  it("tetap menghasilkan JSON valid ketika artifact reference menghabiskan budget", () => {
    const source = JSON.stringify({
      kind: "terminal.result",
      artifactRef: "a".repeat(512),
      output: "b".repeat(2_000),
    });

    for (const maximum of [512, 96, 24, 2, 1]) {
      const compacted = compactObservationSummary(source, maximum);
      assert.ok(compacted.length <= maximum);
      assert.doesNotThrow(() => JSON.parse(compacted));
      if (maximum === 96) {
        const parsed = JSON.parse(compacted) as Record<string, unknown>;
        assert.equal(parsed["truncated"], true);
        assert.equal(parsed["originalCharacters"], source.length);
        assert.equal(typeof parsed["preview"], "object");
      }
    }
  });

  it("memberi head/tail pada observation teks biasa", () => {
    const compacted = headTailText(
      `AWAL-${"x".repeat(200)}-AKHIR`,
      80,
    );
    assert.ok(compacted.length <= 80);
    assert.match(compacted, /^AWAL-/u);
    assert.match(compacted, /-AKHIR$/u);
    assert.match(compacted, /dipadatkan/u);
  });
});
