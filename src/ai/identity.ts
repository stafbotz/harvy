/**
 * Nama lapisan model Harvy.
 *
 * Harvy tidak bergantung pada satu model dasar. "Capybara" adalah nama sistem
 * model Harvy yang memilih dan merangkai beberapa model sesuai kebutuhan,
 * sehingga jawaban ini tetap benar ketika penyedia atau model dasarnya berubah.
 */
export const CAPYBARA_MODEL_REPLY =
  "Aku pakai model Capybara—sistem AI Harvy yang memakai beberapa model sesuai kebutuhan, bukan cuma satu model dasar.";

export const CAPYBARA_MIXED_MESSAGE_GUIDANCE = [
  "Pesan saat ini juga menanyakan identitas model Harvy.",
  "Aplikasi akan menambahkan jawaban tetap tentang model Capybara.",
  "Jangan menyebut model dasar, penyedia, GPT, Gemini, Claude, atau ChatGPT.",
  "Jawab hanya bagian lain dari permintaan pengguna.",
].join(" ");

const IDENTITY_FAST_PATH_CONTEXT_MS = 30 * 60 * 1_000;

/**
 * Pertanyaan identitas model dijawab oleh produk, bukan dibiarkan berubah-ubah
 * mengikuti model yang kebetulan sedang terpilih pada giliran tersebut.
 */
export function isModelIdentityQuestion(message: string): boolean {
  const normalized = normalizeIdentityMessage(message);

  if (!normalized) return false;
  if (
    /\b(?:ai|model)\s+apa\s+(?:yang\s+)?(?:cocok|bagus|terbaik|untuk|buat)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  const asksGenericModel =
    /\b(model|ai)\s*(apa|apaan|mana)\b/.test(normalized) ||
    /\b(pakai|pake|menggunakan|gunain)\s+(model|ai)\b/.test(normalized) ||
    /\b(model|ai)\s+(yang\s+)?(kamu|harvy|lu|lo|anda)\s+(pakai|pake|gunakan)\b/.test(
      normalized,
    ) ||
    /\b(modelmu|ai mu|aimu)\b/.test(normalized) ||
    /\b(dibuat|ditenagai)\s+(?:pakai|pake|dengan|oleh)\s+(?:model\s+)?(?:apa|ai)\b/.test(
      normalized,
    ) ||
    /\b(?:what|which)\s+(?:ai\s+)?model\s+(?:are|do)\s+(?:you|harvy)\b/.test(
      normalized,
    ) ||
    /\b(?:what|which)\s+(?:ai\s+)?model\s+(?:is|does)\s+harvy\b/.test(
      normalized,
    );

  const asksNamedModel =
    /\b(?:kamu|harvy|lu|lo|anda)\s+(?:itu\s+)?(?:pakai\s+|pake\s+|menggunakan\s+)?(?:chatgpt|gpt(?:\s*\d+(?:\.\d+)?)?|gemini|claude|llama|openai)\b/.test(
      normalized,
    ) ||
    /\b(?:are\s+you|is\s+harvy)\s+(?:an?\s+)?(?:ai|chatgpt|gpt|gemini|claude|llama)\b/.test(
      normalized,
    ) ||
    /\b(?:pakai|pake|menggunakan|powered\s+by|built\s+with)\s+(?:model\s+)?(?:chatgpt|gpt(?:\s*\d+(?:\.\d+)?)?|gemini|claude|llama|openai)\b/.test(
      normalized,
    );

  if (asksNamedModel) return true;
  if (!asksGenericModel) return false;

  return (
    /\b(kamu|harvy|lu|lo|anda|dirimu|you|modelmu|ai mu|aimu)\b/.test(normalized) ||
    /^(model|ai)\s*(apa|apaan|mana)\b/.test(normalized) ||
    /^(pakai|pake|menggunakan|gunain)\s+(model|ai)\b/.test(normalized)
  );
}

/**
 * Jalur tanpa model hanya untuk pertanyaan identitas yang berdiri sendiri.
 * Pesan campuran tetap melewati pemahaman dan triase agar permintaan lain atau
 * sinyal keselamatan tidak terbuang.
 */
export function isPureModelIdentityQuestion(message: string): boolean {
  if (!isModelIdentityQuestion(message)) return false;

  const normalized = normalizeIdentityMessage(message);
  return [
    /^(?:hai |halo |hey |oi |woy )?(?:harvy )?(?:kamu |lu |lo |anda )?(?:pakai |pake |menggunakan )?(?:model|ai) (?:apa|apaan|mana)(?: sih| dong| ya| nih)?$/,
    /^(?:hai |halo |hey |oi |woy )?(?:harvy )?(?:modelmu|ai mu|aimu) (?:apa|apaan|mana)(?: sih| dong| ya| nih)?$/,
    /^(?:hai |halo |hey |oi |woy )?(?:harvy )?(?:kamu|lu|lo|anda) (?:itu )?(?:pakai |pake |menggunakan )?(?:chatgpt|gpt(?: \d+(?: \d+)?)?|gemini|claude|llama|openai|ai)(?: ya| bukan| kah| nih)?$/,
    /^(?:hai |halo |hey |oi |woy )?(?:harvy )?(?:pakai|pake|menggunakan) (?:model )?(?:apa|chatgpt|gpt(?: \d+(?: \d+)?)?|gemini|claude|llama|openai)(?: ya| nih)?$/,
    /^(?:hai |halo |hey |oi |woy )?(?:harvy )?(?:ai|model) apa yang (?:kamu|harvy|lu|lo|anda) (?:pakai|pake|gunakan|menggunakan)(?: sih| ya)?$/,
    /^(?:hai |halo |hey |oi |woy )?harvy (?:dibuat|ditenagai) (?:pakai|pake|dengan|oleh) (?:model )?(?:apa|ai)(?: sih| ya)?$/,
    /^(?:what|which) (?:ai )?model (?:are|do) (?:you|harvy)(?: using| use)?$/,
    /^(?:are you|is harvy) (?:an? )?(?:ai|chatgpt|gpt|gemini|claude|llama)$/,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * Jalur deterministik boleh melewati model hanya bila tidak ada episode chat
 * yang masih hangat. Dalam episode aktif, pertanyaan polos sekalipun melewati
 * triase agar lanjutan singkat setelah percakapan berisiko tidak terputus.
 */
export function canUseModelIdentityFastPath(
  message: string,
  turns: readonly { at: string }[],
  now = new Date(),
): boolean {
  if (!isPureModelIdentityQuestion(message)) return false;
  const latest = turns.at(-1);
  if (!latest) return true;
  const at = new Date(latest.at).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > IDENTITY_FAST_PATH_CONTEXT_MS;
}

export function prependCapybaraIdentity(reply: string): string {
  const clean = reply.trim();
  return clean ? `${CAPYBARA_MODEL_REPLY}\n\n${clean}` : CAPYBARA_MODEL_REPLY;
}

function normalizeIdentityMessage(message: string): string {
  return message
    .toLocaleLowerCase("id-ID")
    .replace(/[?!.,:;()[\]{}"'`*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
