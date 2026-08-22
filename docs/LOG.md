# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-08.md`](log/2026-08-08.md)
- [`log/2026-08-09.md`](log/2026-08-09.md)
- [`log/2026-08-13.md`](log/2026-08-13.md)
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

## 2026-08-22 — Percakapan semantic-first dan interruptible lintas kanal

Scope: kebijakan batas giliran, lifecycle progress, presentasi respons,
adapter Telegram dan WhatsApp privat/grup, evaluator, tes, dan dokumentasi
kontrak percakapan.

Changed: seluruh batch, konteks ringkas, dan timing kini menjadi dasar
assessment semantik `complete|open|incomplete|urgent`; guard lokal dibatasi
pada bentuk deterministik sempit. Pesan yang masuk saat pekerjaan aktif
dibedakan menjadi addition, correction, redirect, atau independent supaya
pekerjaan stale dapat dibatalkan tanpa mematikan percakapan independen.
Progress memakai satu surface sementara setelah grace period dan hanya
mengumumkan fase kerja yang benar-benar berjalan. Telegram dan WhatsApp memakai
planner presentasi bersama tanpa batas personality tiga bubble, memeriksa fence
sebelum setiap bubble/efek, serta hanya mencatat history dan usage yang
benar-benar terkirim. Grup WhatsApp tetap diam untuk arus ambient.

Verified: suite terarah PASS 386/386 dalam 21 suite; `npm run check` PASS;
`npm test` PASS 1.614/1.614 dalam 202 suite; `git diff --check` PASS selain
warning line-ending Windows.

Not verified: provider/model live, akun Telegram nyata, akun WhatsApp nyata,
reconnect, edit/delete status, dan interupsi delivery pada jaringan nyata.

## 2026-08-22 — WhatsApp pribadi opt-in dan default-off

Scope: konfigurasi dan transport WhatsApp, percakapan privat, consent, safety,
context/memory/history, usage/funding, tes, dan dokumentasi kanal.

Changed: `WHATSAPP_PRIVATE_ENABLED` ditambahkan dengan default `false`. Saat
mati, transport membuang chat pribadi sebelum callback tetapi grup tetap
berjalan. Saat aktif, pesan pribadi memakai consent `SETUJU`, core percakapan
dan safety yang sama, scope data WhatsApp terisolasi, kontrol teks izin/memori,
penghapusan penuh dengan konfirmasi exact, serta settlement history balasan dan
usage hanya setelah send berhasil.
Surface khusus Telegram seperti tombol, ZIP/coding, task/reminder, dan sesi
interaktif belum dipindahkan.

Verified: tes terarah WhatsApp PASS 63/63 dalam 4 suite; `npm run check` dan
`npm run build` PASS; `npm test` PASS 1.586/1.586 dalam 200 suite;
`npm run context:check` PASS (6.088 byte, estimasi 1.522 token) dengan warning
bahwa snapshot CURRENT 21 Agustus mendahului entri ini;
`git diff --check` PASS selain warning line-ending Windows.

Not verified: akun WhatsApp nyata, reconnect/delivery live, banyak nomor nyata,
provider/model live, dan parity surface khusus Telegram.

## 2026-08-21 — Fondasi Harvy Compute dan funding resolver

Scope: plan policy, economy/runtime funding, billing/usage UX, Telegram,
WhatsApp, Console, config, tests, dan dokumentasi paket.

Changed: allowance fixed-point dipisahkan dari RunBudget dan physical-cost
ledger. Request memakai reservation dan delivery settlement dengan funding
included/sponsored/PAYG-consent/BYOK/safety-exempt. Stable plan IDs dan quality
ceiling dipertahankan. Wallet, subscription, Commons, payment interface,
encrypted BYOK store, operator view, dan `/penggunaan` owner-scoped tanpa model
ditambahkan; token legacy tetap overlay tanpa rewrite historis. Dashboard
memisahkan physical cost dari settlement, memakai snapshot cache historis, dan
menolak disclosure grup. Persentase allowance dashboard kini memakai basis
points `BigInt`; usage/reservation sekecil apa pun tidak lagi terlihat `100%`.

Verified: targeted economy/dashboard/channel PASS (112/112); `npm run check`
dan `npm run build` PASS; `npm test` PASS (1.520 test dalam 194 suite, 0
gagal); `npm run context:check` PASS.

Not verified: payment provider production, signed webhook/reconciliation live,
secret rotation/KMS, dan `/penggunaan` pada akun Telegram/WhatsApp live.

## 2026-08-22 — Long-term memory, `/memori`, dan explicit remember

Scope: memory/history/learning core, Telegram+group adapter, project memory,
data control, policy, tes, ADR-006/043, serta Constitution v0.6.

Changed: potret `/memori` tetap bounded dan bukan canonical source; natural
edit/forget tetap memakai cascade. Perintah explicit remember kini menjadi
consent item-spesifik setelah signal understanding dan guard raw user turn
sama-sama cocok; personal memory langsung ditulis tanpa consent kedua, tetapi
cerita implicit tetap bertoken. Negasi/retrieval/reminder, candidate lain, dan
scope lain tidak mendapat authority. Credential ditolak lagi oleh primary,
group, dan project memory service. Acknowledgment hanya mengaku ingat setelah
write atau duplicate terbukti. Receipt hasil commit dibawa ke penyusun balasan
agar Harvy mengakuinya di dalam jawaban utama yang mengikuti konteks, bukan
lewat template atau log memory kedua. `📍` bersifat opsional untuk save/update,
sedangkan `💭` hanya untuk recall; beberapa write dalam satu turn disintesis
menjadi satu pengalaman.

Verified: targeted acknowledgement/explicit/Telegram/group 223/223 PASS;
`npm run check` PASS; `npm test` PASS 1.575/1.575 dalam 199 suite; `npm run
context:check` PASS; `git diff --check` PASS selain warning line-ending Windows.

Not verified: provider/model atau Telegram/WhatsApp live, multi-node storage,
dan kualitas recall guard pada ragam bahasa di luar fixture.

## 2026-08-20 — Routing role dan bounded orchestration

Scope: understanding/global routing, model role/config/profile, execution
policy, Agent Runtime delegation, handoff/resource/discovery contract, tes, dan
ADR-041.

Changed: assessment semantic tertutup kini membedakan mechanical/normal/deep,
nuansa, planning, stakes, size, serta tool need; panjang 280 karakter tinggal
fallback legacy. Ordinary chat berbicara lewat everyday role dan deep chat lewat
orkestrator langsung. Tier accounting tetap kompatibel sementara role dapat
diikat ke exact model lewat config. Specialist one-hop memakai WorkBrief/
AgentHandoff tanpa reasoning privat, authorization default-deny, context-free
delegation, dan batas dua aksi; production tetap default-off. Execution effort
dapat naik dari difficulty/stakes/uncertainty. Resource grant dan capability
discovery ditambahkan sebagai primitive code-owned yang belum dirangkai ke
RunBudget/planner aktif. `toughest`, selective safety, dan continuation tidak
diubah. Entri LOG terlama dipindah utuh ke arsip 2026-08-09 sesuai batas ukuran.

Verified: tes terarah 229/229 PASS; `npm run check` PASS; `npm test` PASS,
1.448 test dalam 187 suite, 0 gagal; `npm run context:check` PASS;
`git diff --check` PASS selain peringatan line-ending Windows.

Not verified: provider/model atau Telegram/WhatsApp live, kualitas corpus
routing nyata, latency/token/cost production, specialist production, adaptive
reserve runtime, progressive schema retrieval, connection/OAuth, dan capability
acquisition/sandbox pihak ketiga.

Next: evaluasi assessment pada corpus tanpa menambah call ordinary; kemudian
rangkai resource reserve dan specialist hanya bersama privacy/objective policy
serta telemetry outcome content-free.

## 2026-08-20 — Riset agent dipromosikan dan dibersihkan

Scope: `docs/research/`, navigasi dokumentasi, serta bukti implementasi agent,
memory, sandbox, provider, dan control plane.

Changed: tujuh draf riset non-normatif dihapus setelah audit penuh. Temuan yang
diterima sudah hidup pada kontrak, kode, tes, dan status subsystem: bounded
AgentRun/checkpoint, scope dan approval code-owned, episodic/semantic memory,
context-pressure serta observation compaction, fallback provider berbatas,
console operasi, dan sandbox OCI `network=none` dengan GitHub berada di broker
terpisah. Tidak ada perilaku runtime baru. Self-installing skill, device
spoofing, command blacklist, dan network allowlist tidak diadopsi: sebagian
lebih lemah daripada isolation yang berjalan, sementara procedural/social
learning dan fallback native masih memerlukan keputusan atau bukti live yang
tercatat di STATUS.

Verified: seluruh isi `docs/research/` dibaca; implementasi dan tes terkait
diperiksa terhadap kontrak/status aktual. `docs/INDEX.md` tidak lagi menautkan
draf yang dihapus. `npm run context:check` PASS dan `git diff --check` PASS
dengan peringatan konversi line-ending Windows saja.

Not verified: `npm run check`, `npm test`, dan acceptance live tidak dijalankan
ulang karena tidak ada perubahan kode atau perilaku runtime.

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
