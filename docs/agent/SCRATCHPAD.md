# Scratchpad — Pekerjaan Belum Selesai

Berkas kerja, bukan status. Ia mencatat sisa pekerjaan yang sudah punya bentuk
konkret supaya penulis berikutnya tidak menurunkannya ulang dari nol. Fakta yang
sudah terbukti ada di `docs/engineering/STATUS.md` dan `docs/LOG.md`; hapus
butir di sini begitu ia selesai atau ternyata tidak diperlukan.

Diperbarui 29 Agustus 2026 sesudah tiga sesi Telegram nyata lewat akun penguji.
Dua alat baru lahir dari sesi itu dan sebaiknya dipakai sebelum menyentuh butir
mana pun di bawah:

- `npm run uji:telegram` — pemeriksaan kanal nyata dengan ekspektasi yang
  diperiksa kode. Ia menyatukan kejadian transport tester dengan log runtime,
  lalu menilai intent, route, domain semantik, apakah Agent Runtime dipakai,
  dan capability mana yang berhasil. Exit 1 bila menyimpang.
- `npx tsx scripts/ukur-batas-giliran.ts` — distribusi latensi classifier batas
  giliran tanpa timeout produksi yang mengikat.

Putaran 29 Agustus sore, diverifikasi sesi Telegram nyata **7/7 lulus**:

- Pagar wiring capability tanpa schema berjalan di composition root.
- `task/cancel` punya pintu bahasa alami. Terbukti live: Harvy meminta
  konfirmasi sebelum menghapus dan menawarkan "tandai selesai" sebagai
  alternatif yang tidak menghilangkan riwayat.
- Ambang otorisasi permukaan bertingkat menurut akibat, bukan seragam.
- `memory.list` dan `memory.remember` terbukti dipanggil model nyata, dan
  penyangkalan palsu "belum ada catatan" hilang.
- Aturan gagal-aman untuk pengumpulan bukti tercatat di `AGENTS.md`.

Yang diukur dan **tidak** menghasilkan perbaikan ada di butir 1: dua percobaan
menaikkan ketepatan `history.search` belum terbukti membantu.

## 1. Ketepatan isi `history.search` belum stabil

Tool-nya terbukti dipanggil di probe maupun kanal nyata; yang belum terbukti
adalah isinya benar. Dua percobaan perbaikan sudah dilakukan dan **keduanya
belum terbukti membantu**:

1. Dua peringatan ditambahkan ke deskripsi tool (sertakan kata pengguna; jangan
   gabungkan klaim lintas episode). Pengukuran sesudahnya: 1 dari 3 run
   menyebut klaim `unresolved` yang tepat.
2. `MAX_CLAIMS_PER_MATCH` disamakan dengan
   `HISTORY_SEARCH_CLAIMS_PER_EPISODE_LIMIT` (4 → 6), karena executor memotong
   lebih agresif daripada pencariannya sendiri dan klaim yang dicari jatuh di
   urutan keempat ke bawah. Pengukuran sesudahnya: 1 tepat, 1 meleset, 1 tidak
   terbaca.

Dengan n=3 dan varians setinggi ini, tidak satu pun angka di atas boleh disebut
perbaikan. Yang konsisten di seluruh pengukuran hanya dua hal: `history.search`
selalu terpanggil, dan Harvy tidak pernah mengarang ketika tidak menemukan.

Sebabnya struktural. `searchConversationEpisodes` memberi peringkat leksikal
atas teks klaim, jadi query yang hanya memuat topik mengembalikan topik, fakta,
dan penanda waktu — sementara klaim `unresolved` yang justru ditanyakan tidak
naik. Query yang memuat kata pengguna sendiri ("belum jelas") mengambilnya.

Langkah berikutnya yang benar-benar mengubah mekanisme, bukan menambah
peringatan: memberi bobot pada field yang cocok dengan bentuk pertanyaan.
Pertanyaan tentang hal yang menggantung menaikkan `unresolved` dan
`uncertainties`; pertanyaan tentang keputusan menaikkan `decisions`. Ukur
dengan ulangan minimal 10 sebelum menyimpulkan apa pun—tiga run tidak cukup
untuk membedakan perbaikan dari keberuntungan.

## 1b. Kosakata internal bocor meski ada aturan prompt yang melarangnya

`AGENT_PLANNER_SHARED` memuat aturan eksplisit: "jangan menyebut episode,
klaim, record, field, query, hasil pencarian, atau nama tool di jawabanmu."
Aturan itu **tidak dipatuhi**. Dari lima jawaban recall terakhir, tiga memakai
kata "episode" secara harfiah ("ketemu episode dari 14 Agustus", "nemu dua
episode").

Aturan prompt yang tidak berlaku lebih buruk daripada tidak ada aturan: ia
membuat pembaca kode mengira masalahnya sudah tertutup. Dua arah yang masuk
akal, dan keduanya belum dicoba:

- Hilangkan sumbernya. Hasil tool memuat `episodeId` dan
  `kind: "history.search.result"`; model mencontoh kosakata yang dilihatnya.
  Menamai field hasil dengan istilah netral menghapus contohnya, bukan sekadar
  melarangnya.
- Ukur dulu apakah aturannya memang tidak sampai. Aturan itu ada di
  `AGENT_PLANNER_SHARED`, yang dipakai kedua kontrak; pastikan ia benar-benar
  ikut terkirim pada giliran recall sebelum menyalahkan kepatuhan model.

## 2. Capability tanpa schema: pagarnya sudah ada

`assertCallableCapabilitySchemas` menolak capability yang terpasang tetapi
executornya tanpa schema native, dipanggil dari composition root di
`src/app.ts`. Kesalahan wiring kini terlihat saat proses dinyalakan, bukan pada
pesan pertama pengguna.

Pemeriksaannya memakai irisan terpasang dan executor, bukan daftar executor
saja: executor untuk capability yang tidak dipasang tidak pernah ditawarkan ke
planner, jadi menuntut schema darinya akan menolak fixture yang sah. Lima tes
mengunci keduanya.

Yang tersisa dan sengaja tidak dikerjakan: lemparan di dalam
`agentNativeTools` masih dinamai `invalid_planner_output` oleh `abortReason`.
Menamainya sendiri berarti menambah alasan penghentian baru beserta copy-nya,
padahal pagar composition root membuat kelas ini tidak lagi sampai ke pengguna
pada deployment yang sehat. Kerjakan hanya bila kelas ini pernah muncul lagi di
produksi.

## 3. Anggaran run `orchestrate` foreground terlalu ketat untuk delegasi paralel

`scripts/coba-agent.ts` kasus "root orchestrate": `agent.delegate.parallel`
selesai `ok`, lalu run berhenti `deadline` pada langkah berikutnya di 2 dari 3
run. Batasnya `deadlineMs: 45_000` dan itu memang batas produksi.

Bukan otomatis cacat: produksi mengarahkan pekerjaan orchestrate berat ke
AgentRun latar lewat `requiresAgentPlanning`, sedangkan probe memanggil
`conversation.agent()` langsung. Yang perlu diperiksa adalah apakah ada
permintaan nyata yang lolos ke jalur foreground tetapi membutuhkan delegasi
paralel; bila ada, yang salah gerbangnya, bukan anggarannya.

## 4. `memory.list` dan `memory.remember`: terbukti dipanggil

Keduanya punya bukti model nyata sejak 29 Agustus 2026, diukur dengan
`scripts/probe-chat.ts --catatan-sintetis` di atas korpus tiga catatan.

Rantai lengkap terekam: `memory.list` → `memory.remember` → `task.list_active`
→ final, lima langkah, `completed`, dan jadwal yang dihasilkan memakai isi
catatan dengan benar (blok 20 menit, pagi sebelum jam tujuh).

Yang menutup jalannya ternyata bukan kontrol memori deterministik melainkan
`toolNeed`, dan sebabnya sama persis di dua tempat: **catatan tersimpan tidak
disebut sebagai state.** Prompt ekstraksi hanya menyebut tugas, agenda, sesi,
pengingat, waktu, dan pengaturan; prompt planner hanya menyebut tugas, agenda,
waktu, dan pengingat. Keduanya sudah diperbaiki, dan efeknya terukur:

| frasa "sesuaikan sama cara belajarku yang biasanya" | sebelum | sesudah |
|---|---|---|
| `toolNeed` internal_state | 0 dari 1 | 3 dari 3 |
| mencapai Agent Runtime | tidak | 3 dari 3 |
| `memory.list` terpanggil | — | 2 dari 3 |
| menyangkal punya catatan | 1 dari 3 | 0 dari 3 |

Penyangkalan palsu itu yang paling merugikan dan sudah hilang: giliran yang
tidak memanggil tool kini tidak lagi mengklaim catatannya tidak ada. Aturannya
ditambahkan ke prompt planner—menyatakan state kosong juga tebakan bila tool
pembacanya belum dipanggil.

Yang tersisa: `memory.list` masih terlewat pada sebagian run meski tool-nya
tersedia dan aturannya ada. n masih kecil; ukur dengan ulangan lebih banyak
sebelum menambah mekanisme.

## 4b. Duplikat catatan durable: diperbaiki, penyebab dalamnya tetap ada

Terekam sekali: planner memanggil `memory.remember` pada langkah 1 dan 2 untuk
fakta yang sama, tampaknya memperbaiki kata yang keliru pada tulisan pertama,
dan keduanya mendarat. Salah satunya bahkan memuat aksara Mandarin di tengah
kalimat Indonesia ("kondisi安静"), tersimpan permanen dan terlihat pengguna.

Deskripsi tool kini melarang menulis ulang fakta yang sudah disimpan pada
giliran yang sama. Pengukuran sesudahnya: 3 run, `memory.remember` terpanggil
sekali di dua di antaranya, jumlah catatan 3 → 4, tidak pernah 5.

Penyebab dalamnya tetap ada dan tidak ditambal: dedupe `MemoryService`
(`src/core/memory-service.ts:63`) hanya membandingkan `content.toLowerCase()`
persis, jadi dua kalimat berbeda satu kata tetap lolos berdua. Menormalkan
tanda baca tidak akan menolong—kedua kalimatnya memang berbeda kata. Perbaikan
yang benar memerlukan pembandingan makna, dan rute memori semantik mati karena
tidak ada model embedding.

Aksara asing yang bocor sengaja **tidak** ditambal penyaring charset: pengguna
Indonesia sah mengutip aksara lain, dan menolaknya akan membuang isi yang
benar. Ukur frekuensinya dulu.

## 4c. Probe melaporkan kandidat auto-memory, belum memprosesnya

`scripts/probe-chat.ts` kini mencetak `kandidatMemori` dan `catatanTersimpan`
di diagnostiknya. Sebelumnya kandidat dari `understand()` diabaikan diam-diam,
dan itu sempat menyesatkan: giliran yang membalas "Catat dulu biar konsisten"
tanpa perubahan jumlah catatan tampak seperti klaim menyimpan yang palsu,
padahal jalur yang menyimpannya—pipa auto-memory adapter—memang absen dari
probe.

Probe tetap **tidak** memprosesnya, dan itu disengaja. Adapter Telegram punya
derivasi metadata, gerbang consent, penolakan rahasia, dan resolusi konflik
dengan retraction (`src/bot/create-bot.ts:3164`, `:3197`, `:5749`). Meniru
separuhnya akan membuat probe menyimpan hal yang produksi tolak—salah dengan
cara yang lebih sulit dilihat daripada tidak menyimpan sama sekali.

Menirunya utuh tetap terbuka, dan wajib dikerjakan sebelum probe dipakai
menilai klaim "sudah kucatat". Adapter tetap authority; probe yang mengikuti.

## 5. Permukaan slash WhatsApp: 29 dijalankan, 11 ditampilkan

`task/cancel` kini ada di closed set dan dikenali `requestsUnhandledTaskChange`,
sehingga "batalin aja tugas biologi itu" punya pintu bahasa alami.
`/batalkan-tugas` ditandai `fallback`: masih dijalankan, tidak lagi memenuhi
layar. Itu menghapus satu-satunya perintah tersisa yang menuntut pengguna
menyalin ID task dari daftar.

Pembatalan tidak diberi route deterministik. Ia selalu "belum tertangani",
jadi satu-satunya jalur adalah Agent Runtime, tempat `task.manage` menuntut
konfirmasi kontekstual. Gerbang bentuk intent ikut diperbaiki supaya sinyal itu
dapat membukanya: sebelumnya `unhandledTaskChange` dihitung **sesudah** gerbang,
sehingga intent `task` selalu ditolak lebih dulu dan sinyal tersebut tidak
terjangkau persis pada bentuk giliran yang melahirkannya.

**Keputusan: `/checkin` tetap sebagai slash.** Ia hanya bekerja di dalam sesi
aktif, dan pada konteks itu tombol `schedule_checkin` sudah tersedia. Memberinya
pintu bahasa alami berarti menambah nilai enum operasi baru, aturan prompt,
jalur di dua adapter, dan tes—demi menghapus satu baris dari daftar 11.
Nilainya tidak sepadan.

Yang belum, dan tetap terbuka:

- Pola balasan bernomor. Ia memerlukan state per pengguna, pemetaan nomor ke
  aksi, dan kedaluwarsa — fitur tersendiri, bukan perapian permukaan.
- Padanan `uji:telegram` untuk WhatsApp. Kejadian surface WhatsApp punya bentuk
  sendiri, tetapi penyatuan bukti dan penilaiannya dapat dipakai ulang apa
  adanya.

## 6. Mutu review artefak kode: lima kasus, semua lulus

`codeCheck` menjalankan blok kode dari balasan di `node:vm` dan mengeksekusi
assertion. Lima kasus lulus 5/5, termasuk penolakan tipe salah, larangan mutasi,
dan batas panjang.

Lulus semuanya pada percobaan pertama berarti korpusnya belum cukup sulit untuk
memisahkan draft dari draft yang sudah direview. Korpus berikutnya perlu kasus
yang draft pertamanya memang sering salah — rekursi dengan kasus dasar meleset,
aritmetika tanggal melewati batas bulan, atau perbandingan float — dan idealnya
satu run pembanding dengan langkah review dimatikan.

## 7. Batas giliran 2 detik: diukur, angkanya tetap, frekuensinya lebih buruk dari dugaan

`npx tsx scripts/ukur-batas-giliran.ts --ulang=3`, 24 pengukuran pada
MiniMax-M3, tanpa timeout produksi yang mengikat:

| | ms |
|---|---|
| minimum | 1.150 |
| p50 | 1.445 |
| p90 | 9.228 |
| p99 / maksimum | 11.683 |

Nol error, nol bentuk salah: model selalu menjawab benar bila diberi waktu.
7 dari 24 (29%) melewati 2.000ms. Distribusinya bimodal dan ekornya bukan soal
kerumitan prompt — kalimat terpendek ("halo") mencatat 2.013 / 9.416 / 9.228ms
pada tiga ulangan berturut-turut. Itu variance provider.

**Di runtime nyata, angkanya jauh lebih buruk.** Sesi Telegram 29 Agustus
mencatat `turn_boundary_check_failed` pada **5 dari 7 giliran**, bukan 29%.
Pengukuran terisolasi tidak menanggung beban runtime yang sedang melayani
giliran; angka 29% itu batas bawah, bukan perkiraan.

**Keputusan: `TURN_BOUNDARY_TIMEOUT_MS` tetap 2.000ms.** Hasil assessment
menentukan `waitMs` sebelum giliran dijadwalkan, jadi timeout ini ada di jalur
kritis: menaikkannya ke p90 berarti menambah sampai 9 detik mati sebelum Harvy
mulai berpikir, demi sebuah *petunjuk* penggabungan bubble. Ekor 6–12 detik
juga tidak tertangkap timeout mana pun yang masih layak. Fallback yang ada
(`open`, confidence 0, continuationLikelihood 0,65) adalah perilaku yang benar.

Yang terbuka, dan lebih besar daripada satu konstanta: pada mayoritas giliran,
Harvy membayar satu request penuh yang hasilnya dibuang lalu tetap menunggu
2 detik. Memperbaikinya berarti berhenti memblokir penjadwalan pada petunjuk
ini—menjadwalkan dengan default lalu memperbaiki bila jawabannya keburu
datang—dan itu perubahan pada batcher, bukan pada angka. Jangan naikkan
konstantanya; datanya sudah menunjukkan itu bukan jalan keluarnya.

Catatan biaya: 5 dari 7 giliran membuang satu panggilan model tier `cheap`.
Bila jalur ini dipertahankan apa adanya, itu tagihan tetap tanpa manfaat pada
mayoritas giliran.

## 8. Ambang otorisasi kini bertingkat menurut akibat

Diagnosis lama—"usulan extractor berayun"—ternyata tidak tepat. Pengukuran
29 Agustus dengan `coba-pemahaman.ts`, tiga ulangan per frasa:

| frasa | domain/operasi | confidence |
|---|---|---|
| "gimana status pekerjaan coding yang lagi jalan?" | `coding/show` 3/3 | 0,90 · 0,95 · 0,95 |
| "gimana status coding-nya sekarang?" | `coding/show` 3/3 | 0,60 · 0,90 · 0,82 |

Domainnya tidak pernah salah. Yang berayun confidence-nya, dan ambang seragam
0,85 memotongnya di tengah: frasa pendek hanya lolos 1 dari 3, sehingga
pengguna mendapat jawaban berbeda untuk kalimat yang sama.

`naturalSurfaceAuthorized` kini memakai 0,70 untuk operasi baca (`show`,
`list`) dan tetap 0,85 untuk yang mengubah state. Ambang bertingkat sudah
menjadi pola di repositori ini—pembacaan daftar task 0,85, penyelesaiannya
0,90—dan alasannya sama: yang salah membaca kehilangan satu pembacaan, yang
salah menulis mengubah data pengguna.

Belum diukur ulang di kanal nyata sesudah perubahan ini.

## 9. Pemeriksaan live: yang masih kurang

`npm run uji:telegram` menutup celah terbesar, tetapi tiga hal belum ada:

- Jendela korelasinya berbasis waktu antara `sent` dan `turn_settled`. Itu cukup
  karena `settle` memang menutup jendela observasi runtime, tetapi ia akan
  meleset bila dua giliran pernah tumpang tindih. Kasus `interrupt` dan `burst`
  belum dipakai sama sekali.
- Tidak ada kasus keselamatan. Menambahkannya menuntut kehati-hatian: korpus
  eval sudah menutup triase, dan mengirim kalimat berisiko ke kanal nyata
  berulang kali bukan hal yang dilakukan tanpa alasan kuat.
- Belum dijalankan berulang. Sesi tunggal tidak membedakan lulus yang stabil
  dari lulus yang kebetulan; butir 8 lahir persis dari selisih antar-run.

## 10. Tiga sinyal mutu dengan frekuensi, bukan lagi anekdot

Ketiganya muncul di kolom `masalah` pada sesi yang **7/7 lulus**, jadi tidak
satu pun menggagalkan giliran. Yang berubah sejak pencatatan pertama: sekarang
ada angkanya.

- **`operation_presentation_invalid`, 2 dari 7 giliran.** Copy presentasi dari
  model tidak lolos `parseOperationPresentation`, lalu fallback deterministik
  dipakai. Pengguna tetap menerima kartu task yang benar, jadi degradasinya
  anggun. Keduanya terjadi pada giliran task (simpan dan baca), bukan tersebar
  acak — itu petunjuk pertama tentang di mana harus mencari.
- **`agent_tool_shape_repair`, 1 dari 7.** Bentuk tool call perlu diperbaiki
  sekali sebelum diterima, pada giliran recall. Mekanisme perbaikannya bekerja;
  yang belum diketahui apakah kelas ini sering pada tool tertentu.
- **Latensi.** Basa-basi 16,6 detik pada sesi ini, di bawah pagar 40 detik yang
  kini terpasang di `scripts/live-telegram-cases.ts`. Pengamatan 31 detik yang
  memicu pemasangan pagar itu belum terulang.

Langkah berikutnya untuk ketiganya sama: jalankan `npm run uji:telegram`
beberapa kali dan hitung. Tiga sampel dari satu sesi belum cukup untuk
membedakan cacat dari variance.

## 11. Observability pernah menjatuhkan giliran

`agentRunLogFields` versi pertama melakukan iterasi langsung atas
`result.trace`. Tipe hasil run memang selalu membawanya, jadi `npm run check`
lolos dan pemeriksaan Telegram langsung 6/6 hijau. Tetapi fungsi itu dipanggil
di jalur giliran pengguna, dan satu hasil `needs_input` tanpa jejak melempar
`TypeError`: checkpoint tidak tersimpan dan pengguna kehilangan pertanyaan
lanjutannya. `tests/create-bot-flow.test.ts` yang menangkapnya.

Sudah diperbaiki, dikunci tes, dan aturannya kini tercatat di bagian jebakan
`AGENTS.md`: pengumpulan bukti yang berjalan di dalam giliran wajib gagal aman
terhadap bentuk hasil yang tidak lengkap.

Dua pelajaran yang layak dicatat karena keduanya berbiaya waktu:

- Harness kanal nyata bukan pengganti suite. Ia lulus 6/6 justru ketika bug ini
  ada, karena tidak satu pun dari enam kasusnya menghasilkan `needs_input`.
  Keduanya menutup hal yang berbeda: suite menjaga kontrak kode, harness
  menjaga jalur yang benar-benar dilalui percakapan.
- Gejalanya sempat terbaca sebagai "suite macet" padahal itu 176 detik dengan
  kegagalan. Yang benar-benar macet adalah proses tes lama dari perintah
  sebelumnya yang tidak dibersihkan. Periksa CPU proses sebelum menyimpulkan
  hang, dan pastikan tidak ada run tes lain yang masih hidup.

## Kemampuan yang absen secara rancangan

Bukan pekerjaan tertunda; dicatat supaya tidak diusulkan ulang sebagai
perbaikan kecil. Harvy tidak dapat mencari apa pun di luar datanya sendiri.
`history.search` membaca riwayat pengguna, bukan web. Menambah pencarian web
berarti membuka trust domain jaringan baru (konektor, kredensial, kebijakan
egress, penanganan konten tidak tepercaya sebagai data), jadi ia proyek
tersendiri dan bukan perluasan `memory-executors.ts`.

Memulai CodingRun, `/github`, dan `/publish` sengaja tidak punya pintu bahasa
alami. Yang pertama tidak dapat dibedakan dari permintaan bantuan biasa lewat
label saja; dua sisanya memegang credential dan mengirim ke luar.
