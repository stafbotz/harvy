import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  MessageBatcher,
  type MessageBatchMetrics,
} from "../src/bot/message-batcher.js";
import type { TurnBoundaryState } from "../src/core/turn-taking-policy.js";
import { AdaptiveDebouncePolicy } from "../src/core/adaptive-debounce-policy.js";

describe("MessageBatcher", () => {
  it("memakai settle adaptif setelah ritme bubble pemilik terukur", async () => {
    const handled: string[] = [];
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 50,
      maxDelayMs: 50,
      maxGapMs: 500,
    });
    policy.observe("student", 10);
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      500,
      250,
      400,
      300,
      undefined,
      undefined,
      policy,
    );

    batcher.enqueue("student", "iya", "ctx");

    await waitFor(() => handled.length === 1, 180);
    assert.deepEqual(handled, ["iya"]);
  });

  it("mempelajari ritme pemilik lintas batch tanpa pre-seed manual", async () => {
    const handled: string[] = [];
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 80,
      maxDelayMs: 80,
      maxGapMs: 10_000,
    });
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      500,
      10,
      400,
      300,
      undefined,
      undefined,
      policy,
    );

    batcher.enqueue("student", "pertama", "ctx-1");
    await waitFor(() => handled.length === 1, 200);
    await delay(40);
    batcher.enqueue("student", "kedua", "ctx-2");
    await delay(30);
    assert.deepEqual(handled, ["pertama"]);
    await waitFor(() => handled.length === 2, 200);
  });

  it("tidak memendekkan window fragmen keras dari profil debounce", async () => {
    const handled: string[] = [];
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 10,
      maxDelayMs: 10,
      maxGapMs: 500,
    });
    policy.observe("student", 5);
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      180,
      50,
      120,
      80,
      undefined,
      undefined,
      policy,
    );

    batcher.enqueue("student", "karena", "ctx");
    await delay(90);
    assert.deepEqual(handled, []);
    await waitFor(() => handled.length === 1, 180);
  });

  it("melupakan timing pemilik saat batch diinvalidasi", () => {
    const policy = new AdaptiveDebouncePolicy({ minSamples: 1 });
    policy.observe("student", 800);
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async () => undefined,
      500,
      50,
      400,
      300,
      undefined,
      undefined,
      policy,
    );

    batcher.invalidate("student");

    assert.equal(policy.estimate("student", 650).adaptive, false);
  });

  it("menggabungkan bubble yang dipenggal sebelum menjawab", async () => {
    const handled: string[] = [];
    const carriers: string[] = [];
    const examined: string[] = [];
    const fullText =
      "aku mau curhat\njadi gini\naku kan cowo\ntapi aku suka cowo";
    const batcher = new MessageBatcher<string>(
      async (text) => {
        examined.push(text);
        return text.includes("tapi aku suka cowo")
          ? {
              state: "complete",
              confidence: 0.6,
              continuationLikelihood: 0.55,
              reasonClass: "uncertain",
            }
          : {
              state: "open",
              confidence: 0.9,
              continuationLikelihood: 0.9,
              reasonClass: "narrative-continuation",
            };
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
        carriers.push(batch.carrier);
      },
      5_000,
      40,
      5_000,
      2_000,
    );

    batcher.enqueue("student", "aku mau curhat", "ctx-1");
    await delay(5);
    batcher.enqueue("student", "jadi gini", "ctx-2");
    await delay(5);
    batcher.enqueue("student", "aku kan cowo", "ctx-3");
    await delay(5);
    batcher.enqueue("student", "tapi aku suka cowo", "ctx-4");
    await waitFor(() => examined.at(-1) === fullText, 5_000);
    assert.deepEqual(handled, []);
    await batcher.drain("student");

    assert.deepEqual(handled, [fullText]);
    assert.equal(examined.at(-1), fullText);
    assert.deepEqual(carriers, ["ctx-4"]);
  });

  it("langsung memproses pesan yang sudah lengkap", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      100,
      1,
    );

    batcher.enqueue("student", "halo", "ctx");
    await waitFor(() => handled.length === 1);
    assert.deepEqual(handled, ["halo"]);
  });

  it("melewati classifier untuk bentuk lokal yang jelas", async () => {
    const classified: string[] = [];
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        classified.push(text);
        return "complete";
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      30,
      1,
      20,
      20,
    );
    const messages = [
      "iya",
      "oke",
      "makasih",
      "B",
      "karena",
      "tapi",
      "terus aku",
      "jadi tadi aku mau",
    ];

    messages.forEach((message, index) => {
      batcher.enqueue(`student-${index}`, message, message);
    });
    await waitFor(() => handled.length === messages.length, 1_500);

    assert.deepEqual(classified, []);
    assert.deepEqual(handled.sort(), [...messages].sort());
  });

  it("memakai classifier hanya untuk bentuk ambigu", async () => {
    const classified: string[] = [];
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        classified.push(text);
        return "complete";
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      40,
      1,
      20,
      20,
    );
    const messages = ["jadi gini", "aku mau cerita", "aku capek banget"];

    messages.forEach((message, index) => {
      batcher.enqueue(`student-${index}`, message, message);
    });
    await waitFor(() => handled.length === messages.length, 1_500);

    assert.deepEqual(classified.sort(), [...messages].sort());
  });

  it("menyimak seluruh rangkaian curhat meski jedanya melewati debounce", async () => {
    const handled: string[] = [];
    const examined: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        examined.push(text);
        return {
          state: "open",
          confidence: 0.9,
          continuationLikelihood: 0.9,
          reasonClass: "narrative-continuation",
        };
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      5_000,
      5,
      3_000,
      1_500,
    );

    const bubbles = [
      "eh tau ga",
      "sumpah",
      "aku cape banget",
      "ada tigasss",
      "aku takutttt banget",
    ];
    for (const bubble of bubbles) {
      batcher.enqueue("student", bubble, bubble);
      await delay(20);
      assert.deepEqual(handled, []);
    }

    // Tidak menunggu timer produksi versi mini: drain membuktikan seluruh
    // potongan masih berada pada satu entry tanpa membuat tes timer rentan pada
    // beban CPU mesin CI.
    await batcher.drain("student");
    assert.equal(handled[0], bubbles.join("\n"));
    assert.ok(
      examined.length >= 2,
      "jeda antar-bubble harus benar-benar melewati debounce evaluator",
    );
  });

  it("menunggu paling lama ketika bubble terakhir masih menggantung", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => ({
        state: "open",
        confidence: 0.9,
        continuationLikelihood: 0.9,
        reasonClass: "narrative-continuation",
      }),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      5_000,
      5,
      3_000,
      1_500,
    );

    batcher.enqueue("student", "aku mau curhat", "ctx-1");
    await delay(20);
    batcher.enqueue("student", "aku hari ini", "ctx-2");
    await delay(45);
    batcher.enqueue("student", "capekk banget", "ctx-3");
    await delay(45);
    batcher.enqueue("student", "karna", "ctx-4");

    await delay(100);
    assert.deepEqual(
      handled,
      [],
      "fragmen 'karna' harus tetap berada di batch sampai jendela panjangnya selesai",
    );

    await batcher.drain("student");
    assert.deepEqual(handled, [
      "aku mau curhat\naku hari ini\ncapekk banget\nkarna",
    ]);
  });

  it("memproses seketika ketika fallback model menyatakan urgent", async () => {
    const handled: Array<{ text: string; urgentBoundary: boolean }> = [];
    const batcher = new MessageBatcher<string>(
      async () => "urgent" as TurnBoundaryState,
      async (_ownerId, batch) => {
        handled.push({
          text: batch.text,
          urgentBoundary: batch.urgentBoundary,
        });
      },
      200,
      5,
      150,
      80,
    );

    batcher.enqueue("student", "aku capek banget", "ctx-1");

    await waitFor(() => handled.length === 1, 120);
    assert.deepEqual(handled, [{
      text: "aku capek banget",
      urgentBoundary: true,
    }]);
  });

  it("mengakui bahaya eksplisit sebelum debounce tanpa classifier", async () => {
    let classifierCalls = 0;
    const handled: string[] = [];
    const acknowledgements: string[] = [];
    const batcher = new MessageBatcher<string>(
      () => {
        classifierCalls += 1;
        return new Promise<TurnBoundaryState>(() => undefined);
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      500,
      150,
      300,
      200,
    ).onUrgent(async (_ownerId, batch) => {
      acknowledgements.push(batch.text);
    });

    const emergency = "aku mau menyakiti diri sekarang\ntolong jawab cepat";
    batcher.enqueue("student", emergency, "ctx-1");

    await waitFor(
      () => acknowledgements.length === 1 && handled.length === 1,
      120,
    );
    assert.equal(classifierCalls, 0);
    assert.deepEqual(acknowledgements, [emergency]);
    assert.deepEqual(handled, [emergency]);
  });

  it("mempertahankan sinyal darurat bubble terbaru saat batch lama memuat marker konteks", async () => {
    let classifierCalls = 0;
    const acknowledgements: Array<{
      text: string;
      explicitImmediateDanger: boolean;
    }> = [];
    const handled: Array<{
      text: string;
      explicitImmediateDanger: boolean;
    }> = [];
    const batcher = new MessageBatcher<string>(
      async () => {
        classifierCalls += 1;
        return "complete";
      },
      async (_ownerId, batch) => {
        handled.push({
          text: batch.text,
          explicitImmediateDanger: batch.explicitImmediateDanger,
        });
      },
      500,
      150,
      300,
      200,
    ).onUrgent(async (_ownerId, batch) => {
      acknowledgements.push({
        text: batch.text,
        explicitImmediateDanger: batch.explicitImmediateDanger,
      });
    });

    batcher.enqueue("student", "contoh untuk tugas", "ctx-1");
    batcher.enqueue("student", "aku dalam bahaya sekarang", "ctx-2");

    await waitFor(
      () => acknowledgements.length === 1 && handled.length === 1,
      1_500,
    );
    const expected = {
      text: "contoh untuk tugas\naku dalam bahaya sekarang",
      explicitImmediateDanger: true,
    };
    assert.equal(classifierCalls, 0);
    assert.deepEqual(acknowledgements, [expected]);
    assert.deepEqual(handled, [expected]);
  });

  it("menyerahkan kutipan bahaya ke classifier tanpa urgent palsu", async () => {
    let classifierCalls = 0;
    const acknowledgements: string[] = [];
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => {
        classifierCalls += 1;
        return "complete";
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      100,
      1,
    ).onUrgent(async (_ownerId, batch) => {
      acknowledgements.push(batch.text);
    });

    batcher.enqueue(
      "student",
      "contoh dialog:\naku mau bunuh diri sekarang",
      "ctx",
    );
    await waitFor(() => handled.length === 1);

    assert.equal(classifierCalls, 1);
    assert.deepEqual(acknowledgements, []);
  });

  it("mengabaikan keputusan model yang kalah cepat dari bubble berikutnya", async () => {
    const decisions: Array<(value: TurnBoundaryState) => void> = [];
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      () =>
        new Promise<TurnBoundaryState>((resolve) => {
          decisions.push(resolve);
        }),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      100,
      1,
    );

    batcher.enqueue("student", "aku capek banget", "ctx-1");
    await waitFor(() => decisions.length === 1, 1_500);
    batcher.enqueue("student", "lanjutannya ini", "ctx-2");

    decisions[0]?.("complete");
    await delay(5);
    assert.deepEqual(handled, []);

    await waitFor(() => decisions.length === 2, 1_500);
    decisions[1]?.("complete");
    await waitFor(() => handled.length === 1, 1_500);
    assert.deepEqual(handled, ["aku capek banget\nlanjutannya ini"]);
  });

  it("tidak membiarkan model lambat melewati batas hening", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      () => new Promise<TurnBoundaryState>(() => undefined),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      35,
      1,
    );

    batcher.enqueue("student", "jadi gini", "ctx");
    // Deadline perilaku tetap 35 ms. Batas tunggu assertion dibuat longgar
    // karena seluruh suite berjalan paralel dan dapat menahan event loop pada
    // mesin CI; yang diuji di sini adalah fail-safe tetap akhirnya menang.
    await waitFor(() => handled.length === 1, 1_500);

    assert.deepEqual(handled, ["jadi gini"]);
  });

  it("menunggu handler aktif sebelum command boleh melanjutkan", async () => {
    let releaseHandle: (() => void) | undefined;
    let started = false;
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async () => {
        started = true;
        await new Promise<void>((resolve) => {
          releaseHandle = resolve;
        });
      },
      100,
      1,
    );

    batcher.enqueue("student", "pesan lama", "ctx");
    await waitFor(() => started);

    let barrierPassed = false;
    const barrier = batcher.cancelAndWait("student").then(() => {
      barrierPassed = true;
    });
    await delay(10);
    assert.equal(barrierPassed, false);

    releaseHandle?.();
    await barrier;
    assert.equal(barrierPassed, true);
  });

  it("membatalkan signal run aktif sebelum command mengantre", async () => {
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        events.push("run mulai");
        await new Promise<void>((resolve) => {
          batch.signal.addEventListener("abort", () => {
            events.push("run batal");
            resolve();
          }, { once: true });
        });
        assert.equal(batch.isCurrent(), false);
      },
      100,
      1,
    );

    batcher.enqueue("student", "pesan lama", "ctx");
    await waitFor(() => events.includes("run mulai"));
    batcher.cancelAndEnqueue("student", async () => {
      events.push("command");
    });

    await waitFor(() => events.includes("command"));
    assert.deepEqual(events, ["run mulai", "run batal", "command"]);
  });

  it("menguras bubble yang lebih dulu masuk sebelum tindakan tombol", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "open",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      5_000,
      1_000,
    );

    batcher.enqueue("student", "pesan sebelum tombol", "ctx");
    await batcher.drain("student");

    assert.deepEqual(handled, ["pesan sebelum tombol"]);
  });

  it("mengabaikan keputusan model yang selesai setelah deadline", async () => {
    let resolveDecision: ((value: TurnBoundaryState) => void) | undefined;
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      () =>
        new Promise<TurnBoundaryState>((resolve) => {
          resolveDecision = resolve;
        }),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      30,
      1,
    );

    batcher.enqueue("student", "pesan lengkap", "ctx");
    await waitFor(() => handled.length === 1, 1_500);
    resolveDecision?.("complete");
    await delay(10);

    assert.deepEqual(handled, ["pesan lengkap"]);
  });

  it("membatalkan evaluator tertunda sebelum mengantrekan command", async () => {
    let resolveDecision: ((value: TurnBoundaryState) => void) | undefined;
    const handled: string[] = [];
    const actions: string[] = [];
    const batcher = new MessageBatcher<string>(
      () =>
        new Promise<TurnBoundaryState>((resolve) => {
          resolveDecision = resolve;
        }),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      1_000,
      1,
    );

    batcher.enqueue("student", "bubble yang dibatalkan", "ctx");
    await waitFor(() => resolveDecision !== undefined);
    batcher.cancelAndEnqueue("student", async () => {
      actions.push("command");
    });
    await waitFor(() => actions.length === 1);

    resolveDecision?.("complete");
    await delay(10);
    assert.deepEqual(handled, []);
    assert.deepEqual(actions, ["command"]);
  });

  it("membatalkan batch yang sudah mengantre tetapi belum mulai", async () => {
    let releaseA: (() => void) | undefined;
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        if (batch.text === "A") {
          handled.push("A mulai");
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
          handled.push("A selesai");
          return;
        }
        handled.push(batch.text);
      },
      1_000,
      1,
    );

    batcher.enqueue("student", "A", "ctx-a");
    await waitFor(() => handled.includes("A mulai"));
    batcher.enqueue("student", "B", "ctx-b");

    // drain memasang B pada chain secara sinkron, tetapi A masih aktif.
    const draining = batcher.drain("student");
    batcher.cancelAndEnqueue("student", async () => {
      handled.push("command");
    });
    releaseA?.();

    await draining;
    await waitFor(() => handled.includes("command"));
    assert.deepEqual(handled, ["A mulai", "A selesai", "command"]);
  });

  it("mendeduplikasi revisi ketika evaluator lama masih berjalan", async () => {
    const resolvers: Array<(value: TurnBoundaryState) => void> = [];
    const examined: string[] = [];
    const handled: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const batcher = new MessageBatcher<string>(
      (text) => {
        examined.push(text);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return new Promise<TurnBoundaryState>((resolve) => {
          resolvers.push((value) => {
            active -= 1;
            resolve(value);
          });
        });
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      1_000,
      5,
      1_000,
      1,
    );

    batcher.enqueue("student", "satu", "ctx-1");
    await waitFor(() => resolvers.length === 1);
    batcher.enqueue("student", "dua", "ctx-2");
    await delay(10);
    batcher.enqueue("student", "tiga", "ctx-3");
    await delay(10);

    assert.equal(resolvers.length, 1);
    resolvers[0]?.("open");
    await waitFor(() => resolvers.length === 2);
    assert.deepEqual(examined, [
      "satu",
      "satu\ndua\ntiga",
    ]);
    assert.equal(maximumActive, 1);

    resolvers[1]?.("complete");
    await waitFor(() => handled.length === 1);
    assert.deepEqual(handled, ["satu\ndua\ntiga"]);
  });

  it("mengantrekan A aktif, B tertunda, lalu tombol dalam urutan yang sama", async () => {
    let releaseA: (() => void) | undefined;
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        if (batch.text === "A") {
          events.push("A mulai");
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
          events.push("A selesai");
          return;
        }
        events.push(batch.text);
      },
      1_000,
      1,
    );

    batcher.enqueue("student", "A", "ctx-a");
    await waitFor(() => events.includes("A mulai"));
    batcher.enqueue("student", "B", "ctx-b");
    batcher.drainAndEnqueue("student", async () => {
      events.push("tombol");
    });

    await delay(10);
    assert.deepEqual(events, ["A mulai"]);
    releaseA?.();
    await waitFor(() => events.includes("tombol"));
    assert.deepEqual(events, ["A mulai", "A selesai", "B", "tombol"]);
  });

  it("tetap menjalankan tindakan setelah handler sebelumnya gagal", async () => {
    const events: string[] = [];
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const batcher = new MessageBatcher<string>(
        async () => "complete",
        async () => {
          events.push("handler");
          throw new Error("sengaja gagal");
        },
        1_000,
        1,
      );

      batcher.enqueue("student", "A", "ctx");
      await waitFor(() => events.includes("handler"));
      batcher.cancelAndEnqueue("student", async () => {
        events.push("command");
      });
      await waitFor(() => events.includes("command"));

      assert.deepEqual(events, ["handler", "command"]);
    } finally {
      console.error = originalError;
    }
  });

  it("barrier satu pengguna tidak menahan pengguna lain", async () => {
    let releaseA: (() => void) | undefined;
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (ownerId) => {
        if (ownerId === "A") {
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
        }
      },
      1_000,
      1,
    );

    batcher.enqueue("A", "pesan A", "ctx-a");
    await waitFor(() => releaseA !== undefined);
    batcher.cancelAndEnqueue("A", async () => {
      events.push("aksi A");
    });
    batcher.cancelAndEnqueue("B", async () => {
      events.push("aksi B");
    });

    await waitFor(() => events.includes("aksi B"));
    assert.deepEqual(events, ["aksi B"]);
    releaseA?.();
    await waitFor(() => events.includes("aksi A"));
    assert.deepEqual(events, ["aksi B", "aksi A"]);
  });

  it("menguras seluruh batch saat proses berhenti normal", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "open",
      async (ownerId, batch) => {
        handled.push(`${ownerId}:${batch.text}`);
      },
      5_000,
      1_000,
    );

    batcher.enqueue("A", "pesan A", "ctx-a");
    batcher.enqueue("B", "pesan B", "ctx-b");
    await batcher.drainAll();

    assert.deepEqual(handled.sort(), ["A:pesan A", "B:pesan B"]);
  });

  it("menunggu evaluator aktif ketika proses berhenti normal", async () => {
    let resolveDecision: ((value: TurnBoundaryState) => void) | undefined;
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      () =>
        new Promise<TurnBoundaryState>((resolve) => {
          resolveDecision = resolve;
        }),
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      1_000,
      1,
    );

    batcher.enqueue("A", "pesan A", "ctx-a");
    await waitFor(() => resolveDecision !== undefined);
    let drained = false;
    const shutdown = batcher.drainAll().then(() => {
      drained = true;
    });

    await delay(10);
    assert.equal(drained, false);
    resolveDecision?.("open");
    await shutdown;
    assert.deepEqual(handled, ["pesan A"]);
  });

  it("worker tidak memaksa bubble yang masih terbuka", async () => {
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "open",
      async (_ownerId, batch) => {
        events.push(`pesan:${batch.text}`);
      },
      1_000,
      100,
    );

    batcher.enqueue("A", "aku masih cerita", "ctx");
    assert.equal(
      await batcher.runWhenIdle("A", async () => {
        events.push("worker");
      }),
      false,
    );
    assert.equal(events.length, 0);

    await batcher.drain("A");
    assert.equal(
      await batcher.runWhenIdle("A", async () => {
        events.push("worker");
      }),
      true,
    );
    assert.deepEqual(events, ["pesan:aku masih cerita", "worker"]);
  });

  it("invalidasi membatalkan bubble yang masuk selama penghapusan", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      100,
      20,
    );

    batcher.enqueue("A", "jangan diproses", "ctx");
    batcher.invalidate("A");
    await delay(130);
    assert.deepEqual(handled, []);
  });

  it("mengirim acknowledgment urgent sebelum handler lama selesai", async () => {
    let releaseOld: (() => void) | undefined;
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => (text === "darurat" ? "urgent" : "complete"),
      async (_ownerId, batch) => {
        events.push(`mulai:${batch.text}`);
        if (batch.text === "lama") {
          await new Promise<void>((resolve) => {
            releaseOld = resolve;
          });
        }
        events.push(`selesai:${batch.text}`);
      },
      200,
      1,
    ).onUrgent(async (_ownerId, batch) => {
      events.push(`ack:${batch.text}`);
    });

    batcher.enqueue("A", "lama", "ctx-lama");
    await waitFor(() => releaseOld !== undefined);
    batcher.enqueue("A", "darurat", "ctx-darurat");
    await waitFor(() => events.includes("ack:darurat"));

    assert.equal(events.includes("selesai:lama"), false);
    assert.equal(events.includes("mulai:darurat"), false);

    releaseOld?.();
    await batcher.drainAll();
    assert.deepEqual(events, [
      "mulai:lama",
      "ack:darurat",
      "selesai:lama",
      "mulai:darurat",
      "selesai:darurat",
    ]);
  });

  it("membatalkan batch biasa yang sudah antre sebelum giliran urgent", async () => {
    let releaseOld: (() => void) | undefined;
    let queuedClassified = false;
    const events: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        if (text === "pesan antre") queuedClassified = true;
        return "complete";
      },
      async (_ownerId, batch) => {
        events.push(`mulai:${batch.text}`);
        if (batch.text === "lama") {
          await new Promise<void>((resolve) => {
            releaseOld = resolve;
          });
        }
        events.push(`selesai:${batch.text}`);
      },
      200,
      1,
    ).onUrgent(async (_ownerId, batch) => {
      events.push(`ack:${batch.text}`);
    });

    batcher.enqueue("A", "lama", "ctx-lama");
    await waitFor(() => releaseOld !== undefined);
    batcher.enqueue("A", "pesan antre", "ctx-antre");
    await waitFor(() => queuedClassified);
    await delay(5);
    batcher.enqueue(
      "A",
      "aku mau menyakiti diri sekarang",
      "ctx-urgent",
    );
    await waitFor(() =>
      events.includes("ack:aku mau menyakiti diri sekarang")
    );

    releaseOld?.();
    await batcher.drainAll();

    assert.deepEqual(events, [
      "mulai:lama",
      "ack:aku mau menyakiti diri sekarang",
      "selesai:lama",
      "mulai:aku mau menyakiti diri sekarang",
      "selesai:aku mau menyakiti diri sekarang",
    ]);
  });

  it("memakai turnId yang sama dari boundary sampai metrik handler", async () => {
    let classifiedTurnId: string | undefined;
    let handledTurnId: string | undefined;
    const metrics: MessageBatchMetrics[] = [];
    const batcher = new MessageBatcher<string>(
      async (_text, _ownerId, turnId) => {
        classifiedTurnId = turnId;
        return "complete";
      },
      async (_ownerId, batch) => {
        handledTurnId = batch.turnId;
      },
      100,
      1,
      20,
      20,
      undefined,
      (record) => {
        metrics.push(record);
      },
    );

    batcher.enqueue("A", "pesan lengkap", "ctx");
    await waitFor(() => metrics.length === 1);

    assert.ok(classifiedTurnId);
    assert.equal(handledTurnId, classifiedTurnId);
    assert.equal(metrics[0]?.turnId, classifiedTurnId);
    assert.equal(metrics[0]?.outcome, "completed");
    assert.equal(metrics[0]?.bubbleCount, 1);
    assert.ok((metrics[0]?.totalLatencyMs ?? -1) >= 0);
  });

  it("menutup span batch tertunda sebagai cancelled saat diinvalidasi", async () => {
    const metrics: MessageBatchMetrics[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async () => undefined,
      100,
      20,
      20,
      20,
      undefined,
      (record) => {
        metrics.push(record);
      },
    );

    batcher.enqueue("A", "pesan batal", "ctx");
    batcher.invalidate("A");

    await waitFor(() => metrics.length === 1);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.outcome, "cancelled");
    assert.equal(metrics[0]?.bubbleCount, 1);
  });

  it("kegagalan sinkron observer tidak membatalkan invalidasi", async () => {
    const handled: string[] = [];
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      50,
      5,
      20,
      20,
      undefined,
      () => {
        throw new Error("observer sengaja gagal");
      },
    );

    batcher.enqueue("A", "jangan diproses", "ctx");
    assert.doesNotThrow(() => batcher.invalidate("A"));
    await delay(60);
    assert.deepEqual(handled, []);
  });

  for (const relation of ["addition", "correction"] as const) {
    it(`mengganti run aktif dan menggabungkan konteks ${relation} yang belum durable`, async () => {
      const handled: Array<{
        text: string;
        relation: string | null;
        current: boolean;
      }> = [];
      let activeStarted = false;
      const batcher = new MessageBatcher<string>(
        async () => "complete",
        async (_ownerId, batch) => {
          if (batch.text === "pilihin aku ITB atau UI?") {
            activeStarted = true;
            await new Promise<void>((resolve) => {
              batch.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            handled.push({
              text: batch.text,
              relation: batch.interruptionRelation,
              current: await batch.awaitCurrent(),
            });
            return;
          }
          handled.push({
            text: batch.text,
            relation: batch.interruptionRelation,
            current: await batch.awaitCurrent(),
          });
        },
        150,
        1,
        30,
        20,
        undefined,
        undefined,
        undefined,
        async () => relation,
      );

      batcher.enqueue("student", "pilihin aku ITB atau UI?", "ctx-1");
      await waitFor(() => activeStarted);
      batcher.enqueue(
        "student",
        relation === "addition"
          ? "pertimbangin juga aku pengen kerja di AI"
          : "eh maksudku ITB atau ITS",
        "ctx-2",
      );
      await batcher.drainAll();

      assert.equal(handled[0]?.current, false);
      assert.equal(handled[1]?.relation, relation);
      assert.match(handled[1]?.text ?? "", /^pilihin aku ITB atau UI\?/u);
      assert.equal(handled[1]?.current, true);
    });
  }

  it("redirect membatalkan output lama tanpa membawa permintaan lama", async () => {
    const handled: Array<{ text: string; relation: string | null }> = [];
    let activeStarted = false;
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        if (batch.text === "cari biaya kuliah ITB?") {
          activeStarted = true;
          await new Promise<void>((resolve) => {
            batch.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return;
        }
        handled.push({
          text: batch.text,
          relation: batch.interruptionRelation,
        });
      },
      150,
      1,
      30,
      20,
      undefined,
      undefined,
      undefined,
      async () => "redirect",
    );

    batcher.enqueue("student", "cari biaya kuliah ITB?", "ctx-1");
    await waitFor(() => activeStarted);
    batcher.enqueue("student", "udah deh bahas UI dulu", "ctx-2");
    await batcher.drainAll();

    assert.deepEqual(handled, [{
      text: "udah deh bahas UI dulu",
      relation: "redirect",
    }]);
  });

  it("pesan independen mengantre tanpa membatalkan run aktif", async () => {
    const events: string[] = [];
    let releaseActive: (() => void) | undefined;
    const batcher = new MessageBatcher<string>(
      async () => "complete",
      async (_ownerId, batch) => {
        if (batch.text === "bandingkan dua jurusan?") {
          events.push("aktif-mulai");
          await new Promise<void>((resolve) => {
            releaseActive = resolve;
          });
          events.push(batch.signal.aborted ? "aktif-batal" : "aktif-selesai");
          return;
        }
        events.push(`berikut:${batch.interruptionRelation}:${batch.text}`);
      },
      150,
      1,
      30,
      20,
      undefined,
      undefined,
      undefined,
      async () => "independent",
    );

    batcher.enqueue("student", "bandingkan dua jurusan?", "ctx-1");
    await waitFor(() => releaseActive !== undefined);
    batcher.enqueue("student", "17 × 24 berapa?", "ctx-2");
    await delay(20);
    assert.deepEqual(events, ["aktif-mulai"]);
    releaseActive?.();
    await batcher.drainAll();

    assert.deepEqual(events, [
      "aktif-mulai",
      "aktif-selesai",
      "berikut:independent:17 × 24 berapa?",
    ]);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(5);
  }
  assert.equal(predicate(), true, "kondisi tidak terpenuhi sebelum timeout");
}
