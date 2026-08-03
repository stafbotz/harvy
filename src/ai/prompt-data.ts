/**
 * Mengenkode teks tidak tepercaya sebelum diletakkan di dalam envelope prompt.
 * Ini bukan sanitizer semantik; tujuannya memastikan data tidak dapat menutup
 * tag pembatas buatan Harvy lalu menyamar sebagai instruksi di luarnya.
 */
export function escapePromptText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** JSON aman untuk blok bertag: karakter delimiter tetap berupa escape JSON. */
export function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
