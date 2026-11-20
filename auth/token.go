// Package auth signs a desktop app in to Google with a locally stored token.
// Tokens and client secrets are written with mode 0600 and must not be logged.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const (
	// AccessMinimal is the default sign-in: Calendar read-only and Drive metadata.
	AccessMinimal = "minimal"
	// AccessFull adds read-only Drive text, Drive Activity, and Gmail messages.
	// It still cannot create, edit, or delete anything.
	AccessFull = "full"

	// ScopeCalendarReadonly is the least-privilege Calendar scope this tool uses.
	// https://developers.google.com/identity/protocols/oauth2/scopes
	ScopeCalendarReadonly = "https://www.googleapis.com/auth/calendar.readonly"
	// ScopeDriveMetadataReadonly reads Drive names, times, and parents, not file contents.
	ScopeDriveMetadataReadonly = "https://www.googleapis.com/auth/drive.metadata.readonly"
	// ScopeDriveReadonly is "View and download all your Drive files".
	// Full mode uses it to export Docs, Sheets, and Slides as text and to
	// download plain text files. It does not upload or edit files.
	ScopeDriveReadonly = "https://www.googleapis.com/auth/drive.readonly"
	// ScopeDriveActivityReadonly is "View the activity record of files in your Drive".
	ScopeDriveActivityReadonly = "https://www.googleapis.com/auth/drive.activity.readonly"
	// ScopeGmailReadonly is "View your email messages and settings".
	// Full mode uses it for subject, recipients, labels, and the snippet.
	// Requests use format=metadata and do not ask for format=full or format=raw.
	ScopeGmailReadonly = "https://www.googleapis.com/auth/gmail.readonly"
)

// SavedAccess is the access level written next to the token. It is not a secret,
// but it is stored with mode 0600 beside the token file.
type SavedAccess struct {
	Access string   `json:"access"`
	Scopes []string `json:"scopes"`
}

// ParseAccess accepts "minimal" (the default) and "full".
func ParseAccess(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", AccessMinimal, "least", "default":
		return AccessMinimal, nil
	case AccessFull, "full-read", "readonly-full":
		return AccessFull, nil
	default:
		return "", fmt.Errorf("unknown access %q (use minimal or full)", s)
	}
}

// Scopes returns the read-only Google scopes for an access level.
// Names match Google's OAuth scope list. None of them grant write access.
func Scopes(access string) ([]string, error) {
	switch access {
	case AccessMinimal:
		return []string{ScopeCalendarReadonly, ScopeDriveMetadataReadonly}, nil
	case AccessFull:
		// drive.readonly replaces drive.metadata.readonly. It is a broader read,
		// not an additional write. Activity and Gmail are separate APIs.
		return []string{
			ScopeCalendarReadonly,
			ScopeDriveReadonly,
			ScopeDriveActivityReadonly,
			ScopeGmailReadonly,
		}, nil
	default:
		return nil, fmt.Errorf("unknown access %q", access)
	}
}

// ConfigFromCredentials parses a desktop OAuth client and requests minimal scopes.
func ConfigFromCredentials(data []byte) (*oauth2.Config, error) {
	return ConfigFromCredentialsWithAccess(data, AccessMinimal)
}

// ConfigFromCredentialsWithAccess parses a desktop OAuth client for one access level.
func ConfigFromCredentialsWithAccess(data []byte, access string) (*oauth2.Config, error) {
	scopes, err := Scopes(access)
	if err != nil {
		return nil, err
	}
	cfg, err := google.ConfigFromJSON(data, scopes...)
	if err != nil {
		return nil, fmt.Errorf("read OAuth client file: %s", Redact(err.Error()))
	}
	return cfg, nil
}

// SaveAccess writes the chosen access level so later commands request the same scopes.
func SaveAccess(path string, access string) error {
	scopes, err := Scopes(access)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(SavedAccess{Access: access, Scopes: scopes}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writePrivate(path, data)
}

// LoadAccess reads a saved access level. A missing file is os.ErrNotExist.
func LoadAccess(path string) (SavedAccess, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return SavedAccess{}, err
	}
	_ = os.Chmod(path, 0o600)
	var rec SavedAccess
	if err := json.Unmarshal(b, &rec); err != nil {
		return SavedAccess{}, errors.New("the saved access file is not valid; run lifediff auth")
	}
	access, err := ParseAccess(rec.Access)
	if err != nil {
		return SavedAccess{}, err
	}
	rec.Access = access
	return rec, nil
}

// SaveToken writes a token so only the current user can read it.
func SaveToken(path string, tok *oauth2.Token) error {
	if tok == nil || (tok.AccessToken == "" && tok.RefreshToken == "") {
		return errors.New("refusing to save an empty Google sign-in")
	}
	data, err := json.MarshalIndent(tok, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writePrivate(path, data)
}

// LoadToken reads a previously saved token. The file mode is tightened to 0600.
func LoadToken(path string) (*oauth2.Token, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	var tok oauth2.Token
	if err := json.Unmarshal(b, &tok); err != nil {
		return nil, errors.New("the saved Google sign-in file is not valid; run lifediff auth")
	}
	if tok.AccessToken == "" && tok.RefreshToken == "" {
		return nil, errors.New("the saved Google sign-in file is empty; run lifediff auth")
	}
	return &tok, nil
}

// HTTPClient returns an HTTP client that sends the saved token and writes back refreshes.
func HTTPClient(ctx context.Context, cfg *oauth2.Config, tokenPath string) (*http.Client, error) {
	tok, err := LoadToken(tokenPath)
	if err != nil {
		return nil, err
	}
	reuse := oauth2.ReuseTokenSource(tok, cfg.TokenSource(ctx, tok))
	src := &persistingSource{base: reuse, path: tokenPath, lastAccess: tok.AccessToken}
	return oauth2.NewClient(ctx, src), nil
}

type persistingSource struct {
	mu         sync.Mutex
	base       oauth2.TokenSource
	path       string
	lastAccess string
}

func (p *persistingSource) Token() (*oauth2.Token, error) {
	tok, err := p.base.Token()
	if err != nil {
		return nil, fmt.Errorf("refresh Google sign-in: %s", Redact(err.Error()))
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if tok.AccessToken != p.lastAccess {
		if err := SaveToken(p.path, tok); err != nil {
			return nil, err
		}
		p.lastAccess = tok.AccessToken
	}
	return tok, nil
}

func writePrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil {
		_ = os.Remove(tmp)
		return werr
	}
	if cerr != nil {
		_ = os.Remove(tmp)
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
