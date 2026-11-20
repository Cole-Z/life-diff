package lifediff

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// ReceiptOptions controls claim checking and the clock used for a receipt.
type ReceiptOptions struct {
	ID          string
	Now         time.Time
	Location    *time.Location
	Claims      []ClaimInput
	CheckClaims bool
}

// BuildReceipt compares a stored snapshot with a later read.
// It does not call Google. A zero Now uses the after-state observation time.
func BuildReceipt(before Snapshot, after AfterState, opt ReceiptOptions) Receipt {
	now := opt.Now
	if now.IsZero() {
		now = after.ObservedAt
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	loc := opt.Location
	if loc == nil {
		loc = loadLocation(before.TimeZone)
	}
	id := opt.ID
	if id == "" {
		id = newID("rcpt", now)
	}

	var outputs []ProviderOutput
	if before.Calendar.Checked {
		outputs = append(outputs, calendarOutput(before.Calendar, after.Calendar, loc, nil))
	}
	if before.Drive.Checked {
		outputs = append(outputs, driveOutput(before.Drive, before.TakenAt, after.Drive, loc, nil))
	}
	opt.Now = now
	opt.Location = loc
	opt.ID = id
	return assembleReceipt(before, outputs, after.Warnings, opt)
}

// assembleReceipt turns provider outputs into one receipt.
// readWarnings are messages from the later read that are not already on an output.
func assembleReceipt(before Snapshot, outputs []ProviderOutput, readWarnings []string, opt ReceiptOptions) Receipt {
	now := opt.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	loc := opt.Location
	if loc == nil {
		loc = loadLocation(before.TimeZone)
	}
	id := opt.ID
	if id == "" {
		id = newID("rcpt", now)
	}

	warnings := append([]string(nil), before.Warnings...)
	warnings = append(warnings, readWarnings...)

	var changes []Change
	var notes []string
	var providers []ProviderInfo
	var calInfo *ReceiptCalendar
	var driveInfo *ReceiptDrive
	for _, out := range outputs {
		if out.Info.ID != "" {
			providers = append(providers, out.Info)
		}
		changes = append(changes, out.Changes...)
		notes = append(notes, out.Notes...)
		warnings = append(warnings, out.Warnings...)
		if out.Calendar != nil {
			calInfo = out.Calendar
		}
		if out.Drive != nil {
			driveInfo = out.Drive
		}
	}

	sessionStart := before.TakenAt
	sessionEnd := now
	for i := range changes {
		occurred := time.Time{}
		if changes[i].OccurredAt != nil {
			occurred = *changes[i].OccurredAt
		}
		level := ConfidenceAt(occurred, sessionStart, sessionEnd)
		changes[i].Confidence = level
		changes[i].ConfidenceReason = confidenceReason(level)
		if changes[i].Fields == nil {
			changes[i].Fields = []FieldChange{}
		}
	}
	sort.SliceStable(changes, func(i, j int) bool {
		return lessChange(changes[i], changes[j])
	})

	receipt := Receipt{
		SchemaVersion: SchemaVersion,
		ID:            id,
		GeneratedAt:   now,
		ReadOnly:      true,
		Producer: Producer{
			Name:    "lifediff",
			Version: Version,
		},
		Snapshot: ReceiptSnapshot{
			ID:      before.ID,
			TakenAt: before.TakenAt,
		},
		ComparedAt: now,
		TimeZone:   loc.String(),
		Session: SessionWindow{
			StartedAt: sessionStart,
			CheckedAt: now,
		},
		Providers:     providers,
		Calendar:      calInfo,
		Drive:         driveInfo,
		Changes:       changes,
		ClaimsChecked: opt.CheckClaims,
		Claims:        []ClaimResult{},
		Notes:         append(baseNotes(loc), notes...),
		Warnings:      compactStrings(warnings),
	}
	if opt.CheckClaims {
		applyClaims(&receipt, opt.Claims)
	}
	receipt.Counts = tally(receipt)
	if receipt.Changes == nil {
		receipt.Changes = []Change{}
	}
	return receipt
}

func baseNotes(loc *time.Location) []string {
	zone := "UTC"
	if loc != nil && loc.String() != "" {
		zone = loc.String()
	}
	return []string{
		"This receipt is from the services Life Diff read, not from what the agent said.",
		"Life Diff only read data. It did not change the connected accounts.",
		"Times are shown in " + zone + ".",
	}
}

func tally(r Receipt) Counts {
	var c Counts
	for _, ch := range r.Changes {
		switch ch.Kind {
		case KindAdded:
			c.Added++
		case KindRemoved:
			c.Removed++
		case KindModified:
			c.Modified++
		default:
			panic(fmt.Sprintf("lifediff: unhandled change kind %q", ch.Kind))
		}
		if ch.ClaimStatus == ClaimUnclaimed {
			c.UnclaimedChanges++
		}
	}
	for _, claim := range r.Claims {
		switch claim.Status {
		case ClaimVerified:
			c.VerifiedClaims++
		case ClaimMissing:
			c.MissingClaims++
		case ClaimUnclaimed:
			// Claims themselves are verified or missing. Unclaimed lives on changes.
		default:
			panic(fmt.Sprintf("lifediff: unhandled claim status %q", claim.Status))
		}
	}
	return c
}

func lessChange(a, b Change) bool {
	if serviceOrder(a.Service) != serviceOrder(b.Service) {
		return serviceOrder(a.Service) < serviceOrder(b.Service)
	}
	if a.Service != b.Service {
		return a.Service < b.Service
	}
	if confidenceOrder(a.Confidence) != confidenceOrder(b.Confidence) {
		return confidenceOrder(a.Confidence) < confidenceOrder(b.Confidence)
	}
	at, bt := time.Time{}, time.Time{}
	if a.OccurredAt != nil {
		at = *a.OccurredAt
	}
	if b.OccurredAt != nil {
		bt = *b.OccurredAt
	}
	switch {
	case at.IsZero() && !bt.IsZero():
		return false
	case !at.IsZero() && bt.IsZero():
		return true
	case !at.Equal(bt):
		return at.Before(bt)
	}
	if a.ResourceName != b.ResourceName {
		return a.ResourceName < b.ResourceName
	}
	return a.ID < b.ID
}

func confidenceOrder(c Confidence) int {
	switch c {
	case ConfidenceHigh:
		return 0
	case ConfidenceMedium:
		return 1
	case ConfidenceLow:
		return 2
	default:
		panic(fmt.Sprintf("lifediff: unhandled confidence %q", c))
	}
}

func serviceOrder(s Service) int {
	switch s {
	case ServiceCalendar:
		return 0
	case ServiceDrive:
		return 1
	case ServiceGmail:
		return 2
	default:
		// Service is an open set of provider ids. Unknown ids sort after
		// the built-in ones, then by name in lessChange.
		return 3
	}
}

func diffCalendar(before Snapshot, after []CalendarEvent, loc *time.Location) []Change {
	prev := indexEvents(before.Calendar.Events)
	next := indexEvents(after)
	var out []Change
	for _, id := range sortedKeys(prev) {
		old := prev[id]
		cur, ok := next[id]
		if !ok || isCancelled(cur.Status) {
			occurred := time.Time{}
			if ok {
				occurred = cur.Updated
			}
			name := displayName(old.Summary)
			fields := calendarSnapshotFields(old, loc)
			out = append(out, Change{
				ID:           changeID(ServiceCalendar, id, KindRemoved),
				Service:      ServiceCalendar,
				Kind:         KindRemoved,
				ResourceID:   id,
				ResourceName: name,
				Summary:      summarizeCalendar(KindRemoved, old, cur, fields, loc),
				Fields:       fields,
				OccurredAt:   timePtr(occurred),
				Link:         safeLink(old.Link),
			})
			continue
		}
		fields := calendarFieldDiff(old, cur, loc)
		if len(fields) == 0 {
			continue
		}
		name := displayName(cur.Summary)
		if strings.TrimSpace(cur.Summary) == "" {
			name = displayName(old.Summary)
		}
		out = append(out, Change{
			ID:           changeID(ServiceCalendar, id, KindModified),
			Service:      ServiceCalendar,
			Kind:         KindModified,
			ResourceID:   id,
			ResourceName: name,
			Summary:      summarizeCalendar(KindModified, old, cur, fields, loc),
			Fields:       fields,
			OccurredAt:   timePtr(cur.Updated),
			Link:         firstLink(cur.Link, old.Link),
		})
	}
	for _, id := range sortedKeys(next) {
		cur := next[id]
		if _, ok := prev[id]; ok || isCancelled(cur.Status) {
			continue
		}
		fields := calendarSnapshotFields(cur, loc)
		// An addition shows the new values in After.
		for i := range fields {
			fields[i].After = fields[i].Before
			fields[i].Before = ""
		}
		out = append(out, Change{
			ID:           changeID(ServiceCalendar, id, KindAdded),
			Service:      ServiceCalendar,
			Kind:         KindAdded,
			ResourceID:   id,
			ResourceName: displayName(cur.Summary),
			Summary:      summarizeCalendar(KindAdded, CalendarEvent{}, cur, fields, loc),
			Fields:       fields,
			OccurredAt:   timePtr(cur.Updated),
			Link:         safeLink(cur.Link),
		})
	}
	return out
}

func calendarFieldDiff(before, after CalendarEvent, loc *time.Location) []FieldChange {
	var fields []FieldChange
	if before.Summary != after.Summary {
		fields = append(fields, edit(fieldTitle, before.Summary, after.Summary))
	}
	if !sameEventTime(before.Start, after.Start) {
		fields = append(fields, edit(fieldStart, formatEventTime(before.Start, loc), formatEventTime(after.Start, loc)))
	}
	if !sameEventTime(before.End, after.End) {
		fields = append(fields, edit(fieldEnd, formatEventTime(before.End, loc), formatEventTime(after.End, loc)))
	}
	if before.Location != after.Location {
		fields = append(fields, edit(fieldLocation, before.Location, after.Location))
	}
	if normNewlines(before.Description) != normNewlines(after.Description) {
		fields = append(fields, edit(fieldNotes, before.Description, after.Description))
	}
	if !sameStrings(before.Attendees, after.Attendees) {
		fields = append(fields, edit(fieldGuests, joinPeople(before.Attendees), joinPeople(after.Attendees)))
	}
	if statusLabel(before.Status) != statusLabel(after.Status) {
		fields = append(fields, edit(fieldStatus, statusLabel(before.Status), statusLabel(after.Status)))
	}
	return fields
}

func calendarSnapshotFields(ev CalendarEvent, loc *time.Location) []FieldChange {
	fields := []FieldChange{
		edit(fieldTitle, ev.Summary, ""),
		edit(fieldStart, formatEventTime(ev.Start, loc), ""),
	}
	if !ev.End.DateTime.IsZero() || ev.End.Date != "" {
		fields = append(fields, edit(fieldEnd, formatEventTime(ev.End, loc), ""))
	}
	if ev.Location != "" {
		fields = append(fields, edit(fieldLocation, ev.Location, ""))
	}
	if ev.Description != "" {
		fields = append(fields, edit(fieldNotes, ev.Description, ""))
	}
	if len(ev.Attendees) > 0 {
		fields = append(fields, edit(fieldGuests, joinPeople(ev.Attendees), ""))
	}
	return fields
}

func statusLabel(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "", "confirmed":
		return "confirmed"
	case "tentative":
		return "tentative"
	case "cancelled", "canceled":
		return "cancelled"
	default:
		return strings.ToLower(strings.TrimSpace(status))
	}
}

func diffDrive(before Snapshot, after DriveAfter, loc *time.Location) ([]Change, *ReceiptDrive) {
	info := &ReceiptDrive{
		Query:             before.Drive.Query,
		DiffMode:          after.Mode,
		TruncatedSnapshot: before.Drive.Truncated,
		TruncatedChanges:  after.Truncated,
	}
	namesBefore := fileNames(before.Drive.Files)
	switch after.Mode {
	case DriveDiffChanges:
		return diffDriveChanges(before.Drive.Files, after.Changes, namesBefore, before.TakenAt, loc), info
	case DriveDiffList:
		suppress := before.Drive.Truncated || after.Truncated
		info.SuppressedRemovals = suppress
		return diffDriveLists(before.Drive.Files, after.Files, namesBefore, before.TakenAt, loc, suppress), info
	default:
		if after.Mode == "" {
			info.DiffMode = DriveDiffList
			suppress := before.Drive.Truncated || after.Truncated
			info.SuppressedRemovals = suppress
			return diffDriveLists(before.Drive.Files, after.Files, namesBefore, before.TakenAt, loc, suppress), info
		}
		panic(fmt.Sprintf("lifediff: unhandled drive diff mode %q", after.Mode))
	}
}

func diffDriveChanges(before []DriveFile, changes []DriveChange, names map[string]string, sessionStart time.Time, loc *time.Location) []Change {
	prev := indexFiles(before)
	latest, order := collapseChanges(changes)
	afterNames := copyNames(names)
	for _, id := range order {
		ch := latest[id]
		if ch.File != nil && ch.File.Name != "" {
			afterNames[ch.File.ID] = ch.File.Name
		}
	}
	var out []Change
	for _, id := range order {
		ch := latest[id]
		old, ok := prev[id]
		out = append(out, driveChangeFrom(id, ok, old, ch, names, afterNames, sessionStart, loc))
	}
	return compactChanges(out)
}

func driveChangeFrom(id string, hadBefore bool, old DriveFile, ch DriveChange, beforeNames, afterNames map[string]string, sessionStart time.Time, loc *time.Location) Change {
	occurred := ch.Time
	if occurred.IsZero() && ch.File != nil {
		occurred = ch.File.ModifiedTime
	}
	if ch.Removed || (ch.File != nil && ch.File.Trashed && (!hadBefore || !old.Trashed)) {
		name := ""
		link := ""
		var beforePtr *DriveFile
		if hadBefore {
			name = old.Name
			link = old.Link
			beforePtr = &old
		}
		if ch.File != nil && ch.File.Name != "" {
			name = ch.File.Name
			if ch.File.Link != "" {
				link = ch.File.Link
			}
		}
		fields := []FieldChange{}
		if ch.File != nil && ch.File.Trashed {
			beforeTrash := "not in trash"
			if hadBefore && old.Trashed {
				beforeTrash = "in trash"
			}
			if !hadBefore {
				beforeTrash = "not in the snapshot"
			}
			fields = append(fields, edit(fieldTrashed, beforeTrash, "in trash"))
		}
		kind := KindRemoved
		var afterPtr *DriveFile
		if ch.File != nil {
			afterPtr = ch.File
		}
		return Change{
			ID:           changeID(ServiceDrive, id, kind),
			Service:      ServiceDrive,
			Kind:         kind,
			ResourceID:   id,
			ResourceName: displayName(name),
			Summary:      summarizeDrive(kind, beforePtr, afterPtr, fields, !hadBefore),
			Fields:       fields,
			OccurredAt:   timePtr(occurred),
			Link:         safeLink(link),
		}
	}

	if ch.File == nil {
		return Change{}
	}
	file := *ch.File
	if !hadBefore {
		if file.Trashed {
			return Change{
				ID:           changeID(ServiceDrive, id, KindRemoved),
				Service:      ServiceDrive,
				Kind:         KindRemoved,
				ResourceID:   id,
				ResourceName: displayName(file.Name),
				Summary:      fmt.Sprintf("Removed %s from Drive.", quoteName(file.Name)),
				Fields:       []FieldChange{},
				OccurredAt:   timePtr(occurred),
				Link:         safeLink(file.Link),
			}
		}
		if createdDuringSession(file, sessionStart) {
			fields := driveAddedFields(file, afterNames, loc)
			return Change{
				ID:           changeID(ServiceDrive, id, KindAdded),
				Service:      ServiceDrive,
				Kind:         KindAdded,
				ResourceID:   id,
				ResourceName: displayName(file.Name),
				Summary:      summarizeDrive(KindAdded, nil, &file, fields, false),
				Fields:       fields,
				OccurredAt:   timePtr(occurred),
				Link:         safeLink(file.Link),
			}
		}
		fields := []FieldChange{edit(fieldDetails, "Not in the snapshot", describeFile(file, afterNames, loc))}
		return Change{
			ID:           changeID(ServiceDrive, id, KindModified),
			Service:      ServiceDrive,
			Kind:         KindModified,
			ResourceID:   id,
			ResourceName: displayName(file.Name),
			Summary:      summarizeDrive(KindModified, nil, &file, fields, true),
			Fields:       fields,
			OccurredAt:   timePtr(occurred),
			Link:         safeLink(file.Link),
		}
	}

	if old.Trashed && !file.Trashed {
		fields := []FieldChange{edit(fieldTrashed, "in trash", "not in trash")}
		fields = append(fields, driveFieldDiff(old, file, beforeNames, afterNames, loc)...)
		return Change{
			ID:           changeID(ServiceDrive, id, KindAdded),
			Service:      ServiceDrive,
			Kind:         KindAdded,
			ResourceID:   id,
			ResourceName: displayName(file.Name),
			Summary:      summarizeDrive(KindAdded, &old, &file, fields, false),
			Fields:       fields,
			OccurredAt:   timePtr(occurred),
			Link:         safeLink(firstNonEmpty(file.Link, old.Link)),
		}
	}

	fields := driveFieldDiff(old, file, beforeNames, afterNames, loc)
	if len(fields) == 0 {
		return Change{}
	}
	return Change{
		ID:           changeID(ServiceDrive, id, KindModified),
		Service:      ServiceDrive,
		Kind:         KindModified,
		ResourceID:   id,
		ResourceName: displayName(file.Name),
		Summary:      summarizeDrive(KindModified, &old, &file, fields, false),
		Fields:       fields,
		OccurredAt:   timePtr(firstNonZero(occurred, file.ModifiedTime)),
		Link:         safeLink(firstNonEmpty(file.Link, old.Link)),
	}
}

func diffDriveLists(before, after []DriveFile, names map[string]string, sessionStart time.Time, loc *time.Location, suppressRemovals bool) []Change {
	prev := indexFiles(before)
	next := indexFiles(after)
	afterNames := copyNames(names)
	for id, f := range next {
		if f.Name != "" {
			afterNames[id] = f.Name
		}
	}
	var out []Change
	if !suppressRemovals {
		for _, id := range sortedKeys(prev) {
			if _, ok := next[id]; ok {
				continue
			}
			old := prev[id]
			out = append(out, Change{
				ID:           changeID(ServiceDrive, id, KindRemoved),
				Service:      ServiceDrive,
				Kind:         KindRemoved,
				ResourceID:   id,
				ResourceName: displayName(old.Name),
				Summary:      summarizeDrive(KindRemoved, &old, nil, nil, false),
				Fields:       []FieldChange{},
				Link:         safeLink(old.Link),
			})
		}
	}
	for _, id := range sortedKeys(next) {
		file := next[id]
		old, ok := prev[id]
		if !ok {
			ch := DriveChange{FileID: id, Time: file.ModifiedTime, File: &file}
			out = append(out, driveChangeFrom(id, false, DriveFile{}, ch, names, afterNames, sessionStart, loc))
			continue
		}
		ch := DriveChange{FileID: id, Time: file.ModifiedTime, File: &file}
		out = append(out, driveChangeFrom(id, true, old, ch, names, afterNames, sessionStart, loc))
	}
	return compactChanges(out)
}

func driveFieldDiff(before, after DriveFile, beforeNames, afterNames map[string]string, loc *time.Location) []FieldChange {
	var fields []FieldChange
	if before.Name != after.Name {
		fields = append(fields, edit(fieldName, before.Name, after.Name))
	}
	if before.MimeType != after.MimeType {
		fields = append(fields, edit(fieldType, friendlyType(before.MimeType), friendlyType(after.MimeType)))
	}
	if !sameStrings(before.Parents, after.Parents) {
		fields = append(fields, edit(fieldFolder, folderText(before.Parents, beforeNames), folderText(after.Parents, afterNames)))
	}
	if contentChanged(before, after) {
		fields = append(fields, edit(fieldContent, contentText(before, loc), contentText(after, loc)))
	}
	return fields
}

func contentChanged(before, after DriveFile) bool {
	if before.Version != after.Version && (before.Version != 0 || after.Version != 0) {
		return true
	}
	if before.MD5 != after.MD5 {
		return true
	}
	if before.Size != after.Size {
		return true
	}
	if !before.ModifiedTime.Equal(after.ModifiedTime) {
		return true
	}
	return false
}

func driveAddedFields(f DriveFile, names map[string]string, loc *time.Location) []FieldChange {
	fields := []FieldChange{
		edit(fieldName, "", f.Name),
		edit(fieldType, "", friendlyType(f.MimeType)),
	}
	if len(f.Parents) > 0 {
		fields = append(fields, edit(fieldFolder, "", folderText(f.Parents, names)))
	}
	if text := contentText(f, loc); text != "no version details" {
		fields = append(fields, edit(fieldContent, "", text))
	}
	return fields
}

func collapseChanges(changes []DriveChange) (map[string]DriveChange, []string) {
	latest := map[string]DriveChange{}
	var order []string
	for _, ch := range changes {
		if ch.FileID == "" {
			continue
		}
		if _, ok := latest[ch.FileID]; !ok {
			order = append(order, ch.FileID)
		}
		latest[ch.FileID] = ch
	}
	return latest, order
}

func indexEvents(events []CalendarEvent) map[string]CalendarEvent {
	out := make(map[string]CalendarEvent, len(events))
	for _, ev := range events {
		if ev.ID == "" {
			continue
		}
		out[ev.ID] = ev
	}
	return out
}

func indexFiles(files []DriveFile) map[string]DriveFile {
	out := make(map[string]DriveFile, len(files))
	for _, f := range files {
		if f.ID == "" {
			continue
		}
		cp := f
		cp.Parents = sortedCopy(f.Parents)
		out[f.ID] = cp
	}
	return out
}

func fileNames(files []DriveFile) map[string]string {
	names := make(map[string]string, len(files))
	for _, f := range files {
		if f.ID != "" && f.Name != "" {
			names[f.ID] = f.Name
		}
	}
	return names
}

func copyNames(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func compactChanges(in []Change) []Change {
	out := make([]Change, 0, len(in))
	for _, ch := range in {
		if ch.ID == "" {
			continue
		}
		out = append(out, ch)
	}
	return out
}

func compactStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func firstLink(values ...string) string {
	return safeLink(firstNonEmpty(values...))
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func firstNonZero(times ...time.Time) time.Time {
	for _, t := range times {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}
