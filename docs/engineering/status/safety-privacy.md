# Status — Safety dan Privacy

Verified: 6 Agustus 2026 pada baseline `43d8e16`; policy, route, dan adapter
palsu teruji otomatis. Untuk perubahan di area ini, baca bagian Constitution
dan invariant yang relevan sebelum mengubah kontraknya.

## Keadaan saat ini

- Triase berjalan paralel dengan understanding dan menerima konteks terbaru.
  Failure atau konflik klasifikasi naik ke keadaan dukungan yang belum pasti,
  bukan turun ke keadaan biasa.
- Giliran non-biasa/uncertain membuang route mutasi serta konteks session, lalu
  menjalankan response review. Jalur danger memiliki fallback khusus; tidak ada
  fail-open untuk mutasi.
- Emergency copy menyatakan batas ketersediaan layanan dan tidak mengasumsikan
  keluarga, sekolah, atau orang sekitar pasti aman.
- Hanya triase danger yang berhasil dan sudah delivered boleh menjadi safety
  note; retensi dibatasi, dukungan/failed triage tidak dicatat, dan full delete
  menghapus note tersebut.
- Consent onboarding menjelaskan penggunaan model/provider dan delegasi
  terbatas. Hanya pesan pertama boleh ditriase sebelum consent; bubble lain
  ditahan lokal.
- Export, withdrawal, forget, dan full deletion tersedia dengan owner scope.
  Confirmation token dipakai untuk withdrawal, full deletion, dan forget-all;
  export serta forget-one tidak memakai pending confirmation.

## Batas dan defect aktif

- Salah klasifikasi ganda pada memory sensitif belum tertutup penuh; jangan
  mengklaim consent pre-save selalu terjamin.
- Corpus safety/percakapan terbaru belum dijalankan penuh terhadap model nyata,
  dan jalur safety belum diuji ulang end-to-end lewat Telegram.
- Nomor/saluran bantuan selain copy deterministik dapat berasal dari model dan
  harus tetap melewati review.
- Pending bubble pra-consent masih in-memory dan dapat hilang saat restart.
- Tidak ada account linking; data tidak boleh digabung lintas kanal dari nama,
  nomor, atau identifier yang tampak sama.

## Bukti dan pointer

- Kode: `src/ai/safety.ts`, `src/core/safety-policy.ts`,
  `src/core/data-control-service.ts`, `src/bot/onboarding.ts`.
- Tes: `tests/safety.test.ts`, `tests/action-policy.test.ts`,
  `tests/data-control-service.test.ts`, `tests/onboarding.test.ts`.
- Kontrak: `docs/CONSTITUTION.md`, `docs/engineering/INVARIANTS.md`, ADR-008.
