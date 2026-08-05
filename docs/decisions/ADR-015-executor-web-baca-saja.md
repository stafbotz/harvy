# ADR-015 — Executor Web Baca-Saja Pertama

- **Status:** Dicabut — 5 Agustus 2026
- **Tanggal:** 2 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-003, ADR-008, ADR-012, ADR-014

> Keputusan ini disimpan sebagai catatan sejarah. Implementasi `web.search`,
> `web.open`, route intent `research`, konfigurasi provider, dan executor web
> telah dihapus dari runtime pada 5 Agustus 2026 atas keputusan pemilik
> produk. Dokumen ini tidak lagi menjadi dasar klaim kemampuan saat ini.

## Konteks

Harvy sudah mempunyai capability catalog dan kernel plan/action/observation,
tetapi seluruh tool eksternal masih ditandai tidak terpasang. Akibatnya Harvy
belum memberi nilai utama untuk workspace research: mencari informasi terbaru,
membuka sumber, lalu menjawab dengan rujukan yang benar-benar diamati.

Vertical slice pertama sengaja hanya membaca. Search dan open dapat memberi
nilai pengguna tanpa menambah risiko approval, retry mutasi, receipt, atau
rekonsiliasi tindakan eksternal. Walau begitu, pembacaan URL umum membawa risiko
SSRF, DNS rebinding, redirect berbahaya, respons tak terbatas, prompt injection,
dan sitasi karangan.

## Keputusan

1. **Dua capability terpisah dan dinamis.** `web.search` v1 dan `web.open` v1
   ber-effect `read`, tanpa confirmation, dan idempotensi `read-only`.
   Keduanya hanya tersedia pada chat privat Telegram bila executor terkait
   benar-benar diaktifkan operator. Snapshot tetap menjadi authority; X,
   Threads, file, MCP, aplikasi, Telegram grup, dan WhatsApp privat tidak ikut
   menjadi tersedia.
2. **Search memakai adapter endpoint resmi yang tetap.** Implementasi awal
   memakai Brave Search API. Endpoint tidak dapat diganti lewat environment;
   key hanya dikirim melalui header `X-Subscription-Token`, tidak masuk query,
   prompt, capability snapshot, Console, atau observation. Count dibatasi 1–8,
   SafeSearch dipaksa ketat, response dibatasi satu megabyte, dan bentuk hasil
   dibaca sebagai input tidak tepercaya.
3. **Open adalah HTTP GET teks publik dengan egress guard.** Hanya HTTP/HTTPS
   tanpa URL credential dan tanpa port non-default. Seluruh hasil A/AAAA harus
   publik; bila satu saja privat/khusus, nama ditolak. Request dipin ke salah
   satu IP yang sudah divalidasi sambil mempertahankan Host/SNI. Setiap redirect
   diurai dan di-resolve ulang, maksimal tiga. Respons dibatasi satu megabyte,
   hanya content type teks/HTML/JSON, tanpa kompresi, dan HTML aktif dibuang
   sebelum teks dipotong maksimum 3.000 karakter.
4. **Loop research memakai kernel yang sudah ada.** Intent `research` hanya
   dipilih untuk permintaan mencari/mengecek sumber. Planner mengusulkan satu
   action JSON per langkah; kode memeriksa capability+versi, schema tertutup,
   policy, deadline internal 45 detik, maksimal enam langkah, cycle guard, dan
   executor. Planner awal memakai tier murah; setelah observasi memakai tier
   `efficient`.
5. **Observasi tidak menjadi instruksi dan egress planner dibatasi.** Query,
   snippet, halaman, dan hasil executor dibungkus sebagai data tak tepercaya.
   Riwayat dan memori privat lama sengaja tidak diberikan ke planner research.
   Satu run hanya boleh mengirim satu query search; `web.open` hanya menerima
   URL kanonik yang ditulis pengguna atau keluar dari search sukses pada run
   yang sama. Ini membatasi indirect prompt injection agar tidak dapat membuat
   query kedua atau memodifikasi URL menjadi kanal eksfiltrasi.
6. **Final membutuhkan observasi sukses.** URL maupun domain polos yang tidak
   berasal dari observation membuat hasil ditahan. Final tanpa sumber sukses
   juga ditolak; hasil search kosong dan kegagalan tool mempunyai copy jujur
   yang berbeda. Bila model lupa daftar sumber, kode menambahkan maksimal tiga
   URL teramati.
7. **Delivery tetap menentukan state percakapan.** Hasil research ditulis ke
   history dan penggunaan memori ditandai hanya setelah Telegram berhasil
   mengirimnya. Delivery gagal membatalkan settlement yang belum terkirim.
8. **Aktivasi dan pemberitahuan harus eksplisit.** `WEB_SEARCH_ENABLED` membutuhkan
   `WEB_SEARCH_API_KEY`; `WEB_OPEN_ENABLED` terpisah karena membuka egress HTTP
   umum. Keduanya mati secara default dan mempunyai timeout berbatas.
   Persetujuan privat dinaikkan ke versi 4: pengguna diberi tahu bahwa query
   research dapat dikirim ke penyedia pencarian terpisah dan URL dapat diambil
   server Harvy, sementara konteks lama privat tidak ikut route research.

## Yang belum diputuskan oleh tahap ini

- Run masih sinkron dan in-memory. Tidak ada `RunStore`, resume setelah crash,
  progress background, artifact research, lease, outbox, receipt, atau
  reconciler. Deadline mempunyai `AbortSignal` internal, tetapi pembatalan dari
  command/generation luar belum disambungkan ke run research yang aktif.
- Planner memakai kontrak JSON Harvy di atas chat completion, belum native
  provider `tools`/`tool_choice` atau Responses tool calling.
- Pemeriksaan URL memastikan sitasi berasal dari observation, tetapi belum
  memverifikasi setiap klaim terhadap kutipan halaman. Search snippet juga
  masih dapat dijadikan sumber tanpa `web.open`; citation coverage dan
  groundedness semantik belum menjadi hard gate produksi.
- Tidak ada konektor khusus X/Threads, login browser, JavaScript rendering,
  robots-policy engine, PDF reader, pagination otomatis, source diversity
  policy, cache, atau indeks workspace.
- Tool baca tidak boleh dipakai sebagai alasan mengaktifkan external write.
  Aksi kalender/email/pesan tetap menunggu durable run, approval UX, outbox,
  receipt, dan rekonsiliasi outcome `unknown`.

## Bukti dan rujukan

Tes deterministik mencakup capability dinamis/scope, config fail-closed,
credential header, parser respons, response cap, URL privat/khusus, campuran DNS
publik+privat, IP pinning, redirect ke localhost, content type biner, sanitasi
HTML, schema executor, loop search→open→final, observasi injeksi, URL karangan,
domain polos, final tanpa observation, pembatas satu search, allowlist URL open,
isolasi context privat, consent v4, normalisasi URL Telegram, dan route Telegram
research.

Kontrak provider dan pagar egress mengikuti sumber primer:

- Brave, [Web Search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get).
- OWASP, [Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
- IANA, [IPv4 Special-Purpose Address Space](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml)
  dan [IPv6 Special-Purpose Address Space](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml).
