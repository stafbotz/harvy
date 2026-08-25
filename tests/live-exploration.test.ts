import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  assertLiveExplorationGate,
  assertLiveExplorationAssessmentAllowed,
  createLiveExplorationWhatsAppScope,
  LIVE_EXPLORATION_ACCOUNT,
  LIVE_EXPLORATION_CONFIRMATION,
  LiveExplorationEvidenceWriter,
  liveExplorationCoverageFromEvidence,
  liveExplorationCoverageSnapshot,
  liveExplorationHasReadyRun,
  liveExplorationRunId,
  LiveSurfaceAliasLedger,
  LiveTurnAttribution,
  isLiveExplorationWhatsAppMessageId,
  liveExplorationWhatsAppMessageId,
  parseLiveExplorationCommand,
  parseLiveExplorationOptions,
  prepareLiveExplorationJourney,
  readLiveExplorationEvidence,
  removeLiveExplorationJourney,
} from "../src/operations/live-exploration.js";

describe("live exploratory tester contract", () => {
  it("memerlukan akun khusus dan konfirmasi eksplisit", () => {
    assert.throws(
      () => assertLiveExplorationGate({}),
      /LIVE_EXPLORATION_REQUIRES_RUN_NONCRITICAL_LIVE_EXPLORATION/u,
    );
    assert.throws(
      () => assertLiveExplorationGate({
        HARVY_LIVE_EXPLORATION_CONFIRM: LIVE_EXPLORATION_CONFIRMATION,
      }),
      /LIVE_EXPLORATION_REQUIRES_DEDICATED_TEST_ACCOUNT/u,
    );
    assert.doesNotThrow(() => assertLiveExplorationGate({
      HARVY_LIVE_EXPLORATION_CONFIRM: LIVE_EXPLORATION_CONFIRMATION,
      HARVY_LIVE_EXPLORATION_ACCOUNT: LIVE_EXPLORATION_ACCOUNT,
    }));
  });

  it("membaca channel dan journey tanpa menerima argumen longgar", () => {
    assert.deepEqual(
      parseLiveExplorationOptions([
        "--channel=telegram",
        "--journey=owner-day-1",
        "--mode=full",
      ]),
      { channel: "telegram", journeyId: "owner-day-1", runMode: "full" },
    );
    assert.throws(
      () => parseLiveExplorationOptions(["--channel=telegram"]),
      /LIVE_EXPLORATION_ARGUMENT_MISSING/u,
    );
    assert.throws(
      () => parseLiveExplorationOptions([
        "--channel=telegram",
        "--journey=owner-day-1",
        "--mode=maybe",
      ]),
      /LIVE_EXPLORATION_MODE_INVALID/u,
    );
    assert.throws(
      () => parseLiveExplorationOptions([
        "--channel=telegram",
        "--journey=../secret",
        "--mode=focused",
      ]),
      /LIVE_EXPLORATION_JOURNEY_INVALID/u,
    );
    assert.throws(
      () => parseLiveExplorationOptions([
        "--channel=telegram",
        "--journey=owner-day-1",
        "--mode=full",
        "--output=transcript.json",
      ]),
      /LIVE_EXPLORATION_ARGUMENT_INVALID/u,
    );
  });

  it("menerima dialog adaptif, penilaian, restart, dan stop", () => {
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"send","text":"Mulai dari mana?"}'),
      { type: "send", text: "Mulai dari mana?" },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"reply","surface":"surface-2","text":"Bukan itu maksudku."}',
      ),
      {
        type: "reply",
        surface: "surface-2",
        text: "Bukan itu maksudku.",
      },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"click","surface":"surface-1","label":"Okei, mulai."}',
      ),
      { type: "click", surface: "surface-1", label: "Okei, mulai." },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"burst","messages":["satu","dua"],"gapMs":800}',
      ),
      { type: "burst", messages: ["satu", "dua"], gapMs: 800 },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"interrupt","text":"Tunggu, maksudku yang versi kedua."}',
      ),
      { type: "interrupt", text: "Tunggu, maksudku yang versi kedua." },
    );
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"settle"}'),
      { type: "settle" },
    );
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"wait","ms":30000}'),
      { type: "wait", ms: 30_000 },
    );
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"restart"}'),
      { type: "restart" },
    );
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"status"}'),
      { type: "status" },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"mark","markers":["real-task","topic-shift","correction"]}',
      ),
      {
        type: "mark",
        markers: ["real-task", "correction", "topic-shift"],
      },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(JSON.stringify({
        type: "assess",
        scores: {
          usefulness: 4,
          naturalness: 3,
          initiative: 2,
          nonRepetition: 4,
          uiClarity: 3,
          contextCoherence: 2,
          correctionHandling: 5,
        },
        completion: "partial",
        defects: ["wrong-route", "incomplete-work"],
      })),
      {
        type: "assess",
        scores: {
          usefulness: 4,
          naturalness: 3,
          initiative: 2,
          nonRepetition: 4,
          uiClarity: 3,
          contextCoherence: 2,
          correctionHandling: 5,
        },
        completion: "partial",
        defects: ["wrong-route", "incomplete-work"],
      },
    );
    assert.deepEqual(
      parseLiveExplorationCommand('{"type":"stop"}'),
      { type: "stop", deleteJourney: false, confirmation: null },
    );
    assert.deepEqual(
      parseLiveExplorationCommand(
        '{"type":"stop","deleteJourney":true,"confirmation":"DELETE_EXPLORATION_JOURNEY"}',
      ),
      {
        type: "stop",
        deleteJourney: true,
        confirmation: "DELETE_EXPLORATION_JOURNEY",
      },
    );
  });

  it("menolak field, isi, dan operasi destruktif yang tidak tertutup", () => {
    for (const input of [
      '{"type":"send","text":"halo","expected":"jawaban tertentu"}',
      '{"type":"interrupt","text":"koreksi","expected":"hasil"}',
      '{"type":"burst","messages":["sendiri"],"gapMs":0}',
      '{"type":"wait","ms":300001}',
      '{"type":"reply","surface":"../../x","text":"halo"}',
      '{"type":"mark","markers":["multi-bubble"]}',
      '{"type":"mark","markers":[]}',
      '{"type":"mark","markers":["correction","correction"]}',
      '{"type":"assess","scores":{"usefulness":6,"naturalness":3,"initiative":3,"nonRepetition":3,"uiClarity":3,"contextCoherence":3,"correctionHandling":3},"completion":"partial","defects":[]}',
      '{"type":"assess","scores":{"usefulness":3,"naturalness":3,"initiative":3,"nonRepetition":3,"uiClarity":3,"contextCoherence":3,"correctionHandling":3},"completion":"partial","defects":["invented-defect"]}',
      '{"type":"assess","scores":{"usefulness":3,"naturalness":3,"initiative":3,"nonRepetition":3,"uiClarity":3,"contextCoherence":3,"correctionHandling":3},"completion":"partial","defects":["wrong-route","wrong-route"]}',
      '{"type":"stop","deleteJourney":true,"confirmation":"ya"}',
      '{"type":"unknown"}',
    ]) {
      assert.throws(() => parseLiveExplorationCommand(input));
    }
  });

  it("memberi alias lokal stabil tanpa membuka ID platform", () => {
    const ledger = new LiveSurfaceAliasLedger();
    assert.equal(ledger.aliasFor("technical-secret-1"), "surface-1");
    assert.equal(ledger.aliasFor("technical-secret-1"), "surface-1");
    assert.equal(ledger.aliasFor("technical-secret-2"), "surface-2");
    assert.equal(ledger.technicalIdFor("surface-1"), "technical-secret-1");
    assert.equal(ledger.technicalIdFor("surface-9"), null);
    assert.equal(ledger.size, 2);
  });

  it("membuat scope kausal WhatsApp unik dengan peran tester dan Harvy", () => {
    const firstScope = createLiveExplorationWhatsAppScope();
    const secondScope = createLiveExplorationWhatsAppScope();
    const testerId = liveExplorationWhatsAppMessageId(firstScope, "tester");
    const harvyId = liveExplorationWhatsAppMessageId(firstScope, "harvy");

    assert.match(firstScope, /^HARVYEXP[A-F0-9]{12}$/u);
    assert.notEqual(firstScope, secondScope);
    assert.equal(testerId.length, 32);
    assert.equal(harvyId.length, 32);
    assert.equal(
      isLiveExplorationWhatsAppMessageId(testerId, firstScope, "tester"),
      true,
    );
    assert.equal(
      isLiveExplorationWhatsAppMessageId(testerId, firstScope, "harvy"),
      false,
    );
    assert.equal(
      isLiveExplorationWhatsAppMessageId(harvyId, secondScope, "harvy"),
      false,
    );
  });

  it("memisahkan surface startup, idle, dan giliran aktif", () => {
    const attribution = new LiveTurnAttribution();
    assert.deepEqual(attribution.observe(1_000), {
      phase: "startup",
      turn: null,
      latencyMs: null,
    });

    attribution.markReady();
    assert.deepEqual(attribution.observe(1_100), {
      phase: "idle",
      turn: null,
      latencyMs: null,
    });

    attribution.start(2, 2_000);
    assert.deepEqual(attribution.observe(2_125), {
      phase: "turn",
      turn: 2,
      latencyMs: 125,
    });

    attribution.close();
    assert.deepEqual(attribution.observe(3_000), {
      phase: "idle",
      turn: null,
      latencyMs: null,
    });
  });

  it("mengunci completion full pada coverage lintas-run yang lengkap", () => {
    const complete = [
      "real-task",
      "correction",
      "topic-shift",
      "multi-bubble",
      "pause",
      "re-entry",
      "context-return",
      "task-completed",
    ] as const;
    assert.throws(
      () => assertLiveExplorationAssessmentAllowed(
        "full",
        "completed",
        ["real-task"],
      ),
      /LIVE_EXPLORATION_FULL_COMPLETION_COVERAGE_INCOMPLETE/u,
    );
    assert.doesNotThrow(() => assertLiveExplorationAssessmentAllowed(
      "full",
      "completed",
      complete,
    ));
    assert.doesNotThrow(() => assertLiveExplorationAssessmentAllowed(
      "focused",
      "completed",
      [],
    ));
    assert.deepEqual(
      liveExplorationCoverageSnapshot(["pause", "real-task", "pause"]),
      {
        markers: ["real-task", "pause"],
        missingForFullCompletion: [
          "correction",
          "topic-shift",
          "multi-bubble",
          "re-entry",
          "context-return",
          "task-completed",
        ],
      },
    );
  });

  it("menghidrasi coverage hanya dari mode journey yang konsisten", () => {
    const records = [
      {
        version: 3,
        type: "lifecycle",
        event: "started",
        details: { resumed: false, runMode: "full" },
      },
      {
        version: 3,
        type: "coverage",
        runMode: "full",
        markers: ["real-task", "correction"],
      },
      {
        version: 3,
        type: "coverage",
        runMode: "full",
        markers: ["pause"],
      },
    ] as Readonly<Record<string, unknown>>[];
    assert.deepEqual(
      liveExplorationCoverageFromEvidence(records, "full"),
      ["real-task", "correction", "pause"],
    );
    assert.throws(
      () => liveExplorationCoverageFromEvidence(records, "focused"),
      /LIVE_EXPLORATION_JOURNEY_MODE_MISMATCH/u,
    );

    const legacy = [{ version: 2, type: "assessment" }];
    assert.deepEqual(
      liveExplorationCoverageFromEvidence(legacy, "focused"),
      [],
    );
    assert.throws(
      () => liveExplorationCoverageFromEvidence(legacy, "full"),
      /LIVE_EXPLORATION_LEGACY_JOURNEY_FULL_MODE_UNAVAILABLE/u,
    );
  });

  it("menandai re-entry hanya sesudah run sebelumnya pernah ready", () => {
    const runId = "run-0123456789abcdef01234567";
    const started = {
      version: 3,
      type: "lifecycle",
      event: "started",
      runId,
      details: { resumed: false, runMode: "full" },
    } as const;
    const failed = {
      version: 3,
      type: "lifecycle",
      event: "startup_failed",
      runId,
      details: { code: "LIVE_EXPLORATION_CONNECTION_CLOSED" },
    } as const;
    const ready = {
      version: 3,
      type: "lifecycle",
      event: "ready",
      runId,
      details: { resumed: false, runMode: "full" },
    } as const;
    assert.equal(liveExplorationHasReadyRun([started, failed], "full"), false);
    assert.equal(liveExplorationHasReadyRun([started, ready], "full"), true);
  });

  it("mempertahankan journey tetapi menyimpan evidence tanpa transcript", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "owner-day-1",
      );
      assert.equal(journey.resumed, false);
      const runId = liveExplorationRunId();
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "telegram",
        () => new Date("2026-08-24T12:00:00.000Z"),
      );
      await writer.recordLifecycle(runId, "started", {
        resumed: false,
        runMode: "focused",
      });
      await writer.recordTurn({
        runId,
        turn: 1,
        kind: "send",
        texts: ["kalimat rahasia penguji"],
      });
      await writer.recordSurface({
        runId,
        sequence: 1,
        operation: "create",
        surface: "surface-1",
        text: "balasan rahasia Harvy",
        buttons: ["tombol rahasia"],
        hasDocument: false,
        latencyMs: 123,
        phase: "turn",
        turn: 1,
      });
      await assert.rejects(() => writer.recordSurface({
        runId,
        sequence: 2,
        operation: "create",
        surface: "surface-2",
        text: "background",
        buttons: [],
        hasDocument: false,
        latencyMs: 1,
        phase: "idle",
        turn: null,
      }), /LIVE_EXPLORATION_SURFACE_TURN_INVALID/u);
      await writer.recordRuntimeTrace({
        runId,
        sequence: 1,
        attempt: 1,
        stage: "private-candidate",
        phase: "turn",
        turn: 1,
      });
      await assert.rejects(() => writer.recordRuntimeTrace({
        runId,
        sequence: 2,
        attempt: 1,
        stage: "raw-message-with-secret",
        phase: "idle",
        turn: null,
      }), /LIVE_EXPLORATION_RUNTIME_TRACE_INVALID/u);
      await writer.recordBoundary({
        runId,
        boundary: 1,
        kind: "settle",
        fromTurn: 1,
        toTurn: null,
        observationFlushTimedOut: false,
      });
      await writer.recordCoverage({
        runId,
        sequence: 1,
        runMode: "focused",
        source: "operator",
        trigger: "mark",
        markers: ["real-task"],
      });
      await writer.recordAssessment({
        runId,
        assessment: 1,
        runMode: "focused",
        coverage: ["real-task"],
        scores: {
          usefulness: 3,
          naturalness: 2,
          initiative: 2,
          nonRepetition: 4,
          uiClarity: 3,
          contextCoherence: 2,
          correctionHandling: 4,
        },
        completion: "partial",
        defects: ["context-attribution", "incomplete-work"],
      });
      await writer.close();

      const raw = await readFile(journey.evidenceFile, "utf8");
      assert.doesNotMatch(raw, /kalimat rahasia|balasan rahasia|tombol rahasia/u);
      const records = await readLiveExplorationEvidence(journey.evidenceFile);
      assert.equal(records.length, 7);
      assert.equal(records.every((record) => record["version"] === 3), true);
      assert.equal(records[1]?.["type"], "turn");
      assert.equal(records[2]?.["latencyMs"], 123);
      assert.equal(records[2]?.["phase"], "turn");
      assert.equal(records[2]?.["turn"], 1);
      assert.equal(records[3]?.["type"], "runtime_trace");
      assert.equal(records[4]?.["type"], "boundary");
      assert.equal(records[5]?.["type"], "coverage");
      assert.equal(records[6]?.["type"], "assessment");
      assert.equal(records[6]?.["completion"], "partial");
      assert.deepEqual(records[6]?.["missingForFullCompletion"], [
        "correction",
        "topic-shift",
        "multi-bubble",
        "pause",
        "re-entry",
        "context-return",
        "task-completed",
      ]);

      const resumed = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "owner-day-1",
      );
      assert.equal(resumed.resumed, true);
      await removeLiveExplorationJourney(
        repository,
        "telegram",
        "owner-day-1",
      );
      await assert.rejects(() => readFile(journey.evidenceFile, "utf8"));
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("menolak resume dan append pada evidence korup tanpa mengubah file", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "corrupt-resume",
      );
      const corrupt = "bukan-ndjson-valid\n";
      await writeFile(journey.evidenceFile, corrupt, "utf8");

      await assert.rejects(
        prepareLiveExplorationJourney(
          repository,
          "telegram",
          "corrupt-resume",
        ),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "telegram",
      );
      await assert.rejects(
        writer.recordLifecycle(liveExplorationRunId(), "started"),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      await assert.rejects(
        writer.close(),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      assert.equal(await readFile(journey.evidenceFile, "utf8"), corrupt);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("menolak evidence target non-regular tanpa menghapusnya", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "non-regular-evidence",
      );
      await mkdir(journey.evidenceFile);

      await assert.rejects(
        prepareLiveExplorationJourney(
          repository,
          "telegram",
          "non-regular-evidence",
        ),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "telegram",
      );
      await assert.rejects(
        writer.recordLifecycle(liveExplorationRunId(), "started"),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      assert.equal((await lstat(journey.evidenceFile)).isDirectory(), true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("menolak evidence dengan hard link tanpa mengubah kedua nama", async (t) => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "hard-link-evidence",
      );
      const alias = join(repository, "evidence-hard-link.ndjson");
      await writeFile(journey.evidenceFile, "", "utf8");
      try {
        await link(journey.evidenceFile, alias);
      } catch (error) {
        if (
          error instanceof Error && "code" in error &&
          (error.code === "EACCES" || error.code === "ENOSYS" ||
            error.code === "ENOTSUP" || error.code === "EOPNOTSUPP" ||
            error.code === "EPERM" || error.code === "EXDEV")
        ) {
          t.skip("Filesystem tidak mendukung hard link untuk fixture ini.");
          return;
        }
        throw error;
      }
      assert.equal((await lstat(journey.evidenceFile)).nlink, 2);
      assert.equal((await lstat(alias)).nlink, 2);

      await assert.rejects(
        prepareLiveExplorationJourney(
          repository,
          "telegram",
          "hard-link-evidence",
        ),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      await assert.rejects(
        readLiveExplorationEvidence(journey.evidenceFile),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "telegram",
      );
      await assert.rejects(
        writer.recordLifecycle(liveExplorationRunId(), "started"),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      assert.equal(await readFile(journey.evidenceFile, "utf8"), "");
      assert.equal(await readFile(alias, "utf8"), "");
      assert.equal((await lstat(journey.evidenceFile)).nlink, 2);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("tidak mengikuti symlink evidence saat resume, read, atau append", async (t) => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "whatsapp",
        "symlink-evidence",
      );
      const outside = join(repository, "outside-evidence.ndjson");
      await writeFile(outside, "", "utf8");
      let outsideProbe = outside;
      try {
        await symlink(outside, journey.evidenceFile, "file");
      } catch (error) {
        if (
          error instanceof Error && "code" in error &&
          (error.code === "EACCES" || error.code === "ENOSYS" ||
            error.code === "EPERM")
        ) {
          const outsideDirectory = join(repository, "outside-evidence-directory");
          outsideProbe = join(outsideDirectory, "canary.txt");
          await mkdir(outsideDirectory);
          await writeFile(outsideProbe, "", "utf8");
          try {
            await symlink(outsideDirectory, journey.evidenceFile, "junction");
          } catch (junctionError) {
            if (
              junctionError instanceof Error && "code" in junctionError &&
              (junctionError.code === "EACCES" ||
                junctionError.code === "ENOSYS" ||
                junctionError.code === "EPERM")
            ) {
              t.skip("Platform tidak mengizinkan pembuatan symlink atau junction.");
              return;
            }
            throw junctionError;
          }
        } else {
          throw error;
        }
      }

      await assert.rejects(
        prepareLiveExplorationJourney(
          repository,
          "whatsapp",
          "symlink-evidence",
        ),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      await assert.rejects(
        readLiveExplorationEvidence(journey.evidenceFile),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "whatsapp",
      );
      await assert.rejects(
        writer.recordLifecycle(liveExplorationRunId(), "started"),
        /LIVE_EXPLORATION_EVIDENCE_INVALID/u,
      );
      assert.equal(await readFile(outsideProbe, "utf8"), "");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("mencatat kegagalan startup secara terminal tanpa isi percakapan", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "whatsapp",
        "startup-failed",
      );
      const runId = liveExplorationRunId();
      const writer = new LiveExplorationEvidenceWriter(
        journey.evidenceFile,
        "whatsapp",
        () => new Date("2026-08-24T12:00:00.000Z"),
      );
      await writer.recordLifecycle(runId, "started", {
        resumed: false,
        runMode: "focused",
      });
      await writer.recordLifecycle(runId, "startup_failed", {
        code: "LIVE_EXPLORATION_CONNECTION_CLOSED",
      });
      await writer.close();

      const records = await readLiveExplorationEvidence(journey.evidenceFile);
      assert.deepEqual(
        records.map((record) => record["event"]),
        ["started", "startup_failed"],
      );
      assert.deepEqual(records[1]?.["details"], {
        code: "LIVE_EXPLORATION_CONNECTION_CLOSED",
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("runner mempersistenkan kegagalan setup terminal dan melepas lock", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-cli-test-"));
    const journeyId = "startup-failed-runner";
    const evidenceFile = join(
      repository,
      "data",
      "live-exploration",
      "telegram",
      journeyId,
      "exploration-evidence.ndjson",
    );
    const lockFile = join(
      repository,
      "secrets",
      "live-acceptance.setup.runtime.lock",
    );
    const secretCanary = "123456789:live-exploration-secret-canary";

    try {
      const entryDirectory = join(repository, "dist", "src");
      await mkdir(entryDirectory, { recursive: true });
      await writeFile(join(entryDirectory, "app.js"), "export {};\n", "utf8");
      const childEnvironment = { ...process.env };
      for (const name of Object.keys(childEnvironment)) {
        if (/(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|SESSION|TOKEN)/iu.test(name)) {
          delete childEnvironment[name];
        }
      }
      childEnvironment.HARVY_LIVE_EXPLORATION_ACCOUNT =
        LIVE_EXPLORATION_ACCOUNT;
      childEnvironment.HARVY_LIVE_EXPLORATION_CONFIRM =
        LIVE_EXPLORATION_CONFIRMATION;
      childEnvironment.TELEGRAM_BOT_TOKEN = secretCanary;

      const execution = await new Promise<{
        error: unknown;
        stdout: string;
        stderr: string;
      }>((resolveExecution) => {
        execFile(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            resolve(process.cwd(), "scripts", "live-exploratory-tester.ts"),
            "--channel=telegram",
            `--journey=${journeyId}`,
            "--mode=focused",
          ],
          {
            cwd: repository,
            encoding: "utf8",
            env: childEnvironment,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
            timeout: process.platform === "win32" ? 60_000 : 20_000,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            resolveExecution({
              error,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          },
        );
      });

      assert.ok(execution.error instanceof Error, execution.stderr);
      const exit = execution.error as Error & {
        code?: unknown;
        killed?: unknown;
      };
      assert.equal(exit.code, 2, `${execution.stdout}\n${execution.stderr}`);
      assert.equal(exit.killed, false, `${execution.stdout}\n${execution.stderr}`);

      const stdoutRecords = execution.stdout.trim().split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
      assert.deepEqual(
        stdoutRecords.map((record) => record["type"]),
        ["startup_failed", "blocked_or_failed"],
        execution.stdout,
      );
      assert.deepEqual(stdoutRecords[0], {
        protocol: "harvy-live-exploration/1",
        at: stdoutRecords[0]?.["at"],
        type: "startup_failed",
        channel: "telegram",
        journey: journeyId,
        code: "LIVE_EXPLORATION_TELEGRAM_NOT_PAIRED",
        evidenceClean: true,
        transcriptPersistence: "none",
      });

      const records = await readLiveExplorationEvidence(evidenceFile);
      assert.deepEqual(
        records.map((record) => record["event"]),
        ["started", "startup_failed"],
      );
      assert.equal(records[0]?.["runId"], records[1]?.["runId"]);
      assert.deepEqual(records[1]?.["details"], {
        code: "LIVE_EXPLORATION_TELEGRAM_NOT_PAIRED",
      });
      assert.equal(
        records.some((record) =>
          record["event"] === "ready" || record["event"] === "stopped"
        ),
        false,
      );

      const persisted = await readFile(evidenceFile, "utf8");
      const serializedRepository = JSON.stringify(repository).slice(1, -1);
      for (const forbidden of [
        secretCanary,
        repository,
        serializedRepository,
        "live-acceptance.key",
      ]) {
        assert.equal(persisted.includes(forbidden), false, forbidden);
        assert.equal(execution.stdout.includes(forbidden), false, forbidden);
        assert.equal(execution.stderr.includes(forbidden), false, forbidden);
      }

      await assert.rejects(
        access(lockFile),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ENOENT",
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("membaca evidence v1 dan v2 bersama v3 tanpa melonggarkan schema", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "mixed-evidence",
      );
      const runId = "run-0123456789abcdef01234567";
      const v1 = {
        version: 1,
        type: "surface",
        at: "2026-08-24T12:00:00.000Z",
        runId,
        channel: "telegram",
        sequence: 1,
        operation: "delete",
        surface: "surface-1",
        textCharacters: 0,
        textDigest: null,
        buttonCount: 0,
        buttonDigests: [],
        hasDocument: false,
        latencyMs: null,
      };
      const v2 = {
        version: 2,
        type: "lifecycle",
        at: "2026-08-24T12:00:00.500Z",
        runId,
        channel: "telegram",
        event: "started",
        details: { resumed: true },
      };
      await writeFile(
        journey.evidenceFile,
        `${JSON.stringify(v1)}\n${JSON.stringify(v2)}\n`,
        "utf8",
      );
      const resumed = await prepareLiveExplorationJourney(
        repository,
        "telegram",
        "mixed-evidence",
      );
      assert.equal(resumed.resumed, true);
      const writer = new LiveExplorationEvidenceWriter(
        resumed.evidenceFile,
        "telegram",
        () => new Date("2026-08-24T12:00:01.000Z"),
      );
      await writer.recordLifecycle(runId, "started", {
        resumed: true,
        runMode: "focused",
      });
      await writer.close();

      const records = await readLiveExplorationEvidence(journey.evidenceFile);
      assert.deepEqual(records.map((record) => record["version"]), [1, 2, 3]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("menolak evidence dengan isi mentah, field asing, atau digest rusak", async () => {
    const repository = await mkdtemp(join(tmpdir(), "harvy-exploration-test-"));
    try {
      const journey = await prepareLiveExplorationJourney(
        repository,
        "whatsapp",
        "tampered-evidence",
      );
      const base = {
        version: 2,
        type: "runtime_trace",
        at: "2026-08-24T12:00:00.000Z",
        runId: "run-0123456789abcdef01234567",
        channel: "whatsapp",
        sequence: 1,
        attempt: 1,
        stage: "private-candidate",
        phase: "idle",
        turn: null,
      } as const;
      for (const tampered of [
        { ...base, messageText: "isi yang tidak boleh tersimpan" },
        { ...base, stage: "unknown-stage" },
        {
          version: 2,
          type: "lifecycle",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          event: "unknown-startup-state",
          details: {},
        },
        {
          version: 2,
          type: "turn",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          turn: 1,
          kind: "send",
          messageCount: 1,
          messages: [{ characters: 4, digest: "rusak" }],
        },
        {
          version: 3,
          type: "lifecycle",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          event: "started",
          details: { resumed: false },
        },
        {
          version: 3,
          type: "coverage",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          sequence: 1,
          runMode: "full",
          source: "operator",
          trigger: "mark",
          markers: ["multi-bubble"],
        },
        {
          version: 3,
          type: "boundary",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          boundary: 1,
          kind: "interrupt",
          fromTurn: 1,
          toTurn: 2,
          observationFlushTimedOut: null,
          rawText: "tidak boleh tersimpan",
        },
        {
          version: 3,
          type: "assessment",
          at: base.at,
          runId: base.runId,
          channel: "whatsapp",
          assessment: 1,
          runMode: "full",
          coverage: [],
          missingForFullCompletion: [
            "real-task",
            "correction",
            "topic-shift",
            "multi-bubble",
            "pause",
            "re-entry",
            "context-return",
            "task-completed",
          ],
          scores: {
            usefulness: 3,
            naturalness: 3,
            initiative: 3,
            nonRepetition: 3,
            uiClarity: 3,
            contextCoherence: 3,
            correctionHandling: 3,
          },
          completion: "completed",
          defects: [],
        },
      ]) {
        await writeFile(
          journey.evidenceFile,
          `${JSON.stringify(tampered)}\n`,
          "utf8",
        );
        await assert.rejects(
          () => readLiveExplorationEvidence(journey.evidenceFile),
          /LIVE_EXPLORATION_/u,
        );
      }
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
