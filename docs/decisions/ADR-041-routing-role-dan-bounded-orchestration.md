# ADR-041 — Routing Role dan Bounded Orchestration

- **Status:** Diterima
- **Tanggal:** 20 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-003, ADR-017, ADR-021, ADR-022, ADR-025, ADR-026,
  ADR-028, ADR-029, ADR-040
- **Mengamendemen:** routing Agent Runtime berbasis panjang pada ADR-003 dan
  boundary delegasi paralel pada ADR-017

## Konteks

Fast path deterministik, selective safety, exact model profile, native tool
calling, provider-bound continuation, cumulative RunBudget, final synthesis
reserve, cycle guard, dan escalation `toughest` one-shot sudah tersedia.
Namun global route masih menjadikan `needsStepByStep` dan panjang 280 karakter
sebagai proxy utama. Tier biaya juga merangkap pekerjaan kognitif, sehingga
planner frontier selalu meminta effort statis dan role executor/verifier/
challenger tidak dapat dikonfigurasi secara independen.

## Keputusan

1. **Global route hanya memilih handler pertama.** Urutannya tetap local-first:
   fast path deterministik dan flow khusus code-owned menang lebih dulu. Output
   extractor murah kemudian boleh memberi `RoutingAssessment` tertutup berisi
   complexity, ambiguity, planning, emotional nuance, execution size, factual
   stakes, mechanical transformation, tool need, dan confidence. Assessment
   tidak dapat memilih provider/model, permission, capability, atau budget.
   Schema asing menjadi `null`; confidence di bawah 0,55 memakai fallback
   kompatibilitas lama.
2. **Panjang bukan difficulty.** Assessment valid dapat mengirim request pendek
   bernuansa atau planning kompleks ke `orchestrate`, sementara transformasi
   mekanis panjang tetap di `conversation`. Global route
   `deterministic|conversation|specialized|orchestrate` tidak memprediksi graph
   lengkap sesudah orkestrator mengambil alih.
3. **Role kognitif dipisah dari tier accounting.** Role yang dikenal adalah
   `mechanical`, `everyday_conversation`, `orchestrator`, `strong_worker`,
   `heavy_executor`, `verifier`, dan `challenger`. `cheap|efficient|ambitious`
   tetap dipertahankan untuk compatibility, harga, usage, dan budget. Binding
   role ke tier serta optional exact model berasal dari
   `AI_MODEL_ROLE_BINDINGS`; provider tetap berasal dari mode aktif. Model exact
   masuk katalog/profile sebagai compatibility sampai profile exact benar-benar
   dideklarasikan. Nama provider/model tidak menjadi policy bisnis.
4. **Suara user-facing tidak melewati rewrite model lain.** Percakapan normal
   memakai role everyday dan percakapan deep memakai orkestrator secara
   langsung. Bila specialist dipakai, orkestrator menerima observation lalu
   menyintesis jawaban final sendiri sebagai Harvy.
5. **Delegasi specialist adalah graph optional, bukan pipeline.** Capability
   `agent.delegate.specialist` default-off dan memerlukan executor, role
   allowlist, serta authorization policy code-owned. Orkestrator dapat meminta
   strong worker, heavy executor, verifier, atau challenger secara langsung.
   Satu run sinkron dibatasi maksimal dua aksi delegasi; delegasi paralel tetap
   hanya pada langkah awal. Selama authority delegasi masih hadir, summary,
   history, dan memory tidak dimasukkan. Recovery dan synthesis kontekstual
   menghapus seluruh schema delegasi. Specialist tidak menerima tool, memory,
   credential, registry, continuation provider root, atau API delegasi.
6. **Handoff lintas model provider-neutral.** `WorkBrief` dan `AgentHandoff`
   memakai schema versioned, exact, bounded untuk goal, facts, constraints,
   evidence, assumptions, plan, work product, pertanyaan terbuka, confidence,
   provenance, acceptance criteria, capability request, dan failure code.
   Orkestrator hanya melihat `workBriefRef` opaque yang harus diputar persis
   untuk mengikat handoff ke run; referensi ini bukan user ID atau isi request.
   `chainOfThought`, `privateReasoning`, `scratchpad`, credential, serta field
   authority tidak ada dan ditolak sebagai field tambahan. `plan_conflict`
   adalah outcome terstruktur, bukan izin worker memperluas scope.
7. **Execution envelope dapat adaptif tetapi tetap code-owned.** Difficulty,
   stakes, uncertainty, dan cognitive role dapat menaikkan requested reasoning
   ke kemampuan profile tanpa mengubah visible verbosity. Model hanya boleh
   mengusulkan `ResourceRequest` closed-set. `ResourceRequestPolicy` memberi
   grant dari adaptive reserve yang sudah dikonfigurasi dan dibatasi hard
   remainder; progress marker tidak memuat reasoning. Primitive ini belum
   mengubah checkpoint atau default RunBudget hingga scheduler mengintegrasikannya.
8. **Capability availability bukan context presence.** Discovery metadata
   leksikal dapat membuat shortlist atau high-recall fallback ter-page tanpa
   memuat schema/executor/credential. Cursor content-free mencegah registry di
   atas 50 item menyembunyikan capability selamanya. Shortlist hanya merupakan
   irisan dengan callable set code-owned dan tidak dapat menambah authority.
   Runtime saat ini tetap
   mengirim seluruh callable subset karena jumlah tool masih kecil; wiring
   discovery ke planner menunggu registry yang cukup besar.
9. **Boundary lama tetap berlaku.** Selective safety tidak mendapat call baru,
   live-state forced tool tetap menang, provider failure bukan intelligence
   signal, `toughest` ADR-040 tidak berubah, raw reasoning tetap ephemeral dan
   provider+model-bound, serta checkpoint/memory/log tetap provider-neutral.

## Konsekuensi

Ordinary chat tidak mendapat model/safety/reviewer call tambahan: extractor
yang sudah ada hanya menghasilkan fitur lebih kaya, lalu everyday model
berbicara langsung. Deep route memperoleh ruang reasoning lebih besar dan
specialist berbeda dapat dipilih tanpa urutan wajib. Exact role binding,
specialist, adaptive reserve, dan discovery tetap fail-closed serta dapat
diaktifkan bertahap.

Capability specialist belum dipasang di composition production, resource
request belum mengubah RunBudget aktif, dan capability discovery belum menjadi
native tool. Tidak ada klaim perilaku provider/model live, kualitas routing
corpus nyata, harga, latency produksi, atau integrasi eksternal dari keputusan
ini.

## Bukti

Tes routing mengunci ordinary/smalltalk, deterministic/live-state, request
pendek bernuansa, transformasi mekanis panjang, planning kompleks, confidence
fallback, dan exact role binding. Tes Agent Runtime mengunci challenger
langsung, graph dua delegasi, context-free delegation, final synthesis, serta
recovery tanpa schema delegasi. Tes execution/resource/handoff/discovery/config
mengunci adaptive effort, reserve/hard ceiling, provider-failure denial,
structured progress, field reasoning privat, PLAN_CONFLICT, authority
intersection, specialist default-off, authorization default-deny, dan profile
exact.
