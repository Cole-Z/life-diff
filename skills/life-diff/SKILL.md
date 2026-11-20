---
name: life-diff
description: Verify what an agent changed in Google Calendar and Google Drive by snapshotting before the work and diffing after. Use when a task may create, edit, move, or delete calendar events or Drive files, or when the user wants proof of what an agent actually changed.
---

# Life Diff

Life Diff reads Google Calendar and Google Drive itself and compares them with a snapshot taken before the work. The receipt is the record. An agent's own message that the work is done is a claim, not proof.

This skill runs the local `lifediff` binary (or the `lifediff` MCP server) on the user's computer. Tokens stay in `~/.lifediff` and must not be printed, copied into chat, or committed.

## When to use it

Use it before any task that might change the user's calendar or Drive files, and again after that task. Also use it when the user asks what an agent changed.

## Steps

1. Confirm the user has already run `lifediff auth` on this computer. If snapshot fails because they are not signed in, stop and ask them to run `lifediff auth`. Do not ask them to paste a token.
2. Run `lifediff snapshot` (or the MCP tool `snapshot`) and wait until it finishes. Note the snapshot id.
3. Do the task.
4. Write a claims file for what you believe you changed, then run:

   ```bash
   lifediff diff --claims claims.json
   ```

   Or call the MCP tool `diff` with the same claims. `get_receipt` reads a receipt that `diff` already saved.

5. Show the user the plain-language lines from the receipt, and tell them where the HTML report was written. Say which claims are verified, which are missing, and which changes the agent did not claim.
6. If a claim is missing, say that Google does not show that change. Do not describe the task as finished when the receipt disagrees.

## Claims file

```json
{
  "claims": [
    {
      "service": "calendar",
      "action": "modified",
      "target": "Dentist",
      "detail": "Moved to Wednesday at 10:00 AM"
    },
    {
      "service": "drive",
      "action": "created",
      "target": "Q2 goals"
    }
  ]
}
```

`service` is `calendar` or `drive`. `action` is `added`, `removed`, or `modified` (`moved` and `renamed` count as modified). `target` is the event title, file name, or resource id.

## How to read the result

- **Verified**: a matching change is in Google's data.
- **Missing**: the claim has no matching change.
- **Not claimed**: Google shows a change the agent did not list.
- **High confidence**: Google dates the change between the snapshot and the check.
- **Low confidence**: Google dates it before the snapshot, so it may be older than this session.

Drive content edits show up as a new version. Life Diff does not download file bodies, so it cannot quote the old and new text.

## Rules

- Read only. Do not ask Life Diff to create, edit, delete, or undo anything in Google.
- Snapshot once, before the work. Diff after. A second snapshot in the middle replaces the before-image.
- Never print credentials, access tokens, or refresh tokens.
