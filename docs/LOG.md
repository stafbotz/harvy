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
- [`log/2026-08-14.md`](log/2026-08-14.md)
- [`log/2026-08-15.md`](log/2026-08-15.md)
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

## 2026-08-24 — Parity privat, delivery fence, dan verifikasi latest build

Scope: adapter Telegram/WhatsApp privat, capability dan executor agent, task/
session delivery, consent memori, lifecycle runtime, backup lokal, evaluator
percakapan, acceptance harness, konfigurasi, tes, invariant, dan status.

Changed: WhatsApp privat sekarang mempunyai capability personal dan coding yang
sama dengan Telegram privat melalui UX teks kanalnya, tanpa membekukan WhatsApp
grup. Task/reminder/session/check-in, data control, Workspace ZIP, CodingRun,
GitHub, serta AgentRun durable dirangkai pada adapter privat. Reminder/check-in
beralih ke delivery intent at-most-once yang menahan duplikat dan mengekspos
hasil ambigu. Consent onboarding privat versi 8 kini menjadi authority untuk
auto-memory ordinary maupun personal tanpa prompt atau tombol per-item;
credential tetap ditolak, commit diberitahukan secara natural, dan kegagalan
write tidak boleh dibalas seolah data sudah tersimpan. Pengguna mengendalikan
hasil lewat bahasa natural dan `/memori`. Classifier privacy-memory terpisah
dipensiunkan; extractor model mengusulkan kandidat, tetapi authority tetap milik
adapter. Grup tidak mewarisi consent privat: kandidat member-local implicit
dilewati tanpa prompt, explicit remember tetap item-scoped, dan shared-room
tetap memerlukan admin.
Supervisor restart berbatas, runtime lock reclaim, backup lokal terenkripsi,
dan acceptance harness akun tester WhatsApp ditambahkan. Pairing lokal untuk
akun Telegram tester serta dua peran WhatsApp kini dikelola dari tab Kanal pengujian
Harvy Console; mode `console:setup` dapat hidup sebelum token runtime tersedia.
Token bot dan session Telegram dipisah dalam vault terenkripsi, QR hanya berada
di memori dan dirender ke sesi operator, 2FA tidak dipersistenkan, dua role
WhatsApp divalidasi berbeda, dan revoke memakai logout-first. Runner privat
menyalakan build pada state sementara, berinteraksi lewat akun nyata, membuat
receipt content-free, melakukan cleanup produk, lalu graceful drain. Evaluator
kini menilai outcome tugas nyata, mengisolasi kegagalan provider, dan memakai
recovery terminal-marker yang bounded. Console dan runner acceptance juga
memegang lock credential lintas proses yang sama agar pairing, revoke, dan
percakapan live tidak memutasi session secara bersamaan; commit token bot dan
session tester Telegram diserialisasi pula di dalam proses, dan callback QR/
session setelah cancel dipagari sebelum dapat mempersistenkan state lama.
Console Kanal pengujian sekarang menampilkan boundary produk utama versus acceptance
secara eksplisit: sisi utama hanya membawa boolean/jumlah konfigurasi dan tidak
mengklaim session tertaut, sedangkan empat credential uji mempunyai checklist
serta flow identitas sendiri. Crash renderer akibat ID QR/cancel Telegram yang
tidak konsisten ditutup dengan kontrak DOM; UI pairing juga dirapikan untuk
hierarki desktop/mobile dan error internal tidak lagi ditampilkan mentah.
Pairing WhatsApp QR nyata kemudian membuktikan defect lain: Baileys 7 rc14
menyimpan identitas, account signature, dan signal identity pair-success namun
flag lama `registered` tetap `false`, sehingga Console menampilkan session sah
sebagai belum dipasangkan dan runner akan menolaknya. Satu validator credential
sekarang dipakai oleh Console, runtime utama, revoke, guard beda-identitas, dan
seluruh runner WhatsApp; state `me`-only tetap gagal tertutup. Setelah pairing
lengkap, Console kini berpindah dari state setup ke surface operasional yang
tenang: ringkasan kesiapan dan dua alur tester → Harvy terlihat di depan,
sedangkan seluruh input, QR, boundary teknis, rotasi token, dan pencabutan sesi
berada dalam pengaturan tertutup. Status `siap diuji` sengaja tidak diklaim
sebagai bukti reconnect atau pengiriman live. Percobaan live kemudian menemukan
dead-end ketika perangkat WhatsApp sudah dicabut dari ponsel: Console kini
menerima `loggedOut` sebagai bukti pencabutan, membersihkan credential lokal
yatim, dan membuka QR pengganti dalam satu alur logout-first. Close jaringan
biasa tetap gagal tertutup. Direct console output Signal yang membawa material
ratchet dipagari, dan runner managed sekarang menunggu runtime ready, memakai
import `tsx` absolut, menerima pasangan PN/LID, serta menyimpan receipt tahap
saat gagal. Runner kemudian dipagari oleh readiness socket WhatsApp `open`,
trace lifecycle content-free, burst collector multi-bubble, ack transport,
shutdown parent yang lebih panjang daripada grace child, dan cleanup Windows
retry-bounded. Race linked-device yang dapat mengirim edit/unpin sebelum event
create anchor ditutup dengan korelasi target bubble exact dari create maupun
edit; target ganda tetap ditolak. Harness sekarang fail-fast sesudah tahap
pertama gagal agar respons tertunda tidak mencemari skenario berikutnya, tetapi
full data cleanup tetap dijalankan. Menu shared sekarang menyebut sesi/check-in yang memang tersedia,
bukan menyembunyikannya di `/bantuan`. Run Anchor privat kini satu surface
mutable yang dipin saat aktif, diedit dengan ID yang sama, lalu dilepas pada
terminal; transient progress dan hasil final tetap surface berbeda. Permintaan
exact-step dengan field eksplisit sekarang diturunkan menjadi kontrak struktur
code-owned dan native final schema; free-text final tidak tersedia pada pass
tersebut, satu repair bounded diizinkan, dan kode merender hasilnya.
Presenter receipt privat kini memisahkan copy model dari fakta code-owned di
Telegram/WhatsApp; failure memakai fallback, dan check-in model tidak menerima
goal/konteks lama. Cold smalltalk serta reminder kosong masuk reply model;
planning AgentRun berasal dari assessment tepercaya/nonmekanis, bukan regex kata.
Reminder juga kini ditahan saat consent AI ditarik.
Acceptance memori sekarang selalu membuktikan commit lewat `/memori`, bukan
hanya mencocokkan gaya acknowledgement. Reset awal dan cleanup akhir WhatsApp
memakai stanza ID berbeda agar dedupe replay produk tidak menelan cleanup kedua.
Satu false-negative live pada preferensi cara belajar ditutup dengan instruksi
extractor generik bahwa preferensi belajar/komunikasi yang stabil adalah
kandidat; rerun akun nyata membuktikan write, acknowledgement, dan recall.

Verified: `npm run check` PASS; `npm test` PASS 1.776/1.776 dalam 221 suite;
tes terarah Console/channel setup/live-acceptance/lock PASS 19/19; smoke setup
localhost membuktikan session `setupOnly`, endpoint kanal 200, dashboard 404,
response tanpa token, instance kedua ditolak `LOCAL_DATA_LOCKED`, serta shutdown
melepas proses dan lock; `npm run context:check` PASS; dependency
audit production PASS tanpa vulnerability; preflight Telegram acceptance gagal
tertutup sebelum koneksi/send saat acknowledgement kosong;
eval provider nyata PASS 60/60 (42 percakapan + 18 boundary/interruption), tanpa
fallback/provider/execution failure; smoke build final mencapai
`application_ready` lalu IPC `shutdown_completed`, exit bersih, tanpa proses
Node atau runtime lock tersisa. Drill backup state terkonfigurasi PASS
create→verify→restore 1.411 entry/3.942.048 byte, terenkripsi tanpa archive
plaintext, lalu artifact uji dihapus. Preflight WhatsApp privat gagal tertutup
sebelum koneksi karena konfirmasi operator belum diberikan. Smoke Microsoft
Edge headless nyata membuktikan login, render/API tanpa exception, status kanal
final, dan layout desktop/mobile; setelah timeout harness dibuat toleran beban,
empat pengulangan PASS dan tidak menyisakan profile atau screenshot sementara.
Pairing WhatsApp A Harvy uji menghasilkan material pair-success durable nyata;
audit content-free membuktikan empat credential acceptance siap dan kedua
identitas WhatsApp berbeda. Smoke Edge membuktikan surface siap, pengaturan
tertutup, aksi Kelola tepat, layout desktop/mobile tanpa overflow, serta alur
error → pulihkan → QR pengganti. Tes credential/Console/Baileys/acceptance
terarah PASS 68/68 dan recovery PASS 23/23. Baseline penuh Telegram tepat
sebelum perubahan consent ini lulus 8/8. Current build kemudian lulus fokus
Telegram memory 3/3 melalui akun nyata: onboarding, preferensi belajar implicit
tersimpan tanpa consent/tombol per-item, recall `/memori`, dan cleanup. Rerun
penuh current build lulus tahap onboarding/menu serta task/reminder, lalu timeout
pada timezone/session/check-in; tahap sesudahnya tidak dijadikan bukti.
WhatsApp privat mempunyai baseline full 10/10 dari policy sebelumnya. Rerun
managed current build meluluskan reset, onboarding/menu, task, reminder,
sesi/check-in, auto-memory implicit beserta acknowledgement+recall, dan planning
sekitar 16 detik dengan Anchor mutable serta kualitas 3/3/3. Run kemudian timeout
pada stage safety nonkrisis sehingga bukan full pass; cleanup tetap lulus. Ada
16 ingress `notify`, 28/28 delivery call berhasil tanpa pipeline/delivery
failure, ack tertinggi `none`, runtime shutdown bersih, dan isolated state
terhapus. Receipt content-free dan tidak membawa identifier akun.

Not verified: rerun penuh current-build Telegram setelah timeout timezone/
session/check-in, full current-build WhatsApp setelah timeout safety nonkrisis,
WhatsApp grup latest build, reconnect/interupsi burst/
CodingRun/GitHub WhatsApp privat, interruption/reconnect Telegram, dogfood tujuh
hari, tiga wawancara, backup eksternal/lintas mesin,
multi-process storage, sandbox Linux non-root, atau GitHub App/push/PR nyata.

Next: mulai dogfood tujuh hari pada tiga surface produk, lakukan tiga wawancara,
uji reconnect dan CodingRun/GitHub WhatsApp privat, lalu buat kunci+salinan
backup eksternal sebelum peluncuran publik.

## 2026-08-22 — Hardening boundary provider, BYOK, dan GitHub broker

Scope: HTTP response boundary chat/embedding/GitHub, konfigurasi origin AI,
SecretStore BYOK, ledger file credential broker, downloader Telegram, tes, dan
kontrak subsystem terkait.

Changed: respons sukses provider chat dan embedding serta JSON GitHub kini
diputus pada hard byte cap sebelum buffering dan di-decode sebagai UTF-8/JSON
strict; body error/redirect yang tidak dipakai dibatalkan. Klien GitHub
credential-domain mempunyai watchdog internal dan selalu melepas archive
reader. `AI_BASE_URL` primary gagal startup bila bukan HTTPS/loopback aman atau
membawa credential/query/fragment/path completion penuh. SecretStore tidak lagi
mempublikasikan cache sebelum replacement durable berhasil, mengoaleskan initial
read tanpa menyerialisasi cache hit, dan menolak ref/ciphertext rusak serta key
prototype. Ledger broker memakai primitive atomik-durable bersama dengan
cleanup temporary/directory sync. Downloader ZIP Telegram juga selalu melepas
reader lock. Model role, reasoning budget, context, tool eligibility, dan
quality ceiling tidak diturunkan.

Verified: suite boundary/economy/GitHub terarah PASS 114/114; `npm run check`
PASS; `npm test` PASS 1.663/1.663 dalam 208 suite termasuk build; `npm audit`
melaporkan 0 advisory pada 155 dependency; `npm run context:check` PASS dengan
freshness warning nonfatal untuk `CURRENT.md`; `git diff --check` PASS selain
peringatan line-ending Windows.

Not verified: provider, Telegram/WhatsApp, GitHub repository, atau sandbox Linux
live; hostile-network penetration test; crash/power-loss fisik; deployment
multi-instance; dan advisory dependency yang belum dipublikasikan.

## 2026-08-22 — Semantic operation, transient context, dan menu terpadu

Scope: Understanding, semantic conversation progress, operasi
usage/task/memory/session, adapter percakapan pribadi Telegram dan WhatsApp,
context compiler, command catalog, observability, tes, ADR, dan status
subsystem.

Changed: natural free text kini dipetakan satu kali ke `SemanticOperation`
tertutup, lalu code tetap memegang authority dengan evidence dari turn aktif,
explicitness, confidence, subject, dan target yang cocok. Exact slash command
tetap deterministik. Follow-up seperti `detailnya` dapat merujuk surface usage
yang berhasil dikirim melalui transient interaction context yang content-free,
process-local, TTL-scoped, bounded maksimal tiga, dan baru dicatat setelah
delivery; state akun selalu dibaca ulang. Konteks jawaban percakapan biasa tidak
lagi memuat katalog capability global, sedangkan planner agent tetap menerima
subset callable. `/menu` Telegram dan menu teks WhatsApp kini berasal dari satu
katalog user-facing; help tetap surface terpisah. Routing role-aware,
specialist orchestration, serta batas authority tidak diubah.

Progress note privat kini memakai `publicFocus` semantic yang dihasilkan di
understanding call yang sama, melalui schema exact, panjang terbatas, serta
validasi ulang terhadap reasoning privat, jargon internal, markup, injection,
dan credential. Phase tetap code-owned dari execution/capability/interruption
yang benar-benar aktif; Telegram dan WhatsApp baru membawa focus transient
setelah triase final biasa ke renderer core yang sama, tanpa history, memory,
checkpoint, log isi, atau call model kosmetik. Jalur safety menahan focus,
sedangkan focus yang hilang/tidak sah memakai copy generik sebagai fallback
terakhir.

Verified: suite terarah perubahan lama PASS 339/339 dalam 23 suite dan recheck
hardening final lama PASS 52/52 dalam 4 suite; progress terarah PASS 186/186
dalam 9 suite; `npm run check` PASS; `npm test` PASS 1.656/1.656 dalam 206 suite
termasuk build; `npm run context:check` PASS.

Not verified: perilaku multilingual model/provider live, akun Telegram atau
WhatsApp nyata, UX setelah process restart (transient context sengaja hilang),
dan latency/kualitas `publicFocus` provider live. Evaluasi yang dijalankan
bersifat unit/sintetis, bukan bukti live provider.

## 2026-08-22 — Specialist production opt-in dan role-aware cleanup

Scope: model policy/config/profile, Conversation Agent Runtime, specialist
delegation/composition, RunBudget handoff, safety role contract, tes, ADR, status,
dan source instruksi repository.

Changed: consolidated implementation spec lama dihapus agar mapping model
historis tidak lagi terbaca sebagai desain aktif. Composition production kini
mempunyai specialist graph opt-in yang default-off dan gagal tertutup tanpa
exact model berbeda serta profile explicit untuk role kritis. Saat aktif,
specialist menggantikan parallel legacy; root orchestrator mempertahankan
konteks relevan, sedangkan worker hanya menerima WorkBrief minimum-necessary
tanpa credential, capability, raw context verbatim, tool, recursion, atau
continuation root. Specialist memakai RunBudget root yang sama, actual task
signals mengalahkan default role, dan invocation exact tidak memakai provider
fallback. Intelligence safety dapat dipilih code-owned tanpa menaikkan
authority; default safety belum berubah.

Verified: suite terarah luas PASS 155/155 dalam 18 suite dan recheck specialist
final PASS 37/37 dalam 5 suite; `npm run check` PASS; `npm test` PASS
1.626/1.626 dalam 204 suite termasuk build. Pencarian
source tidak menemukan Terra sebagai runtime hardcode dan tidak menemukan
reference ke spec yang dihapus.

Not verified: model/provider live, kualitas atau diversity model deployment,
Telegram production, harga/latency, dan konfigurasi gate aktif nyata.

Next: jalankan provider smoke dengan exact role bindings/profile yang disetujui
sebelum mengaktifkan gate. Integrasi ResourceRequest scheduler dan planner tool
discovery tetap pekerjaan terpisah.

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
