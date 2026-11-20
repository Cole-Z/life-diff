package lifediff

import (
	"fmt"
	"strings"
)

// PlainSummary is the short text form of a receipt.
func (r Receipt) PlainSummary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d added, %d removed, %d modified\n", r.Counts.Added, r.Counts.Removed, r.Counts.Modified)
	for _, ch := range r.Changes {
		fmt.Fprintf(&b, "%s (%s): %s\n", ch.Kind.Display(), ch.Service.Display(), ch.Summary)
	}
	if r.ClaimsChecked {
		fmt.Fprintf(&b, "Claims: %d verified, %d missing\n", r.Counts.VerifiedClaims, r.Counts.MissingClaims)
		for _, c := range r.Claims {
			if c.Status == ClaimMissing {
				fmt.Fprintf(&b, "Missing: %s. %s\n", c.Target, c.Reason)
			}
		}
	}
	return b.String()
}
