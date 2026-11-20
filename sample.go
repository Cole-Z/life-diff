package lifediff

import "time"

// SampleReceipt is a deterministic receipt built from fixture before/after data.
// The HTML report in docs/ is rendered from this receipt.
func SampleReceipt() Receipt {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		loc = time.FixedZone("EDT", -4*60*60)
	}
	at := func(s string) time.Time {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			panic(err)
		}
		return t
	}
	snapAt := at("2026-04-02T15:00:00Z")
	checkAt := at("2026-04-02T15:40:00Z")

	dentistBefore := CalendarEvent{
		ID:       "evt_dentist",
		Summary:  "Dentist",
		Location: "Office",
		Status:   "confirmed",
		Start:    EventTime{DateTime: at("2026-04-07T15:00:00-04:00"), TimeZone: "America/New_York"},
		End:      EventTime{DateTime: at("2026-04-07T16:00:00-04:00"), TimeZone: "America/New_York"},
		Updated:  at("2026-04-01T15:00:00Z"),
		Link:     "https://www.google.com/calendar/event?eid=dentist",
	}
	dentistAfter := dentistBefore
	dentistAfter.Location = "Clinic"
	dentistAfter.Start.DateTime = at("2026-04-08T10:00:00-04:00")
	dentistAfter.End.DateTime = at("2026-04-08T11:00:00-04:00")
	dentistAfter.Updated = at("2026-04-02T15:20:00Z")

	gymBefore := CalendarEvent{
		ID:      "evt_gym",
		Summary: "Gym",
		Status:  "confirmed",
		Start:   EventTime{DateTime: at("2026-04-06T07:00:00-04:00"), TimeZone: "America/New_York"},
		End:     EventTime{DateTime: at("2026-04-06T08:00:00-04:00"), TimeZone: "America/New_York"},
		Updated: at("2026-03-01T12:00:00Z"),
	}
	gymAfter := gymBefore
	gymAfter.Summary = "Morning gym"

	pickup := CalendarEvent{
		ID:       "evt_pickup",
		Summary:  "School pickup",
		Location: "Lincoln Elementary",
		Status:   "confirmed",
		Start:    EventTime{DateTime: at("2026-04-10T14:30:00-04:00"), TimeZone: "America/New_York"},
		End:      EventTime{DateTime: at("2026-04-10T15:00:00-04:00"), TimeZone: "America/New_York"},
		Updated:  at("2026-04-02T15:10:00Z"),
		Link:     "https://www.google.com/calendar/event?eid=pickup",
	}

	folder := DriveFile{ID: "folder_trips", Name: "Trips", MimeType: "application/vnd.google-apps.folder"}
	vacationBefore := DriveFile{
		ID:           "file_vac",
		Name:         "Vacation ideas",
		MimeType:     "application/vnd.google-apps.document",
		ModifiedTime: at("2026-04-01T12:00:00Z"),
		CreatedTime:  at("2026-01-15T12:00:00Z"),
		Parents:      []string{"folder_trips"},
		Version:      3,
		Link:         "https://docs.google.com/document/d/file_vac",
	}
	vacationAfter := vacationBefore
	vacationAfter.Name = "Vacation ideas (final)"
	vacationAfter.Version = 4
	vacationAfter.ModifiedTime = at("2026-04-02T15:25:00Z")
	vacationText := DriveText{Text: "Lisbon\nTokyo\nLaunch TBD\n", Kind: "document"}
	vacationTextAfter := DriveText{Text: "Lisbon\nTokyo\nLaunch in May\n", Kind: "document"}

	oldDraft := DriveFile{
		ID:           "file_old",
		Name:         "Old draft.docx",
		MimeType:     "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		ModifiedTime: at("2026-03-20T12:00:00Z"),
		CreatedTime:  at("2026-03-01T12:00:00Z"),
		Parents:      []string{"folder_trips"},
	}

	before := Snapshot{
		SchemaVersion: SchemaVersion,
		ID:            "snap_sample",
		TakenAt:       snapAt,
		TimeZone:      "America/New_York",
		Calendar: CalendarSnapshot{
			Checked:     true,
			CalendarID:  "primary",
			WindowStart: at("2026-04-02T04:00:00Z"),
			WindowEnd:   at("2026-07-01T04:00:00Z"),
			SyncToken:   "sync-sample",
			Events:      []CalendarEvent{dentistBefore, gymBefore},
		},
		Drive: DriveSnapshot{
			Checked:        true,
			Query:          "trashed = false",
			StartPageToken: "drive-token-sample",
			Files:          []DriveFile{folder, vacationBefore, oldDraft},
			Texts:          map[string]DriveText{"file_vac": vacationText},
		},
	}
	after := AfterState{
		ObservedAt: checkAt,
		Calendar: &CalendarAfter{
			Mode:   CalendarDiffSync,
			Events: []CalendarEvent{dentistAfter, gymAfter, pickup},
		},
		Drive: &DriveAfter{
			Mode: DriveDiffChanges,
			Changes: []DriveChange{
				{FileID: "file_vac", Time: vacationAfter.ModifiedTime, File: &vacationAfter},
				{FileID: "file_old", Removed: true, Time: at("2026-04-02T15:30:00Z")},
			},
			Texts:    map[string]DriveText{"file_vac": vacationTextAfter},
			TextRead: true,
		},
	}
	return BuildReceipt(before, after, ReceiptOptions{
		ID:          "rcpt_sample",
		Now:         checkAt,
		Location:    loc,
		CheckClaims: true,
		Claims: []ClaimInput{
			{ID: "claim_dentist", Service: "calendar", Action: "modified", Target: "Dentist", Detail: "Moved to Wednesday at 10:00 AM"},
			{ID: "claim_goals", Service: "drive", Action: "created", Target: "Q2 goals", Detail: "Created a doc named Q2 goals"},
		},
	})
}
