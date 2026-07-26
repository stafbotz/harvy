import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessageBatcher } from "../src/bot/message-batcher.js";
import type { TurnBoundaryState } from "../src/core/turn-taking-policy.js";

describe("MessageBatcher", () => {
  it("menggabungkan bubble yang dipenggal sebelum menjawab", async () => {
    const handled: string[] = [];
    const carriers: string[] = [];
    const examined: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        examined.push(text);
        return text.includes("tapi aku suka cowo") ? "complete" : "open";
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
        carriers.push(batch.carrier);
      },
      200,
      40,
    );

    batcher.enqueue("student", "aku mau curhat", "ctx-1");
    await delay(5);
    batcher.enqueue("student", "jadi gini", "ctx-2");
    await delay(5);
    batcher.enqueue("student", "aku kan cowo", "ctx-3");
    await delay(5);
    batcher.enqueue("student", "tapi aku suka cowo", "ctx-4");
    await waitFor(() => handled.length === 1);

    assert.deepEqual(handled, [
      "aku mau curhat\njadi gini\naku kan cowo\ntapi aku suka cowo",
    ]);
    assert.deepEqual(examined, [
      "aku mau curhat\njadi gini\naku kan cowo\ntapi aku suka cowo",
    ]);
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

  it("menyimak seluruh rangkaian curhat meski jedanya melewati debounce", async () => {
    const handled: string[] = [];
    const examined: string[] = [];
    const batcher = new MessageBatcher<string>(
      async (text) => {
        examined.push(text);
        // Uji ini sengaja mensimulasikan model yang terlalu cepat berkata
        // complete. Pengaman lokal harus tetap mengenali pembuka curhat.
        return "complete";
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
      async () => "complete",
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

  it("mendahulukan keselamatan tanpa menunggu jendela curhat", async () => {
    const handled: string[] = [];
    let classifierCalled = false;
    const batcher = new MessageBatcher<string>(
      () => {
        classifierCalled = true;
        return new Promise<TurnBoundaryState>(() => undefined);
      },
      async (_ownerId, batch) => {
        handled.push(batch.text);
      },
      200,
      5,
      150,
      80,
    );

    batcher.enqueue("student", "aku mau curhat", "ctx-1");
    await delay(20);
    batcher.enqueue(
      "student",
      "aku mau menyakiti diri sekarang",
      "ctx-2",
    );

    await waitFor(() => handled.length === 1, 80);
    assert.deepEqual(handled, [
      "aku mau curhat\naku mau menyakiti diri sekarang",
    ]);
    assert.equal(
      classifierCalled,
      true,
      "pembuka boleh sempat dinilai sebelum bubble darurat tiba",
    );
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

    batcher.enqueue("student", "aku boleh curhat kah", "ctx-1");
    await waitFor(() => decisions.length === 1);
    batcher.enqueue("student", "lanjutannya ini", "ctx-2");

    decisions[0]?.("complete");
    await delay(5);
    assert.deepEqual(handled, []);

    await waitFor(() => decisions.length === 2);
    decisions[1]?.("complete");
    await waitFor(() => handled.length === 1);
    assert.deepEqual(handled, ["aku boleh curhat kah\nlanjutannya ini"]);
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
    await waitFor(() => handled.length === 1, 250);

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
    await waitFor(() => handled.length === 1);
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
