# Peta Konteks Harvy

## Harvy itu apa

Harvy adalah satu produk AI bagi pelajar Indonesia, terutama Gen Z dan Gen
Alpha. Hari ini chat pribadi Telegram sudah ada dan fondasi grup WhatsApp
melalui Baileys tersedia sebagai beta lokal; kelak Harvy yang sama dapat hadir
dalam percakapan pribadi maupun grup di kedua kanal.
Kapibara adalah maskot, ikon, dan filosofinya: tenang, tidak menghakimi, dan
dapat hidup berdampingan tanpa mendominasi. Kalimat yang menaungi seluruh
produk ini adalah **"Harvy membantu, tetapi tidak mengambil alih."**
Sistem multi-model Harvy disebut **model Capybara**; ini bukan nama satu model
dasar atau penyedia.

Cara memakainya adalah percakapan biasa dan tombol — bukan perintah `/`.
Manajemen tugas hanyalah pintu masuk; yang dituju adalah satu teman bicara yang
berpindah alami antara kewajiban, belajar, keputusan, dan keadaan diri.

Yang benar-benar tersedia sekarang adalah Harvy pribadi di Telegram dan
fondasi teruji-otomatis untuk grup WhatsApp dengan banyak nomor Baileys dalam
satu proses. Satu nomor sudah berhasil pairing, login, dan membalas grup nyata;
perilaku grup lengkap belum diuji end-to-end. Grup Telegram, WhatsApp pribadi,
dan website masih rencana.

## Selalu baca

| Pertanyaan | Dokumen |
|---|---|
| Apa yang dikerjakan terakhir kali, dan kenapa? | [`LOG.md`](LOG.md) (hanya ~15 entri terbaru; arsip di [`log/`](log/)) |
| Apa yang sudah benar-benar berjalan hari ini? | [`engineering/STATUS.md`](engineering/STATUS.md) |

## Baca sesuai tugasnya

| Dokumen | Baca ketika |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Menyentuh perilaku produk, visi, roadmap, atau target pengguna |
| [`CONSTITUTION.md`](CONSTITUTION.md) | Menyentuh perilaku, privasi, keselamatan, atau hak pengguna. Konstitusi berkedudukan lebih tinggi daripada dokumen lain di repositori ini. |
| [`engineering/ARCHITECTURE.md`](engineering/ARCHITECTURE.md) | Refactor besar, menambah modul baru, memahami aliran data antar-komponen |
| [`engineering/INVARIANTS.md`](engineering/INVARIANTS.md) | Menyentuh mutasi data, safety, adapter, UI, grup, atau WhatsApp |
| [`engineering/DEVELOPMENT.md`](engineering/DEVELOPMENT.md) | Setup, debug, probe diagnostik, konfigurasi environment, model routing |
| [`engineering/TESTING.md`](engineering/TESTING.md) | Menyusun bukti verifikasi atau menguji secara manual |
| [`operations/WORKFLOW.md`](operations/WORKFLOW.md) | Menulis kode, berpindah alat, membuat branch, atau menyerahkan hasil |
| [`operations/HARVY_CONSOLE.md`](operations/HARVY_CONSOLE.md) | Menyalakan Console localhost, membaca ledger, backup/restore, atau merencanakan transisi VPS/domain |
| [`product/PILOT_BETA_DAN_PAKET.md`](product/PILOT_BETA_DAN_PAKET.md) | Menentukan cohort beta, paket pribadi/grup pilot, harga hipotesis, atau batas sebelum menerima pembayaran |
| [`research/AGENT_ENGINEERING_RESEARCH.md`](research/AGENT_ENGINEERING_RESEARCH.md) | Membahas draf sementara context/harness/loop/graph engineering, pemadatan token, isolasi ruang, agent sosial, Codex, Claude Code, atau prinsip Karpathy; bukan sumber status kemampuan |
| [`decisions/ADR-001-agent-orchestration.md`](decisions/ADR-001-agent-orchestration.md) | Mengubah cara beberapa agent bekerja pada satu repositori |
| [`decisions/ADR-002-percakapan-bahasa-alami.md`](decisions/ADR-002-percakapan-bahasa-alami.md) | Menyentuh cara pengguna berbicara dengan Harvy, tombol, atau pengenalan maksud |
| [`decisions/ADR-003-routing-model.md`](decisions/ADR-003-routing-model.md) | Menyentuh model AI, pemilihan model, penyedia, biaya, atau mode uji |
| [`decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md) | Menyentuh cara pesan dipahami, prompt, kepribadian, atau ketiadaan cadangan aturan |
| [`decisions/ADR-005-konteks-menggantikan-work-order.md`](decisions/ADR-005-konteks-menggantikan-work-order.md) | Mengubah cara pekerjaan dimulai, dibatasi, atau diserahterimakan |
| [`decisions/ADR-006-memori-dan-riwayat-percakapan.md`](decisions/ADR-006-memori-dan-riwayat-percakapan.md) | Menyentuh apa yang Harvy ingat tentang penggunanya, riwayat percakapan, atau kendali pengguna atas keduanya |
| [`decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md`](decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md) | Menyentuh penggabungan bubble, pertanyaan riwayat, balasan multi-bubble, atau pemberitahuan memori sementara |
| [`decisions/ADR-008-rencana-giliran-dan-fail-closed.md`](decisions/ADR-008-rencana-giliran-dan-fail-closed.md) | Menyentuh izin mutasi, tindakan adaptif, mode menyimak, sesi lunak, triase gagal, atau evaluasi percakapan |
| [`decisions/ADR-009-whatsapp-grup-dan-armada-baileys.md`](decisions/ADR-009-whatsapp-grup-dan-armada-baileys.md) | Menyentuh perilaku grup, binding, banyak nomor WhatsApp, auth Baileys, reconnect, atau isolasi memori grup |
| [`decisions/ADR-010-log-operasional-produksi.md`](decisions/ADR-010-log-operasional-produksi.md) | Menyentuh log runtime, error/crash, redaksi, korelasi, rotasi, retensi, atau adapter logger dependency |
| [`decisions/ADR-011-partisipasi-natural-dan-evaluasi-grup.md`](decisions/ADR-011-partisipasi-natural-dan-evaluasi-grup.md) | Menyentuh keputusan nimbrung tanpa tag, timing/stale candidate, naturalness grup, atau corpus/evaluator grup |
| [`decisions/ADR-012-harness-agent-dan-scope-memori.md`](decisions/ADR-012-harness-agent-dan-scope-memori.md) | Menyentuh capability registry, loop agent, executor/tool, approval/idempotensi, context budget, scope lintas kanal, atau memori semantik anggota grup |
| [`decisions/ADR-013-harvy-console-entitlement-dan-ledger-biaya.md`](decisions/ADR-013-harvy-console-entitlement-dan-ledger-biaya.md) | Menyentuh Console operator, cohort beta, paket, kuota, harga model, ledger provider/entitlement, atau atribusi biaya grup |
| [`decisions/ADR-014-structured-episodic-compaction-v2.md`](decisions/ADR-014-structured-episodic-compaction-v2.md) | Menyentuh sequence riwayat, episode terstruktur, provenance/hash, migrasi history v1, retensi episode, compaction race, atau drain riwayat |
| [`decisions/ADR-015-executor-web-baca-saja.md`](decisions/ADR-015-executor-web-baca-saja.md) | Keputusan historis yang telah dicabut tentang intent research, `web.search`, `web.open`, Brave Search, egress/SSRF, observasi tak tepercaya, atau validasi sitasi |
| [`decisions/ADR-016-scope-dan-otoritas-v1.md`](decisions/ADR-016-scope-dan-otoritas-v1.md) | Menyentuh WorkspaceScope, membership/role/ACL epoch, matriks authority grup, shared room memory, atau batas reset admin/member-local |
| [`decisions/ADR-017-agent-runtime-internal-dan-delegasi.md`](decisions/ADR-017-agent-runtime-internal-dan-delegasi.md) | Menyentuh root agent cheap-first, orkestrator ambitious, sub-agent paralel, tool internal, jam deterministik, agenda Harvy, terminal virtual, atau batas memory authority |
| [`decisions/ADR-018-checkpoint-klarifikasi-agent-durable-lokal.md`](decisions/ADR-018-checkpoint-klarifikasi-agent-durable-lokal.md) | Menyentuh persistence `waiting_input`, CAS/restart checkpoint agent, watermark jawaban, retensi, consent/ekspor/penghapusan run, atau batas adapter file sebelum RunStore produksi |
| [`evidence/agent-acceptance-v1-2026-08-04/README.md`](evidence/agent-acceptance-v1-2026-08-04/README.md) | Menilai bukti 12 skenario penerimaan Agent Runtime v1 |
| [`evidence/group-conversation-2026-07-30/README.md`](evidence/group-conversation-2026-07-30/README.md) | Menilai angka dan batas bukti evaluasi model grup 30 Juli 2026 |
| [`../README.md`](../README.md) | Menjalankan atau mencoba Harvy secara lokal |

Ini peta, bukan daftar bacaan wajib. Jangan memuat seluruh `docs/` ke konteks.

## Dua jenis dokumen, jangan tertukar

`CONSTITUTION.md`, `PROJECT.md`, dan `decisions/` menjelaskan **tujuan dan
keputusan**. `engineering/STATUS.md` dan `LOG.md` menjelaskan **keadaan yang
sebenarnya**.

Kemampuan yang disebut di dokumen tujuan belum tentu sudah ada. Untuk pertanyaan
"apakah ini sudah bisa?", jawaban yang sah hanya berasal dari `STATUS.md` atau
dari kode itu sendiri. Kekeliruan terbesar dalam sejarah repositori ini terjadi
persis karena kedua jenis dokumen ini tertukar.

## Urutan pencarian konteks

1. `AGENTS.md` di root.
2. `docs/LOG.md` dan `docs/engineering/STATUS.md`.
3. Baris yang relevan pada peta ini.
4. Dokumen detail sesuai tugas (`ARCHITECTURE.md`, `INVARIANTS.md`,
   `DEVELOPMENT.md`, `CONSTITUTION.md`, `PROJECT.md`, ADR, dsb.).
5. Kode, tes, dan konfigurasi yang benar-benar terkait.
6. Dokumentasi resmi dependency atau layanan, hanya bila informasi lokal belum
   cukup.

Jika dokumen dan kode bertentangan, jangan diam-diam memilih salah satunya.
Ikuti perilaku yang terbukti ada di kode, dan laporkan perbedaannya.
