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

  it("merekonsiliasi intent generik bila semantic save explicit membawa payload lengkap", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "request",
      taskAction: "save",
      task: {
        title: "Kembali mengerjakan slide hipotesis",
        dueAt: null,
        remindAt: "2026-08-26T16:00:00+07:00",
        importance: 2,
      },
      semanticOperation: {
        version: 1,
        domain: "task",
        operation: "save",
        target: "kembali mengerjakan slide hipotesis",
        subject: "self",
        reference: "none",
        explicitness: "explicit",
        evidence: "ingatkan aku 25 menit lagi untuk kembali mengerjakan slide hipotesis",
        confidence: 0.97,
      },
    }));

    assert.equal(understanding?.intent, "task");
    assert.equal(understanding?.taskAction, "save");
    assert.equal(
      understanding?.task?.title,
      "Kembali mengerjakan slide hipotesis",
    );
  });

  it("menolak semantic save explicit yang tidak membawa payload task lengkap", () => {
    const semanticOperation = {
      version: 1,
      domain: "task",
      operation: "save",
      target: "kembali mengerjakan slide hipotesis",
      subject: "self",
      reference: "none",
      explicitness: "explicit",
      evidence: "ingatkan aku nanti",
      confidence: 0.97,
    };

    assert.equal(parseUnderstanding(JSON.stringify({
      intent: "request",
      taskAction: null,
      task: null,
      semanticOperation,
    })), null);
    assert.equal(parseUnderstanding(JSON.stringify({
      intent: "task",
      taskAction: "save",
      task: null,
      semanticOperation,
    })), null);
  });

  it("mempertahankan payload jadwal khusus untuk semantic task update", () => {
    const understanding = parseUnderstanding(
      JSON.stringify({
        intent: "task",
        taskAction: null,
        task: {
          title: "Peninjauan live Telegram dan WhatsApp",
          dueAt: "2026-08-25T10:30:00+07:00",
          remindAt: "2026-08-25T09:30:00+07:00",
          importance: 3,
        },
        semanticOperation: {
          version: 1,
          domain: "task",
          operation: "update",
          target: "tugas peninjauan",
          subject: "self",
          reference: "recent",
          explicitness: "explicit",
          evidence: "ubah tugas peninjauan itu menjadi besok pukul 10.30",
          confidence: 0.98,
        },
      }),
    );

    assert.equal(understanding?.taskAction, null);
    assert.equal(
      understanding?.task?.dueAt?.toISOString(),
      "2026-08-25T03:30:00.000Z",
    );
    assert.equal(
      understanding?.task?.remindAt?.toISOString(),
      "2026-08-25T02:30:00.000Z",
    );
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
          {
            kind: "preference",
            content: "Warna favoritnya adalah biru",
            sourceEvidence: "warna favoritku biru",
            sourceSubject: "self",
            durability: "durable",
          },
        ],
      }),
    );

    assert.equal(understanding?.intent, "smalltalk");
    assert.equal(understanding?.memoryAction, null);
    assert.equal(understanding?.memories[0]?.kind, "preference");
    assert.equal(understanding?.memories[0]?.sourceSubject, "self");
    assert.equal(understanding?.memories[0]?.durability, "durable");
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

  it("mempertahankan sinyal explicit remember bersama candidate", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "memory",
      memoryAction: "remember",
      memories: [{ kind: "personal", content: "Sangat mencintai Sohit" }],
    }));

    assert.equal(understanding?.intent, "smalltalk");
    assert.equal(understanding?.memoryAction, "remember");
    assert.equal(understanding?.memories[0]?.kind, "personal");
  });

  it("membaca topik forget sebagai bahasa alami, bukan ID memory", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "memory",
      memoryAction: "forget",
      memoryTarget: "Sohit",
      memories: [],
    }));

    assert.equal(understanding?.memoryAction, "forget");
    assert.equal(understanding?.memoryTarget, "Sohit");
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

  it("membaca RiskHint terstruktur dan menerima boolean lama selama migrasi", () => {
    const aman = JSON.stringify({ intent: "feeling", task: null });
    assert.deepEqual(parseUnderstanding(aman)?.riskHint, {
      level: "none",
      confidence: 1,
    });

    const berisiko = JSON.stringify({
      intent: "feeling",
      riskHint: {
        level: "strong",
        category: "self_harm",
        confidence: 0.95,
      },
      task: null,
    });
    assert.deepEqual(parseUnderstanding(berisiko)?.riskHint, {
      level: "strong",
      category: "self_harm",
      confidence: 0.95,
    });
    assert.equal(parseUnderstanding(berisiko)?.safetySensitive, true);

    assert.equal(
      parseUnderstanding(JSON.stringify({
        intent: "feeling",
        riskHint: { level: "strong", confidence: 2 },
      })),
      null,
    );
    assert.equal(
      parseUnderstanding(JSON.stringify({
        intent: "feeling",
        safetySensitive: true,
      }))?.riskHint.level,
      "possible",
    );
  });

  it("tidak melebur evidence dari dua klausa dengan horizon berbeda", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "smalltalk",
      memories: [{
        kind: "preference",
        content:
          "Mudah buntu saat slide penuh teks dan ingin keputusan utama.",
        sourceEvidence:
          "aku gampang buntu kalau slide penuh teks. Untuk presentasi ini aku mau keputusan utama dulu",
        sourceSubject: "self",
        durability: "bounded",
      }],
    }));

    assert.deepEqual(understanding?.memories, []);
  });

  it("membaca koreksi beberapa ingatan tanpa mengubah mixed turn menjadi form edit", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "memory",
      memoryAction: "edit",
      memoryTarget: null,
      memories: [{
        kind: "preference",
        content: "Lebih mudah memahami penjelasan teknis bila inti didahulukan",
        sourceEvidence:
          "penjelasan teknis panjang membuatku kehilangan inti",
        sourceSubject: "self",
        durability: "durable",
      }],
      memoryRetractions: [
        {
          target: "preferensi bahasa Inggris",
          sourceEvidence:
            "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
          explicitness: "explicit",
          confidence: 0.96,
        },
        {
          target: "kebun sebagai keadaan permanen",
          sourceEvidence: "Kebun itu hanya proyek yang sedang dibahas",
          explicitness: "explicit",
          confidence: 0.94,
        },
      ],
    }));

    assert.equal(understanding?.intent, "smalltalk");
    assert.equal(understanding?.memoryAction, null);
    assert.equal(understanding?.memoryRetractions?.length, 2);
    assert.equal(
      understanding?.memoryRetractions?.[0]?.target,
      "preferensi bahasa Inggris",
    );
  });

  it("membuang retraction yang implicit, multi-klausa, atau confidence-nya rusak", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "smalltalk",
      memories: [],
      memoryRetractions: [
        {
          target: "bahasa Inggris",
          sourceEvidence: "Itu cuma tadi",
          explicitness: "implicit",
          confidence: 0.99,
        },
        {
          target: "kebun",
          sourceEvidence: "Kebun hanya proyek ini. Jangan jadikan profil",
          explicitness: "explicit",
          confidence: 0.99,
        },
        {
          target: "preferensi lama",
          sourceEvidence: "Preferensi itu keliru",
          explicitness: "explicit",
          confidence: 2,
        },
      ],
    }));

    assert.equal(understanding?.memoryRetractions, undefined);
  });

  it("membaca assessment routing tertutup tanpa memberi authority model", () => {
    const understanding = parseUnderstanding(JSON.stringify({
      intent: "request",
      riskHint: { level: "none", category: null, confidence: 1 },
      needsStepByStep: false,
      routingAssessment: {
        complexity: "deep",
        ambiguity: "high",
        planningRequired: true,
        emotionalNuance: "medium",
        executionSize: "heavy",
        factualStakes: "high",
        transformationMechanical: false,
        toolNeed: "execution",
        confidence: 0.87,
      },
    }));

    assert.deepEqual(understanding?.routingAssessment, {
      complexity: "deep",
      ambiguity: "high",
      planningRequired: true,
      emotionalNuance: "medium",
      executionSize: "heavy",
      factualStakes: "high",
      transformationMechanical: false,
      toolNeed: "execution",
      confidence: 0.87,
    });
  });

  it("membaca public focus exact dan membuang focus tidak aman tanpa menjatuhkan intent", () => {
    const valid = {
      kind: "distinguish",
      subject: "kemampuan matematika kamu sekarang",
      contrast: "kecocokan Informatika",
      purpose: null,
    };
    const parsed = parseUnderstanding(JSON.stringify({
      intent: "question",
      publicFocus: valid,
    }));

    assert.deepEqual(parsed?.publicFocus, valid);
    assert.equal(Object.isFrozen(parsed?.publicFocus), true);

    for (const publicFocus of [
      { ...valid, reasoning: "langkah privat" },
      { ...valid, subject: "reasoning high, lalu tool call search" },
      { ...valid, subject: "**Informatika**" },
      { ...valid, subject: "Informatika\nmatematika" },
      { ...valid, subject: "x".repeat(73) },
    ]) {
      const understanding = parseUnderstanding(JSON.stringify({
        intent: "question",
        publicFocus,
      }));
      assert.equal(understanding?.intent, "question");
      assert.equal(understanding?.publicFocus, null);
    }
  });

  it("mengabaikan assessment asing atau berlebih secara fail-closed", () => {
    const base = {
      complexity: "normal",
      ambiguity: "low",
      planningRequired: false,
      emotionalNuance: "low",
      executionSize: "small",
      factualStakes: "low",
      transformationMechanical: false,
      toolNeed: "none",
      confidence: 0.9,
    };
    for (const routingAssessment of [
      { ...base, complexity: "superintelligence" },
      { ...base, provider: "pilih-model-mahal" },
      { ...base, confidence: 2 },
    ]) {
      const understanding = parseUnderstanding(JSON.stringify({
        intent: "question",
        riskHint: { level: "none", category: null, confidence: 1 },
        routingAssessment,
      }));
      assert.equal(understanding?.intent, "question");
      assert.equal(understanding?.routingAssessment, null);
    }
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

  it("membaca semantic operation exact dan menolak field atau pasangan asing", () => {
    const valid = {
      version: 1,
      domain: "usage",
      operation: "show-details",
      target: null,
      subject: "self",
      reference: "recent",
      explicitness: "contextual",
      evidence: "detailnya",
      confidence: 0.94,
    };
    const parsed = parseUnderstanding(JSON.stringify({
      intent: "question",
      semanticOperation: valid,
    }));
    assert.deepEqual(parsed?.semanticOperation, valid);

    for (const semanticOperation of [
      { ...valid, operation: "delete-all" },
      { ...valid, confidence: 2 },
      { ...valid, capability: "billing.admin" },
      { ...valid, target: "" },
      { ...valid, target: "x".repeat(161) },
      { ...valid, evidence: "detailnya\nreasoning" },
    ]) {
      assert.equal(
        parseUnderstanding(JSON.stringify({ intent: "question", semanticOperation }))
          ?.semanticOperation,
        null,
      );
    }
  });

  it("menolak reasoning privat pada payload provider-neutral", () => {
    for (const key of [
      "chain_of_thought",
      "private_reasoning",
      "reasoning_content",
      "reasoning_details",
      "thought_signature",
      "chainOfThought",
      "privateReasoning",
    ]) {
      assert.equal(
        parseUnderstanding(JSON.stringify({
          intent: "question",
          semanticOperation: null,
          nested: { [key]: "rahasia" },
        })),
        null,
        key,
      );
    }
    assert.equal(
      parseUnderstanding(JSON.stringify({
        intent: "question",
        semanticOperation: null,
        nested: { a: { b: { c: { d: { e: { f: {
          private_reasoning: "tetap tidak boleh lolos",
        } } } } } } },
      })),
      null,
    );
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
