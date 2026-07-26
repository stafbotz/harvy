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

Rencana saat keputusan ini dibuat: DeepSeek V4 Flash sebagai `cheap`,
GPT 5.6 Luna sebagai `efficient`, dan GPT 5.6 Terra sebagai `ambitious`.

### Routing berdasarkan kesulitan, bukan paket pengguna

`docs/PROJECT.md` sudah menetapkan ini sejak awal dan Konstitusi menguatkannya.
Pelajar yang tidak membayar tetap mendapat model terkuat ketika persoalannya
memang sulit. Sinyal yang dipakai adalah maksud pesan, panjangnya, permintaan
dituntun bertahap, dan kepekaan keselamatan — bukan status akun.

**Keselamatan tidak pernah dihemat.** Percakapan yang menyinggung menyakiti
diri, kekerasan, pelecehan, atau eksploitasi selalu naik ke tingkatan
`ambitious`, berapa pun biayanya. Pasal 3.8 menuntut respons yang proporsional
dan hati-hati, dan itu tidak dapat didelegasikan ke model termurah.

### Dua mode, dua penyedia

| Mode | Penyedia | Model | Kunci |
|---|---|---|---|
| `testing` | Google AI Studio | Satu model gratis untuk semua tingkatan | Banyak, dipakai bergantian |
| `production` | OpenRouter | Tiga model sesuai tingkatan | Satu |

Produksi memakai OpenRouter sebagai gerbang tunggal agar tagihan berada di satu
tempat dan model dapat diganti tanpa membuka akun baru.

Mode uji memakai kuota gratis Google AI Studio. Menghentikan mode uji cukup
dengan mengubah `AI_MODE` menjadi `production`; tidak ada kode yang disentuh.

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

## Risiko yang diketahui

- **Sebagian nama model belum terverifikasi.** ID
  `deepseek/deepseek-v4-flash` dan `gemini-3.5-flash-lite` diverifikasi pada
  daftar resmi penyedia tanggal 26 Juli 2026. GPT 5.6 Luna dan GPT 5.6 Terra
  belum diverifikasi. Seluruh ID tetap berada di environment: koreksi cukup
  satu baris `.env`.
- **Dua penyedia selama masa uji.** Google AI Studio bukan OpenRouter, sehingga
  kredit tetap terpisah selama pengujian. OpenRouter juga menyediakan Gemini;
  bila keseragaman lebih penting daripada gratis, `AI_BASE_URL` dan
  `AI_MODEL_TESTING` dapat diarahkan ke sana tanpa mengubah kode.
- **Perubahan perilaku antar mode.** Model uji tunggal tidak akan berperilaku
  sama dengan tiga model produksi. Hasil pengujian dalam mode uji tidak boleh
  dianggap mewakili produksi, terutama untuk percakapan keselamatan.
- **Biaya belum terukur.** Belum ada batas pemakaian, penghitungan token, atau
  pemantauan biaya per pengguna.

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

## Yang belum dikerjakan

Alur teknis yang dituju, sesuai konteks produk:

```text
pesan pengguna → pemeriksaan keselamatan → klasifikasi kebutuhan →
pemilihan model → pemanggilan model → pemeriksaan respons → balasan
```

Yang sudah ada: **klasifikasi**, **pemilihan model**, dan **pemanggilan model**.

Yang belum ada:

- pemeriksaan keselamatan sebagai lapisan tersendiri. Saat ini kepekaan
  keselamatan hanya dinilai oleh model dalam langkah klasifikasi, lalu dijawab
  dengan tambahan prompt. Konteks produk menegaskan prompt saja tidak cukup;
- pemeriksaan respons sebelum dikirim ke pengguna;
- penghitungan token, batas pemakaian, dan pemantauan biaya per pengguna;
- riwayat percakapan kemudian dikerjakan lewat `ADR-006`; dan
- penanganan khusus pengguna di bawah 18 tahun.
