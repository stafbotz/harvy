import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HISTORY_WINDOW } from "../src/core/history-policy.js";
import { HistoryService } from "../src/core/history-service.js";
import type {
  ConversationHistory,
  ConversationTurn,
  HistoryRepository,
} from "../src/domain/history.js";

describe("HistoryService", () => {
  it("mengisolasi riwayat berdasarkan pemilik", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student-a", "user", "halo");
    await service.append("student-b", "user", "hai");

    const mine = await service.context("student-a");
    assert.equal(mine.turns.length, 1);
    assert.equal(mine.turns[0]?.text, "halo");
  });

  it("hanya membawa beberapa giliran terakhir ke dalam prompt", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    for (let index = 0; index < HISTORY_WINDOW; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const context = await service.context("student");
    assert.equal(context.turns.length, HISTORY_WINDOW);
    assert.equal(context.turns.at(-1)?.text, `pesan ${HISTORY_WINDOW - 1}`);
  });

  it("meringkas giliran lama lalu membuang teks mentahnya", async () => {
    const store = new HistoryStore();
    const summarized: ConversationTurn[][] = [];
    const service = new HistoryService(store, async (_previous, turns) => {
      summarized.push(turns);
      return "Pengguna sedang menyiapkan ujian biologi.";
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const stored = await store.load("student");
    assert.equal(stored?.summary, "Pengguna sedang menyiapkan ujian biologi.");
    assert.ok(summarized.length > 0, "peringkas tidak pernah dipanggil");

    // Pemadatan berjalan di ambang lalu riwayat terisi lagi, jadi yang dijaga
    // bukan angka pastinya melainkan bahwa ia tidak pernah tumbuh tanpa batas.
    assert.ok(
      (stored?.turns.length ?? 0) < 20,
      "riwayat tidak pernah dipadatkan",
    );
    assert.ok((stored?.turns.length ?? 0) >= HISTORY_WINDOW);

    // Yang diringkas harus giliran terlama, bukan yang sedang dipakai.
    assert.equal(summarized[0]?.[0]?.text, "pesan 0");

    // Teks mentah yang sudah diringkas benar-benar hilang dari penyimpanan.
    // Kalau ia masih ada, ringkasan hanya menambah data, bukan menggantikannya.
    assert.equal(
      stored?.turns.some((turn) => turn.text === "pesan 0"),
      false,
    );
    assert.equal(stored?.turns.at(-1)?.text, "pesan 19");
  });

  it("mempertahankan riwayat ketika peringkasan gagal", async () => {
    const store = new HistoryStore();
    const service = new HistoryService(store, async () => {
      throw new Error("model sedang tidak bisa dihubungi");
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const stored = await store.load("student");
    // Membuang giliran tanpa ringkasannya berarti kehilangan konteks diam-diam.
    // Lebih baik riwayat kepanjangan sebentar dan dipadatkan lagi nanti.
    assert.equal(stored?.summary, null);
    assert.equal(stored?.turns.length, 20);
  });

  it("melupakan seluruh riwayat seorang pengguna", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student", "user", "halo");
    assert.equal(await service.forget("student"), true);
    assert.equal((await service.context("student")).turns.length, 0);
  });

  it("mengabaikan giliran kosong", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student", "user", "   ");
    assert.equal((await service.context("student")).turns.length, 0);
  });
});

async function neverSummarize(): Promise<string> {
  throw new Error("peringkas tidak seharusnya dipanggil pada tes ini");
}

/** Penyimpanan di memori proses, agar tes tidak menyentuh berkas nyata. */
class HistoryStore implements HistoryRepository {
  private histories: ConversationHistory[] = [];

  async load(ownerId: string): Promise<ConversationHistory | null> {
    const found = this.histories.find(
      (history) => history.ownerId === ownerId,
    );
    // Disalin supaya pemanggil tidak diam-diam mengubah isi penyimpanan,
    // seperti halnya adapter berkas yang selalu membaca ulang dari disk.
    return found ? structuredClone(found) : null;
  }

  async save(history: ConversationHistory): Promise<void> {
    const index = this.histories.findIndex(
      (stored) => stored.ownerId === history.ownerId,
    );
    if (index >= 0) {
      this.histories[index] = structuredClone(history);
    } else {
      this.histories.push(structuredClone(history));
    }
  }

  async remove(ownerId: string): Promise<boolean> {
    const index = this.histories.findIndex(
      (history) => history.ownerId === ownerId,
    );
    if (index < 0) return false;

    this.histories.splice(index, 1);
    return true;
  }
}
