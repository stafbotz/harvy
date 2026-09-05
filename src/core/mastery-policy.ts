import type { LearningTrace } from "../domain/learning-trace.js";
import type { SessionStage } from "../domain/session.js";

/**
 * Kapan Harvy boleh mundur, dan sejauh mana.
 *
 * Konstitusi menaruh ini sebagai kewajiban, bukan fitur. Pasal 2: "Untuk
 * kemampuan yang sudah dikuasai pengguna, Harvy mengurangi bantuan secara
 * bertahap apabila sesuai dengan tujuan pengguna." Pasal 4 menutup tangga
 * bantuan belajar dengan "Harvy mengurangi bantuan ketika pengguna siap."
 *
 * Dua kalimat lain di pasal yang sama adalah pagarnya, dan keduanya lebih
 * penting daripada mekanisme apa pun di berkas ini:
 *
 * - "Harvy tidak sengaja mempersulit pengguna dengan dalih membangun
 *   kemandirian." (Pasal 3)
 * - Tabel evaluasi konstitusi menandai "Harvy selalu menolak memberi jawaban
 *   dengan alasan 'demi kemandirian'" sebagai **perlu dirancang ulang**,
 *   dengan sebab: paternalistik dan tidak memperhatikan keadaan pengguna.
 *
 * Karena itu yang diputuskan di sini **hanya tahap pembuka sebuah sesi tutor**.
 * Ia tidak pernah menolak menjawab, tidak pernah mengunci tahap, dan tidak
 * pernah menahan bantuan: sinyal `stuck` tetap membawa pelajarnya turun ke
 * `hint` lalu `explain` pada giliran yang sama seperti sebelumnya. Yang berubah
 * hanyalah dari mana sesi dimulai—dan pelajar yang sudah tiga kali mengerjakan
 * turunan sendiri tidak perlu ditanya lagi "sudah paham konsepnya belum?".
 *
 * Modul ini murni: tidak menyentuh jaringan, berkas, jam, maupun model.
 */

/**
 * Berapa banyak penyelesaian mandiri sebelum pembukanya dipendekkan.
 *
 * Tiga, bukan satu. Sekali berhasil bisa berarti soalnya kebetulan mudah;
 * tiga kali berturut pada topik yang sama adalah pola. Angka yang sama dipakai
 * `offer-fatigue-policy` untuk alasan yang sama.
 */
export const MASTERY_INDEPENDENT_RUNS = 3;

/**
 * Umur jejak yang masih dihitung.
 *
 * Kemampuan memudar, dan pelajar berganti semester. Jejak yang lebih tua dari
 * ini tidak lagi menjadi alasan untuk mundur—kalau ternyata ia masih bisa,
 * satu sesi akan menunjukkannya lagi dan jejaknya diperbarui.
 */
export const MASTERY_TRACE_MAX_AGE_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Seberapa penuh bantuan dibuka pada sesi tutor.
 *
 * `penuh` memulai dari `assess`—menanyakan dulu apa yang sudah ia pahami.
 * `ringkas` melewati itu dan langsung mempersilakan mencoba. Tidak ada tingkat
 * ketiga yang menolak membantu; tingkat seperti itu akan melanggar Pasal 3.
 */
export type SupportLevel = "penuh" | "ringkas";

/**
 * Menyamakan dua topik yang ditulis berbeda.
 *
 * Perbandingan kata, bukan model kedua: sebuah keputusan yang mengubah cara
 * Harvy membuka sesi harus dapat dibaca dan diuji tanpa memanggil apa pun.
 * Sengaja ketat—dua topik dianggap sama hanya bila kata beratinya benar-benar
 * beririsan sebagian besar. Salah menganggap sama berarti mundur pada topik
 * yang belum pernah dikerjakan, dan itu kesalahan yang merugikan pelajarnya.
 */
export function sameTopic(left: string, right: string): boolean {
  const a = significantWords(left);
  const b = significantWords(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }
  const smaller = Math.min(a.size, b.size);
  return shared >= Math.max(1, Math.ceil(smaller * 0.6));
}

/**
 * Jejak untuk satu topik, terbaru lebih dulu, yang masih dihitung.
 */
export function tracesForTopic(
  traces: readonly LearningTrace[],
  topic: string,
  now: Date,
): LearningTrace[] {
  const cutoff = now.getTime() - MASTERY_TRACE_MAX_AGE_DAYS * DAY_MS;
  return traces
    .filter((trace) =>
      Date.parse(trace.completedAt) >= cutoff && sameTopic(trace.topic, topic)
    )
    .sort((left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt)
    );
}

/**
 * Tingkat bantuan untuk sebuah sesi tutor yang akan dibuka.
 *
 * Mundur hanya ketika penyelesaian mandiri **berturut-turut** mencapai ambang.
 * Satu sesi yang perlu dijelaskan mengembalikannya ke `penuh` seketika, dan
 * itu disengaja: kesulitan yang baru muncul lebih berarti daripada keberhasilan
 * bulan lalu.
 */
export function supportLevelFor(
  traces: readonly LearningTrace[],
  topic: string,
  now: Date,
): SupportLevel {
  const recent = tracesForTopic(traces, topic, now);
  if (recent.length < MASTERY_INDEPENDENT_RUNS) return "penuh";
  const streak = recent.slice(0, MASTERY_INDEPENDENT_RUNS);
  return streak.every((trace) => trace.depth === "mandiri") ? "ringkas" : "penuh";
}

/**
 * Tahap pembuka sesi tutor.
 *
 * Satu-satunya tempat tingkat bantuan berpengaruh. Sesudah sesi berjalan,
 * seluruh tangga bekerja seperti biasa.
 */
export function openingTutorStage(level: SupportLevel): SessionStage {
  return level === "ringkas" ? "attempt" : "assess";
}

/**
 * Kata yang cukup berarti untuk dicocokkan.
 *
 * Sama dengan penyaringan di `memory-policy`: kata sangat pendek muncul di
 * hampir setiap kalimat dan hanya membuat semua topik terlihat sama.
 */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("id-ID")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3),
  );
}
