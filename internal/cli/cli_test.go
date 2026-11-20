package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cole-Z/life-diff"
	"github.com/Cole-Z/life-diff/auth"
	"golang.org/x/oauth2"
)

func TestSnapshotDiffAndStrictExit(t *testing.T) {
	home := t.TempDir()
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 4, 7, 19, 0, 0, 0, time.UTC)
	before := lifediff.CalendarEvent{
		ID: "evt_dentist", Summary: "Dentist", Location: "Office", Status: "confirmed",
		Start: lifediff.EventTime{DateTime: start},
		End:   lifediff.EventTime{DateTime: start.Add(time.Hour)},
	}
	after := before
	after.Location = "Clinic"
	after.Start.DateTime = time.Date(2026, 4, 8, 14, 0, 0, 0, time.UTC)
	after.End.DateTime = after.Start.DateTime.Add(time.Hour)
	after.Updated = time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)
	cal := &memCal{window: []lifediff.CalendarEvent{before}, token: "tok", changes: []lifediff.CalendarEvent{after}}
	file := lifediff.DriveFile{ID: "file_notes", Name: "Notes", MimeType: "text/plain", Version: 1}
	drive := &memDrive{token: "page", files: lifediff.DriveFileList{Files: []lifediff.DriveFile{file}}}
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	opt := Options{
		Home:     home,
		Location: loc,
		Env:      map[string]string{},
		Now:      func() time.Time { return now },
		Readers: func(context.Context, string) (lifediff.CalendarReader, lifediff.DriveReader, error) {
			return cal, drive, nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(context.Background(), []string{"snapshot"}, &stdout, &stderr, opt); code != 0 {
		t.Fatalf("snapshot %d %s", code, stderr.String())
	}
	now = now.Add(40 * time.Minute)
	claims := filepath.Join(home, "claims.json")
	if err := os.WriteFile(claims, []byte(`{"claims":[{"service":"calendar","action":"moved","target":"Dentist"},{"service":"drive","action":"created","target":"Q2 goals"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	code := Run(context.Background(), []string{"diff", "--claims", claims, "--strict"}, &stdout, &stderr, opt)
	if code != 3 {
		t.Fatalf("diff code %d\n%s\n%s", code, stdout.String(), stderr.String())
	}
	text := stdout.String()
	if !strings.Contains(text, `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM`) {
		t.Fatal(text)
	}
	if !strings.Contains(text, "Missing: Q2 goals") {
		t.Fatal(text)
	}
	if strings.Contains(text, "access_token") || strings.Contains(stderr.String(), "refresh_token") {
		t.Fatal(text)
	}
	entries, err := os.ReadDir(filepath.Join(home, "receipts"))
	if err != nil {
		t.Fatal(err)
	}
	var htmlPath string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".html") {
			htmlPath = filepath.Join(home, "receipts", e.Name())
		}
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %o", e.Name(), info.Mode().Perm())
		}
	}
	body, err := os.ReadFile(htmlPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "Modified") || !strings.Contains(string(body), "Dentist") {
		t.Fatal("html report missing labels")
	}
}

func TestAuthStatusDoesNotPrintToken(t *testing.T) {
	home := t.TempDir()
	secret := "ya29.status-should-not-print"
	if err := auth.SaveToken(filepath.Join(home, "token.json"), &oauth2.Token{AccessToken: secret, RefreshToken: "1//hidden-refresh"}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"auth", "--status"}, &stdout, &stderr, Options{Home: home, Env: map[string]string{}})
	if code != 0 {
		t.Fatal(code, stderr.String())
	}
	if strings.Contains(stdout.String(), secret) || strings.Contains(stdout.String(), "1//hidden-refresh") {
		t.Fatal(stdout.String())
	}
	if !strings.Contains(stdout.String(), "saved sign-in") {
		t.Fatal(stdout.String())
	}
}

func TestDemoSummary(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"demo"}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatal(code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM`) {
		t.Fatal(stdout.String())
	}
}

func TestUsageAndMissingSnapshot(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Run(context.Background(), nil, &stdout, &stderr, Options{Home: t.TempDir(), Env: map[string]string{}}); code != 2 {
		t.Fatal(code)
	}
	stdout.Reset()
	stderr.Reset()
	code := Run(context.Background(), []string{"diff"}, &stdout, &stderr, Options{
		Home: t.TempDir(),
		Env:  map[string]string{},
		Readers: func(context.Context, string) (lifediff.CalendarReader, lifediff.DriveReader, error) {
			return &memCal{}, &memDrive{}, nil
		},
	})
	if code != 1 || !strings.Contains(stderr.String(), "no snapshot yet") {
		t.Fatalf("%d %s", code, stderr.String())
	}
}

func TestProxyUsageAndActionReceipt(t *testing.T) {
	home := t.TempDir()
	opt := Options{Home: home, Env: map[string]string{}}
	var stdout, stderr bytes.Buffer
	if code := Run(context.Background(), []string{"proxy"}, &stdout, &stderr, opt); code != 2 {
		t.Fatalf("proxy usage %d %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "lifediff proxy") {
		t.Fatal(stderr.String())
	}
	dir := filepath.Join(home, "actions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"time":"2026-04-02T15:00:00Z","upstream":"docs","tool":"search_docs","arguments":{"query":"Workers"},"ok":true,"summary":"Looked up \"Workers\" in Docs.","durationMs":12,"effect":"read","tone":"read","source":"proxy","resultSummary":"Workers run code."}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "ses_test.jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "latest"), []byte("ses_test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	htmlPath := filepath.Join(home, "out.html")
	if code := Run(context.Background(), []string{"receipt", "--html", htmlPath}, &stdout, &stderr, opt); code != 0 {
		t.Fatalf("receipt %d %s %s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), `Looked up "Workers" in Docs.`) {
		t.Fatal(stdout.String())
	}
	html, err := os.ReadFile(htmlPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(html, []byte("#0f5c32")) || !bytes.Contains(html, []byte("Reported by proxy")) || !bytes.Contains(html, []byte("badge-read")) {
		t.Fatalf("%s", html)
	}
}

type memCal struct {
	window  []lifediff.CalendarEvent
	token   string
	changes []lifediff.CalendarEvent
}

func (m *memCal) ListWindow(context.Context, string, time.Time, time.Time) ([]lifediff.CalendarEvent, error) {
	return m.window, nil
}
func (m *memCal) CurrentSyncToken(context.Context, string) (string, error) { return m.token, nil }
func (m *memCal) ListSyncChanges(context.Context, string, string) ([]lifediff.CalendarEvent, error) {
	return m.changes, nil
}

type memDrive struct {
	token string
	files lifediff.DriveFileList
}

func (m *memDrive) StartPageToken(context.Context) (string, error) { return m.token, nil }
func (m *memDrive) ListFiles(context.Context, string, int) (lifediff.DriveFileList, error) {
	return m.files, nil
}
func (m *memDrive) ListChanges(context.Context, string) (lifediff.DriveChangeList, error) {
	return lifediff.DriveChangeList{}, nil
}
