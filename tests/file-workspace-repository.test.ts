import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkspaceAuthorityState } from "../src/domain/workspace.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";

describe("file workspace repository", () => {
  it("menyimpan authority state atomik dan terpisah per workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-workspace-"));
    const file = join(root, "workspaces.json");
    const repository = new FileWorkspaceRepository(file);
    await repository.saveAuthorityState(state("ws-a", "member-a"), null);
    await repository.saveAuthorityState(state("ws-b", "member-b"), null);

    assert.equal(
      (await repository.loadAuthorityState("ws-a"))?.memberships[0]
        ?.membershipId,
      "member-a",
    );
    assert.equal(
      (await repository.loadAuthorityState("ws-b"))?.memberships[0]
        ?.membershipId,
      "member-b",
    );
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      workspaces: unknown[];
      memberships: unknown[];
    };
    assert.equal(stored.version, 1);
    assert.equal(stored.workspaces.length, 2);
    assert.equal(stored.memberships.length, 2);
  });

  it("menolak membership dari scope lain dan principal aktif duplikat", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-workspace-"));
    const repository = new FileWorkspaceRepository(join(root, "workspaces.json"));
    const wrongScope = state("ws-a", "member-a");
    wrongScope.memberships[0]!.workspaceKey = "ws-b";
    await assert.rejects(
      repository.saveAuthorityState(wrongScope, null),
      /scope membership workspace tidak cocok/iu,
    );

    const duplicate = state("ws-a", "member-a");
    duplicate.memberships.push({
      ...duplicate.memberships[0]!,
      membershipId: "member-b",
    });
    await assert.rejects(
      repository.saveAuthorityState(duplicate, null),
      /principal aktif workspace duplikat/iu,
    );
  });

  it("menegakkan compare-and-swap pada aclEpoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-workspace-"));
    const repository = new FileWorkspaceRepository(join(root, "workspaces.json"));
    const initial = state("ws-cas", "owner");
    assert.equal(await repository.saveAuthorityState(initial, null), "saved");
    const next = structuredClone(initial);
    next.workspace.aclEpoch = 2;
    assert.equal(await repository.saveAuthorityState(next, 1), "saved");
    const stale = structuredClone(initial);
    stale.workspace.aclEpoch = 2;
    assert.equal(await repository.saveAuthorityState(stale, 1), "conflict");
    assert.equal(
      (await repository.loadAuthorityState("ws-cas"))?.workspace.aclEpoch,
      2,
    );
  });
});

function state(
  workspaceKey: string,
  membershipId: string,
): WorkspaceAuthorityState {
  const at = "2026-08-02T00:00:00.000Z";
  return {
    workspace: {
      workspaceKey,
      displayName: workspaceKey,
      aclEpoch: 1,
      createdAt: at,
      updatedAt: at,
      disabledAt: null,
    },
    memberships: [
      {
        workspaceKey,
        membershipId,
        channel: "telegram",
        principalKey: `principal-${membershipId}`,
        role: "owner",
        joinedAt: at,
        updatedAt: at,
        revokedAt: null,
      },
    ],
  };
}
