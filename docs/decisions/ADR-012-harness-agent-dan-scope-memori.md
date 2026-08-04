# ADR-012 — Harness Agent dan Scope Memori

- **Status:** Diterima
- **Tanggal:** 31 Juli 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-003, ADR-004, ADR-006, ADR-008, ADR-009, ADR-011

## Konteks

Harvy sudah mengelilingi beberapa model dengan routing, penyusunan konteks,
triase dan review keselamatan, validasi keluaran, layanan deterministik,
telemetry, serta adapter kanal. Dalam arti teknis lapisan itu adalah harness,
tetapi belum ada kontrak tunggal yang menjawab tiga pertanyaan produksi:

1. kemampuan apa yang benar-benar tersedia pada run dan kanal ini;
2. bagaimana proposal tindakan model dibatasi, diizinkan, dijalankan, dan
   dibatalkan; dan
3. di ruang mana konteks dan memori boleh dibaca atau ditulis.

Tanpa kontrak itu, prompt dapat mengesankan Harvy mampu mencari web atau
mengubah aplikasi padahal `AiClient` belum mempunyai toolbox. Implementasi
privat Telegram dan grup WhatsApp juga dapat berkembang menjadi dua produk
berbeda. Di sisi memori, konteks ruangan grup dan fakta jangka panjang tentang
satu anggota mempunyai batas akses yang berbeda dan tidak boleh dilebur.

## Keputusan

1. **Satu harness, beberapa adapter.** `AgentHarness`, capability catalog,
   model policy, safety, context budget, dan layanan grup berada di lapisan
   channel-neutral. Telegram dan WhatsApp tetap mempunyai adapter transport,
   tetapi tidak mempunyai persona, katalog kemampuan, atau kebijakan agentik
   sendiri-sendiri.
2. **Capability catalog adalah authority kode.** Setiap snapshot mempunyai ID,
   versi, effect, kebutuhan konfirmasi, kontrak idempotensi, status tersedia,
   alasan tidak tersedia, scope, dan hash. Isi chat dan keluaran model tidak
   dapat menambah capability. Definisi inti boleh sama lintas kanal, sedangkan
   availability snapshot tetap mengikuti adapter yang benar-benar hidup.
   Karena itu Telegram grup dan WhatsApp privat tidak boleh diklaim tersedia
   sebelum adapter-nya dipasang. Snapshot dan entry dibekukan sebelum diberikan
   kepada planner agar planner tidak dapat mengubah authority di tengah run.
3. **Harvy menyatakan batasnya pada model.** Prompt balasan privat dan grup
   menerima capability snapshot tepercaya. Sejak `ADR-015`, `web.search` dan
   `web.open` dapat tersedia secara dinamis hanya pada chat privat Telegram
   ketika operator memasang executor-nya. Konektor lain dan memori lintas ruang
   tetap ditandai belum tersedia. Menjawab dari pengetahuan model tidak boleh
   disebut pencarian atau verifikasi langsung.
4. **Model mengusulkan, kode mengotorisasi.** Kernel agent menerima hanya
   keputusan bertipe `final`, `need_input`, atau `action`. Proposal action harus
   memakai capability+versi snapshot dan input JSON yang lolos validator
   executor. Unknown/unavailable menjadi observation, bukan eksekusi.
   `need_input` menyimpan pertanyaan pada checkpoint dan jawaban berikutnya
   masuk sebagai user input terikat run, bukan memulai request baru.
5. **Loop selalu berbatas.** Satu run mempunyai jumlah langkah, deadline,
   batas panjang reply/observation, cycle detection, AbortSignal, dan generation
   guard. Checkpoint serializable mempertahankan run pada pause/resume. Hasil
   terlambat dari generation lama tidak boleh di-commit.
6. **Aksi berpengaruh tidak diam-diam.** Kebijakan bawaan hanya mengizinkan
   effect `none` dan `read`; write/destructive/external memerlukan approval.
   Approval mengikat run, langkah, scope, capability, versi, input, dan masa
   berlaku. Yang diikat dan dieksekusi adalah nilai JSON hasil validasi yang
   persis sama, bukan input mentah yang divalidasi ulang setelah approval.
   Policy sendiri tunduk deadline/cancellation dan hasil rusak atau error gagal
   tertutup. Cancellation/deadline diperiksa lagi setelah setiap await sebelum
   operasi dimulai. Executor menerima idempotency key deterministik. Retry
   mutasi tidak otomatis; executor masa depan wajib merekonsiliasi outcome yang
   belum pasti.
7. **Workflow keselamatan dan consent tetap deterministik.** Safety, consent,
   penghapusan, dan kontrol data tidak dipindahkan ke loop agent generik.
   Harness mengorkestrasi model, bukan menyerahkan kewenangan produk kepada
   model.
8. **Konteks adalah anggaran perhatian.** Ringkasan, giliran, dan memori
   dipotong dengan batas eksplisit; giliran terbaru didahulukan. Memori dan
   ringkasan tetap dibungkus sebagai data tak tepercaya. Memori non-profile
   hanya masuk bila mempunyai kecocokan kata bermakna dengan pesan sekarang;
   top-k tanpa ambang relevansi tidak cukup.
9. **Scope dibuat bertipe dan tidak dapat ditebak dari string bebas.** Ruang
   privat memakai `channel + owner`; ruang grup memakai `channel + group +
   member`, serta mempunyai shared room key yang terpisah dari member memory
   key. Tuple di-encode secara injektif. Scope berbeda tidak dapat membaca
   memori satu sama lain hanya karena ID platform atau nama tampilannya sama.
10. **Memori grup terdiri dari dua lapisan.** Shared room context tetap pendek,
    beridentitas, dan berada di RAM. Memori semantik anggota disimpan terpisah
    per `channel + group + member`, hanya dipakai ketika anggota itu berbicara
    di grup itu, dan tidak masuk chat privat, grup lain, atau kanal lain.
    Record semantik menyimpan hash alias scoped, bukan PN/LID mentah; store
    sosial legacy masih memegang pasangan PN/LID untuk bridging platform.
11. **Kontrol hadir bersama memori anggota.** Notice harus menjelaskan scope,
    retensi, dan kontrol. Anggota dapat melihat, mengoreksi, menghapus satu,
    atau melupakan seluruh data dirinya. Memori biasa boleh disimpan setelah
    notice dan diumumkan pada balasan yang sama; memori personal atau yang
    ditandai sensitif tidak boleh otomatis tersimpan. Kegagalan delivery
    pemberitahuan menggulung balik write. Usulan personal mendapat jalur
    konfirmasi eksplisit 10 menit; hanya balasan anggota yang sama dalam scope
    yang sama dapat menyimpannya. Write hasil konfirmasi ikut di-rollback bila
    acknowledgment gagal, dan pending baru dibersihkan setelah delivery sukses.
    Rollback memakai identitas yang tersimpan pada proposal, bukan identitas
    pesan konfirmasi terbaru, agar perpindahan alias PN/LID tidak meninggalkan
    catatan sensitif.
12. **Migrasi dilakukan bertahap.** Runtime tugas, memori, consent, safety, dan
    sesi tetap menjalankan workflow deterministik. Kernel action generik kini
    dipakai vertical slice research baca-saja `web.search`/`web.open`; ia tidak
    memaksa seluruh Harvy ditulis ulang atau mengubah workflow berpengaruh
    menjadi aksi model generik.

### Amandemen 4 Agustus 2026

ADR-017 memasang vertical slice agent internal kedua. Katalog kini membedakan
snapshot fitur produk dari `callableCapabilities`, yaitu irisan capability
available dan executor run. Tool baru hanya membaca tugas, sesi, pengaturan
waktu, serta agenda internal; terminal yang tersedia adalah filesystem virtual
sementara tanpa shell/host/network. Root ambitious boleh menjalankan satu
fan-out read-only maksimal tiga worker cheap/efficient tanpa delegasi rekursif.
Kalender eksternal, shell host, dan seluruh tool write tetap belum tersedia.
Checkpoint menyimpan horizon resume absolut, batas langkah, dan hash authority;
setiap invocation juga mempunyai deadline aktif sendiri. State ini masih belum
durable lintas crash.

## Konsekuensi

- Harvy sekarang dapat menyebut kemampuan dan keterbatasan runtime secara
  konsisten. Search/open web opsional, tool baca state internal, agenda Harvy,
  dan terminal virtual tersedia pada privat Telegram. MCP, kalender eksternal,
  email, pembacaan file host, X/Threads, dan konektor aplikasi belum ada.
- Core grup dapat dipakai oleh adapter Telegram dan WhatsApp, tetapi saat ADR
  ini diterima hanya grup WhatsApp yang disambungkan. Chat privat masih hanya
  Telegram. Kesetaraan arsitektur belum berarti kesetaraan surface produksi.
- Memori semantik anggota grup kini ada, tetapi kesalahan serentak ekstraksi
  dan triase masih dapat salah menganggap isi sensitif sebagai biasa. Notice,
  kontrol, dan rollback membatasi dampak; keterbatasan ini tidak dianggap
  tertutup.
- Repository berkas tetap single-process. Research web masih sinkron/in-memory;
  checkpoint kernel belum mempunyai durable run store dan belum ada dispatcher
  outbox/inbox untuk side effect eksternal.
- Repository grup berkas menulis tombstone disable dan penghapusan social/member
  memory dalam satu commit atomik. Adapter repository lama tetap wajib
  mengulang cleanup meski binding sudah disabled; pending consent sensitif
  masih hanya hidup di memori proses selama 10 menit. Penghapusan telemetry
  scope juga harus dapat dicoba ulang sesudah commit repository berhasil.
- Tidak ada account linking lintas kanal. Menambahkannya kelak memerlukan
  verifikasi identitas, persetujuan eksplisit, provenance, dan kontrol unlink;
  kesamaan nomor/nama tidak pernah cukup.

## Bukti dan rujukan

Keputusan mengikuti prinsip dari sumber primer berikut, disesuaikan dengan
Konstitusi Harvy:

- OpenAI, [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/): mulai dari orkestrasi sederhana, tool terdefinisi, guardrail, dan intervensi manusia.
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): workflow deterministik tetap tepat untuk jalur yang dapat diprediksi; agentic loop perlu feedback dan stopping condition.
- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): konteks adalah sumber terbatas yang perlu dipilih, dipadatkan, dan diisolasi.
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): checkpoint, progress, dan handoff eksplisit mencegah run panjang kehilangan keadaan.
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): outcome dan trajectory sama-sama perlu diuji, termasuk kegagalan tool dan state.

Tes deterministik menjaga capability awareness, isolasi tuple scope, context
budget, approval binding, input JSON, cycle/deadline freshness, migrasi store,
relevansi memori privat, isolasi memori anggota grup, consent sensitif,
PN/LID bridging, koreksi/penghapusan, dan rollback delivery. Angka gerbang penuh
dicatat di `docs/engineering/STATUS.md` dan `docs/LOG.md` setelah verifikasi.
