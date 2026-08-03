import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiError } from "../src/ai/client.js";
import {
  classifyEvaluationFailure,
  coverageOrNull,
  percentileOrNull,
  ratioOrNull,
} from "../scripts/group-eval-support.js";

describe("dukungan evaluator grup", () => {
  it("memisahkan gangguan provider dari salah konfigurasi dan bug harness", () => {
    assert.equal(
      classifyEvaluationFailure(
        new AiError("kuota sementara", 429),
      ).kind,
      "provider",
    );
    assert.equal(
      classifyEvaluationFailure(
        new AiError("upstream gagal", 503),
      ).kind,
      "provider",
    );
    assert.equal(
      classifyEvaluationFailure(
        new AiError("request salah", 400),
      ).kind,
      "harness",
    );
    assert.equal(
      classifyEvaluationFailure(
        new AiError("kunci salah", 401),
      ).kind,
      "harness",
    );
    assert.equal(
      classifyEvaluationFailure(
        new TypeError("bug pemetaan lokal"),
      ).kind,
      "harness",
    );
    assert.equal(
      classifyEvaluationFailure(
        new TypeError("fetch failed", {
          cause: { code: "ECONNRESET" },
        }),
      ).kind,
      "provider",
    );
    const timeout = new Error("batas waktu");
    timeout.name = "AbortError";
    assert.equal(
      classifyEvaluationFailure(timeout).kind,
      "provider",
    );
  });

  it("mengembalikan null ketika metrik belum punya sampel", () => {
    assert.equal(ratioOrNull(0, 0), null);
    assert.equal(percentileOrNull([], 0.95), null);
    assert.equal(coverageOrNull([], () => true), null);
  });

  it("menghitung metrik hanya setelah ada sampel", () => {
    assert.equal(ratioOrNull(3, 4), 0.75);
    assert.equal(percentileOrNull([10, 20, 30, 40], 0.95), 40);
    assert.equal(
      coverageOrNull(
        [{ ok: true }, { ok: false }, { ok: true }],
        (item) => item.ok,
      ),
      2 / 3,
    );
  });
});
