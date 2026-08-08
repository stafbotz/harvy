# Status — Safety dan Privacy

Verified: 8 Agustus 2026 pada working tree Phase B di atas `306df42`;
`npm run check`, build, dan `npm run context:check` PASS; tes terarah PASS 138
test / 13 suite; `npm test` PASS 695 test / 97 suite. Untuk perubahan di area
ini, baca bagian Constitution dan invariant yang relevan sebelum mengubah
kontraknya.

## Keadaan saat ini

- Emergency preflight lokal hanya mempercepat ACK untuk pernyataan bahaya
  langsung. Pada chat privat ia kini langsung masuk lane acute-safety tanpa
  compiler umum; triage dan mandatory danger review tetap menjadi authority
  pasca-consent. Pra-consent memakai copy lokal segera tanpa provider.
- Compiler privat menghasilkan `RiskHint none|possible|strong`. Hint `none`
  melewati acute triage; `possible|strong` memanggil triage khusus. Kegagalan
  compiler juga memanggil triage fallback karena tidak adanya hint bukan bukti
  tenang.
- Disposition privat adalah `calm|support|danger|unavailable`. Outage tanpa
  bukti kuat tetap normal, bukti kuat yang belum terselesaikan memakai jalur
  konservatif, dan disagreement `strong + calm` tidak dibuka sebagai calm.
- Balasan support yang pasti biasanya langsung; support belum pasti dan danger
  direview. Danger memiliki fallback khusus. Izin mutasi dinilai per efek:
  tugas/reminder biasa yang eksplisit dapat berjalan saat aman secara aksi,
  begitu pula kontrol eksplisit atas data sendiri selama tidak ada danger atau
  bukti kuat unresolved. Kandidat memori baru, pending implisit, sesi, dan
  state percakapan umum hanya pada calm yang pasti.
- Acute triage privat tidak lagi menilai privacy. Classifier `memory-privacy`
  hanya dipanggil untuk kandidat memori; jenis personal, hasil sensitif, parse
  invalid, timeout, atau error semuanya meminta consent.
- Jawaban pending berbentuk tanggal/waktu/durasi/pilihan dari closed set serta
  acknowledgment dingin yang sempit mempunyai fast path setelah emergency
  preflight negatif. Edit memori, konfirmasi destruktif, dan `agent-input`
  tanpa schema jawaban terikat tetap di luar fast path tersebut.
- Emergency copy menyatakan batas ketersediaan layanan dan tidak mengasumsikan
  keluarga, sekolah, atau orang sekitar pasti aman.
- Hanya triase danger yang berhasil dan sudah delivered boleh menjadi safety
  note; retensi dibatasi, dukungan/failed triage tidak dicatat, dan full delete
  menghapus note tersebut.
- Consent onboarding menjelaskan penggunaan model/provider dan delegasi
  terbatas. Hanya pesan pertama boleh ditriase sebelum consent; bubble lain
  ditahan lokal.
- Runtime grup masih memakai screening risk+privacy gabungan serta review lama
  pada semua pesan. Ini batas migrasi sengaja agar retensi konteks grup tidak
  menjadi lebih permisif sebelum privacy gate grup dipisahkan.
- Telemetry tetap content-free; classifier `memory-privacy` adalah overhead
  non-billable dan summary menyediakan `safeActionBlockedRate`.
- Export, withdrawal, forget, dan full deletion tersedia dengan owner scope.
  Confirmation token dipakai untuk withdrawal, full deletion, dan forget-all;
  export serta forget-one tidak memakai pending confirmation.

## Batas dan defect aktif

- Salah klasifikasi ekstraksi dan classifier privacy pada memory sensitif masih
  dapat terjadi; jangan mengklaim consent pre-save selalu terjamin.
- Corpus safety/percakapan terbaru belum dijalankan penuh terhadap model nyata,
  dan jalur safety belum diuji ulang end-to-end lewat Telegram.
- Emergency preflight bersifat closed-set dan baru ada pada batching Telegram
  privat pasca-consent; jangan menganggap hasil negatif sebagai bukti aman.
- Nomor/saluran bantuan selain copy deterministik dapat berasal dari model dan
  harus tetap melewati review.
- Pending bubble pra-consent masih in-memory dan dapat hilang saat restart.
- Selective safety routing grup dan debounce adaptif belum diimplementasikan.
- Tidak ada account linking; data tidak boleh digabung lintas kanal dari nama,
  nomor, atau identifier yang tampak sama.

## Bukti dan pointer

- Kode: `src/ai/safety.ts`, `src/ai/memory-privacy.ts`,
  `src/core/safety-policy.ts`,
  `src/core/data-control-service.ts`, `src/bot/message-batcher.ts`,
  `src/bot/fast-path-policy.ts`, `src/bot/onboarding.ts`.
- Tes: `tests/safety.test.ts`, `tests/action-policy.test.ts`,
  `tests/message-batcher.test.ts`, `tests/create-bot-flow.test.ts`,
  `tests/data-control-service.test.ts`, `tests/onboarding.test.ts`.
- Kontrak: `docs/CONSTITUTION.md`, `docs/engineering/INVARIANTS.md`, ADR-008,
  ADR-021, ADR-022.
