# ADR-004: Seluruh Percakapan Diproses Model AI

- Status: Accepted
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Menggantikan sebagian: [`ADR-002`](ADR-002-percakapan-bahasa-alami.md)

> **Supersesi parsial 8 Agustus 2026.** [`ADR-021`](ADR-021-emergency-preflight-dan-boundary-local-first.md)
> mengganti klaim bahwa setiap free-text wajib memanggil model. Boundary bentuk
> jelas, emergency preflight, waktu tanpa episode hangat, dan fakta identitas
> model yang murni kini boleh deterministik. Percakapan generatif dan pemahaman
> pesan yang tidak berada dalam closed set tetap memakai model.

> **Supersesi parsial lanjutan 8 Agustus 2026.**
> [`ADR-022`](ADR-022-selective-safety-routing-dan-privacy-memory.md) menambah
> acknowledgment dingin serta jawaban pending closed-set sebagai pengecualian
> deterministik. Pesan biasa di luar closed set tetap memakai compiler model;
> acute triage dan privacy-memory classifier dipanggil selektif sesudahnya.

> **Koreksi 26 Juli 2026.** Versi pertama ADR ini menyebut modul `intent.ts`,
> `natural-language.ts`, dan `time.ts`. Ketiga nama itu tidak ditemukan pada
> commit mana pun dalam riwayat Git repositori ini. Modul berbasis aturan yang
> benar-benar tercatat dan benar-benar dihapus hanya satu, yaitu
> `src/core/input-parser.ts` beserta `tests/input-parser.test.ts`. Teks di bawah
> sudah diperbaiki agar cocok dengan riwayat yang dapat diperiksa.

## Konteks

[`ADR-002`](ADR-002-percakapan-bahasa-alami.md) membuat Harvy menerima bahasa
alami dengan aturan, tanpa model AI, agar dapat diuji tanpa biaya inferensi.
Seluruh penguraian pesan berbasis aturan berada di satu modul,
`src/core/input-parser.ts`, yang membaca judul, tenggat, dan kepentingan dari
teks pengguna.

Keduanya bekerja untuk kalimat yang sudah diperkirakan, tetapi tidak untuk
Harvy yang sebenarnya dituju. Harvy adalah pendamping belajar yang harus
menjelaskan materi, menuntun bertahap, dan menanggapi keadaan pengguna. Semua
itu tidak dapat dilakukan aturan.

Setelah [`ADR-003`](ADR-003-routing-model.md) menetapkan model dan penyedia,
mempertahankan dua jalur yang saling menutupi hanya menambah beban perawatan.

## Keputusan

1. `src/core/input-parser.ts` dihapus beserta `tests/input-parser.test.ts`.
2. Seluruh pesan bebas diproses model. Tidak ada lagi cadangan berbasis aturan.
3. Pemahaman dan balasan dipisah menjadi dua panggilan:
   - model `cheap` membaca pesan menjadi JSON terstruktur berisi maksud,
     kepekaan keselamatan, kebutuhan penuntunan, dan data tugas;
   - tingkatan model untuk balasan dipilih dari hasil pembacaan itu.
4. Kepribadian, batas moral, dan aturan keselamatan berada di `src/ai/persona.ts`,
   bukan menempel pada satu model. Konstitusi Pasal 3.13 menuntut model dapat
   diganti tanpa mengubah identitas Harvy.
5. Balasan model diperlakukan sebagai masukan yang tidak tepercaya.
   `src/ai/understand.ts` memaksanya masuk ke bentuk yang sudah ditetapkan dan
   mengembalikan `null` bila gagal, sehingga Harvy mengaku tidak paham alih-alih
   menebak.
6. Ketika maksud pesan bukan mencatat tugas tetapi ada pekerjaan yang tersirat,
   Harvy menjawab dulu lalu **menawarkan** pencatatan dengan tombol. Prinsip
   ADR-002 ini tetap berlaku.

## Yang tetap dari ADR-002

Perintah berformat dan ID teknis tetap tidak ada. Tombol tetap menjadi cara
menjalankan tindakan. Persetujuan tetap diminta sebelum mencatat sesuatu yang
tidak jelas diminta. Yang berubah hanya mesin yang memahami pesan.

## Konsekuensi

Positif:

- Harvy dapat menanggapi kalimat apa pun, bukan hanya pola yang diperkirakan.
- Satu jalur percakapan, bukan dua yang harus dijaga tetap sepadan.
- Pemahaman tanggal tidak lagi terbatas pada kosakata yang ditulis tangan.

Trade-off yang harus diterima:

- **Harvy tidak dapat berjalan tanpa kunci API.** Tidak ada mode `off` dan tidak
  ada cadangan. Ketika kuota habis atau penyedia terganggu, Harvy diam dan
  mengatakannya terus terang kepada pengguna.
- **Setiap pesan berbiaya**, termasuk sapaan. Sebelumnya klasifikasi gratis.
- **Hasilnya tidak deterministik.** Model dapat salah membaca tenggat. Karena
  itu tugas yang tercatat selalu ditampilkan lengkap beserta tombol Ubah tenggat
  dan Batalkan.
- **Perilaku berbeda antar mode.** Satu model uji tidak mewakili tiga model
  produksi. Hasil pengujian dalam mode uji tidak boleh dianggap mewakili
  produksi, terutama untuk percakapan keselamatan.
- **Privasi berubah.** Isi pesan pelajar dikirim ke penyedia model pihak
  ketiga. Konstitusi Pasal 3.9 menuntut pengguna diberi tahu tentang ini.
  Sejak gelembung persetujuan onboarding menyatakannya, tuntutan itu
  **sudah dipenuhi**; lihat bagian keadaan sekarang di bawah.

## Batas yang dipilih dengan sengaja

Balasan untuk tugas yang berhasil dicatat disusun Harvy sendiri, bukan model.
Ini jalur paling sering dipakai, dan isinya hanya menampilkan kembali data yang
sudah diekstraksi. Memanggil model dua kali di sana menambah biaya dan jeda
tanpa manfaat yang sepadan.

## Yang sudah dikerjakan sejak ADR ini ditulis

Diperiksa ulang terhadap kode 3 September 2026. Keempat butir yang dulu tercatat
belum ada, tiga di antaranya kini terpasang:

- **Pemberitahuan pemrosesan pihak ketiga: ada.** Gelembung persetujuan
  onboarding menyatakan pesan dan gambar diproses AI sebelum percakapan dimulai
  (`src/bot/onboarding.ts`). Ini menutup tuntutan Pasal 3.9 yang disebut di
  bagian konsekuensi di atas.
- **Riwayat percakapan: ada.** `src/core/history-service.ts` menyimpan giliran,
  memadatkannya menjadi episode, dan mengirim jendela terakhir ke tiap prompt.
- **Batas pemakaian per pengguna: ada.** `src/core/economy-service.ts` beserta
  ledger entitlement.
- **Pemeriksaan keselamatan sebagai lapisan tersendiri: ada.** `src/ai/safety.ts`
  dan `src/core/safety-policy.ts` memegang triase dan routing terpisah dari
  penilaian model biasa. Pengukuran 3 September 2026 mencatat ongkosnya 3% dari
  panggilan dan 1% dari waktu.

Butir-butir itu dibiarkan tertulis di atas sebagai catatan sejarah keputusan,
bukan sebagai pekerjaan tertunda. Yang membaca ADR ini untuk mencari pekerjaan
harus memakai daftar di sini, bukan daftar lama.

## Yang belum dikerjakan saat ADR ini ditulis

_Lihat bagian di atas untuk keadaan sekarang._

- Pemberitahuan kepada pengguna bahwa pesannya diproses penyedia model pihak
  ketiga, beserta persetujuannya.
- Riwayat percakapan. Harvy belum mengingat pesan sebelumnya, sehingga tutoring
  bertahap belum benar-benar mungkin.
- Pemeriksaan keselamatan sebagai lapisan tersendiri, di luar penilaian model.
- Batas pemakaian per pengguna, agar biaya tidak lepas kendali.
