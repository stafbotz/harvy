import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import type {
  WorkspaceAuthorityState,
  WorkspaceRepository,
} from "../src/domain/workspace.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { scopeKey } from "../src/harness/scope.js";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SECRET = "workspace-test-secret-32-characters-long";

describe("workspace authority", () => {
  it("membentuk principal pseudonim yang terpisah per kanal", () => {
    const telegram = workspacePrincipal(SECRET, "telegram", "42");
    const whatsapp = workspacePrincipal(SECRET, "whatsapp", "42");

    assert.notEqual(telegram.principalKey, whatsapp.principalKey);
    assert.equal(telegram.principalKey.length, 64);
    assert.equal(JSON.stringify(telegram).includes("42"), false);
    assert.throws(() => workspacePrincipal("pendek", "telegram", "42"));
  });

  it("mengisolasi workspace dan mengikat authority key ke ACL epoch", async () => {
    const { service } = createService();
    const owner = principal("owner");
    const first = await service.createWorkspace("Riset A", owner);
    const second = await service.createWorkspace("Riset B", owner);

    assert.notEqual(first.scope.sharedMemoryKey, second.scope.sharedMemoryKey);
    assert.notEqual(first.scope.artifactKey, second.scope.artifactKey);
    const oldScope = first.scope;
    const added = await service.addMember(oldScope, principal("editor"), "editor");
    assert.equal(added.status, "updated");
    assert.equal(await service.isCurrent(oldScope), false);

    const fresh = await service.resolveScope(first.workspace.workspaceKey, owner);
    assert.ok(fresh);
    assert.equal(fresh.sharedMemoryKey, oldScope.sharedMemoryKey);
    assert.equal(fresh.artifactKey, oldScope.artifactKey);
    assert.notEqual(scopeKey(fresh), scopeKey(oldScope));
    assert.doesNotMatch(scopeKey(fresh), /owner|editor/u);
    assert.equal(
      await service.isCurrent({
        ...fresh,
        permissions: [...fresh.permissions, "workspace.manage"],
      }),
      false,
    );
    assert.equal(
      await service.isCurrent({
        ...fresh,
        artifactKey: "v1:workspace:other:artifact",
      }),
      false,
    );
  });

  it("menerapkan role matrix dan menolak scope basi", async () => {
    const { service } = createService();
    const ownerPrincipal = principal("owner");
    const created = await service.createWorkspace("Kelas", ownerPrincipal);

    const addAdmin = await service.addMember(
      created.scope,
      principal("admin"),
      "admin",
    );
    assert.equal(addAdmin.status, "updated");
    assert.equal(
      (await service.addMember(created.scope, principal("basi"), "viewer")).status,
      "stale",
    );

    let owner = await service.resolveScope(created.workspace.workspaceKey, ownerPrincipal);
    assert.ok(owner);
    const addViewer = await service.addMember(
      owner,
      principal("viewer"),
      "viewer",
    );
    assert.equal(addViewer.status, "updated");
    assert.equal(addViewer.status === "updated" && addViewer.membership.role, "viewer");

    const admin = await service.resolveScope(
      created.workspace.workspaceKey,
      principal("admin"),
    );
    assert.ok(admin);
    assert.equal(
      (await service.changeRole(admin, created.owner.membershipId, "viewer")).status,
      "forbidden",
    );
    assert.equal(await service.authorize(admin, "membership.manage"), true);

    const viewer = await service.resolveScope(
      created.workspace.workspaceKey,
      principal("viewer"),
    );
    assert.ok(viewer);
    assert.equal(await service.authorize(viewer, "artifact.read"), true);
    assert.equal(await service.authorize(viewer, "artifact.write"), false);
    assert.equal(
      (await service.addMember(viewer, principal("lain"), "viewer")).status,
      "forbidden",
    );

    owner = await service.resolveScope(created.workspace.workspaceKey, ownerPrincipal);
    assert.ok(owner);
    if (addViewer.status !== "updated") return;
    assert.equal(
      (await service.removeMember(owner, addViewer.membership.membershipId)).status,
      "updated",
    );
    assert.equal(
      await service.resolveScope(created.workspace.workspaceKey, principal("viewer")),
      null,
    );
  });

  it("mewajibkan revalidator sebelum harness memakai workspace", async () => {
    const { service } = createService();
    const created = await service.createWorkspace("Agent", principal("owner"));
    const harness = new AgentHarness(
      createHarvyCapabilityCatalog({
        activeSurfaces: ["workspace:telegram"],
      }),
      service,
    );
    let planned = 0;
    const planner = async () => {
      planned += 1;
      return { kind: "final", reply: "selesai" };
    };

    const missingAuthority = await harness.run({
      scope: created.scope,
      request: "cari",
      planner,
    });
    assert.equal(missingAuthority.status, "stopped");
    assert.equal(
      missingAuthority.status === "stopped" && missingAuthority.reason,
      "stale",
    );
    assert.equal(planned, 0);

    const current = await harness.run({
      scope: created.scope,
      request: "cari",
      planner,
      isCurrent: () => true,
    });
    assert.equal(current.status, "completed");
    assert.equal(planned, 1);
  });

  it("menolak write epoch lama dari dua service authority yang berlomba", async () => {
    const repository = new MemoryWorkspaceRepository();
    let sequence = 0;
    const serviceA = new WorkspaceAuthorityService(
      repository,
      () => NOW,
      () => `a:${sequence += 1}`,
    );
    const serviceB = new WorkspaceAuthorityService(
      repository,
      () => NOW,
      () => `b:${sequence += 1}`,
    );
    const created = await serviceA.createWorkspace("Race", principal("owner"));
    const scopeA = await serviceA.resolveScope(
      created.workspace.workspaceKey,
      principal("owner"),
    );
    const scopeB = await serviceB.resolveScope(
      created.workspace.workspaceKey,
      principal("owner"),
    );
    assert.ok(scopeA);
    assert.ok(scopeB);
    const results = await Promise.all([
      serviceA.addMember(scopeA, principal("one"), "viewer"),
      serviceB.addMember(scopeB, principal("two"), "viewer"),
    ]);
    assert.equal(results.filter((result) => result.status === "updated").length, 1);
    assert.equal(results.filter((result) => result.status === "stale").length, 1);
  });
});

class MemoryWorkspaceRepository implements WorkspaceRepository {
  readonly states = new Map<string, WorkspaceAuthorityState>();

  async loadAuthorityState(
    workspaceKey: string,
  ): Promise<WorkspaceAuthorityState | null> {
    const state = this.states.get(workspaceKey);
    return state ? structuredClone(state) : null;
  }

  async saveAuthorityState(
    state: WorkspaceAuthorityState,
    expectedAclEpoch: number | null,
  ): Promise<"saved" | "conflict"> {
    const current = this.states.get(state.workspace.workspaceKey);
    if (
      (expectedAclEpoch === null && current) ||
      (expectedAclEpoch !== null &&
        (!current || current.workspace.aclEpoch !== expectedAclEpoch))
    ) {
      return "conflict";
    }
    this.states.set(state.workspace.workspaceKey, structuredClone(state));
    return "saved";
  }
}

function createService(): {
  repository: MemoryWorkspaceRepository;
  service: WorkspaceAuthorityService;
} {
  const repository = new MemoryWorkspaceRepository();
  let sequence = 0;
  return {
    repository,
    service: new WorkspaceAuthorityService(
      repository,
      () => NOW,
      () => `id:${sequence += 1}`,
    ),
  };
}

function principal(id: string) {
  return workspacePrincipal(SECRET, "telegram", id);
}
