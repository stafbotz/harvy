# ADR-022: Selective Safety Routing dan Privacy Memory

- Status: Accepted
- Tanggal: 8 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-003`, `ADR-004`, `ADR-008`, `ADR-020`, `ADR-021`, Konstitusi
  Pasal 3.8, 3.9, dan 3.13
- Supersesi parsial: triase privat pada setiap free-text, timeout yang selalu
  menjadi `dukungan`, privacy flag milik acute triage, review seluruh support,
  global mutation gate untuk setiap keadaan emosional non-calm, dan triase
  umum untuk jawaban pending closed-set

## Amendemen 24 Agustus 2026

Bagian keputusan 5 dan konsekuensi classifier privasi disupersede oleh
Konstitusi v0.8 serta ADR-006 yang diamendemen. Consent onboarding privat versi
8 kini menjadi authority auto-memory ordinary maupun personal; tidak ada izin
atau tombol per-item. Classifier `memory-privacy` dipensiunkan dari runtime
karena tidak lagi menentukan authority. Model understanding hanya mengusulkan
kandidat, primary tetap menjaga scope/lifecycle/dedupe/limit dan menolak
credential, sedangkan acknowledgement hanya boleh muncul sesudah commit.
Purpose telemetry lama tetap dapat dibaca sebagai data historis.

## Konteks

Pipeline privat lama menjalankan understanding dan triase secara paralel pada
setiap giliran. Satu classifier sekaligus menilai bahaya akut dan sensitivitas
privasi. Timeout dipetakan langsung ke `dukungan`; semua support direview dan
semua mutasi diblokir. Desain itu melindungi kasus ketika triase gagal pada
pesan berisiko, tetapi juga membuat gangguan provider tampak sebagai bukti
krisis, memberi UX darurat pada false positive, dan memblokir permintaan tugas
biasa hanya karena pengguna sedang tertekan.

Phase A sudah menyediakan denominator per giliran, rate triase/review/fallback,
dan p50/p95 tanpa isi percakapan. ADR-021 sudah menambahkan emergency preflight,
boundary local-first, serta fast path waktu/identitas. Perubahan berikutnya
harus menjadi evolusi policy yang dapat diuji, bukan pelemahan safety atau
rewrite adapter.

## Keputusan

1. Compiler privat menghasilkan `RiskHint` terstruktur dengan level
   `none|possible|strong`, kategori acute-risk tertutup, dan confidence. Hint
   hanya data routing; disposition akhir tetap milik policy setelah triase.
2. Emergency lokal berpresisi tinggi langsung masuk lane safety: ACK tetap
   dikirim sebelum debounce, compiler umum dilewati, dan acute triage tetap
   wajib pada chat pasca-consent. Pada pesan pertama pra-consent, copy safety
   deterministik dikirim langsung tanpa menunggu atau mengirim teks ke provider.
   Hasil lokal tidak pernah memberi authority mutasi.
3. Giliran privat dengan hint `none` melewati acute triage. Hint
   `possible|strong` menjalankan triage khusus. Jika compiler gagal, triage
   dijalankan sebagai fallback karena ketiadaan hint bukan bukti tenang.
4. Policy memakai `RiskDisposition = calm|support|danger|unavailable`.
   `possible + calm` kembali normal; `strong + calm` memakai support belum
   pasti; outage tanpa bukti kuat tetap pada jalur normal; outage dengan bukti
   kuat memakai jalur support konservatif. `strong + support` juga dianggap
   high-consequence uncertainty dan direview. Timeout tidak lagi identik
   dengan krisis.
5. Acute triage privat tidak menilai privasi. Classifier `memory-privacy`
   hanya dipanggil bila compiler benar-benar menghasilkan kandidat memori.
   Jenis `personal`, hasil sensitif, schema invalid, timeout, atau error tetap
   gagal tertutup ke consent; tidak ada penyimpanan sensitif diam-diam.
6. Balasan calm tidak direview. Support yang pasti biasanya dikirim langsung.
   Support yang belum pasti direview, dan danger selalu direview. Kegagalan
   reviewer tetap memakai fallback deterministik sesuai level.
7. Izin dinilai per efek. Tugas/reminder biasa serta kontrol eksplisit milik
   pengguna—termasuk melihat, memperbaiki, mengekspor, melupakan, menghapus,
   atau menarik consent—boleh berjalan pada support yang pasti atau outage
   dengan bukti lemah. Memory candidate baru, pending implisit, sesi, tawaran,
   dan mutasi state percakapan umum hanya berjalan pada calm yang pasti.
   Danger, emergency lokal, dan bukti kuat yang belum terselesaikan tetap
   memblokir efek operasional yang bersaing dengan lane safety.
8. Nilai pending closed-set untuk tanggal/waktu/durasi/pilihan melewati
   compiler dan triase umum setelah emergency preflight negatif. Edit memori,
   konfirmasi destruktif, dan `agent-input` tanpa schema jawaban terikat tidak
   masuk fast path ini. Acknowledgment dingin dari closed set sempit juga
   mendapat balasan lokal tanpa model umum.
9. Port grup belum dimigrasikan dalam change set ini. Ia tetap meminta triase
   gabungan risk+privacy pada setiap giliran agar raw context dan memory grup
   tidak menjadi lebih permisif. Migrasi grup harus memisahkan privacy gate
   lebih dulu dan membawa tes retensi/ambient tersendiri.
10. Telemetry menambah purpose `memory-privacy` sebagai overhead non-billable
    serta signal/rate `safe-action-blocked`, tetapi tetap content-free. Harvy
    tidak menyimpan label risiko per pengguna untuk menghitung false
    positive/negative; metrik kualitas itu berasal dari corpus sintetis
    berlabel dan evaluasi manual yang disetujui.

## Konsekuensi

Positif:

- mayoritas pesan biasa tidak lagi membayar acute triage atau safety reviewer;
- outage classifier tidak menghasilkan UX krisis tanpa bukti sebelumnya;
- cerita pribadi tidak lagi otomatis dianggap acute-risk;
- distress tidak menjadi tombol mati global untuk tugas biasa yang eksplisit;
- hak akses, koreksi, ekspor, penghapusan, dan penarikan consent tidak hilang
  hanya karena emotional context support;
- danger dan disagreement kuat tetap fail-closed serta direview.

Trade-off dan batas:

- selective routing bergantung pada recall compiler; kegagalan compiler karena
  transport/schema ditutup dengan triage fallback, tetapi false negative model
  yang valid tetap harus diukur lewat corpus;
- classifier privasi tambahan dapat menambah satu model call hanya pada giliran
  yang memiliki kandidat memori;
- quick acknowledgment hanya aktif pada chat dingin agar tidak memotong
  kesinambungan episode;
- debounce adaptif, selective routing grup, dan platform selain Telegram privat
  tetap change set Phase B terpisah.

## Verifikasi

Tes policy mengunci matriks hint/triage/disposition, unavailable, disagreement,
review kondisional, dan permission per efek. Tes adapter mengunci emergency
tanpa compiler, compiler-failure fallback, task aman saat outage/support,
pending closed-set, quick acknowledgment, serta pemisahan privacy memory. Tes
Conversation mengunci prompt acute-only, port grup eksplisit, dan usage purpose
privacy yang bukan safety-critical. Hasil gerbang repository dicatat di
`docs/LOG.md`.
