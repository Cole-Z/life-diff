// Package googleprov reads Google Calendar, Drive, and Gmail.
// It does not create, edit, delete, or send anything.
package googleprov

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Cole-Z/life-diff"
	"github.com/Cole-Z/life-diff/auth"
)

const maxBody = 8 << 20

// Client is a read-only Google API client. BaseURL is https://www.googleapis.com
// unless a test points it at a local server.
type Client struct {
	HTTP    *http.Client
	BaseURL string
}

// New returns a client that uses httpClient for signed requests.
func New(httpClient *http.Client) *Client {
	return &Client{HTTP: httpClient, BaseURL: "https://www.googleapis.com"}
}

func (c *Client) httpClient() *http.Client {
	if c != nil && c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) base() string {
	if c != nil && c.BaseURL != "" {
		return strings.TrimRight(c.BaseURL, "/")
	}
	return "https://www.googleapis.com"
}

type apiError struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

type httpStatusError struct {
	Status int
	Path   string
	Detail string
}

func (e *httpStatusError) Error() string {
	if e == nil {
		return ""
	}
	return e.Detail
}

func (c *Client) getJSON(ctx context.Context, path string, q url.Values, dest any) error {
	return c.doJSON(ctx, http.MethodGet, path, q, nil, dest)
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, dest any) error {
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	return c.doJSON(ctx, http.MethodPost, path, nil, body, dest)
}

func (c *Client) doJSON(ctx context.Context, method, path string, q url.Values, payload []byte, dest any) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	u := c.base() + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "lifediff/"+lifediff.Version)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("google request failed: %s", auth.Redact(err.Error()))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("read google response: %s", auth.Redact(err.Error()))
	}
	if len(body) > maxBody {
		return fmt.Errorf("google response for %s was larger than expected", path)
	}
	if resp.StatusCode == http.StatusGone {
		return lifediff.ErrSyncTokenExpired
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := googleMessage(body)
		if msg == "" {
			msg = resp.Status
		}
		return &httpStatusError{
			Status: resp.StatusCode,
			Path:   path,
			Detail: fmt.Sprintf("google %s: %s", path, auth.Redact(msg)),
		}
	}
	if dest == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, dest); err != nil {
		return fmt.Errorf("decode google %s: %s", path, auth.Redact(err.Error()))
	}
	return nil
}

// getBytes reads a text response, such as a Drive export or alt=media download.
// limit is the most bytes kept. truncated is true when the response was longer.
func (c *Client) getBytes(ctx context.Context, path string, q url.Values, limit int) ([]byte, bool, error) {
	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	if limit <= 0 {
		limit = lifediff.MaxDriveTextBytes
	}
	u := c.base() + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("User-Agent", "lifediff/"+lifediff.Version)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("google request failed: %s", auth.Redact(err.Error()))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		return nil, false, fmt.Errorf("read google response: %s", auth.Redact(err.Error()))
	}
	truncated := len(body) > limit
	if truncated {
		body = body[:limit]
	}
	if resp.StatusCode == http.StatusGone {
		return nil, false, lifediff.ErrSyncTokenExpired
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := googleMessage(body)
		if msg == "" {
			msg = resp.Status
		}
		return nil, false, &httpStatusError{
			Status: resp.StatusCode,
			Path:   path,
			Detail: fmt.Sprintf("google %s: %s", path, auth.Redact(msg)),
		}
	}
	return body, truncated, nil
}

func googleMessage(body []byte) string {
	var parsed apiError
	if err := json.Unmarshal(body, &parsed); err == nil && parsed.Error.Message != "" {
		return parsed.Error.Message
	}
	s := strings.TrimSpace(string(body))
	if len(s) > 180 {
		s = s[:180]
	}
	return s
}

func parseGoogleTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, s)
}
