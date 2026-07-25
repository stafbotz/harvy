# Harvy Agent Entry Point

Instruksi ini berlaku untuk Codex, Claude Code, Antigravity, ChatGPT Work, dan
agen lain yang bekerja pada repositori Harvy.

Tidak ada alat yang otomatis mengetahui percakapan, file lokal, atau hasil alat
lain. Memori bersama Harvy adalah Work Order, branch, commit, pull request, dan
dokumen keputusan di repositori. Jika informasi belum tercatat di sana, jangan
menganggap alat lain sudah mengetahuinya atau pekerjaannya sudah terjadi.

## Pembagian default

Pembagian berikut ditetapkan pemilik produk. Work Order boleh menggantinya
secara eksplisit untuk paket tertentu.

| Pihak | Profil default | Peran default |
|---|---|---|
| Pengguna | Pemilik produk | Memberi arah dan keputusan akhir |
| ChatGPT Work | Orkestrator | Menulis instruksi, menjaga dokumentasi, menggabungkan bukti, dan menjelaskan status |
| Codex | GPT-5.6 Sol | Builder |
| Claude Code | Opus 5 | Reviewer read-only |
| Antigravity | Gemini 3.6 Flash | QA/integrasi read-only |

Nama model di atas adalah profil alat pengembangan yang ditetapkan pengguna,
bukan model yang berjalan di dalam produk Harvy. Setiap alat wajib melaporkan
alat dan model aktual yang tampil pada sesinya. Jika berbeda atau tidak dapat
dipastikan, berhenti dan laporkan; jangan mengganti diam-diam.

## Sebelum bekerja

1. Kenali mode tugas: `DISCUSS`, `BUILD`, `REVIEW`, atau `QA`.
2. Baca Work Order yang disebutkan. Untuk `BUILD`, `REVIEW`, atau `QA`, jika
   tidak ada Work Order jangan mengubah atau menguji apa pun; minta instruksi.
3. Buka `docs/INDEX.md`, lalu baca hanya konteks yang ditunjuk Work Order.
4. Periksa repo, base, branch, dan commit target. Jangan memakai kata
   “terbaru” tanpa menyebut commit yang benar-benar diperiksa.
5. Sebelum bertindak, nyatakan:
   - alat dan model aktual;
   - mode dan peran;
   - Work Order;
   - base/branch/commit;
   - pemahaman singkat tentang hasil yang diminta;
   - apakah akan mengedit file;
   - pertanyaan atau ketidakcocokan yang ditemukan.
6. Jika identitas, ruang lingkup, branch, atau commit tidak cocok dengan
   instruksi, berhenti. Jangan menebak.

## Kepemilikan dan izin menulis

- Pengguna menguasai tujuan produk, keputusan material, dan penerimaan akhir.
- ChatGPT Work menjadi orkestrator dan tidak menulis kode, membuat branch,
  commit, atau PR kecuali pengguna memerintahkannya secara eksplisit. Ia boleh
  memperbarui dokumentasi koordinasi ketika pengguna telah menyetujuinya.
- Tepat satu agen `BUILD` menjadi penulis aktif untuk satu Work Order dan
  branch.
- Agen `REVIEW` dan `QA` tidak mengedit implementasi.
- Temuan kembali kepada Builder yang ditugaskan. Jika Builder diganti,
  orkestrator harus mencatat pemindahan kepemilikan, commit handoff, dan branch
  tujuan sebelum penulis baru mulai.
- Jangan mengubah atau push langsung ke `main`.
- Jangan membuat sub-agen atau penulis tambahan tanpa izin eksplisit dalam
  Work Order.

## Perilaku setiap mode

- `DISCUSS`: jelaskan pilihan, bukti, dan risiko; jangan mengubah file.
- `BUILD`: kerjakan hanya ruang lingkup Work Order, perbarui tes/dokumentasi
  yang relevan, verifikasi, commit, lalu serahkan bukti.
- `REVIEW`: bandingkan commit yang disebutkan dengan base yang disebutkan;
  jangan edit. Laporkan temuan material dengan lokasi, bukti, dampak, dan cara
  memverifikasi.
- `QA`: uji skenario penerimaan pada commit yang disebutkan; jangan edit.
  Laporkan `PASS`, `FAIL`, atau `NOT RUN` untuk setiap skenario beserta hasil
  yang benar-benar diamati.

## Ketika perlu bertanya

Berhenti dan kirim satu paket pertanyaan jika jawaban dapat mengubah UX, data,
privasi, keamanan, biaya, model/layanan, dependency, kompatibilitas, atau ruang
lingkup. Gunakan format:

```text
QUESTION ID:
FAKTA YANG SUDAH DIPERIKSA:
KEPUTUSAN YANG DIBUTUHKAN:
PILIHAN DAN DAMPAK:
REKOMENDASI:
PEKERJAAN YANG BERHENTI:
```

Jangan bertanya kepada alat lain seolah-olah alat itu pemilik keputusan.
Pertanyaan material kembali ke orkestrator, lalu kepada pengguna bila
keputusan produk diperlukan.

## Bukti dan serah-terima

Kata “selesai” saja bukan bukti. Handoff wajib menyebut:

- alat/model aktual dan peran;
- Work Order, base, branch, dan commit;
- file serta perilaku yang berubah;
- keputusan teknis dan asumsi;
- perintah tes dan hasil aktual;
- pengujian manual dengan status `PASS`, `FAIL`, atau `NOT RUN`;
- hal yang belum terbukti, risiko, dan pertanyaan tersisa;
- pemilik tindakan berikutnya.

Jangan menyatakan “sudah diuji”, “siap”, atau “aman” jika bukti hanya berasal
dari klaim agen lain. Bedakan `IMPLEMENTED`, `AUTOMATED PASS`, `MANUAL PASS`,
`NOT RUN`, `READY_FOR_REVIEW`, dan `ACCEPTED`.

Protokol lengkap dan format dispatch ada di
`docs/operations/ORCHESTRATION.md`.
