# Status — Console dan Control Plane

Verified: 25 Agustus 2026; HTTP tests, kontrak DOM, handshake session WhatsApp
nyata, serta smoke Microsoft Edge headless pada desktop/mobile tersedia.
Console adalah surface operator localhost, bukan website pengguna.

## Keadaan saat ini

- Server bind wajib `127.0.0.1` dan memakai token-to-session `HttpOnly`, CSRF,
  Host/Origin checks, CSP/no-CORS, schema/body/rate/version guards, serta audit.
- UI menampilkan provider/model yang dikonfigurasi tanpa key/base URL, usage,
  biaya, request, fallback, grup, enrollment, cohort, package, dan runtime mode.
- Tab Kanal memverifikasi token bot Telegram, memasangkan session penguji
  Telegram/WhatsApp lewat QR browser, menerima 2FA Telegram tanpa persist, dan
  mencabut session dengan logout-first. Token Telegram tersimpan terpisah dari
  session penguji; status API dan audit tidak membawa secret, identifier, atau
  payload QR.
- Tab Kanal membedakan **Layanan** dan **Pengujian** sebagai dua tab halaman
  dengan lebar setara. Mode setup tidak membawa sidebar satu-item; tepat satu
  lingkungan dan satu panel pengelolaan terlihat pada satu waktu. Detail
  credential baru muncul setelah tindakan **Kelola**, bukan otomatis memenuhi
  halaman saat ada masalah.
  Token bot utama dikelola store AES-GCM lokal, dapat dimigrasikan atomik dari
  satu entri `.env` legacy, dan diverifikasi langsung ke Telegram. Snapshot
  hanya membawa source/phase/runtime/restart; token tidak pernah kembali ke
  browser. Credential utama tidak dipakai ulang oleh acceptance dan token yang
  identik ditolak. Checklist dan flow identitas memperlihatkan empat prasyarat
  uji secara terpisah.
- Tab Layanan juga mengelola armada WhatsApp utama tanpa `WHATSAPP_ACCOUNTS` di
  environment. Banyak akun memakai alias operasional dan lifecycle durable
  `pending|active|removing`; hanya akun active masuk composition runtime.
  Pairing, replace, probe, dan revoke tersedia per akun, nomor/JID tidak pernah
  masuk snapshot, dan identitas yang duplikat terhadap armada maupun acceptance
  ditolak. Migrasi legacy memverifikasi session+nomor sebelum menulis store
  terenkripsi dan menghapus tiga field `.env` secara atomik. Mutasi armada dan
  akses file credential diserialkan; polling tidak menyentuh folder session
  yang sedang dimutasi, sehingga pairing/revoke tidak berlomba dengan probe
  atau penulisan token Telegram pada file terenkripsi yang sama.
- Surface kanal mempunyai state setup dan operasional yang berbeda. Saat belum
  lengkap, badge tab dan tindakan **Selesaikan** menunjukkan identitas yang perlu
  ditangani tanpa membuka form secara otomatis. Setelah empat identitas tersedia dan kedua session WhatsApp diterima dalam
  pemeriksaan terbaru, layar utama menunjukkan ringkasan `Siap untuk pengujian langsung`
  dan alur Penguji → Harvy untuk Telegram/WhatsApp; form
  secret, QR, serta tombol pairing berada di pengaturan tertutup. Ringkasan ini
  tidak mengklaim reconnect atau pengiriman live sudah terbukti. Rotasi token
  dan pencabutan session tetap tersedia melalui progressive disclosure.
- Readiness WhatsApp tidak lagi berasal dari keberadaan `creds.json`. Console
  menjalankan handshake bounded, membedakan `accepted`, `rejected`, dan
  `unreachable`, mencatat waktu pemeriksaan tanpa identifier, serta merefresh
  hasil maksimal setiap lima menit atau saat operator meminta. Credential lokal
  yang mendapat 401 tetap terlihat sebagai tersimpan tetapi UI menampilkan
  **Sesi ditolak**, membuka panel pemulihan, dan tidak menghitung kanal siap.
  Gangguan jaringan menampilkan **Belum terverifikasi** tanpa memaksa pairing.
- Pengelolaan WhatsApp mempunyai alur **Pasangkan ulang** logout-first. Session
  lama dihapus lokal hanya setelah logout berhasil atau WhatsApp mengembalikan
  bukti terminal `loggedOut`; kemudian QR baru dibuka tanpa meminta operator
  mencari folder auth. State error membuka panel pemulihan otomatis dan tidak
  menampilkan kode internal sebagai copy utama. Direct console output Signal
  yang dapat membawa material ratchet dibuang sebelum socket dibuka.
- `npm run console:setup` mengatasi bootstrap saat runtime utama belum memiliki
  token Telegram. Ia memakai boundary Console yang sama dan control-plane
  sementara; credential utama serta live acceptance tetap berada pada store
  lokal berbeda yang diabaikan Git. Proses ini juga memegang runtime lock utama,
  jadi mutasi session layanan hanya tersedia ketika runtime Harvy berhenti.
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
  outbox/reconciliation, backup operasional yang dikelola Console, atau
  threat-model deployment. Drill backup lokal create→verify→restore sudah
  lulus, tetapi belum memakai kunci durable/media eksternal/restore lintas mesin.
- Tidak ada subscription, checkout, renewal, invoice, refund, webhook, atau SLA.
- Ledger dan repository tetap file lokal satu proses; billing provider belum
  diuji end-to-end pada kanal nyata.
- Audit lokal content-free membuktikan keempat credential acceptance tersedia.
  Keduanya kemudian dipakai untuk full build Telegram/WhatsApp privat yang diuji,
  probe percakapan sesudah crash/restart, dan scope grup WhatsApp dua-akun.
  Pairing durable sendiri tetap bukan bukti delivery; receipt acceptance yang
  terpisah menjadi bukti tersebut.
- Browser Edge desktop/mobile membuktikan transisi sesi valid→ditolak→valid,
  recovery dari connection-closed menuju QR baru, dan tidak memantulkan kode
  internal. Smoke juga mengunci race restore-session versus login operator,
  perpindahan tab Layanan/Pengujian lewat mouse/keyboard, kesetaraan lebar tab,
  sidebar setup yang benar-benar hilang, satu panel aktif, dan hasil pemeriksaan
  berwarna warning bila koneksi perlu perhatian. Smoke memblokir dua request
  QR, membuktikan error terlihat, lalu memulihkan SVG representatif yang
  panjang melalui `fetch`, validasi struktur, dan penyisipan inline tanpa
  pairing baru. Audit `external-qr` juga dapat membuktikan ukuran, warna, dan
  modul SVG pada pairing WhatsApp nyata tanpa mencetak payload. Smoke armada
  layanan membuka panel, memeriksa alias tanpa nomor, mengubah lalu mengembalikan
  sakelar privat, dan mengunci kesimetrian kartu. Audit `external-service` pada
  instalasi nyata membuktikan state legacy migratable di desktop/mobile; migrasi
  UI kemudian memindahkan satu akun aktif ke store Console dan menghapus tiga
  field daftar akun dari `.env` tanpa revoke. Audit ulang sesudah migrasi
  membuktikan session WhatsApp layanan `ready`; audit browser read-only current
  build juga memberi ringkasan acceptance WhatsApp `Sesi_valid`. Bukti ini hanya
  menyatakan handshake session, belum journey pesan penguji→Harvy.
- Website pengguna belum ada.

## Bukti dan pointer

- Kode: `src/console/`, `src/operations/channel-setup.ts`,
  `scripts/channel-setup-console.ts`, `src/core/control-plane-service.ts`,
  `src/core/usage-ledger-service.ts`, `src/core/telemetry-service.ts`.
- Tes: `tests/console-server.test.ts`, `tests/console-channel-setup.test.ts`,
  `tests/channel-setup.test.ts`, `tests/control-plane-service.test.ts`,
  `tests/usage-ledger-service.test.ts`, `tests/telemetry-service.test.ts`.
- Browser smoke deterministik: `npm run test:console-browser`; audit credential
  dan handshake nyata read-only: `npm run test:console-browser:live`; audit
  renderer pada QR pairing aktif: `npm run test:console-browser:external-qr`;
  audit tab layanan pada Console setup aktif:
  `npm run test:console-browser:external-service`.
- Keputusan: ADR-013. Operasi: `docs/operations/HARVY_CONSOLE.md`.
