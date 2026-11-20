package googleprov

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Cole-Z/life-diff"
)

func TestFakeGoogleResponses(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s %s", r.Method, r.URL.Path)
		}
		if strings.Contains(r.URL.Path, "/export") || r.URL.Query().Get("alt") == "media" {
			t.Errorf("content download %s", r.URL.RequestURI())
		}
		calls = append(calls, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer super-secret-token" {
			// The error-echo test uses the same server and sets the header.
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			if r.URL.Query().Get("syncToken") == "expired" {
				w.WriteHeader(http.StatusGone)
				_, _ = io.WriteString(w, `{"error":{"message":"Sync token expired Bearer super-secret-token"}}`)
				return
			}
			if r.URL.Query().Get("syncToken") != "" {
				writeFixture(t, w, "testdata/calendar_changes.json")
				return
			}
			if r.URL.Query().Get("timeMin") != "" {
				if r.URL.Query().Get("pageToken") == "" {
					if r.URL.Query().Get("singleEvents") != "true" || r.URL.Query().Get("showDeleted") != "true" {
						t.Errorf("window query %s", r.URL.RawQuery)
					}
				}
				if r.URL.Query().Get("pageToken") == "page-2" {
					writeFixture(t, w, "testdata/calendar_page2.json")
					return
				}
				writeFixture(t, w, "testdata/calendar_page1.json")
				return
			}
			writeFixture(t, w, "testdata/calendar_sync_seed.json")
		case strings.HasSuffix(r.URL.Path, "/changes/startPageToken"):
			writeFixture(t, w, "testdata/drive_start.json")
		case strings.HasSuffix(r.URL.Path, "/files"):
			if r.URL.Query().Get("q") != "trashed = false" {
				t.Errorf("query %s", r.URL.RawQuery)
			}
			writeFixture(t, w, "testdata/drive_files.json")
		case strings.HasSuffix(r.URL.Path, "/changes"):
			if r.URL.Query().Get("pageToken") == "chg-2" {
				writeFixture(t, w, "testdata/drive_changes_page2.json")
				return
			}
			writeFixture(t, w, "testdata/drive_changes_page1.json")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client := &Client{
		BaseURL: srv.URL,
		HTTP:    &http.Client{Transport: headerRoundTripper{base: srv.Client().Transport, token: "super-secret-token"}},
	}
	cal := &Calendar{Client: client}
	drive := &Drive{Client: client}
	ctx := context.Background()

	start := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 90)
	events, err := cal.ListWindow(ctx, "primary", start, end)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Summary != "Dentist" || events[0].Attendees[0] != "sam@example.com (accepted)" {
		t.Fatalf("%#v", events)
	}
	if !events[1].Start.IsAllDay() || events[1].Summary != "Trip" {
		t.Fatalf("%#v", events[1])
	}
	token, err := cal.CurrentSyncToken(ctx, "primary")
	if err != nil || token != "sync-1" {
		t.Fatal(err, token)
	}
	changed, err := cal.ListSyncChanges(ctx, "primary", "sync-1")
	if err != nil || len(changed) != 1 || changed[0].Location != "Clinic" {
		t.Fatal(err, changed)
	}
	_, err = cal.ListSyncChanges(ctx, "primary", "expired")
	if !errors.Is(err, lifediff.ErrSyncTokenExpired) {
		t.Fatal(err)
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatal(err)
	}

	page, err := drive.StartPageToken(ctx)
	if err != nil || page != "tok-1" {
		t.Fatal(err, page)
	}
	files, err := drive.ListFiles(ctx, "trashed = false", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(files.Files) != 2 || files.Files[0].Version != 12 || files.Files[1].Size != 2048 || files.Files[1].MD5 != "abc123def456" {
		t.Fatalf("%#v", files.Files)
	}
	short, err := drive.ListFiles(ctx, "trashed = false", 1)
	if err != nil || !short.Truncated || len(short.Files) != 1 {
		t.Fatalf("%v %#v", err, short)
	}
	changes, err := drive.ListChanges(ctx, "tok-1")
	if err != nil {
		t.Fatal(err)
	}
	if changes.NewStartToken != "tok-2" || len(changes.Changes) != 2 {
		t.Fatalf("%#v", changes)
	}
	if changes.Changes[0].File == nil || changes.Changes[0].File.Name != "Notes final" || changes.Changes[0].File.Version != 13 {
		t.Fatalf("%#v", changes.Changes[0])
	}
	if !changes.Changes[1].Removed || changes.Changes[1].FileID != "file_old" {
		t.Fatalf("%#v", changes.Changes[1])
	}
	for _, path := range calls {
		if strings.Contains(path, "upload") {
			t.Fatal(path)
		}
	}
}

func TestGoogleErrorRedactsToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"message":"denied ya29.supersecretvalue"}}`)
	}))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	err := client.getJSON(context.Background(), "/calendar/v3/calendars/primary/events", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "ya29.supersecretvalue") || strings.Contains(err.Error(), "super-secret") {
		t.Fatal(err)
	}
	if !strings.Contains(err.Error(), "[redacted]") {
		t.Fatal(err)
	}
}

type headerRoundTripper struct {
	base  http.RoundTripper
	token string
}

func (h headerRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	r.Header.Set("Authorization", "Bearer "+h.token)
	base := h.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(r)
}

func writeFixture(t *testing.T, w http.ResponseWriter, path string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
}
