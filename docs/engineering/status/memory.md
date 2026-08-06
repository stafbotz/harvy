# Status — Memory dan Data

Verified: 6 Agustus 2026 pada baseline `43d8e16`; repository lokal dan service
teruji otomatis. Baca untuk memory, history, compaction, storage, atau kontrol
data yang bukan policy safety.

## Keadaan saat ini

- Task, history, profile, session, telemetry, ledger, dan agent checkpoint
  memakai adapter file atomik satu proses. Memory/insight memakai Markdown.
- Riwayat mentah terbaru dibatasi 24 giliran. Setelah threshold, awalan kontigu
  dipadatkan menjadi episode terstruktur dengan source sequence/hash, CAS,
  generation guard, retensi maksimum, dan drain shutdown.
- Memori privat mempunyai lima jenis, notification+rollback, list/edit/forget,
  serta token confirmation untuk data personal/sensitif dan forget-all.
- Memory grup member-local dan shared-room terpisah dari state privat; detail
  authority kanal ada di status WhatsApp.
- Ekspor mencakup state pengguna yang didukung. Full deletion memblokir request
  baru, menunggu background write, lalu menghapus repository terkait termasuk
  checkpoint dan telemetry tersimpan.
- Consent withdrawal mempertahankan task/memory/session/check-in tetapi menahan
  pemrosesan yang memerlukan consent.

## Batas dan defect aktif

- Storage tetap single-process dan belum PostgreSQL. Crash dapat menyisakan
  lock stale; aturan penghapusan lock ada di status platform.
- Dua model dapat sama-sama salah menilai isi sensitif sebagai biasa sehingga
  consent sebelumnya dapat terlewat. Notification/forget membatasi dampak tetapi
  bukan pengganti consent.
- `forget one` menghapus semantic record, tetapi belum membersihkan sumber sama
  dari recent history/episode. Episode belum memisahkan actor/trust per klaim.
- Memori privat belum mempunyai provenance, revision, valid-time,
  supersession, atau cap per jenis; karena itu tidak boleh menjadi authority.
- Ketepatan ringkasan episode masih bergantung model dan threshold belum
  token-aware.

## Bukti dan pointer

- Kode: `src/core/memory-service.ts`, `src/core/history-service.ts`,
  `src/core/episodic-compaction.ts`, `src/storage/`.
- Tes: `tests/memory-service.test.ts`, `tests/history-service.test.ts`,
  `tests/episode-summary.test.ts`, `tests/data-control-service.test.ts`.
- Keputusan: ADR-006, ADR-007, ADR-014, ADR-018.

