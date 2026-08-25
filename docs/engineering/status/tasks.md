# Status — Tasks, Sessions, dan Waktu

Refreshed: 25 Agustus 2026 pada reminder relatif berdetik, commit-first task
receipt Telegram, dan focused live rerun. Delivery normal terbukti live; exact
crash window tetap belum diuji.

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
- Check-in satu kali hanya dibuat setelah pilihan pengguna. Model boleh menulis
  pertanyaan generik yang lebih natural dari jenis/tahap sesi, tetapi tidak
  menerima goal, summary, memori, atau riwayat; fallback tetap generik dan tidak
  ada nudge berulang secara implisit.
- Worker reminder dan check-in sama-sama menahan delivery selama consent AI
  ditarik; jadwal tidak dihapus dan dapat berjalan lagi setelah consent aktif.
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
- Copy model untuk reminder/check-in proaktif dibuat sebelum intent delivery
  menjadi `in_flight`, lalu hanya dipakai bila fingerprint kandidat masih sama;
  hal ini tidak memperlebar crash window delivery. Timeout/invalid/provider
  gagal memakai copy deterministik dan tidak menggagalkan jadwal.

## Batas dan defect aktif

- Fence sekarang memilih at-most-once, bukan at-least-once: duplikat ditahan,
  tetapi crash setelah persist intent dan sebelum receipt dapat membuat satu
  reminder tidak terkirim atau tetap berstatus ambigu. Belum ada reconciliation
  receipt eksternal yang dapat membedakan keduanya.
- Build full-acceptance 24 Agustus pada Telegram dan WhatsApp privat sudah
  membuktikan pembuatan task natural, penjadwalan reminder, perubahan timezone,
  start/stop sesi, serta penjadwalan check-in dari kanal sampai state produk dan
  balasan. Rerun 24 Agustus juga menunggu reminder satu menit dan check-in satu
  menit benar-benar jatuh tempo pada kedua transport sebelum cleanup. Ia belum
  melakukan crash di antara intent dan receipt, dan belum menguji tutoring
  penuh atau quiet-hours end-to-end pada kedua transport.
- Presenter receipt dan resolusi konflik planning/langkah-kecil sudah melewati
  acceptance pada build yang diuji di Telegram dan WhatsApp nyata. Pertanyaan proaktif
  saat reminder/check-in jatuh tempo sudah diterima live; privacy payload ragam
  sensitif dan fallback provider tetap baru terbukti otomatis. Presentasi task
  dengan reminder yang tidak lagi menulis `tanpa tenggat` sudah terlihat live
  di Telegram; exact tree WhatsApp belum direrun karena sesi Harvy A ditolak
  platform dengan reason 401.
- Full exploratory v3 menemukan reminder “1 menit lagi” tiba setelah 42,735
  detik. Akar terkuatnya adalah general understanding prompt yang hanya memberi
  model waktu sampai menit; parser, store, dan worker mempertahankan timestamp
  tanpa pembulatan. Prompt sekarang membawa detik dan melarang pembulatan
  durasi relatif. Focused live rerun menerima reminder setelah 66,1 detik, dan
  exact build sesudah patch receipt menerima reminder sekitar 64,6 detik setelah
  pemrosesan pesan pra-consent dilanjutkan.
- Focused rerun juga menemukan Telegram dapat mengirim acknowledgement “siap”
  sebelum task tersimpan serta copy yang berkontradiksi dengan kartu task.
  Telegram sekarang commit ke primary task store dahulu, lalu model hanya
  menyuarakan receipt dengan stable fact block code-owned. Exact live rerun
  membuktikan `/tugas`, kartu reminder, completion tombol, dan cleanup membaca
  state yang konsisten. WhatsApp privat sudah memakai urutan commit-first ini.
- Diagnostic provider live membaca tenggat natural `besok jam 7 malam`, dan
  evaluasi provider penuh lulus untuk save-task, reminder kosong, timezone,
  jawaban singkat sesi, serta selesai sesi eksplisit. Bersama acceptance live,
  ini masih belum membuktikan recovery receipt pada exact crash window atau
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
