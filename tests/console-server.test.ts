import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConsoleServer } from "../src/console/console-server.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";

describe("Harvy Console", () => {
  it("menolak bind non-loopback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-console-bind-"));
    try {
      const { control, ledger } = runtime(directory);
      assert.throws(
        () => new ConsoleServer(control, ledger, {
          host: "0.0.0.0",
          port: 0,
          operatorToken: "token-operator-uji-yang-panjangnya-lebih-dari-32",
        }),
        /127\.0\.0\.1/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("menjaga auth, Origin, CSRF, CSP, schema tertutup, dan audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-console-http-"));
    const { control, ledger } = runtime(directory);
    const token = "token-operator-uji-yang-panjangnya-lebih-dari-32";
    const server = new ConsoleServer(
      control,
      ledger,
      { host: "127.0.0.1", port: 0, operatorToken: token },
    );
    const started = await server.start();
    try {
      const starting = await fetch(`${started.origin}/api/v1/health`);
      assert.equal((await starting.json() as { status: string }).status, "starting");
      server.markReady();
      const page = await fetch(started.origin);
      assert.equal(page.status, 200);
      const pageBody = await page.text();
      assert.match(pageBody, /<select id="price-model"/u);
      assert.match(pageBody, /role="tablist"/u);
      assert.doesNotMatch(pageBody, /id="price-provider"/u);
      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/u,
      );
      assert.equal(page.headers.get("access-control-allow-origin"), null);
      const script = await (await fetch(`${started.origin}/app.js`)).text();
      assert.doesNotThrow(() => new Function(script));
      assert.match(script, /aria-busy/u);
      assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage/u);
      assert.match(script, /groupDetails/u);
      assert.match(script, /betaExpiresAt/u);
      assert.match(script, /operatorLabel/u);
      assert.match(script, /usage-cohort/u);
      assert.match(script, /configuredModels/u);
      assert.match(script, /Promise\.allSettled/u);
      assert.match(script, /current_catalog_estimate/u);
      assert.match(script, /Belum ada penggunaan/u);
      assert.match(script, /function groupStatus/u);
      assert.match(script, /requireFresh/u);
      assert.match(script, /preserveForms/u);
      assert.doesNotMatch(script, /unknown \(0\)/u);
      assert.doesNotMatch(script, /price-provider/u);
      assert.match(script, /effectiveTo===null/u);

      const missingOrigin = await fetch(`${started.origin}/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      assert.equal(missingOrigin.status, 403);

      const login = await fetch(`${started.origin}/api/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: started.origin,
        },
        body: JSON.stringify({ token }),
      });
      assert.equal(login.status, 201);
      const loginBody = await login.json() as { csrfToken: string };
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/u);
      assert.match(login.headers.get("set-cookie") ?? "", /SameSite=Strict/u);

      const controlState = await fetch(
        `${started.origin}/api/v1/control-plane`,
        { headers: { cookie } },
      );
      const configuredModels = (await controlState.json() as {
        configuredModels: {
          providerId: string;
          modelId: string;
          sources: { environmentVariable: string }[];
        }[];
      }).configuredModels;
      assert.deepEqual(configuredModels, [{
        providerId: "provider-tanpa-harga",
        modelId: "model-tanpa-harga",
        active: true,
        sources: [{
          environmentVariable: "AI_MODEL_TESTING",
          mode: "testing",
          origin: "primary",
          tiers: ["cheap", "efficient", "ambitious"],
          active: true,
        }],
      }]);

      const group = await control.createEnrollmentFromExternal(
        "kelas-a@g.us",
        { kind: "group", channel: "whatsapp" },
        "Kelas A",
      );
      const attempt = {
        attemptId: "console-unpriced-attempt",
        requestId: "console-unpriced-request",
        turnId: "console-turn",
        attemptNo: 1,
        ownerId: "whatsapp:kelas-a@g.us",
        subjectKind: "group" as const,
        channel: "whatsapp" as const,
        actorAliases: ["pn:1"],
        providerId: "provider-tanpa-harga",
        origin: "primary" as const,
        modelId: "model-tanpa-harga",
        tier: "cheap" as const,
        purpose: "group-reply" as const,
        environment: "development" as const,
        costCenter: "runtime" as const,
        maxOutputTokens: 100,
        inputTokenEstimate: 10,
        safetyCritical: false,
        startedAt: "2026-08-01T00:00:00.000Z",
      };
      await ledger.startAttempt(attempt);
      await ledger.finishAttempt(attempt, {
        finishedAt: "2026-08-01T00:00:01.000Z",
        status: "completed",
        httpStatus: 200,
        responseOutcome: "accepted",
        finishReason: "stop",
        latencyMs: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          estimated: false,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerCostUsd: null,
          providerGenerationId: null,
        },
      });
      const memberUsage = await fetch(
        `${started.origin}/api/v1/groups/${group.subjectRef}/members`,
        { headers: { cookie } },
      );
      const memberRecords = (await memberUsage.json() as {
        records: {
          costUsdNanos: string | null;
          costCompleteness: string;
          unpricedAttempts: number;
          indicativeCostUsdNanos: string | null;
          costCoverage: string;
          unavailableCostAttempts: number;
        }[];
      }).records;
      assert.equal(memberRecords[0]?.costUsdNanos, null);
      assert.equal(memberRecords[0]?.costCompleteness, "unknown");
      assert.equal(memberRecords[0]?.unpricedAttempts, 1);
      assert.equal(memberRecords[0]?.indicativeCostUsdNanos, null);
      assert.equal(memberRecords[0]?.costCoverage, "unavailable");
      assert.equal(memberRecords[0]?.unavailableCostAttempts, 1);

      const filtered = await fetch(
        `${started.origin}/api/v1/usage?planId=group_direct&cohort=standard`,
        { headers: { cookie } },
      );
      const filteredBody = await filtered.json() as {
        summary: { attempts: number; costCoverage: string };
        attempts: { costView: { source: string; reason: string } }[];
      };
      assert.equal(filteredBody.summary.attempts, 1);
      assert.equal(filteredBody.summary.costCoverage, "unavailable");
      assert.equal(filteredBody.attempts[0]?.costView.source, "unavailable");
      assert.equal(filteredBody.attempts[0]?.costView.reason, "current_price_missing");

      const noCsrf = await fetch(`${started.origin}/api/v1/enrollments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: started.origin,
          cookie,
        },
        body: JSON.stringify({
          kind: "private",
          channel: "telegram",
          externalId: "123",
        }),
      });
      assert.equal(noCsrf.status, 403);

      const created = await fetch(`${started.origin}/api/v1/enrollments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: started.origin,
          cookie,
          "x-csrf-token": loginBody.csrfToken,
        },
        body: JSON.stringify({
          kind: "private",
          channel: "telegram",
          externalId: "123",
        }),
      });
      assert.equal(created.status, 201);
      const enrollment = await created.json() as {
        subjectRef: string;
        version: number;
        evaluationConsent: { status: string };
      };
      assert.match(enrollment.subjectRef, /^subject_/u);
      assert.equal(enrollment.evaluationConsent.status, "not_invited");

      const stale = await fetch(
        `${started.origin}/api/v1/enrollments/${enrollment.subjectRef}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            origin: started.origin,
            cookie,
            "x-csrf-token": loginBody.csrfToken,
            "if-match": String(enrollment.version + 1),
          },
          body: JSON.stringify({ cohort: "beta" }),
        },
      );
      assert.equal(stale.status, 409);

      const unknownField = await fetch(`${started.origin}/api/v1/enrollments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: started.origin,
          cookie,
          "x-csrf-token": loginBody.csrfToken,
        },
        body: JSON.stringify({
          kind: "private",
          channel: "telegram",
          externalId: "456",
          transcript: "tidak boleh",
        }),
      });
      assert.equal(unknownField.status, 400);

      const noGrantEndpoint = await fetch(
        `${started.origin}/api/v1/evaluation-consents/${enrollment.subjectRef}/grant`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: started.origin,
            cookie,
            "x-csrf-token": loginBody.csrfToken,
          },
          body: "{}",
        },
      );
      assert.equal(noGrantEndpoint.status, 404);

      const validPrice = await fetch(
        `${started.origin}/api/v1/prices/versions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: started.origin,
            cookie,
            "x-csrf-token": loginBody.csrfToken,
          },
          body: JSON.stringify({
            providerId: "provider-tanpa-harga",
            modelId: "model-tanpa-harga",
            inputPerMillionUsd: "0.10",
            outputPerMillionUsd: "0.40",
            effectiveFrom: "2026-08-01T02:00:00.000Z",
          }),
        },
      );
      assert.equal(validPrice.status, 201);

      const estimatedMemberUsage = await fetch(
        `${started.origin}/api/v1/groups/${group.subjectRef}/members`,
        { headers: { cookie } },
      );
      const estimatedMember = (await estimatedMemberUsage.json() as {
        records: {
          costUsdNanos: string | null;
          indicativeCostUsdNanos: string | null;
          currentPriceEstimateUsdNanos: string;
          currentPriceEstimatedAttempts: number;
          historicalPriceGapAttempts: number;
          costCoverage: string;
        }[];
      }).records[0];
      assert.equal(estimatedMember?.costUsdNanos, null);
      assert.equal(estimatedMember?.indicativeCostUsdNanos, "3000");
      assert.equal(estimatedMember?.currentPriceEstimateUsdNanos, "3000");
      assert.equal(estimatedMember?.currentPriceEstimatedAttempts, 1);
      assert.equal(estimatedMember?.historicalPriceGapAttempts, 1);
      assert.equal(estimatedMember?.costCoverage, "estimated");

      const pricedAttempt = {
        ...attempt,
        attemptId: "console-priced-attempt",
        requestId: "console-priced-request",
        startedAt: "2026-08-01T03:10:00.000Z",
      };
      await ledger.startAttempt(pricedAttempt);
      await ledger.finishAttempt(pricedAttempt, {
        finishedAt: "2026-08-01T03:10:01.000Z",
        status: "completed",
        httpStatus: 200,
        responseOutcome: "accepted",
        finishReason: "stop",
        latencyMs: 1,
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          estimated: false,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerCostUsd: null,
          providerGenerationId: null,
        },
      });
      const pendingAttempt = {
        ...attempt,
        attemptId: "console-pending-attempt",
        requestId: "console-pending-request",
        startedAt: "2026-08-01T03:20:00.000Z",
      };
      await ledger.startAttempt(pendingAttempt);
      await ledger.finishAttempt(pendingAttempt, {
        finishedAt: "2026-08-01T03:20:30.000Z",
        status: "timeout",
        httpStatus: null,
        responseOutcome: "not_checked",
        finishReason: null,
        latencyMs: 30_000,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimated: true,
          reasoningTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerCostUsd: null,
          providerGenerationId: null,
        },
      });
      const mixedMemberUsage = await fetch(
        `${started.origin}/api/v1/groups/${group.subjectRef}/members`,
        { headers: { cookie } },
      );
      const mixedMember = (await mixedMemberUsage.json() as {
        records: {
          costUsdNanos: string | null;
          indicativeCostUsdNanos: string | null;
          currentPriceEstimatedAttempts: number;
          unavailableCostAttempts: number;
          missingUsageAttempts: number;
          pendingAttempts: number;
          costCoverage: string;
        }[];
      }).records[0];
      assert.equal(mixedMember?.costUsdNanos, "6000");
      assert.equal(mixedMember?.indicativeCostUsdNanos, "9000");
      assert.equal(mixedMember?.currentPriceEstimatedAttempts, 1);
      assert.equal(mixedMember?.unavailableCostAttempts, 1);
      assert.equal(mixedMember?.missingUsageAttempts, 1);
      assert.equal(mixedMember?.pendingAttempts, 1);
      assert.equal(mixedMember?.costCoverage, "partial");

      const inventedPrice = await fetch(
        `${started.origin}/api/v1/prices/versions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: started.origin,
            cookie,
            "x-csrf-token": loginBody.csrfToken,
          },
          body: JSON.stringify({
            providerId: "provider-buatan",
            modelId: "model-buatan",
            inputPerMillionUsd: "1",
            outputPerMillionUsd: "2",
            effectiveFrom: "2026-08-01T03:00:00.000Z",
          }),
        },
      );
      assert.equal(inventedPrice.status, 400);
      assert.match(
        JSON.stringify(await inventedPrice.json()),
        /tidak tersedia di konfigurasi environment/u,
      );

      const audit = await fetch(`${started.origin}/api/v1/audit`, {
        headers: { cookie },
      });
      assert.equal(audit.status, 200);
      const records = (await audit.json() as {
        records: { action: string; outcome: string; reasonCode: string | null }[];
      }).records;
      assert.ok(records.some(
        (record) =>
          record.action === "session_login" &&
          record.outcome === "rejected" &&
          record.reasonCode === "origin_rejected",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "enrollment_create" &&
          record.outcome === "succeeded",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "enrollment_create" &&
          record.outcome === "rejected",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "enrollment_create" &&
          record.reasonCode === "csrf_rejected",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "enrollment_update" &&
          record.reasonCode === "version_conflict",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "unknown_mutation" &&
          record.reasonCode === "not_found",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "price_version_create" &&
          record.outcome === "succeeded",
      ));
      assert.ok(records.some(
        (record) =>
          record.action === "price_version_create" &&
          record.outcome === "rejected" &&
          record.reasonCode === "validation_rejected",
      ));
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function runtime(directory: string) {
  const control = new ControlPlaneService(
    new FileControlPlaneRepository(join(directory, "control.json")),
    {
      fallbackRollingTokenLimit: 100,
      betaQuotaMultiplier: 4,
      configuredModels: [{
        providerId: "provider-tanpa-harga",
        modelId: "model-tanpa-harga",
        active: true,
        sources: [{
          environmentVariable: "AI_MODEL_TESTING",
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
    { retentionDays: 90 },
  );
  return { control, ledger };
}
