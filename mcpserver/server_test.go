package mcpserver

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Cole-Z/life-diff"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPSnapshotDiffReceipt(t *testing.T) {
	home := t.TempDir()
	start := time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)
	before := lifediff.CalendarEvent{
		ID: "evt_dentist", Summary: "Dentist", Status: "confirmed", Location: "Office",
		Start: lifediff.EventTime{DateTime: start},
		End:   lifediff.EventTime{DateTime: start.Add(time.Hour)},
	}
	after := before
	after.Location = "Clinic"
	after.Updated = time.Date(2026, 4, 2, 15, 20, 0, 0, time.UTC)
	cal := &memCal{window: []lifediff.CalendarEvent{before}, token: "tok", changes: []lifediff.CalendarEvent{after}}
	drive := &memDrive{token: "page"}
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	cfg := Config{
		Store:    lifediff.Store{Dir: home},
		Location: time.UTC,
		Now:      func() time.Time { return now },
		NewEngine: func(context.Context) (*lifediff.Engine, error) {
			return &lifediff.Engine{Calendar: cal, Drive: drive, Location: time.UTC, Now: func() time.Time { return now }}, nil
		},
	}
	server := NewServer(cfg)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := server.Connect(context.Background(), st, nil); err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	session, err := client.Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "snapshot",
		Arguments: map[string]any{"only": "calendar"},
	})
	if err != nil || res.IsError {
		t.Fatal(err, res)
	}
	now = now.Add(30 * time.Minute)
	res, err = session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "diff",
		Arguments: map[string]any{
			"claims": []any{map[string]any{"service": "calendar", "action": "modified", "target": "Dentist"}},
		},
	})
	if err != nil || res.IsError {
		t.Fatal(err, res)
	}
	text := textOf(res)
	if !strings.Contains(text, "Dentist") {
		t.Fatal(text)
	}
	receipt, err := cfg.Store.CurrentReceipt()
	if err != nil {
		t.Fatal(err)
	}
	got, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "get_receipt",
		Arguments: map[string]any{"receiptId": receipt.ID},
	})
	if err != nil || got.IsError {
		t.Fatal(err, got)
	}
	if !strings.Contains(textOf(got), "verified") && !strings.Contains(textOf(got), "Dentist") {
		t.Fatal(textOf(got))
	}
}

func textOf(res *mcp.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if text, ok := c.(*mcp.TextContent); ok {
			b.WriteString(text.Text)
		}
	}
	return b.String()
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

type memDrive struct{ token string }

func (m *memDrive) StartPageToken(context.Context) (string, error) { return m.token, nil }
func (m *memDrive) ListFiles(context.Context, string, int) (lifediff.DriveFileList, error) {
	return lifediff.DriveFileList{Files: []lifediff.DriveFile{}}, nil
}
func (m *memDrive) ListChanges(context.Context, string) (lifediff.DriveChangeList, error) {
	return lifediff.DriveChangeList{Changes: []lifediff.DriveChange{}}, nil
}
