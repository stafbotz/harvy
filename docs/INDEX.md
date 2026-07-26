# Peta Konteks Harvy

## Harvy itu apa

Harvy adalah AI pendamping pelajar Indonesia, terutama Gen Z dan Gen Alpha,
diakses lewat chat pribadi Telegram. Wujudnya kapibara: tenang, tidak
menghakimi, dan dapat hidup berdampingan tanpa mendominasi. Kalimat yang
menaungi seluruh produk ini adalah **"Harvy membantu, tetapi tidak mengambil
alih."**

Cara memakainya adalah percakapan biasa dan tombol — bukan perintah `/`.
Manajemen tugas hanyalah pintu masuk; yang dituju adalah satu teman bicara yang
berpindah alami antara kewajiban, belajar, keputusan, dan keadaan diri.

Yang sedang dikerjakan sekarang adalah **Harvy Capybara**, kanal Telegram
pribadi. Bagian lain (WhatsApp, website, Harvy Chat, Harvy Core) masih rencana.

## Baca empat ini dulu

Siapa pun yang mulai bekerja — manusia maupun AI — harus dapat menjawab empat
pertanyaan berikut dari repositori, tanpa bertanya kepada siapa pun.

| Pertanyaan | Dokumen |
|---|---|
| Proyek ini apa, untuk siapa, dan kenapa layak ada? | [`PROJECT.md`](PROJECT.md) |
| Apa batas moral, hak pengguna, dan larangannya? | [`CONSTITUTION.md`](CONSTITUTION.md) |
| Apa yang sudah benar-benar berjalan hari ini? | [`engineering/STATUS.md`](engineering/STATUS.md) |
| Apa yang dikerjakan terakhir kali, dan kenapa? | [`LOG.md`](LOG.md) |

Konstitusi berkedudukan lebih tinggi daripada dokumen lain di repositori ini.

## Selebihnya, baca sesuai keperluan

| Dokumen | Baca ketika |
|---|---|
| [`operations/WORKFLOW.md`](operations/WORKFLOW.md) | Menulis kode, berpindah alat, membuat branch, atau menyerahkan hasil |
| [`engineering/TESTING.md`](engineering/TESTING.md) | Menyusun bukti verifikasi atau menguji secara manual |
| [`decisions/ADR-001-agent-orchestration.md`](decisions/ADR-001-agent-orchestration.md) | Mengubah cara beberapa agent bekerja pada satu repositori |
| [`decisions/ADR-002-percakapan-bahasa-alami.md`](decisions/ADR-002-percakapan-bahasa-alami.md) | Menyentuh cara pengguna berbicara dengan Harvy, tombol, atau pengenalan maksud |
| [`decisions/ADR-003-routing-model.md`](decisions/ADR-003-routing-model.md) | Menyentuh model AI, pemilihan model, penyedia, biaya, atau mode uji |
| [`decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md) | Menyentuh cara pesan dipahami, prompt, kepribadian, atau ketiadaan cadangan aturan |
| [`decisions/ADR-005-konteks-menggantikan-work-order.md`](decisions/ADR-005-konteks-menggantikan-work-order.md) | Mengubah cara pekerjaan dimulai, dibatasi, atau diserahterimakan |
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
2. Empat dokumen inti di atas.
3. Baris yang relevan pada peta ini.
4. Kode, tes, dan konfigurasi yang benar-benar terkait.
5. Dokumentasi resmi dependency atau layanan, hanya bila informasi lokal belum
   cukup.

Jika dokumen dan kode bertentangan, jangan diam-diam memilih salah satunya.
Ikuti perilaku yang terbukti ada di kode, dan laporkan perbedaannya.
