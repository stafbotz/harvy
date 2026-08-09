# ADR-026 — RunBudget Kumulatif Agent

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-003, ADR-013, ADR-017, ADR-018, ADR-020, ADR-025
- **Diamendemen oleh:** ADR-027 untuk work lane active v2; batas sinkron di
  bawah tetap merupakan histori change set ADR-026

## Konteks

Execution policy dan exact provider profile sudah memisahkan model, role,
effort, output ceiling, dan deadline per call. Namun satu logical AgentRun dapat
memanggil planner beberapa kali, mencoba ulang key/provider, dan menjalankan
worker paralel. Batas per call tidak mencegah seluruh turunan itu memakai token,
biaya, waktu, atau tool secara tak terbatas; retry bahkan dapat tampak sebagai
request baru bila tidak diikat ke akun yang sama.

Budget juga harus tetap berlaku setelah `waiting_input`. Waktu ketika pengguna
belum menjawab tidak boleh menghabiskan waktu kerja aktif, tetapi resume tidak
boleh memperoleh token, biaya, attempt, langkah, atau horizon baru. Model hanya
boleh melihat sisa budget sebagai data informatif; model, prompt, tool output,
atau provider tidak boleh menentukan atau mereset policy.

## Keputusan

1. **Satu akun code-owned per logical AgentRun.** `RunBudgetAccount` yang sama
   dibawa root planner, seluruh physical retry/fallback, executor, dan worker.
   Default v1 adalah 96.000 total token, USD 1, 6 langkah, 5 tool call, 12
   physical model attempt, 45 detik kerja aktif, ambang context 0,82, dan 3
   worker konkuren. Limit ini adalah policy runtime, bukan keluaran model.
2. **Model call memakai reservasi atomik sebelum efek.** Client mereservasi
   estimasi input + output maksimum dan biaya tier sebelum mengambil API key,
   mencatat attempt, atau melakukan fetch. Reservasi serentak ikut dihitung,
   sehingga worker tidak dapat melewati cap melalui check-then-act race. Setiap
   fetch primary, retry, JSON retry, atau fallback adalah satu model attempt.
3. **Actual usage menang atas estimasi.** Usage dan biaya provider yang sah
   menyelesaikan reservasi. Respons terminal maupun nonterminal dengan usage
   nyata tetap dibebankan. Actual usage satu attempt dapat melampaui estimasi;
   attempt itu sudah terjadi, tetapi policy/tool baru tidak boleh dimulai
   setelah overage. Balasan final yang sudah lengkap boleh tetap dikirim.
4. **Ketidakpastian dihitung konservatif.** HTTP 408/5xx, timeout, gangguan
   network, JSON 2xx yang tidak terbaca, usage numerik tidak aman, respons 2xx
   malformed tanpa usage, truncation tanpa usage, dan reservation yang masih
   live saat checkpoint menahan reservation penuh sebagai `unknown`. Reported
   provider cost yang tetap diketahui dibebankan bila lebih tinggi. HTTP 4xx
   selain 408 yang diketahui menolak request melepas token/biaya, tetapi attempt
   tetap dihitung. HTTP 408 tetap boleh retry/fallback bila budget tersisa.
5. **Planner hanya menerima view angka.** View menyatakan sisa token, biaya,
   langkah, tool, model attempt, waktu aktif, dan concurrency. View tidak dapat
   memperluas akun. Stop `budget_*` menghasilkan copy deterministik dan tidak
   boleh disamarkan sebagai final atau kegagalan umum.
6. **Checkpoint baru mengikat budget kumulatif.** `AgentRunCheckpoint` writer
   baru memakai version 2 dan mewajibkan embedded `RunBudgetCheckpoint` version
   1 berisi price snapshot, limits, counter, unknown attempts, serta elapsed
   aktif. Restore memakai snapshot itu dan jeda manusia tidak dihitung sebagai
   active time; horizon absolut sepuluh menit tetap tidak bergeser. Checkpoint
   agent version 1 diterima hanya untuk migrasi konservatif 8.192 token per
   inferred model call; histori retry, worker, dan waktu aktif lama tidak dapat
   direkonstruksi persis. Checkpoint v2 tanpa budget ditolak.
7. **Concurrency run dan provider adalah batas berbeda.** Delegasi memakai
   semaphore per run dari policy budget, dibatasi jumlah task, di samping
   semaphore global provider. Seluruh worker tetap menerima object akun yang
   sama; tidak ada budget anak yang dapat direset.
8. **Policy internal tidak masuk ekspor pengguna.** Store lokal menyimpan
   checkpoint lengkap untuk resume, tetapi ekspor data hanya membawa request,
   progress, pertanyaan/jawaban, observation, dan counter usage. Capability
   hash, scope authority, tier prices, dan anti-abuse limits tidak keluar dari
   trust domain.

## Batas change set ini

- Scope baru mencakup Agent Runtime privat, bukan seluruh call Harvy dan bukan
  `CodingRunBudget` untuk sandbox/coding.
- `compactAtContextRatio` baru policy/view; context-pressure compaction belum
  dijalankan. Output-ceiling overhaul, reserved final synthesis, recovery
  truncation, visible verbosity, validator-driven escalation, dan K3/toughest
  tetap pekerjaan Phase C berikutnya.
- Run aktif masih sinkron; belum ada durable RunStore, outbox, receipt,
  reconciliation, atau crash recovery. Adapter file hanya mempersistenkan
  `waiting_input` dan tetap satu proses.
- Harga tier berasal dari konfigurasi telemetry. Bila harga masih nol dan
  provider tidak melaporkan biaya, cap biaya tidak dapat menjadi guard
  preflight; cap token dan attempt tetap berlaku. Limit belum dapat dituning
  lewat Console dan belum mempunyai telemetry outcome khusus RunBudget.
- Token/biaya adalah preflight cumulative cap, bukan jaminan ceiling absolut
  terhadap under-estimation atau provider overage pada attempt yang sudah
  terjadi.

## Konsekuensi

Positif:

- retry, fallback, dan fan-out tidak memperoleh budget baru;
- kegagalan provider ambigu dihitung fail-closed tanpa mengarang usage nol;
- pause/resume tidak mereset konsumsi atau menagih waktu tunggu manusia; dan
- model dapat merencanakan dengan sisa budget tanpa menjadi authority policy.

Trade-off:

- unknown attempt sengaja dapat overcharge reservation demi mencegah
  pengulangan optimistis;
- migrasi legacy adalah estimasi konservatif; dan
- guard biaya bergantung pada price coverage yang benar.

## Bukti

Tes deterministik mencakup reservasi konkuren, cumulative usage/cost, provider
overage, unsafe/missing usage, HTTP 4xx/408/5xx, timeout/network, retry dan
fallback lintas provider, response nonterminal/malformed, stop sebelum policy
atau executor, deadline provenance, concurrency worker, checkpoint v2,
migrasi v1 dua kali resume, jeda manusia, copy adapter, cleanup durable, dan
redaksi ekspor. Uji provider serta kanal nyata belum dilakukan.
