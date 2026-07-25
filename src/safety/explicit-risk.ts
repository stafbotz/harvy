const EXPLICIT_SERIOUS_RISK_PATTERNS = [
  /\b(?:aku|saya|gue|gua)\s+(?:mau|ingin|pengen|kepengin|berencana)\s+(?:bunuh diri|mengakhiri hidup|menyakiti diri|nyakitin diri)\b/i,
  /\b(?:aku|saya|gue|gua)\s+(?:mau|ingin|pengen|kepengin|berencana)\s+mati(?:\s+(?:sekarang|malam ini|hari ini|saja|aja|banget))?\s*(?:[.!?]|$)/i,
  /\b(?:mau|ingin|pengen|kepengin)\s+(?:bunuh diri|mengakhiri hidup|menyakiti diri|nyakitin diri)\b/i,
  /\b(?:aku|saya|gue|gua)\s+(?:sedang|lagi)\s+(?:dipukul|disiksa|dilecehkan|diperkosa|diancam)\b/i,
  /\b(?:dia|mereka|orang)\s+(?:sedang|lagi|mau)\s+(?:memukul|menyakiti|memperkosa|membunuh)\s+(?:aku|saya|gue|gua)\b/i,
  /\b(?:aku|saya|gue|gua)\s+(?:sedang|lagi)\s+(?:tidak aman|nggak aman|gak aman)\b/i,
  /\b(?:aku|saya|gue|gua)\s+(?:tidak|nggak|gak)\s+aman\b/i,
];

export function hasExplicitSeriousRisk(message: string): boolean {
  return EXPLICIT_SERIOUS_RISK_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}
