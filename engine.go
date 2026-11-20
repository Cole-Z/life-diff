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

// Engine reads registered providers and turns those reads into snapshots and receipts.
// It does not store them. Callers keep snapshots wherever they like.
//
// Providers is the list of services. When it is empty, Calendar and Drive are
// wrapped with NewCalendarProvider and NewDriveProvider so existing callers
// keep working. A new service is added by appending to Providers.
type Engine struct {
	Providers []Provider
	Calendar  CalendarReader
	Drive     DriveReader
	Now       func() time.Time
	Location  *time.Location
}

// SnapshotOptions selects what a snapshot includes.
// Only, when non-empty, is the explicit provider list. Otherwise Calendar,
// Drive, and Extras choose among the registered providers.
type SnapshotOptions struct {
	Only          []string
	Extras        bool
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

// TakeSnapshot reads each selected provider.
func (e *Engine) TakeSnapshot(ctx context.Context, opt SnapshotOptions) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	now := e.now()
	opt = normalizeSnapshotOptions(opt, now)
	providers := e.active()
	if len(providers) == 0 {
		return Snapshot{}, fmt.Errorf("no providers are configured")
	}
	ids, err := providerIDs(opt, providers)
	if err != nil {
		return Snapshot{}, err
	}
	snap := Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            newID("snap", now),
		TakenAt:       now,
		TimeZone:      e.location().String(),
		Calendar:      CalendarSnapshot{Checked: false, Events: []CalendarEvent{}},
		Drive:         DriveSnapshot{Checked: false, Files: []DriveFile{}},
	}
	req := snapshotRequest(opt, e.location(), now)
	ran := false
	for _, id := range ids {
		p := findProvider(providers, id)
		if p == nil {
			return Snapshot{}, fmt.Errorf("%s reader is not configured", id)
		}
		ran = true
		useLocation(p, e.location())
		state, err := p.Snapshot(ctx, req)
		if err != nil {
			return Snapshot{}, err
		}
		if state.ID == "" {
			state.ID = p.ID()
		}
		if state.DisplayName == "" {
			state.DisplayName = p.DisplayName()
		}
		if state.TimeZone == "" {
			state.TimeZone = e.location().String()
		}
		snap.Providers = append(snap.Providers, state)
		snap.Warnings = append(snap.Warnings, state.Warnings...)
		if proj, ok := p.(snapshotProjector); ok {
			proj.ProjectSnapshot(&snap, state)
		}
	}
	if !ran {
		return Snapshot{}, fmt.Errorf("choose at least one provider")
	}
	return snap, nil
}

// Compare reads each provider in the snapshot again and builds a receipt.
func (e *Engine) Compare(ctx context.Context, before Snapshot, opt CompareOptions) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	if before.ID == "" {
		return Receipt{}, ErrNoSnapshot
	}
	before = ensureProviderStates(before)
	if len(before.Providers) == 0 {
		return Receipt{}, fmt.Errorf("snapshot %s has no services to compare", before.ID)
	}
	providers := e.active()
	now := e.now()
	cc := CompareContext{
		Session:  SessionWindow{StartedAt: before.TakenAt, CheckedAt: now},
		Location: e.location(),
	}
	var outputs []ProviderOutput
	var skipped []string
	for _, state := range before.Providers {
		if !state.Checked {
			continue
		}
		p := findProvider(providers, state.ID)
		if p == nil {
			name := state.DisplayName
			if name == "" {
				name = state.ID
			}
			skipped = append(skipped, name+" was in the snapshot, and this run does not have that provider.")
			continue
		}
		useLocation(p, e.location())
		current, err := p.ReadCurrent(ctx, state)
		if err != nil {
			return Receipt{}, err
		}
		out, err := p.BuildChanges(state, current, cc)
		if err != nil {
			return Receipt{}, err
		}
		outputs = append(outputs, out)
	}
	receipt := assembleReceipt(before, outputs, nil, ReceiptOptions{
		ID:          opt.ReceiptID,
		Now:         now,
		Location:    e.location(),
		Claims:      opt.Claims,
		CheckClaims: opt.CheckClaims,
	})
	if len(skipped) > 0 {
		receipt.Warnings = compactStrings(append(skipped, receipt.Warnings...))
	}
	return receipt, nil
}

type snapshotProjector interface {
	ProjectSnapshot(dst *Snapshot, state ServiceState)
}

func (e *Engine) active() []Provider {
	if e == nil {
		return nil
	}
	if len(e.Providers) > 0 {
		return e.Providers
	}
	var out []Provider
	if e.Calendar != nil {
		out = append(out, NewCalendarProvider(e.Calendar))
	}
	if e.Drive != nil {
		out = append(out, NewDriveProvider(e.Drive))
	}
	return out
}

func providerIDs(opt SnapshotOptions, providers []Provider) ([]string, error) {
	if len(opt.Only) > 0 {
		return append([]string(nil), opt.Only...), nil
	}
	var ids []string
	if opt.Calendar {
		ids = append(ids, string(ServiceCalendar))
	}
	if opt.Drive {
		ids = append(ids, string(ServiceDrive))
	}
	if opt.Extras {
		for _, p := range providers {
			if p.ID() == string(ServiceCalendar) || p.ID() == string(ServiceDrive) {
				continue
			}
			ids = append(ids, p.ID())
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("choose at least one provider")
	}
	return ids, nil
}

type locationUser interface {
	UseLocation(*time.Location)
}

func useLocation(p Provider, loc *time.Location) {
	if u, ok := p.(locationUser); ok {
		u.UseLocation(loc)
	}
}

func findProvider(providers []Provider, id string) Provider {
	for _, p := range providers {
		if p.ID() == id {
			return p
		}
	}
	return nil
}

func snapshotRequest(opt SnapshotOptions, loc *time.Location, now time.Time) SnapshotRequest {
	params := map[string]string{
		"calendar_id": opt.CalendarID,
	}
	if !opt.WindowStart.IsZero() {
		params["window_start"] = opt.WindowStart.UTC().Format(time.RFC3339)
	}
	if !opt.WindowEnd.IsZero() {
		params["window_end"] = opt.WindowEnd.UTC().Format(time.RFC3339)
	}
	if opt.DriveQuery != "" {
		params["drive_query"] = opt.DriveQuery
	}
	if opt.MaxDriveFiles > 0 {
		params["max_drive_files"] = fmt.Sprintf("%d", opt.MaxDriveFiles)
	}
	if opt.SkipSyncToken {
		params["skip_sync_token"] = "1"
	}
	return SnapshotRequest{Now: now, Location: loc, Params: params}
}

func ensureProviderStates(before Snapshot) Snapshot {
	if len(before.Providers) > 0 {
		return before
	}
	if before.Calendar.Checked {
		payload, err := encodePayload(before.Calendar)
		if err == nil {
			before.Providers = append(before.Providers, ServiceState{
				ID:          string(ServiceCalendar),
				DisplayName: ServiceCalendar.Display(),
				Checked:     true,
				TakenAt:     before.TakenAt,
				TimeZone:    before.TimeZone,
				Cursor:      before.Calendar.SyncToken,
				ItemCount:   len(before.Calendar.Events),
				Payload:     payload,
			})
		}
	}
	if before.Drive.Checked {
		payload, err := encodePayload(before.Drive)
		if err == nil {
			before.Providers = append(before.Providers, ServiceState{
				ID:          string(ServiceDrive),
				DisplayName: ServiceDrive.Display(),
				Checked:     true,
				TakenAt:     before.TakenAt,
				TimeZone:    before.TimeZone,
				Cursor:      before.Drive.StartPageToken,
				ItemCount:   len(before.Drive.Files),
				Payload:     payload,
			})
		}
	}
	return before
}

func normalizeSnapshotOptions(opt SnapshotOptions, now time.Time) SnapshotOptions {
	if !opt.Calendar && !opt.Drive && len(opt.Only) == 0 && !opt.Extras {
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
