import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, it } from "node:test";
import { createBaileysLogger } from "../src/observability/baileys-logger.js";
import {
  operatorSecretChannelAvailable,
  presentOperatorSecret,
} from "../src/observability/operator-secret.js";
import {
  createOperationalLogSystem,
  OPERATIONAL_LOG_SCHEMA,
  type OperationalLogOptions,
} from "../src/observability/operational-logger.js";

describe("log operasional", () => {
  it("menolak sink pada akar filesystem sebelum membuat atau menghapus apa pun", async () => {
    await assert.rejects(
      createOperationalLogSystem(
        options(parse(process.cwd()).root),
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "LOG_DIRECTORY_ROOT",
    );
  });

  it("menulis schema terstruktur dan menyaring isi, identitas, serta kredensial", async () => {
    await withTempDirectory(async (directory) => {
      const consoleOutput: string[] = [];
      const consoleStream = {
        write(chunk: string | Uint8Array): boolean {
          consoleOutput.push(String(chunk));
          return true;
        },
      };
      const system = await createOperationalLogSystem(
        options(directory, {
          consoleEnabled: true,
          consoleFormat: "pretty",
          stdout: consoleStream,
          stderr: consoleStream,
        }),
      );
      const cyclic: Record<string, unknown> = {};
      cyclic["self"] = cyclic;
      const secretToken = "123456789:abcdefghijklmnopqrstuvwxyzABCDE";
      const querySecret = "fallback-secret-sentinel";
      const error = Object.assign(
        new Error(
          `isi chat rahasia biasa gagal untuk 62812345:3@s.whatsapp.net, ` +
            `Bearer very-secret-token, ` +
            `https://example.invalid/chat?apikey=${querySecret}, ` +
            `dan ${process.cwd()}`,
        ),
        {
          name: "IsiChatRahasiaError",
          code: "E_PROVIDER",
          statusCode: 503,
          cause: Object.assign(
            new Error("penyebab berisi cerita pribadi lain"),
            { name: "PenyebabPribadiError" },
          ),
        },
      );

      system.logger.runWithContext(
        {
          traceId: "trace-redaction",
          channel: "whatsapp",
          operation: "group_turn",
          accountId: "utama",
        },
        () => {
          system.logger.error(
            "privacy_probe",
            "Probe redaksi gagal secara terkontrol.",
            error,
            {
              text: "cerita pribadi pengguna",
              prompt: "prompt rahasia",
              reply: "balasan rahasia",
              ownerId: "1234567890123",
              groupId: "120363000000000000@g.us",
              token: secretToken,
              nested: {
                mediaKey: "kunci-media-rahasia",
                directPath: "/v/t62/rahasia",
              },
              binary: Buffer.from("rahasia"),
              cyclic,
              payload: {
                message: {
                  conversation: "raw WhatsApp sangat rahasia",
                },
                first_name: "Nama Telegram Rahasia",
              },
              senderJidAlt: "62876543:3@lid",
              status: "status berupa kalimat pribadi",
            },
          );
          system.logger.error(
            "non_error_probe",
            "Rejection non-Error diterima.",
            "rejection string berisi curhat pribadi",
          );
          system.logger.info(
            "free_description_probe",
            "deskripsi call site berisi percakapan pribadi",
          );
        },
      );
      await system.flush();

      const records = await readRecords(directory);
      const record = records.find(
        (candidate) => candidate["event"] === "privacy_probe",
      );
      assert.ok(record);
      assert.equal(record["schema"], OPERATIONAL_LOG_SCHEMA);
      assert.equal(record["level"], "error");
      assert.equal(record["component"], "app");
      assert.equal(
        (record["context"] as Record<string, unknown>)["traceId"],
        "trace-redaction",
      );
      assert.equal(
        (record["context"] as Record<string, unknown>)["accountId"],
        "utama",
      );
      assert.match(String(record["timestamp"]), /^\d{4}-\d{2}-\d{2}T/);
      assert.match(
        String(
          (record["error"] as Record<string, unknown>)["fingerprint"],
        ),
        /^[a-f0-9]{16}$/,
      );

      const serialized = JSON.stringify(records);
      for (const forbidden of [
        "cerita pribadi pengguna",
        "prompt rahasia",
        "balasan rahasia",
        "1234567890123",
        "120363000000000000@g.us",
        secretToken,
        querySecret,
        "kunci-media-rahasia",
        "/v/t62/rahasia",
        "very-secret-token",
        "isi chat rahasia biasa",
        "IsiChatRahasiaError",
        "penyebab berisi cerita pribadi lain",
        "PenyebabPribadiError",
        "raw WhatsApp sangat rahasia",
        "Nama Telegram Rahasia",
        "62876543:3@lid",
        "status berupa kalimat pribadi",
        "rejection string berisi curhat pribadi",
        "deskripsi call site berisi percakapan pribadi",
        process.cwd(),
      ]) {
        assert.doesNotMatch(serialized, new RegExp(escapeRegExp(forbidden)));
      }
      assert.match(serialized, /PRIVATE_IDENTIFIER/);
      assert.match(serialized, /REDACTED/);
      assert.equal(
        (record["error"] as Record<string, unknown>)["type"],
        "error",
      );
      assert.match(serialized, /fieldsOmitted/);
      assert.doesNotMatch(serialized, /BINARY|CIRCULAR/);
      const prettyConsole = consoleOutput.join("");
      assert.match(
        prettyConsole,
        /privacy_probe[^\n]* error=error code=E_PROVIDER status=503 fingerprint=[a-f0-9]{16}/u,
      );
      assert.doesNotMatch(prettyConsole, /isi chat rahasia biasa/u);
      const nonError = records.find(
        (candidate) => candidate["event"] === "non_error_probe",
      );
      assert.equal(
        (nonError?.["error"] as Record<string, unknown>)["type"],
        "non_error_string",
      );
      await system.close();
    });
  });

  /**
   * Token prompt caching wajib lolos penyaring, bukan cuma diteruskan.
   *
   * Percobaan pertama menambahkannya di `ai_request_completed` dan tesnya lulus—
   * tetapi tes itu memakai logger palsu yang tidak melewati sanitasi sama
   * sekali. Sesi Telegram sungguhan 1 September 2026 memperlihatkan angkanya
   * tetap tidak muncul: nol dari enam belas permintaan, hanya `fieldsOmitted`
   * yang naik. Daftar-izin membuang field yang tidak dikenalnya tanpa suara.
   *
   * Jadi tes yang benar untuk daftar-izin harus menulis lewat sistem log
   * sungguhan dan membaca kembali berkasnya.
   */
  it("mengizinkan token cache prompt melewati penyaring", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));
      system.logger.info("cache_probe", "Token cache dicatat.", {
        inputTokens: 6_632,
        cacheReadTokens: 6_500,
        cacheWriteTokens: 132,
      });
      await system.flush();

      const record = (await readRecords(directory)).find(
        (candidate) => candidate["event"] === "cache_probe",
      );
      const data = record?.["data"] as Record<string, unknown>;
      assert.equal(data["cacheReadTokens"], 6_500);
      assert.equal(data["cacheWriteTokens"], 132);
      assert.equal(data["fieldsOmitted"], undefined);
    });
  });

  // Nol adalah kabar, bukan ketiadaan kabar: justru itu keadaan yang selama ini
  // tidak terlihat.
  it("mencatat token cache bernilai nol apa adanya", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));
      system.logger.info("cache_probe_nol", "Tidak ada yang ter-cache.", {
        cacheReadTokens: 0,
      });
      await system.flush();

      const record = (await readRecords(directory)).find(
        (candidate) => candidate["event"] === "cache_probe_nol",
      );
      const data = record?.["data"] as Record<string, unknown>;
      assert.equal(data["cacheReadTokens"], 0);
    });
  });

  it("mengizinkan counter context manifest tanpa membuka isi konteks", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));
      system.logger.info("context_manifest_probe", "Manifest konteks dicatat.", {
        contextManifestVersion: 1,
        contextBudgetBasis: "characters",
        contextTokenEstimateMethod: "characters_div_4_v1",
        contextBudgetCharacters: 16_000,
        contextIncludedCharacters: 4_000,
        contextEstimatedTokens: 1_000,
        contextUtilizationPercent: 25,
        inputTokenEstimate: 900,
        inputTokens: 1_000,
        inputTokenEstimateErrorTokens: -100,
        inputTokenEstimateRatioPermille: 900,
        tokenUsageEstimated: false,
        estimatedTokens: 900,
        contextIncludedTurns: 6,
        contextDroppedTurns: 2,
        contextIncludedMemories: 3,
        contextSummaryIncluded: true,
        summary: "isi ringkasan rahasia",
      });
      await system.flush();

      const record = (await readRecords(directory)).find(
        (candidate) => candidate["event"] === "context_manifest_probe",
      );
      const data = record?.["data"] as Record<string, unknown>;
      assert.equal(data["contextManifestVersion"], 1);
      assert.equal(data["contextBudgetCharacters"], 16_000);
      assert.equal(data["contextEstimatedTokens"], 1_000);
      assert.equal(data["contextIncludedCharacters"], 4_000);
      assert.equal(data["contextUtilizationPercent"], 25);
      assert.equal(data["inputTokenEstimate"], 900);
      assert.equal(data["inputTokens"], 1_000);
      assert.equal(data["inputTokenEstimateErrorTokens"], -100);
      assert.equal(data["inputTokenEstimateRatioPermille"], 900);
      assert.equal(data["tokenUsageEstimated"], false);
      assert.equal(data["estimatedTokens"], undefined);
      assert.equal(data["contextIncludedTurns"], undefined);
      assert.equal(data["contextDroppedTurns"], undefined);
      assert.equal(data["contextSummaryIncluded"], undefined);
      assert.doesNotMatch(JSON.stringify(record), /isi ringkasan rahasia/u);
      await system.close();
    });
  });

  it("mencatat keputusan semantic route tanpa isi pesan pengguna", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));
      system.logger.info(
        "semantic_route_selected",
        "Rute semantik terpilih.",
        {
          semanticDomain: "usage",
          semanticOperation: "show-details",
          confidenceBucket: "high",
          route: "account",
          recentContextUsed: true,
          recentContextKind: "interaction",
          deterministic: true,
          clarificationNeeded: false,
          semanticFallback: false,
          text: "detail saldo pribadi yang tidak boleh masuk log",
        },
      );
      await system.flush();

      const record = (await readRecords(directory)).find(
        (candidate) => candidate["event"] === "semantic_route_selected",
      );
      const data = record?.["data"] as Record<string, unknown>;
      assert.deepEqual(data, {
        semanticDomain: "usage",
        semanticOperation: "show-details",
        confidenceBucket: "high",
        route: "account",
        recentContextUsed: true,
        recentContextKind: "interaction",
        deterministic: true,
        clarificationNeeded: false,
        semanticFallback: false,
        text: "[REDACTED]",
      });
      assert.doesNotMatch(
        JSON.stringify(record),
        /detail saldo pribadi yang tidak boleh masuk log/u,
      );
      await system.close();
    });
  });

  it("menjaga trace terpisah pada pekerjaan async yang berjalan bersamaan", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));

      await Promise.all([
        system.logger.runWithContext(
          { traceId: "trace-a", channel: "telegram" },
          async () => {
            await delay(8);
            system.logger.info("trace_probe", "Trace A selesai.", {
              lane: "a",
            });
          },
        ),
        system.logger.runWithContext(
          { traceId: "trace-b", channel: "whatsapp" },
          async () => {
            await delay(1);
            system.logger.info("trace_probe", "Trace B selesai.", {
              lane: "b",
            });
          },
        ),
      ]);
      await system.flush();

      const records = (await readRecords(directory)).filter(
        (record) => record["event"] === "trace_probe",
      );
      assert.equal(records.length, 2);
      const byLane = new Map(
        records.map((record) => [
          (record["data"] as Record<string, unknown>)["lane"],
          (record["context"] as Record<string, unknown>)["traceId"],
        ]),
      );
      assert.equal(byLane.get("a"), "trace-a");
      assert.equal(byLane.get("b"), "trace-b");
      await system.close();
    });
  });

  it("merotasi segmen berdasarkan ukuran dan pergantian hari UTC", async () => {
    await withTempDirectory(async (directory) => {
      let now = new Date("2026-07-29T23:59:00.000Z");
      const system = await createOperationalLogSystem(
        options(directory, {
          now: () => now,
          maxSegmentBytes: 900,
          maxTotalBytes: 100_000,
        }),
      );
      for (let index = 0; index < 8; index += 1) {
        system.logger.info(
          "rotation_probe",
          `Record rotasi ${index} ${"x".repeat(220)}`,
        );
      }
      await system.flush();
      now = new Date("2026-07-30T00:01:00.000Z");
      system.logger.info("day_rotation_probe", "Hari UTC berubah.");
      await system.flush();

      const filenames = (await readdir(directory)).filter((name) =>
        name.endsWith(".ndjson"),
      );
      assert.ok(
        filenames.filter((name) => name.startsWith("harvy-20260729-"))
          .length >= 2,
      );
      assert.ok(
        filenames.some((name) => name.startsWith("harvy-20260730-")),
      );
      for (const filename of filenames) {
        assert.ok((await stat(join(directory, filename))).size > 0);
      }
      await system.close();
    });
  });

  it("menyerialkan rotasi, penulisan, dan maintenance yang berjalan bersamaan", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(
        options(directory, {
          maxSegmentBytes: 1_200,
          maxTotalBytes: 100_000,
        }),
      );
      const maintenance = Promise.all([
        system.maintain(),
        system.maintain(),
        system.maintain(),
      ]);
      for (let index = 0; index < 40; index += 1) {
        system.logger.info("concurrency_probe", "Record konkurensi.", {
          count: index,
        });
      }
      await maintenance;
      await system.close();

      const records = await readRecords(directory);
      assert.equal(
        records.filter(
          (record) => record["event"] === "concurrency_probe",
        ).length,
        40,
      );
      assert.equal(system.health().droppedRecords, 0);
    });
  });

  it("menghapus hanya segmen Harvy yang melewati retensi", async () => {
    await withTempDirectory(async (directory) => {
      const oldLog = join(directory, "harvy-20260101-0001.ndjson");
      const recentLog = join(directory, "harvy-20260728-0001.ndjson");
      const unrelated = join(directory, "catatan-penting.ndjson");
      await writeFile(oldLog, "{}\n", "utf8");
      await writeFile(recentLog, "{}\n", "utf8");
      await writeFile(unrelated, "jangan hapus\n", "utf8");
      const old = new Date("2026-01-01T00:00:00.000Z");
      const restoredNow = new Date("2026-07-29T00:00:00.000Z");
      // Retensi mengikuti tanggal UTC pada nama segmen. Copy/restore tidak
      // boleh memperpanjang umur file lama atau menghapus file baru.
      await utimes(oldLog, restoredNow, restoredNow);
      await utimes(recentLog, old, old);
      await utimes(unrelated, old, old);

      const system = await createOperationalLogSystem(
        options(directory, {
          now: () => new Date("2026-07-29T00:00:00.000Z"),
          retentionDays: 14,
        }),
      );
      await system.flush();

      const filenames = await readdir(directory);
      assert.equal(filenames.includes("harvy-20260101-0001.ndjson"), false);
      assert.equal(filenames.includes("harvy-20260728-0001.ndjson"), true);
      assert.equal(filenames.includes("catatan-penting.ndjson"), true);
      await system.close();
    });
  });

  it("membuang fragmen crash dan mempertahankan baris NDJSON terakhir yang valid", async () => {
    await withTempDirectory(async (directory) => {
      const filename = join(directory, "harvy-20260729-0001.ndjson");
      await writeFile(
        filename,
        `${JSON.stringify({
          schema: OPERATIONAL_LOG_SCHEMA,
          event: "record_sebelum_crash",
        })}\n{"schema":"${OPERATIONAL_LOG_SCHEMA}","event":"terpot`,
        "utf8",
      );

      const system = await createOperationalLogSystem(
        options(directory, {
          now: () => new Date("2026-07-29T12:00:00.000Z"),
        }),
      );
      await system.close();

      const content = await readFile(filename, "utf8");
      const lines = content.trim().split("\n");
      assert.ok(lines.length >= 2);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
      assert.doesNotMatch(content, /"event":"terpot/);
      const records = await readRecords(directory);
      const ready = records.find(
        (record) => record["event"] === "operational_logging_ready",
      );
      assert.equal(
        (ready?.["data"] as Record<string, unknown>)[
          "partialLinesRecovered"
        ],
        1,
      );
    });
  });

  it("tetap melayani dengan console tersaring saat sink file opsional gagal", async () => {
    await withTempDirectory(async (directory) => {
      const blockedPath = join(directory, "bukan-folder");
      await writeFile(blockedPath, "file", "utf8");
      const output: string[] = [];
      const stream = {
        write(chunk: string | Uint8Array): boolean {
          output.push(String(chunk));
          return true;
        },
      };
      const system = await createOperationalLogSystem(
        options(blockedPath, {
          // Ketika sink opsional gagal, fallback stderr tetap wajib hidup
          // meski operator semula mematikan console.
          consoleEnabled: false,
          fileRequired: false,
          stdout: stream,
          stderr: stream,
        }),
      );

      system.logger.error(
        "optional_sink_probe",
        "Operasi gagal dengan Bearer rahasia-sekali.",
        new Error("token 123456789:abcdefghijklmnopqrstuvwxyzABCDE"),
      );
      await system.flush();
      assert.equal(system.health().fileEnabled, false);
      assert.match(output.join(""), /optional_sink_probe/);
      assert.doesNotMatch(output.join(""), /rahasia-sekali/);
      assert.doesNotMatch(output.join(""), /abcdefghijklmnopqrstuvwxyzABCDE/);
      await system.close();

      await assert.rejects(
        createOperationalLogSystem(
          options(blockedPath, {
            fileRequired: true,
            consoleEnabled: false,
            stderr: stream,
          }),
        ),
      );
    });
  });

  it("mempertahankan health retensi dan tetap menutup handle saat sink wajib degraded", async () => {
    await withTempDirectory(async (directory) => {
      const configured = options(directory, {
        fileRequired: true,
        stderr: {
          write(): boolean {
            return true;
          },
        },
      });
      const system = await createOperationalLogSystem(configured);
      configured.directory = join(directory, "folder-yang-tidak-ada");

      await assert.rejects(system.maintain());
      assert.equal(system.health().writeHealthy, true);
      assert.equal(system.health().retentionHealthy, false);
      assert.equal(system.health().fileHealthy, false);
      await assert.rejects(system.close(), /LOG_FILE_REQUIRED/i);
      await assert.rejects(system.close(), /LOG_FILE_REQUIRED/i);
    });
  });

  it("membatasi antrean dan menghitung record yang dibuang", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(
        options(directory, {
          maxQueueBytes: 64,
          maxQueueRecords: 1,
        }),
      );
      for (let index = 0; index < 5; index += 1) {
        system.logger.info("queue_probe", "Record ini melebihi antrean.");
      }
      await system.flush();
      assert.ok(system.health().droppedRecords >= 5);
      await system.close();
    });
  });

  it("membatasi jalur darurat saat error storm agar tidak melewati cap disk", async () => {
    await withTempDirectory(async (directory) => {
      const maxSegmentBytes = 900;
      const maxTotalBytes = 1_000;
      const system = await createOperationalLogSystem(
        options(directory, {
          maxSegmentBytes,
          maxTotalBytes,
          maxQueueBytes: 64,
          maxQueueRecords: 1,
        }),
      );
      for (let index = 0; index < 100; index += 1) {
        system.logger.error(
          "emergency_storm_probe",
          "Error sintetis untuk menguji batas jalur darurat.",
          Object.assign(new Error("tidak disimpan"), {
            code: "E_STORM",
          }),
          { count: index },
        );
      }
      await system.flush();
      await system.close();

      const logFiles = (await readdir(directory)).filter((name) =>
        name.endsWith(".ndjson"),
      );
      const sizes = await Promise.all(
        logFiles.map(async (name) => (await stat(join(directory, name))).size),
      );
      assert.ok(sizes.every((size) => size <= maxSegmentBytes));
      assert.ok(
        sizes.reduce((total, size) => total + size, 0) <= maxTotalBytes,
      );
      assert.ok(system.health().droppedRecords > 0);
    });
  });

  it("memesan ruang writer sebelum await agar emergency concurrent tidak melewati cap", async () => {
    await withTempDirectory(async (directory) => {
      const maxSegmentBytes = 800;
      const system = await createOperationalLogSystem(
        options(directory, {
          maxSegmentBytes,
          maxTotalBytes: 100_000,
          maxQueueBytes: 400,
          maxQueueRecords: 10,
        }),
      );
      await system.flush();

      system.logger.info("normal_probe", "Record normal kecil.", {
        count: 1,
      });
      queueMicrotask(() => {
        system.logger.error(
          "emergency_probe",
          "Record darurat concurrent.",
          Object.assign(new Error("tidak disimpan"), {
            code: "E_RACE",
          }),
          { count: 2 },
        );
      });
      await delay(20);
      await system.close();

      const logFiles = (await readdir(directory)).filter((name) =>
        name.endsWith(".ndjson"),
      );
      const sizes = await Promise.all(
        logFiles.map(async (name) => (await stat(join(directory, name))).size),
      );
      assert.ok(sizes.every((size) => size <= maxSegmentBytes));
      assert.ok(system.health().droppedRecords > 0);
    });
  });

  it("menghentikan tulisan console saat backpressure agar buffer tidak tumbuh", async () => {
    await withTempDirectory(async (directory) => {
      const writes: string[] = [];
      let drain: (() => void) | undefined;
      let blocked = true;
      const stream = {
        write(chunk: string | Uint8Array): boolean {
          writes.push(String(chunk));
          return !blocked;
        },
        once(event: string, listener: () => void): void {
          if (event === "drain") drain = listener;
        },
      };
      const system = await createOperationalLogSystem(
        options(directory, {
          consoleEnabled: true,
          stdout: stream,
          stderr: stream,
        }),
      );
      const writesAtBackpressure = writes.length;
      system.logger.info("console_probe_one", "Record pertama.");
      system.logger.info("console_probe_two", "Record kedua.");
      assert.equal(writes.length, writesAtBackpressure);
      assert.ok(system.health().consoleDroppedRecords >= 2);

      blocked = false;
      drain?.();
      system.logger.info("console_probe_recovered", "Console pulih.");
      assert.equal(writes.length, writesAtBackpressure + 1);
      await system.close();
      const records = await readRecords(directory);
      assert.ok(
        records.some(
          (record) =>
            record["event"] === "console_backpressure_started",
        ),
      );
      assert.ok(
        records.some(
          (record) =>
            record["event"] === "console_backpressure_recovered",
        ),
      );
    });
  });

  it("adapter Baileys membuang payload mentah dan menormalkan restart 515", async () => {
    await withTempDirectory(async (directory) => {
      const system = await createOperationalLogSystem(options(directory));
      const baileys = createBaileysLogger(system.logger, "utama");
      baileys.info(
        {
          initialHistBootstrapInlinePayload:
            "arsip-chat-yang-tidak-boleh-tercatat",
        },
        "history received",
      );
      baileys.error(
        {
          fullErrorNode: {
            attrs: { code: "515" },
            content: "payload-protokol-rahasia",
          },
          mediaKey: "media-rahasia",
        },
        "stream errored out",
      );
      baileys.error(
        {
          code: 500,
          body: "isi-respons-rahasia",
        },
        "connection errored",
      );
      await system.flush();

      const records = await readRecords(directory);
      assert.ok(
        records.some(
          (record) => record["event"] === "baileys_restart_required",
        ),
      );
      assert.ok(
        records.some(
          (record) => record["event"] === "baileys_connection_error",
        ),
      );
      const serialized = JSON.stringify(records);
      assert.doesNotMatch(
        serialized,
        /arsip-chat-yang-tidak-boleh-tercatat/,
      );
      assert.doesNotMatch(serialized, /payload-protokol-rahasia/);
      assert.doesNotMatch(serialized, /media-rahasia/);
      assert.doesNotMatch(serialized, /isi-respons-rahasia/);
      await system.close();
    });
  });

  it("tidak pernah menampilkan secret operator di production atau non-TTY", () => {
    const writes: string[] = [];
    const stream = {
      write(chunk: string | Uint8Array): boolean {
        writes.push(String(chunk));
        return true;
      },
    };
    assert.equal(operatorSecretChannelAvailable("production", true), false);
    assert.equal(
      presentOperatorSecret("QR-RAHASIA", {
        environment: "production",
        interactive: true,
        stream,
      }),
      false,
    );
    assert.equal(
      presentOperatorSecret("PAIRING-RAHASIA", {
        environment: "development",
        interactive: false,
        stream,
      }),
      false,
    );
    assert.deepEqual(writes, []);
    assert.equal(
      presentOperatorSecret("AMAN-HANYA-TERMINAL", {
        environment: "development",
        interactive: true,
        stream,
      }),
      true,
    );
    assert.deepEqual(writes, ["AMAN-HANYA-TERMINAL\n"]);
    assert.equal(
      presentOperatorSecret("GAGAL-TULIS", {
        environment: "development",
        interactive: true,
        stream: {
          write(): boolean {
            throw new Error("stream rusak");
          },
        },
      }),
      false,
    );
  });

  it("mencatat rejection fatal tanpa membiarkan Node mencetak pesan mentah", async () => {
    await withTempDirectory(async (directory) => {
      const loggerUrl = new URL(
        "../src/observability/operational-logger.js",
        import.meta.url,
      ).href;
      const diagnosticsUrl = new URL(
        "../src/observability/process-diagnostics.js",
        import.meta.url,
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            const { createOperationalLogSystem } = await import(${JSON.stringify(loggerUrl)});
            const { installProcessDiagnostics } = await import(${JSON.stringify(diagnosticsUrl)});
            const system = await createOperationalLogSystem({
              directory: process.env.HARVY_FATAL_LOG_DIR,
              level: "trace",
              environment: "test",
              release: "test",
              retentionDays: 14,
              maxSegmentBytes: 262144,
              maxTotalBytes: 1048576,
              maxQueueRecords: 100,
              maxQueueBytes: 262144,
              consoleEnabled: false,
              consoleFormat: "json",
              fileRequired: true
            });
            installProcessDiagnostics(system, system.logger.child("process"));
            Promise.reject(new Error("SENTINEL_FATAL_RAHASIA"));
            setInterval(() => undefined, 1000);
          `,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HARVY_FATAL_LOG_DIR: directory,
          },
          timeout: 10_000,
        },
      );

      assert.equal(child.status, 1);
      assert.doesNotMatch(
        `${child.stdout}${child.stderr}`,
        /SENTINEL_FATAL_RAHASIA/,
      );
      const records = await readRecords(directory);
      assert.ok(
        records.some(
          (record) =>
            record["event"] === "process_unhandled_rejection",
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(records),
        /SENTINEL_FATAL_RAHASIA/,
      );
    });
  });
});

function options(
  directory: string,
  overrides: Partial<OperationalLogOptions> = {},
): OperationalLogOptions {
  return {
    directory,
    level: "trace",
    environment: "test",
    release: "test",
    retentionDays: 14,
    maxSegmentBytes: 25 * 1024,
    maxTotalBytes: 250 * 1024,
    maxQueueRecords: 1_000,
    maxQueueBytes: 2 * 1024 * 1024,
    consoleEnabled: false,
    consoleFormat: "json",
    fileRequired: true,
    ...overrides,
  };
}

async function readRecords(
  directory: string,
): Promise<Record<string, unknown>[]> {
  const filenames = (await readdir(directory))
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
  const records: Record<string, unknown>[] = [];
  for (const filename of filenames) {
    const content = await readFile(join(directory, filename), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return records;
}

async function withTempDirectory(
  action: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-log-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
