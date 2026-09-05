export interface LivePlanQuality {
  passed: boolean;
  numberedSteps: number;
  stepsWithAction: number;
  stepsWithEvidence: number;
  stepsWithPassCriterion: number;
  contaminatedBySafetyScenario: boolean;
}

/**
 * Permintaan yang benar-benar membuka jalur planning durable.
 *
 * Naskah sebelumnya meminta rencana audit kualitas Harvy sendiri. Ia berhenti
 * bekerja karena dua sebab sekaligus, dan keduanya Harvy yang benar.
 *
 * Pertama rutenya. Sejak `requiresPlannedExecution` mensyaratkan `toolNeed`
 * bernilai `execution` atau `external`, rencana yang dapat langsung dijawab
 * di chat tidak lagi membuka AgentRun—kontrak pemahaman menyuruh model
 * menandainya `none`, dan syarat itu sendiri perbaikan atas defect "analisis
 * chat-only membuka AgentRun". Diukur atas naskah lama: `toolNeed` `none`
 * pada 3 dari 3 percobaan, jadi stage-nya tidak akan pernah hijau lagi.
 *
 * Kedua isinya. Diminta menyusun audit teknis atas dirinya sendiri, Harvy
 * menolak dengan alasan ia tidak punya akses ke kode, log, maupun telemetry,
 * lalu menawarkan checklist dari sisi pengguna. Itu kejujuran yang memang
 * diminta Pasal 5, bukan kegagalan.
 *
 * Naskah ini menggantinya dengan pekerjaan yang memang berat, bertahap, dan
 * membutuhkan pengumpulan sumber: 4 dari 4 percobaan menghasilkan
 * `toolNeed: external`, complexity deep, executionSize heavy. Bentuk
 * jawabannya tetap sama—tepat tiga langkah dengan Tindakan, Bukti, dan
 * Kriteria lulus—sehingga `assessThreeStepAuditPlan` tetap berlaku.
 *
 * `label` tetap ikut sebagai judul supaya hasil satu run dapat dibedakan dari
 * run lain; posisinya di kalimat terakhir dan tidak mengubah rutenya.
 *
 * Naskahnya sengaja pendek. Versi yang lebih lengkap—menambahkan "Berikan
 * detail yang cukup agar orang lain dapat menjalankannya tanpa menebak"—membuat
 * modelnya mengerjakan pekerjaan yang lebih berat dan stage-nya lulus 1 dari 5,
 * lawan 3 dari 6 pada naskah ini. Sebabnya bukan naskahnya melainkan
 * `DEFAULT_AGENT_RUN_LIMITS.deadlineMs`; lihat
 * `docs/engineering/status/telegram.md`.
 */
export function liveAcceptancePlanningPrompt(label: string): string {
  return [
    "Tolong kerjakan riset perbandingan mendalam tiga teknik menghafal, kumpulkan sumbernya, lalu susun rencana tepat tiga langkah.",
    "Setiap langkah wajib memuat Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus.",
    `Beri judul rencananya dengan kode ${label}.`,
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
