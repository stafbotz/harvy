import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { HmacTrustDomainRequestProofProvider } from "../src/transport/trust-domain-http.js";
import {
  TrustDomainHttpServer,
  type TrustDomainServiceRequest,
} from "../src/transport/trust-domain-http-server.js";
import { HttpSandboxTransport } from "../src/transport/http-sandbox-transport.js";

const servers: TrustDomainHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("TrustDomainHttpServer", () => {
  it("memverifikasi binding HMAC exact sebelum route dipanggil", async () => {
    const secret = randomBytes(32);
    const observed: TrustDomainServiceRequest[] = [];
    const server = new TrustDomainHttpServer({
      protocol: "harvy-sandbox/1",
      host: "127.0.0.1",
      port: 0,
      identities: [{ keyId: "sandbox-test", secret }],
      handler: {
        handle: async (request) => {
          observed.push(request);
          return {
            kind: "json",
            result: {
              available: true,
              runtime: "isolated-linux",
              identity: {
                serviceIdentityDigest: "1".repeat(64),
                runtimeImageDigest: "2".repeat(64),
                policyDigest: "3".repeat(64),
              },
              checkedAt: "2026-08-15T00:00:00.000Z",
              reason: null,
            },
          };
        },
      },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    servers.push(server);
    const address = await server.start();
    const transport = new HttpSandboxTransport({
      origin: address.origin,
      allowInsecureLoopback: true,
      proofProvider: new HmacTrustDomainRequestProofProvider("sandbox-test", secret),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });

    assert.deepEqual(await transport.health(), {
      available: true,
      runtime: "isolated-linux",
      identity: {
        serviceIdentityDigest: "1".repeat(64),
        runtimeImageDigest: "2".repeat(64),
        policyDigest: "3".repeat(64),
      },
      checkedAt: "2026-08-15T00:00:00.000Z",
      reason: null,
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.binding.pathname, "/v1/sandbox/health");
    assert.equal(observed[0]!.binding.audience, address.origin);
    assert.deepEqual(observed[0]!.envelope, { version: 1 });
  });

  it("menolak identity salah tanpa mencapai handler", async () => {
    let calls = 0;
    const server = new TrustDomainHttpServer({
      protocol: "harvy-sandbox/1",
      host: "127.0.0.1",
      port: 0,
      identities: [{ keyId: "sandbox-test", secret: randomBytes(32) }],
      handler: {
        handle: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      },
    });
    servers.push(server);
    const address = await server.start();
    const transport = new HttpSandboxTransport({
      origin: address.origin,
      allowInsecureLoopback: true,
      proofProvider: new HmacTrustDomainRequestProofProvider(
        "sandbox-test",
        randomBytes(32),
      ),
    });

    await assert.rejects(() => transport.health(), /menolak request \(HTTP 401\)/u);
    assert.equal(calls, 0);
  });
});
