package lifediff

import (
	"fmt"
	"strings"
	"time"
)

func summarizeCalendar(kind ChangeKind, before, after CalendarEvent, fields []FieldChange, loc *time.Location) string {
	switch kind {
	case KindAdded:
		return fmt.Sprintf("Added %s on %s.", quoteName(after.Summary), formatSpan(after, loc))
	case KindRemoved:
		ev := before
		return fmt.Sprintf("Removed %s, which was on %s.", quoteName(ev.Summary), formatSpan(ev, loc))
	case KindModified:
		return summarizeCalendarEdit(before, after, fields, loc)
	default:
		panic(fmt.Sprintf("lifediff: unhandled change kind %q", kind))
	}
}

func summarizeCalendarEdit(before, after CalendarEvent, fields []FieldChange, loc *time.Location) string {
	name := displayName(after.Summary)
	if strings.TrimSpace(after.Summary) == "" {
		name = displayName(before.Summary)
	}
	oldName := displayName(before.Summary)
	var sentences []string

	_, startChanged := findField(fields, fieldStart)
	_, titleChanged := findField(fields, fieldTitle)
	if startChanged {
		sentences = append(sentences, fmt.Sprintf(
			"Moved %s from %s to %s.",
			quoteName(oldName),
			formatEventTime(before.Start, loc),
			formatEventTime(after.Start, loc),
		))
	}
	if titleChanged {
		sentences = append(sentences, fmt.Sprintf("Renamed %s to %s.", quoteName(before.Summary), quoteName(after.Summary)))
	}
	if _, ok := findField(fields, fieldEnd); ok && shouldMentionEnd(before, after, startChanged, loc) {
		sentences = append(sentences, fmt.Sprintf(
			"Changed when %s ends from %s to %s.",
			quoteName(name),
			formatEventTime(before.End, loc),
			formatEventTime(after.End, loc),
		))
	}
	if f, ok := findField(fields, fieldLocation); ok {
		sentences = append(sentences, locationSentence(name, f))
	}
	if _, ok := findField(fields, fieldNotes); ok {
		sentences = append(sentences, fmt.Sprintf("Updated the notes on %s.", quoteName(name)))
	}
	if _, ok := findField(fields, fieldGuests); ok {
		sentences = append(sentences, fmt.Sprintf("Changed the guests on %s.", quoteName(name)))
	}
	if f, ok := findField(fields, fieldStatus); ok {
		sentences = append(sentences, fmt.Sprintf("Changed the status of %s from %s to %s.", quoteName(name), shown(f.Before), shown(f.After)))
	}
	if len(sentences) == 0 {
		return fmt.Sprintf("Updated %s.", quoteName(name))
	}
	return strings.Join(sentences, " ")
}

func shouldMentionEnd(before, after CalendarEvent, startChanged bool, loc *time.Location) bool {
	if !startChanged {
		return true
	}
	bd, bok := eventDuration(before, loc)
	ad, aok := eventDuration(after, loc)
	if !bok || !aok {
		return true
	}
	return bd != ad
}

func locationSentence(name string, f FieldChange) string {
	switch {
	case strings.TrimSpace(f.Before) == "" && strings.TrimSpace(f.After) != "":
		return fmt.Sprintf("Set the location of %s to %s.", quoteName(name), strconvQuote(f.After))
	case strings.TrimSpace(f.After) == "" && strings.TrimSpace(f.Before) != "":
		return fmt.Sprintf("Cleared the location of %s (it was %s).", quoteName(name), strconvQuote(f.Before))
	default:
		return fmt.Sprintf("Changed the location of %s from %s to %s.", quoteName(name), strconvQuote(f.Before), strconvQuote(f.After))
	}
}

func strconvQuote(s string) string {
	if strings.TrimSpace(s) == "" {
		return quoteName("")
	}
	return quoteName(s)
}

func summarizeDrive(kind ChangeKind, before, after *DriveFile, fields []FieldChange, unknownBefore bool) string {
	name := driveName(before, after)
	switch kind {
	case KindAdded:
		if after != nil && wasRestored(fields) {
			return fmt.Sprintf("Restored %s from trash.", quoteName(name))
		}
		if after != nil && isFolder(after.MimeType) {
			return fmt.Sprintf("Added the folder %s to Drive.", quoteName(after.Name))
		}
		kindLabel := "file"
		if after != nil {
			kindLabel = friendlyType(after.MimeType)
		}
		return fmt.Sprintf("Added %s (%s) to Drive.", quoteName(name), kindLabel)
	case KindRemoved:
		if trashed, ok := findField(fields, fieldTrashed); ok && trashed.After == "in trash" {
			return fmt.Sprintf("Moved %s to trash.", quoteName(name))
		}
		return fmt.Sprintf("Removed %s from Drive.", quoteName(name))
	case KindModified:
		if unknownBefore {
			return fmt.Sprintf("Changed %s, but the snapshot did not include its earlier details.", quoteName(name))
		}
		return summarizeDriveEdit(name, fields)
	default:
		panic(fmt.Sprintf("lifediff: unhandled change kind %q", kind))
	}
}

func wasRestored(fields []FieldChange) bool {
	f, ok := findField(fields, fieldTrashed)
	return ok && f.Before == "in trash" && f.After == "not in trash"
}

func driveName(before, after *DriveFile) string {
	if after != nil && strings.TrimSpace(after.Name) != "" {
		return after.Name
	}
	if before != nil {
		return before.Name
	}
	return ""
}

func summarizeDriveEdit(name string, fields []FieldChange) string {
	var sentences []string
	if f, ok := findField(fields, fieldName); ok {
		sentences = append(sentences, fmt.Sprintf("Renamed %s to %s.", quoteName(f.Before), quoteName(f.After)))
	}
	if _, ok := findField(fields, fieldContent); ok {
		sentences = append(sentences, fmt.Sprintf("Updated the contents of %s.", quoteName(name)))
	}
	if _, ok := findField(fields, fieldFolder); ok {
		sentences = append(sentences, fmt.Sprintf("Moved %s to a different folder.", quoteName(name)))
	}
	if f, ok := findField(fields, fieldType); ok {
		sentences = append(sentences, fmt.Sprintf("Changed the type of %s from %s to %s.", quoteName(name), shown(f.Before), shown(f.After)))
	}
	if len(sentences) == 0 {
		return fmt.Sprintf("Updated %s.", quoteName(name))
	}
	return strings.Join(sentences, " ")
}

func shown(s string) string {
	if strings.TrimSpace(s) == "" {
		return "blank"
	}
	return s
}

func contentText(f DriveFile, loc *time.Location) string {
	var parts []string
	if f.Version > 0 {
		parts = append(parts, fmt.Sprintf("version %d", f.Version))
	}
	if !f.ModifiedTime.IsZero() {
		parts = append(parts, "saved "+formatInstant(f.ModifiedTime, loc))
	}
	if f.MD5 != "" {
		short := f.MD5
		if len(short) > 8 {
			short = short[:8]
		}
		parts = append(parts, "checksum "+short)
	}
	if f.Size > 0 {
		parts = append(parts, formatBytes(f.Size))
	}
	if len(parts) == 0 {
		return "no version details"
	}
	return strings.Join(parts, ", ")
}

func folderText(ids []string, names map[string]string) string {
	if len(ids) == 0 {
		return "no folder"
	}
	parts := make([]string, 0, len(ids))
	for _, id := range sortedCopy(ids) {
		if n := names[id]; n != "" {
			parts = append(parts, strconvQuote(n))
			continue
		}
		parts = append(parts, "folder "+id)
	}
	return strings.Join(parts, ", ")
}

func describeFile(f DriveFile, names map[string]string, loc *time.Location) string {
	parts := []string{friendlyType(f.MimeType)}
	if len(f.Parents) > 0 {
		parts = append(parts, "in "+folderText(f.Parents, names))
	}
	if text := contentText(f, loc); text != "no version details" {
		parts = append(parts, text)
	}
	return strings.Join(parts, ", ")
}

func isCancelled(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func createdDuringSession(f DriveFile, sessionStart time.Time) bool {
	if f.CreatedTime.IsZero() {
		return false
	}
	return !f.CreatedTime.Before(sessionStart.Add(-highSkew))
}
