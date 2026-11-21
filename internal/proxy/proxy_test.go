package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("LIFEDIFF_PROXY_CHILD") == "1" {
		child()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestProxyPassthroughRecordsAndRedacts(t *testing.T) {
	t.Setenv("LIFEDIFF_PROXY_CHILD", "1")
	capture := filepath.Join(t.TempDir(), "seen.json")
	t.Setenv("LIFEDIFF_PROXY_CAPTURE", capture)
	home := t.TempDir()
	now := time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC)
	logPath, err := Prepare(home, now)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("log mode %o", info.Mode().Perm())
	}
	var out bytes.Buffer
	var errOut bytes.Buffer
	in := strings.NewReader(strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_page","arguments":{"title":"Q2 goals","token":"sekret","note":"Authorization: Bearer ghp_1234567890abcdefghijklmnop password: hunter2 password=hunter2"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_note","arguments":{"text":"hello"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_pages","arguments":{"query":"react"}}}`,
		"",
	}, "\n"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = Run(ctx, []string{os.Args[0]}, in, &out, &errOut, Options{LogPath: logPath, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("proxy: %v\nstderr: %s\nstdout: %s", err, errOut.String(), out.String())
	}
	text := out.String()
	if !strings.Contains(text, `"id":1`) || !strings.Contains(text, `"id":2`) || !strings.Contains(text, "pong") {
		t.Fatalf("responses were not passed through:\n%s", text)
	}
	if strings.Contains(text, "sekret") {
		t.Fatal("stdout should be the child response, which does not echo the token")
	}
	seen, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(seen), "sekret") || !strings.Contains(string(seen), "create_page") {
		t.Fatalf("child did not receive the call untouched: %s", seen)
	}
	log, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(log.Entries) != 3 {
		t.Fatalf("entries %#v", log.Entries)
	}
	created := log.Entries[0]
	if created.Tool != "create_page" || created.Tone != "created" || !created.OK {
		t.Fatalf("created %#v", created)
	}
	if !strings.Contains(created.Summary, "Q2 goals") || strings.Contains(created.Summary, "create_page") {
		t.Fatalf("summary %q", created.Summary)
	}
	encoded, _ := json.Marshal(created.Arguments)
	if strings.Contains(string(encoded), "sekret") || strings.Contains(string(encoded), "hunter2") || strings.Contains(string(encoded), "ghp_1234567890abcdefghijklmnop") {
		t.Fatalf("arguments %s", encoded)
	}
	if !strings.Contains(string(encoded), "Authorization: Bearer [redacted]") || !strings.Contains(string(encoded), "password: [redacted]") || !strings.Contains(string(encoded), "password=[redacted]") {
		t.Fatalf("separators were rewritten: %s", encoded)
	}
	if strings.Contains(string(encoded), "Authorization=[redacted]") {
		t.Fatalf("colon separator was rewritten: %s", encoded)
	}
	if log.Entries[1].OK || log.Entries[1].Tone != "removed" || log.Entries[1].Verb != "send" {
		t.Fatalf("send %#v", log.Entries[1])
	}
	if log.Entries[2].Tone != "read" || log.Entries[2].Effect != "read" {
		t.Fatalf("read %#v", log.Entries[2])
	}
	html := string(RenderHTML(log))
	if !strings.Contains(html, "#0f5c32") || !strings.Contains(html, "#8d1c1c") || !strings.Contains(html, "Reported by proxy") {
		t.Fatal(html)
	}
	if strings.Contains(html, "sekret") {
		t.Fatal("html kept the token")
	}
	writeAt := strings.Index(html, "Q2 goals")
	details := strings.Index(html, "<details>")
	if writeAt < 0 || details < 0 || writeAt > details {
		t.Fatalf("writes should be outside the collapsed reads: %d %d", writeAt, details)
	}
	var printed bytes.Buffer
	Print(&printed, log, true)
	if !strings.Contains(printed.String(), "\033[32m") || !strings.Contains(printed.String(), "reported by proxy") {
		t.Fatal(printed.String())
	}
}

func child() {
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var msg map[string]any
		if err := dec.Decode(&msg); err != nil {
			return
		}
		method, _ := msg["method"].(string)
		if method == "tools/call" {
			if path := os.Getenv("LIFEDIFF_PROXY_CAPTURE"); path != "" {
				raw, _ := json.Marshal(msg)
				_ = os.WriteFile(path, raw, 0o600)
				_ = os.Unsetenv("LIFEDIFF_PROXY_CAPTURE")
			}
			params, _ := msg["params"].(map[string]any)
			name, _ := params["name"].(string)
			if name == "send_note" {
				_ = enc.Encode(map[string]any{
					"jsonrpc": "2.0",
					"id":      msg["id"],
					"error":   map[string]any{"code": -32000, "message": "nope"},
				})
				continue
			}
			_ = enc.Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      msg["id"],
				"result":  map[string]any{"content": []any{map[string]any{"type": "text", "text": "pong"}}},
			})
			continue
		}
		if _, ok := msg["id"]; ok {
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg["id"], "result": map[string]any{}})
		}
	}
}

func TestRedactValuePatterns(t *testing.T) {
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIBsecretvalue\n-----END RSA PRIVATE KEY-----"
	input := strings.Join([]string{
		"api_key=sk_test_51H1234567890abcd",
		"password: hunter2",
		"password=hunter2",
		"Authorization: Bearer ghp_1234567890abcdefghijklmnop",
		"authorization=Bearer gho_1234567890abcdefghijklmnop",
		"ghs_1234567890abcdefghijklmnop",
		"github_pat_11AAAAAAA0123456789abcdef",
		"sk_live_51H1234567890abcd",
		"rk_live_51H1234567890abcd",
		"xoxb-123456789012-abcdefghijklmnopqrstuv",
		"AKIAIOSFODNN7EXAMPLE",
		"AIzaSyD1234567890abcdefghijklmnopqrst",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
		pem,
	}, " ")
	cleaned := redactText(input)
	for _, secret := range []string{
		"hunter2", "sk_test_51H1234567890abcd", "sk_live_51H1234567890abcd", "rk_live_51H1234567890abcd",
		"ghp_1234567890abcdefghijklmnop", "gho_1234567890abcdefghijklmnop", "ghs_1234567890abcdefghijklmnop",
		"github_pat_11AAAAAAA0123456789abcdef", "xoxb-123456789012-abcdefghijklmnopqrstuv",
		"AKIAIOSFODNN7EXAMPLE", "AIzaSyD1234567890abcdefghijklmnopqrst",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "MIIBsecretvalue",
	} {
		if strings.Contains(cleaned, secret) {
			t.Fatalf("kept %s in %s", secret, cleaned)
		}
	}
	for _, want := range []string{
		"api_key=[redacted]",
		"password: [redacted]",
		"password=[redacted]",
		"Authorization: Bearer [redacted]",
		"authorization=Bearer [redacted]",
	} {
		if !strings.Contains(cleaned, want) {
			t.Fatalf("missing %s in %s", want, cleaned)
		}
	}
	if strings.Contains(cleaned, "Authorization=[redacted]") || strings.Contains(cleaned, "password:=") {
		t.Fatalf("rewrote a separator: %s", cleaned)
	}
	prose := "How does React reconcile a token bucket with a password reset email? The keynote covered the public API and a cookie recipe: chocolate chip."
	if redactText(prose) != prose {
		t.Fatalf("prose changed: %s", redactText(prose))
	}
	redacted := redactValue(map[string]any{
		"title": "Q2 goals",
		"token": "sekret",
		"note":  "Authorization: Bearer ghp_1234567890abcdefghijklmnop",
	}, 0)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if strings.Contains(text, "sekret") || strings.Contains(text, "ghp_1234567890abcdefghijklmnop") || !strings.Contains(text, "Authorization: Bearer [redacted]") || !strings.Contains(text, "Q2 goals") {
		t.Fatalf("value redaction %s", text)
	}
}

func TestClassifyReadsAndSummaries(t *testing.T) {
	ask := classifyTool("ask_wiki_question")
	if ask.effect != "read" || ask.verb != "ask" {
		t.Fatalf("ask %#v", ask)
	}
	if got := plainAction("deepwiki", ask, "How does React work?", true, "ask_wiki_question"); got != "Asked DeepWiki about 'How does React work?'." {
		t.Fatalf("ask summary %q", got)
	}
	read := classifyTool("read_wiki_structure")
	if got := plainAction("deepwiki", read, "facebook/react", true, "read_wiki_structure"); got != "Looked up the docs outline for facebook/react in DeepWiki." {
		t.Fatalf("read summary %q", got)
	}
	for _, name := range []string{"get_page", "describe_repo", "lookup_user", "check_status"} {
		if classifyTool(name).effect != "read" {
			t.Fatalf("%s", name)
		}
	}
}
