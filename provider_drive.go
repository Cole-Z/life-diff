package lifediff

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const maxRevisionLookups = 20

// NewDriveProvider wraps a read-only Drive reader.
// Full read mode is off until EnableDriveContentSignals is called.
func NewDriveProvider(r DriveReader) Provider {
	return &driveProvider{reader: r}
}

// EnableDriveContentSignals turns on full read mode for a provider returned
// by NewDriveProvider: revision metadata, Drive Activity, and file text.
// Text comes from DriveTextSource. Other providers are left unchanged.
// Nothing is uploaded or edited.
func EnableDriveContentSignals(p Provider) {
	d, ok := p.(*driveProvider)
	if !ok {
		return
	}
	d.full = true
}

type driveProvider struct {
	reader DriveReader
	full   bool
}

func (p *driveProvider) ID() string { return string(ServiceDrive) }

func (p *driveProvider) DisplayName() string { return ServiceDrive.Display() }

func (p *driveProvider) Snapshot(ctx context.Context, req SnapshotRequest) (ServiceState, error) {
	if p == nil || p.reader == nil {
		return ServiceState{}, fmt.Errorf("drive reader is not configured")
	}
	query := param(req, "drive_query")
	if query == "" {
		query = defaultDriveQuery
	}
	maxFiles := atoiParam(param(req, "max_drive_files"))
	if maxFiles <= 0 {
		maxFiles = DefaultMaxDriveFiles
	}
	snap := DriveSnapshot{Checked: true, Query: query, Files: []DriveFile{}}
	state := ServiceState{
		ID:          p.ID(),
		DisplayName: p.DisplayName(),
		Checked:     true,
		TakenAt:     req.Now.UTC(),
	}
	token, err := p.reader.StartPageToken(ctx)
	if err != nil {
		state.Warnings = append(state.Warnings, "Drive did not provide a changes token. The next check will list files again.")
	} else {
		snap.StartPageToken = token
		state.Cursor = token
	}
	listed, err := p.reader.ListFiles(ctx, query, maxFiles)
	if err != nil {
		return ServiceState{}, fmt.Errorf("read drive: %w", err)
	}
	snap.Files = listed.Files
	snap.Truncated = listed.Truncated
	if snap.Files == nil {
		snap.Files = []DriveFile{}
	}
	state.ItemCount = len(snap.Files)
	if listed.Truncated {
		state.Warnings = append(state.Warnings, fmt.Sprintf("Drive snapshot stopped at %d files. Later edits to older files still show up, without earlier details.", maxFiles))
	}
	if p.full {
		p.attachFileText(ctx, snap.Files, &snap.Texts, &state)
	}
	payload, err := encodePayload(snap)
	if err != nil {
		return ServiceState{}, err
	}
	state.Payload = payload
	return state, nil
}

func (p *driveProvider) ReadCurrent(ctx context.Context, before ServiceState) (ServiceState, error) {
	if p == nil || p.reader == nil {
		return ServiceState{}, fmt.Errorf("drive reader is not configured")
	}
	var snap DriveSnapshot
	if err := decodePayload(before.Payload, &snap); err != nil {
		return ServiceState{}, err
	}
	after, warn, err := p.read(ctx, snap)
	if err != nil {
		return ServiceState{}, err
	}
	state := ServiceState{
		ID:          p.ID(),
		DisplayName: p.DisplayName(),
		Checked:     true,
		Mode:        after.Mode,
	}
	if warn != "" {
		state.Warnings = append(state.Warnings, warn)
	}
	if p.full {
		p.attachSignals(ctx, before.TakenAt, snap, &after, &state)
		if p.attachFileText(ctx, changedDriveFiles(snap, after), &after.Texts, &state) {
			after.TextRead = true
		}
	}
	if after.Mode == DriveDiffList {
		state.ItemCount = len(after.Files)
	} else {
		state.ItemCount = len(after.Changes)
	}
	payload, err := encodePayload(after)
	if err != nil {
		return ServiceState{}, err
	}
	state.Payload = payload
	return state, nil
}

func (p *driveProvider) read(ctx context.Context, snap DriveSnapshot) (DriveAfter, string, error) {
	if snap.StartPageToken != "" {
		listed, err := p.reader.ListChanges(ctx, snap.StartPageToken)
		if err == nil {
			return DriveAfter{
				Mode:      DriveDiffChanges,
				Changes:   listed.Changes,
				Truncated: listed.Truncated,
			}, "", nil
		}
		warn := "Drive changes feed failed (" + trimErr(err) + "). Life Diff listed files again."
		files, ferr := p.reader.ListFiles(ctx, snap.Query, DefaultMaxDriveFiles)
		if ferr != nil {
			return DriveAfter{}, "", fmt.Errorf("read drive: %w", ferr)
		}
		return DriveAfter{Mode: DriveDiffList, Files: files.Files, Truncated: files.Truncated}, warn, nil
	}
	files, err := p.reader.ListFiles(ctx, snap.Query, DefaultMaxDriveFiles)
	if err != nil {
		return DriveAfter{}, "", fmt.Errorf("read drive: %w", err)
	}
	return DriveAfter{Mode: DriveDiffList, Files: files.Files, Truncated: files.Truncated}, "", nil
}

func (p *driveProvider) attachSignals(ctx context.Context, since time.Time, snap DriveSnapshot, after *DriveAfter, state *ServiceState) {
	sig, ok := p.reader.(DriveContentSignals)
	if !ok {
		state.Warnings = append(state.Warnings, "Full Drive read was requested, but this Drive client does not report activity or revisions.")
		return
	}
	if since.IsZero() {
		since = time.Now().UTC().Add(-24 * time.Hour)
	}
	activity, err := sig.ActivitySince(ctx, since)
	if err != nil {
		state.Warnings = append(state.Warnings, "Drive Activity was not available ("+trimErr(err)+"). The receipt uses the changes feed only.")
	} else if len(activity) > 0 {
		after.Activity = activity
	}
	ids := revisionCandidates(snap, *after)
	if len(ids) == 0 {
		return
	}
	if len(ids) > maxRevisionLookups {
		state.Warnings = append(state.Warnings, fmt.Sprintf("Drive revision metadata was limited to %d changed files.", maxRevisionLookups))
		ids = ids[:maxRevisionLookups]
	}
	revs := map[string][]DriveRevision{}
	var revErr error
	for _, id := range ids {
		list, err := sig.Revisions(ctx, id)
		if err != nil {
			revErr = err
			continue
		}
		if len(list) > 0 {
			revs[id] = list
		}
	}
	if revErr != nil {
		state.Warnings = append(state.Warnings, "Some Drive revision metadata was not available ("+trimErr(revErr)+").")
	}
	if len(revs) > 0 {
		after.Revisions = revs
	}
}

func revisionCandidates(before DriveSnapshot, after DriveAfter) []string {
	var ids []string
	seen := map[string]bool{}
	add := func(id string, removed bool) {
		if id == "" || removed || seen[id] {
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}
	switch after.Mode {
	case DriveDiffChanges:
		for _, ch := range after.Changes {
			add(ch.FileID, ch.Removed)
		}
	default:
		prev := indexFiles(before.Files)
		for _, f := range after.Files {
			old, ok := prev[f.ID]
			if !ok || contentChanged(old, f) || old.Name != f.Name || old.Trashed != f.Trashed {
				add(f.ID, f.Trashed)
			}
		}
	}
	return ids
}

func (p *driveProvider) BuildChanges(before, current ServiceState, cc CompareContext) (ProviderOutput, error) {
	var snap DriveSnapshot
	if err := decodePayload(before.Payload, &snap); err != nil {
		return ProviderOutput{}, err
	}
	var after DriveAfter
	if err := decodePayload(current.Payload, &after); err != nil {
		return ProviderOutput{}, err
	}
	taken := before.TakenAt
	if taken.IsZero() {
		taken = cc.Session.StartedAt
	}
	return driveOutput(snap, taken, &after, cc.Location, current.Warnings), nil
}

func (p *driveProvider) ProjectSnapshot(dst *Snapshot, state ServiceState) {
	var snap DriveSnapshot
	if err := decodePayload(state.Payload, &snap); err != nil {
		return
	}
	dst.Drive = snap
}

func driveOutput(snap DriveSnapshot, takenAt time.Time, after *DriveAfter, loc *time.Location, extra []string) ProviderOutput {
	out := ProviderOutput{Warnings: append([]string{}, extra...)}
	if !snap.Checked {
		return out
	}
	if after == nil {
		out.Warnings = append(out.Warnings, "Drive was not compared on this check.")
		return out
	}
	if loc == nil {
		loc = time.UTC
	}
	changes, info := diffDrive(Snapshot{TakenAt: takenAt, Drive: snap}, *after, loc)
	changes = annotateDriveFull(changes, *after)
	changes = applyTextDiffs(changes, snap, *after)
	out.Changes = changes
	out.Drive = info
	if info != nil && info.SuppressedRemovals {
		out.Warnings = append(out.Warnings, "The Drive file list was cut off, so this receipt does not treat missing files as removed.")
	}
	if info != nil && info.TruncatedChanges {
		out.Warnings = append(out.Warnings, "Drive's change list was cut off. This receipt may be missing later changes.")
	}
	if after.Mode == DriveDiffList {
		out.Warnings = append(out.Warnings, "Drive was compared by listing files again. A file that no longer matches the snapshot query shows up as removed.")
	}
	mode := ""
	if info != nil {
		mode = info.DiffMode
	}
	out.Info = ProviderInfo{
		ID:          string(ServiceDrive),
		DisplayName: ServiceDrive.Display(),
		DiffMode:    mode,
		Intro:       driveIntro(Receipt{Drive: info}),
	}
	if after.TextRead || len(snap.Texts) > 0 || len(after.Texts) > 0 {
		out.Notes = append(out.Notes, "Drive text is exported from Docs, Sheets, and Slides, or read from plain text files. Nothing is written back.")
	} else {
		out.Notes = append(out.Notes, "Drive file text was not read. A content update means a new version was saved, and the old and new words are not shown.")
	}
	return out
}

func (p *driveProvider) attachFileText(ctx context.Context, files []DriveFile, dest *map[string]DriveText, state *ServiceState) bool {
	src, ok := p.reader.(DriveTextSource)
	if !ok {
		state.Warnings = append(state.Warnings, "Full Drive read was requested, but this Drive client does not export file text.")
		return false
	}
	stored := 0
	failed := 0
	for _, file := range files {
		if stored >= MaxDriveTextFiles {
			state.Warnings = append(state.Warnings, fmt.Sprintf("Drive text was stored for %d files. Further files stay metadata only.", MaxDriveTextFiles))
			break
		}
		if file.ID == "" || file.Trashed || DriveTextKind(file.MimeType) == "" {
			continue
		}
		text, err := src.FileText(ctx, file)
		if err != nil {
			failed++
			continue
		}
		if text.Unavailable != "" || text.Text == "" && !text.Truncated {
			continue
		}
		clipped, cut := clipStoredText(text.Text, text.Truncated)
		text.Text = clipped
		text.Truncated = cut
		if *dest == nil {
			*dest = map[string]DriveText{}
		}
		(*dest)[file.ID] = text
		stored++
	}
	if failed > 0 {
		state.Warnings = append(state.Warnings, fmt.Sprintf("Text for %d Drive files could not be read.", failed))
	}
	return true
}

func changedDriveFiles(before DriveSnapshot, after DriveAfter) []DriveFile {
	var files []DriveFile
	seen := map[string]bool{}
	add := func(f DriveFile) {
		if f.ID == "" || f.Trashed || seen[f.ID] || DriveTextKind(f.MimeType) == "" {
			return
		}
		seen[f.ID] = true
		files = append(files, f)
	}
	prev := indexFiles(before.Files)
	switch after.Mode {
	case DriveDiffChanges:
		for _, ch := range after.Changes {
			if ch.Removed || ch.File == nil {
				continue
			}
			old, ok := prev[ch.FileID]
			if ok && !contentChanged(old, *ch.File) && old.Name == ch.File.Name {
				continue
			}
			add(*ch.File)
		}
	default:
		for _, f := range after.Files {
			old, ok := prev[f.ID]
			if ok && !contentChanged(old, f) && old.Name == f.Name {
				continue
			}
			add(f)
		}
	}
	return files
}

func applyTextDiffs(changes []Change, before DriveSnapshot, after DriveAfter) []Change {
	if len(before.Texts) == 0 && len(after.Texts) == 0 {
		return changes
	}
	for i := range changes {
		ch := &changes[i]
		if ch.Service != ServiceDrive {
			continue
		}
		old, hasOld := before.Texts[ch.ResourceID]
		cur, hasNew := after.Texts[ch.ResourceID]
		if !hasOld && !hasNew {
			continue
		}
		beforeText, afterText := "", ""
		truncated := false
		if hasOld {
			beforeText = old.Text
			truncated = truncated || old.Truncated
		}
		if hasNew {
			afterText = cur.Text
			truncated = truncated || cur.Truncated
		}
		name := ch.ResourceName
		switch ch.Kind {
		case KindRemoved:
			if strings.TrimSpace(beforeText) == "" {
				continue
			}
			shown, _ := textFieldPair(beforeText, "")
			ch.Fields = append(ch.Fields, edit(fieldText, shown, ""))
		case KindAdded:
			if strings.TrimSpace(afterText) == "" {
				continue
			}
			_, shown := textFieldPair("", afterText)
			ch.Fields = append(ch.Fields, edit(fieldText, "", shown))
		case KindModified:
			if hasOld && hasNew && normalizeDoc(beforeText) == normalizeDoc(afterText) {
				if next, ok := replaceContentsSentence(ch.Summary, name); ok {
					ch.Summary = next
				}
				continue
			}
			if strings.TrimSpace(beforeText) == "" && strings.TrimSpace(afterText) == "" {
				continue
			}
			var sentence string
			if strings.TrimSpace(beforeText) == "" {
				sentence = fmt.Sprintf("Updated the text of %s, but the snapshot did not include the earlier text.", quoteName(name))
			} else if strings.TrimSpace(afterText) == "" {
				sentence = fmt.Sprintf("Updated %s. The new text could not be read.", quoteName(name))
			} else {
				sentence = textEditSentence(name, beforeText, afterText, truncated)
			}
			ch.Summary = mergeTextSentence(ch.Summary, name, sentence)
			left, right := textFieldPair(beforeText, afterText)
			ch.Fields = append(ch.Fields, edit(fieldText, left, right))
		default:
			panic(fmt.Sprintf("lifediff: unhandled change kind %q", ch.Kind))
		}
	}
	return changes
}

func annotateDriveFull(changes []Change, after DriveAfter) []Change {
	if len(after.Activity) == 0 && len(after.Revisions) == 0 {
		return changes
	}
	latest := map[string]DriveActivity{}
	for _, act := range after.Activity {
		prev, ok := latest[act.FileID]
		if !ok || act.Time.After(prev.Time) {
			latest[act.FileID] = act
		}
	}
	for i := range changes {
		if changes[i].Service != ServiceDrive {
			continue
		}
		if act, ok := latest[changes[i].ResourceID]; ok && !act.Time.IsZero() {
			t := act.Time.UTC()
			changes[i].OccurredAt = &t
			if verb := activityVerb(act.Action); verb != "" {
				changes[i].Fields = append(changes[i].Fields, edit(fieldActivity, "", verb))
			}
		}
		revs := after.Revisions[changes[i].ResourceID]
		if len(revs) == 0 {
			continue
		}
		last := revs[0]
		for _, rev := range revs[1:] {
			if rev.ModifiedTime.After(last.ModifiedTime) {
				last = rev
			}
		}
		if text := revisionText(last); text != "" {
			changes[i].Fields = append(changes[i].Fields, edit(fieldRevision, "", text))
		}
	}
	return changes
}

func activityVerb(action string) string {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "create":
		return "Created"
	case "edit":
		return "Edited"
	case "rename":
		return "Renamed"
	case "move":
		return "Moved"
	case "delete":
		return "Deleted"
	case "restore":
		return "Restored"
	case "":
		return ""
	default:
		a := strings.TrimSpace(action)
		return strings.ToUpper(a[:1]) + a[1:]
	}
}

func revisionText(rev DriveRevision) string {
	when := ""
	if !rev.ModifiedTime.IsZero() {
		when = rev.ModifiedTime.UTC().Format(time.RFC3339)
	}
	switch {
	case rev.ID != "" && when != "":
		return "revision " + rev.ID + " at " + when
	case rev.ID != "":
		return "revision " + rev.ID
	default:
		return when
	}
}
