package auth

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

func TestRedact(t *testing.T) {
	in := `header Bearer super-secret-token json "client_secret":"super-secret-value" form access_token=ya29.supersecretvalue refresh_token=1//abcdef code=4/0Acode`
	out := Redact(in)
	for _, secret := range []string{"super-secret-token", "super-secret-value", "ya29.supersecretvalue", "1//abcdef", "4/0Acode"} {
		if strings.Contains(out, secret) {
			t.Fatalf("secret %q leaked in %s", secret, out)
		}
	}
}

func TestFullScopesAreReadOnly(t *testing.T) {
	b, err := os.ReadFile("testdata/credentials.json")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ConfigFromCredentialsWithAccess(b, AccessFull)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, scope := range cfg.Scopes {
		got[scope] = true
		if strings.Contains(scope, "gmail.modify") || strings.Contains(scope, "gmail.compose") || strings.Contains(scope, "gmail.insert") || strings.Contains(scope, "gmail.metadata") || scope == "https://mail.google.com/" {
			t.Fatal(scope)
		}
		if scope == "https://www.googleapis.com/auth/drive" || scope == "https://www.googleapis.com/auth/drive.activity" || scope == "https://www.googleapis.com/auth/calendar" {
			t.Fatal(scope)
		}
	}
	for _, want := range []string{ScopeCalendarReadonly, ScopeDriveReadonly, ScopeDriveActivityReadonly, ScopeGmailReadonly} {
		if !got[want] {
			t.Fatalf("missing %s in %v", want, cfg.Scopes)
		}
	}
	if got[ScopeDriveMetadataReadonly] {
		t.Fatal("full access should use drive.readonly instead of drive.metadata.readonly")
	}
	path := filepath.Join(t.TempDir(), "access.json")
	if err := SaveAccess(path, AccessFull); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	loaded, err := LoadAccess(path)
	if err != nil || loaded.Access != AccessFull || len(loaded.Scopes) != 4 {
		t.Fatalf("%+v %v", loaded, err)
	}
}

func TestScopesAreReadOnly(t *testing.T) {
	b, err := os.ReadFile("testdata/credentials.json")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ConfigFromCredentials(b)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(cfg.Scopes, " ")
	if !strings.Contains(got, ScopeCalendarReadonly) || !strings.Contains(got, ScopeDriveMetadataReadonly) {
		t.Fatal(got)
	}
	if strings.Contains(got, "calendar.events") || strings.Contains(got, "/auth/drive\"") || strings.Contains(got, "auth/drive ") {
		t.Fatal(got)
	}
	for _, scope := range cfg.Scopes {
		if scope != ScopeCalendarReadonly && scope != ScopeDriveMetadataReadonly {
			t.Fatal(scope)
		}
	}
}

func TestSaveTokenPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "token.json")
	secret := "ya29.saved-token-value"
	if err := SaveToken(path, &oauth2.Token{AccessToken: secret, RefreshToken: "1//refresh-value"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", dirInfo.Mode().Perm())
	}
	loaded, err := LoadToken(path)
	if err != nil || loaded.AccessToken != secret {
		t.Fatal(err)
	}
	if err := SaveToken(path, &oauth2.Token{}); err == nil {
		t.Fatal("empty token should be refused")
	}
}

func TestPersistingSourceRedactsAndSaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token.json")
	if err := SaveToken(path, &oauth2.Token{AccessToken: "first-token", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	src := &persistingSource{
		base:       oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "second-token", RefreshToken: "refresh"}),
		path:       path,
		lastAccess: "first-token",
	}
	tok, err := src.Token()
	if err != nil || tok.AccessToken != "second-token" {
		t.Fatal(err, tok)
	}
	loaded, err := LoadToken(path)
	if err != nil || loaded.AccessToken != "second-token" {
		t.Fatal(err, loaded)
	}
	bad := &persistingSource{base: errSource{}, path: path, lastAccess: "second-token"}
	_, err = bad.Token()
	if err == nil || strings.Contains(err.Error(), "ya29.supersecretvalue") {
		t.Fatal(err)
	}
}

type errSource struct{}

func (errSource) Token() (*oauth2.Token, error) {
	return nil, errors.New("oauth failed access_token=ya29.supersecretvalue")
}

func TestLoginLoopback(t *testing.T) {
	cfg := testConfig(t)
	var gotCode string
	var out bytes.Buffer
	tok, err := Login(context.Background(), cfg, LoginOptions{
		Out: &out,
		OpenBrowser: func(raw string) error {
			u, err := url.Parse(raw)
			if err != nil {
				return err
			}
			cb, err := url.Parse(u.Query().Get("redirect_uri"))
			if err != nil {
				return err
			}
			q := cb.Query()
			q.Set("code", "good-code")
			q.Set("state", u.Query().Get("state"))
			cb.RawQuery = q.Encode()
			resp, err := http.Get(cb.String())
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte("Life Diff is connected")) {
				return errors.New(resp.Status + " " + string(body))
			}
			return nil
		},
		Exchange: func(ctx context.Context, cfg *oauth2.Config, code string) (*oauth2.Token, error) {
			gotCode = code
			if !strings.Contains(strings.Join(cfg.Scopes, " "), ScopeCalendarReadonly) {
				return nil, errors.New("scopes missing")
			}
			return &oauth2.Token{AccessToken: "ya29.login-token", RefreshToken: "1//login-refresh"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotCode != "good-code" || tok.AccessToken != "ya29.login-token" {
		t.Fatalf("code %s token %#v", gotCode, tok)
	}
	text := out.String()
	if strings.Contains(text, "super-secret-value") || strings.Contains(text, "ya29.login-token") || strings.Contains(text, "1//login-refresh") {
		t.Fatal(text)
	}
	if !strings.Contains(text, "calendar.readonly") && !strings.Contains(text, "accounts.google.com") {
		t.Fatal(text)
	}
}

func TestLoginRejectsStateMismatch(t *testing.T) {
	cfg := testConfig(t)
	_, err := Login(context.Background(), cfg, LoginOptions{
		Out: io.Discard,
		OpenBrowser: func(raw string) error {
			u, err := url.Parse(raw)
			if err != nil {
				return err
			}
			cb, err := url.Parse(u.Query().Get("redirect_uri"))
			if err != nil {
				return err
			}
			q := cb.Query()
			q.Set("code", "good-code")
			q.Set("state", "not-the-state")
			cb.RawQuery = q.Encode()
			resp, err := http.Get(cb.String())
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			return nil
		},
		Exchange: func(context.Context, *oauth2.Config, string) (*oauth2.Token, error) {
			return nil, errors.New("exchange should not run")
		},
	})
	if err == nil || !strings.Contains(err.Error(), "did not match") {
		t.Fatal(err)
	}
}

func testConfig(t *testing.T) *oauth2.Config {
	t.Helper()
	b, err := os.ReadFile("testdata/credentials.json")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ConfigFromCredentials(b)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}
