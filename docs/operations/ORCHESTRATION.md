# Orkestrasi Pengembangan Harvy

Protokol ini membuat pengguna menjadi pengarah, ChatGPT Work menjadi
orkestrator, dan Codex, Claude Code, serta Antigravity bekerja sebagai tim yang
terkoordinasi tanpa saling menimpa atau mengandalkan ingatan percakapan.

## Prinsip utama: alat tidak saling membaca pikiran

Codex, Claude Code, Antigravity, dan ChatGPT Work memiliki sesi serta konteks
yang terpisah. Mereka tidak otomatis mengetahui:

- percakapan pengguna dengan alat lain;
- perubahan lokal yang belum di-commit;
- tes yang dijalankan di komputer atau sesi lain;
- keputusan yang hanya disebutkan lewat chat;
- model aktual yang dipakai alat lain.

Karena itu, komunikasi antaralat tidak dilakukan dengan asumsi. ChatGPT Work
mengirim instruksi mandiri kepada setiap alat, sedangkan repo GitHub menjadi
papan kerja bersama. Pernyataan material harus tercatat di Work Order, commit,
PR, review, hasil QA, atau ADR.

## Pihak, profil, dan peran default

| Pihak | Profil yang ditetapkan pemilik | Peran default | Wewenang utama |
|---|---|---|---|
| Pengguna | Pemilik produk Harvy | Pengarah | Menetapkan tujuan, memilih trade-off, dan menerima/menolak hasil |
| ChatGPT Work | Orkestrator | Koordinator | Menyusun Work Order dan dispatch, mengarahkan pertanyaan, memeriksa bukti, serta menjelaskan status |
| Codex | GPT-5.6 Sol | Builder | Mengubah kode pada satu branch dan membuktikan hasil |
| Claude Code | Opus 5 | Reviewer | Menelaah arsitektur, logika, keamanan, dan risiko secara read-only |
| Antigravity | Gemini 3.6 Flash | QA/integrasi | Menjalankan alur nyata dan menguji pengalaman secara read-only |

Ini adalah pembagian default terbaru yang disetujui pengguna. Peran boleh
dirotasi sesuai keahlian tugas, tetapi hanya jika Work Order menyebut alat,
model, mode, dan tanggung jawab baru secara eksplisit.

Setiap alat wajib melaporkan profil aktual pada awal tugas. Jika model yang
tersedia berbeda dari profil di atas, status menjadi `BLOCKED` sampai
orkestrator/pengguna memutuskan apakah substitusi diterima. Tidak boleh ada
penggantian diam-diam.

### Jangan mencampur model alat dengan model produk

Model alat pengembangan di atas berbeda dari arah arsitektur model di dalam
produk Harvy:

| Lapisan produk Harvy | Peran yang telah diarahkan pengguna |
|---|---|
| DeepSeek V4 Flash | Volume tinggi dan risiko rendah, seperti klasifikasi atau ekstraksi |
| GPT-5.6 Luna | Percakapan, pendampingan, dan tutoring generatif utama |
| GPT-5.6 Terra | Masalah tersulit, verifikasi, dan perencanaan kompleks |

Keputusan produk ini tidak membuktikan bahwa router atau semua model sudah
diimplementasikan. PR #2 saat ini hanya merupakan prototipe satu model.
Ketersediaan, slug API, harga, dan batas provider harus diverifikasi kembali
sebelum implementasi atau uji live.

## Batas wewenang

### Pengguna

- Memberikan tujuan dengan bahasa biasa.
- Menjawab keputusan produk yang material.
- Mencoba hasil yang dapat dilihat/dirasakan.
- Menyetujui, meminta perubahan, menunda, atau menolak.

Pengguna tidak harus menulis prompt teknis panjang atau meneruskan konteks
secara manual; itu tanggung jawab orkestrator.

### ChatGPT Work

- Mengubah pembahasan menjadi Work Order dan dispatch yang jelas.
- Menentukan siapa Builder, Reviewer, dan QA untuk satu paket.
- Menjaga catatan status, keputusan, bukti, dan pekerjaan berikutnya.
- Menerjemahkan laporan teknis menjadi bahasa yang dipahami pengguna.
- Menggabungkan pertanyaan agar pengguna tidak dibebani percakapan yang
  berulang.

ChatGPT Work tidak menulis kode, membuat branch, commit, atau PR kecuali
pengguna memberi perintah eksplisit untuk tindakan tersebut. Pembaruan
dokumentasi koordinasi boleh dilakukan setelah persetujuan pengguna. Jika
terjadi penyimpangan, identitas pelaksana aktual harus dicatat; pekerjaan tidak
boleh dilabelkan seolah dikerjakan alat lain.

### Builder

- Menjadi satu-satunya penulis aktif pada Work Order dan branch yang ditugaskan.
- Mengambil keputusan teknis kecil yang mudah dibalik dan mencatatnya.
- Berhenti untuk keputusan material.
- Menjalankan verifikasi, meninjau diff, commit, dan membuat handoff lengkap.

### Reviewer dan QA

- Bekerja read-only.
- Reviewer memeriksa diff dan bukti terhadap Work Order.
- QA menguji commit yang telah ditentukan dari sudut pengguna/integrasi.
- Keduanya tidak memperbaiki kode sendiri dan tidak mengubah branch yang
  diperiksa.

### Pemindahan Builder

Builder tidak boleh berganti hanya melalui chat. Pemindahan kepemilikan sah
jika:

1. penulis lama berhenti dan seluruh perubahan sudah di-commit atau dibatalkan;
2. handoff menyebut commit terakhir dan pekerjaan belum selesai;
3. orkestrator mencatat alasan, Builder baru, branch tujuan, serta file yang
   boleh disentuh;
4. Builder baru mengakui commit awal sebelum mengedit.

Untuk penyimpangan historis PR #1 dan PR #2, implementasi aktual dibuat oleh
ChatGPT Work. Perbaikan berikutnya tidak otomatis kembali ke ChatGPT Work;
orkestrator akan membuat dispatch baru untuk Codex setelah review dan QA
dikumpulkan.

## Sumber kebenaran

| Informasi | Tempat resmi | Siapa memperbarui |
|---|---|---|
| Tujuan, ruang lingkup, peran, status | Work Order | Orkestrator; Builder hanya memperbarui bagian pelaksanaan |
| Keputusan produk permanen | `docs/product/` atau `docs/decisions/` | Orkestrator setelah persetujuan pengguna |
| Kode yang diusulkan | Branch dan commit | Builder |
| Ringkasan serta bukti paket | Pull request | Builder/orkestrator sesuai handoff |
| Temuan review | Review/comment PR dan bagian review Work Order | Reviewer |
| Hasil integrasi/UX | Comment PR dan bagian QA Work Order | QA |
| Temuan kecil | Backlog `docs/PROJECT.md` | Orkestrator |
| Penerimaan akhir | Work Order dan status PR | Pengguna + orkestrator |

Chat membantu koordinasi, tetapi tidak menjadi satu-satunya tempat untuk fakta
yang harus diketahui alat berikutnya.

## Aturan 5×1

1. Satu repositori menjadi sumber kebenaran.
2. Satu Work Order mendefinisikan satu hasil pengguna yang utuh.
3. Satu Builder menjadi satu-satunya penulis aktif pada branch itu.
4. Satu handoff memuat commit/PR dan bukti pengujian.
5. Satu putaran perbaikan utama; temuan kecil masuk backlog.

Kerja paralel bukan default. Orkestrator hanya mengizinkannya jika Work Order
berbeda, branch/folder kerja terisolasi, kepemilikan file tidak tumpang tindih,
dan urutan integrasinya ditulis.

## Status Work Order

| Status | Pemilik tindakan berikutnya | Arti |
|---|---|---|
| `DRAFT` | Pengguna + orkestrator | Kebutuhan masih dibahas |
| `READY` | Builder yang ditugaskan | Ruang lingkup, identitas, branch, dan kriteria telah dikunci |
| `IN_PROGRESS` | Builder | Implementasi sedang berlangsung |
| `BLOCKED` | Orkestrator/pengguna | Keputusan, akses, atau identitas belum tersedia |
| `READY_FOR_REVIEW` | Reviewer | Commit, diff, dan bukti Builder siap diperiksa |
| `CHANGES_REQUESTED` | Builder yang ditugaskan | Temuan material perlu diperbaiki |
| `READY_FOR_QA` | QA | Review material lulus dan commit QA sudah dikunci |
| `READY_FOR_ACCEPTANCE` | Pengguna + orkestrator | Review dan QA yang diwajibkan selesai |
| `ACCEPTED` | Orkestrator | Pengguna menerima commit tertentu; baru dapat digabung |

`READY` tanpa akhiran bukan berarti siap dirilis. Selalu gunakan status yang
menjelaskan siap untuk tahap apa.

## Siklus satu Work Order

1. Pengguna memberikan arah dengan bahasa biasa.
2. Orkestrator merangkum pemahaman dan membuat Work Order `DRAFT`.
3. Pengguna menyetujui hasil, ruang lingkup, dan keputusan material.
4. Orkestrator mengisi Builder, Reviewer, QA, profil model, base commit, branch,
   kriteria penerimaan, verifikasi, dan kondisi berhenti; status menjadi
   `READY`.
5. Orkestrator mengirim dispatch mandiri kepada Builder.
6. Builder mengirim pengakuan awal. Jika cocok, status menjadi `IN_PROGRESS`;
   jika tidak cocok, Builder berhenti.
7. Builder mengimplementasikan, menguji, meninjau diff, commit, push, membuka
   PR, dan mengisi handoff; status menjadi `READY_FOR_REVIEW`.
8. Reviewer menerima dispatch terpisah yang menyebut base dan head commit.
   Reviewer tidak mengedit dan mengirim satu laporan temuan.
9. Jika ada `BLOCKER`/`IMPORTANT`, orkestrator menggabungkannya untuk Builder.
   Builder melakukan perbaikan hanya setelah menerima dispatch perbaikan.
10. Setelah review lulus, QA menerima commit yang dikunci dan menjalankan
    skenario `PASS`/`FAIL`/`NOT RUN`.
11. Orkestrator membandingkan klaim Builder, Reviewer, dan QA, lalu menjelaskan
    kepada pengguna: yang bekerja, yang belum terbukti, risiko, dan keputusan
    yang dibutuhkan.
12. Pengguna menguji atau menilai hasil. Penerimaan selalu menyebut commit.
13. Setelah `ACCEPTED`, PR boleh digabung ke `main`, kemudian Work Order dan
    dokumen keputusan diperbarui.

## Kontrak dispatch dari orkestrator

Setiap alat mendapat instruksi mandiri. Jangan mengirim “lanjutkan pekerjaan
tadi” tanpa konteks berikut:

```text
DISPATCH ID: WO-NNN-<ROLE>-<PUTARAN>
MODE: BUILD | REVIEW | QA
EXPECTED TOOL/MODEL:
REPOSITORY: stafbotz/harvy
WORK ORDER:
BASE REF + COMMIT:
TARGET BRANCH/HEAD COMMIT:
OBJECTIVE:
IN SCOPE:
OUT OF SCOPE:
REQUIRED READS:
REQUIRED VERIFICATION:
STOP AND ASK IF:
WRITE PERMISSION: yes/no dan path/branch yang diizinkan
RETURN FORMAT:
```

Dispatch Builder harus menyebut branch tulis. Dispatch Reviewer/QA harus
menyebut commit tetap dan `WRITE PERMISSION: no`.

## Pengakuan awal dari alat

Sebelum bertindak, alat mengembalikan:

```text
ACK
ACTUAL TOOL/MODEL:
MODE/ROLE:
WORK ORDER:
BASE/BRANCH/COMMIT:
MY UNDERSTANDING:
WILL EDIT: yes/no
MISMATCH OR QUESTIONS: none/<daftar>
```

Jika profil model tidak dapat dilihat, tulis `MODEL: UNVERIFIED`, bukan
menebak. Orkestrator menentukan apakah pekerjaan boleh lanjut.

## Jalur pertanyaan

Jika keputusan material diperlukan, alat tidak bertanya secara kabur. Gunakan:

```text
QUESTION ID:
FROM:
FACTS CHECKED:
DECISION NEEDED:
OPTIONS AND CONSEQUENCES:
RECOMMENDATION:
WORK STOPPED:
```

Alurnya:

1. alat mengirim pertanyaan kepada orkestrator;
2. orkestrator memeriksa apakah jawabannya sudah ada di sumber kebenaran;
3. jika belum, orkestrator menjelaskan pilihan dalam bahasa sederhana kepada
   pengguna;
4. pengguna memutuskan;
5. orkestrator mencatat keputusan pada Work Order/ADR;
6. alat menerima dispatch lanjutan yang memuat keputusan tersebut.

Pilihan teknis kecil yang mudah dibalik tidak perlu menunggu, tetapi harus
dicatat pada handoff.

## Format komunikasi dan handoff

### Catatan aktivitas bersama

Setiap Work Order memiliki tabel:

| Waktu | Alat/model aktual | Mode/peran | Tindakan | Branch/commit/bukti | Hasil | Belum terbukti | Pemilik berikutnya |
|---|---|---|---|---|---|---|---|

Catatan bukan log setiap perintah terminal. Isinya hanya perpindahan tanggung
jawab, keputusan, bukti utama, dan status.

### Handoff Builder

```text
STATUS:
ACTUAL TOOL/MODEL:
WORK ORDER:
BASE / BRANCH / HEAD:
FILES AND BEHAVIOR CHANGED:
DECISIONS AND ASSUMPTIONS:
AUTOMATED CHECKS: command + result
MANUAL CHECKS: PASS/FAIL/NOT RUN + evidence
UNTESTED OR UNPROVEN:
RISKS:
QUESTIONS:
NEXT OWNER:
```

### Laporan Reviewer

Setiap temuan menyebut:

- tingkat `BLOCKER`, `IMPORTANT`, atau `MINOR`;
- lokasi file/baris atau skenario;
- bukti;
- dampak pengguna/operasional;
- langkah verifikasi;
- hubungan dengan kriteria penerimaan.

Reviewer tidak memenuhi kuota temuan dan tidak memperbaiki kode.

### Laporan QA

QA mencatat environment, commit, alat/model aktual, lalu tabel:

| Skenario | Expected | Observed | Status | Bukti/catatan |
|---|---|---|---|---|

Gunakan hanya `PASS`, `FAIL`, atau `NOT RUN`. Tidak ada “sepertinya berhasil”.

### Laporan orkestrator kepada pengguna

Setiap pembaruan harus memisahkan:

1. apa yang berubah;
2. bukti yang benar-benar ada;
3. apa yang belum diuji atau belum diketahui;
4. siapa pemilik tindakan berikutnya;
5. keputusan pengguna yang diperlukan, jika ada.

## Bahasa bukti

| Istilah | Arti yang diizinkan |
|---|---|
| `IMPLEMENTED` | Kode ada pada commit tertentu; belum otomatis berarti bekerja |
| `AUTOMATED PASS` | Perintah tes tertentu dijalankan dan lulus pada environment tertentu |
| `MANUAL PASS` | Skenario pengguna dijalankan dan hasilnya diamati |
| `NOT RUN` | Pengujian tidak dilakukan; alasan disebutkan |
| `READY_FOR_REVIEW` | Handoff Builder lengkap; belum diterima |
| `READY_FOR_QA` | Review material lulus pada commit tertentu |
| `ACCEPTED` | Pengguna menerima commit tertentu |

Klaim dari satu alat tidak berubah menjadi bukti independen hanya karena
diulang orkestrator.

## Branch dan folder kerja

- `main` selalu versi stabil.
- Branch paket memakai `work/wo-NNN-ringkasan`.
- Builder tidak menggunakan branch paket lain tanpa instruksi.
- Dalam satu folder lokal, alat digunakan bergantian. Sebelum berpindah alat,
  semua perubahan harus di-commit atau folder kerja bersih.
- Untuk kerja paralel yang diizinkan, gunakan clone/worktree terpisah.
- Force-push, merge, rebase, penghapusan branch, perubahan secret, atau
  perubahan remote memerlukan instruksi eksplisit.
- Reviewer dan QA memeriksa commit tetap; jika head berubah, hasil lama tidak
  otomatis berlaku pada head baru.

## Adaptor tiga alat

- Codex membaca `AGENTS.md` dari root Git.
- Claude Code membaca `CLAUDE.md`, yang mengimpor `AGENTS.md`.
- Antigravity membaca `.agent/rules/00-harvy-bootstrap.md`, yang menunjuk
  `AGENTS.md`. Di Rules, atur sebagai **Always On**.

Verifikasi saat repo pertama kali dibuka atau setelah adaptor berubah:

1. Codex menyebut Work Order, mode, branch/commit, dan model aktual sebelum
   mengedit.
2. Claude Code menjalankan `/context` dan memastikan `CLAUDE.md` dimuat.
3. Antigravity membuka **Customizations → Rules** dan memastikan bootstrap
   Harvy aktif sebagai **Always On**.

## GitHub privat dan secret

Repo `stafbotz/harvy` harus tetap privat. Jangan menaruh `.env`, token Telegram,
API key, credential, data pengguna nyata, atau isi percakapan sensitif ke Git,
PR, laporan, atau chat. Secret dimasukkan melalui pengaturan resmi alat dan
tetap di environment lokal.

Setelah bootstrap, seluruh perubahan melalui branch dan PR. ZIP atau salinan
chat bukan jalur koordinasi rutin.
