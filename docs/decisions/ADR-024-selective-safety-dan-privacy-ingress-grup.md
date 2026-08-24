# ADR-024: Selective Safety dan Privacy Ingress Grup

- Status: Accepted
- Tanggal: 8 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-009`, `ADR-011`, `ADR-016`, `ADR-021`, `ADR-022`, `ADR-023`
- Supersesi parsial: screening risk+privacy gabungan dan blanket triage/review
  pada seluruh pesan WhatsApp grup

## Amendemen 24 Agustus 2026

Bagian keputusan 6 disupersede untuk durable member memory. Grup tidak
mewarisi authority onboarding kanal privat. Kandidat member-local implicit kini
dilewati tanpa write dan tanpa prompt izin; perintah remember explicit tetap
harus cocok dengan raw turn dan exact candidate, credential tetap ditolak, dan
shared room memory tetap membutuhkan konfirmasi admin. Karena tidak ada lagi
jalur proposal implicit, classifier `memory-privacy` juga dipensiunkan dari
runtime grup. `contextPrivacy` untuk retensi raw rolling context tetap berlaku
tanpa perubahan.

## Konteks

Jalur grup sebelumnya memakai triase gabungan pada setiap direct maupun
ambient message. Satu output sekaligus menentukan acute safety, gaya balasan,
dan retensi raw context. Akibatnya outage triase tampak seperti kebutuhan
dukungan, cerita personal dapat tercampur dengan risiko akut, dan semua pesan
membayar model safety. Priority triage juga dapat dimulai sebelum core sendiri
menyelesaikan revalidasi membership.

Privacy raw context dua jam dan privacy memori durable bukan authority yang
sama. Setiap pesan merupakan kandidat raw-context, sedangkan hanya hasil
ekstraksi tertentu menjadi kandidat memori durable. Keduanya harus gagal
tertutup tanpa membuat outage privacy terlihat sebagai krisis.

## Keputusan

1. Core harus membuktikan `social.read`, binding akun aktif, dan notice versi
   live sebelum isi pesan boleh mencapai assessment/preflight model. Authority
   direvalidasi lagi di FIFO dan tepat sebelum mutasi repository. Bubble
   pra-join dalam batch campuran dibuang sebelum matcher, ACK, atau model;
   revocation membatalkan assessment aktif dan menghapus yang masih mengantre.
   Observation authority async diserialkan per runtime; revision hanya dikomit
   oleh observation authorized/live. Alias default/durable dihidrasi sebelum
   admission, dan observation yang ditolak disettle hanya pada generation yang
   sama.
2. Normal ingress menghasilkan dua field independen: `riskHint` acute-only dan
   `contextPrivacy ordinary|sensitive` untuk raw rolling context. Direct memakai
   classifier ringan; ambient membawa kedua field dalam envelope planner agar
   tidak menambah call. Parser membaca plan, hint, dan privacy secara independen.
3. Field hilang/rusak menjadi `null`, bukan `none` atau `ordinary`. Risk hint
   null memanggil acute triage fallback. Privacy null atau sensitive menolak
   retensi message dan reply, tetapi tidak mengubah gaya percakapan menjadi
   support.
4. `RiskHint none` melewati triage. `possible|strong`, emergency lokal, dan
   kelanjutan marker risiko memanggil triage. Hasil direkonsiliasi menjadi
   `calm|support|danger|unavailable`: outage tanpa bukti kuat tetap normal,
   sedangkan bukti kuat yang belum terselesaikan memakai support konservatif.
5. Support yang pasti tidak direview rutin. Danger dan support yang tidak pasti
   tetap direview fail-closed. Permission per efek dari ADR-022 berlaku juga di
   grup; kontrol eksplisit berisiko rendah—termasuk hak data, julukan, dan
   proposal room berotoritas—tidak diblokir hanya karena support yang pasti,
   tetapi authority grup tidak pernah digantikan output model.
6. `contextPrivacy` bukan consent authority memori durable. Classifier
   `memory-privacy` hanya berjalan ketika ekstraksi direct benar-benar membuat
   kandidat; jenis personal, classifier null/timeout/error, atau hasil sensitive
   semuanya meminta consent. Tidak ada kandidat berarti tidak ada call privacy.
7. Emergency lokal berpresisi tinggi melewati debounce grup dan dapat mengirim
   fixed acknowledgment setelah authority+binding+notice. Full triage, reviewer,
   final reply, dan mutasi tetap melalui pipeline dan FIFO. ACK dan assessment
   mempunyai reservation terpisah agar ACK cepat tidak menelan triase. Emergency
   memulai acute triage tanpa menunggu ingress compiler/memory extraction;
   direct yang mengantre dapat memakai risk preflight, sedangkan ambient biasa
   tetap memakai satu envelope planner di FIFO. Priority assessment dibatasi
   empat aktif dan antrean 32, dideduplikasi per message ID, dan dibatalkan oleh
   generation/`AbortSignal`. Emergency ambient yang direkonsiliasi sebagai
   support tetap menerima final safety reply yang direview; ia tidak berhenti
   pada ACK hanya karena triage unavailable atau tidak mengonfirmasi danger.
8. Mode `direct_only` menerima emergency lokal meski tanpa tag/reply. Mode
   `disabled` dan `paused` tetap fail-closed. Kutipan, negasi, histori, dan
   pembahasan umum tidak lolos matcher lokal. Pada batch multi-bubble matcher
   menilai setiap bubble sendiri: marker konteks pada bubble lama tidak boleh
   membatalkan pernyataan emergency eksplisit pada bubble berikutnya. Admission
   ingress bukan authority permanen: mode efektif dibaca ulang tepat sebelum
   pending model revalidation, fixed ACK, dan delivery; work dari snapshot lama
   dibatalkan bila admission terbaru bukan `process`. Emergency eksplisit tetap
   diizinkan pada `direct_only`.
9. Purpose `group-ingress` adalah overhead non-billable dan dihitung sebagai
   compiler/understanding. Telemetry/log tetap content-free dan tidak menyimpan
   hint, privacy label, isi pesan, atau identifier timing mentah.

## Konsekuensi

Positif:

- pesan ordinary tidak lagi membayar acute triage atau reply reviewer;
- outage safety dan outage privacy mempunyai fallback berbeda yang proporsional;
- raw context, memori durable, dan mutasi grup mempunyai authority terpisah;
- emergency eksplisit tidak tertahan debounce atau paket `direct_only`;
- burst ordinary tidak memenuhi antrean triage prioritas.

Trade-off dan batas:

- direct tetap memakai satu call ingress dan satu call understanding; ambient
  menggabungkan ingress dengan planner;
- hasil privacy dari snapshot direct pre-FIFO tidak menjadi authority retensi;
  queued direct itu gagal tertutup ke no-retain, sedangkan risk hint tetap dapat
  dipakai untuk routing cepat;
- classifier privacy/risk tetap dapat salah, sehingga local matcher, no-retain
  unknown, dedicated memory classifier, reviewer, dan mutation guard tetap
  diperlukan;
- priority preflight hanya tersedia setelah binding+notice live; grup baru
  mengirim notice lebih dulu. Risiko ambient yang tidak lolos matcher lokal
  baru diketahui ketika envelope planner mencapai FIFO;
- kualitas classifier dan timing ACK belum diuji di grup WhatsApp nyata.

## Verifikasi

Tes parser mengunci field independen dan plan-invalid+strong-hint. Tes service
mengunci selective triage, unavailable evidence-aware, conditional review,
no-retain privacy tanpa UX support, candidate-only memory privacy, filter
pra-join sebelum model, pembatalan revocation aktif/queued, explicit low-risk
control, strong-hint marker merge, urgent ACK/assessment dedupe terpisah,
ambient emergency ACK+final reviewed reply, ambient one-envelope, ordinary
burst tanpa preflight, concurrency maksimum empat, authority observation FIFO,
cold-start alias durable, rejected-observation settlement, serta mode flip saat
pending, memory read, active delivery, dan fixed ACK. Tes batcher/runtime
mengunci emergency bypass, full-turn FIFO, serta mode
`direct_only|paused|disabled`. Hasil gerbang repository dicatat di
`docs/LOG.md`.
