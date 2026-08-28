# Kegagalan Tes yang Sudah Diketahui

Berkas ini mencatat tes yang **sudah merah sebelum kamu menyentuh apa pun**.
Tujuannya satu: agar penulis berikutnya tidak membuang waktu membuktikan bahwa
kegagalan itu bukan ulahnya.

Baca ini sebelum menyimpulkan perubahanmu merusak sesuatu. Bila sebuah
kegagalan tidak tercatat di sini, kemungkinan besar memang berasal dari
perubahanmu — buktikan asalnya sebelum melapor.

## Aturan

- Meninggalkan tes merah wajib dicatat di sini pada sesi yang sama.
- Satu entri memuat: nama tes, berkas, sejak kapan, sebab, dan pemiliknya.
- Hapus entri hanya setelah tes benar-benar hijau, bukan setelah dianggap
  tidak penting.
- Berkas kosong adalah keadaan yang benar. Bila tidak ada kegagalan, sisakan
  bagian "Aktif" kosong dengan satu baris penjelas.

## Aktif

### `meregenerasi code-only yang membawa prosa atau conditional expression rumpang`

- Berkas: `tests/conversation.test.ts`
- Sejak: 2026-08-27, hadir di working tree sebelum pekerjaan tool/persona hari
  itu dimulai.
- Gejala: mengharapkan 3 permintaan model, menerima 2.
- Sebab: pekerjaan `reply()` yang belum selesai di working tree, yaitu langkah
  review artefak kode yang baru ditambahkan (`src/ai/conversation.ts`, sekitar
  blok pemeriksaan akhir artefak). Tes ini hijau pada `HEAD`.
- Pemilik: penulis perubahan `reply()` yang belum di-commit.

### `mereview konsistensi kode dan test sebelum artefak dikirim`

- Berkas: `tests/conversation.test.ts`
- Sejak: 2026-08-27, tes baru yang belum ada di `HEAD`.
- Gejala: artefak hasil review tidak sama dengan yang diharapkan; draft
  dikembalikan tanpa perbaikan konsistensi.
- Sebab: sama dengan entri di atas — langkah review artefak belum selesai.
- Pemilik: penulis perubahan `reply()` yang belum di-commit.

## Cara membuktikan asal sebuah kegagalan

Bila menemukan tes merah yang tidak tercatat di sini:

```bash
git stash push -m "cek-baseline"
npm test
git stash pop
```

Bila tes sudah merah tanpa perubahanmu, catat di sini. Bila tidak, itu
regresimu.

Untuk berkas yang kamu dan orang lain sama-sama ubah, `git stash` tidak
memisahkan keduanya. Petakan hunk diff terhadap fungsi yang gagal:

```bash
git diff HEAD -- path/ke/berkas.ts | rg "^@@"
```

Bila tidak ada hunk milikmu yang jatuh di dalam rentang fungsi yang diuji,
kegagalannya bukan berasal darimu.
