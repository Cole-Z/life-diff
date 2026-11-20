package lifediff

import (
	"fmt"
	"time"
)

const (
	// highSkew covers clock differences between Google and this computer.
	highSkew = 2 * time.Minute
	// mediumGrace is the wider band still treated as "close to the session".
	mediumGrace = 15 * time.Minute
)

// ConfidenceAt rates a service timestamp against the session window.
// A zero timestamp is medium: the change was observed, but the service did not date it.
func ConfidenceAt(occurred, sessionStart, sessionEnd time.Time) Confidence {
	if occurred.IsZero() {
		return ConfidenceMedium
	}
	if !occurred.Before(sessionStart.Add(-highSkew)) && !occurred.After(sessionEnd.Add(highSkew)) {
		return ConfidenceHigh
	}
	if !occurred.Before(sessionStart.Add(-mediumGrace)) && occurred.Before(sessionStart) {
		return ConfidenceMedium
	}
	if occurred.Before(sessionStart) {
		return ConfidenceLow
	}
	return ConfidenceMedium
}

func confidenceReason(level Confidence) string {
	switch level {
	case ConfidenceHigh:
		return "The service recorded this during the session, between the snapshot and this check."
	case ConfidenceMedium:
		return "The timing is unclear or only close to the session, so this check is partly sure."
	case ConfidenceLow:
		return "The service dates this before the snapshot, so it may not have been done in this session."
	default:
		panic(fmt.Sprintf("lifediff: unhandled confidence %q", level))
	}
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}

func loadLocation(name string) *time.Location {
	if name == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

func formatInstant(t time.Time, loc *time.Location) string {
	if t.IsZero() {
		return ""
	}
	if loc == nil {
		loc = time.UTC
	}
	return t.In(loc).Format("Mon, Jan 2, 3:04 PM")
}

func formatAllDay(date string) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date + " (all day)"
	}
	return t.Format("Mon, Jan 2") + " (all day)"
}

func formatEventTime(t EventTime, loc *time.Location) string {
	if t.IsAllDay() {
		return formatAllDay(t.Date)
	}
	return formatInstant(t.DateTime, loc)
}

func sameDay(a, b time.Time, loc *time.Location) bool {
	if loc == nil {
		loc = time.UTC
	}
	aa := a.In(loc)
	bb := b.In(loc)
	return aa.Year() == bb.Year() && aa.YearDay() == bb.YearDay()
}

// formatSpan renders when an event happens, in plain language.
func formatSpan(ev CalendarEvent, loc *time.Location) string {
	if ev.Start.IsAllDay() {
		start := formatAllDay(ev.Start.Date)
		if ev.End.Date == "" || ev.End.Date == nextDate(ev.Start.Date) {
			return start
		}
		// Calendar all-day end dates are exclusive.
		last := previousDate(ev.End.Date)
		if last == "" || last == ev.Start.Date {
			return start
		}
		return start + " through " + formatAllDay(last)
	}
	if ev.Start.DateTime.IsZero() {
		return "an unknown time"
	}
	start := formatInstant(ev.Start.DateTime, loc)
	if ev.End.DateTime.IsZero() {
		return start
	}
	end := ev.End.DateTime
	if loc == nil {
		loc = time.UTC
	}
	if sameDay(ev.Start.DateTime, end, loc) {
		return start + "–" + end.In(loc).Format("3:04 PM")
	}
	return start + " to " + formatInstant(end, loc)
}

func nextDate(date string) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

func previousDate(date string) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, -1).Format("2006-01-02")
}

func (ev CalendarEvent) span(loc *time.Location) (time.Time, time.Time, bool) {
	if loc == nil {
		loc = time.UTC
	}
	if ev.Start.IsAllDay() {
		start, err := time.ParseInLocation("2006-01-02", ev.Start.Date, loc)
		if err != nil {
			return time.Time{}, time.Time{}, false
		}
		endDate := ev.End.Date
		if endDate == "" {
			endDate = nextDate(ev.Start.Date)
		}
		end, err := time.ParseInLocation("2006-01-02", endDate, loc)
		if err != nil || !end.After(start) {
			end = start.AddDate(0, 0, 1)
		}
		return start, end, true
	}
	if ev.Start.DateTime.IsZero() {
		return time.Time{}, time.Time{}, false
	}
	end := ev.End.DateTime
	if end.IsZero() {
		end = ev.Start.DateTime.Add(time.Hour)
	}
	return ev.Start.DateTime, end, true
}

func overlapsWindow(ev CalendarEvent, start, end time.Time, loc *time.Location) bool {
	es, ee, ok := ev.span(loc)
	if !ok {
		return false
	}
	return ee.After(start) && es.Before(end)
}

func eventDuration(ev CalendarEvent, loc *time.Location) (time.Duration, bool) {
	start, end, ok := ev.span(loc)
	if !ok {
		return 0, false
	}
	return end.Sub(start), true
}

func sameEventTime(a, b EventTime) bool {
	if a.IsAllDay() || b.IsAllDay() {
		return a.Date == b.Date && a.DateTime.Equal(b.DateTime)
	}
	return a.DateTime.Equal(b.DateTime)
}
