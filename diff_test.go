package lifediff

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestDentistMoveSentence(t *testing.T) {
	r := SampleReceipt()
	ch, ok := findChange(r, "evt_dentist")
	if !ok {
		t.Fatal("missing dentist change")
	}
	want := `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM. Changed the location of "Dentist" from "Office" to "Clinic".`
	if ch.Summary != want {
		t.Fatalf("summary:\n got %s\nwant %s", ch.Summary, want)
	}
	if ch.Kind != KindModified || ch.Confidence != ConfidenceHigh || ch.ClaimStatus != ClaimVerified {
		t.Fatalf("kind=%s confidence=%s claim=%s", ch.Kind, ch.Confidence, ch.ClaimStatus)
	}
	if ch.Service != ServiceCalendar {
		t.Fatal(ch.Service)
	}
	start, ok := findField(ch.Fields, fieldStart)
	if !ok || start.Before != "Tue, Apr 7, 3:00 PM" || start.After != "Wed, Apr 8, 10:00 AM" {
		t.Fatalf("start field %#v", start)
	}
}

func TestSampleClaimVerdicts(t *testing.T) {
	r := SampleReceipt()
	if !r.ReadOnly || r.SchemaVersion != SchemaVersion {
		t.Fatalf("schema %s readonly %v", r.SchemaVersion, r.ReadOnly)
	}
	if r.Counts.Added != 1 || r.Counts.Removed != 1 || r.Counts.Modified != 3 {
		t.Fatalf("counts %+v", r.Counts)
	}
	if r.Counts.VerifiedClaims != 1 || r.Counts.MissingClaims != 1 || r.Counts.UnclaimedChanges != 4 {
		t.Fatalf("claim counts %+v", r.Counts)
	}
	var missing ClaimResult
	found := false
	for _, c := range r.Claims {
		if c.ID == "claim_goals" {
			missing = c
			found = true
		}
	}
	if !found || missing.Status != ClaimMissing {
		t.Fatalf("missing claim %+v", missing)
	}
	gym, ok := findChange(r, "evt_gym")
	if !ok || gym.Confidence != ConfidenceLow || gym.ClaimStatus != ClaimUnclaimed {
		t.Fatalf("gym %+v", gym)
	}
	if !strings.Contains(gym.Summary, `Renamed "Gym" to "Morning gym".`) {
		t.Fatal(gym.Summary)
	}
	old, ok := findChange(r, "file_old")
	if !ok || old.Kind != KindRemoved || !strings.Contains(old.Summary, `Removed "Old draft.docx" from Drive.`) {
		t.Fatalf("old draft %+v", old)
	}
	vac, ok := findChange(r, "file_vac")
	if !ok || !strings.Contains(vac.Summary, `Renamed "Vacation ideas" to "Vacation ideas (final)".`) || !strings.Contains(vac.Summary, `removed "Launch TBD" and added "Launch in May"`) {
		t.Fatal(vac.Summary)
	}
	pickup, ok := findChange(r, "evt_pickup")
	if !ok || pickup.Kind != KindAdded || !strings.Contains(pickup.Summary, `Added "School pickup" on Fri, Apr 10, 2:30 PM–3:00 PM.`) {
		t.Fatal(pickup.Summary)
	}
}

func TestClaimsNotCheckedLeavesStatusBlank(t *testing.T) {
	r := SampleReceipt()
	// Rebuild without claims by using the same snapshot path through a direct call
	// is covered by clearing via a fresh receipt options in the helper below.
	plain := receiptFrom(t, []CalendarEvent{{
		ID: "a", Summary: "A", Status: "confirmed",
		Start: EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
		End:   EventTime{DateTime: time.Date(2026, 4, 7, 16, 0, 0, 0, time.UTC)},
	}}, []CalendarEvent{{
		ID: "a", Summary: "B", Status: "confirmed",
		Start:   EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
		End:     EventTime{DateTime: time.Date(2026, 4, 7, 16, 0, 0, 0, time.UTC)},
		Updated: time.Date(2026, 4, 2, 15, 10, 0, 0, time.UTC),
	}}, nil, false)
	if plain.ClaimsChecked {
		t.Fatal("claims checked")
	}
	if len(plain.Changes) != 1 || plain.Changes[0].ClaimStatus != "" {
		t.Fatalf("%+v", plain.Changes)
	}
	if plain.Counts.UnclaimedChanges != 0 {
		t.Fatal(plain.Counts)
	}
	_ = r
}

func TestEmptyClaimsMarkUnclaimed(t *testing.T) {
	r := receiptFrom(t, []CalendarEvent{{
		ID: "a", Summary: "A", Status: "confirmed",
		Start: EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
		End:   EventTime{DateTime: time.Date(2026, 4, 7, 16, 0, 0, 0, time.UTC)},
	}}, []CalendarEvent{{
		ID: "a", Summary: "B", Status: "confirmed",
		Start: EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
		End:   EventTime{DateTime: time.Date(2026, 4, 7, 16, 0, 0, 0, time.UTC)},
	}}, []ClaimInput{}, true)
	if len(r.Changes) != 1 || r.Changes[0].ClaimStatus != ClaimUnclaimed {
		t.Fatalf("%+v", r.Changes)
	}
	if len(r.Claims) != 0 || r.Counts.MissingClaims != 0 || r.Counts.UnclaimedChanges != 1 {
		t.Fatalf("%+v claims %d", r.Counts, len(r.Claims))
	}
}

func TestServiceMismatchDoesNotVerify(t *testing.T) {
	before := []DriveFile{{ID: "f", Name: "Dentist", MimeType: "text/plain", Version: 1}}
	after := []DriveFile{{ID: "f", Name: "Dentist notes", MimeType: "text/plain", Version: 1}}
	r := driveReceipt(t, before, after, []ClaimInput{{
		Service: "calendar", Action: "modified", Target: "Dentist",
	}}, true)
	if r.Counts.VerifiedClaims != 0 || r.Counts.MissingClaims != 1 {
		t.Fatalf("%+v", r.Counts)
	}
}

func TestCancelledEventIsRemovalWithTime(t *testing.T) {
	start := time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)
	r := receiptFrom(t, []CalendarEvent{{
		ID: "a", Summary: "Dentist", Status: "confirmed",
		Start: EventTime{DateTime: start},
		End:   EventTime{DateTime: start.Add(time.Hour)},
	}}, []CalendarEvent{{
		ID: "a", Summary: "Dentist", Status: "cancelled",
		Start:   EventTime{DateTime: start},
		End:     EventTime{DateTime: start.Add(time.Hour)},
		Updated: time.Date(2026, 4, 2, 15, 5, 0, 0, time.UTC),
	}}, nil, false)
	if len(r.Changes) != 1 || r.Changes[0].Kind != KindRemoved {
		t.Fatalf("%+v", r.Changes)
	}
	if r.Changes[0].Confidence != ConfidenceHigh {
		t.Fatal(r.Changes[0].Confidence, r.Changes[0].ConfidenceReason)
	}
	if !strings.Contains(r.Changes[0].Summary, "Removed") {
		t.Fatal(r.Changes[0].Summary)
	}
}

func TestAttendeeOrderIsNotAChange(t *testing.T) {
	ev := func(list []string) CalendarEvent {
		return CalendarEvent{
			ID: "a", Summary: "Standup", Status: "confirmed",
			Start:     EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
			End:       EventTime{DateTime: time.Date(2026, 4, 7, 15, 30, 0, 0, time.UTC)},
			Attendees: list,
		}
	}
	r := receiptFrom(t, []CalendarEvent{ev([]string{"b@x", "a@x"})}, []CalendarEvent{ev([]string{"a@x", "b@x"})}, nil, false)
	if len(r.Changes) != 0 {
		t.Fatalf("unexpected %#v", r.Changes)
	}
}

func TestContentOnlyDriveUpdate(t *testing.T) {
	before := DriveFile{ID: "n", Name: "Notes", MimeType: "application/vnd.google-apps.document", Version: 2, ModifiedTime: time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)}
	after := before
	after.Version = 3
	after.ModifiedTime = time.Date(2026, 4, 2, 15, 12, 0, 0, time.UTC)
	r := driveReceipt(t, []DriveFile{before}, []DriveFile{after}, nil, false)
	if len(r.Changes) != 1 {
		t.Fatalf("%#v", r.Changes)
	}
	if !strings.Contains(r.Changes[0].Summary, `Updated the contents of "Notes".`) {
		t.Fatal(r.Changes[0].Summary)
	}
	if _, ok := findField(r.Changes[0].Fields, fieldContent); !ok {
		t.Fatal(r.Changes[0].Fields)
	}
}

func TestTrashAndRestore(t *testing.T) {
	file := DriveFile{ID: "n", Name: "Notes", MimeType: "text/plain", Version: 1}
	trashed := file
	trashed.Trashed = true
	removed := driveChangesReceipt(t, []DriveFile{file}, []DriveChange{{FileID: "n", Removed: false, File: &trashed, Time: time.Date(2026, 4, 2, 15, 12, 0, 0, time.UTC)}})
	if len(removed.Changes) != 1 || removed.Changes[0].Kind != KindRemoved {
		t.Fatalf("%#v", removed.Changes)
	}
	if !strings.Contains(removed.Changes[0].Summary, `Moved "Notes" to trash.`) {
		t.Fatal(removed.Changes[0].Summary)
	}
	restored := driveChangesReceipt(t, []DriveFile{trashed}, []DriveChange{{FileID: "n", File: &file, Time: time.Date(2026, 4, 2, 15, 12, 0, 0, time.UTC)}})
	if len(restored.Changes) != 1 || restored.Changes[0].Kind != KindAdded {
		t.Fatalf("%#v", restored.Changes)
	}
	if !strings.Contains(restored.Changes[0].Summary, `Restored "Notes" from trash.`) {
		t.Fatal(restored.Changes[0].Summary)
	}
}

func TestMoveOutsideWindow(t *testing.T) {
	loc := time.UTC
	windowStart := time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC)
	windowEnd := time.Date(2026, 4, 30, 0, 0, 0, 0, time.UTC)
	inside := CalendarEvent{
		ID: "evt", Summary: "Dentist", Status: "confirmed",
		Start: EventTime{DateTime: time.Date(2026, 4, 7, 15, 0, 0, 0, time.UTC)},
		End:   EventTime{DateTime: time.Date(2026, 4, 7, 16, 0, 0, 0, time.UTC)},
	}
	outside := inside
	outside.Start.DateTime = time.Date(2026, 8, 1, 15, 0, 0, 0, time.UTC)
	outside.End.DateTime = outside.Start.DateTime.Add(time.Hour)
	outside.Updated = time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	merged := applySync([]CalendarEvent{inside}, []CalendarEvent{outside}, windowStart, windowEnd, loc)
	if len(merged) != 1 || !merged[0].Start.DateTime.Equal(outside.Start.DateTime) {
		t.Fatalf("merged %#v", merged)
	}
	r := BuildReceipt(Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap",
		TakenAt:       time.Date(2026, 4, 2, 14, 0, 0, 0, time.UTC),
		TimeZone:      "UTC",
		Calendar: CalendarSnapshot{
			Checked: true, CalendarID: "primary",
			WindowStart: windowStart, WindowEnd: windowEnd,
			Events: []CalendarEvent{inside},
		},
	}, AfterState{
		ObservedAt: time.Date(2026, 4, 2, 16, 0, 0, 0, time.UTC),
		Calendar:   &CalendarAfter{Mode: CalendarDiffSync, Events: merged},
	}, ReceiptOptions{Now: time.Date(2026, 4, 2, 16, 0, 0, 0, time.UTC), Location: loc})
	if len(r.Changes) != 1 || r.Changes[0].Kind != KindModified || !strings.Contains(r.Changes[0].Summary, "Moved") {
		t.Fatalf("kind %s summary %s", r.Changes[0].Kind, r.Changes[0].Summary)
	}
}

func TestConfidenceBands(t *testing.T) {
	start := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	end := start.Add(40 * time.Minute)
	if ConfidenceAt(start.Add(10*time.Minute), start, end) != ConfidenceHigh {
		t.Fatal("high")
	}
	if ConfidenceAt(start.Add(-10*time.Minute), start, end) != ConfidenceMedium {
		t.Fatal("medium")
	}
	if ConfidenceAt(start.Add(-2*time.Hour), start, end) != ConfidenceLow {
		t.Fatal("low")
	}
	if ConfidenceAt(time.Time{}, start, end) != ConfidenceMedium {
		t.Fatal("missing time")
	}
}

func TestParseClaims(t *testing.T) {
	claims, err := ParseClaims([]byte(`[{"service":"gcal","action":"moved","target":"Dentist"}]`))
	if err != nil || len(claims) != 1 {
		t.Fatal(err, claims)
	}
	claims, err = ParseClaims([]byte(`{"claims":[{"service":"drive","action":"created","target":"Notes"}]}`))
	if err != nil || len(claims) != 1 {
		t.Fatal(err, claims)
	}
	if _, err := ParseClaims([]byte(`[{"target":""}]`)); err == nil {
		t.Fatal("expected target error")
	}
	if _, err := ParseClaims([]byte(`[{"service":"not a service","target":"x"}]`)); err == nil {
		t.Fatal("expected service error")
	}
	claims, err = ParseClaims([]byte(`[{"service":"gmail","target":"Hello"},{"service":"slack","target":"standup"}]`))
	if err != nil || len(claims) != 2 {
		t.Fatal(err, claims)
	}
}

func TestReportHasLabelsAndNoScript(t *testing.T) {
	html, err := RenderHTML(SampleReceipt())
	if err != nil {
		t.Fatal(err)
	}
	body := string(html)
	for _, needle := range []string{"Added", "Removed", "Modified", "Dentist", "Tue, Apr 7, 3:00 PM", "The agent did not claim this.", "Missing", "High confidence", "Low confidence"} {
		if !strings.Contains(body, needle) {
			t.Fatalf("report missing %q", needle)
		}
	}
	if strings.Contains(body, "<script") || strings.Contains(body, "fonts.googleapis") {
		t.Fatal("report should be self-contained and script-free")
	}
	if strings.Contains(body, "access_token") || strings.Contains(body, "client_secret") {
		t.Fatal("report contains secret-looking fields")
	}
}

func TestDocsSampleMatchesGenerator(t *testing.T) {
	html, err := RenderHTML(SampleReceipt())
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile("docs/sample-report.html")
	if err != nil {
		t.Fatal(err)
	}
	if string(html) != string(onDisk) {
		t.Fatal("docs/sample-report.html is stale; run go run ./cmd/lifediff demo --html docs/sample-report.html --json docs/sample-receipt.json")
	}
	data, err := Marshal(SampleReceipt())
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err = os.ReadFile("docs/sample-receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(onDisk) {
		t.Fatal("docs/sample-receipt.json is stale")
	}
}

func TestReceiptJSONHasNoSecrets(t *testing.T) {
	b, err := Marshal(SampleReceipt())
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, needle := range []string{"access_token", "refresh_token", "client_secret", "ya29."} {
		if strings.Contains(s, needle) {
			t.Fatal(needle)
		}
	}
	if !strings.Contains(s, `"schemaVersion": "1.1.0"`) || !strings.Contains(s, `"readOnly": true`) {
		t.Fatal(s[:400])
	}
}

func findChange(r Receipt, id string) (Change, bool) {
	for _, ch := range r.Changes {
		if ch.ResourceID == id {
			return ch, true
		}
	}
	return Change{}, false
}

func receiptFrom(t *testing.T, before, after []CalendarEvent, claims []ClaimInput, check bool) Receipt {
	t.Helper()
	snapAt := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	return BuildReceipt(Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap",
		TakenAt:       snapAt,
		TimeZone:      "UTC",
		Calendar: CalendarSnapshot{
			Checked: true, CalendarID: "primary",
			WindowStart: snapAt, WindowEnd: snapAt.AddDate(0, 0, 90),
			Events: before,
		},
	}, AfterState{
		ObservedAt: snapAt.Add(30 * time.Minute),
		Calendar:   &CalendarAfter{Mode: CalendarDiffSync, Events: after},
	}, ReceiptOptions{
		Now: snapAt.Add(30 * time.Minute), Location: time.UTC,
		Claims: claims, CheckClaims: check,
	})
}

func driveReceipt(t *testing.T, before, after []DriveFile, claims []ClaimInput, check bool) Receipt {
	t.Helper()
	snapAt := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	return BuildReceipt(Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap",
		TakenAt:       snapAt,
		TimeZone:      "UTC",
		Drive:         DriveSnapshot{Checked: true, Query: "trashed = false", Files: before},
	}, AfterState{
		ObservedAt: snapAt.Add(30 * time.Minute),
		Drive:      &DriveAfter{Mode: DriveDiffChanges, Changes: filesAsChanges(after)},
	}, ReceiptOptions{
		Now: snapAt.Add(30 * time.Minute), Location: time.UTC,
		Claims: claims, CheckClaims: check,
	})
}

func filesAsChanges(files []DriveFile) []DriveChange {
	out := make([]DriveChange, 0, len(files))
	for i := range files {
		f := files[i]
		out = append(out, DriveChange{FileID: f.ID, Time: f.ModifiedTime, File: &f})
	}
	return out
}

func driveChangesReceipt(t *testing.T, before []DriveFile, changes []DriveChange) Receipt {
	t.Helper()
	snapAt := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	return BuildReceipt(Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap",
		TakenAt:       snapAt,
		TimeZone:      "UTC",
		Drive:         DriveSnapshot{Checked: true, Query: "trashed = false", Files: before},
	}, AfterState{
		ObservedAt: snapAt.Add(30 * time.Minute),
		Drive:      &DriveAfter{Mode: DriveDiffChanges, Changes: changes},
	}, ReceiptOptions{Now: snapAt.Add(30 * time.Minute), Location: time.UTC})
}
