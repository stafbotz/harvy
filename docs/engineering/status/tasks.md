# Status — Tasks, Sessions, dan Waktu

Refreshed: 23 Agustus 2026 pada delivery fence, parity kanal privat, dan
acceptance akun Telegram/WhatsApp nyata. Scheduling baseline terbukti live;
delivery jatuh-tempo setelah crash tetap belum diuji.

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
- Mutasi task dan worker delivery diserialkan pada antrean owner yang sama.
  Reschedule, complete, cancel, dan remove tidak dapat saling menimpa dengan
  commit delivery yang sedang berjalan.
- Sebelum send, worker menyimpan intent delivery `in_flight`. Crash atau hasil
  send ambigu tidak di-retry otomatis, sehingga satu jadwal tidak sengaja
  mengirim duplikat. Status itu tampil sebagai delivery yang belum dapat
  dipastikan; pengguna dapat menjadwalkan ulang untuk membuat intent baru.

## Batas dan defect aktif

- Fence sekarang memilih at-most-once, bukan at-least-once: duplikat ditahan,
  tetapi crash setelah persist intent dan sebelum receipt dapat membuat satu
  reminder tidak terkirim atau tetap berstatus ambigu. Belum ada reconciliation
  receipt eksternal yang dapat membedakan keduanya.
- Acceptance akun nyata latest build pada Telegram dan WhatsApp privat sudah
  membuktikan pembuatan task natural, penjadwalan reminder, perubahan timezone,
  start/stop sesi, serta penjadwalan check-in dari kanal sampai state produk dan
  balasan. Ia belum menunggu reminder/check-in benar-benar jatuh tempo, belum
  melakukan crash di antara intent dan receipt, dan belum menguji tutoring
  penuh atau quiet-hours end-to-end pada kedua transport.
- Diagnostic provider live membaca tenggat natural `besok jam 7 malam`, dan
  evaluasi provider penuh lulus untuk save-task, reminder kosong, timezone,
  jawaban singkat sesi, serta selesai sesi eksplisit. Bersama acceptance live,
  ini masih belum membuktikan delivery jatuh-tempo/recovery receipt atau
  kualitas lintas bahasa yang luas.
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
