# ADR-006: Memori Per Pengguna dan Riwayat Percakapan

- Status: Disahkan
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-004` (percakapan sepenuhnya lewat AI), Konstitusi Pasal 3.9 dan
  Pasal 4
- Disupersesi sebagian: `ADR-030` memisahkan retensi storage 32 episode padat
  dari attention context otomatis 12 episode.
- Ditindaklanjuti: `ADR-031` menambah semantic projection, Context Pack, dan
  lifecycle suppression; `ADR-032` menambah graph temporal turunan.
- UX daftar/tombol per-item disupersesi `ADR-043`; primary MemoryItem dan hak
  cascade deletion yang ditetapkan ADR ini tetap berlaku.
- Amandemen 24 Agustus 2026: consent onboarding privat menggantikan prompt
  per-item; grup tetap memakai authority yang lebih sempit.

## Konteks

Sampai keputusan ini diambil, setiap pesan berdiri sendiri. Akibatnya dua hal.

Pertama, Harvy menjengkelkan. Pengguna harus mengulang hal yang sama —
kelasnya, mata pelajarannya, apa yang barusan ditanyakan — pada setiap giliran.
Kalimat seperti "iya yang tadi itu" tidak pernah bisa dipahami.

Kedua, tutoring bertahap tidak mungkin. Pola lima langkah pada Konstitusi Pasal
3.4 menuntut Harvy tahu sudah sampai mana penggunanya. Tanpa itu, `persona.ts`
boleh saja menjanjikan tutoring, tetapi yang benar-benar terjadi hanyalah
penjelasan satu giliran yang diulang dari nol.

Kekosongan ini juga pernah berubah menjadi ketidakjujuran: ditanya "aku tanya
apa tadi", Harvy menjawab "ini pesan pertama kamu di obrolan kita". Perbaikan
sementaranya adalah mewajibkan Harvy mengaku tidak punya ingatan.

## Keputusan

### 1. Dua barang yang terpisah, bukan satu

**Memori** adalah pengetahuan tentang pengguna yang bertahan: namanya, kelasnya,
cara belajar yang cocok, ujian minggu depan, ibunya sedang sakit. Bentuknya
terstruktur, jumlahnya sedikit, dan setiap butirnya dapat ditunjuk untuk
dihapus.

**Riwayat percakapan** adalah giliran-giliran mentah yang baru saja terjadi.
Bentuknya apa adanya, jumlahnya banyak, dan gunanya hanya untuk memahami
konteks terdekat.

Keduanya sengaja tidak digabung. Menggabungkannya menghasilkan transkrip mentah
yang ditumpuk lalu disebut memori, dengan tiga akibat: prompt membengkak setiap
giliran, pengguna tidak dapat menghapus satu hal tertentu karena tidak ada "satu
hal" yang dapat ditunjuk, dan hal paling sensitif ikut tersimpan tanpa pernah
ada yang memutuskan bahwa ia tersimpan.

### 2. Memori privat disimpan otomatis setelah onboarding

Jenis memori menentukan perlakuannya:

| Jenis | Contoh | Perlakuan |
|---|---|---|
| `profile` | nama panggilan, kelas, sekolah | otomatis |
| `preference` | lebih paham lewat contoh, tidak suka dikejar-kejar | otomatis |
| `routine` | les Jumat sore, ekskul Sabtu | otomatis |
| `context` | ujian biologi minggu depan, sedang lomba | otomatis |
| `personal` | kesehatan, keluarga, relasi, gender, orientasi seksual, tekanan emosional berat | otomatis setelah consent onboarding privat aktif |

Yang otomatis tetap **diberitahukan** saat disimpan, tetapi acknowledgement
menjadi bagian balasan kontekstual, bukan copy per-kind atau dump record. Sejak
ADR-043, primary commit menghasilkan receipt code-owned sebelum model memilih
wording; balasan yang sudah jelas tidak mendapat note kedua. `📍` boleh dipakai
untuk write/update, `💭` hanya untuk recall lama, dan keduanya tidak wajib.
Pemberitahuan juga tidak memasang tombol Lupakan per item; pengguna mengoreksi
atau melupakan dengan bahasa biasa, sementara `/memori` dan Data & izin menjaga
transparansi. Pasal 4 nomor 2 meminta pengguna tahu ketika sesuatu yang baru
disimpan; ia tidak meminta Harvy membuka pengelola record atau meminta izin
kedua untuk setiap remah. Consent onboarding privat yang menjelaskan bahwa
catatan biasa maupun personal dapat disimpan otomatis menjadi authority scope.
Perubahan material ini menaikkan `CONSENT_VERSION`, sehingga consent versi lama
tidak dipakai diam-diam untuk kebijakan baru.

Perintah seperti `ingat ya ...` tetap dibuktikan dari raw user turn agar
kegagalan write dapat dilaporkan dan fakta lain tidak diakui sebagai bagian
perintah. Bukti ini bukan lagi satu-satunya authority pada kanal privat. Model
hanya mengusulkan isi; primary service tetap memiliki dedupe, lifecycle block,
batas penyimpanan, dan hard exclusion credential. Grup tidak mewarisi consent
privat: kandidat member-local implicit diabaikan tanpa prompt, perintah explicit
anggota tetap item-scoped, dan shared room memory tetap dikonfirmasi pengelola.

Credential merupakan hard exclusion yang berbeda dari data personal sensitif.
Password, OTP, PIN, token, API key, dan credential sejenis ditolak lagi oleh
primary service sekalipun adapter membawa consent eksplisit; derivation tidak
pernah dimulai untuk konten tersebut.

Harvy **boleh** mengingat curhat setelah onboarding privat aktif, tetapi tidak
boleh diam-diam mengarang atau mengaku menyimpan. Setiap write/update yang
commit mempunyai receipt sebelum acknowledgement; failure tidak mendapat klaim
write. Pengguna dapat mengoreksi atau melupakan lewat bahasa biasa dan
`/memori`, tanpa tombol per-save.

### 3. Riwayat disimpan ke disk, dipadatkan per episode, lalu dibuang

Giliran mentah disimpan agar konteks tidak hilang saat proses restart. Setelah
melewati jumlah tertentu, awalan giliran lama diekstrak menjadi satu episode
terstruktur dan teks mentah sumbernya dibuang. Setiap klaim episode menunjuk
sequence sumber; rentang dan hash sumber dibuat kode. Episode lama tidak pernah
dikirim lagi ke peringkas, sehingga tidak ada satu paragraf yang terus
diringkas ulang dan bergeser maknanya.

Sejak `ADR-007`, pemadatan diminta setelah balasan terkirim dan tidak ditunggu
jalur respons. `ADR-014` mengganti format rolling v1 dengan episodic v2:
completion hanya di-commit bila generation, coverage episode, awalan giliran,
dan source hash masih sama. Bubble yang datang saat model bekerja tetap ada.
Kegagalan mempertahankan sumber mentah dan diberi cooldown satu menit; shutdown
normal menunggu pekerjaan yang sudah dimulai.

Riwayat tetap terbatas. Keputusan awal menyimpan 12 episode; sejak `ADR-030`,
storage menyimpan maksimum 32 episode padat sebagai sumber search lokal,
sementara hanya 12 episode terbaru dan maksimum 3.000 karakter masuk context
otomatis. Ringkasan v1 lama dimigrasikan sebagai episode warisan tanpa
mengarang sequence atau provenance.

Ini bukan sekadar penghematan token. Ringkasan adalah bentuk penyimpanan yang
lebih sedikit, dan Pasal 3.9 meminta data dikumpulkan sesedikit mungkin serta
memiliki batas penyimpanan. Transkrip yang tumbuh tanpa batas melanggar
keduanya.

Riwayat tidak memiliki tombol hapus per giliran — pengguna tidak seharusnya
mengurus rumah tangga transkrip. Yang tersedia adalah "lupakan semua tentang
aku", yang menghapus memori **dan** riwayat sekaligus. Pasal 2 nomor 5 dan Pasal
4 nomor 4 menuntut jalan itu ada.

### 4. Masa berlaku ditetapkan per jenis

`context` hidup 60 hari; ujian yang sudah lewat bukan pengetahuan, hanya sampah.
`personal` hidup 180 hari, supaya keadaan berat tidak menempel selamanya tanpa
pernah ditinjau. `profile`, `preference`, dan `routine` tidak kedaluwarsa dengan
sendirinya karena memang jarang berubah.

Memori yang kedaluwarsa dibuang saat dibaca, bukan menunggu pekerja terjadwal.

### 5. Isolasi memakai `ownerId`, sama seperti tugas

Setiap metode port memori dan riwayat menerima `ownerId`. Ini invarian yang
sudah berlaku untuk `TaskRepository` dan tidak diperlakukan berbeda di sini.

### 6. Memori dan riwayat adalah masukan yang tidak tepercaya

Keduanya berisi teks yang ditulis pengguna, lalu diputar ulang ke dalam prompt
pada giliran berikutnya — kali ini dari sisi sistem. Tanpa perlakuan khusus,
kalimat yang ditulis hari ini menjadi jalan injeksi besok.

Karena itu keduanya masuk prompt dengan pembungkus yang sama disiplinnya dengan
`understandingInput`, dan disertai penegasan bahwa isinya adalah catatan, bukan
perintah.

### 7. Pemilihan memori dilakukan di kode, bukan oleh model

Memori yang ikut masuk prompt dipilih secara deterministik di `core/`:
kedaluwarsa dibuang, sisanya diberi skor dari kecocokan kata, bobot jenis, dan
kebaruan, lalu diambil beberapa teratas.

Alasannya dua. Pemilihan yang deterministik dapat diuji unit tanpa memanggil
model, sejalan dengan `prioritizer.ts`. Dan menambah satu panggilan model untuk
memilih memori berarti membayar dua kali untuk satu giliran percakapan.

### 8. Ekstraksi memori menumpang panggilan pemahaman yang sudah ada

Model `cheap` sudah membaca setiap pesan menjadi JSON pada `temperature: 0`.
Usulan memori menjadi satu field tambahan pada JSON itu. Tidak ada panggilan
baru, sehingga biaya per giliran tidak bertambah.

## Konsekuensi

Positif:

- Harvy berhenti menanyakan hal yang sudah diketahuinya.
- Tutoring bertahap menjadi mungkin untuk pertama kalinya.
- Pengguna dapat melihat, menyunting, menghapus, dan mengekspor apa yang
  diingat tentang dirinya. Ekspor sengaja mengecualikan satu jenis insight
  tersembunyi yang disahkan Konstitusi; penghapusan penuh tetap menghapusnya.

Trade-off:

- Setiap giliran membawa prompt yang lebih panjang, sehingga biaya per pesan
  naik. Telemetry tanpa isi dan batas token 24 jam kini mengukurnya, tetapi
  angkanya belum dibandingkan dengan tagihan penyedia nyata.
- `data/` kini berisi teks percakapan, bukan hanya judul tugas. Nilai berkas itu
  bagi penyerang naik, dan penyimpanan berkas satu proses menjadi lebih sempit
  umurnya.
- Ringkasan dapat salah. Yang diringkas adalah perkataan pengguna, jadi
  kekeliruan ringkasan berarti Harvy salah mengingat — bukan sekadar lupa.

Yang berubah di tempat lain:

- `persona.ts` tidak lagi mewajibkan Harvy mengaku tanpa ingatan. Membiarkannya
  akan mengubah kejujuran 26 Juli menjadi kebohongan baru ke arah sebaliknya.
- `README.md` tidak lagi menjanjikan Harvy tidak menyimpan curhat.

## Alternatif yang ditolak

- **Riwayat di memori proses saja.** Lebih aman dan lebih murah, tetapi konteks
  hilang setiap restart, dan pengguna tidak punya cara mengetahui kapan proses
  restart. Ditolak pemilik produk.
- **Menanyakan izin untuk setiap memori.** Paling patuh, tetapi menciptakan
  gangguan baru yang persis sebesar masalah yang hendak diselesaikan.
- **Menyimpan seluruh transkrip tanpa batas.** Paling sederhana, melanggar Pasal
  3.9 soal batas penyimpanan dan pengumpulan seminimal mungkin.
- **Memilih memori dengan panggilan model tersendiri.** Lebih luwes, tetapi
  membayar dua kali per giliran dan tidak dapat diuji tanpa jaringan.
