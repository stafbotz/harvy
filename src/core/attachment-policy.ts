/**
 * Apa yang benar-benar dapat Harvy tangkap dari sebuah pesan, dan apa yang
 * dikatakannya ketika yang datang bukan itu.
 *
 * Harvy membaca teks dan gambar. Itu saja. Ia tidak mendengar rekaman suara,
 * tidak menonton video, dan tidak membuka isi PDF, Word, Excel, atau
 * PowerPoint.
 *
 * Sampai 4 September 2026 batas itu tidak pernah dikatakan kepada siapa pun.
 * Berkas non-gambar jatuh ke jalur upload project, sehingga seorang pelajar
 * yang mengirim PDF tugasnya dijawab "Untuk project coding, kirim archive
 * berformat ZIP"—kalimat yang tidak menjelaskan apa pun tentang keadaan
 * sebenarnya dan mengirimnya mencari kesalahan yang tidak ia buat. Pesan suara
 * lebih buruk lagi: tidak ada handler-nya sama sekali, jadi Harvy diam saja.
 *
 * Yang diminta pemilik produk: minta maaf, katakan batasnya, lalu tawarkan
 * jalan yang benar-benar bekerja—screenshot. Screenshot dipilih karena ia satu
 * hal yang pasti bisa dilakukan siapa pun dari ponselnya, tidak menuntut
 * mengetik ulang isi berkas, dan hasilnya persis jenis masukan yang memang
 * dapat Harvy baca.
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, jam, maupun model.
 * Kembarannya di sisi model ada di `HARVY_IDENTITY` (`src/ai/persona.ts`),
 * supaya Harvy menjawab hal yang sama ketika **ditanya** tentang batas ini,
 * bukan hanya ketika berkasnya benar-benar datang.
 */

export type UnsupportedAttachment =
  | "dokumen"
  | "suara"
  | "video"
  /** Berkas gambar dengan format yang tidak dapat dibaca penyedia model. */
  | "gambar-asing";

/**
 * Apakah berkas ini archive project untuk runtime coding.
 *
 * Terpisah dari selebihnya karena ZIP adalah satu-satunya berkas non-gambar
 * yang memang punya tujuan di Harvy—dan itu pun hanya ketika runtime coding
 * terpasang. Pemanggil wajib memeriksa keterpasangan itu sendiri: ZIP yang
 * datang ke deployment tanpa runtime coding bukan project, ia berkas biasa
 * yang tidak dapat dibaca, dan pengirimnya layak diberi tahu begitu.
 */
export function isProjectArchive(
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
): boolean {
  return fileName?.toLocaleLowerCase("en-US").endsWith(".zip") === true ||
    mimeType?.trim().toLocaleLowerCase("en-US") === "application/zip";
}

/**
 * Kalimat yang dikirim ketika lampirannya tidak dapat dibaca.
 *
 * Tiga bagian, selalu dalam urutan yang sama: maaf sekali dan singkat, batas
 * yang dinyatakan apa adanya, lalu satu jalan keluar yang konkret. Maafnya
 * tidak diulang dan tidak dibesar-besarkan—ini keterbatasan yang wajar, bukan
 * kesalahan pengguna dan bukan pula bencana.
 */
export function unsupportedAttachmentReply(
  kind: UnsupportedAttachment,
): string {
  switch (kind) {
    case "dokumen":
      return "Maaf ya, aku belum bisa membuka isi file seperti ini. Yang bisa kubaca cuma teks dan gambar. Coba screenshot bagian yang mau kamu tanyain terus kirim ke sini—dari situ aku langsung bisa bantu.";
    case "suara":
      return "Maaf ya, aku belum bisa mendengarkan pesan suara. Yang bisa kubaca cuma teks dan gambar. Ketik aja poinnya, nanti kita lanjut dari situ.";
    case "video":
      return "Maaf ya, aku belum bisa menonton video. Yang bisa kubaca cuma teks dan gambar. Screenshot bagian yang mau kamu tanyain aja, nanti kubantu dari situ.";
    case "gambar-asing":
      return "Maaf ya, format gambarnya belum bisa kubaca. Kirim ulang sebagai JPEG, PNG, atau WebP—atau screenshot langsung dari layarmu, itu yang paling gampang.";
  }
}
