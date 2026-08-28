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

Tidak ada kegagalan yang diketahui. Suite penuh pada 2026-08-29 hijau: 1.980
tes, 1.980 lulus, 0 gagal dalam 242 suite, exit code 0.

Ketiga entri yang sebelumnya tercatat di sini sudah diperbaiki pada tanggal yang
sama. Sebabnya dicatat di bawah karena dua di antaranya sempat salah
didiagnosis, dan diagnosis yang salah itulah yang membuat ketiganya bertahan
merah berhari-hari.

### Sudah diperbaiki: dua tes review artefak kode

`meregenerasi code-only yang membawa prosa atau conditional expression rumpang`
dan `mereview konsistensi kode dan test sebelum artefak dikirim`, keduanya di
`tests/conversation.test.ts`.

Catatan lama menyebut sebabnya "langkah review artefak `reply()` belum
selesai". Itu keliru — langkahnya sudah lengkap. Yang salah adalah satu
argumen: blok review memanggil `this.execution(...)` dengan stage role `critic`
sambil mewariskan `cognitiveRole` giliran utama, padahal `validateCognitiveRole`
di `src/core/execution-policy.ts` hanya mengizinkan `critic` berpasangan dengan
`verifier` atau `challenger`. `ExecutionPolicy` melempar sebelum provider
dipanggil, dan `catch` di sekeliling blok itu menelannya sebagai "review
gagal" lalu diam-diam mempertahankan draft. Gejalanya terlihat seperti fitur
yang belum ditulis. Perbaikannya satu baris: `cognitiveRole: "verifier"`.

Tes kedua masih merah setelah itu karena setupnya sendiri kurang: ia memeriksa
atribusi billing (`usage.purpose`) tanpa pernah memberi `ownerId` ke `reply()`,
sedangkan `usage()` memang sengaja mengembalikan `undefined` tanpa pemilik.
Runtime `{ ownerId: "student", channel: "telegram" }` ditambahkan mengikuti
konvensi tes lain di berkas yang sama.

### Sudah diperbaiki: `tidak membiarkan usage explicit membajak penilaian produk nonmekanis`

`tests/whatsapp-private-conversation.test.ts`.

Catatan lama menyebut "semantic operation `usage/show-details` masih mencapai
handler economy". Itu juga keliru. Handler economy tidak pernah terpanggil —
`allowsDeterministicSurface` menolak assessment nonmekanis, persis seperti
seharusnya. Assertion yang gagal adalah `agentCalls`, bukan `usageRead`.

Sebab sebenarnya: tes ini mengunci aturan bahwa `toolNeed: "internal_state"`
bukan authority Agent Runtime. Aturan itu sengaja diubah bersama kontrak
planner `tool_choice: "auto"`, dengan alasan terukur yang ditulis panjang di
`requestsAgentTooling` (`src/ai/model-policy.ts`). Tes kembarannya di
`tests/create-bot-flow.test.ts` sudah diperbarui saat itu; versi WhatsApp
tertinggal. Kini keduanya menegaskan invariant yang sama dan lebih kuat:
`agentCalls + replyCalls === 1` — tepat satu jalur menjawab — sementara
`usageRead === 0` tetap menjaga maksud asli tes.

### Pelajaran

Sebab pada berkas ini adalah hipotesis sampai dibuktikan. Dua dari tiga entri di
atas salah sebab, dan keduanya menuduh "fitur belum selesai" padahal fiturnya
ada. Ketika sebuah `catch` menelan error tanpa mencetak pesannya, gejala di
permukaan tidak dapat dipakai menyimpulkan akar masalah; cetak dulu error yang
tertelan.

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
