import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installThirdPartyConsoleSecretGuard,
  isSensitiveThirdPartyConsoleStack,
} from "../src/observability/third-party-console-guard.js";

describe("third-party console secret guard", () => {
  it("membuang seluruh output yang berasal dari libsignal", () => {
    const output: unknown[][] = [];
    const target = consoleTarget(output);
    installThirdPartyConsoleSecretGuard(
      target,
      () => "Error\n    at close (C:\\repo\\node_modules\\libsignal\\src\\session_record.js:273:17)",
    );

    target.info("Closing session:", { rootKey: "synthetic-secret" });
    target.error("Session error", "synthetic-stack");

    assert.deepEqual(output, []);
  });

  it("meneruskan output aplikasi biasa tanpa mengubah payload", () => {
    const output: unknown[][] = [];
    const target = consoleTarget(output);
    installThirdPartyConsoleSecretGuard(
      target,
      () => "Error\n    at main (C:\\repo\\dist\\src\\app.js:10:3)",
    );

    target.warn("runtime warning", 17);

    assert.deepEqual(output, [["warn", "runtime warning", 17]]);
  });

  it("mengenali separator path Windows dan POSIX", () => {
    assert.equal(
      isSensitiveThirdPartyConsoleStack(
        "at close (C:\\repo\\node_modules\\libsignal\\src\\session_record.js:1:1)",
      ),
      true,
    );
    assert.equal(
      isSensitiveThirdPartyConsoleStack(
        "at close (/repo/node_modules/@whiskeysockets/libsignal/src/session.js:1:1)",
      ),
      true,
    );
    assert.equal(
      isSensitiveThirdPartyConsoleStack("at main (/repo/dist/src/app.js:1:1)"),
      false,
    );
  });
});

function consoleTarget(output: unknown[][]) {
  const method = (name: string) => (...values: unknown[]): void => {
    output.push([name, ...values]);
  };
  return {
    debug: method("debug"),
    info: method("info"),
    log: method("log"),
    warn: method("warn"),
    error: method("error"),
  };
}
