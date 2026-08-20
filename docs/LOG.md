# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-08.md`](log/2026-08-08.md)
- [`log/2026-08-09.md`](log/2026-08-09.md)
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

## 2026-08-20 — Coding input target dan publish privat exact

Scope: CodingRun/coordinator/worker, private coding session, private GitHub
application, provider profile/smoke, startup harness, tes integrasi, dan status.

Changed: `waiting_input` CodingRun kini membawa pertanyaan durable terikat
instruction revision; reply Anchor tepercaya menjadi ChangeSet sedangkan batas
action internal tetap checkpoint `running`. Session privat mempertahankan
project revision pada jeda nonterminal. Publish privat menjalankan branch,
exact push, dan draft PR melalui tiga confirmation terpisah; offer menjadi basi
setelah ACL epoch berubah. Body Markdown PR menerima newline/tab tetapi tetap
menolak control character lain. Profile
`google-ai-studio/gemini-3.5-flash-lite` pada endpoint resmi dipromosikan
code-owned setelah wire exact lulus; custom gateway dan active fallback tidak
mewarisi capability itu.

Verified: `npm run check` PASS; `npm test` PASS 1.413/1.413 dalam 183 suite, 0
gagal; `npm run context:check` PASS; `git diff --check` PASS selain peringatan
line-ending Windows. Acceptance otomatis membuktikan ZIP→CodingRun→validator→
local commit, pertanyaan target, urutan private confirmation, dan rejection
sebelum transport saat authority berubah. `npm run acceptance:provider` PASS
live pada 20 Agustus 2026 dengan digest
`4d4c4f299b84b5a1767c96a54e6591a53c06a90807aba16d78a04fe4967d7d5c`:
effort, native tool, thought signature+replay, stop/length, local pressure gate,
timeout, dan retry teramati; fallback dinonaktifkan.

Not verified: hostile suite pada Linux nyata, GitHub App/repository live,
WhatsApp grup nyata, provider fallback, dan critic `toughest` live. Guard
berhenti tanpa efek dengan
`SANDBOX_ACCEPTANCE_REQUIRES_LINUX_HOST`,
`GITHUB_LIVE_ACCEPTANCE_REQUIRES_CREATE_NONCRITICAL_DRAFT_PR`, dan
`WHATSAPP_LIVE_ACCEPTANCE_REQUIRES_RUN_NONCRITICAL_WHATSAPP_GROUP`.

Next: jalankan acceptance nonkritis exact pada infrastruktur/credential live,
tanpa membuka runtime default-off sebelum bukti conformance tersedia.

## 2026-08-15 — Coding production vertical slice dan trust-domain service

Scope: isolated sandbox, Workspace/CodingRun private+group composition,
local-git, GitHub App broker, startup recovery, validator escalation, TTFR,
deployment contract, acceptance harness, dan status arsitektur.

Changed: Harvy kini mempunyai service rootless OCI terpisah dengan
network-off/quota/seccomp/no-host-mount, 15-scenario hostile harness dan exact
conformance receipt gate; AI coding writer iterative, production validators,
Run Anchor, trusted private ingress, stale revision/cancel fencing, dan ZIP→Git
commit acceptance otomatis; credential-free local-git dengan atomic ref CAS;
credential-owning GitHub App broker dengan installation/archive/exact
non-force push/draft PR/reconciliation; startup/shutdown supervisor production;
validator-driven one-shot `toughest`; TTFR/final p50/p95; serta group-coding
ingress, private Workspace handoff, audience-safe delivery, dan authority-loss
lifecycle fence. Seluruh runtime tetap opt-in dan fail-closed.

Verified: `npm run check` PASS; `npm run context:check` PASS; `npm test` PASS
1.399/1.399 dalam 181 suite, 0 gagal; suite perbaikan ZIP/Workspace/HTTP
trust-domain PASS 23/23; `git diff --check` PASS selain peringatan line-ending.
Acceptance guard sandbox, GitHub, provider, dan WhatsApp semuanya berhenti
sebelum efek dengan reason code eksplisit.

Not verified: hostile suite pada Linux nyata (host ini Windows tanpa OCI/WSL),
GitHub branch/push/draft PR live (App+repo uji+confirmation tidak tersedia),
provider continuation exact (profile aktif compatibility), dan WhatsApp grup
live (confirmation+akun/grup uji tidak tersedia). Store selain lease SQLite
masih single-service; horizontal safety dan procedural memory belum selesai.

Next: jalankan empat acceptance pada infrastruktur nonkritis exact, terbitkan
receipt sandbox dari host yang sama, lalu kerjakan distributed lease/outbox/
reconciler hanya setelah bukti live P0/P1 lulus.

## 2026-08-15 — GroupAgentRun menjadi reachable dan startup dapat dibatalkan

Scope: composition WhatsApp GroupAgentRun, checkpoint/delivery repository,
startup/shutdown runtime, konfigurasi lokal, status, dan ADR-037.

Changed: bubble GroupAgentRun authorized kini dipisahkan sebelum batch chat dan
masuk ke guarded controller, executor/processor, worker durable, usage, serta
Baileys delivery fence. Claim/final/question memakai repository dan receipt
nyata; watermark jawaban dibaca setelah question delivery, startup/periodic
resume serta stop/drain dirangkai, dan flag tetap opt-in. Transisi repository
sekarang mengizinkan pengikatan question ID pada checkpoint sampling yang sama.
Control IPC dipasang sebelum network startup Telegram; dev-stop mengabort
request startup, mencegah polling terlambat menjadi ready, dan melepas lock.
`.env` lokal dikonfigurasi dengan state GroupAgentRun terpisah.

Verified: suite terarah PASS 40/40; `npm test` PASS 1.348/1.348 dalam 169 suite;
`npm run check` dan `npm run context:check` PASS (5.125 byte, estimasi 1.282
token); smoke dev mencapai `application_ready`→`shutdown_completed`, exit 0,
tanpa `runtime_failed` atau lock tersisa; `git diff --check` PASS selain
peringatan line-ending.

Not verified: GroupAgentRun/notice/reconnect/fault delivery di WhatsApp nyata,
provider live, multi-process storage/outbox, runner Linux terisolasi, daemon
local-git, atau GitHub App broker nyata. Coding/GitHub tetap fail-closed.

Next: lakukan acceptance WhatsApp dengan akun/grup uji nonkritis; provision
backend isolated-linux dan GitHub App terpisah sebelum membuka surface coding.

## 2026-08-15 — Fondasi arsitektur agent mencapai Phase M

Scope: completion GroupAgentRun Phase K, group-coding Phase L, escalation
`toughest`/privacy observability/eval routing Phase M, config, ledger, ADR, dan
tes.

Changed: GroupAgentRun kini mempunyai authority-on-claim, executor one-decision
group-safe tanpa private context/capability, checkpoint RunBudget content-free,
work processor yang mengurutkan checkpoint→delivery receipt→usage settlement,
serta startup reconciliation kandidat usage. Phase L menambah link grup ke
Workspace melalui irisan admin grup + membership/permission Workspace,
CodingRun admission/reference idempoten, proyeksi grup tanpa source/diff/path,
dan offer GitHub yang tetap memerlukan confirmation privat. Phase M menambah
slot `toughest` default-off dengan profile exact dan privacy domain, closed
validator reasons, one-shot/no-tool durable reservation, no-retry outcome
ambigu, sensitive cross-domain gate, metadata route/material content-free, dan
harness routing A–E dengan variant E hanya untuk selected hard tasks. Capability
kanal/coding tidak dibuka dan seluruh core baru belum composed ke runtime
produksi.

Verified: `npm run check` PASS; `npm test` PASS 1.345/1.345 dalam 167 suite
termasuk build; `npm run context:check` PASS (6.070 byte, estimasi 1.518 token);
`git diff --check` PASS. Suite mencakup Phase K executor/processor/barrier,
Phase L audience/authority/replay, Phase M policy/repository/config/ledger, dan
corpus routing.

Not verified: WhatsApp/group-coding/provider/toughest/evaluator live, runner
Linux, GitHub broker/App nyata, restart proses atau multi-process nyata, harga
model toughest, serta privacy behavior provider eksternal.

Next: implementasikan resolver+lease authority dan composition produksi secara
terpisah, lalu jalankan conformance/live test sintetis sebelum capability
diaktifkan.

## 2026-08-14 — Koordinasi penulisan coding agent menjadi adaptif

Scope: workflow kontribusi, ADR-001/005/038, dan indeks keputusan.

Changed: mandat satu penulis, read-only otomatis untuk peran lain, dan worktree/
clone wajib bagi penulis kedua dicabut. Agent kini memilih strategi koordinasi
berdasarkan scope dan risiko, sambil tetap menjaga perubahan yang ada serta
otoritas pengguna. Invariant runtime `CodingRun` tidak berubah.

Verified: `npm run context:check` PASS; tes kontrak agent PASS 11/11; pencarian
sumber aktif tidak menemukan mandat lama.

Not verified: kolaborasi live beberapa penulis pada perubahan yang overlap.

## 2026-08-14 — Fondasi lifecycle, work, dan final Group AgentRun Phase K

Scope: GroupAgentRun core/delivery/lifecycle WhatsApp.

Changed: Notice v9, activation lease/quote cache, cleanup durable, ledger work,
dan final commit barrier kini tersedia. Migrasi work/result dan cap event tetap
konservatif; state nonterminal selalu menyisakan slot penutupan dan hasil yang
tidak committed tidak diakui. Exact parser/controller dan
`GroupAgentRunWorker` ada tetapi belum composed; checkpoint/executor model belum
ada dan authority-on-claim tetap prasyarat sebelum composition.

Verified: tes terarah GroupAgentRun/WhatsApp 275/275 dalam 24 suite; `npm run
check` PASS; `npm test` PASS 1.270/1.270 dalam 158 suite termasuk build;
`npm run context:check` PASS (6.070 byte, estimasi 1.518 token); diff-check PASS.

Not verified: WhatsApp/reconnect/model/work live, restart proses nyata,
reconciliation `unknown`, dan multi-process.

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
