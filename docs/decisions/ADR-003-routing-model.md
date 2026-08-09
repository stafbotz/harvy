# ADR-003: Tiga Model dengan Routing Berdasarkan Kesulitan

- Status: Accepted
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy

## Konteks

Harvy v0.1 berjalan sepenuhnya berbasis aturan tanpa model AI, sesuai
[`ADR-002`](ADR-002-percakapan-bahasa-alami.md). Pendekatan itu membuat Harvy
dapat diuji tanpa biaya, tetapi tidak cukup untuk pendamping belajar: Harvy
belum bisa menjelaskan materi, menuntun bertahap, atau menanggapi kalimat di
luar pola yang dikenali.

Kendala yang membentuk keputusan ini:

1. biaya inferensi harus dapat diprediksi sebelum ada pemasukan;
2. kredit yang tersebar di banyak platform merepotkan;
3. selama pengembangan, biaya sebaiknya nol; dan
4. Konstitusi Pasal 3.13 menempatkan model AI sebagai alat yang dapat diganti,
   sehingga kepribadian, aturan tutoring, keselamatan, dan memori harus tetap
   berada di lapisan Harvy.

## Keputusan

### Tiga tingkatan model

| Tingkatan | Dipakai untuk | Alasan |
|---|---|---|
| `cheap` | Mengurai pesan, menentukan batas bubble, klasifikasi, balasan pendek rutin | Pekerjaan ekstraksi, tidak butuh penalaran |
| `efficient` | Percakapan sehari-hari, check-in, memecah pekerjaan menjadi langkah kecil, penjelasan ringan | Butuh kepekaan bahasa, bukan penalaran berat |
| `ambitious` | Penjelasan berlapis, tutoring bertahap, dan perencanaan jangka panjang | Kesalahan di sini paling mahal bagi pengguna |

**Koreksi 27 Juli 2026.** Percakapan keselamatan tidak lagi naik ke `ambitious`.
Pemilik produk memutuskan `efficient` sudah cukup — di produksi tingkatan itu
adalah GPT 5.6 Luna — dan biaya menaikkan setiap kalimat yang menyerempet
keselamatan dinilai tidak sepadan. Yang menggantikan jaminan lama bukan
tingkatan model, melainkan lapisan tersendiri: triase risiko sebelum balasan
dan pemeriksaan balasan sesudahnya.

Model konkret untuk tiap tingkatan **tidak ditulis di kode**. Semuanya dibaca
dari environment (`AI_MODEL_CHEAP`, `AI_MODEL_EFFICIENT`,
`AI_MODEL_AMBITIOUS`).

**Amandemen 9 Agustus 2026.** Tier tetap memilih slot model seperti keputusan
ini, tetapi capability, role, reasoning effort, verbosity metadata, dan wire
provider diatur ADR-025. Base URL resmi tidak membuktikan capability setiap
model. Tanpa deklarasi exact `AI_MODEL_PROFILES`, runtime memakai profile
compatibility dan tidak mengirim reasoning control baru. Ini menggantikan
asumsi bahwa semua model pada satu endpoint OpenAI-compatible mempunyai
capability seragam.

Rencana saat keputusan ini dibuat: DeepSeek V4 Flash sebagai `cheap`,
GPT 5.6 Luna sebagai `efficient`, dan GPT 5.6 Terra sebagai `ambitious`.

### Routing berdasarkan kesulitan, bukan paket pengguna

`docs/PROJECT.md` sudah menetapkan ini sejak awal dan Konstitusi menguatkannya.
Pelajar yang tidak membayar tetap mendapat model terkuat ketika persoalannya
memang sulit. Sinyal yang dipakai adalah maksud pesan, panjangnya, permintaan
dituntun bertahap, dan kepekaan keselamatan — bukan status akun.

**Keselamatan tidak pernah diblokir batas pemakaian.** Sesuai koreksi di atas,
triase dan pemeriksaan respons memakai `cheap`, sedangkan balasan
`dukungan`/`bahaya` memakai `efficient`. Keduanya selalu berjalan sekalipun
batas token percakapan biasa sudah habis. Tutoring memakai `ambitious` hanya
pada giliran tenang; keselamatan tetap menang atas tier sesi.

**Amandemen 4 Agustus 2026 — routing khusus Agent Runtime.** Setelah consent,
triase, kontrol deterministik, research, dan sesi dipisahkan, intent tenang
`question`/`request` memakai root agent `cheap` sebagai default. Kode
menaikkannya menjadi root `ambitious` hanya bila `needsStepByStep` atau panjang
pesan melebihi 280 karakter. Root ambitious boleh mendelegasikan maksimal tiga
subpekerjaan independen kepada worker `cheap|efficient`; worker tidak boleh
memilih tier sendiri, memakai `ambitious`, mengganti scope, memanggil tool, atau
mendelegasikan lagi. Safety tetap direct `efficient`, tutoring aktif tetap
mengikuti policy sesi, dan research tetap route khusus ADR-015. Detail boundary
tool dan paralelisme berada di ADR-017.

### Dua mode dan cadangan testing yang terbatas

| Mode | Primary | Cadangan | Model dan kunci |
|---|---|---|---|
| `testing` | Google AI Studio | Opsional, satu gateway OpenAI-compatible | Primary memakai satu model dan banyak kunci bergantian; cadangan memakai model serta kunci sendiri |
| `production` | OpenRouter | Tidak ada | Tiga model sesuai tingkatan dan satu kunci |

Produksi memakai OpenRouter sebagai gerbang tunggal agar tagihan berada di satu
tempat dan model dapat diganti tanpa membuka akun baru.

Mode uji memakai kuota gratis Google AI Studio. Provider cadangan hanya dibaca
saat `AI_MODE=testing`; konfigurasi yang sama diabaikan pada production.
Menghentikan mode uji cukup dengan mengubah `AI_MODE` menjadi `production`;
tidak ada kode yang disentuh.

Per 26 Juli 2026, model mode uji adalah `gemini-3.5-flash-lite`. Model ini juga
dipakai untuk keputusan batas bubble; lihat `ADR-007`.

Keduanya diakses lewat satu klien yang sama. Google AI Studio dan OpenRouter
sama-sama menyediakan permukaan yang kompatibel dengan OpenAI, sehingga yang
berbeda hanya alamat dan kunci.

### Beberapa kunci untuk mode uji

`GOOGLE_AI_STUDIO_API_KEYS` menerima lebih dari satu kunci yang dipisah koma.
Kunci dipakai bergantian agar kuota gratis tidak menghentikan pengembangan
setiap kali satu kunci mencapai batas. Ketika sebuah permintaan ditolak karena
kuota atau gangguan sementara, permintaan diulang dengan kunci berikutnya
sebanyak jumlah kunci yang tersedia.

Ini alat pengembangan, bukan cara mengelak dari batas layanan. Seluruh kunci
tetap milik akun yang sama dan tunduk pada ketentuan penyedia.

### Amandemen 31 Juli 2026: failover provider mode uji

Log grup 30 Juli memperlihatkan timeout Google pada triase, generasi, review,
dan planner. Rotasi dua kunci membuat satu tahap provider-wide dapat menunggu
dua timeout berturut-turut. Pemilik kemudian meminta AlwaysCodex sebagai
cadangan selama pengujian.

Keputusan implementasinya:

1. `AI_TESTING_FALLBACK_BASE_URL`, `AI_TESTING_FALLBACK_API_KEY`, dan
   `AI_TESTING_FALLBACK_MODEL` wajib diisi bersama. Base URL wajib HTTPS dan
   dilarang membawa userinfo, query, fragment, atau `/chat/completions`.
2. Kunci cadangan dikirim lewat `Authorization: Bearer`, bukan query. Model
   dikirim lewat body serta query; gateway yang dipakai meneruskan bentuk
   OpenAI-compatible itu ke upstream. Redirect sengaja ditolak agar header
   kredensial tidak ikut berpindah host.
3. Timeout, kegagalan jaringan, dan HTTP 5xx dianggap provider-wide: jangan
   menghabiskan kunci Google lain, langsung pindah ke cadangan. HTTP 429 tetap
   mengikuti batas rotasi kunci primary pada request sebelum failover; tanpa
   batas khusus, seluruh kunci primary dicoba.
4. Pembatalan lifecycle, HTTP 4xx selain 429, keluaran model kosong/terpotong,
   opsi yang tidak didukung setelah downgrade, dan penolakan batas penggunaan
   lokal tidak boleh memicu failover.
5. Sesudah kegagalan provider-wide atau 429 yang telah mengenai seluruh kunci
   primary, circuit in-memory melewati primary selama 30 detik secara bawaan.
   Request yang membatasi percobaan sebelum seluruh kunci dicoba boleh failover
   pada 429 tanpa membuka circuit global. Primary dicoba lagi setelah cooldown
   atau langsung dianggap pulih ketika berhasil. Circuit ini sengaja sederhana
   dan tidak terkoordinasi lintas proses.
6. Evaluator model nyata menonaktifkan cadangan secara default. Flag
   `--allow-fallback` hanya untuk mengukur availability dan menandai hasil
   sebagai `primary-or-fallback`; baseline perilaku harus tetap satu model.
   Dua script probe manual mengikuti opt-in yang sama dan menampilkan model
   cadangan bila flag itu aktif.

Ini adalah duplikasi pemrosesan, bukan sekadar routing: bila primary sudah
menerima request tetapi terlambat merespons, isi yang sama dapat dikirim lagi
ke gateway cadangan. Karena itu persetujuan pribadi dinaikkan ke versi 3 dan
notice grup ke versi 5. Dokumentasi gateway menyebut endpoint v3 sebagai proxy
transparan ke upstream; kebijakan privasi, retensi, dan kesiapan produksinya
belum diverifikasi. Cadangan ini hanya untuk data sintetis/dogfood testing,
bukan persetujuan menjadikannya infrastruktur production.

Permintaan pertama yang menemukan primary gagal juga masih dapat memakan satu
timeout primary ditambah satu timeout cadangan. Circuit mengurangi pengulangan
pada request berikutnya, tetapi belum ada deadline total lintas seluruh tahap
satu turn.

## Risiko yang diketahui

- **Sebagian nama model belum terverifikasi.** ID
  `deepseek/deepseek-v4-flash` dan `gemini-3.5-flash-lite` diverifikasi pada
  daftar resmi penyedia tanggal 26 Juli 2026. GPT 5.6 Luna dan GPT 5.6 Terra
  belum diverifikasi. Seluruh ID tetap berada di environment: koreksi cukup
  satu baris `.env`.
- **Lebih dari satu rantai penyedia selama masa uji.** Google AI Studio,
  gateway cadangan, dan upstream gateway tersebut mempunyai kegagalan,
  ketentuan, serta retensi masing-masing. Bila keseragaman lebih penting
  daripada gratis, `AI_BASE_URL` dan `AI_MODEL_TESTING` dapat diarahkan ke satu
  penyedia tanpa mengubah kode.
- **Perubahan perilaku antar mode.** Model uji tunggal tidak akan berperilaku
  sama dengan tiga model produksi. Hasil pengujian dalam mode uji tidak boleh
  dianggap mewakili produksi, terutama untuk percakapan keselamatan.
- **Biaya belum terbukti pada penyedia nyata.** Kode kini mencatat penggunaan
  token, perkiraan, latensi, kegagalan, dan biaya per pengguna tanpa isi
  percakapan, serta menerapkan batas bergulir 24 jam. Harga tetap harus diisi
  dari daftar penyedia, dan angka aktual belum dibandingkan dengan tagihan.

## Konsekuensi

Positif:

- Biaya pengembangan nol, dan menaikkannya ke produksi hanya satu perubahan
  konfigurasi.
- Model dapat diganti tanpa menyentuh kepribadian, keselamatan, atau memori.
- Kebijakan routing murni dan dapat diuji tanpa kunci API maupun jaringan.

Trade-off:

- Tiga model berarti tiga perilaku yang harus diuji sebelum peluncuran.
- Routing berdasarkan kesulitan menuntut penilaian kesulitan yang tepat; salah
  menilai berarti pengguna mendapat model yang terlalu lemah.

## Status pelaksanaan per 27 Juli 2026

Alur teknis yang berjalan:

```text
pesan pengguna → (triase keselamatan || ekstraksi kebutuhan) →
pemilihan tier → pemanggilan model → pemeriksaan respons bila berisiko → balasan
```

Sudah ada: klasifikasi, routing, pemanggilan model, triase risiko tersendiri,
pemeriksaan respons fail-closed, riwayat percakapan (`ADR-006`), tutoring
persisten lima tahap, telemetry tanpa isi, serta batas pemakaian yang tidak
memblokir keselamatan. Perlindungan pengguna muda menyesuaikan isi dan tahap
perkembangan tanpa menanyakan umur.

Yang belum terbukti: perilaku tiga tier produksi, angka biaya terhadap tagihan
penyedia, dan seluruh alur baru melalui Telegram dengan kunci sungguhan.
