# ADR-028 — Output Policy dan Cadangan Final Synthesis

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-003, ADR-017, ADR-018, ADR-025, ADR-026, ADR-027
- **Mengamendemen:** ceiling general pada ADR-025 dan batas RunBudget pada
  ADR-026

## Konteks

Execution policy dan cumulative RunBudget sudah tersedia, tetapi call general
masih memakai ceiling lama yang tersebar: 4.096 token untuk reply/planner dan
1.536 token untuk worker. Pada reasoning model, ceiling itu juga menanggung
reasoning internal sehingga function call atau jawaban final dapat terpotong
meskipun total run masih mempunyai budget besar. Sebaliknya, sekadar menaikkan
semua ceiling tanpa reservasi cumulative dapat membuat planner, retry, atau
fan-out menghabiskan seluruh budget sebelum sintesis terakhir.

Classifier dan extractor mekanis tetap membutuhkan output sempit. Perubahan
ini hanya boleh melonggarkan call general melalui policy kode, tetap tunduk pada
profile exact, dan tidak boleh menjadikan model authority atas budget.

## Keputusan

1. **ExecutionPolicy memiliki default ceiling general.** Tanpa override
   eksplisit, conversationalist dan worker mendapat emergency ceiling 8.192
   token; planner, synthesizer, dan recovery 32.768; critic 4.096; extractor dan
   classifier 2.048. Ceiling mekanis yang lebih kecil tetap dipasang caller.
   Bila profile exact menyatakan maksimum lebih kecil, policy meng-clamp ke
   maksimum itu. Override eksplisit yang melampaui profile tetap ditolak.
2. **Request memakai hasil policy yang sama.** `max_tokens` yang dikirim client
   harus persis sama dengan `ExecutionPlan.maxOutputTokens`; mismatch gagal
   sebelum API key, attempt ledger, atau network. Provider-attempt telemetry
   tetap mencatat effective ceiling secara content-free.
3. **Model call mempunyai kelas budget code-owned.** Planner, worker,
   classifier, extractor, dan critic adalah `work`. Conversationalist,
   synthesizer, dan recovery adalah `final`. Prompt, provider response, dan
   model tidak dapat memilih kelas tersebut. Pemanggil langsung RunBudget yang
   tidak menyatakan kelas dianggap `work` secara fail-closed.
4. **Satu bagian RunBudget dilindungi untuk final synthesis.** Work call tidak
   dapat mereservasi separuh total token/biaya; reserve token dibatasi paling
   tinggi 49.152. Pada budget default 96.000, reserve aktual adalah 48.000:
   emergency ceiling output 32.768 plus headroom input 15.232. Limit yang
   sedikitnya 98.304 mencapai cap dan memberi headroom input 16.384. Final call
   dapat memakai bagian itu. View planner membedakan total remaining, remaining
   work, serta reserve final yang masih tersedia.
5. **Actual usage tetap menang.** Jika usage work aktual melewati bagian work,
   tool atau work non-final berikutnya berhenti. Final yang sudah lengkap tetap
   boleh dipublikasikan sesuai ADR-026, dan final call baru masih boleh memakai
   reserve selama hard total budget belum terlampaui.
6. **Checkpoint tidak berganti schema.** Reserve diturunkan deterministik dari
   limits dan counter RunBudget yang sudah dipersistenkan. Resume karena input
   pengguna atau restart mempertahankan reserve tanpa menambah limit baru.

## Batas change set ini

- Context-pressure compaction, recovery otomatis atas truncation, reserved
  context window, visible verbosity wire, validator-driven escalation, dan
  K3/toughest belum diimplementasikan.
- Pada budget default, reserve token menjamin ruang final hanya selama estimasi
  input final tidak melampaui headroom 15.232. Limit sedikitnya 98.304 memberi
  headroom hingga 16.384; input yang lebih besar tetap dapat ditolak sampai
  compaction tekanan konteks tersedia.
- Planner native saat ini dapat menyelesaikan atau mengusulkan tool dalam call
  yang sama. Kelas `synthesizer` melindungi fase setelah observation, tetapi
  belum merupakan finalizer terpisah yang selalu dipaksa terminal.
- Ceiling eksplisit yang memang mekanis atau product-bounded—boundary, triage,
  review, privacy classifier, episode summary, dan group participation—tidak
  dilonggarkan oleh keputusan ini.
- Ceiling lebih tinggi adalah emergency maximum, bukan target panjang jawaban.
  Batas karakter reply, verbosity, actual usage, dan cumulative budget tetap
  berlaku.

## Konsekuensi

Positif:

- reasoning/tool call general tidak lagi dicekik oleh ceiling lama 1.536/4.096;
- retry dan worker tidak dapat menghabiskan seluruh token/biaya yang diperlukan
  untuk sintesis terakhir; dan
- profile model, checkpoint, serta telemetry tetap konsisten dengan policy yang
  benar-benar dipakai client.

Trade-off:

- reservation maksimum per call lebih besar sehingga work yang sangat lebar
  dapat ditolak lebih awal oleh cumulative budget;
- provider tanpa usage yang dapat dipercaya akan menahan reservation besar
  secara konservatif; dan
- reserve final belum menggantikan kebutuhan compaction serta recovery
  truncation.

## Bukti

Tes deterministik mencakup default ceiling dan profile clamp, kelas work/final
di planner/synthesizer/worker, preflight client sebelum key/network, reserve
token dan biaya, actual overage sebelum tool, serta restore checkpoint yang
mempertahankan reserve. `npm run check` dan `npm test` lulus, 845 test dalam
108 suite, 0 gagal. Provider/model dan kanal nyata belum diuji.
