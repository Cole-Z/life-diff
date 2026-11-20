# Writing a Life Diff provider

A provider is one service Life Diff can snapshot and compare. Calendar and Drive are the first providers. Gmail metadata is the third, and it is registered only after `lifediff auth --access full`. Slack, Notion, Linear, GitHub, Microsoft 365, and anything else are the same kind of addition: a type that implements `lifediff.Provider`, registered on `Engine.Providers`.

The engine, receipt assembly, claim matching, and HTML report do not name those future services. They call the interface and render whatever `ProviderOutput` comes back.

## Interface

```go
type Provider interface {
    ID() string
    DisplayName() string
    Snapshot(ctx context.Context, req SnapshotRequest) (ServiceState, error)
    ReadCurrent(ctx context.Context, before ServiceState) (ServiceState, error)
    BuildChanges(before, current ServiceState, cc CompareContext) (ProviderOutput, error)
}
```

`Snapshot` reads the current state and returns a `ServiceState`. `Payload` is JSON the provider owns. The core stores it and does not interpret it. Put cursors (sync tokens, history ids, page tokens) in `Cursor` as well as inside the payload, so a person can see that a cursor was saved without reading the payload.

`ReadCurrent` reads the service again. Use the cursor from `before` when the service has an incremental feed. If the cursor is expired, read the same window or list again, set `Mode` to the fallback, and add a warning that says so. Do not fail the whole receipt for an expired cursor when a full read is possible.

`BuildChanges` turns the two payloads into `Change` values. Use `lifediff.ChangeID` for `Change.ID`. Set `Service` to the provider id. The core fills `Confidence` from `OccurredAt` and the session window, sorts the changes, and checks claims. Leave confidence blank.

`ProviderOutput.Info` is the receipt section. `Intro` is the one sentence under the service name in the HTML report. `Notes` are extra sentences appended after the standard receipt notes. `Warnings` are partial-read messages.

An optional later write path is `UndoProvider`:

```go
type UndoProvider interface {
    Provider
    Undo(ctx context.Context, change Change, before ServiceState) error
}
```

The read-only core never calls `Undo`. Implementing it does not turn Life Diff into a writer. Do not call it from `Snapshot`, `ReadCurrent`, or `BuildChanges`.

## Register it

Construct the providers in the program that has the credentials. The core does not import them.

```go
eng := &lifediff.Engine{
    Providers: []lifediff.Provider{
        calendarProvider,
        driveProvider,
        NewSlack(client),
    },
    Now:      time.Now,
    Location: time.Local,
}
snap, err := eng.TakeSnapshot(ctx, lifediff.SnapshotOptions{Extras: true, Calendar: true, Drive: true})
```

`Extras: true` selects every registered provider that is not Calendar or Drive. `Only: []string{"slack"}` selects one. The CLI flag is `--only slack` or `--only calendar,slack`.

A provider id is a lowercase token: a letter, then letters, digits, `_`, or `-`, at most 40 characters. Claims can name that id directly (`"service": "slack"`). Well-known aliases (`gcal`, `gmail`, `google mail`) are accepted for the built-in services. A new service does not need an alias.

## What a provider must not do

- Do not create, edit, delete, or send anything in the account. Life Diff is read-only.
- Do not put tokens or client secrets in the snapshot, the receipt, or a log line.
- Minimal mode does not download file text. Full mode may export Google Docs, Sheets, and Slides as text and download plain text files, then store that text only in the local snapshot (mode `0600`). Do not download binaries, and do not upload or edit files.
- Return a clear error when the user is not signed in for this service. The CLI already says to run `lifediff auth`.
- Keep tests on fake HTTP or in-memory readers. A provider test must not call the real service.

## Shape of a change

```go
lifediff.Change{
    ID:           lifediff.ChangeID("slack", "C123", lifediff.KindAdded),
    Service:      "slack",
    Kind:         lifediff.KindAdded, // added, removed, or modified
    ResourceID:   "C123",
    ResourceName: "standup",
    Summary:      `Posted "standup" in #engineering.`,
    Fields: []lifediff.FieldChange{{
        Field: "text", Label: "Text", Before: "", After: "Shipped the receipt.",
    }},
    OccurredAt: &when,
    Link:       "https://example.slack.com/archives/C123",
}
```

`Summary` is the sentence a person reads. `Fields` are the before and after values. `OccurredAt` is the time the service itself gives. High confidence means that time falls inside the session, with two minutes of clock skew. If the service has no time, leave `OccurredAt` nil and the receipt says the confidence is medium.

`Link` must be `https`. The report drops anything else.

## Where the Google providers live

Calendar and Drive readers are `CalendarReader` and `DriveReader` in this module. `NewCalendarProvider` and `NewDriveProvider` adapt them. Their diff code stays next to the normalized Calendar and Drive types because the receipt sentences for those two services are already here. The Calendar adapter has `UseLocation` so all-day events use the report's time zone. A new provider does not need that method.

Gmail is `googleprov.Gmail`. It implements `Provider` itself and does not add a type to the core. That is the pattern for the next service: one package, one constructor, a fake server in the test.

`googleprov.Providers(httpClient, access)` returns the set for a saved access level. `minimal` is Calendar plus Drive metadata. `full` also enables Drive Activity, revision metadata, and text export on the Drive provider, and appends Gmail. See the README for the scope names and why a personal OAuth client in Testing does not go through Google verification.

Drive full read calls `revisions.list`, the Drive Activity query, `files.export` for Docs, Sheets, and Slides, and `alt=media` for plain text files. Gmail calls `users.messages.get` with `format=metadata` (subject, recipients, labels, snippet) and does not request `format=full` or `format=raw`.

## Snapshot file

A snapshot stores `providers[]`, one `ServiceState` per service, plus the older `calendar` and `drive` objects when those services ran. A 1.0.0 snapshot without `providers` still compares: the engine rebuilds provider state from the Calendar and Drive objects. A new provider's payload is only in `providers[]`.
