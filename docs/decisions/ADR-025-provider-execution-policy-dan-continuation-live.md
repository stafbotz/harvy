# ADR-025 — Provider, Execution Policy, dan Continuation Live

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-003, ADR-013, ADR-017, ADR-018, ADR-020
- **Diamendemen oleh:** ADR-026 untuk cumulative RunBudget physical attempt dan
  ADR-028 untuk output policy general; batas historis change set ADR-025 di
  bawah tetap benar untuk change set itu

## Konteks

Routing Harvy sudah memilih tier `cheap|efficient|ambitious`, tetapi setiap
call masih menentukan temperature, output ceiling, dan bentuk provider secara
tersebar. Endpoint OpenAI-compatible tidak membuktikan bahwa semua model pada
endpoint itu mendukung reasoning effort, tool choice, structured output, atau
continuation yang sama. Planner juga hanya memutar ulang `tool_calls`; metadata
reasoning assistant-level dapat hilang di tengah tool loop.

Capability provider berubah cepat. Keputusan ini memakai dokumentasi resmi
yang diperiksa 9 Agustus 2026: Google memetakan `reasoning_effort` menurut
keluarga Gemini, OpenRouter mengekspos capability reasoning per model dan
memerlukan replay `reasoning_details` secara utuh, sedangkan DeepSeek thinking
tool loop memerlukan replay `reasoning_content`. Fakta itu bukan izin untuk
menggeneralisasi seluruh model pada satu gateway.

## Keputusan

1. **Profile terikat exact provider+model.** `ModelProfileRegistry` memakai
   pasangan provider dan ID model tanpa tebakan substring. Seluruh model yang
   ada di slot environment mendapat profile `compatibility`; profile ini
   mempertahankan perilaku lama tetapi mengaktifkan nol reasoning wire.
   Capability baru hanya aktif melalui deklarasi `AI_MODEL_PROFILES` yang
   schema-valid dan exact. Profile asing, duplikat, enum/limit rusak, atau
   kombinasi capability yang kontradiktif menggagalkan startup.
2. **Tier, role, effort, dan verbosity adalah dimensi terpisah.** Pure
   `ExecutionPolicy` menghasilkan tier, work class, role, requested/effective
   effort, verbosity, output ceiling, deadline, max step, dan izin tool/
   delegasi. Prompt, model, dan tool output tidak boleh memilihnya. Effort yang
   tidak didukung hanya boleh turun ke nilai yang didukung; policy gagal
   tertutup bila satu-satunya pilihan justru menaikkannya.
3. **Adapter memiliki wire provider.** Google OpenAI compatibility memakai
   `reasoning_effort`; OpenRouter memakai `reasoning.effort` dengan reasoning
   tidak dikecualikan; primitive DeepSeek memakai `reasoning_effort` dan
   `thinking.type=enabled`. Temperature, structured output, tool choice, dan
   limit yang dinyatakan profile dikontrol sebelum fetch. Custom base URL tidak
   otomatis mendapat capability provider tertentu.
4. **Continuation berupa assistant turn utuh dan hanya hidup selama
   invocation.** Planner production memakai `completeToolTurn()`, menyimpan
   content, tool calls, serta field Chat Completions yang dikenal:
   `reasoning`, `reasoning_content`, `reasoning_details`, dan Gemini
   `thought_signature`. Metadata dibatasi ukuran/depth/node, di-clone dan
   dibekukan, serta terikat ke provider+model. Adapter hanya mengirim field
   wire allowlist dan menolak replay lintas binding.
5. **Reasoning bukan memory atau authority.** Raw reasoning tidak masuk log,
   telemetry, checkpoint, history, memory, approval, scope, atau idempotency.
   Checkpoint tetap provider-neutral; resume membangun transcript baru.
   `completeToolCalls()` dipertahankan untuk kompatibilitas one-shot, tetapi
   tidak boleh dipakai oleh loop yang akan mengirim hasil tool kembali.
6. **Respons nonterminal gagal tertutup.** Hanya `finish_reason=stop` untuk
   teks dan `finish_reason=tool_calls` untuk native tool yang diterima. Length,
   content filter, reason asing, atau reason yang hilang tidak pernah
   diteruskan sebagai jawaban sukses. Ledger membedakan `truncated` dan
   `incomplete` serta tetap menyimpan usage content-free yang dilaporkan.
7. **Observability tetap bebas isi.** Provider-attempt ledger boleh menyimpan
   role, requested/effective effort, dan verbosity. Ia tidak boleh menyimpan
   reasoning atau provider assistant turn. Record v1 lama tanpa metadata baru
   tetap terbaca.

## Batas change set ini

Ini adalah fondasi Phase C, bukan penyelesaian Phase C. Change set ini sengaja
tidak:

- menambah tier `toughest` atau mengaktifkan K3;
- mengganti routing tier lama dengan route role yang memilih model lain;
- menerapkan verbosity pada wire/output yang terlihat;
- melonggarkan output ceiling agent/general;
- membuat cumulative `RunBudget`, context-pressure compaction, atau recovery
  otomatis atas truncation;
- mendukung opaque provider fields, `previous_response_id`, Responses API,
  atau continuation durable lintas restart; atau
- mengklaim DeepSeek sebagai provider production Harvy.

Ceiling lama tetap dipertahankan sampai budget total satu logical run dan
turunannya tersedia. Primitive DeepSeek hanya mempunyai tes adapter/client
sintetis; composition root saat ini tetap Google AI Studio atau OpenRouter.

## Konsekuensi

Positif:

- model yang belum diverifikasi tidak menerima reasoning field baru;
- keputusan biaya/kualitas dapat diamati tanpa mencatat isi reasoning;
- tool loop Chat Completions tidak lagi kehilangan metadata continuation yang
  dikenal; dan
- request invalid ditolak sebelum attempt dicatat atau API key diputar.

Trade-off:

- operator harus memperbarui deklarasi exact ketika mengganti model;
- registry belum melakukan discovery capability provider saat startup; dan
- provider/model live tetap harus di-smoke dengan data sintetis sebelum
  capability explicit dianggap terbukti operasional.

## Bukti dan sumber

Tes lokal mencakup registry/config fail-closed, policy downgrade, serializer
Google/OpenRouter/DeepSeek, omission tool choice, replay exact dan binding,
batas continuation, allowlist payload, incomplete response, rotasi key, serta
metadata ledger. Uji provider, Telegram, dan WhatsApp nyata belum dijalankan.

Sumber primer yang diperiksa:

- [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [OpenRouter reasoning tokens dan preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
