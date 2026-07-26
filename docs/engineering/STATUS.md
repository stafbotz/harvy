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
| Pencatatan tugas + tombol tindakan | Ada di kode, belum teruji | Tombol baru dapat hidup setelah perbaikan `allowed_updates`; belum pernah dijalankan dengan bot sungguhan |
| Tombol adaptif yang disusun AI | Belum | Seluruh papan tombol ditulis tangan dan tetap di `src/bot/messages.ts`. Model tidak ikut menentukan tindakan apa yang ditawarkan |
| `/start`, `/tugas`, `/bantuan` | Ada, sebagai pelengkap | Bukan cara utama. Tidak ada perintah lain; pesan `/` lain dijawab dengan bantuan |
| Pengurutan prioritas | Ada | Murni dan teruji unit di `src/core/prioritizer.ts` |
| Pengingat | Sebagian | Dapat diminta lewat kalimat ("ingetin aku jam 8") atau tombol. Lewat tombol waktunya masih ditetapkan Harvy, satu jam sebelum tenggat. Jam tenang dan frekuensi belum ada |
| Penyimpanan per pengguna | Ada | JSON atomik, terisolasi lewat `ownerId` |
| Rotasi kunci mode uji | Ada | Teruji unit; perilaku terhadap kuota nyata belum diamati |
| Tutoring bertahap | Belum | Promptnya ada, tetapi tanpa riwayat percakapan pola lima langkah tidak dapat berjalan lintas pesan |
| Riwayat percakapan | Belum | Setiap pesan berdiri sendiri |
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

## Yang belum pernah diverifikasi sama sekali

Harvy belum pernah dijalankan dengan token bot dan kunci API sungguhan. Artinya
seluruh baris "Ada" di atas berarti *ada di kode dan lolos gerbang otomatis*,
bukan *terbukti bekerja bagi pengguna*. Belum ada satu pun percakapan nyata,
tombol yang benar-benar ditekan, atau pengingat yang benar-benar terkirim.

## Cara merawat dokumen ini

Perbarui tabel pada sesi yang mengubah kemampuannya, bukan belakangan. Hapus
baris dari "Cacat yang diketahui" hanya setelah ada bukti, bukan setelah ada
niat. Bila sebuah baris berubah menjadi "Ada", sebutkan bukti apa yang membuatnya
berubah — gerbang otomatis, uji manual, atau keduanya — dan catat perubahannya di
[`../LOG.md`](../LOG.md).
