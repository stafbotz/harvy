import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("role-aware model architecture contract", () => {
  it("tidak mengembalikan consolidated specification yang obsolete", () => {
    const obsoleteSpec = [
      "HARVY_AGENT",
      "ARCHITECTURE_IMPLEMENTATION_SPEC.md",
    ].join("_");
    assert.equal(
      existsSync(resolve(obsoleteSpec)),
      false,
    );
  });

  it("tidak meng-hardcode Terra sebagai role aktif di runtime source", () => {
    const matches = sourceFiles(resolve("src")).filter((path) =>
      /terra/iu.test(readFileSync(path, "utf8"))
    );
    assert.deepEqual(matches, []);
  });
});

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
