import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDueDate,
  parseUnderstanding,
} from "../src/ai/understand.js";

const TASK_JSON = JSON.stringify({
  intent: "task",
  taskAction: "save",
  memoryAction: null,
  safetySensitive: false,
  needsStepByStep: false,
  task: {
    title: "Kumpulin matematika halaman 20",
    dueAt: "2026-07-27T19:00:00+07:00",
    importance: 3,
  },
});

describe("pembacaan balasan model", () => {
  it("membaca JSON yang bersih", () => {
    const result = parseUnderstanding(TASK_JSON);

    assert.equal(result?.intent, "task");
    assert.equal(result?.task?.title, "Kumpulin matematika halaman 20");
    assert.equal(result?.task?.dueAt?.toISOString(), "2026-07-27T12:00:00.000Z");
    assert.equal(result?.task?.importance, 3);
  });

  it("membaca JSON yang terbungkus pagar kode dan basa-basi", () => {
    const raw = ["Tentu! Ini hasilnya:", "```json", TASK_JSON, "```"].join("\n");
    assert.equal(parseUnderstanding(raw)?.task?.importance, 3);
  });

  it("menolak balasan yang bukan JSON", () => {
    assert.equal(parseUnderstanding("maaf, aku tidak mengerti"), null);
    assert.equal(parseUnderstanding(""), null);
  });

  it("menerima alias reminder yang memang dikenal", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "reminder",
        taskAction: "save",
        memoryAction: null,
        safetySensitive: false,
        needsStepByStep: false,
        task: {
          title: "Minum obat",
          dueAt: null,
          remindAt: "2026-07-26T11:21:00+07:00",
          importance: 2,
        },
      }),
    );

    assert.equal(understanding?.intent, "task");
    assert.equal(understanding?.task?.title, "Minum obat");
  });

  it("menolak intent karangan meski membawa aksi simpan dan tugas yang sah", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "belanja",
        taskAction: "save",
        task: {
          title: "Beli susu",
          dueAt: null,
          remindAt: null,
          importance: 2,
        },
      }),
    );

    assert.equal(understanding, null);
  });

  it("menerima intent yang hurufnya berbeda", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ intent: " Feeling ", task: null }),
    );

    assert.equal(understanding?.intent, "feeling");
  });

  it("membedakan riwayat chat dari daftar memori tentang pengguna", () => {
    const history = parseUnderstanding(
      JSON.stringify({ intent: "history", task: null }),
    );
    const memory = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        task: null,
        taskAction: null,
        memoryAction: "list",
      }),
    );

    assert.equal(history?.intent, "history");
    assert.equal(memory?.intent, "memory");
    assert.equal(memory?.memoryAction, "list");
  });

  it("tidak mengubah permintaan kepada Harvy menjadi tugas pengguna", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "request",
        taskAction: "offer",
        memoryAction: null,
        task: {
          title: "Buat kode tic-tac-toe",
          dueAt: null,
          remindAt: null,
          importance: 2,
        },
      }),
    );

    assert.equal(understanding?.intent, "request");
    assert.equal(understanding?.taskAction, null);
    assert.equal(understanding?.task, null);
  });

  it("tidak menyimpan tugas bila model lupa memberi aksi", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "task",
        taskAction: null,
        task: {
          title: "Kumpulkan matematika",
          dueAt: null,
          remindAt: null,
          importance: 2,
        },
      }),
    );

    assert.equal(understanding?.intent, "task");
    assert.equal(understanding?.taskAction, null);
    assert.equal(understanding?.task, null);
  });

  it("hanya mempertahankan tawaran tugas untuk cerita pengguna", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "feeling",
        taskAction: "offer",
        task: {
          title: "Belajar untuk ulangan biologi",
          dueAt: "2026-07-27T08:00:00+07:00",
          remindAt: null,
          importance: 3,
        },
      }),
    );

    assert.equal(understanding?.intent, "feeling");
    assert.equal(understanding?.taskAction, "offer");
    assert.equal(
      understanding?.task?.title,
      "Belajar untuk ulangan biologi",
    );
  });

  it("tidak membuka daftar memori untuk pernyataan preferensi baru", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        taskAction: null,
        memoryAction: null,
        task: null,
        memories: [
          { kind: "preference", content: "Warna favoritnya adalah biru" },
        ],
      }),
    );

    assert.equal(understanding?.intent, "smalltalk");
    assert.equal(understanding?.memoryAction, null);
    assert.equal(understanding?.memories[0]?.kind, "preference");
  });

  it("mendahulukan fakta baru bila aksi daftar memori berkontradiksi", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        taskAction: null,
        memoryAction: "list",
        task: null,
        memories: [
          { kind: "preference", content: "Warna favoritnya adalah biru" },
        ],
      }),
    );

    assert.equal(understanding?.intent, "smalltalk");
    assert.equal(understanding?.memoryAction, null);
    assert.equal(
      understanding?.memories[0]?.content,
      "Warna favoritnya adalah biru",
    );
  });

  it("mempertahankan aksi kontrol memori yang tidak membawa fakta baru", () => {
    const list = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        memoryAction: "list",
        memories: [],
      }),
    );
    const forget = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        memoryAction: "forget",
        memories: [],
      }),
    );

    assert.equal(list?.intent, "memory");
    assert.equal(list?.memoryAction, "list");
    assert.equal(forget?.intent, "memory");
    assert.equal(forget?.memoryAction, "forget");
  });

  it("menolak intent di luar yang dikenal", () => {
    const raw = JSON.stringify({ intent: "belanja", task: null });
    assert.equal(parseUnderstanding(raw), null);
  });

  it("membuang tugas tanpa judul", () => {
    const raw = JSON.stringify({
      intent: "feeling",
      task: { title: "   ", dueAt: null, importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task, null);
  });

  it("mengabaikan tenggat yang tidak masuk akal", () => {
    const raw = JSON.stringify({
      intent: "task",
      taskAction: "save",
      task: { title: "Ujian", dueAt: "2999-01-01T00:00:00+07:00", importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.dueAt, null);
  });

  it("mengabaikan tenggat yang tidak dapat dibaca", () => {
    const raw = JSON.stringify({
      intent: "task",
      taskAction: "save",
      task: { title: "Ujian", dueAt: "besok pokoknya", importance: 2 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.dueAt, null);
  });

  it("mengembalikan kepentingan ke nilai tengah bila tidak sah", () => {
    const raw = JSON.stringify({
      intent: "task",
      taskAction: "save",
      task: { title: "Ujian", dueAt: null, importance: 9 },
    });

    assert.equal(parseUnderstanding(raw)?.task?.importance, 2);
  });

  it("membaca usulan memori beserta jenisnya", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "smalltalk",
        memories: [
          { kind: "profile", content: "Kelas 11 IPA di SMAN 3" },
          { kind: "personal", content: "Ibunya sedang sakit" },
        ],
      }),
    );

    assert.equal(understanding?.memories.length, 2);
    assert.equal(understanding?.memories[0]?.kind, "profile");
    assert.equal(understanding?.memories[1]?.kind, "personal");
  });

  it("memperlakukan jenis memori yang tidak dikenal sebagai sensitif", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "feeling",
        memories: [{ kind: "kesehatan", content: "Sedang sakit tipes" }],
      }),
    );

    // Menebak ke arah yang lebih longgar berarti menyimpan diam-diam sesuatu
    // yang mungkin sensitif. Menebak ke arah yang ketat hanya membuat Harvy
    // bertanya dulu, dan itu jauh lebih murah kalau salah.
    assert.equal(understanding?.memories[0]?.kind, "personal");
  });

  it("membuang usulan memori yang cacat tanpa menjatuhkan pesannya", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "task",
        taskAction: "save",
        task: { title: "Kumpulkan matematika", importance: 2 },
        memories: [
          { kind: "profile" },
          { content: "" },
          "bukan objek",
          { kind: "routine", content: "Les Jumat sore" },
        ],
      }),
    );

    assert.equal(understanding?.task?.title, "Kumpulkan matematika");
    assert.equal(understanding?.memories.length, 1);
    assert.equal(understanding?.memories[0]?.content, "Les Jumat sore");
  });

  it("membatasi jumlah memori per pesan", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "smalltalk",
        memories: [
          { kind: "profile", content: "Satu" },
          { kind: "profile", content: "Dua" },
          { kind: "profile", content: "Tiga" },
        ],
      }),
    );

    assert.equal(understanding?.memories.length, 2);
  });

  it("mengembalikan daftar memori kosong bila tidak ada", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ intent: "smalltalk" }),
    );

    assert.deepEqual(understanding?.memories, []);
  });

  it("membaca tanda keselamatan sebagai boolean tegas", () => {
    const aman = JSON.stringify({ intent: "feeling", task: null });
    assert.equal(parseUnderstanding(aman)?.safetySensitive, false);

    const berisiko = JSON.stringify({
      intent: "feeling",
      safetySensitive: true,
      task: null,
    });
    assert.equal(parseUnderstanding(berisiko)?.safetySensitive, true);
  });

  it("menyaring tindakan adaptif asing, duplikat, dan lebih dari tiga", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "feeling",
        suggestedActions: [
          "listen",
          "clarify",
          "listen",
          "buat_transfer",
          "prioritize",
          "start_small",
        ],
        actionGoal: "  mulai   satu hal  ",
      }),
    );

    assert.deepEqual(understanding?.suggestedActions, [
      "listen",
      "clarify",
      "prioritize",
    ]);
    assert.equal(understanding?.actionGoal, "mulai satu hal");
  });

  it("hanya menerima kontrol dan sinyal sesi dari enum tertutup", () => {
    const control = parseUnderstanding(
      JSON.stringify({
        intent: "control",
        controlAction: "delete-all",
        sessionSignal: "done",
      }),
    );
    assert.equal(control?.controlAction, "delete-all");
    assert.equal(control?.sessionSignal, "done");

    const ordinary = parseUnderstanding(
      JSON.stringify({
        intent: "smalltalk",
        controlAction: "delete-all",
        sessionSignal: "melompat",
      }),
    );
    assert.equal(ordinary?.controlAction, null);
    assert.equal(ordinary?.sessionSignal, null);
  });

  it("mempertahankan aksi edit memori sebagai kontrol", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "memory",
        memoryAction: "edit",
      }),
    );
    assert.equal(understanding?.intent, "memory");
    assert.equal(understanding?.memoryAction, "edit");
  });
});

describe("pembacaan tenggat baru", () => {
  it("hanya menerima tanggal ISO yang masuk akal", () => {
    assert.equal(
      parseDueDate('{"dueAt":"2026-07-27T19:00:00+07:00"}')?.toISOString(),
      "2026-07-27T12:00:00.000Z",
    );
    assert.equal(parseDueDate('{"dueAt":"besok malam"}'), null);
    assert.equal(parseDueDate('{"dueAt":"2026-07-27"}'), null);
    assert.equal(parseDueDate('{"dueAt":"2026-07-27T19:00:00"}'), null);
    assert.equal(parseDueDate('{"dueAt":"2999-01-01T00:00:00+07:00"}'), null);
  });
});
