package googleprov

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Cole-Z/life-diff"
)

func TestGmailSessionActions(t *testing.T) {
	var sawMetadata bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s %s", r.Method, r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("alt") == "media" || q.Get("format") == "full" || q.Get("format") == "raw" {
			t.Errorf("body read %s", r.URL.RequestURI())
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/profile"):
			_, _ = io.WriteString(w, `{"emailAddress":"ada@example.com","historyId":"10"}`)
		case strings.HasSuffix(r.URL.Path, "/messages") && q.Get("q") != "":
			_, _ = io.WriteString(w, `{"messages":[{"id":"m1","threadId":"t1"},{"id":"m3","threadId":"t3"}]}`)
		case strings.HasSuffix(r.URL.Path, "/messages/m2"):
			if q.Get("format") != "metadata" {
				t.Errorf("format %s", r.URL.RawQuery)
			}
			sawMetadata = true
			_, _ = io.WriteString(w, `{"id":"m2","threadId":"t2","labelIds":["SENT"],"snippet":"Friday works","internalDate":"1743607200000","payload":{"headers":[{"name":"Subject","value":"Plans"},{"name":"From","value":"Ada <ada@example.com>"},{"name":"To","value":"Cara <cara@example.com>"},{"name":"Cc","value":"Dee <dee@example.com>"}]}}`)
		case strings.HasSuffix(r.URL.Path, "/messages/m3"):
			_, _ = io.WriteString(w, `{"id":"m3","threadId":"t3","labelIds":["INBOX"],"snippet":"bye","internalDate":"1712066400000","payload":{"headers":[{"name":"Subject","value":"Old"},{"name":"From","value":"Ada <ada@example.com>"},{"name":"To","value":"Bea <bea@example.com>"}]}}`)
		case strings.HasSuffix(r.URL.Path, "/messages/m1"):
			if q.Get("format") != "metadata" {
				t.Errorf("format %s", r.URL.RawQuery)
			}
			sawMetadata = true
			_, _ = io.WriteString(w, `{"id":"m1","threadId":"t1","labelIds":["INBOX"],"snippet":"See you tomorrow","internalDate":"1712066400000","payload":{"headers":[{"name":"Subject","value":"Hello"},{"name":"From","value":"Ada <ada@example.com>"},{"name":"To","value":"Bea <bea@example.com>"}]}}`)
		case strings.HasSuffix(r.URL.Path, "/history"):
			_, _ = io.WriteString(w, `{"historyId":"11","history":[{"messagesAdded":[{"message":{"id":"m2","threadId":"t2","labelIds":["SENT"]}}],"labelsRemoved":[{"message":{"id":"m1"},"labelIds":["INBOX"]}],"messagesDeleted":[{"message":{"id":"m3"}}]}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	g := &Gmail{Client: &Client{BaseURL: srv.URL, HTTP: srv.Client()}}
	now := time.Date(2026, 4, 2, 16, 0, 0, 0, time.UTC)
	snap, err := g.Snapshot(context.Background(), lifediff.SnapshotRequest{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if !sawMetadata || snap.ItemCount != 2 {
		t.Fatalf("metadata %v count %d", sawMetadata, snap.ItemCount)
	}
	current, err := g.ReadCurrent(context.Background(), snap)
	if err != nil {
		t.Fatal(err)
	}
	out, err := g.BuildChanges(snap, current, lifediff.CompareContext{
		Session:  lifediff.SessionWindow{StartedAt: now.Add(-time.Hour), CheckedAt: now},
		Location: time.UTC,
	})
	if err != nil {
		t.Fatal(err)
	}
	var sent, archived, deleted bool
	for _, ch := range out.Changes {
		switch ch.ResourceID {
		case "m2":
			if ch.Kind != lifediff.KindAdded || !strings.Contains(ch.Summary, `Sent "Plans" to Cara <cara@example.com>; cc Dee <dee@example.com>.`) {
				t.Fatalf("sent %#v", ch)
			}
			sent = fieldHas(ch, "snippet", "Friday works") && fieldHas(ch, "recipients", "Cara <cara@example.com>")
		case "m1":
			archived = ch.Kind == lifediff.KindModified && strings.Contains(ch.Summary, `Archived "Hello".`) && fieldHas(ch, "snippet", "See you tomorrow")
		case "m3":
			deleted = ch.Kind == lifediff.KindRemoved && strings.Contains(ch.Summary, `Deleted "Old".`)
		default:
			t.Fatalf("unexpected %#v", ch)
		}
	}
	if !sent || !archived || !deleted {
		t.Fatalf("sent %v archived %v deleted %v\n%s", sent, archived, deleted, dumpChanges(out.Changes))
	}
	for _, note := range out.Notes {
		if strings.Contains(strings.ToLower(note), "bodies are not read") {
			return
		}
	}
	t.Fatal("missing body note")
}

func fieldHas(ch lifediff.Change, field, text string) bool {
	for _, f := range ch.Fields {
		if f.Field == field && (strings.Contains(f.Before, text) || strings.Contains(f.After, text)) {
			return true
		}
	}
	return false
}

func dumpChanges(changes []lifediff.Change) string {
	var b strings.Builder
	for _, ch := range changes {
		b.WriteString(ch.ResourceID + " " + ch.Summary + "\n")
	}
	return b.String()
}

func TestDriveFullReadExportsText(t *testing.T) {
	var exportCalls, mediaCalls int
	docBody := "Launch TBD\n"
	noteBody := "alpha\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && !strings.Contains(r.URL.Path, "activity:query") {
			t.Errorf("write %s %s", r.Method, r.URL.Path)
		}
		switch {
		case strings.Contains(r.URL.Path, "/export"):
			if r.Method != http.MethodGet || r.URL.Query().Get("mimeType") != "text/plain" {
				t.Errorf("export %s %s", r.Method, r.URL.RawQuery)
			}
			exportCalls++
			_, _ = io.WriteString(w, docBody)
			docBody = "Launch in May\n"
		case r.URL.Query().Get("alt") == "media":
			if r.Method != http.MethodGet {
				t.Errorf("media %s", r.Method)
			}
			mediaCalls++
			_, _ = io.WriteString(w, noteBody)
			noteBody = "alpha\nbeta\n"
		case strings.HasSuffix(r.URL.Path, "/startPageToken"):
			_, _ = io.WriteString(w, `{"startPageToken":"page"}`)
		case strings.HasSuffix(r.URL.Path, "/files"):
			_, _ = io.WriteString(w, `{"files":[{"id":"doc1","name":"Q2 goals","mimeType":"application/vnd.google-apps.document","version":"1"},{"id":"note1","name":"Notes","mimeType":"text/plain","size":"6","version":"1"},{"id":"pic","name":"pic.jpg","mimeType":"image/jpeg","version":"1"}]}`)
		case strings.HasSuffix(r.URL.Path, "/changes"):
			_, _ = io.WriteString(w, `{"changes":[{"fileId":"doc1","time":"2026-04-02T15:20:00Z","file":{"id":"doc1","name":"Q2 goals","mimeType":"application/vnd.google-apps.document","version":"2","modifiedTime":"2026-04-02T15:20:00Z"}},{"fileId":"note1","time":"2026-04-02T15:21:00Z","file":{"id":"note1","name":"Notes","mimeType":"text/plain","size":"11","version":"2","modifiedTime":"2026-04-02T15:21:00Z"}},{"fileId":"pic","time":"2026-04-02T15:22:00Z","file":{"id":"pic","name":"pic.jpg","mimeType":"image/jpeg","version":"2","modifiedTime":"2026-04-02T15:22:00Z"}}],"newStartPageToken":"page2"}`)
		case strings.HasSuffix(r.URL.Path, "/revisions"):
			_, _ = io.WriteString(w, `{"revisions":[{"id":"9","modifiedTime":"2026-04-02T15:20:00Z"}]}`)
		case strings.Contains(r.URL.Path, "activity:query"):
			if r.Method != http.MethodPost {
				t.Errorf("activity %s", r.Method)
			}
			_, _ = io.WriteString(w, `{"activities":[{"primaryActionDetail":{"edit":{}},"targets":[{"driveItem":{"name":"items/doc1","title":"Q2 goals"}}],"timestamp":"2026-04-02T15:20:00Z"}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	if got := Providers(srv.Client(), "full"); len(got) != 3 {
		t.Fatalf("full providers %d", len(got))
	}
	if got := Providers(srv.Client(), "minimal"); len(got) != 2 {
		t.Fatalf("minimal providers %d", len(got))
	}
	drive := &Drive{Client: client}
	dp := lifediff.NewDriveProvider(drive)
	lifediff.EnableDriveContentSignals(dp)
	eng := &lifediff.Engine{
		Providers: []lifediff.Provider{dp},
		Location:  time.UTC,
		Now:       func() time.Time { return time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC) },
	}
	snap, err := eng.TakeSnapshot(context.Background(), lifediff.SnapshotOptions{Only: []string{"drive"}})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := eng.Compare(context.Background(), snap, lifediff.CompareOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if exportCalls < 2 || mediaCalls < 2 {
		t.Fatalf("export %d media %d", exportCalls, mediaCalls)
	}
	plain := receipt.PlainSummary()
	if !strings.Contains(plain, `removed "Launch TBD" and added "Launch in May"`) {
		t.Fatal(plain)
	}
	if !strings.Contains(plain, `added "beta"`) && !strings.Contains(plain, "beta") {
		t.Fatal(plain)
	}
	for _, ch := range receipt.Changes {
		if ch.ResourceID == "pic" {
			for _, f := range ch.Fields {
				if f.Field == "text" {
					t.Fatalf("image text %#v", f)
				}
			}
		}
	}
}
