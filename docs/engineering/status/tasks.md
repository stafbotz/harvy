# Status — Tasks, Sessions, dan Waktu

Refreshed: 22 Agustus 2026 pada semantic task/session authority; service dan
adapter teruji otomatis, sebagian besar jalur terbaru belum diuji Telegram
nyata.

## Keadaan saat ini

- Task hanya dibuat langsung dari `SemanticOperation` save yang explicit,
  mempunyai evidence raw-turn dan isi konkret; task tersirat memakai
  confirmation token owner-scoped dan sekali pakai. Explicitness tidak lagi
  ditentukan oleh daftar verba Indonesia.
- Prioritas deterministik tersedia. Reminder memvalidasi waktu lampau dan jam
  tenang; worker menunggu owner tidak sedang mengetik/diproses.
- Satu sesi persisten per pengguna tersedia sebagai konteks lunak. Continue,
  stuck, done, dan cancel memakai meaning closed-set ketika sesi aktif; done/
  cancel wajib explicit, sementara goal overlap dan jawaban formula tetap
  fallback struktural. Tutoring menjalankan tahap
  `ukur → coba → petunjuk → penjelasan → coba lagi`.
- Check-in satu kali hanya dibuat setelah pilihan pengguna, memakai notifikasi
  generik, dan tidak menjadwalkan nudge berulang secara implisit.
- Zona WIB/WITA/WIT, fallback IANA lama, jam tenang, status sesi, serta agenda
  internal Harvy tersedia. Agenda eksternal tidak ada.
- Harvy dapat menyusun draf bantuan manusia tetapi tidak mengirimkannya.

## Batas dan defect aktif

- Reminder dan check-in mempunyai jendela at-least-once: crash setelah delivery
  tetapi sebelum commit dapat menyebabkan retry.
- Worker terbaru, timezone/quiet-hours, tutoring penuh, dan check-in belum diuji
  end-to-end lewat Telegram.
- Kualitas semantic task/session lintas bahasa baru dibuktikan fixture otomatis,
  bukan provider live.
- `calendar.agenda` hanya membaca task/reminder/check-in Harvy untuk 1–31 hari;
  tidak terhubung ke Google/Outlook/device calendar dan tidak dapat memutasi
  event eksternal.

## Bukti dan pointer

- Kode: `src/core/task-service.ts`, `src/core/session-service.ts`,
  `src/reminders/`, `src/core/time-policy.ts`.
- Tes: `tests/task-service.test.ts`, `tests/session-service.test.ts`,
  `tests/reminder-worker.test.ts`, `tests/checkin-worker.test.ts`,
  `tests/time-policy.test.ts`.
- Keputusan: ADR-002, ADR-008, ADR-017, ADR-044.
