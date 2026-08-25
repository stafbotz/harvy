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
- [`log/2026-08-20.md`](log/2026-08-20.md)
- [`log/2026-08-21.md`](log/2026-08-21.md)
- [`log/2026-08-22.md`](log/2026-08-22.md)
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

## 2026-08-25 — Console mengelola credential kanal dan membuktikan session

Scope: Channel Setup, bootstrap Telegram, Console Kanal, backup lokal, dan
credential utama/acceptance.

Changed: keberadaan credential lokal tidak lagi dipromosikan menjadi kesiapan
WhatsApp. Console menjalankan handshake bounded, membedakan session diterima,
ditolak, dan platform tidak terjangkau, mencatat waktu tanpa identifier, serta
membuka pemulihan saat ditolak. Refresh manual memaksa probe baru; polling
memakai hasil lima menit agar tidak membuka socket tiap 1,5 detik.
Token bot Telegram utama kini diverifikasi dan disimpan AES-GCM oleh Console,
terpisah dari bot acceptance. Migrasi menulis store sebelum menghapus satu
entri `.env` secara atomik; konflik sumber dan file link gagal tertutup.

Verified: migrasi token utama nyata lulus tanpa refleksi; `.env` kini 0 entri,
bootstrap membaca store, backup drill aktual dan smoke Edge desktop/mobile
lulus, serta gerbang penuh 1865/1865. Probe WhatsApp nyata sebelumnya
menunjukkan A tersimpan tetapi ditolak dan B diterima tanpa identifier/secret.

Not verified: restart/delivery bot utama pascamigrasi dan journey WhatsApp B→A.

## 2026-08-25 — Eksplorasi Telegram v3 dan receipt task setelah commit

Scope: runner eksploratif, Telegram privat, semantic task/reminder, evidence
content-free, dan penghapusan data journey.

Changed: mode full/focused, boundary `settle`/`interrupt`, coverage marker, dan
schema evidence v3 kini menahan klaim completion yang tidak didukung. Temuan
live reminder satu menit yang datang terlalu awal ditelusuri ke prompt waktu
general tanpa detik; prompt kini mempertahankan detik dan durasi relatif.
Telegram juga menyimpan task lebih dulu lalu memberi model receipt code-owned,
sehingga balasan bebas tidak dapat mengaku state berubah sebelum commit.

Verified: journey full v3 akun Telegram nyata berjalan dua run, 13/13 turn,
49 surface, re-entry, restart, seluruh coverage, dan cleanup. Ia tetap menemukan
empat defect kualitas serta reminder 42,735 detik. Dua rerun focused kemudian
membuktikan reminder 66,1 detik, menemukan false acknowledgement/task-state,
lalu exact build berikutnya membuktikan pesan pra-consent tersimpan sebagai task,
`/tugas` membaca state yang sama, reminder sekitar 64,6 detik setelah pemrosesan
dilanjutkan, completion tombol, cleanup, dan shutdown bersih. Regresi terarah
conversation+Telegram lulus 154/154.

Not verified: dogfood tujuh hari, physical erasure halaman bebas SQLite,
WhatsApp exact-tree sesudah pairing ulang Harvy A, dan crash tepat di celah
send/receipt.

Next: pair ulang WhatsApp A untuk journey B→A dan lanjutkan dogfood multi-hari.

## 2026-08-24 — Parity privat, delivery fence, dan verifikasi build tanggal itu

Scope: adapter Telegram/WhatsApp privat dan grup, capability dan executor agent,
task/session delivery, consent memori, lifecycle runtime, backup lokal,
evaluator percakapan/routing, acceptance harness, konfigurasi, tes, invariant,
dan status.

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
Runner exploratory privat operator-driven ditambahkan untuk Telegram dan
WhatsApp dengan state journey terisolasi, dialog adaptif tanpa expected answer,
assessment manual, alias surface, causal fence WhatsApp, restart, serta evidence
content-free tervalidasi. Receipt tidak menyimpan transcript, sedangkan state
produk journey tetap lokal dan dapat memuat percakapan uji. Journey nyata
menemukan timeout `turn-boundary` yang salah membuka circuit primary global,
shortcut `/hapus-data`/menu data Telegram yang sulit ditemukan, dan presentasi
task yang menulis `tanpa tenggat` di samping reminder. Circuit dan kontrol data
Telegram sudah diperbaiki serta direrun live; presentasi task baru teruji lokal.
Runtime status WhatsApp kini diteruskan content-free dan startup
`needs-operator` gagal cepat sambil menghentikan child, bukan menunggu timeout
atau menggantung.
Acceptance memori sekarang selalu membuktikan commit lewat `/memori`, bukan
hanya mencocokkan gaya acknowledgement. Satu false-negative live pada
preferensi cara belajar ditutup dengan pemeriksaan akhir extractor yang tetap
model-driven; tiga focus run dan full rerun akun nyata kemudian membuktikan
write, acknowledgement, dan recall. Parser waktu kini membawa detik dan
melarang pembulatan durasi relatif setelah “1 menit lagi” sempat dianggap sudah
lewat. Fault mode acceptance satu kali ditambahkan pada supervisor. Runner grup
managed membuat grup disposable dan membersihkannya; temuan duplicate replay
menutup ingress Baileys grup dengan deduplikasi tuple scope+message ID. Evaluator
routing kini tidak berhenti seluruhnya pada satu request provider yang gagal,
dan drill backup ephemeral membuktikan inventaris restore exact tanpa menjadikan
kunci sementara sebagai backup operasional.

Verified: `npm run check` dan `npm run context:check` PASS; `npm test` PASS
1.778/1.778 dalam 221 suite;
tes terarah perubahan utama PASS 98/98, kontrak corpus PASS 5/5, dan jalur coding
lokal PASS 67/67; dependency audit production menemukan 0 vulnerability.
Console/channel setup dan smoke Edge desktop/mobile sebelumnya membuktikan empat
credential acceptance terpisah, recovery QR, boundary localhost, serta tidak
merefleksikan secret. Build Telegram yang diuji lulus full live 8/8 lewat akun
MTProto nyata: onboarding/menu, task+reminder jatuh tempo, timezone+sesi+
check-in jatuh tempo, auto-memory+recall, planning 3/3/3 dengan satu Anchor
pin/edit/unpin, safety, ekspor, dan cleanup. Telegram fault acceptance lulus
menu sebelum/sesudah satu crash child dan satu restart. Build WhatsApp privat
yang diuji lulus full live 10/10 lewat tester B→Harvy A dengan 31/31 delivery,
reminder/check-in jatuh tempo, memory, planning 3/3/3, safety, ekspor, cleanup,
serta create/edit/delete/pin/unpin; fault acceptance lulus dua probe nyata,
8/8 delivery, satu crash, dan satu restart. WhatsApp grup lulus delapan stage
scope dua-akun: remove/re-add+notice, start/anchor, ambient isolation, quoted
correction+duplicate replay, status quote, safety lane, admin cancel, dan
cleanup; receipt tetap `passed_partial_live_scope`. Provider primary resmi
`google-ai-studio/gemini-3.5-flash-lite` lulus native tool, thought signature,
continuation, truncation/pressure, timeout, dan retry. Seluruh 62 kasus evaluasi
percakapan mempunyai observasi current yang lulus lewat rerun kasus tersisa
setelah satu 429 dan satu AbortError; ini bukan satu run uninterrupted. Routing
A–E hanya 5/9 memenuhi seluruh sinyal. Sampel grup ambient lulus 30/30 dengan
16 warning jangkar topik; direct 15/15 setelah dua rerun terarah dengan dua
warning. Drill backup lulus create→verify→restore 3.588 entry/4.371.589 byte
dari 14/18 target dan menghapus artifact. Sandbox Linux dan GitHub live sama-
sama gagal tertutup sebelum efek karena host/konfirmasi/credential belum siap.
Dua journey eksploratif akun nyata juga selesai tanpa naskah jawaban: WhatsApp
18/18 giliran dengan 71 surface event dalam sekitar 16 menit dan Telegram 25/25
dengan 77 surface event dalam sekitar 18 menit; keduanya menjalankan satu
restart dan shutdown bersih. Completion manual keduanya `completed`, tetapi
receipt tetap membawa defect kualitas. Rerun Telegram patch circuit/kontrol data
mendapat response 10/10, membuktikan menu dan full deletion live, serta tidak
mengulang dua model failure lama. Rerun WhatsApp berikutnya berhenti sebelum
percakapan karena linked session Harvy A ditolak platform (`needs-operator`,
reason `401`); diagnosis dan fail-fast runner terverifikasi live tanpa membuka
identifier atau credential.

Not verified: dogfood tujuh hari, tiga wawancara, crash tepat di antara send
eksternal dan receipt durable, network disconnect murni, interruption di tengah
provider/burst, konflik multi-instance, grup multi-human+assigned answer+memory,
group-coding publish, CodingRun/GitHub remote dari kanal nyata, sandbox hostile
Linux non-root, GitHub App/push/draft PR nyata, backup dengan kunci durable serta
media eksternal/restore lintas mesin, kalibrasi FP/FN safety/memory, dan operasi
publik jangka panjang. Perlu juga rerun WhatsApp sesudah pairing ulang Harvy A,
penutupan output generik/keputusan tanpa bukti yang ditemukan eksploratif, dan
verifikasi live presentasi reminder. Dua journey bounded bukan bukti dogfood
tujuh hari.

Next: pair ulang WhatsApp A lalu rerun B→A, tutup defect kualitas eksploratif,
kemudian mulai dogfood tujuh hari pada tiga surface produk dan tiga wawancara;
siapkan host Linux, repository GitHub nonkritis, fault window send/receipt,
peserta grup tambahan, serta backup eksternal sebelum peluncuran publik.

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
