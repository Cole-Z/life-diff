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
	"sync"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const (
	// ScopeCalendarReadonly is the least-privilege Calendar scope this tool uses.
	ScopeCalendarReadonly = "https://www.googleapis.com/auth/calendar.readonly"
	// ScopeDriveMetadataReadonly reads Drive names, times, and parents, not file contents.
	ScopeDriveMetadataReadonly = "https://www.googleapis.com/auth/drive.metadata.readonly"
)

// ConfigFromCredentials parses a Google desktop OAuth client JSON file.
func ConfigFromCredentials(data []byte) (*oauth2.Config, error) {
	cfg, err := google.ConfigFromJSON(data, ScopeCalendarReadonly, ScopeDriveMetadataReadonly)
	if err != nil {
		return nil, fmt.Errorf("read OAuth client file: %s", Redact(err.Error()))
	}
	return cfg, nil
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
