export const GROUP_TURN_POLICY_VERSION = "2026-07-30.2";

/**
 * Koreksi bentuk giliran yang sempit dan bebas I/O.
 *
 * Ini tidak mengenali keadaan pribadi, bahaya, atau topik. Ia hanya mencegah
 * planner mengubah acknowledgment/izin/penutup koordinasi pendek menjadi
 * kesempatan Harvy menyela. Pertanyaan eksplisit tetap selalu lolos ke model.
 */
export function shouldHoldAmbientTurn(text: string): boolean {
  const clean = text
    .toLocaleLowerCase("id-ID")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean || clean.length > 120) return false;
  if (
    /[?]/u.test(clean) ||
    /\b(?:apa|siapa|kenapa|mengapa|gimana|bagaimana|kapan|mana|menurut)\b/iu.test(
      clean,
    )
  ) {
    return false;
  }
  return [
    /^(?:nah\s+)?(?:itu|ini)\s+(?:(?:yang|yg)\s+)?(?:menarik|jelas|pas)(?:\s+(?:sih|banget|ya|yah))?[.!…]*$/iu,
    /^(?:boleh|silakan)\s+(?:kirim|lanjut|coba)(?:\s+(?:dulu|aja|sekarang|ya|yah))?[.!…]*$/iu,
    /^(?:sip|oke|ok|siap|noted|mantap)(?:\s+(?:deh|ya|yah|nih|makasih|terima\s+kasih|gas|kabarin(?:\s+aja)?|nanti\s+(?:digabung|dikirim|dibahas)(?:\s+\S+){0,2}))?[.!…]*$/iu,
  ].some((pattern) => pattern.test(clean));
}
