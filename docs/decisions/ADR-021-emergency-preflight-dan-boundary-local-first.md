# ADR-021: Emergency Preflight dan Boundary Local-First

- Status: Accepted
- Tanggal: 8 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-004`, `ADR-007`, `ADR-008`, `ADR-017`, `ADR-020`, Konstitusi
  Pasal 3.8
- Supersesi parsial: kewajiban classifier model pada setiap free-text dan
  penghapusan mutlak seluruh sinyal bahaya lokal

> **Supersesi parsial lanjutan 8 Agustus 2026.**
> [`ADR-022`](ADR-022-selective-safety-routing-dan-privacy-memory.md)
> menyelesaikan selective triage, `unavailable`, privacy separation,
> conditional review, pending/ack fast path, dan izin per efek untuk Telegram
> privat. Port grup dan debounce adaptif tetap belum dimigrasikan.

## Konteks

Baseline Phase A menunjukkan bahwa boundary adalah satu logical model call pada
setiap batch yang tidak sedang menjawab pending. Akibatnya acknowledgment,
pilihan pendek, fragmen tata bahasa, pertanyaan waktu, dan fakta identitas
produk membayar classifier walaupun bentuknya sudah diketahui kode.

Lebih penting, `urgent` hanya dapat berasal dari classifier yang baru dimulai
sesudah debounce 650 milidetik. Jika classifier menggantung, pesan bahaya yang
eksplisit menunggu deadline fail-safe. Ini tidak cocok dengan target Phase B:
boundary model harus menjadi fallback ambigu dan bahaya langsung harus dapat
diakui sebelum model tersedia.

Kontrak lama sengaja menghapus pagar bahaya berbasis daftar kata karena pagar
yang terlalu luas dapat menganggap emosi biasa sebagai krisis. Pelajaran itu
tetap berlaku. Solusinya bukan classifier lokal umum, melainkan sinyal sempit
yang hanya mempercepat acknowledgment dan tidak menentukan disposition akhir.

## Keputusan

1. `hasExplicitImmediateDangerSignal` adalah pure policy tersendiri dari policy
   bentuk giliran. Ia hanya menerima pernyataan langsung dengan subjek/korban
   yang jelas dan kedekatan waktu yang eksplisit, termasuk self-harm langsung,
   kekerasan segera, abuse aktif, atau pernyataan sedang tidak aman.
2. Kutipan, laporan pihak ketiga, negasi, histori, contoh/cerita, pertanyaan
   umum, idiom, dan distress samar tidak diputus sebagai emergency lokal.
   Hasil `false` berarti “tidak dipastikan lokal”, bukan “aman”.
3. Pada free-text Telegram yang sudah melewati gerbang consent,
   `MessageBatcher.enqueue` mengevaluasi sinyal tersebut sebelum debounce.
   Hasil positif menaikkan generation, mengirim `AbortSignal` ke run aktif,
   membuat batch biasa lama yang belum mulai menjadi stale, mengirim
   acknowledgment tetap di luar FIFO, dan memasukkan handler penuh ke chain
   pemilik tanpa menunggu classifier. Cancellation request provider yang sudah
   aktif belum sepenuhnya kooperatif.
4. Emergency preflight bukan triase dan tidak memberi izin tindakan. Triase
   penuh, review balasan sesuai disposition/policy, history safety, commit,
   serta semua mutasi tetap mengikuti pipeline dan FIFO yang sudah ada.
   Fallback classifier masih dapat mengusulkan `urgent` untuk pesan yang tidak
   dipastikan policy lokal.
5. `classifyTurnBoundaryLocally` hanya memutus satu bubble yang berada dalam
   closed set berpresisi tinggi:
   - acknowledgment/penutup/pilihan pendek yang jelas menjadi `complete`;
   - fragmen tata bahasa yang berdiri sendiri menjadi `incomplete`.
   Multi-bubble, pembuka seperti `jadi gini`/`aku mau cerita`, emosi seperti
   `aku capek banget`, dan bentuk lain menjadi `null` lalu memakai classifier.
6. Guard bentuk lama tetap berjalan setelah keputusan lokal maupun fallback
   model. Revision coalescing, deadline 4/7/12 detik, generation guard,
   cancellation, FIFO, dan shutdown drain tetap menjadi primitive yang sama;
   jalur urgent kini memakai generation guard untuk melewati batch biasa lama
   yang belum mulai.
7. Pertanyaan waktu yang berdiri sendiri serta pertanyaan identitas model yang
   murni diputus `complete` tanpa boundary model. Pertanyaan waktu melewati
   understanding, triage, dan reply model hanya bila tidak ada episode hangat
   dalam 30 menit; pada episode hangat ia tetap masuk pipeline penuh agar
   konteks keselamatan tidak terputus.
8. Satu `turnId` tetap mengikuti giliran. Sinyal
   `urgent-acknowledgement` membuka span telemetry secara atomik bila belum ada
   dan diantrikan sebelum delivery ACK tanpa menjadi dependency-nya. Handler
   biasa tidak menimpa span itu, sehingga `recordTurn` tidak dapat menutupnya
   sebelum sinyal. Turn tanpa classifier tetap menjadi denominator
   `boundaryClassifierRate`; isi dan pola yang cocok tidak dicatat.
9. Gerbang consent tidak dipindah. Pengecualian triase pesan pertama sebelum
   consent, safety-critical quota, pending authority, dan seluruh batas
   privacy yang ada tetap berlaku.

## Konsekuensi

Positif:

- bahaya eksplisit dalam closed set dapat menerima acknowledgment sebelum
  debounce dan tanpa menunggu provider model;
- bentuk jelas tidak lagi membayar classifier boundary;
- pertanyaan waktu tanpa konteks hangat dapat dijawab sepenuhnya deterministik;
- Phase A dapat mengukur perubahan lewat boundary rate dan urgent ACK count.

Trade-off dan batas:

- closed set sengaja sempit, sehingga banyak kalimat yang mungkin dapat
  diputus lokal masih memakai model;
- sinyal emergency lokal dapat mempunyai false negative; fallback model dan
  triase penuh tetap wajib, sedangkan review berjalan sesuai disposition/policy;
- ADR-022 memasang local preflight pada pesan pertama pra-consent tanpa provider;
  command, callback, WhatsApp, dan group runtime masih belum memakai jalur ini;
- debounce belum adaptif; nilai 650 ms dan jendela 4/7/12 detik belum berubah;
- selective routing grup dan platform selain Telegram privat belum
  diimplementasikan; perubahan privatnya dicatat oleh ADR-022.

## Verifikasi

Tes mengunci closed-set local boundary, fallback untuk bentuk ambigu, negative
cases emergency termasuk konteks multiline, ACK sebelum debounce ketika
classifier tidak pernah selesai, invalidasi batch biasa yang sudah antre,
revision/cancellation/FIFO, race sinyal telemetry melawan penutupan span, serta
time fast path yang tidak memanggil boundary/understanding/triage pada konteks
dingin. Hasil gerbang repository dicatat di `docs/LOG.md`.
