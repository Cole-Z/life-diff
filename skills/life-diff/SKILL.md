---
name: life-diff
description: Verify what an agent changed in the user's accounts by snapshotting before the work and diffing after. Use when a task may create, edit, move, or delete Google Calendar events, Drive files, or Gmail messages, or when the user wants proof of what an agent actually changed. Present the Life Diff receipt, not the agent's own "done".
---

# Life Diff

Life Diff writes one receipt of the tool calls it forwarded, and, where a service exposes history, a check against that history. An agent's message that the work is done is a claim, not proof.

The hosted server is `https://lifediff.dev/mcp`. Register other MCP servers with `add_upstream` (name, https URL, optional token) or at `https://lifediff.dev/settings`. Their tools appear as `<name>__<tool>`. Reconnect after adding one if the tool list is stale. Call `end_session` or `get_receipt` and show the returned markdown to the user verbatim. Call `get_roundup` when the user asks, at the end of a long session, or when you are close to a usage or context limit. Do not post a roundup after every change. Life Diff does not run the Undo lines. Lines from forwarded tools say reported by proxy. GitHub lines say verified from service history. Call `start_session` before the work when that GitHub check should be in the same receipt.

The self-run command still reads the user's Google accounts itself and compares them with a snapshot. That path is below.

The default sign-in reads Google Calendar and Drive file metadata. `lifediff auth --access full` also reads Drive activity, Drive revision metadata, the text of Docs, Sheets, Slides, and plain files, and Gmail subject, recipients, labels, and snippet. It still cannot create, edit, delete, or send anything. Message bodies are not requested. Snapshots stay in `~/.lifediff` with mode `0600`.

Tokens stay in `~/.lifediff` and must not be printed, copied into chat, or committed.

## When to use it

Use it before any task that might change the user's calendar, Drive files, or (with full access) Gmail, and again after that task. Also use it when the user asks what an agent changed.

Do not use it as a reason to request write access. If a task needs a change, the other tool makes the change. Life Diff only checks.

## Install

The user needs the `lifediff` binary and this skill. They do not need Go.

```bash
curl -fsSL https://raw.githubusercontent.com/Cole-Z/life-diff/main/install.sh | sh
```

That installs the binary to `~/.local/bin/lifediff` and this skill to `~/.cursor/skills/life-diff/SKILL.md`. `~/.local/bin` must be on `PATH`.

They also need their own Google desktop OAuth client, saved at `~/.lifediff/credentials.json` (mode `0600`). The app stays in Testing, and their account is a test user. That is why Google does not ask for verification. The steps are in the Life Diff README.

Then they sign in once, in a terminal they control:

```bash
lifediff auth
```

Full read-only access, including Gmail metadata:

```bash
lifediff auth --access full
```

If a later command says they are not signed in, stop and ask them to run `lifediff auth`. Do not ask them to paste a token, a client secret, or an authorization code.

## Snapshot, then the work, then diff

1. Run `lifediff snapshot` (or the MCP tool `snapshot`) and wait until it finishes. Note the snapshot id. A snapshot in the middle of the work replaces the before-image, so do this first.
2. Do the task with whatever tools the user already trusts.
3. Write a claims file for what you believe you changed. Then run:

   ```bash
   lifediff diff --claims claims.json
   ```

   Or call the MCP tool `diff` with the same claims. `get_receipt` reads a receipt that `diff` already saved.

`--only calendar` or `--only calendar,drive,gmail` limits the snapshot. The default is every provider the sign-in includes.

## How to present the receipt

Show the user the result in this order:

1. The count line: how many items were added, removed, and modified.
2. Each plain-language sentence from the receipt, including the service name. Example: `Modified (Calendar): Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM.`
3. The claim verdicts: which claims are **verified**, which are **missing**, and which changes are **not claimed**.
4. The path to the HTML report. Tell them they can open that file. Do not paste the whole JSON unless they ask.

Say what the confidence means when it matters. **High** means the service dates the change between the snapshot and the check. **Low** means the service dates it earlier, so it may be older than this session.

If a claim is missing, say that the service does not show that change. Do not describe the task as finished when the receipt disagrees. Quote the missing line.

If nothing changed, say that. An empty receipt is a result.

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
    },
    {
      "service": "gmail",
      "action": "added",
      "target": "Hello"
    }
  ]
}
```

`service` is a provider id: `calendar`, `drive`, `gmail`, or a later provider. `action` is `added`, `removed`, or `modified` (`moved` and `renamed` count as modified; `created` counts as added). `target` is the event title, file name, message subject, or resource id.

## How to read a row

- **Verified**: a matching change is in the service's data.
- **Missing**: the claim has no matching change.
- **Not claimed**: the service shows a change the agent did not list.
- **High confidence**: the service dates the change between the snapshot and the check.
- **Low confidence**: the service dates it before the snapshot, so it may be older than this session.

With full access, a Drive edit quotes the lines that changed. Without it, a content edit shows up as a new version and the words are not shown. Gmail rows use the subject, recipients, labels, and snippet, not the message body.

## Rules

- Read only. Do not ask Life Diff to create, edit, delete, send, or undo anything.
- Snapshot once, before the work. Diff after.
- Never print credentials, access tokens, or refresh tokens.
- Never commit `~/.lifediff`.
