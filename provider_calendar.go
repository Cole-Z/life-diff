package lifediff

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// NewCalendarProvider wraps a read-only Calendar reader.
func NewCalendarProvider(r CalendarReader) Provider {
	return &calendarProvider{reader: r}
}

type calendarProvider struct {
	reader CalendarReader
	loc    *time.Location
}

// UseLocation sets the zone used to decide whether an incremental Calendar
// change still overlaps the snapshot window. The engine calls it. A provider
// that does not need a zone does not implement this method.
func (p *calendarProvider) UseLocation(loc *time.Location) {
	if p != nil {
		p.loc = loc
	}
}

func (p *calendarProvider) ID() string { return string(ServiceCalendar) }

func (p *calendarProvider) DisplayName() string { return ServiceCalendar.Display() }

func (p *calendarProvider) Snapshot(ctx context.Context, req SnapshotRequest) (ServiceState, error) {
	if p == nil || p.reader == nil {
		return ServiceState{}, fmt.Errorf("calendar reader is not configured")
	}
	calID := param(req, "calendar_id")
	if calID == "" {
		calID = "primary"
	}
	start := req.Now.Add(-24 * time.Hour)
	end := req.Now.AddDate(0, 0, 90)
	if v := param(req, "window_start"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return ServiceState{}, fmt.Errorf("calendar window start: %w", err)
		}
		start = t
	}
	if v := param(req, "window_end"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return ServiceState{}, fmt.Errorf("calendar window end: %w", err)
		}
		end = t
	}
	events, err := p.reader.ListWindow(ctx, calID, start, end)
	if err != nil {
		return ServiceState{}, fmt.Errorf("read calendar: %w", err)
	}
	snap := CalendarSnapshot{
		Checked:     true,
		CalendarID:  calID,
		WindowStart: start.UTC(),
		WindowEnd:   end.UTC(),
		Events:      activeEvents(events),
	}
	state := ServiceState{
		ID:          p.ID(),
		DisplayName: p.DisplayName(),
		Checked:     true,
		TakenAt:     req.Now.UTC(),
		TimeZone:    locationName(req.Location),
		ItemCount:   len(snap.Events),
	}
	if param(req, "skip_sync_token") != "1" {
		token, err := p.reader.CurrentSyncToken(ctx, calID)
		if err != nil {
			state.Warnings = append(state.Warnings, "Calendar did not provide a sync token. The next check will read the same time window again.")
		} else {
			snap.SyncToken = token
			state.Cursor = token
		}
	}
	payload, err := encodePayload(snap)
	if err != nil {
		return ServiceState{}, err
	}
	state.Payload = payload
	return state, nil
}

func (p *calendarProvider) ReadCurrent(ctx context.Context, before ServiceState) (ServiceState, error) {
	if p == nil || p.reader == nil {
		return ServiceState{}, fmt.Errorf("calendar reader is not configured")
	}
	var snap CalendarSnapshot
	if err := decodePayload(before.Payload, &snap); err != nil {
		return ServiceState{}, err
	}
	loc := p.loc
	if loc == nil {
		loc = loadLocation(before.TimeZone)
	}
	events, mode, warn, err := p.read(ctx, snap, loc)
	if err != nil {
		return ServiceState{}, err
	}
	after := CalendarAfter{Events: events, Mode: mode}
	payload, err := encodePayload(after)
	if err != nil {
		return ServiceState{}, err
	}
	state := ServiceState{
		ID:          p.ID(),
		DisplayName: p.DisplayName(),
		Checked:     true,
		Mode:        mode,
		ItemCount:   len(events),
		Payload:     payload,
	}
	if warn != "" {
		state.Warnings = append(state.Warnings, warn)
	}
	return state, nil
}

func (p *calendarProvider) read(ctx context.Context, snap CalendarSnapshot, loc *time.Location) ([]CalendarEvent, string, string, error) {
	if snap.SyncToken != "" {
		events, err := p.reader.ListSyncChanges(ctx, snap.CalendarID, snap.SyncToken)
		if err == nil {
			merged := applySync(snap.Events, events, snap.WindowStart, snap.WindowEnd, loc)
			return merged, CalendarDiffSync, "", nil
		}
		warn := "Calendar incremental sync failed (" + trimErr(err) + "). Life Diff read the same time window again."
		events, werr := p.reader.ListWindow(ctx, snap.CalendarID, snap.WindowStart, snap.WindowEnd)
		if werr != nil {
			return nil, "", "", fmt.Errorf("read calendar: %w", werr)
		}
		return events, CalendarDiffWindow, warn, nil
	}
	events, err := p.reader.ListWindow(ctx, snap.CalendarID, snap.WindowStart, snap.WindowEnd)
	if err != nil {
		return nil, "", "", fmt.Errorf("read calendar: %w", err)
	}
	return events, CalendarDiffWindow, "", nil
}

func locationName(loc *time.Location) string {
	if loc == nil {
		return ""
	}
	return loc.String()
}

func (p *calendarProvider) BuildChanges(before, current ServiceState, cc CompareContext) (ProviderOutput, error) {
	var snap CalendarSnapshot
	if err := decodePayload(before.Payload, &snap); err != nil {
		return ProviderOutput{}, err
	}
	var after CalendarAfter
	if err := decodePayload(current.Payload, &after); err != nil {
		return ProviderOutput{}, err
	}
	return calendarOutput(snap, &after, cc.Location, current.Warnings), nil
}

func (p *calendarProvider) ProjectSnapshot(dst *Snapshot, state ServiceState) {
	var snap CalendarSnapshot
	if err := decodePayload(state.Payload, &snap); err != nil {
		return
	}
	dst.Calendar = snap
}

func calendarOutput(snap CalendarSnapshot, after *CalendarAfter, loc *time.Location, extra []string) ProviderOutput {
	out := ProviderOutput{Warnings: append([]string{}, extra...)}
	if !snap.Checked {
		return out
	}
	if after == nil {
		out.Warnings = append(out.Warnings, "Calendar was not compared on this check.")
		return out
	}
	if loc == nil {
		loc = time.UTC
	}
	info := &ReceiptCalendar{
		CalendarID:  snap.CalendarID,
		WindowStart: snap.WindowStart,
		WindowEnd:   snap.WindowEnd,
		DiffMode:    after.Mode,
	}
	if after.Mode == CalendarDiffWindow {
		out.Warnings = append(out.Warnings, "Calendar was compared by reading the same time window again. An event moved outside that window shows up as removed.")
	}
	out.Changes = diffCalendar(Snapshot{Calendar: snap}, after.Events, loc)
	out.Calendar = info
	out.Info = ProviderInfo{
		ID:          string(ServiceCalendar),
		DisplayName: ServiceCalendar.Display(),
		DiffMode:    after.Mode,
		Intro:       calendarIntro(Receipt{Calendar: info}, loc),
	}
	return out
}

func atoiParam(s string) int {
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
