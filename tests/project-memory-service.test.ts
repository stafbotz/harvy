import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MemoryKnowledgeService } from "../src/core/memory-knowledge-service.js";
import { ProjectMemoryService } from "../src/core/project-memory-service.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import { FileMemoryKnowledgeRepository } from "../src/storage/file-memory-knowledge-repository.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-11T04:00:00.000Z");
const SECRET = "project-memory-test-secret-32-characters";

describe("ProjectMemoryService Phase G", () => {
  it("mengikat facts/procedures ke project namespace dan ACL workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-project-memory-"));
    let sequence = 0;
    const ids = () => `id-${sequence += 1}`;
    const authority = new WorkspaceAuthorityService(
      new FileWorkspaceRepository(join(root, "authority.json")),
      () => NOW,
      ids,
    );
    const ownerPrincipal = workspacePrincipal(SECRET, "telegram", "owner");
    const workspace = await authority.createWorkspace("Project memory", ownerPrincipal);
    const knowledge = new MemoryKnowledgeService(
      new FileMemoryKnowledgeRepository(join(root, "knowledge")),
      null,
      () => NOW,
      ids,
    );
    const projects = new ProjectWorkspaceService(
      new FileProjectWorkspaceRepository(join(root, "projects.json")),
      authority,
      { root: join(root, "project-data") },
      knowledge,
      () => NOW,
      ids,
    );
    const memories = new ProjectMemoryService(
      knowledge,
      projects,
      authority,
      {
        async verify(_scope, _projectId, _projectRevision, evidenceIds) {
          return evidenceIds.length >= 2 && evidenceIds.every(
            (item) => /^validator-[a-z0-9-]+$/u.test(item),
          );
        },
      },
    );
    const project = await projects.createFromUpload(
      workspace.scope,
      buildZip([{ name: "src/index.ts", content: "export const value = 1;\n" }]),
    );

    const saved = await memories.remember(
      workspace.scope,
      project.id,
      project.revision,
      [
        {
          kind: "fact",
          subject: "test-suite",
          predicate: "uses",
          value: "node:test",
          displayText: "Project ini memakai node:test.",
        },
        {
          kind: "procedure",
          subject: "verification",
          predicate: "run",
          value: "npm test",
          displayText: "Jalankan npm test sebelum selesai.",
          sourceEvidenceIds: ["validator-test-1", "validator-test-2"],
        },
      ],
    );
    assert.equal(saved.saved, 2);
    const state = await memories.snapshot(workspace.scope, project.id, project.revision);
    assert.equal(state?.namespace.kind, "project");
    assert.equal(state?.semanticMemories.length, 2);
    assert.equal(state?.semanticMemories.some((item) => item.predicate === "procedure:run"), true);
    await assert.rejects(
      memories.remember(workspace.scope, project.id, project.revision, [{
        kind: "procedure",
        subject: "unsafe-procedure",
        predicate: "run",
        value: "skip tests",
        displayText: "Jangan simpan dari satu observasi.",
        sourceEvidenceIds: ["validator-only-once"],
      }]),
      /dua evidence/iu,
    );

    const viewerPrincipal = workspacePrincipal(SECRET, "telegram", "viewer");
    await authority.addMember(workspace.scope, viewerPrincipal, "viewer");
    const ownerScope = await authority.resolveScope(
      workspace.workspace.workspaceKey,
      ownerPrincipal,
    );
    const viewerScope = await authority.resolveScope(
      workspace.workspace.workspaceKey,
      viewerPrincipal,
    );
    assert.ok(ownerScope);
    assert.ok(viewerScope);
    assert.equal(
      (await memories.snapshot(viewerScope, project.id, project.revision))?.semanticMemories.length,
      2,
    );
    await assert.rejects(
      memories.remember(viewerScope, project.id, project.revision, [{
        kind: "fact",
        subject: "forbidden",
        predicate: "write",
        value: "denied",
        displayText: "Viewer tidak boleh menulis.",
      }]),
      /code\.write/iu,
    );
    await assert.rejects(
      memories.remember(ownerScope, project.id, project.revision, [{
        kind: "fact",
        subject: "secret",
        predicate: "contains",
        value: `github_pat_${"x".repeat(32)}`,
        displayText: "credential harus ditolak",
      }]),
      /credential/iu,
    );
    await assert.rejects(
      memories.remember(ownerScope, project.id, project.revision, [{
        kind: "fact",
        subject: "secret",
        predicate: "contains",
        value: `AWS_SECRET_ACCESS_KEY=${"s".repeat(40)}`,
        displayText: "credential trust-domain lain juga harus ditolak",
      }]),
      /credential/iu,
    );
    await assert.rejects(
      memories.remember(ownerScope, project.id, project.revision, [{
        kind: "fact",
        subject: "secret",
        predicate: "contains",
        value: "API key adalah CONTOH_KUNCI_123456",
        displayText: "credential berlabel natural juga harus ditolak",
      }]),
      /credential/iu,
    );

    const replaced = await projects.replaceFromUpload(
      ownerScope,
      project.id,
      project.revision,
      buildZip([{ name: "src/index.ts", content: "export const value = 2;\n" }]),
    );
    await assert.rejects(
      memories.snapshot(ownerScope, project.id, project.revision),
      /revision.*basi/iu,
    );
    await projects.remove(ownerScope, project.id, replaced.revision);
    assert.equal(await knowledge.snapshot(state!.namespace), null);
  });
});
