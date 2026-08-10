# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-07.md`](log/2026-08-07.md)
- [`log/2026-08-02-sampai-2026-08-06.md`](log/2026-08-02-sampai-2026-08-06.md)
- [`log/2026-07-25-sampai-2026-08-02.md`](log/2026-07-25-sampai-2026-08-02.md)

## Kebijakan entri

Tambahkan entri hanya bila fakta atau kontrak proyek berubah material. Gunakan
beberapa paragraf pendek; pindahkan detail panjang ke issue, PR, ADR, atau
evidence. Diskusi tanpa keputusan, investigasi tanpa fakta baru, typo,
formatting, rename internal, refactor murni, dan commit kecil tidak memerlukan
entri.

Format:

```md
## YYYY-MM-DD — Judul singkat

Scope: file atau subsystem utama.
Changed: perubahan perilaku atau kontrak.
Verified: perintah dan hasil penting.
Not verified: yang belum diuji.
Next: hanya bila ada tindak lanjut material.
```

Arsipkan whole entry tertua ke `docs/log/` ketika file ini melewati 24 KiB atau
12 entri material. Jangan memecah entri dan jangan memindahkan entri yang masih
memiliki perubahan pengguna yang belum diselesaikan.

## 2026-08-10 — Retrieval memori dan graph temporal Phase E/F

Scope: semantic/episodic memory, MemoryQueryPlan/ContextCompiler, embedding
port, temporal graph, lifecycle storage/delete/export, adapter bot privat, tes,
dan kontrak dokumentasi memory.

Changed: FTS episode lama kini menjadi salah satu route Context Pack bounded,
bersama semantic cosine retrieval opt-in dan graph temporal derived. Semantic
memory membawa provenance, confidence, sensitivity, status, dan validity;
consolidation menangani contradiction, correction, supersession, serta
recurrence. Temporal/privacy/suppression/freshness filter berlaku pada recent
summary maupun seluruh route retrieval. Forget/edit/full-delete melakukan
cascade tanpa resurrection, export memuat state turunan, dan file repository
memvalidasi namespace/provenance/projection secara fail-closed. ADR-030 mencatat
slice FTS; ADR-031 dan ADR-032 mengikat consumer semantic/Context Pack dan graph.

Verified: `npm run check` PASS; `npm test` PASS, 953 test dalam 120 suite,
0 gagal; `npm run context:check` PASS dengan output 3.924 byte (estimasi 981
token). Tes otomatis mencakup owner isolation, old-relevant ranking, vector
threshold, current/as-of, correction/recurrence, graph depth/provenance,
suppression, restart, CAS/race, export, dan deletion.

Not verified: provider embedding nyata, Telegram/WhatsApp live, kualitas pada
corpus percakapan nyata, multi-process/file lease, serta consumer group/project.

Next: Phase berikutnya dapat memasang consumer project/group dan procedural
memory; storage multi-instance memerlukan keputusan serta migrasi tersendiri.

## 2026-08-09 — RunMailbox idempotent dan lossless

Scope: active AgentRun service/repository, adapter Telegram, checkpoint input,
tes regresi, dan kontrak Agent Runtime.

Changed: `sourceMessageId` kini mengikat envelope mailbox per run. Replay
identik lintas restart lokal menjadi no-op tanpa acknowledgment kedua;
kind/content/question yang bertabrakan gagal tertutup. Mailbox dan ChangeSet
ditulis berpasangan. Update pending dibawa utuh dan kronologis melalui beberapa
input checkpoint; capacity envelope/ledger menghasilkan backpressure sebelum
revision naik, sementara slot pembatalan tetap tersedia. Record lama dengan
replay identik tetap dapat dibaca, tetapi collision ditolak.

Verified: tes terarah service/repository/mailbox 35/35 PASS; flow Telegram
duplicate ikut PASS dalam suite penuh. `npm run check` PASS; `npm test` PASS,
866 test dalam 110 suite, 0 gagal; `npm run context:check` PASS;
`git diff --check` PASS selain peringatan line-ending.

Not verified: provider/model nyata, Telegram live, storage/lease multi-instance,
dispatcher/outbox/reconciler eksternal, dan throughput ledger pada filesystem
produksi.

Next: lakukan smoke provider+Telegram yang masih tertunda atau lanjutkan
RunStore/dispatcher produksi sesuai urutan deployment; jangan mengklaim
exactly-once lintas instance.

## 2026-08-09 — Context pressure dan recovery truncation Agent

Scope: AI conversation/client, agent harness, context manifest, observation
compaction, tes regresi, dan kontrak Agent Runtime.

Changed: native Agent Runtime kini menjaga continuation lossless di bawah
threshold profile exact, lalu membangun state provider-neutral dari kernel saat
input plus output ceiling mendekati context window. Observation besar membawa
head/tail, ukuran asli, dan artifact reference bila tersedia tanpa merusak JSON.
Typed `finish_reason=length` boleh mendapat satu recovery tanpa delegasi,
setelah freshness diperiksa ulang, dalam cumulative RunBudget yang sama;
partial/incomplete lain tetap tidak dipublikasikan. ADR-029 mengikat keputusan
dan batasnya.

Verified: tes terarah 76/76 PASS sebelum freshness regression; suite akhir
terkait recovery/pressure/harness 48/48 PASS; hardening profile/envelope 9/9
dan audit independen 33/33 PASS. `npm run check` PASS; `npm test` PASS, 860
test dalam 110 suite, 0 gagal; `npm run context:check` dan `git diff --check`
PASS.

Not verified: tokenizer/usage dan latency provider nyata, profile/model live,
Telegram/WhatsApp live, artifact full retrieval, serta finalizer terminal.

Next: perbaiki idempotency `sourceMessageId` dan agregasi update RunMailbox yang
masih dapat memotong koreksi terbaru; setelah itu lanjutkan batas Phase C atau
RunStore produksi sesuai urutan deployment.

## 2026-08-09 — Output policy dan reserve final synthesis

Scope: execution policy, AI conversation/worker/client, RunBudget, agent
harness, tes regresi, serta kontrak Agent Runtime.

Changed: call general kini memperoleh output ceiling code-owned per role dan
di-clamp ke profile exact; ceiling mekanis tetap sempit. Planner/worker memakai
kelas budget `work`, sedangkan conversationalist/synthesizer/recovery memakai
`final`. Work tidak dapat mereservasi separuh total token/biaya yang dilindungi
untuk final synthesis—48.000 pada budget default, maksimal 49.152 token. View
numeric dan checkpoint/resume mempertahankan reserve tanpa schema baru.
ADR-028 mengikat keputusan dan batasnya.

Verified: tes terarah terkait PASS. `npm run check` PASS; `npm test` PASS,
846 test dalam 108 suite, 0 gagal. `npm run context:check`
PASS; `git diff --check` PASS.

Not verified: provider/model nyata, Telegram/WhatsApp live, context-pressure
compaction, recovery truncation, finalizer terminal terpisah, dan efek latency/
biaya provider dari ceiling baru.

Next: implementasikan context-pressure compaction dan recovery truncation
sebagai slice Phase C terpisah. Production RunStore/dispatcher tetap wajib
sebelum work lane diperluas ke surface atau job lain.

## 2026-08-09 — Active AgentRun dan work lane Telegram

Scope: AgentRun domain/repository/service, agent harness, adapter Telegram,
Run Anchor, mailbox policy, consent/data control, dan dokumentasi arsitektur.

Changed: permintaan planning eksplisit Telegram privat kini memperoleh satu
foreground active AgentRun v2 yang durable lokal dan tidak memblokir chat.
RunMailbox dan ChangeSet mengikat koreksi/jawaban secara eksplisit; instruction
revision menahan hasil basi; commit barrier mencatat receipt outbound dan
menutup delivery ambigu sebagai `partial|unknown` tanpa retry. Startup/shutdown,
expiry, ekspor teredaksi, retensi tujuh hari, serta penghapusan snapshot saat
memory/history dicabut kini mempunyai lifecycle tepercaya. Consent dinaikkan ke
versi 7. ADR-027 mengikat keputusan dan batasnya.

Verified: `npm run check` PASS; `npm test` PASS, 842 test dalam 108 suite, 0
gagal; `npm run context:check` PASS; `git diff --check` bersih selain peringatan
line-ending.

Not verified: provider/model nyata, Telegram live, storage/lease multi-instance,
dispatcher/outbox/reconciler eksternal, job queue kedua, pin/archive Anchor,
coding sandbox, dan efek tool write.

Next: buktikan profile/provider dan Telegram lewat smoke test, lalu pisahkan
RunStore/dispatcher produksi sebelum memperluas work lane ke job atau surface
lain.

## 2026-08-09 — RunBudget kumulatif Agent Runtime

Scope: Agent Runtime privat, AiClient retry/fallback, delegasi worker,
checkpoint `waiting_input`, adapter Telegram, dan ekspor data AgentRun.

Changed: satu akun RunBudget code-owned kini mengikat root, setiap physical
attempt, tool, dan worker. Reservation token+biaya dibuat sebelum key/fetch;
actual usage dan reported cost disettle, sedangkan transport/408/5xx/payload
ambigu dibebankan konservatif. Checkpoint writer baru memakai v2 dengan budget
kumulatif dan migrasi v1 konservatif tanpa menagih jeda pengguna. Stop budget
memakai copy jujur, concurrency worker dibatasi per run, dan ekspor pengguna
meredaksi capability hash, price snapshot, serta limit internal. ADR-026
mengikat keputusan dan batasnya.

Verified: `npm run check` PASS; suite terarah RunBudget+AiClient PASS, 55 test
dalam 2 suite; `npm test` PASS, 819 test dalam 104 suite, 0 gagal; `npm run
context:check` PASS; `git diff --check` bersih selain peringatan line-ending.

Not verified: provider/Telegram/WhatsApp nyata, tuning limit produksi,
kelengkapan harga tier, crash recovery run aktif, dan multi-process storage.

Next: implementasikan context-pressure compaction, reserved final synthesis,
output-ceiling overhaul, dan recovery truncation sebagai slice Phase C
terpisah sebelum K3/toughest.

## 2026-08-09 — Fondasi Phase C provider-aware

Scope: registry/config capability model, execution policy, adapter provider,
AiClient, live native-tool continuation, provider-attempt ledger, dan call
production conversation/group/worker.

Changed: capability kini terikat pasangan provider+model exact dan hanya
reasoning profile explicit yang boleh mengaktifkan wire baru. Seluruh call
production membawa execution plan code-owned; adapter mengallowlist payload
serta memetakan effort Google/OpenRouter/DeepSeek sesuai profile. Planner
memutar assistant turn Chat Completions utuh selama invocation dengan binding
provider+model dan batas reasoning, tanpa mempersistenkan atau mencatat isinya.
Respons nonterminal gagal tertutup, attempt lokal invalid tidak memutar key,
dan ledger membedakan incomplete/truncated/schema-rejected sambil merekam
metadata role/effort/verbosity content-free. Profile explicit fallback testing
sengaja ditolak sampai execution plan fallback dapat dihitung ulang aman.
ADR-025 mengikat keputusan dan batasnya.

Verified: `npm run check` PASS; suite terarah provider/config/client PASS, 66
test dalam 6 suite; `npm test` PASS, 789 test dalam 103 suite, 0 gagal; `npm run
context:check` PASS.

Not verified: Google AI Studio/OpenRouter/DeepSeek live, Telegram live, WhatsApp
live, serta kualitas/biaya reasoning pada model produksi exact.

Next: tambahkan cumulative RunBudget sebelum melonggarkan output ceiling, lalu
context-pressure compaction, recovery truncation, visible verbosity,
validator-driven escalation, dan K3/toughest sebagai change set terpisah.

## 2026-08-09 — Sinyal safety privat bertahan melewati batching

Scope: MessageBatcher Telegram, onboarding/held messages, adapter private,
serta regresi safety per bubble.

Changed: emergency lokal per bubble dan hasil boundary `urgent` kini dibawa
sebagai metadata terpisah sampai handler sehingga penggabungan teks tidak
menghilangkan kewajiban acute triage. Hanya pesan pertama boleh dinilai sebelum
consent; bubble lain tetap ditahan lokal dengan batas aslinya, lalu baru
diperiksa per bubble setelah consent agar marker konteks lama tidak memveto
emergency baru.

Verified: `npm run check` PASS; `npm test` PASS, 755 test dalam 100 suite, 0
gagal; `npm run context:check` PASS dengan output bootstrap 3.742 byte (estimasi
936 token).

Not verified: Telegram/model live, latency ACK jaringan nyata, dan akurasi
false-positive/false-negative pada corpus model aktual.

Next: ukur corpus safety aktual dan uji split-bubble/ACK lewat Telegram nyata.

## 2026-08-09 — Selective safety dan privacy ingress grup

Scope: classifier/planner ingress grup, GroupTurnService, batching WhatsApp,
usage policy, kontrak arsitektur, dan tes regresi grup.

Changed: core kini menyelesaikan membership authority, binding aktif, dan
notice live sebelum assessment model. Direct/ambient menghasilkan `riskHint`
acute-only dan `contextPrivacy` raw-retention-only dengan parser independen;
ordinary melewati triage, outage safety evidence-aware, unknown privacy
no-retain tanpa UX krisis, dan durable memory memakai classifier candidate-only
terpisah. Reviewer menjadi kondisional dan kontrol eksplisit low-risk tetap
tersedia pada support yang pasti. Bubble pra-join difilter sebelum matcher/model,
revocation membatalkan assessment aktif/queued, dan emergency lokal melewati
debounce/`direct_only`: fixed ACK terpisah dari reservation triage, acute triage
tidak menunggu compiler/memory extraction, emergency ambient tetap mendapat
final reviewed safety reply, dan matcher full-turn menilai tiap bubble agar
marker konteks lama tidak memveto emergency baru. Full turn tetap FIFO.
Observation authority async diserialkan per runtime dan hanya observation
authorized/live yang boleh menaikkan revision atau menyupersesi ambient. Alias
default/durable dihidrasi sebelum admission, observation yang sengaja ditolak
disettle pada generation yang sama, dan mode runtime efektif dibaca ulang tepat
sebelum pending revalidation, delivery, serta fixed ACK. ADR-024 mengikat
kontrak ini.

Verified: `npm run check` PASS; tes terarah GroupTurnService dan runtime policy
PASS, 80 test dalam 2 suite; `npm test` PASS, 755 test dalam 100 suite, 0 gagal;
`npm run context:check` PASS dengan output bootstrap 3.742 byte (estimasi 936
token). Audit read-only lifecycle runtime-mode tidak menemukan blocker tersisa.

Not verified: WhatsApp live, grup nyata, model/provider live, latency ACK nyata,
akurasi false-positive/false-negative classifier risk/privacy pada corpus model
aktual, serta kualitas split bubble produksi.

Next: ukur false-positive/false-negative safety pada corpus model aktual dan
validasi latency/split-bubble kanal nyata; Phase C provider/execution policy
tetap change set terpisah.

## 2026-08-09 — Adaptive debounce per subjek

Scope: batching Telegram privat dan WhatsApp grup, pure timing policy,
kontrak arsitektur, serta tes regresinya.

Changed: debounce kini belajar p90 gap antar-arrival content-free berbatas per
pemilik atau `scope+account+participant`, termasuk lintas batch yang sudah
ter-flush. Speaker switch memutus sampel grup A→B→A; fallback lama tetap sampai
tiga sampel dan state RAM dibersihkan lewat TTL yang tidak diperpanjang akses,
eviction, invalidasi, serta shutdown. Estimasi mengubah settle awal dan ruang
multi-bubble lengkap; window semantik open/incomplete tetap 7/12 detik.
Perubahan tidak menambah model call, persistensi, isi telemetry/log, atau
authority baru. ADR-023 mengikat policy.

Verified: `npm run check` PASS; tes terarah policy/batcher/turn-taking PASS;
`npm test` PASS, 755 test dalam 100 suite, 0 gagal; `npm run context:check` PASS
dengan output bootstrap 3.742 byte (estimasi 936 token).

Not verified: Telegram live, WhatsApp live, latency jaringan nyata, dan kualitas
split bubble produksi.

Next: validasi latency dan kualitas split-bubble pada kanal nyata; Phase C
provider/execution policy tetap change set terpisah.

## 2026-08-08 — Selective safety routing dan privacy memory privat

Scope: compiler/triage/reviewer percakapan privat, izin tindakan per efek,
classifier privacy memory, fast path pending/acknowledgment, telemetry usage,
runner evaluasi, kontrak arsitektur, serta tes regresinya.

Changed: compiler kini menghasilkan `RiskHint` dan acute triage hanya dipanggil
ketika hint, emergency lokal, atau kegagalan compiler membutuhkannya. Outage
memiliki disposition `unavailable` yang terpisah dari krisis; disagreement
berisiko ditangani konservatif; support pasti tidak selalu direview; dan izin
dinilai per efek sehingga tugas aman serta hak kontrol data tidak diblokir oleh
emosi support biasa. Privacy memory dipisahkan dari acute risk, hanya menilai
kandidat memori, gagal tertutup ke consent, dan menjadi overhead non-billable.
Fast path baru dibatasi pada acknowledgment dingin dan jawaban pending dengan
bentuk terikat; `agent-input` terbuka tetap memakai compiler. Telemetry kini
mengukur safe-action-blocked tanpa isi percakapan. ADR-022 menyupersesi kontrak
global gate privat pada ADR/invariant lama.

Verified: `npm run check` PASS. Build dan tes terarah PASS, 138 test dalam 13
suite. `npm test` PASS, 695 test dalam 97 suite, 0 gagal. `npm run
context:check` PASS dengan output bootstrap 3.627 byte (estimasi 907 token).
Audit read-only terpisah tidak menemukan temuan P0/P1/P2 tersisa.

Not verified: provider/model live, Telegram live, WhatsApp live, kualitas
corpus produksi, latency jaringan nyata, dan perilaku multi-instance tidak
dijalankan.

Next: selesaikan selective routing grup dan debounce adaptif sebagai slice
Phase B terpisah; lanjutkan Phase C provider/execution policy setelahnya.

## 2026-08-08 — Emergency preflight dan boundary local-first

Scope: safety/turn-taking policy, batching dan adapter Telegram privat,
telemetry turn, fast path waktu, kontrak arsitektur, serta tes regresinya.

Changed: free-text pasca-consent kini menjalankan emergency preflight
berpresisi tinggi sebelum debounce dan memakai closed set lokal untuk boundary
yang jelas; classifier model menjadi fallback bentuk ambigu. ACK urgent tidak
bergantung pada telemetry, batch biasa lama yang belum mulai dibatalkan lewat
generation guard, dan sinyal ACK tidak lagi kalah race dari penutupan span.
Pertanyaan waktu tanpa episode hangat 30 menit melewati boundary,
understanding, triage, dan reply model. ADR-021 merekonsiliasi supersesi parsial
kontrak AI-only lama; triase tetap menentukan disposition dan closed set ini
belum menyelesaikan Phase B seluruhnya.

Verified: tes terarah policy/batcher/adapter/telemetry/agent PASS, 129 test dalam
13 suite. `npm run check` PASS. `npm test` PASS, 674 test dalam 95 suite, 0
gagal. `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token).

Not verified: provider/model live, Telegram live, WhatsApp live, latency ACK
<500 ms pada jaringan nyata, dan perilaku multi-instance tidak dijalankan.
Preflight pra-consent/command/callback/grup/WhatsApp serta debounce adaptif
belum diimplementasikan.

Next: lanjutkan Phase B dengan `RiskHint`/`RiskDisposition`, semantics triage
`unavailable`, dan selective triage sebelum memisahkan privacy sensitivity dan
izin tindakan per efek.
