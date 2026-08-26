import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConsoleServer } from "../src/console/console-server.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import {
  CodingRuntimeSetupService,
  codingRuntimeSetupPaths,
  type CodingRuntimeSetupProbes,
} from "../src/operations/coding-runtime-setup.js";
import { FileControlPlaneRepository } from
  "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from
  "../src/storage/file-usage-ledger-repository.js";

const OPERATOR_TOKEN = "token-operator-coding-setup-yang-lebih-dari-32";
const NOW = new Date("2026-08-26T09:00:00.000Z");
const IDENTITY = {
  serviceIdentityDigest: "1".repeat(64),
  runtimeImageDigest: "2".repeat(64),
  policyDigest: "3".repeat(64),
};

describe("Harvy Console coding setup", () => {
  it("menjaga auth/CSRF/schema dan tidak merefleksikan credential compute atau GitHub", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-console-coding-"));
    const control = new ControlPlaneService(
      new FileControlPlaneRepository(join(directory, "control.json")),
      {
        fallbackRollingTokenLimit: 100,
        betaQuotaMultiplier: 4,
        configuredModels: [{
          providerId: "setup-console",
          modelId: "setup-only",
          active: true,
          sources: [{
            environmentVariable: "CODING_SETUP_ONLY",
            mode: "testing",
            origin: "primary",
            tiers: ["cheap", "efficient", "ambitious"],
            active: true,
          }],
        }],
        priceBootstraps: [],
      },
    );
    const ledger = new UsageLedgerService(
      new FileUsageLedgerRepository(join(directory, "usage.json")),
      control,
      { retentionDays: 1 },
    );
    const setup = new CodingRuntimeSetupService({
      paths: codingRuntimeSetupPaths(directory),
      probes: probes(),
      now: () => new Date(NOW),
    });
    const server = new ConsoleServer(
      control,
      ledger,
      {
        host: "127.0.0.1",
        port: 0,
        operatorToken: OPERATOR_TOKEN,
        setupOnly: true,
      },
      undefined,
      undefined,
      null,
      null,
      setup,
    );
    const started = await server.start();
    server.markReady();
    try {
      const page = await (await fetch(started.origin)).text();
      assert.match(page, /id="tab-compute"/u);
      assert.match(page, /id="tab-github"/u);
      assert.match(page, /data-setup-tab="compute"/u);
      assert.equal(
        (await fetch(`${started.origin}/api/v1/coding-setup`)).status,
        401,
      );

      const login = await fetch(`${started.origin}/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: started.origin },
        body: JSON.stringify({ token: OPERATOR_TOKEN }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const csrf = (await login.json() as { csrfToken: string }).csrfToken;
      assert.ok(cookie);

      const initial = await json(started.origin, cookie, "/api/v1/coding-setup");
      assert.equal(initial.source, "none");
      const sandboxSecret = randomBytes(32).toString("base64url");
      const gitSecret = randomBytes(32).toString("base64url");
      const computeBody = {
        sandboxOrigin: "http://127.0.0.1:8443",
        sandboxKeyId: "sandbox-v1",
        sandboxHmacSecret: sandboxSecret,
        localGitOrigin: "http://127.0.0.1:8444",
        localGitKeyId: "local-git-v1",
        localGitHmacSecret: gitSecret,
        conformanceReceipt: JSON.stringify(receipt()),
        allowInsecureLoopback: true,
        codingAiPrivacyDomain: "workspace.private",
      };
      const missingCsrf = await fetch(
        `${started.origin}/api/v1/coding-setup/compute`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: started.origin,
            cookie,
          },
          body: JSON.stringify(computeBody),
        },
      );
      assert.equal(missingCsrf.status, 403);

      const unknown = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/coding-setup/compute",
        { ...computeBody, unexpected: true },
      );
      assert.equal(unknown.response.status, 400);
      const savedCompute = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/coding-setup/compute",
        computeBody,
      );
      assert.equal(savedCompute.response.status, 200);
      assert.equal(savedCompute.raw.includes(sandboxSecret), false);
      assert.equal(savedCompute.raw.includes(gitSecret), false);

      const enabledCompute = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/coding-setup/compute/verify",
        {},
      );
      assert.equal(enabledCompute.response.status, 200);
      assert.equal(JSON.parse(enabledCompute.raw).compute.enabled, true);

      const brokerSecret = randomBytes(32).toString("base64url");
      const clientSecret = "github-client-secret-console-test";
      const privateKey = privateKeyPem();
      const savedGitHub = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/coding-setup/github",
        {
          brokerOrigin: "http://127.0.0.1:8445",
          brokerKeyId: "github-broker-v1",
          brokerHmacSecret: brokerSecret,
          appId: "123456",
          appSlug: "harvy-repo-doctor",
          clientId: "Iv1.harvy-client",
          clientSecret,
          privateKeyPem: privateKey,
          callbackUrl: "https://github.harvy.example/v1/github-app/callback",
        },
      );
      assert.equal(savedGitHub.response.status, 200);
      assert.equal(savedGitHub.raw.includes(brokerSecret), false);
      assert.equal(savedGitHub.raw.includes(clientSecret), false);
      assert.equal(savedGitHub.raw.includes(privateKey), false);

      const enabledGitHub = await mutation(
        started.origin,
        cookie,
        csrf,
        "/api/v1/coding-setup/github/verify",
        {},
      );
      assert.equal(enabledGitHub.response.status, 200);
      const finalSnapshot = JSON.parse(enabledGitHub.raw);
      assert.equal(finalSnapshot.github.enabled, true);
      assert.equal(finalSnapshot.github.appSlug, "harvy-repo-doctor");
      assert.equal("clientSecret" in finalSnapshot.github, false);
      assert.equal("privateKeyPem" in finalSnapshot.github, false);
    } finally {
      await server.close();
    }
  });
});

function probes(): CodingRuntimeSetupProbes {
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

function receipt() {
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

async function mutation(
  origin: string,
  cookie: string,
  csrf: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; raw: string }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      "x-csrf-token": csrf,
    },
    body: JSON.stringify(body),
  });
  return { response, raw: await response.text() };
}

async function json(origin: string, cookie: string, path: string): Promise<any> {
  return (await fetch(`${origin}${path}`, { headers: { cookie } })).json();
}
