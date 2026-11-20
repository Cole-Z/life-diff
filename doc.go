// Package lifediff builds a read-only before/after receipt of what changed in
// connected accounts.
//
// Each service is a Provider. Calendar and Drive are the first ones. A new
// service implements Provider in its own package and is registered on
// Engine.Providers. The engine does not name that service.
//
// Services do not keep the history this needs, so a caller stores a Snapshot
// and later compares a fresh read against it. BuildReceipt does not touch
// the network. A hosted product can reuse this package with its own providers.
package lifediff
