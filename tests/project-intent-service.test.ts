import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectIntentService } from "../src/core/project-intent-service.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import { FileProjectIntentRepository } from "../src/storage/file-project-intent-repository.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";

const NOW = new Date("2026-08-26T10:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectGoal dan skill deklaratif", () => {
  it("membuat project kosong content-addressed dan memuatnya lagi", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createBlank(fixture.scope);
    assert.equal(project.source.type, "blank");
    assert.equal(project.revision, 1);
    assert.match(project.baseSnapshot, /^[a-f0-9]{64}$/u);
    const manifest = await fixture.projects.readManifest(fixture.scope, project.id);
    assert.deepEqual(manifest?.files, []);
    assert.equal(manifest?.totalBytes, 0);
  });

  it("menahan completion sampai semua criterion mempunyai evidence durable", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createBlank(fixture.scope);
    const goal = await fixture.intents.setGoal(fixture.scope, project.id, {
      objective: "Bangun Repo Doctor yang dapat diverifikasi.",
      acceptanceCriteria: [
        { kind: "code", text: "Semua validator lulus." },
        { kind: "github", text: "Draft PR tersedia." },
        { kind: "manual", text: "Pengguna menerima UX CLI." },
      ],
      milestones: ["Implementasi", "Publikasi"],
    });
    await assert.rejects(
      fixture.intents.completeGoal(fixture.scope, project.id),
      /criterion tanpa evidence/iu,
    );
    const afterCode = await fixture.intents.recordEvidence(fixture.scope, project.id, {
      ref: "coding-run:run-1",
      kind: "coding_run",
      summary: "Validator dan local commit lulus.",
      satisfyKinds: ["code"],
    });
    assert.equal(afterCode.acceptanceCriteria[0]?.status, "met");
    const replayedCode = await fixture.intents.recordEvidence(fixture.scope, project.id, {
      ref: "coding-run:run-1",
      kind: "coding_run",
      summary: "Validator dan local commit lulus.",
      satisfyKinds: ["code"],
    });
    assert.equal(replayedCode.evidence.length, 1);
    assert.deepEqual(
      await fixture.intents.latestEvidenceRefs(fixture.scope, project.id),
      ["coding-run:run-1"],
    );
    const afterGitHub = await fixture.intents.recordEvidence(fixture.scope, project.id, {
      ref: "github:pr-1",
      kind: "github",
      summary: "Draft PR dibuat pada branch terisolasi.",
      satisfyKinds: ["github"],
    });
    const manualId = afterGitHub.acceptanceCriteria.find((item) => item.kind === "manual")!.id;
    await fixture.intents.recordEvidence(fixture.scope, project.id, {
      ref: "user-confirmation:ux-1",
      kind: "user_confirmation",
      summary: "UX CLI diterima pengguna.",
      satisfyCriterionIds: [manualId],
    });
    const completed = await fixture.intents.completeGoal(fixture.scope, project.id);
    assert.equal(completed.status, "completed");

    const restarted = new ProjectIntentService(
      new FileProjectIntentRepository(fixture.intentFile),
      fixture.authority,
      fixture.projects,
      fixture.tools,
      () => NOW,
      fixture.ids,
    );
    assert.equal((await restarted.goal(fixture.scope, project.id))?.revision, completed.revision);
    assert.equal((await restarted.goal(fixture.scope, project.id))?.status, "completed");
    assert.equal(goal.goalId, completed.goalId);
  });

  it("membuat skill hanya dari evidence dan tidak memberinya capability baru", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createBlank(fixture.scope);
    await fixture.intents.setGoal(fixture.scope, project.id, {
      objective: "Audit project.",
      acceptanceCriteria: [{ kind: "code", text: "Validator lulus." }],
    });
    await assert.rejects(
      fixture.intents.createSkill(fixture.scope, project.id, skillInput(["missing:evidence"])),
      /evidence goal/iu,
    );
    await fixture.intents.recordEvidence(fixture.scope, project.id, {
      ref: "coding-run:run-1",
      kind: "coding_run",
      summary: "Workflow audit berhasil.",
      satisfyKinds: ["code"],
    });
    await assert.rejects(
      fixture.intents.createSkill(fixture.scope, project.id, {
        ...skillInput(["coding-run:run-1"]),
        toolRequirements: ["host.shell"],
      }),
      /capability yang tidak tersedia/iu,
    );
    const skill = await fixture.intents.createSkill(
      fixture.scope,
      project.id,
      skillInput(["coding-run:run-1"]),
    );
    assert.equal(skill.versions.length, 1);
    assert.equal((await fixture.intents.skillForApply(fixture.scope, project.id, "Repo quality" )).version, 1);
    const updated = await fixture.intents.updateSkill(
      fixture.scope,
      project.id,
      skill.skillId,
      { ...skillInput(["coding-run:run-1"]), description: "Audit project secara berulang." },
    );
    assert.equal(updated.versions.length, 2);
    await fixture.intents.setSkillActive(fixture.scope, project.id, skill.skillId, false);
    await assert.rejects(
      fixture.intents.skillForApply(fixture.scope, project.id, skill.skillId),
      /tidak ditemukan/iu,
    );
  });

  it("menyelesaikan blocker natural hanya bila rujukannya unik", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createBlank(fixture.scope);
    await fixture.intents.setGoal(fixture.scope, project.id, {
      objective: "Audit project.",
      acceptanceCriteria: [{ kind: "manual", text: "Audit diterima." }],
    });
    await fixture.intents.addBlocker(fixture.scope, project.id, "Akses registry belum tersedia");
    await fixture.intents.addBlocker(fixture.scope, project.id, "Akses GitHub belum tersedia");
    await assert.rejects(
      fixture.intents.resolveBlockerByQuery(fixture.scope, project.id, "akses"),
      /ambigu/iu,
    );
    const resolved = await fixture.intents.resolveBlockerByQuery(
      fixture.scope,
      project.id,
      "registry",
    );
    assert.equal(
      resolved.blockers.find((item) => item.summary.includes("registry"))?.status,
      "resolved",
    );
  });
});

function skillInput(sourceEvidenceRefs: string[]) {
  return {
    name: "Repo quality",
    description: "Audit kualitas project Node.",
    semanticTriggers: ["audit repo"],
    preconditions: ["Project aktif tersedia."],
    steps: ["Baca manifest.", "Jalankan validator."],
    toolRequirements: ["workspace.read", "sandbox.test"],
    verification: ["Semua validator lulus."],
    sourceEvidenceRefs,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "harvy-project-intent-"));
  roots.push(root);
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "workspaces.json")),
    () => NOW,
    ids,
  );
  const principal = workspacePrincipal("project-intent-secret-32-characters", "telegram", "owner");
  const created = await authority.createWorkspace("Repo Doctor", principal);
  const projects = new ProjectWorkspaceService(
    new FileProjectWorkspaceRepository(join(root, "projects.json")),
    authority,
    { root: join(root, "project-storage"), processRoot: process.cwd() },
    undefined,
    () => NOW,
    ids,
  );
  const intentFile = join(root, "project-intents.json");
  const tools = ["workspace.read", "sandbox.test"];
  const intents = new ProjectIntentService(
    new FileProjectIntentRepository(intentFile),
    authority,
    projects,
    tools,
    () => NOW,
    ids,
  );
  return { root, ids, authority, projects, intents, intentFile, tools, scope: created.scope };
}
