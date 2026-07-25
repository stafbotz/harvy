# Orkestrasi Pengembangan Harvy

Tujuan protokol ini adalah membuat pengguna dan ChatGPT menjadi ruang kendali,
sementara Codex, Claude Code, dan Antigravity dapat bergantian mengoding tanpa
saling menimpa pekerjaan atau mengandalkan ingatan percakapan.

## Peran

| Peran | Wewenang | Tidak dilakukan |
|---|---|---|
| Pemilik produk (pengguna) | Menjelaskan kebutuhan, memilih trade-off, mencoba hasil, menerima atau menolak | Menulis prompt teknis panjang |
| Orkestrator (ChatGPT) | Mengubah diskusi menjadi Work Order, menetapkan peran, memeriksa bukti dan diff, menjaga keputusan | Menyetujui keputusan produk material tanpa pengguna |
| Builder | Menulis satu paket lengkap pada branch miliknya dan membuktikan hasil | Mengubah ruang lingkup atau `main` |
| Reviewer | Membaca diff dan mencari masalah material | Mengedit implementasi yang sedang ditinjau |
| QA | Menguji pengalaman pengguna dan mencatat bukti yang dapat diulang | Memperbaiki kode di tengah pengujian |

Codex, Claude Code, dan Antigravity bukan peran permanen. Pada setiap Work Order,
salah satunya menjadi Builder dan yang lain dapat menjadi Reviewer atau QA.

## Aturan 5×1

1. Satu repositori menjadi sumber kebenaran.
2. Satu Work Order mendefinisikan satu hasil pengguna yang utuh.
3. Satu Builder menjadi satu-satunya penulis aktif pada branch itu.
4. Satu handoff berbentuk commit/PR dan bukti pengujian.
5. Satu putaran perbaikan utama; temuan kecil masuk backlog.

Kerja paralel bukan default. Orkestrator hanya mengizinkannya jika Work Order
berbeda, branch terisolasi, kepemilikan file tidak tumpang tindih, dan urutan
integrasi sudah ditentukan.

## Siklus sebuah Work Order

| Status | Pemilik tindakan berikutnya | Arti |
|---|---|---|
| `DRAFT` | Pemilik produk + orkestrator | Kebutuhan masih dibahas |
| `READY` | Builder yang ditugaskan | Ruang lingkup, branch, dan kriteria telah dikunci |
| `IN_PROGRESS` | Builder | Implementasi sedang berlangsung |
| `BLOCKED` | Orkestrator/pemilik produk | Ada keputusan material yang belum tersedia |
| `READY_FOR_REVIEW` | Reviewer | Commit, diff, dan bukti tes siap diperiksa |
| `CHANGES_REQUESTED` | Builder yang sama | Temuan material perlu diperbaiki |
| `READY_FOR_ACCEPTANCE` | Pemilik produk + orkestrator | Review material lulus; siap diuji pengguna |
| `ACCEPTED` | Orkestrator | Hasil diterima dan dapat digabung ke `main` |

Alurnya:

1. Pengguna menjelaskan ide dengan bahasa biasa.
2. Orkestrator membuat satu Work Order `DRAFT` dan mengumpulkan keputusan
   material dalam satu pembahasan.
3. Setelah pengguna setuju, orkestrator menetapkan Builder, Reviewer, QA,
   branch, dan status `READY`.
4. Builder memeriksa branch, membaca konteks yang ditunjuk, mengubah status
   menjadi `IN_PROGRESS`, lalu menyelesaikan seluruh paket.
5. Builder menjalankan tes, meninjau diff, commit, push, membuka PR, dan
   menyerahkan bukti. Status menjadi `READY_FOR_REVIEW`.
6. Reviewer bekerja read-only. Temuan `BLOCKER` atau `IMPORTANT` kembali ke
   Builder dalam satu kumpulan; `MINOR` masuk backlog.
7. Builder yang sama melakukan satu putaran perbaikan dan memperbarui bukti.
8. Orkestrator memeriksa diff akhir. Pengguna menjalankan uji penerimaan yang
   dapat dilihat atau dirasakan.
9. Setelah diterima, PR digabung ke `main`, keputusan permanen diperbarui, dan
   Work Order berstatus `ACCEPTED`.

## Branch dan folder kerja

- `main` selalu merupakan versi stabil.
- Branch paket memakai `work/wo-NNN-ringkasan`.
- Builder tidak menggunakan branch paket lain dan tidak menyalin perubahan
  tanpa riwayat commit yang jelas.
- Dalam satu folder lokal, alat digunakan bergantian. Sebelum berpindah alat,
  pastikan perubahan sudah di-commit atau folder kerja bersih.
- Jika dua paket kelak benar-benar paralel, gunakan clone atau Git worktree
  terpisah. Jangan membuka dua penulis pada folder lokal yang sama.
- Push, force-push, merge, rebase, atau penghapusan branch hanya dilakukan bila
  diminta oleh Work Order atau orkestrator.

## Media komunikasi bersama

| Informasi | Tempat resmi |
|---|---|
| Tujuan dan batas pekerjaan | Work Order |
| Kode yang diusulkan | Branch dan commit |
| Bukti selesai | Pull request |
| Temuan review | Review/comment pada pull request |
| Keputusan permanen | `docs/decisions/` |
| Temuan kecil | Backlog di `docs/PROJECT.md` |

Percakapan membantu koordinasi, tetapi klaim yang memengaruhi hasil harus
ditulis pada salah satu tempat di atas. Agen berikutnya tidak perlu membaca
riwayat chat agen sebelumnya.

## Kapan Builder berhenti dan bertanya

Builder mengumpulkan pertanyaan dan mengirimkannya sekaligus jika jawaban dapat
mengubah:

- pengalaman pengguna atau kriteria penerimaan;
- bentuk, migrasi, retensi, atau privasi data;
- keamanan, credential, izin, atau tindakan eksternal;
- dependency, layanan berbayar, model, atau biaya operasional;
- batas Work Order atau kompatibilitas.

Pilihan implementasi kecil yang mudah dibalik tidak perlu menunggu. Builder
memilih solusi paling sederhana yang konsisten dengan kode dan mencatat
asumsinya.

## Standar review

- `BLOCKER`: kehilangan/kebocoran data, celah keamanan, tes gagal, kerusakan
  fitur utama, atau kriteria penerimaan tidak terpenuhi.
- `IMPORTANT`: bug atau risiko material yang sangat mungkin dirasakan pengguna.
- `MINOR`: kosmetik, refactor opsional, atau peningkatan yang tidak menghalangi
  penerimaan.

Setiap temuan harus menyebut bukti, lokasi, dampak, dan cara memverifikasi.
Reviewer tidak memenuhi kuota temuan dan tidak mengulang preferensi gaya yang
tidak berdampak.

## Prompt pendek dari orkestrator

Builder menerima instruksi seperti:

```text
MODE: BUILD
WORK ORDER: docs/work-orders/WO-NNN-nama.md
BRANCH: work/wo-NNN-nama

Baca AGENTS.md dan Work Order. Kerjakan seluruh paket, jalankan verifikasi,
lalu serahkan commit/PR beserta bukti. Jangan memperluas ruang lingkup.
```

Reviewer menerima instruksi seperti:

```text
MODE: REVIEW
WORK ORDER: docs/work-orders/WO-NNN-nama.md
COMPARE: main...work/wo-NNN-nama

Jangan edit. Laporkan hanya BLOCKER dan IMPORTANT dengan bukti. Daftarkan
MINOR terpisah agar tidak menghalangi penerimaan.
```

QA menerima instruksi seperti:

```text
MODE: QA
WORK ORDER: docs/work-orders/WO-NNN-nama.md
COMMIT: <sha>

Jangan edit. Jalankan skenario penerimaan dan laporkan PASS/FAIL/NOT RUN
beserta langkah dan hasil yang diamati.
```

Pengguna tidak perlu menulis prompt ini; orkestrator menyiapkannya untuk setiap
paket.

## Adaptor tiga alat

- Codex membaca `AGENTS.md` dari root Git.
- Claude Code membaca `CLAUDE.md`, yang hanya mengimpor `AGENTS.md`.
- Antigravity membaca `.agent/rules/00-harvy-bootstrap.md`, yang menunjuk ke
  `AGENTS.md`. Path `.agent/rules/` adalah fallback kompatibel yang masih
  didukung Antigravity. Di panel Rules, atur rule tersebut menjadi
  **Always On**.

Verifikasi sekali setelah repositori dibuka:

1. Codex harus dapat menyebut Work Order yang diminta sebelum mengedit.
2. Pada Claude Code, jalankan `/context` dan pastikan `CLAUDE.md` dimuat.
3. Pada Antigravity, buka **Customizations → Rules** dan pastikan bootstrap
   Harvy aktif sebagai **Always On**.

## GitHub privat

Repositori remote harus privat. Jangan mengunggah `.env`, data lokal, arsip
duplikat, token Telegram, API key, atau credential lain. Setelah remote
tersedia, semua serah-terima menggunakan branch dan pull request; ZIP bukan
jalur koordinasi rutin.

Checklist satu kali:

1. Buat repositori GitHub privat bernama `harvy` tanpa README atau template
   tambahan.
2. Jadikan folder proyek ini initial commit pada `main`, lalu push ke remote
   tersebut. Ini satu-satunya pengecualian bootstrap untuk perubahan langsung
   pada `main`.
3. Hubungkan repositori GitHub ke ruang orkestrator ChatGPT.
4. Buka clone/repositori yang sama dari Claude Code dan Antigravity. Jangan
   memakai tiga salinan yang memiliki riwayat berbeda.
5. Jalankan verifikasi adaptor pada bagian sebelumnya.
6. Setelah itu, semua perubahan baru dimulai dari branch
   `work/wo-NNN-ringkasan` dan masuk melalui pull request.

Credential GitHub dimasukkan melalui login resmi alat, bukan ditulis di chat,
terminal history, atau file proyek.
