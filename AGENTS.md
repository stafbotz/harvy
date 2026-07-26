# Harvy Agent Entry Point

Instruksi ini berlaku untuk Codex, Claude Code, Antigravity, dan coding agent
lain yang bekerja di repositori Harvy, sekaligus untuk manusia yang baru
bergabung.

## Kontrak

Tiga hal ini tidak boleh dilewati, sependek apa pun pekerjaannya.

1. **Baca konteks sebelum menjawab apa pun.** `docs/PROJECT.md`,
   `docs/CONSTITUTION.md`, `docs/engineering/STATUS.md`, dan `docs/LOG.md`.
   Jangan menjawab pertanyaan tentang keadaan proyek dari ingatan, dari nama
   berkas, atau dari dugaan yang terdengar masuk akal.
2. **Jangan mengklaim apa pun yang belum diperiksa.** Kalau sebuah kemampuan
   tidak tercatat di `STATUS.md` dan tidak terlihat di kode, kemampuan itu
   dianggap belum ada. Katakan "belum diperiksa" alih-alih menebak.
3. **Tulis entri `docs/LOG.md` sebelum sesi berakhir** — untuk sesi yang menulis
   kode maupun yang hanya berdiskusi. Diskusi yang menghasilkan keputusan tetapi
   tidak dicatat akan hilang, karena sesi berikutnya tidak dapat membaca
   percakapan ini.

Kontrak ini ada karena pernah dilanggar. Dokumen di repositori ini sempat
mencatat penghapusan tiga berkas yang tidak pernah ada, hanya karena penulisnya
menyusun riwayat yang masuk akal alih-alih memeriksanya. Lihat catatan koreksi
di `ADR-002` dan `ADR-004`.

## Sebelum bekerja

Repositori ini dikerjakan bergantian oleh manusia dan beberapa AI yang tidak
dapat membaca riwayat percakapan satu sama lain. Karena itu konteks diambil dari
repositori, bukan dari ingatan atau dugaan. Jawab empat pertanyaan ini lebih
dulu:

1. **Proyek ini apa dan untuk siapa?** → `docs/PROJECT.md`
2. **Apa batas moral dan hak penggunanya?** → `docs/CONSTITUTION.md`.
   Konstitusi berkedudukan lebih tinggi daripada dokumen lain di repositori ini,
   dan wajib dibaca untuk perubahan yang menyentuh perilaku produk, memori,
   notifikasi, privasi, keselamatan, atau agensi pengguna.
3. **Apa yang sudah benar-benar berjalan?** → `docs/engineering/STATUS.md`.
   Jangan mengklaim sebuah kemampuan sudah ada tanpa memeriksa dokumen ini atau
   kodenya langsung.
4. **Apa yang dikerjakan terakhir kali, dan kenapa?** → `docs/LOG.md`.

`docs/INDEX.md` memetakan sisanya; baca hanya yang relevan, jangan memuat
seluruh `docs/`. Jika dokumentasi berbeda dari kenyataan kode, ikuti kode dan
laporkan perbedaannya.

## Kepemilikan

- Pengguna Harvy menguasai tujuan produk, ruang lingkup, keputusan material, dan
  penerimaan akhir.
- Satu penulis aktif pada satu waktu. Yang meninjau atau menguji tidak ikut
  mengedit; perbaikan kembali ke penulis yang sama.
- Jangan mendelegasikan edit kepada agent lain atau menjalankan pekerjaan
  paralel yang menulis file, kecuali diminta.
- Jangan mengubah atau melakukan push langsung ke `main`.
- Sebelum berpindah alat, commit pekerjaan atau pastikan folder kerja bersih.
  Alat berikutnya tidak dapat melihat perubahan yang masih menggantung.

## Ruang lingkup

Kerjakan yang diminta sampai tuntas, lalu berhenti di situ. Sejak `ADR-005`
tidak ada Work Order, sehingga yang menahan pekerjaan agar tidak melebar hanya
permintaannya sendiri dan penilaian penulisnya.

- Ketika diminta berdiskusi, jelaskan pilihan dan risikonya; jangan mengubah
  file.
- Ketika diminta meninjau atau menguji, laporkan temuan beserta bukti; jangan
  memperbaiki sendiri.
- Ketika menulis, perbarui tes dan dokumentasi yang memang ikut berubah,
  termasuk `docs/engineering/STATUS.md` bila kemampuannya bergeser.

## Perintah pengembangan

```bash
npm ci                 # instal dari lockfile
npm run check          # tsc --noEmit, gerbang tipe
npm test               # build lalu node --test dist/tests/*.test.js
npm run build          # tsc ke dist/
npm run dev            # tsx watch src/app.ts, perlu .env berisi TELEGRAM_BOT_TOKEN
npm start              # jalankan hasil build
```

Tidak ada linter atau formatter terpasang; `npm run check` adalah satu-satunya
gerbang statis. Tes dijalankan dari hasil build, bukan dari `tests/*.ts`, jadi
selalu `npm run build` sebelum memanggil `node --test` secara manual.

`npm run build` tidak membersihkan `dist/`. Setelah menghapus atau mengganti
nama berkas sumber, jalankan `rm -rf dist` lebih dulu agar hasil build lama
tidak ikut dijalankan sebagai tes.

Menjalankan satu berkas tes atau satu kasus:

```bash
npm run build && node --test dist/tests/prioritizer.test.js
npm run build && node --test --test-name-pattern="menandai tugas selesai" dist/tests/*.test.js
```

Konfigurasi runtime berasal dari `.env` (lihat `.env.example`):
`TELEGRAM_BOT_TOKEN`, `DATA_FILE`, `DEFAULT_TIMEZONE`, `DEFAULT_UTC_OFFSET`,
`REMINDER_INTERVAL_MS`, serta kelompok `AI_*` termasuk `AI_BASE_URL` yang
menimpa alamat bawaan penyedia. Berkas `.env` dibaca lewat
`process.loadEnvFile()`, tanpa dependency tambahan.

ID model tidak boleh ditulis di kode. Nama dan harga model berubah cepat, jadi
semuanya dibaca dari environment agar koreksi cukup satu baris `.env`.
`AI_MODE=testing` memakai satu model gratis lewat Google AI Studio dengan
beberapa kunci bergantian; `AI_MODE=production` memakai tiga model lewat
OpenRouter. Tanpa kunci, bot menolak start.

Dalam mode `testing`, `resolveModel` mengembalikan model yang sama untuk semua
tingkatan. Routing tetap dihitung tetapi tidak dapat diamati, jadi jangan
mengklaim routing sudah terbukti setelah menguji dalam mode ini.

## Arsitektur

Aliran satu arah: adapter Telegram → layanan → port penyimpanan. Logika inti
tidak mengenal grammY maupun berkas.

- `src/app.ts` — satu-satunya composition root. Merangkai `loadConfig` →
  `FileTaskRepository` → `TaskService` → `createBot` → `startReminderWorker`,
  mendaftarkan command Telegram, dan menangani shutdown.
- `src/domain/task.ts` — bentuk data `StudentTask` sekaligus port
  `TaskRepository`. Inti bergantung pada antarmuka ini, bukan pada penyimpanan.
- `src/core/` — bebas I/O dan bebas Telegram: `prioritizer.ts` (skor prioritas
  murni) dan `task-service.ts` (orkestrasi kasus penggunaan).
- `src/ai/` — lapisan Harvy di atas model: `persona.ts` (kepribadian, batas
  moral, aturan keselamatan), `model-policy.ts` (memilih tingkatan model dari
  kesulitan), `understand.ts` (membaca balasan model sebagai masukan tidak
  tepercaya), `client.ts` (HTTP kompatibel OpenAI dengan rotasi kunci),
  `key-pool.ts`, dan `conversation.ts` (menyatukan pemahaman dan balasan).
  Percakapan berjalan dua langkah: model `cheap` selalu membaca pesan menjadi
  JSON pada `temperature: 0`, lalu tingkatan model untuk balasan dipilih dari
  hasil bacaan itu. Ekstraksi tidak pernah membayar harga model besar, dan
  `safetySensitive` selalu naik ke `ambitious` sekaligus menambahkan
  `SAFETY_ADDENDUM` ke prompt.
- `src/bot/` — adapter grammY: `create-bot.ts` memasang guard chat pribadi,
  alur percakapan, dan tombol; `messages.ts` memformat keluaran serta menyusun
  papan tombol; `pending.ts` menyimpan satu langkah percakapan yang sedang
  menunggu jawaban.
- `src/storage/file-task-repository.ts` — JSON `{ version: 1, tasks: [] }`,
  tulis atomik melalui berkas `.tmp` lalu `rename`, dan serialisasi tulis
  melalui antrian promise agar tidak ada pembaruan yang hilang.
- `src/reminders/reminder-worker.ts` — `setInterval` dengan penjaga reentrancy;
  `reminderSentAt` mencegah satu pengingat terkirim dua kali.

Invarian yang harus dijaga:

- **Pesan bebas tidak boleh langsung menjadi tugas.** Model membaca maksudnya
  lebih dulu; tugas hanya dicatat langsung ketika maksudnya memang mencatat
  pekerjaan. Selebihnya Harvy menjawab lalu *menawarkan* pencatatan lewat
  tombol. Ini menegakkan Konstitusi Pasal 3.11 dan melindungi pengguna yang
  sedang bercerita.
- **Balasan model adalah masukan yang tidak tepercaya.** Selalu lewat
  `understand.ts`; jangan pernah memakai hasil `JSON.parse` mentah dari model.
- **Harvy tidak punya cadangan berbasis aturan.** Tanpa kunci API, bot tidak
  dapat memproses pesan dan harus mengatakannya terus terang.
- `ownerId` (Telegram `from.id`) adalah batas isolasi data. Setiap metode
  repository menerima `ownerId`; jangan menambah kueri tugas tanpa itu.
- **Percakapan dan tombol adalah antarmuka utama, bukan perintah `/`.** Perintah
  hanya pelengkap opsional. Jangan menambah perintah baru sebagai cara memakai
  sebuah fitur; jalannya lewat pesan bebas dan tombol. Tombol yang ditawarkan
  seharusnya adaptif menurut keadaan percakapan, disusun AI — saat ini masih
  papan tombol tetap di `bot/messages.ts`, dan itu tercatat sebagai kesenjangan
  di `docs/engineering/STATUS.md`.
- ID tugas tidak pernah ditampilkan kepada pengguna. Semua tindakan berjalan
  lewat tombol inline yang membawa ID di `callback_data`.
- Waktu disimpan sebagai ISO UTC. Input diurai memakai `DEFAULT_UTC_OFFSET`,
  tampilan memakai `DEFAULT_TIMEZONE`. Belum ada zona waktu per pengguna;
  jangan mengasumsikan zona waktu proses.
- `TaskService` menerima `now: () => Date` agar dapat diuji. Tes memakai
  `MemoryRepository` yang mengimplementasi `TaskRepository`, bukan berkas nyata.
- `PendingStore` hanya di memori, satu langkah per pengguna, hangus setelah 10
  menit. Tombol "Ya, catat" dan alur "Ubah tenggat" bergantung padanya, jadi
  keduanya memang mati setelah proses restart. Itu keadaan normal, bukan galat.
- Proyek ini ESM dengan `module: NodeNext`. Impor antarmodul wajib berakhiran
  `.js` meskipun sumbernya `.ts`.
- `tsconfig.json` memakai `strict`, `noUncheckedIndexedAccess`, dan
  `exactOptionalPropertyTypes`. Indeks array menghasilkan tipe opsional.
- Di chat non-pribadi, Harvy hanya menjawab perintah dan mengabaikan pesan lain.
  Pesan bebas hanya diproses di chat pribadi, dan di sana itulah jalur utamanya.

Menambah perilaku baru biasanya menyentuh, berurutan: tipe di `domain/`, port
`TaskRepository` bila datanya baru, logika dan tes di `core/`, perintah di
`bot/create-bot.ts`, lalu teks di `bot/messages.ts`.

## Batas dan verifikasi

- Jangan memasukkan `.env`, token, credential, data pengguna nyata, atau secret
  lain ke Git maupun laporan.
- Jangan menambah dependency, mengubah kontrak data, pengalaman pengguna,
  keamanan, layanan eksternal, atau biaya tanpa diminta.
- Keputusan teknis kecil boleh diambil dan dicatat dalam serah-terima.
- Kumpulkan pertanyaan yang memengaruhi UX, data, keamanan, biaya, atau ruang
  lingkup dan tanyakan sekaligus.
- Gunakan Node.js 22 atau lebih baru.
- Pemeriksaan minimum perubahan kode: `npm run check` dan `npm test`.
- **Gerbang otomatis tidak menyentuh model sungguhan maupun grammY.** Yang
  teruji hanya bagian murni. `npm test` yang hijau tidak membuktikan Harvy dapat
  berbicara, tombolnya hidup, atau pengingatnya terkirim; itu hanya dapat
  dibuktikan lewat uji manual dengan kunci API sungguhan.
- Baca `docs/engineering/STATUS.md` sebelum mengklaim sebuah kemampuan sudah
  ada. Dokumen lain menjelaskan tujuan dan keputusan, bukan keadaan kode.
- Baca `docs/engineering/TESTING.md` untuk bukti tes dan pengujian manual.

## Selesai berarti

Sebuah pekerjaan selesai ketika ada empat hal:

1. perubahan yang terlihat pada diff;
2. hasil `npm run check` dan `npm test` yang benar-benar dijalankan, beserta
   angkanya;
3. keterangan terus terang tentang apa yang **tidak** diuji — percakapan,
   tombol, dan pengingat tidak tersentuh gerbang otomatis; dan
4. satu entri baru di `docs/LOG.md`, ditulis sebelum sesi berakhir.

Entri `LOG.md` adalah satu-satunya cara sesi berikutnya mengetahui apa yang
sudah terjadi. Melewatkannya berarti memaksa penulis berikutnya menebak, dan
tebakan yang masuk akal pernah masuk ke dokumen sebagai fakta yang tidak pernah
terjadi.

Chat yang berkata “selesai” tanpa empat hal itu belum selesai.

Cara kerja selengkapnya ada di `docs/operations/WORKFLOW.md`.
