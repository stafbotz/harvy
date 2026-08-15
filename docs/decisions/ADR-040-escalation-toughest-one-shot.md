# ADR-040 — Escalation Toughest One-Shot

- **Status:** Diterima
- **Tanggal:** 15 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-003, ADR-010, ADR-025, ADR-026, ADR-029, ADR-035
- **Mengamendemen:** batas `toughest` pada ADR-025

## Konteks

Continuation provider-aware, cumulative RunBudget, context-pressure recovery,
revision/stale fence, dan evaluator lokal sudah tersedia. Menambah model paling
kuat sebagai planner ambient atau retry jaringan akan menaikkan biaya, latency,
correlated failure, dan paparan lintas provider tanpa bukti kebutuhan. Phase M
memerlukan eskalasi yang berasal dari validator code-owned, dapat diaudit tanpa
isi prompt, dan tidak dapat mengulang panggilan ambigu sesudah restart.

## Keputusan

1. **Slot `toughest` default-off dan exact.** Model hanya aktif bila slot mode
   aktif, privacy domain, dan `AI_MODEL_PROFILES` exact berstatus `explicit`
   tersedia bersama. ID tidak ditebak dari nama model. Slot mode lain boleh
   tetap masuk katalog sebagai inactive; konfigurasi parsial pada mode aktif
   menggagalkan startup.
2. **Provider failure bukan intelligence signal.** Network/provider failure
   menghasilkan keputusan retry/fallback biasa. Eskalasi hanya berasal dari
   closed-set validator: constraint hilang, schema/tool salah, kontradiksi
   observasi/internal, deadline terlewat, pertanyaan tak terjawab, test gagal
   berulang, atau confidence rendah dengan konsekuensi tinggi.
3. **Route awal selalu one-shot.** Hanya role `critic`, `recovery`, atau
   `synthesizer`; tepat satu step; tanpa tool dan delegasi. Accounting budget
   memakai kelas `ambitious`, tetapi ledger tetap mencatat provider/model exact
   dan marker route `toughest`.
4. **Reservation mendahului provider.** Satu stage key hanya dapat direservasi
   sekali secara durable. Replay exact mengembalikan `already_used`; collision
   ditolak. Completed, rejected, provider/execution failure, maupun outcome
   ambigu semuanya terminal dan tidak memanggil provider lagi. Startup menutup
   reservation menggantung sebagai `outcome_unknown`.
5. **Budget tetap code-owned.** Caller harus membuktikan sisa model-call,
   output-token, output ceiling, dan deadline sebelum route dibentuk. Prompt,
   candidate, atau provider tidak dapat menaikkan batas tersebut.
6. **Privacy path eksplisit.** Source dan target privacy domain tidak diturunkan
   dari substring model. Sensitive work yang berpindah domain memerlukan
   approval code-owned. Reservation hanya menyimpan digest, reason, role,
   provider/model, kelas material, domain, outcome, dan timestamp—bukan prompt,
   candidate, output, source, atau chain-of-thought.
7. **Observability provider tetap content-free.** Attempt ledger dan log aman
   mencatat role, requested/effective effort, route/escalation reason, kelas
   material prompt, serta source/target privacy domain. Metadata tidak masuk
   wire provider.
8. **A–E dievaluasi, bukan dijadikan ladder otomatis.** Harness sintetis
   membandingkan raw; rewrite-only; raw+brief; raw+brief+candidate; dan
   raw+brief+candidate+critic. Variant B diberi label evaluation-only, materi
   turunan selalu untrusted, raw tetap hadir pada C–E, dan E hanya dipilih untuk
   case sulit terpilih.

## Konsekuensi

Harvy mempunyai primitive Phase M yang dapat dipasang pada validator tertentu
tanpa menjadikan model terkuat ambient. Belum ada target `toughest` yang
dikonfigurasi atau invocation yang dirangkai di composition root, dan runner
evaluasi model nyata belum dijalankan. Tidak ada klaim kualitas, harga, privacy
provider live, atau ketersediaan K3 produksi.

## Bukti

Tes policy/repository mengunci closed validator reasons, priority, budget,
profile exact, sensitive cross-domain denial, one-shot/no-tool, replay restart,
candidate/provider failure, unknown recovery, collision, schema, dan transisi
terminal. Tes config, execution policy, client/ledger, serta corpus routing
mengunci default-off, inventaris mode, metadata non-wire, dan variant A–E.
