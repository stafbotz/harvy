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

Yang tertutup pada putaran ini: gerbang intent `history` terbukti end-to-end di
Telegram nyata (`agent: tools, capability history.search`); pintu bahasa alami
`coding/show` terbukti menyala; run agent yang berhasil kini meninggalkan jejak
`agent_run_completed`; batas giliran sudah diukur dan diputuskan.

## 1. Ketepatan isi `history.search` belum stabil

Tool-nya terbukti dipanggil di probe maupun kanal nyata; yang belum terbukti
adalah isinya benar. Dari lima run probe dengan pertanyaan sama: dua menyebut
klaim `unresolved` yang tepat, dua menjawab jujur bahwa hasilnya tidak
memuatnya, satu menjahit klaim dari dua episode berbeda menjadi satu ingatan
yang tidak pernah terjadi.

Sebabnya struktural. `searchConversationEpisodes` memberi peringkat leksikal
atas teks klaim, jadi query yang hanya memuat topik mengembalikan topik, fakta,
dan penanda waktu — sementara klaim `unresolved` yang justru ditanyakan berada
di luar empat klaim teratas. Query yang memuat kata pengguna sendiri
("belum jelas") mengambilnya.

Dua peringatan sudah ditambahkan ke deskripsi tool. **Efeknya belum diukur
ulang.** Ukur dulu sebelum menambah mekanisme; bila belum cukup, langkah
berikutnya memberi bobot pada field yang cocok dengan bentuk pertanyaan, bukan
menambah pass model kedua.

## 2. Capability tanpa schema mematikan seluruh run, dan gejalanya menyamar

`agentNativeTools` melempar begitu satu capability callable tidak punya
`nativeTool`, lemparan itu terjadi di dalam planner, dan `abortReason`
menamainya `invalid_planner_output`. Akibatnya setiap giliran agent di proses
itu berhenti pada langkah pertama — selamanya, karena penyebabnya tidak berlalu
sendiri.

Seluruh executor di `src/agent/` membawa schema, jadi ini bukan cacat produksi
hari ini. Yang belum ada adalah pagar yang membuatnya tidak bisa terulang.
Pemeriksaan di `executorMap` akan menangkapnya sebelum panggilan model mana pun,
tetapi ia menolak juga executor fixture yang sah: puluhan tes memakai executor
tanpa schema bersama planner stub. Pagar yang benar harus memakai irisan
installed dan executor, bukan daftar executor saja.

## 3. Anggaran run `orchestrate` foreground terlalu ketat untuk delegasi paralel

`scripts/coba-agent.ts` kasus "root orchestrate": `agent.delegate.parallel`
selesai `ok`, lalu run berhenti `deadline` pada langkah berikutnya di 2 dari 3
run. Batasnya `deadlineMs: 45_000` dan itu memang batas produksi.

Bukan otomatis cacat: produksi mengarahkan pekerjaan orchestrate berat ke
AgentRun latar lewat `requiresAgentPlanning`, sedangkan probe memanggil
`conversation.agent()` langsung. Yang perlu diperiksa adalah apakah ada
permintaan nyata yang lolos ke jalur foreground tetapi membutuhkan delegasi
paralel; bila ada, yang salah gerbangnya, bukan anggarannya.

## 4. `memory.list` dan `memory.remember` belum pernah terpanggil

Sesi Telegram nyata menjawab sebagian pertanyaannya: "apa aja yang kamu inget
tentang aku?" dijawab dalam 4,6 detik oleh kartu memori deterministik dengan
`intent: memory`, `route: memory-control`, `agent: tidak dipakai`.
`immediateUnderstandingRoute` menangkapnya sebagai kontrol memori sebelum
gerbang agent dinilai.

Perilakunya benar dan murah, jadi bukan regresi. Tetapi ia membatalkan asumsi
lama: membuka intent `memory` pada gerbang agent tidak dengan sendirinya membuat
`memory.list` terpakai, karena frasa paling alami untuk memori sudah punya jalur
deterministik yang lebih cepat.

Untuk benar-benar mengukur keduanya, cari frasa yang **tidak** lolos
`memoryControlAuthorized` tetapi tetap membutuhkan isi catatan — kemungkinan
besar di tengah pekerjaan multi-langkah, bukan sebagai pertanyaan pembuka.
Catatan: `memory.remember` memakai `confirmation: "contextual"`, jadi hasil yang
diharapkan mungkin `needs_approval`, bukan `completed`.

## 5. Permukaan slash WhatsApp: yang belum dikerjakan

Pemangkasan 29 menjadi 12 bersifat presentasi. Yang belum:

- `batalkan-tugas` dan `checkin` tetap ditampilkan **karena tidak punya pintu
  bahasa alami**, bukan karena keduanya layak jadi slash. `DOMAIN_OPERATIONS`
  tidak punya `task/cancel` maupun operasi penjadwalan check-in. Menambahkan
  keduanya akan menurunkan permukaan menjadi 10 sekaligus menghapus satu-satunya
  jalur yang menuntut ID task disalin manual.
- Pola balasan bernomor yang pernah diusulkan tidak dikerjakan. Ia memerlukan
  state per pengguna, pemetaan nomor ke aksi, dan kedaluwarsa — fitur
  tersendiri, bukan perapian permukaan.
- Belum ada padanan `uji:telegram` untuk WhatsApp. Kejadian surface WhatsApp
  punya bentuk sendiri, tetapi penyatuan bukti dan penilaiannya dapat dipakai
  ulang apa adanya.

## 6. Mutu review artefak kode: lima kasus, semua lulus

`codeCheck` menjalankan blok kode dari balasan di `node:vm` dan mengeksekusi
assertion. Lima kasus lulus 5/5, termasuk penolakan tipe salah, larangan mutasi,
dan batas panjang.

Lulus semuanya pada percobaan pertama berarti korpusnya belum cukup sulit untuk
memisahkan draft dari draft yang sudah direview. Korpus berikutnya perlu kasus
yang draft pertamanya memang sering salah — rekursi dengan kasus dasar meleset,
aritmetika tanggal melewati batas bulan, atau perbandingan float — dan idealnya
satu run pembanding dengan langkah review dimatikan.

## 7. Batas giliran 2 detik: sudah diukur, angkanya tetap

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

**Keputusan: `TURN_BOUNDARY_TIMEOUT_MS` tetap 2.000ms.** Hasil assessment
menentukan `waitMs` sebelum giliran dijadwalkan, jadi timeout ini ada di jalur
kritis: menaikkannya ke p90 berarti menambah sampai 9 detik mati sebelum Harvy
mulai berpikir, demi sebuah *petunjuk* penggabungan bubble. Ekor 6–12 detik juga
tidak dapat ditangkap timeout mana pun yang masih layak. Fallback yang ada
(`open`, confidence 0, continuationLikelihood 0,65) adalah perilaku yang benar.

Yang masih terbuka, dan lebih besar daripada satu konstanta: 29% giliran
ambigu membayar satu request penuh yang hasilnya dibuang, lalu tetap menunggu
2 detik. Memperbaikinya berarti berhenti memblokir penjadwalan pada petunjuk
ini—menjadwalkan dengan default lalu memperbaiki bila jawabannya keburu
datang—dan itu perubahan pada batcher, bukan pada angka. Jangan naikkan
konstantanya; datanya sudah menunjukkan itu bukan jalan keluarnya.

## 8. Usulan extractor untuk frasa status coding belum stabil

Pintu bahasa alaminya bekerja: satu run mencatat `semantic_route_selected`
dengan `semanticDomain: "coding"`, `semanticOperation: "show"`, confidence
`high`, dan Harvy menjawab lewat jalur itu. Run berikutnya pada kalimat yang
sama tidak mengusulkan operasi apa pun, masuk Agent Runtime, dan memanggil
`task.list_active`.

Kalimat yang lebih pendek lebih buruk lagi: "gimana status coding-nya sekarang?"
terukur `data`/`show-controls` pada confidence rendah — extractor menyamakan
kata "status" dengan pusat kontrol data.

Langkah berikutnya menjalankan `scripts/coba-pemahaman.ts` pada beberapa frasa
status coding dengan pengulangan, seperti yang dilakukan untuk
`no-physical-claim`, lalu memperbaiki **aturan prompt**-nya. Jangan menurunkan
ambang 0,85: ambang itu yang menjaga mutasi tidak dipicu label lemah, dan
masalahnya di sini bukan ambang melainkan usulan yang berayun.

Kasus `status-coding` di `scripts/live-telegram-cases.ts` sengaja hanya mengunci
bagian yang tidak boleh berayun—jawaban tidak mengarang pekerjaan coding yang
sedang berjalan—supaya harness tidak menjadi merah permanen dan berhenti dibaca.

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

## 10. Dua sinyal mutu yang baru terlihat lewat harness

Keduanya muncul di kolom `masalah` sesi 6/6 lulus, jadi tidak satu pun
menggagalkan giliran. Dicatat karena baru terlihat setelah log runtime ikut
dibaca, bukan karena sudah dinilai penting.

- `operation_presentation_invalid` pada giliran simpan task: copy presentasi
  dari model tidak lolos `parseOperationPresentation`, lalu fallback
  deterministik dipakai. Pengguna tetap menerima kartu task yang benar, jadi
  degradasinya anggun. Yang belum diketahui frekuensinya: satu kejadian dalam
  satu sesi bukan angka. Hitung dulu lewat beberapa run `npm run uji:telegram`
  sebelum menyentuh prompt presentasinya.
- Latensi basa-basi 31 detik untuk "makasih ya, kamu ngebantu banget". Sebagian
  memang anggaran desain—jendela batch sekitar 7 detik plus 2 detik batas
  giliran yang habis waktu—tetapi sisanya belum dijelaskan. `maxLatencyMs`
  sudah tersedia di kontrak kasus dan belum dipakai; memasangnya pada kasus
  basa-basi akan mengubah ini dari pengamatan menjadi pagar.

## 11. Observability pernah menjatuhkan giliran; pagarnya baru satu

`agentRunLogFields` versi pertama melakukan iterasi langsung atas
`result.trace`. Tipe hasil run memang selalu membawanya, jadi `npm run check`
lolos dan pemeriksaan Telegram langsung 6/6 hijau. Tetapi fungsi itu dipanggil
di jalur giliran pengguna, dan satu hasil `needs_input` tanpa jejak melempar
`TypeError`: checkpoint tidak tersimpan dan pengguna kehilangan pertanyaan
lanjutannya. `tests/create-bot-flow.test.ts` yang menangkapnya.

Sudah diperbaiki dan dikunci tes. Yang belum: tidak ada aturan yang mencegah
pemanggil log berikutnya mengulang bentuk kesalahan yang sama. Setiap
pengumpulan bukti yang berjalan di dalam giliran—bukan sesudahnya—wajib gagal
aman terhadap bentuk hasil yang tidak lengkap.

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
