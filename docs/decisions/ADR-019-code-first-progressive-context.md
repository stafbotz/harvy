# ADR-019: Code-First Progressive Context

- Status: Accepted
- Tanggal: 6 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Menggantikan sebagian: [`ADR-005`](ADR-005-konteks-menggantikan-work-order.md)

## Konteks

Kontrak sebelumnya mewajibkan empat dokumen besar dan catatan LOG pada setiap
sesi. Pada baseline audit, `PROJECT + CONSTITUTION + STATUS + LOG + AGENTS`
mencapai 232.935 byte (sekitar 228 KiB) sebelum kode diperiksa; SessionStart
sendiri mencetak 16.434 byte. STATUS mencampur capability, defect, evidence,
dan histori,
sedangkan LOG kembali tumbuh hampir dua kali lipat dalam dua hari setelah
dipangkas. Hook tetap tidak dapat membedakan perubahan material dari typo.

Akibatnya konteks yang dimaksudkan mencegah dugaan justru mengurangi ruang untuk
kode, diagnosis, diff, dan error. SessionStart Claude juga menjadi lebih berat
daripada bootstrap Codex/Antigravity dan dapat menyuntikkan kutipan defect yang
tidak perlu.

## Keputusan

1. `AGENTS.md` tetap satu kontrak utama; adaptor Claude dan Antigravity tipis.
2. Coding dan diagnosis memakai urutan code-first: task/git state, kode/tes/
   config/diff, lalu dokumentasi on-demand untuk pertanyaan konkret.
3. Konteks dimuat Level 0–3. Sebelum implementasi, docs idealnya sekitar 15%
   konteks; agent berhenti membaca setelah kontrak/invariant/acceptance terkait
   ditemukan. Maksimal tiga entri LOG relevan dibaca.
4. Kode dan tes yang berjalan berada di atas status tertulis untuk diagnosis.
   Selisih wajib dilaporkan, bukan diselaraskan diam-diam.
5. `STATUS.md` menjadi indeks ringkas dan detail aktif dipilih per subsystem.
   Snapshot monolit lama tetap di arsip non-normatif.
6. `docs/agent/CURRENT.md` boleh menjadi snapshot bootstrap, maksimum 5.120
   byte. Total output SessionStart maksimum 8.192 byte dan tidak membaca raw
   LOG, STATUS, PROJECT, CONSTITUTION, log, prompt, atau data pengguna.
7. LOG hanya mencatat perubahan material, keputusan durable, insiden, migrasi,
   hasil live test, atau perubahan status. Diskusi biasa dan commit kecil tidak
   memerlukan entri.
8. Dokumentasi diperbarui hanya ketika fakta, kontrak, perilaku, keputusan,
   known defect, atau prosedur proyek berubah material.
9. Hook memvalidasi struktur/pointer/batas konteks yang dapat ditentukan secara
   mekanis. Hook tidak mencoba menilai materialitas diff dan tidak memaksa LOG.

Keputusan ADR-005 bahwa konteks menggantikan Work Order tetap berlaku. Yang
diganti adalah kewajiban memuat empat dokumen sebelum kerja dan menulis LOG
setiap sesi.

## Konsekuensi

Positif:

- agent baru dapat mulai dari bug lokal tanpa menghabiskan konteks pada product
  vision, Constitution, STATUS monolit, dan histori umum;
- safety/privacy tetap dirutekan wajib ketika task menyentuh kontraknya;
- status dan blocker tetap dapat ditemukan dengan satu hop per subsystem;
- Claude, Codex, dan Antigravity memakai sumber aturan yang sama;
- verifier menjaga ukuran bootstrap secara deterministik.

Trade-off:

- materialitas dan relevansi tidak dapat diputuskan sempurna oleh hook;
- `CURRENT.md` dapat basi walau ukurannya valid, sehingga klaim tetap harus
  dibuktikan dari kode/tes;
- arsip historis tetap besar dan harus dicari per heading/istilah;
- disiplin berhenti membaca dan budget 15% adalah aturan perilaku, bukan metrik
  runtime yang dapat ditegakkan penuh.

## Verifikasi keputusan

`npm run context:check` mengukur output aktual, batas snapshot, pointer adaptor,
status index, wrapper shell, aturan lama di sumber aktif, dan hook. Tes kontrak
repository mengunci perilaku yang sama. Angka check/test aktual dicatat di LOG
hanya ketika perubahan ini selesai diverifikasi.
