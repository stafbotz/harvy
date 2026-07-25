# WO-NNN: Judul Hasil

- Status: `DRAFT`
- Pemilik produk: pengguna Harvy
- Orkestrator: ChatGPT Work
- Builder yang ditugaskan: `UNASSIGNED` (alat + model)
- Reviewer yang ditugaskan: `UNASSIGNED` (alat + model)
- QA yang ditugaskan: `UNASSIGNED` (alat + model)
- Pelaksana historis, jika berbeda: tidak ada
- Base branch + commit: `main` pada `<sha>`
- Work branch: `work/wo-NNN-ringkasan`
- Head/commit yang sedang diperiksa: belum ada

## Pengakuan identitas dan tugas

| Peran | Profil yang diharapkan | Profil aktual | Mode | Target branch/commit | ACK/status |
|---|---|---|---|---|---|
| Builder | ... | menunggu | `BUILD` | ... | menunggu |
| Reviewer | ... | menunggu | `REVIEW` | ... | menunggu |
| QA | ... | menunggu | `QA` | ... | menunggu |

Jika profil aktual berbeda atau tidak dapat dipastikan, tulis `UNVERIFIED` dan
berhenti sampai orkestrator memutuskan.

## Masalah dan hasil pengguna

Jelaskan masalah dalam bahasa pengguna dan hasil yang harus terasa setelah
paket selesai.

## Dalam ruang lingkup

- ...

## Di luar ruang lingkup

- ...

## Keputusan yang sudah dikunci

- ...

## Pertanyaan yang masih terbuka

- Tidak ada / ...

## Kriteria penerimaan

- [ ] ...

Centang hanya berdasarkan bukti pada commit yang disebutkan. Bedakan tes
Builder, review independen, QA, dan penerimaan pengguna.

## Konteks yang wajib dibaca

| Dokumen/kode | Alasan |
|---|---|
| `AGENTS.md` | Aturan inti |
| `docs/operations/ORCHESTRATION.md` | Dispatch, komunikasi, dan handoff |
| `docs/INDEX.md` | Memilih konteks lain yang relevan |
| ... | ... |

## Batas implementasi

- Path yang boleh atau diperkirakan berubah.
- Dependency, kontrak data, model, layanan, atau biaya yang tidak boleh berubah.
- Risiko kompatibilitas atau migrasi.
- Izin menulis: hanya Builder pada branch ini.

## Verifikasi wajib

Automated:

- `npm run check`
- `npm test`

Manual:

- ...

## Berhenti dan tanyakan jika

- ...

Gunakan format `QUESTION ID`, fakta, keputusan yang dibutuhkan, pilihan dan
dampak, rekomendasi, serta pekerjaan yang berhenti.

## Catatan komunikasi

| Waktu | Alat/model aktual | Mode/peran | Tindakan | Branch/commit/bukti | Hasil | Belum terbukti | Pemilik berikutnya |
|---|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | ... | ... |

## Handoff Builder

- Status:
- Alat/model aktual:
- Base / branch / head:
- File dan perilaku yang berubah:
- Keputusan teknis/asumsi:
- Automated (perintah + hasil):
- Manual (`PASS`/`FAIL`/`NOT RUN` + bukti):
- Belum diuji atau belum terbukti:
- Risiko:
- Pertanyaan:
- Dokumentasi yang diubah:
- Pemilik berikutnya:

## Hasil review

- Reviewer + model aktual:
- Base/head yang dibandingkan:
- Status:
- `BLOCKER`:
- `IMPORTANT`:
- `MINOR` untuk backlog:
- Hal yang tidak diperiksa:
- Pemilik berikutnya:

## Hasil QA/integrasi

- QA + model aktual:
- Commit dan environment:

| Skenario | Expected | Observed | Status | Bukti/catatan |
|---|---|---|---|---|
| ... | ... | ... | `PASS`/`FAIL`/`NOT RUN` | ... |

- Hal yang tidak diuji:
- Pemilik berikutnya:

## Penerimaan

- Ringkasan orkestrator: yang bekerja / belum terbukti / risiko:
- Keputusan pengguna:
- Commit yang diterima:
- Tanggal:
