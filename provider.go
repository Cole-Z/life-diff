package lifediff

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// CalendarReader is the read-only Calendar surface a Calendar provider needs.
// Implementations must not create, edit, or delete events.
type CalendarReader interface {
	ListWindow(ctx context.Context, calendarID string, start, end time.Time) ([]CalendarEvent, error)
	CurrentSyncToken(ctx context.Context, calendarID string) (string, error)
	ListSyncChanges(ctx context.Context, calendarID, syncToken string) ([]CalendarEvent, error)
}

// DriveReader is the read-only Drive surface a Drive provider needs.
// Implementations must not upload, update, or delete files.
type DriveReader interface {
	StartPageToken(ctx context.Context) (string, error)
	ListFiles(ctx context.Context, query string, maxFiles int) (DriveFileList, error)
	ListChanges(ctx context.Context, pageToken string) (DriveChangeList, error)
}

// DriveContentSignals is an optional Drive surface used only in full read mode.
// It lists revision metadata and the Drive Activity record.
type DriveContentSignals interface {
	Revisions(ctx context.Context, fileID string) ([]DriveRevision, error)
	ActivitySince(ctx context.Context, since time.Time) ([]DriveActivity, error)
}

// DriveTextSource is an optional Drive surface used only in full read mode.
// FileText exports Google Docs, Sheets, and Slides as text, or downloads a
// plain text file. It must not upload, update, or delete anything.
type DriveTextSource interface {
	FileText(ctx context.Context, file DriveFile) (DriveText, error)
}

// Provider is one service Life Diff can snapshot and compare.
// The core calls Snapshot, then later ReadCurrent and BuildChanges.
// Adding a service means implementing this interface in its own package and
// registering the value on Engine.Providers. The engine, receipt assembly,
// and report do not need a change for that service.
type Provider interface {
	// ID is a stable key such as "calendar" or "drive".
	ID() string
	// DisplayName is the word shown to people, such as "Calendar".
	DisplayName() string
	// Snapshot reads the current state. The payload is private to the provider.
	Snapshot(ctx context.Context, req SnapshotRequest) (ServiceState, error)
	// ReadCurrent reads the service again, using cursors stored in before.
	ReadCurrent(ctx context.Context, before ServiceState) (ServiceState, error)
	// BuildChanges compares the snapshot with the later read.
	// It does not have to be pure: a provider may use the context for a
	// follow-up read. Calendar and Drive do the comparison locally.
	BuildChanges(before, current ServiceState, cc CompareContext) (ProviderOutput, error)
}

// UndoProvider is reserved for a later write path.
// The read-only core never calls Undo. A provider can implement it now
// without the core knowing the service.
type UndoProvider interface {
	Provider
	Undo(ctx context.Context, change Change, before ServiceState) error
}

// SnapshotRequest is the normalized input for Provider.Snapshot.
// Params uses provider-defined keys. Unknown keys are ignored.
type SnapshotRequest struct {
	Now      time.Time
	Location *time.Location
	Params   map[string]string
}

// CompareContext is the session a provider uses when it builds changes.
type CompareContext struct {
	Session  SessionWindow
	Location *time.Location
}

// ServiceState is one provider's slice of a snapshot, or of a later read.
// Payload is opaque to the core. Other fields are small facts the CLI can show
// without understanding the service.
type ServiceState struct {
	ID          string          `json:"id"`
	DisplayName string          `json:"displayName"`
	Checked     bool            `json:"checked"`
	TakenAt     time.Time       `json:"takenAt,omitempty"`
	TimeZone    string          `json:"timeZone,omitempty"`
	ItemCount   int             `json:"itemCount,omitempty"`
	Cursor      string          `json:"cursor,omitempty"`
	Mode        string          `json:"mode,omitempty"`
	Warnings    []string        `json:"warnings,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

// ProviderOutput is what BuildChanges returns for one service.
type ProviderOutput struct {
	Info     ProviderInfo
	Changes  []Change
	Notes    []string
	Warnings []string
	// Calendar and Drive are set by those providers so a receipt can keep
	// the 1.0 fields. Other providers leave them nil.
	Calendar *ReceiptCalendar
	Drive    *ReceiptDrive
}

// ProviderInfo is the generic section of a receipt for one service.
type ProviderInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	DiffMode    string `json:"diffMode,omitempty"`
	Intro       string `json:"intro,omitempty"`
}

// ProviderSelection is the result of parsing a provider list such as
// "calendar,drive" or "all".
type ProviderSelection struct {
	// Only is the explicit list. Nil means the caller did not restrict by id.
	Only     []string
	Extras   bool
	Calendar bool
	Drive    bool
}

// ParseProviderList parses a CLI or MCP provider list.
// An empty string, "all", and "both" select every registered provider.
// Other values are comma-separated provider ids. Aliases such as "gcal"
// are not accepted here; use the provider id.
func ParseProviderList(spec string) (ProviderSelection, error) {
	folded := fold(spec)
	switch folded {
	case "", "all", "both":
		return ProviderSelection{Extras: true, Calendar: true, Drive: true}, nil
	}
	var ids []string
	seen := map[string]bool{}
	for _, part := range strings.Split(folded, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		if !validProviderID(id) {
			return ProviderSelection{}, fmt.Errorf("unknown provider %q (use calendar, drive, gmail, all, or a provider id)", spec)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ProviderSelection{}, fmt.Errorf("unknown provider %q", spec)
	}
	return ProviderSelection{
		Only:     ids,
		Calendar: seen[string(ServiceCalendar)],
		Drive:    seen[string(ServiceDrive)],
	}, nil
}

func validProviderID(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if i == 0 {
			if c < 'a' || c > 'z' {
				return false
			}
			continue
		}
		switch {
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '-' || c == '_':
		default:
			return false
		}
	}
	return true
}

func param(req SnapshotRequest, key string) string {
	if req.Params == nil {
		return ""
	}
	return strings.TrimSpace(req.Params[key])
}

func encodePayload(v any) (json.RawMessage, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}

func decodePayload(raw json.RawMessage, dest any) error {
	if len(bytesTrim(raw)) == 0 {
		return fmt.Errorf("provider state is missing its payload")
	}
	if err := json.Unmarshal(raw, dest); err != nil {
		return fmt.Errorf("provider state payload: %w", err)
	}
	return nil
}

func bytesTrim(raw json.RawMessage) []byte {
	return []byte(strings.TrimSpace(string(raw)))
}
