// Package lifediff builds a read-only before/after receipt of what changed in
// Google Calendar and Google Drive.
//
// Calendar and Drive do not keep a history Life Diff can read, so a caller
// stores a Snapshot from its own machine and later compares a fresh read
// against it. The comparison is pure: Engine talks to provider interfaces,
// and BuildReceipt does not touch the network. A hosted product can reuse
// this package with its own CalendarReader and DriveReader.
package lifediff
