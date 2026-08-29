import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertCallableCapabilitySchemas,
  createHarvyCapabilityCatalog,
} from "../src/harness/capabilities.js";

const NATIVE_TOOL = {
  name: "harvy_contoh_v1",
  description: "Tool contoh untuk pemeriksaan wiring.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

describe("pagar schema capability pada composition root", () => {
  // Kombinasi "terpasang tetapi tanpa schema" mematikan seluruh run agent di
  // proses itu pada langkah pertama, dan gejalanya menyamar sebagai keluaran
  // planner yang tidak sah. Empat kasus probe pernah terbaca sebagai kemampuan
  // yang belum terbukti selama berjam-jam karena ini.
  it("menolak capability terpasang yang executornya tanpa schema", () => {
    const catalog = createHarvyCapabilityCatalog({ recallToolsInstalled: true });

    assert.throws(
      () =>
        assertCallableCapabilitySchemas(catalog, [
          { capabilityId: "history.search" },
        ]),
      /history\.search/u,
    );
  });

  it("menyebut seluruh capability yang bermasalah, bukan hanya yang pertama", () => {
    const catalog = createHarvyCapabilityCatalog({ recallToolsInstalled: true });

    assert.throws(
      () =>
        assertCallableCapabilitySchemas(catalog, [
          { capabilityId: "memory.list" },
          { capabilityId: "history.search" },
        ]),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return message.includes("history.search") &&
          message.includes("memory.list");
      },
    );
  });

  // Pemeriksaannya memakai irisan terpasang dan executor. Executor untuk
  // capability yang tidak dipasang tidak pernah ditawarkan ke planner, jadi
  // menuntut schema darinya akan menolak fixture yang sah: banyak tes memakai
  // executor tanpa schema bersama planner stub.
  it("membiarkan executor untuk capability yang tidak dipasang", () => {
    const catalog = createHarvyCapabilityCatalog({ recallToolsInstalled: false });

    assert.doesNotThrow(() =>
      assertCallableCapabilitySchemas(catalog, [
        { capabilityId: "history.search" },
      ])
    );
  });

  it("menerima executor terpasang yang membawa schema", () => {
    const catalog = createHarvyCapabilityCatalog({ recallToolsInstalled: true });

    assert.doesNotThrow(() =>
      assertCallableCapabilitySchemas(catalog, [
        { capabilityId: "history.search", nativeTool: NATIVE_TOOL },
        { capabilityId: "memory.list", nativeTool: NATIVE_TOOL },
      ])
    );
  });

  it("tidak mempermasalahkan daftar executor kosong", () => {
    assert.doesNotThrow(() =>
      assertCallableCapabilitySchemas(
        createHarvyCapabilityCatalog({ recallToolsInstalled: true }),
        [],
      )
    );
  });
});
