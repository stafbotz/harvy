# Status — WhatsApp Grup

Verified: 6 Agustus 2026 pada baseline `43d8e16`; core/lifecycle teruji otomatis,
sementara bukti kanal nyata masih sempit.

## Keadaan saat ini

- Baileys menyediakan fondasi beta grup terpisah dari state privat Telegram.
  Direct, ambient, membership lifecycle, binding, batching, dan generation
  guard tersedia.
- Metadata membership pengirim dan Harvy harus segar sebelum ingress diterima;
  core melakukan revalidation sebelum binding atau mutasi.
- Direct settle 350 ms dan membatalkan kandidat ambient; ambient settle 1,2
  detik lalu revalidate terhadap quiet gap, freshness, dan human-flow policy.
- Member-local memory dan shared room memory ada di core dengan authority guard,
  preview/confirmation, retensi, dan kontrol member/admin. Rollback delivery
  lengkap hanya untuk record member/room yang baru dibuat.
- `WHATSAPP_ACCOUNTS` mendukung beberapa alias account satu proses, masing-masing
  dengan auth folder, socket, cache, reconnect, generation, dan queue sendiri.
- Satu nomor nyata pernah QR/login/`open` dan membalas satu jalur dasar.

## Batas dan defect aktif

- Notice/privacy terbaru, memory member/room, timing ambient, removal, safety,
  dan shutdown belum diuji end-to-end di grup nyata.
- Dua nomor nyata sekaligus belum diuji. Tidak ada failover atau rebind otomatis
  antar-account.
- Pending confirmation dan authority epoch grup tidak durable lintas restart.
- Edit, delete, reset, alias, dan self-delete belum mempunyai kompensasi generik
  bila acknowledgment gagal sesudah mutasi commit.
- Store sosial legacy masih memakai PN/LID mentah untuk bridging; semantic
  record baru memakai alias hash scoped. Account linking lintas kanal belum ada.
- Satu stream grup belum mempunyai conversation disentanglement sempurna dan
  quote kandidat dapat hilang saat cache Baileys kedaluwarsa.

## Bukti dan pointer

- Kode: `src/whatsapp/`, `src/core/group-turn-service.ts`,
  `src/core/group-memory-service.ts`, `src/core/group-authority-policy.ts`.
- Tes: `tests/baileys-account-manager.test.ts`,
  `tests/group-conversation.test.ts`, `tests/group-turn-service.test.ts`,
  `tests/group-memory-service.test.ts`.
- Keputusan: ADR-009, ADR-011, ADR-016.
