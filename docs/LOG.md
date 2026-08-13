# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-08.md`](log/2026-08-08.md)
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

## 2026-08-13 — Fondasi ProjectWorkspace dan coding Phase G–J

Scope: Workspace permission/capability, ProjectWorkspace/safe ZIP/snapshot,
SandboxRunner policy, CodingRun/repository tools/validators, local git, GitHub
broker, client HTTP trust-domain, AgentHarness deadline, adapter metadata, tes,
ADR-033–036, dan status coding.

Changed: Project archive kini masuk parser ZIP internal fail-closed dan menjadi
snapshot content-addressed read-only dengan revision/rollback, quota logical+
allocated termasuk working/trash, artifact upload tanpa bit tulis, staged
retention dan crash recovery,
ACL/CAS, serta namespace memory project. Sandbox menjadi port trust-domain
Linux terpisah dengan binding tenant+snapshot, network-off, resource/admission/
lease/watchdog/artifact policy, late-allocation cleanup, queued-abort guard, dan
quarantine lease ambigu. Lifecycle lease ditulis durable sebelum allocation,
dipasangi fence tanpa reattach saat startup, dan baru dihapus sesudah exact disposal
ACK; adapter SQLite memberi CAS lintas proses. Default tetap unavailable tanpa
host fallback. Snapshot dialirkan sebagai bundle content-addressed tanpa host
path; execute mengikat operation/request digest, dan artifact byte diverifikasi
size+hash sebelum menjadi evidence.
Lifecycle runtime eksplisit kini menuntaskan recovery sebelum readiness,
menutup admission secara sinkron, menunggu operasi aktif saat drain, mem-fence
seluruh record, dan baru menutup journal setelah semua ACK exact. Fence gagal
mempertahankan record `disposing` agar shutdown tidak mengarang keberhasilan.
Penghapusan project kini memakai tombstone durable sebelum cleanup. Semua
jalur project/run gagal tertutup setelah request; saga yang dapat dilanjutkan
memasang fence pada operasi provider dan seluruh lease sandbox project,
menghapus evidence termasuk orphan, record run, metadata GitHub lokal, memory,
serta payload project secara berurutan. Pending commit atau receipt GitHub
`unknown` menahan cleanup; tombstone completed dipertahankan agar ID tidak
hidup kembali. Tombstone incomplete kini dipage sebagai locator content-free;
worker bounded melanjutkan cleanup lokal exact tanpa scope pengguna, efek
coding/publish non-cleanup baru, atau sapuan trash project lain. Penghapusan ini tidak pernah menghapus
repository remote.
Authority dan antrean project sekarang menjadi critical section terstruktur:
child re-entrant ikut ditunggu, descendant yang lolos wajib revalidasi, dan
guard tidak dapat dipakai lintas repository realm. Snapshot hanya keluar lewat
callback satu-kali selama guard ACL+revision masih aktif; disposal working copy
juga memerlukan guard ACL/project dengan `code.write`.
CodingRun menegakkan single writer, worker read yang terserialisasi, structured
patch ber-hash dengan rollback, post-read freshness, ChangeSet/freshness,
validator receipt yang mengikat task+command, repository map, plan, task-level
review evidence, rolling event ledger, diff/security gate, pending commit, dan
recovery tanpa retry. Executor coding berbatas tersedia tetapi belum dipasang
ke surface produksi; mutasi memerlukan `code.write`, input credential-like
ditolak pada brief/constraint/plan/path/source sebelum persistence/provider,
terminalisasi stale merevalidasi authority, execution/artifact ID sandbox harus
opaque dan credential-free, dan file teks besar tetap dipindai.
Validator evidence disalin ke store content-addressed sebelum lease sandbox
dibuang dan diverifikasi lagi saat completion/recovery. Coordinator memiliki
budget keputusan kumulatif, pause/resume `waiting_input`, state fence per
action, `sandbox.exec`, serta registri operasi provider yang dapat di-abort dan
ditunggu secara berbatas oleh deletion fence.
Scheduler immediate-admission membatasi concurrency global+workspace tanpa
mengantre scope basi, mencadangkan state revision melalui CAS, dan baru melepas
slot setelah provider asli quiescent. Receipt conformance deployment wajib
diverifikasi ulang pada setiap admission; health saja tidak membuka coding.
Pending commit terjadwal tetap fail-closed sampai recovery authority terpisah
melakukan reconciliation; jalur coordinator langsung tetap berscope pengguna.
Supervisor maintenance mengurutkan sandbox recovery, GitHub unknown initial
pass, lalu deletion initial pass dengan admission tetap tertutup. Shutdown
menyegel seluruh caller, men-drain mereka, lalu men-drain/menutup sandbox paling
akhir; failure stop/quiescence tetap fail-closed dan dapat di-retry.
Local git
dan GitHub publish dipisah; broker menolak schema asing, memeriksa
ACL+App+base/target ref, memakai effect ID deterministik, canonical pending
receipt, ordered attempt, tri-state reconciliation, contract confirmation
authority/grant sekali pakai tanpa menyimpan proof, workflow effect/approval terpisah,
server-side operation fence contract, non-force `harvy/*`, dan draft PR. Field
asing dan nilai yang menyerupai credential ditolak sebelum canonical effect
atau metadata dipersistenkan. Commit lokal juga menghasilkan descriptor object
bundle Git content-addressed; exact push mengikatnya ke effect/approval dan
receipt tidak boleh committed bila broker tidak mengonsumsi seluruh stream
sesuai size+SHA-256.
Client HTTP default-off untuk sandbox, local-git, dan GitHub broker memakai
origin/protocol/audience tetap, proof HMAC service-bound, schema tertutup,
request proof + response protocol/request-ID echo, AbortSignal tanpa retry
efek, serta upload/download
content-addressed berbatas. Mode loopback hanya fixture dev; client ini bukan
backend isolasi, daemon git, GitHub App broker, atau bukti live. Push kedua pada
branch Harvy yang sama mengikat immediate parent/head sebelumnya dan tetap
non-force.
Grant publish mengikat interaction ID dan audience `workspace-private`;
interaction group gagal sebelum approval. Detach saat project deletion hanya
membersihkan ledger/selection credential-free lokal setelah receipt ambigu
selesai dan tidak melakukan remote unlink atau menghapus repository GitHub.
Receipt `unknown` kini dapat dipage sebagai locator content-free dan diamati
worker bounded satu proses setelah restart tanpa scope pengguna atau replay
branch/push/PR. Worker menerima authority historis exact saat installation sudah
revoked, memerlukan ACK terminal fenced, dan hanya mencatat agregat; primitive
ini belum dirangkai di `app.ts` atau membuktikan recovery multi-instance.
Watchdog AgentHarness mengatribusikan `AbortError` ke owner deadline yang sudah
dipilih sehingga tie invocation/RunBudget tidak berubah karena scheduler load.
Semua capability baru default-off.

Verified: `npm run check` PASS; tes terarah G–J/authority/HTTP PASS, 171 test
dalam 19 suite; `npm test` PASS, 1.120 test dalam 138 suite, 0 gagal;
`npm run context:check` PASS. Tes mencakup malicious
archive, tamper/quota, tenant/admission/watchdog, writer/validator/commit race,
stale zombie, structured guard/escaped source, strict HTTP proof/stream,
second-run non-force push, exact ref/approval/replay/reconciliation, serta
penolakan credential-like key dan value.

Not verified: runner Linux/container nyata, seccomp/cgroup/mount/network/secret
isolation dan streaming cap; daemon local-git/object store dan GitHub App
broker di trust domain nyata, provision secret identitas service + verifier
server-side, confirmation controller
produksi; Workspace ingress/UI/kanal E2E;
provider/model coding;
power-loss durability file journal
pada Windows; serta metadata project/run/evidence/deletion/GitHub
multi-instance.

Next: pasang dan conformance-test runner, daemon local-git, object store, serta
GitHub App broker di trust domain terpisah; provision secret identitas service,
verifier server-side, dan
confirmation controller; lalu baru rangkai executor/surface dan capability.

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
