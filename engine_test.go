package lifediff

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeCalendar struct {
	window    []CalendarEvent
	token     string
	tokenErr  error
	changes   []CalendarEvent
	syncErr   error
	windowErr error
}

func (f *fakeCalendar) ListWindow(context.Context, string, time.Time, time.Time) ([]CalendarEvent, error) {
	if f.windowErr != nil {
		return nil, f.windowErr
	}
	return f.window, nil
}

func (f *fakeCalendar) CurrentSyncToken(context.Context, string) (string, error) {
	if f.tokenErr != nil {
		return "", f.tokenErr
	}
	return f.token, nil
}

func (f *fakeCalendar) ListSyncChanges(context.Context, string, string) ([]CalendarEvent, error) {
	if f.syncErr != nil {
		return nil, f.syncErr
	}
	return f.changes, nil
}

type fakeDrive struct {
	token     string
	tokenErr  error
	files     DriveFileList
	filesErr  error
	changes   DriveChangeList
	changeErr error
}

func (f *fakeDrive) StartPageToken(context.Context) (string, error) {
	if f.tokenErr != nil {
		return "", f.tokenErr
	}
	return f.token, nil
}

func (f *fakeDrive) ListFiles(context.Context, string, int) (DriveFileList, error) {
	if f.filesErr != nil {
		return DriveFileList{}, f.filesErr
	}
	return f.files, nil
}

func (f *fakeDrive) ListChanges(context.Context, string) (DriveChangeList, error) {
	if f.changeErr != nil {
		return DriveChangeList{}, f.changeErr
	}
	return f.changes, nil
}

func TestEngineSnapshotAndCompare(t *testing.T) {
	start := time.Date(2026, 4, 7, 19, 0, 0, 0, time.UTC) // 3:00 PM EDT
	beforeEv := CalendarEvent{
		ID: "evt_dentist", Summary: "Dentist", Location: "Office", Status: "confirmed",
		Start: EventTime{DateTime: start}, End: EventTime{DateTime: start.Add(time.Hour)},
	}
	afterEv := beforeEv
	afterEv.Start.DateTime = time.Date(2026, 4, 8, 14, 0, 0, 0, time.UTC) // 10:00 AM EDT
	afterEv.End.DateTime = afterEv.Start.DateTime.Add(time.Hour)
	afterEv.Location = "Clinic"
	afterEv.Updated = time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)

	cal := &fakeCalendar{window: []CalendarEvent{beforeEv}, token: "tok", changes: []CalendarEvent{afterEv}}
	file := DriveFile{ID: "file_notes", Name: "Notes", MimeType: "text/plain", Version: 1, ModifiedTime: time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)}
	renamed := file
	renamed.Name = "Notes final"
	renamed.ModifiedTime = time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)
	drive := &fakeDrive{
		token: "page",
		files: DriveFileList{Files: []DriveFile{file}},
		changes: DriveChangeList{Changes: []DriveChange{{
			FileID: file.ID, Time: renamed.ModifiedTime, File: &renamed,
		}}, NewStartToken: "page2"},
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	eng := &Engine{Calendar: cal, Drive: drive, Location: loc, Now: func() time.Time { return now }}
	snap, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{
		WindowStart: time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Calendar.SyncToken != "tok" || len(snap.Calendar.Events) != 1 || len(snap.Drive.Files) != 1 {
		t.Fatalf("%+v", snap)
	}
	now = now.Add(40 * time.Minute)
	receipt, err := eng.Compare(context.Background(), snap, CompareOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Calendar == nil || receipt.Calendar.DiffMode != CalendarDiffSync {
		t.Fatalf("%+v", receipt.Calendar)
	}
	dentist, ok := findChange(receipt, "evt_dentist")
	if !ok || !strings.Contains(dentist.Summary, `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM`) {
		t.Fatal(dentist.Summary)
	}
	notes, ok := findChange(receipt, "file_notes")
	if !ok || !strings.Contains(notes.Summary, `Renamed "Notes" to "Notes final".`) {
		t.Fatal(notes.Summary)
	}
}

func TestSyncFailureFallsBackToWindow(t *testing.T) {
	ev := CalendarEvent{
		ID: "a", Summary: "A", Status: "confirmed",
		Start: EventTime{DateTime: time.Date(2026, 4, 8, 15, 0, 0, 0, time.UTC)},
		End:   EventTime{DateTime: time.Date(2026, 4, 8, 16, 0, 0, 0, time.UTC)},
	}
	cal := &fakeCalendar{
		token:   "tok",
		window:  []CalendarEvent{ev},
		syncErr: ErrSyncTokenExpired,
	}
	// Second window read is the fallback. The snapshot stored the first window.
	eng := &Engine{Calendar: cal, Now: func() time.Time { return time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC) }, Location: time.UTC}
	snap, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{Drive: false, Calendar: true})
	if err != nil {
		t.Fatal(err)
	}
	moved := ev
	moved.Summary = "B"
	moved.Updated = time.Date(2026, 4, 2, 15, 10, 0, 0, time.UTC)
	cal.window = []CalendarEvent{moved}
	receipt, err := eng.Compare(context.Background(), snap, CompareOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Calendar.DiffMode != CalendarDiffWindow {
		t.Fatal(receipt.Calendar.DiffMode)
	}
	if len(receipt.Warnings) == 0 || !strings.Contains(receipt.Warnings[0], "sync token expired") {
		t.Fatal(receipt.Warnings)
	}
	if len(receipt.Changes) != 1 || receipt.Changes[0].Kind != KindModified {
		t.Fatalf("%#v", receipt.Changes)
	}
}

func TestEngineRequiresAReader(t *testing.T) {
	eng := &Engine{}
	if _, err := eng.TakeSnapshot(context.Background(), SnapshotOptions{Calendar: true, Drive: false}); err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(ErrNoSnapshot, ErrNoSnapshot) {
		t.Fatal("sentinel")
	}
}
