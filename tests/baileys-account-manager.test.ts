import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  DisconnectReason,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type BaileysEventEmitter,
  type BaileysEventMap,
  type GroupMetadata,
  type UserFacingSocketConfig,
  type WAMessage,
  type WASocket,
} from "baileys";
import type { GroupMessage } from "../src/domain/group.js";
import {
  BaileysAccountManager,
  GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES,
  GROUP_INCOMING_QUOTE_CACHE_MS,
  reconnectDecision,
  reconnectDelay,
  type GroupRunDeliveryAuthorityExpectation,
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

  it("menjawab pesan privat dan mendeduplikasi upsert", async () => {
    const privateMessages: string[] = [];
    const groupMessages: string[] = [];
    let delivered = 0;
    let deliveryFailed = 0;
    const lifecycle: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      {
        ...config(),
        privateEnabled: true,
        accounts: [config().accounts[0]!],
      },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          groupMessages.push(incoming.messageId);
        },
        onPrivateMessage: async (incoming) => {
          privateMessages.push(incoming.text);
          return {
            text: "*Penggunaan Harvy*\nSisa penggunaan: 68%",
            onDelivered: async () => {
              delivered += 1;
            },
            onDeliveryFailed: async () => {
              deliveryFailed += 1;
            },
          };
        },
        onPrivateLifecycle: (_accountId, stage) => lifecycle.push(stage),
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
    socket.ev.emit("connection.update", { connection: "open" });
    const incoming: WAMessage = {
      key: {
        id: "private-command-1",
        remoteJid: "628777777777@s.whatsapp.net",
        fromMe: false,
      },
      messageTimestamp: 1_775_000_000,
      message: { conversation: "/penggunaan" },
    };
    socket.ev.emit("messages.upsert", { type: "notify", messages: [incoming] });
    socket.ev.emit("messages.upsert", { type: "notify", messages: [incoming] });
    await manager.drainEvents();

    assert.deepEqual(privateMessages, ["/penggunaan"]);
    assert.deepEqual(groupMessages, []);
    assert.equal(socket.sentMessages.length, 1);
    assert.equal(socket.sentMessages[0]?.jid, "628777777777@s.whatsapp.net");
    assert.match(socket.sentMessages[0]?.text ?? "", /^\*Penggunaan Harvy\*/u);
    assert.equal(delivered, 1);
    assert.equal(deliveryFailed, 0);
    assert.deepEqual(lifecycle, [
      "private-upsert-notify",
      "private-candidate",
      "private-normalized",
      "private-upsert-notify",
      "private-candidate",
      "private-normalized",
      "private-handler-returned",
      "private-delivery-attempted",
      "private-delivery-succeeded",
    ]);
    await manager.stop();
  });

  it("menganggap pair-success QR siap walau flag registered Baileys tetap false", async () => {
    const creds = initAuthCreds();
    creds.me = {
      id: "628123456789:3@s.whatsapp.net",
      lid: "12345:3@lid",
      name: "~",
    };
    creds.account = {
      details: Buffer.from([1]),
      accountSignatureKey: Buffer.from([2]),
      accountSignature: Buffer.from([3]),
      deviceSignature: Buffer.from([4]),
    };
    creds.signalIdentities = [{
      identifier: { name: "628123456789", deviceId: 3 },
      identifierKey: Buffer.from([5]),
    }];
    const state = {
      creds,
      keys: {
        get: async () => ({}),
        set: async () => undefined,
        clear: async () => undefined,
      },
    } as unknown as AuthenticationState;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      {
        ...config(),
        pairingMode: "code",
        accounts: [config().accounts[0]!],
      },
      noOpEvents(),
      {
        loadAuthState: async () => ({ state, saveCreds: async () => undefined }),
        createSocket: (value) => {
          const socket = new FakeSocket(value, sockets.length);
          sockets.push(socket);
          return socket.value;
        },
      },
    );

    await manager.start();
    sockets[0]!.ev.emit("connection.update", { connection: "connecting" });
    await nextTurn();

    assert.equal(creds.registered, false);
    assert.equal(sockets[0]!.pairingRequests, 0);
    await manager.stop();
  });

  it("mengelola exact anchor privat lewat edit, hapus, pin, dan unpin", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    await manager.drainEvents();

    const sent = await manager.sendPrivateTextTracked(
      "utama",
      "628777777777@s.whatsapp.net",
      "Anchor pekerjaan",
    );
    assert.deepEqual(sent.messageIds, ["out-Anchor pekerjaan"]);
    const edited = await manager.editPrivateText(
      "utama",
      "628777777777@s.whatsapp.net",
      sent.messageIds[0]!,
      "Anchor selesai",
    );
    assert.equal(edited.messageId, sent.messageIds[0]);
    assert.deepEqual(socket.editedMessageIds, ["out-Anchor pekerjaan"]);
    await manager.setPrivateMessagePinned(
      "utama",
      "628777777777@s.whatsapp.net",
      sent.messageIds[0]!,
      true,
    );
    await manager.setPrivateMessagePinned(
      "utama",
      "628777777777@s.whatsapp.net",
      sent.messageIds[0]!,
      false,
    );
    assert.deepEqual(socket.pinOperations, [
      {
        messageId: "out-Anchor pekerjaan",
        type: proto.PinInChat.Type.PIN_FOR_ALL,
        time: 604_800,
      },
      {
        messageId: "out-Anchor pekerjaan",
        type: proto.PinInChat.Type.UNPIN_FOR_ALL,
        time: null,
      },
    ]);
    await manager.removePrivateText(
      "utama",
      "628777777777@s.whatsapp.net",
      sent.messageIds[0]!,
    );
    assert.deepEqual(socket.deletedMessageIds, ["out-Anchor pekerjaan"]);
    await manager.stop();
  });

  it("mengunduh ZIP privat secara bounded sebelum menyerahkannya ke coding", async () => {
    const sockets: FakeSocket[] = [];
    const received: Buffer[] = [];
    const manager = new BaileysAccountManager(
      {
        ...config(),
        privateEnabled: true,
        accounts: [config().accounts[0]!],
      },
      {
        ...noOpEvents(),
        onPrivateMessage: async (incoming) => {
          if (incoming.document) received.push(incoming.document.data);
          return null;
        },
      },
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          sockets.push(socket);
          return socket.value;
        },
        downloadContent: async () => {
          const stream = new PassThrough();
          stream.end(Buffer.from("PK\u0003\u0004fixture-zip", "binary"));
          return stream;
        },
      },
    );
    await manager.start();
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "private-zip-1",
          remoteJid: "628777777777@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1_775_000_000,
        message: {
          documentMessage: {
            fileName: "project.zip",
            mimetype: "application/zip",
            fileLength: 15,
          },
        },
      } as WAMessage],
    });
    await manager.drainEvents();

    assert.equal(received.length, 1);
    assert.match(received[0]!.toString("binary"), /^PK/u);
    await manager.stop();
  });

  it("mengabaikan chat pribadi saat flag mati tetapi tetap memproses grup", async () => {
    const groupMessages: string[] = [];
    let privateMessages = 0;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (incoming) => {
          groupMessages.push(incoming.messageId);
        },
        onPrivateMessage: async () => {
          privateMessages += 1;
          return "Balasan yang tidak boleh terkirim";
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "private-diabaikan",
          remoteJid: "628777777777@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1_775_000_000,
        message: { conversation: "halo pribadi" },
      }],
    });
    socket.ev.emit("groups.upsert", [metadata()]);
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("grup-tetap-jalan")],
    });
    await manager.drainEvents();

    assert.deepEqual(groupMessages, ["grup-tetap-jalan"]);
    assert.equal(privateMessages, 0);
    assert.equal(socket.sentMessages.length, 0);
    await manager.stop();
  });

  it("menyelesaikan reply privat sebagai gagal ketika socket menolak send", async () => {
    let delivered = 0;
    let deliveryFailed = 0;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      {
        ...config(),
        privateEnabled: true,
        accounts: [config().accounts[0]!],
      },
      {
        ...noOpEvents(),
        onPrivateMessage: async () => ({
          text: "Balasan privat",
          onDelivered: async () => {
            delivered += 1;
          },
          onDeliveryFailed: async () => {
            deliveryFailed += 1;
          },
        }),
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
    socket.failSend = true;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "private-send-gagal",
          remoteJid: "628777777777@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1_775_000_000,
        message: { conversation: "halo" },
      }],
    });
    await manager.drainEvents();

    assert.equal(delivered, 0);
    assert.equal(deliveryFailed, 1);
    assert.equal(socket.sentMessages.length, 0);
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

  it("merevalidasi live membership dari socket dan memperbarui authority cache", async () => {
    const epochs: number[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupAuthorityChanged: (_scopeKey, _accountId, epoch) => {
          epochs.push(epoch);
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [adminMetadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => metadata();

    assert.equal(await manager.hasLiveGroupMembership({
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
    }), true);
    assert.equal(socket.groupMetadataCalls, 1);
    assert.deepEqual(epochs, [1, 2]);
    assert.deepEqual(await manager.resolveGroupAuthority({
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
      participantIds: ["12345@lid"],
      claimedAdmin: false,
      claimedAuthorityEpoch: 2,
    }), {
      role: "member",
      authorityEpoch: 2,
    });
    await manager.stop();
  });

  it("menolak live membership ketika metadata terbaru tidak memuat self", async () => {
    const disabled: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => metadataWithoutSelf();

    const membership = await manager.captureLiveGroupMembership({
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
    });
    assert.deepEqual(membership, { status: "self-missing" });
    await manager.drainEvents();
    assert.equal(socket.groupMetadataCalls, 1);
    assert.deepEqual(disabled, ["whatsapp:120363000000@g.us"]);
    await manager.stop();
  });

  it("gagal tertutup ketika refresh live membership gagal", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => {
      throw new Error("120363000000@g.us/private-refresh-detail");
    };

    assert.equal(await manager.hasLiveGroupMembership({
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
    }), false);
    assert.equal(socket.groupMetadataCalls, 1);
    await manager.stop();
  });

  it("membedakan refresh membership transient agar lease dapat dicoba ulang", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    let refreshes = 0;
    socket.groupMetadataImpl = async () => {
      refreshes += 1;
      if (refreshes === 1) throw new Error("private transient detail");
      return metadata();
    };
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };

    assert.deepEqual(await manager.captureLiveGroupMembership(target), {
      status: "unavailable",
    });
    const membership = await manager.captureLiveGroupMembership(target);
    assert.equal(membership.status, "member");
    if (membership.status !== "member") assert.fail("membership harus live");
    assert.equal(membership.lease.isCurrent(), true);
    assert.equal(refreshes, 2);
    await manager.stop();
  });

  it("menolak revalidation yang mengantre melewati socket generation", async () => {
    let releaseActive!: () => void;
    let markActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeStarted = new Promise<void>((resolve) => {
      markActive = resolve;
    });
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupActive: async () => {
          markActive();
          await activeGate;
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
    const oldSocket = sockets[0]!;
    oldSocket.ev.emit("connection.update", { connection: "open" });
    oldSocket.ev.emit("groups.upsert", [metadata()]);
    await activeStarted;

    const membership = manager.hasLiveGroupMembership({
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
    });
    oldSocket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.restartRequired),
        date: new Date(),
      },
    });
    await nextTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(sockets.length, 2);
    releaseActive();

    assert.equal(await membership, false);
    assert.equal(oldSocket.groupMetadataCalls, 0);
    await manager.stop();
  });

  it("mengikat onGroupActive fence dan memagari sendNotice yang stale", async () => {
    let authorityFence: (() => boolean) | null = null;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupActive: async (_message, fence) => {
          authorityFence = fence;
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
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    const activeFence = authorityFence as (() => boolean) | null;
    assert.ok(activeFence);
    assert.equal(activeFence(), true);

    await manager.sendNotice(target, "Notice valid", activeFence);
    socket.ev.emit("group-participants.update", {
      id: target.scope.groupId,
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "remove",
    });
    assert.equal(activeFence(), false);
    await assert.rejects(
      manager.sendNotice(target, "Notice stale", activeFence),
      /Authority notice grup/iu,
    );
    assert.equal(socket.sentMessages.length, 1);
    await manager.drainEvents();
    await manager.stop();
  });

  it("menghentikan continuation grup sebelum bubble berikutnya saat fence stale", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    await manager.drainEvents();
    let current = true;
    socket.onSend = () => {
      current = false;
    };
    const incoming: GroupMessage = {
      scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
      accountId: "utama",
      messageId: "incoming-1",
      participantId: "anggota@s.whatsapp.net",
      participantAliases: ["anggota@s.whatsapp.net"],
      participantName: "Anggota",
      groupName: "Ruang tes",
      text: "Harvy, jelaskan",
      at: new Date().toISOString(),
      mentionsHarvy: true,
      repliesToHarvy: false,
      isAdmin: false,
    };

    const delivery = await manager.sendReply(
      incoming,
      "Bubble satu.\n\nBubble dua?\n\nBubble tiga.",
      () => current,
    );

    assert.deepEqual(socket.sentMessages.map((item) => item.text), [
      "Bubble satu.",
    ]);
    assert.deepEqual(delivery, {
      text: "Bubble satu.",
      bubbleCount: 1,
      complete: false,
    });
    await manager.stop();
  });

  it("membership lease live menjadi stale segera ketika epoch berubah", async () => {
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
    const socket = sockets[0]!;
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => metadata();

    const membership = await manager.captureLiveGroupMembership(target);
    assert.equal(membership.status, "member");
    if (membership.status !== "member") assert.fail("membership harus live");
    assert.equal(membership.lease.isCurrent(), true);
    socket.ev.emit("group-participants.update", {
      id: target.scope.groupId,
      author: "admin@s.whatsapp.net",
      participants: [{ id: "12345@lid" }],
      action: "demote",
    });
    assert.equal(membership.lease.isCurrent(), false);
    await manager.drainEvents();
    await manager.stop();
  });

  it("mempertahankan incoming quote sesudah callback ingress selesai", async () => {
    const received: string[] = [];
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onMessage: async (message) => {
          received.push(message.messageId);
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("quote-after-ingress")],
    });
    await manager.drainEvents();
    assert.deepEqual(received, ["quote-after-ingress"]);

    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Control copy tertunda",
      "quote-after-ingress",
      "effect-delayed-control-copy",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.equal(socket.sentMessages[0]?.quotedMessageId, "quote-after-ingress");
    await manager.stop();
  });

  it("menghapus incoming quote segera ketika socket close tanpa reconnect", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("quote-before-close")],
    });
    await manager.drainEvents();
    const runtime = (manager as unknown as {
      accounts: Map<string, { incoming: Map<string, unknown> }>;
    }).accounts.get("utama");
    assert.equal(runtime?.incoming.size, 1);

    socket.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: disconnectError(DisconnectReason.loggedOut),
        date: new Date(),
      },
    });
    // Handler close menghapus raw quote sinkron, sebelum backoff/status async.
    assert.equal(runtime?.incoming.size, 0);
    await manager.drainEvents();
    await manager.stop();
  });

  it("mengisolasi incoming quote dengan message ID identik pada dua grup", async () => {
    const otherGroupId = "120363000001@g.us";
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [
      metadata(),
      { ...metadata(), id: otherGroupId, subject: "Grup Uji Lain" },
    ]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        incomingMessage("same-message-id"),
        messageInGroup("same-message-id", otherGroupId),
      ],
    });
    await manager.drainEvents();

    for (const [index, groupId] of [
      "120363000000@g.us",
      otherGroupId,
    ].entries()) {
      await manager.sendGroupRunMessage(
        {
          scope: { channel: "whatsapp", groupId },
          accountId: "utama",
        },
        `Control copy ${index}`,
        "same-message-id",
        `effect-cross-group-${index}`,
        memberRunAuthority(),
        allowGroupRunRuntime,
      );
    }
    assert.deepEqual(socket.quotedRemoteJids, [
      "120363000000@g.us",
      otherGroupId,
    ]);
    await manager.stop();
  });

  it("self-remove menghapus quote exact group tanpa menghapus grup lain", async () => {
    const removedGroupId = "120363000000@g.us";
    const retainedGroupId = "120363000001@g.us";
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [
      metadata(),
      { ...metadata(), id: retainedGroupId, subject: "Grup Uji Lain" },
    ]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        incomingMessage("quote-before-remove"),
        messageInGroup("quote-before-remove", retainedGroupId),
      ],
    });
    await manager.drainEvents();

    socket.ev.emit("group-participants.update", {
      id: removedGroupId,
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "remove",
    });
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => metadata();
    socket.ev.emit("group-participants.update", {
      id: removedGroupId,
      author: "admin@s.whatsapp.net",
      participants: [{ id: "bot@lid" }],
      action: "add",
    });
    await manager.drainEvents();

    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: removedGroupId },
        accountId: "utama",
      },
      "Sesudah re-add",
      "quote-before-remove",
      "effect-after-self-readd",
      memberRunAuthority(3),
      allowGroupRunRuntime,
    );
    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: retainedGroupId },
        accountId: "utama",
      },
      "Grup lain tetap valid",
      "quote-before-remove",
      "effect-other-group-retained",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.deepEqual(socket.quotedRemoteJids, [null, retainedGroupId]);
    await manager.stop();
  });

  it("menghapus incoming quote setelah TTL pendek dan tetap mengirim aman", async () => {
    let nowMs = Date.UTC(2026, 7, 14, 0, 0, 0);
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        now: () => new Date(nowMs),
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: [incomingMessage("quote-expired")],
    });
    await manager.drainEvents();
    nowMs += GROUP_INCOMING_QUOTE_CACHE_MS + 1;

    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Control copy tanpa quote kedaluwarsa",
      "quote-expired",
      "effect-expired-control-copy",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.equal(socket.sentMessages[0]?.quotedMessageId, null);
    await manager.stop();
  });

  it("menghapus incoming quote tertua ketika cap tercapai", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.ev.emit("messages.upsert", {
      type: "notify",
      messages: Array.from(
        { length: GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES + 1 },
        (_unused, index) => incomingMessage(`quote-cap-${index}`),
      ),
    });
    await manager.drainEvents();

    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Control copy setelah cap",
      "quote-cap-0",
      "effect-capped-control-copy",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.equal(socket.sentMessages[0]?.quotedMessageId, null);

    await manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Control copy quote terbaru",
      `quote-cap-${GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES}`,
      "effect-latest-capped-control-copy",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.equal(
      socket.sentMessages[1]?.quotedMessageId,
      `quote-cap-${GROUP_INCOMING_QUOTE_CACHE_MAX_MESSAGES}`,
    );
    await manager.stop();
  });

  it("mengembalikan ID delivery GroupRun dan dapat mengutip pesan outbound", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };

    const anchor = await manager.sendGroupRunMessage(
      target,
      "  Anchor run  ",
      undefined,
      "effect-anchor-1",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    const update = await manager.sendGroupRunMessage(
      target,
      "Update run",
      anchor.messageId,
      "effect-update-1",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );

    assert.match(anchor.messageId, /^[A-F0-9]{32}$/u);
    assert.match(update.messageId, /^[A-F0-9]{32}$/u);
    assert.notEqual(anchor.messageId, update.messageId);
    assert.deepEqual(socket.sentMessages, [
      {
        jid: "120363000000@g.us",
        text: "Anchor run",
        quotedMessageId: null,
        requestedMessageId: anchor.messageId,
      },
      {
        jid: "120363000000@g.us",
        text: "Update run",
        quotedMessageId: anchor.messageId,
        requestedMessageId: update.messageId,
      },
    ]);
    await manager.stop();
  });

  it("mengedit exact anchor GroupRun dengan message ID idempoten baru", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };
    const anchor = await manager.sendGroupRunMessage(
      target,
      "Anchor awal",
      undefined,
      "effect-edit-anchor",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    const edited = await manager.editGroupRunMessage(
      target,
      "Anchor selesai",
      anchor.messageId,
      "effect-edit-terminal",
      memberRunAuthority(),
      allowGroupRunRuntime,
    );
    assert.match(edited.messageId, /^[A-F0-9]{32}$/u);
    assert.notEqual(edited.messageId, anchor.messageId);
    assert.deepEqual(socket.editedMessageIds, [anchor.messageId]);
    assert.equal(socket.sentMessages[1]?.quotedMessageId, null);
    assert.equal(socket.sentMessages[1]?.text, "Anchor selesai");
    await manager.stop();
  });

  it("gagal tertutup ketika delivery GroupRun tidak mempunyai ID pesan", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          socket.omitSentMessageId = true;
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    sockets[0]!.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();

    await assert.rejects(
      manager.sendGroupRunMessage(
        {
          scope: {
            channel: "whatsapp",
            groupId: "120363000000@g.us",
          },
          accountId: "utama",
        },
        "Anchor tanpa ID",
        undefined,
        "effect-missing-id",
        memberRunAuthority(),
        allowGroupRunRuntime,
      ),
      /tidak menghasilkan ID pesan/iu,
    );
    await assert.doesNotReject(
      manager.sendNotice(
        {
          scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
          accountId: "utama",
        },
        "Pesan biasa tetap mempertahankan kontrak void lama",
      ),
    );
    await manager.stop();
  });

  it("menolak bila transport mengganti ID idempotent GroupRun", async () => {
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        loadAuthState: authLoader([]),
        createSocket: (socketConfig) => {
          const socket = new FakeSocket(socketConfig, 0);
          socket.ignoreRequestedMessageId = true;
          sockets.push(socket);
          return socket.value;
        },
      },
    );
    await manager.start();
    sockets[0]!.ev.emit("connection.update", { connection: "open" });
    sockets[0]!.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    await assert.rejects(
      manager.sendGroupRunMessage(
        {
          scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
          accountId: "utama",
        },
        "Anchor",
        undefined,
        "effect-id-must-survive",
        memberRunAuthority(),
        allowGroupRunRuntime,
      ),
      /tidak mempertahankan ID idempotent/iu,
    );
    await manager.stop();
  });

  it("menolak epoch delivery GroupRun yang stale dan fence tanpa aktor", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };

    await assert.rejects(
      manager.sendGroupRunMessage(
        target,
        "Epoch lama",
        undefined,
        "effect-stale-epoch",
        memberRunAuthority(0),
        allowGroupRunRuntime,
      ),
      /Authority delivery GroupRun/iu,
    );
    await assert.rejects(
      manager.sendGroupRunMessage(
        target,
        "Tanpa aktor",
        undefined,
        "effect-no-actors",
        { expectedAuthorityEpoch: 1, actors: [] },
        allowGroupRunRuntime,
      ),
      /fence authority delivery GroupRun tidak sah/iu,
    );
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
  });

  it("menolak aktor asing atau role aktor yang tidak cocok", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    const target = {
      scope: { channel: "whatsapp" as const, groupId: "120363000000@g.us" },
      accountId: "utama",
    };

    await assert.rejects(
      manager.sendGroupRunMessage(
        target,
        "Aktor asing",
        undefined,
        "effect-wrong-actor",
        {
          expectedAuthorityEpoch: 1,
          actors: [{
            participantIds: ["outsider@lid"],
            expectedRole: "member",
          }],
        },
        allowGroupRunRuntime,
      ),
      /Authority delivery GroupRun/iu,
    );
    await assert.rejects(
      manager.sendGroupRunMessage(
        target,
        "Role salah",
        undefined,
        "effect-wrong-role",
        {
          expectedAuthorityEpoch: 1,
          actors: [{
            participantIds: [
              "12345@lid",
              "628777777777@s.whatsapp.net",
            ],
            expectedRole: "admin",
          }],
        },
        allowGroupRunRuntime,
      ),
      /Authority delivery GroupRun/iu,
    );
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
  });

  it("merefresh metadata stale dan memagari role yang berubah", async () => {
    let nowMs = Date.UTC(2026, 7, 14, 0, 0, 0);
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        now: () => new Date(nowMs),
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [adminMetadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => metadata();
    nowMs += 31_000;

    await assert.rejects(
      manager.sendGroupRunMessage(
        {
          scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
          accountId: "utama",
        },
        "Role lama tidak boleh lolos refresh",
        undefined,
        "effect-stale-role-refresh",
        adminRunAuthority(),
        allowGroupRunRuntime,
      ),
      /Authority delivery GroupRun/iu,
    );
    assert.equal(socket.groupMetadataCalls, 1);
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
  });

  it("memagari send yang mengantre ketika aktor didemote atau dikeluarkan", async () => {
    for (const action of ["demote", "remove"] as const) {
      let releaseActive!: () => void;
      let markActive!: () => void;
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        markActive = resolve;
      });
      const sockets: FakeSocket[] = [];
      const manager = new BaileysAccountManager(
        { ...config(), accounts: [config().accounts[0]!] },
        {
          ...noOpEvents(),
          onGroupActive: async () => {
            markActive();
            await activeGate;
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
      socket.ev.emit("connection.update", { connection: "open" });
      socket.ev.emit("groups.upsert", [adminMetadata()]);
      await activeStarted;

      const delivery = manager.sendGroupRunMessage(
        {
          scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
          accountId: "utama",
        },
        `Tidak boleh terkirim setelah ${action}`,
        undefined,
        `effect-queued-${action}`,
        adminRunAuthority(),
        allowGroupRunRuntime,
      );
      socket.ev.emit("group-participants.update", {
        id: "120363000000@g.us",
        author: "admin@s.whatsapp.net",
        participants: [{ id: "12345@lid" }],
        action,
      });
      releaseActive();

      await assert.rejects(delivery, /Authority delivery GroupRun/iu);
      await manager.drainEvents();
      assert.deepEqual(socket.sentMessages, []);
      await manager.stop();
    }
  });

  it("memagari delivery ketika mode runtime berubah selama antrean grup", async () => {
    let releaseActive!: () => void;
    let markActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    const activeStarted = new Promise<void>((resolve) => {
      markActive = resolve;
    });
    let runtimeActive = true;
    let fenceCalls = 0;
    let fenceArguments: unknown[] | null = null;
    const runtimeFence = async (...args: unknown[]): Promise<boolean> => {
      fenceCalls += 1;
      fenceArguments = args;
      return runtimeActive;
    };
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      {
        ...noOpEvents(),
        onGroupActive: async () => {
          markActive();
          await activeGate;
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await activeStarted;

    const delivery = manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Tidak boleh terkirim setelah mode berubah",
      undefined,
      "effect-queued-runtime-mode",
      memberRunAuthority(),
      runtimeFence,
    );
    runtimeActive = false;
    releaseActive();

    await assert.rejects(delivery, /Runtime delivery GroupRun/iu);
    assert.equal(fenceCalls, 1);
    assert.deepEqual(fenceArguments, []);
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
  });

  it("merecheck mode runtime setelah await refresh metadata", async () => {
    let nowMs = Date.UTC(2026, 7, 14, 0, 0, 0);
    let releaseMetadata!: () => void;
    let markMetadata!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const metadataStarted = new Promise<void>((resolve) => {
      markMetadata = resolve;
    });
    let runtimeActive = true;
    let fenceCalls = 0;
    const sockets: FakeSocket[] = [];
    const manager = new BaileysAccountManager(
      { ...config(), accounts: [config().accounts[0]!] },
      noOpEvents(),
      {
        now: () => new Date(nowMs),
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
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();
    socket.groupMetadataImpl = async () => {
      markMetadata();
      await metadataGate;
      return metadata();
    };
    nowMs += 31_000;

    const delivery = manager.sendGroupRunMessage(
      {
        scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
        accountId: "utama",
      },
      "Tidak boleh terkirim sesudah refresh",
      undefined,
      "effect-runtime-mode-after-refresh",
      memberRunAuthority(),
      async () => {
        fenceCalls += 1;
        return runtimeActive;
      },
    );
    await metadataStarted;
    runtimeActive = false;
    releaseMetadata();

    await assert.rejects(delivery, /Runtime delivery GroupRun/iu);
    assert.equal(socket.groupMetadataCalls, 1);
    assert.equal(fenceCalls, 1);
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
  });

  it("gagal tertutup ketika callback runtime delivery melempar error", async () => {
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
    const socket = sockets[0]!;
    socket.ev.emit("connection.update", { connection: "open" });
    socket.ev.emit("groups.upsert", [metadata()]);
    await manager.drainEvents();

    await assert.rejects(
      manager.sendGroupRunMessage(
        {
          scope: { channel: "whatsapp", groupId: "120363000000@g.us" },
          accountId: "utama",
        },
        "Callback gagal tidak boleh membuka delivery",
        undefined,
        "effect-runtime-fence-throws",
        memberRunAuthority(),
        async () => {
          throw new Error("detail internal runtime");
        },
      ),
      /Runtime delivery GroupRun/iu,
    );
    assert.deepEqual(socket.sentMessages, []);
    await manager.stop();
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
  groupMetadataCalls = 0;
  omitSentMessageId = false;
  ignoreRequestedMessageId = false;
  failSend = false;
  onSend?: (text: string) => void | Promise<void>;
  readonly sentMessages: Array<{
    jid: string;
    text: string;
    quotedMessageId: string | null;
    requestedMessageId: string | null;
  }> = [];
  readonly quotedRemoteJids: Array<string | null> = [];
  readonly editedMessageIds: Array<string | null> = [];
  readonly deletedMessageIds: Array<string | null> = [];
  readonly pinOperations: Array<{
    messageId: string | null;
    type: number | null;
    time: number | null;
  }> = [];
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
    groupMetadata: async () => {
      this.groupMetadataCalls += 1;
      return this.groupMetadataImpl();
    },
    sendMessage: async (
      jid: string,
      content: {
        text?: string;
        edit?: { id?: string };
        delete?: { id?: string };
        pin?: { id?: string };
        type?: number | null;
        time?: number;
      },
      options?: { quoted?: WAMessage; messageId?: string },
    ) => {
      if (this.failSend) throw new Error("simulated send failure");
      this.quotedRemoteJids.push(options?.quoted?.key.remoteJid ?? null);
      if (content.edit) this.editedMessageIds.push(content.edit.id ?? null);
      if (content.delete) this.deletedMessageIds.push(content.delete.id ?? null);
      if (content.pin) {
        this.pinOperations.push({
          messageId: content.pin.id ?? null,
          type: content.type ?? null,
          time: content.time ?? null,
        });
      }
      this.sentMessages.push({
        jid,
        text: content.text ?? "",
        quotedMessageId: options?.quoted?.key.id ?? null,
        requestedMessageId: options?.messageId ?? null,
      });
      await this.onSend?.(content.text ?? "");
      const sent = incomingMessage(
        !this.ignoreRequestedMessageId && options?.messageId
          ? options.messageId
          : `out-${content.text ?? "kosong"}`,
        true,
      );
      return this.omitSentMessageId
        ? { ...sent, key: { ...sent.key, id: undefined } }
        : sent;
    },
    end: async () => {
      this.endCalls += 1;
    },
  } as unknown as WASocket;
}

function config(): WhatsAppConfig {
  return {
    enabled: true,
    privateEnabled: false,
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

function messageInGroup(messageId: string, groupId: string): WAMessage {
  const message = incomingMessage(messageId);
  return {
    ...message,
    key: {
      ...message.key,
      remoteJid: groupId,
    },
  };
}

function memberRunAuthority(
  expectedAuthorityEpoch = 1,
): GroupRunDeliveryAuthorityExpectation {
  return {
    expectedAuthorityEpoch,
    actors: [{
      participantIds: [
        "12345@lid",
        "628777777777@s.whatsapp.net",
      ],
      expectedRole: "member",
    }],
  };
}

async function allowGroupRunRuntime(): Promise<boolean> {
  return true;
}

function adminRunAuthority(): GroupRunDeliveryAuthorityExpectation {
  return {
    expectedAuthorityEpoch: 1,
    actors: [{
      participantIds: [
        "12345@lid",
        "628777777777@s.whatsapp.net",
      ],
      expectedRole: "admin",
    }],
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
