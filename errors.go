package lifediff

import "errors"

var (
	// ErrSyncTokenExpired means Google rejected a Calendar sync token and a full
	// window read is required. Sync tokens expire; they are not a stored history.
	ErrSyncTokenExpired = errors.New("calendar sync token expired")

	// ErrNoSnapshot means diff was asked to run before any snapshot was saved.
	ErrNoSnapshot = errors.New("no snapshot yet")

	// ErrTooManyEvents means a calendar window was cut off. Comparing it would
	// report events that were merely unread as removed, so the read fails instead.
	ErrTooManyEvents = errors.New("calendar window has too many events to compare safely")
)
