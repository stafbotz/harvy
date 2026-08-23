export interface LivePlanQuality {
  passed: boolean;
  numberedSteps: number;
  stepsWithAction: number;
  stepsWithEvidence: number;
  stepsWithPassCriterion: number;
  contaminatedBySafetyScenario: boolean;
}

export function liveAcceptancePlanningPrompt(label: string): string {
  return [
    `Saya sedang menilai kualitas Harvy pada run ${label}.`,
    "Tolong susun rencana mendalam tepat tiga langkah yang konkret untuk memeriksa onboarding, alur pekerjaan durable, dan pemulihan kegagalan.",
    "Pada setiap langkah, tulis jelas: Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus.",
    "Berikan detail yang cukup agar orang lain dapat menjalankannya tanpa menebak.",
  ].join(" ");
}

/**
 * Acceptance ini sengaja menilai kegunaan, bukan sekadar adanya balasan.
 * Prompt live meminta tepat tiga langkah dengan tindakan, bukti, dan kriteria
 * lulus; semua unsur itu harus benar-benar terlihat pada setiap langkah.
 */
export function assessThreeStepAuditPlan(text: string): LivePlanQuality {
  const normalized = text.trim();
  const sections = numberedSections(normalized);
  const actionPattern = /\b(tindakan|lakukan|jalankan|uji|periksa|audit|bandingkan|simulasikan|verifikasi)\b/iu;
  const evidencePattern = /\b(bukti|evidence|catat|rekam|log|trace|screenshot|hasil|artefak|metrik)\b/iu;
  const criterionPattern = /\b(kriteria\s+lulus|lulus\s+(?:jika|bila|ketika)|berhasil\s+(?:jika|bila|ketika)|dinyatakan\s+lulus|pass\s+criteria)\b/iu;
  const stepsWithAction = sections.filter((section) =>
    actionPattern.test(section)
  ).length;
  const stepsWithEvidence = sections.filter((section) =>
    evidencePattern.test(section)
  ).length;
  const stepsWithPassCriterion = sections.filter((section) =>
    criterionPattern.test(section)
  ).length;
  const contaminatedBySafetyScenario =
    /bunuh diri|nomor darurat|\b112\b|menanggung semuanya sendirian/iu.test(
      normalized,
    );
  return {
    passed: normalized.length >= 420 && sections.length === 3 &&
      stepsWithAction === 3 && stepsWithEvidence === 3 &&
      stepsWithPassCriterion === 3 && !contaminatedBySafetyScenario,
    numberedSteps: sections.length,
    stepsWithAction,
    stepsWithEvidence,
    stepsWithPassCriterion,
    contaminatedBySafetyScenario,
  };
}

function numberedSections(text: string): string[] {
  const matches = [...text.matchAll(/^\s*([1-3])[.)]\s+(.+)$/gimu)];
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const [index, match] of matches.entries()) {
    const number = match[1];
    if (!number || seen.has(number)) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    sections.push(text.slice(start, end).trim());
    seen.add(number);
  }
  return sections;
}
