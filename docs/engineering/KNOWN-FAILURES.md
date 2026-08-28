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

Dua entri percakapan di bawah ini semula dicatat sebagai kegagalan working tree pada
2026-08-27. Commit `4454f65` (2026-08-28) memasukkan `src/ai/conversation.ts`
dan `tests/conversation.test.ts` beserta langkah review artefak yang belum
selesai, jadi keduanya sekarang merah di `HEAD`, bukan lagi hanya di working
tree seseorang. Kalimat "hijau pada `HEAD`" dan "belum ada di `HEAD`" pada versi
lama entri ini sudah tidak berlaku.

### `meregenerasi code-only yang membawa prosa atau conditional expression rumpang`

- Berkas: `tests/conversation.test.ts`
- Sejak: 2026-08-27 di working tree; merah di `HEAD` sejak commit `4454f65`
  pada 2026-08-28.
- Gejala: mengharapkan 3 permintaan model, menerima 2.
- Sebab: langkah review artefak kode pada `reply()` belum selesai
  (`src/ai/conversation.ts`, blok pemeriksaan akhir artefak sekitar baris 1229).
- Pemilik: penulis lanjutan langkah review artefak `reply()`.

### `mereview konsistensi kode dan test sebelum artefak dikirim`

- Berkas: `tests/conversation.test.ts`
- Sejak: 2026-08-27 di working tree; merah di `HEAD` sejak commit `4454f65`
  pada 2026-08-28.
- Gejala: artefak hasil review tidak sama dengan yang diharapkan; draft
  dikembalikan tanpa perbaikan konsistensi.
- Sebab: sama dengan entri di atas — langkah review artefak belum selesai.
- Pemilik: penulis lanjutan langkah review artefak `reply()`.

### `tidak membiarkan usage explicit membajak penilaian produk nonmekanis`

- Berkas: `tests/whatsapp-private-conversation.test.ts`
- Ditemukan: 2026-08-28 pada working tree bersih di `HEAD` `03dcc29`; commit
  pengenal regresi belum dibuktikan.
- Gejala: mengharapkan handler usage tidak dipanggil, menerima satu panggilan.
- Sebab: semantic operation `usage/show-details` dari model masih mencapai
  handler economy ketika pesan pengguna sebenarnya meminta penilaian kesiapan
  produk; akar routing tepatnya belum didiagnosis.
- Pemilik: tindak lanjut routing WhatsApp privat.

Diperiksa ulang langsung dengan
`node --test dist/tests/whatsapp-private-conversation.test.js`: 53/54 lulus dan
kasus ini tetap merah.

Diperiksa ulang 2026-08-28 dengan `node --test dist/tests/conversation.test.js`:
keduanya masih merah. Pekerjaan agent yang belum di-commit hari itu tidak
menyentuh jalur ini — `tests/conversation.test.ts` identik dengan `HEAD` dan
seluruh hunk `src/ai/conversation.ts` yang belum di-commit berada di planner
agent, jauh setelah blok review artefak.

Diperiksa ulang dengan suite penuh pada 2026-08-28 sesudah mesin tata-kelola
agent dihapus: 1.977 lulus, 3 gagal dalam 242 suite. Ketiga entri di atas
adalah satu-satunya yang merah, jadi penghapusan itu tidak menambah regresi.

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
