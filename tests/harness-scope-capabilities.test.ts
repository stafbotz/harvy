import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capabilitySystemContext,
  createHarvyCapabilityCatalog,
} from "../src/harness/capabilities.js";
import {
  groupAgentScope,
  privateAgentScope,
} from "../src/harness/scope.js";

describe("scope harness", () => {
  it("memisahkan user privat per kanal dan anggota per grup", () => {
    const telegram = privateAgentScope("telegram", "42");
    const whatsapp = privateAgentScope("whatsapp", "42");
    const groupA = groupAgentScope("whatsapp", "kelas-a", "42");
    const groupB = groupAgentScope("whatsapp", "kelas-b", "42");

    assert.notEqual(telegram.memoryKey, whatsapp.memoryKey);
    assert.notEqual(telegram.memoryKey, groupA.memoryKey);
    assert.notEqual(groupA.memoryKey, groupB.memoryKey);
    assert.notEqual(groupA.memoryKey, groupA.sharedMemoryKey);
  });

  it("mengenkode delimiter sehingga dua tuple tidak bertabrakan", () => {
    const first = groupAgentScope("telegram", "a:b", "c");
    const second = groupAgentScope("telegram", "a", "b:c");
    assert.notEqual(first.memoryKey, second.memoryKey);
  });

  it("menolak ID kosong dan karakter kontrol", () => {
    assert.throws(() => privateAgentScope("telegram", "   "));
    assert.throws(() => groupAgentScope("whatsapp", "grup", "a\u0000b"));
  });
});

describe("capability catalog", () => {
  it("memberi kontrak kemampuan grup yang sama pada Telegram dan WhatsApp", () => {
    const catalog = createHarvyCapabilityCatalog([
      "group:telegram",
      "group:whatsapp",
    ]);
    const telegram = catalog.snapshot(
      groupAgentScope("telegram", "g", "anggota"),
    );
    const whatsapp = catalog.snapshot(
      groupAgentScope("whatsapp", "g", "anggota"),
    );

    assert.deepEqual(
      telegram.entries.map(({ id, available }) => ({ id, available })),
      whatsapp.entries.map(({ id, available }) => ({ id, available })),
    );
  });

  it("jujur bahwa aksi eksternal belum dipasang", () => {
    const scope = privateAgentScope("telegram", "rahasia-user");
    const snapshot = createHarvyCapabilityCatalog().snapshot(scope);
    const prompt = capabilitySystemContext(snapshot);

    assert.equal(
      snapshot.entries.find((entry) => entry.id === "external.act")?.available,
      false,
    );
    assert.match(prompt, /menjawab dari pengetahuan model bukan pencarian/iu);
    assert.doesNotMatch(prompt, /rahasia-user/u);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.entries), true);
    assert.equal(Object.isFrozen(snapshot.entries[0]), true);
  });

  it("tidak mencantumkan tool research yang sudah dicabut", () => {
    const snapshot = createHarvyCapabilityCatalog().snapshot(
      privateAgentScope("telegram", "1"),
    );
    assert.equal(
      snapshot.entries.some((entry) =>
        entry.id === "web.search" || entry.id === "web.open"
      ),
      false,
    );
  });

  it("menjaga specialist default-off dan hanya available lewat opt-in tepercaya", () => {
    const scope = privateAgentScope("telegram", "1");
    const defaultEntry = createHarvyCapabilityCatalog().snapshot(scope).entries
      .find((entry) => entry.id === "agent.delegate.specialist");
    const installedEntry = createHarvyCapabilityCatalog({
      specialistDelegationInstalled: true,
    }).snapshot(scope).entries
      .find((entry) => entry.id === "agent.delegate.specialist");

    assert.equal(defaultEntry?.available, false);
    assert.equal(installedEntry?.available, true);
    assert.match(installedEntry?.description ?? "", /WorkBrief/u);
  });

  it("menyatakan gap kanal privat tanpa membuat katalog kedua", () => {
    const catalog = createHarvyCapabilityCatalog();
    const telegram = catalog.snapshot(privateAgentScope("telegram", "1"));
    const whatsapp = catalog.snapshot(privateAgentScope("whatsapp", "1"));

    assert.equal(
      telegram.entries.find((entry) => entry.id === "task.manage")?.available,
      true,
    );
    assert.equal(
      whatsapp.entries.find((entry) => entry.id === "task.manage")?.available,
      false,
    );
    assert.equal(
      whatsapp.entries.find((entry) => entry.id === "memory.scoped")?.available,
      false,
    );
  });

  it("tidak mengaku adapter Telegram grup sudah hidup hanya karena core-nya bersama", () => {
    const snapshot = createHarvyCapabilityCatalog().snapshot(
      groupAgentScope("telegram", "g", "anggota"),
    );

    assert.equal(
      snapshot.entries.find((entry) => entry.id === "group.participate")
        ?.available,
      false,
    );
    assert.match(
      snapshot.entries.find((entry) => entry.id === "group.participate")
        ?.unavailableReason ?? "",
      /adapter.*belum tersedia/iu,
    );
  });
});
