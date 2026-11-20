# Life Diff receipt schema 1.1.0

A receipt is the JSON document written by `lifediff diff`. It is the normalized list of what changed between a snapshot and a later read of each provider, plus an optional check of what an agent claimed.

`schemaVersion` is `1.1.0`. Version 1.1.0 adds `providers`, one section per service that was compared. `calendar` and `drive` are still present for those two services. Patch and minor versions may add fields. Readers must ignore fields they do not know. A snapshot or receipt with `schemaVersion` `1.0.0` still loads. A different major version is not this document.

The sample file [`sample-receipt.json`](sample-receipt.json) is a full document produced from fixture data. The HTML form of that same receipt is [`sample-report.html`](sample-report.html).

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | `1.1.0` for this document. |
| `id` | string | Receipt id, for example `rcpt_sample`. |
| `generatedAt` | string | RFC3339 time the receipt was built. |
| `readOnly` | bool | Always `true`. Life Diff did not write to the connected accounts. |
| `producer` | object | `name` and `version` of the program that wrote the file. |
| `snapshot` | object | `id` and `takenAt` of the before-image. |
| `comparedAt` | string | RFC3339 time of the later read. Same instant as `generatedAt` for a receipt written by `diff`. |
| `timeZone` | string | IANA zone used to render times in `summary` and in the HTML report. Instants in this file stay in UTC. |
| `session` | object | `startedAt` (snapshot) and `checkedAt` (this comparison). Confidence uses this window. |
| `providers` | array | One object per service that was compared, in provider order. See below. Added in 1.1.0. |
| `calendar` | object | Present when Calendar was compared. See below. |
| `drive` | object | Present when Drive was compared. See below. |
| `counts` | object | `added`, `removed`, `modified`, `verifiedClaims`, `missingClaims`, `unclaimedChanges`. |
| `changes` | array | One object per added, removed, or modified resource. Empty array when nothing changed. |
| `claimsChecked` | bool | `true` when the caller supplied a claims list, including an empty list. |
| `claims` | array | One result per claim. Empty when no claims were supplied. |
| `notes` | array | Short statements about how to read the receipt. |
| `warnings` | array | Present when a comparison was partial, for example a sync token expired. |

`counts.verifiedClaims`, `counts.missingClaims`, and `counts.unclaimedChanges` are meaningful when `claimsChecked` is `true`. They are `0` otherwise.

### `providers`

| Field | Meaning |
| --- | --- |
| `id` | Provider id, such as `calendar`, `drive`, or `gmail`. |
| `displayName` | Word shown in the report, such as `Calendar`. |
| `diffMode` | How that provider compared, when it has one. Calendar uses `sync` or `window`. Drive uses `changes` or `list`. Gmail uses `history` or `list`. |
| `intro` | One sentence the report prints under the service name. |

A new provider adds an object here. It does not add a new top-level field.

### `calendar`

| Field | Meaning |
| --- | --- |
| `calendarId` | Calendar that was read. `primary` is the user's main calendar. |
| `windowStart`, `windowEnd` | The snapshot window. |
| `diffMode` | `sync` when the Calendar sync token was used, or `window` when the same window was read again. |

### `drive`

| Field | Meaning |
| --- | --- |
| `query` | Drive files query stored with the snapshot. The default is `trashed = false`. |
| `diffMode` | `changes` when the Drive Changes API was used, or `list` when files were listed again. |
| `truncatedSnapshot` | The snapshot stored only part of the file list. |
| `truncatedChanges` | The changes feed was cut off. |
| `suppressedRemovals` | Removals were not inferred from a cut-off file list, so a missing file is not reported as removed. |

## Change

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable id derived from the service, resource id, and kind. |
| `service` | string | Provider id. Built-in ids are `calendar`, `drive`, and `gmail`. Any other provider id is allowed. |
| `kind` | string | `added`, `removed`, or `modified`. |
| `resourceId` | string | Google event id or file id. |
| `resourceName` | string | Title or file name shown to a person. |
| `summary` | string | Plain-language sentence, for example `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM.` |
| `fields` | array | Field-level before/after values. May be empty for a removal whose only fact is the sentence. |
| `occurredAt` | string | RFC3339 time Google gave for the change, omitted when Google did not give one. |
| `confidence` | string | `high`, `medium`, or `low`. |
| `confidenceReason` | string | Why that level was chosen. |
| `claimStatus` | string | Omitted when claims were not checked. Otherwise `verified` or `unclaimed`. |
| `link` | string | HTTPS link to the event or file when Google provided one. |

### Field

| Field | Meaning |
| --- | --- |
| `field` | Stable key: `title`, `start`, `end`, `location`, `notes`, `guests`, `status`, `name`, `folder`, `trashed`, `content`, `type`, or `details`. |
| `label` | Short label for the report, such as `Starts` or `Contents`. |
| `before` | Value in the snapshot. Empty for an addition. |
| `after` | Value at check time. Empty for a removal. |

`content` is Drive metadata (version, save time, checksum, size). It is not the file body. A content edit of a Google Doc is visible because the version changed, not because the words were compared.

## Claim result

| Field | Meaning |
| --- | --- |
| `id` | Caller-supplied id, or `claim-1`, `claim-2`, ... |
| `service` | The provider id the claim named, when it named one. |
| `action` | Normalized `added`, `removed`, or `modified` when the claim named one. |
| `target` | The name or id the agent gave. |
| `detail` | Optional text from the agent. |
| `status` | `verified` or `missing`. |
| `confidence` | Present on a verified claim. Copied from the matched change. |
| `matchedChangeIds` | The change id that satisfied the claim. One claim matches at most one change. |
| `reason` | Plain-language explanation. |

A change that no claim matched has `claimStatus` `unclaimed`. That is the third verdict. It lives on the change, not as a synthetic claim.

### Matching

A claim matches a change only when:

- the service matches, if the claim named one
- the action matches the change kind, if the claim named one (`move` and `rename` are `modified`; `create` is `added`; `delete` and `trash` are `removed`)
- the target equals the resource id, or equals the name ignoring case, or is a whole phrase inside the name (at least 3 characters)

The highest score wins. Each change is used for at most one claim.

### Confidence

Compare `occurredAt` with the session window:

- **high**: the time falls in the window, allowing two minutes of clock skew
- **medium**: the time is within 15 minutes before the snapshot, the time is missing, or the time is after the check by more than the skew
- **low**: the service dates the change earlier than that

Low confidence still means the before and after values differ. It means the edit may be older than this agent session.

## What this schema does not contain

- OAuth tokens, client secrets, or authorization codes
- Gmail message bodies. A Gmail change may include the subject, recipients, labels, and snippet.
- A promise that an unclaimed change was made by a particular agent. The receipt shows what the connected services report, and how the timing relates to the session.

Full-mode Drive changes may include a `text` field: the exported text of a Doc, Sheet, or Slides file, or the contents of a plain text file. That text is also stored in the local snapshot (`texts` on the Drive provider state), which is written with mode `0600`. Binary files are not stored.
