# ADR-044 — Semantic Operation dan Transient Interaction Context

- **Status:** Diterima
- **Tanggal:** 22 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-002, ADR-004, ADR-006, ADR-008, ADR-010, ADR-031,
  ADR-041, ADR-043
- **Mengamendemen:** authority berbasis frasa pada ADR-043 serta routing
  natural-language account surface sebelum keputusan ini

## Konteks

Harvy mempunyai surface deterministik untuk usage, account, task, memory,
session, dan menu. Exact command sudah cepat dan andal, tetapi sebagian
free-text masih ditafsirkan oleh daftar frasa lokal. Output deterministik juga
tidak selalu masuk history, sehingga follow-up pendek seperti `detailnya`
kehilangan referen meski dashboard baru saja terlihat. Menambah sinonim per
bahasa akan memperbesar daftar tanpa menyelesaikan kelas masalah tersebut.

Capability runtime juga tidak boleh disamakan dengan isi context setiap turn.
Percakapan biasa tidak membutuhkan seluruh katalog tool, command internal,
atau instruksi agent untuk tetap mampu memakai jalur agent ketika routing
benar-benar memilihnya.

## Keputusan

1. **Makna natural language berasal dari satu understanding pass yang sudah
   ada.** Output `Understanding` dapat membawa `SemanticOperation` v1 dengan
   domain dan operation closed-set, target bounded, subject, reference,
   explicitness, exact evidence span, dan confidence. Object harus mempunyai
   key exact; pasangan domain-operation asing, field tambahan, nilai di luar
   batas, serta field raw reasoning membuat proposal ditolak. Absennya proposal
   tetap berarti `null`, bukan izin memakai fallback sensitif.
2. **Semantic output adalah proposal, bukan authority.** Kode memeriksa raw
   turn, evidence, confidence, explicitness, subject self, operation yang
   diizinkan, owner/scope, state aktif, target closed-set, confirmation, dan
   policy effect sebelum read atau mutation. Model tidak dapat memilih owner,
   storage ID, capability, credential, permission, budget, atau receipt.
   Regex tetap sah untuk exact command, callback/protocol, URL/ID, nominal,
   credential detection, schema, syntax, dan safety preflight sempit; ia bukan
   sumber utama makna free-text.
3. **Precedence referensi bersifat eksplisit.** Maksud eksplisit turn sekarang
   menang, diikuti quote/pending yang scoped, recent transient interaction,
   active session/run, recent conversation history, lalu retrieved long-term
   memory. Context lama tidak boleh mengalahkan intent eksplisit baru dan
   percakapan biasa tidak otomatis menjadi input active run.
4. **Recent surface memakai transient interaction context generik.** Store
   process-local di-key oleh owner, channel, dan conversation; default-nya
   maksimal tiga entry dengan TTL sepuluh menit. Payload hanya memuat versi,
   domain, operation, reference, timestamp expiry, dan generation—tanpa raw
   message/reply, nilai account, isi memory/task, ID storage, credential, model,
   atau provider. Entry baru dicatat hanya sesudah output berhasil dikirim.
   Consent withdrawal dan full deletion membersihkan scope terkait. Restart
   sengaja menghilangkan state ini; ia bukan durable memory/history.
5. **Transient context hanya menentukan referen.** Usage/account detail selalu
   membaca state owner-scoped terbaru dari service. Angka lama tidak disimpan
   atau dipercaya. Exact command tetap deterministic dan tidak membayar model;
   free-text memakai semantic understanding, lalu renderer/service
   deterministic bila policy mengizinkan. Surface tersebut tidak dimasukkan ke
   durable conversation history hanya demi mempertahankan referen.
6. **Task, memory, dan session memakai explicitness lintas bahasa.** Task save,
   remember/forget/edit, serta session done/cancel memerlukan proposal explicit
   dengan evidence dari turn sekarang. Forget-all dan full data deletion tetap
   memakai confirmation existing. Lexical matching boleh meranking target
   owner-local atau cold evidence setelah semantic target tersedia; ia tidak
   lagi menjadi satu-satunya parser izin. Memory/history recall dapat
   mengaktifkan query plan melalui semantic meaning tanpa kamus Indonesia.
7. **Capability availability dipisahkan dari context presence.** Final
   `Conversation.reply` biasa menerima raw current message dan human context
   relevan yang bounded, tetapi tidak menerima global capability catalog atau
   seluruh tool schema. Agent planner tetap menerima callable subset hanya
   ketika composition telah memasang dan mengotorisasinya. Specialist privacy,
   role routing, RunBudget, dan provider-native reasoning boundary tidak
   berubah.
8. **Menu dan help mempunyai satu katalog user-facing.** Katalog yang sama
   membentuk Telegram native command registration, kategori `/menu`, detail
   menu, serta `/bantuan`. Availability mengikuti composition; command
   operator/internal tidak masuk. `/menu` adalah navigasi ringkas dan mobile-
   friendly, sedangkan `/bantuan` menjelaskan cara memakai Harvy. WhatsApp
   privat memperoleh padanan teks tanpa memaksakan callback Telegram; grup
   tidak menerima menu panjang secara ambient.
9. **Observability tetap content-free.** Log boleh mencatat domain/operation,
   confidence bucket, route, penggunaan recent context, deterministic/fallback,
   dan kebutuhan klarifikasi melalui allowlist scalar. Raw turn, target,
   evidence, response, account value, dan isi context tidak boleh dicatat.

## Konsekuensi

Positif:

- frasa Indonesia, Inggris, Sunda, Jawa, campuran, slang, dan typo memakai
  contract makna yang sama tanpa synonym dictionary sebagai authority;
- follow-up setelah dashboard/menu/task/memory dapat mempertahankan referen
  tanpa mengubah navigation state menjadi personal memory;
- read-only surface tetap cepat dan mengambil state terbaru; dan
- ordinary conversation tidak membawa manual internal Harvy ke setiap model
  request.

Trade-off dan batas:

- kualitas proposal semantic tetap bergantung pada model understanding;
  confidence/evidence/policy membuat kegagalan sensitif tertutup, tetapi live
  multilingual quality belum dibuktikan;
- transient reference hilang saat restart atau TTL habis, sehingga follow-up
  dapat memerlukan penyebutan ulang; dan
- lexical ranking target memory masih konservatif dan tidak menjamin setiap
  parafrasa menemukan item yang tepat.

## Bukti

Tes mengunci schema exact dan raw-reasoning rejection, routing domain dan
explicitness, usage lintas bahasa beserta follow-up fresh-state, collision
usage/memory, task/memory/session multilingual, forget-all confirmation,
transient TTL/bounds/isolation/restart loss/delivery failure, context
cleanliness, menu/help/catalog/registration, serta sanitasi log content-free.
Provider, akun Telegram, dan akun WhatsApp live tidak termasuk bukti unit ini.
