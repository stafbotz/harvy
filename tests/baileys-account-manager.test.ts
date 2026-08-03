import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DisconnectReason,
  initAuthCreds,
  type AuthenticationState,
  type BaileysEventEmitter,
  type BaileysEventMap,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "baileys";
import {
  BaileysAccountManager,
  reconnectDecision,
  reconnectDelay,
} from "../src/whatsapp/baileys-account-manager.js";
import type { WhatsAppConfig } from "../src/whatsapp/config.js";

describe("armada akun Baileys", () => {
  it("menampilkan QR secara lokal sebagai pairing default tanpa meminta code", async () => {
    const qrs: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onQr: async (_accountId, qr) => {
          qrs.push(qr);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    sockets[0]!.ev.emit("connection.update", {
      connection: "connecting",
      qr: "token-qr-rahasia",
    });
    await nextTurn();

    assert.deepEqual(qrs, ["token-qr-rahasia"]);
    assert.equal(sockets[0]!.pairingRequests, 0);
    assert.equal(manager.accountStatus("utama"), "pairing");
    await manager.stop();
  });

  it("tetap mendukung pairing code hanya ketika dipilih eksplisit", async () => {
    const codes: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      {
        ...config(),
        pairingMode: "code",
        accounts: [config().accounts[0]!],
      },
      {
        ...noOpEvents(),
        onPairingCode: async (_accountId, code) => {
          codes.push(code);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    sockets[0]!.ev.emit("connection.update", {
      connection: "connecting",
    });
    await nextTurn();

    assert.deepEqual(codes, ["CODE0"]);
    assert.equal(sockets[0]!.pairingRequests, 1);
    await manager.stop();
  });

  it("membersihkan state pairing-code parsial sebelum membuka QR", async () => {
    const creds = initAuthCreds();
    creds.pairingCode = "ABCDEFGH";
    creds.me = {
      id: "628123456789@s.whatsapp.net",
      name: "~",
    };
    const state = {
      creds,
      keys: {
        get: async () => ({}),
        set: async () => undefined,
        clear: async () => undefined,
      },
    } as unknown as AuthenticationState;
    let saves = 0;
    let socketConfig: UserFacingSocketConfig | null = null;
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: async () => ({
          state,
          saveCreds: async () => {
            saves += 1;
          },
        }),
        createSocket: (value) => {
          socketConfig = value;
          return new FakeSocket(value, 0).value;
        },
      },
    );

    await manager.start();

    assert.equal(saves, 1);
    assert.equal(state.creds.pairingCode, undefined);
    assert.equal(state.creds.me, undefined);
    assert.ok(socketConfig);
    await manager.stop();
  });

  it("mempertahankan identitas hasil QR saat restart 515", async () => {
    const creds = initAuthCreds();
    creds.me = {
      id: "628123456789:3@s.whatsapp.net",
      lid: "12345:3@lid",
      name: "~",
    };
    const state = {
      creds,
      keys: {
        get: async () => ({}),
        set: async () => undefined,
        clear: async () => undefined,
      },
    } as unknown as AuthenticationState;
    const sockets: FakeSocket[] = [];
    let saves = 0;
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: async () => ({
          state,
          saveCreds: async () => {
            saves += 1;
          },
        }),
        createSocket: (value) => {
          const socket = new FakeSocket(value, sockets.length);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    assert.deepEqual(state.creds.me, {
      id: "628123456789:3@s.whatsapp.net",
      lid: "12345:3@lid",
      name: "~",
    });
    assert.equal(saves, 0);

    sockets[0]!.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.restartRequired),
        date: new Date(),
      },
    });
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    assert.equal(sockets.length, 2);
    assert.deepEqual(state.creds.me, {
      id: "628123456789:3@s.whatsapp.net",
      lid: "12345:3@lid",
      name: "~",
    });
    assert.equal(saves, 0);
    await manager.stop();
  });

  it("membuat auth namespace dan socket terpisah untuk setiap nomor", async () => {
    const paths: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      config(),
      noOpEvents(),
      {
        loadAuthState: authLoader(paths),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, sockets.length);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    assert.equal(sockets.length, 2);
    assert.match(paths[0] ?? "", /auth[\\/]utama$/);
    assert.match(paths[1] ?? "", /auth[\\/]cadangan$/);

    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    sockets[1]!.ev.emit("connection.update", { connection: "open" });
    await nextTurn();
    assert.equal(manager.accountStatus("utama"), "open");
    assert.equal(manager.accountStatus("cadangan"), "open");

    sockets[0]!.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.loggedOut),
        date: new Date(),
      },
    });
    await nextTurn();
    assert.equal(manager.accountStatus("utama"), "needs-operator");
    assert.equal(manager.accountStatus("cadangan"), "open");

    await manager.stop();
    assert.equal(sockets[0]!.endCalls, 0);
    assert.equal(sockets[1]!.endCalls, 1);
  });

  it("hanya meneruskan upsert notify, bukan append/history", async () => {
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          received.push(incoming.messageId);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("groups.upsert", [metadata()]);
    socket.ev.emit("messages.upsert", {
      type: "append",
      messages: [incomingMessage("lama")],
    });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("baru")],
    });
    await nextTurn();

    assert.deepEqual(received, ["baru"]);
    await manager.stop();
  });

  it("mengklasifikasikan reconnect dan membatasi backoff berjitter", () => {
    assert.equal(
      reconnectDecision(DisconnectReason.restartRequired),
      "restart",
    );
    assert.equal(reconnectDecision(DisconnectReason.loggedOut), "stop");
    assert.equal(reconnectDecision(DisconnectReason.connectionLost), "retry");
    assert.equal(reconnectDelay(0, 2_000, 60_000, 0), 1_500);
    assert.equal(reconnectDelay(20, 2_000, 60_000, 1), 60_000);
  });

  it("mengaktifkan ulang binding dari event self-add dan menonaktifkannya saat self-remove", async () => {
    const active: string[] = [];
    const disabled: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupActive: async (target) => {
          active.push(target.scope.groupId);
        },
        onGroupDisabled: async (scopeKey) => {
          disabled.push(scopeKey);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;

    socket.ev.emit("group-participants.update", {
      id: "120363000000@g.us",
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "add",
    });
    await nextTurn();
    socket.ev.emit("group-participants.update", {
      id: "120363000000@g.us",
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "remove",
    });
    await nextTurn();

    assert.deepEqual(active, ["120363000000@g.us"]);
    assert.deepEqual(disabled, ["whatsapp:120363000000@g.us"]);
    await manager.stop();
  });

  it("membuang cache admin lama ketika socket reconnect", async () => {
    const adminFlags: boolean[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          adminFlags.push(incoming.isAdmin);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, sockets.length);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("groups.upsert", [adminMetadata()]);
    await manager.drainEvents();
    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("admin-sebelum-reconnect")],
    });
    await manager.drainEvents();
    assert.deepEqual(adminFlags, [true]);

    sockets[0]!.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.restartRequired),
        date: new Date(),
      },
    });
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(sockets.length, 2);

    sockets[1]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("sesudah-reconnect")],
    });
    await manager.drainEvents();
    assert.deepEqual(adminFlags, [true, false]);
    await manager.stop();
  });

  it("merevalidasi role admin dan authority epoch dari metadata terbaru", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    sockets[0]!.ev.emit("groups.upsert", [adminMetadata()]);
    await manager.drainEvents();

    const request = {
      scope: {
        channel: "whatsapp" as const,
        groupId: "120363000000@g.us",
      },
      accountId: "utama",
      participantIds: ["12345@lid"],
      claimedAdmin: true,
      claimedAuthorityEpoch: 0,
    };
    assert.deepEqual(await manager.resolveGroupAuthority(request), {
      role: "admin",
      authorityEpoch: 1,
    });

    sockets[0]!.groupMetadataImpl = async () => metadata();
    sockets[0]!.ev.emit("group-participants.update", {
      id: "120363000000@g.us",
      author: "admin@s.whatsapp.net",
      action: "demote",
      participants: [{ id: "12345@lid" }],
    });
    // Cache role lama harus hilang pada call stack event yang sama, bukan baru
    // sesudah queue metadata selesai.
    assert.equal(await manager.resolveGroupAuthority(request), null);
    await manager.drainEvents();
    assert.equal(await manager.resolveGroupAuthority(request), null);

    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("sesudah-demote")],
    });
    await manager.drainEvents();
    assert.deepEqual(await manager.resolveGroupAuthority(request), {
      role: "member",
      authorityEpoch: 2,
    });
    await manager.stop();
  });

  it("menolak metadata tanpa identitas Harvy dan memberi disable one-shot", async () => {
    const disabled: string[] = [];
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          received.push(incoming.messageId);
        },
        onGroupDisabled: async (scopeKey) => {
          disabled.push(scopeKey);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          socket.groupMetadataImpl = async () => metadataWithoutSelf();
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadataWithoutSelf()]);
    socket.ev.emit("groups.upsert", [metadataWithoutSelf()]);
    await manager.drainEvents();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("tanpa-self")],
    });
    await manager.drainEvents();

    assert.deepEqual(disabled, ["whatsapp:120363000000@g.us"]);
    assert.deepEqual(received, []);
    assert.equal(
      await manager.resolveGroupAuthority({
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
        participantIds: ["12345@lid"],
        claimedAdmin: true,
        claimedAuthorityEpoch: 0,
      }),
      null,
    );
    await manager.stop();
  });

  it("menolak event dari pengirim yang tidak ada pada snapshot membership", async () => {
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          received.push(incoming.messageId);
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        ...incomingMessage("bukan-member"),
        key: {
          ...incomingMessage("bukan-member").key,
          participant: "outsider@lid",
          participantAlt: "628000000000@s.whatsapp.net",
        },
      }],
    });
    await manager.drainEvents();

    assert.deepEqual(received, []);
    await manager.stop();
  });

  it("menolak refresh metadata lama yang selesai setelah self-remove", async () => {
    let releaseMetadata!: () => void;
    let markMetadataStarted!: () => void;
    let markDisabled!: () => void;
    let markSecondSeen!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const metadataStarted = new Promise<void>((resolve) => {
      markMetadataStarted = resolve;
    });
    const disabled = new Promise<void>((resolve) => {
      markDisabled = resolve;
    });
    const secondSeen = new Promise<void>((resolve) => {
      markSecondSeen = resolve;
    });
    const adminFlags: boolean[] = [];
    const sockets: FakeSocket[] = [];
    let metadataCalls = 0;
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          adminFlags.push(incoming.isAdmin);
          if (incoming.messageId === "sesudah-remove") markSecondSeen();
        },
        onGroupDisabled: async () => {
          markDisabled();
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          socket.groupMetadataImpl = async () => {
            metadataCalls += 1;
            if (metadataCalls === 1) {
              markMetadataStarted();
              await metadataGate;
              return adminMetadata();
            }
            return metadata();
          };
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("sebelum-remove")],
    });
    await metadataStarted;
    socket.ev.emit("group-participants.update", {
      id: "120363000000@g.us",
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "remove",
    });
    await disabled;
    releaseMetadata();
    await nextTurn();
    await nextTurn();

    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("sesudah-remove")],
    });
    await within(secondSeen, 500);
    assert.deepEqual(adminFlags, [false]);
    await manager.stop();
  });

  it("melanjutkan pesan berikutnya ketika satu pesan dalam upsert gagal", async () => {
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          received.push(incoming.messageId);
          if (incoming.messageId === "rusak") {
            throw new Error("gagal sengaja");
          }
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("rusak"), incomingMessage("lanjut")],
    });
    await nextTurn();

    assert.deepEqual(received, ["rusak", "lanjut"]);
    await manager.stop();
  });

  it("tidak menahan ingress grup berikutnya selama callback pesan pertama masih berjalan", async () => {
    let releaseFirst!: () => void;
    let markSecondSeen!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondSeen = new Promise<void>((resolve) => {
      markSecondSeen = resolve;
    });
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          received.push(incoming.messageId);
          if (incoming.messageId === "pertama") await firstGate;
          if (incoming.messageId === "kedua") markSecondSeen();
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("pertama")],
    });
    await nextTurn();
    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("kedua")],
    });

    try {
      await within(secondSeen, 500);
      assert.deepEqual(received, ["pertama", "kedua"]);

      let stopped = false;
      const stopping = manager.stop().then(() => {
        stopped = true;
      });
      await nextTurn();
      assert.equal(stopped, false);
      releaseFirst();
      await stopping;
      assert.equal(stopped, true);
    } finally {
      releaseFirst();
    }
  });

  it("membatasi refresh metadata yang menggantung dan menolak ingress tanpa membership", async () => {
    let seen = false;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async () => {
          seen = true;
        },
      },
      {
        metadataTimeoutMs: 20,
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          socket.groupMetadataImpl = () => new Promise(() => undefined);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    sockets[0]!.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("tanpa-metadata")],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.equal(seen, false);
    await within(manager.stop(), 100);
  });

  it("menunggu pekerjaan event yang sudah dimulai saat shutdown", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupDisabled: async () => {
          started();
          await gate;
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("group-participants.update", {
      id: "120363000000@g.us",
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "remove",
    });
    await eventStarted;

    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    await nextTurn();
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
  });

  it("menunggu antrean penyimpanan kredensial sebelum restart membaca auth", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const loaded: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: async (path) => {
          loaded.push(path);
          const state = {
            creds: initAuthCreds(),
            keys: {
              get: async () => ({}),
              set: async () => undefined,
              clear: async () => undefined,
            },
          } as unknown as AuthenticationState;
          return {
            state,
            saveCreds: async () => {
              await saveGate;
            },
          };
        },
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, sockets.length);
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("creds.update", {});
    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.restartRequired),
        date: new Date(),
      },
    });
    await nextTurn();
    await nextTurn();
    assert.equal(loaded.length, 1);

    releaseSave();
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(loaded.length, 2);
    await manager.stop();
  });
});

class FakeEmitter {
  private readonly listeners = new Map<string, ((value: unknown) => void)[]>();

  readonly value = {
    on: <T extends keyof BaileysEventMap>(
      event: T,
      listener: (arg: BaileysEventMap[T]) => void,
    ): void => {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener as (value: unknown) => void);
      this.listeners.set(event, listeners);
    },
  } as BaileysEventEmitter;

  emit<T extends keyof BaileysEventMap>(
    event: T,
    value: BaileysEventMap[T],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class FakeSocket {
  readonly ev = new FakeEmitter();
  endCalls = 0;
  pairingRequests = 0;
  groupMetadataImpl: () => Promise<GroupMetadata> =
    async () => metadata();

  constructor(
    readonly socketConfig: UserFacingSocketConfig,
    index: number,
  ) {
    this.index = index;
  }

  private readonly index: number;

  readonly value = {
    ev: this.ev.value,
    user: {
      id: "628123456789@s.whatsapp.net",
      lid: "bot@lid",
    },
    requestPairingCode: async () => {
      this.pairingRequests += 1;
      return `CODE${this.index}`;
    },
    groupMetadata: async () => this.groupMetadataImpl(),
    sendMessage: async (_jid: string, content: { text?: string }) =>
      incomingMessage(`out-${content.text ?? "kosong"}`, true),
    end: async () => {
      this.endCalls += 1;
    },
  } as unknown as WASocket;
}

function config(): WhatsAppConfig {
  return {
    enabled: true,
    pairingMode: "qr",
    accounts: [
      { id: "utama", phoneNumber: "628123456789" },
      { id: "cadangan", phoneNumber: "628111111111" },
    ],
    authFolder: "C:\\tmp\\auth",
    groupFile: "unused",
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 60_000,
  };
}

function noOpEvents() {
  return {
    onMessage: async () => undefined,
    onGroupActive: async () => undefined,
    onGroupDisabled: async () => undefined,
    onPairingCode: () => undefined,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Batas tunggu tes terlampaui.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authLoader(paths: string[]) {
  return async (path: string) => {
    paths.push(path);
    const state = {
      creds: initAuthCreds(),
      keys: {
        get: async () => ({}),
        set: async () => undefined,
        clear: async () => undefined,
      },
    } as unknown as AuthenticationState;
    return { state, saveCreds: async () => undefined };
  };
}

function metadata(): GroupMetadata {
  return {
    id: "120363000000@g.us",
    owner: undefined,
    subject: "Grup Uji",
    participants: [
      { id: "12345@lid", phoneNumber: "628777777777@s.whatsapp.net" },
      { id: "628123456789@s.whatsapp.net", lid: "bot@lid" },
    ],
  };
}

function adminMetadata(): GroupMetadata {
  return {
    ...metadata(),
    participants: [
      {
        id: "12345@lid",
        phoneNumber: "628777777777@s.whatsapp.net",
        admin: "admin",
      },
      { id: "628123456789@s.whatsapp.net", lid: "bot@lid" },
    ],
  };
}

function metadataWithoutSelf(): GroupMetadata {
  return {
    ...metadata(),
    participants: [
      { id: "12345@lid", phoneNumber: "628777777777@s.whatsapp.net" },
    ],
  };
}

function incomingMessage(id: string, fromMe = false): WAMessage {
  return {
    key: {
      id,
      remoteJid: "120363000000@g.us",
      participant: "12345@lid",
      participantAlt: "628777777777@s.whatsapp.net",
      fromMe,
    },
    pushName: "Ayu",
    messageTimestamp: 1_775_000_000,
    message: { conversation: "halo" },
  };
}

function disconnectError(statusCode: number): Error {
  return Object.assign(new Error("putus"), {
    output: { statusCode },
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
