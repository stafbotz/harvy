# ADR-011 — Partisipasi Natural dan Evaluasi Grup

- **Status:** Diterima
- **Tanggal:** 30 Juli 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-003, ADR-008, ADR-009, ADR-010

## Konteks

Uji pengguna menunjukkan Harvy terlalu sering hanya menjawab tag/reply,
percakapannya terasa seperti chatbot, dan ingress berikutnya menunggu pekerjaan
AI sebelumnya. Masalah ini bukan sekadar prompt. Di grup, keputusan bicara
bergantung pada siapa yang sedang dituju, apakah manusia sudah menjawab, apakah
topik telah bergerak, dan apakah kontribusi masih berguna ketika model selesai.

Riset multi-party dialogue mendukung perlakuan itu. Inoue dkk. melaporkan
addressee eksplisit hanya muncul pada sekitar 20% giliran dalam corpus mereka
dan benchmark GPT-4o hanya sedikit di atas peluang acak
([IWSDS 2025](https://aclanthology.org/2025.iwsds-1.36/)). Kummerfeld dkk.
menunjukkan satu aliran pesan dapat memuat percakapan yang saling berselang dan
menyediakan 77.563 pesan beranotasi struktur reply
([ACL 2019](https://aclanthology.org/P19-1374/)). Prediksi turn-taking juga
lebih tepat diperlakukan sebagai keputusan yang dikondisikan pada respons yang
akan diberikan, bukan sinyal akhir kalimat saja
([Findings ACL 2023](https://aclanthology.org/2023.findings-acl.776/)).
Corpus chat Indonesia yang tersedia menegaskan perlunya memahami bentuk chat
lokal, tetapi tidak membenarkan Harvy mengarang typo atau pengalaman manusia
([LREC 2016](https://aclanthology.org/L16-1129/)).

## Keputusan

1. Setiap pesan live yang eligible diobservasi sebelum pergantian pembicara
   menutup batch lama. Observation revision per `scopeKey + accountId`
   menjadi dasar pembatalan kandidat; duplicate, replay sebelum join, dan akun
   yang tidak memegang binding tidak boleh membatalkan kandidat sah.
2. Listener Baileys tidak menunggu AI. Normalisasi dan enqueue tetap berurutan
   per grup, tetapi pekerjaan giliran dilacak sebagai task terpisah. Refresh
   metadata diberi timeout dan berjalan di latar. Panggilan direct memakai
   settle 350 ms, ambient 1,2 detik, dan typing indicator bersifat kosmetik.
   Cache metadata/admin dikosongkan pada reconnect dan dilindungi epoch per
   grup agar refresh socket lama atau refresh yang selesai setelah removal
   tidak dapat menghidupkan hak admin basi.
3. Panggilan metadata, reply ke Harvy, dan alias berbentuk vocative masuk jalur
   direct. Penyebutan Harvy sebagai topik—misalnya “jangan panggil Harvy
   dulu”—bukan panggilan. Alias textual dipakai sebelum batching agar tidak
   membayar jeda ambient.
4. Planner ambient hanya boleh memilih `speak` untuk empat alasan positif:
   pertanyaan belum terjawab, konteks baru yang berguna, koreksi fakta, atau
   banter yang benar-benar mengundang. Acknowledgment, izin, dan penutup
   koordinasi pendek ditahan kebijakan bentuk lokal; reply ke anggota lain
   tetap default diam.
5. Kandidat bernilai tinggi yang tersusul tidak langsung dibuang dan tidak
   langsung dikirim. Maksimum satu kandidat pending per runtime menunggu quiet
   gap 900 ms, paling lama 15 detik atau empat giliran baru, lalu direvalidasi
   terhadap konteks aman terbaru. Quiet gap baru sah bila seluruh observation
   yang sudah terlihat juga sudah selesai diproses; ini mencegah timer 900 ms
   mendahului settle ambient 1,2 detik. Direct call, bahaya, kelanjutan
   pengirim target, quote ke target, removal, atau shutdown membatalkan timer
   sekaligus request revalidation/fact-reply yang sedang aktif.
6. Budget ambient adaptif memberi ruang nyata untuk manusia dan tidak dihitung
   dari balasan direct/control. Ia menggantikan cooldown global 60 detik yang
   dapat membuat Harvy tidak pernah bicara di grup aktif, tetapi tetap mencegah
   Harvy menjadi separuh percakapan.
7. Kandidat ambient dikirim langsung hanya untuk kontribusi biasa yang lolos
   pagar output. `fact_correction` diregenerasi lewat tier balasan
   `efficient`. Pagar sempit menolak pengalaman/kegiatan manusia palsu, tawaran
   DM, diagnosis/tuduhan pasti, jaminan transaksi, dan balasan terlalu panjang.
8. Riwayat prompt berbentuk giliran chat dengan identitas pembicara, bukan
   kutipan arsip. Persona grup tidak membawa kontrak Telegram. Harvy memahami
   lowercase, singkatan, code-mix, elongation, emoji, dan bubble, tetapi tidak
   sengaja meniru salah ketik atau mengarang slang.
9. Urgent ACK mempunyai reservation/dedupe, pemeriksaan join/binding, batas
   empat triase aktif dan antrean 32. Generation guard diperiksa sebelum dan
   sesudah I/O sehingga removal tidak dapat mengirim balasan atau menghidupkan
   konteks, alias, notice, atau penanda risiko lama. Disable tetap masuk antrean
   penyimpanan walau snapshot binding masih kosong, sehingga implicit
   activation yang sedang berlomba dengan self-remove tidak dapat bertahan.
10. Evaluasi grup memakai 150 skenario semantik lintas 15 topik × empat variasi
    permukaan (600 snapshot ambient), ditambah 60 episode direct. Runner
    menyimpan seluruh JSONL, seed, model/versi/hash, metrik strict terpisah dari
    preference, konsistensi cluster, dan latency. Gangguan provider dan bug
    harness dipisahkan serta tidak boleh menghasilkan skor semu.
11. Shutdown menutup ingress, menguras event saat socket masih dapat mengirim,
    menguras batch dan pending candidate, menutup socket, lalu menguras
    telemetry dan logger paling akhir.

## Konsekuensi

Harvy kini dapat menilai dan mengirim kontribusi ambient tanpa tag, direct call
tidak lagi menunggu planner ambient yang macet, dan kandidat bernilai tinggi
dapat tetap berguna setelah satu pesan sela tanpa menimpa percakapan manusia.
Pagar bentuk lokal mengurangi latency dan false-positive pada kalimat penutup.

Biayanya adalah state runtime yang lebih rumit: observation revision beserta
watermark settled, abort controller, epoch metadata, satu pending candidate,
queue urgent, dan drain lifecycle semuanya harus tetap generation-safe.
Evaluator juga harus dibaca sebagai 150 skenario semantik dengan empat
transformasi, bukan 600 percakapan independen.

Keputusan ini belum membuktikan kualitas produksi. Corpus terbaru belum
dijalankan penuh sesudah kuota testing habis; belum ada penilaian naturalness
buta oleh manusia atau uji perilaku lengkap di WhatsApp nyata. Reply ke anggota
lain sengaja masih sangat konservatif. Kandidat tertunda dapat kehilangan
native quoted-message bila cache transport sudah kedaluwarsa, walau target dan
konteks core tetap dipertahankan. Satu stream grup juga belum mempunyai
conversation disentanglement sempurna.

## Alternatif yang ditolak

- **Hanya menjawab tag/reply.** Ditolak karena addressee grup sering implisit
  dan Harvy akan tetap menjadi chatbot pasif.
- **Menjawab semua pertanyaan bertanda tanya.** Ditolak karena pertanyaan dapat
  ditujukan kepada anggota tertentu atau sudah dijawab manusia.
- **Cooldown global tetap.** Ditolak karena satu pesan irrelevan atau grup ramai
  dapat membuat kontribusi bernilai terus mati.
- **Mengirim kandidat lama tanpa revalidasi.** Ditolak karena balasan yang
  benar saat dibuat dapat menjadi interupsi basi saat selesai.
- **Meniru typo manusia agar terasa natural.** Ditolak. Natural berarti paham
  ritme, register, konteks, dan kapan diam—bukan menyamarkan AI sebagai manusia.
