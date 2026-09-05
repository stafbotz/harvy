import type { Transformer } from "grammy";

/**
 * Tipe sinyal yang dideklarasikan grammY.
 *
 * grammY mengetik parameternya dengan `AbortSignal` dari paket polyfill
 * `abort-controller`, bukan yang global milik runtime. Nilainya pada saat
 * berjalan tetap `AbortSignal` platform; yang berbeda hanya deklarasinya.
 * Menurunkan tipenya dari `Transformer` membuat berkas ini ikut benar bila
 * grammY kelak memakai tipe global, tanpa satu pun cast.
 */
type GrammySignal = NonNullable<Parameters<Parameters<Transformer>[0]>[2]>;
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Pengawas atas jalur HTTP grammY.
 *
 * Tiga hal yang selama ini tidak terlihat dan tidak tertangani, seluruhnya
 * bertemu di satu tempat karena grammY memberi satu titik cegat untuk
 * ketiganya: transformer API.
 *
 * **1. Kegagalan polling tidak pernah tercatat.** grammY menangkap galat
 * `getUpdates` di dalam `fetchUpdates`, melaporkannya lewat `debugErr`—paket
 * `debug`, yang mati kecuali variabel lingkungan `DEBUG` diisi—lalu tidur tiga
 * detik dan mengulang tanpa batas. Galat itu tidak pernah sampai ke
 * `bot.catch`, yang hanya menangani galat *handler*. Akibatnya Harvy dapat
 * gagal menerima pesan selama berjam-jam sambil menghasilkan nol baris log.
 *
 * **2. Socket yang mati menggantung 500 detik.** Batas bawaan grammY adalah
 * `timeoutSeconds: 500`, sedangkan long-poll yang sehat dijawab Telegram dalam
 * ~30 detik. Ketika koneksi TCP mati tanpa menutup—soket masuk CLOSE-WAIT,
 * `epoll` tetap melaporkannya dapat dibaca, tidak ada exception yang
 * dilempar—Harvy tuli selama enam belas kali lipat jendela sehatnya, tanpa
 * satu pun sinyal.
 *
 * **3. `retry_after` diabaikan saat mengirim.** Telegram membatasi laju, dan
 * Harvy memecah balasan menjadi beberapa bubble. Bubble yang ditolak 429
 * melempar seketika; `PartialReplyDeliveryError` menangani akibatnya, tetapi
 * tidak ada yang mencoba lagi sesudah jeda yang justru diberitahukan Telegram
 * sendiri di dalam responsnya.
 *
 * Asalnya `hermes/plugins/platforms/telegram/adapter.py`, yang membangun tiga
 * detektor terpisah beserta watchdog untuk watchdog-nya sendiri. Sebagian besar
 * kerumitan itu **tidak** ditiru, dan alasannya bukan kemalasan: Hermes memakai
 * python-telegram-bot, yang tidak memberi titik cegat pada jalur HTTP-nya,
 * sehingga satu-satunya cara mengetahui polling sudah mati adalah menyelidikinya
 * dari luar—probe `get_me()`, `getWebhookInfo().pending_update_count`, dan
 * watchdog stall berbasis state lokal. Transformer grammY memberi Harvy tempat
 * yang tidak dimiliki Hermes: batas waktu dipasang pada permintaannya sendiri,
 * sehingga soket mati membatalkan dirinya lalu grammY membangun ulang koneksi
 * dengan mesin retry yang sudah ia punya. Yang di Hermes butuh tiga detektor,
 * di sini cukup satu deadline—di lapisan yang benar.
 */

/**
 * Batas satu putaran `getUpdates`.
 *
 * Long-poll Harvy meminta jendela 30 detik dan Telegram menjawab dalam batas
 * itu. Lima puluh lima detik memberi ruang untuk jaringan yang lambat sambil
 * tetap jauh di bawah 500 detik bawaan. Melewatinya berarti soketnya mati,
 * bukan Telegram-nya lambat.
 */
export const TELEGRAM_POLL_DEADLINE_MS = 55_000;

/**
 * Batas indikator mengetik.
 *
 * Murni kosmetik, tetapi ditunggu di dalam giliran. Tanpa batasnya sendiri,
 * satu panggilan yang menggantung menahan seluruh balasan selama 500 detik
 * demi tiga titik yang berkedip.
 */
export const TELEGRAM_TYPING_DEADLINE_MS = 10_000;

/** Jeda terlama yang masih dipatuhi dari `retry_after`. */
export const TELEGRAM_MAX_RETRY_AFTER_MS = 30_000;

/** Berapa kali satu permintaan dicoba, termasuk percobaan pertama. */
export const TELEGRAM_MAX_ATTEMPTS = 3;

/** Jendela peringkasan log agar gangguan panjang tidak membanjiri berkas. */
export const TELEGRAM_FAILURE_LOG_WINDOW_MS = 60_000;

/** Jeda bawaan indikator mengetik sesudah satu kegagalan. */
export const TELEGRAM_TYPING_COOLDOWN_MS = 30_000;

/** Batas atas penahanan indikator mengetik. */
export const TELEGRAM_TYPING_COOLDOWN_MAX_MS = 300_000;

const METHOD_DEADLINE_MS: Readonly<Record<string, number>> = Object.freeze({
  getUpdates: TELEGRAM_POLL_DEADLINE_MS,
  sendChatAction: TELEGRAM_TYPING_DEADLINE_MS,
});

/**
 * Batas waktu khusus untuk sebuah method, atau `null` bila memakai bawaan.
 *
 * Sengaja hanya dua. Pengiriman sungguhan—terutama unggahan berkas—boleh
 * berjalan lama, dan memaksakan batas di sana akan membatalkan pekerjaan yang
 * sebenarnya sehat.
 */
export function methodDeadlineMs(method: string): number | null {
  return METHOD_DEADLINE_MS[method] ?? null;
}

/** Bentuk respons Bot API sebagaimana terlihat transformer. */
export interface TelegramApiResponse {
  ok: boolean;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/**
 * Apakah permintaan yang ditolak layak diulang, dan sesudah berapa lama.
 *
 * Murni dan dapat diuji tanpa jaringan. Hanya 429 yang diulang, dan itu
 * disengaja: 429 berarti Telegram **menolak** permintaannya, jadi mengulang
 * tidak mungkin menghasilkan duplikat. Galat 5xx tidak diulang karena
 * sebaliknya—permintaannya mungkin sudah diterima, dan pengulangan dapat
 * mengirim bubble yang sama dua kali kepada seorang pelajar.
 *
 * `getUpdates` juga tidak pernah diulang di sini; grammY sudah mematuhi
 * `retry_after` untuk polling di dalam `handlePollingError`, dan lapisan kedua
 * hanya akan menggandakan jedanya.
 */
export function retryDecision(
  method: string,
  response: TelegramApiResponse,
  attempt: number,
  options: { maxAttempts?: number; maxDelayMs?: number } = {},
): RetryDecision {
  const maxAttempts = options.maxAttempts ?? TELEGRAM_MAX_ATTEMPTS;
  const maxDelayMs = options.maxDelayMs ?? TELEGRAM_MAX_RETRY_AFTER_MS;
  if (response.ok || method === "getUpdates") return { retry: false, delayMs: 0 };
  if (response.error_code !== 429) return { retry: false, delayMs: 0 };
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0 };

  const seconds = response.parameters?.retry_after;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return { retry: false, delayMs: 0 };
  }
  const delayMs = Math.min(Math.ceil(seconds * 1_000), maxDelayMs);
  // Jeda yang diminta melampaui batas berarti Telegram menyuruh berhenti lebih
  // lama daripada yang masuk akal ditunggu di dalam satu giliran. Menunggu
  // sebagian lalu mengulang hanya akan ditolak lagi.
  if (Math.ceil(seconds * 1_000) > maxDelayMs) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs };
}

/**
 * Meringkas kegagalan berulang menjadi satu baris per jendela.
 *
 * Tanpa ini, Telegram yang tidak dapat dihubungi selama sepuluh menit
 * menghasilkan dua ratus baris identik, dan berkas log yang penuh satu galat
 * yang sama sama tidak berguna dengan berkas log yang kosong.
 *
 * Murni: jamnya diberikan pemanggil.
 */
export class FailureLogThrottle {
  private readonly windows = new Map<
    string,
    { openedAt: number; suppressed: number }
  >();

  constructor(
    private readonly windowMs: number = TELEGRAM_FAILURE_LOG_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `null` berarti tahan; angka berarti catat, dengan sekian kejadian yang
   * ikut terwakili sejak baris terakhir.
   */
  admit(key: string): { suppressed: number } | null {
    const at = this.now();
    const window = this.windows.get(key);
    if (!window || at - window.openedAt >= this.windowMs) {
      this.windows.set(key, { openedAt: at, suppressed: 0 });
      return { suppressed: window?.suppressed ?? 0 };
    }
    window.suppressed += 1;
    return null;
  }
}

export interface TelegramApiResilienceOptions {
  logger?: OperationalLogger;
  maxAttempts?: number;
  maxRetryAfterMs?: number;
  logWindowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Diberikan agar uji dapat memakai jam palsu tanpa menunggu sungguhan. */
  deadlineSignal?: (ms: number) => AbortSignal;
}

/**
 * Transformer grammY yang memasang deadline, mematuhi `retry_after`, dan
 * membuat kegagalan Telegram terlihat.
 *
 * Dipasang lewat `bot.api.config.use(...)`. Tidak pernah menelan galat:
 * apa pun yang gagal tetap dilempar atau dikembalikan apa adanya kepada
 * grammY, sehingga seluruh penanganan yang sudah ada tetap berlaku. Yang
 * ditambahkan hanya catatan, batas waktu, dan satu pengulangan yang aman.
 */
export function createTelegramApiResilience(
  options: TelegramApiResilienceOptions = {},
): Transformer {
  const logger = options.logger ??
    NOOP_OPERATIONAL_LOGGER.child("telegram.api");
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadlineSignal = options.deadlineSignal ??
    ((ms: number) => AbortSignal.timeout(ms));
  const throttle = new FailureLogThrottle(
    options.logWindowMs ?? TELEGRAM_FAILURE_LOG_WINDOW_MS,
    options.now ?? Date.now,
  );

  const transformer: Transformer = async (prev, method, payload, signal) => {
    for (let attempt = 1; ; attempt += 1) {
      const deadlineMs = methodDeadlineMs(method);
      // Seluruh penyusunan sinyal berada DI DALAM try. Versi pertama
      // meletakkannya di luar, sehingga lemparannya lolos dari logging berkas
      // ini sendiri dan mematikan polling tanpa satu baris pun tercatat.
      let combined: CombinedSignal = { signal, release: () => {} };
      let response: Awaited<ReturnType<typeof prev>>;
      try {
        combined = combineSignals(signal, deadlineMs, deadlineSignal);
        response = await prev(method, payload, combined.signal);
      } catch (error) {
        // Pembatalan yang disengaja bukan kegagalan. `bot.stop()` membatalkan
        // `getUpdates` yang menggantung, dan mencatatnya sebagai galat akan
        // menandai setiap shutdown bersih sebagai kerusakan—melatih pembacanya
        // mengabaikan justru event yang berkas ini ada untuknya. Pembedanya
        // sinyal pemanggil, bukan nama galat: grammY membungkus pembatalan
        // menjadi `HttpError`. Alasan yang sama ditulis `isCancellation` di
        // `create-bot.ts`.
        if (signal !== undefined && isAborted(signal)) throw error;

        // Galat transport. Untuk `getUpdates` inilah satu-satunya tempat
        // kegagalan polling dapat terlihat sama sekali—sesudah ini grammY
        // menelannya ke `debugErr` dan mengulang diam-diam.
        const admitted = throttle.admit(`throw:${method}`);
        if (admitted) {
          logger.error(
            method === "getUpdates"
              ? "telegram_polling_failed"
              : "telegram_request_failed",
            method === "getUpdates"
              ? "Permintaan getUpdates gagal; grammY akan mencoba lagi."
              : "Permintaan Telegram gagal pada lapisan transport.",
            error,
            {
              method,
              attempt,
              ...(admitted.suppressed > 0
                ? { suppressedSince: admitted.suppressed }
                : {}),
              ...(deadlineMs === null ? {} : { deadlineMs }),
            },
          );
        }
        throw error;
      } finally {
        combined.release();
      }

      const decision = retryDecision(method, response, attempt, {
        ...(options.maxAttempts === undefined
          ? {}
          : { maxAttempts: options.maxAttempts }),
        ...(options.maxRetryAfterMs === undefined
          ? {}
          : { maxDelayMs: options.maxRetryAfterMs }),
      });
      if (!decision.retry) {
        if (!response.ok) {
          const admitted = throttle.admit(`reject:${method}:${response.error_code}`);
          if (admitted) {
            logger.warn(
              "telegram_request_rejected",
              "Telegram menolak permintaan.",
              {
                method,
                attempt,
                errorCode: response.error_code,
                ...(admitted.suppressed > 0
                  ? { suppressedSince: admitted.suppressed }
                  : {}),
              },
            );
          }
        }
        return response;
      }

      logger.warn(
        "telegram_rate_limited",
        "Telegram membatasi laju; menunggu sesuai retry_after lalu mengulang.",
        { method, attempt, delayMs: decision.delayMs },
      );
      await sleep(decision.delayMs);
    }
  };
  return transformer;
}

/**
 * Menahan indikator mengetik sesudah Telegram menolaknya.
 *
 * Indikator ini murni kosmetik, tetapi ia dikirim pada tiap giliran. Ketika
 * Telegram sedang membatasi laju, mengirimnya lagi justru menambah tekanan
 * lewat jalur yang tidak membawa satu pun kata kepada penggunanya. Hermes
 * menyimpan cooldown per chat dan menghormati `retry_after`; ini bentuk yang
 * sama, lebih kecil.
 *
 * Murni: jamnya diberikan pemanggil. State-nya process-local dan hilang saat
 * restart, dan itu benar—ia soal laju sesaat, bukan data pengguna.
 */
export class TypingCooldown {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly defaultMs: number = TELEGRAM_TYPING_COOLDOWN_MS,
    private readonly maxMs: number = TELEGRAM_TYPING_COOLDOWN_MAX_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Apakah indikator untuk chat ini sedang ditahan. */
  active(chatId: string): boolean {
    const until = this.until.get(chatId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.until.delete(chatId);
    return false;
  }

  /**
   * Mencatat kegagalan. `retryAfterSeconds` dipakai bila Telegram
   * menyebutkannya; kalau tidak, jeda bawaan.
   */
  record(chatId: string, retryAfterSeconds?: number): void {
    const requested =
      typeof retryAfterSeconds === "number" &&
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1_000
        : this.defaultMs;
    const delay = Math.max(1_000, Math.min(requested, this.maxMs));
    this.until.set(chatId, this.now() + delay);
  }

  /** Satu keberhasilan menghapus penahanan; keadaannya sudah berubah. */
  clear(chatId: string): void {
    this.until.delete(chatId);
  }
}

/**
 * Menggabungkan sinyal pembatalan pemanggil dengan deadline milik kita.
 *
 * **Tidak memakai `AbortSignal.any`**, dan itu bukan pilihan gaya. grammY
 * meneruskan `AbortSignal` dari paket polyfill `abort-controller`: namanya
 * `AbortSignal`, tetapi ia bukan instance `AbortSignal` global.
 * `AbortSignal.any` menolaknya dengan galat yang terbaca seperti lelucon—
 * *The "signals[0]" argument must be an instance of AbortSignal. Received an
 * instance of AbortSignal.*
 *
 * Akibatnya pada 5 September 2026 fatal dan sunyi. Lemparan itu terjadi
 * sebelum `prev` dipanggil, grammY menangkapnya di `handlePollingError`,
 * melaporkannya ke `debugErr` yang mati, tidur tiga detik, lalu mengulang
 * selamanya. Harvy hidup, polling "berjalan", dan nol pesan sampai—persis
 * kelas kegagalan yang berkas ini dibuat untuk mencegahnya. Ditemukan uji
 * kanal sungguhan, bukan oleh suite.
 *
 * Yang dipakai sekarang hanya `addEventListener`, yang dimiliki kedua
 * implementasi. Pemanggil **wajib** memanggil `release()` setelah permintaan
 * selesai: sinyal polling grammY hidup selama proses, dan satu listener per
 * `getUpdates` berarti kebocoran yang tumbuh tiap tiga puluh detik.
 */
interface CombinedSignal {
  signal: GrammySignal | undefined;
  release: () => void;
}

function combineSignals(
  caller: GrammySignal | undefined,
  deadlineMs: number | null,
  makeDeadline: (ms: number) => AbortSignal,
): CombinedSignal {
  const noop = (): void => {};
  if (deadlineMs === null) return { signal: caller, release: noop };
  const deadline = makeDeadline(deadlineMs);
  if (!caller) {
    return { signal: deadline as unknown as GrammySignal, release: noop };
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (isAborted(caller) || deadline.aborted) {
    controller.abort();
    return {
      signal: controller.signal as unknown as GrammySignal,
      release: noop,
    };
  }
  caller.addEventListener("abort", abort, { once: true });
  deadline.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal as unknown as GrammySignal,
    release: () => {
      caller.removeEventListener("abort", abort);
      deadline.removeEventListener("abort", abort);
    },
  };
}

function isAborted(signal: GrammySignal): boolean {
  return (signal as { aborted?: boolean }).aborted === true;
}
