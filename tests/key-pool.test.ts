import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiKeyPool } from "../src/ai/key-pool.js";

describe("kumpulan kunci API", () => {
  it("memakai kunci bergantian lalu kembali ke awal", () => {
    const pool = new ApiKeyPool(["a", "b", "c"]);

    assert.equal(pool.take(), "a");
    assert.equal(pool.take(), "b");
    assert.equal(pool.take(), "c");
    assert.equal(pool.take(), "a");
  });

  it("tetap bekerja dengan satu kunci", () => {
    const pool = new ApiKeyPool(["satu"]);

    assert.equal(pool.size, 1);
    assert.equal(pool.take(), "satu");
    assert.equal(pool.take(), "satu");
  });

  it("menolak dibuat tanpa kunci sama sekali", () => {
    assert.throws(() => new ApiKeyPool([]), /Minimal satu kunci/);
  });

  it("membaca banyak kunci dari satu baris environment", () => {
    assert.deepEqual(ApiKeyPool.parse("a, b ,c"), ["a", "b", "c"]);
    assert.deepEqual(ApiKeyPool.parse("a\nb"), ["a", "b"]);
    assert.deepEqual(ApiKeyPool.parse("  satu  "), ["satu"]);
  });

  it("menganggap nilai kosong sebagai tidak ada kunci", () => {
    assert.deepEqual(ApiKeyPool.parse(undefined), []);
    assert.deepEqual(ApiKeyPool.parse(""), []);
    assert.deepEqual(ApiKeyPool.parse(" , , "), []);
  });
});
