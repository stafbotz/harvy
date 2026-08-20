# WhatsApp live acceptance

`npm run acceptance:whatsapp` is a live, mutating staging probe. It uses a
separately paired tester account to exercise a running Harvy account in a
non-critical WhatsApp group. It is not a fake Baileys socket test and it never
pairs, logs out, prints a QR, or prints a phone/JID/message/auth path.

## Preconditions

- Harvy is already running with `WHATSAPP_ENABLED=true` and
  `WHATSAPP_GROUP_AGENT_RUN_ENABLED=true`.
- The tester linked-device auth folder exists outside Git and is already
  paired. The tester is a current admin of the disposable group.
- The Harvy account is a current member of the same group.
- The group has no real users or important history. The probe removes and
  re-adds Harvy once and sends an explicit synthetic safety phrase.
- The operator has authority to mutate membership in this test group.

Run only with the exact acknowledgement:

```bash
HARVY_WHATSAPP_ACCEPTANCE_CONFIRM=RUN_NONCRITICAL_WHATSAPP_GROUP \
HARVY_WHATSAPP_ACCEPTANCE_TESTER_AUTH_FOLDER=/run/harvy-wa-acceptance/tester-auth \
HARVY_WHATSAPP_ACCEPTANCE_GROUP_JID='<numeric-test-group>@g.us' \
HARVY_WHATSAPP_ACCEPTANCE_HARVY_JID='<harvy-number>@s.whatsapp.net' \
HARVY_WHATSAPP_ACCEPTANCE_RUN_LABEL=20260815-a1 \
npm run acceptance:whatsapp
```

`HARVY_WHATSAPP_ACCEPTANCE_STAGE_TIMEOUT_MS` may be set from 5,000 through
180,000 ms. Never put these live identifiers or the auth folder in `.env`, a
committed shell script, docs, issue text, or logs.

## What the probe proves

The live socket verifies current tester admin authority and current Harvy
membership before effects. It then records digest-only evidence for:

- Harvy removal, disabled ingress, and no reply while removed;
- re-add, live membership, notice-before-work, and cleanup gate;
- exact GroupAgentRun start grammar and a real anchor;
- ambient chatter not acknowledged as run input;
- quote-targeted correction;
- duplicate stanza replay producing one acknowledgement;
- quote-targeted status;
- emergency text going to the safety lane rather than the run mailbox;
- admin cancellation and a terminal response.

If the probe fails after removing Harvy, it attempts to restore the original
membership before closing the tester socket. An operator must still inspect the
group after any interrupted run.

## Deliberately not claimed

One tester socket cannot honestly prove second-participant self-info,
proposal/assigned-question behavior, a narrow `WAITING_INPUT` answer, or an
actual Harvy process crash/reconnect between socket send and receipt commit. It
also cannot create a Workspace-private group-coding publish offer without a
separately provisioned test Workspace.

For that reason the current command emits `passed_partial_live_scope` and exits
non-success even when every automated live stage passes. Full WhatsApp
acceptance remains blocked until the remaining human/fault-injection matrix is
run and its evidence is reviewed; do not translate this partial receipt into
“WhatsApp production-ready.”
