# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

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

## 2026-08-07 — Baseline telemetry per giliran

Scope: telemetry domain/service/storage, batching Telegram privat, kontrak
observabilitas, serta tes regresinya.

Changed: satu `turnId` acak kini mengikuti bubble dari evaluasi boundary sampai
handler selesai. Telemetry content-free mencatat outcome, jumlah bubble,
batch/queue/handling/total latency, jumlah dan tujuan logical model call, serta
sinyal fast path, triage unavailable, safety fallback, dan urgent
acknowledgement. File telemetry bermigrasi kompatibel dari version 1/2 ke
version 3 dengan koleksi `turns`; retensi, ekspor data, dan forget ikut mencakup
record baru. Ringkasan per pemilik menyediakan p50/p95 dan rate dengan seluruh
turn sebagai denominator. ADR-020 mengikat batas privasi dan ruang lingkup
baseline ini.

Verified: `npm run check` PASS. `npm test` PASS, 663 test dalam 94 suite, 0
gagal. `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token). `git diff --check` PASS.

Not verified: provider/model live, Telegram live, WhatsApp live, multi-instance
durability, dashboard, dan TTFR terpisah tidak dijalankan atau belum
diimplementasikan.

Next: Phase B harus merekonsiliasi ADR/invariant safety lama sebelum mengubah
boundary, triage unavailable, review, atau izin mutasi.

## 2026-08-06 — Bootstrap agent menjadi code-first dan berbatas

Scope: `AGENTS.md`, bootstrap Claude/Antigravity, context tooling, workflow,
STATUS, LOG, hook, dan tes kontrak agent.

Changed: satu kontrak utama kini memakai klasifikasi task dan Level 0–3; docs
dibaca on-demand dengan budget sekitar 15%. SessionStart hanya mencetak kontrak
ringkas plus `CURRENT.md`. STATUS menjadi indeks delapan subsystem dan snapshot
monolit dipindah ke arsip. LOG lama—termasuk perubahan working tree yang sudah
ada—diarsipkan dengan urutan dan fakta tetap utuh; satu credential-like value
serta kutipan pengguna sensitif direduksi tanpa mengulang nilainya. Hook tidak
lagi memaksa LOG dan hanya memvalidasi snapshot staged ketika sumber konteks
berubah. ADR-019 mencatat keputusan durable ini.

Verified: `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token; sebelumnya 16.434 byte). `npm run check` PASS. `npm test`
PASS, 654 test dalam 94 suite, 0 gagal. Smoke test index sementara menerima
snapshot staged lengkap serta menolak penghapusan `AGENTS.md` dan hilangnya
mode executable hook.

Not verified: runtime produk, provider/model live, Telegram, WhatsApp, dan
perilaku UI tidak dijalankan karena kode produk tidak berubah.
