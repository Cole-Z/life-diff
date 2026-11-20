package lifediff

import (
	"context"
	"fmt"
	"time"
)

const (
	// DefaultMaxDriveFiles caps how much file metadata a snapshot stores.
	// The Drive changes feed still reports later edits to files past the cap;
	// those edits have no earlier details to compare.
	DefaultMaxDriveFiles = 2000
	defaultDriveQuery    = "trashed = false"
)

// Engine reads Calendar and Drive and turns those reads into snapshots and receipts.
// It does not store them. Callers keep snapshots wherever they like.
type Engine struct {
	Calendar CalendarReader
	Drive    DriveReader
	Now      func() time.Time
	Location *time.Location
}

// SnapshotOptions selects what a snapshot includes.
type SnapshotOptions struct {
	Calendar      bool
	Drive         bool
	CalendarID    string
	WindowStart   time.Time
	WindowEnd     time.Time
	DriveQuery    string
	MaxDriveFiles int
	SkipSyncToken bool
}

// CompareOptions controls a diff against an existing snapshot.
type CompareOptions struct {
	Claims      []ClaimInput
	CheckClaims bool
	ReceiptID   string
}

func (e *Engine) now() time.Time {
	if e != nil && e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}

func (e *Engine) location() *time.Location {
	if e != nil && e.Location != nil {
		return e.Location
	}
	return time.Local
}

// TakeSnapshot reads the current Calendar window and Drive metadata.
func (e *Engine) TakeSnapshot(ctx context.Context, opt SnapshotOptions) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	opt = normalizeSnapshotOptions(opt, e.now())
	if !opt.Calendar && !opt.Drive {
		return Snapshot{}, fmt.Errorf("choose calendar, drive, or both")
	}
	if opt.Calendar && e.Calendar == nil {
		return Snapshot{}, fmt.Errorf("calendar reader is not configured")
	}
	if opt.Drive && e.Drive == nil {
		return Snapshot{}, fmt.Errorf("drive reader is not configured")
	}

	snap := Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            newID("snap", e.now()),
		TakenAt:       e.now(),
		TimeZone:      e.location().String(),
		Calendar:      CalendarSnapshot{Checked: opt.Calendar, Events: []CalendarEvent{}},
		Drive:         DriveSnapshot{Checked: opt.Drive, Files: []DriveFile{}},
	}

	if opt.Calendar {
		events, err := e.Calendar.ListWindow(ctx, opt.CalendarID, opt.WindowStart, opt.WindowEnd)
		if err != nil {
			return Snapshot{}, fmt.Errorf("read calendar: %w", err)
		}
		snap.Calendar.CalendarID = opt.CalendarID
		snap.Calendar.WindowStart = opt.WindowStart.UTC()
		snap.Calendar.WindowEnd = opt.WindowEnd.UTC()
		snap.Calendar.Events = activeEvents(events)
		if !opt.SkipSyncToken {
			token, err := e.Calendar.CurrentSyncToken(ctx, opt.CalendarID)
			if err != nil {
				snap.Warnings = append(snap.Warnings, "Calendar did not provide a sync token. The next check will read the same time window again.")
			} else {
				snap.Calendar.SyncToken = token
			}
		}
	}

	if opt.Drive {
		token, err := e.Drive.StartPageToken(ctx)
		if err != nil {
			snap.Warnings = append(snap.Warnings, "Drive did not provide a changes token. The next check will list files again.")
		} else {
			snap.Drive.StartPageToken = token
		}
		listed, err := e.Drive.ListFiles(ctx, opt.DriveQuery, opt.MaxDriveFiles)
		if err != nil {
			return Snapshot{}, fmt.Errorf("read drive: %w", err)
		}
		snap.Drive.Query = opt.DriveQuery
		snap.Drive.Files = listed.Files
		snap.Drive.Truncated = listed.Truncated
		if listed.Files == nil {
			snap.Drive.Files = []DriveFile{}
		}
		if listed.Truncated {
			snap.Warnings = append(snap.Warnings, fmt.Sprintf("Drive snapshot stopped at %d files. Later edits to older files still show up, without earlier details.", opt.MaxDriveFiles))
		}
	}
	return snap, nil
}

// Compare reads Google again and builds a receipt against snapshot.
func (e *Engine) Compare(ctx context.Context, before Snapshot, opt CompareOptions) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	if before.ID == "" {
		return Receipt{}, ErrNoSnapshot
	}
	after := AfterState{ObservedAt: e.now()}

	if before.Calendar.Checked {
		if e.Calendar == nil {
			return Receipt{}, fmt.Errorf("calendar reader is not configured")
		}
		events, mode, warn, err := e.readCalendar(ctx, before)
		if err != nil {
			return Receipt{}, err
		}
		after.Calendar = &CalendarAfter{Events: events, Mode: mode}
		if warn != "" {
			after.Warnings = append(after.Warnings, warn)
		}
	}
	if before.Drive.Checked {
		if e.Drive == nil {
			return Receipt{}, fmt.Errorf("drive reader is not configured")
		}
		driveAfter, warn, err := e.readDrive(ctx, before)
		if err != nil {
			return Receipt{}, err
		}
		after.Drive = &driveAfter
		if warn != "" {
			after.Warnings = append(after.Warnings, warn)
		}
	}

	return BuildReceipt(before, after, ReceiptOptions{
		ID:          opt.ReceiptID,
		Now:         after.ObservedAt,
		Location:    e.location(),
		Claims:      opt.Claims,
		CheckClaims: opt.CheckClaims,
	}), nil
}

func (e *Engine) readCalendar(ctx context.Context, before Snapshot) ([]CalendarEvent, string, string, error) {
	cal := before.Calendar
	if cal.SyncToken != "" {
		events, err := e.Calendar.ListSyncChanges(ctx, cal.CalendarID, cal.SyncToken)
		if err == nil {
			merged := applySync(cal.Events, events, cal.WindowStart, cal.WindowEnd, e.location())
			return merged, CalendarDiffSync, "", nil
		}
		warn := "Calendar incremental sync failed (" + trimErr(err) + "). Life Diff read the same time window again."
		events, werr := e.Calendar.ListWindow(ctx, cal.CalendarID, cal.WindowStart, cal.WindowEnd)
		if werr != nil {
			return nil, "", "", fmt.Errorf("read calendar: %w", werr)
		}
		return events, CalendarDiffWindow, warn, nil
	}
	events, err := e.Calendar.ListWindow(ctx, cal.CalendarID, cal.WindowStart, cal.WindowEnd)
	if err != nil {
		return nil, "", "", fmt.Errorf("read calendar: %w", err)
	}
	return events, CalendarDiffWindow, "", nil
}

func (e *Engine) readDrive(ctx context.Context, before Snapshot) (DriveAfter, string, error) {
	if before.Drive.StartPageToken != "" {
		listed, err := e.Drive.ListChanges(ctx, before.Drive.StartPageToken)
		if err == nil {
			return DriveAfter{
				Mode:      DriveDiffChanges,
				Changes:   listed.Changes,
				Truncated: listed.Truncated,
			}, "", nil
		}
		warn := "Drive changes feed failed (" + trimErr(err) + "). Life Diff listed files again."
		files, ferr := e.Drive.ListFiles(ctx, before.Drive.Query, DefaultMaxDriveFiles)
		if ferr != nil {
			return DriveAfter{}, "", fmt.Errorf("read drive: %w", ferr)
		}
		return DriveAfter{Mode: DriveDiffList, Files: files.Files, Truncated: files.Truncated}, warn, nil
	}
	files, err := e.Drive.ListFiles(ctx, before.Drive.Query, DefaultMaxDriveFiles)
	if err != nil {
		return DriveAfter{}, "", fmt.Errorf("read drive: %w", err)
	}
	return DriveAfter{Mode: DriveDiffList, Files: files.Files, Truncated: files.Truncated}, "", nil
}

func normalizeSnapshotOptions(opt SnapshotOptions, now time.Time) SnapshotOptions {
	if !opt.Calendar && !opt.Drive {
		opt.Calendar = true
		opt.Drive = true
	}
	if opt.CalendarID == "" {
		opt.CalendarID = "primary"
	}
	if opt.WindowStart.IsZero() {
		opt.WindowStart = now.Add(-24 * time.Hour)
	}
	if opt.WindowEnd.IsZero() {
		opt.WindowEnd = now.AddDate(0, 0, 90)
	}
	if opt.DriveQuery == "" {
		opt.DriveQuery = defaultDriveQuery
	}
	if opt.MaxDriveFiles <= 0 {
		opt.MaxDriveFiles = DefaultMaxDriveFiles
	}
	return opt
}

func activeEvents(in []CalendarEvent) []CalendarEvent {
	out := make([]CalendarEvent, 0, len(in))
	seen := map[string]bool{}
	for _, ev := range in {
		if ev.ID == "" || isCancelled(ev.Status) || seen[ev.ID] {
			continue
		}
		seen[ev.ID] = true
		ev.Attendees = sortedCopy(ev.Attendees)
		out = append(out, ev)
	}
	return out
}

// applySync overlays incremental Calendar changes on the snapshot.
// Events that were in the snapshot stay in the result even if they moved
// outside the window, so a move is not mistaken for a deletion.
// Cancelled events that were in the snapshot are kept so the diff can use
// their updated time.
func applySync(before []CalendarEvent, changes []CalendarEvent, windowStart, windowEnd time.Time, loc *time.Location) []CalendarEvent {
	current := map[string]CalendarEvent{}
	order := make([]string, 0, len(before))
	for _, ev := range before {
		if ev.ID == "" || isCancelled(ev.Status) {
			continue
		}
		if _, ok := current[ev.ID]; ok {
			continue
		}
		current[ev.ID] = ev
		order = append(order, ev.ID)
	}
	for _, ev := range changes {
		if ev.ID == "" {
			continue
		}
		_, was := current[ev.ID]
		if isCancelled(ev.Status) {
			if was {
				current[ev.ID] = ev
			}
			continue
		}
		if was || overlapsWindow(ev, windowStart, windowEnd, loc) {
			if !was {
				order = append(order, ev.ID)
			}
			current[ev.ID] = ev
		}
	}
	out := make([]CalendarEvent, 0, len(order))
	for _, id := range order {
		ev, ok := current[id]
		if !ok {
			continue
		}
		out = append(out, ev)
	}
	return out
}

func trimErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if len(msg) > 180 {
		return msg[:180]
	}
	return msg
}
