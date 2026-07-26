# Harvy

Fondasi MVP **Harvy Capybara**, pendamping pelajar yang diakses lewat chat
pribadi Telegram. Seluruh percakapan dipahami oleh model AI, tanpa cadangan
berbasis aturan, sesuai
[ADR-004](docs/decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md). Mode uji
memakai satu model gratis, jadi tugas, prioritas, dan pengingat tetap dapat
dicoba tanpa biaya inferensi.

## Cara pakai

Tulis saja seperti mengobrol biasa. Tidak ada format yang perlu dihafal dan
tidak ada ID yang perlu diketik.

```text
besok jam 7 malam kumpulin matematika halaman 20
senin ada ulangan biologi, penting banget
30 agustus daftar lomba
bawa buku sejarah
```

Harvy membalas dengan tugas yang sudah dirapikan beserta tombol **Selesai**,
**Ingatkan**, **Ubah tenggat**, dan **Batalkan**.

Hanya ada dua perintah, dan keduanya opsional:

```text
/tugas     lihat yang harus dikerjakan
/bantuan   lihat cara pakai
```

### Yang dipahami Harvy

| Kamu tulis | Harvy mengerti |
|---|---|
| `besok`, `lusa`, `hari ini` | tanggal relatif |
| `senin`, `jumat depan`, `minggu depan` | hari berikutnya |
| `30 agustus`, `28/7`, `2026-07-28` | tanggal pasti |
| `jam 7 malam`, `19.30`, `sore` | waktu |
| `ingetin aku jam 8` | permintaan pengingat |
| `penting banget`, `santai`, `nggak penting` | tingkat kepentingan |

Tanggal tanpa jam dianggap berlaku sampai akhir hari itu.

### Yang Harvy ingat

Harvy mengingat beberapa hal supaya kamu tidak perlu mengulang dirimu:
kelasmu, cara belajar yang cocok, kebiasaan, dan apa yang sedang kamu hadapi.
Setiap kali ada yang disimpan, Harvy mengatakannya berikut tombol **Lupakan**.

Untuk hal pribadi — kesehatan, keluarga, tekanan yang berat — Harvy **selalu
bertanya dulu** dan tidak menyimpan apa pun tanpa jawabanmu.

Beberapa giliran terakhir juga diingat supaya "yang tadi itu" bisa dimengerti.
Percakapan lama diringkas menjadi satu paragraf, lalu teks aslinya dibuang.

Tanya "apa yang kamu ingat tentang aku" kapan saja untuk melihat daftarnya,
menghapus satu, atau menghapus semuanya sekaligus.

### Yang Harvy lakukan saat tidak yakin

Harvy **tidak** mengubah setiap pesan menjadi tugas. Kalau kamu menulis keluhan,
ia menanggapi keadaanmu dulu, lalu menawarkan mencatat pekerjaannya lewat
tombol. Kalau kamu bertanya soal pelajaran, ia menuntun alih-alih langsung
memberi jawaban akhir. Kalau ia tidak paham, ia mengatakannya.

## Menjalankan

Syarat: Node.js 22 atau lebih baru, token bot dari
[@BotFather](https://t.me/BotFather), dan kunci model AI.

```bash
npm install
cp .env.example .env
```

Isi `TELEGRAM_BOT_TOKEN`, lalu pilih mode di `.env`:

- **`AI_MODE=testing`** — satu model gratis lewat Google AI Studio. Isi
  `GOOGLE_AI_STUDIO_API_KEYS` (boleh beberapa kunci dipisah koma, dipakai
  bergantian supaya kuota gratis tidak cepat habis) dan `AI_MODEL_TESTING`.
- **`AI_MODE=production`** — tiga model lewat OpenRouter, dipilih menurut
  kesulitan pekerjaan. Isi `OPENROUTER_API_KEY` beserta `AI_MODEL_CHEAP`,
  `AI_MODEL_EFFICIENT`, dan `AI_MODEL_AMBITIOUS`.

Verifikasi ejaan persis ID model di daftar model penyedia sebelum dipakai.
Setelah itu:

```bash
npm run dev
```

Untuk pemeriksaan lengkap:

```bash
npm run check
npm test
```

## Batas versi awal

- **Butuh kunci API untuk berjalan.** Tidak ada cadangan berbasis aturan; kalau
  kuota habis atau penyedia terganggu, Harvy mengaku sedang tidak bisa memproses.
- **Isi pesanmu dikirim ke penyedia model pihak ketiga**, kini termasuk memori
  dan ringkasan percakapan. Pemberitahuan dan persetujuan pengguna untuk hal ini
  belum dibuat.
- Memori dan riwayat percakapan sudah ada, tetapi belum pernah dicoba pada
  percakapan sungguhan. Tutoring bertahap lima langkah juga belum ditulis sebagai
  alur, jadi ia belum benar-benar berjalan.
- Ringkasan percakapan disusun model, jadi ia bisa keliru. Keliru meringkas
  berarti Harvy salah mengingat, bukan sekadar lupa.
- Pengingat lewat tombol Ingatkan waktunya masih ditetapkan Harvy, satu jam
  sebelum tenggat. Belum ada jam tenang maupun pengaturan frekuensi.
- Pembacaan tenggat oleh model tidak selalu tepat. Setiap tugas yang tercatat
  selalu ditampilkan lengkap beserta tombol Ubah tenggat dan Batalkan.
- Kosakata condong ke bahasa Indonesia sehari-hari; bahasa daerah dan campur
  kode berat belum tertangani.
- Satu zona waktu untuk semua pengguna, mengikuti `DEFAULT_TIMEZONE` dan
  `DEFAULT_UTC_OFFSET`.
- Memori dan riwayat dapat dihapus dari dalam chat, tetapi tugas belum ikut
  terhapus dan belum ada cara mengekspor data.
- Tidak membaca grup Telegram atau WhatsApp.
- Hal sensitif — kesehatan, keluarga, tekanan berat — hanya disimpan bila kamu
  mengizinkannya lebih dulu, tidak pernah diam-diam.
- Tidak menghubungi pengguna tanpa pengingat yang ia pasang sendiri.
- Penyimpanan berkas cocok untuk prototipe satu proses, belum untuk produksi.

Keputusan produk dan backlog ada di [docs/PROJECT.md](docs/PROJECT.md). Arah
moral dan batasnya ada di [docs/CONSTITUTION.md](docs/CONSTITUTION.md).

## Pengembangan dengan coding agent

Codex, Claude Code, dan Antigravity menggunakan satu protokol bersama. Mulai
dari [AGENTS.md](AGENTS.md), lalu pilih dokumentasi melalui
[docs/INDEX.md](docs/INDEX.md).

Sekali per clone, aktifkan hook yang menolak commit tanpa catatan konteks:

```bash
git config core.hooksPath .githooks
```
