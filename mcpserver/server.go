// Package mcpserver exposes Life Diff as a local stdio MCP server.
package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Cole-Z/life-diff"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Config wires the MCP tools to a local store and a reader factory.
type Config struct {
	Store     lifediff.Store
	NewEngine func(ctx context.Context) (*lifediff.Engine, error)
	Location  *time.Location
	Now       func() time.Time
}

type service struct {
	cfg Config
}

// NewServer builds an MCP server with snapshot, diff, and get_receipt.
func NewServer(cfg Config) *mcp.Server {
	s := &service{cfg: cfg}
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "lifediff",
		Version: lifediff.Version,
	}, &mcp.ServerOptions{
		Instructions: "Life Diff is read-only. Call snapshot before changing Google Calendar or Drive, diff afterward, and get_receipt to read a saved receipt. Do not ask the user for tokens or credentials.",
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "snapshot",
		Description: "Save a read-only snapshot of Google Calendar events in a time window and Google Drive file metadata. Run this before an agent changes the user's accounts.",
	}, s.snapshot)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "diff",
		Description: "Compare Google Calendar and Drive with the saved snapshot and return a receipt of added, removed, and modified items. Pass claims for what the agent says it did.",
	}, s.diff)
	mcp.AddTool(server, &mcp.Tool{
		Name:        "get_receipt",
		Description: "Read a Life Diff receipt that diff already saved.",
	}, s.getReceipt)
	return server
}

// ServeStdio runs the server on stdin and stdout until the client disconnects.
func ServeStdio(ctx context.Context, cfg Config) error {
	return NewServer(cfg).Run(ctx, &mcp.StdioTransport{})
}

type snapshotInput struct {
	From       string `json:"from,omitempty" jsonschema:"window start as RFC3339 or YYYY-MM-DD; default is 24 hours ago"`
	To         string `json:"to,omitempty" jsonschema:"window end as RFC3339 or YYYY-MM-DD; default is 90 days ahead"`
	CalendarID string `json:"calendarId,omitempty" jsonschema:"calendar id, default primary"`
	Only       string `json:"only,omitempty" jsonschema:"calendar, drive, or both"`
}

type snapshotOutput struct {
	SnapshotID     string    `json:"snapshotId"`
	TakenAt        time.Time `json:"takenAt"`
	CalendarEvents int       `json:"calendarEvents"`
	DriveFiles     int       `json:"driveFiles"`
	Warnings       []string  `json:"warnings,omitempty"`
}

type diffInput struct {
	SnapshotID string                `json:"snapshotId,omitempty" jsonschema:"snapshot to compare; default is the latest"`
	Claims     []lifediff.ClaimInput `json:"claims,omitempty" jsonschema:"what the agent says it changed"`
}

type diffOutput struct {
	Summary  string           `json:"summary"`
	JSONPath string           `json:"jsonPath"`
	HTMLPath string           `json:"htmlPath"`
	Receipt  lifediff.Receipt `json:"receipt"`
}

type getReceiptInput struct {
	ReceiptID string `json:"receiptId,omitempty" jsonschema:"receipt id; default is the latest"`
}

func (s *service) snapshot(ctx context.Context, _ *mcp.CallToolRequest, in snapshotInput) (*mcp.CallToolResult, snapshotOutput, error) {
	eng, err := s.engine(ctx)
	if err != nil {
		return nil, snapshotOutput{}, err
	}
	opt, err := snapshotOptions(in, s.location())
	if err != nil {
		return nil, snapshotOutput{}, err
	}
	snap, err := eng.TakeSnapshot(ctx, opt)
	if err != nil {
		return nil, snapshotOutput{}, err
	}
	if err := s.cfg.Store.SaveSnapshot(snap); err != nil {
		return nil, snapshotOutput{}, err
	}
	return nil, snapshotOutput{
		SnapshotID:     snap.ID,
		TakenAt:        snap.TakenAt,
		CalendarEvents: len(snap.Calendar.Events),
		DriveFiles:     len(snap.Drive.Files),
		Warnings:       snap.Warnings,
	}, nil
}

func (s *service) diff(ctx context.Context, _ *mcp.CallToolRequest, in diffInput) (*mcp.CallToolResult, diffOutput, error) {
	eng, err := s.engine(ctx)
	if err != nil {
		return nil, diffOutput{}, err
	}
	snap, err := s.loadSnapshot(in.SnapshotID)
	if err != nil {
		return nil, diffOutput{}, err
	}
	claims, check, err := normalizeClaims(in.Claims)
	if err != nil {
		return nil, diffOutput{}, err
	}
	receipt, err := eng.Compare(ctx, snap, lifediff.CompareOptions{
		Claims:      claims,
		CheckClaims: check,
	})
	if err != nil {
		return nil, diffOutput{}, err
	}
	html, err := lifediff.RenderHTML(receipt)
	if err != nil {
		return nil, diffOutput{}, err
	}
	if err := s.cfg.Store.SaveReceipt(receipt, html); err != nil {
		return nil, diffOutput{}, err
	}
	out := diffOutput{
		Summary:  receipt.PlainSummary(),
		JSONPath: s.cfg.Store.ReceiptPath(receipt.ID),
		HTMLPath: s.cfg.Store.ReportPath(receipt.ID),
		Receipt:  receipt,
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: out.Summary}},
	}, out, nil
}

func (s *service) getReceipt(_ context.Context, _ *mcp.CallToolRequest, in getReceiptInput) (*mcp.CallToolResult, diffOutput, error) {
	var (
		receipt lifediff.Receipt
		err     error
	)
	if in.ReceiptID == "" {
		receipt, err = s.cfg.Store.CurrentReceipt()
	} else {
		receipt, err = s.cfg.Store.LoadReceipt(in.ReceiptID)
	}
	if err != nil {
		return nil, diffOutput{}, err
	}
	html, err := lifediff.RenderHTML(receipt)
	if err != nil {
		return nil, diffOutput{}, err
	}
	if err := s.cfg.Store.SaveReceipt(receipt, html); err != nil {
		return nil, diffOutput{}, err
	}
	out := diffOutput{
		Summary:  receipt.PlainSummary(),
		JSONPath: s.cfg.Store.ReceiptPath(receipt.ID),
		HTMLPath: s.cfg.Store.ReportPath(receipt.ID),
		Receipt:  receipt,
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: out.Summary}},
	}, out, nil
}

func (s *service) engine(ctx context.Context) (*lifediff.Engine, error) {
	if s.cfg.NewEngine == nil {
		return nil, fmt.Errorf("Life Diff is not configured")
	}
	eng, err := s.cfg.NewEngine(ctx)
	if err != nil {
		return nil, err
	}
	if eng.Now == nil && s.cfg.Now != nil {
		eng.Now = s.cfg.Now
	}
	if eng.Location == nil {
		eng.Location = s.location()
	}
	return eng, nil
}

func (s *service) location() *time.Location {
	if s.cfg.Location != nil {
		return s.cfg.Location
	}
	return time.Local
}

func (s *service) loadSnapshot(id string) (lifediff.Snapshot, error) {
	if id == "" {
		return s.cfg.Store.CurrentSnapshot()
	}
	return s.cfg.Store.LoadSnapshot(id)
}

func snapshotOptions(in snapshotInput, loc *time.Location) (lifediff.SnapshotOptions, error) {
	cal, drive, err := parseOnly(in.Only)
	if err != nil {
		return lifediff.SnapshotOptions{}, err
	}
	from, err := parseTime(in.From, loc)
	if err != nil {
		return lifediff.SnapshotOptions{}, err
	}
	to, err := parseTime(in.To, loc)
	if err != nil {
		return lifediff.SnapshotOptions{}, err
	}
	return lifediff.SnapshotOptions{
		Calendar:    cal,
		Drive:       drive,
		CalendarID:  in.CalendarID,
		WindowStart: from,
		WindowEnd:   to,
	}, nil
}

func normalizeClaims(in []lifediff.ClaimInput) ([]lifediff.ClaimInput, bool, error) {
	if in == nil {
		return nil, false, nil
	}
	raw, err := json.Marshal(map[string]any{"claims": in})
	if err != nil {
		return nil, false, err
	}
	claims, err := lifediff.ParseClaims(raw)
	if err != nil {
		return nil, false, err
	}
	return claims, true, nil
}

func parseOnly(s string) (calendar, drive bool, err error) {
	switch s {
	case "", "both":
		return true, true, nil
	case "calendar":
		return true, false, nil
	case "drive":
		return false, true, nil
	default:
		return false, false, fmt.Errorf("unknown only value %q (use calendar, drive, or both)", s)
	}
}

func parseTime(s string, loc *time.Location) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if loc == nil {
		loc = time.UTC
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("use RFC3339 or YYYY-MM-DD, not %q", s)
	}
	return t, nil
}
