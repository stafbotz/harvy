# Pengembangan Harvy — Referensi Lengkap

Dokumen ini berisi detail perintah pengembangan, probe diagnostik, dan
konfigurasi environment. Baca ketika setup, debug config, atau menulis probe.

Perintah ringkas ada di `AGENTS.md` bagian **Quick ref**.

---

## Dev runner

`npm run dev` memakai `scripts/dev-runner.ts`, bukan `tsx watch`. Perubahan di
`src/`, `.env`, `package.json`, atau `tsconfig.json` tetap memicu reload, tetapi
runner meminta shutdown lewat IPC dan menunggu child melepas runtime lock
sebelum memulai proses baru. Pada Windows ini wajib: `tsx watch` mematikan child
dengan sinyal proses yang melewati handler shutdown Harvy.

Tidak ada linter atau formatter terpasang; `npm run check` adalah satu-satunya
gerbang statis. Tes dijalankan dari hasil build, bukan dari `tests/*.ts`, jadi
selalu `npm run build` sebelum memanggil `node --test` secara manual.

`npm run build` tidak membersihkan `dist/`. Setelah menghapus atau mengganti
nama berkas sumber, jalankan `rm -rf dist` lebih dulu agar hasil build lama
tidak ikut dijalankan sebagai tes.

## Menjalankan tes individual

```bash
npm run build && node --test dist/tests/prioritizer.test.js
npm run build && node --test --test-name-pattern="menandai tugas selesai" dist/tests/*.test.js
```

## Probe diagnostik

Menguji pemahaman satu kalimat langsung ke model, tanpa lewat Telegram:

```bash
npx tsx scripts/coba-pemahaman.ts "ingetin aku jam 8 minum obat"
npx tsx scripts/coba-pemahaman.ts --due "besok jam 7 malam"
npx tsx scripts/coba-pemahaman.ts --boundary "aku mau curhat"
```

Menguji bagaimana Harvy *terdengar*, bukan bagaimana ia membaca:

```bash
npx tsx scripts/coba-balasan.ts "aku capek banget hari ini"
npx tsx scripts/coba-balasan.ts --riwayat "yang tadi gimana"
npx tsx scripts/coba-balasan.ts --riwayat=percakapan.json "lanjut dong"
npx tsx scripts/coba-balasan.ts --listen "besok ada ulangan biologi"
```

Menguji Agent Runtime read-only dengan kasus sintetis, tanpa Telegram atau data
pengguna:

```bash
npx tsx scripts/coba-agent.ts
```

Tiga probe ini adalah jalur pemeriksaan model tanpa membuka Telegram dan
menampilkan balasan mentah model — termasuk jalur sempit
Ubah tenggat dengan `--due` dan keputusan menyimak bubble dengan `--boundary`.
`coba-balasan.ts` meniru routing privat ADR-022: emergency lokal langsung ke
triase, pesan lain menjalankan compiler lalu hanya mentriase RiskHint
`possible|strong` atau compiler failure, dan review hanya pada danger/support
yang belum pasti. Ia menampilkan disposition serta normalisasi/pemecahan
bubble, tetapi tidak menjalankan tombol atau state adapter. `coba-agent.ts`
menjalankan root tools,
delegasi paralel, dan agenda besok terhadap executor sintetis/virtual; trace
yang dicetak hanya capability/status, bukan observation atau credential.
`--riwayat` menyisipkan giliran contoh sehingga kesinambungan dan pengulangan pembuka ikut
terlihat. Tuliskan `\n` di argumen untuk menguji beberapa bubble sekaligus. Ini
membedakan balasan terpotong dari balasan rusak. Perlu `.env` berisi kunci
sungguhan; pakai `AI_MODE=testing` agar gratis. Probe ini memanggil model, jadi
tidak boleh masuk gerbang otomatis. Semua probe primary-only secara default
agar model tidak salah atribusi; `--allow-fallback` harus dipilih eksplisit dan
menampilkan model cadangannya. Runtime, probe, dan evaluator mengambil lock
atomik yang sama dari `<CONTROL_PLANE_FILE>.runtime.lock`; jangan menjalankan
probe/evaluator pada set data yang sedang dipakai aplikasi. Lock crash tidak
boleh dihapus sebelum PID pemilik dipastikan sudah mati.

## Konfigurasi environment

Konfigurasi runtime berasal dari `.env` (lihat `.env.example`):
`TELEGRAM_BOT_TOKEN`, `DATA_FILE`, `MEMORY_FILE`, `HISTORY_FILE`,
`MEMORY_FOLDER`, `PROFILE_FILE`, `SESSION_FILE`, `AGENT_RUN_FILE`, `TELEMETRY_FILE`,
`TELEMETRY_RETENTION_DAYS`, `DEFAULT_TIMEZONE`, `REMINDER_INTERVAL_MS`, serta
kelompok `AI_*` termasuk `AI_BASE_URL`, batas token 24 jam, dan harga input /
output tiap tier. Executor web dan konfigurasi `WEB_SEARCH_*`/`WEB_OPEN_*` sudah
dicabut; lihat ADR-015 sebagai histori, bukan setup aktif. Control plane lokal
memakai `CONTROL_PLANE_FILE`, `USAGE_LEDGER_FILE`, `ENTITLEMENT_LEDGER_FILE`,
retensi ledger,
`BETA_QUOTA_MULTIPLIER`, serta kelompok `HARVY_CONSOLE_*`; Console saat ini
wajib loopback dan bukan server internet-ready. Cadangan mode uji memakai
`AI_TESTING_FALLBACK_BASE_URL`, `AI_TESTING_FALLBACK_API_KEY`,
`AI_TESTING_FALLBACK_MODEL`, `AI_TESTING_FALLBACK_PROVIDER_ID`, dan
`AI_TESTING_FALLBACK_COOLDOWN_MS`; tiga nilai
pertama wajib diisi bersama. WhatsApp beta memakai `WHATSAPP_ENABLED`,
`WHATSAPP_PAIRING_MODE`, `WHATSAPP_ACCOUNTS`, `WHATSAPP_AUTH_FOLDER`,
`WHATSAPP_GROUP_FILE`, serta batas reconnect. Pairing QR lokal adalah default
pengembangan hanya pada terminal interaktif dan tidak pernah ditampilkan saat
`APP_ENV=production`; mode pairing code hanya opsi karena masih mempunyai
kegagalan upstream Baileys. Log operasional memakai `APP_ENV`, `RELEASE_SHA`, `LOG_LEVEL`,
`LOG_FOLDER`, retensi, batas segmen/total/antrean, format console, dan
`LOG_FILE_REQUIRED`. `HISTORY_FILE` berisi kata-kata pengguna apa adanya;
perlakukan sebagai data pribadi, bukan cache. `PROFILE_FILE` menyimpan catatan
persetujuan, preferensi waktu, dan tombstone penghapusan; menghapusnya membuat
semua pengguna diminta menyetujui ketentuannya lagi. `AGENT_RUN_FILE` memuat
permintaan, observation internal, jawaban, dan progress checkpoint yang sedang
menunggu; perlakukan sebagai data pribadi dan jangan menyalinnya ke log.
Berkas `.env` dibaca lewat
`process.loadEnvFile()`, tanpa dependency tambahan.

## Model routing

ID model tidak boleh ditulis di kode. Nama dan harga model berubah cepat, jadi
semuanya dibaca dari environment agar koreksi cukup satu baris `.env`.
`AI_MODE=testing` memakai model gratis lewat Google AI Studio dengan beberapa
kunci bergantian dan boleh memakai satu provider OpenAI-compatible sebagai
cadangan; `AI_MODE=production` memakai tiga model lewat OpenRouter dan selalu
mengabaikan konfigurasi cadangan testing. Tanpa kunci, bot menolak start.

Harvy Console menginventarisasi seluruh slot model environment yang nonkosong
pada startup—testing default/override, fallback, dan production—tetapi hanya
mengekspos provider/model, mode, origin, tier, nama slot, dan status aktif.
Base URL, key, token pool, dan credential tidak boleh masuk kontrak Console.
Operator memilih satu pasangan katalog dan hanya mengatur harga; server wajib
menolak pasangan buatan. Menghapus model dari `.env` tidak menghapus histori
harganya, tetapi mencegah versi harga baru sampai model dikonfigurasi kembali.

Cadangan testing menerima base URL tanpa `/chat/completions`, query, atau
kredensial. Kuncinya dikirim lewat `Authorization: Bearer`; model dikirim lewat
body dan query karena gateway yang sedang dipakai membutuhkannya. Timeout,
gangguan jaringan, dan HTTP 5xx pada primary langsung pindah provider; HTTP 429
lebih dulu mengikuti batas rotasi kunci primary pada request tersebut (secara
default seluruh kunci). Pembatalan lifecycle, HTTP 4xx lain, keluaran rusak,
serta penolakan kuota lokal tidak boleh memicu cadangan.
Satu kegagalan provider-wide atau 429 yang sudah mengenai seluruh kunci primary
membuka circuit selama cooldown in-memory. Bila request sengaja membatasi
percobaan sebelum semua kunci dicoba, 429 itu boleh failover untuk request
tersebut tetapi tidak membuka circuit bagi request berikutnya.
Evaluator model nyata tetap primary-only secara default agar satu run tidak
diam-diam mencampur model; `--allow-fallback` hanya untuk run availability dan
wajib tercatat pada ringkasannya.

Dalam mode `testing`, `resolveModel` memakai `AI_MODEL_TESTING` untuk semua
tingkatan kecuali yang diberi model sendiri lewat `AI_MODEL_TESTING_CHEAP`,
`AI_MODEL_TESTING_EFFICIENT`, atau `AI_MODEL_TESTING_AMBITIOUS`. Selama peta itu
kosong, routing tetap dihitung tetapi tidak dapat diamati — jangan mengklaim
routing sudah terbukti setelah menguji dalam keadaan itu.

### Profile capability model

`AI_MODEL_PROFILES` adalah array JSON opsional untuk capability yang telah
diverifikasi operator bagi pasangan provider+ID model exact. Tanpa variabel
ini, setiap slot memakai profile `compatibility`: routing/tool behavior lama
tetap ada, tetapi Harvy tidak mengirim reasoning control atau replay reasoning
assistant-level baru. Base URL dan substring nama model tidak pernah dipakai
untuk menebak capability.

Setiap entry wajib mempunyai schema penuh berikut; ID harus sudah berada di
salah satu slot model environment (aktif maupun tidak aktif):

```json
[
  {
    "provider": "openrouter",
    "id": "vendor/model-id-exact",
    "reasoning": {
      "mandatory": false,
      "defaultEffort": "medium",
      "supportedEfforts": ["low", "medium", "high"],
      "wireFormat": "openrouter-reasoning"
    },
    "supports": {
      "tools": true,
      "toolChoice": true,
      "namedToolChoice": true,
      "structuredOutput": true,
      "temperature": true
    },
    "continuation": {
      "preserveReasoning": true,
      "preserveAssistantMessage": true
    },
    "contextWindow": null,
    "maxOutputTokens": null
  }
]
```

Minify array tersebut menjadi satu nilai `.env`. `null` berarti batas belum
diverifikasi dan tidak boleh diperlakukan sebagai tak terbatas. Wire yang
tersedia saat ini: `openai-reasoning-effort` untuk Google AI Studio,
`openrouter-reasoning`, `deepseek-thinking`, atau `none`. DeepSeek baru
mempunyai primitive adapter sintetis dan belum menjadi provider production di
composition root. Verifikasi ulang dokumentasi resmi dan jalankan smoke data
sintetis setiap kali model/capability berubah; startup gagal tertutup pada
profile asing, duplikat, rusak, atau kontradiktif.
Provider fallback testing belum menerima profile explicit; runtime menolaknya
agar mandatory reasoning/effort tidak diturunkan diam-diam saat failover.

Percakapan yang menyentuh keselamatan memakai tingkatan `efficient`, bukan
`ambitious`. Keputusan pemilik produk 27 Juli 2026: di produksi tingkatan itu
adalah GPT 5.6 Luna dan dinilai cukup.
