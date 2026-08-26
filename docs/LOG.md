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

## 2026-08-27 — Coding berorientasi goal dan bootstrap GitHub exact

Scope: ProjectWorkspace/CodingRun, project intent, GitHub App Broker, Console
setup coding, verifikasi session WhatsApp, tes, invariant, ADR, dan status.

Changed: project kini dapat dimulai kosong dan mempunyai ProjectGoal durable,
acceptance criteria, milestone, blocker, evidence, serta skill deklaratif
versioned tanpa authority baru. CodingRun mengikat brief/evidence ke goal dan
menjalankan challenger+verifier read-only sebelum satu integration writer.
Console setup menambah langkah Komputer kerja dan GitHub dengan secret
non-reflective serta aktivasi berbasis health/receipt. Repository private kosong
berhenti pada `bootstrap_required`; konfirmasi exact membuat satu README
code-owned melalui WAL/idempotency/reconciliation sebelum provisioning. Race UI
verifikasi WhatsApp ditutup dengan melepas operation fence sebelum status
terminal dapat terlihat.

Verified: tes integrasi terarah PASS 95/95; smoke Edge nyata PASS pada desktop
dan mobile termasuk isi/simpan/verifikasi form Compute+GitHub tanpa refleksi
secret; `npm run check` PASS; `npm test` PASS 1.948/1.948 dalam 236 suite; dan
`npm run context:check` PASS; `git diff --check` PASS dengan warning line-ending
Windows.

Not verified: sandbox hostile-code pada Linux non-root nyata; GitHub App,
bootstrap repository kosong, branch, push, dan draft PR pada remote nonkritis;
serta coding end-to-end dari akun Telegram/WhatsApp nyata. Test GitHub memakai
broker/API palsu dan Git object lokal, bukan bukti efek remote.

## 2026-08-26 — Adaptive live mempersempit routing dan potret memori

Scope: percakapan privat Telegram/WhatsApp, model routing, AgentRun admission,
auto-memory, `/memori`, kualitas keluaran, live exploratory tester, deadline
Agent Harness, tes, dan kontrak subsystem.

Changed: planning durable kini memerlukan current intent request, assessment
tepercaya, execution medium/heavy, serta tool execution/external; analysis tanpa
tool dan internal-state model tidak lagi membuka AgentRun. Kandidat hypothetical,
current work, dan negated remember ditolak. Balasan tanpa receipt tidak boleh
mengklaim storage/delete, dan `/memori` hanya memakai primary source yang dapat
dikendalikan pengguna—history/episode-only tetap konteks percakapan, bukan
memori. Prosa yang menyisipkan writing system tak diminta diregenerasi sekali
lalu dibersihkan sempit. Tie deadline invocation dan RunBudget kini tetap
diatribusikan ke invocation walau dua pembacaan clock berlomba.

Verified: akun Telegram tester benar-benar menjalankan perjalanan adaptif; pesan
berikutnya dipilih setelah membaca respons Harvy. Focused rerun menuntaskan
tugas nyata, topic shift, explicit usage, context return, correction, dan
`/memori` empty tanpa wrong AgentRun atau usage tak diminta. Assessment
content-free final: usefulness 5, naturalness 4, initiative 4,
non-repetition 5, UI clarity 5, context coherence 5, correction handling 5.
Suite perubahan privat PASS 263/263, Agent Harness PASS 28/28 termasuk clock
race deterministik, `npm run check` PASS, `npm test` PASS 1.896/1.896 dalam 231
suite, `npm run context:check` PASS dengan warning freshness nonfatal, dan
`git diff --check` PASS dengan warning line-ending Windows.

Not verified: current build WhatsApp tidak mencapai satu pesan karena session
akun tester ditolak transport dengan connection closed 401; akun Harvy/runtime
tidak disentuh oleh run gagal itu. Dogfood tujuh hari, image melalui kanal,
private coding/GitHub live, dan kalibrasi bahasa luas juga belum selesai.

Next: pasangkan ulang session akun WhatsApp tester lalu ulangi journey adaptif
yang sama tanpa expected transcript.

## 2026-08-25 — Testing beralih ke GMI tanpa provider fallback

Scope: konfigurasi AI, migrasi environment lokal, evaluator/probe, disclosure
privasi, model profile, dan dokumentasi operasi.

Changed: Google AI Studio dan AlwaysCodex dicabut dari composition testing;
runtime, probe, dan evaluator kini selalu memakai satu provider aktif tanpa
flag fallback. Mode testing memakai endpoint OpenAI-compatible GMI Serving,
`GMI_API_KEY`, dan target `MiniMaxAI/MiniMax-M3`. Migrasi lokal atomik menghapus
enam entri provider lama tanpa memindahkan atau mencetak secret, serta kini
menulis ulang atau membuang komentar konfigurasi legacy agar `.env` tidak
menampilkan setup yang sudah dicabut. Profile live Google dihapus; sesudah
smoke exact lulus, profile code-owned MiniMax hanya terbuka untuk endpoint resmi
GMI dan model exact, sedangkan gateway/model lain tetap compatibility.
Dokumentasi/status aktif,
label fixture generik, dan provider-wire binding juga diselaraskan ke GMI;
penyebutan lama hanya dipertahankan pada migrasi, denylist, ledger historis,
serta histori keputusan yang ditandai superseded.
Perubahan penyedia, cache otomatis, dan input gambar transient menaikkan consent
privat ke v10 dan notice grup ke v11 dengan disclosure satu layanan AI utama
tanpa pengiriman ulang ke provider cadangan.

Verified: migrasi `.env` menghapus keenam entri lama dan meninggalkan slot GMI
kosong; suite terarah PASS 134/134, tes WhatsApp privat PASS 47/47,
suite cleanup provider PASS 89/89, `npm run check` PASS, dan `npm test` PASS
1.864/1.864 dalam 227 suite. Dua
artefak build Google yang stale dihapus sebelum run penuh terakhir sehingga
hasil hanya berasal dari source aktif. Setelah key tersedia lokal,
`npm run acceptance:provider` lulus terhadap endpoint/model exact untuk basic,
structured JSON, native tool+continuation, terminal/truncation, context reject,
timeout, automatic cache reuse, dan input gambar.

Not verified: rotasi/retry lintas key karena hanya satu key tersedia, SLA dan
retensi provider, serta input gambar melalui kanal Telegram/WhatsApp nyata.

Next: ukur latency/kualitas lewat dogfood kanal dan ulangi smoke rotation hanya
bila key uji kedua tersedia.

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
Armada WhatsApp layanan kini mengikuti kontrak yang sama: Console menyimpan
metadata multi-akun terenkripsi, memasangkan QR per alias, memeriksa session,
serta menyediakan replace/revoke dan sakelar privat tanpa memantulkan nomor.
Lifecycle `pending|active|removing` mencegah runtime memuat akun setengah jadi;
mode setup memegang runtime lock utama. Instalasi nyata dimigrasikan melalui UI
dari tiga field WhatsApp legacy menjadi satu akun Console-managed aktif tanpa
mencabut session. Mutasi armada serta akses file credential kanal utama kini
diserialkan; polling melewati folder session yang sedang dimutasi dan reset
folder mengulang error filesystem Windows sementara. Ini menutup race antara
pairing/revoke/probe dan antara penulisan Telegram/WhatsApp pada store yang sama.
Surface Kanal kini memisahkan **Layanan** dan **Pengujian** sebagai tab halaman
yang simetris. Mode setup membuang sidebar satu-item, memakai label peran
Penguji→Harvy tanpa A/B, hanya menampilkan detail setelah tindakan **Kelola**,
dan memberi hasil warning ketika probe menemukan masalah. Pesan privasi global
dipindahkan dari sidebar ke konteks Audit. Epoch autentikasi mencegah respons restore lama
mengembalikan UI ke login setelah login operator baru berhasil. QR tidak lagi
diam sebagai kotak putih setelah request gagal: Console mengambil SVG sendiri,
menolak status/MIME/struktur yang tidak sah, lalu memasang SVG tervalidasi secara
inline. Retry otomatis dibatasi satu kali dan retry manual tidak mengulang pairing.

Verified: migrasi token utama nyata lulus tanpa refleksi; `.env` kini 0 entri,
bootstrap membaca store, backup drill aktual dan smoke Edge desktop/mobile
lulus, serta gerbang penuh 1870/1870 dalam 227 suite. Smoke interaksi baru lulus tiga run
beruntun; audit Edge read-only atas credential nyata kembali membuktikan
Telegram siap, akun Harvy tersimpan tetapi ditolak, dan akun penguji diterima tanpa
identifier/secret. Smoke Edge juga memblokir dua request QR lalu membuktikan
error terlihat dan payload panjang pulih sebagai QR inline. Audit Edge pada
pairing WhatsApp nyata membuktikan permukaan 320×320, opacity penuh, warna
hitam/putih, dan lebih dari dua ribu modul tanpa mencetak payload QR.
Smoke armada layanan juga lulus interaksi pengaturan dan layout desktop/mobile;
audit browser pada Console setup nyata membuktikan state legacy migratable lalu
state Console-managed setelah migrasi tanpa identifier.
Setelah pairing diperbaiki, audit read-only current build memberi ringkasan
acceptance WhatsApp `Sesi_valid`; akun layanan Console-managed juga lulus probe
langsung dengan status `ready`.

Not verified: restart/delivery WhatsApp layanan dari source Console-managed,
penambahan nomor layanan nyata kedua, dan journey WhatsApp penguji→Harvy.

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
