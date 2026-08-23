# Status — Safety dan Privacy

Refreshed: 23 Agustus 2026 pada consent memori implicit lintas kanal dan probe
model nyata. Angka gerbang penuh terbaru dicatat di `docs/LOG.md`. Untuk
perubahan di area ini, baca bagian Constitution dan invariant yang relevan
sebelum mengubah kontraknya.

## Keadaan saat ini

- Emergency preflight lokal hanya mempercepat ACK untuk pernyataan bahaya
  langsung. Pada chat privat ia kini langsung masuk lane acute-safety tanpa
  compiler umum; triage dan mandatory danger review tetap menjadi authority
  pasca-consent. Pra-consent memakai copy lokal segera tanpa provider. Sinyal
  immediate-danger per bubble dan hasil boundary `urgent` bertahan sebagai
  metadata batch sampai handler; keduanya memaksa acute triage tetapi bukan
  disposition atau izin mutasi.
- Compiler privat dan ingress grup menghasilkan `RiskHint
  none|possible|strong`. Hint `none` melewati acute triage;
  `possible|strong` memanggil triage khusus. Kegagalan compiler juga memanggil
  triage fallback karena tidak adanya hint bukan bukti tenang. Ambient grup
  menggabungkan hint dengan planner dan parse keduanya secara independen.
- Disposition adalah `calm|support|danger|unavailable`. Outage tanpa
  bukti kuat tetap normal, bukti kuat yang belum terselesaikan memakai jalur
  konservatif, dan disagreement `strong + calm` tidak dibuka sebagai calm.
- Balasan support yang pasti biasanya langsung; support belum pasti dan danger
  direview. Danger memiliki fallback khusus. Izin mutasi dinilai per efek:
  tugas/reminder biasa yang eksplisit dapat berjalan saat aman secara aksi,
  begitu pula kontrol eksplisit berisiko rendah—termasuk hak data dan kontrol
  grup yang masih lolos authority—selama tidak ada danger atau bukti kuat
  unresolved. Kandidat memori baru, pending implisit, sesi, dan
  state percakapan umum hanya pada calm yang pasti.
- Acute triage tidak lagi menilai privacy. Pada grup, `contextPrivacy` terpisah
  hanya mengizinkan raw rolling context; null/sensitive no-retain tanpa UX
  support. Model ekstraksi dan classifier `memory-privacy` boleh membantu
  membentuk kandidat/prompt, tetapi tidak lagi menjadi authority write:
  seluruh kandidat implicit pada Telegram privat, WhatsApp privat, dan direct
  WhatsApp grup menunggu izin item-spesifik. Perintah explicit remember tetap
  harus dibuktikan dari raw turn dan exact candidate; credential selalu ditolak.
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
  ditahan lokal dengan batas bubble aslinya. Setelah consent, matcher lokal
  menilai tiap bubble sehingga marker konteks lama tidak memveto emergency
  baru.
- Runtime grup menyelesaikan authority+binding+notice sebelum model. Pesan
  ordinary tidak memanggil triage; support pasti tidak direview rutin. Bubble
  pra-join dibuang sebelum matcher/model dan revocation membatalkan assessment
  aktif maupun queued. Emergency lokal melewati debounce dan `direct_only`,
  dengan ACK tetap di luar FIFO tetapi acute triage/full turn tetap terikat
  pipeline, generation, serta authority. Bila triage unavailable atau tidak
  mengonfirmasi danger, emergency ambient tetap mendapat final support reply
  yang direview—bukan berhenti setelah ACK. Observation authority async
  diserialkan per runtime; alias default/durable dihidrasi sebelum admission,
  revision yang ditolak disettle hanya pada generation yang sama, dan mode
  runtime efektif diperiksa lagi tepat sebelum pending revalidation, delivery,
  serta fixed ACK.
- Telemetry tetap content-free; classifier `memory-privacy` dan
  `group-ingress` adalah overhead non-billable dan summary menyediakan
  `safeActionBlockedRate`.
- Export, withdrawal, forget, dan full deletion tersedia dengan owner scope.
  Confirmation token dipakai untuk withdrawal, full deletion, dan forget-all;
  export serta forget-one tidak memakai pending confirmation.

## Batas dan defect aktif

- Salah klasifikasi ekstraksi/privacy masih dapat melewatkan kandidat yang
  seharusnya ditawarkan atau meminta izin secara berlebihan, tetapi tidak lagi
  dapat mengotorisasi penyimpanan implicit. Jangan mengklaim deteksi sensitivitas
  sempurna atau bahwa semua fakta penting pasti menjadi kandidat.
- Evaluasi provider nyata terbaru lulus 60/60: 42 kasus percakapan dan 18 kasus
  boundary/interruption tanpa fallback atau kegagalan provider. Di dalamnya,
  cerita biasa/putus cinta tetap pada dukungan proporsional, sedangkan self-harm
  dan kekerasan akut masuk jalur bahaya. Corpus ini adalah sampel regresi, bukan
  pengukuran false-positive/false-negative yang terkalibrasi. Acceptance latest
  build pada akun Telegram dan WhatsApp nyata juga meloloskan satu skenario
  nonkrisis yang secara eksplisit ditandai sebagai simulasi melalui jalur
  transport penuh, tanpa mencemari jawaban planning sesudahnya. Itu membuktikan
  routing baseline, bukan penanganan krisis manusia nyata atau angka FP/FN.
- Emergency preflight bersifat closed-set pada batching Telegram privat dan
  WhatsApp grup; jangan menganggap hasil negatif sebagai bukti aman. Grup baru
  tetap harus menyelesaikan notice sebelum ACK/model.
- Nomor/saluran bantuan selain copy deterministik dapat berasal dari model dan
  harus tetap melewati review.
- Pending bubble pra-consent masih in-memory dan dapat hilang saat restart.
- Adaptive timing, selective safety, dan emergency ACK grup belum diuji pada
  grup WhatsApp nyata.
- Tidak ada account linking; data tidak boleh digabung lintas kanal dari nama,
  nomor, atau identifier yang tampak sama.

## Bukti dan pointer

- Kode: `src/ai/safety.ts`, `src/ai/group-ingress.ts`,
  `src/ai/memory-privacy.ts`,
  `src/core/safety-policy.ts`,
  `src/core/data-control-service.ts`, `src/bot/message-batcher.ts`,
  `src/bot/fast-path-policy.ts`, `src/bot/onboarding.ts`,
  `src/core/group-turn-service.ts`, `src/core/group-runtime-policy.ts`,
  `src/whatsapp/group-message-batcher.ts`.
- Tes: `tests/safety.test.ts`, `tests/action-policy.test.ts`,
  `tests/message-batcher.test.ts`, `tests/create-bot-flow.test.ts`,
  `tests/data-control-service.test.ts`, `tests/onboarding.test.ts`,
  `tests/group-ingress.test.ts`, `tests/group-turn-service.test.ts`,
  `tests/group-runtime-policy.test.ts`, `tests/group-message-batcher.test.ts`.
- Kontrak: `docs/CONSTITUTION.md`, `docs/engineering/INVARIANTS.md`, ADR-008,
  ADR-021, ADR-022, ADR-023, ADR-024.
