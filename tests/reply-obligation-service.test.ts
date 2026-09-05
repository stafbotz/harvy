import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REPLY_OBLIGATION_MAX_AGE_MS,
  REPLY_OBLIGATION_MAX_ATTEMPTS,
  REPLY_OBLIGATION_MAX_CHARACTERS,
  ReplyObligationService,
} from "../src/core/reply-obligation-service.js";
import type {
  ReplyObligation,
  ReplyObligationRepository,
} from "../src/domain/reply-obligation.js";

const THIS_PROCESS = { pid: 4242, startedAt: "2026-09-04T10:00:00.000Z" };
const DEAD_PROCESS = { pid: 1717, startedAt: "2026-09-04T09:00:00.000Z" };
const NOW = new Date("2026-09-04T10:05:00.000Z");

class ObligationStore implements ReplyObligationRepository {
  rows: ReplyObligation[] = [];

  async save(obligation: ReplyObligation): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === obligation.id);
    if (index >= 0) this.rows[index] = obligation;
    else this.rows.push(obligation);
  }

  async listUnsettled(): Promise<ReplyObligation[]> {
    return this.rows.filter(
      (row) => row.state === "pending" || row.state === "attempting",
    );
  }

  async list(ownerId: string): Promise<ReplyObligation[]> {
    return this.rows.filter((row) => row.ownerId === ownerId);
  }

  async remove(id: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async removeAll(ownerId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.ownerId !== ownerId);
    return before - this.rows.length;
  }
}

function service(store: ObligationStore, now: Date = NOW) {
  return new ReplyObligationService(store, THIS_PROCESS, () => now);
}

function row(overrides: Partial<ReplyObligation> = {}): ReplyObligation {
  return {
    id: "abc123",
    ownerId: "ayu",
    chatId: "123",
    channel: "telegram",
    text: "Besok kita mulai dari bab sel ya.",
    state: "pending",
    attempts: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ownerProcess: DEAD_PROCESS,
    ...overrides,
  };
}

describe("janji balasan", () => {
  it("mencatat sebelum kirim lalu melepasnya sesudah sampai", async () => {
    const store = new ObligationStore();
    const obligations = service(store);

    const id = await obligations.record({
      ownerId: "ayu",
      chatId: "123",
      channel: "telegram",
      text: "Halo!",
    });
    assert.notEqual(id, null);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.state, "pending");

    await obligations.settle(id);
    assert.equal(store.rows.length, 0);
  });

  it("menandai bahwa I/O sudah dimulai", async () => {
    const store = new ObligationStore();
    const obligations = service(store);

    const id = await obligations.record({
      ownerId: "ayu",
      chatId: "123",
      channel: "telegram",
      text: "Halo!",
    });
    await obligations.markAttempting(id);

    assert.equal(store.rows[0]?.state, "attempting");
    assert.equal(store.rows[0]?.attempts, 1);
  });

  it("tidak mencatat balasan kosong", async () => {
    const store = new ObligationStore();
    const id = await service(store).record({
      ownerId: "ayu",
      chatId: "123",
      channel: "telegram",
      text: "   ",
    });
    assert.equal(id, null);
    assert.equal(store.rows.length, 0);
  });

  it("memotong teks yang melewati plafon", async () => {
    const store = new ObligationStore();
    await service(store).record({
      ownerId: "ayu",
      chatId: "123",
      channel: "telegram",
      text: "a".repeat(REPLY_OBLIGATION_MAX_CHARACTERS + 500),
    });
    assert.equal(store.rows[0]?.text.length, REPLY_OBLIGATION_MAX_CHARACTERS);
  });

  it("memulihkan janji milik proses yang sudah mati", async () => {
    const store = new ObligationStore();
    store.rows = [row()];

    const recovered = await service(store).recover();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.obligation.id, "abc123");
  });

  it("tidak pernah mengklaim janji milik proses yang masih hidup", async () => {
    // Pengirimannya barangkali sedang berjalan; mengambilnya berarti mengirim
    // dua kali dengan sengaja.
    const store = new ObligationStore();
    store.rows = [row({ ownerProcess: THIS_PROCESS })];

    assert.deepEqual(await service(store).recover(), []);
    assert.equal(store.rows.length, 1);
  });

  it("menandai yang pengirimannya sempat dimulai sebagai mungkin sudah sampai", async () => {
    const store = new ObligationStore();
    store.rows = [
      row({ id: "belum", state: "pending" }),
      row({ id: "sempat", state: "attempting", attempts: 1 }),
    ];

    const recovered = await service(store).recover();
    const byId = new Map(
      recovered.map((item) => [item.obligation.id, item.possiblyDelivered]),
    );
    assert.equal(byId.get("belum"), false);
    assert.equal(byId.get("sempat"), true);
  });

  it("meninggalkan janji yang sudah terlalu tua", async () => {
    // Balasan yang tiba lima belas menit terlambat lebih buruk daripada tidak
    // ada: percakapannya sudah bergerak.
    const store = new ObligationStore();
    store.rows = [
      row({
        createdAt: new Date(
          NOW.getTime() - REPLY_OBLIGATION_MAX_AGE_MS - 1_000,
        ).toISOString(),
      }),
    ];

    assert.deepEqual(await service(store).recover(), []);
    assert.equal(store.rows.length, 0);
  });

  it("meninggalkan janji yang sudah kehabisan percobaan", async () => {
    const store = new ObligationStore();
    store.rows = [
      row({ state: "attempting", attempts: REPLY_OBLIGATION_MAX_ATTEMPTS }),
    ];

    assert.deepEqual(await service(store).recover(), []);
    assert.equal(store.rows.length, 0);
  });

  it("menghapus seluruh janji milik pengguna yang menghapus datanya", async () => {
    const store = new ObligationStore();
    store.rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c", ownerId: "lain" })];

    assert.equal(await service(store).forgetOwner("ayu"), 2);
    assert.deepEqual(store.rows.map((item) => item.id), ["c"]);
  });

  it("tidak pernah menahan pengiriman ketika penyimpanan gagal", async () => {
    // Kegagalan ledger tidak boleh menjadi sebab balasan tidak terkirim.
    const rusak: ReplyObligationRepository = {
      save: async () => {
        throw new Error("disk penuh");
      },
      listUnsettled: async () => {
        throw new Error("disk penuh");
      },
      list: async () => {
        throw new Error("disk penuh");
      },
      remove: async () => {
        throw new Error("disk penuh");
      },
      removeAll: async () => {
        throw new Error("disk penuh");
      },
    };
    const obligations = new ReplyObligationService(
      rusak,
      THIS_PROCESS,
      () => NOW,
    );

    assert.equal(
      await obligations.record({
        ownerId: "ayu",
        chatId: "123",
        channel: "telegram",
        text: "Halo!",
      }),
      null,
    );
    await obligations.markAttempting("apa-saja");
    await obligations.settle("apa-saja");
    assert.deepEqual(await obligations.recover(), []);
    assert.equal(await obligations.forgetOwner("ayu"), 0);
  });
});
