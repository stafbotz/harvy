import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectMemoryNamespace } from "../src/core/memory-namespace.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-10T03:00:00.000Z");
const SECRET = "project-workspace-test-secret-32-characters";
const GIT_BASE = "a".repeat(40);
const GIT_HEAD = "b".repeat(40);
const GIT_COMMIT = "c".repeat(40);
const GIT_TREE = "d".repeat(40);
const GIT_BUNDLE = Buffer.from("test git object bundle", "utf8");
const GIT_BUNDLE_SHA = createHash("sha256").update(GIT_BUNDLE).digest("hex");

describe("ProjectWorkspace Phase G", () => {
  it("membuat artifact+snapshot immutable, commit revision, dan rollback tanpa menimpa snapshot", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    assert.equal(project.revision, 1);
    assert.equal(project.source.type, "upload");
    assert.equal(project.baseSnapshot.length, 64);
    if (project.source.type === "upload") {
      const ownerPart = createHash("sha256")
        .update("harvy-project-owner-v1\0", "utf8")
        .update(project.ownerWorkspaceKey, "utf8")
        .digest("hex");
      const artifactState = await stat(join(
        fixture.root,
        "project-data",
        "artifacts",
        ownerPart,
        project.id,
        `${project.source.artifactId}.zip`,
      ));
      assert.equal(artifactState.mode & 0o222, 0);
    }
    assert.deepEqual(
      projectMemoryNamespace(project.ownerWorkspaceKey, project.id),
      {
        kind: "project",
        workspaceKey: project.ownerWorkspaceKey,
        projectId: project.id,
      },
    );
    const manifest = await fixture.projects.readManifest(
      fixture.ownerScope,
      project.id,
    );
    assert.equal(manifest?.files[0]?.path, "src/index.ts");

    const working = await fixture.projects.createWorkingCopy(
      fixture.ownerScope,
      project.id,
      1,
    );
    await writeFile(
      join(working.internalPath, "src", "index.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    const committed = await fixture.projects.commitWorkingCopy(
      fixture.ownerScope,
      working,
    );
    assert.equal(committed.revision, 2);
    assert.notEqual(committed.baseSnapshot, project.baseSnapshot);
    await assert.rejects(access(working.internalPath));

    const pending = committed.pendingGitCommit!;
    assert.ok(pending, "upload coding revision harus menyiapkan local-git exact effect");
    await assert.rejects(
      fixture.projects.rollback(fixture.ownerScope, project.id, 2, 1),
      /Pending local git effect/iu,
    );
    const locallyCommitted = await fixture.projects.recordLocalGitCommit(
      fixture.ownerScope,
      project.id,
      committed.revision,
      {
        operationId: pending.operationId,
        projectId: project.id,
        snapshotId: committed.baseSnapshot,
        sourceWorkspaceRevision: committed.revision,
        branch: pending.targetBranch,
        parentCommit: pending.parentCommit,
        commit: GIT_COMMIT,
        treeHash: GIT_TREE,
        objectBundle: {
          version: 1,
          artifactId: `git-bundle-${GIT_BUNDLE_SHA}`,
          sha256: GIT_BUNDLE_SHA,
          size: GIT_BUNDLE.byteLength,
          mediaType: "application/vnd.git.bundle",
          commit: GIT_COMMIT,
          parentCommit: pending.parentCommit,
          treeHash: GIT_TREE,
        },
        authorName: "Harvy Bot",
        authorEmail: "bot@harvy.local",
        committedAt: NOW.toISOString(),
      },
    );

    const rolledBack = await fixture.projects.rollback(
      fixture.ownerScope,
      project.id,
      locallyCommitted.revision,
      1,
    );
    assert.equal(rolledBack.revision, 4);
    assert.equal(rolledBack.baseSnapshot, project.baseSnapshot);
    const restored = await fixture.projects.createWorkingCopy(
      fixture.ownerScope,
      project.id,
      4,
    );
    assert.equal(
      await readFile(join(restored.internalPath, "src", "index.ts"), "utf8"),
      "export const value = 1;\n",
    );
  });

  it("ZIP baru membuat revision baru dan tidak mengganti direktori run aktif", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("before\n"),
    );
    const oldWorking = await fixture.projects.createWorkingCopy(
      fixture.ownerScope,
      project.id,
      1,
    );
    const replaced = await fixture.projects.replaceFromUpload(
      fixture.ownerScope,
      project.id,
      1,
      zip("replacement\n"),
    );
    assert.equal(replaced.revision, 2);
    assert.equal(
      await readFile(join(oldWorking.internalPath, "src", "index.ts"), "utf8"),
      "before\n",
    );
    await assert.rejects(
      fixture.projects.commitWorkingCopy(fixture.ownerScope, oldWorking),
      /revision sudah basi/iu,
    );
  });

  it("membentuk bundle sandbox deterministik tanpa mengekspos host path", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("bundle\n"),
    );
    const handle = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const streamed = await fixture.projects.withSandboxSnapshotSource(
      fixture.ownerScope,
      handle,
      async (source) => {
        const bytes = await consume(source.open());
        await assert.rejects(consume(source.open()), /basi atau terpakai/iu);
        return { bytes, descriptor: structuredClone(source.descriptor) };
      },
    );
    const { bytes: first, descriptor } = streamed;
    assert.equal(first.length, descriptor.size);
    assert.equal(
      createHash("sha256").update(first).digest("hex"),
      descriptor.bundleSha256,
    );
    assert.equal(descriptor.snapshotId, project.baseSnapshot);
    assert.equal(JSON.stringify(descriptor).includes(handle.internalPath), false);

    const escaped = await fixture.projects.withSandboxSnapshotSource(
      fixture.ownerScope,
      handle,
      async (source) => source,
    );
    await assert.rejects(consume(escaped.open()), /basi atau terpakai/iu);
  });

  it("menolak path sensitif dan credential-like content sebelum snapshot keluar", async () => {
    const fixture = await createFixture();
    const sensitivePath = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      buildZip([
        { name: "src/index.ts", content: "export const safe = true;\n" },
        { name: ".env", content: "TOKEN=placeholder\n" },
      ]),
    );
    const sensitiveHandle = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      sensitivePath.id,
      sensitivePath.revision,
    );
    let pathOperationCalled = false;
    await assert.rejects(
      fixture.projects.withSandboxSnapshotSource(
        fixture.ownerScope,
        sensitiveHandle,
        async () => {
          pathOperationCalled = true;
        },
      ),
      /path sensitif/iu,
    );
    assert.equal(pathOperationCalled, false);

    const token = `xoxb-${"S".repeat(24)}`;
    const sensitiveContent = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      buildZip([{
        name: "src/config.ts",
        content: `export const legacy = "${token}";\n`,
      }]),
    );
    const contentHandle = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      sensitiveContent.id,
      sensitiveContent.revision,
    );
    let contentOperationCalled = false;
    await assert.rejects(
      fixture.projects.withSandboxSnapshotSource(
        fixture.ownerScope,
        contentHandle,
        async () => {
          contentOperationCalled = true;
        },
      ),
      /credential-like content/iu,
    );
    assert.equal(contentOperationCalled, false);
  });

  it("mengisolasi owner workspace, menolak root proses, dan menghapus project memory", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("private project\n"),
    );
    const stranger = await fixture.authority.createWorkspace(
      "Workspace lain",
      workspacePrincipal(SECRET, "telegram", "stranger"),
    );
    assert.equal(await fixture.projects.get(stranger.scope, project.id), null);

    assert.throws(
      () => new ProjectWorkspaceService(
        fixture.projectRepository,
        fixture.authority,
        { root: process.cwd() },
      ),
      /terpisah dari root proses/iu,
    );

    assert.equal(
      await fixture.projects.remove(fixture.ownerScope, project.id, 1),
      "removed",
    );
    assert.deepEqual(fixture.forgotten, [
      projectMemoryNamespace(project.ownerWorkspaceKey, project.id),
    ]);
    assert.equal(await fixture.projectRepository.load(project.id), null);
  });

  it("menolak disposal working copy dengan scope yang sudah dicabut", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("protected working copy\n"),
    );
    const editorPrincipal = workspacePrincipal(SECRET, "telegram", "dispose-editor");
    const added = await fixture.authority.addMember(
      fixture.ownerScope,
      editorPrincipal,
      "editor",
    );
    assert.equal(added.status, "updated");
    if (added.status !== "updated") return;
    const owner = await fixture.authority.resolveScope(
      fixture.ownerScope.workspaceKey,
      workspacePrincipal(SECRET, "telegram", "owner"),
    );
    const editor = await fixture.authority.resolveScope(
      fixture.ownerScope.workspaceKey,
      editorPrincipal,
    );
    assert.ok(owner);
    assert.ok(editor);
    const working = await fixture.projects.createWorkingCopy(
      editor,
      project.id,
      project.revision,
    );
    assert.equal(
      (await fixture.authority.removeMember(owner, added.membership.membershipId)).status,
      "updated",
    );
    await assert.rejects(
      fixture.projects.disposeWorkingCopy(editor, working),
      /tidak tersedia atau basi/iu,
    );
    assert.equal(
      await readFile(join(working.internalPath, "src", "index.ts"), "utf8"),
      "protected working copy\n",
    );
    const currentOwner = await fixture.authority.resolveScope(
      fixture.ownerScope.workspaceKey,
      workspacePrincipal(SECRET, "telegram", "owner"),
    );
    assert.ok(currentOwner);
    await fixture.projects.disposeWorkingCopy(currentOwner, working);
  });

  it("repository metadata menerapkan CAS dan bertahan setelah instance baru", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("persisted\n"),
    );
    const second = new FileProjectWorkspaceRepository(fixture.metadataFile);
    assert.equal((await second.load(project.id))?.baseSnapshot, project.baseSnapshot);
    const { revision: _revision, ...withoutRevision } = project;
    const candidate = {
      ...withoutRevision,
      snapshotHistory: [
        ...withoutRevision.snapshotHistory,
        {
          revision: 2,
          snapshotId: project.baseSnapshot,
          parentSnapshotId: project.baseSnapshot,
          reason: "coding" as const,
          createdAt: NOW.toISOString(),
        },
      ],
      storageUsage: structuredClone(project.storageUsage),
    };
    assert.equal(
      (await fixture.projectRepository.save(candidate, 1)).status,
      "saved",
    );
    const stale = await second.save(candidate, 1);
    assert.equal(stale.status, "conflict");
  });

  it("mematerialisasi selection GitHub secara deterministik dan idempoten", async () => {
    const fixture = await createFixture();
    const archive = buildZip([
      { name: "stafbotz-harvy-abcdef0/", content: "" },
      { name: "stafbotz-harvy-abcdef0/src/", content: "" },
      {
        name: "stafbotz-harvy-abcdef0/src/index.ts",
        content: "selected repository\n",
        unixMode: 0o100755,
      },
    ]);
    const input = {
      selectionId: "selection-1",
      installationConnectionId: "connection-1",
      repositoryId: "repository-1",
      installationId: "installation-1",
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      archive,
      git: { baseCommit: GIT_BASE, headCommit: GIT_BASE, branch: "main" },
    };
    const created = await fixture.projects.createFromGitHubSelection(
      fixture.ownerScope,
      input,
    );
    const replay = await fixture.projects.createFromGitHubSelection(
      fixture.ownerScope,
      input,
    );
    assert.equal(replay.id, created.id);
    assert.equal(replay.baseSnapshot, created.baseSnapshot);
    assert.equal((await fixture.projects.list(fixture.ownerScope)).length, 0);
    assert.equal(await fixture.projects.get(fixture.ownerScope, created.id), null);
    assert.equal(
      (await fixture.projects.getGitHubProvisioningProject(
        fixture.ownerScope,
        "selection-1",
      ))?.id,
      created.id,
    );
    assert.equal(created.source.type, "github");
    if (created.source.type === "github") {
      assert.equal(created.source.repositorySelectionId, "selection-1");
      assert.equal(created.source.installationConnectionId, "connection-1");
      assert.equal(created.source.provisioningStatus, "pending");
    }
    const activated = await fixture.projects.activateGitHubSelectionProject(
      fixture.ownerScope,
      "selection-1",
      "binding-1",
    );
    assert.equal(activated.revision, 2);
    assert.deepEqual(
      (await fixture.projects.readManifest(
        fixture.ownerScope,
        activated.id,
        activated.baseSnapshot,
      ))?.files.map((file) => ({
        path: file.path,
        executable: file.executable,
      })),
      [{ path: "src/index.ts", executable: true }],
    );
    assert.equal((await fixture.projects.list(fixture.ownerScope)).length, 1);
    assert.equal(
      (await fixture.projects.get(fixture.ownerScope, created.id))?.revision,
      2,
    );
    await assert.rejects(
      fixture.projects.createFromGitHubSelection(fixture.ownerScope, {
        ...input,
        archiveSha256: "f".repeat(64),
      }),
      /tidak cocok descriptor/iu,
    );
  });

  it("mencadangkan slot revision local-git sebelum snapshot GitHub dipromosikan", async () => {
    const constrained = await createFixture({ maxRevisionsPerProject: 2 });
    const blocked = await constrained.projects.createFromGitHubArchive(
      constrained.ownerScope,
      {
        repositoryId: "repository-1",
        installationId: "installation-1",
        archive: githubZip("before\n"),
        git: { baseCommit: GIT_BASE, headCommit: GIT_HEAD, branch: "main" },
      },
    );
    const blockedWorking = await constrained.projects.createWorkingCopy(
      constrained.ownerScope,
      blocked.id,
      blocked.revision,
    );
    await writeFile(
      join(blockedWorking.internalPath, "src", "index.ts"),
      "after\n",
      "utf8",
    );
    await assert.rejects(
      constrained.projects.commitWorkingCopy(
        constrained.ownerScope,
        blockedWorking,
      ),
      /Batas revision ProjectWorkspace/iu,
    );
    assert.equal(
      (await constrained.projectRepository.load(blocked.id))?.revision,
      1,
    );

    const fixture = await createFixture({ maxRevisionsPerProject: 3 });
    const project = await fixture.projects.createFromGitHubArchive(
      fixture.ownerScope,
      {
        repositoryId: "repository-1",
        installationId: "installation-1",
        archive: githubZip("before\n"),
        git: { baseCommit: GIT_BASE, headCommit: GIT_HEAD, branch: "main" },
      },
    );
    const working = await fixture.projects.createWorkingCopy(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    await writeFile(join(working.internalPath, "src", "index.ts"), "after\n", "utf8");
    const committed = await fixture.projects.commitWorkingCopy(
      fixture.ownerScope,
      working,
    );
    assert.equal(committed.revision, 2);
    const pending = committed.pendingGitCommit!;
    assert.equal(pending.snapshotId, committed.baseSnapshot);
    assert.equal(pending.sourceRevision, 2);
    assert.equal(pending.baseCommit, GIT_BASE);
    assert.equal(pending.parentCommit, GIT_HEAD);
    assert.match(pending.operationId, /^local-git-[a-f0-9]{64}$/u);
    assert.match(pending.targetBranch, /^harvy\//u);
    assert.equal(pending.preparedAt, NOW.toISOString());
    assert.deepEqual(
      (await new FileProjectWorkspaceRepository(fixture.metadataFile).load(project.id))
        ?.pendingGitCommit,
      committed.pendingGitCommit,
    );
    const withLocalCommit = await fixture.projects.recordLocalGitCommit(
      fixture.ownerScope,
      project.id,
      committed.revision,
      {
        operationId: pending.operationId,
        projectId: project.id,
        snapshotId: committed.baseSnapshot,
        sourceWorkspaceRevision: committed.revision,
        branch: pending.targetBranch,
        parentCommit: GIT_HEAD,
        commit: GIT_COMMIT,
        treeHash: GIT_TREE,
        objectBundle: {
          version: 1,
          artifactId: `git-bundle-${GIT_BUNDLE_SHA}`,
          sha256: GIT_BUNDLE_SHA,
          size: GIT_BUNDLE.byteLength,
          mediaType: "application/vnd.git.bundle",
          commit: GIT_COMMIT,
          parentCommit: GIT_HEAD,
          treeHash: GIT_TREE,
        },
        authorName: "Harvy Bot",
        authorEmail: "bot@harvy.local",
        committedAt: NOW.toISOString(),
      },
    );
    assert.equal(withLocalCommit.revision, 3);
    assert.equal(withLocalCommit.pendingGitCommit, undefined);
    assert.equal(withLocalCommit.localGitCommitReceipts?.[0]?.commit, GIT_COMMIT);
  });

  it("memulihkan trash prepared yang masih direferensikan sebelum menghitung quota", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("recoverable\n"),
    );
    const handle = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const ownerPart = createHash("sha256")
      .update("harvy-project-owner-v1\0", "utf8")
      .update(project.ownerWorkspaceKey, "utf8")
      .digest("hex");
    const storageRoot = join(fixture.root, "project-data");
    const manifest = join(
      storageRoot,
      "manifests",
      ownerPart,
      project.id,
      `${project.baseSnapshot}.json`,
    );
    const trash = join(
      storageRoot,
      "trash",
      ownerPart,
      project.id,
      "prune-test",
    );
    await mkdir(trash, { recursive: true });
    await writeFile(join(trash, ".harvy-trash.json"), `${JSON.stringify({
      version: 1,
      kind: "snapshot-prune",
      ownerPart,
      projectId: project.id,
      projectCreatedAt: project.createdAt,
      snapshotId: project.baseSnapshot,
    })}\n`, "utf8");
    await rename(handle.internalPath, join(trash, "snapshot"));
    await rename(manifest, join(trash, "manifest"));

    await fixture.projects.createFromUpload(fixture.ownerScope, zip("second\n"));
    const restored = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    assert.equal(
      await readFile(join(restored.internalPath, "src", "index.ts"), "utf8"),
      "recoverable\n",
    );
  });

  it("menyelesaikan recovery prune yang crash sebelum atau di tengah rename", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("base\n"),
    );
    const working = await fixture.projects.createWorkingCopy(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const ownerPart = createHash("sha256")
      .update("harvy-project-owner-v1\0", "utf8")
      .update(project.ownerWorkspaceKey, "utf8")
      .digest("hex");
    const storageRoot = join(fixture.root, "project-data");
    const prepareMarker = async (snapshotId: string, name: string) => {
      const trash = join(storageRoot, "trash", ownerPart, project.id, name);
      await mkdir(trash, { recursive: true });
      await writeFile(join(trash, ".harvy-trash.json"), `${JSON.stringify({
        version: 1,
        kind: "snapshot-prune",
        ownerPart,
        projectId: project.id,
        projectCreatedAt: project.createdAt,
        snapshotId,
      })}\n`, "utf8");
      return trash;
    };
    const manifestPath = (snapshotId: string) => join(
      storageRoot,
      "manifests",
      ownerPart,
      project.id,
      `${snapshotId}.json`,
    );

    await writeFile(join(working.internalPath, "src", "index.ts"), "stage-one\n");
    const first = await fixture.projects.stageWorkingSnapshot(
      fixture.ownerScope,
      working,
    );
    const firstManifest = manifestPath(first.snapshotId);
    const firstTrash = await prepareMarker(first.snapshotId, "before-first-rename");
    await fixture.projects.createFromUpload(fixture.ownerScope, zip("trigger-one\n"));
    await assert.rejects(access(first.internalPath));
    await assert.rejects(access(firstManifest));
    await assert.rejects(access(firstTrash));

    await writeFile(join(working.internalPath, "src", "index.ts"), "stage-two\n");
    const second = await fixture.projects.stageWorkingSnapshot(
      fixture.ownerScope,
      working,
    );
    const secondManifest = manifestPath(second.snapshotId);
    const secondTrash = await prepareMarker(second.snapshotId, "between-renames");
    await rename(second.internalPath, join(secondTrash, "snapshot"));
    await fixture.projects.createFromUpload(fixture.ownerScope, zip("trigger-two\n"));
    await assert.rejects(access(second.internalPath));
    await assert.rejects(access(secondManifest));
    await assert.rejects(access(secondTrash));
  });

  it("mendeteksi tamper snapshot dan membatasi quota/revision secara fail-closed", async () => {
    const fixture = await createFixture({ maxRevisionsPerProject: 2 });
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("original\n"),
    );
    const handle = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      project.id,
      1,
    );
    const snapshotFile = join(handle.internalPath, "src", "index.ts");
    await chmod(snapshotFile, 0o600);
    await writeFile(snapshotFile, "tampered\n", "utf8");
    await assert.rejects(
      fixture.projects.createWorkingCopy(fixture.ownerScope, project.id, 1),
      /immutable snapshot/iu,
    );

    const rollbackFixture = await createFixture({ maxRevisionsPerProject: 3 });
    const rollbackProject = await rollbackFixture.projects.createFromUpload(
      rollbackFixture.ownerScope,
      zip("rollback-one\n"),
    );
    const rollbackTarget = await rollbackFixture.projects.getSnapshotHandle(
      rollbackFixture.ownerScope,
      rollbackProject.id,
      1,
    );
    const rollbackCurrent = await rollbackFixture.projects.replaceFromUpload(
      rollbackFixture.ownerScope,
      rollbackProject.id,
      1,
      zip("rollback-two\n"),
    );
    const rollbackTargetFile = join(rollbackTarget.internalPath, "src", "index.ts");
    await chmod(rollbackTargetFile, 0o600);
    await writeFile(rollbackTargetFile, "tampered rollback target\n", "utf8");
    await assert.rejects(
      rollbackFixture.projects.rollback(
        rollbackFixture.ownerScope,
        rollbackProject.id,
        rollbackCurrent.revision,
        1,
      ),
      /immutable snapshot/iu,
    );
    assert.equal(
      (await rollbackFixture.projectRepository.load(rollbackProject.id))?.revision,
      rollbackCurrent.revision,
    );

    const revisionFixture = await createFixture({ maxRevisionsPerProject: 2 });
    const revisionProject = await revisionFixture.projects.createFromUpload(
      revisionFixture.ownerScope,
      zip("one\n"),
    );
    await revisionFixture.projects.replaceFromUpload(
      revisionFixture.ownerScope,
      revisionProject.id,
      1,
      zip("two\n"),
    );
    await assert.rejects(
      revisionFixture.projects.replaceFromUpload(
        revisionFixture.ownerScope,
        revisionProject.id,
        2,
        zip("three\n"),
      ),
      /batas revision/iu,
    );

    const quotaFixture = await createFixture({
      maxStoredBytesPerProject: 1,
      maxStoredBytesPerOwner: 1,
    });
    await assert.rejects(
      quotaFixture.projects.createFromUpload(quotaFixture.ownerScope, zip("x\n")),
      /quota storage/iu,
    );
    assert.deepEqual(await quotaFixture.projects.list(quotaFixture.ownerScope), []);

    const workingFixture = await createFixture({ maxWorkingCopiesPerProject: 1 });
    const workingProject = await workingFixture.projects.createFromUpload(
      workingFixture.ownerScope,
      zip("working\n"),
    );
    const firstWorking = await workingFixture.projects.createWorkingCopy(
      workingFixture.ownerScope,
      workingProject.id,
      1,
    );
    await assert.rejects(
      workingFixture.projects.createWorkingCopy(
        workingFixture.ownerScope,
        workingProject.id,
        1,
      ),
      /quota working copy/iu,
    );
    await workingFixture.projects.disposeWorkingCopy(
      workingFixture.ownerScope,
      firstWorking,
    );
    assert.equal(
      (await workingFixture.projects.createWorkingCopy(
        workingFixture.ownerScope,
        workingProject.id,
        1,
      )).projectId,
      workingProject.id,
    );
  });
});

async function createFixture(storage: {
  maxRevisionsPerProject?: number;
  maxStoredBytesPerProject?: number;
  maxStoredBytesPerOwner?: number;
  maxWorkingCopiesPerProject?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "harvy-project-workspace-"));
  const metadataFile = join(root, "projects.json");
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "authority.json")),
    () => NOW,
    ids,
  );
  const owner = workspacePrincipal(SECRET, "telegram", "owner");
  const created = await authority.createWorkspace("Coding", owner);
  const projectRepository = new FileProjectWorkspaceRepository(metadataFile);
  const forgotten: Array<ReturnType<typeof projectMemoryNamespace>> = [];
  const projects = new ProjectWorkspaceService(
    projectRepository,
    authority,
    { root: join(root, "project-data"), ...storage },
    {
      async forgetAll(namespace) {
        forgotten.push(structuredClone(namespace));
      },
    },
    () => NOW,
    ids,
    {
      async isProjectSelectionBound(binding) {
        return binding.selectionId === "selection-1" &&
          binding.bindingId === "binding-1";
      },
    },
  );
  return {
    root,
    metadataFile,
    authority,
    ownerScope: created.scope,
    projectRepository,
    projects,
    forgotten,
  };
}

function zip(content: string): Buffer {
  return buildZip([
    { name: "src/", content: "" },
    { name: "src/index.ts", content },
  ]);
}

function githubZip(content: string): Buffer {
  return buildZip([
    { name: "owner-repository-deadbeef/", content: "" },
    { name: "owner-repository-deadbeef/src/", content: "" },
    { name: "owner-repository-deadbeef/src/index.ts", content },
  ]);
}

async function consume(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
