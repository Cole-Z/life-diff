package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"os/exec"
	"sync/atomic"
	"time"

	"golang.org/x/oauth2"
)

// LoginOptions controls the local browser sign-in.
type LoginOptions struct {
	ListenAddr  string
	OpenBrowser func(url string) error
	Exchange    func(ctx context.Context, cfg *oauth2.Config, code string) (*oauth2.Token, error)
	Timeout     time.Duration
	Out         io.Writer
	// ScopeNote is the sentence printed above the sign-in link.
	// An empty note keeps the Calendar and Drive wording.
	ScopeNote string
}

// Login runs the desktop loopback OAuth flow and returns a token.
// It does not print the token or the client secret.
func Login(ctx context.Context, cfg *oauth2.Config, opt LoginOptions) (*oauth2.Token, error) {
	if cfg == nil {
		return nil, errors.New("missing OAuth client configuration")
	}
	copied := *cfg
	cfg = &copied
	if opt.Timeout <= 0 {
		opt.Timeout = 3 * time.Minute
	}
	if opt.Exchange == nil {
		opt.Exchange = func(ctx context.Context, cfg *oauth2.Config, code string) (*oauth2.Token, error) {
			return cfg.Exchange(ctx, code)
		}
	}
	if opt.OpenBrowser == nil {
		opt.OpenBrowser = openBrowser
	}
	addr := opt.ListenAddr
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen for the Google redirect: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	cfg.RedirectURL = fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	state, err := randomState()
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	authURL := cfg.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.ApprovalForce)
	if opt.Out != nil {
		fmt.Fprintf(opt.Out, "Waiting for Google to redirect to %s\n", cfg.RedirectURL)
		note := opt.ScopeNote
		if note == "" {
			note = "Open this link to allow read-only access to Calendar and Drive:"
		}
		fmt.Fprintf(opt.Out, "%s\n\n%s\n\n", note, authURL)
	}

	type result struct {
		tok *oauth2.Token
		err error
	}
	done := make(chan result, 1)
	var once int32
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if !first(&once) {
			writePage(w, http.StatusConflict, "Already used", "This sign-in link was already used.")
			return
		}
		if !sameString(r.URL.Query().Get("state"), state) {
			writePage(w, http.StatusBadRequest, "Sign-in did not match", "This sign-in attempt did not match. Run lifediff auth again.")
			done <- result{err: errors.New("sign-in state did not match")}
			return
		}
		if oauthErr := r.URL.Query().Get("error"); oauthErr != "" {
			writePage(w, http.StatusBadRequest, "Sign-in stopped", "Google did not grant access. You can close this tab.")
			done <- result{err: fmt.Errorf("google sign-in was not completed (%s)", Redact(oauthErr))}
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			writePage(w, http.StatusBadRequest, "Missing code", "Google did not return a sign-in code.")
			done <- result{err: errors.New("google did not return a sign-in code")}
			return
		}
		tok, err := opt.Exchange(r.Context(), cfg, code)
		if err != nil {
			writePage(w, http.StatusBadGateway, "Sign-in failed", "Life Diff could not finish signing in. You can close this tab.")
			done <- result{err: fmt.Errorf("exchange Google sign-in code: %s", Redact(err.Error()))}
			return
		}
		writePage(w, http.StatusOK, "Life Diff is connected", "Read-only access is saved on this computer. You can close this tab.")
		done <- result{tok: tok}
	})

	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	if err := waitReady(ln.Addr().String()); err != nil {
		return nil, err
	}
	if err := opt.OpenBrowser(authURL); err != nil && opt.Out != nil {
		fmt.Fprintln(opt.Out, "Open the link above in your browser.")
	}

	timer := time.NewTimer(opt.Timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errors.New("timed out waiting for Google. Run lifediff auth again")
	case res := <-done:
		if res.err != nil {
			return nil, res.err
		}
		return res.tok, nil
	}
}

func first(flag *int32) bool {
	return atomic.CompareAndSwapInt32(flag, 0, 1)
}

func randomState() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func sameString(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func writePage(w http.ResponseWriter, status int, title, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>",
		html.EscapeString(title), html.EscapeString(title), html.EscapeString(body))
}

func openBrowser(url string) error {
	cmd := exec.Command("xdg-open", url)
	return cmd.Start()
}

func waitReady(addr string) error {
	deadline := time.Now().Add(2 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	if last == nil {
		last = errors.New("listener did not start")
	}
	return fmt.Errorf("local sign-in listener: %w", last)
}
