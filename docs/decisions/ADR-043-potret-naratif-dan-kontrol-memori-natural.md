# ADR-043 — Potret Naratif dan Kontrol Memori Natural

- **Status:** Diterima
- **Tanggal:** 21 Agustus 2026
- **Amandemen:** 22 Agustus 2026 — explicit remember adalah consent item-spesifik;
  acknowledgement memakai receipt commit dan bahasa percakapan kontekstual
- **Amandemen:** 24 Agustus 2026 — consent onboarding privat mengotorisasi
  auto-memory; prompt dan tombol consent per-item dihapus
- **Disupersesi sebagian:** ADR-044 menggantikan guard frasa pada poin 6 dan 9
  dengan `SemanticOperation` tervalidasi; lexical matching tetap hanya untuk
  ranking target owner-local
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-002, ADR-006, ADR-014, ADR-031, ADR-032, ADR-042

## Konteks

Backend Harvy sudah membedakan primary memory, episode, semantic/graph,
user-model, confidence, validity, supersession, suppression, dan learned
memory. UI lama mereduksi keadaan itu menjadi daftar `content — kind` dengan
tombol Ubah/Lupakan per record. Bentuk tersebut mudah diimplementasikan tetapi
tidak jujur untuk fakta yang berubah, belum pasti, atau hanya bermakna bersama
pengalaman percakapan.

## Keputusan

1. **Satu renderer untuk seluruh entry point privat.** `/memori`, pertanyaan
   natural tentang apa yang Harvy ingat, dan Data & izin memanggil
   `showMemories` yang sama. `/memori` juga terdaftar di menu Telegram dan help;
   kanal non-private tetap ditolak oleh pagar adapter.
2. **Tampilan utama adalah potret naratif dinamis.** Primary memory tetap source
   kendali pengguna, tetapi layar tidak lagi merender record satu per satu.
   Narasi disintesis ulang setiap kali diminta dan tidak pernah disimpan sebagai
   canonical memory.
3. **Context synthesis tetap bounded dan selective.** Query khusus potret
   meminta primary, episode relevan, semantic, graph, dan user model melalui
   `MemoryContextCompiler`. Budget compiler tetap 8 item/3.000 karakter;
   renderer prompt membatasi 16 primary, 12 evidence, dan 1.800 karakter shared
   experience. Procedure, error lesson, seluruh archive mentah, dan raw recent
   turn tidak masuk synthesis. Giliran biasa tidak membayar request ini.
4. **Ketidakpastian dirender sebagai bahasa manusia.** Status dan validity
   membantu model membedakan keadaan current, superseded, dan uncertain.
   Parser output menolak bullet/database dump, panjang di atas 1.600 karakter,
   serta metadata seperti confidence, status, predicate, provenance, graph,
   embedding, source ID, dan validity field. Empty state dan kegagalan synthesis
   memakai copy deterministik yang tidak mengarang profil.
5. **`Ubah` kembali ke percakapan, bukan form.** Potret hanya mempunyai tombol
   `Ubah`. Callback itu tidak membuat pending mode; pesan berikutnya melewati
   understanding, privacy, dan memory pipeline biasa. Koreksi membuat state
   temporal baru/supersession. Permintaan lupakan adalah lifecycle deletion yang
   berbeda.
6. **Scoped forget memakai bahasa natural dengan guard lokal.** Extractor boleh
   mengusulkan `memoryTarget`, tetapi mutasi hanya boleh berjalan bila teks
   pengguna sendiri memuat kata forget/hapus/jangan simpan. Matcher owner-local
   memilih primary source dari topik atau rujukan `yang tadi`, lalu selalu
   memanggil `MemoryService.forget` agar semantic/graph, user model, archive
   suppression, embedding, candidate, dan derivation lain mengikuti cascade.
7. **Hapus semua ingatan tetap tindakan besar.** Kontrol ini terpisah di Data &
   izin dan tetap memakai token konfirmasi sekali pakai. Jalur forget-all lama
   yang menyuspensi memory/history dan menghapus seluruh turunannya tidak
   dilemahkan.
8. **Acknowledgement memory adalah bagian percakapan, bukan log.** Authority dan
   policy menentukan write lebih dulu; primary memory harus benar-benar commit
   sebelum kode memberikan receipt `saved`, `updated`, atau `already-known` ke
   lapisan percakapan. Model hanya memilih cara menyampaikannya sesuai isi,
   emosi, dan gaya turn. Balasan yang sudah jelas mengatakan ingat/simpan/catat/
   perbarui tidak mendapat note kedua. Fallback tidak mencetak `content`, kind,
   atau daftar record, dan beberapa write disintesis menjadi satu kalimat.
   Callback lama tetap dapat dibaca hanya untuk pesan yang sudah terlanjur
   terkirim.
9. **Onboarding privat adalah authority auto-memory; explicit remember tetap
   dibuktikan.** Setelah consent versi aktif, candidate biasa maupun personal
   dapat ditulis tanpa prompt per-item. Sinyal model `memoryAction: "remember"`
   tetap bukan bukti bahwa pengguna meminta write: adapter memeriksa raw turn
   untuk membedakan permintaan explicit, retrieval, negasi, dan reminder agar
   kegagalan dijawab tepat. Credential/secret tetap ditolak. Grup tidak
   mewarisi consent privat: member-local implicit diabaikan tanpa prompt,
   explicit remember tetap terikat anggota+grup, dan shared room memory tidak
   memperoleh authority ini.
10. **📍 dan 💭 memiliki peran berbeda tetapi tidak wajib.** `📍` hanya boleh
    membantu menyatakan write atau update yang sudah terkonfirmasi. `💭` hanya
    boleh membantu recall pemahaman lama yang sedang dibawa kembali ke turn
    sekarang; ia tidak menjadi simbol save. Kalimat natural tanpa emoji tetap
    sah. Kata atau emoji pada draft model bukan bukti commit, dan kegagalan
    delivery sebelum acknowledgement terlihat tetap me-rollback primary write
    baru. Bila acknowledgement sudah terkirim pada bubble awal, write
    dipertahankan meski bubble lanjutan gagal agar Harvy tidak mengaku ingat
    sesuatu yang kemudian justru dihapusnya sendiri.

## Konsekuensi

Positif:

- pengguna melihat bagaimana Harvy memahaminya, bukan isi storage mentah;
- perubahan dan ketidakpastian dapat ditulis tanpa dipaksa menjadi fakta
  absolut;
- satu renderer mencegah `/memori`, pertanyaan natural, dan Data & izin
  menyimpang; dan
- correction, scoped forget, forget-all, serta full data deletion tetap memakai
  lifecycle backend yang sudah teruji; dan
- pengguna yang sudah berkata “ingat” tidak harus mengulang izin, sementara
  cerita personal biasa tetap tidak disimpan diam-diam; dan
- Harvy tidak terdengar seperti dua suara—percakapan lalu database—ketika
  mengakui memory write.

Trade-off dan batas:

- membuka potret non-empty membutuhkan satu request synthesis tambahan;
- Context Pack yang diterima synthesis membawa status/validity tetapi belum
  membawa confidence dan stability user-model sebagai field terpisah;
- matcher scoped forget bersifat lexical dengan alias topik dan hanya dapat
  menghapus primary source yang cocok. Detail episode-only tanpa primary source
  memerlukan target yang lebih spesifik atau forget-all; dan
- kualitas tone naratif tetap bergantung pada model, sehingga output divalidasi
  dan gagal ke copy aman alih-alih menampilkan dump primary.

## Bukti

Tes mengunci command/menu/private gate, renderer bersama tiga entry point,
context route/budget, ketidakpastian, larangan metadata, empty state, tombol
`Ubah` tanpa pending, targeted forget tanpa ID, konfirmasi forget-all,
correction kuliah/relasi, explicit remember item-scoped, auto-memory privat
pasca-onboarding, hard exclusion credential, receipt sebelum acknowledgement, semantik
opsional `📍`/`💭`, larangan duplicate note/log per-item, cascade lama, serta
regresi command dan memory suite.
