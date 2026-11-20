package lifediff

import (
	"fmt"
	"time"
)

// SchemaVersion is the receipt and snapshot document version.
// Minor versions may add fields. Readers should ignore fields they do not know.
const SchemaVersion = "1.0.0"

// Version is the Life Diff library and CLI version.
const Version = "0.1.0"

// Service is a connected account Life Diff knows how to read.
type Service string

const (
	ServiceCalendar Service = "calendar"
	ServiceDrive    Service = "drive"
)

// Display returns the word shown to people.
func (s Service) Display() string {
	switch s {
	case ServiceCalendar:
		return "Calendar"
	case ServiceDrive:
		return "Drive"
	default:
		panic(fmt.Sprintf("lifediff: unhandled service %q", s))
	}
}

// ChangeKind is the normalized shape of one change.
type ChangeKind string

const (
	KindAdded    ChangeKind = "added"
	KindRemoved  ChangeKind = "removed"
	KindModified ChangeKind = "modified"
)

// Display returns the badge label for this kind.
func (k ChangeKind) Display() string {
	switch k {
	case KindAdded:
		return "Added"
	case KindRemoved:
		return "Removed"
	case KindModified:
		return "Modified"
	default:
		panic(fmt.Sprintf("lifediff: unhandled change kind %q", k))
	}
}

// Confidence says how sure Life Diff is that a change happened during the session.
type Confidence string

const (
	ConfidenceHigh   Confidence = "high"
	ConfidenceMedium Confidence = "medium"
	ConfidenceLow    Confidence = "low"
)

// Display returns a short label for the report.
func (c Confidence) Display() string {
	switch c {
	case ConfidenceHigh:
		return "High confidence"
	case ConfidenceMedium:
		return "Medium confidence"
	case ConfidenceLow:
		return "Low confidence"
	default:
		panic(fmt.Sprintf("lifediff: unhandled confidence %q", c))
	}
}

// ClaimStatus is the verdict for an agent claim or for a change the agent did not mention.
type ClaimStatus string

const (
	ClaimVerified  ClaimStatus = "verified"
	ClaimMissing   ClaimStatus = "missing"
	ClaimUnclaimed ClaimStatus = "unclaimed"
)

// Display returns the word shown on the report.
func (s ClaimStatus) Display() string {
	switch s {
	case ClaimVerified:
		return "Verified"
	case ClaimMissing:
		return "Missing"
	case ClaimUnclaimed:
		return "Not claimed"
	default:
		panic(fmt.Sprintf("lifediff: unhandled claim status %q", s))
	}
}

// CalendarDiffSync compares the snapshot with Calendar's incremental sync feed.
// CalendarDiffWindow reads the same time window again.
const (
	CalendarDiffSync   = "sync"
	CalendarDiffWindow = "window"
)

// DriveDiffChanges uses the Drive Changes API.
// DriveDiffList lists file metadata again and compares the two lists.
const (
	DriveDiffChanges = "changes"
	DriveDiffList    = "list"
)

// EventTime is either a timed instant or an all-day date (YYYY-MM-DD).
type EventTime struct {
	DateTime time.Time `json:"dateTime,omitempty"`
	Date     string    `json:"date,omitempty"`
	TimeZone string    `json:"timeZone,omitempty"`
}

// IsAllDay reports whether this value is a calendar date with no clock time.
func (t EventTime) IsAllDay() bool {
	return t.Date != "" && t.DateTime.IsZero()
}

// CalendarEvent is the normalized metadata Life Diff stores for one event.
type CalendarEvent struct {
	ID          string    `json:"id"`
	Summary     string    `json:"summary,omitempty"`
	Description string    `json:"description,omitempty"`
	Location    string    `json:"location,omitempty"`
	Status      string    `json:"status,omitempty"`
	Start       EventTime `json:"start"`
	End         EventTime `json:"end"`
	Attendees   []string  `json:"attendees,omitempty"`
	Updated     time.Time `json:"updated,omitempty"`
	Link        string    `json:"link,omitempty"`
}

// DriveFile is file metadata. Life Diff never stores file contents.
type DriveFile struct {
	ID           string    `json:"id"`
	Name         string    `json:"name,omitempty"`
	MimeType     string    `json:"mimeType,omitempty"`
	ModifiedTime time.Time `json:"modifiedTime,omitempty"`
	CreatedTime  time.Time `json:"createdTime,omitempty"`
	Trashed      bool      `json:"trashed,omitempty"`
	Parents      []string  `json:"parents,omitempty"`
	Size         int64     `json:"size,omitempty"`
	MD5          string    `json:"md5Checksum,omitempty"`
	Version      int64     `json:"version,omitempty"`
	Link         string    `json:"link,omitempty"`
}

// DriveChange is one item from the Drive Changes feed.
type DriveChange struct {
	FileID  string     `json:"fileId"`
	Removed bool       `json:"removed,omitempty"`
	Time    time.Time  `json:"time,omitempty"`
	File    *DriveFile `json:"file,omitempty"`
}

// DriveChangeList is a page-merged Changes feed.
type DriveChangeList struct {
	Changes       []DriveChange `json:"changes"`
	NewStartToken string        `json:"newStartToken,omitempty"`
	Truncated     bool          `json:"truncated,omitempty"`
}

// DriveFileList is a page-merged metadata listing.
type DriveFileList struct {
	Files     []DriveFile `json:"files"`
	Truncated bool        `json:"truncated,omitempty"`
}

// CalendarSnapshot is the Calendar half of a saved snapshot.
type CalendarSnapshot struct {
	Checked     bool            `json:"checked"`
	CalendarID  string          `json:"calendarId,omitempty"`
	WindowStart time.Time       `json:"windowStart,omitempty"`
	WindowEnd   time.Time       `json:"windowEnd,omitempty"`
	SyncToken   string          `json:"syncToken,omitempty"`
	Events      []CalendarEvent `json:"events"`
}

// DriveSnapshot is the Drive half of a saved snapshot.
type DriveSnapshot struct {
	Checked        bool        `json:"checked"`
	Query          string      `json:"query,omitempty"`
	StartPageToken string      `json:"startPageToken,omitempty"`
	Files          []DriveFile `json:"files"`
	Truncated      bool        `json:"truncated,omitempty"`
}

// Snapshot is the local before-image. Google does not keep this history for us.
type Snapshot struct {
	SchemaVersion string           `json:"schemaVersion"`
	ID            string           `json:"id"`
	TakenAt       time.Time        `json:"takenAt"`
	TimeZone      string           `json:"timeZone,omitempty"`
	Calendar      CalendarSnapshot `json:"calendar"`
	Drive         DriveSnapshot    `json:"drive"`
	Warnings      []string         `json:"warnings,omitempty"`
}

// FieldChange is one before/after pair inside a change.
type FieldChange struct {
	Field  string `json:"field"`
	Label  string `json:"label"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// Change is one normalized thing that differs between the snapshot and the later read.
type Change struct {
	ID               string        `json:"id"`
	Service          Service       `json:"service"`
	Kind             ChangeKind    `json:"kind"`
	ResourceID       string        `json:"resourceId"`
	ResourceName     string        `json:"resourceName"`
	Summary          string        `json:"summary"`
	Fields           []FieldChange `json:"fields"`
	OccurredAt       *time.Time    `json:"occurredAt,omitempty"`
	Confidence       Confidence    `json:"confidence"`
	ConfidenceReason string        `json:"confidenceReason"`
	ClaimStatus      ClaimStatus   `json:"claimStatus,omitempty"`
	Link             string        `json:"link,omitempty"`
}

// ClaimInput is what an agent says it did. Targets are names or resource ids.
type ClaimInput struct {
	ID      string `json:"id,omitempty" jsonschema:"optional id for this claim"`
	Service string `json:"service,omitempty" jsonschema:"calendar or drive; omit to match either"`
	Action  string `json:"action,omitempty" jsonschema:"added, removed, or modified"`
	Target  string `json:"target" jsonschema:"event title, file name, or resource id"`
	Detail  string `json:"detail,omitempty" jsonschema:"optional detail in plain language"`
}

// ClaimResult is a claim plus the verdict Life Diff can support from Google's data.
type ClaimResult struct {
	ID               string      `json:"id"`
	Service          Service     `json:"service,omitempty"`
	Action           string      `json:"action,omitempty"`
	Target           string      `json:"target"`
	Detail           string      `json:"detail,omitempty"`
	Status           ClaimStatus `json:"status"`
	Confidence       Confidence  `json:"confidence,omitempty"`
	MatchedChangeIDs []string    `json:"matchedChangeIds,omitempty"`
	Reason           string      `json:"reason"`
}

// ReceiptSnapshot points at the before-image a receipt was built from.
type ReceiptSnapshot struct {
	ID      string    `json:"id"`
	TakenAt time.Time `json:"takenAt"`
}

// SessionWindow is the time between the snapshot and the later check.
type SessionWindow struct {
	StartedAt time.Time `json:"startedAt"`
	CheckedAt time.Time `json:"checkedAt"`
}

// ReceiptCalendar describes how Calendar was compared.
type ReceiptCalendar struct {
	CalendarID  string    `json:"calendarId"`
	WindowStart time.Time `json:"windowStart"`
	WindowEnd   time.Time `json:"windowEnd"`
	DiffMode    string    `json:"diffMode"`
}

// ReceiptDrive describes how Drive was compared.
type ReceiptDrive struct {
	Query              string `json:"query,omitempty"`
	DiffMode           string `json:"diffMode"`
	TruncatedSnapshot  bool   `json:"truncatedSnapshot"`
	TruncatedChanges   bool   `json:"truncatedChanges,omitempty"`
	SuppressedRemovals bool   `json:"suppressedRemovals,omitempty"`
}

// Counts is the headline tally for a receipt.
type Counts struct {
	Added            int `json:"added"`
	Removed          int `json:"removed"`
	Modified         int `json:"modified"`
	VerifiedClaims   int `json:"verifiedClaims"`
	MissingClaims    int `json:"missingClaims"`
	UnclaimedChanges int `json:"unclaimedChanges"`
}

// Producer identifies the program that wrote a receipt.
type Producer struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Receipt is the versioned record of a comparison.
type Receipt struct {
	SchemaVersion string           `json:"schemaVersion"`
	ID            string           `json:"id"`
	GeneratedAt   time.Time        `json:"generatedAt"`
	ReadOnly      bool             `json:"readOnly"`
	Producer      Producer         `json:"producer"`
	Snapshot      ReceiptSnapshot  `json:"snapshot"`
	ComparedAt    time.Time        `json:"comparedAt"`
	TimeZone      string           `json:"timeZone,omitempty"`
	Session       SessionWindow    `json:"session"`
	Calendar      *ReceiptCalendar `json:"calendar,omitempty"`
	Drive         *ReceiptDrive    `json:"drive,omitempty"`
	Counts        Counts           `json:"counts"`
	Changes       []Change         `json:"changes"`
	ClaimsChecked bool             `json:"claimsChecked"`
	Claims        []ClaimResult    `json:"claims"`
	Notes         []string         `json:"notes"`
	Warnings      []string         `json:"warnings,omitempty"`
}

// CalendarAfter is the Calendar read used as the "after" side.
type CalendarAfter struct {
	Events []CalendarEvent `json:"events"`
	Mode   string          `json:"mode"`
}

// DriveAfter is the Drive read used as the "after" side.
type DriveAfter struct {
	Mode      string        `json:"mode"`
	Changes   []DriveChange `json:"changes,omitempty"`
	Files     []DriveFile   `json:"files,omitempty"`
	Truncated bool          `json:"truncated,omitempty"`
}

// AfterState is a fresh read, already fetched, ready to compare with a snapshot.
type AfterState struct {
	ObservedAt time.Time      `json:"observedAt"`
	Calendar   *CalendarAfter `json:"calendar,omitempty"`
	Drive      *DriveAfter    `json:"drive,omitempty"`
	Warnings   []string       `json:"warnings,omitempty"`
}
