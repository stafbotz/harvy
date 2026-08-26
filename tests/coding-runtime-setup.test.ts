import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CodingRuntimeSetupService,
  codingRuntimeSetupPaths,
  loadManagedGitHubBrokerServiceConfigurationSync,
  type CodingRuntimeSetupProbes,
} from "../src/operations/coding-runtime-setup.js";
import { codingRuntimeConformanceReceiptDigest } from
  "../src/core/pinned-coding-runtime-conformance.js";
import { loadCodingRuntimeDeploymentConfig } from
  "../src/core/coding-runtime-composition.js";
import type { CodingRuntimeConformanceReceipt } from
  "../src/core/coding-run-scheduler.js";

const NOW = new Date("2026-08-26T09:00:00.000Z");
const IDENTITY = {
  serviceIdentityDigest: "1".repeat(64),
  runtimeImageDigest: "2".repeat(64),
  policyDigest: "3".repeat(64),
};

describe("CodingRuntimeSetupService", () => {
  it("menyimpan config content-safe lalu hanya mengaktifkan compute dan GitHub setelah probe live", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-coding-setup-"));
    const paths = codingRuntimeSetupPaths(root);
    const probes = acceptedProbes();
    const service = new CodingRuntimeSetupService({
      paths,
      probes,
      now: () => new Date(NOW),
    });
    await service.initialize();
    const sandboxSecret = randomBytes(32).toString("base64url");
    const gitSecret = randomBytes(32).toString("base64url");
    const brokerSecret = randomBytes(32).toString("base64url");
    const receipt = conformanceReceipt();

    const savedCompute = await service.saveCompute({
      sandboxOrigin: "http://127.0.0.1:8443",
      sandboxKeyId: "sandbox-v1",
      sandboxHmacSecret: sandboxSecret,
      localGitOrigin: "http://127.0.0.1:8444",
      localGitKeyId: "local-git-v1",
      localGitHmacSecret: gitSecret,
      conformanceReceipt: JSON.stringify(receipt),
      allowInsecureLoopback: true,
      codingAiPrivacyDomain: "workspace.private",
    });

    assert.equal(savedCompute.compute.configured, true);
    assert.equal(savedCompute.compute.enabled, false);
    assert.equal(savedCompute.compute.receiptExpiresAt, receipt.expiresAt);
    const configOnDisk = await readFile(paths.configFile, "utf8");
    assert.doesNotMatch(configOnDisk, new RegExp(sandboxSecret, "u"));
    assert.doesNotMatch(configOnDisk, new RegExp(gitSecret, "u"));
    assert.equal(
      loadCodingRuntimeDeploymentConfig({}, paths).enabled,
      false,
    );

    const enabledCompute = await service.verifyAndEnableCompute();
    assert.equal(enabledCompute.compute.enabled, true);
    assert.equal(enabledCompute.compute.verificationCurrent, true);
    const runtime = loadCodingRuntimeDeploymentConfig({}, paths);
    assert.equal(runtime.enabled, true);
    assert.equal(runtime.sandbox?.origin, "http://127.0.0.1:8443");
    assert.equal(runtime.github, null);
    assert.equal(runtime.conformanceReceiptSha256,
      codingRuntimeConformanceReceiptDigest(receipt));

    const savedGitHub = await service.saveGitHub({
      brokerOrigin: "http://127.0.0.1:8445",
      brokerKeyId: "github-broker-v1",
      brokerHmacSecret: brokerSecret,
      appId: "123456",
      appSlug: "harvy-repo-doctor",
      clientId: "Iv1.harvy-client",
      clientSecret: "github-client-secret-test",
      privateKeyPem: privateKeyPem(),
      callbackUrl: "https://github.harvy.example/v1/github-app/callback",
    });
    assert.equal(savedGitHub.github.configured, true);
    assert.equal(savedGitHub.github.enabled, false);
    assert.equal(savedGitHub.compute.verificationCurrent, true);
    assert.doesNotMatch(
      await readFile(paths.configFile, "utf8"),
      /github-client-secret-test|PRIVATE KEY/u,
    );

    const brokerConfig = loadManagedGitHubBrokerServiceConfigurationSync(paths);
    assert.equal(brokerConfig?.appSlug, "harvy-repo-doctor");
    assert.equal(brokerConfig?.callbackHost, "0.0.0.0");
    assert.equal(brokerConfig?.hmacSecretFile, paths.githubBrokerSecretFile);

    const enabledGitHub = await service.verifyAndEnableGitHub();
    assert.equal(enabledGitHub.github.enabled, true);
    assert.equal(enabledGitHub.github.verificationCurrent, true);
    assert.equal(
      loadCodingRuntimeDeploymentConfig({}, paths).github?.origin,
      "http://127.0.0.1:8445",
    );

    const disabled = await service.disable("compute");
    assert.equal(disabled.compute.enabled, false);
    assert.equal(disabled.github.enabled, false);
    const restarted = new CodingRuntimeSetupService({ paths, probes });
    assert.equal((await restarted.snapshot()).compute.configured, true);
  });

  it("gagal tertutup bila identity sandbox berbeda dan tidak menyalakan runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-coding-setup-mismatch-"));
    const paths = codingRuntimeSetupPaths(root);
    const probes = acceptedProbes();
    probes.compute = async () => ({
      sandbox: {
        available: true,
        runtime: "isolated-linux",
        identity: { ...IDENTITY, policyDigest: "9".repeat(64) },
        checkedAt: NOW.toISOString(),
        reason: null,
      },
      localGit: {
        available: true,
        protocol: "harvy-local-git/1",
        checkedAt: NOW.toISOString(),
        reason: null,
      },
    });
    const service = new CodingRuntimeSetupService({
      paths,
      probes,
      now: () => new Date(NOW),
    });
    await service.saveCompute({
      sandboxOrigin: "https://sandbox.internal.example:8443",
      sandboxKeyId: "sandbox-v1",
      sandboxHmacSecret: randomBytes(32).toString("base64url"),
      localGitOrigin: "https://local-git.internal.example:8444",
      localGitKeyId: "local-git-v1",
      localGitHmacSecret: randomBytes(32).toString("base64url"),
      conformanceReceipt: JSON.stringify(conformanceReceipt()),
      allowInsecureLoopback: false,
    });

    await assert.rejects(
      service.verifyAndEnableCompute(),
      /identity sandbox live tidak cocok/iu,
    );
    assert.equal((await service.snapshot()).compute.enabled, false);
  });

  it("menolak sumber environment aktif ketika config Console tersedia", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-coding-setup-source-"));
    const paths = codingRuntimeSetupPaths(root);
    const service = new CodingRuntimeSetupService({
      paths,
      probes: acceptedProbes(),
      now: () => new Date(NOW),
    });
    await service.saveCompute({
      sandboxOrigin: "https://sandbox.internal.example:8443",
      sandboxKeyId: "sandbox-v1",
      sandboxHmacSecret: randomBytes(32).toString("base64url"),
      localGitOrigin: "https://local-git.internal.example:8444",
      localGitKeyId: "local-git-v1",
      localGitHmacSecret: randomBytes(32).toString("base64url"),
      conformanceReceipt: JSON.stringify(conformanceReceipt()),
      allowInsecureLoopback: false,
    });

    assert.throws(
      () => loadCodingRuntimeDeploymentConfig(
        { HARVY_CODING_RUNTIME_ENABLED: "true" },
        paths,
      ),
      /Console dan environment/iu,
    );
  });
});

function acceptedProbes(): CodingRuntimeSetupProbes {
  return {
    async compute() {
      return {
        sandbox: {
          available: true,
          runtime: "isolated-linux",
          identity: IDENTITY,
          checkedAt: NOW.toISOString(),
          reason: null,
        },
        localGit: {
          available: true,
          protocol: "harvy-local-git/1",
          checkedAt: NOW.toISOString(),
          reason: null,
        },
      };
    },
    async github() {
      return {
        available: true,
        protocol: "harvy-github-broker/1",
        checkedAt: NOW.toISOString(),
        reason: null,
      };
    },
  };
}

function conformanceReceipt(): CodingRuntimeConformanceReceipt {
  return {
    version: 1,
    ...IDENTITY,
    suiteDigest: "4".repeat(64),
    verifiedAt: "2026-08-26T08:55:00.000Z",
    expiresAt: "2026-09-02T08:55:00.000Z",
  };
}

function privateKeyPem(): string {
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    "ZmFrZS1wcml2YXRlLWtleS1mb3VuZGFyeQ==",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
}
