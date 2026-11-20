package googleprov

import (
	"net/http"

	"github.com/Cole-Z/life-diff"
	"github.com/Cole-Z/life-diff/auth"
)

// Providers returns the Google providers for a saved access level.
// Minimal access is Calendar and Drive metadata. Full access adds Drive
// activity, Drive revision metadata, and Gmail metadata.
func Providers(httpClient *http.Client, access string) []lifediff.Provider {
	client := New(httpClient)
	cal := lifediff.NewCalendarProvider(&Calendar{Client: client})
	drive := &Drive{Client: client}
	driveProvider := lifediff.NewDriveProvider(drive)
	out := []lifediff.Provider{cal, driveProvider}
	if access == auth.AccessFull {
		lifediff.EnableDriveContentSignals(driveProvider)
		out = append(out, NewGmail(client))
	}
	return out
}
