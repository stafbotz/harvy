import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTelegramApiResilience,
  FailureLogThrottle,
  TELEGRAM_TYPING_COOLDOWN_MAX_MS,
  TypingCooldown,
  methodDeadlineMs,
  retryDecision,
  TELEGRAM_MAX_ATTEMPTS,
  TELEGRAM_MAX_RETRY_AFTER_MS,
  TELEGRAM_POLL_DEADLINE_MS,
  TELEGRAM_TYPING_DEADLINE_MS,
} from "../src/bot/telegram-api-resilience.js";

function limited(retryAfterSeconds: number) {
  return {
    ok: false,
    error_code: 429,
    parameters: { retry_after: retryAfterSeconds },
  };
}

describe("batas waktu per method Telegram", () => {
  it("membatasi getUpdates jauh di bawah 500 detik bawaan grammY", () => {
    assert.equal(methodDeadlineMs("getUpdates"), TELEGRAM_POLL_DEADLINE_MS);
    assert.ok(TELEGRAM_POLL_DEADLINE_MS < 500_000);
    // Long-poll meminta jendela 30 detik; batasnya harus di atas itu.
    assert.ok(TELEGRAM_POLL_DEADLINE_MS > 30_000);
  });

  it("membatasi indikator mengetik karena ia ditunggu di dalam giliran", () => {
    assert.equal(methodDeadlineMs("sendChatAction"), TELEGRAM_TYPING_DEADLINE_MS);
  });

  it("tidak membatasi pengiriman sungguhan", () => {
    // Unggahan berkas boleh berjalan lama; batas di sini akan membatalkan
    // pekerjaan yang sebenarnya sehat.
    assert.equal(methodDeadlineMs("sendMessage"), null);
    assert.equal(methodDeadlineMs("sendDocument"), null);
    assert.equal(methodDeadlineMs("sendPhoto"), null);
  });
});

describe("keputusan mengulang permintaan Telegram", () => {
  it("mengulang hanya untuk 429", () => {
    assert.equal(retryDecision("sendMessage", limited(2), 1).retry, true);
    assert.equal(
      retryDecision("sendMessage", { ok: false, error_code: 500 }, 1).retry,
      false,
    );
    assert.equal(
      retryDecision("sendMessage", { ok: false, error_code: 400 }, 1).retry,
      false,
    );
  });

  it("tidak pernah mengulang 5xx karena permintaannya mungkin sudah diterima", () => {
    for (const code of [500, 502, 503, 504]) {
      assert.equal(
        retryDecision("sendMessage", { ok: false, error_code: code }, 1).retry,
        false,
        String(code),
      );
    }
  });

  it("tidak menyentuh respons yang berhasil", () => {
    assert.equal(retryDecision("sendMessage", { ok: true }, 1).retry, false);
  });

  it("menyerahkan polling ke mesin retry grammY sendiri", () => {
    // grammY sudah mematuhi retry_after di dalam handlePollingError; lapisan
    // kedua hanya akan menggandakan jedanya.
    assert.equal(retryDecision("getUpdates", limited(2), 1).retry, false);
  });

  it("memakai jeda yang diberitahukan Telegram", () => {
    assert.deepEqual(retryDecision("sendMessage", limited(3), 1), {
      retry: true,
      delayMs: 3_000,
    });
  });

  it("menolak menunggu lebih lama daripada batas yang masuk akal", () => {
    const panjang = TELEGRAM_MAX_RETRY_AFTER_MS / 1_000 + 10;
    assert.equal(retryDecision("sendMessage", limited(panjang), 1).retry, false);
  });

  it("berhenti setelah percobaan terakhir", () => {
    assert.equal(
      retryDecision("sendMessage", limited(1), TELEGRAM_MAX_ATTEMPTS).retry,
      false,
    );
    assert.equal(
      retryDecision("sendMessage", limited(1), TELEGRAM_MAX_ATTEMPTS - 1).retry,
      true,
    );
  });

  it("mengabaikan retry_after yang tidak masuk akal alih-alih menebak", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        retryDecision(
          "sendMessage",
          { ok: false, error_code: 429, parameters: { retry_after: value } },
          1,
        ).retry,
        false,
        String(value),
      );
    }
    assert.equal(
      retryDecision("sendMessage", { ok: false, error_code: 429 }, 1).retry,
      false,
    );
  });
});

describe("peringkasan log kegagalan", () => {
  it("mencatat yang pertama lalu menahan sisanya dalam satu jendela", () => {
    let now = 1_000;
    const throttle = new FailureLogThrottle(60_000, () => now);

    assert.deepEqual(throttle.admit("a"), { suppressed: 0 });
    assert.equal(throttle.admit("a"), null);
    assert.equal(throttle.admit("a"), null);
  });

  it("membuka jendela baru dan melaporkan yang tertahan", () => {
    let now = 1_000;
    const throttle = new FailureLogThrottle(60_000, () => now);

    throttle.admit("a");
    throttle.admit("a");
    throttle.admit("a");
    now += 60_000;

    assert.deepEqual(throttle.admit("a"), { suppressed: 2 });
  });

  it("menghitung tiap kunci secara terpisah", () => {
    let now = 1_000;
    const throttle = new FailureLogThrottle(60_000, () => now);

    assert.deepEqual(throttle.admit("a"), { suppressed: 0 });
    assert.deepEqual(throttle.admit("b"), { suppressed: 0 });
  });
});

describe("transformer ketahanan Telegram", () => {
  function harness(
    responses: Array<unknown>,
    options: Record<string, unknown> = {},
  ) {
    const calls: Array<{ method: string; signal?: AbortSignal }> = [];
    const slept: number[] = [];
    const logged: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      child: () => logger,
      runWithContext: <T,>(_c: unknown, action: () => T) => action(),
      debug: () => undefined,
      info: () => undefined,
      warn: (event: string, _m: string, fields?: Record<string, unknown>) => {
        logged.push({ event, ...(fields ? { fields } : {}) });
      },
      error: (
        event: string,
        _m: string,
        _e: unknown,
        fields?: Record<string, unknown>,
      ) => {
        logged.push({ event, ...(fields ? { fields } : {}) });
      },
      fatal: () => undefined,
    };
    let index = 0;
    const prev = ((method: string, _payload: unknown, signal?: AbortSignal) => {
      calls.push({ method, ...(signal ? { signal } : {}) });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    }) as never;

    const transformer = createTelegramApiResilience({
      logger: logger as never,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      ...options,
    });
    return { transformer, prev, calls, slept, logged };
  }

  it("meneruskan respons berhasil tanpa mengubah apa pun", async () => {
    const h = harness([{ ok: true, result: 1 }]);
    const result = await h.transformer(h.prev, "sendMessage" as never, {} as never);

    assert.deepEqual(result, { ok: true, result: 1 });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.logged, []);
  });

  it("mengulang 429 sesudah menunggu lalu mengembalikan hasil keduanya", async () => {
    const h = harness([limited(2), { ok: true, result: 7 }]);
    const result = await h.transformer(h.prev, "sendMessage" as never, {} as never);

    assert.deepEqual(h.slept, [2_000]);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(result, { ok: true, result: 7 });
    assert.equal(h.logged[0]?.event, "telegram_rate_limited");
  });

  it("membuat kegagalan polling terlihat, yang selama ini ditelan grammY", async () => {
    const boom = new Error("socket hang up");
    const h = harness([boom]);

    await assert.rejects(
      h.transformer(h.prev, "getUpdates" as never, {} as never),
      /socket hang up/u,
    );
    assert.equal(h.logged[0]?.event, "telegram_polling_failed");
    assert.equal(h.logged[0]?.fields?.method, "getUpdates");
    assert.equal(h.logged[0]?.fields?.deadlineMs, TELEGRAM_POLL_DEADLINE_MS);
  });

  it("mencatat penolakan yang tidak diulang, dengan kode galatnya", async () => {
    const h = harness([{ ok: false, error_code: 403 }]);
    const result = await h.transformer(h.prev, "sendMessage" as never, {} as never);

    assert.deepEqual(result, { ok: false, error_code: 403 });
    assert.equal(h.logged[0]?.event, "telegram_request_rejected");
    assert.equal(h.logged[0]?.fields?.errorCode, 403);
  });

  it("memasang sinyal deadline pada getUpdates, bukan pada pengiriman", async () => {
    const h = harness([{ ok: true, result: [] }]);
    await h.transformer(h.prev, "getUpdates" as never, {} as never);
    assert.notEqual(h.calls[0]?.signal, undefined);

    const kirim = harness([{ ok: true, result: 1 }]);
    await kirim.transformer(kirim.prev, "sendMessage" as never, {} as never);
    assert.equal(kirim.calls[0]?.signal, undefined);
  });

  it("tidak pernah menelan galat yang bukan urusannya", async () => {
    const h = harness([new TypeError("fetch failed")]);
    await assert.rejects(
      h.transformer(h.prev, "sendMessage" as never, {} as never),
      TypeError,
    );
  });
});

describe("penahanan indikator mengetik", () => {
  it("tidak menahan apa pun sebelum ada kegagalan", () => {
    const cooldown = new TypingCooldown(30_000, 300_000, () => 1_000);
    assert.equal(cooldown.active("123"), false);
  });

  it("menahan sesudah gagal lalu melepas setelah jedanya lewat", () => {
    let now = 1_000;
    const cooldown = new TypingCooldown(30_000, 300_000, () => now);

    cooldown.record("123");
    assert.equal(cooldown.active("123"), true);

    now += 30_000;
    assert.equal(cooldown.active("123"), false);
  });

  it("mematuhi retry_after yang diberitahukan Telegram", () => {
    let now = 1_000;
    const cooldown = new TypingCooldown(30_000, 300_000, () => now);

    cooldown.record("123", 90);
    now += 60_000;
    assert.equal(cooldown.active("123"), true);
    now += 30_000;
    assert.equal(cooldown.active("123"), false);
  });

  it("mengklem jeda yang tidak masuk akal di kedua ujungnya", () => {
    let now = 1_000;
    const cooldown = new TypingCooldown(30_000, TELEGRAM_TYPING_COOLDOWN_MAX_MS, () => now);

    cooldown.record("besar", 100_000);
    now += TELEGRAM_TYPING_COOLDOWN_MAX_MS;
    assert.equal(cooldown.active("besar"), false);

    now = 1_000;
    cooldown.record("kecil", 0.1);
    assert.equal(cooldown.active("kecil"), true);
  });

  it("satu keberhasilan melepas penahanan", () => {
    const cooldown = new TypingCooldown(30_000, 300_000, () => 1_000);
    cooldown.record("123");
    cooldown.clear("123");
    assert.equal(cooldown.active("123"), false);
  });

  it("menahan tiap chat secara terpisah", () => {
    const cooldown = new TypingCooldown(30_000, 300_000, () => 1_000);
    cooldown.record("123");
    assert.equal(cooldown.active("123"), true);
    assert.equal(cooldown.active("456"), false);
  });
});
