import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createSandboxConformanceReceipt,
  parseSandboxLiveAcceptanceObservation,
  sandboxAcceptanceSuiteDigest,
} from "../src/sandbox/sandbox-live-conformance.js";
import { codingRuntimeConformanceReceiptDigest } from "../src/core/pinned-coding-runtime-conformance.js";

const observationPath = process.argv[2];
if (!observationPath || process.argv.length !== 3) {
  throw new Error("Usage: npm run conformance:sandbox -- <observation.json>");
}
const acceptanceSource = await readFile(new URL("./sandbox-live-acceptance.ts", import.meta.url));
const observation = parseSandboxLiveAcceptanceObservation(
  JSON.parse(await readFile(observationPath, "utf8")) as unknown,
  sandboxAcceptanceSuiteDigest(acceptanceSource),
);
const receipt = createSandboxConformanceReceipt(observation, new Date());
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.stderr.write(
  `HARVY_CODING_CONFORMANCE_RECEIPT_SHA256=${codingRuntimeConformanceReceiptDigest(receipt)}\n` +
  `generator=${fileURLToPath(import.meta.url)}\n`,
);
