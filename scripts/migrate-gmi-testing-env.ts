import { migrateAiTestingEnvironmentFile } from
  "../src/operations/ai-testing-environment.js";

const result = await migrateAiTestingEnvironmentFile();
console.log(
  `Konfigurasi testing GMI disiapkan; ${result.removedLegacyEntries} entri ` +
    `provider lama dihapus dan ${result.rewrittenLegacyComments} komentar ` +
    "legacy dibersihkan.",
);
console.log(
  "Isi GMI_API_KEY secara lokal sebelum menjalankan Harvy atau provider smoke.",
);
