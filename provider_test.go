package lifediff

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// staticProvider is a stand-in for a future service such as Slack.
// It lives in the test, not in the engine, to show that a new provider
// does not require a core change.
type staticProvider struct {
	value string
}

func (p *staticProvider) ID() string          { return "slack" }
func (p *staticProvider) DisplayName() string { return "Slack" }

func (p *staticProvider) Snapshot(ctx context.Context, req SnapshotRequest) (ServiceState, error) {
	if err := ctx.Err(); err != nil {
		return ServiceState{}, err
	}
	payload, err := json.Marshal(map[string]string{"text": p.value})
	if err != nil {
		return ServiceState{}, err
	}
	return ServiceState{
		ID: p.ID(), DisplayName: p.DisplayName(), Checked: true,
		TakenAt: req.Now, ItemCount: 1, Payload: payload,
	}, nil
}

func (p *staticProvider) ReadCurrent(ctx context.Context, before ServiceState) (ServiceState, error) {
	if err := ctx.Err(); err != nil {
		return ServiceState{}, err
	}
	payload, err := json.Marshal(map[string]string{"text": "after"})
	if err != nil {
		return ServiceState{}, err
	}
	return ServiceState{ID: p.ID(), DisplayName: p.DisplayName(), Checked: true, Payload: payload}, nil
}

func (p *staticProvider) BuildChanges(before, current ServiceState, cc CompareContext) (ProviderOutput, error) {
	var prior, next map[string]string
	if err := json.Unmarshal(before.Payload, &prior); err != nil {
		return ProviderOutput{}, err
	}
	if err := json.Unmarshal(current.Payload, &next); err != nil {
		return ProviderOutput{}, err
	}
	if prior["text"] == next["text"] {
		return ProviderOutput{Info: ProviderInfo{ID: p.ID(), DisplayName: p.DisplayName(), Intro: "Slack messages."}}, nil
	}
	when := cc.Session.CheckedAt
	return ProviderOutput{
		Info: ProviderInfo{ID: p.ID(), DisplayName: p.DisplayName(), Intro: "Slack messages."},
		Changes: []Change{{
			ID:           ChangeID(Service(p.ID()), "msg1", KindModified),
			Service:      Service(p.ID()),
			Kind:         KindModified,
			ResourceID:   "msg1",
			ResourceName: "standup",
			Summary:      `Edited Slack message "standup".`,
			Fields:       []FieldChange{{Field: "text", Label: "Text", Before: prior["text"], After: next["text"]}},
			OccurredAt:   &when,
		}},
	}, nil
}

func TestCustomProviderNeedsNoCoreChange(t *testing.T) {
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	p := &staticProvider{value: "before"}
	eng := &Engine{
		Providers: []Provider{p},
		Location:  time.UTC,
		Now:       func() time.Time { return now },
	}
	snap, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{Only: []string{"slack"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Providers) != 1 || snap.Providers[0].ID != "slack" || snap.Calendar.Checked || snap.Drive.Checked {
		t.Fatalf("%+v", snap.Providers)
	}
	receipt, err := eng.Compare(context.Background(), snap, CompareOptions{
		CheckClaims: true,
		Claims:      []ClaimInput{{Service: "slack", Action: "modified", Target: "standup"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(receipt.Changes) != 1 || receipt.Changes[0].Service != "slack" {
		t.Fatalf("%#v", receipt.Changes)
	}
	if receipt.Counts.VerifiedClaims != 1 {
		t.Fatalf("claims %+v", receipt.Claims)
	}
	if !strings.Contains(receipt.PlainSummary(), "Slack") {
		t.Fatal(receipt.PlainSummary())
	}
	html, err := RenderHTML(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(html), "Slack") || strings.Contains(string(html), "<script") {
		t.Fatal("report did not include the provider section")
	}
}

type signalDrive struct {
	fakeDrive
	revs []DriveRevision
	acts []DriveActivity
}

func (s *signalDrive) Revisions(context.Context, string) ([]DriveRevision, error) {
	return s.revs, nil
}

func (s *signalDrive) ActivitySince(context.Context, time.Time) ([]DriveActivity, error) {
	return s.acts, nil
}

type textDrive struct {
	fakeDrive
	texts map[string]string
}

func (t *textDrive) FileText(_ context.Context, file DriveFile) (DriveText, error) {
	body, ok := t.texts[file.ID]
	if !ok {
		return DriveText{Unavailable: "missing"}, nil
	}
	return DriveText{Text: body, Kind: DriveTextKind(file.MimeType)}, nil
}

func TestFullDriveTextDiffQuotesTheEdit(t *testing.T) {
	when := time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)
	file := DriveFile{ID: "doc", Name: "Q2 goals", MimeType: "application/vnd.google-apps.document", Version: 1}
	next := file
	next.Version = 2
	next.ModifiedTime = when
	texts := map[string]string{"doc": "Ship in April\n"}
	drive := &textDrive{
		fakeDrive: fakeDrive{
			token: "page",
			files: DriveFileList{Files: []DriveFile{file}},
			changes: DriveChangeList{Changes: []DriveChange{{
				FileID: file.ID, Time: when, File: &next,
			}}},
		},
		texts: texts,
	}
	provider := NewDriveProvider(drive)
	EnableDriveContentSignals(provider)
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	eng := &Engine{
		Providers: []Provider{provider},
		Location:  time.UTC,
		Now:       func() time.Time { return now },
	}
	snap, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{Only: []string{"drive"}})
	if err != nil {
		t.Fatal(err)
	}
	texts["doc"] = "Ship in May\n"
	receipt, err := eng.Compare(context.Background(), snap, CompareOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ch, ok := findChange(receipt, "doc")
	if !ok || !strings.Contains(ch.Summary, `removed "Ship in April" and added "Ship in May"`) {
		t.Fatal(receipt.PlainSummary())
	}
	var saw bool
	for _, f := range ch.Fields {
		if f.Field == "text" && f.Before == "Ship in April" && f.After == "Ship in May" {
			saw = true
		}
	}
	if !saw {
		t.Fatalf("%#v", ch.Fields)
	}
}

func TestFullDriveSignalsAnnotateChanges(t *testing.T) {
	when := time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)
	file := DriveFile{ID: "file_notes", Name: "Notes", MimeType: "text/plain", Version: 1}
	renamed := file
	renamed.Name = "Notes final"
	renamed.Version = 2
	renamed.ModifiedTime = when
	drive := &signalDrive{
		fakeDrive: fakeDrive{
			token: "page",
			files: DriveFileList{Files: []DriveFile{file}},
			changes: DriveChangeList{Changes: []DriveChange{{
				FileID: file.ID, Time: when, File: &renamed,
			}}},
		},
		revs: []DriveRevision{{ID: "9", ModifiedTime: when}},
		acts: []DriveActivity{{FileID: file.ID, Time: when, Action: "rename", Title: "Notes final"}},
	}
	provider := NewDriveProvider(drive)
	EnableDriveContentSignals(provider)
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	eng := &Engine{
		Providers: []Provider{provider},
		Location:  time.UTC,
		Now:       func() time.Time { return now },
	}
	snap, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{Only: []string{"drive"}})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := eng.Compare(context.Background(), snap, CompareOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ch, ok := findChange(receipt, "file_notes")
	if !ok {
		t.Fatal(receipt.PlainSummary())
	}
	if ch.OccurredAt == nil || !ch.OccurredAt.Equal(when) {
		t.Fatalf("occurred %#v", ch.OccurredAt)
	}
	var sawActivity, sawRevision bool
	for _, f := range ch.Fields {
		if f.Field == "activity" && f.After == "Renamed" {
			sawActivity = true
		}
		if f.Field == "revision" && strings.Contains(f.After, "revision 9") {
			sawRevision = true
		}
	}
	if !sawActivity || !sawRevision {
		t.Fatalf("%#v", ch.Fields)
	}
}
