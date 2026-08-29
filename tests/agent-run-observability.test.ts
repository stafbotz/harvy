import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentRunLogFields } from "../src/ai/agent.js";
import type {
  AgentRunResult,
  AgentTraceEvent,
} from "../src/harness/agent-harness.js";

function trace(
  ...events: readonly [number, AgentTraceEvent["phase"], string, string | null][]
): AgentTraceEvent[] {
  return events.map(([step, phase, outcome, capabilityId]) => ({
    step,
    phase,
    outcome,
    capabilityId,
  }));
}

function completed(events: AgentTraceEvent[]): AgentRunResult {
  return {
    status: "completed",
    reply: "Jawaban akhir untuk pengguna.",
    trace: events,
  } as unknown as AgentRunResult;
}

describe("jejak run agent pada log operasional", () => {
  // Sampai 29 Agustus 2026 hanya run yang gagal meninggalkan jejak. Giliran
  // yang berhasil tidak dapat dibedakan dari balasan biasa, sehingga pertanyaan
  // pertama saat percakapan nyata berperilaku aneh—"apakah tadi lewat Agent
  // Runtime?"—tidak punya jawaban.
  it("menyebut capability yang benar-benar berhasil dieksekusi", () => {
    const fields = agentRunLogFields(
      completed(trace(
        [0, "plan", "action", null],
        [0, "execute", "started", "history.search"],
        [0, "execute", "ok", "history.search"],
        [1, "plan", "final", null],
        [1, "terminate", "completed", null],
      )),
      "tools",
    );

    assert.equal(fields["capabilities"], "history.search");
    assert.equal(fields["capabilityCount"], 1);
    assert.equal(fields["plannerMode"], "tools");
    assert.equal(fields["status"], "completed");
    assert.equal(fields["stepCount"], 5);
  });

  // Capability yang gagal bukan capability yang dipakai. Mencatatnya sebagai
  // terpakai membuat laporan live mengklaim jalur yang tidak pernah selesai.
  it("tidak menghitung eksekusi yang gagal sebagai capability terpakai", () => {
    const fields = agentRunLogFields(
      completed(trace(
        [0, "execute", "started", "calendar.agenda"],
        [0, "execute", "error", "calendar.agenda"],
        [1, "plan", "final", null],
      )),
      "tools",
    );

    assert.equal(fields["capabilities"], "none");
    assert.equal(fields["capabilityCount"], 0);
  });

  it("tidak mengulang capability yang dipanggil lebih dari sekali", () => {
    const fields = agentRunLogFields(
      completed(trace(
        [0, "execute", "ok", "history.search"],
        [1, "execute", "ok", "history.search"],
        [2, "execute", "ok", "task.list_active"],
      )),
      "orchestrate",
    );

    assert.equal(fields["capabilities"], "history.search+task.list_active");
    assert.equal(fields["capabilityCount"], 2);
    assert.equal(fields["plannerMode"], "orchestrate");
  });

  // Sanitizer log hanya menerima skalar dengan charset terbatas; koma membuat
  // seluruh nilai menjadi `[REDACTED_SCALAR]` dan jejaknya hilang diam-diam.
  it("memakai pemisah yang lolos sanitizer log", () => {
    const fields = agentRunLogFields(
      completed(trace(
        [0, "execute", "ok", "history.search"],
        [1, "execute", "ok", "memory.list"],
        [2, "execute", "ok", "task.list_active"],
      )),
      "tools",
    );

    assert.match(String(fields["capabilities"]), /^[A-Za-z0-9_./:@+-]{1,160}$/u);
  });

  // Batas yang tidak boleh dilanggar: jejak ini masuk berkas log, jadi ia tidak
  // boleh membawa satu pun kata dari pengguna atau dari model.
  it("tidak membawa balasan, prompt, atau teks pengguna", () => {
    const fields = agentRunLogFields(
      completed(trace([0, "execute", "ok", "history.search"])),
      "tools",
    );

    const serialized = JSON.stringify(fields);
    assert.doesNotMatch(serialized, /Jawaban akhir untuk pengguna/u);
    for (const key of Object.keys(fields)) {
      assert.ok(
        ["plannerMode", "status", "stepCount", "capabilityCount", "capabilities", "reason"]
          .includes(key),
        `field tak terduga: ${key}`,
      );
    }
  });

  // Fungsi ini dipanggil di jalur giliran pengguna. Versi pertamanya melakukan
  // iterasi langsung atas `trace`, lalu satu hasil `needs_input` tanpa jejak
  // melempar TypeError dan menjatuhkan seluruh giliran: checkpoint tidak
  // tersimpan dan pengguna kehilangan pertanyaan lanjutannya. Observability
  // tidak boleh pernah menjadi sebab giliran gagal.
  it("tidak melempar ketika hasil run datang tanpa jejak", () => {
    const withoutTrace = {
      status: "needs_input",
      prompt: "Rentang tanggal mana yang kamu maksud?",
    } as unknown as AgentRunResult;

    const fields = agentRunLogFields(withoutTrace, "tools");
    assert.equal(fields["status"], "needs_input");
    assert.equal(fields["stepCount"], 0);
    assert.equal(fields["capabilities"], "none");
    assert.equal(fields["capabilityCount"], 0);
  });

  it("menyertakan alasan hanya ketika run benar-benar dihentikan", () => {
    const stopped = {
      status: "stopped",
      reason: "provider_unavailable",
      checkpoint: null,
      trace: trace([0, "terminate", "provider_unavailable", null]),
    } as unknown as AgentRunResult;

    assert.equal(agentRunLogFields(stopped, "tools")["reason"], "provider_unavailable");
    assert.equal(
      agentRunLogFields(completed(trace([0, "plan", "final", null])), "tools")["reason"],
      undefined,
    );
  });
});
