# Status — Console dan Control Plane

Verified: 23 Agustus 2026; HTTP tests, kontrak DOM, serta smoke Microsoft Edge
headless nyata pada desktop/mobile untuk server setup lokal terisolasi
tersedia. Console adalah surface operator localhost, bukan website pengguna.

## Keadaan saat ini

- Server bind wajib `127.0.0.1` dan memakai token-to-session `HttpOnly`, CSRF,
  Host/Origin checks, CSP/no-CORS, schema/body/rate/version guards, serta audit.
- UI menampilkan provider/model yang dikonfigurasi tanpa key/base URL, usage,
  biaya, request, fallback, grup, enrollment, cohort, package, dan runtime mode.
- Tab Kanal pengujian memverifikasi token bot Telegram, memasangkan session tester
  Telegram/WhatsApp lewat QR browser, menerima 2FA Telegram tanpa persist, dan
  mencabut session dengan logout-first. Token Telegram tersimpan terpisah dari
  session tester; status API dan audit tidak membawa secret, identifier, atau
  payload QR.
- Tab Kanal pengujian membedakan konfigurasi produk utama dan credential
  acceptance.
  Snapshot utama hanya membawa boolean/jumlah akun; status deklarasi tidak
  diklaim sebagai bukti session tertaut. Credential utama tidak dipakai ulang
  oleh acceptance. Checklist dan flow identitas memperlihatkan empat prasyarat
  uji secara terpisah.
- Surface kanal mempunyai state setup dan operasional yang berbeda. Saat belum
  lengkap, pengaturan pairing terbuka pada identitas yang perlu ditangani.
  Setelah empat identitas tersedia, layar utama hanya menunjukkan ringkasan
  `Harvy siap diuji` dan alur tester → Harvy untuk Telegram/WhatsApp; form
  secret, QR, serta tombol pairing berada di pengaturan tertutup. Ringkasan ini
  tidak mengklaim reconnect atau pengiriman live sudah terbukti. Rotasi token
  dan pencabutan session tetap tersedia melalui progressive disclosure.
- Pengelolaan WhatsApp mempunyai alur **Pasangkan ulang** logout-first. Session
  lama dihapus lokal hanya setelah logout berhasil atau WhatsApp mengembalikan
  bukti terminal `loggedOut`; kemudian QR baru dibuka tanpa meminta operator
  mencari folder auth. State error membuka panel pemulihan otomatis dan tidak
  menampilkan kode internal sebagai copy utama. Direct console output Signal
  yang dapat membawa material ratchet dibuang sebelum socket dibuka.
- `npm run console:setup` mengatasi bootstrap saat runtime utama belum memiliki
  token Telegram. Ia memakai boundary Console yang sama dan control-plane
  sementara; credential live acceptance tetap berada pada storage lokal yang
  diabaikan Git.
- Console dan runner acceptance memakai lock credential lintas proses yang
  sama; instance setup kedua atau acceptance saat Console aktif gagal tertutup.
- Status WhatsApp mengenali hasil QR Baileys 7 dari material pair-success
  lengkap walau flag kompatibilitas `registered` tetap `false`. Identitas tanpa
  account/signature/signal identity tetap ditolak sebagai state parsial.
- Control plane mendukung standard/beta cohort, paket pilot personal/grup,
  quota override, expiry, consent evaluasi, dan mode grup.
- Entitlement reservation dan provider-attempt ledger tersedia satu proses.
  Delivery/discard mengikat debit logical pada owner+turn; physical attempt
  tetap dicatat untuk retry/fallback/gagal.
- Cost report membedakan reported dan estimated dengan provenance/cakupan;
  attempt historis tidak ditulis ulang saat katalog harga berubah.

## Batas dan defect aktif

- Console belum internet-ready: belum ada OIDC/MFA/RBAC/TLS, PostgreSQL,
  outbox/reconciliation, backup-restore drill, atau threat-model deployment.
- Tidak ada subscription, checkout, renewal, invoice, refund, webhook, atau SLA.
- Ledger dan repository tetap file lokal satu proses; billing provider belum
  diuji end-to-end pada kanal nyata.
- Audit lokal content-free sebelumnya membuktikan keempat credential
  acceptance tersedia. Session WhatsApp tester kemudian dicabut saat merotasi
  material uji; ia harus dipasangkan ulang melalui recovery Console sebelum
  acceptance berikutnya. Pairing durable tidak membuktikan reconnect, send,
  atau percakapan latest build end-to-end.
- Browser Edge desktop/mobile membuktikan recovery UI dari connection-closed
  menuju QR baru dengan adapter terkontrol; rotasi ulang nomor tester nyata
  memakai build perbaikan ini belum dilakukan.
- Website pengguna belum ada.

## Bukti dan pointer

- Kode: `src/console/`, `src/operations/channel-setup.ts`,
  `scripts/channel-setup-console.ts`, `src/core/control-plane-service.ts`,
  `src/core/usage-ledger-service.ts`, `src/core/telemetry-service.ts`.
- Tes: `tests/console-server.test.ts`, `tests/console-channel-setup.test.ts`,
  `tests/channel-setup.test.ts`, `tests/control-plane-service.test.ts`,
  `tests/usage-ledger-service.test.ts`, `tests/telemetry-service.test.ts`.
- Browser smoke: `npm run test:console-browser`.
- Keputusan: ADR-013. Operasi: `docs/operations/HARVY_CONSOLE.md`.
