# Status Kemampuan Harvy

Dokumen ini menjawab satu pertanyaan saja: **apa yang benar-benar berjalan hari
ini.** Dokumen lain di repositori ini menjelaskan tujuan, keputusan, dan batas
moral — semuanya sah, tetapi tidak satu pun menyatakan keadaan kode. Perbedaan
itu pernah membuat agent dan manusia sama-sama mengira kemampuan yang masih
berupa rencana sudah tersedia.

Aturannya: **jika sebuah kemampuan tidak tercatat “Ada” di sini, jangan
mengklaimnya ada.** Kalau dokumen lain terdengar lebih optimistis, dokumen ini
yang menang, dan perbedaannya dilaporkan.

- Terakhir diverifikasi: 26 Juli 2026.
- Basis: commit `9971ac2` ditambah perubahan lapisan AI yang belum di-commit.
- Cara verifikasi: membaca kode secara langsung, bukan membaca dokumen lain.

## Cara memakai Harvy

Harvy Capybara dipakai lewat **percakapan biasa dan tombol**, bukan lewat
perintah `/`. Pengguna menulis apa adanya; Harvy memahami maksudnya, lalu
menyediakan tindakan sebagai tombol. Perintah `/` hanya pelengkap opsional dan
tidak boleh menjadi cara utama apa pun — Konstitusi Pasal 3.11 melarang pengguna
dipaksa menghafal perintah.

Tombolnya sendiri seharusnya **adaptif dan disusun AI menurut keadaan**, bukan
papan tombol tetap. Ini belum terjadi; lihat tabel di bawah.

## Kemampuan

| Kemampuan | Status | Catatan |
|---|---|---|
| Bot Telegram khusus chat pribadi | Ada | Chat non-pribadi hanya dijawab bila pesannya perintah |
| Pesan bebas dipahami model | Ada | Jalur utama. Dua langkah: ekstraksi `cheap`, lalu balasan sesuai tingkatan |
| Curhat tidak otomatis jadi tugas | Ada | Harvy menjawab dulu, pencatatan ditawarkan lewat tombol |
| Pencatatan tugas + tombol tindakan | Ada, terbukti | Tugas tercatat dan tombol Selesai berfungsi pada percakapan nyata 26 Juli 2026 |
| Tombol adaptif yang disusun AI | Belum | Seluruh papan tombol ditulis tangan dan tetap di `src/bot/messages.ts`. Model tidak ikut menentukan tindakan apa yang ditawarkan |
| `/start`, `/tugas`, `/bantuan` | Ada, sebagai pelengkap | Bukan cara utama. Tidak ada perintah lain; pesan `/` lain dijawab dengan bantuan |
| Pengurutan prioritas | Ada | Murni dan teruji unit di `src/core/prioritizer.ts` |
| Pengingat | Sebagian | Dapat diminta lewat kalimat ("ingetin aku jam 8") atau tombol. Lewat tombol waktunya masih ditetapkan Harvy, satu jam sebelum tenggat. Jam tenang dan frekuensi belum ada |
| Penyimpanan per pengguna | Ada | JSON atomik, terisolasi lewat `ownerId` |
| Rotasi kunci mode uji | Ada | Teruji unit; perilaku terhadap kuota nyata belum diamati |
| Tutoring bertahap | Belum | Promptnya ada, tetapi tanpa riwayat percakapan pola lima langkah tidak dapat berjalan lintas pesan |
| Riwayat percakapan | Belum | Setiap pesan berdiri sendiri. Pernah membuat Harvy menjawab "ini pesan pertama kamu" padahal bukan; sejak 26 Juli 2026 prompt mewajibkannya mengaku tidak punya ingatan alih-alih menyangkal |
| Memori terstruktur dan kendalinya | Belum | Belum ada objek memori untuk dilihat, diperbaiki, atau dihapus |
| Pemeriksaan keselamatan sebagai lapisan | Belum | Hanya satu field JSON yang dinilai model ekstraksi, lalu dijawab tambahan prompt |
| Pemeriksaan respons sebelum dikirim | Belum | Balasan model langsung diteruskan ke pengguna |
| Pemberitahuan dan persetujuan privasi | Belum | Isi pesan sudah dikirim ke penyedia pihak ketiga tanpa diberitahukan |
| Zona waktu per pengguna | Belum | Satu zona untuk semua, dari `.env` |
| Ekspor dan hapus seluruh data | Belum | Tidak ada jalannya dari dalam chat |
| Batas pemakaian dan pemantauan biaya | Belum | Tidak ada penghitungan token |
| Ukuran keberhasilan Pasal 8 | Belum | Tidak ada yang diukur, termasuk yang boleh diukur |
| WhatsApp dan website | Belum | Belum dimulai, dan memang belum dijadwalkan |

## Cacat yang diketahui

Tidak ada yang tercatat saat ini. Tiga cacat sebelumnya — pagar injeksi yang
tidak terpasang, `remindAt` yang dibuang, dan mode JSON yang tidak dipakai —
diperbaiki pada 26 Juli 2026 dan kini dijaga tes di `tests/conversation.test.ts`
serta `tests/task-service.test.ts`.

Ketiganya punya pola yang sama dan pantas diingat: **kode ditulis lengkap lalu
tidak pernah disambungkan.** `tsconfig.json` tidak mengaktifkan `noUnusedLocals`,
sehingga impor dan fungsi yang tidak pernah dipanggil tetap lolos
`npm run check`. Gerbang statis tidak akan menangkap cacat keempat yang serupa.

## Bukti dari pemakaian nyata

**26 Juli 2026 — Harvy berjalan untuk pertama kalinya** dengan token bot dan
kunci sungguhan.

Terbukti bekerja:

- sapaan dan perkenalan diri sebagai AI berbentuk kapibara;
- obrolan ringan yang tidak berubah menjadi tugas;
- persona dan gaya bahasa sesuai `persona.ts`.

- pencatatan tugas dari kalimat, lengkap dengan pengingat: "ingetin aku pukul
  sebelas lewat 43 menit untuk minum obat" tercatat benar berikut 🔔;
- **tombol inline benar-benar hidup.** Tombol Selesai ditekan dan bekerja, yang
  sekaligus membuktikan perbaikan `allowed_updates`;
- tutoring satu giliran: "ajarin aku kalkulus" dijawab dengan memecah topik dan
  bertanya balik, bukan langsung menceramahi.

Pernah gagal, sudah diperbaiki:

- **Balasan model terpotong.** Dua percobaan pengingat pertama dijawab "Aku
  belum menangkap maksudnya". Penyebabnya bukan format, melainkan panjang:
  `gemini-3.6-flash` memakai token keluaran untuk berpikir, dan batas 400 token
  habis sebelum JSON-nya ditutup. Sapaan pendek tetap lolos, sehingga cacatnya
  hanya menyerang pesan yang paling perlu dipahami. Batas dinaikkan dan
  `finish_reason=length` kini dicatat ke log.
- **Harvy menyangkal riwayat yang tidak diingatnya.** Ditanya "aku tanya apa
  tadi", ia menjawab "ini pesan pertama kamu di obrolan kita" — pernyataan yang
  tidak benar tentang pengalaman penggunanya sendiri. Prompt kini mewajibkannya
  mengaku tidak punya ingatan percakapan. Ini pelanggaran Pasal 3.6 dan Pasal 5
  nomor 6, bukan sekadar fitur yang belum ada.

Masih belum pernah terjadi:

- pengingat yang benar-benar terkirim oleh worker pada waktunya;
- percakapan keselamatan;
- pemakaian lebih dari beberapa menit berturut-turut.

Untuk baris yang masih "Ada" tanpa keterangan terbukti, artinya *ada di kode dan
lolos gerbang otomatis*, bukan *terbukti bekerja bagi pengguna*.

### Perlu diperiksa

Pada transkrip 26 Juli 2026, konfirmasi setelah tombol Selesai muncul sebagai
"Selesai ✓" tanpa judul tugas, padahal `refreshAfterChange` menyusunnya sebagai
`Selesai ✓ <judul>`. Belum jelas apakah judulnya benar-benar hilang atau hanya
tidak ikut tersalin saat transkrip disalin. Perlu diamati sekali lagi.

## Cara merawat dokumen ini

Perbarui tabel pada sesi yang mengubah kemampuannya, bukan belakangan. Hapus
baris dari "Cacat yang diketahui" hanya setelah ada bukti, bukan setelah ada
niat. Bila sebuah baris berubah menjadi "Ada", sebutkan bukti apa yang membuatnya
berubah — gerbang otomatis, uji manual, atau keduanya — dan catat perubahannya di
[`../LOG.md`](../LOG.md).
