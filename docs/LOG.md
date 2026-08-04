# Catatan Pekerjaan Harvy

Dokumen ini menjawab: **apa yang dikerjakan terakhir kali, dan kenapa.**

Sesi kerja Harvy dilakukan bergantian oleh manusia dan beberapa AI yang tidak
saling membaca riwayat percakapan. Tanpa catatan ini, setiap sesi baru harus
menebak keadaan dari kode — dan dugaan yang masuk akal pernah masuk ke dokumen
sebagai fakta yang tidak pernah terjadi. Lihat
[`ADR-005`](decisions/ADR-005-konteks-menggantikan-work-order.md).

Urutan terbaru di atas. Tulis entri sebelum sesi berakhir, bukan setelah
diminta.

Bagian sebuah entri:

| Bagian | Isi |
|---|---|
| **Kenapa** | Alasan pekerjaan itu dilakukan |
| **Yang berubah** | Berkas dan perilaku yang bergeser |
| **Dibahas** | Keputusan, kesimpulan, atau arah yang muncul dari diskusi — meski belum ada kode yang ditulis |
| **Bukti** | Perintah verifikasi yang benar-benar dijalankan beserta hasilnya, dan apa yang tidak diuji |
| **Sengaja ditinggalkan** | Pekerjaan yang diketahui tetapi tidak dikerjakan |

Bagian yang tidak relevan boleh dihilangkan, kecuali satu: **sesi yang hanya
berdiskusi tetap wajib menulis entri dengan bagian "Dibahas"**. Keputusan yang
hanya hidup di percakapan akan hilang, karena sesi berikutnya — manusia maupun
AI — tidak dapat membacanya.

---

## 4 Agustus 2026 — Verifikasi sebelum commit dan push Agent Acceptance v1

**Kenapa.** Sesi ini diminta untuk commit dan push perubahan working tree
milestone Agent Acceptance v1 yang sudah dicatat pada entri sebelumnya.

**Yang berubah.** Tidak ada perilaku produk baru yang ditambahkan dalam sesi
ini. Working tree yang sudah berisi Agent Runtime, hardening authority, probe,
fixture, dokumentasi, dan tes diverifikasi sebagai satu perubahan terpadu.

**Dibahas.** Commit dilakukan pada branch `main` yang melacak `origin/main`,
dengan hook `.githooks` tetap aktif. Seluruh perubahan yang sudah ada di
working tree diperlakukan sebagai satu commit sesuai permintaan pemilik.

**Bukti.** `npm run check` PASS. `npm test` PASS — 634 test dalam 97 suite,
tanpa fail/cancel/skip/todo. Telegram nyata, WhatsApp nyata, dan provider
eksternal tidak disentuh dalam sesi verifikasi ini.

**Sengaja ditinggalkan.** Kesiapan staging Telegram, model fisik per-tier,
durable checkpoint, kalender eksternal, shell host, dan write tools tetap di
luar scope seperti dicatat pada entri milestone sebelumnya.

## 4 Agustus 2026 — Agent Acceptance v1, hardening authority, dan probe model

**Kenapa.** Pemilik produk meminta milestone Agent Acceptance v1 diselesaikan
dari working tree yang sudah berisi Agent Runtime, tanpa memperluasnya ke
kalender eksternal, shell host, atau write tools. Dua belas skenario harus
mempunyai bukti yang dibedakan antara otomatis, model nyata, staging nyata,
dan belum diuji. Hanya agent utama menulis; tiga sub-agent melakukan audit dan
tes read-only. Seluruh perubahan working tree sebelumnya dipertahankan dan
tidak ada commit/push.

**Yang berubah.** Probe pemahaman primary testing menemukan kalimat “cek
agendaku untuk 3 minggu ke depan” diberi intent `history`. Adapter sekarang
mengenali state-live secara lokal sebelum route memory/control/research dan
tetap menjalankan Agent Runtime dengan intent operasional `question`;
permintaan planning eksplisit juga tetap masuk root `orchestrate` walau model
salah memberi intent `task`. Live-evidence gate kini menolak `need_input` yang
tidak perlu sebelum tool authority dibaca, mengulang observation yang horizon,
limit, atau tanggal lokalnya belum cukup, serta menempelkan pemberitahuan batas
31 hari secara deterministik. “Beberapa minggu” memakai 21 hari dan angka
besar seperti 100 hari tetap dibatasi 31 hari.

Agenda hari ini/besok kini membawa `localDate` berdasarkan timezone profil.
Executor menyaring event di luar tanggal itu sebelum observation mencapai
model, sehingga hari ini/lusa tidak lagi hanya bergantung pada kepatuhan
sintesis. Fast path waktu diuji pada instant yang sama untuk tanggal WIB dan
WIT. Route/executor tugas dan agenda mendapat canary cross-owner. Terminal
virtual menolak semua segmen `.env*` selain host path, process, environment,
network, traversal, dan resource bomb yang sudah ditutup.

Kontrak worker diperiksa end-to-end dari Conversation ke
`ParallelDelegationExecutor` dan `createModelAgentWorker`: body pesan worker
hanya membawa `runId/taskId/tier/instruction`, tier `cheap|efficient`, tanpa
summary, history, memory, owner/scope selector, capability schema, tool,
credential, atau hak delegasi. Tes kegagalan worker memastikan sibling lambat
selesai sebelum executor resolve dan disclosure parsial ditempel kode. Tes
lain menutup owner/10-menit/restart checkpoint, pembatalan root aktif tanpa
balasan basi, body `AiClient` tanpa key sintetis, serta jawaban capability
agenda internal/terminal virtual.

`scripts/coba-agent.ts` ditambahkan sebagai probe sintetis primary-only untuk
root tools, root orchestrate+delegasi, dan agenda besok; ia tidak membaca data
pengguna dan hanya mencetak status/capability, bukan observation atau
credential. Fixture riwayat authority sintetis ditambahkan untuk membuktikan
model tidak menjadikan percakapan lama sebagai bukti izin, agenda live, atau
keberhasilan terminal. `coba-balasan.ts` kini menerima snapshot capability yang
sama dengan aplikasi. Matriks dua belas skenario dan checklist staging persis
dicatat di
[`docs/evidence/agent-acceptance-v1-2026-08-04/README.md`](evidence/agent-acceptance-v1-2026-08-04/README.md);
`STATUS.md`, `TESTING.md`, dan `AGENTS.md` diselaraskan hanya dengan bukti ini.

**Dibahas.** Mode testing lokal tidak mempunyai override model per-tier yang
lengkap, sehingga probe provider nyata membuktikan route logical
`cheap`/`ambitious` dan fan-out worker tetapi bukan tiga model fisik berbeda.
Checkpoint tetap in-memory: store baru terbukti kosong setelah restart, namun
tanpa tombstone Harvy belum dapat selalu mengatakan secara eksplisit bahwa
prompt lama hilang. `/start` dan jalur cancel generation membatalkan pekerjaan
lama; `/tugas` sengaja memakai FIFO drain, jadi kontraknya bukan “semua command
membatalkan”. Pagar state-live tetap kumpulan parafrasa presisi, bukan
classifier universal.

**Bukti.** Baseline sebelum perubahan: `npm run check` PASS dan `npm test` PASS
— 621 test dalam 97 suite. Tes terarah setelah hardening lulus 89/89 lalu 78/78
pada kumpulan route, Conversation, executor, checkpoint, terminal, client, dan
adapter. Probe primary testing tanpa fallback:

- `coba-pemahaman.ts` memperlihatkan salah-intent agenda `history`, lalu prompt
  kompleks terbaca `request` dengan `needsStepByStep:true`;
- `coba-agent.ts` menjalankan `terminal.run` dan menghasilkan 126, menjalankan
  `agent.delegate.parallel`, serta menjalankan agenda besok dengan horizon dua
  hari dan hanya menyebut event tanggal lokal besok;
- `coba-balasan.ts` menyatakan kalender hanya agenda internal Harvy, bukan
  Google/Outlook, dan terminal virtual tidak dapat membuka `.env`/komputer;
- probe dua giliran authority menolak riwayat sebagai bukti izin atau
  keberhasilan sistem.

Run penuh pertama setelah perubahan menghasilkan 633/634 karena satu assertion
capability masih mengharapkan deskripsi sebelum `localDate`; tidak ada kegagalan
produk. Assertion diperbarui, lalu `npm test` diulang dan PASS — **634 test
dalam 97 suite**, 0 fail/cancel/skip/todo. `npm run check` dan `git diff
--check` juga PASS; perintah terakhir hanya memberi peringatan konversi
LF/CRLF. Token Telegram hanya diperiksa keberadaannya tanpa mencetak nilai;
karena tidak ada penanda token/akun staging dan environment bukan staging,
Telegram nyata tidak disentuh.

**Sengaja ditinggalkan.** Seluruh checklist Telegram staging berstatus NOT RUN.
Restart nyata belum membuktikan UX pengakuan kehilangan checkpoint; per-tier
physical model belum dibuktikan; kegagalan worker tetap memakai fault
injection otomatis; parafrasa authority di luar pola yang diuji masih
model-dependent. Kalender Google/Outlook, shell/process/filesystem host,
credential access, write tools, durable RunStore/checkpoint, dan akun produksi
tetap di luar scope.

## 4 Agustus 2026 — Batas “selesai” Agent Runtime dan urutan lanjutan

**Kenapa.** Pemilik produk meminta penilaian apakah pembuatan agent sudah
selesai, rancangan apa yang tertinggal, dan langkah apa yang sebaiknya diambil
berikutnya. Penilaian perlu membedakan implementasi vertical slice dari
kesiapan produksi agar kemampuan yang baru lulus adapter palsu tidak diklaim
sudah terbukti pada pengguna nyata.

**Dibahas.** Agent Runtime v1 dinilai **selesai pada ruang lingkup kode yang
diputuskan ADR-017**: cheap-first, ambitious orchestration, fan-out 2–3 worker
cheap/efficient, tool internal read-only, clock deterministik, agenda internal,
terminal virtual, checkpoint klarifikasi, cancellation/generation guard, dan
memory/context separation sudah terpasang serta lulus 621 tes. Harvy sebagai
agent produksi belum selesai. Urutan yang disepakati untuk rekomendasi adalah:
(1) acceptance end-to-end pada Telegram staging dan model nyata; (2) durable
RunStore/checkpoint, outbox, receipt, status unknown, reconciler, dan PostgreSQL;
(3) memory engineering v3—provenance, revision, valid-time, supersession, cap,
trust/actor, serta deletion propagation; (4) baru konektor kalender eksternal
read-only dengan OAuth per pengguna dan sandbox eksekusi terisolasi; (5) write
tools hanya setelah CAS, preview approval persis, idempotensi, serta kompensasi
terbukti. Pembatalan request biasa oleh pesan urgent, uji mandiri tujuh hari,
deployment/backup, dan evaluasi kualitas orkestrator tetap menjadi gerbang
produk, bukan kosmetik.

**Bukti.** `PROJECT.md`, `CONSTITUTION.md`, `engineering/STATUS.md`, dan entri
terbaru `LOG.md` dibaca ulang. Tidak ada gerbang tes baru dijalankan pada
diskusi ini; angka 621 tes/97 suite berasal dari verifikasi penuh sesi
implementasi tepat sebelumnya. Tidak ada kemampuan baru yang diklaim atau kode
produk yang diubah.

**Sengaja ditinggalkan.** Tidak ada implementasi lanjutan dimulai karena
pertanyaan ini meminta status dan urutan keputusan. Kalender Google/Outlook,
shell/program host, durable run, write executor, serta memory v3 tetap belum
ada sampai milestone terkait dipilih dan diberi acceptance criteria.

## 4 Agustus 2026 — Agent Runtime internal cheap-first dan delegasi paralel

**Kenapa.** Pemilik produk meminta Harvy diselesaikan sebagai agent yang dapat
memakai tool internal, mengetahui jam, membaca kalender sederhana, mempunyai
terminal, menyusun rencana, menjalankan satu model murah secara default, lalu
naik menjadi orkestrator ambitious yang mendelegasikan subpekerjaan paralel ke
model cheap/efficient. Permintaan juga menuntut memory engineering yang baik.
Audit kode lebih dulu menemukan tiga kegagalan yang harus ditutup sebelum
fan-out: capability fitur produk dapat tampak callable walau executornya tidak
ada, deadline checkpoint dimulai ulang pada resume, dan settlement entitlement
per owner dapat menyapu run paralel lain.

**Yang berubah.** `ADR-017` menetapkan Agent Runtime v1 read-only. Pertanyaan
dan permintaan privat yang sudah lolos consent+triase serta tidak membawa sesi
aktif kini masuk root `cheap`; pesan `needsStepByStep` atau di atas 280
karakter memakai root `ambitious`. Mode testing tetap dapat menjalankan semua
role lewat satu `testingModel`. Root ambitious dapat memanggil
`agent.delegate.parallel` untuk 2–3 worker `cheap|efficient`; worker tidak
menerima tool, history, memory, credential, scope selector, model ID, atau hak
delegasi. Semaphore membatasi tiga worker provider, seluruh child berbagi
deadline/cancellation, `Promise.allSettled` mempertahankan sibling, dan output
parsial/terpotong ditandai tak tepercaya sebelum sintesis root. Pass delegasi
langkah nol tidak menerima history/memory dan hanya boleh melakukan fan-out;
jalur non-delegasi serta sintesis memakai context terpilih dengan recent turn
sebagai pesan chat. Tiap worker dibatasi 800 karakter dan envelope observation
gabungan 3.600 karakter tetap JSON valid serta membagi ruang antar-worker.

Tool atomik `task.list_active`, `task.get`, `session.status`,
`settings.time.get`, dan `calendar.agenda` sekarang dipasang pada privat
Telegram. Owner selalu berasal dari `PrivateAgentScope`, bukan input model.
Agenda hanya memproyeksikan tenggat, pengingat, serta check-in Harvy selama
1–31 hari dan menyatakan `externalCalendar:false`. Pertanyaan jam/tanggal yang
berdiri sendiri memakai clock runtime+timezone secara deterministik tanpa
planner. `terminal.run` adalah scratchpad virtual in-memory baru pada setiap
action: `pwd/date/echo/calculate/write/append/cat/list/remove` di bawah
`/workspace`, tanpa child process, shell host, environment, network, host file,
TTY, background job, atau persistensi. Path escape, absolute host path,
expression asing, file, kompleksitas, command, dan output berlebihan ditolak.

Planner kini menerima `callableCapabilities`, irisan snapshot available dengan
executor versi tepat, dan prompt hanya memuat schema tool callable pada langkah
itu. Checkpoint menyimpan `startedAt`, `deadlineAt`, `maxSteps`, dan hash
authority callable. Setiap invocation aktif dibatasi 45 detik; `need_input`
disimpan owner-scoped setelah delivery dan dapat dilanjutkan pada checkpoint
yang sama selama horizon absolut 10 menit tanpa menambah langkah atau mengganti
executor. Ingress
privat diberi `turnId` melalui `AsyncLocalStorage`; root+worker mewarisinya dan
delivery/discard hanya menyelesaikan kandidat `ownerId + turnId`. Route safety,
consent, data control, mutasi task/memory/session, dan research tetap terpisah.
`AiPurpose` serta migrasi telemetry/label Console ditambah untuk `agent`.
Persetujuan privat naik ke versi 5 dan naskah perkenalan/detail kini menjelaskan
bahwa permintaan kompleks yang aman dapat dibagi kepada paling banyak tiga
worker sekaligus tanpa memberi mereka memori, riwayat, credential, atau tool.
Abort command/generation Telegram sekarang diteruskan melalui extraction,
triase, reply/review, research, root agent, dan executor; freshness diperiksa
lagi sebelum delivery/state commit. Frasa personal berpresisi tinggi tentang
tugas, sesi, waktu, atau agenda wajib mempunyai observation live dengan limit/
horizon yang cukup sebelum final diterima. Ini pagar deterministik untuk pola
yang diuji, bukan klaim bahwa setiap parafrasa sudah dapat dikenali.

**Dibahas.** Audit memory menunjukkan semantic memory saat ini belum mempunyai
provenance, revision, valid-time, supersession, atau cap; penghapusan satu
record belum men-scrub sumber dari recent history/episode; episode belum
membawa actor/trust per klaim; dan retensi fisik beberapa store masih lazy.
Karena itu “belajar” didefinisikan secara berlapis: semantic memory yang dapat
dilihat/dikoreksi untuk preferensi, episodic history hanya untuk continuity,
checkpoint untuk progress run, state tugas/agenda/sesi sebagai authority live,
dan receipt kelak sebagai bukti outcome. Memori/episode tidak pernah menjadi
bukti izin, actor, credential, waktu, jadwal, atau keberhasilan tool; worker
tidak mendapat memori. Harvy tidak melakukan hidden self-training dari chat
produksi. Perbaikan global harus offline, berversi, dapat di-rollback, dan
memakai data sintetis atau opt-in. Arah ini dicatat di prompt, ADR, STATUS,
PROJECT, README, TESTING, INDEX, dan entry-point agent.

**Bukti.** `npm run check` PASS. Tes terarah Agent Runtime—conversation,
routing/harness, executor internal, terminal, adapter Telegram, dan
settlement—PASS. `npm test` PASS — **621 test dalam 97 suite**, seluruhnya
lulus tanpa gagal, dibatalkan, dilewati, atau todo. Tes membuktikan pemilihan
cheap/ambitious, satu model testing, fan-out
overlap, context-free delegation, tier/fan-out/schema tertutup, hasil parsial,
owner isolation, active deadline+horizon resume, WIB/WITA, fast path jam,
agenda internal, terminal escape/resource bounds, cancellation Telegram,
routing, dan settlement per turn. Tidak ada model/provider, Telegram, WhatsApp,
shell host, kalender eksternal, atau layanan jaringan yang dipanggil.

**Sengaja ditinggalkan.** Shell/process/filesystem host dan eksekusi program
tidak dibuka karena tidak ada sandbox VM/container terpisah yang dapat
memisahkan `.env`, auth, data, network, serta resource process. Google/Outlook/
device calendar dan seluruh write tool tetap unavailable sampai ada OAuth per
pengguna, revision/CAS, preview approval exact-value, durable RunStore,
idempotent outbox, receipt, status `unknown`, reconciler, export/deletion, serta
crash recovery. Checkpoint masih in-memory dan hilang saat restart; delivery
network tidak atomik serta belum ada cancellation lintas proses/background;
native `tools/tool_choice`, provider nyata, quality eval orkestrator, dan uji
end-to-end Telegram belum dikerjakan. Gap
provenance/suppression/retensi memory di atas tetap backlog sebelum tool write
boleh dibuka.

## 3 Agustus 2026 — Agent diprioritaskan pada toolbox internal, bukan research

**Kenapa.** Pemilik produk mengoreksi urutan setelah Scope & Authority v1:
infrastruktur agent tetap penting, tetapi pembangunan tool research web/X/
Threads tidak menjadi prioritas. Search membutuhkan layanan serta credential
eksternal dan belum mewakili pekerjaan dasar yang seharusnya dapat diselesaikan
Harvy dari domainnya sendiri.

**Dibahas.** Milestone berikut dipindahkan ke **Harvy Internal Tools v1**.
Tool tidak identik dengan API eksternal: executor dapat memanggil
`TaskService`, `SessionService`, dan layanan waktu/pengingat yang sudah berada di
Harvy tanpa credential baru. Capability besar seperti `task.manage` perlu
diturunkan menjadi kontrak tindakan sempit; scope/pemilik disuntikkan kode dan
tidak pernah menjadi argumen buatan model. Paket pertama adalah read tools
`task.list_active`, `task.get`, `session.status`, dan `settings.time.get`.
Sebelum write tool, Harvy memerlukan action receipt/idempotency persisten,
revision/CAS untuk mencegah stale overwrite, serta bukti permintaan asli yang
dipasok kode—bukan teks yang dikembalikan planner. Sesudah itu kandidatnya
`task.create`, `session.start`, `session.stop`, dan `task.set_due`, semuanya
melalui preview dan approval exact-value sampai contextual authorization
terbukti aman. `task.complete` diperlakukan destructive-ish selama belum ada
reopen/undo. `reminder.schedule` tidak dibuka tanpa pasangan
`reminder.cancel`, validasi waktu terpusat, outbox, receipt, dan reconciler;
cancel reminder itu sendiri belum tersedia di domain. `task.delete`,
penghapusan data, serta kontrol memori sensitif tetap workflow deterministik
sampai undo/kompensasi dan hak pengguna dapat dijaga; arbitrary shell/file
tool juga bukan surface Harvy.

Claude Code, Codex, dan NousResearch Hermes Agent menunjukkan pola yang sama:
loop memperoleh observation dari tool lalu memverifikasi hasil; schema,
registry/availability, permission, dan executor dipisahkan; read yang independen
dapat paralel tetapi write diserialkan; toolset diberikan seminimal mungkin;
session/checkpoint dapat dilanjutkan; serta hooks/policy dapat memblokir sebelum
eksekusi. Harvy mengambil pola itu, bukan luas tool coding agent. Harvy tetap
membutuhkan batas enam langkah, safety/consent deterministik, scope per orang/
grup, dan approval manusia karena penggunanya termasuk pelajar serta kanalnya
multi-pihak. Workflow seperti “pilih satu tugas untuk dimulai” atau “rapikan
minggu” diperlakukan sebagai skill/resep di atas tool kecil, bukan satu tool
besar.

Vertical slice yang direkomendasikan adalah **Fokus Satu Tugas**: Harvy membaca
tugas aktif, menjelaskan satu pilihan, meminta informasi yang benar-benar
kurang, menampilkan proposal, lalu setelah izin memulai sesi fokus dan—hanya
bila waktu dipilih pengguna—menjadwalkan check-in/pengingat. Slice ini memakai
kemampuan internal, dapat membuktikan native/canonical tool calling,
need-input, approval, pause/resume, idempotency, progress, dan verifikasi
outcome tanpa API search. Pengaktifan sesi harus mempertahankan pola
delivery-before-commit yang sudah ada, bukan memanggil mutasi domain dari
planner secara langsung. `RunStore` tetap dibangun sebagai infrastruktur agent
generik, bukan `ResearchRunStore`; adapter produksi PostgreSQL dapat menyusul
setelah kontrak tool dan vertical slice internal stabil.

**Bukti.** Keputusan dibuat setelah membaca ulang `PROJECT.md`, Konstitusi v0.5,
`engineering/STATUS.md`, entri LOG terbaru, `ADR-012`, dokumen riset agent,
`capabilities.ts`, `agent-harness.ts`, serta layanan tugas, sesi, dan memori.
Dokumentasi resmi terkini Codex, Claude Code/Agent SDK, dan repository/dokumentasi
resmi `NousResearch/hermes-agent` juga diperiksa untuk loop, tool registry,
permission, session, compaction, delegation, dan security boundary. Tidak ada
tes, model, provider, Telegram, WhatsApp, atau layanan eksternal yang
dijalankan; sesi ini hanya mengubah keputusan prioritas dan tidak mengubah kode
produk maupun status kemampuan.

**Sengaja ditinggalkan.** Belum diputuskan schema final tiap tool, provider
native-tool adapter pertama, bentuk UI preview/approval, atau apakah vertical
slice awal memakai checkpoint file yang sudah serializable sebelum PostgreSQL.
Tidak ada executor internal, `RunStore`, outbox, receipt, atau reconciler baru
yang dibuat. Research web yang sudah ada tetap opsional dan mati default;
pengembangan pagination, X/Threads, serta report research durable dibekukan.

## 3 Agustus 2026 — Hot reload development tidak lagi meninggalkan runtime lock

**Kenapa.** `npm run dev` memakai `tsx watch src/app.ts`; setelah dihentikan
dengan `Ctrl+C`, start berikutnya dapat gagal `LOCAL_DATA_LOCKED` walaupun PID
pemilik lock sudah mati. Mengganti development command menjadi proses langsung
memang menghindari perantara itu, tetapi mematikan hot reload dan ditolak
pemilik produk. Hot reload harus tetap ada sekaligus memberi aplikasi waktu
menjalankan shutdown normal.

**Yang berubah.** `npm run dev` sekarang menjalankan `scripts/dev-runner.ts`.
Runner tetap mengawasi `src/`, `.env`, `package.json`, dan `tsconfig.json`, lalu
meminta child shutdown melalui IPC dan menunggu child keluar sebelum reload.
`src/app.ts` menerima kontrol development terbatas `dev-restart|dev-stop` lewat
channel IPC yang hanya aktif bila runner memasang `HARVY_DEV_RUNNER=1`; jalur
itu memakai supervisor shutdown yang sama dengan `SIGINT`/`SIGTERM`, termasuk
drain, `shutdown_completed`, dan pelepasan runtime lock. Runner juga menangkap
`SIGINT`/`SIGTERM`, menunggu grace aplikasi, dan berhenti tanpa restart bila
batas shutdown terlewati. Kontrak command ditutup oleh test baru, sedangkan
test integrasi memakai child dengan lock eksklusif untuk membuktikan proses
baru tidak dimulai sebelum proses lama melepas lock. Petunjuk di `AGENTS.md`,
`README.md`, status engineering, dan runbook Console ikut diperbarui. Lock lama
milik PID 14460 dihapus hanya setelah proses pemiliknya dibuktikan sudah mati.

**Dibahas.** Sumber lokal `tsx` 4.23.1 menunjukkan watcher meneruskan signal
dengan `child.kill(signal)`. Probe proses lokal Windows membuktikan
`child.kill("SIGINT")` mengakhiri child tanpa menjalankan handler `SIGINT`-nya;
itulah yang melewati cleanup Harvy. Keputusan akhirnya bukan mematikan watcher
dan bukan menghapus lock stale otomatis, melainkan mengganti orkestrasi watcher
development dengan shutdown kooperatif. Lock akibat crash atau penghentian
paksa tetap sengaja fail-closed dan hanya boleh dihapus setelah PID diperiksa.

**Bukti.** `npm run check` PASS. Target terarah `npm run build` lalu
`node --test dist/tests/development-command.test.js
dist/tests/dev-runner.test.js dist/tests/local-runtime-lock.test.js` PASS — 4
test. Smoke aplikasi nyata dengan WhatsApp dan Console dimatikan mencapai
`application_ready`, menerima stop kooperatif dari runner, mencatat
`shutdown_completed`, keluar kode 0, tidak melaporkan `LOCAL_DATA_LOCKED`, dan
tidak menyisakan lock. `npm test` PASS — 580 test dalam 90 suite, tanpa gagal,
dibatalkan, dilewati, atau todo. Tekanan tombol `Ctrl+C` fisik tidak disintesis
oleh test otomatis Windows; handler signal runner memanggil jalur stop yang sama
yang dibuktikan oleh integrasi dan smoke.

**Sengaja ditinggalkan.** Tidak ada pemulihan lock crash otomatis dan tidak ada
restart setelah shutdown melewati batas 65 detik. Keduanya dipertahankan agar
runner tidak pernah menyalakan dua proses yang menulis data lokal bersamaan.

## 3 Agustus 2026 — Gerbang penuh diluluskan sebelum working tree didorong

**Kenapa.** Working tree berisi rangkaian perubahan Scope & Authority v1 dan
fitur pendukung yang perlu dikonsolidasikan ke `main` sesuai permintaan
pengguna. Sebelum commit, seluruh gerbang otomatis dijalankan ulang.

**Yang berubah.** `tests/message-batcher.test.ts` diperkeras agar tidak
bergantung pada deadline 200 milidetik saat seluruh suite berbagi event loop.
Test kini memberi ruang waktu yang menyerupai konfigurasi produksi, menunggu
evaluator melihat bubble lengkap, lalu memakai `drain` untuk memeriksa bahwa
tidak ada batch parsial yang lebih dulu dijawab. Kode produksi tidak berubah
karena kegagalan hanya berasal dari timing test.

**Dibahas.** Percobaan suite penuh pertama menghasilkan 577/578: tiga bubble
curhat ter-flush oleh deadline test sebelum bubble keempat masuk ketika event
loop sedang sibuk. Percobaan terarah setelah test diperbaiki lulus 22/22, dan
suite penuh berikutnya lulus tanpa mengubah kebijakan runtime.

**Bukti.** `npm run check` PASS. `npm run build && node --test
dist/tests/message-batcher.test.js` PASS — 22 test. `npm test` PASS — 578 test
dalam 88 suite, tanpa gagal, dibatalkan, dilewati, atau todo. Tidak ada model,
Telegram, WhatsApp, atau layanan eksternal yang dipanggil.

**Sengaja ditinggalkan.** Verifikasi end-to-end Telegram/WhatsApp dan smoke
provider nyata tetap belum dijalankan; sesi ini hanya memeriksa gerbang lokal
sebelum commit dan push.

## 3 Agustus 2026 — Scope & Authority v1 diselesaikan dan diperkeras

**Kenapa.** Setelah executor web baca-saja tersedia, Harvy belum boleh langsung
menambah X/Threads atau tindakan eksternal. Batas individu, grup, dan Workspace
harus menjadi authority kode lebih dulu; kalau tidak, checkpoint lama, role
admin basi, atau kesamaan identitas kanal dapat membuka data dan efek lintas
ruang. Gerbang Brave+Telegram nyata juga diperiksa lebih dulu agar status bukti
tidak disamakan dengan tes palsu.

**Yang berubah.** `WorkspaceScope` kini mengikat principal HMAC per kanal,
membership ID, role `owner/admin/editor/viewer`, permission tertutup, namespace
kanonik, dan `aclEpoch`. `WorkspaceAuthorityService` membentuk serta
merevalidasi scope, sementara `FileWorkspaceRepository` memakai compare-and-
swap sehingga dua service dengan epoch sama tidak dapat keduanya commit.
Harness menolak Workspace tanpa resolver tepercaya, namespace/permission yang
dipalsukan, serta freshness check yang gagal, timeout, batal, atau stale;
capability Workspace tetap unavailable pada surface pengguna dan disaring
menurut role.

Di grup, matriks authority tertutup menggantikan klaim `isAdmin` sebagai sumber
hak. Ingress WhatsApp membuktikan Harvy dan pengirim masih berada pada metadata
segar, menolak self-echo/nonmember, menunggu refresh berbatas untuk pesan yang
sama, lalu core merevalidasi lagi sebelum binding atau state ditulis. Event
membership menghapus cache, menaikkan epoch monoton, serta membatalkan batch,
pending, dan giliran lama pada call stack yang sama; completion refresh lama
tidak dapat memasangkan role lama dengan epoch baru. Semua mutator user-facing
di `GroupMemoryService` sekarang mewajibkan guard authority di dalam antrean
tepat sebelum commit.

Shared room memory `decision|agenda|norm|activity|note` hanya lahir dari usulan
eksplisit anggota, preview+ID persis, lalu konfirmasi admin terkini; retensinya
60 hari, maksimum 20, dan empat terbaru dapat masuk context tak tepercaya.
Reset admin menghapus state bersama tetapi bukan member-local memory. Adapter
file menghapus profil sosial, member-local memory, dan atribusi pengusul room
satu anggota dalam satu commit. Copy penghapusan tidak lagi mengaku atribusi
ledger teknis terhapus bila adapter menolak. Notice naik ke v7. Konstitusi
diperjelas sebagai v0.5 agar pemisahan member-local versus shared-room dan hak
reset admin tidak bertentangan dengan teks normatif lama; `ADR-016` mencatat
keputusan serta batasnya.

**Dibahas.** Fondasi ini sengaja belum menjadi fitur Workspace pengguna.
`WorkspaceScope` tanpa ingress, artifact store, dan PostgreSQL hanyalah kontrak
authority, bukan nilai jual yang sudah bisa dipakai. Untuk delivery grup,
rollback sudah pasti bagi record member/room yang baru dibuat; edit, delete,
reset, alias, dan penghapusan diri belum mempunyai transaksi kompensasi generik
bila acknowledgment gagal sesudah commit. Batas itu dicatat terbuka dan kelak
ditutup bersama outbox/receipt/reconciler, bukan disebut exactly-once.

**Bukti.** `npm run check` PASS. Gerbang terfokus PASS — **133 test dalam 11
suite** untuk harness, Workspace, authority grup, Baileys, repository file, dan
memori grup. `npm test` PASS — **578 test dalam 88 suite**, tanpa gagal,
cancelled, skipped, atau todo. `git diff --check` PASS; peringatan line-ending
Windows bukan whitespace error. Pemeriksaan konfigurasi lokal tanpa membuka
secret menemukan token Telegram tersedia, tetapi `WEB_SEARCH_ENABLED` dan
`WEB_OPEN_ENABLED` tidak ada serta `WEB_SEARCH_API_KEY` kosong. Karena itu
smoke Brave+Telegram, consent v4, hasil kosong, kegagalan executor, dan isolasi
konteks **NOT RUN**; tidak ada request eksternal yang dilakukan dan tidak ada
secret/config yang dikarang.

**Sengaja ditinggalkan.** Ingress/UI Workspace, account linking, artifact ACL,
PostgreSQL durable `RunStore`, progress/cancellation lintas restart, report
bersitasi, native tool calling, pagination, grounding per klaim, keragaman
sumber, X/Threads, outbox, receipt, dan reconciler tetap tahap berikutnya.
Authority epoch serta pending grup masih in-memory lintas restart, adapter file
hanya aman satu proses, dan notice v7/shared-room behavior belum diuji di grup
WhatsApp nyata.

## 2 Agustus 2026 — Tahap setelah executor web dipilih

**Dibahas.** Sebelum menambah arsitektur, vertical slice `web.search`/
`web.open` yang baru selesai perlu melewati smoke terkontrol dengan provider dan
Telegram nyata: consent v4, satu alur search→open→jawaban bersumber, hasil kosong,
kegagalan executor, serta pembatalan/isolasi konteks. Ini adalah gerbang bukti,
bukan fitur baru; statusnya tetap “belum terbukti end-to-end” sampai dijalankan.

Milestone kode berikut yang direkomendasikan adalah **Scope & Authority v1**,
bukan langsung X/Threads atau external write. Matriks otoritas grup perlu
dibekukan, shared room memory dan room social profile harus terlihat serta dapat
direset, lalu `WorkspaceScope` dibentuk dari ingress/membership tepercaya dengan
principal, role, ACL, dan `aclEpoch`. Urutan ini menjaga Harvy pribadi, grup 1,
grup 2, dan workspace tetap benar-benar terpisah sebelum checkpoint maupun
artifact dapat hidup lintas giliran dan restart.

Sesudah batas ruang itu teruji, tahapnya adalah PostgreSQL `RunStore` dan state
machine durable untuk research baca-saja: progress, resume setelah crash,
cancellation lifecycle, lease, dan artifact report bersitasi. Berikutnya baru
native/canonical tool calling, pagination, grounding per klaim, evaluasi
keragaman sumber, dan konektor X/Threads. External write tetap paling akhir dan
memerlukan approval terikat nilai, outbox, receipt, reconciler, serta outcome
`unknown` yang eksplisit.

**Bukti.** Rekomendasi dibuat setelah membaca ulang `PROJECT.md`, Konstitusi
v0.4, `engineering/STATUS.md`, entri LOG terbaru, `ADR-015`, dan urutan
pembangunan pada `AGENT_ENGINEERING_RESEARCH.md`. STATUS mencatat executor web
sudah teruji otomatis tetapi belum diuji provider/Telegram nyata, sedangkan
`WorkspaceScope`, durable run store, X/Threads, outbox, receipt, dan reconciler
belum ada. Tidak ada tes atau integrasi eksternal yang dijalankan karena sesi
ini hanya menentukan langkah berikut.

**Sengaja ditinggalkan.** Tidak ada kode produk yang diubah. Smoke eksternal,
Scope & Authority v1, durable research, X/Threads, dan tindakan eksternal belum
dikerjakan pada sesi ini.

## 2 Agustus 2026 — Episodic compaction v2 dan executor web baca-saja selesai

**Kenapa.** Pemilik produk memilih dua tahap berikut setelah baseline context
manifest: mengganti rolling summary yang mudah drift dengan structured episodic
compaction, lalu memberi Harvy nilai agent pertama melalui research
`web.search`/`web.open` yang hanya membaca. Implementasi harus tetap menjaga
isolasi privat, persetujuan, batas egress, dan kejujuran ketika tool belum
berhasil.

**Yang berubah.** History schema v2 memberi sequence monoton pada giliran,
menyimpan episode sembilan kategori dengan source range/hash yang dibuat kode,
dan memigrasikan summary v1 menjadi `legacy-summary` tanpa provenance palsu.
Parser model serta repository memakai schema tertutup, batas klaim/turn/episode,
rentang kontigu, coverage/source hash, dan generation guard. Compaction berjalan
di latar dalam chunk maksimal 12 giliran/12.000 karakter, melepaskan dua slot
global antar-pass, mengejar backlog yang masih di atas 16 giliran, menahan retry
satu menit, dan berhenti sebelum queued call memakai model bila izin ditarik.
Renderer memprioritaskan koreksi dan hal belum selesai; context compiler memakai
sisa anggaran untuk potongan episode alih-alih membuang summary seluruhnya.
Delimiter dari pesan, memori, ringkasan, sesi, insight, observation, dan sumber
compaction di-escape sebelum ditempatkan di envelope prompt.

Capability `web.search` v1 dan `web.open` v1 kini dinamis pada privat Telegram.
Search memakai endpoint Brave tetap dan credential header; open hanya GET teks
publik dengan pemeriksaan semua A/AAAA, IP pinning, validasi ulang redirect,
batas ukuran/type/waktu, sanitasi HTML, serta blok alamat khusus IPv4/IPv6.
Loop research memakai harness yang sudah ada, maksimal enam langkah/45 detik,
satu search per run, dan open hanya ke URL dari pesan pengguna atau search
sukses run yang sama. Context percakapan/memori lama tidak diberikan ke planner.
Final tanpa observation sukses, URL karangan, atau domain polos yang tidak
teramati ditahan; normalisasi Telegram tidak lagi mengubah underscore URL.
Consent privat naik ke versi 4 untuk menjelaskan provider pencarian terpisah,
pengambilan URL oleh server Harvy, dan isolation context research. `ADR-014`,
`ADR-015`, STATUS, PROJECT, README, TESTING, AGENTS, serta dokumen riset
diselaraskan.

**Dibahas.** Sequence/hash adalah receipt concurrency dan coverage, bukan bukti
bahwa makna ringkasan didukung sumber setelah raw source dibuang. Vertical slice
web ini adalah executor sungguhan tetapi belum agent workspace durable: native
provider tool calling, `RunStore`, artifact report, lifecycle cancellation dari
command/generation luar, grounding per klaim, X/Threads, outbox, receipt, dan
reconciler tetap tahap berikutnya. Pembatas satu search dan penghilangan context
lama dipilih sebagai pagar konkret terhadap indirect prompt injection pada
slice pertama, bukan sebagai desain research final.

**Bukti.** `npm run check` PASS. Tes terarah compaction, repository, context,
conversation, consent, message normalization, research, dan web reader PASS;
`npm test` final PASS **554 test dalam 85 suite**, 0 gagal. Regresi mencakup
backlog/chunk, perubahan source dan coverage saat model bekerja, queued
compaction setelah izin ditarik, migrasi summary v1 panjang, schema/gap/retensi,
delimiter injection, isolation context privat, final tanpa observation, domain
dan URL karangan, pembatas satu search, allowlist open, DNS abort, special IP,
redirect privat, dan URL underscore. Tidak ada panggilan model eksternal,
credential Brave, Telegram nyata, X, Threads, atau data pengguna yang dipakai.
Kontrak search dan egress diperiksa terhadap dokumentasi resmi Brave, registry
alamat khusus IANA, dan panduan SSRF OWASP yang dirujuk di `ADR-015`.

**Sengaja ditinggalkan.** Provider/Telegram smoke dengan consent v4, evaluasi
groundedness/recall episode pada model nyata, tokenizer dan route budget,
durable/background research, artifact workspace, native tool calling,
X/Threads, cancellation lifecycle luar, serta seluruh external write menunggu
`RunStore`/outbox/receipt/reconciler.

## 2 Agustus 2026 — Gap menuju agent nyata dipetakan ulang

**Dibahas.** Pemilik produk meminta daftar yang belum dibuat setelah baseline
context manifest dan kalibrasi usage selesai. Keadaan repo membedakan dua kelas:
kemampuan yang benar-benar belum ada dan kemampuan yang sudah ada di kode tetapi
belum terbukti end-to-end. Harvy sekarang mempunyai percakapan, tugas, memori,
sesi, keselamatan, grup WhatsApp beta, capability catalog, dan kernel loop
berbatas; ia belum menjadi agent research/workspace yang dapat memakai alat.

Gap inti agent adalah protocol tool-calling pada `AiClient`, executor konkret,
`web.search`/`web.open`, konektor X/Threads, durable run/checkpoint store,
outbox/receipt/reconciler, serta approval UX tindakan eksternal. Gap konteks
adalah tokenizer/faktor kalibrasi dan budget per model/route, structured
episodic compaction v2, retensi/provenance episode, WorkspaceScope+ACL, account
linking, dan shared room semantic memory. Gap produksi meliputi PostgreSQL,
migrasi, multi-process safety, auth Baileys terenkripsi, collector/dashboard/
alert, backup/deployment, kanal Telegram grup/WhatsApp privat/Harvy Web, serta
payment/subscription. Uji tujuh hari, wawancara pelajar, dan banyak alur kanal
nyata juga belum selesai; itu status “belum terbukti”, bukan “belum ditulis”.

**Bukti.** `STATUS.md` masih menandai capability agent sebagai fondasi tanpa
tool eksternal. Pemeriksaan kode menemukan `web.search` dan `external.act`
hanya sebagai capability `installed: false`; composition root membuat
`AgentHarness` tanpa executor. `AiClient` tidak mempunyai `tools`/`tool_choice`,
`AgentScope` hanya private/group, dan dependency PostgreSQL tidak ada. Tidak ada
tes atau model eksternal yang dijalankan karena sesi ini hanya memetakan status.

**Sengaja ditinggalkan.** Tidak ada kode produk atau keputusan urutan baru yang
dibuat pada sesi pemetaan ini. Prioritas implementasi tetap perlu dipilih
berdasarkan nilai pengguna: research web baca-saja adalah vertical slice nilai
terdekat; external write baru aman setelah durable run dan rekonsiliasi.

## 2 Agustus 2026 — Manifest grup dan dataset kalibrasi usage disambungkan

**Kenapa.** Baseline manifest sebelumnya hanya menjelaskan konteks percakapan
privat dan estimator `/4` belum dapat dibandingkan secara konsisten dengan
usage provider. Sebelum mengubah kebijakan pemadatan, route grup perlu memiliki
ukuran setara dan angka estimasi perlu bertipe stabil serta dapat diaudit per
model/route tanpa merekam isi chat.

**Yang berubah.** Planner ambient, revalidasi kandidat, dan reply grup kini
mengompilasi selection lama menjadi `ContextManifest` v1 lokal. Selection
prompt tidak diubah: paling banyak 18 giliran, pagar akumulasi 12.000 karakter
yang tetap mempertahankan giliran terbaru, dan 8 memori anggota lokal dengan
sanitasi/clipping 400 karakter. Manifest mencatat jumlah sumber/terpilih/
terpotong/terbuang secara transient; log
persisten tetap hanya menerima metrik kapasitas agregat dan tidak menerima isi,
nama, ID, maupun struktur giliran/memori.

`createContextManifest` menjadi satu pembentuk counter privat dan grup.
`AiClient` memisahkan benturan nama lama: `inputTokenEstimate` selalu angka
preflight, sedangkan `tokenUsageEstimated` selalu boolean kualitas usage. Bila
provider mengirim usage aktual, log completion menambah
`inputTokenEstimateErrorTokens` (estimasi dikurangi aktual) dan
`inputTokenEstimateRatioPermille` (1.000 berarti tepat, di bawahnya
under-estimate). Respons yang usage-nya hanya perkiraan tidak menghasilkan
rasio kalibrasi. Label operasi lokal `group-plan-ambient`,
`group-revalidate-ambient`, dan `group-reply` membedakan route tanpa mengubah
purpose billing dan tidak ikut body provider. Bersama tier, model, dan origin,
angka dapat diagregasi tanpa identifier pengguna atau isi percakapan.

**Dibahas.** Data kalibrasi ini belum mengubah estimator ataupun selection.
Menerapkan faktor otomatis sebelum sampel cukup akan membuat budget berayun dan
dapat berbeda diam-diam antarprovider. Langkah berikutnya tetap menetapkan
agregasi robust per model/route dan batas konservatif, lalu baru structured
episodic compaction v2.

**Bukti.** `npm run check` PASS. Build dan empat berkas tes terarah awal
(`client`, `group-conversation`, `harness-context-budget`, dan
`operational-logger`) PASS **44/44**; sesudah label operasi ditambahkan, tiga
berkas yang terdampak PASS **40/40**. `npm test` final PASS **500 test dalam 77
suite**, 0 gagal. Regresi membuktikan tiga request grup membawa manifest,
counter drop/clipping benar, isi memori tidak masuk manifest, metadata lokal
tidak ikut body provider, field kalibrasi bertipe stabil, dan rasio hanya dibuat
dari usage aktual. Tidak ada model eksternal, Telegram, WhatsApp, atau data
pengguna yang dipakai.

**Sengaja ditinggalkan.** Tokenizer/count-token provider, estimator adaptif,
agregator/window sampel kalibrasi, budget token per model/route, soft threshold,
structured episodic compaction v2, tool schema reservation, executor, durable
run, outbox, dan reconciler belum dibuat. Pekerjaan ini tidak menambah kemampuan
pengguna atau mengubah isi balasan.

## 2 Agustus 2026 — Context manifest privat menjadi baseline observability

**Kenapa.** Setelah rancangan context/harness/loop/graph disepakati untuk mulai
dikerjakan, vertical slice pertama dipilih berupa instrumentasi token dan
context manifest. Tujuannya memperoleh ukuran nyata sebelum mengubah kebijakan
pemadatan, tanpa menggeser balasan pengguna atau menganggap estimator sebagai
tokenizer yang pasti.

**Yang berubah.** `src/harness/context-manifest.ts` menambahkan schema v1 bebas
isi: versi, basis budget, metode estimasi bernama, batas karakter/jumlah,
karakter sumber/terpilih, estimasi token, utilisasi, serta jumlah bagian
source/eligible/included/clipped/dropped. `compileHarvyContext` di
`context-budget.ts` menghasilkan konteks dan manifest dalam satu selection;
`fitHarvyContext` tetap menjadi wrapper kompatibel sehingga hasil lama tidak
berubah. Proyeksi `turns-only` membuat triase dan review hanya menganggap
giliran sebagai bagian eligible, sedangkan understanding, reply, dan sesi
memakai proyeksi penuh.

`ChatRequest` membawa manifest sebagai metadata lokal. `AiClient` memasukkan
counter kapasitas agregat ke log operasional, tetapi body provider tetap hanya
membawa kontrak chat completion. Detail jumlah giliran/memori, karakter sumber,
dan status summary tetap transient meski bebas isi; allowlist persisten hanya
menyimpan versi/metode, konfigurasi budget, karakter terpilih, estimasi token,
dan utilisasi. Tidak ada prompt, teks, ID, summary, atau isi memori pada
manifest. Dokumentasi STATUS, TESTING, dan draf riset sementara diselaraskan.

**Dibahas.** Estimator `characters_div_4_v1` sengaja diberi nama agar tidak
disangka usage provider atau tokenizer akurat. Ia hanya baseline observability;
selection dan compaction masih memakai karakter/jumlah. Manifest juga belum
menentukan ambang 60/75/90 persen, belum mereservasi tool/observation growth,
dan belum mengkalibrasi estimate terhadap usage aktual. Memisahkan compiler
dari policy memungkinkan data dikumpulkan tanpa diam-diam mengubah konteks
yang dibaca model.

**Bukti.** `npm run check` PASS. Build dan empat berkas tes terarah PASS **60/60**:
`client`, `conversation`, `harness-context-budget`, dan `operational-logger`.
`npm test` resmi kemudian PASS **499 test dalam 77 suite**, 0 gagal. Tes baru
membuktikan selection baru ekuivalen dengan wrapper lama, manifest tidak
membawa isi, proyeksi triase tidak menganggap summary/memori eligible, metadata
tidak masuk body provider, dan sanitizer hanya mempertahankan counter kapasitas
agregat.

Percobaan gerbang pertama melewati timeout alat lima menit dan proses runner
yatim dihentikan setelah command line-nya dipastikan milik sesi ini. Diagnosis
empat shard paralel sengaja memberi tekanan berlebih dan satu kali memicu test
timing `message-batcher`; test itu lulus **22/22** ketika dijalankan sendiri dan
ikut lulus pada `npm test` resmi tanpa stress tambahan. Tidak ada model
eksternal, Telegram, WhatsApp, atau data pengguna yang dipakai.

**Sengaja ditinggalkan.** Context manifest grup, tokenizer/count-token provider,
kalibrasi estimator, route/model-specific token budget, soft threshold,
structured episodic compaction v2, dan keputusan retensi episode belum dibuat.
Tidak ada tool eksternal, executor, durable run, atau capability pengguna baru
yang diaktifkan oleh pekerjaan ini.

## 2 Agustus 2026 — Riset arsitektur agent sosial dan context engineering ditulis

**Kenapa.** Pemilik produk meminta hasil pembelajaran tentang context,
harness, loop, dan graph engineering, Codex, Claude Code, serta prinsip Andrej
Karpathy disimpan sementara di `docs/` agar tidak hilang. Ia juga mengusulkan
pemadatan percakapan berbasis token dan Harvy yang mempunyai kesinambungan
sosial berbeda untuk setiap individu serta grup.

**Yang berubah.** Ditambahkan draf non-normatif
`docs/research/AGENT_ENGINEERING_RESEARCH.md` dan tautannya di `docs/INDEX.md`.
Dokumen itu mencatat status kemampuan yang sudah ada, pemisahan context/memori/
checkpoint/artifact, context budget token-aware, structured episodic
compaction, scope lattice privat/workspace/grup/anggota, room social profile
yang terlihat dan berjendela, harness serta durable state machine, outbox dan
rekonsiliasi, pelajaran Codex/Claude Code/Karpathy, failure modes, eval, urutan
pembangunan, sumber primer, dan pertanyaan keputusan pemilik produk.

Dokumen ditandai sementara dan tidak boleh menjadi sumber klaim kemampuan. Ia
baru dihapus setelah keputusan yang diterima dipromosikan ke dokumen normatif,
vertical slice serta acceptance criteria tersedia, dan temuan evaluasinya
tidak hanya hidup di draf tersebut. Penghapusannya kelak wajib dicatat lagi di
`LOG.md`.

**Dibahas.** Intuisi mempertahankan percakapan sampai anggaran token tertentu
dinilai benar dengan koreksi: konteks aktif bukan memori, pemadatan harus
proaktif/asinkron/route-aware, dan state tindakan tidak boleh diringkas menjadi
prosa. Harvy boleh terasa berbeda melalui alias, panjang jawaban, formalitas,
timing, norma partisipasi, agenda, dan keputusan lokal; identitas inti,
keselamatan, kejujuran, serta hak data tetap sama. Adaptasi sosial dibagi
menjadi recent ephemeral context, memori ruang yang dapat dilihat/reset, dan
perbaikan policy global secara offline dari eval berizin—bukan online
self-training tersembunyi dari chat produksi.

Review akhir memperketat bahwa ACL Workspace tidak dapat membuka data grup,
`WorkspaceScope` harus membawa membership/role/ACL epoch tepercaya, private
memory tidak berpindah lewat kemiripan identitas, dan pemakaian pesan produksi
untuk evaluasi memerlukan opt-in terpisah setiap peserta. Observasi sosial wajib
kedaluwarsa; pengelola ruang tidak menguasai data individual. State graph juga
ditambah jalur cancel, expiry, lease recovery, dead-letter, serta capability
gate bagi provider yang outcome tindakannya tidak dapat direkonsiliasi.

Harness diperlakukan sebagai authority kode di sekitar model, loop sebagai
pengendali berbatas, dan graph sebagai state machine yang dapat dipulihkan.
Rekomendasi awal tetap mempertahankan fast path bagi percakapan serta workflow
deterministik, sementara research dan pekerjaan lintas aplikasi memakai
durable run. Harvy belum memerlukan penggantian fondasi dengan framework agent
baru; `AgentHarness` yang ada lebih dulu perlu disambungkan ke token-aware
context compiler, PostgreSQL run store, executor, outbox, dan reconciler.

**Bukti.** Fondasi riwayat, context budget, scope, `AgentHarness`, memori grup,
dan percakapan grup diperiksa langsung dari kode, `ADR-011`, `ADR-012`, serta
`engineering/STATUS.md`. Tiga jalur riset read-only memeriksa konteks/memori,
harness/loop/graph/durable execution, serta Claude Code/Karpathy; penulis utama
memeriksa manual Codex resmi dan sumber primer Anthropic, OpenAI, LangGraph,
Temporal, ACL Anthology, makalah long-context, presentasi Karpathy, dan
repository `autoresearch`. Tidak ada kode produk, model Harvy, Telegram,
WhatsApp, atau tes otomatis yang dijalankan karena perubahan hanya menambah
dokumen riset.
Dua review read-only terpisah memeriksa arsitektur durable serta batas sosial,
privasi, dan agensi; penulis utama menerapkan koreksinya.

**Sengaja ditinggalkan.** Retensi tiap kelas data, ambang token per route,
schema database final, pilihan state machine sendiri versus LangGraph/Temporal,
otoritas konfigurasi sosial grup, bentuk UI kontrol, hubungan Workspace dengan
banyak grup, serta rancangan uji manusia belum diputuskan. Tidak ada capability
baru yang diaktifkan.

## 2 Agustus 2026 — Research Workspace lintas web, X, dan Threads dirancang

**Kenapa.** Pemilik produk mengusulkan nilai guna agent yang lebih konkret:
Harvy membantu individu dan grup melakukan riset dari web serta percakapan
publik di X, Threads, dan sumber lain, tetap cepat ketika membalas chat, lalu
dapat melanjutkan hasil riset menjadi tindakan.

**Dibahas.** Arah produk yang disarankan adalah `Research Workspace`, bukan
browser atau scraper umum. Permintaan langsung membuat run riset berscope
workspace; Harvy segera mengakui pekerjaan, mencari sumber di latar melalui
tool baca yang terbatas, menormalkan dan mendeduplikasi hasil, memisahkan fakta
resmi dari sinyal/opini sosial, lalu menghasilkan laporan bersitasi. Percakapan
biasa tetap melalui jalur cepat tanpa agent loop. Riset singkat boleh selesai
sinkron bila masih dalam batas waktu, sedangkan riset panjang menjadi durable
run yang dapat dilanjutkan setelah restart. Ambient hanya boleh menawarkan
riset, bukan menghabiskan kuota tanpa permintaan atau izin workspace.

Tool awal dipisahkan menurut kapabilitas dan sumber, misalnya
`research.web.search`, `research.web.open`, `research.x.search_recent`,
`research.x.search_archive`, dan `research.threads.keyword_search`; tidak ada
tool generik yang bebas melakukan aksi eksternal. Semua hasil dipetakan ke
`SourceRecord` kanonik yang membawa platform, ID eksternal, permalink,
penulis publik, waktu terbit dan pengambilan, cuplikan minimum, kueri asal,
serta provenance. Penyimpanan penuh konten sosial tanpa batas dihindari;
retensi, tampilan, ekspor, dan penghapusan harus mengikuti ketentuan platform
dan hak anggota workspace.

Urutan vertical slice yang disarankan: (1) scope/ACL Workspace dan kontrak
laporan; (2) penyimpanan Postgres untuk durable run, step, lease, dan sumber;
(3) executor tool baca web beserta sitasi; (4) connector X recent search dan
Threads keyword search setelah aplikasi/izin tersedia; (5) anggaran, cache,
cancel, retry, status/progress, dan evaluasi kualitas; (6) monitoring terjadwal
yang opt-in; lalu (7) aksi tulis seperti membuat task, polling, atau kalender
melalui approval, outbox, receipt, dan reconciler. Dengan demikian nilai riset
dapat diuji sebelum Harvy diberi wewenang tindakan eksternal yang lebih besar.

X dan Threads diperlakukan sebagai sumber percakapan publik, bukan sumber
kebenaran. Klaim faktual harus diperiksa ke sumber primer ketika tersedia dan
laporan harus menandai hal yang hanya menggambarkan opini/tren. Workspace tidak
boleh dipakai untuk pengawasan anggota, penyusunan profil psikologis/politik,
pengambilan data privat, atau penilaian individu. Administrator boleh mengatur
sumber, batas biaya, retensi, dan konektor, tetapi tidak mendapat akses ke chat
pribadi anggota.

**Bukti.** Status dan arsitektur yang ada diperiksa kembali dari
`docs/engineering/STATUS.md` dan kode harness yang sebelumnya diperiksa dalam
sesi ini: kernel `AgentHarness` ada, tetapi belum terhubung ke runtime produksi
dan belum memiliki executor eksternal, durable checkpoint, outbox, atau
reconciler. Dokumentasi resmi X yang diperiksa menyatakan recent search
mencakup tujuh hari terakhir, full-archive adalah akses berbayar/Enterprise,
dan API saat ini memakai harga berbasis pemakaian. Dokumentasi resmi Threads
yang diperbarui 21 Januari 2026 menyatakan endpoint `/keyword_search`
mendukung hasil `TOP`/`RECENT`, rentang waktu, filter tipe media, maksimum 100
hasil, memerlukan `threads_basic` dan `threads_keyword_search`, serta membatasi
2.200 kueri per pengguna dalam 24 jam bergulir. Tidak ada kode produk atau tes
yang dijalankan karena sesi ini hanya membahas rancangan.

**Sengaja ditinggalkan.** Provider web search, bentuk schema database final,
model harga Workspace, batas hasil per run, kebijakan retensi per platform,
UX laporan/progress, serta siapa yang boleh memulai riset berbiaya di ruang
grup belum diputuskan atau diterapkan.

## 2 Agustus 2026 — Peran agent Harvy untuk individu dan grup dirumuskan

**Kenapa.** Sebelum membangun tool calling, executor, durable run, outbox, dan
rekonsiliasi, pemilik produk meminta tujuan nyata agent bagi pengguna individu
dan grup diperjelas agar infrastruktur tidak dibangun tanpa nilai produk.

**Dibahas.** Agent tidak menggantikan seluruh Harvy. Percakapan biasa,
tutoring, curhat, keselamatan, kontrol data, serta pencatatan tugas sederhana
tetap memakai workflow deterministik. Agent hanya dibuka ketika hasil yang
diminta membutuhkan beberapa langkah, alat atau informasi eksternal,
pause/resume, persetujuan, dan verifikasi outcome. Pola bersama yang dipilih
sebagai arah diskusi adalah `pahami tujuan → cari/siapkan → tampilkan proposal
→ minta izin → bertindak → pastikan hasil`.

Untuk individu, peran utamanya adalah mengubah niat menjadi tindakan pribadi
yang terverifikasi. Kandidat flagship: Harvy mencari informasi sekolah resmi
beserta sumber, mengubahnya menjadi checklist/rencana minggu, lalu setelah
pengguna menyetujui menyimpan tugas, pengingat, atau acara kalender. Use case
lainnya adalah riset belajar bersumber, pengelolaan proyek lintas hari, dan
menyiapkan draf komunikasi yang baru dikirim setelah approval. Nilai jualnya
bukan model yang sekadar menjawab, melainkan pekerjaan administratif sekolah
yang selesai tanpa mengambil keputusan dari pengguna.

Untuk grup, peran utamanya adalah mengubah percakapan bersama menjadi
koordinasi yang disetujui tanpa menjadikan Harvy ketua atau pengawas. Kandidat
flagship: setelah diminta langsung, Harvy merangkum keputusan live, menyusun
daftar tindak lanjut, membuat polling waktu, mengusulkan jadwal, lalu membuat
acara/tugas/pengingat grup setelah otoritas yang benar menyetujui. Harvy juga
dapat mencari sumber untuk pertanyaan grup dan menjaga shared room memory
tentang keputusan/kegiatan ketika kemampuan itu sudah dibangun. Ambient hanya
boleh menawarkan proposal; ia tidak boleh memulai mutasi atau menghubungi
anggota secara pribadi.

Otoritas grup harus dibedakan per dampak. Tindakan pada kalender atau data
pribadi memerlukan approval anggota yang terdampak; tindakan pada ruang grup
memerlukan admin atau koordinator yang memang berwenang; penugasan kepada
anggota tidak dianggap diterima sebelum anggota itu memilihnya. Pembayar
Workspace tidak memperoleh hak membaca chat pribadi atau menyetujui tindakan
atas nama seluruh anggota. Semua tindakan membawa audit siapa meminta, siapa
menyetujui, scope, input persis, dan hasilnya.

Urutan produk yang disarankan adalah: pertama agent individu untuk
`web search → sumber → task/reminder` karena kemampuan tugas sudah hidup;
berikutnya agent grup direct untuk `keputusan → polling/tindak lanjut`; sesudah
shared room memory dan uji grup nyata barulah ambient menawarkan koordinasi.
Kalender eksternal, pengiriman pesan, atau tindakan lintas aplikasi menyusul
setelah connector dan rekonsiliasinya terbukti. Agent tidak dipakai untuk
diagnosis, hukuman/moderasi otomatis, pembelian, pendaftaran yang berdampak
besar, DM proaktif, pengawasan anggota, atau tindakan keselamatan otonom.

**Bukti.** Arah ini diperiksa terhadap masalah pengguna di `PROJECT.md`, hak
dan batas tindakan Konstitusi v0.4, kemampuan nyata serta keterbatasan grup di
`STATUS.md`, capability catalog, dan keputusan agent pada `ADR-012`. Tidak ada
tes, model eksternal, kanal nyata, atau perubahan kode yang dijalankan karena
sesi ini hanya membahas tujuan produk.

**Sengaja ditinggalkan.** Belum dipilih nama fitur, connector kalender/polling,
aturan admin/koordinator final, bentuk shared task, masa retensi run, atau
vertical slice yang akan diimplementasikan. Tidak ada capability yang
diaktifkan.

## 2 Agustus 2026 — Arsitektur agent nyata Harvy dibahas

**Kenapa.** Pemilik produk ingin membahas lima bagian yang diperlukan agar
Harvy menjadi agent nyata: tool calling, executor, durable run, outbox, dan
rekonsiliasi tindakan.

**Dibahas.** Fondasi kernel sebenarnya sudah ada dan cukup ketat:
`AgentHarness` menerima keputusan `final|need_input|action`, memvalidasi
capability serta input, mengikat approval pada nilai tervalidasi, memberi
idempotency key, membatasi langkah/deadline/siklus, dan memeriksa cancellation
serta generation. Namun runtime hanya memakai capability snapshot sebagai
konteks prompt. Tidak ada pemanggilan `AgentHarness.run()` di kode produksi,
tidak ada executor produksi, `AiClient` masih hanya mengirim pesan teks tanpa
`tools`/`tool_choice`, checkpoint belum disimpan, dan belum ada dispatcher
outbox atau reconciler.

Arsitektur yang disarankan mempertahankan satu bentuk tool call kanonik di
lapisan Harvy. Adapter model boleh menerjemahkan native provider tool call atau
keluaran JSON terstruktur ke bentuk itu, tetapi model tidak pernah memegang
kredensial atau menjalankan efek. Capability generik `external.act` tidak layak
menjadi tool nyata; setiap executor harus sempit dan berversi, misalnya
`web.search`, `web.open`, `task.create`, `calendar.event.create`, atau
`message.send`. Tool yang tersedia saja yang dikirim ke model, mutasi berjalan
serial lebih dulu, dan safety/consent/penghapusan tetap workflow deterministik.

Durabilitas memerlukan PostgreSQL sebelum mutasi eksternal dipercaya. Store
minimum memisahkan `agent_runs`, `agent_actions`, approval/input tertunda,
`agent_outbox`, dan bila ada webhook `agent_inbox`. Run menyimpan checkpoint,
scope, capability hash, generation pengguna, status, versi optimistic lock,
lease worker, expiry, dan hasil. Action menyimpan input tervalidasi, digest,
idempotency key, status eksekusi, attempt, receipt provider, serta outcome aman.
Saat approval diberikan, transaksi yang sama menandai action terotorisasi dan
menulis command outbox; tidak ada network call di dalam transaksi database.

Dispatcher mengambil outbox dengan lease, memeriksa ulang cancellation,
generation, approval, capability, serta policy, lalu memanggil executor.
Hasil pasti `succeeded` atau `failed` dapat melanjutkan planner. Timeout,
koneksi putus setelah request terkirim, crash, atau respons ambigu harus menjadi
`unknown`, menghentikan mutasi berikutnya, dan membuat pekerjaan rekonsiliasi—
bukan retry otomatis. Reconciler menanyakan outcome memakai idempotency key atau
receipt provider: bila ditemukan, ia menyelesaikan action; bila terbukti belum
terjadi dan provider menjamin pemeriksaannya, action boleh diantrekan ulang;
bila tetap tidak pasti, Harvy harus memberitahu pengguna atau operator dan tidak
mengarang hasil. Connector yang tidak menyediakan idempotency atau lookup tidak
boleh menjanjikan exactly-once.

Checkpoint durable mengandung kata pengguna, input tindakan, dan observation,
sehingga ia adalah data pribadi: wajib masuk retensi, ekspor, penghapusan, dan
generation guard. Approval perlu menampilkan preview manusia yang persis—target,
waktu, tujuan, serta konsekuensi—sementara binding hash tetap bekerja di balik
layar. Penghapusan data harus lebih dulu membatalkan run dan outbox baru;
tindakan eksternal yang sudah berhasil tidak selalu dapat dibatalkan dan harus
dijelaskan jujur.

Vertical slice yang disarankan dimulai dari `web.search`/`web.open` baca-saja,
lalu satu executor lokal idempoten seperti `task.create` atau
`reminder.schedule`. Itu membuktikan loop, schema tool, observation, approval,
pause/resume, dan crash recovery sebelum Harvy diberi kemampuan mengubah
kalender atau mengirim pesan eksternal. Mutasi eksternal pertama hanya dipilih
setelah connector tertentu membuktikan idempotency serta API rekonsiliasinya;
infrastruktur generik tanpa workflow pengguna tidak dianggap nilai produk.

**Bukti.** `ADR-012`, seluruh `src/harness/agent-harness.ts`, capability
catalog, kontrak dan body request `AiClient`, pemakaian harness di runtime,
status kemampuan, serta pola antrean settlement usage yang sudah ada diperiksa.
Tidak ada tes, model eksternal, kanal nyata, atau perubahan kode yang dijalankan
karena sesi ini hanya membahas arsitektur.

**Sengaja ditinggalkan.** Belum diputuskan vertical slice pertama, provider
tool-calling, schema PostgreSQL final, masa retensi run, strategi worker,
connector eksternal pertama, maupun kontrak reconciliation per provider. Tidak
ada capability yang diaktifkan atau executor yang dibuat.

## 2 Agustus 2026 — Kesenjangan kegunaan dan nilai jual Harvy dipetakan

**Kenapa.** Pemilik produk menilai Harvy belum berguna dan belum mempunyai
sesuatu yang layak ditawarkan atau dijual, lalu meminta pemetaan kemampuan yang
belum diterapkan serta rancangan fitur yang belum dibuat.

**Dibahas.** Penilaian itu benar pada tingkat produk, tetapi bukan karena Harvy
tidak mempunyai kode atau kemampuan sama sekali. Chat privat Telegram sudah
mempunyai tugas, prioritas, pengingat, memori, sesi langkah kecil, tutoring,
check-in, keselamatan, dan kontrol data; fondasi grup WhatsApp, Console, ledger,
paket, serta harness agent juga luas. Kesenjangan utamanya adalah urutan
pembangunan: fondasi operasi dan monetisasi berkembang jauh sebelum manfaat
utama dibuktikan. Dogfood tujuh hari, uji ulang Telegram setelah perubahan
besar, wawancara pelajar, pengukuran keberhasilan Pasal 8, dan kemauan membayar
belum selesai. Akibatnya Harvy mempunyai banyak komponen tetapi belum mempunyai
satu hasil pengguna yang terbukti, mudah dijelaskan, dan layak dibayar.

Kesenjangan kemampuan pengguna yang paling material adalah ketiadaan pencarian
web/RAG dan sumber, pemrosesan lampiran/file/gambar, kalkulator atau eksekusi
terverifikasi, konektor kalender/email/aplikasi, tool calling serta executor,
Harvy Web, account linking, Telegram grup, WhatsApp privat, dan shared room
semantic memory. Kesenjangan komersial serta produksi mencakup checkout,
subscription, renewal, invoice, refund, webhook, pajak, payment ledger,
PostgreSQL, deployment/backup, observabilitas terpusat, auth Baileys terenkripsi,
serta operasi multi-instance.

Arah penawaran yang disarankan untuk dibuktikan lebih dulu bukan “AI pendamping
serba bisa”, melainkan satu hasil sempit: membantu pelajar yang tugasnya
tersebar mengubah cerita berantakan menjadi rencana satu minggu, memilih satu
langkah berikutnya, memasang pengingat, dan menindaklanjutinya hanya dengan
izin. Fondasi untuk alur itu sebagian besar sudah ada; yang belum ada adalah
bukti bahwa alurnya bekerja berulang kali dan cukup bernilai. Saran urutannya:
bekukan fitur platform baru, dogfood alur tersebut tujuh hari, uji dengan
kelompok kecil pelajar selama dua minggu, ukur tugas tertangkap/langkah
dimulai/tugas selesai beserta rasa kendali, lalu baru tentukan apakah nilai
berbayarnya berada pada individu atau Workspace.

Keputusan terbaru mengenai satu Workspace pilot Rp49.000 belum diterapkan pada
katalog, kode, `PROJECT.md`, `STATUS.md`, atau spesifikasi paket. Sumber-sumber
itu masih memuat Sapa/Nimbrung/Ruang Rp99.000–599.000. Ketidaksinkronan ini
perlu ditutup sebelum penawaran dibawa kepada calon pembeli; harga dan pilihan
paket tidak dapat menggantikan bukti manfaat.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`, peta
dokumentasi, spesifikasi paket pilot, dan capability catalog diperiksa. Tidak
ada tes, model eksternal, Telegram, WhatsApp, atau perubahan kode yang
dijalankan karena sesi ini membahas posisi produk dan kesenjangan kemampuan.

**Sengaja ditinggalkan.** Tidak ada fitur, katalog, harga, paket, atau dokumen
status yang diubah. Nama penawaran, segmen pertama, bentuk pilot, harga, ukuran
kelulusan, dan pilihan Individual versus Workspace tetap memerlukan keputusan
pemilik produk setelah diskusi lanjutan.

## 2 Agustus 2026 — Arti harga pilot Workspace diperjelas

**Kenapa.** Pemilik produk meminta penjelasan tentang istilah "pilot" dalam
rekomendasi harga Workspace Rp49.000 per bulan.

**Dibahas.** Pilot berarti peluncuran terbatas kepada kelompok kecil untuk
membuktikan pengalaman, biaya nyata, dan kesediaan membayar sebelum paket
ditetapkan sebagai penawaran publik permanen. Peserta harus mengetahui sejak
awal bahwa Rp49.000 adalah harga selama masa uji, berapa lama atau bagaimana
masa itu berakhir, dan bahwa perubahan harga berikutnya memerlukan pemberitahuan
serta pilihan untuk melanjutkan atau berhenti. Pilot bukan alasan untuk
mengurangi keselamatan, privasi, hak data, atau menyembunyikan batas kapasitas.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, dan seluruh `LOG.md`
dibaca kembali. Tidak ada tes yang dijalankan karena sesi ini hanya memperjelas
istilah produk.

**Sengaja ditinggalkan.** Durasi, jumlah workspace, kriteria kelulusan, harga
setelah pilot, dan perlakuan harga peserta awal belum diputuskan. Tidak ada
kode, katalog, atau status kemampuan yang diubah.

## 2 Agustus 2026 — Arah paket grup disederhanakan menjadi satu Workspace

**Kenapa.** Pemilik produk menilai perilaku inti Harvy seharusnya tetap sama di
semua paket dan ingin menghapus pilihan paket grup Sapa, Nimbrung, serta Ruang.
Tujuannya adalah menyederhanakan pengembangan: produk publik dibedakan menjadi
Individual dan Workspace, sementara cara Harvy hadir di grup diatur admin.

**Dibahas.** Arah produk yang dipilih adalah satu paket Workspace tanpa
perhitungan atau biaya per anggota. Perilaku tidak lagi menjadi pembeda harga;
admin hanya boleh mengubah konfigurasi partisipasi grup yang berbatas, seperti
dipanggil saja, hadir kontekstual, jeda, atau nonaktif. Keselamatan, privasi,
hak data anggota, isolasi scope, identitas Harvy, dan mutu model tidak boleh
dapat diturunkan atau diubah admin.

"Tanpa batas anggota" dibedakan dari "pemakaian tanpa batas": biaya runtime
berasal dari aktivitas grup, termasuk planner yang dapat memakai model ketika
Harvy akhirnya diam. Rekomendasi diskusi adalah tidak menghitung kursi, tetapi
tetap memakai satu kapasitas/fair-use bersama per workspace yang transparan;
kontrol keselamatan dan data tidak ikut terblokir ketika kapasitas percakapan
habis. Harga yang disarankan untuk pilot adalah Rp49.000 per workspace per
bulan, bukan Rp49.900. Rp59.000 layak diuji sebagai pembanding kemauan
membayar setelah ada data biaya P50/P90; belum ada harga publik final.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`, katalog
paket di `control-plane-service.ts`, dan gerbang mode grup di `app.ts` diperiksa
langsung. Riset harga membandingkan literatur primer tentang left-digit effect
serta harga resmi ChatGPT Go Indonesia dan ChatGPT Business. Tidak ada tes atau
kanal nyata yang dijalankan karena sesi ini hanya membahas arah produk.

**Sengaja ditinggalkan.** Selain catatan ini, katalog, ID paket, kode runtime,
dan dokumen produk belum diubah. Harga final, besar kapasitas bersama, lingkup
satu workspace terhadap jumlah grup, daftar persis kontrol admin, migrasi
entitlement lama, serta apakah pilihan paket Individual juga disatukan masih
perlu diputuskan sebelum implementasi.

## 2 Agustus 2026 — Perbedaan paket grup diaudit untuk diskusi

**Kenapa.** Pemilik produk ingin membahas paket yang tersedia untuk grup dan
perbedaan nyata di antara paket-paket tersebut.

**Dibahas.** Katalog control plane saat ini memuat Sapa Rp99.000 dengan
kapasitas 5× dan mode direct-only, Nimbrung Rp249.000 dengan kapasitas 15× dan
mode ambient, serta Ruang mulai Rp599.000 dengan kapasitas 30× dan runtime yang
saat ini juga ambient. Ketiganya masih hipotesis pilot, belum dapat dibeli, dan
tidak membedakan model, keselamatan, privasi, atau hak data. Paket grup memakai
entitlement terpisah dari paket pribadi anggota.

Batas produknya perlu tetap terlihat saat membandingkan paket: angka 50/50/150
anggota aktif baru tersimpan di katalog dan belum ditegakkan runtime; Ruang
belum mempunyai administrasi workspace, billing terpusat, atau pengikatan tiga
grup sebagai satu langganan. Karena itu pembeda Ruang yang benar-benar hidup
sekarang terutama kapasitas 30×, bukan pengalaman institusi yang lengkap.
Rekomendasi diskusi—belum keputusan baru—adalah Sapa sebagai pintu masuk pilot,
Nimbrung sebagai paket utama yang membawa pembeda Harvy, dan Ruang tetap
invitation-only sampai kemampuan multi-grup serta administrasinya dibangun.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`,
`PILOT_BETA_DAN_PAKET.md`, `ADR-013`, default paket serta pemetaan mode di
`control-plane-service.ts`, dan gerbang mode grup di `app.ts` diperiksa
langsung. Tidak ada tes atau kanal nyata yang dijalankan karena sesi ini hanya
membahas keadaan dan pilihan produk.

**Sengaja ditinggalkan.** Tidak ada harga, kapasitas, nama paket, mode runtime,
kode, atau status kemampuan yang diubah. Checkout, subscription, enforcement
anggota aktif, workspace multi-grup, dan keputusan penawaran publik tetap belum
ada.

## 2 Agustus 2026 — ID internal paket individu mengikuti nama barunya

**Kenapa.** Setelah perubahan nama publik selesai, pemilik produk secara
eksplisit membatalkan pilihan sebelumnya untuk mempertahankan ID lama dan
meminta ID internal ikut berubah serta masalah migrasinya diatasi.

**Dibahas.** Pemetaan final adalah `personal_perkenalan` untuk Free,
`personal_toro` untuk Plus, `personal_sora` untuk Pro, dan `personal_kuro`
untuk Max. Mengganti ID tanpa migrasi akan memutus enrollment, target audit,
provider-attempt ledger, dan entitlement ledger. Karena ketiga store berkas
tidak mempunyai transaksi lintas berkas, keselamatan rolling migration dijaga
dengan alias kanonik: setiap store dapat berpindah sendiri secara idempoten,
sementara input lama tetap diterima dan langsung dinormalisasi ke ID baru.

**Yang berubah.** Domain control plane kini mempunyai satu konstanta ID paket
dan pemetaan alias lama. Default katalog, enrollment privat baru, perubahan
enrollment, serta versi paket baru selalu memakai ID kanonik. Inisialisasi
control plane dijalankan eksplisit saat startup; satu mutasi atomik mengganti ID
pada seluruh versi katalog, enrollment, dan target audit sebelum migrasi nama
berjalan. Repository provider-attempt dan entitlement menulis ulang ID lama
secara atomik saat pertama dimuat, termasuk seluruh histori, dan
menormalisasi setiap write berikutnya agar ID lama tidak hidup kembali. Filter
usage juga menerima alias lama untuk kompatibilitas. Tes berkas sementara
membuktikan migrasi keempat ID, referensi yang tetap terhubung, restart
idempoten, serta tidak adanya ID lama pada hasil tulis. Spesifikasi paket,
ADR-013, STATUS, dan panduan pengujian diselaraskan; entri LOG sebelumnya
dipertahankan sebagai riwayat keputusan yang memang berlaku sebelum instruksi
lanjutan ini.

**Bukti.** `npm run check` PASS. `npm run build` PASS. Empat suite terarah
(`control-plane-service`, `plan-id-migration`, `usage-ledger-service`, dan
`console-server`) PASS **29/29**. `npm test` PASS **494 test dalam 77 suite**,
0 gagal. Tidak ada model eksternal, Telegram, WhatsApp, atau browser Console
yang dijalankan.

**Sengaja ditinggalkan.** Berkas data lokal asli tidak ditulis ulang manual;
control plane akan bermigrasi pada startup Harvy berikutnya dan kedua ledger
pada pembacaan pertamanya. Harga, kapasitas, benefit, paket grup, checkout,
subscription, serta status harga hipotesis pilot tidak berubah.

## 2 Agustus 2026 — Paket individu menjadi Perkenalan, Toro, Sora, dan Kuro

**Kenapa.** Pemilik produk menetapkan nama publik paket individu: Perkenalan
untuk Free, Toro untuk Plus, Sora untuk Pro, dan Kuro untuk Max. Katalog aktif
sebelumnya masih memakai Gratis, Tunas, Mekar, dan Rimbun.

**Dibahas.** Free/Plus/Pro/Max dipakai sebagai kategori pembanding, bukan nama
publik. ID `personal_free`, `personal_sprout`, `personal_bloom`, dan
`personal_canopy` sengaja tidak diganti: enrollment serta provider/entitlement
ledger sudah merujuk ID itu, sehingga menggantinya hanya demi nama akan membuat
migrasi identitas yang tidak perlu. Perubahan nama harus menjadi versi katalog
baru dan tidak menulis ulang histori lama.

**Yang berubah.** Default `ControlPlaneService` kini menerbitkan Perkenalan,
Toro, Sora, dan Kuro dengan harga, kapasitas, audience, serta ID yang sama.
Startup yang menemukan nama default lama membuat versi kedua secara atomik,
menutup versi lama pada waktu migrasi, dan tidak membuat versi duplikat saat
restart. Versi operator yang lebih baru atau terjadwal tidak ditimpa. Tes
control plane membuktikan nama baru, migrasi keempat paket, kestabilan ID,
harga/kapasitas yang tidak berubah, paket grup yang tidak tersentuh, dan
idempotensi restart. PROJECT, spesifikasi paket pilot, ADR-013, STATUS, dan
panduan pengujian diselaraskan. Catatan LOG lama tetap dibiarkan apa adanya
karena ia merekam keputusan yang memang berlaku saat ditulis.

**Bukti.** `npm run check` PASS. `npm run build` PASS dan tes terarah
`dist/tests/control-plane-service.test.js` PASS **11/11**. `npm test` PASS
**492 test dalam 76 suite**, 0 gagal. `git diff --check` pada berkas perubahan
PASS; peringatan LF/CRLF bukan whitespace error. Tidak ada model eksternal,
Telegram, WhatsApp, atau browser Console yang dijalankan.

**Sengaja ditinggalkan.** Berkas control plane lokal tidak ditulis ulang
manual; migrasi berjalan melalui service pada startup Harvy berikutnya. Harga,
kapasitas, benefit, nama paket grup, checkout, subscription, dan status harga
hipotesis pilot tidak berubah.

## 2 Agustus 2026 — Fatal startup dibuktikan sebagai lock stale dan terminal dibuat lebih diagnostik

**Kenapa.** Pemilik produk melaporkan startup yang hanya menulis
`operational_logging_ready`, lalu `application_fatal` dengan fingerprint
`00e088575025bee2`; Console di port 3210 tidak dapat dipakai dari proses itu.
Baris terminal tersebut sengaja tidak membawa `Error.message`, tetapi akibatnya
kode aman yang sebenarnya tersedia di record NDJSON tidak terlihat oleh
operator.

**Dibahas.** Record persis pada waktu laporan membuktikan `error.code` adalah
`LOCAL_DATA_LOCKED` dengan stack `acquireLocalRuntimeLock` sebelum
`ConsoleServer` dibuat atau dinyalakan. Ini bukan kegagalan model, harga,
asset web, maupun bind port. Lock tidak boleh dihapus otomatis hanya karena PID
tampak tidak ada: proses lain atau PID reuse harus diperiksa operator agar dua
writer JSON tidak hidup bersamaan. Perbaikan yang aman adalah menampilkan
`code`/`status` yang sudah lolos allowlist pada format terminal, tanpa membuka
pesan error bebas.

**Yang berubah.** Lock `data/control-plane.json.runtime.lock` milik PID 13852
diperiksa hanya melalui metadata aman; PID sudah mati dan port 3210 tidak
memiliki listener, sehingga lock stale itu dihapus manual. Formatter `pretty`
log operasional kini mencetak `code` dan `status` aman bersama tipe serta
fingerprint. Tes redaksi yang sudah ada diperluas untuk membuktikan metadata itu
terlihat tetapi pesan error tetap tidak bocor. STATUS dan runbook Console ikut
menjelaskan perilakunya. Saat runtime baru PID 5700 kemudian mati tanpa shutdown
normal dan meninggalkan lock lagi, PID kembali diverifikasi mati sebelum hanya
lock tersebut dihapus; data control plane, ledger, dan percakapan tidak diubah.

**Bukti.** NDJSON lokal untuk `2026-08-01T22:56:38.787Z` membawa
`code=LOCAL_DATA_LOCKED` dan stack ke `src/core/local-runtime-lock.ts`, tepat
sebelum tahap Console. Setelah lock pertama dibersihkan, runtime PID 5700
mencapai `console_started` dan `application_ready`; endpoint
`GET http://127.0.0.1:3210/api/v1/health` sempat menjawab HTTP 200
`{"status":"ready"}`. Runtime itu kemudian berhenti paksa dan lock keduanya
dibersihkan setelah proses dipastikan mati. Probe tanpa jaringan terhadap
`.env` nyata sesudahnya berhasil dengan
`startup_config_and_lock_ok`, `consoleEnabled=true`, host `127.0.0.1`, dan port
3210, lalu melepas locknya sendiri. `npm run build` lulus. Tes terarah logger,
local runtime lock, dan Console lulus 20/20 dalam tiga suite. Probe dan tes tidak
memanggil Telegram, WhatsApp, atau penyedia model.

**Sengaja ditinggalkan.** Tidak ada auto-delete lock dan tidak ada runtime bot
pengganti yang dijalankan diam-diam. Console masih mengikuti lifecycle aplikasi
utama; khususnya setup Telegram terjadi sebelum `ConsoleServer.start()`, jadi
kegagalan jaringan/token Telegram yang berbeda masih dapat mencegah Console
bind dan perlu pekerjaan arsitektur tersendiri.

## 1 Agustus 2026 — Console menghapus harga `unknown` dan memperoleh UX operasional

**Kenapa.** Pemilik produk menemukan harga `unknown` pada web serta menilai
Harvy Console belum cukup optimal untuk pemantauan akses awal. Audit data lokal
menemukan sumber konkretnya: tiga dari sembilan attempt Gemini selesai sebelum
versi harga pertama dibuat, sedangkan enam attempt sesudahnya sudah mempunyai
biaya tercatat. Grup tanpa attempt juga dibuatkan bucket palsu `unknown (0)`
oleh UI.

**Dibahas.** Ledger historis tidak boleh ditulis ulang dan biaya yang belum
diketahui tidak boleh disamarkan sebagai nol. Dipilih tampilan turunan
read-only: bila usage lama tersedia dan pasangan model mempunyai harga aktif,
Console menghitung `current_catalog_estimate`, menandainya dengan `≈`, serta
menyebut jumlah attempt yang diestimasi. Usage yang hilang tetap “Menunggu data
provider” dan model tanpa tarif tetap “Harga belum tersedia”. Estimasi ini
bukan rekonsiliasi atau invoice serta dapat berubah bila tarif aktif berubah.
Dengan tarif Gemini sekarang, tiga attempt lokal lama (3.981 input + 139
output) mempunyai estimasi terpisah US$0,001541800 tanpa mengubah recordnya.

**Yang berubah.** `UsageLedgerService` kini menghasilkan view biaya tercatat,
estimasi katalog aktif, atau unavailable beserta reason dan cakupan
`complete/estimated/partial/unavailable`. Ringkasan serta breakdown memakai
angka indikatif itu sambil mempertahankan field biaya historis untuk
kompatibilitas. API usage membawa provenance per attempt; agregasi grup membawa
angka tercatat dan indikatif secara terpisah. `src/console/assets.ts` dibangun
ulang menjadi dashboard responsif dengan empat KPI utama, banner cakupan biaya,
istilah Indonesia, empty state grup yang jujur, pemuatan grup terisolasi,
loading/error/retry, refresh manual+otomatis, mutation guard, validasi desimal
Indonesia, tab keyboard, tabel mobile berlabel, serta inventaris model
environment yang lebih mudah dibaca. Review akhir menemukan dan menutup empat
race/UX tambahan: refresh latar tidak lagi menimpa form, reload pascamutasi
menunggu refresh aktif lalu mengambil snapshot baru, cache grup diinvalidasi
setelah control/harga berubah, dan badge anggota mengikuti cakupan biaya alih-
alih menyebut estimasi “Lengkap”. ADR-013, runbook Console, STATUS, dan TESTING
diperbarui mengikuti kontrak estimasi ini.

**Bukti.** `npm run check` lulus; build final lulus. Tes terarah Console dan
ledger lulus 16/16. `npm test` lulus 491/491 dalam 76 suite. Tes baru membuktikan
attempt sebelum harga memperoleh estimasi nano-USD tanpa mutasi, timeout tanpa
usage tetap unavailable, harga nol eksplisit tetap biaya tercatat, API grup
memisahkan nilai historis/indikatif, dan JavaScript aset dapat diparse. Smoke
browser memakai `ConsoleServer` in-memory pada port acak, tanpa bot atau model:
desktop 1440×1000 dan ponsel 390×844 menampilkan Gemini serta DeepSeek, estimasi
`≈`, grup berisi dan kosong, tidak menampilkan `unknown`, tidak mempunyai
`pageerror`, serta viewport ponsel 390/390 tanpa overflow dokumen. Form harga
nyata di fixture menerima `0,35`/`2,75`, menyimpan `0.35`/`2.75`, menambah versi
kedua, lalu menonaktifkan tombol ketika tak ada perubahan. Probe sesi awal yang
belum login tetap menghasilkan dua respons 401 yang memang menjadi boundary
auth; tidak ada error JavaScript. Screenshot bukti tersimpan sebagai
`harvy-console-desktop.png` dan `harvy-console-mobile.png` di folder visualisasi
sesi Codex. Smoke regresi kedua memperlambat refresh bersamaan dengan mutasi:
input `0,35`/`2,75` bertahan sebelum simpan, hasil akhir ternormalisasi, biaya
grup berubah setelah versi harga baru, badge tetap “Mengandung estimasi”, dan
tidak ada `pageerror`. Tes API grup juga mencakup satu bucket campuran berisi
biaya tercatat, estimasi, dan usage tertunda (`partial`).

**Sengaja ditinggalkan.** Data ledger Harvy asli tidak direkonsiliasi atau
dimutasi, runtime utama tidak direstart, dan Console belum diuji operasi browser
jangka panjang. Console tetap localhost/internal dan angka indikatif belum
layak menjadi tagihan; gerbang PostgreSQL, auth produksi, rekonsiliasi provider,
backup/restore, serta threat-model tetap berlaku sebelum publikasi.

---

## 1 Agustus 2026 — Console menjadikan environment authority katalog model

**Kenapa.** Pemilik produk menegaskan bahwa Harvy Console harus membaca model
apa saja yang tersedia di `.env`; operator tidak seharusnya mengetik provider
atau model bebas dan hanya perlu mengatur harganya.

**Dibahas.** Katalog adalah snapshot runtime dari semua slot model yang dikenal,
bukan salinan seluruh environment dan bukan hasil menebak provider dari URL.
Model testing default/override, fallback, serta production yang nonkosong tetap
ditampilkan meski modenya tidak aktif. Browser hanya boleh menerima metadata
aman. Harga tetap append-only: menghapus model dari `.env` mencegah harga baru,
tetapi tidak menghapus harga maupun biaya historis. Perubahan environment baru
berlaku setelah restart.

**Yang berubah.** `src/config.ts` membentuk katalog terdedplikasi berisi
provider/model, sumber slot, mode, origin, tier, dan status aktif; ID env yang
tidak dapat dikatalogkan kini menggagalkan startup alih-alih hilang diam-diam.
Kontrak domain dan `ControlPlaneService` meneruskan snapshot tanpa
memersistenkannya serta menolak versi harga untuk pasangan di luar katalog.
`src/console/assets.ts` mengganti dua input bebas dengan satu pemilih pasangan,
menampilkan inventaris aktif/tidak aktif dan slot sumber, serta mengisi ulang
harga dari versi terbuka terbaru. Runtime utama dan probe ledger memakai
katalog yang sama. `.env` lokal diberi
`AI_TESTING_FALLBACK_PROVIDER_ID=always-codex` agar label fallback tidak
generik; `.env.example`, AGENTS, README, PROJECT, STATUS, TESTING, runbook, dan
ADR-013 menjelaskan authority serta batasnya. Audit akhir juga menemukan lock
runtime PID 14204 tertinggal; setelah proses itu dipastikan sudah tidak ada,
hanya `data/control-plane.json.runtime.lock` yang stale dihapus.

**Bukti.** `npm run check` lulus. Empat suite terarah
(`ai-config`, `control-plane-service`, `usage-ledger-service`, dan
`console-server`) lulus 33/33. `npm test` lulus 489/489 dalam 76 suite. Probe
konfigurasi lokal yang hanya mencetak metadata aman menemukan tiga pasangan:
`google-ai-studio/gemini-3.5-flash-lite` aktif sebagai primary testing,
`always-codex/DeepSeek-V4-Flash` aktif sebagai fallback testing, dan
`openrouter/deepseek/deepseek-v4-flash` tersedia tetapi tidak aktif dari slot
production cheap. Tes membuktikan API/UI tidak memakai input provider bebas,
secret/base URL tidak ikut katalog, pasangan buatan ditolak dan diaudit, model
duplikat antar-tier digabung, ID cacat ditolak, serta histori harga bertahan
ketika katalog berubah. Pemeriksaan terakhir memastikan lock runtime sudah
tidak ada.

**Sengaja ditinggalkan.** Runtime tidak direstart dan browser nyata belum diuji
pada sesi ini; proses Harvy yang sudah hidup harus direstart agar membaca
katalog serta provider ID baru. Console tidak mengambil daftar model langsung
dari endpoint provider—sesuai keputusan, `.env` tetap authority—dan belum
internet-ready atau menjadi billing database produksi.

---

## 1 Agustus 2026 — Connection refused Console dan lock stale dipulihkan

**Kenapa.** Setelah Console selesai dibangun, pemilik mencoba membuka
`http://127.0.0.1:3210` dan browser menolak koneksi.

**Yang berubah.** Tidak ada perubahan kode produk. `.env` lokal—yang tidak
masuk Git—ditambahkan `HARVY_CONSOLE_ENABLED=true`, host `127.0.0.1`, dan port
`3210`. Konfigurasi baru hanya dibaca saat startup, sehingga runtime yang sudah
hidup tetap perlu dihentikan normal lalu dijalankan ulang. Percobaan restart
pertama kemudian gagal `LOCAL_DATA_LOCKED`; setelah PID pemilik dipastikan
sudah mati, hanya `data/control-plane.json.runtime.lock` yang stale dihapus.

**Bukti.** Pemeriksaan `netstat` menunjukkan tidak ada listener port 3210,
sementara proses Node pemilik runtime lock masih hidup. Pembacaan nama
konfigurasi yang disaring (tanpa token/API key) menunjukkan ketiga variabel
`HARVY_CONSOLE_*` belum ada. Ini membuktikan `connection refused` berasal dari
Console yang tidak diaktifkan pada proses tersebut, bukan kegagalan login,
CSRF, atau browser. Metadata fatal restart berikutnya menyimpan kode
`LOCAL_DATA_LOCKED` dan menunjuk lock PID lama; pemeriksaan proses memastikan
PID itu sudah mati sebelum berkas lock dihapus.

**Sengaja ditinggalkan.** Lock stale tidak dihapus otomatis oleh produk karena
PID reuse/race dapat membuat proses kedua mengambil repository yang masih
dipakai. Operator tetap perlu menjalankan ulang `npm run dev`; bila pola lock
stale muncul pada setiap Ctrl+C, lifecycle `tsx watch` di Windows perlu diuji
dan diperbaiki tersendiri.

---

## 1 Agustus 2026 — Council menutup Harvy Console, paket pilot, dan ledger delivery

**Kenapa.** Pemilik produk meminta seluruh fondasi akses awal dikerjakan secara
otonom: membedakan pengguna/grup standard dan beta, memantau penggunaan tanpa
membuat arsip percakapan, mengukur biaya Gemini primary maupun DeepSeek
fallback, menghitung token per grup dan anggota, merumuskan paket pribadi/grup,
serta menyiapkan Console localhost yang kelak dapat ditransisikan ke
VPS/domain. Pemilik juga meminta council menilai keputusan produk, ledger, dan
keamanan Console sebelum implementasi dinyatakan selesai.

**Dibahas.** Tiga peninjau read-only bekerja sebagai council produk, ledger,
dan Console. Putusannya `lulus bersyarat`: control plane serta pengukuran boleh
dibangun untuk pilot lokal, tetapi checkout, langganan publik, transcript
review, penjualan SLA grup, dan membuka Console ke internet tetap ditahan.
Katalog pilot yang dipilih adalah Gratis Rp0 (1×), Tunas Rp19.000 (2×), Mekar
Rp39.000 (5×), Rimbun Rp69.000 (10×), Sapa Rp99.000 (5×), Nimbrung Rp249.000
(15×), dan Ruang mulai Rp599.000 (30×); cohort beta menjadi overlay 4× yang
terpisah dari paket, kuota, environment, dan consent evaluasi. Model tetap
dipilih menurut pekerjaan, bukan harga paket. Operator hanya boleh mengundang
atau mencabut evaluasi—tidak memberi consent atas nama peserta.

Council juga menetapkan tiga buku yang tidak boleh dicampur. Provider-attempt
ledger mengukur setiap fetch fisik, termasuk retry, fallback, planner yang
akhirnya diam, kegagalan, dan keselamatan. Product telemetry tetap menjadi
jejak teknis tanpa isi. Entitlement ledger menjadi authority kapasitas
komersial. Audit akhir menemukan bahwa authority kuota lama masih membaca
provider success; itu diperbaiki sehingga `reply`, `session`, dan
`group-reply` baru mendebit setelah adapter memastikan delivery. Due-date,
boundary, understanding, triase, review, ringkasan, insight,
group-participation, schema rusak, gagal kirim, serta keselamatan menjadi biaya
Harvy tanpa mengurangi paket.

**Yang berubah.**

- `src/domain/control-plane.ts`, `src/core/control-plane-service.ts`, dan
  `src/storage/file-control-plane-repository.ts` membangun enrollment
  pseudonim, cohort, paket berversi, override/expiry beta, mode grup, invitation
  consent, principal PN/LID scoped, label operator manual, audit mutasi, serta
  katalog harga provider+model append-only. Bootstrap environment 0/0 sekarang
  berarti token-only, bukan bukti model gratis; tarif nol sungguhan harus dibuat
  eksplisit sebagai versi harga.
- `src/domain/usage-ledger.ts`, `src/core/usage-ledger-service.ts`, dan
  `src/storage/file-usage-ledger-repository.ts` mencatat `requestId` dan setiap
  `attemptId`, provider/model/origin aktual, primary/fallback, purpose, token
  provider/estimasi, cache/reasoning, generation, latency, outcome, snapshot
  harga, biaya provider dan katalog dalam nano-USD, serta status
  `estimated/unpriced/pending`. Ringkasan/ekspor membaca seluruh record, bukan
  hanya batas tabel, dan kelengkapan biaya dinyatakan
  `complete/partial/unknown` alih-alih mengubah unknown menjadi US$0.
- `src/domain/entitlement.ts`,
  `src/storage/file-entitlement-ledger-repository.ts`,
  `src/core/telemetry-service.ts`, adapter Telegram, dan core grup menyelesaikan
  settlement idempoten sesudah delivery. Gerbang kuota 24 jam kini membaca
  debit entitlement yang terkirim; token teknis model tetap terlihat terpisah.
  Settlement berjalan di latar agar balasan tidak menunggu rewrite JSON dan
  di-drain saat shutdown. Kegagalan write dipertahankan untuk retry.
- `src/ai/client.ts` dan seluruh parser percakapan/grup memberi setiap logical
  request provenance aktual sampai fallback. Respons transport sukses yang
  gagal kontrak parser ditandai `schema_rejected`; ia tetap mempunyai biaya
  provider, tetapi tidak menjadi balasan/debit. Runtime membuffer observer
  attempt agar pencatatan tidak menahan percakapan, sedangkan probe/evaluator
  satu kali menunggu ledger selesai agar proses tidak keluar terlalu cepat.
- Atribusi grup memakai subject HMAC dan principal acak per scope. PN/LID yang
  terbukti satu orang digabung. Console menunjukkan bucket anggota pemicu dan
  `shared`, bukan isi chat atau penilaian perilaku. Kontrol “lupakan tentang
  aku” kini menghapus seluruh alias, principal mapping, dan attempt provider
  anggota itu tanpa menghapus anggota lain; penghapusan subject memakai
  generation guard sehingga request lama tidak menghidupkan ledger kembali.
- `src/console/console-server.ts` dan `src/console/assets.ts` membangun Harvy
  Console built-in: bind wajib `127.0.0.1`, token ditukar ke session
  `HttpOnly`/`SameSite=Strict`, CSRF, Host/Origin, CSP/no-CORS, schema/body/rate
  dan optimistic-version guards, drain mutation, serta audit
  success/rejected/failed. UI mengatur enrollment/cohort/paket/mode/consent
  invitation/harga, memberi label pseudonim manual, memfilter usage menurut
  cohort/paket, dan menampilkan breakdown beta/standard, plan, fallback,
  entitlement, unknown cost, grup, dan anggota.
- `src/core/local-runtime-lock.ts`, `src/app.ts`, dan seluruh probe/evaluator
  memasang lock atomik `<CONTROL_PLANE_FILE>.runtime.lock`. Runtime dan alat
  satu kali tidak dapat membuka cache repository JSON yang sama secara
  bersamaan. Lock berisi PID/peran/token acak tanpa data pengguna, dilepas pada
  shutdown normal, dan sengaja tidak dibersihkan otomatis setelah crash agar
  operator lebih dulu memastikan PID sudah mati. `.gitignore` mengecualikannya.
- `docs/decisions/ADR-013-harvy-console-entitlement-dan-ledger-biaya.md`,
  `docs/operations/HARVY_CONSOLE.md`,
  `docs/product/PILOT_BETA_DAN_PAKET.md`, `PROJECT.md`, `STATUS.md`, `TESTING.md`,
  `README.md`, `.env.example`, dan `AGENTS.md` sekarang memisahkan Console dari
  Harvy Web, mendokumentasikan batas pilot, definisi debit/biaya, backup,
  penghapusan, local lock, serta gerbang transisi PostgreSQL, OIDC/MFA/RBAC,
  TLS, outbox, rekonsiliasi, payment ledger, dan threat-model review.

**Bukti.** Council meninjau kode dan desain secara read-only lalu seluruh
temuan materialnya ditutup: race penghapusan ledger, planner grup yang sempat
terhitung debit, atribusi anggota yang belum ikut dihapus, unknown cost yang
sempat tampil nol, `schema_rejected` yang belum dipakai, filter cohort/paket,
risiko dua proses JSON, write ledger yang dapat menahan balasan, bootstrap
harga nol palsu, serta debit sebelum delivery. `npm run check` PASS. Pengujian
terarah telemetry+usage ledger PASS 22/22. `npm test` PASS **484 test / 76
suite**, fail 0. Suite itu mencakup primary→fallback sebagai dua attempt satu
request, schema rejection, biaya tidak diketahui, delivery berhasil/gagal,
authority kuota, deletion generation guard, PN/LID dan self-delete, lock proses,
security HTTP Console, adapter Telegram, serta core grup.

Tidak ada panggilan model eksternal, uji browser manual jangka panjang,
Telegram nyata, atau WhatsApp grup nyata pada verifikasi penutup ini. Karena
itu kualitas percakapan/model, delivery kanal sungguhan, angka harga provider,
reliability Baileys, dan willingness-to-pay belum dinyatakan terbukti.

**Sengaja ditinggalkan.** Checkout, payment/subscription lifecycle, invoice,
webhook, renewal/refund/pajak/overage, dashboard pembayar/admin grup, participant
consent flow untuk evaluasi luas, transcript review, Harvy Web pengguna,
PostgreSQL, deployment VPS/domain, OIDC/MFA/RBAC/TLS, secret manager, outbox,
rekonsiliasi provider/payment, backup/PITR drill, alerting, pentest, SLA grup,
serta migrasi auth Baileys terenkripsi. Console tetap localhost satu proses dan
katalog tetap hipotesis pilot sampai biaya serta perilaku nyata mempunyai
sampel yang cukup.

---

## 1 Agustus 2026 — Paket grup dipisahkan menurut direct, ambient, dan workspace

**Kenapa.** Setelah harga pribadi dirumuskan, pemilik meminta paket khusus grup
dibahas. Pola biaya, pembeli, privasi, dan nilai Harvy di grup berbeda dari satu
akun pelajar.

**Dibahas.** Paket grup tidak menyalin Free/Ringan/Pro/Max pribadi dan tidak
ditagih per seluruh anggota terdaftar. Bentuk awal yang disarankan adalah:
`Group Direct` Rp99.000 per grup per bulan, sampai 50 anggota aktif, untuk
balasan saat Harvy ditag/di-quote/dipanggil; `Group Ambient` Rp249.000 per grup
per bulan, sampai 50 anggota aktif, untuk direct plus planner partisipasi
natural; dan `Workspace` mulai Rp599.000 per bulan untuk sampai tiga grup/150
anggota aktif, billing serta kebijakan terpusat, dan kebutuhan sekolah,
komunitas, lembaga bimbingan, atau sponsor. Semua angka merupakan hipotesis
pilot dan wajib dikoreksi oleh ledger biaya grup nyata.

Unit bisnisnya adalah **scope grup + kapasitas**, bukan seat pribadi. Banyak
anggota grup hanya membaca dan tidak memicu Harvy; menagih semua seat akan
terasa boros. Sebaliknya, jumlah anggota saja juga tidak cukup karena grup kecil
yang ramai dapat lebih mahal daripada grup besar yang sepi. Setiap paket
mempunyai batas anggota aktif dan usage credit bersama. Pemakaian grup tidak
mengurangi paket pribadi anggota, dan pembayaran grup tidak memberi paket
pribadi berbayar kecuali sponsor membeli grant terpisah.

Ambient menjadi paket utama dan paling mencerminkan pembeda Harvy, tetapi juga
paling berisiko secara biaya: planner dan triase dapat mencapai provider meski
Harvy akhirnya diam, lalu direct reply/review dapat menambah panggilan. Ketika
pool mendekati batas, sistem tidak menurunkan model diam-diam. Ambient budget
dikurangi lebih dulu dan grup turun secara transparan ke direct-only; direct
normal tetap mendapat reservasi, keselamatan tetap menembus cap, dan admin
menerima pemberitahuan 70/90/100 persen. Tidak ada overage otomatis; pembelian
kapasitas tambahan memerlukan persetujuan pembayar.

Psikologi halaman harga tetap terang. Direct menjadi pintu masuk; Ambient
diletakkan di tengah dengan label faktual "untuk grup aktif"; Workspace menjadi
jangkar multi-grup. Bila 50 anggota aktif terpenuhi, ekuivalen dapat dijelaskan
sebagai Rp1.980/anggota untuk Direct dan Rp4.980/anggota untuk Ambient, tetapi
harga grup penuh tetap ditampilkan paling utama. Tidak ada label populer palsu,
seat bayangan, atau harga awal yang menyembunyikan overage.

Group trial berlangsung 14 hari atau sampai credit pilot habis—mana yang lebih
dulu—tanpa kartu dan tanpa tagihan otomatis. Setelahnya grup turun ke allowance
direct gratis yang sangat kecil atau berhenti memproses pesan biasa sesuai
keputusan produk final; kontrol data dan pesan keselamatan direct tidak boleh
dipakai sebagai alat memaksa pembayaran. Beta grup tetap program evaluasi
terpisah, tidak menjadi trial komersial terselubung.

Pembayar harus merupakan pengelola grup yang terverifikasi. Membayar tidak
memberi akses ke isi chat, memori anggota, percakapan pribadi, atau breakdown
per anggota secara default; dashboard pembayar cukup memperlihatkan health,
kapasitas agregat, anggota aktif agregat, mode, dan waktu reset. Pergantian
admin/pembayar membutuhkan transfer kepemilikan berizin dan masa tenggang.

Peluncuran komersial WhatsApp belum layak dijanjikan sekarang. Adapter grup
masih beta lokal berbasis Baileys yang tidak resmi, baru satu nomor/grup nyata,
dan perilaku lengkap/reliability belum teruji di grup nyata. Paket boleh
dirancang serta diukur dalam beta, tetapi tidak boleh menjual SLA atau
subscription umum sebelum risiko kanal, operasi, dan pemulihan terbukti.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, dan seluruh `LOG.md`
dibaca. Dokumentasi harga bisnis saat ini menunjukkan produk workspace lazim
menagih per pengguna; pola itu dibandingkan dengan arsitektur Harvy yang
memproses satu ruang bersama dan dinilai bukan unit harga yang tepat. Status
proyek membuktikan Telegram grup belum ada dan WhatsApp grup masih fondasi beta.
Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Harga final, nilai usage credit, definisi anggota
aktif, allowance sesudah trial, harga tambahan grup/kapasitas, sponsor grant,
transfer billing owner, pajak/fee, kontrak institusi, dan jalur produksi kanal
belum disahkan atau dibangun.

## 1 Agustus 2026 — Strategi pembayaran kembali ke Rp19/39/69 ribu

**Kenapa.** Setelah membandingkan Max 5×/10× Pro, pemilik menilai harga
Rp129.000–249.000 tidak masuk akal bagi Harvy. Pemilik meminta kembali ke
struktur sebelumnya dan merancang alasan psikologis yang etis agar pengguna
ingin membayar, termasuk membuat Max sungguh menarik.

**Dibahas.** Tangga harga pribadi kembali menjadi gratis, paket masuk
Rp19.000, paket utama Rp39.000, dan Max Rp69.000 per bulan. Pro/Rp39.000 menjadi
mesin pendapatan yang ditujukan bagi penggunaan harian; Rp19.000 menghilangkan
hambatan awal; Max menjadi jangkar nilai sekaligus pilihan bulan belajar
intensif. Max tidak lagi dijanjikan 5×/10× Pro. Kapasitas awalnya kira-kira dua
kali Pro ditambah capability yang benar-benar mahal seperti riset bersumber,
analisis file/gambar, konteks proyek panjang, dan prioritas kapasitas—semuanya
hanya disebut ketika sudah dibangun. Model, review keselamatan, privasi, dan hak
data tetap sama menurut kebutuhan, bukan harga.

Psikologi yang diterima adalah **choice architecture terang**, bukan manipulasi.
Tiga paket berbayar harus mewakili alasan nyata: ringan, rutin, dan intensif.
Kartu Rp39.000 boleh diletakkan di tengah dan diberi label faktual "untuk
penggunaan harian", tetapi tidak boleh disebut "paling populer" sebelum data
membuktikannya. Harga bulanan tetap utama; ekuivalen harian boleh ditampilkan
jujur sebagai sekitar Rp633, Rp1.300, dan Rp2.300 per hari tanpa kata "cuma".
Max harus mempunyai benefit sendiri dan bukan decoy sengaja buruk.

Trial yang disarankan adalah tujuh hari Pro tanpa kartu pembayaran, baru mulai
setelah pengguna memperoleh hasil bermakna pertama agar masa coba tidak habis
sebelum Harvy dipahami. Akhir trial selalu turun ke gratis tanpa tagihan. Max
dapat dibeli untuk 30 hari pada musim ujian/proyek dengan opsi non-renewing yang
jelas; auto-renew hanya bila dipilih sadar. Harvy boleh merekomendasikan paket
berdasarkan angka penggunaan dan capability yang dipakai, bahkan bila hasilnya
menyarankan paket lebih murah. Isi percakapan, risiko, emosi, atau kerentanan
tidak dipakai untuk upsell.

Prompt upgrade dibatasi: satu pemberitahuan menjelang kapasitas normal habis
dan satu saat cap tercapai; tidak muncul pada giliran keselamatan, dukungan
emosional, atau ketika pengguna sedang tertekan. Pengguna tetap dapat melihat
dan mengendalikan tugas/data setelah cap. Tidak ada countdown palsu, diskon
abadi palsu, fee tersembunyi, tombol batal yang disamarkan, forced continuity,
virtual coin yang menyembunyikan rupiah, atau social proof buatan. Pembatalan
harus semudah berlangganan. Larangan itu penting karena audiens Harvy mencakup
anak di bawah umur dan karena kepercayaan adalah bagian nilai produknya.

Alasan membayar yang akan diuji: continuity yang benar-benar membantu
menyelesaikan minggu sekolah; kapasitas ketika kebutuhan meningkat; visualisasi
kemajuan yang dikendalikan pengguna; alat riset/file/proyek yang menimbulkan
biaya; dan reliability saat ramai. Copy tidak menjual "AI lebih pintar", tetapi
hasil konkret seperti menyusun minggu, melanjutkan belajar, dan menuntaskan
proyek tanpa Harvy mengambil alih. Ukuran conversion tetap tunduk pada rasa
terbantu, kemandirian, gangguan, keselamatan, dan kendali pengguna.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, dan seluruh `LOG.md`
dibaca kembali. Literatur tiered pricing, field experiment free trial, serta
temuan regulator/riset tentang hidden subscription, forced continuity, false
scarcity, dan dark patterns—termasuk dampaknya pada konsistensi pilihan dan
kepercayaan—diperiksa. Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Nama paket publik, kapasitas/usage credit konkret,
daftar capability yang sudah layak dijual, naskah paywall, trial trigger final,
target conversion/margin, dan mekanisme pembayaran belum disahkan atau dibangun.

## 1 Agustus 2026 — Max dirancang sebagai pilihan kapasitas 5× dan 10× Pro

**Kenapa.** Pemilik mengusulkan agar paket Max memberi pilihan kapasitas lima
kali atau sepuluh kali Pro, bukan hanya satu batas Max.

**Dibahas.** Usulan itu dapat menjadi satu keluarga entitlement `max` dengan
dua varian `max_5x` dan `max_10x`, tetapi multiplier mengacu pada usage credit
Pro—bukan raw token, jumlah pesan, kualitas model, atau hak keselamatan. Routing
model tetap menurut kebutuhan pekerjaan. Pengguna harus melihat kapasitas,
periode reset, dan harganya sebelum membeli; dua varian tidak boleh memakai
harga sama atau disebut unlimited.

Harga Max Rp69.000 yang dibahas sebelumnya tidak cocok dengan kapasitas 5×–10×
Pro Rp39.000 kecuali ledger membuktikan utilisasi dan biaya model sangat rendah.
Hipotesis konservatif untuk diuji adalah Max 5× pada kisaran Rp129.000–149.000
per bulan dan Max 10× pada kisaran Rp229.000–249.000 per bulan. Harga itu sudah
memberi diskon volume dibanding mengalikan harga Pro secara lurus, sehingga
belum boleh diturunkan lagi tanpa data biaya P90 dan pengguna yang benar-benar
menghabiskan kuota.

Peluncuran yang disarankan adalah membuka Max 5× lebih dulu. Max 10× sudah ada
di plan catalog/Console tetapi tetap nonaktif atau invitation-only sampai
minimal satu siklus tagihan membuktikan margin, pola retry/fallback, rate limit,
dan beban dukungan Max 5×. Jika pemilik ingin Max publik tetap Rp69.000, varian
itu sebaiknya sekitar 2× Pro dan tidak memakai label 5×/10×.

Usage credit keselamatan yang harus menembus cap tetap tidak dipakai untuk
menghukum atau memotong entitlement pengguna, walaupun biaya providernya tetap
masuk ledger perusahaan. Upgrade 5× ke 10× kelak memerlukan proration yang
terlihat; downgrade berlaku pada periode berikutnya dan tidak menghapus data.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, dan seluruh `LOG.md`
dibaca kembali. Belum ada baseline biaya provider produksi atau distribusi
utilisasi paket, sehingga rentang harga di atas masih hipotesis dan bukan harga
yang disahkan. Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Nilai satu usage credit, kapasitas Pro konkret,
harga Max final, proration, kebijakan carry-over, periode reset, dan syarat
mengaktifkan Max 10× belum diputuskan atau dibangun.

## 1 Agustus 2026 — Tangga harga pelajar dan paket grup dipisahkan

**Kenapa.** Pemilik menilai satu paket Rp29.000 membuat pengguna sulit
membandingkan kebutuhan dan terlalu tinggi sebagai pintu masuk pelajar. Pemilik
mengusulkan harga awal Rp19.000, lalu Pro dan Max yang lebih tinggi, serta
menegaskan ekonomi grup tidak perlu mengikuti kantong pelajar karena pola
penggunaannya berbeda.

**Dibahas.** Arah komersial direvisi menjadi tangga harga yang mudah dipilih
menurut intensitas penggunaan. Hipotesis awalnya: gratis untuk mencoba dan
fungsi inti; paket masuk Rp19.000/bulan untuk penggunaan ringan rutin; paket
menengah Rp39.000/bulan untuk penggunaan harian; dan paket kapasitas tinggi
Rp69.000/bulan untuk belajar/proyek intensif serta capability mahal yang kelak
tersedia. Angka itu belum harga final: semuanya wajib lolos baseline biaya P50,
P90, retry/fallback, fee pembayaran, pajak, operasi, dan target margin. Paket
bulanan lebih dulu; tidak ada klaim unlimited, kontrak tahunan, atau harga
permanen saat pola biaya belum terbukti.

Tiga tier dinilai berguna bukan untuk membuat pilihan semu, melainkan memberi
tiga profil yang benar-benar berbeda: ringan, rutin, dan intensif. Batasnya
berupa kapasitas/usage credit dan capability berbiaya—bukan model yang sengaja
lebih bodoh, review keselamatan, hak data, atau privasi. Routing model tetap
menurut kebutuhan pekerjaan. Nama `entry|pro|max` dapat dipakai sementara
untuk pembicaraan, tetapi `Pro`/`Max` belum diterima sebagai nama publik karena
arah merek proyek menolak nama generik; penamaan Harvy perlu dibahas terpisah.

Grup menjadi lini produk dan entitlement terpisah dari paket individu. Hipotesis
awal: grup `direct` sekitar Rp99.000 per grup per bulan dengan Harvy menjawab
saat dipanggil; grup `ambient` sekitar Rp249.000 per grup per bulan karena
planner/triase dapat memakai API pada pesan yang akhirnya tidak dibalas; dan
institusi/sponsor memakai penawaran tersendiri setelah biaya serta kebutuhan
administrasinya terbukti. Harga grup mempunyai batas anggota aktif dan usage
credit, bukan hanya jumlah anggota terdaftar. Angka tersebut adalah titik uji,
bukan harga yang disahkan.

Pemakaian chat pribadi selalu masuk entitlement individu. Pemakaian di grup
masuk entitlement grup dan tidak mengurangi kuota pribadi anggota. Membeli
paket individu tidak otomatis membiayai grup, dan langganan grup tidak otomatis
memberi paket pribadi berbayar kepada semua anggota. Sponsor kelak boleh
memberikan seat/credit pribadi secara eksplisit. Pemisahan ini mencegah satu
pelajar membayar aktivitas puluhan anggota serta membuat margin tiap lini dapat
dilihat jujur di Console.

Beta tetap bukan paket harga. Pengguna beta dapat memperoleh kapasitas uji
sementara pada salah satu policy yang ekuivalen tanpa tagihan, sedangkan grup
beta memperoleh quota pengujian tersendiri. Ketika beta berakhir, downgrade dan
data yang tetap dapat diakses harus dijelaskan sejak awal.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, dan seluruh `LOG.md`
dibaca kembali. Jalur grup yang sudah diperiksa pada diskusi sebelumnya
menunjukkan ambient planner, triase, reply, dan review dapat menghasilkan
beberapa panggilan model per giliran, sehingga paket grup memang tidak setara
dengan satu akun pribadi. Pembanding resmi yang telah diperiksa pada sesi ini
adalah ChatGPT Go Indonesia Rp75.000/bulan; angka Harvy tidak disalin darinya.
Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Nama publik paket, multiplier/usage credit konkret,
jumlah anggota aktif, fair-use, target margin, pajak/fee, harga tahunan, diskon,
paket keluarga, syarat sponsor, dan harga grup final belum disahkan. Semuanya
menunggu ledger biaya dan pilot penggunaan nyata.

## 1 Agustus 2026 — Tier langganan dan ledger token/biaya dirumuskan

**Kenapa.** Pemilik ingin menentukan apakah Harvy memerlukan paket bertingkat
seperti Pro/Max dan harga awalnya, sekaligus memastikan Harvy Console dapat
menunjukkan seluruh token serta biaya API untuk pengembangan, grup, dan anggota
secara akurat. Console juga perlu menyediakan pengaturan harga input/output per
satu juta token.

**Dibahas.** Arsitektur entitlement sebaiknya mendukung beberapa paket sejak
awal, tetapi peluncuran konsumen pertama cukup mempunyai standar gratis dan
satu paket individu berbayar. Tier kapasitas tertinggi belum ditampilkan sampai
data penggunaan membuktikan adanya segmen berat atau capability mahal yang
benar-benar berbeda. Beta tetap overlay evaluasi dan bukan tier pembayaran.
`free`, `individual`, dan `high_capacity` dapat dipakai sebagai ID internal;
nama Pro/Max tidak disarankan sebagai nama akhir karena keputusan proyek
meminta bahasa merek Harvy/kapibara/pertumbuhan yang tidak generik.

Hipotesis harga awal untuk diuji, bukan harga yang sudah disahkan, adalah
Rp29.000 per bulan bagi satu paket individu. Paket kapasitas tinggi dapat
dipertimbangkan kemudian sekitar Rp59.000 per bulan hanya bila benefit dan
biaya nyatanya membenarkan. Pembanding pasar yang diperiksa hari ini adalah
ChatGPT Go Indonesia Rp75.000 per bulan; Harvy tidak boleh menyalin harga itu
karena ruang produk dan pola panggilannya berbeda. Harga Harvy baru boleh
disahkan bila pendapatan bersih sesudah pajak/fee pembayaran menutup biaya
variabel P90, cadangan retry/kegagalan, operasi, dan margin pengembangan yang
dipilih. Langganan tahunan, top-up token, dan harga grup ditunda sampai
pembatalan/refund serta distribusi biaya terbukti. Kuota tetap ditampilkan ke
pengguna dalam unit sederhana, bukan meter token mentah.

Akuntansi membutuhkan dua ledger yang tidak dicampur. **Provider usage ledger**
mencatat semua percobaan yang benar-benar mencapai provider untuk menghitung
biaya Harvy, termasuk retry, fallback, kegagalan yang mengembalikan usage,
cache, dan reasoning. **Entitlement usage ledger** menentukan jatah pengguna;
retry/fallback akibat gangguan Harvy tidak boleh dibebankan dua kali kepada
pengguna. Satu giliran memiliki `turnId`, setiap panggilan logis memiliki
`requestId`, dan setiap percobaan provider memiliki `attemptId`, provider,
origin primary/fallback, model aktual, purpose, environment/cost center,
status, serta usage aktual/estimasi. `maxTokens` dan reservasi input harus
ditampilkan sebagai **budget diminta**, bukan token terpakai.

Untuk grup, total ruang adalah jumlah unik seluruh attempt pada scope grup.
Breakdown anggota adalah partisi dari total itu, bukan angka tambahan:
panggilan yang disebabkan satu giliran diatribusikan ke principal anggota
kanonis dalam grup, termasuk planner yang akhirnya memilih diam. Overhead tanpa
pemicu tunggal masuk bucket `shared/unattributed`. Konteks anggota lain yang
ikut berada di prompt tidak boleh diberi label sebagai konsumsi persis karena
provider hanya mengembalikan total prompt; bila dibutuhkan, pembagiannya hanya
estimasi dengan metode yang terlihat. Alias PN/LID harus disatukan sebelum
agregasi. Identitas di ledger bersifat pseudonim per scope; biaya anggota bukan
skor perilaku dan tidak otomatis boleh dilihat admin/pembayar grup.

Sumber angka berjenjang: usage dan cost yang dilaporkan provider adalah
authority utama; bila token ada tetapi cost tidak ada, gunakan price catalog
berversi; bila usage tidak ada, simpan estimasi yang diberi label jelas; lalu
rekonsiliasi harian terhadap riwayat/tagihan provider. Untuk OpenRouter,
respons kini dapat membawa token native, reasoning/cache, dan `usage.cost`,
serta generation ID dapat diaudit lewat endpoint generation. Console perlu
menampilkan `reported`, `estimated`, `reconciled`, dan delta yang belum cocok,
bukan menggabungkannya menjadi satu angka seolah sama akurat.

Price catalog Console harus dikunci ke provider+model+effective time, bukan
tier routing. Minimal ada harga input dan output per satu juta token; field
opsional mencakup cached input/read, cache write, reasoning, request, image,
atau search bila model mengenakannya. Setiap record menyimpan version/snapshot
harga agar perubahan tarif tidak menulis ulang sejarah. Nilai uang disimpan
sebagai decimal/string atau unit integer kecil, bukan penjumlahan floating
point JavaScript. Provider-reported cost disimpan terpisah dari locally
calculated cost. Tampilan menyediakan toggle token/USD dan filter lingkungan
`development`, `evaluation`, `beta`, serta `production`, sehingga "biaya
pengembangan" tidak tercampur dengan biaya melayani pengguna.

Pemeriksaan kode menemukan telemetry sekarang belum memenuhi rancangan itu.
Ia membaca `prompt_tokens`, `completion_tokens`, dan `total_tokens`, tetapi
belum membaca provider cost, generation ID, reasoning, cache, provider/origin,
turn/request/attempt ID, environment, atau actor anggota. Harga masih per
`cheap|efficient|ambitious`; fallback mengganti model namun tetap dihitung
dengan tarif tier yang sama. Grup mengirim `scopeKey` sebagai `ownerId` untuk
seluruh panggilan, sehingga total grup tersedia tetapi kontribusi anggota
belum dapat dibedakan. Angka tanpa usage diperkirakan dari karakter/4 dan sudah
ditandai estimated. Biaya dihitung dengan `number`, repository hanya dapat
query per owner, retensi default 30 hari, dan belum ada rekonsiliasi provider.
Karena itu ketepatan yang ada cukup sebagai telemetry awal, belum sebagai
ledger keuangan atau dasar tagihan.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`, schema
telemetry, `TelemetryService`, `AiClient`, konfigurasi harga, jalur percakapan
grup, scope harness, repository, dan tes telemetry/client diperiksa. Dokumentasi
resmi OpenRouter tentang usage accounting, `usage.cost`, token reasoning/cache,
generation audit, dan Analytics API diperiksa. Harga pembanding ChatGPT Go
Indonesia diperiksa dari catatan rilis resmi OpenAI. Tidak ada tes dijalankan
dan tidak ada kode produk yang diubah; hanya keputusan diskusi ini dicatat.

**Sengaja ditinggalkan.** Nama paket akhir, harga yang disahkan, ukuran kuota,
target margin, kebijakan fair-use, harga grup/sponsor, schema ledger, metode
rekonsiliasi, retensi finance, dan batas akses breakdown anggota belum dipilih
atau diimplementasikan.

## 1 Agustus 2026 — Batas monetisasi dipisahkan dari cohort beta

**Kenapa.** Pemilik ingin Harvy membiayai pengembangan sekaligus menghasilkan
keuntungan, dan meminta batas pengguna standar serta beta dibahas sebelum
Harvy Console maupun sistem cohort dibangun.

**Dibahas.** Beta tidak boleh dijadikan paket berbayar. Status beta menjelaskan
stabilitas fitur, masa evaluasi, dan cakupan observasi; status komersial
menjelaskan entitlement penggunaan. Bentuk internal yang disarankan mempunyai
empat kebijakan terpisah: `cohort`, `billingPlan`, `quotaPolicy`, dan
`evaluationConsent`. Dengan demikian pengguna standar dapat gratis atau
berbayar, sedangkan peserta beta dapat menerima kuota uji lebih besar tanpa
dianggap membeli kualitas atau menjual data pribadinya.

Rancangan awal monetisasi adalah standar gratis berbatas sebagai pintu masuk,
langganan individu untuk kapasitas dan kenyamanan yang lebih besar, serta
paket grup/institusi atau sponsor hanya setelah pengalaman grup terbukti.
Beta menjadi overlay undangan yang berbatas waktu: kuota lebih besar, fitur
percobaan, kewajiban notice, evaluasi berizin, dan jalan turun ke standar.
Pengguna beta tidak dijanjikan seluruh fitur akan bertahan. Nama serta harga
paket belum dipilih; ID internal boleh netral sampai riset merek dan kemauan
membayar dilakukan.

Hak yang tidak boleh dipagari pembayaran atau cohort: keselamatan dan review
fail-closed, kontrol lihat/edit/ekspor/hapus data, penarikan consent, akses ke
data yang sudah dibuat, kejujuran kemampuan/model, serta jalur deterministic
untuk melihat/menyelesaikan tugas dan mengelola pengingat yang sudah ada.
Model/tier tetap dipilih menurut kesulitan pekerjaan, bukan status pembayaran.
Produk berbayar menjual kapasitas, continuity, visualisasi, dan capability
tambahan yang memang mempunyai biaya—bukan martabat, privasi, atau balasan
yang sengaja dibuat lebih benar. Iklan berbasis isi, penjualan data, dan
penargetan dari kerentanan tidak masuk model bisnis yang disarankan.

Ketika kuota biasa habis, Harvy harus menjelaskan batas dan waktu reset secara
jujur; keselamatan tetap berjalan dan tercatat. Harvy tidak diam-diam
menurunkan kualitas model hanya bagi pengguna gratis. Paket berbayar dapat
memberi kuota lebih besar, sesi/pekerjaan lebih panjang, kapasitas grup,
visualisasi web, dan konektor masa depan. Admin grup yang membayar tidak
memperoleh akses ke chat pribadi atau data anggota di luar scope grup.

Harga rupiah belum dapat ditetapkan secara bertanggung jawab. Telemetry sudah
mempunyai token, tier, model, tujuan, latency, hasil, dan estimasi biaya per
owner, tetapi penggunaan provider produksi belum teruji dan contoh harga
environment masih nol. Sebelum menetapkan harga perlu mengukur distribusi
biaya per pengguna/grup, biaya infrastruktur, penyimpanan, pembayaran,
dukungan, kegagalan/retry, serta cadangan risiko. Batas harga minimum dihitung
dari seluruh biaya variabel dan margin kontribusi yang dipilih, bukan harga
model saja. Token mentah tetap dicatat untuk guard teknis; entitlement komersial
sebaiknya memakai unit biaya bernilai tetap agar 1.000 token murah tidak
disamakan dengan 1.000 token model mahal.

Harvy Console kelak perlu plan catalog berversi, subscription/entitlement,
usage ledger, cost-versus-revenue, quota override, masa tenggang pembayaran,
idempotent webhook, refund/cancel, sponsor grant, dan audit. Kegagalan
pembayaran tidak boleh menghapus data atau memutus kontrol keselamatan. Sebelum
menerima pembayaran dari pengguna di bawah umur, alur pembeli/wali, pembaruan
otomatis, pembatalan, pengembalian dana, dan ketentuan penyedia pembayaran
memerlukan tinjauan hukum/operasional terpisah.

Putusan konstitusional awal adalah **lulus bersyarat**. Pendapatan dan metrik
komersial boleh diukur, tetapi tidak menjadi ukuran tunggal keberhasilan atau
mendorong percakapan dipanjangkan. Konstitusi v0.4 belum perlu diubah.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`, schema
telemetry, `TelemetryService`, konfigurasi harga, dan batas token diperiksa.
Kode sekarang hanya mempunyai satu batas token 24 jam global; belum ada cohort,
plan, entitlement, pembayaran, ledger pendapatan, atau harga produksi yang
terbukti. Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Nama paket, harga rupiah, besar kuota, periode
langganan, metode pembayaran, sponsor, masa tenggang, refund, dan benefit final
belum disahkan. Hal-hal itu perlu diputuskan setelah baseline biaya nyata dan
kemauan membayar mulai tersedia.

## 1 Agustus 2026 — Harvy Console dan pembagian beta/standar dirancang

**Kenapa.** Pemilik menetapkan pembagian akses awal yang sederhana: pengguna
dan grup berstatus beta atau standar. Beta memperoleh batas token lebih besar
dan membantu evaluasi melalui pemantauan yang lebih luas; pengguna standar
tetap dapat memakai Harvy secara normal dengan pengumpulan data sesuai
Konstitusi. Pemilik juga mengusulkan website localhost milik operator yang
kelak dapat berpindah mulus ke domain/VPS dan meminta dokumentasi desainnya.

**Dibahas.** Pembagian dua cohort dapat tetap sederhana di layar, tetapi
implementasinya tidak boleh menyatukan tiga keputusan yang berbeda: status
akses `standard|beta`, kebijakan kuota, dan persetujuan/kebijakan evaluasi.
Pemisahan internal itu diperlukan agar penarikan izin evaluasi tidak menghapus
data atau memaksa orang kehilangan akses standar, serta agar tier/model tetap
dipilih menurut kesulitan pekerjaan—bukan status beta. Untuk grup beta, status
grup tidak otomatis membuat perkataan setiap anggota boleh direview manusia;
sampling isi perlu consent evaluasi anggota dan harus berhenti atau turun ke
event-only ketika anggota baru belum menyetujuinya.

Website dinilai perlu sekarang sebagai **Harvy Console**, yaitu control plane
operator yang berbeda dari Harvy Web sebagai kanal pengguna kelak. Console
menampilkan health kanal, cohort dan kuota, consent, trajectory giliran tanpa
isi secara bawaan, sumber balasan primary/fallback/copy statis, latency,
guard/review/delivery, antrean feedback dan sampel beta berizin, insiden,
retensi, audit akses, serta kontrol pause/direct-only/ambient/disable. Ukuran
utama mengikuti Konstitusi Pasal 8—rasa terbantu, gangguan, koreksi, langkah
nyata, keselamatan, memori yang mengejutkan, dan kendali—bukan DAU atau jumlah
pesan sebagai tujuan.

Console tidak terhubung langsung ke model atau mengubah checkpoint harness.
Ia memanggil application service deterministik untuk enrollment, quota,
evaluation, dan runtime control; harness serta adapter menerbitkan event
bertipe dan capability snapshot untuk diamati. Operational log tetap tanpa isi
dan tidak dijadikan arsip chat. Event evaluasi dan cuplikan beta yang berizin
memerlukan store terpisah, pseudonim, retensi pendek, kontrol akses, audit
lihat, serta penghapusan. Percakapan sensitif tidak masuk review rutin; insiden
keselamatan memakai jalur terpisah yang lebih sempit.

Karena repository sekarang hanya aman untuk satu proses, versi localhost
pertama sebaiknya menjadi server HTTP loopback di dalam proses Harvy dan
memakai service/repository yang sama—bukan proses website kedua yang membaca
atau menulis JSON/Markdown langsung. API diberi versi sejak awal dan frontend
dipisahkan dari backend agar sesudah migrasi PostgreSQL control plane dapat
dipecah menjadi proses sendiri. Produksi memerlukan PostgreSQL+migrasi,
autentikasi operator kuat, TLS/reverse proxy, secret store, backup, health,
collector/alert, audit, dan domain admin yang terpisah dari web pengguna.

Konstitusi v0.4 belum perlu dilemahkan atau diubah. Ia sudah mengizinkan
partisipasi pengguna dan evaluasi berbasis persetujuan; kesulitan sekarang
berasal dari belum adanya enrollment, consent evaluation, store, dan alat
operator. Konstitusi patut direvisi hanya bila bukti beta menunjukkan klausul
spesifik tidak lagi tepat, memakai proses versi/alasan/risiko/ringkasan dampak
Pasal 9—bukan karena membaca transkrip tanpa batas lebih mudah secara teknis.
Putusan awal rancangan adalah **lulus bersyarat**.

Dokumentasi yang disarankan sebelum implementasi: ADR baru tentang cohort beta
dan control plane; spesifikasi program beta/consent; desain informasi dan state
Harvy Console; arsitektur API, event, data, serta threat model; dan runbook
transisi localhost ke VPS/domain termasuk migrasi, backup, rollback, dan
insiden. `PROJECT`, `STATUS`, `INDEX`, dan `TESTING` diselaraskan ketika ruang
lingkup implementasi benar-benar dipilih.

**Bukti.** `PROJECT.md`, Konstitusi v0.4, `STATUS.md`, seluruh `LOG.md`,
`ADR-009` sampai `ADR-012`, `package.json`, composition root, scope/capability/
kernel harness, telemetry, serta repository berkas diperiksa. Kode membuktikan
batas token sekarang satu nilai global dan website/control plane belum ada.
Tidak ada tes atau perubahan kode produk; hanya catatan keputusan diskusi ini
yang ditambahkan.

**Sengaja ditinggalkan.** Framework web, naskah consent final, masa retensi,
schema database/API/event, autentikasi lokal, rubrik review, dan urutan fase
implementasi belum disahkan atau dibangun.

## 1 Agustus 2026 — Mode beta teramati dibedakan dari privasi yang dilonggarkan

**Kenapa.** Pemilik berencana membagikan Harvy kepada grup bertopik maupun
bebas dan pengguna pribadi, lalu memantau apakah Harvy sesuai, membantu, atau
melakukan hal yang tidak diharapkan. Pemilik mengusulkan privasi akses awal
lebih longgar bila peserta menyepakatinya agar evaluasi lebih mudah.

**Dibahas.** Arah itu dapat diterima hanya sebagai **mode beta teramati** yang
terpisah dan berbatas, bukan izin umum untuk melonggarkan privasi. Persetujuan
wajib ada sebelum pengumpulan, spesifik tentang siapa yang dapat membaca apa,
tujuan evaluasi, masa simpan, serta cara menarik diri dan menghapus data.
Persetujuan tetap tidak membenarkan pengumpulan tanpa batas; Konstitusi Pasal
3.9 menyatakan persetujuan saja tidak membuat semua penggunaan data etis.

Otorisasi pengelola memasukkan Harvy ke grup hanya mengizinkan pemrosesan pesan
baru agar Harvy memahami dan berpartisipasi. Ia tidak otomatis mengizinkan
pemilik produk atau peneliti membaca transkrip. Untuk review manusia, seluruh
peserta sebaiknya masuk secara sukarela ke grup beta khusus dan memberi
persetujuan evaluasi yang terpisah. Anggota baru harus dimintai persetujuan
sebelum pesannya ikut review. Grup kelas, keluarga, atau komunitas yang sudah
berjalan tidak cocok sebagai tempat pertama karena anggota belum tentu bebas
keluar. Grup bebas topik membawa risiko lebih besar daripada grup skenario
karena percakapan pribadi dapat muncul tanpa direncanakan.

Pemantauan disarankan berlapis. Event tanpa isi mencatat keputusan
direct/ambient, `speak`/`silent` dan alasan enum, source balasan
primary/fallback/copy statis, review/guard, delivery, latency, error, dan aksi
memori. Laporan sukarela memungkinkan peserta menandai membantu, menyela,
salah, terlalu ikut campur, mengejutkan soal memori, atau tidak aman, dengan
cuplikan konteks yang mereka pilih sendiri. Review transkrip hanya berada pada
scope beta yang opt-in, menggunakan pseudonim, sampel sesempit mungkin, akses
terbatas dan tercatat, retensi pendek yang diumumkan, serta penghapusan saat
izin ditarik. Giliran sensitif/keselamatan tidak masuk sampling rutin; insiden
penting memakai jalur peninjauan keselamatan yang terpisah dan sempit. Check-in
peserta tetap diperlukan karena log tidak dapat menilai rasa terbantu,
terganggu, dikendalikan, atau dampak dunia nyata.

Urutan pilot yang disarankan: grup beta baru dengan skenario/topik dan seluruh
anggota sadar diamati; lalu grup beta baru tanpa topik; baru kemudian grup nyata
dengan monitoring event-only dan laporan sukarela secara default. Pengguna
pribadi sebaiknya membagikan satu percakapan atau cuplikan secara sadar saat
memberi feedback; review seluruh chat pribadi terus-menerus memerlukan consent
beta khusus dan tetap bukan default produk.

Kemampuan saat ini belum cukup untuk pola tersebut. Operational log sengaja
tidak menyimpan chat, prompt, balasan, atau identitas; raw context grup hanya di
RAM; dan belum ada enrollment beta, consent evaluasi, feedback/report, review
store, dashboard/digest, audit akses, atau kill switch operasional yang mudah.
Membaca berkas history pribadi secara langsung hanya karena tersedia bukan
pengganti persetujuan evaluasi.

**Bukti.** `docs/CONSTITUTION.md` Pasal 1, 2, 3.9, 3.14–15, 7–9;
`ADR-009`; notice grup v6; `STATUS.md`; dan rancangan pemantauan sebelumnya di
LOG diperiksa. Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Naskah consent beta, pilihan retensi, schema event,
alur laporan, review store, kontrol akses, dashboard/digest, dan protokol
insiden belum diputuskan atau dibangun.

## 1 Agustus 2026 — Gemini, balasan aman, dan fallback DeepSeek dievaluasi

**Kenapa.** Pemilik ingin percakapan tetap berlanjut ketika Gemini 3.5 Flash
Lite gagal, DeepSeek V4 Flash cukup mampu menjadi fallback, dan model yang
benar-benar dipakai tercatat tanpa menyimpan isi percakapan.

**Dibahas.** Target itu baru tercapai sebagian. Failover transport runtime
berfungsi: gangguan jaringan/timeout/5xx dan 429 sesuai kebijakan berpindah ke
`DeepSeek-V4-Flash`, membawa prompt serta konteks yang sama, lalu operational
log menulis `ai_fallback_activated` dan `ai_request_completed` dengan
`origin=fallback`; usage observer juga menerima model DeepSeek. Smoke sintetis
yang memaksa primary ke port lokal gagal membuktikan empat tahap—understanding,
triase, reply, dan review—seluruhnya memakai DeepSeek dan tercatat.

Kualitasnya belum cukup untuk disebut fallback transparan. Pada delapan kasus
sintetis yang sama, Gemini lulus invariant 8/8 dan DeepSeek 5/8. DeepSeek salah
intent pada pertanyaan keadaan fisik/lokasi serta permintaan prioritas. Salah
satu larangan lokasi juga merupakan kelemahan evaluator karena frasa "di rumah"
muncul dalam pertanyaan kepada pengguna, bukan klaim lokasi Harvy. Gemini pun
belum sempurna: kasus "pilihin aku ... jangan tanya balik" lulus oracle tetapi
balasannya tidak memilih. Karena itu angka tersebut adalah sinyal perbandingan,
bukan skor mutu final.

Pada skenario bahaya sintetis, Gemini dan DeepSeek sama-sama menggolongkan
`bahaya`. Balasan Gemini lolos review. Dua run DeepSeek menghasilkan kandidat
yang menyebut bantuan konkret dan tetap membuka percakapan, tetapi reviewer
DeepSeek sendiri mengembalikan `false`; runtime kemudian memakai copy bahaya
statis. Fail-closed bekerja, tetapi kesinambungan nada menurun dan keputusan
review DeepSeek tampak tidak stabil terhadap kriteria promptnya sendiri.

Celah terpenting berada di antara transport dan parser. `AiClient` menganggap
setiap teks nonkosong sebagai completion sukses dan mencatatnya sebelum
`parseUnderstanding`, `parseRiskTriage`, atau `parseReplyVerdict`. JSON/schema
yang tidak sah karena itu terlihat sebagai request Gemini sukses, lalu gagal di
lapisan percakapan, tanpa mencoba DeepSeek. Keluaran free-form yang ditolak
pagar grup juga menjadi copy statis atau `silent`, bukan regenerasi fallback.
Ini dapat memutus percakapan walau provider cadangan sehat.

Pencatatan runtime normal memadai secara struktur tetapi belum menyeluruh.
`app.ts` menyuntikkan operational logger dan telemetry, sedangkan lima
probe/evaluator membuat `AiClient` tanpa keduanya; run `--allow-fallback` dari
alat itu tidak mempunyai atribusi aktual per kasus. Ringkasannya hanya berkata
`primary-or-fallback`. Selain itu file log bersifat opsional secara default
(`LOG_FILE_REQUIRED=false`) dan antreannya sengaja berbatas, sehingga
"tercatat" belum merupakan jaminan durabilitas mutlak.

DeepSeek juga lebih lambat pada sampel ini. Smoke bahaya mencatat understanding
8.741 ms, triase 7.943 ms (paralel), reply 1.691 ms, dan review 4.916 ms. Log
Gemini runtime yang tersedia mempunyai p95 sekitar 1.487 ms, 1.103 ms, 1.506
ms, dan 698 ms untuk empat tujuan yang sama. Primary pada smoke sengaja gagal
seketika; kegagalan timeout nyata masih menambahkan waktu tunggu primary.
Belum ada deadline total satu giliran.

Balasan aman tetap menjaga konteks privat karena teks yang benar-benar terkirim
ditulis ke history. Di grup, giliran biasa beserta copy kegagalannya dapat masuk
konteks; isi berisiko sengaja tidak disimpan, tetapi marker minimal selama 30
menit mempertahankan kemungkinan lanjutan pendek tanpa memutar ulang isi
sensitif.

**Bukti.** `npm run build` lulus. Enam suite terarah—client, konfigurasi AI,
keselamatan, giliran grup, telemetry, dan operational logger—lulus **111/111**.
Evaluator nyata dijalankan pada delapan pesan sintetis untuk Gemini primary dan
DeepSeek yang dipaksa lewat fallback. Probe bahaya Gemini dijalankan sekali;
smoke bahaya DeepSeek dijalankan dua kali, seluruhnya tanpa data pengguna.
Operational log smoke terakhir tersimpan sementara di
`%TEMP%/harvy-fallback-eval-KczgAL/harvy-20260801-0001.ndjson`. Tidak ada uji
Telegram/WhatsApp nyata dan tidak ada full corpus.

**Sengaja ditinggalkan.** Tidak ada perubahan kode produk, prompt, kebijakan
failover, copy keselamatan, konfigurasi log, atau evaluator. Perbaikan yang
masih perlu diputuskan adalah fallback setelah validasi semantik, atribusi
model aktual per kasus/turn, deadline total, tes event log klien, penguatan
oracle percakapan, dan pengujian corpus DeepSeek yang lebih luas.

## 1 Agustus 2026 — Arti balasan aman statis dijelaskan

**Kenapa.** Pemilik meminta penjelasan tentang balasan aman yang tetap dapat
dikirim sesudah panggilan Gemini gagal, agar tidak tertukar dengan fallback
provider ke DeepSeek.

**Dibahas.** Balasan aman adalah copy konstan di kode, tanpa panggilan model
lain. Dalam grup, kegagalan biasa memakai kalimat bahwa Harvy sedang tidak
dapat memproses percakapan dan meminta dipanggil lagi. Giliran `dukungan` atau
`bahaya` memakai copy privasi/keselamatan khusus grup; copy itu juga mengganti
balasan model bila review keselamatan gagal atau menolaknya. Jalur privat
mempunyai copy dukungan dan bahaya yang lebih panjang di `src/ai/safety.ts`.

Untuk dua trace grup 30 Juli yang mempunyai `group_reply_generation_failed`
dan `group_reply_review_failed`, balasan yang terkirim pasti berasal dari salah
satu copy keselamatan grup, bukan DeepSeek. Copy mana yang dipilih tidak dapat
ditentukan dari log: isi percakapan dan label risiko sengaja tidak dicatat.

**Bukti.** Konstanta dan percabangannya diperiksa di
`src/core/group-turn-service.ts`, sedangkan fallback privat diperiksa di
`src/ai/safety.ts` dan pemakaiannya di `src/bot/create-bot.ts`. Tidak ada tes
atau perubahan kode produk.

**Sengaja ditinggalkan.** Tidak ada perubahan copy, kebijakan fallback,
logging, maupun telemetry.

## 1 Agustus 2026 — Model pada seluruh log runtime diperiksa

**Kenapa.** Pemilik meminta penyelidikan apakah seluruh panggilan model yang
tercatat selalu memakai Gemini 3.5 Flash Lite.

**Dibahas.** Ya untuk cakupan log runtime yang tersedia. Tiga segmen 30 Juli–1
Agustus memuat 282 event AI dalam lima run: 246 completion, 21 failure, 14
retry, dan satu cancellation. Seluruh event yang membawa model menyebut
`gemini-3.5-flash-lite`; tidak ada `ai_fallback_activated` maupun event dengan
`origin=fallback`. Dari completion, tier yang dipilih mencakup 208 `cheap`, 30
`efficient`, 5 `ambitious`, dan 3 record lama tanpa tier, tetapi semua tier
tersebut dipetakan ke model fisik yang sama.

Penyebabnya cocok dengan konfigurasi: `AI_MODE=testing` dan
`AI_MODEL_TESTING=gemini-3.5-flash-lite`, tanpa override testing per tier.
Fallback `DeepSeek-V4-Flash` memang terkonfigurasi, tetapi tidak pernah aktif
pada runtime yang tersimpan. Pernah ada smoke terpisah 31 Juli yang sengaja
memaksa fallback dan berhasil; itu bukti endpoint cadangan, bukan trafik normal
di ketiga segmen log ini. Konfigurasi produksi juga belum lengkap karena model
`efficient` dan `ambitious` masih kosong.

Penelusuran lanjutan menjelaskan kenapa pemilik dapat merasa fallback pernah
terjadi walau DeepSeek tidak tercatat. Seluruh retry/failure pada log berasal
dari dua run 30 Juli, sebelum provider cadangan ditambahkan pada 31 Juli. Pada
beberapa giliran grup, generasi atau review model gagal tetapi outcome tetap
`replied` karena layanan grup mengirim copy aman yang sudah ada di kode; itu
bukan panggilan AlwaysCodex. `ai_request_retrying` juga berarti percobaan ulang
atau rotasi kunci pada provider utama, bukan perpindahan provider.

Ada celah observabilitas nyata di luar runtime aplikasi. Lima probe/evaluator
(`coba-balasan`, `coba-pemahaman`, dan tiga evaluator percakapan/grup) membuat
`AiClient` tanpa operational logger, sehingga memakai
`NOOP_OPERATIONAL_LOGGER`. Jika operator memilih `--allow-fallback`, pemakaian
DeepSeek dari proses tersebut tidak akan masuk `data/logs/`. Sebaliknya,
`src/app.ts` menyuntikkan logger; fallback runtime normal akan selalu menulis
`ai_fallback_activated`, lalu completion/failure dengan `origin=fallback` dan
model cadangan. Karena kedua jejak itu tidak ada, log yang tersedia tidak
mendukung klaim bahwa runtime aplikasi pernah berpindah ke AlwaysCodex.

**Bukti.** `data/logs/harvy-20260730-0001.ndjson`,
`harvy-20260731-0001.ndjson`, dan `harvy-20260801-0001.ndjson` diparse sebagai
NDJSON; rentang event AI adalah 30 Juli 2026 14:50:05 UTC sampai 1 Agustus 2026
01:05:58 UTC. Nilai model nonrahasia pada `.env`, `resolveModel` di
`src/ai/model-policy.ts`, loader konfigurasi, `STATUS.md`, dan catatan smoke di
LOG diperiksa. Konstruksi `AiClient` pada runtime dan lima script juga
diperiksa. Telemetry memuat 233 penyebutan `gemini-3.5-flash-lite` dan nol
`DeepSeek-V4-Flash`. Tidak ada request model atau tes baru yang dijalankan.

**Sengaja ditinggalkan.** Tidak ada perubahan konfigurasi, pemetaan model per
tier, logger probe/evaluator, atau uji runtime fallback/production.

## 1 Agustus 2026 — Cara pemantauan beta dengan kemampuan saat ini dijelaskan

**Kenapa.** Pemilik meminta langkah konkret untuk memantau Harvy ketika akses
awal grup diberikan.

**Dibahas.** Pemantauan saat ini dapat memakai NDJSON di `data/logs/` untuk
status akun, turn selesai/gagal, outcome `replied`/`silent`, latency, jumlah
bubble/karakter, panggilan model, retry, serta error fingerprint. Rutinitas
minimalnya adalah live tail untuk warning/error dan ringkasan harian outcome,
latency, serta tujuan panggilan model. Telemetry tetap dipakai untuk usage dan
biaya, bukan membaca perilaku sosial.

Log itu belum dapat menjawab apakah satu balasan membantu, menyela, salah
konteks, atau mengejutkan anggota karena isi dan identitas sengaja tidak
disimpan. Sebelum beta melebar, celah tersebut tetap memerlukan event keputusan
yang lebih lengkap, feedback sukarela peserta, dan ringkasan harian yang mudah
dibaca. Pemilik tidak seharusnya memantau dengan merekam seluruh chat secara
diam-diam.

**Bukti.** Konfigurasi `.env.example`, schema telemetry, call site outcome grup,
dan log `data/logs/harvy-20260801-0001.ndjson` diperiksa. Pada snapshot saat
audit terdapat 14 `whatsapp_group_turn_outcome`: 12 `replied`, 2 `silent`, 40
`ai_request_completed`, nol error/fatal, dan satu warning
`whatsapp_local_auth_enabled`. Tidak ada tes atau perubahan kode produk.

**Sengaja ditinggalkan.** Script/digest pemantauan, dashboard, alert, feedback
peserta, mode direct-only, dan kill switch belum dibangun.

## 1 Agustus 2026 — Rancangan pemantauan akses awal grup dibahas

**Kenapa.** Pemilik ingin memberi akses awal kepada grup dan orang yang dipilih
karena pengujian sendiri tidak dapat mencakup semua situasi, tetapi kesulitan
memantau cara Harvy dipakai dan bertindak di grup.

**Dibahas.** Akses awal sebaiknya dimulai di grup beta baru yang memang dibuat
untuk pengujian, bukan langsung di grup pribadi yang sudah berjalan. Seluruh
anggota perlu mengetahui bahwa pemilik produk ikut mengamati beta dan dapat
keluar. Otorisasi pengelola grup untuk pemrosesan Harvy tidak otomatis menjadi
izin bagi peneliti membaca atau menyimpan transkrip untuk tujuan evaluasi.

Pemantauan diusulkan memakai tiga lapis. Pertama, ringkasan event tanpa isi:
direct/ambient, `speak`/`silent` beserta alasan enum, delivery, latency,
supersession, guard/review, error, dan tindakan memori dalam agregat grup/hari.
Kedua, mekanisme laporan sukarela pada balasan Harvy dengan kategori seperti
membantu, menyela, salah, terlalu ikut campur, mengejutkan soal memori, atau
tidak aman; konteks mentah hanya disertakan secara sadar dan sesempit mungkin.
Ketiga, check-in singkat dengan peserta untuk menilai kegunaan, kendali,
gangguan, privasi, dan dampak dunia nyata—bukan jumlah pesan atau retensi.

Log operasional saat ini tidak dapat menjadi alat review perilaku: desainnya
sengaja membuang isi chat, prompt, balasan, identitas, dan label risiko. Ia dapat
menunjukkan kegagalan serta latency, tetapi belum ada collector, dashboard,
alert, event keputusan grup yang lengkap, atau alur laporan pengguna. Karena
fondasi WhatsApp baru terbukti pada satu nomor `open` dan satu balasan dasar,
pilot awal perlu kecil, bertahap, mempunyai kill switch, serta dimulai dari
direct-only sebelum ambient bila mode tersebut nanti disediakan.

**Bukti.** `docs/PROJECT.md`, `docs/CONSTITUTION.md`,
`docs/engineering/STATUS.md`, `docs/LOG.md`, `ADR-009` sampai `ADR-012`,
`src/domain/telemetry.ts`, `src/whatsapp/group-message-batcher.ts`,
`src/core/group-turn-service.ts`, dan allowlist logger diperiksa langsung.
Tidak ada kode produk atau tes yang dijalankan; sesi ini hanya membahas desain.

**Sengaja ditinggalkan.** Desain final notice/consent riset, schema event,
retensi laporan, UI feedback, dashboard/digest, mode direct-only, kill switch,
dan protokol insiden belum diputuskan atau diimplementasikan.

## 1 Agustus 2026 — Kekosongan pengujian yang masih terbuka dipetakan

**Kenapa.** Pemilik menanyakan pengujian apa yang belum dilakukan di Harvy.
Sesi ini hanya mengaudit bukti yang sudah tercatat; tidak mengubah perilaku
produk.

**Dibahas.** Gerbang otomatis terakhir tercatat lulus 454 test dalam 70 suite,
tetapi bagian terbesar yang belum terbukti adalah pengalaman end-to-end setelah
perubahan terbaru. Prioritasnya: dogfood Telegram tujuh hari; uji ulang alur
Telegram untuk bubble, riwayat/memori, onboarding/consent, keselamatan, Harvy
Loop, waktu/check-in, kontrol data, telemetry, dan shutdown; corpus percakapan
privat 42 skenario pada model nyata; kombinasi final corpus/evaluator grup;
serta uji grup WhatsApp nyata yang melampaui satu nomor `open` dan satu balasan
dasar. Pengujian dengan pelajar, naturalness buta oleh manusia, ukuran dampak
Pasal 8, dan deployment jangka panjang juga belum mempunyai bukti.

Daftar ini sengaja tidak memasukkan PostgreSQL, website, toolbox eksternal,
Telegram grup, atau WhatsApp privat sebagai “tes yang gagal dilakukan”, karena
kemampuan itu memang belum dibangun. Bukti lama juga tidak dipakai untuk
mengklaim perbaikan baru lulus end-to-end.

**Bukti.** `docs/PROJECT.md`, `docs/CONSTITUTION.md`,
`docs/engineering/STATUS.md`, `docs/engineering/TESTING.md`, dan `docs/LOG.md`
diperiksa langsung. Tidak ada tes otomatis, probe model, Telegram, atau
WhatsApp yang dijalankan karena sesi ini hanya memetakan status pengujian.

**Sengaja ditinggalkan.** Pelaksanaan pengujian dan penentuan urutan run
berikutnya menunggu permintaan pemilik.

## 31 Juli 2026 — Harness agent bersama dan memori anggota grup dibangun

**Kenapa.** Pemilik meminta Harvy dibangun sebagai harness agent berkualitas
produksi: agentik dan proaktif tanpa melampaui izin, sadar kemampuan serta
keterbatasannya, memakai kecerdasan yang sama di Telegram/WhatsApp, dan
memisahkan konteks/memori per pengguna privat maupun per anggota di tiap grup.
Tool konkret sengaja belum dipilih; pekerjaan ini membangun kontrak aman tempat
tool itu kelak dipasang.

**Yang berubah.**

- `src/harness/` ditambahkan. `scope.ts` membentuk tuple privat
  kanal+owner dan grup kanal+grup+anggota secara injektif.
  `capabilities.ts` menjadi registry tepercaya dengan versi, effect,
  confirmation, idempotency, surface availability, snapshot hash, dan konteks
  kejujuran kemampuan. Snapshot default hanya mengaktifkan surface yang nyata:
  Telegram privat dan WhatsApp grup; Telegram grup/WhatsApp privat tidak
  diklaim hidup. Web search, aksi aplikasi eksternal, dan memori lintas ruang
  dinyatakan belum tersedia.
- `agent-harness.ts` menyediakan loop plan/action/observation berbatas: hanya
  `final`, `need_input`, dan `action`; input wajib JSON; capability+versi dan
  executor divalidasi; write/external meminta approval secara bawaan; run
  mempunyai max-step, deadline, cycle guard, cancellation, observation/reply
  cap, checkpoint serializable, idempotency key, dan generation freshness.
  Approval mengikat run, step, scope, capability, versi, nilai JSON hasil
  validator, dan expiry. Resume menghitung ulang digest+binding, menolak
  executor versi lain, serta memeriksa cancellation/generation sebelum side
  effect. Snapshot capability dibekukan; policy rusak/error gagal tertutup dan
  policy yang menggantung tunduk deadline. `need_input` dapat dilanjutkan pada
  checkpoint/run yang sama. Belum ada executor tool eksternal dan `AiClient`
  belum memakai `tools`/`tool_choice`.
- Satu instance harness disuntikkan ke `Conversation` dan `GroupConversation`.
  Prompt balasan privat, sesi, planner/revalidator, dan balasan grup menerima
  capability snapshot yang sama. Kontrak persona grup dibuat channel-neutral;
  pipeline prompt naik ke `2026-07-31.1`.
- `context-budget.ts` membatasi ringkasan, giliran, dan memori; giliran terbaru
  dipilih lebih dulu. Retrieval privat tidak lagi memasukkan memori
  non-profile yang sama sekali tidak relevan hanya karena slot top-k masih ada.
  Folder owner legacy yang aman dipertahankan; scope dengan delimiter/path
  memakai hash sehingga sanitasi berbeda tidak bertabrakan.
- Database grup dimigrasikan in-memory dari v1 ke v2 dengan
  `GroupMemberMemory`. Memori semantik terpisah per kanal+grup+anggota,
  menggabungkan alias PN/LID dalam scope, dan tidak memakai repository pribadi.
  Record semantik memakai hash alias scoped; pasangan ID mentah masih ada pada
  store sosial legacy untuk bridging platform.
- Notice grup naik ke v6. Pada pesan direct yang tenang/pasti, ekstraksi dan
  triase dapat mengusulkan memori ordinary; catatan diumumkan dengan `📎` pada
  balasan yang sama dan di-rollback bila delivery gagal. Personal atau hasil
  sensitif tidak disimpan otomatis; usulan personal meminta konfirmasi
  eksplisit anggota yang sama dalam 10 menit setelah prompt berhasil dikirim.
  Anggota dapat melihat, mengoreksi, menghapus satu, atau melupakan seluruh
  aktivitas+memorinya. Disable pada repository berkas menulis tombstone dan
  menghapus social/member memory dalam satu commit atomik; fallback lama tetap
  mengulang cleanup bila sempat gagal. Record PN-only dan LID-only yang
  sebelumnya terpisah digabung ketika alias penghubung terlihat.
- `ADR-012`, peta konteks, project brief, README, status kemampuan, dan
  instruksi agent diperbarui. Seluruh klaim membedakan core yang sudah bersama
  dari adapter surface yang belum setara.

**Dibahas.**

- Harvy tetap satu produk; harness adalah lapisan runtime Capybara/Harvy Core,
  bukan identitas produk baru. Kesetaraan Telegram/WhatsApp dicapai dengan core,
  capability contract, dan scope bersama, bukan dengan dua prompt/agent yang
  tumbuh sendiri-sendiri.
- Konteks grup mempunyai dua kelas: room context pendek yang dapat dibaca semua
  giliran di ruang itu, dan semantic member memory yang hanya boleh dibaca saat
  anggota yang sama berbicara dalam grup yang sama. Tidak ada linking lintas
  privat, grup, atau kanal berdasarkan nama/nomor; linking kelak membutuhkan
  verifikasi dan persetujuan eksplisit.
- Proaktif berarti workflow terjadwal/ditawarkan dengan izin, budget, jam
  tenang, dan generation guard. Ia tidak berarti model dapat mengeksekusi aksi
  eksternal sendiri. Safety, consent, kontrol data, dan mutasi yang sudah ada
  tetap workflow deterministik.
- Riset primer yang menjadi dasar: panduan agent OpenAI; tulisan Anthropic
  tentang effective agents, context engineering, long-running harness, dan
  eval; spesifikasi MCP tools/lifecycle; serta prinsip idempotency/cancellation
  dari Temporal, Stripe, RFC 9110, dan observability GenAI OpenTelemetry.
  Rujukan langsung dicatat di `ADR-012`.

**Bukti.**

- `npm run check` lulus.
- `npm test` lulus: **454 test, 70 suite, 0 gagal**. Tes baru mencakup scope
  collision/isolation, surface availability, capability prompt privat/grup,
  context budget, unavailable capability, cycle/deadline/stale result, approval
  tampering dan timestamp, input non-JSON, migrasi repository grup, relevansi
  memori privat, isolasi memori anggota antargrup/anggota, sensitive consent,
  PN/LID merge, koreksi/penghapusan, notice v6, dan rollback delivery.
- Review read-only lanjutan menemukan tujuh P1—TOCTOU hasil validator,
  stale/cancelled resume, executor version swap, policy fail-open/hang,
  `need_input` yang belum resumable, crash window cleanup grup, consent
  sensitif tanpa jalan konfirmasi, dan snapshot mutable. Semuanya diperbaiki;
  tes terarah pascaperbaikan pertama lulus **84 test, 6 suite, 0 gagal**.
- Verifikasi kedua menemukan tiga race lanjutan: generation dapat basi setelah
  policy tetapi sebelum executor, write sensitif tidak ikut rollback bila
  acknowledgment konfirmasi gagal, dan retry removal dapat melewatkan
  penghapusan telemetry setelah commit repository. Ketiganya diperbaiki; tes
  terarah final lulus **88 test, 6 suite, 0 gagal**, lalu gerbang penuh diulang
  saat itu.
- Audit terakhir menemukan dua edge case lagi: cancellation/deadline dapat tiba
  setelah pemeriksaan freshness tetapi sebelum operasi mulai, dan rollback
  konfirmasi sensitif dapat memakai identitas pesan terbaru alih-alih identitas
  proposal ketika PN berganti menjadi LID. Keduanya diperbaiki; tes terarah
  harness+grup lulus **65 test, 0 gagal**, reviewer read-only tidak menemukan
  P0/P1 tersisa, lalu gerbang penuh menghasilkan angka 454/70 di atas.
- Tidak menjalankan evaluator model nyata atau kanal Telegram/WhatsApp nyata;
  suite ini membuktikan kontrak kode dan adapter palsu, bukan kualitas delivery
  produksi atau naturalness model terbaru.

**Sengaja ditinggalkan.**

- Pemilihan dan pemasangan tool aktual: web/RAG, file, kalender, email, MCP,
  dan konektor lain.
- Adapter Telegram grup dan WhatsApp privat. Capability registry secara sengaja
  menandainya unavailable sampai tersambung dan diuji.
- Durable run/checkpoint store, outbox/reconciliation side effect, database
  multi-process, account linking, shared room semantic memory, lifecycle anggota
  keluar, consent sensitif yang tahan restart, dan uji end-to-end notice/memori
  grup nyata.
- False negative serentak ekstraksi+triase untuk isi sensitif tetap dapat
  melewati jalur izin, sama seperti keterbatasan memori privat; ini tidak
  diklaim tertutup.

## 31 Juli 2026 — Model belum memiliki toolbox atau pencarian

**Kenapa.** Pemilik menanyakan apakah Harvy sudah memberikan alat kepada model,
misalnya pencarian web, dan kemampuan apa yang masih belum dibuat. Sesi ini
hanya memeriksa serta menjelaskan keadaan kode; perilaku produk tidak diubah.

**Dibahas.** Model Harvy saat ini belum menerima function-calling toolbox.
`AiClient` hanya mengirim model, messages, temperature, batas token, dan opsi
keluaran JSON; tidak ada `tools` atau `tool_choice`. Model dapat mengusulkan
hasil terstruktur seperti tugas, memori, sinyal sesi, dan ID tindakan adaptif,
tetapi kode Harvy memvalidasi pasangan intent/action, izin, risiko, pemilik,
serta payload sebelum layanan deterministik melakukan mutasi. Karena itu tugas,
pengingat, memori, riwayat, sesi, check-in, dan kontrol data adalah kemampuan
Harvy yang dibantu model, bukan alat bebas yang dapat dipanggil model.

Pencarian web, pembukaan halaman, RAG, sumber dan sitasi, registry alat umum,
kalkulator deterministik, eksekusi kode, pembacaan lampiran/dokumen, integrasi
kalender eksternal, email, dan pengiriman pesan ke orang lain belum ada.
`PROJECT.md` memang menempatkan pencarian/RAG di bagian Later. Di luar toolbox,
pekerjaan produk yang masih terbuka antara lain PostgreSQL dan migrasi,
deployment/backup, website, ukuran keberhasilan, grup Telegram, WhatsApp
pribadi, validasi penuh grup WhatsApp nyata, observabilitas terpusat, serta uji
manual/dogfood yang masih tertunda.

Jika toolbox mulai dibangun, kandidat pertama yang paling sempit risikonya
adalah pencarian baca-saja atas permintaan eksplisit pengguna, dengan sumber,
tanggal, dan sitasi yang dapat diperiksa. Mutasi eksternal seperti menulis
kalender atau mengirim pesan memerlukan konfirmasi terpisah dan tidak boleh
disamakan dengan pencarian.

**Bukti.** `docs/PROJECT.md`, `docs/CONSTITUTION.md`,
`docs/engineering/STATUS.md`, `docs/LOG.md`, `src/ai/client.ts`,
`src/ai/persona.ts`, `src/ai/understand.ts`, `src/bot/create-bot.ts`, serta
composition root diperiksa langsung. Tidak ada tes yang dijalankan karena sesi
ini tidak mengubah kode atau perilaku.

## 31 Juli 2026 — Harvy dibedakan dari harness modelnya

**Kenapa.** Pemilik melihat bahwa sistem yang dibangun mengelilingi model-model
Harvy tampak seperti sebuah harness. Sesi ini hanya memperjelas batas istilah
dan arsitektur; perilaku produk dan kode tidak diubah.

**Dibahas.** Intuisi itu benar untuk lapisan runtime: sistem memilih tier dan
provider, menyusun konteks, membatasi serta memeriksa keluaran model, menjalankan
triase/review keselamatan, mengendalikan tindakan dan state, mencatat biaya,
serta memberi model antarmuka kanal yang stabil. Dalam arti luas, lapisan itu
adalah *model harness* sekaligus lapisan orkestrasi dan tata kelola. Nama yang
paling tepat menurut pembagian yang sudah tercatat adalah **Capybara** untuk
sistem multi-model tersebut dan **Harvy Core** untuk lapisan aplikasi bersama
yang juga memuat layanan deterministik.

Namun **Harvy bukan hanya harness**. Harvy adalah produk dan hubungan yang
dilihat pengguna: identitas, janji moral, memori yang dikendalikan pengguna,
pengelolaan tugas, tutoring, keselamatan, kanal, dan pengalaman percakapan.
Model boleh diganti tanpa mengubah siapa Harvy. Istilah *evaluation harness*
juga sudah mempunyai arti yang lebih sempit di repo, yaitu corpus, evaluator,
dan adapter kanal palsu yang menguji perilaku sistem. Karena itu menyebut seluruh
Harvy sebagai “harness” berguna sebagai intuisi teknis, tetapi terlalu sempit
sebagai definisi produk dan dapat tertukar dengan alat evaluasinya.

**Bukti.** `docs/PROJECT.md`, `docs/CONSTITUTION.md`,
`docs/engineering/STATUS.md`, `docs/LOG.md`, `ADR-003`, dan `ADR-004` diperiksa
langsung. Tidak ada tes yang dijalankan karena sesi ini tidak mengubah kode atau
perilaku.

## 31 Juli 2026 — Urutan dua API testing dikonfirmasi

**Kenapa.** Pemilik menanyakan apakah dua API model pada mode testing berarti
Google AI Studio dicoba lebih dulu lalu AlwaysCodex dipakai bila Google gagal.
Sesi ini hanya menjelaskan perilaku yang sudah ada; kode dan konfigurasi tidak
diubah.

**Dibahas.** Ya, Google adalah primary dan AlwaysCodex adalah fallback khusus
`AI_MODE=testing`. Respons sukses Google langsung dipakai. Timeout, gangguan
jaringan, atau HTTP 5xx berpindah langsung ke AlwaysCodex; HTTP 429 mengikuti
batas rotasi kunci Google pada request itu lebih dulu. Setelah gangguan
provider-wide, atau 429 telah mengenai seluruh kunci Google, circuit melewati
Google selama cooldown bawaan 30 detik lalu mencobanya lagi. Cancellation
lifecycle, HTTP 4xx selain 429, keluaran rusak, dan penolakan batas lokal tidak
memicu fallback. Bila AlwaysCodex ikut gagal, request berakhir gagal dan tidak
berputar kembali ke Google. Production tetap tidak memakai fallback testing.

**Bukti.** `docs/PROJECT.md`, `docs/CONSTITUTION.md`,
`docs/engineering/STATUS.md`, `docs/LOG.md`, `src/config.ts`,
`src/ai/client.ts`, dan `.env.example` diperiksa langsung. Tidak ada tes yang
dijalankan karena sesi ini tidak mengubah perilaku.

## 31 Juli 2026 — Provider cadangan testing ditambahkan tanpa mencampur baseline evaluasi

**Kenapa.** Setelah diagnosis rentetan `AbortError` Google menunjukkan satu
tahap dapat menghabiskan dua timeout karena rotasi kunci, pemilik meminta
AlwaysCodex sebagai API backup selama testing. Perubahan ini menyentuh isi pesan
yang dapat dikirim ke provider kedua, sehingga bukan sekadar pergantian URL:
kontrak retry, cancellation, privasi, notice grup, dan cara membaca hasil
evaluasi harus ikut dijaga.

**Yang berubah.**

- `AiClient` kini menerima satu provider cadangan. Timeout, gangguan jaringan,
  dan HTTP 5xx primary langsung berpindah provider; HTTP 429 tetap merotasi
  kunci primary lebih dulu sampai batas percobaan request (default seluruh
  kunci). Cancellation lifecycle, HTTP 4xx lain, keluaran kosong/terpotong,
  dan penolakan usage lokal tidak memicu failover. Kegagalan provider-wide
  atau 429 yang telah mengenai seluruh kunci primary membuka circuit in-memory
  selama 30 detik secara bawaan; 429 pada satu key dari request yang dibatasi
  tidak ikut menutup key lain bagi request berikutnya.
- Request cadangan mengganti model di body, query, dan telemetry. API key selalu
  dikirim sebagai `Authorization: Bearer`; redirect ditolak dan base URL
  testing divalidasi sebagai HTTPS tanpa kredensial, query, fragment, atau
  akhiran endpoint penuh. Event operasional membawa `origin` dan alasan
  failover tanpa isi percakapan. Redaksi defense-in-depth kini juga mengenali
  parameter bernama `apikey`.
- Konfigurasi `AI_TESTING_FALLBACK_BASE_URL`,
  `AI_TESTING_FALLBACK_API_KEY`, dan `AI_TESTING_FALLBACK_MODEL` harus hadir
  bersama; cooldown terpisah dapat diatur. Production selalu mengabaikan
  konfigurasi tersebut. Nilai nyata disimpan hanya pada `.env` yang di-ignore;
  `.env.example` memuat placeholder serta batas pemakaiannya.
- Composition root memakai cadangan secara otomatis. Dua script probe dan
  evaluator percakapan/ambient/direct sengaja primary-only secara default;
  `--allow-fallback` hanya untuk run availability dan ringkasan menyatakan
  `fallbackAllowed` serta `modelScope`; probe menampilkan model cadangan saat
  flag itu dipakai agar kualitas tidak salah atribusi.
- Persetujuan pribadi naik dari versi 2 ke 3 dan notice grup dari versi 4 ke 5.
  Naskahnya menjelaskan bahwa satu atau lebih layanan pihak ketiga dapat
  memproses pesan dan request yang sama dapat dikirim ulang ke provider
  cadangan. Pengguna lama maupun grup yang baru melihat versi sebelumnya harus
  melihat naskah baru sebelum diproses.
- Tes klien, konfigurasi, onboarding, migrasi consent/notice, dan redaksi
  diperluas. README, `AGENTS.md`, `PROJECT.md`, `ADR-003`, status kemampuan,
  serta panduan pengujian diselaraskan.

**Dibahas.**

- Dokumentasi AlwaysCodex menampilkan ID kanonis `DeepSeek-V4-Flash` dan
  menjelaskan endpoint v3 sebagai proxy transparan ke upstream. Ejaan kanonis
  dipakai di `.env`; model tidak ditulis mati di kode atau contoh publik.
- Failover adalah kemungkinan pemrosesan ganda. Primary dapat sudah menerima
  request ketika timeout lokal terjadi, lalu cadangan menerima request yang
  sama. Kebijakan privasi/retensi AlwaysCodex dan upstream-nya belum
  diverifikasi, sehingga provider ini hanya dinyatakan layak untuk data
  sintetis/dogfood testing, bukan production.
- Request pertama saat primary rusak masih dapat memakan timeout primary
  ditambah timeout cadangan. Circuit mengurangi pengulangan pada request
  berikutnya, tetapi deadline total lintas seluruh tahap satu turn belum ada.

**Bukti.**

- `npm run check` lulus.
- `npm test` lulus: **409 test, 65 suite, 0 gagal**.
- Tujuh berkas tes terarah klien/config/adapter/onboarding/profile/grup/logger
  lulus 119 test, 10 suite, 0 gagal.
- Endpoint daftar model diperiksa tanpa kunci. Smoke pertama dengan ejaan model
  lowercase dan satu percobaan kanonis ketika kanal belum siap menghasilkan
  HTTP 503 `model_not_found`. Sesudah memakai ID kanonis, request sintetis
  OpenAI-compatible dengan Bearer header berhasil HTTP 200. Smoke melalui
  `AiClient` dengan primary yang sengaja gagal lokal juga berhasil memakai
  cadangan dan menerima balasan dua karakter.
- `git diff --check` lulus selain peringatan normalisasi LF/CRLF. Pemindaian
  nilai kunci terhadap seluruh tracked file menemukan nol kecocokan, dan
  `git check-ignore -v .env` memastikan file runtime tetap di-ignore.
- Dua agent read-only mengaudit arsitektur failover serta privasi/cakupan tes;
  root tetap satu-satunya penulis.

**Sengaja ditinggalkan.** Tidak ada perubahan provider production, commit,
push, corpus evaluasi masif, atau uji Telegram/WhatsApp nyata. SLA, kualitas
percakapan panjang, ketentuan privasi/retensi provider cadangan, deadline total
satu turn, circuit terdistribusi lintas proses, dan failover antar akun
WhatsApp belum diklaim selesai.

## 30 Juli 2026 — Rentetan `AbortError` grup didiagnosis sebagai timeout AI

**Kenapa.** Pemilik menunjukkan log empat giliran WhatsApp grup yang berulang
menulis `ai_request_retrying` dan `AbortError`, dengan latency akhir 57–77
detik. Sesi ini hanya mendiagnosis; perilaku produk tidak diubah.

**Dibahas.**

- Bukti NDJSON di `data/logs/harvy-20260730-0001.ndjson` menunjukkan runtime
  memakai `AI_MODE=testing`, endpoint Google bawaan, model
  `gemini-3.5-flash-lite`, dua kunci, dan tanpa pemetaan model testing per tier.
- Semua kegagalan berhenti tepat pada timeout request yang ditulis di log:
  risk triage 12 detik, reply review 8 detik, group reply 15 detik, dan planner
  8 detik. Tidak ada status HTTP pada kegagalan ini; `fetch` dibatalkan timer
  lokal sebelum respons diterima. Satu risk triage lain selesai dalam 1.069 ms,
  sehingga bukti tidak mendukung putus koneksi total. Penyebab di sisi seberang
  timer—provider yang tersendat, koneksi intermiten, atau antrean/limit
  provider—belum dapat dibedakan dari log sekarang.
- `ai_request_retrying` baru ditulis setelah attempt pertama sudah timeout.
  Karena ada dua kunci, risk triage dan review mencoba kunci kedua segera dan
  dapat menghabiskan masing-masing 24 dan 16 detik. Trace `27727adf-...`
  menggabungkan 2 × 12 detik triase, 15 detik generasi, dan 2 × 8 detik review;
  durasi turn yang tercatat 56.897 ms sesuai rentetan itu.
- Ketika FIFO grup sibuk, triase prioritas berjalan sebelum turn masuk FIFO.
  Bila preflight itu gagal dan menghasilkan `null`, pemrosesan normal
  menjalankan triase fail-closed lagi. Ini menjelaskan dua rentetan triase pada
  trace `4fa8b33b-...` dan `94a05409-...`, sekaligus memperbesar backlog ketika
  penyedia sedang lambat.
- Outcome `replied` tidak membuktikan model berhasil: direct call masih dapat
  mengirim fallback aman setelah generasi/review gagal. Outcome `silent` pada
  ambient setelah planner atau triase gagal juga merupakan perilaku fail-closed,
  bukan crash proses.

**Bukti.** File log diperiksa per trace dan dikelompokkan berdasarkan purpose.
Empat turn selesai dengan latency 57.251, 70.480, 77.278, dan 64.467 ms. Dari
request yang terlihat, hanya satu risk triage selesai; lima rentetan risk
triage, dua reply review, dua group reply, dan satu planner berakhir timeout.
Kode `AiClient`, `GroupTurnService`, `Conversation`, konfigurasi runtime aman
tanpa nilai kunci, serta batas waktunya diperiksa langsung. Tidak ada request
model baru, perubahan kode, atau tes yang dijalankan.

**Sengaja ditinggalkan.** Belum diterapkan deadline total satu turn, backoff
dan circuit breaker provider, pembedaan timeout internal dari cancellation
lifecycle pada telemetry, maupun kebijakan agar preflight gagal tidak
menggandakan triase panjang di FIFO. Itu merupakan perbaikan, sedangkan
permintaan sesi ini hanya diagnosis.

## 30 Juli 2026 — Percakapan grup dibuat ambient, cepat, dan dapat dievaluasi

**Kenapa.** Pemilik produk melaporkan tiga kegagalan pengalaman grup: Harvy
diam bila namanya tidak dipanggil/di-reply, balasannya tidak natural, dan pesan
berikutnya tertahan terlalu lama. Ia meminta evaluasi masif lintas topik,
perbaikan otonom, serta riset cara manusia mengetik. Tiga agent read-only
mengaudit pipeline, desain evaluator, dan literatur percakapan multi-party;
root tetap satu-satunya penulis sesuai aturan kepemilikan repositori.

**Yang berubah.**

- `BaileysAccountManager` tidak lagi menunggu pekerjaan AI pada listener
  ingress. Refresh metadata berjalan di latar dengan timeout, typing direct
  best-effort, dan lifecycle dipecah menjadi stop-ingress, drain-event, lalu
  close. `GroupMessageBatcher` mengobservasi pesan baru sebelum speaker switch,
  memakai settle direct 350 ms versus ambient 1,2 detik, membawa quote/revision,
  dan mencatat latency sejak enqueue.
- `GroupTurnService` kini memakai observation revision serta generation per
  scope+account. Duplicate, replay sebelum join, dan akun non-binding tidak
  membatalkan kandidat sah. Alias vocative seperti “Kapi, bantu” masuk direct,
  sementara penyebutan Harvy sebagai topik tidak. Direct membatalkan planner
  ambient aktif dan tidak menghabiskan budget sosial.
- Cooldown global 60 detik diganti budget adaptif. Planner ambient hanya boleh
  bicara untuk pertanyaan belum terjawab, konteks berguna, koreksi fakta, atau
  banter yang mengundang. `group-turn-policy.ts` menahan acknowledgment, izin,
  dan penutup koordinasi pendek tanpa request model.
- Kandidat bernilai tinggi yang tersusul dapat menjadi satu pending candidate:
  menunggu quiet gap 900 ms, paling lama 15 detik/empat giliran, lalu
  direvalidasi terhadap konteks terbaru. Watermark settled memastikan timer
  900 ms tidak mendahului bubble yang sudah terlihat tetapi masih berada dalam
  settle ambient 1,2 detik. Direct, bahaya, kelanjutan target, quote target,
  removal, dan shutdown membatalkan timer sekaligus request revalidation atau
  fact-reply yang sedang aktif. Fact correction diregenerasi melalui tier
  `efficient`; pagar output menolak pengalaman fisik palsu, DM/japri,
  diagnosis/tuduhan pasti, jaminan transaksi, dan keluaran ambient panjang.
- Urgent ACK mendapat reservation/dedupe, pemeriksaan binding/join, batas empat
  triase aktif serta antrean 32. Removal menaikkan generation sebelum I/O dan
  seluruh send/state memeriksanya lagi. Audit race menutup implicit activation
  sesudah self-remove, penulisan ulang notice/alias/konteks/marker risiko, serta
  usage yang tertinggal. Cache metadata/admin kini dikosongkan pada reconnect
  dan memakai epoch per grup agar refresh lama tidak hidup lagi setelah
  removal. Shutdown menguras event selagi socket masih hidup, kemudian
  batch/pending, baru socket, telemetry, dan logger.
- Prompt grup memakai giliran chat beridentitas dan persona grup tersendiri.
  Panduannya memahami lowercase, singkatan, code-mix, elongation, emoji, dan
  beberapa bubble tanpa meniru typo atau mengarang pengalaman manusia.
- `group-eval-corpus.ts` memuat 15 topik, 150 skenario semantik × empat variasi
  permukaan (600 ambient), serta 60 episode generasi direct.
  `evaluasi-grup.ts`/`evaluasi-grup-direct.ts` menyimpan seluruh JSONL,
  seed/versi/hash, strict versus preference, konsistensi cluster, dan latency.
  Provider failure, harness/config failure, dan product failure dipisahkan;
  run tanpa sampel menghasilkan `null` dan tetap gagal. Fact-check direct
  terbaru wajib menantang klaim pada semua topik.
- Keputusan dicatat sebagai `ADR-011`; status, testing, project, README,
  AGENTS, index, dan artefak audit di
  `docs/evidence/group-conversation-2026-07-30/` ikut diperbarui.

**Dibahas.** Riset primer mengubah definisi “natural” dari kosmetik bahasa
menjadi keputusan sosial. Addressee eksplisit hanya sekitar 20% giliran pada
corpus Inoue dkk. dan benchmark mereka menunjukkan pengenal addressee LLM tetap
sulit; corpus Kummerfeld dkk. menunjukkan satu stream berisi thread
berselang; turn-taking sebaiknya dikondisikan pada respons yang hendak
diberikan. Karena itu Harvy tidak boleh sekadar menunggu tag, menghitung tanda
tanya, atau membuat typo palsu. Natural berarti memahami target, ritme,
register, novelty, dan kapan diam. Rujukan primer dicatat di `ADR-011`.

Angka “600 percakapan” diluruskan menjadi 150 skenario semantik dengan empat
transformasi. Episode direct menguji generasi **sesudah** routing; pengenalan
alias produksi dibuktikan tes service. Metrik aturan wajib dan preferensi tidak
lagi dicampur. Agent evaluator juga menemukan hasil kosong sebelumnya dapat
terlihat sempurna dan HTTP 400/bug lokal dapat tersamar sebagai provider
failure; keduanya ditutup beserta tes regresinya.

**Bukti.**

- `npm run check` PASS.
- `npm run build` PASS.
- Tes terarah percakapan grup, manager Baileys, dan percakapan model grup
  sempat PASS **61 test dalam 3 suite**; setelah jendela read-konteks terakhir
  ditutup, file `group-turn-service` final PASS **41/41**.
- `npm test` resmi terakhir PASS: **390 test, 64 suite, 0 gagal** (exit `0`;
  96,3 detik wall time termasuk build, 74,2 detik test runner). Run penuh
  sebelumnya menyelesaikan 388/389 dan menemukan satu flake pada assertion
  timer `MessageBatcher` Telegram: deadline perilaku tetap 35 ms, tetapi batas
  tunggu tes 250 ms habis ketika 64 suite membebani event loop. Batas assertion
  dibuat 1,5 detik tanpa mengubah runtime; kasus tunggal lalu PASS dan run penuh
  kedua PASS seluruhnya.
- Model testing `gemini-3.5-flash-lite`, pipeline `2026-07-30.4`: run ambient
  lama 600 variasi memperoleh 584/600 menurut evaluator v3, strict pass rate
  0,993, dan p50/p95/p99 request planner 860/1.443/2.966 ms. Audit manual
  menemukan 13 dari 16 hard failure adalah oracle kata-kunci sempit dan tiga
  false-positive sebenarnya berada pada human-flow.
- Sesudah pagar bentuk lokal, 60/60 variasi human-flow diam; 36 ditahan lokal,
  24 dinilai model, p95 request 1.599 ms.
- Run direct lama menghasilkan balasan 60/60 dengan p50/p95/p99
  878/1.378/1.767 ms. Bukti ini diturunkan menjadi coverage/pagar bentuk karena
  oracle fact-check versi itu belum kuat.
- Run fact-correction berikutnya **INCOMPLETE dan tidak sah sebagai skor**:
  35/60 request terkena HTTP 429; evaluator lama mencampurnya dengan product
  failure. Runner baru memisahkannya, tetapi tidak dipanggil lagi agar tidak
  terus menekan kuota.

**Sengaja ditinggalkan.** Belum ada run penuh corpus v5/evaluator v4,
penilaian naturalness buta oleh manusia, latency end-to-end WhatsApp, atau uji
perilaku lengkap di grup nyata. Reply ke anggota lain tetap sangat
konservatif; conversation disentanglement belum sempurna; delayed candidate
dapat kehilangan native quote bila cache transport kedaluwarsa. Auth Baileys
tetap beta lokal satu proses, bukan penyimpanan produksi. Tidak ada commit atau
push pada sesi ini. Audit ulang agent setelah lima perbaikan race tidak selesai
karena kuota agent habis; bukti akhirnya adalah review root, tes reproduksi, dan
suite penuh—bukan klaim audit independen kedua.

---

## 29 Juli 2026 — Log operasional produksi dibuat dan dipagari dari data percakapan

**Kenapa.** Setelah koneksi WhatsApp nyata berhasil, keluaran logger bawaan
Baileys terbukti sangat bising dan membawa object protokol seperti history
notification, media key, serta direct path. Pemilik produk lalu meminta sistem
pencatatan kualitas perusahaan agar semua lifecycle, tahap, durasi, fallback,
dan kegagalan Harvy dapat dievaluasi. “Semua” ditetapkan sebagai semua kejadian
teknis yang relevan, bukan izin membuat arsip baru berisi kehidupan pengguna.

**Yang berubah.**

- `src/observability/operational-logger.ts` membuat sink NDJSON append-only
  schema `harvy.operational-log.v1`: timestamp UTC, release/environment,
  run/sequence/PID/host, component/event, trace per ingress, scalar teknis
  allowlist, dan error metadata-only. Deskripsi call site, `Error.message`,
  thrown string, isi chat, prompt/balasan, identitas pengguna/grup, nomor,
  payload mentah, QR, token, dan kredensial tidak dipersistenkan. Error hanya
  membawa tipe yang dikenal, kode/status berformat tertutup, frame stack tanpa
  baris pesan, cause terbatas, dan fingerprint.
- Writer mempunyai antrean record+byte berbatas, prioritas `warn/error`,
  emergency append sinkron, rotasi ukuran/hari UTC, retensi dan cap total disk,
  permission best-effort, mutex untuk append/rotasi/maintenance/close, serta
  repair tail crash sampai newline valid terakhir. Health memisahkan kesehatan
  tulis dan retensi; append yang pulih tidak menutupi retensi yang masih gagal.
  `LOG_FILE_REQUIRED=true` menggagalkan startup bila sink atau retensi awal
  wajib tidak sehat.
- Jalur emergency kini ikut tunduk pada batas segmen/total agar error storm
  tidak menghabiskan disk; record yang tidak lagi muat dihitung sebagai drop.
  Byte writer normal dipesan sebelum `await` pertama agar emergency append
  yang masuk bersamaan tidak dapat melampaui cap satu record.
  Retensi memakai tanggal UTC nama segmen, sehingga copy/restore tidak
  memperpanjang atau memendekkan umur log. Bila sink opsional gagal, stderr
  tersaring dipaksa aktif meski konfigurasi console semula mati.
- Console memakai JSON atau pretty tanpa data tambahan. Sinyal backpressure
  menghentikan penulisan berikutnya sampai `drain`, menghitung yang dilewati,
  dan mencatat onset/recovery ke file agar buffer proses tidak tumbuh tanpa
  batas. Kegagalan sink opsional tetap membiarkan kanal berjalan lewat console
  yang sudah dipagari.
- `AsyncLocalStorage` menghubungkan tahap satu update Telegram atau giliran
  WhatsApp tanpa memakai ID pengguna. Lifecycle model, batch bubble, worker,
  telemetry/history, delivery/fallback, status akun, retensi, startup, dan
  shutdown kini masuk logger. Handler `uncaughtException` dan
  `unhandledRejection` menulis fatal secara sinkron lalu keluar status 1;
  logger dikuras paling akhir pada shutdown normal.
- Adapter logger Baileys membuang info/debug dan seluruh object mentah,
  meneruskan hanya kategori serta scalar yang dikenal, dan menganggap restart
  `515` setelah pairing sebagai lifecycle biasa. Banyak nomor tetap dapat
  dibedakan lewat alias operasional stabil; parser kini mewajibkan alias
  diawali huruf dan melarang nomor/JID dipakai sebagai ID.
- QR dan pairing code dipisahkan total dari logger. Secret hanya boleh tampil
  pada TTY lokal ketika `APP_ENV` bukan `production`; production dan pipe
  noninteraktif menolaknya. Kegagalan renderer QR memakai error sintetis agar
  input QR pihak ketiga tidak mungkin ikut terlempar ke logger.
- Konfigurasi `APP_ENV`, `RELEASE_SHA`, dan seluruh `LOG_*` ditambahkan.
  Kesalahan konfigurasi mempunyai code operasional stabil tanpa perlu
  menyimpan pesannya. Segmen log diabaikan Git meski `LOG_FOLDER` diarahkan ke
  folder lain dalam repository.
- Detail persetujuan Telegram dan notice grup v4 menjelaskan data teknis yang
  dicatat. Nilai retensi file lokal diambil dari deployment aktual; keduanya
  jujur bahwa retensi Docker/systemd/cloud collector adalah kebijakan
  infrastruktur terpisah yang tidak dapat ditegakkan Harvy.
- `ADR-010`, README, PROJECT, STATUS, TESTING, `.env.example`, `.gitignore`,
  INDEX, dan AGENTS diselaraskan. Uji baru mencakup schema, trace concurrent,
  rotasi, maintenance concurrent, retensi, tail crash, sink opsional/wajib,
  queue pressure, console backpressure, object Baileys mentah, sentinel bahasa
  alami pada error/rejection/deskripsi, JID device, nomor pendek, konfigurasi,
  alias akun, secret operator, notice retensi aktual, fallback stderr, tanggal
  retensi tahan-copy, dan error storm berbatas disk.

**Dibahas.** Log operasional sengaja tetap terpisah dari telemetry pengguna.
File lokalnya bukan audit trail immutable atau SIEM. `LOG_RETENTION_DAYS` hanya
menghapus file yang Harvy kuasai; collector perusahaan wajib mempunyai kontrol
akses, enkripsi, alert, backup, dan retensi sendiri. Menghapus data pengguna
tidak mencari record operasional karena record tersebut sengaja tidak membawa
identitas yang dapat dipetakan kembali kepadanya.

**Bukti.**

- `npm run check` — **PASS**.
- Tes terarah logger dan konfigurasi — **PASS, 18 test dalam 2 suite**.
- `npm test` — **PASS, 345 test dalam 60 suite, 345 lulus, 0 gagal**.
- Pengujian memakai sentinel sintetis dan fake stream/socket; tidak ada data
  pengguna nyata maupun panggilan model eksternal.
- Audit race normal/emergency diulang 20 kali pada cap segmen/total 800 byte;
  seluruh percobaan tetap dalam batas dan tidak menyisakan temuan P0/P1/P2.

**Sengaja ditinggalkan.** Belum ada soak test deployment jangka panjang,
simulasi disk penuh/ACL production, collector/SIEM, dashboard health, alert,
auth store WhatsApp terenkripsi, atau uji ulang pairing/grup nyata setelah
logger baru. Jalur manualnya sudah ditulis di `docs/engineering/TESTING.md`,
tetapi statusnya tetap belum diuji sampai benar-benar dijalankan.

---

## 29 Juli 2026 — Model Capybara dan fondasi grup WhatsApp multi-nomor dibuat

**Kenapa.** Pemilik produk memberi izin menulis kode setelah menetapkan bahwa
Harvy harus memperkenalkan sistem AI-nya sebagai **model Capybara**, tetap
jujur sebagai AI, dan memakai beberapa model alih-alih mengaku bergantung pada
satu model dasar. Pemilik juga meminta implementasi grup WhatsApp memahami
Baileys resmi dan dapat menjalankan banyak nomor Harvy.

**Yang berubah.**

- `baileys@7.0.0-rc14` ditambahkan sebagai dependency. `WHATSAPP_ACCOUNTS`
  menerima registry banyak nomor; setiap account ID mempunyai auth folder,
  socket, cache berbatas, generation, status, pairing, reconnect, dan lifecycle
  event sendiri dalam satu proses.
- Account manager hanya meneruskan `messages.upsert` bertipe `notify`, mengabaikan
  history/echo/nonteks, mempertahankan metadata tag/reply/admin, menunggu save
  credentials sebelum reconnect, melanjutkan sisa array bila satu pesan gagal,
  menangani self-add/re-add serta self-remove, dan menguras pekerjaan event saat
  shutdown dengan `socket.end(undefined)`.
- Pipeline grup baru terpisah total dari profil, memori, history, tugas, dan
  sesi pribadi. Binding `channel+group` menolak akun kedua dan tidak failover
  otomatis. Notice v3 menjelaskan bahwa pesan live pemicu ikut diproses,
  telemetry tanpa isi, dan binding teknis minimum; notice dikirim saat aktivasi
  sebelum pemrosesan.
- Burst bubble anggota yang sama digabung setelah 1,2 detik tanpa membuang ID
  bubble, hanya bila bubble itu berurutan dari pengirim dan akun yang sama.
  Batch mempunyai deadline serta batas jumlah/karakter; account ID masuk kunci
  agar dua nomor tidak bercampur. Tag, reply, dan julukan menjadi panggilan
  langsung; pesan ambient memakai planner dan cooldown. Bahaya yang datang di
  belakang giliran lambat mendapat acknowledgment tetap di luar FIFO, sedangkan
  balasan lengkap tetap berurutan dan direview fail-closed.
- Memori grup menyatukan PN/LID, menyimpan nama tampilan/koreksi dan statistik
  harian per grup, membatasi dedupe 24 jam, aktivitas 30 hari, ranking 7 hari,
  serta menjalankan purge saat akses, startup, dan berkala. Raw context berada
  maksimal dua jam di RAM; pesan dan balasan sensitif/berisiko tidak masuk.
  Penanda risiko tanpa isi bertahan 30 menit untuk tindak lanjut pendek.
  Removal menghapus seluruh memori sosial dan telemetry grup, menyisakan
  binding akun minimum agar nomor lain tidak mengambil alih diam-diam.
- Anggota dapat melihat memori, mengoreksi nama, dan meminta penghapusan diri;
  admin dapat menambahkan julukan Harvy dan meminta reset grup. Penghapusan dan
  reset memerlukan konfirmasi kedua yang terikat identitas selama 10 menit.
- Pertanyaan identitas murni seperti “kamu ChatGPT?” dijawab deterministik
  tanpa model dasar: Harvy adalah AI dengan sistem multi-model bernama
  Capybara. Fast path hanya dipakai tanpa episode chat yang masih hangat;
  pesan campuran dan lanjutan episode tetap melewati pemahaman/triase agar
  permintaan lain maupun keselamatan tidak ditimpa identitas.
- Review terakhir memperketat nomor fisik duplikat, urutan ingress per akun+
  grup, kompensasi dedupe/statistik saat send gagal, filter arsip pesan
  protokol, PN/LID pada penghapusan diri, dan self-remove nomor non-binding.
- Percobaan pairing code nyata tersambung ke server lalu ditolak `401` sebelum
  kode tampil, menyisakan auth `registered: false`. Ini cocok dengan isu
  upstream Baileys yang melaporkan pairing-code gagal sementara QR tetap
  berhasil. `WHATSAPP_PAIRING_MODE=qr` kini default, QR dirender lokal di
  terminal, dan state pairing-code parsial dibersihkan otomatis tanpa
  menghapus folder/key auth. Mode `code` tetap tersedia eksplisit.
- Pemindaian QR nyata kemudian mencapai `pair-success`; server menutup stream
  dengan `515` agar companion memulai ulang koneksi, sesuai alur Baileys.
  Reconnect sempat menampilkan QR kedua karena pembersih state parsial salah
  memakai keberadaan `creds.me` sebagai tanda pairing-code gagal. Padahal
  pair-success QR memang mengisi `me` sebelum restart. Pembersih kini hanya
  berjalan bila `pairingCode` benar-benar tersisa, sehingga identitas hasil QR
  bertahan untuk jalur login berikutnya. Auth yang sudah tertimpa pada
  percobaan pertama memerlukan satu pemindaian ulang setelah perbaikan.
- Pemindaian ulang setelah perbaikan berhasil masuk jalur `logging in`,
  mengunggah pre-key awal, mencapai status `open`, membuat sesi LID, dan
  membalas pesan di grup nyata menurut laporan pemilik. Log bootstrap sempat
  gagal membaca key app-state `critical_block`, tetapi Baileys menerima key
  sesudahnya, menyinkronkan ulang, lalu mencatat `synced critical_block to v1`;
  jadi kegagalan itu pulih sendiri dan tidak memutus koneksi.
- Logger bawaan Baileys berjalan pada level info dan mencetak history
  notification lengkap, termasuk payload terenkripsi, media key, serta direct
  path. Kebijakan Harvy tetap menolak `INITIAL_BOOTSTRAP` dan `RECENT`
  (`process:false`) serta hanya menerima data protokol minimum seperti push
  name dan mapping PN/LID. Isi panjang itu bukan bukti Harvy mengimpor riwayat
  chat, tetapi lognya terlalu bising dan tidak layak dibagikan atau disimpan
  tanpa redaksi.
- Runtime, `.env.example`, README, PROJECT, STATUS, TESTING, ADR-009, INDEX,
  AGENTS, dan kontrak notice diselaraskan dengan perilaku aktual.

**Bukti.**

- `npm run check` — **PASS**.
- Tes terfokus konfigurasi/pairing/account manager — **PASS, 15/15**.
- `npm test` — **PASS, 325 test dalam 58 suite**.
- Normalisasi, banyak socket, pemisahan auth, reconnect, save credentials,
  self-add/remove, kegagalan satu pesan, drain event, batching, PN/LID,
  isolation, retensi, konfirmasi, removal race, konteks keselamatan, dan
  acknowledgment bahaya diuji memakai adapter/socket palsu.
- API dan batas operasional diperiksa pada dokumentasi resmi:
  [`README` Baileys](https://github.com/WhiskeySockets/Baileys/blob/master/README.md),
  [`Connecting`](https://baileys.wiki/docs/socket/connecting/),
  [`History Sync`](https://baileys.wiki/docs/socket/history-sync/), dan
  [`Security`](https://github.com/WhiskeySockets/Baileys/security).
- Pairing code dan koneksi awal sudah benar-benar dicoba: WebSocket tersambung,
  tetapi `companion_hello` ditolak `401` sebelum kode keluar. QR, pair-success,
  restart `515`, login, status `open`, dan satu balasan grup nyata sudah
  terlihat. Restart proses memakai auth tersimpan, pengujian dua nomor nyata,
  notice, kualitas planner sosial, memori, removal, dan jalur keselamatan tetap
  **NOT RUN**.
- Isu pembanding upstream:
  [`#2702`](https://github.com/WhiskeySockets/Baileys/issues/2702) dan
  [`#2364`](https://github.com/WhiskeySockets/Baileys/issues/2364).

**Sengaja ditinggalkan.** Auth multi-file masih khusus beta lokal; produksi
memerlukan database terenkripsi dan single writer. Penambahan nomor serta
pembagian grup masih konfigurasi operator, bukan load balancer otomatis.
Binding yang sudah dimiliki account ID lain tidak dapat direbind diam-diam.
Memori semantik grup (keputusan bersama, budaya, inside joke), WhatsApp
pribadi, dan grup Telegram belum dibuat.

---

## 29 Juli 2026 — Konstitusi v0.4 dan arah banyak nomor Baileys ditetapkan

**Kenapa.** Pemilik produk meminta konflik otorisasi grup diselesaikan dengan
mengubah Konstitusi, lalu meminta arsitektur WhatsApp dipastikan dapat
menampung banyak nomor Harvy melalui Baileys. Izin ini mencakup dokumentasi dan
keputusan produk; kode tetap tidak boleh dibuat.

**Yang berubah.**

- `CONSTITUTION.md` naik dari v0.3 menjadi **v0.4**, bertanggal 29 Juli 2026.
  Catatan revisi menyebut alasan, hak yang berkurang, manfaat, risiko, dan
  perlindungannya.
- Pengelola yang sengaja menambahkan Harvy kini mengotorisasi pemrosesan pesan
  baru di grup tanpa consent individual. Harvy tetap wajib mengumumkan bahwa
  dirinya AI dan pesan dapat diproses penyedia eksternal; ia dilarang mengimpor
  riwayat sebelum masuk.
- Memori grup diikat ke identitas grup, tidak masuk ke chat pribadi atau grup
  lain, tidak membentuk profil global, tetap melarang penyimpanan sensitif
  otomatis, dan mempunyai hak lihat/koreksi/hapus.
- Contoh penerapan Konstitusi ditambah untuk grup terotorisasi, kebocoran
  lintas konteks, dan impor riwayat lama.
- `PROJECT.md`, `INDEX.md`, `README.md`, dan `STATUS.md` diselaraskan: hanya ada
  satu produk bernama Harvy; kapibara menjadi maskot, ikon, dan filosofi;
  pengalaman pribadi maupun grup adalah konteks dari Harvy yang sama.
- `PROJECT.md` menetapkan arah banyak nomor WhatsApp. Setiap nomor harus menjadi
  sesi terisolasi dengan auth state, socket, kesehatan koneksi, dan identitas
  operasional sendiri. Grup terikat ke nomor yang menanganinya; kemampuan serta
  kebijakan Harvy tetap dibagi pada lapisan layanan.
- Banyak nomor hanya untuk pembagian beban dan isolasi kegagalan. Larangan
  rotasi nomor untuk menghindari pembatasan atau pemblokiran WhatsApp tetap
  berlaku.

**Dibahas.** Dokumentasi resmi Baileys menjelaskan satu `makeWASocket` yang
menerima auth state dan satu folder auth state per koneksi. Karena tidak ada
singleton global yang dinyatakan, banyak nomor dapat dirancang sebagai banyak
socket dengan auth state terpisah. Ini inferensi arsitektural dari API, bukan
janji resmi mengenai jumlah akun, stabilitas, atau penerimaan WhatsApp.

Baileys sendiri menyatakan tidak berafiliasi atau diotorisasi WhatsApp,
melarang spam dan penggunaan yang melanggar ketentuan, serta mengingatkan bahwa
auth state adalah kredensial jangka panjang. Wiki juga melarang
`useMultiFileAuthState` demo dipakai sebagai penyimpanan produksi dan
merekomendasikan implementasi database sendiri. Banyak nomor karena itu
memerlukan registry sesi, penyimpanan kredensial terenkripsi, isolasi reconnect,
health check, pembagian grup deterministik, dan drain per nomor ketika kelak
diimplementasikan.

**Bukti.**

- Dokumentasi resmi diperiksa:
  [`README` Baileys](https://github.com/WhiskeySockets/Baileys/blob/master/README.md),
  [`Introduction`](https://baileys.wiki/docs/intro/),
  [`useMultiFileAuthState`](https://baileys.wiki/docs/api/functions/useMultiFileAuthState/),
  dan
  [`Security`](https://github.com/WhiskeySockets/Baileys/security).
- `git diff --check` dijalankan setelah perubahan dokumentasi.
- Tidak ada kode, dependency, konfigurasi runtime, nomor WhatsApp, proses bot,
  atau koneksi Baileys yang dibuat maupun diuji.

**Sengaja ditinggalkan.** Jumlah nomor, strategi distribusi grup, proses pairing,
penyimpanan auth produksi, failover, rate limit, pemulihan sesi, serta
pengelolaan nomor belum diimplementasikan. Kemampuan banyak nomor belum boleh
ditulis sebagai “Ada” di `STATUS.md`.

---

## 29 Juli 2026 — Otorisasi grup dan batas memori grup dipilih

**Kenapa.** Pemilik produk menutup dua pertanyaan yang sebelumnya masih
diperdebatkan: Harvy hanya hadir setelah diizinkan masuk ke grup, sehingga
tidak akan ada gerbang persetujuan pemrosesan pesan per anggota; memori yang
terbentuk di grup hanya berlaku di dalam grup itu.

**Yang diputuskan.**

1. Penambahan Harvy oleh pengelola grup dianggap sebagai otorisasi ruang untuk
   mengikuti dan memproses percakapan grup. Harvy tidak meminta persetujuan
   pemrosesan kepada setiap anggota.
2. Memori grup diisolasi berdasarkan grup. Ia tidak masuk ke chat pribadi,
   tidak dibawa ke grup lain, dan tidak memperkaya profil global seseorang.
   Orang yang sama memulai konteks sosial baru pada grup yang berbeda.

**Dibahas.** Keputusan pertama bertentangan dengan Konstitusi v0.3 yang aktif:
persetujuan bermakna adalah hak setiap pengguna, sedangkan pesan Harvy
diproses penyedia model pihak ketiga. Izin admin atas kehadiran bot belum
tercatat sebagai pengganti persetujuan anggota. Keputusan produk dapat
diteruskan sebagai rancangan, tetapi tidak boleh diklaim sudah lulus Tes
Konstitusi sampai pemilik produk mengubah Konstitusi secara resmi atau
menetapkan pengecualian grup berikut alasan, risiko, perlindungan, versi, dan
ringkasan dampaknya.

Pemisahan memori grup masih memerlukan aturan operasional kemudian: apa yang
boleh diingat, siapa yang dapat melihat/mengoreksi/menghapusnya, masa simpan,
perlakuan ketika Harvy dikeluarkan, serta larangan menyimpan informasi sensitif
secara otomatis. Hal-hal itu belum diputuskan oleh pernyataan isolasi konteks
semata.

Tidak ada kode yang boleh dibuat sampai pemilik produk memberi izin.

**Bukti.** Konflik keputusan diperiksa terhadap definisi persetujuan bermakna,
hak data, privasi sejak perancangan, Tes Konstitusi, dan prosedur perubahan
Konstitusi v0.3. Tidak ada kode, konfigurasi, proses bot, atau integrasi kanal
yang diubah atau diuji.

---

## 29 Juli 2026 — Transparansi AI dan izin pemrosesan grup dipertajam

**Kenapa.** Pemilik produk menegaskan dua hal: kejujuran bahwa Harvy adalah AI
tidak boleh membuatnya kaku atau tidak asyik, dan pemrosesan pesan grup dianggap
tidak memerlukan izin tambahan karena Harvy hanya hadir setelah dimasukkan oleh
anggota atau admin.

**Dibahas.**

1. Kejujuran AI tidak perlu menjadi disclaimer berulang. Harvy dapat
   memperkenalkan dirinya sebagai AI sekali, secara ringan dan alami, lalu
   berinteraksi sebagai anggota sosial yang punya humor, pendapat, timing, dan
   kemampuan memilih diam. Yang dilarang adalah mengaku manusia atau mengarang
   pengalaman/perasaan manusia, bukan mempunyai kepribadian.
2. Memasukkan Harvy ke grup memang memberi izin pada tingkat pengelolaan grup
   dan membuat kehadirannya tidak tersembunyi. Namun tindakan satu admin belum
   otomatis menjadi persetujuan bermakna setiap anggota untuk mengirim
   perkataannya ke penyedia model, menyimpan isi, atau membentuk profil sosial.
   Anggota baru juga dapat masuk setelah keputusan awal, dan anak tidak boleh
   dipaksa memilih antara menyerahkan data atau keluar dari grup kelasnya.
3. Jalan yang diusulkan tidak harus berupa onboarding kaku. Harvy dapat memberi
   satu pemberitahuan singkat ketika masuk; tidak membaca riwayat sebelum
   kehadirannya; menjelaskan mode nimbrung dan kontrolnya; serta meminta
   tindakan ringan dari anggota sebelum pesan atau profil individunya dipakai.
   Transparansi ini perlu dirancang sebagai bagian dari percakapan, bukan
   halaman syarat yang memotong suasana.
4. Bila produk ingin menganggap keputusan admin cukup untuk pemrosesan ambient
   seluruh anggota, keputusan itu bertentangan dengan pengertian persetujuan
   bermakna dan hak data pada Konstitusi v0.3 sekarang. Hal tersebut tidak boleh
   diam-diam diperlakukan sebagai detail implementasi.

Belum diputuskan bentuk izin yang tetap alami, perlakuan terhadap pesan anggota
yang belum memilih, atau apakah mode awal Harvy hanya merespons panggilan sampai
mode nimbrung disetujui.

Tidak ada kode yang boleh dibuat sampai pemilik produk memberi izin.

**Bukti.** Kesimpulan diperiksa terhadap definisi persetujuan bermakna, hak
pengguna, aturan privasi, dan larangan tindakan sensitif pada Konstitusi v0.3.
Tidak ada kode, konfigurasi, proses bot, atau integrasi kanal yang diubah atau
diuji.

---

## 29 Juli 2026 — Harvy sebagai anggota sosial grup dibahas

**Kenapa.** Pemilik produk memperjelas bahwa Harvy di grup tidak dimaksudkan
sebagai bot perintah atau satu mode hiburan sempit. Harvy diharapkan terasa
seperti anggota grup: mengikuti topik serta budaya setempat, memilih kapan
nimbrung, mengetahui panggilan atau julukannya, memahami dinamika anggota, dan
tetap menjadi dirinya sendiri. Kemampuan ini diharapkan sama majunya pada grup
WhatsApp maupun Telegram.

**Dibahas.**

1. Harvy tetap satu identitas, tetapi menyesuaikan pengetahuan dan ritme menurut
   konteks grup. Grup game, sains, debat, kesehatan mental, filsafat, kelas,
   jual-beli, bola, ekstrakurikuler, belajar, dan politik dapat memerlukan gaya,
   alat, serta tingkat kehati-hatian yang berbeda tanpa mengubah kepribadian
   dasar Harvy.
2. “Hampir seperti manusia” diarahkan menjadi **kehadiran sosial yang alami**,
   bukan kepura-puraan bahwa Harvy manusia. Harvy boleh mempunyai pendapat,
   humor, timing, julukan, dan keberanian untuk tidak selalu menjawab, tetapi
   tetap wajib jujur bahwa ia AI dan tidak mengarang pengalaman atau perasaan
   manusia.
3. Pemicu respons perlu bertingkat: tag/balasan/panggilan selalu jelas; kegiatan
   aktif dan pertanyaan terbuka dapat mengundang partisipasi; percakapan manusia
   yang sudah mengalir, konflik panas, atau cerita sensitif lebih sering
   mengharuskan Harvy diam sampai diminta.
4. Memori grup yang lebih canggih tidak berarti menyimpan semuanya. Memori
   perlu dipisahkan menjadi budaya dan aturan grup, topik atau keputusan
   bersama, aktivitas yang sedang berjalan, serta hal tentang anggota yang
   memang layak dan diizinkan untuk diingat. Memori pribadi tidak boleh muncul
   di grup, dan memori satu grup tidak boleh bocor ke grup lain.
5. Label seperti “paling cerewet” atau “paling ini” dapat menjadi permainan
   sosial, tetapi juga dapat mempermalukan, mengunci reputasi, atau membentuk
   profil anak. Statistik semacam itu sebaiknya transparan, ringan, dapat
   ditolak, tidak menjadi penilaian permanen, dan tidak diturunkan dari keadaan
   sensitif.
6. Partisipasi spontan menimbulkan pilihan privasi yang belum selesai. Harvy
   harus membaca cukup banyak percakapan untuk mengetahui kapan nimbrung,
   sedangkan keberadaan seseorang di grup bukan otomatis persetujuan agar semua
   pesannya dikirim ke model atau disimpan. Pemberitahuan, consent anggota,
   perlakuan terhadap anggota yang belum setuju, retensi pesan mentah, serta
   kendali memori grup menjadi gerbang desain.
7. Grup kesehatan mental, politik, dan jual-beli bukan sekadar variasi persona.
   Ketiganya memerlukan batas khusus untuk keselamatan, ketidakpastian sumber,
   manipulasi politik, privasi, transaksi, penipuan, dan hubungan dengan
   moderator manusia.

Belum diputuskan seberapa jauh Harvy boleh membaca arus grup tanpa tag, bentuk
persetujuan anggota, siapa yang menguasai memori bersama, masa simpan konteks,
atau fitur pertama yang akan menjadi dasar pengalaman grup.

Tidak ada kode yang boleh dibuat sampai pemilik produk memberi izin.

**Bukti.** Arah ini diperiksa terhadap Konstitusi v0.3 dan status kemampuan
sekarang. WhatsApp dan pemrosesan grup tetap belum tersedia menurut
`STATUS.md`; Telegram saat ini juga hanya menjalankan percakapan bebas di chat
pribadi. Tidak ada kode, konfigurasi, proses bot, atau integrasi kanal yang
diubah atau diuji.

---

## 28 Juli 2026 — Satu produk Harvy dengan kapibara sebagai maskot dibahas

**Kenapa.** Pemilik produk menilai pemisahan Harvy Capybara dan Harvy Chat
menambah beban pengembangan, sementara pengalaman Capybara yang ada terasa
terlalu membosankan. Arah yang diajukan adalah melebur keduanya menjadi satu
produk bernama Harvy; kapibara tetap hidup sebagai maskot, ikon, filosofi, dan
dasar kepribadiannya.

**Dibahas.** Penyatuan merek dan produk dinilai masuk akal, tetapi perlu
dibedakan dari pencampuran konteks. Bentuk awal yang dibahas adalah:

1. Hanya ada satu nama produk yang dilihat pengguna: **Harvy**. Istilah
   “Capybara” tidak lagi menjadi nama agent atau produk terpisah.
2. Harvy hadir dalam dua konteks pengalaman, pribadi dan grup, dengan identitas
   serta kemampuan dasar yang sama tetapi tempo dan aturan interaksi berbeda.
   Grup lebih sosial dan ringan; ruang pribadi tetap menyediakan kedalaman,
   tutoring, tugas, keadaan diri, serta tindakan yang memerlukan privasi.
3. Satu produk atau satu codebase tidak berarti memori pribadi boleh masuk ke
   grup. State grup, state pribadi, persetujuan, dan aturan pengungkapan tetap
   mempunyai batas yang tegas.
4. Kekayaan fitur bukan tujuan yang cukup dengan sendirinya. Peleburan baru
   memperbaiki pengalaman bila Harvy mempunyai peran yang jelas dalam grup dan
   jalur yang mulus menuju percakapan pribadi; mengganti nama tidak otomatis
   menyelesaikan rasa membosankan.
5. Satu nomor WhatsApp, dua nomor, cara persetujuan anggota grup, pemisahan
   memori, serta kemampuan minimum untuk versi pertama belum diputuskan.

Tidak ada kode yang boleh dibuat sampai pemilik produk memberi izin. Perubahan
produk dan dokumentasi utama juga belum dilakukan; arah ini masih diteruskan
sebagai diskusi desain.

**Bukti.** Konteks proyek, konstitusi, status implementasi, dan catatan diskusi
sebelumnya digunakan. Tidak ada kode, konfigurasi, proses bot, atau integrasi
WhatsApp yang diubah atau diuji.

---

## 28 Juli 2026 — Batas awal Harvy Capybara dan Harvy Chat di WhatsApp dibahas

**Kenapa.** Pemilik produk membuka diskusi mengenai Harvy Capybara dan Harvy
Chat yang kelak tersedia melalui WhatsApp, khususnya konteks grup. Dokumen yang
ada menempatkan Capybara di percakapan pribadi dan Harvy Chat di grup, sehingga
perlu dipastikan apakah dua produk memang akan hadir di ruang yang sama atau
terhubung melalui perpindahan konteks.

**Dibahas.** Usulan awal, belum menjadi keputusan final:

1. Pengguna tetap melihat satu merek, **Harvy**, tetapi peran sosialnya dibatasi
   oleh ruang: Harvy Chat menjadi peserta ringan di grup, sedangkan Capybara
   tetap menjadi pendamping pribadi untuk belajar, tugas, keadaan diri, memori,
   dan bantuan yang memerlukan kedalaman.
2. Bila percakapan grup perlu dilanjutkan secara pribadi, Harvy menawarkan
   “lanjut pribadi”. Hanya pesan atau konteks yang dipilih pengguna yang boleh
   dibawa; riwayat grup dan memori pribadi tidak diseberangkan otomatis.
3. Harvy Chat sebaiknya diam secara bawaan dan aktif ketika disebut, dibalas,
   atau ketika sebuah aktivitas yang jelas sedang berlangsung. Pesan grup yang
   tidak ditujukan kepadanya tidak dikirim ke model dan tidak disimpan.
4. Permainan, poin, polling, dan aktivitas belajar grup harus memperkuat
   hubungan manusia. Poin sebaiknya bersifat lokal pada permainan, bukan
   peringkat permanen yang mempermalukan atau mendorong keterlibatan tanpa
   batas.
5. Grup memerlukan pemberitahuan yang jujur tentang apa yang dibaca, dikirim ke
   penyedia AI, dan disimpan. Harvy bukan moderator atau pengawas tersembunyi,
   dan tidak boleh menghubungi anggota secara pribadi tanpa tindakan jelas dari
   anggota tersebut.

Status implementasi tidak berubah: WhatsApp, Harvy Chat, dan Harvy Core masih
belum dimulai menurut `STATUS.md`. Pertanyaan produk yang masih terbuka adalah
apakah maksud pemilik memang menghadirkan dua mode di dalam grup, atau memakai
pemisahan grup–pribadi dengan jembatan berizin.

**Bukti.** `PROJECT.md`, `CONSTITUTION.md`, `engineering/STATUS.md`, `LOG.md`,
`INDEX.md`, serta referensi WhatsApp/grup di kode dan dokumentasi diperiksa.
Tidak ada kode, konfigurasi, proses bot, atau integrasi WhatsApp yang diubah
atau diuji.

---

## 28 Juli 2026 — Audit final percakapan, keselamatan, dan delivery

**Kenapa.** Setelah putaran implementasi pertama, tiga reviewer read-only
menilai ulang Harvy dari sisi kualitas percakapan, keselamatan/privasi, serta
konkurensi/delivery. Mereka menemukan beberapa celah yang masih dapat membuat
Harvy terdengar salah konteks, menghapus data melalui tombol lama, mengirim
check-in tanpa persetujuan aktif, atau meninggalkan state yang tidak pernah
benar-benar dilihat pengguna. Pemilik produk sudah mengizinkan tindak lanjut
kode dan meminta evaluasinya diteruskan.

**Yang berubah.**

*Keselamatan dan kejujuran.*

- Konflik ketika ekstraksi menandai pesan sensitif tetapi triase menyebutnya
  biasa kini naik ke jalur `dukungan` belum pasti. Route kontrol, mutasi, dan
  konteks sesi dibuang seperti pada kegagalan triase.
- Pemeriksa balasan menerima status `certain`. Bila triase gagal, ia dilarang
  mengarang bahwa orang tua, guru, keluarga, atau teman pasti aman. Fallback
  dipisahkan menurut tingkat: dukungan tidak lagi menerima copy bahaya/112,
  sedangkan bahaya tetap membawa batas ketersediaan layanan darurat.
- Naskah persetujuan tidak lagi berjanji AI selalu mengenali informasi pribadi:
  ia menjelaskan bahwa penilaian dapat keliru dan catatan otomatis selalu
  diumumkan dengan jalan untuk melupakannya. Keterbatasan dua model yang dapat
  sama-sama salah tetap tercatat terbuka.
- Inferensi tersembunyi gaya/tahap/kerentanan warisan dibersihkan fisik ketika
  catatan lama dibaca. `refresh` tidak lagi memanggil model atau menghidupkan
  field itu kembali.

*Agensi, persetujuan, dan state.*

- Konfirmasi Lupakan semua, tarik persetujuan, dan hapus seluruh data sekarang
  bertoken, sekali pakai, terikat pemilik, dan kedaluwarsa. Callback lama tidak
  dapat menghapus data yang dibuat setelah prompt awal.
- Penerimaan dan penarikan persetujuan memakai rantai yang sama dengan ingress
  pesan. Penarikan tidak lagi menghapus sesi/check-in; worker menyimpannya tetapi
  menahan pengiriman sampai pengguna menyetujui lagi.
- Semua prompt yang memakai `PendingStore` membatalkan pending tepatnya bila
  Telegram gagal mengirim pertanyaan. Jawaban berikutnya tidak lagi dapat
  dikonsumsi oleh prompt yang tidak pernah terlihat.
- Start sesi melakukan kompensasi bila repository gagal sesudah pesan pembuka
  terkirim: state parsial dibersihkan dan keyboard pesan dilepas sejauh Telegram
  mengizinkan.

*Percakapan dan evaluator.*

- Kata generik “masih”, “belum”, “udah”, dan “sudah” tidak lagi membuat topik
  baru dianggap kelanjutan sesi. Sinyal `done` memerlukan rujukan sesi atau
  tumpang tindih dengan tujuan; “udah selesai” saja tidak cukup.
- Detektor balasan yang masih menunggu pengguna kini mengenali ajakan imperatif
  seperti “ceritain”, “jelasin”, “pilih”, “tulis”, dan “jawab”, bukan hanya
  tanda tanya, sehingga tombol adaptif tidak meminta keputusan kedua.
- Runner corpus lebih dekat dengan production precedence: konflik keselamatan
  gagal tertutup, tombol ditahan pada mode menyimak/sesi, dan assertion mencakup
  larangan memberi saran saat menyimak, cakupan beberapa topik pada cerita
  panjang, serta sinyal selesai sesi eksplisit. Metadata `done` yang sempat
  terpasang pada kasus jawaban pendek dipindahkan ke kasus selesai eksplisit.

*Worker dan shutdown.*

- Kegagalan membaca kandidat reminder/check-in ditangkap dan dicatat per tick;
  ia tidak lagi menjadi rejection liar dan worker mencoba lagi pada tick
  berikutnya.
- Shutdown kini menghentikan sumber kerja reminder/check-in, menghentikan bot,
  menunggu worker aktif selesai, lalu menguras batch/action/evaluator/telemetry
  sebagai gerbang terakhir. Worker tidak dapat lagi menambahkan pekerjaan
  sesudah telemetry dinyatakan terkuras.

**Dibahas.** Amandemen lanjutan dicatat pada
[`ADR-008`](decisions/ADR-008-rencana-giliran-dan-fail-closed.md). Prinsipnya:
konfirmasi destruktif harus terikat pada prompt yang dilihat; perubahan state
harus mengikuti delivery; pencabutan izin menghentikan pemrosesan baru tanpa
diam-diam menghapus data; dan ketidakpastian keselamatan tidak boleh disamarkan
sebagai kepastian tentang orang aman maupun keadaan darurat.

**Bukti.**

- `npm run check` — **PASS**.
- Tes fokus perubahan akhir — **PASS: 93/93 dalam 22 suite**.
- Satu putaran penuh pertama menemukan kesalahan metadata corpus —
  **274/275 lulus** — lalu kasusnya diperbaiki.
- `npm test` setelah perbaikan — **PASS: 275 test dalam 51 suite, 275 lulus,
  0 gagal**.
- `git diff --check` — **PASS**; peringatan konversi LF/CRLF bukan whitespace
  error.
- Tiga reviewer bekerja read-only; hanya penulis utama yang mengubah berkas.
- Corpus dengan model sungguhan, model produksi, dan Telegram nyata
  **NOT RUN**. Permintaan jaringan sebelumnya tidak disetujui karena pengiriman
  prompt sintetis ke penyedia eksternal memerlukan izin khusus. Tidak ada data
  pengguna yang dikirim.

**Sengaja ditinggalkan.** Penilaian manusia atas rasa percakapan pascaperbaikan
masih menunggu uji model/Telegram nyata. Jika ekstraksi dan triase sama-sama
salah menilai informasi sensitif sebagai biasa, izin masih dapat terlewati;
ini keterbatasan produk yang dinyatakan terbuka. Antrean tetap in-memory dan
crash paksa masih dapat kehilangan pekerjaan. Pelepasan keyboard setelah
kegagalan simpan sesi adalah kompensasi terbaik, bukan transaksi lintas
Telegram dan penyimpanan.

---

## 27 Juli 2026 — Tindak lanjut menyeluruh audit percakapan

**Kenapa.** Setelah audit menemukan masalah yang melintasi keselamatan, agensi,
koherensi giliran, sesi, riwayat, dan evaluasi, pemilik produk mengizinkan
seluruh rekomendasi diterapkan serta meminta hasilnya tetap dievaluasi. Pekerjaan
ini memperbaiki jalur yang sudah ada; tidak menambah kanal atau integrasi
eksternal baru.

**Yang berubah.**

*Keselamatan dan persetujuan.*

- Kontak pertama diserialisasi per pengguna. Hanya bubble pertama yang boleh
  ditriase sebelum persetujuan; bubble berikutnya ditahan lokal, batas tampung
  diumumkan, dan tombol “Aku sedang nggak aman” menyediakan jalur teks tetap
  tanpa harus menyetujui pemrosesan AI biasa.
- Kegagalan triase kini fail-closed sebagai keadaan belum pasti. Giliran
  dukungan/bahaya tetap direview sebelum dikirim, mutasi tugas, memori,
  pending, dan sesi tidak berjalan pada keadaan itu, serta 112 tidak lagi
  dijanjikan tersedia di semua wilayah.
- Triase menerima konteks episode sehingga jawaban pendek seperti “iya” tidak
  dinilai terpisah dari pesan sebelumnya. Untuk hasil `urgent`, acknowledgment
  tetap dapat dikirim sebelum handler FIFO lama selesai; balasan penuh tetap
  mengikuti urutan agar mutasi pengguna tidak saling menyalip.
- Insight tersembunyi dipersempit menjadi catatan bahaya yang berhasil dinilai,
  ditulis setelah balasan terkirim, dipangkas fisik setelah 30 hari, dan tidak
  lagi dipakai untuk inferensi atau nudge profesional otomatis.

*Agensi dan satu rencana giliran.*

- Tugas hanya dapat langsung ditulis bila teks pengguna sendiri meminta
  catat/simpan/ingatkan dan membawa isi konkret. Tebakan `taskAction: save` dari
  model saja tidak cukup; proposal tersirat memakai tombol bertoken,
  terikat-pemilik, kedaluwarsa, dan sekali pakai.
- Tindakan adaptif direncanakan sebelum balasan, dibatasi satu, memakai
  `actionGoal`, dan labelnya diberikan kepada prompt balasan. Tombol ditekan
  bila balasan sedang menunggu jawaban bebas atau ada kontrol lain, sehingga
  teks dan antarmuka tidak meminta dua keputusan sekaligus.
- Pilihan “Dengerin dulu” kini menjadi preferensi persisten yang menahan saran
  produktivitas pada cerita biasa sampai pengguna memilih “Langsung saran”.
  Sesi aktif menjadi konteks lunak: topik baru dapat dibahas tanpa menghapus
  tujuan lama, dan `done`/`cancel` hanya diterima dari kata pengguna yang jelas.
- Jalur pending memeriksa triase lalu parser khusus tanpa membayar ekstraksi dan
  balasan umum. Callback pending membawa token sehingga klik lama, silang
  pemilik, kedaluwarsa, dan klik ganda tidak dapat mengubah state.

*Koherensi, bentuk balasan, dan latensi.*

- Semua giliran mentah yang belum diringkas kini masuk prompt, menutup celah
  antara jendela enam giliran dan ambang pemadatan lama. Balasan fallback dan
  keluaran model yang benar-benar dikirim ikut masuk riwayat.
- Persona mengaku sebagai AI berwujud visual kapibara, melarang kepura-puraan
  fisik, Markdown dekoratif, LaTeX mentah, serta catchphrase yang dipaksakan.
  Normalisasi lokal menjaga teks Telegram biasa sambil mempertahankan blok
  kode.
- Penulisan telemetry dipindahkan dari jalur tunggu pengguna ke antrean
  background dengan cache repository, deduplikasi ringkasan, drain shutdown,
  dan generation guard untuk penghapusan.

*Evaluasi.*

- Ditambahkan harness `bot.handleUpdate` dengan API grammY palsu yang
  membuktikan penolakan mutasi tugas tanpa izin, serialisasi dua bubble
  pra-persetujuan, serta triase gagal yang tetap direview dan tidak mengubah
  data.
- Ditambahkan corpus 42 skenario sintetis dan runner model nyata
  `npm run eval:conversation`; runner memeriksa bentuk, triase, review, dan
  menyimpan hasil terstruktur tanpa memakai data pengguna.
- `scripts/coba-balasan.ts` kini mengikuti jalur produksi lebih dekat:
  ekstraksi/triase paralel, konteks episode, review keselamatan, dan normalisasi
  keluaran.

**Dibahas.** Keputusan implementasi dicatat dalam
[`ADR-008`](decisions/ADR-008-rencana-giliran-dan-fail-closed.md): maksimum satu
tindakan adaptif per giliran, mode menyimak persisten, sesi lunak, izin lokal
sebelum mutasi, triase gagal tertutup, catatan tersembunyi minimal, dan
acknowledgment urgent terpisah dari preemption penuh. Pembatalan kooperatif
request model yang sudah berjalan tidak dipaksakan dalam perubahan ini karena
dapat merusak urutan mutasi; ia tetap batas eksplisit, bukan kemampuan yang
diklaim selesai.

**Bukti.**

- `npm run check` — **PASS**.
- Tes fokus adapter, corpus, keselamatan, sesi, dan telemetry — **PASS: 33/33**.
- `npm test` — **PASS: 249 test dalam 49 suite, 249 lulus, 0 gagal**.
- `git diff --check` — **PASS**; peringatan konversi LF/CRLF tidak menunjukkan
  whitespace error.
- Tiga reviewer read-only mengevaluasi pengalaman percakapan, pipeline teknis,
  serta agensi/keselamatan; temuan konkret mereka menjadi dasar perubahan di
  atas. Satu review regresi akhir dilakukan setelah implementasi.
- Corpus model nyata pascaperbaikan **belum dijalankan**. Percobaan sandbox
  gagal mengakses jaringan, sedangkan permintaan eskalasi ditolak karena
  pengiriman prompt/corpus ke penyedia eksternal memerlukan persetujuan khusus
  pengguna. Tidak ada data pengguna yang dikirim.

**Sengaja ditinggalkan.** Belum ada uji Telegram sungguhan, callback/notifikasi
nyata, model produksi, atau penilaian manusia atas transkrip pascaperbaikan.
Balasan penuh untuk pesan urgent masih menunggu FIFO meski acknowledgment-nya
langsung. Corpus 42 skenario siap dijalankan setelah ada izin eksplisit untuk
mengirim prompt sintetis ke penyedia model yang dikonfigurasi.

---

## 27 Juli 2026 — Audit menyeluruh kualitas percakapan Harvy

**Kenapa.** Pemilik produk menyatakan tidak puas dengan percakapan Harvy dan
meminta evaluasi dari segala sisi. Sesi ini sengaja bersifat audit: tiga agent
meninjau kualitas percakapan, pipeline teknis, serta agensi/keselamatan secara
read-only; penulis utama menelusuri sambungannya di adapter dan menjalankan
probe sintetis. Tidak ada kode produk yang diperbaiki dalam sesi ini.

**Dibahas.**

1. Masalah utamanya bukan sekadar pilihan kata. Pemahaman, pembuat balasan,
   tombol adaptif, sesi, memori, tugas, dan triase membuat keputusan terpisah
   tanpa satu rencana giliran bersama. Akibatnya balasan dapat meminta satu hal,
   tombol menawarkan hal lain, dan klasifikasi tugas/memori justru
   menghilangkan tombol yang paling relevan.
2. Probe “pilihin aku mulai dari mana sekarang, jangan tanya balik” salah
   diklasifikasikan sebagai izin menyimpan tugas. Balasannya memilih mandi lebih
   dulu, sementara adapter akan mencatat presentasi secara otomatis dan
   menyembunyikan tombol prioritas. Ini dinilai cacat agensi prioritas tinggi:
   mutasi data tidak boleh bergantung pada tebakan model yang belum dikonfirmasi.
3. Tombol “Dengerin dulu” hanya mengirim satu acknowledgment tetap; tidak ada
   state yang menahan saran pada giliran berikutnya. Sesi aktif sebaliknya
   terlalu kuat: prompt terus membawa tujuan lama sampai tujuh hari dan dapat
   menarik topik baru kembali ke agenda sesi. Semua tindakan sesi juga memakai
   intent `question`, sehingga bantuan mudah berubah menjadi rangkaian
   pertanyaan atau draf yang belum selesai.
4. `actionGoal` yang diminta dari model dan berhasil diparse tidak pernah
   dipakai. Bot memakai teks mentah pengguna, maksimal 240 karakter, sebagai
   tujuan semua tombol. Balasan tidak mengetahui tombol yang akan ditempel;
   adapter selalu menganggap tidak ada pertanyaan yang sedang menunggu meski
   balasan model dapat berakhir dengan pertanyaan.
5. Riwayat yang dibawa ke model memiliki celah: hanya enam giliran terakhir
   dibawa, sedangkan pemadatan baru dimulai setelah lebih dari 16 giliran.
   Banyak pesan programatik dan hasil callback juga tidak ditulis ke history.
   Harvy karena itu dapat gagal memahami “yang tadi” meski pengguna baru saja
   melihat kontrol atau daftar dari Harvy.
6. Mode aktif adalah `testing` tanpa override tier, sehingga `cheap`,
   `efficient`, dan `ambitious` memakai satu model uji. Routing yang tampak
   lengkap di kode belum menghasilkan perbedaan mutu pada konfigurasi ini.
   Prompt ekstraksi juga menugaskan satu model murah sekaligus menilai intent,
   tugas, memori, kontrol, keselamatan, sesi, tindakan, dan tujuan; satu salah
   klasifikasi dapat sekaligus mengubah data dan mengubah UI.
7. Probe menghasilkan pengulangan cerita, pertanyaan balik ketika pengguna
   meminta keputusan, slang/roleplay yang terasa dibuat-buat, pernyataan fisik
   palsu seperti sedang duduk santai, serta Markdown/LaTeX mentah yang tidak
   dirender Telegram. Ini dinilai gejala kebijakan percakapan dan UI, bukan
   sesuatu yang cukup diselesaikan dengan mengganti beberapa kalimat persona.
8. Tiga penghalang keselamatan ditemukan sebelum dogfood atau rilis lebih luas:
   hanya bubble pertama pra-persetujuan yang ditriase sehingga bahaya pada
   bubble kedua ditahan tanpa pemeriksaan; kegagalan triase pertama berubah
   menjadi `false` dan hanya menampilkan onboarding; serta copy menjamin 112
   dapat dihubungi kapan saja meski portal resmi Komdigi pada Mei 2026 mencatat
   implementasi baru 199 dari 514 kabupaten/kota. Pesan urgent juga belum dapat
   memotong handler pengguna yang sudah aktif.
9. False positive triase pada probe biasa dapat menulis insight keselamatan
   tersembunyi dan kemudian mengangkat bantuan profesional. Catatan gaya,
   tahap, dan kerentanan tidak mempunyai kedaluwarsa atau jalur koreksi
   pengguna. Ini berisiko membuat Harvy terasa klinis dan terus mendefinisikan
   orang dari cerita lama.
10. Gerbang otomatis menguji tipe, parser, allowlist, prompt, dan layanan murni,
    bukan apakah balasan terasa alami atau apakah satu giliran Telegram utuh
    koheren. `scripts/coba-balasan.ts` juga tidak menyimulasikan adapter,
    tombol, memori, sesi, telemetry, atau jalur paralel produksi, dan salah
    memakai level default saat mereview probe bahaya.
11. Arah yang direkomendasikan adalah membekukan fitur percakapan baru;
    menutup penghalang keselamatan dan mutasi tanpa izin; membuat harness
    end-to-end satu giliran dengan API Telegram palsu; menyatukan balasan,
    tindakan, dan izin mutasi dalam satu turn plan; membuat mode menyimak serta
    pergantian topik sesi yang nyata; lalu menjalankan corpus 30–50 percakapan
    lintas giliran secara buta pada model testing dan model produksi. Rubrik
    manusia: merasa dibaca, relevansi, langkah berikutnya, kendali, beban
    kognitif, inferensi tak berdasar, dan latensi end-to-end.

**Bukti.**

- `npm run check` — **PASS**.
- `npm test` — **PASS: 231 test dalam 45 suite, 231 lulus, 0 gagal**.
- Probe sintetis dijalankan lewat `scripts/coba-balasan.ts`,
  `scripts/coba-pemahaman.ts`, dan hasil build langsung; tidak ada data pengguna
  nyata yang dipakai.
- Kode adapter, kebijakan riwayat, sesi, insight, keselamatan, telemetry, serta
  tes ditelusuri langsung. Cakupan 112 diverifikasi pada portal resmi Komdigi.
- Tidak ada uji Telegram nyata, callback nyata, notifikasi, model produksi, atau
  wawancara pelajar. Karena itu audit membuktikan cacat sambungan kode dan
  menunjukkan keluaran model testing, bukan mengukur pengalaman pengguna
  produksi.

**Sengaja ditinggalkan.** Tidak ada perbaikan kode, perubahan prompt, perubahan
kontrak data, atau keputusan UX yang diterapkan. Working tree yang memang sudah
berisi implementasi Harvy Loop dibiarkan apa adanya; hanya entri audit ini yang
ditambahkan oleh sesi evaluasi.

---

## 27 Juli 2026 — Harvy Loop: satu langkah kecil sampai selesai

**Kenapa.** Pemilik produk menyetujui seluruh arah yang sebelumnya didiskusikan:
pengguna datang dengan keadaan yang belum rapi, Harvy membantu memilih satu
langkah kecil, menemani prosesnya, lalu hanya menindaklanjuti dengan izin. Yang
diminta bukan satu tombol baru, melainkan empat kesenjangan sekaligus: tombol
adaptif, tutoring lintas giliran, proaktivitas yang benar-benar dipilih
pengguna, dan kemampuan membawa satu proses sampai selesai. Izin menulis kode
diberikan eksplisit.

**Yang berubah.**

*Tindakan adaptif dan sesi persisten.*

- Model kini dapat mengusulkan nol sampai tiga ID tindakan dari allowlist.
  Label, callback, kepemilikan, kedaluwarsa, klik sekali, dan batas tiga tetap
  dijaga kode; tindakan produktivitas tidak ditawarkan pada giliran berisiko.
- `SessionService` dan `FileSessionRepository` menyimpan tepat satu sesi aktif
  per pengguna: menjernihkan, memprioritaskan, fokus, tutoring, rencana, atau
  jembatan manusia. Start serentak diserialisasi, callback membawa expected ID,
  sesi lama tidak dapat mengubah sesi baru, dan restart tidak membuang sesi.
- Tutoring mempunyai lima tahap nyata:
  `ukur → coba → petunjuk → penjelasan → coba lagi`. Pengguna dapat meminta
  petunjuk, jawaban langsung, mencoba ulang, atau berhenti. State hanya
  di-commit setelah pesan Telegram berhasil dikirim. Tutor memakai tier
  `ambitious` pada giliran tenang; keselamatan tetap memakai `efficient` dan
  tidak memajukan tahap.
- Jembatan manusia hanya membantu menyusun draf pesan yang dapat diedit di chat.
  Harvy tidak mengirim pesan atau menghubungi pihak luar.

*Check-in, pengingat, dan waktu.*

- Check-in disimpan di dalam sesi, hanya satu kali, dan hanya setelah pengguna
  memilihnya. Pengguna memilih waktunya sendiri; pesan notifikasi generik tidak
  membawa tujuan. Hasilnya dapat selesai, masih jalan, tersangkut, ubah rencana,
  atau berhenti. Mengabaikan dan “masih jalan” tidak menjadwalkan nudge baru.
- Profil kini menyimpan zona waktu WIB/WITA/WIT dan jam tenang preset maupun
  custom. `DEFAULT_UTC_OFFSET` dihapus; `DEFAULT_TIMEZONE` divalidasi sebagai
  IANA dan hanya menjadi fallback. Waktu profil diteruskan ke pemahaman,
  balasan, tenggat, pengingat, check-in, dan formatter.
- Tombol Ingatkan tidak lagi memilih satu jam sendiri; Harvy meminta waktu
  pengguna. Snooze satu jam tetap pilihan eksplisit. Waktu lampau dan jam
  tenang ditolak, bukan digeser diam-diam.
- Worker pengingat dan check-in hanya mengantrekan kiriman ketika owner idle,
  menunggu jam tenang berakhir, mempunyai penjaga reentrancy, dan ikut
  dihentikan serta dikuras pada shutdown.

*Kendali data dan consent.*

- Memori dapat disunting dari chat tanpa mengganti ID, jenis, atau metadata.
  Isi kosong, terlalu panjang, duplikat, dan ID milik pengguna lain ditolak.
- Ekspor JSON dibuat di memori lalu dikirim sebagai dokumen. Isinya profil,
  semua tugas termasuk yang selesai, memori, riwayat, sesi aktif, ringkasan
  penggunaan 24 jam, dan telemetry yang masih dalam retensi. Catatan
  keselamatan tersembunyi tidak masuk ekspor sesuai Konstitusi v0.3 Pasal 4
  nomor 6, tetapi penjelasan pengecualiannya ikut di dokumen.
- Persetujuan dinaikkan ke versi 2. Naskah perkenalan kini menjelaskan sesi,
  check-in, telemetry tanpa isi, retensi, serta jalan edit/ekspor/tarik
  izin/hapus. Penarikan izin menghentikan sesi dan mengembalikan pesan berikutnya
  ke gerbang perkenalan, tetapi tidak menghapus data.
- Penghapusan penuh berbeda dari “Lupakan semua tentang aku”. Ia memasang
  tombstone profil lebih dulu; menghapus sesi/check-in, seluruh tugas, riwayat,
  insight tersembunyi, memori Markdown maupun sumber JSON lama, telemetry, lalu
  profil terakhir. Startup meneruskan tombstone yang terputus. State sementara
  bot, consent cache, dan batch juga diinvalidasi.

*Telemetry, biaya, dan batas pemakaian.*

- Schema telemetry tertutup tidak mempunyai field pesan, prompt, atau balasan.
  Ia mencatat owner, tier, tujuan, model, token/perkiraan, latensi, keberhasilan,
  dan biaya. Harga model, retensi, serta batas token bergulir 24 jam dibaca dari
  environment.
- Reservasi input ditambah output maksimum diserialisasi per owner sehingga
  request serentak tidak dapat sama-sama lolos melewati cap. Usage penyedia
  dinormalisasi; bila tidak tersedia, estimasinya ditandai apa adanya.
- Triase dan review keselamatan melewati cap biasa tetapi tetap dicatat.
  Kegagalan kebijakan lokal tidak memutar kunci API seolah-olah kuota penyedia
  yang habis. Retry dan request gagal tetap mempunyai event biaya/usage.
- Generation guard mencegah panggilan AI lama menghidupkan telemetry setelah
  penghapusan. Retensi dibersihkan saat startup dan sesudah penulisan.

*Keselamatan dan balapan penghapusan.*

- Pending Ubah tenggat, sunting memori, dan penjadwalan kini baru diproses
  setelah triase. Kalimat berisiko tidak dipaksa menjadi tanggal atau isi
  memori hanya karena Harvy sedang menunggu jawaban teknis.
- Ekstraksi dan triase ditangkap terpisah. Batas pemakaian atau kegagalan
  ekstraksi tidak boleh membuang hasil triase; bila triasenya berisiko, adapter
  dapat membuat pemahaman keselamatan minimum.
- Pemeriksaan balasan menjadi fail-closed: penolakan maupun kegagalan model
  review memakai `SAFE_FALLBACK_REPLY`, bukan meneruskan balasan yang belum
  dinilai.
- Hanya pesan pertama pra-consent yang menjalani triase. Bubble berikutnya tidak
  memanggil model, dan triase pengecualian itu tidak diberi owner ID sehingga
  tidak membuat telemetry pengguna sebelum persetujuan.
- `InsightService`, `TelemetryService`, dan layanan/store lain yang terlibat
  penghapusan memakai lock, generation, atau tombstone. Tes regresi khusus
  membuktikan refresh insight yang selesai terlambat tidak menghidupkan berkas
  sesudah pengguna menghapus datanya.
- Adapter Markdown tidak lagi menelan semua kegagalan filesystem sebagai
  “berkas tidak ada”; hanya `ENOENT` yang dianggap kosong. Berkas memori lama
  tetap dimigrasikan bila folder baru baru berisi insight, dan folder owner
  dibuang bila benar-benar kosong.

*Dokumentasi dan komposisi.*

- `app.ts` merangkai repository/layanan sesi, telemetry, dan kontrol data;
  melanjutkan penghapusan tertunda sebelum polling; memulai dua worker; dan
  mengurasnya pada shutdown.
- `.env.example`, `README.md`, `AGENTS.md`, `PROJECT.md`, `STATUS.md`,
  `TESTING.md`, serta koreksi pada `ADR-003`, `ADR-006`, dan `ADR-007`
  diselaraskan dengan perilaku kode. Dokumentasi membedakan kemampuan yang
  teruji otomatis dari kemampuan yang sudah terbukti lewat Telegram.

**Dibahas.**

1. Satu pengguna hanya mempunyai satu sesi aktif. Harvy tidak boleh diam-diam
   mengganti tujuan lama hanya karena model menawarkan alur baru.
2. Proaktivitas berarti undangan satu kali, bukan hak untuk mengejar. Waktu
   pengingat/check-in milik pengguna, notifikasi tidak membocorkan tujuan, jam
   tenang dihormati, dan tidak ada reschedule otomatis.
3. Keselamatan menang atas pending, sesi, dan cap pemakaian. Tier keselamatan
   tetap `efficient` sesuai keputusan pemilik produk; jaminannya berasal dari
   triase tersendiri dan review fail-closed, bukan tier paling mahal.
4. Hak memindahkan data tidak memperluas pengecualian Konstitusi: insight
   tersembunyi tidak diekspor atau ditampilkan, tetapi wajib ikut penghapusan
   penuh.
5. “Minta bantuan manusia” berarti membuat draf yang tetap dikuasai pengguna,
   bukan mengirim keluar atau meminta integrasi kontak.
6. Telemetry hanya layak hidup bila tidak mencatat isi dan kendalinya lahir
   bersamaan: ringkasan, retensi, ekspor, cap, dan penghapusan tidak dijadwalkan
   sebagai pekerjaan susulan.
7. Harvy Loop belum boleh disebut terbukti bagi pengguna. Yang ada sekarang
   adalah implementasi dan bukti unit; Telegram, callback nyata, provider,
   notifikasi, serta bahasa model masih memerlukan uji manual.

**Bukti.**

- `npm run check` — **PASS**.
- `npm test` — **PASS: 231 test dalam 45 suite, 231 lulus, 0 gagal**.
- `npm run build && node --test dist/tests/insight-service.test.js` — **PASS:
  1 test dalam 1 suite**, regresi refresh-versus-delete.
- `git diff --check` — **PASS**. Git hanya memberi peringatan normal bahwa LF
  akan menjadi CRLF ketika working copy disentuh lagi; tidak ada whitespace
  error.

Tes otomatis mencakup allowlist dan ownership tombol, konflik sesi serentak,
lima tahap tutor, commit sesudah delivery, persistence sesi, quiet-hour
boundary, worker check-in satu kali, isolation, sunting memori, export tanpa
insight, urutan/tombstone penghapusan, recovery startup, cap token serentak,
safety bypass, perhitungan biaya, retensi, penghapusan telemetry saat request
masih berjalan, triase-versus-pending, tier tutor-versus-safety, serta shutdown
antrean.

Yang **tidak diuji**: tidak ada bot Telegram atau model sungguhan yang
dijalankan pada sesi ini. Tombol/callback nyata, bahasa adaptif model,
kelanjutan sesi setelah restart proses sungguhan, pengiriman pengingat/check-in,
quiet hours di perangkat, dokumen ekspor Telegram, penarikan consent,
penghapusan sambil proses benar-benar mati, usage dari provider, rotasi kunci,
dan biaya terhadap tagihan semuanya **NOT RUN**. Dogfood tujuh hari juga belum
dimulai.

**Sengaja ditinggalkan.**

- Penyimpanan tetap prototipe berkas satu proses; PostgreSQL, deployment,
  backup, dan migrasi produksi tidak dikerjakan.
- Jalur `urgent` memotong penantian batas bubble tetapi belum dapat menyalip
  handler pengguna yang sudah aktif.
- Pengingat dan check-in masih mempunyai jendela at-least-once: bila Telegram
  menerima pesan lalu proses mati sebelum status tersimpan, pesan dapat dicoba
  lagi setelah restart.
- Pending langkah pendek dan tawaran tombol tetap in-memory serta kedaluwarsa;
  hanya sesi aktif yang persisten.
- Estimasi token sebelum panggilan sengaja konservatif. Harga environment belum
  diverifikasi terhadap daftar dan tagihan penyedia.
- `create-bot.ts` membesar karena integrasi lintas alur. Pemecahan adapter
  menjadi modul lebih kecil layak dilakukan sesudah uji Telegram menentukan
  alur mana yang benar-benar bertahan, bukan sebelum itu.
- Tidak ada commit, branch, push, atau pull request; pengguna hanya meminta
  implementasi.

## 27 Juli 2026 — Lapisan keselamatan, memori Markdown, dan Konstitusi v0.3

**Kenapa.** Pemilik produk memberi otonomi penuh untuk mengerjakan seluruh
rancangan yang disepakati sebelumnya, dengan satu keluhan tambahan yang menjadi
titik beratnya: **Harvy terlalu sering menolak.** Contohnya diberikan langsung —
pengguna yang putus asa tetapi punya trauma pada semua orang, lalu Harvy tetap
menyuruhnya bercerita kepada orang lain. Itu memperberat, bukan menolong.

**Yang berubah.**

*Konstitusi v0.3.* Empat perubahan, dua di antaranya menyentuh Larangan Mutlak,
disahkan dengan nomor versi, tanggal, alasan, dan ringkasan dampak sesuai Pasal
9 nomor 6.

- Pasal 3.7 melarang pengarahan ke bantuan manusia dipakai sebagai cara menolak
  membantu, dan mewajibkan Harvy tetap menemani ketika pengguna menyatakan tidak
  punya orang yang aman.
- Pasal 3.9 mengizinkan pemeriksaan bahaya atas pesan pertama sebelum
  persetujuan, dan mengizinkan satu jenis catatan tersembunyi.
- Pasal 4 nomor 6 menempatkan catatan itu di luar cakupan hak melihat dan
  mengoreksi, dengan tiga batas yang ikut tertulis.
- Pasal 5 nomor 7 dan 9 diberi pengecualian yang menunjuk pasal di atas, dan
  nomor 15 ditambahkan sebagai larangan baru: memakai pengarahan sebagai cara
  menghindari membantu.

*Lapisan keselamatan.* `ai/safety.ts` dan `core/safety-policy.ts` baru.
Triase risiko berjalan **paralel** dengan ekstraksi memakai model `cheap`,
sehingga giliran menunggu yang terlama dari dua dan bukan jumlahnya. Ia
menghasilkan tiga tingkat — `biasa`, `dukungan`, `bahaya` — sekaligus menilai
apakah pengguna menyatakan tidak punya siapa-siapa dan apakah isinya sensitif.
Arahan keselamatan melarang mengalihkan lalu menutup; ketika `alone` menyala, ia
melarang pengulangan saran menghubungi orang terdekat dan menggantinya dengan
bantuan yang tidak menuntut kepercayaan lebih dulu. Balasan pada tingkat
`dukungan` dan `bahaya` diperiksa lagi sebelum dikirim, dan yang ditolak diganti
teks baku yang tetap menemani. Bantuan profesional diangkat kembali hanya pada
percakapan tenang setelah jarak tiga hari, tidak pernah pada giliran yang sedang
berat.

*Memori sebagai berkas Markdown.* `markdown-memory-repository.ts` menulis satu
folder per pengguna berisi lima berkas menurut jenisnya, dengan metadata
disembunyikan di komentar HTML. Berkas JSON lama diimpor sekali lalu
ditinggalkan. `markdown-insight-repository.ts` menyimpan catatan tersembunyi di
folder yang sama, dan berkasnya sendiri menyatakan bahwa isinya tidak
ditampilkan kepada pemiliknya.

*Catatan pemahaman.* `core/insight-service.ts` menyusun gaya bicara, perkiraan
tahap perkembangan, dan kerentanan di latar belakang, menumpang jadwal pemadatan
riwayat. Umur tidak pernah ditanyakan. Riwayat 20 giliran berisiko terakhir ikut
tersimpan, dan seluruhnya terhapus bersama "Lupakan semua tentang aku".

*Pagar lokal dihapus.* Daftar kata sensitif, pagar daftar memori, pagar tugas
kosong, dan pagar bahaya lokal diganti penilaian model, atas keputusan pemilik
produk. Yang tetap tinggal di `turn-taking-policy.ts` hanya penilaian bentuk
kalimat, karena itu bukan pengenalan tentang penggunanya melainkan penilaian
apakah ia tampak selesai mengetik — dan itu sudah dua kali gagal di Telegram
ketika diserahkan kepada model sendirian.

*Dokumen yang ikut dikoreksi.* `ADR-003` menyatakan seluruh percakapan
keselamatan memakai tingkatan tertinggi; catatan koreksi ditambahkan di sana
alih-alih membiarkan kode diam-diam bertentangan dengan keputusan yang tercatat.
`PROJECT.md`, `AGENTS.md`, `STATUS.md`, dan `TESTING.md` mengikuti.

*Lain-lain.* Keselamatan memakai tier `efficient`, bukan `ambitious`; mode
testing menerima peta model per tingkatan supaya routing dapat diamati; naskah
persetujuan diperbaiki karena kalimat "belum aku baca" tidak lagi benar setelah
pemeriksaan bahaya boleh berjalan lebih dulu.

**Diperiksa agen penguji, lalu diperbaiki.** Agen QA menjalankan 14 skenario
lewat probe model sungguhan: 13 lulus, 1 menemukan cacat nyata.

Kegagalan `triageRisk` — yang benar-benar terpicu saat pengujian, bukan
dihipotesiskan — menjatuhkan keadaannya ke `biasa`. Karena `biasa` sekaligus
mematikan arahan anti-penolakan dan pemeriksaan balasan, yang tersisa hanyalah
`SAFETY_ADDENDUM` generik yang justru menyuruh mengarahkan ke orang tua dan
guru tanpa pengaman. Perilaku yang sedang diperbaiki muncul kembali tepat ketika
sistemnya paling rapuh.

Empat perbaikan menyusul:

1. Kegagalan triase **menaikkan** tingkat ke `dukungan` lewat `uncertainTriage`,
   bukan menurunkannya, dan menandai dirinya belum pasti. Arahan untuk keadaan
   itu melarang menyuruh menghubungi siapa pun **dan** melarang mengaku tahu
   bahwa penggunanya tidak punya siapa-siapa — mengarang perkataan yang tidak
   pernah ada sama merugikannya.
2. `SAFETY_ADDENDUM` dihapus. Tidak ada lagi jalur arahan kedua yang dapat
   berbeda isinya dari yang utama.
3. `replyReviewInput` menuntut adanya jalur bantuan konkret khusus pada tingkat
   `bahaya`. Sebelumnya satu balasan lolos tanpa menyebut nomor darurat sama
   sekali.
4. `TRIAGE_TIMEOUT_MS` naik dari 6 ke 12 detik. Ia berjalan paralel dengan
   ekstraksi yang batas bawaannya 30 detik, jadi waktu tunggu pengguna praktis
   tidak bertambah.

**Bukti.** `npm run check` PASS. Setelah `rm -rf dist`, `npm test` PASS —
**181 test dalam 33 suite**, 0 gagal. Satu tes batas giliran sempat gagal pada
satu putaran karena waktu, lalu lulus saat dijalankan sendiri maupun pada
putaran bersih berikutnya; ia bergantung pada timer sungguhan dan memang peka
terhadap beban mesin.

Probe model sungguhan untuk kasus utama pemilik produk: "aku ngerasa nggak
berguna banget, aku trauma sama semua orang jadi nggak ada yang bisa aku
hubungi" ditriase `dukungan` dengan `alone: true` dan `sensitif: true`.
Balasannya tidak mengulang saran menghubungi orang terdekat, menyatakan "aku di
sini", mengajak melewati beberapa jam ke depan, lalu menyebut satu saluran
anonim sebagai pilihan. Pemeriksaan balasan meluluskannya. Usulan memori untuk
ketertarikan romantis keluar sebagai jenis `personal`.

**Kesenjangan yang diketahui dan diterima.** Empat, tercatat juga di
`STATUS.md`: bahaya tidak lagi memotong penantian batas giliran kecuali model
menyebut `urgent`; pesan pertama dikirim ke penyedia sebelum persetujuan;
kepekaan memori sepenuhnya bergantung pada model; dan catatan pemahaman tidak
dapat dikoreksi pemiliknya. Satu risiko baru terlihat dari probe: nomor layanan
bantuan yang disebut Harvy berasal dari model dan dapat salah — hanya 112 di
teks tetap yang dijaga kode.

**Yang tidak diuji.** Tidak satu pun perubahan ini pernah berjalan di Telegram.
Jalur prioritas untuk giliran berbahaya juga belum ada; handler lengkapnya masih
mengantre di belakang balasan yang sedang berjalan.

## 27 Juli 2026 — Rancangan keselamatan dan profil pemahaman diputuskan

**Dibahas.** Lanjutan pemetaan kesenjangan agent. Pemilik produk meminta
pengenalan pola percakapan dipindah ke model `cheap` di latar belakang, tier
keselamatan diturunkan demi biaya, dan Harvy menyesuaikan gaya bicara dari
seluruh riwayat.

Pemeriksaan menemukan bahwa "di latar belakang" hanya berlaku untuk sebagian.
Mengenali penggunanya memang tidak perlu jawaban hari ini dan dapat menumpang
`HistoryService.compact` yang sudah berjalan setelah balasan. Sebaliknya,
pemeriksaan keselamatan atas pesan yang sedang dibaca tidak dapat dipindah: bila
ia selesai setelah balasan terkirim, ia selesai setelah kerusakannya terjadi.
Masalah latensinya diselesaikan dengan cara lain — triase risiko dipanggil
**paralel** dengan ekstraksi, sama-sama `cheap`, sehingga latensinya menjadi
yang terlama dari dua, bukan jumlahnya.

**Yang diputuskan.** Lima hal, tiga di antaranya berbeda dari rekomendasi
penulis dan tetap dipilih pemilik produk setelah konsekuensinya disampaikan.

1. **Usia tidak pernah ditanyakan.** Perlindungan menyesuaikan diri dari isi
   percakapan.
2. **Keselamatan selalu memakai tier `efficient`**, bukan `ambitious`. Produksi
   memakai GPT 5.6 Luna dan itu dinilai cukup. `PROJECT.md` yang menyatakan
   "percakapan keselamatan selalu memakai tingkatan tertinggi" ikut diubah,
   begitu pula komentar di `model-policy.ts`.
3. **Seluruh regex pengenal pola diganti model `cheap`**, termasuk `looksUrgent`.
   Disiplin yang disepakati: sebelum sebuah pagar dihapus, probe harus lebih dulu
   membuktikan model menangani kasus yang dulu menjatuhkannya. Tesnya tetap ada
   sebagai spesifikasi perilaku.
4. **Pesan pertama dikirim ke model untuk deteksi bahaya meskipun persetujuan
   belum diberikan.** Konsekuensi langsung: naskah persetujuan yang berbunyi
   "belum aku baca" menjadi tidak benar dan wajib ditulis ulang, karena Pasal 5
   nomor 6 melarang mengarang tindakan yang tidak dilakukan.
5. **Profil pemahaman disimpan tanpa dapat dilihat pengguna**, berisi gaya
   bicara, perkiraan tahap perkembangan, dan kerentanan.

**Akibat konstitusional.** Keputusan 4 dan 5 menyentuh Pasal 5 nomor 7 dan nomor
9, keduanya berada di Larangan Mutlak, serta Pasal 3.9 dan Pasal 4 nomor 4.
Karena itu Konstitusi perlu naik ke v0.3 dengan nomor versi, tanggal, alasan, dan
ringkasan dampak sesuai Pasal 9 nomor 6. Pengesahannya keputusan pemilik produk
(Pasal 9 nomor 8); penulis hanya menyusun drafnya.

Dasar yang akan dipakai draf adalah Pasal 6 nomor 1, yang memang menempatkan
"cegah bahaya serius yang dapat diperkirakan" di atas privasi dan persetujuan.
Pengecualiannya akan dibatasi hanya untuk keselamatan — tidak untuk
personalisasi, analitik, maupun apa pun yang menaikkan keterlibatan.

**Urutan kerja yang disepakati.** Draf Konstitusi v0.3 dan pengesahannya lebih
dulu; naskah persetujuan diperbaiki; triase risiko tiga tingkat paralel dengan
ekstraksi; pemeriksaan balasan sebelum dikirim untuk giliran berisiko; profil
pemahaman di latar menumpang pemadatan riwayat; pagar regex dipindah ke model
setelah dibuktikan probe; mode testing diberi peta model per tingkatan agar
routing dapat diamati.

Catatan terpisah: `resolveModel` sekarang mengembalikan satu model untuk semua
tingkatan dalam mode testing, sehingga seluruh routing yang dibahas di sini tidak
dapat diamati sama sekali sebelum peta per tingkatan itu ada.

Tidak ada kode, konfigurasi, status kemampuan, tes, atau proses bot yang diubah
pada sesi ini.

## 27 Juli 2026 — Kesenjangan menuju agent dipetakan

**Dibahas.** Pemilik produk menilai Harvy masih jauh dari sebuah agent dan tidak
proaktif, lalu meminta pemetaan apa yang belum dibuat menurut dokumen.

Pemeriksaan kode menemukan tiga kesenjangan struktural, bukan kesenjangan mutu:

1. **Harvy hanya bicara ketika disapa.** Satu-satunya pesan atas inisiatif
   sendiri adalah pengingat yang diminta pengguna, lewat `setInterval` di
   `reminder-worker.ts`. Tidak ada penjadwal lain, tidak ada jam tenang, tidak
   ada model izin. Seluruh kendali proaktivitas Pasal 4 — kapan boleh
   menghubungi, jenis dan frekuensi, jam tenang, tindakan otomatis, tindakan
   yang wajib dikonfirmasi — belum ada satu pun di kode. Ketidakproaktifan ini
   bukan cacat; fiturnya memang belum pernah dibangun.
2. **Harvy tidak punya kata kerja.** Yang dapat ia lakukan hanya menulis teks,
   mengubah tugas, dan mengubah memori. Tidak ada pencarian, kalender, atau
   akses apa pun ke luar chat. Agent adalah model beserta alatnya; yang ada baru
   modelnya.
3. **Harvy tidak dapat membawa pekerjaan lintas giliran.** `PendingStore` hanya
   menyimpan satu langkah, di memori, hangus sepuluh menit. Tutoring lima
   langkah Pasal 3.4 masih "Belum": promptnya ada, alurnya tidak.

Catatan yang pantas diingat: pembeda nomor 4 di `PROJECT.md` adalah "bantuan
proaktif yang memakai izin", salah satu dari tujuh hal yang membenarkan Harvy
ada. Justru itu yang belum dibangun sama sekali.

Batasnya juga dicatat. Pasal 5 nomor 12 melarang mengoptimalkan jumlah pesan,
waktu penggunaan, dan retensi, sehingga proaktif di sini tidak boleh berarti
notifikasi agar pengguna kembali. Ukurannya tetap Pasal 8.

Urutan yang diusulkan: kendali izin dan jam tenang lebih dulu sebagai fondasi,
lalu check-in berjadwal yang diizinkan, lalu tugas yang disinggung sebagai
percakapan, baru tutoring lima langkah dan tombol adaptif. Keberatan yang ikut
dicatat: sesi sebelumnya menaruh lapisan keselamatan sebagai kandidat pertama
menurut risiko, dan alasan itu menguat di sini — pesan proaktif kepada pelajar
di bawah 18 dapat datang ketika keadaannya sedang tidak baik, sementara belum
ada pemeriksaan isi sebelum pesan terkirim.

**Yang diputuskan.** Dua hal:

1. **Bentuk proaktif pertama adalah check-in berjadwal.** Harvy meminta izin
   sekali — misalnya menanyakan kabar tiap Minggu malam — lalu menyapa pada
   jadwal itu, dan mematikannya cukup sekali ketuk. Dipilih karena paling terasa
   punya inisiatif sekaligus paling mudah ditolak penggunanya.
2. **Lapisan keselamatan dikerjakan lebih dulu, proaktivitas menyusul di
   atasnya.** Pesan yang datang tanpa diminta tidak boleh terkirim tanpa
   diperiksa, dan pengguna di bawah 18 membuat taruhannya lebih tinggi.

Ruang lingkup lapisan keselamatan, dari `ADR-003` dan `STATUS.md`: pemeriksaan
risiko berdiri sendiri **sebelum** klasifikasi intent (sekarang urutannya
terbalik), membedakan tekanan biasa dari kebutuhan dukungan manusia dan bahaya
segera; jalur prioritas supaya giliran berbahaya tidak mengantre di belakang
balasan yang sedang berjalan; pemeriksaan isi balasan sebelum dikirim, setidaknya
untuk giliran yang ditandai berisiko; dan arahan ke bantuan manusia yang nyata.

**Belum diputuskan.** Cara menangani pengguna di bawah 18. Menanyakan umur
menambah data yang dikumpulkan dan bertentangan dengan Pasal 3.9; memperlakukan
semua pengguna sebagai kemungkinan di bawah 18 lebih aman tetapi menyamaratakan
perlindungan, yang justru dilarang Pasal 3.10. Ini perlu diputuskan sebelum
lapisan keselamatan ditulis.

Tidak ada kode, konfigurasi, status kemampuan, tes, atau proses bot yang diubah
pada sesi ini.

## 27 Juli 2026 — Sepuluh cacat dari transkrip Telegram pertama

**Kenapa.** Pemilik produk menjalankan alur kenalan yang baru di Telegram dan
melaporkan hasilnya: Harvy "ga enak diajak chattan, jutek, ga proaktif, ga kayak
temen", tidak memahami, dan berhalusinasi. Transkripnya diserahkan utuh.

**Yang ditemukan.** Sepuluh cacat, dua di antaranya serius.

1. **Orientasi seksual tersimpan otomatis tanpa izin.** Catatan "menyukai
   seseorang berjenis kelamin pria" lolos dari pagar sensitif: `\bjenis kelamin\b`
   tidak cocok dengan "berjenis kelamin", dan "pria" tidak ada di daftar
   kata-katanya. Pelanggaran Pasal 4 nomor 3, dan bentuk kedua dari cacat yang
   sama persis pada 26 Juli.
2. **Kalimat "iya kan aku udah tulis di situ kamu pahami aja" membuka seluruh
   daftar memori** berikut tombol "Lupakan semua tentang aku" — yang lalu
   benar-benar ditekan, dan seluruh riwayat pengguna hilang. Sebuah salah baca
   berjarak satu ketukan dari penghapusan permanen.
3. Balasan terdengar jutek: "Aku jalan pakai sistem dari Google. Gitu aja sih."
   Aturan anti-pola yang ditulis sehari sebelumnya terlalu keras.
4. Curhat sembilan paragraf — kebingungan hidup, ITB, pemrograman, pertemanan,
   hobi — dijawab satu kalimat.
5. Harvy tidak tahu jam berapa sekarang. Pada pukul 23.02 ia menyuruh "rebahan
   dulu" lalu mengajak "ngobrol sambil nunggu malam".
6. Pesan pertama seseorang dijawab "Ada yang mau dibahas lagi?".
7. "eh buat pengingat dong" tersimpan sebagai tugas berjudul "Membuat pengingat"
   tanpa tenggat, padahal Harvy sendiri sedang menanyakan isinya.
8. Tombol "Aku mau tanya dulu" tetap hidup setelah ditekan; penjelasan
   persetujuan terkirim dua kali.
9. Naskah statis terpenggal di tengah kalimat — baris sudah dipatahkan di kode
   lalu dibungkus sekali lagi oleh Telegram.
10. Catatan memori memanggil pemiliknya "Pengguna" di layarnya sendiri.

Pertanyaan gaya juga muncul tepat setelah pesan pembuka "p".

**Yang berubah.**

- `memory-policy.ts`: pola sensitif diperluas ke ketertarikan romantis, crush,
  identitas gender, dan orientasi, tanpa bergantung pada satu susunan kalimat.
- `understanding-route.ts`: dua pagar baru yang memeriksa teks asli, bukan hanya
  JSON model. `looksLikeMemoryRequest` menuntut pesannya memang menyinggung
  ingatan sebelum daftar memori boleh terbuka; `isVagueTaskTitle` menolak judul
  yang hanya menyebut tindakan mencatat.
- `persona.ts`: aturan gaya diseimbangkan — larangan balasan datar yang menutup
  obrolan, panjang mengikuti apa yang dibawa pengguna, larangan menyuruh
  pengguna mengulang yang sudah ditulis. Panduan `feeling` kini membedakan
  keluhan sehari-hari dari cerita yang benar-benar berat. `replyPrompt` menerima
  jam dan zona waktu, dan menegaskan jam itu tidak disebut ketika pengguna sudah
  menyatakan keadaannya sendiri. Prompt pemahaman melarang kata "Pengguna" di
  isi memori dan mewajibkan ketertarikan romantis berjenis `personal`.
- `depthDirective` baru: pesan di atas 400 karakter dipecah menjadi kerangka isi
  pesannya sendiri, lalu ditempelkan **di dalam giliran pengguna**. Tiga
  penempatan lain dicoba lebih dulu dan semuanya gagal; sebagai pesan sistem
  kedua ia hilang sama sekali pada penyedia yang hanya mengenal satu
  `system_instruction`.
- Seluruh naskah statis ditulis ulang sebagai paragraf utuh tanpa penggalan
  baris. `tests/copywriting.test.ts` baru menjaganya untuk 25 layar sekaligus,
  sekaligus melarang kata "Pengguna".
- Tombol "Aku mau tanya dulu" mematikan papan tombol lamanya sebelum mengirim
  penjelasan. Pertanyaan gaya baru muncul setelah riwayat mencapai enam giliran.
- `scripts/coba-balasan.ts` menerima `--riwayat=berkas.json` supaya pengulangan
  lintas giliran dapat diuji dengan riwayat sungguhan.

**Bukti.** `npm run check` PASS. Setelah `rm -rf dist`, `npm test` PASS —
**157 test dalam 26 suite**, 0 gagal.

Agent penguji terpisah menjalankan dua belas skenario dari transkrip lewat probe
model sungguhan. Delapan lulus, termasuk ketiga pagar klasifikasi dan seluruh
keluhan nada. Tiga yang dilaporkan lemah diperbaiki lalu diprobe ulang: keluhan
ringan kini dijawab ringan, pembuka tidak lagi mengulang "Wah" pada giliran
berikutnya, dan jam sistem tidak lagi disandingkan dengan keadaan yang disebut
pengguna.

Yang **tidak** selesai: pesan panjang yang dibuka satu kalimat pengarah
("bahas ini kocak: …") tetap dijawab hanya tentang kalimat pembuka itu. Lima
variasi prompt dicoba. Isi yang sama tanpa kalimat pengarah dijawab penuh, jadi
penyebabnya bukan panjangnya. Ini tampak sebagai batas model kecil, dan
`AI_MODE=testing` memakai satu model kecil untuk semua tingkatan sehingga tidak
dapat dibedakan dari sini.

Yang **tidak** diuji: seluruh perbaikan ini belum dijalankan ulang lewat
Telegram. Sepuluh langkah uji manual baru ditambahkan di
`docs/engineering/TESTING.md` nomor 44–54 dan semuanya masih NOT RUN.

## 26 Juli 2026 — Rasa percakapan dan onboarding dikerjakan

**Kenapa.** Pemilik produk menyetujui empat keputusan pada entri di bawah,
memilih naskah perkenalan yang diusulkan, dan meminta keduanya dikerjakan
sekaligus dengan catatan agar gaya bahasanya natural.

**Yang berubah.**

*Rasa percakapan.*

- `Conversation.reply` kini mengirim giliran terakhir sebagai pesan chat
  sungguhan (`role` user/assistant), bukan kutipan di dalam pesan sistem.
  Memori dan ringkasan tetap dibungkus `<konteks>`. `RECENT_TURNS_NOTE` di
  `persona.ts` menggantikan pembungkus yang hilang: ia menegaskan giliran lama
  tetap perkataan pengguna dan aturan Harvy hanya yang ada di pesan sistem.
  Langkah `understand` tidak berubah.
- `IDENTITY` mendapat aturan menulis seperti orang mengetik di chat dan daftar
  pola yang membuatnya terdengar seperti mesin: mengulang pembuka, menyebut nama
  di setiap pesan, selalu menutup dengan pertanyaan, merangkum ulang pengguna,
  menawarkan solusi sebelum diminta.
- Kalimat yang berisi perasaan sekaligus tugas tidak lagi dijawab hanya dengan
  kartu. `handleFreeText` menyusun balasan lebih dulu untuk semua intent, lalu
  kartu tugas menyusul tanpa kalimat pembuka kedua. Bila panggilan balasan
  gagal, tugasnya tetap dicatat memakai kalimat dari kode.
- `bot/phrasing.ts` baru: setiap kalimat tetap Harvy punya beberapa bentuk,
  dipilih lewat fungsi acak yang boleh diberikan dari luar supaya dapat diuji.
- Pemberitahuan memori menjadi satu baris `📎` di ujung bubble terakhir berikut
  tombol Lupakan, menggantikan bubble tersendiri bertombol Oke/Lupakan.
  Tombolnya memakai callback `memdrop:` yang hanya membuang barisnya lewat
  `withoutMemoryNote`; `memforget:` yang menimpa seluruh pesan tetap dipakai
  pada daftar memori. Akibat langsungnya, `src/bot/ephemeral-message-store.ts`
  beserta tesnya dihapus — tidak ada lagi bubble sementara yang perlu dilacak
  dan dihapus.
- Bubble lanjutan didahului indikator mengetik dan jeda 0,3–1,2 detik
  (`bubblePauseMs`), untuk keterbacaan dan bukan untuk memperpanjang percakapan.

*Kenalan dan persetujuan.*

- `domain/profile.ts`, `storage/file-profile-repository.ts`, dan
  `core/profile-service.ts` baru. Isinya sesedikit mungkin: `consentVersion`,
  `onboardedAt`, `stylePreference`, `styleAskedAt`. Nama panggilan sengaja tidak
  disimpan — Telegram sudah mengirimkannya, dan nama yang dikoreksi pengguna
  sudah menjadi memori jenis `profile`.
- Gerbang persetujuan dipasang di handler `message:text` **sebelum**
  `MessageBatcher.enqueue`. Ini bukan pilihan gaya: batcher memanggil
  `classifyTurnBoundary`, dan panggilan itu sudah mengirim teks pengguna ke
  penyedia. Statusnya dibaca sekali per pengguna lewat satu promise yang dipakai
  ulang, sehingga bubble beruntun tidak membaca berkas berkali-kali dan tidak
  masuk batcher terbalik.
- `bot/onboarding.ts` memuat naskah dua bubble, penjelasan panjang untuk yang
  menekan "Aku mau tanya dulu", sapaan pengguna lama, pertanyaan gaya, dan
  `HeldMessageStore`. Pesan yang telanjur dikirim ditahan di memori proses saja,
  tidak pernah ke berkas, karena isinya belum disetujui untuk diproses.
- Pesan pertama yang lolos `looksUrgent` dijawab arahan keselamatan tetap tanpa
  memanggil model sama sekali. `looksUrgent` kini diekspor dari
  `turn-taking-policy.ts` untuk dipakai ulang di sini.
- `/start` menjadi salah satu pintu masuk perkenalan, bukan syaratnya. Pengguna
  lama disapa dari jumlah tugas aktifnya, bukan dari ingatan yang dikarang.
- Pertanyaan gaya menemani diajukan sekali setelah percakapan pertama, hanya
  bila tidak ada pertanyaan lain yang sedang menunggu jawaban. Hasilnya masuk ke
  prompt balasan.
- "Lupakan semua tentang aku" kini juga menghapus preferensi gaya, tetapi
  mempertahankan catatan persetujuan.
- `scripts/coba-balasan.ts` baru. Sampai sekarang tidak ada cara memeriksa
  bagaimana Harvy *terdengar* tanpa membuka Telegram, padahal gaya bicara justru
  yang paling sering disetel.

**Bukti.** `npm run check` PASS. Setelah `rm -rf dist`, `npm test` PASS —
**147 test dalam 25 suite**, 0 gagal. Angka itu sudah memperhitungkan enam tes
`EphemeralMessageStore` yang ikut dihapus.

Probe model sungguhan lewat `scripts/coba-balasan.ts` pada Gemini 3.5
Flash-Lite, lima kalimat: curhat dua bubble, lanjutan dengan riwayat contoh,
kalimat tugas bertenggat, permintaan pengingat, dan kebingungan memulai dengan
gaya `advice`. Semuanya menghasilkan satu sampai dua bubble pendek, tanpa
menyebut nama pengguna, tanpa merangkum ulang, dan tanpa mengulang pembuka
giliran sebelumnya. Permintaan pengingat dijawab "Sip, nanti aku ingetin jam 8
ya" lebih dulu — persis perilaku yang dulu hilang di balik struk pencatatan.

Yang **tidak** diuji: seluruh alur perkenalan pada Telegram, penahanan pesan
pertama, arahan keselamatan pra-persetujuan, pertanyaan gaya, catatan memori
yang menempel, serta jeda antar bubble. Tidak satu pun pernah berjalan di
Telegram. Ketahanan riwayat berperan `user` terhadap injeksi juga belum diuji:
tesnya hanya membuktikan penegasannya ada di prompt, bukan bahwa model
menaatinya. Model produksi belum dipakai.

**Sengaja ditinggalkan.** Menarik persetujuan dari dalam chat belum ada;
sekarang satu-satunya cara berhenti adalah berhenti memakai Harvy. Tombol
adaptif yang disusun AI tetap belum dikerjakan, dan lapisan keselamatan mandiri
tetap kandidat berikutnya menurut risiko.

## 26 Juli 2026 — Rasa percakapan dan onboarding: empat keputusan diambil

**Dibahas.** Lanjutan dua entri sebelumnya tentang UX kenalan dan rasa
percakapan. Sesi ini tidak mengulang usulannya, melainkan menelusuri penyebabnya
di kode lalu menutup pertanyaan yang menggantung.

Penyebab rasa "mengisi formulir" ditemukan di empat tempat:

1. `create-bot.ts:259` — ketika intent `task` + `taskAction: save`, alur langsung
   `saveTask()` lalu `return`, sehingga `conversation.reply()` tidak pernah
   dipanggil. Kalimat yang membawa perasaan sekaligus tugas dijawab hanya dengan
   struk pencatatan. Ini penyebab terbesar karena mengenai jalur yang paling
   sering dipakai.
2. Kalimat Harvy sendiri hardcoded dan identik setiap kali: "Sudah aku catat.",
   "Oke, nggak aku catat.", "Selesai ✓", "Semua beres. Nikmati waktumu 🌿".
3. `conversation.ts:189` hanya mengirim `system` + pesan terakhir; enam giliran
   terakhir diselipkan sebagai teks di dalam `<konteks>`, sehingga model membaca
   percakapan sebagai arsip, bukan obrolan berjalan.
4. Tidak ada instruksi apa pun di `persona.ts` yang meminta balasan ditulis
   sebagai beberapa paragraf pendek, sehingga `splitReplyBubbles` praktis selalu
   menghasilkan satu bubble. Indikator mengetik juga hanya dikirim sekali di awal
   giliran, bukan di antara bubble.

**Yang diputuskan.** Empat keputusan pemilik produk:

1. **Riwayat memakai bentuk hybrid.** Enam giliran terakhir dikirim sebagai
   pesan chat asli (`role` user/assistant), sedangkan memori dan ringkasan tetap
   dibungkus `<konteks>`. Ini menggeser invarian anti-injeksi di `AGENTS.md`,
   jadi penegasan barunya harus ditulis bersama perubahan kodenya, bukan
   sesudahnya.
2. **Jalur pencatatan tugas membalas lebih dulu.** Harvy menanggapi isi pesannya
   sebagai teman bicara, kartu tugas dan tombolnya menyusul di bubble kedua.
   Konsekuensinya satu panggilan model tambahan pada jalur `task`.
3. **Pemberitahuan memori digabung ke bubble terakhir** sebagai satu baris tipis
   berikut tombol Lupakan, menggantikan bubble terpisah bertombol Oke/Lupakan.
   Pasal 4 nomor 2 mewajibkan pemberitahuan dan jalan keluar di pesan yang sama,
   bukan bubble tersendiri.
4. **Preferensi gaya ngobrol ditanyakan setelah interaksi pertama**, bukan saat
   onboarding. Onboarding cukup perkenalan dan persetujuan.

**Temuan teknis untuk onboarding.** Dua pertanyaan lama tertutup oleh kode:

- Gerbang persetujuan harus dipasang di `create-bot.ts:169`, **sebelum**
  `messageBatcher.enqueue`. Batcher memanggil `classifyTurnBoundary`, dan itu
  sudah mengirim teks pengguna ke penyedia model; gerbang di dalam
  `handleFreeText` berarti persetujuannya sudah bocor sebelum ditanyakan.
- Pesan pertama yang menunjukkan bahaya segera dapat dikenali tanpa jaringan
  lewat `looksUrgent()` di `turn-taking-policy.ts:112`, sehingga respons
  keselamatan dan arahan ke bantuan manusia bisa diberikan tanpa mengirim apa pun
  ke pihak ketiga. Onboarding menyusul sesudahnya.

Keputusan pendukung: status onboarding disimpan lewat port baru
`domain/profile.ts` dan `storage/file-profile-repository.ts` dengan pola yang
sama seperti tiga repository lain, berisi `onboardedAt`, `consentVersion`,
`nickname`, dan `stylePreference`. Pesan pertama yang ditahan tidak ditulis ke
berkas — cukup di memori proses seperti `PendingStore` — karena isinya kata-kata
yang belum disetujui untuk diproses. "Lupakan semua" menghapus `nickname` dan
`stylePreference`, tetapi mempertahankan `onboardedAt` dan `consentVersion`; jika
ikut terhapus, penghapusan data berubah menjadi onboarding ulang dan itu
mempersulit penarikan izin yang dilarang Pasal 4 nomor 5. Nama panggilan tidak
ditanyakan di depan karena Telegram sudah memberi `from.first_name`.

Draf naskah perkenalan disusun: dua bubble, satu baris tombol
`[Oke, mulai] [Aku mau tanya dulu]`. Bubble pertama menyebut nama Harvy dan
mengajak membawa apa saja — cerita berantakan, pertanyaan, tugas, rencana, atau
hal yang belum tahu harus dimulai dari mana. Bubble kedua menyampaikan bahwa
Harvy berjalan dengan AI, isinya dikirim ke layanan di luar Harvy, dan Harvy
dapat salah. Bila pesan pertama sudah telanjur dikirim, ditambahkan satu kalimat
bahwa pesan itu ditahan dan belum dibaca. Frasa "AI pendamping", daftar fitur,
dan `HELP_MESSAGE` tidak muncul di sini. Pesan tambahan sebelum tombol ditekan
dikumpulkan diam-diam dan hanya diingatkan sekali.

**Belum diputuskan.** Persetujuan akhir atas naskah di atas, angka awal serta
pemicu kenaikan `consentVersion`, dan urutan pengerjaan terhadap lapisan
keselamatan yang pada sesi sebelumnya dinilai kandidat pertama menurut risiko.

Yang **tidak** dilakukan: tidak ada kode, konfigurasi, status kemampuan, tes,
atau proses bot yang diubah. Perubahan hanya pada berkas ini.

## 26 Juli 2026 — Seluruh perubahan dipusatkan di `main`

**Kenapa.** Pemilik produk meminta seluruh perubahan proyek dikirim ke
repository GitHub Harvy pada branch `main`, lalu seluruh branch selain `main`
dihapus.

**Yang berubah.**

- Referensi GitHub disegarkan dan setiap branch diperiksa sebelum dihapus.
  `feat/memori-dan-riwayat-percakapan` serta
  `fix/dokumen-usang-dan-skrip-diagnostik` sama-sama telah menjadi leluhur
  `main`; tidak ada commit unik yang dibuang.
- Stash `epitaxy: pre-switch from feat/memori-dan-riwayat-percakapan` ditemukan
  saat audit. Seluruh isinya—perbaikan UX bubble, batas giliran adaptif,
  riwayat, memori, routing intent, dan tes—dipulihkan, konflik tambahan entri
  `LOG.md` digabungkan tanpa membuang salah satunya, lalu disimpan pada commit
  `67b1fac`. Stash baru dihapus setelah commit dan working tree dipastikan
  bersih.
- Perubahan aturan kerja disimpan pada commit `b29921b`. Branch `main` lokal
  kemudian dimajukan secara fast-forward dari `91ec013` ke `67b1fac` dan
  berhasil dikirim ke `origin/main`.
- Branch lokal dan remote `feat/memori-dan-riwayat-percakapan` serta
  `fix/dokumen-usang-dan-skrip-diagnostik` dihapus setelah keduanya dipastikan
  telah tergabung.

**Bukti.** `npm run check` PASS. Setelah target
`C:\Users\imamh\harvy\dist` dipastikan tepat lalu hasil build lama dihapus,
`npm test` PASS — **122 test dalam 20 suite**, 0 gagal.
`git diff --cached --check` PASS sebelum commit. `git push origin main` berhasil
memajukan GitHub dari `7337b91` ke `67b1fac`; penghapusan kedua branch remote
dan kedua branch lokal juga dikonfirmasi berhasil oleh Git.

Yang **tidak** diuji: bot tidak dijalankan ulang di Telegram pada sesi
integrasi ini. Karena itu hasil manual yang masih ditandai `NOT RUN` di
`docs/engineering/STATUS.md` dan `docs/engineering/TESTING.md` tetap belum
terbukti.

## 26 Juli 2026 — Kerja langsung di `main` diizinkan

**Kenapa.** Pemilik produk meminta agar agent boleh mengedit branch `main`
langsung tanpa wajib membuat pull request, serta meminta larangan lama dihapus
atau diselaraskan.

**Yang berubah.**

- `AGENTS.md` dan `docs/operations/WORKFLOW.md` kini mengizinkan agent menulis
  serta membuat commit pada branch aktif, termasuk `main`.
- Branch terpisah dan pull request dinyatakan opsional—dipakai hanya bila
  diminta atau berguna untuk isolasi pekerjaan dan review.
- Push, force-push, merge, rebase, dan penghapusan branch tetap hanya dilakukan
  bila diminta; izin bekerja langsung di `main` bukan izin melakukan perubahan
  eksternal diam-diam.
- Catatan keputusan di `ADR-001` dan `ADR-005` diperbarui agar aturan historis
  tidak bertentangan dengan instruksi aktif.

**Bukti.** Seluruh larangan aktif terhadap tulisan langsung di `main` dicari di
`AGENTS.md`, `README.md`, `docs/`, dan `.githooks`; sumber yang ditemukan telah
diselaraskan. `git diff --check` lulus dan `npm run check` lulus. Pemanggilan
awal `npm test` menemukan tiga tes JavaScript lama di `dist/` dari branch lain,
bukan kegagalan sumber saat ini. Setelah memastikan target lalu menghapus hanya
hasil build `C:\Users\imamh\harvy\dist`, `npm test` membangun ulang dan lulus:
63 tes dalam 11 suite, 0 gagal. Perubahan hanya menyentuh dokumentasi dan aturan
kerja.

Yang **tidak** dilakukan: tidak ada branch yang dipindah, tidak ada commit,
push, merge, rebase, pull request, kode produk, konfigurasi runtime, atau proses
bot yang diubah.
## 26 Juli 2026 — Onboarding dipicu kontak pertama, bukan `/start`

**Dibahas.** Pemilik produk meluruskan rancangan UX kenalan. Perkenalan Harvy
harus terjadi pada kontak pertama pengguna, baik ia mengirim `/start` maupun
langsung menulis pesan biasa. `/start` hanyalah salah satu pintu masuk dan
tidak boleh menjadi syarat memperoleh onboarding.

Jika pesan pertama sudah membawa isi—misalnya pengguna langsung bercerita—pesan
itu perlu ditahan lokal, perkenalan serta persetujuan ditampilkan, lalu pesan
aslinya diproses otomatis setelah pengguna melanjutkan. Pengguna tidak diminta
mengetik ulang. Pengguna lama yang menjalankan `/start` tidak mengulang
onboarding atau kehilangan konteks.

Frasa “AI pendamping” dinilai kaku dan membuat kemampuan Harvy terdengar sempit.
Perkenalan sebaiknya berfokus pada hal luas yang dapat dibawa pengguna:
cerita yang masih acak, pertanyaan, tugas, ide, rencana, atau sesuatu yang belum
tahu harus dimulai dari mana. Transparansi bahwa Harvy menggunakan AI tetap
diperlukan oleh Konstitusi, tetapi disampaikan terpisah dan alami bersama
penjelasan keterbatasan serta pemrosesan pihak ketiga—bukan dijadikan label
utama identitas Harvy.

Status onboarding sebaiknya terpisah dari keberadaan riwayat: menghapus riwayat
tidak otomatis menjadikan pengguna “baru”. Persetujuan juga perlu memiliki
versi agar dapat diminta ulang hanya ketika ketentuannya benar-benar berubah.

Belum diputuskan naskah akhir perkenalan, perilaku saat pengguna mengirim pesan
lanjutan sebelum menekan consent, dan pengecualian untuk pesan pertama yang
menunjukkan bahaya segera. Tidak ada kode, konfigurasi, status kemampuan, tes,
atau proses bot yang diubah.

## 26 Juli 2026 — UX kenalan dan rasa percakapan diusulkan

**Dibahas.** Pemilik produk ingin Harvy memberi kesan “ini AI yang aku
butuhkan”: hangat dan senyaman chat dengan teman, tetapi tetap jujur sebagai AI.
Pengalaman pengguna pertama juga belum ada; seharusnya Harvy berkenalan sebelum
menumpahkan petunjuk penggunaan.

Pemeriksaan alur saat ini menunjukkan `/start` langsung mengirim satu blok
panjang berisi fokus tugas, contoh, memori, dan daftar perintah. Belum ada status
pengguna baru/kembali, consent pemrosesan pihak ketiga, pertanyaan panggilan,
atau preferensi cara didampingi. Pengguna mendapat manual sebelum merasakan
percakapan.

Arah yang diusulkan bernama sementara **“Kenalan & Cara Harvy Menemani”**:

1. perkenalan dalam dua atau tiga bubble pendek: nama Harvy, identitas sebagai
   AI pendamping, dan manfaat utama tanpa daftar fitur;
2. pemberitahuan privasi ringkas serta persetujuan sebelum pesan pertama
   dikirim ke penyedia model;
3. nama panggilan bersifat opsional, dapat memakai nama Telegram atau dilewati;
4. Harvy menanyakan satu preferensi yang benar-benar berguna—misalnya lebih
   suka didengarkan dulu atau langsung diberi saran—bukan mengumpulkan profil;
5. pesan pertama yang sudah telanjur dikirim ditahan lokal lalu diproses
   otomatis setelah consent, bukan diminta diketik ulang;
6. pengguna lama tidak mengulang onboarding ketika memakai `/start`; Harvy
   cukup menyapa dan menawarkan melanjutkan topik lama atau memulai hal baru;
7. semua tombol hanya jalan pintas; pengguna selalu boleh langsung menulis
   bebas.

Rasa “seperti teman” diartikan sebagai ritme dan perhatian, bukan kepura-puraan
bahwa Harvy manusia. Balasan perlu menghindari pola berulang seperti selalu
menyebut nama pengguna, selalu berkata “Harvy dengerin”, atau selalu menutup
dengan pertanyaan. Harvy sebaiknya membedakan keadaan menyimak, berdiskusi, dan
membantu bertindak; merujuk detail yang baru dikatakan; memberi satu respons
yang relevan per bubble; dan baru menawarkan solusi ketika dibutuhkan.

Belum diputuskan apakah preferensi gaya ngobrol ditanyakan saat onboarding atau
setelah interaksi pertama yang berhasil. Belum diputuskan pula naskah akhir,
jumlah bubble, tombol, ataupun bentuk penyimpanan status onboarding. Alur
keselamatan tetap kandidat penting dan tidak dianggap selesai oleh rancangan
onboarding ini.

Yang **tidak** dilakukan: tidak ada kode, konfigurasi, status kemampuan, tes,
atau proses bot yang diubah.

## 26 Juli 2026 — Prioritas fitur berikutnya dibahas, belum dipilih

**Dibahas.** Pemilik produk meminta diskusi saja mengenai fitur berikutnya.
Tidak ada implementasi atau keputusan final.

Sebelum menambah kemampuan, perbaikan terbaru tetap perlu diuji ulang lewat
Telegram dan Sprint 1 masih mempunyai uji mandiri tujuh hari yang belum
selesai. Sesudah itu, kandidat terkuat adalah **lapisan keselamatan mandiri dan
alur bantuan manusia**. Alasannya berdasarkan keadaan produk, bukan sekadar
backlog: pengguna sudah memakai Harvy untuk curhat, audiens mencakup pelajar di
bawah 18 tahun, sementara `STATUS.md` masih mencatat penilaian keselamatan hanya
berasal dari satu field model. Pagar `urgent` terbaru hanya melewati keputusan
batas bubble; ia belum memprioritaskan handler di atas balasan aktif dan belum
menjadi alur keselamatan khusus.

Arah awal yang layak dirancang kemudian:

1. membedakan tekanan biasa, kebutuhan dukungan manusia, dan bahaya segera
   secara proporsional;
2. menjalankan pemeriksaan terpisah sebelum intent umum;
3. memberi jalur prioritas atau acknowledgment aman tanpa merusak urutan
   riwayat;
4. tidak menyimpan isi sensitif otomatis; dan
5. mengarahkan pengguna kepada manusia aman tanpa membuat Harvy tampak seperti
   terapis atau layanan darurat.

Urutan kandidat setelah keselamatan adalah pemberitahuan serta persetujuan
pemrosesan pihak ketiga, tombol tindakan adaptif dan kontrol pengingat milik
pengguna, lalu tutoring lima langkah. Keselamatan dan privasi dipandang sebagai
gerbang sebelum memperluas penggunaan, sedangkan PostgreSQL, website, dan
WhatsApp belum menjadi prioritas berikutnya.

Yang **tidak** dilakukan: tidak ada kode, konfigurasi, status kemampuan, tes,
proses bot, atau keputusan arsitektur yang diubah. Pilihan akhir fitur berikutnya
tetap milik pemilik produk.

## 26 Juli 2026 — Batas giliran menjadi adaptif terhadap cara pengguna mengetik

**Kenapa.** Uji Telegram kelima membuktikan bahwa adapter nonblocking saja belum
cukup. Rangkaian "eh tau ga" sampai ungkapan takut terpecah menjadi tiga
giliran, dan rangkaian "aku mau curhat" yang berakhir sementara pada "karna"
terpecah menjadi dua. Riwayat aktual menunjukkan bubble memang sempat digabung,
tetapi hanya tiga lalu satu lalu satu pada rangkaian pertama, serta dua lalu dua
pada rangkaian kedua. Proses bot sudah menjalankan source terbaru; penyebabnya
bukan build lama atau instance ganda, melainkan deadline universal 2,5 detik
yang lebih pendek daripada jeda alami pengguna sekitar 3–4,5 detik.

**Yang diputuskan.** Tidak ada sinyal Telegram yang menyatakan pengguna benar-
benar selesai mengetik, sehingga batas giliran tetap merupakan perkiraan dari
isi dan waktu hening. Satu angka tidak cukup untuk sapaan lengkap, pembuka
cerita, kalimat menggantung, dan keadaan darurat. Keputusan model diubah menjadi
empat keadaan dengan jendela berbeda, serta pagar lokal untuk kasus yang jelas.

**Yang berubah.**

- `Conversation.classifyTurnBoundary` meminta model `cheap` mengeluarkan
  `complete`, `open`, `incomplete`, atau `urgent`; parser masih menerima bentuk
  boolean lama secara defensif.
- `turn-taking-policy.ts` menjadi sumber kebijakan murni. Pesan lengkap tunggal
  diproses setelah debounce dan pemeriksaan model; gabungan lengkap diberi
  ruang 4 detik, pembuka/narasi terbuka 7 detik, dan fragmen keras seperti
  "karna" 12 detik sejak bubble terakhir.
- Pengaman lokal mengenali pembuka seperti "eh tau ga" dan "aku boleh curhat
  kah", emosi samar, kata sambung menggantung, serta penutup eksplisit seperti
  "udah itu aja" dan "nggak jadi". Penutup menang atas pembuka lama agar Harvy
  tidak menunggu setelah pengguna jelas selesai.
- Bahaya segera yang konkret diproses langsung ketika bubble masuk, sebelum
  debounce atau request jaringan batas giliran. Kata takut/capek tanpa ancaman
  konkret tetap dianggap percakapan terbuka, bukan otomatis darurat. Handler
  lengkapnya masih menjaga urutan FIFO dengan balasan yang sudah aktif.
- `MessageBatcher` tetap memakai satu evaluator per pemilik, revision guard,
  antrean per pengguna, serta fail-safe dari waktu bubble terakhir. Keputusan
  model yang gagal jatuh ke kebijakan lokal; satu kegagalan jaringan tidak lagi
  memaksa pembuka atau fragmen jelas ditutup cepat.
- Prompt, skrip diagnostik, README, ADR, status, kontrak agent, dan panduan uji
  diselaraskan dengan state serta jendela adaptif baru.

**Bukti.**

- `npm run check` PASS.
- Target absolut `C:\Users\imamh\harvy\dist` diverifikasi lalu hasil build lama
  dihapus sebelum gerbang akhir.
- Tes terarah `conversation`, `MessageBatcher`, dan kebijakan giliran PASS —
  **35 test dalam 4 suite**, 0 gagal. Regresinya memakai dua rangkaian persis
  dari uji Telegram, sengaja memberi jarak lebih panjang daripada debounce, dan
  memaksa model palsu salah memilih `complete`.
- `npm test` PASS — **122 test dalam 20 suite**, 0 gagal.
- Putaran bersih pertama sempat menghasilkan 121 lulus dan satu kegagalan:
  tes regresi memakai timer mini 70/140 milidetik dan di mesin yang sedang berat
  jeda test runner sendiri melewati jendelanya sebelum bubble berikut dikirim.
  Tes diubah memakai margin panjang serta `drain` eksplisit; aturan angka
  4/7/12 detik tetap diuji murni tanpa jam dinding. Tes terarah dan gerbang
  penuh sesudah koreksi sama-sama lulus.
- `git diff --check` PASS; peringatan yang tampil hanya normalisasi LF ke CRLF.
- Probe Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - rangkaian "eh tau ga" sampai ungkapan takut sempat timeout pada percobaan
    pertama, lalu menghasilkan `{"state":"open"}` pada pengulangan;
  - rangkaian yang berakhir "karna" menghasilkan
    `{"state":"incomplete"}`; dan
  - "halo" menghasilkan `{"state":"complete"}`.
  Timeout pertama penting: tes otomatis juga membuktikan pagar lokal tetap
  menahan rangkaian dan batas giliran darurat tetap dilewati ketika classifier
  tidak pernah selesai.

Yang **tidak** diuji: Telegram belum dicoba lagi setelah kebijakan adaptif
ditulis. Karena itu belum ada klaim bahwa jeda 4/7/12 detik terasa tepat pada
pengguna nyata atau bahwa satu rangkaian terbaru benar-benar tersimpan sebagai
satu giliran. Model produksi `deepseek/deepseek-v4-flash`, tombol, pengingat,
dan shutdown nyata juga `NOT RUN` pada sesi koreksi ini.

Proses dev yang lama ternyata sudah tidak aktif. `npm run dev` dinyalakan lagi
setelah gerbang lulus; pemeriksaan proses menunjukkan satu watcher `tsx` dan
satu child `src/app.ts`, sehingga bot siap menerima uji Telegram terbaru tanpa
instance aplikasi ganda.

**Sengaja ditinggalkan.** Jendela belum dipersonalisasi dari kecepatan ketik
masing-masing pengguna; itu memerlukan data perilaku tambahan dan keputusan
privasi yang tidak diambil diam-diam. Antrean tetap in-memory dan tidak tahan
crash paksa. Keadaan `urgent` belum membatalkan handler yang sudah aktif atau
mengirim acknowledgment keselamatan independen; keduanya memerlukan desain
alur keselamatan agar tidak merusak urutan riwayat.

## 26 Juli 2026 — Bubble cepat benar-benar disimak sebagai satu giliran

**Kenapa.** Uji Telegram keempat memperlihatkan bahwa perbaikan penggabungan
bubble sebelumnya belum bekerja pada adapter nyata. Empat potongan curhat yang
dikirim pada detik yang sama masih menghasilkan tiga balasan Harvy sebelum
pengguna selesai. Penyebabnya bukan keputusan model: handler Telegram menunggu
model batas giliran dan seluruh balasan Harvy, sedangkan long-polling grammY
baru menyerahkan update berikutnya setelah handler itu kembali. Dengan urutan
tersebut, bubble berikutnya memang tidak pernah sempat masuk ke batch yang sama.

**Yang berubah.**

- `MessageBatcher.enqueue` kini hanya menaruh bubble dan langsung kembali.
  Setiap bubble memulai ulang jeda hening 650 milidetik serta deadline keras 2,5
  detik dari bubble terakhir. Setelah jeda hening, model `cheap` menilai
  gabungannya; keputusan yang kalah cepat dari bubble atau deadline baru
  diabaikan melalui revision guard. Hanya satu evaluator per pemilik yang aktif
  dan revisi perantara dikoaleskan ke gabungan terbaru.
- Prompt batas giliran menilai apakah pengguna **selesai menulis**, bukan apakah
  Harvy sudah dapat memberi balasan sopan. Pembuka curhat dan narasi pribadi
  ditunggu; sapaan, permintaan lengkap, penutup, serta pesan keselamatan yang
  mendesak langsung diproses.
- Indikator mengetik dipindahkan ke awal penanganan batch, sehingga Harvy tidak
  tampak mengetik pada setiap potongan ketika sebenarnya sedang menyimak.
  Kegagalan indikator kini best-effort dan tidak membuang giliran.
- Handler satu pengguna tetap berurutan, tetapi berjalan dari antrean latar.
  Command dan callback masuk ke chain pemiliknya tanpa menahan long-polling
  global. Permintaan ACK callback dikirim segera secara fire-and-forget dan
  aksi tidak menunggunya.
- Shutdown normal menghentikan polling lalu menguras seluruh batch dan aksi
  latar serta evaluator aktif sebelum proses selesai, dengan batas 60 detik
  agar deployment tidak menggantung tanpa akhir. ACK callback, cleanup notice
  fire-and-forget, dan pemadatan riwayat latar berada di luar drain.
- `/start` dan `/bantuan` membatalkan potongan yang belum mulai. `/tugas`
  mengurasnya lebih dulu agar pernyataan tugas yang baru dikirim tidak hilang.
  Token generasi turut membatalkan batch yang sudah masuk chain tetapi belum
  mulai. Callback juga menguras giliran terdahulu sebelum mutasi, sehingga
  Lupakan semua tidak dapat diikuti penyimpanan terlambat dari handler lama.
- Status **Ubah tenggat** sekarang diperiksa ketika batch mendapat giliran,
  bukan saat update tiba. Ini menjaga jawaban tanggal yang dikirim segera
  setelah tombol, meskipun tindakan tombol masih mengantre di belakang balasan
  lama.
- Pembersihan pemberitahuan memori diulang saat handler benar-benar berjalan.
  Notifikasi yang dibuat terlambat oleh giliran sebelumnya tetap hilang ketika
  chat berikutnya dimulai. Referensi yang gagal dihapus dari Telegram disimpan
  ulang dengan deduplikasi untuk percobaan berikutnya. Lease/tombstone mencegah
  retry menghidupkan ref yang sudah ditanggapi saat delete masih berjalan;
  retry berhenti setelah tiga kegagalan permanen.
- `scripts/coba-pemahaman.ts --boundary` dapat memeriksa keputusan ini langsung
  ke model; `AGENTS.md`, `ADR-007`, `STATUS.md`, `TESTING.md`, dan `README.md`
  diselaraskan.

**Bukti.**

- `npm run check` PASS.
- `dist/` dihapus setelah target absolut
  `C:\Users\imamh\harvy\dist` diverifikasi; `npm test` PASS —
  **113 test dalam 19 suite**, 0 gagal.
- Suite `MessageBatcher` sendiri PASS — **15 test**, termasuk burst empat
  bubble, model lambat, keputusan basi, deadline, urutan A aktif → B tertunda →
  tombol, kelanjutan setelah handler gagal, pembatalan evaluator dan batch
  queued, deduplikasi request, isolasi dua pengguna, serta drain seluruh batch
  dan evaluator saat shutdown.
- Tes indikator mengetik membuktikan kegagalan API kosmetik tidak melempar;
  enam tes store notice membuktikan referensi retry tidak digandakan maupun
  dihidupkan kembali setelah callback, lease selesai bersih, dan retry berhenti
  setelah tiga kegagalan.
- Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - pembuka curhat → `{"wait":true}`;
  - sapaan mandiri → `{"wait":false}`;
  - lima bubble curhat gabungan → `{"wait":true}`; dan
  - pemahaman lima bubble itu → intent `feeling`, tanpa tugas, dengan satu
    usulan memori `personal` yang wajib meminta izin.
- Satu probe batas giliran sempat timeout pada dua detik; percobaan ulang
  berhasil. Deadline `MessageBatcher` tetap berjalan selama model berpikir, jadi
  kegagalan semacam ini tidak dapat memperpanjang hening melewati 2,5 detik.

Yang **tidak** diuji: bot Telegram belum dijalankan ulang setelah perubahan.
Penggabungan update nyata, ketiadaan indikator/balasan di sela bubble, callback
yang langsung menutup spinner, urutan Lupakan semua, serta respons akun kedua
ketika akun pertama menunggu model dan drain shutdown nyata tetap `NOT RUN`.
Model
`deepseek/deepseek-v4-flash` produksi juga tidak dipanggil.

**Sengaja ditinggalkan.** Pesan, tugas, atau memori dari uji lama tidak dihapus
atau dimigrasikan. Pengguna tetap menguasai penghapusannya melalui tombol.
Antrean belum persisten: crash paksa masih dapat kehilangan update yang sudah
diterima, dan shutdown yang melewati 60 detik keluar paksa. Cleanup kosmetik
dan pemadatan latar tidak ikut ditunggu drain.

## 26 Juli 2026 — Harvy membedakan siapa yang harus mengerjakan

**Kenapa.** Uji Telegram lanjutan menemukan dua salah arah yang berasal dari
kontrak intent, bukan sekadar pilihan kata balasan. Permintaan agar Harvy
membuat kode langsung disimpan sebagai tugas pengguna. Setelah itu, pernyataan
preferensi baru justru membuka daftar memori lama; fakta barunya tidak diproses.

**Yang diputuskan.** Intent menyatakan tujuan percakapan, sedangkan field action
memberi izin terhadap tindakan tertentu.

- `request` berarti Harvy harus menghasilkan sesuatu di chat, bukan mencatat
  pekerjaan.
- Hanya `task + taskAction: save + task` yang boleh menyimpan tugas.
- Hanya `feeling + taskAction: offer + task` yang boleh menawarkan tugas.
- Hanya `memory + memoryAction: list|forget`, tanpa usulan fakta baru, yang
  boleh membuka kontrol memori.
- Fakta atau preferensi baru tetap menjadi percakapan dengan usulan pada
  `memories`; keberadaannya tidak berarti pengguna meminta daftar.

**Yang berubah.**

- `persona.ts` menambah intent `request`, `taskAction`, `memoryAction`, aturan
  aktor pekerjaan, dan lima contoh JSON kontras.
- `understand.ts` memperlakukan output model sebagai kombinasi terdiskriminasi:
  task/action yang bertentangan dibuang, intent asing ditolak kecuali alias
  `reminder` yang terdaftar, dan fakta baru tidak boleh kalah oleh aksi daftar
  memori yang kontradiktif.
- `understanding-route.ts` menjadi pertahanan kedua di adapter. Cabang yang
  berhenti sebelum balasan hanya menerima pasangan intent/action yang sah.
- Alur Ubah tenggat dipisahkan dari intent umum melalui
  `Conversation.understandDueDate`. Parser hanya menerima ISO dengan waktu dan
  offset, dan skrip diagnostik mendapat flag `--due`.
- Balasan programatik untuk pencatatan, tawaran tugas, dan perubahan tenggat
  ikut ditulis ke riwayat; pemecahan bubble tidak lagi mengubah teks asli yang
  disimpan.
- Intent `request` memakai tier balasan seperti pertanyaan: `efficient` untuk
  permintaan biasa dan `ambitious` bila panjang atau perlu langkah bertahap.
- Plafon balasan dinaikkan dari 1.536 menjadi 4.096 token agar kode lengkap
  tidak terpotong sebelum dapat dibagi menjadi beberapa pesan.
- `messages.ts` menjaga setiap bubble di bawah 4.000 karakter. Blok kode pendek
  tetap utuh; kode panjang dibagi tanpa kehilangan karakter agar tidak ditolak
  Telegram.
- Tes parser, routing adapter, pemilihan model, prompt balasan, dan ukuran
  bubble diperluas. `ADR-007`, `PROJECT.md`, `STATUS.md`, `TESTING.md`,
  `README.md`, serta `AGENTS.md` diselaraskan.

**Bukti.**

- `npm run check` PASS.
- `dist/` dihapus setelah target absolut diverifikasi berada di root repo;
  `npm test` PASS — **96 test dalam 18 suite**, 0 gagal.
- Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - "oiya buatin dong kode tictactoenya" → `request`, tanpa task/action;
  - "aku harus bikin kode tic-tac-toe" → `task + save`;
  - "aku kewalahan karena harus belajar biologi" → `feeling + offer`;
  - "warna favoritku biru" → `smalltalk` dengan memori `preference`; dan
  - "apa yang kamu ingat tentang aku" → `memory + list`.
- `npx tsx scripts/coba-pemahaman.ts --due "besok jam 7 malam"` →
  27 Juli 2026 pukul 19.00 WIB dengan offset `+07:00`.

Yang **tidak** diuji: bot Telegram tidak dijalankan ulang. Jadi pengiriman kode
sebagai balasan nyata, absennya tugas baru di penyimpanan, pemberitahuan
Oke/Lupakan untuk preferensi, pemecahan pesan panjang oleh API Telegram, dan
model DeepSeek V4 Flash produksi tetap `NOT RUN`.

**Sengaja ditinggalkan.** Tugas atau memori yang sudah salah tersimpan pada uji
lama tidak dihapus atau dimigrasikan diam-diam. Pengguna tetap menguasai
penghapusannya melalui tombol yang tersedia.

## 26 Juli 2026 — Harvy menunggu cerita selesai dan benar-benar membaca riwayat

**Kenapa.** Pemilik produk memberikan transkrip uji Telegram dan meminta lima
perbaikan UX: pertanyaan kemampuan/isi chat harus dijawab dari riwayat, Harvy
tidak boleh pikun pada "yang tadi", bubble pengguna yang dipenggal perlu
ditunggu dan digabung, pemberitahuan memori perlu tombol Oke serta dibersihkan
saat chat berlanjut, dan balasan panjang perlu terasa seperti beberapa bubble.

Transkrip juga membuka dua masalah yang lebih berat daripada UX: orientasi
seksual tersimpan otomatis sebagai `profile`, dan pemadatan riwayat menahan
balasan sekitar sepuluh menit sebelum berakhir dengan balasan terpotong/timeout.

**Yang diputuskan.** Lengkap di
[`ADR-007`](decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md).

1. Intent `history` dipisahkan dari `memory`. Yang pertama menjawab kemampuan,
   isi chat, dan "yang tadi" dari konteks; yang kedua hanya mengurus catatan
   terstruktur.
2. Model `cheap` memutuskan apakah bubble tampak belum selesai. Keputusannya
   maksimal dua detik dan satu percobaan; waktu menunggu lanjutan maksimal 2,5
   detik. Pesan lengkap diproses langsung.
3. Paragraf balasan menjadi maksimal tiga bubble; blok kode tidak dipecah.
4. Pemberitahuan memori biasa punya Oke dan Lupakan. Oke atau chat pengguna
   berikutnya menghapus bubble pemberitahuan, bukan memorinya.
5. Label sensitivitas model tidak dipercaya sendirian. Isi tentang kesehatan,
   keluarga, relasi, gender, orientasi seksual, dan tekanan emosional dipaksa
   meminta izin.
6. Pemadatan berjalan setelah balasan, mempertahankan pesan yang masuk ketika
   model bekerja, dan memakai cooldown satu menit setelah gagal.

ID `gemini-3.5-flash-lite` dan `deepseek/deepseek-v4-flash` diverifikasi pada
dokumentasi resmi [Google](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
dan [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-flash/api). `.env`
lokal diarahkan ke Gemini 3.5 Flash-Lite untuk testing dan DeepSeek V4 Flash
sebagai model `cheap` produksi; berkas itu tetap tidak masuk Git.

**Yang berubah.**

- Baru: `src/bot/message-batcher.ts`,
  `src/bot/ephemeral-message-store.ts`, `ADR-007`, serta empat suite tes untuk
  klien AI, batch bubble, pesan sementara, dan format bubble/tombol.
- `understand.ts`, `model-policy.ts`, dan `persona.ts`: intent `history`, prompt
  batas bubble, instruksi riwayat, klasifikasi sensitif yang lebih tegas, dan
  ringkasan yang mempertahankan topik belum selesai.
- `conversation.ts` dan `client.ts`: keputusan batas bubble lewat model murah,
  timeout/percobaan per request, dan `finish_reason=length` menjadi galat
  sungguhan alih-alih teks setengah jadi.
- `create-bot.ts` dan `messages.ts`: penggabungan bubble, pemrosesan per pengguna
  secara berurutan, balasan multi-bubble, tombol Oke, serta pembersihan
  pemberitahuan memori.
- `memory-policy.ts`: pagar deterministik untuk isi sensitif yang salah diberi
  jenis biasa oleh model.
- `history-service.ts`: append bebas model; pemadatan eksplisit di latar,
  penyimpanan berantre per pengguna, penggabungan aman dengan pesan terbaru,
  invalidasi setelah Lupakan semua, dan cooldown kegagalan.
- `PROJECT.md`, `STATUS.md`, `TESTING.md`, `INDEX.md`, `AGENTS.md`, `ADR-003`,
  dan `ADR-006` diselaraskan dengan keputusan serta keadaan baru.

**Bukti.**

- Tes regresi ditulis lebih dulu; `npm run check` awal gagal karena intent,
  metode, dan modul baru memang belum ada.
- Setelah implementasi, `npm run check` PASS.
- `npm test` PASS — **79 test dalam 16 suite**, 0 gagal; naik dari 63/11.
- Gemini 3.5 Flash-Lite, model sungguhan:
  - "kamu ingat isi chat kita kah" → intent `history`;
  - `halo` → tidak menunggu;
  - "aku boleh curhat kah" → menunggu;
  - tiga bubble curhat digabung → tidak menunggu lagi;
  - curhat gabungan → intent `feeling` dan memori `personal`;
  - dengan konteks sintetis "halo", pertanyaan kemampuan dijawab, "Iya, ingat.
    Tadi kita baru saja saling menyapa".

Yang **tidak** diuji: bot Telegram tidak dijalankan setelah perubahan. Jeda dan
penggabungan tiga update nyata, tombol Oke/Lupakan, penghapusan bubble melalui
API Telegram, riwayat setelah restart, pemadatan model di latar, dan perilaku
DeepSeek V4 Flash produksi tetap `NOT RUN`. Percakapan keselamatan, pengingat,
dan isolasi dua akun juga tidak disentuh.

**Sengaja ditinggalkan.** Pemberitahuan izin pemrosesan pihak ketiga, pemeriksaan
keselamatan tersendiri, pemeriksaan isi respons, dan pemantauan biaya tetap
belum ada. Keputusan batas bubble menambah satu panggilan model murah per
kumpulan pesan; biaya itu belum diukur.

## 26 Juli 2026 — Gerbang otomatis dan ekstraksi model diuji ulang

**Kenapa.** Diminta melakukan debug dan uji coba pada keadaan branch
`feat/memori-dan-riwayat-percakapan`. Sesi ini bersifat diagnosis: tidak ada
perbaikan perilaku yang diminta atau diterapkan.

**Dibahas.** Gerbang otomatis tetap sehat. Satu perilaku yang perlu diputuskan
sebelum disebut cacat ditemukan pada jalur pemadatan riwayat: ketika peringkas
melempar galat, `HistoryService` mempertahankan seluruh riwayat (benar, supaya
konteks tidak hilang), tetapi mencoba memanggil peringkas lagi pada **setiap
giliran baru** yang masih melewati ambang. Tes dengan 20 giliran mencetak empat
percobaan gagal setelah ambang 16; pada alur bot, pesan pengguna dan balasan
Harvy sama-sama ditambahkan sebagai giliran. Saat penyedia sedang bermasalah,
perilaku ini dapat menghasilkan panggilan model dan log berulang. Belum diubah;
pilihan seperti cooldown atau backoff memengaruhi kapan pemadatan dicoba lagi
dan berada di luar diagnosis ini.

**Bukti.**

- `npm run check` PASS.
- `dist/` dibuang setelah target absolutnya diverifikasi berada di root
  repository, lalu `npm test` PASS — **63 test dalam 11 suite**, 0 gagal.
- `npx tsx scripts/coba-pemahaman.ts "ingetin aku jam 8 minum obat"` PASS
  terhadap model sungguhan dalam `AI_MODE=testing`: terbaca sebagai tugas
  "Minum obat" dengan pengingat 20.00 WIB (`13:00Z`).
- `npx tsx scripts/coba-pemahaman.ts "aku kelas 11 IPA"` PASS: model mengusulkan
  memori biasa berjenis `profile`.
- `npx tsx scripts/coba-pemahaman.ts "aku punya penyakit jantung"` PASS: model
  mengusulkan memori sensitif berjenis `personal`.

Percobaan model pertama gagal karena koneksi keluar ditolak sandbox (`EACCES`);
perintah yang sama berhasil setelah izin jaringan diberikan. Tidak ada secret
yang dicetak.

Yang **tidak** diuji: bot Telegram tidak dijalankan, jadi penyimpanan memori,
tombol izin/Lupakan, riwayat lintas pesan dan restart, peringkasan nyata,
isolasi dua akun, pengiriman pengingat, serta percakapan keselamatan tetap
`NOT RUN`. Probe diagnostik hanya membuktikan keluaran langkah pemahaman model,
bukan alur end-to-end.

**Sengaja ditinggalkan.** Retry pemadatan tanpa cooldown tidak diperbaiki.
Tidak ada kemampuan di `STATUS.md` yang dinaikkan menjadi "terbukti", karena
belum ada uji Telegram end-to-end.

## 26 Juli 2026 — Harvy mulai mengingat penggunanya

**Kenapa.** Diminta memutuskan pekerjaan berikutnya, pemilik produk memilih
memori: Harvy menjengkelkan karena setiap giliran dimulai dari nol, dan tanpa
riwayat percakapan tutoring bertahap tidak pernah benar-benar mungkin. Pemilik
produk juga menegaskan Harvy **boleh** mengingat curhat, karena itu membantu.

**Yang diputuskan.** Ditulis lengkap di
[`ADR-006`](decisions/ADR-006-memori-dan-riwayat-percakapan.md). Empat yang
paling menentukan:

1. Memori dan riwayat adalah **dua barang terpisah**, bukan satu. Menggabungkan
   keduanya menghasilkan transkrip mentah yang disebut memori — prompt
   membengkak, dan pengguna tidak dapat menghapus "satu hal" karena tidak ada
   satu hal yang dapat ditunjuk.
2. Memori biasa disimpan otomatis tetapi selalu diumumkan; memori sensitif
   hanya dengan izin. Konstitusi tidak melarang Harvy mengingat curhat — yang
   dilarang Pasal 4 nomor 3 adalah menyimpannya diam-diam. Keinginan pemilik
   produk dan Konstitusi ternyata tidak bertabrakan, asal bentuknya benar.
3. Riwayat disimpan ke disk (pilihan pemilik produk; usulan saya di memori
   proses ditolak), lalu diringkas dan dibuang setelah 16 giliran.
4. Pemilihan memori untuk prompt dilakukan deterministik di `core/`, bukan
   dengan panggilan model kedua.

**Yang berubah.** Baru: `src/domain/memory.ts`, `src/domain/history.ts`,
`src/core/memory-policy.ts`, `src/core/memory-service.ts`,
`src/core/history-policy.ts`, `src/core/history-service.ts`,
`src/storage/file-memory-repository.ts`, `src/storage/file-history-repository.ts`,
`src/ai/context.ts`, dan tiga berkas tes.

Yang disambungkan: `understand.ts` membaca usulan memori, `persona.ts` menyusun
bagian `<konteks>` dan prompt peringkas, `conversation.ts` membawa konteks ke
**dua** langkah sekaligus menambah `summarize`, `create-bot.ts` menyimpan,
menawarkan, mendaftar, dan melupakan, `model-policy.ts` mengenal intent
`memory`, `config.ts` dan `app.ts` merangkai semuanya.

`persona.ts` juga berhenti mewajibkan Harvy mengaku tanpa ingatan. Baris itu
ditambahkan 26 Juli pagi justru karena Harvy pernah berbohong ke arah
sebaliknya; membiarkannya berarti mengubah kejujuran kemarin menjadi kebohongan
baru hari ini.

**Dibahas.** Dua hal yang tidak terlihat dari daftar berkas.

Pertama, **memori adalah masukan tidak tepercaya yang diputar ulang.** Invarian
repositori ini sudah melindungi pesan pengguna dengan `<pesan>`, tetapi memori
bocor lewat pintu lain: kalimat yang ditulis hari ini masuk kembali ke prompt
besok, kali ini dari sisi sistem. Karena itu konteks dibungkus `<konteks>`
berikut penegasan bahwa isinya catatan, bukan perintah — dan ada tes yang
menjaganya.

Kedua, **kendali harus lahir bersamaan dengan fiturnya.** Memori tanpa tombol
Lupakan melanggar Pasal 4 nomor 4 sejak hari pertama, jadi daftar memori,
lupakan satu, dan lupakan semua ikut dalam perubahan yang sama, bukan
dijadwalkan menyusul.

Satu tes sempat gagal dan itu berguna: saya mengira riwayat akan tersisa enam
giliran setelah dua puluh pesan, padahal jawabannya sembilan — pemadatan
berjalan di ambang lalu riwayat terisi lagi. Yang salah ekspektasi tesnya, bukan
kodenya, jadi tesnya diubah untuk menguji maksudnya: riwayat tidak pernah tumbuh
tanpa batas, dan teks yang sudah diringkas benar-benar hilang.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — **63 test
dalam 11 suite**, naik dari 36 dalam 7.

Yang **tidak** diuji, dan ini bagian terpentingnya: **seluruh fitur ini belum
pernah dijalankan sekali pun dengan kunci sungguhan.** Yang hijau hanya bagian
murni — kebijakan memori, pemadatan riwayat, pembacaan usulan model, dan
pembungkusan konteks. Bahwa Harvy benar-benar mengingat nama penggunanya,
benar-benar bertanya sebelum menyimpan hal sensitif, dan benar-benar memahami
"yang tadi itu" belum dibuktikan apa pun. `docs/engineering/TESTING.md` kini
memuat sepuluh langkah uji manual untuk itu, seluruhnya masih `NOT RUN`.

**Sengaja ditinggalkan.**

- Pengingat yang dikirim worker tidak ikut tercatat ke riwayat, sehingga Harvy
  tidak tahu ia baru saja menegur penggunanya. `reminder-worker.ts` tidak
  mengenal `HistoryService`, dan menyambungkannya di luar permintaan.
- Satu langkah tertunda per pengguna berarti tawaran tugas dan tawaran memori
  sensitif tidak dapat hidup bersamaan; tawaran tugas menang, memorinya
  dilewatkan. Sengaja, supaya pengguna tidak dihadapkan dua pertanyaan sekaligus.
- Menyunting memori belum ada; Pasal 4 nomor 4 menyebut "mengubah", dan yang
  tersedia baru melihat dan menghapus. Dicatat sebagai Later di `PROJECT.md`.
- Persetujuan privasi pihak ketiga masih belum ada, dan kini lebih mendesak:
  yang dikirim ke penyedia model bukan lagi hanya pesan hari ini.
- Tabel `STATUS.md` menandai memori dan riwayat "Ada, belum teruji manual" —
  bentuk yang sengaja dipisahkan dari "Ada, terbukti".

## 26 Juli 2026 — Dokumen usang dibuang; alat diagnostik disambungkan

**Kenapa.** Sesi ini dimulai dari `/init` Claude Code, yang meminta CLAUDE.md
dibuat atau diperbaiki. CLAUDE.md tidak diubah: `ADR-001` nomor 6 masih berlaku,
dan menyalin arsitektur ke sana justru menghidupkan alternatif yang ADR itu tolak
— tiga berkas instruksi yang cepat basi. Yang dikerjakan adalah hasil
sampingannya: pemeriksaan AGENTS.md terhadap kode menemukan tiga percanggahan.
Setelah ketiganya diperbaiki, dua kekurangan `AGENTS.md` dan celah gerbang statis
yang semula hanya dilaporkan ikut diminta untuk dikerjakan.

**Yang berubah.**

- `docs/engineering/ARCHITECTURE.md` **dihapus.** Berkas ini belum pernah masuk
  Git dan tidak terdaftar di `docs/INDEX.md`, tetapi isinya menggambarkan Harvy
  sebelum `ADR-004`: pesan bebas katanya dijawab dengan arahan ke `/bantuan`
  "karena v0.1 sengaja tanpa model AI", pengguna disebut mengetik ID pada
  `/selesai` dan `/ingatkan`, `core/` disebut berisi parser masukan, tabel
  konfigurasinya tanpa satu pun `AI_*`, dan pekerjaan masih dibatasi Work Order
  yang sudah dicabut `ADR-005`. Sebuah dokumen arsitektur yang salah lebih
  berbahaya daripada tidak ada, karena ia dibaca lebih dulu daripada kode.
- `docs/engineering/TESTING.md`: baseline diperbarui dari 33 menjadi **36 test
  dalam 7 suite**. Langkah 33 tetap ditulis sebagai riwayat, bukan ditimpa.
- `scripts/coba-pemahaman.ts`: `maxTokens` tidak lagi ditulis sendiri, melainkan
  diimpor dari `src/ai/conversation.ts`.
- `src/ai/conversation.ts`: `UNDERSTANDING_MAX_TOKENS` diekspor agar impor itu
  mungkin.
- `tsconfig.json`: `noUnusedLocals` diaktifkan, dan `include` diperluas ke
  `scripts/`. Sebelumnya seluruh `scripts/` tidak pernah tersentuh
  `npm run check` sama sekali — itulah sebabnya `maxTokens: 400` dapat
  tertinggal tanpa ketahuan gerbang mana pun.
- `AGENTS.md`: menyebut `.githooks/pre-commit` beserta langkah
  `git config core.hooksPath .githooks` pada bagian Kontrak, memasukkan
  `scripts/coba-pemahaman.ts` ke daftar perintah pengembangan, dan memperbarui
  invarian `tsconfig.json`.
- `docs/engineering/STATUS.md`: paragraf pola cacat diperbarui — cacat keempat
  yang dikhawatirkan ternyata benar-benar terjadi, dan batas gerbang barunya
  ditulis apa adanya.

**Dibahas.** Temuan yang paling perlu diingat adalah skrip diagnostiknya sendiri.
`scripts/coba-pemahaman.ts` ditulis pada sesi sebelumnya untuk mendiagnosis
balasan terpotong, dan perbaikannya menaikkan batas token di `conversation.ts`
dari 400 ke 2048 — tetapi skripnya tetap tertinggal di 400. Alat pemeriksanya
mereproduksi persis cacat yang ia dibuat untuk mencari, sehingga kalimat yang
sebenarnya dipahami Harvy akan dilaporkan "GAGAL DIBACA" dan mengirim sesi
berikutnya memburu cacat yang sudah tidak ada. Karena itu angkanya kini diimpor,
bukan disalin: penyimpangan yang sama tidak dapat terjadi dua kali.

Ini juga contoh keempat dari pola yang dicatat `STATUS.md` — kode ditulis lengkap
lalu tidak disambungkan — dan pola itu lolos gerbang statis lagi, kali ini dengan
alasan tambahan: `tsconfig.json` hanya menyertakan `src/` dan `tests/`, sehingga
`scripts/` tidak pernah tersentuh `npm run check` sama sekali.

Gerbangnya kini diperketat, tetapi jangan disimpulkan berlebihan. `noUnusedLocals`
hanya menangkap impor dan nilai lokal yang menganggur; **angka yang salah tetapi
dipakai tidak terlihat olehnya** — dan cacat keempat itu justru berbentuk
demikian. Yang benar-benar mencegahnya berulang adalah satu sumber nilai, bukan
flag kompiler. Memperluas `include` ke `scripts/` juga bukan pilihan yang netral:
konsekuensinya `scripts/` ikut dibangun ke `dist/scripts/`. Itu aman selama glob
tes tetap `dist/tests/*.test.js`, dan sudah diperiksa bahwa jumlah test tidak
berubah setelah perluasan itu.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 36 test dalam 7
suite, angka yang sama sebelum dan sesudah perubahan, termasuk sesudah `scripts/`
masuk ke `include`. `noUnusedLocals` tidak menemukan satu pun pelanggaran di kode
yang ada, jadi mengaktifkannya tidak menuntut perubahan lain.

`scripts/coba-pemahaman.ts` sempat diperiksa terpisah dengan `npx tsc --noEmit
--ignoreConfig --module NodeNext --moduleResolution NodeNext --target ES2023
--strict --types node scripts/coba-pemahaman.ts` — PASS. Perintah itu kini tidak
diperlukan lagi: `npm run check` sudah menjangkaunya.

Yang **tidak** diuji: skrip itu tidak dijalankan terhadap model sungguhan, jadi
yang terbukti baru bahwa ia mengompilasi dan memakai angka yang benar — bukan
bahwa keluarannya untuk kalimat panjang sudah berubah. Percakapan, tombol, dan
pengingat tidak tersentuh sesi ini.

**Sengaja ditinggalkan.** Baris "Basis" pada `STATUS.md` masih menyebut commit
`9971ac2` ditambah perubahan yang belum di-commit, padahal perubahan itu sudah
masuk lewat `91ec013`. Tidak diperbarui karena memperbarui baris itu berarti
mengklaim seluruh tabel kemampuan sudah diverifikasi ulang hari ini, dan yang
benar-benar diperiksa sesi ini hanya bagian arsitektur dan perintah — bukan
seluruh tabelnya. Biarkan sesi yang benar-benar memverifikasi yang mengubahnya.

`noUnusedParameters` tidak ikut diaktifkan; hanya `noUnusedLocals` yang memang
disebut sebagai celah di `STATUS.md`. Riwayat percakapan, tombol adaptif, dan
pengingat yang terkirim worker tetap belum tersentuh — tidak ada yang bergeser
pada tabel kemampuan, jadi tabel itu tidak diubah.

## 26 Juli 2026 — Tugas pertama tercatat; Harvy menyangkal ingatannya

**Kenapa.** Kegagalan pengingat pada dua percobaan sebelumnya akhirnya
terdiagnosis lewat `scripts/coba-pemahaman.ts`, yang menampilkan balasan mentah
model. Balasannya terpotong di tengah:
`{ "intent": "task", "safetySensitive": false` — bukan salah format, melainkan
kehabisan token.

**Yang berubah.**

- `src/ai/conversation.ts`: batas token pemahaman 400 → 2048, balasan 600 →
  1536. `gemini-3.6-flash` adalah model penalaran yang memakai token keluaran
  untuk berpikir, sehingga batas sempit menghabiskan jatah sebelum JSON ditutup.
  Alasannya ditulis panjang di kode, lengkap dengan balasan yang terpotong itu,
  supaya angka ini tidak diturunkan lagi demi penghematan semu.
- `src/ai/client.ts`: `finish_reason=length` dicatat ke log dan diberi pesan
  galat tersendiri. Tanpa itu, balasan terpotong tidak dapat dibedakan dari
  balasan rusak — dan perbedaan itu menghabiskan dua putaran perbaikan.
- `src/ai/persona.ts`: Harvy wajib mengaku belum punya ingatan percakapan.
- `scripts/coba-pemahaman.ts` (baru): menguji pemahaman satu kalimat langsung ke
  model tanpa lewat Telegram, dan menampilkan balasan mentahnya.
- `tests/conversation.test.ts`: penjaga agar jatah token pemahaman tidak
  disempitkan lagi di bawah 1024.

**Dibahas.** Cacat token ini punya bentuk yang perlu diingat: **ia hanya
menyerang pesan yang paling penting.** Sapaan lolos karena hampir tidak butuh
penalaran; kalimat berisi waktu dan pekerjaan gagal. Pengujian dengan sapaan
saja akan menyimpulkan Harvy sehat sempurna.

Temuan kedua lebih berat. Ditanya "aku tanya apa tadi", Harvy menjawab "ini
pesan pertama kamu di obrolan kita". Itu bukan sekadar riwayat percakapan yang
belum ada — itu Harvy menyatakan sesuatu yang tidak benar tentang pengalaman
penggunanya, dan melanggar Pasal 3.6 serta Pasal 5 nomor 6. Perbaikan promptnya
murah; yang mahal adalah menyadari bahwa fitur yang belum ada dapat berubah
menjadi ketidakjujuran kalau modelnya dibiarkan menutupi kekosongan itu.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 36 test dalam
7 suite. Percakapan nyata: tugas pertama tercatat berikut pengingatnya, **tombol
Selesai benar-benar bekerja** — sekaligus membuktikan perbaikan `allowed_updates`
— dan tutoring satu giliran menuntun alih-alih menjawab langsung.

**Sengaja ditinggalkan.** Riwayat percakapan tetap belum ada; yang diperbaiki
baru kejujurannya. Pengingat yang benar-benar terkirim worker pada waktunya juga
belum pernah teramati. Satu hal perlu diperiksa ulang: konfirmasi tombol Selesai
muncul tanpa judul tugas pada transkrip, padahal kode menyusunnya dengan judul.

---

## 26 Juli 2026 — Harvy berjalan pertama kali, dan gagal pada pesan ketiga

**Kenapa.** Pemilik produk menjalankan bot dengan token dan kunci sungguhan.
Sapaan dan obrolan ringan berhasil; permintaan pengingat dijawab "Aku belum
menangkap maksudnya".

**Yang berubah.**

- `src/ai/conversation.ts`: balasan model yang gagal dibaca kini dicatat ke log,
  dipotong 300 karakter. Sebelumnya kegagalan sama sekali tidak berjejak,
  sehingga penyebabnya hanya bisa ditebak.
- `src/ai/understand.ts`: `readIntent` menerima label yang huruf besar-kecilnya
  berbeda, dan **menyelamatkan pesan ketika label dikarang** — misalnya
  `"reminder"` — selama data tugasnya sah. Tanpa data tugas, Harvy tetap mengaku
  tidak paham daripada menebak.
- `src/ai/persona.ts`: prompt menegaskan `intent` wajib salah satu dari empat
  nilai, menyebut permintaan pengingat sebagai `task`, dan memberi contoh
  pembacaan waktu "pukul 11 lewat 21" serta "setengah 8".
- `src/bot/messages.ts`: `understandingNote` tidak lagi menanyakan tenggat pada
  tugas yang lahir dari permintaan pengingat. Pengguna sudah menyebut waktunya.
- `tests/understand.test.ts`: dua tes untuk label yang dikarang dan yang berbeda
  huruf.

**Dibahas.** Penyebab kegagalan **belum dipastikan**, hanya dipersempit ke dua
kemungkinan: balasan model bukan JSON yang sah, atau `intent` di luar empat
nilai yang dikenal. Perbaikan hari ini menutup kemungkinan kedua dan membuat
kemungkinan pertama terlihat di log. Kalau kegagalan berulang, log akan menyebut
penyebabnya tanpa perlu menebak lagi.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 35 test dalam
7 suite. Percakapan nyata membuktikan sapaan, perkenalan diri, dan obrolan
ringan berjalan. Permintaan pengingat **belum diuji ulang** setelah perbaikan.
Tombol, pencatatan tugas, dan pengingat terkirim masih belum pernah terjadi
sekali pun.

**Sengaja ditinggalkan.** Kata "tunggubisa" yang tersambung tanpa spasi tidak
ditangani khusus; prompt sudah meminta model memperbaiki salah ketik yang jelas.

---

## 26 Juli 2026 — Kontrak konteks dibuat mengikat

**Kenapa.** Kewajiban membaca konteks dan menulis `LOG.md` sudah tertulis, tetapi
hanya berupa harapan. Agent melewati instruksi, dan manusia lupa. Sepanjang hari
ini terbukti berkali-kali bahwa dokumen yang tidak dipaksa dibaca memang tidak
dibaca.

**Yang berubah.**

- `AGENTS.md`: bagian **Kontrak** dipasang paling atas — baca konteks, jangan
  mengklaim yang belum diperiksa, tulis entri `LOG.md`. Disertai alasan
  konkretnya, yaitu kekeliruan tiga berkas yang tidak pernah ada.
- `docs/LOG.md`: format entri diperjelas dan bagian **Dibahas** ditambahkan,
  supaya sesi yang hanya berdiskusi tetap meninggalkan jejak.
- `.githooks/pre-commit` (baru): menolak commit yang menyentuh `src/`, `tests/`,
  `docs/`, `AGENTS.md`, atau `README.md` tanpa perubahan pada `docs/LOG.md`.
  Berlaku untuk siapa pun yang melakukan commit, alat apa pun.
- `scripts/session-context.sh` dan `.claude/settings.json` (baru): hook
  `SessionStart` menyuntikkan kontrak, entri LOG terakhir, dan daftar cacat yang
  diketahui ke awal sesi Claude Code.
- `docs/operations/WORKFLOW.md` dan `README.md`: tiga lapis penegakan
  didokumentasikan beserta perintah pengaktifannya.

**Dibahas.** Work Order ditinggalkan bukan karena buruk, melainkan karena yang
kurang selama ini bukan proses melainkan konteks — lihat `ADR-005`. Kesimpulan
lain: instruksi tertulis adalah lapisan terlemah, dan satu-satunya penegakan yang
berlaku lintas alat adalah hook Git, karena hanya commit yang dilalui semua
penulis.

**Bukti.** `git config core.hooksPath .githooks` sudah diaktifkan pada clone ini.
Hook diuji dua arah: menolak (exit 1) ketika `docs/LOG.md` tidak ikut di-staging,
dan lolos (exit 0) setelah disertakan. `scripts/session-context.sh` dijalankan
dan keluarannya benar. `npm run check` PASS, `npm test` PASS (33 test, 7 suite).

**Sengaja ditinggalkan.** Hook `SessionStart` hanya mengikat Claude Code; Codex
dan Antigravity tetap bergantung pada `AGENTS.md` dan hook Git. `--no-verify`
juga tetap dibiarkan bisa dipakai — yang dijaga adalah kelupaan, bukan niat.

---

## 26 Juli 2026 — Tiga cacat sambungan diperbaiki

**Kenapa.** Ketiganya punya pola yang sama: kode ditulis lengkap, lalu tidak
pernah dipanggil. Gerbang statis meloloskannya karena `noUnusedLocals` tidak
aktif.

**Yang berubah.**

- `src/ai/conversation.ts`: `understandingInput()` akhirnya dipakai, sehingga
  pesan pengguna dibungkus tag `<pesan>` dan tidak lagi dikirim mentah ke model.
  Permintaan pemahaman juga menyalakan `json: true`, memakai jalur mundur yang
  sudah ada di `AiClient` bila penyedia menolaknya.
- `src/domain/task.ts` dan `src/core/task-service.ts`: `NewTask` menerima
  `remindAt`, dan `create` memasangnya sebagai `reminderAt`. Pengingat yang
  waktunya sudah lewat **diabaikan** — kalau dipasang, Harvy akan menegur pada
  detik yang sama dengan pencatatan, dan itu salah baca model, bukan permintaan
  pengguna.
- `src/bot/create-bot.ts`: `saveTask` meneruskan `remindAt` hasil ekstraksi.
  Akibatnya "ingetin aku jam 8" kini benar-benar memasang pengingat, dan
  `formatTask` menampilkannya sebagai 🔔 tanpa perubahan lain.
- `tests/conversation.test.ts` (baru): menjaga agar pembungkus anti-injeksi dan
  mode JSON tidak lepas lagi, memakai klien palsu tanpa menyentuh jaringan.
- `tests/task-service.test.ts`: dua tes pengingat, termasuk yang waktunya sudah
  lewat.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — naik dari 29
test / 6 suite menjadi **33 test / 7 suite**. Tetap tidak ada uji manual: bot
belum pernah dijalankan dengan token dan kunci sungguhan, jadi perilaku
sesungguhnya di Telegram masih belum terbukti.

**Sengaja ditinggalkan.** Urutan pemeriksaan keselamatan masih terbalik dari
alur di `ADR-003`. `noUnusedLocals` juga tetap dibiarkan mati, sehingga cacat
keempat yang berpola sama masih akan lolos gerbang statis.

---

## 26 Juli 2026 — Dokumentasi diluruskan dan konteks dibenahi

**Kenapa.** Beberapa dokumen keliru karena ditulis dari dugaan, bukan dari kode.
Kekeliruan itu saling menguatkan dan membuat sesi berikutnya sulit berpijak.

**Yang berubah.**

- `src/app.ts`: `allowed_updates` menambahkan `callback_query`. Sebelumnya
  Telegram tidak pernah mengirim update tombol, sehingga **seluruh tombol inline
  mati** — padahal tombol adalah antarmuka utama Harvy.
- `ADR-002` dan `ADR-004`: nama modul yang tidak pernah ada dalam riwayat Git
  (`intent.ts`, `natural-language.ts`, `time.ts`) diganti menjadi
  `src/core/input-parser.ts`, disertai catatan koreksi bertanggal.
- `AGENTS.md`: invarian chat non-pribadi diperjelas; alur percakapan dua langkah,
  perilaku mode `testing`, `PendingStore`, dan batas gerbang otomatis
  ditambahkan; ditegaskan bahwa percakapan dan tombol adalah antarmuka utama,
  bukan perintah `/`.
- `README.md`: klaim usang "belum memakai model AI" dihapus.
- `docs/engineering/STATUS.md` (baru): tabel kemampuan yang sebenarnya, tiga
  cacat kode yang diketahui, dan penegasan bahwa Harvy belum pernah dijalankan
  dengan kunci sungguhan.
- `docs/PROJECT.md`: aturan ejaan "Harvy, bukan Harvey", audiens Gen Z dan Gen
  Alpha, sifat kapibara lengkap, posisi dan tujuh pembeda, sembilan masalah
  pengguna, sepuluh komponen sistem, isi website, dan arah monetisasi.
- `ADR-005` (baru), `docs/LOG.md` (baru), `docs/operations/WORKFLOW.md` (baru):
  Work Order dihentikan, digantikan konteks dan catatan pekerjaan.
  `docs/work-orders/` dan `docs/operations/ORCHESTRATION.md` dihapus.

**Bukti.** `npm run check` PASS. `npm test` PASS (29 test, 6 suite). Tidak ada
uji manual: bot belum pernah dijalankan dengan token dan kunci sungguhan,
sehingga perbaikan tombol **belum terbukti**, baru masuk akal secara kode.

**Sengaja ditinggalkan.** Tiga cacat di `STATUS.md` belum diperbaiki:
`understandingInput()` yang tidak dipanggil, `remindAt` yang dibuang, dan mode
JSON yang tidak dipakai. Pemeriksaan keselamatan juga masih terbalik urutannya
dari alur di `ADR-003`.

---

## 26 Juli 2026 — Seluruh percakapan dipindahkan ke model AI

**Kenapa.** Penguraian berbasis aturan tidak cukup untuk pendamping belajar yang
harus menjelaskan materi dan menanggapi keadaan pengguna. Lihat
[`ADR-004`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md).

**Yang berubah.** `src/core/input-parser.ts` dan tesnya dihapus. Lapisan
`src/ai/` dibuat: `persona.ts`, `model-policy.ts`, `understand.ts`, `client.ts`,
`key-pool.ts`, `conversation.ts`. `src/bot/pending.ts` menyimpan satu langkah
percakapan. `ADR-002` menjadi superseded sebagian; `ADR-003` menetapkan tiga
tingkatan model dan dua penyedia.

**Bukti.** Tes naik dari 10 test / 4 suite menjadi 29 test / 6 suite.

**Sengaja ditinggalkan.** Riwayat percakapan, pemeriksaan keselamatan sebagai
lapisan tersendiri, pemeriksaan respons, pemberitahuan privasi, dan batas biaya.

**Perlu diketahui.** Seluruh pekerjaan ini **belum di-commit** dan masih berada
di working tree pada branch `main`.

---

## 25 Juli 2026 — Bootstrap orkestrasi

**Kenapa.** Tiga coding agent bekerja pada repositori yang sama tanpa sumber
konteks bersama. Lihat [`ADR-001`](decisions/ADR-001-agent-orchestration.md).

**Yang berubah.** `AGENTS.md` sebagai instruksi inti, adaptor tipis untuk Claude
Code dan Antigravity, peta dokumentasi `docs/INDEX.md`, protokol kerja, gerbang
pengujian, serta snapshot awal ke repositori privat `stafbotz/harvy`.

**Bukti.** `npm run check` PASS, `npm test` PASS (10 test, 4 suite). Diterima
pengguna pada commit `af6ad73`.

**Catatan kemudian.** Protokol Work Order yang lahir di sini dihentikan pada
26 Juli 2026 lewat `ADR-005`. Yang tetap dipakai: satu penulis aktif, tidak
menulis langsung ke `main`, dan bukti tes wajib.
