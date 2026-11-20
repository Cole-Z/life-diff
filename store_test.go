package lifediff

import (
	"os"
	"testing"
	"time"
)

func TestStoreRoundTripAndPermissions(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	snap := Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap_test",
		TakenAt:       time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC),
		Calendar:      CalendarSnapshot{Checked: true, Events: []CalendarEvent{}},
		Drive:         DriveSnapshot{Checked: true, Files: []DriveFile{}},
	}
	if err := s.SaveSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	got, err := s.CurrentSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != snap.ID {
		t.Fatal(got.ID)
	}
	assertMode(t, s.Dir+"/snapshots/"+snap.ID+".json", 0o600)
	assertMode(t, s.Dir+"/snapshots", 0o700)

	html := []byte("<html><p>ok</p></html>")
	receipt := SampleReceipt()
	receipt.ID = "rcpt_test"
	if err := s.SaveReceipt(receipt, html); err != nil {
		t.Fatal(err)
	}
	loaded, err := s.LoadReceipt(receipt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ID != receipt.ID || len(loaded.Changes) == 0 {
		t.Fatalf("%s changes %d", loaded.ID, len(loaded.Changes))
	}
	assertMode(t, s.ReceiptPath(receipt.ID), 0o600)
	assertMode(t, s.ReportPath(receipt.ID), 0o600)

	if _, err := s.LoadSnapshot("../secret"); err == nil {
		t.Fatal("path traversal should fail")
	}
}

func TestCurrentSnapshotMissing(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	_, err := s.CurrentSnapshot()
	if err != ErrNoSnapshot {
		t.Fatal(err)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != want {
		t.Fatalf("%s mode %o, want %o", path, info.Mode().Perm(), want)
	}
}
