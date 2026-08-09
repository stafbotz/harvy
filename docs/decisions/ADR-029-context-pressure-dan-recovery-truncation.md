# ADR-029 — Context Pressure dan Recovery Truncation Agent

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-017, ADR-018, ADR-025, ADR-026, ADR-027, ADR-028

## Konteks

Agent Runtime sudah mempertahankan native assistant turn secara utuh, menolak
response nonterminal, memakai cumulative RunBudget, dan melindungi reserve
final synthesis. Namun `compactAtContextRatio` masih berupa data policy. Native
tool loop dapat mengakumulasi reasoning continuation dan observation hingga
request berikutnya mencapai hard context window. `finish_reason=length` juga
selalu menghentikan run meski state kernel masih dapat dibangun ulang dengan
aman.

Compaction tidak boleh sekadar memotong transcript provider. Tool result tanpa
assistant call pasangannya merusak wire contract; meringkas opaque reasoning
akan mempersistenkan atau menafsirkan chain-of-thought; memotong jawaban/koreksi
pengguna dapat menghasilkan output yang revision-nya baru tetapi semantiknya
basi. Recovery juga tidak boleh mengubah content filter menjadi retry biasa
atau memakai reserve final untuk delegasi baru.

## Keputusan

1. **Pressure memakai profile dan policy kode.** Auto-compaction hanya aktif
   ketika profile exact menyatakan `contextWindow`. Pressure dihitung dari
   estimasi seluruh input request ditambah emergency output ceiling, lalu
   dibandingkan dengan `contextWindow * compactAtContextRatio`. Profile dengan
   context window `null` mempertahankan perilaku compatibility; angka tidak
   ditebak dari nama model.
2. **Di bawah threshold, continuation tetap utuh.** Assistant tool turn,
   reasoning field yang diizinkan, thought signature, tool call, dan result
   diputar ulang persis seperti ADR-025. Compiler tidak menyentuh transcript
   hanya untuk mengurangi ukuran nominal.
3. **Compaction adalah boundary provider-neutral yang eksplisit.** Pada
   pressure, completed native transcript diganti dengan satu state message
   yang benar-benar dikirim ke provider. State itu dibangun dari request mentah,
   scope/callable set, observation kernel, seluruh pasangan prompt+jawaban
   pengguna, dan RunBudget view terbaru. Stable system instructions, request
   mentah, dan seluruh `AgentPlannerInput.userInputs` yang sudah diterima
   compiler tidak boleh dipotong.
   Context tersimpan diperkecil bertahap; bila state wajib tetap tidak muat
   hard window, request gagal lokal sebelum network. Opaque reasoning tidak
   disalin ke summary, checkpoint, memory, atau log.
4. **Observation dipadatkan dengan evidence metadata.** Output yang melebihi
   budget memakai head/tail preview, `originalCharacters`, `kind`, dan
   `artifactRef` bila executor memang memberikannya. Structured observation
   tetap JSON valid bahkan pada helper budget sangat kecil; runtime menolak
   limit di bawah 96 karakter agar evidence envelope selalu muat. Perubahan ini
   tidak mengarang artifact dan tidak menjanjikan full retrieval tanpa
   reference dari executor.
5. **Truncation mendapat paling banyak satu recovery.** Hanya typed response
   `truncated` dari `finish_reason=length` yang boleh memicu attempt kedua.
   Fragmen pertama dibuang; recovery dibangun dari state kernel yang sudah
   dipadatkan, memakai role `recovery`, escalation reason tertutup
   `output_truncated`, akun RunBudget yang sama, serta budget view yang sudah
   memperhitungkan attempt pertama. Capability delegasi dihapus dari tool set
   recovery. Sebelum attempt kedua, runtime memeriksa revision freshness lagi;
   revision yang sudah basi berhenti sebagai `stale` tanpa membelanjakan
   recovery. `content_filter`, finish reason hilang/asing, schema invalid, dan
   incomplete lain tidak di-retry sebagai recovery.
6. **Observability tetap content-free.** Context manifest membawa apakah
   compaction/recovery terjadi, window/threshold/output ceiling, estimasi token
   sebelum/sesudah, jumlah native message, dan jumlah observation yang
   dipadatkan. Tidak ada prompt, observation, reasoning, identifier, atau
   artifact content yang masuk field log tersebut.

## Batas change set ini

- Compiler pressure baru dipasang pada native private Agent Runtime; call
  conversation/session/group mekanis belum mendapat recovery otomatis.
- Profile tanpa exact context window tidak mendapat auto-compaction. Recovery
  truncation tetap memutus transcript ke state provider-neutral meski window
  belum diketahui.
- Tidak ada model summarizer baru, durable provider continuation, artifact
  store/full-output retrieval, finalizer terminal terpisah, visible verbosity
  wire, validator-driven escalation, atau K3/toughest.
- Deduplication dan agregasi update di upstream RunMailbox bukan bagian change
  set ini; jaminan preservation dimulai dari `AgentPlannerInput` yang diterima
  compiler pressure.
- Threshold dan estimator karakter-per-empat masih perlu dikalibrasi dari
  usage provider nyata; metadata ini bukan hitungan tokenizer pasti.

## Konsekuensi

Positif:

- loop agent dapat mengurangi context sebelum hard failure tanpa kehilangan
  raw request atau input pengguna yang sudah diterima compiler;
- continuation tetap lossless selama belum ada pressure, dan compaction tidak
  mencampur dangling tool result dengan transcript lama;
- partial output tidak pernah diteruskan sebagai final; dan
- recovery tetap terikat freshness check harness dan cumulative RunBudget.

Trade-off:

- compaction membuang opaque reasoning lama dan sebagian detail observation;
- state wajib yang terlalu besar menghentikan run alih-alih dipotong diam-diam;
- satu recovery dapat memakai reserve final; dan
- model/profile tanpa context metadata belum memperoleh auto-compaction.

## Bukti

Tes deterministik mencakup no-op di bawah threshold, compaction di atas
threshold, reset transcript tanpa reasoning leak, preservation seluruh input
pengguna, hard-window fail-closed, rasio policy ekstrem, observation JSON
head/tail/artifact, typed truncation, satu recovery tanpa delegasi, budget view
attempt kedua, non-recovery untuk content filter, serta auto-compaction pada
loop native dua langkah. Provider/model dan Telegram/WhatsApp nyata belum
diuji.
