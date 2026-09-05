import type { StoredConversationTurn } from "../src/domain/history.js";

/**
 * Transkrip sintetis untuk mengukur apa yang benar-benar hilang saat episode
 * dipadatkan.
 *
 * Sintetis dengan sengaja, dan itu bukan kompromi. Transkrip sungguhan berisi
 * kata-kata pelajar dan tidak boleh masuk Git—aturan yang sama dipakai Hermes
 * pada harness setara mereka ("Transcripts are NOT committed"). Yang dibutuhkan
 * pengukuran ini bukan keaslian melainkan **kepadatan fakta persis** yang
 * diketahui: tanggal, bab, nilai, dan jam yang jawabannya sudah pasti, sehingga
 * sebuah jawaban dapat dinilai benar atau salah tanpa menebak.
 *
 * Tiga sifat bentuknya penting, dan ketiganya ditemukan lewat run yang gagal:
 *
 * 1. **Cukup panjang sampai pemadatan benar-benar memadatkan.** Versi pertama
 *    hanya 16 giliran pendek, dan konteks episodenya justru **lebih besar**
 *    daripada transkrip mentahnya. Pada ukuran itu sumbu biaya terbalik dan
 *    angka recall-nya tidak berarti apa-apa.
 * 2. **Fakta emas hanya di bagian awal.** `HISTORY_WINDOW` giliran terakhir
 *    tidak pernah dipadatkan. Kalau sebuah fakta diulang di ujung percakapan,
 *    ia selamat mentah-mentah dan pertanyaannya berhenti mengukur pemadatan.
 *    Harness memeriksa ini sebelum menjalankan apa pun.
 * 3. **Sebagian besar giliran tidak membawa fakta yang ditanyakan.**
 *    Percakapan sungguhan penuh keraguan, pengulangan, dan basa-basi. Itulah
 *    yang memaksa peringkas **memilih**, dan memilih itulah yang diukur.
 */

export interface CompactionEvalQuestion {
  id: string;
  question: string;
  /** Jawaban benar, dipakai penilai dan tidak pernah dilihat penjawab. */
  gold: string;
}

export interface CompactionEvalTranscript {
  id: string;
  turns: StoredConversationTurn[];
  questions: CompactionEvalQuestion[];
}

type Line = readonly [role: "user" | "harvy", text: string];

function build(
  id: string,
  lines: readonly Line[],
  questions: CompactionEvalQuestion[],
): CompactionEvalTranscript {
  return {
    id,
    turns: lines.map(([role, text], index) => ({
      role,
      text,
      at: new Date(
        Date.UTC(2026, 8, 1, 8 + Math.floor(index / 6), (index % 6) * 9),
      ).toISOString(),
      sequence: index + 1,
    })),
    questions,
  };
}

/** Bagian pembuka: seluruh fakta emas ada di sini, dan hanya di sini. */
const UJIAN_AWAL: readonly Line[] = [
  ["user", "kak minggu depan ada ulangan biologi, aku belum mulai sama sekali dan rasanya udah panik duluan"],
  ["harvy", "Panik duluan wajar kalau belum ada gambaran. Kita bikin gambarannya dulu. Ulangannya tanggal berapa?"],
  ["user", "Selasa 16 September, jam 07.00 langsung jam pertama"],
  ["harvy", "Berarti semua persiapan harus selesai sebelum malam Senin. Materinya sudah dikasih tahu?"],
  ["user", "bab 7 sampai bab 9, yang sel sama jaringan"],
  ["harvy", "Tiga bab. Kelihatan banyak, tapi yang benar-benar keluar biasanya lebih sempit. Ada kisi-kisi?"],
  ["user", "nggak ada kisi-kisi resmi, cuma dibilang fokus ke yang sering keluar"],
  ["harvy", "Kalau begitu soal latihan jadi penunjuk terbaiknya. Ada soal yang bisa dipakai?"],
  ["user", "ada di buku paket halaman 142, soal nomor 12-20"],
  ["harvy", "Bagus, itu konkret. Sembilan soal cukup untuk tahu di mana kamu goyah."],
  ["user", "iya tapi tiap lihat soal itu aku langsung males"],
  ["harvy", "Males biasanya bukan malas, tapi nggak ada pintu masuk. Ulangan sebelumnya hasilnya gimana?"],
  ["user", "jelek, nilai 68 padahal KKM 75. makanya aku takut ngulang lagi"],
  ["harvy", "Tujuh poin itu jarak, bukan jurang. Waktu itu yang salah kebanyakan di bagian mana?"],
  ["user", "aku lupa detailnya, tapi banyak isian singkat yang aku kosongin"],
  ["harvy", "Isian kosong biasanya soal istilah, bukan soal paham. Bab mana yang paling bikin bingung?"],
  ["user", "bab 8 yang jaringan tumbuhan, istilahnya mirip-mirip semua"],
  ["harvy", "Mirip-mirip itu justru pola. Kalau dikelompokkan biasanya tinggal tiga keluarga istilah."],
  ["user", "oh gitu. tapi aku nggak yakin punya waktu buat ngelompokin"],
  ["harvy", "Kamu bisa belajar berapa lama tiap hari?"],
  ["user", "paling satu jam habis magrib, soalnya masih ada tugas fisika juga"],
  ["harvy", "Satu jam cukup kalau fokusnya sempit. Tugas fisikanya kapan dikumpulkan?"],
  ["user", "Kamis 11 September, jadi itu duluan"],
  ["harvy", "Berarti fisika sampai Kamis, biologi mulai Jumat. Empat hari untuk tiga bab."],
  ["user", "oh iya guru biologinya Bu Rina, dia suka soal uraian"],
  ["harvy", "Itu mengubah cara latihannya. Uraian berarti menulis alasan, bukan menghafal pilihan."],
];

/** Bagian tengah: percakapan sungguhan, tanpa satu pun fakta emas. */
const UJIAN_TENGAH: readonly Line[] = [
  ["user", "berarti aku harus bisa jelasin pakai kalimat sendiri dong"],
  ["harvy", "Betul, dan itu lebih gampang diukur. Kalau bisa menjelaskan tanpa lihat catatan, kamu sudah bisa."],
  ["user", "aku coba deh nanti malam"],
  ["harvy", "Mulai dari yang paling kecil aja. Satu istilah, satu kalimat penjelasan."],
  ["user", "kalau aku nggak paham penjelasannya gimana"],
  ["harvy", "Bilang bagian mana yang buntu, nanti kita pecah lebih kecil lagi."],
  ["user", "oke. ada yang lain yang perlu aku siapin?"],
  ["harvy", "Alat tulis dan tidur. Dua-duanya sering dilupakan."],
  ["user", "aku juga takut nggak sempat tidur cukup"],
  ["harvy", "Tidur bukan waktu yang hilang. Yang dipelajari malam itu justru dikunci pas tidur."],
  ["user", "tapi kalau aku tidur cepat, belajarnya jadi sedikit"],
  ["harvy", "Sedikit tapi nempel lebih berguna daripada banyak tapi menguap besok paginya."],
  ["user", "masuk akal juga"],
  ["harvy", "Kamu biasanya tidur jam berapa?"],
  ["user", "kadang tengah malam, kadang lebih"],
  ["harvy", "Kalau bisa digeser sedikit lebih awal minggu ini aja, nggak usah selamanya."],
  ["user", "aku coba"],
  ["harvy", "Nggak perlu sempurna, cukup lebih baik dari kemarin."],
  ["user", "kak, kalau misalnya aku tetap dapat nilai jelek gimana"],
  ["harvy", "Kamu mau aku jawab jujur atau mau aku tenangkan dulu?"],
  ["user", "jujur aja"],
  ["harvy", "Bisa saja terjadi. Tapi satu ulangan bukan ukuran kemampuanmu, dan masih ada perbaikan setelahnya."],
  ["user", "iya sih. cuma orang tua suka nanya"],
  ["harvy", "Pertanyaan mereka biasanya soal khawatir, bukan soal angka. Itu dua hal berbeda."],
  ["user", "kadang rasanya sama aja"],
  ["harvy", "Rasanya memang sama. Yang beda cuma apa yang bisa kamu lakukan soal itu."],
  ["user", "hmm iya"],
  ["harvy", "Kita balik ke yang bisa dikerjakan dulu ya, itu yang paling menenangkan."],
  ["user", "oke kak"],
  ["harvy", "Kamu sudah punya buku paketnya di rumah?"],
  ["user", "ada, tapi catatannya nggak lengkap"],
  ["harvy", "Nggak apa-apa. Buku paket lebih penting daripada catatan untuk soal latihan."],
  ["user", "berarti aku nggak perlu pinjam catatan teman?"],
  ["harvy", "Kalau ada waktu boleh, tapi jangan jadi alasan menunda mulai."],
  ["user", "bener juga, biasanya aku nunggu-nunggu gitu"],
  ["harvy", "Menunggu bahan lengkap itu bentuk menunda yang paling meyakinkan."],
  ["user", "haha iya banget"],
  ["harvy", "Jadi malam ini mulai dari apa yang sudah ada di tangan."],
  ["user", "oke. aku mulai dari yang paling gampang dulu ya"],
  ["harvy", "Boleh. Yang penting mulai, bukan mulai dari yang benar."],
  ["user", "kalau ternyata gampang semua gimana"],
  ["harvy", "Berarti kamu lebih siap dari yang kamu kira, dan itu juga informasi."],
  ["user", "belum pernah kepikiran gitu"],
  ["harvy", "Latihan itu bukan cuma buat belajar, tapi buat tahu posisi kamu di mana."],
  ["user", "oke aku ngerti"],
  ["harvy", "Ada lagi yang mau dibahas sebelum kamu mulai?"],
];

/** Bagian akhir: enam giliran yang tidak pernah dipadatkan, tanpa fakta emas. */
const UJIAN_AKHIR: readonly Line[] = [
  ["user", "kayaknya udah cukup kak"],
  ["harvy", "Bagus. Kabari kalau ada yang macet ya."],
  ["user", "iya makasih banyak"],
  ["harvy", "Sama-sama. Semangatnya dijaga secukupnya aja."],
  ["user", "siap"],
  ["harvy", "Sampai nanti."],
];

const PROYEK_AWAL: readonly Line[] = [
  ["user", "kak aku ada proyek kelompok sejarah, bingung mulai dari mana dan udah mepet"],
  ["harvy", "Kita urutkan biar kelihatan mana yang mendesak. Presentasinya kapan?"],
  ["user", "Jumat 19 September jam 10.00, di kelas 11 IPS 2"],
  ["harvy", "Berapa orang di kelompokmu?"],
  ["user", "empat orang, aku, Dani, Sari, sama Bagas"],
  ["harvy", "Pembagiannya sudah jelas atau masih mengambang?"],
  ["user", "udah dibagi dari awal, cuma nggak semua jalan"],
  ["harvy", "Bagianmu apa?"],
  ["user", "latar belakang sama kesimpulan, halaman 3 sampai 5 di slide"],
  ["harvy", "Itu dua bagian yang paling menentukan nada presentasinya. Sudah ada yang jadi?"],
  ["user", "belum, baru outline. Bagas belum kirim bagiannya sama sekali"],
  ["harvy", "Berarti ada dua masalah terpisah. Jangan dicampur, nanti dua-duanya macet."],
  ["user", "iya aku malah kepikiran punya dia terus"],
  ["harvy", "Yang bisa kamu kendalikan cuma satu dari dua itu."],
  ["user", "bener juga"],
  ["harvy", "Kapan terakhir kalian sepakat kumpul bahan?"],
  ["user", "Senin 15 September, tapi lewat"],
  ["harvy", "Kesepakatannya perlu diperbarui, bukan diulang. Sumbernya dari mana?"],
  ["user", "buku sejarah bab 4 sama satu artikel yang dikasih Pak Anto"],
  ["harvy", "Dua sumber untuk latar belakang sudah cukup. Nggak perlu cari yang baru."],
  ["user", "aku takutnya kurang dalam kalau cuma dua"],
  ["harvy", "Dua yang benar-benar dibaca lebih kuat daripada lima yang cuma dikutip judulnya."],
  ["user", "nilai proyek ini bobotnya 30 persen dari nilai akhir katanya"],
  ["harvy", "Cukup besar, dan itu alasan lain mengamankan bagianmu dulu."],
];

const PROYEK_TENGAH: readonly Line[] = [
  ["user", "aku masih bingung nulis latar belakangnya gimana"],
  ["harvy", "Latar belakang menjawab satu pertanyaan: kenapa ini layak dibahas. Tiga kalimat cukup untuk slide."],
  ["user", "oh cuma segitu? aku kira harus panjang"],
  ["harvy", "Slide bukan makalah. Yang panjang justru bikin pendengarnya berhenti mendengar."],
  ["user", "kalau kesimpulannya gimana?"],
  ["harvy", "Kesimpulan mengulang pertanyaan itu, lalu menjawabnya dengan satu kalimat."],
  ["user", "kedengarannya gampang tapi pas nulis susah"],
  ["harvy", "Karena biasanya kita nulis sambil mikir. Coba pisahkan: mikir dulu, baru nulis."],
  ["user", "caranya gimana"],
  ["harvy", "Tulis dulu jawabannya dalam bahasa ngobrol, baru dirapikan."],
  ["user", "oh boleh gitu ya"],
  ["harvy", "Boleh. Yang penting isinya benar dulu, bahasanya belakangan."],
  ["user", "oke aku coba"],
  ["harvy", "Kalau macet di kalimat pertama, lewati aja dan mulai dari yang kedua."],
  ["user", "kak kalau dia tetap nggak kirim gimana"],
  ["harvy", "Kabari sekali dengan tenggat yang jelas."],
  ["user", "terus kalau lewat juga?"],
  ["harvy", "Bilang ke gurunya sebelum hari H, bukan sesudahnya."],
  ["user", "iya aku takutnya dianggap ngadu"],
  ["harvy", "Memberi tahu sebelum hari H itu menjaga kelompok. Yang merugikan kalau baru ketahuan pas presentasi."],
  ["user", "hmm bener juga"],
  ["harvy", "Dan itu lebih adil buat dia, masih punya kesempatan memperbaiki."],
  ["user", "aku belum pernah kepikiran dari sisi itu"],
  ["harvy", "Biasanya nggak kepikiran karena rasanya kayak melaporkan. Padahal lebih dekat ke memberi tahu."],
  ["user", "iya sih"],
  ["harvy", "Sekarang bagianmu dulu. Kamu bisa mulai malam ini?"],
  ["user", "bisa, habis magrib"],
  ["harvy", "Berapa lama kira-kira?"],
  ["user", "sejam kali ya"],
  ["harvy", "Sejam cukup untuk tiga kalimat pembuka dan kerangka penutup."],
  ["user", "kalau lebih dari sejam gimana"],
  ["harvy", "Berhenti aja. Lebih baik selesai sedikit tiap hari daripada sekali banyak lalu kapok."],
  ["user", "oke"],
  ["harvy", "Slidenya pakai apa?"],
  ["user", "yang bisa dikerjakan barengan"],
  ["harvy", "Bagus, itu juga bikin kelihatan siapa yang sudah mengisi."],
  ["user", "iya kelihatan banget siapa yang belum"],
  ["harvy", "Itu informasi, bukan bahan marah. Dipakai buat menentukan siapa yang perlu dikabari."],
  ["user", "aku sering kesel duluan sih"],
  ["harvy", "Kesel wajar. Yang nggak berguna cuma kalau keselnya bikin bagianmu ikut terhenti."],
  ["user", "iya itu yang terjadi kemarin"],
  ["harvy", "Sekarang kita balik urutannya: kerjakan punyamu, baru urus yang lain."],
  ["user", "oke"],
  ["harvy", "Ada yang masih mengganjal sebelum mulai?"],
];

const PROYEK_AKHIR: readonly Line[] = [
  ["user", "kayaknya udah jelas kak"],
  ["harvy", "Bagus. Kalau macet, kirim ke sini."],
  ["user", "siap makasih"],
  ["harvy", "Sama-sama."],
  ["user", "nanti aku kabarin"],
  ["harvy", "Aku tunggu."],
];

const UJIAN = build(
  "ujian-biologi",
  [...UJIAN_AWAL, ...UJIAN_TENGAH, ...UJIAN_AKHIR],
  [
    { id: "tanggal", question: "Kapan ulangan biologinya?", gold: "Selasa 16 September, jam 07.00" },
    { id: "materi", question: "Bab berapa saja yang diujikan?", gold: "Bab 7 sampai bab 9" },
    { id: "soal", question: "Di mana soal latihannya?", gold: "Buku paket halaman 142, soal nomor 12-20" },
    { id: "nilai", question: "Berapa nilai ulangan sebelumnya dan berapa KKM-nya?", gold: "Nilai 68, KKM 75" },
    { id: "bab-sulit", question: "Bab mana yang paling sulit baginya?", gold: "Bab 8, jaringan tumbuhan" },
    { id: "waktu-belajar", question: "Berapa lama ia bisa belajar tiap hari?", gold: "Sekitar satu jam setelah magrib" },
    { id: "fisika", question: "Kapan tugas fisikanya dikumpulkan?", gold: "Kamis 11 September" },
    { id: "guru", question: "Siapa guru biologinya dan soal seperti apa yang ia suka?", gold: "Bu Rina, suka soal uraian" },
  ],
);

const PROYEK = build(
  "proyek-kelompok",
  [...PROYEK_AWAL, ...PROYEK_TENGAH, ...PROYEK_AKHIR],
  [
    { id: "presentasi", question: "Kapan presentasinya?", gold: "Jumat 19 September jam 10.00" },
    { id: "kelas", question: "Di kelas apa?", gold: "Kelas 11 IPS 2" },
    { id: "anggota", question: "Siapa saja anggota kelompoknya?", gold: "Dia sendiri, Dani, Sari, dan Bagas" },
    { id: "bagian", question: "Bagian mana yang jadi tanggung jawabnya?", gold: "Latar belakang dan kesimpulan, halaman 3 sampai 5" },
    { id: "hambatan", question: "Apa yang sedang menghambat?", gold: "Bagas belum mengirim bagiannya" },
    { id: "tenggat-bahan", question: "Kapan mereka sepakat kumpul bahan?", gold: "Senin 15 September" },
    { id: "sumber", question: "Dari mana sumbernya?", gold: "Buku sejarah bab 4 dan artikel dari Pak Anto" },
    { id: "bobot", question: "Berapa bobot nilai proyek ini?", gold: "30 persen dari nilai akhir" },
  ],
);

export const COMPACTION_EVAL_TRANSCRIPTS: readonly CompactionEvalTranscript[] = [
  UJIAN,
  PROYEK,
];
