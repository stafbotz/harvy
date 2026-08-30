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

**Sesi pertama dari tiga: 9 dari 9 lulus, nol pelanggaran register.** Dua sesi
sisanya masih berjalan; satu sesi belum membedakan pagar yang bekerja dari
pelanggaran yang kebetulan tidak muncul. Perbarui angkanya ketika keduanya
mendarat.

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
dari pengukuran terisolasi adalah batas bawah, dan mayoritas giliran membayar
satu panggilan model tier `cheap` yang hasilnya dibuang.

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
| sesudah, sesi penuh | 1 dari 1, dua sesi lagi berjalan |

Belum cukup untuk disebut perbaikan. Bila prosa tetap tidak dipatuhi, pelajaran
butir 1 berlaku di sini juga: beri slot pada schema—field sasaran yang terpisah
dari teks pertanyaan—karena parameter yang dideklarasikan diisi sedangkan prosa
diabaikan.

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
