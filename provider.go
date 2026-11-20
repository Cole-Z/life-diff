package lifediff

import (
	"context"
	"time"
)

// CalendarReader is the read-only Calendar surface the engine needs.
// Implementations must not create, edit, or delete events.
type CalendarReader interface {
	ListWindow(ctx context.Context, calendarID string, start, end time.Time) ([]CalendarEvent, error)
	CurrentSyncToken(ctx context.Context, calendarID string) (string, error)
	ListSyncChanges(ctx context.Context, calendarID, syncToken string) ([]CalendarEvent, error)
}

// DriveReader is the read-only Drive surface the engine needs.
// Implementations must not upload, update, or delete files.
type DriveReader interface {
	StartPageToken(ctx context.Context) (string, error)
	ListFiles(ctx context.Context, query string, maxFiles int) (DriveFileList, error)
	ListChanges(ctx context.Context, pageToken string) (DriveChangeList, error)
}
