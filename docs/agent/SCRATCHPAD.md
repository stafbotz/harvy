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
- `npx tsx scripts/ukur-pemahaman.ts` — klasifikasi `understand()` pada kalimat
  berulang, termasuk pesan multi-baris. Kalimat ujinya tertanam di kode karena
  argumen shell pernah memotongnya diam-diam dan melahirkan kesimpulan keliru.

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

## 1. Ketepatan isi `history.search`: dari 1 dari 3 menjadi 5 dari 5

Tertutup, dan yang menutupnya bukan perbaikan peringkat melainkan satu
instrumentasi. Dua percobaan pertama—peringatan pada deskripsi tool, lalu
menyamakan cap klaim 4 → 6—tidak menghasilkan perubahan terukur. Yang mengubah
segalanya adalah mencatat query yang **benar-benar** dikirim planner:

```
history.search query: "ujian biologi persiapan"   (4 dari 5)
```

Kata isyarat pengguna dibuang. Pembobotan field yang dibangun untuk menaikkan
klaim `unresolved` tidak pernah punya kesempatan menyala, dan deskripsi tool
yang memintanya tidak dipatuhi—kelas yang sama dengan butir 1b.

Perbaikannya berhenti memakai prosa dan memberi **slot di schema**: parameter
`aspect` untuk jenis hal yang dicari, terpisah dari topik. Hasilnya:

| | sebelum | sesudah |
|---|---|---|
| klaim tepat disebut | 1/3, lalu 2/5 | **5/5** |
| `aspect` diisi planner | — | 5/5 |
| query memuat kata isyarat | 1/5 | 4/5 |

Efeknya melampaui dugaan: menamai konsepnya di schema mengubah perilaku pada
**kedua** field, bukan hanya slot barunya.

Nuansa yang perlu diingat penulis berikutnya: pengaruh langsung `aspect` pada
skor sederhana saja. Bonusnya 2,5 dan sengaja tidak cukup mengalahkan kecocokan
frasa persis yang bernilai 3. Nilai terbesarnya adalah mengubah apa yang
dikirim planner, bukan menata ulang hasil. Tes penguncinya memakai query yang
tidak muncul utuh di klaim mana pun, karena fixture yang memberi bonus frasa
kepada klaim pesaing akan menutup pengaruh aspek seluruhnya.

## 1b. Kosakata internal: sumbernya dihapus, bukan larangannya dipertegas

Aturannya sudah ada dan terbukti terkirim: `AGENT_PLANNER_SHARED` memuat
"jangan menyebut episode, klaim, record, field, query, hasil pencarian, atau
nama tool di jawabanmu", hadir di kedua kontrak planner, baris 15 dari 23 pada
kontrak auto. Jadi ini tidak pernah soal pengiriman.

Ia tetap dilanggar 2 dari 5 karena kata terlarangnya justru ada di bahan yang
dibaca model, dan sebagian besar **buatan sendiri**:

- Deskripsi `history.search` menyebut "episode" dua kali dan "episodeId" sekali.
  Kalimat itu ditulis untuk memperbaiki penggabungan lintas-percakapan, dan
  tanpa disadari memberi model contoh kata yang dilarang dipakainya.
- Setiap hasil pencarian membawa field `episodeId`, dan nilainya sendiri
  berawalan `episode_` karena begitulah `episodic-compaction` menamainya.

Melarang sebuah kata sambil menyodorkannya pada setiap hasil adalah aturan yang
tidak dapat dipatuhi. Perbaikannya menghapus sumbernya: deskripsi ditulis ulang
tanpa kosakata internal, dan `episodeId` diganti `sumber` berisi nomor urut
dalam satu hasil pencarian. Model hanya perlu membedakan sumber, bukan
mengidentifikasinya secara global.

| | sebelum | sesudah |
|---|---|---|
| jawaban memuat kosakata internal | 2 dari 5 | **0 dari 5** |
| klaim yang tepat disebut | 5 dari 5 | 5 dari 5 |

Satu tes mengunci bentuk hasilnya: ringkasan `history.search` tidak boleh
memuat kata "episode" sama sekali.

Pelajaran yang berlaku lebih luas daripada butir ini: bila sebuah aturan prompt
tidak dipatuhi, periksa dulu apakah yang dilarang justru muncul di tempat model
membacanya. Mempertegas larangan tidak akan menolong selama contohnya masih
disodorkan.

## 1c. Bahasa balasan kini berpagar, frekuensinya masih diukur

`HARVY_IDENTITY` sudah menuntut Harvy mengikuti bahasa pengguna "dan pakai
hanya kata serta aksara dari bahasa itu". Aturannya dilanggar dua kali secara
teramati: satu balasan jadwal belajar dibuka dalam bahasa Inggris untuk pesan
berbahasa Indonesia, dan satu catatan durable tersimpan dengan aksara Mandarin
di tengah kalimat Indonesia.

Ini pola yang sama dengan butir 1b—aturannya ada, pagarnya tidak—tetapi
sumbernya berbeda. Pada 1b kata terlarang muncul di bahan yang dibaca model,
jadi menghapus sumbernya yang benar. Di sini tidak ada sumber untuk dihapus,
jadi pagar memang jawabannya.

`scripts/uji-telegram-langsung.ts` kini memeriksa setiap balasan pada **semua**
kasus, bukan hanya yang menyatakannya. Dua bentuk: aksara di luar Latin, dan
perpindahan ke bahasa Inggris yang menuntut dua penanda berbeda supaya satu
kata pinjaman seperti "deadline" tidak memicu alarm.

Polanya diuji dua arah sebelum dipasang, memakai balasan nyata yang sudah
tersimpan:

| | hasil |
|---|---|
| balasan Inggris yang teramati | menyala, 3 penanda |
| catatan beraksara Mandarin | menyala |
| bahasa Indonesia wajar | diam |
| Indonesia dengan kata pinjaman Inggris | diam |
| 42 baris keluaran harness nyata | nol positif palsu |

Tiga sesi selesai. Dua di antaranya menghasilkan 9 dari 9 lulus dengan **nol
pelanggaran register** pada 18 giliran yang benar-benar berjalan.

Sesi ketiga tidak terhitung: onboarding gagal, tombol persetujuan tidak pernah
tertekan, dan kesembilan kasusnya berjalan dengan pesan yang ditahan runtime.
Harness mendeteksinya dan mengatakannya terang-terangan, tetapi baru sesudah
membakar sembilan giliran model yang tidak mengukur apa pun. Kini kandidat
alias tombolnya diperluas menjadi lima dan penerimaan izin diperiksa di akhir
fase pertama; sesi berhenti dengan kode 2 bila izin belum diterima, sebelum
satu kasus pun dijalankan.

Nol pelanggaran dari 18 giliran belum membuktikan pagarnya menangkap sesuatu—
ia membuktikan pelanggarannya jarang. Kedua pelanggaran yang memicu pagar ini
teramati pada giliran yang lewat Agent Runtime dengan pekerjaan panjang, dan
korpus sembilan kasus hanya punya sedikit bentuk itu.

Yang belum dijaga: perpindahan "aku" ke "Saya". Sengaja tidak dijadikan pagar
karena `HARVY_IDENTITY` menyatakan Harvy punya dua register yang keduanya
suaranya sendiri, jadi kata ganti yang lebih formal belum tentu pelanggaran.
Membedakannya menuntut aturan kata ganti yang eksplisit lebih dulu, dan itu
keputusan persona—bukan pagar.

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

## 3. Anggaran orchestrate foreground: gerbangnya benar, anggarannya cukup

Pertanyaannya—apakah ada permintaan nyata yang lolos ke jalur foreground tetapi
membutuhkan delegasi paralel—kini terjawab dengan pengukuran, bukan pembacaan
kode saja.

**Jalur foregroundnya memang terjangkau.** Kombinasinya sempit tetapi nyata:
`globalRoute` orchestrate, Agent Runtime aktif, dan `requiresAgentPlanning`
false sehingga lane latar tidak dipilih. Contoh yang menghasilkannya:

> "menurutmu beban dua minggu ke depan masih masuk akal buat aku atau enggak?
> pertimbangkan semua yang sudah tercatat, timbang risikonya, dan jelaskan
> alasanmu sedetail mungkin"

Sebabnya struktural: `requiresPlannedExecution` menuntut `toolNeed` bernilai
`execution` atau `external`, sementara pencarian web sudah dicabut dan satu-
satunya capability `execution` di lane privat adalah terminal virtual. Giliran
"deep" yang membutuhkan state pengguna karena itu hampir selalu berujung
`toolNeed: internal_state`, yang tidak pernah memenuhi syarat lane latar.

**Tetapi delegasi paralel tidak pernah dipilih di sana.** Tujuh frasa realistis
diuji—perbandingan mendalam, keputusan bertaruh tinggi, penyusunan prioritas
beralasan, rencana dua pekan, penelusuran tiga sudut sekaligus—dan tidak satu
pun memanggil `agent.delegate.parallel`. Lima run pada frasa yang paling berat
menghasilkan 4 selesai dan 1 berhenti `invalid_planner_output`.

Kasus `coba-agent.ts` yang menabrak deadline **memerintahkan** delegasi secara
eksplisit ("tiga subpekerjaan independen"). Itu bentuk yang dibuat untuk
menguji capability-nya, bukan bentuk yang datang dari pengguna.

**Kesimpulan: jangan ubah `deadlineMs`.** Yang menabrak batas adalah kasus
sintetis yang meminta delegasi, sedangkan permintaan berbentuk manusia tidak
memilih delegasi sama sekali pada jalur ini. Menaikkan anggaran akan membayar
biaya nyata—jeda lebih panjang pada setiap giliran berat—untuk kasus yang belum
pernah teramati di luar probe.

Dua hal yang tersisa, keduanya lebih menarik daripada anggaran:

- `invalid_planner_output` muncul 1 dari 5 pada jalur orchestrate foreground.
  Bukan pola pada n sekecil ini, tetapi jalur ini menjalankan 15–19 kejadian
  jejak per giliran, jadi permukaan kegagalannya lebih luas daripada jalur
  `tools`. Layak dihitung bila kelas ini muncul lagi.
- `agent.delegate.parallel` tidak pernah dipilih pada permintaan berbentuk
  manusia. Ia terpasang di lane privat, ikut menempati schema tool pada setiap
  giliran orchestrate, dan manfaatnya belum pernah teramati di luar kasus yang
  memerintahkannya. Pertanyaannya bukan lagi anggaran melainkan apakah ia layak
  ditawarkan di lane ini.

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

## 4b. Duplikat catatan durable: diperbaiki di hulu, hilirnya sengaja dibiarkan

Terekam sekali: planner memanggil `memory.remember` pada langkah 1 dan 2 untuk
fakta yang sama, tampaknya memperbaiki kata yang keliru pada tulisan pertama,
dan keduanya mendarat. Salah satunya memuat aksara Mandarin di tengah kalimat
Indonesia ("kondisi安静"), tersimpan permanen dan terlihat pengguna.

Deskripsi tool kini melarang menulis ulang fakta yang sudah disimpan pada
giliran yang sama. Pengukuran sesudahnya: 3 run, `memory.remember` terpanggil
sekali di dua di antaranya, jumlah catatan 3 → 4, tidak pernah 5.

**Dedupe `MemoryService` sengaja tidak diubah**, dan alasannya lebih kuat
daripada "butuh embedding". Pembanding berbasis tumpang tindih token akan
menangkap pasangan yang teramati—kemiripannya sekitar 0,85—tetapi negasi
mematahkannya:

> "Boleh dihubungi lewat telepon sebelum jam lima sore"
> "**Tidak** boleh dihubungi lewat telepon sebelum jam lima sore"

Kemiripannya sekitar 0,91, sementara maknanya berlawanan. Penjaga seperti itu
akan menolak koreksi justru karena ia mirip dengan hal yang dikoreksi, dan
koreksi memori adalah kelas yang memang ditangani sistem ini lewat
`memoryRetractions`. Menukar duplikat yang terlihat dengan koreksi yang hilang
diam-diam adalah pertukaran yang buruk.

Bila kelas ini muncul lagi, kerjakan di tingkat run, bukan penyimpanan: tulisan
kedua dalam satu run yang sangat mirip hampir pasti penulisan ulang, bukan
koreksi keyakinan lama. Itu memerlukan state ber-scope run pada executor.

Aksara asing yang bocor juga tidak ditambal penyaring charset: pengguna
Indonesia sah mengutip aksara lain, dan menolaknya membuang isi yang benar.
Belum terulang sejak deskripsi tool diperbaiki; ukur frekuensinya sebelum
menambah pagar.

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

## 6. Langkah review artefak kode: terbukti berbayar hasil

Korpus dinaikkan dari 5 menjadi 9 kasus, empat tambahannya dipilih karena draft
pertamanya memang sering salah: rekursi dengan kasus dasar dan batas waktu,
aritmetika tanggal melewati batas bulan dan tahun, perbandingan float, dan
pembagian rupiah yang jumlahnya harus persis kembali ke total.

Kesembilannya lulus dengan review menyala, jadi korpus saja tetap tidak dapat
menjawab apakah langkah review berguna. Jawabannya datang dari menjalankan
korpus yang sama tanpa review, lewat `HARVY_DISABLE_CODE_ARTIFACT_REVIEW=1`
yang sengaja hanya dapat dinyalakan dari variabel lingkungan:

| | lulus |
|---|---|
| review menyala, dua ulangan | **18 dari 18** |
| review dimatikan, dua ulangan | 15 dari 18 |

Kegagalan tanpa review:

- `code-request` gagal **dua kali dengan error yang sama persis**:
  `SyntaxError: Identifier 'jumlahkanArray' has already been declared`. Model
  mengeluarkan dua blok kode yang keduanya mendeklarasikan fungsi yang sama.
  Reproduksi, bukan varians.
- `code-reject-wrong-type` melempar `TypeError` dari fungsinya sendiri pada
  masukan yang sah.

Satu kejujuran soal alat ukurnya: pemeriksa menggabungkan **seluruh** blok kode
dalam balasan sebelum menjalankannya, jadi dua blok yang sama-sama
mendeklarasikan fungsi itu fatal baginya. Bagi pembaca manusia, blok kedua
mungkin sekadar contoh pemakaian. Kegagalan kedua—fungsi melempar pada masukan
sah—tidak punya keringanan seperti itu.

Kesimpulan yang ditopang datanya: langkah review menghapus cacat yang benar-
benar ada pada draft, dan satu panggilan model tambahan per giliran kode
terbayar. Yang belum: apakah manfaatnya bertahan pada korpus yang jauh lebih
besar, dan berapa biayanya dalam token.

Untuk menjalankan pembandingnya lagi:

```bash
CASES=code-request,code-empty-input,code-reject-wrong-type,code-no-mutation,code-boundary,code-rekursi-basis,code-tanggal-lintas-bulan,code-float,code-bagi-rupiah
npm run eval:conversation -- --case=$CASES
HARVY_DISABLE_CODE_ARTIFACT_REVIEW=1 npm run eval:conversation -- --case=$CASES
```

Catatan alat: error dari `node:vm` dibuat pada realm berbeda, sehingga
`error instanceof Error` selalu false. Sebelum diperbaiki, setiap kegagalan
sandbox dilaporkan sebagai "unknown" dan perbandingan ini tidak dapat dibaca
sama sekali—model yang menulis kode rusak dan sandbox yang tidak bisa
menjalankan kode sah terlihat persis sama.

## 7. Batas giliran: biayanya bukan 2 detik, melainkan 7

Catatan sebelumnya di butir ini keliru dan sudah dikoreksi di sini. Ia menyebut
"mayoritas giliran membayar satu request penuh yang hasilnya dibuang lalu tetap
menunggu 2 detik", dan menyarankan berhenti memblokir penjadwalan. Pembacaan
kode menunjukkan saran itu bukan perbaikan: `scheduleDeadline` menghitung
`remaining = idleMs - (Date.now() - lastReceivedAt)`, jadi tenggat ditambatkan
ke pesan terakhir pengguna, bukan ke saat penjadwalan. Dua detik menunggu
classifier terserap ke dalam jendela.

Yang sebenarnya terjadi lebih mahal. Jendela tunggu ditentukan keluaran
classifier:

| keluaran | jendela |
|---|---|
| `complete` | 0 — Harvy langsung mulai |
| `urgent` | 0 |
| `open` | 7.000 ms |
| `incomplete` | 12.000 ms |

Ketika panggilan model gagal, `assessment` tetap pada nilai awal yang disiapkan
sebelum `try`: `open`, confidence 0, continuationLikelihood 0,65. Artinya
**setiap kegagalan classifier menjadi tunggu 7 detik**, sedangkan keberhasilan
yang menyimpulkan `complete` menjadi 0.

Bukti empirisnya sudah ada di log sesi: giliran dengan
`turn_boundary_check_failed` mencatat `batchWaitMs` 7005, 7009, dan 7010,
sementara giliran tanpa kegagalan mencatat `batchWaitMs: 0`.

Frekuensinya, dari tujuh sesi tersimpan: 4, 5, 2, 5, 2, 3, dan 0 giliran per
sesi. Pada korpus 28 giliran sebelumnya, 16 di antaranya gagal—dan 16 giliran
itu menunggu sekitar tujuh detik sebelum Harvy mulai bekerja, bukan karena
pengguna masih mengetik melainkan karena classifier-nya tidak menjawab tepat
waktu.

**Pengukuran ulang latensi tetap menyimpulkan angka 2.000ms jangan dinaikkan.**
p90 classifier 9.228 ms, lebih besar daripada jendela `open` 7.000 ms itu
sendiri; menunggu jawabannya justru dapat melampaui jendela yang hendak
ditentukannya.

Tiga arah masuk akal. **Yang kedua sudah dikerjakan**; dua sisanya tetap
keputusan produk karena mengubah kapan Harvy memotong pengguna.

- **Perpendek fallback kegagalan.** Kegagalan bukan bukti pengguna masih
  mengetik; `open` penuh 7 detik memperlakukannya seolah begitu. Jendela yang
  lebih pendek khusus untuk kegagalan mengurangi jeda tanpa mengklaim
  kelengkapan. Risikonya memotong orang yang memang masih menulis. Belum
  dikerjakan.
- **Panggil lebih jarang.** Dikerjakan 30 Agustus, lihat di bawah.
- **Terima apa adanya.** Tujuh detik jeda pada sebagian giliran adalah harga
  untuk tidak memotong orang yang sedang mengetik, dan itu pertukaran yang sah.

Yang jelas salah adalah menaikkan timeout, dan yang jelas tidak menolong adalah
memindahkan penjadwalan lebih awal.

### Lever kedua: heuristik lokal kini membaca semburan

`assessTurnBoundaryLocally` menyerah pada **setiap** pesan multi-bubble
(`if (rawBubbles.length !== 1) return null;`). Karena classifier model hanya
dipanggil ketika fungsi ini mengembalikan null (`message-batcher.ts:524`),
setiap semburan otomatis membayar satu panggilan model—pada bentuk pesan yang
paling wajar diketik pelajar.

Kini ia menilai bubble **terakhir**. Keyakinannya sengaja diturunkan ke 0,7
dengan continuation 0,5 untuk multi-bubble, supaya `assessmentIdleWindowMs`
memberi bantalan `MULTI_BUBBLE_IDLE_MS` 4 detik alih-alih memotong di nol
detik—penjaga terpenting di `tests/turn-taking-policy.test.ts`.

Cakupan, diukur atas dua belas bentuk semburan: **7 selesai di kode, 5 tetap ke
model**, dari sebelumnya 0 dari 12. Karena panggilan model bergantung langsung
pada nilai balik fungsi ini, tujuh itu adalah panggilan yang benar-benar hilang.

**Pengurangan di kanal nyata: nol, tidak terukur.** Dua sesi sesudah perubahan
memberi 20 giliran dengan 6 kegagalan batas (30%); baseline 18 giliran dengan 5
kegagalan (28%). Sama saja, dan sebabnya struktural, bukan kebetulan:

- **8 dari 9 kasus di `live-telegram-cases.ts` hanya satu bubble.** Korpusnya
  tidak dapat melihat perbaikan multi-bubble.
- Satu-satunya kasus multi-bubble, `burst-satu-pikiran`, berakhir dengan bubble
  "yang biologi sama yang sejarah, aku harus gimana ya"—persis salah satu dari
  lima bentuk yang masih diserahkan ke model. Kedua sesi mencatatnya
  `3 bubble, batas open`, tidak berubah.
- Keempat giliran yang berakhir `open` semuanya pesan satu bubble yang ambigu,
  yang memang bukan sasaran perubahan ini.

Jadi cakupan 7 dari 12 berdiri sebagai sifat fungsinya, sementara klaim
perbaikan latensi di kanal nyata **tidak punya bukti**. Untuk mendapatkannya,
korpus harness perlu beberapa kasus semburan lagi yang bubble akhirnya memang
dapat diputuskan—dan sebaiknya bentuknya diambil dari lalu lintas nyata, bukan
dikarang seperti dua belas bentuk di atas.

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

## 9. Turn-taking kini terperiksa; korelasi tumpang tindih tetap batasnya

Dua bentuk giliran baru masuk harness, dan keduanya menguji subsistem yang
paling sulit dinilai dari transkrip.

**`burst-satu-pikiran`** mengirim tiga bubble berjeda 900 ms. Hasilnya
`3 bubble, batas complete`—ketiganya digabung menjadi satu giliran—dan
balasannya menyentuh isi bubble terakhir, bukan sekadar menanggapi "eh btw".
Penggabungan bubble terbukti bekerja di kanal nyata untuk pertama kalinya.

**`interupsi-mengalihkan`** mengirim pengalihan tegas di tengah pekerjaan
panjang. Perilakunya benar: Harvy menjawab pertanyaan baru, bukan meneruskan
rencana dua minggu. Satu run bahkan merekam `interupsi redirect`.

Keempat field bukti turn-taking sebelumnya dibuang allowlist logger
(`fieldsOmitted: 4` pada `conversation_turn_completed`), sehingga penggabungan
bubble dan klasifikasi interupsi tidak dapat diperiksa dari luar sama sekali.
`boundaryState`, `boundaryConfidence`, `adaptiveTimingUsed`, dan
`interruptionRelation` kini lolos; semuanya bebas isi.

**Batas yang tidak bisa dihilangkan dengan menyetel angka.** Harness ini
mencocokkan bukti runtime lewat jendela waktu antara `sent` dan `turn_settled`,
dan interupsi adalah satu-satunya bentuk yang membuat dua giliran tumpang
tindih. Akibatnya catatan runtime tidak dapat diatribusikan dengan yakin:
`interruptionRelation` muncul pada sebagian run dan `null` pada sebagian lain
untuk perilaku yang sama. Ia karena itu dicetak sebagai bahan baca, bukan
dijadikan pagar; yang dijaga kasus ini adalah perilaku yang terlihat pengguna.

Memperbaikinya menuntut atribusi berbasis urutan, bukan waktu—memasangkan
catatan `conversation_turn_completed` ke giliran kasus menurut urutan
kemunculan. Itu pekerjaan tersendiri dan baru sepadan bila kelas interupsi
perlu dijamin, bukan sekadar diamati.

**Waktu interupsi adalah bagian dari kasusnya, bukan detail.** Pada 3 detik,
pesan kedua masih berada di dalam jendela penggabungan sekitar 7 detik sehingga
batcher memperlakukannya sebagai bubble kedua dari satu pikiran—`2 bubble,
batas open, interupsi null`. Perilaku Harvy di sana benar; kasusnya yang menguji
sesuatu yang tidak pernah ia siapkan. Angkanya kini 14 detik.

Verifikasi perbaikan onboarding, sesi baru: **8 dari 9 lulus**, izin diterima
pada fase pertama dan kasus berjalan normal. Jalur suksesnya terbukti; jalur
gagalnya belum, karena onboarding memang tidak gagal pada sesi itu.

`burst-satu-pikiran` gagal sekali dari tiga, dan kegagalannya menyambung ke
butir 7. Ketiga bubble digabung dengan benar—`3 bubble`—tetapi giliran itu
mencatat **dua** `turn_boundary_check_failed` sehingga jatuh ke fallback `open`,
dan isinya lalu dibaca sebagai `intent: feeling` lalu dijawab tanpa menyentuh
dua mata pelajaran yang disebut pengguna.

Penggabungan bubble bukan penyebabnya; ia bekerja. Yang gagal adalah membaca
maksud teks gabungan yang diakhiri pertanyaan ("aku harus gimana ya"). Diukur
terpisah di butir 13: kelas ini memang tidak pernah dibaca question maupun
request, dan `toolNeed`-nya selalu none.

Yang masih kurang:

- Tidak ada kasus keselamatan. Menambahkannya menuntut kehati-hatian: korpus
  eval sudah menutup triase, dan mengirim kalimat berisiko ke kanal nyata
  berulang kali bukan hal yang dilakukan tanpa alasan kuat.
- Sembilan kasus menghasilkan 30 perintah dari batas 32. Kasus berikutnya tidak
  akan muat; pemecahan per sesi sudah dijaga `MAX_TESTER_COMMANDS` dan akan
  gagal dengan pesan yang menyebut berapa kasus yang muat.

## 10. Frekuensi tiga sinyal mutu, dari 28 giliran

Empat sesi `npm run uji:telegram` berturut-turut, 28 giliran kasus:

| sinyal | frekuensi |
|---|---|
| `turn_boundary_check_failed` | 16 dari 28 (57%) |
| `operation_presentation_invalid` | 3 dari 28 (11%) |
| `agent_tool_shape_repair` | 2 dari 28 (7%) |

Kelulusan 25 dari 28. Kegagalannya bukan acak:

- `batalkan-task-alami` gagal 2 dari 4 sesi, selalu dengan tanda tangan yang
  sama: routing benar (`task/cancel` high, agent memanggil `task.list_active`)
  tetapi balasannya tidak menyebut tugas yang akan dihapus. Lihat butir 12.
- `memori-deterministik` gagal 1 dari 4: extractor tidak menghasilkan operasi
  semantik sama sekali (`none/none`), sehingga route deterministik tidak dapat
  mengambilnya dan giliran jatuh ke Agent Runtime—yang lalu tidak memanggil
  capability apa pun selama 16 detik. Ini biaya nyata dari membuka intent
  `memory` ke Agent Runtime: ketika extractor gagal, jalur mahal menggantikan
  jalur murah tanpa memberi manfaat. Layak diukur ulang bila kelas ini sering.

`turn_boundary_check_failed` pada 57% giliran mengonfirmasi butir 7: angka 29%
dari pengukuran terisolasi adalah batas bawah. Biayanya bukan hanya panggilan
model yang dibuang—setiap kegagalan menjadi tunggu tujuh detik sebelum Harvy
mulai bekerja, karena fallback-nya `open`. Rinciannya di butir 7.

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

## 12. Konfirmasi destruktif menyebut sasarannya

Terukur 2 dari 4 sesi: Harvy meminta konfirmasi sebelum menghapus—perilaku yang
benar—tetapi tanpa menyebut apa yang akan dihapus.

> "Hmm, aku nggak bisa langsung hapus tanpa konfirmasi. Mau aku tandai selesai
> aja, atau emang mau dihapus permanen?"

Sesi yang benar menyebutnya: "yakin mau hapus permanen tugas 'Mengumpulkan
tugas biologi' yang jatuh tempo besok?" Dengan satu tugas ini ceroboh; dengan
lima tugas ia berbahaya, karena pengguna menjawab "iya hapus" tanpa tahu mana
yang hilang. Konfirmasi yang tidak menyebut sasarannya bukan konfirmasi.

Deskripsi `harvy_need_input_v1` kini menuntut menyebut sasaran dengan nama
memakai hasil tool yang sudah dibaca.

Pengukuran sesudahnya, kasus `batalkan-task-alami`:

| | lulus |
|---|---|
| sebelum perubahan | 2 dari 4 |
| sesudah, terisolasi | 2 dari 3 |
| sesudah, sesi penuh | 2 dari 2 |

Digabung: 4 dari 5 sesudah perubahan, dibanding 2 dari 4 sebelumnya. Arahnya
benar tetapi n-nya masih kecil, dan sesi ketiga tidak terhitung karena
onboarding-nya gagal. Bila prosa tetap tidak dipatuhi, pelajaran
butir 1 berlaku di sini juga: beri slot pada schema—field sasaran yang terpisah
dari teks pertanyaan—karena parameter yang dideklarasikan diisi sedangkan prosa
diabaikan.

## 13. Keluhan yang meminta arahan kini membaca daftar tugas

Dikerjakan 30 Agustus 2026. Diagnosisnya benar, tetapi jalur perbaikan yang
diusulkan versi sebelumnya tidak akan bekerja, dan menemukan sebabnya membuka
dua cacat yang lebih dalam.

**Usul lama—menaikkan `toolNeed`—tidak membuka apa pun.** Gerbangnya di
`create-bot.ts:3419` berbunyi
`intentAllowsAgentRuntime(intent) || requiresLiveState || …`, dan `toolNeed`
baru dinilai *sesudah* gerbang itu. Dengan intent `feeling`, satu-satunya jalan
masuk yang tidak menyentuh intent adalah `liveStateRequirement`.

**Perbaikan: satu cabang baru di `liveStateRequirement`** yang menuntut tiga
syarat bersamaan—kata kewajiban, penanda waktu atau kemajemukan, dan permintaan
arahan. Konjungsi ketiga memisahkan curhat dari permintaan bantuan, sehingga
mode menyimak tetap utuh; konjungsi kedua menahan pertanyaan isi.

| lolos ke pembacaan state | tetap ditangani percakapan |
|---|---|
| "besok ada dua deadline barengan … aku harus gimana ya" | "capek banget deadline numpuk" |
| "tugas numpuk banget, harus mulai dari mana?" | "besok ada ujian biologi, aku belum siap sama sekali" |
| "deadline minggu ini banyak, gimana caranya aku atur prioritas" | "pr matematika nomor 3 gimana caranya?" |

Lima positif dan delapan negatif dikunci di `tests/agent-runtime.test.ts`.

### Cacat yang tersingkap: model menolak `tool_choice` yang dipaksakan

Membuka gerbang saja **memperburuk keadaan**: empat probe berturut-turut
berakhir `stopped:invalid_planner_output`, kini dengan empat panggilan model.

Nama status itu menyesatkan. `invalid_planner_output` adalah *fallback
catch-all* terakhir di `abortReason`—setiap lemparan planner yang tidak
terklasifikasi memakai nama itu. Sebab sebenarnya, terbaca sesudah errornya
dicetak: `AiToolShapeError` dengan `reason: 'ignored_tool_choice'` dan
`'missing_tool_call'`. Kelas state-live memaksa model memanggil capability lewat
named `tool_choice`, dan MiniMax-M3 berulang kali menolak—ia membalas teks
permintaan maaf. Akibatnya kebalikan dari tujuan gerbang: jawaban akhirnya
disusun fallback justru tanpa state yang wajib dibaca. Frasa state-live lama
gagal dengan cara yang sama, jadi ini bukan bawaan cabang baru.

**Kewajiban itu milik kode, bukan model.** `liveStateRequirement` sudah
menetapkan capability sekaligus inputnya, jadi tidak ada keputusan tersisa untuk
model. `planAgent` kini menerbitkan aksinya sendiri. Harness tetap memvalidasi
proposal, memeriksa permission, dan mencatat eksekusinya; seluruh capability
kelas ini read-only. Named `tool_choice` dan terjemahan portabelnya ikut
dihapus karena tidak ada lagi yang memakainya.

Satu langkah tambahan diperlukan: thread native harus tetap koheren. Tanpa
pasangan call/hasil sintetis, model melihat observation tanpa jejak pemanggilnya
lalu mengusulkan capability yang sama sekali lagi.

| tahap | probe selesai |
|---|---|
| gerbang dibuka saja | 0 dari 4 |
| aksi diterbitkan kode | 1 dari 4 |
| + thread native koheren | **5 dari 5** |

Biaya giliran ikut turun: 2 panggilan model dan 17.763 token, dari 4 panggilan
dan 23.530 token pada giliran yang gagal. Balasannya kini berdasar—probe
terakhir membuka dengan "Aku cek task list dulu — kosong, belum ada yang
tercatat di situ", lalu menawarkan mencatat keduanya.

### Regresi yang hampir lolos: kalimat duka menjadi pekerjaan

Sesudah probe 8 dari 8 selesai dan perubahan dikira tuntas, suite penuh
menjatuhkan satu tes:

```
✖ request pendek bernuansa tanpa tool tetap memakai reply
   "Ayahku meninggal. Besok aku ujian. Aku harus gimana?"
   agentCalls 1, seharusnya 0
```

Ketiga syarat cocok penuh—"ujian", "besok", "harus gimana". Aturan yang ditulis
justru untuk menjaga mode menyimak malah mengubah kalimat duka menjadi
pembacaan daftar tugas.

Sebabnya struktural, bukan kata yang kurang tepat. `liveStateRequirement` adalah
kewajiban keras yang menang atas nuansa emosi di `selectGlobalRoute`, sedangkan
cabang keluhan ini cuma dugaan tentang beban kerja. Menaruh dugaan di tempat
kewajiban membuatnya mengalahkan penilaian yang seharusnya lebih tinggi.

Cabang keluhan kini menerima `emotionalNuance` dan tertutup seluruhnya pada
`high`. Kelas state-live lain sengaja tidak memakai penjaga itu: pertanyaan
tentang agenda tetap wajib membaca agenda betapa pun beratnya perasaan yang
menyertainya. Keduanya dikunci tes.

**Pelajarannya.** Delapan probe provider nyata berturut-turut hijau dan tidak
satu pun menyentuh kelas ini. Probe mengukur kalimat yang terpikirkan; suite
menyimpan kalimat yang pernah menyakiti seseorang. Perubahan pada gerbang
routing tidak boleh dianggap selesai sebelum `npm test` penuh, betapa pun
meyakinkan pengukuran di kanal nyata.

### Yang dibayar sadar

- **Kontinuitas reasoning provider hilang pada langkah terbitan kode.** Provider
  tidak pernah membuat panggilan itu, jadi tidak ada `thought_signature` maupun
  `reasoningDetails` miliknya. Dikunci eksplisit di tes, bukan disembunyikan.
- **Kode hanya menerbitkan aksinya sekali.** Bila executor memangkas hasilnya
  sehingga syarat tak pernah terpenuhi, giliran berikutnya dikembalikan kepada
  model. Tanpa batas ini aksi yang sama terulang sampai penjaga siklus
  menghentikan percakapan.
- **Larangan post-hoc dipersempit.** `Planner mengabaikan capability state-live
  wajib` kini hanya berlaku bila pembacaannya belum pernah terjadi. Sesudah
  observation nyata ada, jawaban yang mengakui batasnya lebih baik daripada
  giliran yang gagal; `coverageNote` memang sudah mekanisme untuk itu.
- Sembilan tes di `agent-conversation.test.ts` mengodekan kontrak lama dan
  diperbarui. Yang mereka jaga tetap dijaga—dan sebagian menjadi lebih kuat,
  karena pembacaan yang dulu bergantung pada kepatuhan model kini dijamin kode.

### Terverifikasi di kanal nyata

Sesi Telegram 30 Agustus sesudah perubahan: `burst-satu-pikiran` **lulus**,
dengan `agent: tools, capability task.list_active` dan tugas biologi yang
benar-benar tercatat kasus `simpan-task` sebelumnya. Intent-nya tetap
`feeling`—gerbangnya memang dibuka `liveStateRequirement`, bukan intent.

## 14. `create-bot-flow.test.ts` sensitif terhadap beban

Satu tes di berkas itu—"tidak menganggap chat berikutnya sebagai jawaban tanpa
binding pertanyaan"—gagal sekali pada suite penuh 30 Agustus dengan
`Kondisi async uji tidak tercapai` sesudah 15,3 detik. Itu timeout pada
`waitForAsync`, bukan assertion perilaku.

Kodenya identik dengan commit yang suite-nya hijau berkali-kali, dan berkas itu
lulus 114 dari 114 pada tiga kali penjalanan terisolasi berturut-turut sesudah
kegagalan tersebut. Jadi ia intermiten di bawah beban, bukan merah.

Gejala serupa pernah muncul lebih parah: berkas yang sama menggantung 50 menit
ketika dua run tes berjalan bersamaan, dan sempat terbaca sebagai "suite macet"
padahal itu kontensi.

Tidak dicatat di `KNOWN-FAILURES.md` karena tesnya tidak merah secara
konsisten—mencatatnya di sana akan membuat pembaca berikutnya mengabaikan
kegagalan yang justru nyata. Yang perlu diperiksa bila ia muncul lagi: batas
waktu `waitForAsync` di berkas tes itu, dan apakah ia memakai jam nyata pada
jalur yang seharusnya deterministik.

## 15. Pengenalan status CodingRun dipindahkan ke kode

Dikerjakan 30 Agustus 2026. Kedua hipotesis di catatan sebelumnya meleset:
capability coding memang tidak terpasang, tetapi bukan itu sebabnya, dan model
juga tidak "memilih capability yang salah dari daftar yang benar".

Membandingkan tiga sesi dengan kalimat yang sama memberi jawabannya:

| sesi | semantik | agent | hasil |
|---|---|---|---|
| A | `coding/show` (high) | tidak dipakai | lulus |
| B | `coding/show` (high) | `capability none` | lulus |
| C | **`none/none`** | `task.list_active` | **gagal** |

Extractor sesekali tidak mengusulkan operasi apa pun. Ketika itu terjadi,
`naturalSurfaceAuthorized` menolak, permukaan deterministik tidak pernah
menyala, dan pertanyaannya jatuh ke planner generik—yang membaca daftar tugas
belajar lalu menyusun jawaban tentang pekerjaan coding yang sedang berjalan
berikut progresnya. Angka itu tidak berasal dari observation mana pun.

Perhatikan sesi B: usulannya ada dan confidence-nya tinggi, tetapi agent tetap
berjalan. Otorisasi permukaan tidak hanya menuntut confidence—ia juga menuntut
`explicitness: explicit` dan reference tertentu. Jadi jalur ini dapat gagal
karena tiga sebab berbeda, dan ambang bertingkat butir 8 hanya menutup satu.

**Perbaikan: `codingRunStatusOperation` di `semantic-operation.ts`.** Dua bentuk
sempit—kata `status` di dekat kata coding, atau coding yang diikuti keterangan
sedang berjalan—dikenali kode dan menghasilkan `coding/show` sintetis ketika
usulan extractor tidak lolos. Kedua adapter memakainya. Lima positif dan enam
negatif dikunci tes, termasuk "gimana cara belajar coding?" yang wajib lolos:
kata "coding" saja bukan bukti.

Hanya pembacaan yang diambil alih kode. `coding/cancel` tetap menuntut usulan
extractor yang lolos ambang 0,85, karena ia menghentikan pekerjaan.

Field log `deterministic` sebelumnya selalu `false` dan kini menyatakan asal
operasinya sebenarnya. Tanpa itu pemeriksaan live tidak dapat membedakan
permukaan yang menyala karena extractor dari yang menyala karena kode.

Assertion `status-coding` di `scripts/live-telegram-cases.ts` ikut diperketat
menjadi `semanticDomain: coding`, `semanticOperation: show`, `agentUsed: false`.
Sebelumnya sengaja longgar karena jalurnya berayun; sesudah pengenalannya milik
kode, alasan itu hilang.

**Sesi Telegram sesudah perubahan: 9 dari 9 lulus**, `status-coding` dengan
`coding/show` (high), agent tidak dipakai, latensi 8,3 detik—turun dari 46
detik pada sesi yang gagal. Perlu dicatat jujur: pada sesi itu extractor
*berhasil* mengusulkan operasinya, jadi jalur deterministiknya belum tentu
ikut menyala. Yang dibuktikan sesi ini adalah tidak adanya regresi; bahwa
detektornya bekerja dibuktikan tes unit. Kegagalan aslinya muncul 1 dari 3
sesi, jadi satu sesi hijau memang belum dapat membedakannya.

**Pelajaran yang mengulang butir 13.** Kelas berpresisi tinggi yang jawabannya
sudah ditentukan kode tidak boleh bergantung pada klasifikasi model. Di butir 13
model menolak memanggil capability yang diwajibkan; di sini model kadang tidak
mengusulkan apa-apa. Bentuk kegagalannya berbeda, obatnya sama: pindahkan
pengenalannya ke kode dan sisakan bahasa untuk model.

## 16. Harvy kini sadar ketika ia memotong pengguna

Dikerjakan 30 Agustus 2026 atas usul pengguna, dan usul itu mengubah arah butir
7. Pertanyaannya bukan lagi bagaimana menebak batas giliran lebih akurat—
menebak tidak akan pernah sempurna, manusia pun saling memotong—melainkan
bagaimana Harvy tahu ketika dirinya memotong lalu memperbaikinya.

**Lubangnya nyata dan satu arah.** Harvy sudah mengenali empat bentuk penyelaan
(`addition`, `correction`, `redirect`, `independent`), tetapi semuanya menilai
*pengguna menyela pekerjaan Harvy*—kodenya menyebutnya "hubungan dengan run
yang digantikan". Ketika balasan sudah terkirim, tidak ada run yang
tergantikan, jadi sambungan kalimat pengguna diperlakukan sebagai topik baru.
Harvy tidak punya cara tahu bahwa ia baru saja memotong orang di tengah pikiran.

**Batasan yang diminta pengguna: hanya ketika sambungannya mengubah jawaban.**
Mengakui setiap potongan lebih jujur tetapi terasa cerewet, dan potongan yang
tidak mengubah apa pun memang tidak merugikan siapa pun. Batasan itu sekaligus
membuatnya dapat diperiksa kode tanpa menebak.

`acknowledgesPrematureReply` menuntut tiga hal bersamaan:

1. **Waktu.** Pesan tiba dalam 8 detik sesudah balasan terkirim. Ini angka waktu
   *membaca*, bukan mengetik: orang yang menyusun pertanyaan lanjutan harus
   membaca balasannya lebih dulu, dan itu tidak selesai dalam hitungan detik.
   Pertanyaan lanjutan dan sambungan yang terpotong berbentuk sama persis;
   hanya waktu yang membedakan.
2. **Bentuk menyambung.** Pembuka penyambung atau fragmen. Bentuk yang jelas
   menutup giliran ("makasih", "oke") tidak pernah dihitung.
3. **Isi yang belum terjawab.** Ada kata isi pada sambungan yang tidak muncul di
   balasan tadi. Inilah arti "mengubah jawaban".

`MessageBatch` kini membawa `firstReceivedAt` supaya jaraknya diukur dari saat
bubble pengguna tiba, bukan sesudah jendela batching—kalau tidak, waktu tunggu
Harvy sendiri ikut terhitung sebagai jeda pengguna.

**Arahan prompt tidak cukup, dan ini terukur.** Sinyalnya mula-mula hanya
diteruskan ke prompt seperti receipt ingatan. Pengukuran provider nyata:
pengakuan **0 dari 5**, baik sinyal menyala maupun tidak. Arahannya bukan tanpa
efek—jawabannya berubah menjadi menyambung alih-alih memulai topik baru—tetapi
bagian yang paling penting tidak pernah muncul.

Kalimatnya karena itu ikut dimiliki kode, sejajar dengan identitas capybara:
tiga varian, dipilih stabil per pengguna, dan tidak ditambahkan bila balasannya
sudah mengakui sendiri. Sesudah itu **3 dari 3**. Arahan prompt tetap dipasang
karena efek bentuknya nyata.

Ini pola yang sama dengan butir 13 dan 15, dan ini kali ketiga berturut-turut:
yang wajib terjadi tidak boleh bergantung pada kepatuhan model. Di butir 13
model menolak memanggil capability, di butir 15 model kadang tidak mengusulkan
apa pun, di sini model tidak mengakui meski diminta.

**Akibatnya untuk butir 7.** Memotong terlalu cepat jadi jauh lebih murah bila
Harvy dapat memperbaiki diri sesudahnya, sehingga arah "perpendek fallback
kegagalan" lebih aman diambil daripada sebelumnya.

**Belum diperiksa di kanal nyata.** Korpus `uji-telegram-langsung` sudah memakai
30 dari 32 perintah untuk sembilan kasus, jadi kasus baru tidak muat tanpa
memecah sesi—batasan yang sudah tercatat di butir 9. Yang sudah diukur dengan
model nyata adalah bagian yang paling mungkin gagal, yaitu apakah pengakuannya
benar-benar muncul.

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
