# Status — Telegram Privat

Verified: 6 Agustus 2026 pada baseline `43d8e16`; mayoritas bukti terbaru adalah
tes otomatis/adaptor palsu. Baca untuk task `src/bot/` dan surface Telegram.

## Keadaan saat ini

- Surface utama adalah chat pribadi Telegram dengan percakapan biasa dan
  tombol; `/start`, `/tugas`, dan `/bantuan` hanya pelengkap.
- Onboarding menahan pesan pertama sampai consent, mempertahankan urutan bubble,
  dan menyediakan jalur safety tanpa consent. Bubble setelah pesan pertama
  tidak dikirim ke model sebelum consent.
- Ingress pesan nonblocking memakai batcher adaptif: settle awal 650 ms, lalu
  jendela 4/7/12 detik menurut keadaan. Command/callback diserialkan per owner.
- Balasan dibagi maksimal tiga bubble, teks Telegram dinormalisasi, dan blok
  kode dipertahankan bila muat.
- Route privat mencakup percakapan, action offer, task, session, data control,
  memory, safety, serta Agent Runtime. Fast path waktu deterministik tersedia.
- Model mengusulkan action dari allowlist; kode tetap menguasai callback,
  ownership, expiry, dan batas pilihan.

## Batas dan defect aktif

- Perbaikan batching, naturalness, waktu, onboarding, tombol, preference, dan
  Agent Runtime terbaru belum diuji ulang end-to-end lewat Telegram.
- Runtime hanya chat pribadi; Telegram grup belum menjadi surface produk.
- Antrean percakapan dan pesan pra-consent masih in-memory. Crash atau force
  stop dapat kehilangan giliran yang belum selesai.
- Request model biasa yang aktif belum mempunyai cancellation kooperatif penuh.
- Ada bukti live lama untuk onboarding/task/tombol dasar, tetapi bukti lama
  tidak membuktikan build terbaru.

## Bukti dan pointer

- Kode: `src/bot/`, `src/ai/conversation.ts`, `src/app.ts`.
- Tes: `tests/create-bot.test.ts`, `tests/conversation.test.ts`,
  `tests/message-batcher.test.ts`, `tests/onboarding.test.ts`.
- Keputusan: ADR-002, ADR-004, ADR-007, ADR-008.

