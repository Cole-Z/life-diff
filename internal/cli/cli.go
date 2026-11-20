// Package cli implements the lifediff command.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cole-Z/life-diff"
	"github.com/Cole-Z/life-diff/auth"
	"github.com/Cole-Z/life-diff/googleprov"
	"github.com/Cole-Z/life-diff/internal/proxy"
	"github.com/Cole-Z/life-diff/mcpserver"
)

// ReaderFunc supplies the Calendar and Drive readers for a command.
// A test that only needs those two services can keep using it.
type ReaderFunc func(ctx context.Context, home string) (lifediff.CalendarReader, lifediff.DriveReader, error)

// ProviderFunc supplies the providers for a command. When it is set, Readers is not used.
type ProviderFunc func(ctx context.Context, home string) ([]lifediff.Provider, error)

// Options overrides process defaults. Tests set them so they do not touch a real account.
type Options struct {
	Home        string
	Now         func() time.Time
	Location    *time.Location
	Readers     ReaderFunc
	Providers   ProviderFunc
	OpenBrowser func(string) error
	Env         map[string]string
}

// Run executes one lifediff command. args does not include the program name.
func Run(ctx context.Context, args []string, stdout, stderr io.Writer, opt Options) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	a := &app{ctx: ctx, stdout: stdout, stderr: stderr, opt: opt}
	switch args[0] {
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	case "version", "-version", "--version":
		fmt.Fprintf(stdout, "lifediff %s\n", lifediff.Version)
		return 0
	case "auth":
		return a.auth(args[1:])
	case "snapshot":
		return a.snapshot(args[1:])
	case "diff":
		return a.diff(args[1:])
	case "receipt":
		return a.receipt(args[1:])
	case "proxy":
		return a.proxy(args[1:])
	case "mcp":
		return a.mcp(args[1:])
	case "demo":
		return a.demo(args[1:])
	default:
		fmt.Fprintf(stderr, "Unknown command %q.\n\n%s", args[0], usage)
		return 2
	}
}

const usage = `Life Diff writes one receipt of the tool calls an agent made through it.
A hosted receipt is at https://lifediff.dev/mcp. This command also reads
Google itself, and it can wrap a local MCP server.

Usage:
  lifediff auth [--access minimal|full] [--credentials file] [--status]
  lifediff snapshot [--from time] [--to time] [--calendar id] [--tz name] [--only calendar,drive,gmail]
  lifediff diff [--snapshot id] [--claims file] [--html file] [--json file] [--strict]
  lifediff receipt [id]
  lifediff proxy [--name service] -- <command> [args]
  lifediff mcp
  lifediff demo --html file [--json file]
  lifediff version

Times are RFC3339 or YYYY-MM-DD. Data stays on this computer under ~/.lifediff
(or LIFEDIFF_HOME). Put the Google desktop OAuth client JSON at
~/.lifediff/credentials.json or set LIFEDIFF_CREDENTIALS.

The default sign-in is read-only: calendar.readonly and drive.metadata.readonly.
lifediff auth --access full adds drive.readonly, drive.activity.readonly, and
gmail.readonly. That works without Google verification only when each person
uses their own OAuth client in Testing. The app still cannot write.
`

type app struct {
	ctx    context.Context
	stdout io.Writer
	stderr io.Writer
	opt    Options
}

func (a *app) auth(args []string) int {
	fs := flag.NewFlagSet("auth", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	status := fs.Bool("status", false, "report whether a sign-in is saved, without printing it")
	credFlag := fs.String("credentials", "", "path to the Google desktop client JSON")
	accessFlag := fs.String("access", auth.AccessMinimal, "minimal or full read-only access")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	access, err := auth.ParseAccess(*accessFlag)
	if err != nil {
		return a.fail(err)
	}
	home, err := a.ensureHome()
	if err != nil {
		return a.fail(err)
	}
	tokenPath := filepath.Join(home, "token.json")
	accessPath := filepath.Join(home, "access.json")
	if *status {
		if _, err := os.Stat(tokenPath); err != nil {
			fmt.Fprintf(a.stdout, "No saved sign-in.\nLooked at %s\n", tokenPath)
			return 1
		}
		fmt.Fprintf(a.stdout, "A saved sign-in is present.\nFile: %s\n", tokenPath)
		fmt.Fprintf(a.stdout, "Access: %s\n", savedAccessLabel(accessPath))
		return 0
	}
	credPath := *credFlag
	if credPath == "" {
		credPath = a.credentialsPath(home)
	}
	data, err := os.ReadFile(credPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return a.fail(fmt.Errorf("no OAuth client file at %s. Download a desktop client JSON from Google Cloud and save it there", credPath))
		}
		return a.fail(err)
	}
	_ = os.Chmod(credPath, 0o600)
	cfg, err := auth.ConfigFromCredentialsWithAccess(data, access)
	if err != nil {
		return a.fail(err)
	}
	scopes, err := auth.Scopes(access)
	if err != nil {
		return a.fail(err)
	}
	tok, err := auth.Login(a.ctx, cfg, auth.LoginOptions{
		Out:         a.stdout,
		OpenBrowser: a.opt.OpenBrowser,
		ScopeNote:   scopeNote(access, scopes),
	})
	if err != nil {
		return a.fail(err)
	}
	if err := auth.SaveToken(tokenPath, tok); err != nil {
		return a.fail(err)
	}
	if err := auth.SaveAccess(accessPath, access); err != nil {
		return a.fail(err)
	}
	fmt.Fprintf(a.stdout, "Saved a read-only sign-in for this computer.\nAccess: %s\nFile: %s\n", access, tokenPath)
	return 0
}

func scopeNote(access string, scopes []string) string {
	var b strings.Builder
	if access == auth.AccessFull {
		b.WriteString("Open this link to allow a broader read-only sign-in (still no writes).")
	} else {
		b.WriteString("Open this link to allow read-only access to Calendar and Drive metadata.")
	}
	b.WriteString("\nScopes:")
	for _, scope := range scopes {
		b.WriteString("\n  ")
		b.WriteString(scope)
	}
	return b.String()
}

func savedAccessLabel(path string) string {
	rec, err := auth.LoadAccess(path)
	if err != nil {
		return auth.AccessMinimal + " (default; run lifediff auth --access full to add Drive text, Drive Activity, and Gmail)"
	}
	return rec.Access
}

func (a *app) snapshot(args []string) int {
	fs := flag.NewFlagSet("snapshot", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	from := fs.String("from", "", "window start (RFC3339 or YYYY-MM-DD)")
	to := fs.String("to", "", "window end (RFC3339 or YYYY-MM-DD)")
	calendarID := fs.String("calendar", "primary", "calendar id")
	only := fs.String("only", "all", "all, or a comma-separated provider list such as calendar,drive,gmail")
	tz := fs.String("tz", "", "IANA timezone for the report")
	query := fs.String("drive-query", "", "Drive files.list query")
	maxFiles := fs.Int("max-files", lifediff.DefaultMaxDriveFiles, "maximum Drive files to store")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	loc, err := a.location(*tz)
	if err != nil {
		return a.fail(err)
	}
	sel, err := lifediff.ParseProviderList(*only)
	if err != nil {
		return a.fail(err)
	}
	start, err := parseTime(*from, loc)
	if err != nil {
		return a.fail(err)
	}
	end, err := parseTime(*to, loc)
	if err != nil {
		return a.fail(err)
	}
	eng, home, err := a.engine(loc)
	if err != nil {
		return a.fail(err)
	}
	snap, err := eng.TakeSnapshot(a.ctx, lifediff.SnapshotOptions{
		Only:          sel.Only,
		Extras:        sel.Extras,
		Calendar:      sel.Calendar,
		Drive:         sel.Drive,
		CalendarID:    *calendarID,
		WindowStart:   start,
		WindowEnd:     end,
		DriveQuery:    *query,
		MaxDriveFiles: *maxFiles,
	})
	if err != nil {
		return a.fail(err)
	}
	store := lifediff.Store{Dir: home}
	if err := store.SaveSnapshot(snap); err != nil {
		return a.fail(err)
	}
	fmt.Fprintf(a.stdout, "Saved snapshot %s\n", snap.ID)
	if snap.Calendar.Checked {
		fmt.Fprintf(a.stdout, "Calendar events: %d\n", len(snap.Calendar.Events))
	}
	if snap.Drive.Checked {
		fmt.Fprintf(a.stdout, "Drive files: %d\n", len(snap.Drive.Files))
	}
	for _, state := range snap.Providers {
		if state.ID == string(lifediff.ServiceCalendar) || state.ID == string(lifediff.ServiceDrive) {
			continue
		}
		fmt.Fprintf(a.stdout, "%s items: %d\n", state.DisplayName, state.ItemCount)
	}
	for _, w := range snap.Warnings {
		fmt.Fprintf(a.stdout, "Note: %s\n", w)
	}
	return 0
}

func (a *app) diff(args []string) int {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	snapshotID := fs.String("snapshot", "", "snapshot id; default is the latest")
	claimsPath := fs.String("claims", "", "JSON file of what the agent says it did")
	htmlPath := fs.String("html", "", "also write the HTML report here")
	jsonPath := fs.String("json", "", "also write the receipt JSON here")
	strict := fs.Bool("strict", false, "exit 3 when a claim is missing, a change was not claimed, or any change exists and no claims were given")
	tz := fs.String("tz", "", "IANA timezone for the report")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	loc, err := a.location(*tz)
	if err != nil {
		return a.fail(err)
	}
	eng, home, err := a.engine(loc)
	if err != nil {
		return a.fail(err)
	}
	store := lifediff.Store{Dir: home}
	var snap lifediff.Snapshot
	if *snapshotID == "" {
		snap, err = store.CurrentSnapshot()
	} else {
		snap, err = store.LoadSnapshot(*snapshotID)
	}
	if err != nil {
		if errors.Is(err, lifediff.ErrNoSnapshot) {
			return a.fail(fmt.Errorf("no snapshot yet. Run lifediff snapshot before lifediff diff"))
		}
		return a.fail(err)
	}
	opt := lifediff.CompareOptions{}
	if *claimsPath != "" {
		data, err := os.ReadFile(*claimsPath)
		if err != nil {
			return a.fail(err)
		}
		claims, err := lifediff.ParseClaims(data)
		if err != nil {
			return a.fail(err)
		}
		opt.Claims = claims
		opt.CheckClaims = true
	}
	receipt, err := eng.Compare(a.ctx, snap, opt)
	if err != nil {
		return a.fail(err)
	}
	return a.finishReceipt(store, receipt, *htmlPath, *jsonPath, *strict)
}

func (a *app) receipt(args []string) int {
	fs := flag.NewFlagSet("receipt", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	htmlPath := fs.String("html", "", "also write the HTML report here")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	home, err := a.ensureHome()
	if err != nil {
		return a.fail(err)
	}
	entries, actionErr := proxy.LoadLatest(home)
	store := lifediff.Store{Dir: home}
	var receipt lifediff.Receipt
	if fs.NArg() == 0 {
		receipt, err = store.CurrentReceipt()
	} else {
		receipt, err = store.LoadReceipt(fs.Arg(0))
	}
	code := 0
	if err == nil {
		code = a.finishReceipt(store, receipt, *htmlPath, "", false)
	}
	if actionErr == nil && len(entries) > 0 {
		fmt.Fprint(a.stdout, proxy.RenderTerminal(entries))
		page := proxy.RenderHTML(entries)
		path := filepath.Join(home, "actions", "latest.html")
		if *htmlPath != "" && err != nil {
			path = *htmlPath
		}
		if writeErr := writePrivate(path, page); writeErr != nil {
			return a.fail(writeErr)
		}
		fmt.Fprintf(a.stdout, "Actions HTML  %s\n", path)
	}
	if err != nil && (actionErr != nil || len(entries) == 0) {
		return a.fail(err)
	}
	return code
}

func (a *app) proxy(args []string) int {
	fs := flag.NewFlagSet("proxy", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	name := fs.String("name", "", "name of this tool on the receipt")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	command := fs.Args()
	if len(command) == 0 {
		fmt.Fprintf(a.stderr, "Usage: lifediff proxy [--name service] -- <command> [args]\n")
		return 2
	}
	home, err := a.ensureHome()
	if err != nil {
		return a.fail(err)
	}
	now := a.opt.Now
	if now == nil {
		now = time.Now
	}
	err = proxy.Serve(a.ctx, proxy.Config{
		Command: command,
		Name:    *name,
		Dir:     home,
		Stdin:   os.Stdin,
		Stdout:  a.stdout,
		Stderr:  a.stderr,
		Now:     now,
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		return a.fail(err)
	}
	return 0
}

func (a *app) finishReceipt(store lifediff.Store, receipt lifediff.Receipt, htmlPath, jsonPath string, strict bool) int {
	html, err := lifediff.RenderHTML(receipt)
	if err != nil {
		return a.fail(err)
	}
	if err := store.SaveReceipt(receipt, html); err != nil {
		return a.fail(err)
	}
	if htmlPath != "" {
		if err := writePrivate(htmlPath, html); err != nil {
			return a.fail(err)
		}
	}
	if jsonPath != "" {
		data, err := lifediff.Marshal(receipt)
		if err != nil {
			return a.fail(err)
		}
		if err := writePrivate(jsonPath, data); err != nil {
			return a.fail(err)
		}
	}
	fmt.Fprintf(a.stdout, "Life Diff receipt %s\n", receipt.ID)
	fmt.Fprint(a.stdout, receipt.PlainSummary())
	fmt.Fprintf(a.stdout, "JSON  %s\n", store.ReceiptPath(receipt.ID))
	fmt.Fprintf(a.stdout, "HTML  %s\n", store.ReportPath(receipt.ID))
	if strict && attention(receipt) {
		return 3
	}
	return 0
}

func attention(r lifediff.Receipt) bool {
	if r.ClaimsChecked {
		return r.Counts.MissingClaims > 0 || r.Counts.UnclaimedChanges > 0
	}
	return len(r.Changes) > 0
}

func (a *app) mcp(args []string) int {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	tz := fs.String("tz", "", "IANA timezone for receipts")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	loc, err := a.location(*tz)
	if err != nil {
		return a.fail(err)
	}
	home, err := a.ensureHome()
	if err != nil {
		return a.fail(err)
	}
	err = mcpserver.ServeStdio(a.ctx, mcpserver.Config{
		Store:    lifediff.Store{Dir: home},
		Location: loc,
		Now:      a.opt.Now,
		NewEngine: func(ctx context.Context) (*lifediff.Engine, error) {
			eng, _, err := a.engine(loc)
			return eng, err
		},
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		return a.fail(err)
	}
	return 0
}

func (a *app) demo(args []string) int {
	fs := flag.NewFlagSet("demo", flag.ContinueOnError)
	fs.SetOutput(a.stderr)
	htmlPath := fs.String("html", "", "write the sample HTML report")
	jsonPath := fs.String("json", "", "write the sample receipt JSON")
	if err := fs.Parse(args); err != nil {
		return flagCode(err)
	}
	receipt := lifediff.SampleReceipt()
	html, err := lifediff.RenderHTML(receipt)
	if err != nil {
		return a.fail(err)
	}
	data, err := lifediff.Marshal(receipt)
	if err != nil {
		return a.fail(err)
	}
	if *htmlPath == "" && *jsonPath == "" {
		fmt.Fprint(a.stdout, receipt.PlainSummary())
		return 0
	}
	if *htmlPath != "" {
		if err := os.WriteFile(*htmlPath, html, 0o644); err != nil {
			return a.fail(err)
		}
		fmt.Fprintf(a.stdout, "HTML  %s\n", *htmlPath)
	}
	if *jsonPath != "" {
		if err := os.WriteFile(*jsonPath, data, 0o644); err != nil {
			return a.fail(err)
		}
		fmt.Fprintf(a.stdout, "JSON  %s\n", *jsonPath)
	}
	return 0
}

func (a *app) engine(loc *time.Location) (*lifediff.Engine, string, error) {
	home, err := a.ensureHome()
	if err != nil {
		return nil, "", err
	}
	var providers []lifediff.Provider
	switch {
	case a.opt.Providers != nil:
		providers, err = a.opt.Providers(a.ctx, home)
	case a.opt.Readers != nil:
		var cal lifediff.CalendarReader
		var drive lifediff.DriveReader
		cal, drive, err = a.opt.Readers(a.ctx, home)
		if err != nil {
			return nil, "", err
		}
		if cal != nil {
			providers = append(providers, lifediff.NewCalendarProvider(cal))
		}
		if drive != nil {
			providers = append(providers, lifediff.NewDriveProvider(drive))
		}
	default:
		providers, err = googleProviders(a.ctx, home, a.getenv)
	}
	if err != nil {
		return nil, "", err
	}
	return &lifediff.Engine{
		Providers: providers,
		Now:       a.opt.Now,
		Location:  loc,
	}, home, nil
}

func googleProviders(ctx context.Context, home string, getenv func(string) string) ([]lifediff.Provider, error) {
	credPath := credentialsPath(home, getenv)
	data, err := os.ReadFile(credPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("no OAuth client file at %s. Save a desktop client JSON there, or set LIFEDIFF_CREDENTIALS", credPath)
		}
		return nil, err
	}
	_ = os.Chmod(credPath, 0o600)
	access := auth.AccessMinimal
	if rec, err := auth.LoadAccess(filepath.Join(home, "access.json")); err == nil && rec.Access != "" {
		access = rec.Access
	}
	cfg, err := auth.ConfigFromCredentialsWithAccess(data, access)
	if err != nil {
		return nil, err
	}
	tokenPath := filepath.Join(home, "token.json")
	if _, err := os.Stat(tokenPath); errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("not signed in. Run lifediff auth")
	}
	httpClient, err := auth.HTTPClient(ctx, cfg, tokenPath)
	if err != nil {
		return nil, err
	}
	return googleprov.Providers(httpClient, access), nil
}

func (a *app) ensureHome() (string, error) {
	home := a.opt.Home
	if home == "" {
		if v := a.getenv("LIFEDIFF_HOME"); v != "" {
			home = v
		} else {
			u, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			home = filepath.Join(u, ".lifediff")
		}
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return "", err
	}
	return home, nil
}

func (a *app) credentialsPath(home string) string {
	return credentialsPath(home, a.getenv)
}

func credentialsPath(home string, getenv func(string) string) string {
	if v := getenv("LIFEDIFF_CREDENTIALS"); v != "" {
		return v
	}
	return filepath.Join(home, "credentials.json")
}

func (a *app) getenv(key string) string {
	if a.opt.Env != nil {
		return a.opt.Env[key]
	}
	return os.Getenv(key)
}

func (a *app) location(tz string) (*time.Location, error) {
	if tz != "" {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			return nil, fmt.Errorf("unknown timezone %q", tz)
		}
		return loc, nil
	}
	if a.opt.Location != nil {
		return a.opt.Location, nil
	}
	return time.Local, nil
}

func (a *app) fail(err error) int {
	fmt.Fprintf(a.stderr, "Error: %s\n", err)
	return 1
}

func flagCode(err error) int {
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	return 2
}

func parseTime(s string, loc *time.Location) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if loc == nil {
		loc = time.UTC
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("use RFC3339 or YYYY-MM-DD, not %q", s)
	}
	return t, nil
}

func writePrivate(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmp)
		if werr != nil {
			return werr
		}
		return cerr
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Chmod(path, 0o600)
}
