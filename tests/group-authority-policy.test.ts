import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DENY_GROUP_AUTHORITY_RESOLVER,
  groupAuthorityAllows,
  type GroupAuthorityAction,
  type GroupRole,
} from "../src/core/group-authority-policy.js";

describe("group authority policy", () => {
  it("menerapkan matriks deny-by-default per role", () => {
    const expected: Readonly<Record<GroupRole, readonly GroupAuthorityAction[]>> = {
      member: [
        "social.read",
        "room.read",
        "member.self.manage",
        "room.propose",
      ],
      admin: [
        "social.read",
        "room.read",
        "member.self.manage",
        "room.propose",
        "room.confirm",
        "room.delete",
        "social.reset",
        "alias.manage",
      ],
      system: ["scope.disable"],
    };
    const actions: GroupAuthorityAction[] = [
      "social.read",
      "room.read",
      "member.self.manage",
      "room.propose",
      "room.confirm",
      "room.delete",
      "social.reset",
      "alias.manage",
      "scope.disable",
    ];

    for (const role of ["member", "admin", "system"] as const) {
      for (const action of actions) {
        assert.equal(
          groupAuthorityAllows(role, action),
          expected[role].includes(action),
          `${role} → ${action}`,
        );
      }
    }
  });

  it("menolak authority bila resolver runtime lupa dipasang", async () => {
    const result = await DENY_GROUP_AUTHORITY_RESOLVER.resolveGroupAuthority({
      scope: { channel: "whatsapp", groupId: "g" },
      accountId: "a",
      participantIds: ["p"],
      claimedAdmin: true,
      claimedAuthorityEpoch: 99,
    });
    assert.equal(result, null);
  });
});
