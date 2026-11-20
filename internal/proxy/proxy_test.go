package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("LIFEDIFF_PROXY_HELPER") != "1" {
		t.Skip("child process")
	}
	capture := os.Getenv("LIFEDIFF_PROXY_CAPTURE")
	in := bufio.NewReader(os.Stdin)
	var received []byte
	for {
		line, err := in.ReadBytes('\n')
		received = append(received, line...)
		if len(bytes.TrimSpace(line)) > 0 {
			if response := helperResponse(line); len(response) > 0 {
				_, _ = os.Stdout.Write(response)
			}
		}
		if err != nil {
			break
		}
	}
	if capture != "" {
		_ = os.WriteFile(capture, received, 0o600)
	}
	os.Exit(0)
}

func helperResponse(line []byte) []byte {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &msg); err != nil || len(msg.ID) == 0 {
		return nil
	}
	if msg.Method == "tools/call" {
		return []byte(`{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{"content":[{"type":"text","text":"saved"}]}}` + "\n")
	}
	return []byte(`{"jsonrpc":"2.0","id":` + string(msg.ID) + `,"result":{}}` + "\n")
}

func TestServePassesToolsCallThrough(t *testing.T) {
	home := t.TempDir()
	capture := filepath.Join(home, "captured.bin")
	t.Setenv("LIFEDIFF_PROXY_HELPER", "1")
	t.Setenv("LIFEDIFF_PROXY_CAPTURE", capture)
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_page","arguments":{"title":"Q2 goals","password":"hunter2"}}}`,
	}, "\n") + "\n"
	var stdout, stderr bytes.Buffer
	err := Serve(context.Background(), Config{
		Command: []string{os.Args[0], "-test.run=^TestHelperProcess$"},
		Name:    "docs",
		Dir:     home,
		Stdin:   strings.NewReader(input),
		Stdout:  &stdout,
		Stderr:  &stderr,
		Now:     func() time.Time { return time.Date(2026, 4, 2, 15, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("serve: %v\nstderr: %s", err, stderr.String())
	}
	got, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != input {
		t.Fatalf("child stdin was changed\n got %q\nwant %q", got, input)
	}
	if !strings.Contains(stdout.String(), `"id":1`) || !strings.Contains(stdout.String(), `"text":"saved"`) {
		t.Fatalf("stdout %s", stdout.String())
	}
	if strings.Contains(stdout.String(), "hunter2") {
		t.Fatal("response should not be a rewritten request")
	}
	entries, err := LoadLatest(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries %#v", entries)
	}
	entry := entries[0]
	if entry.Tool != "create_page" || entry.Upstream != "docs" || !entry.OK || entry.Source != "proxy" {
		t.Fatalf("%#v", entry)
	}
	if entry.Tone != "added" || entry.Effect != "write" {
		t.Fatalf("class %#v", entry)
	}
	if entry.Summary != `Created "Q2 goals" in Docs.` {
		t.Fatal(entry.Summary)
	}
	encoded, _ := json.Marshal(entry.Arguments)
	if strings.Contains(string(encoded), "hunter2") || !strings.Contains(string(encoded), "[redacted]") {
		t.Fatal(string(encoded))
	}
	info, err := os.Stat(filepath.Join(home, "actions", strings.TrimSpace(mustRead(t, filepath.Join(home, "actions", "latest")))+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	html := RenderHTML(entries)
	if !bytes.Contains(html, []byte("#0f5c32")) || !bytes.Contains(html, []byte("Reported by proxy")) || !bytes.Contains(html, []byte("Created")) {
		t.Fatalf("html %s", html)
	}
	if bytes.Contains(html, []byte("hunter2")) {
		t.Fatal("html leaked the password")
	}
	terminal := RenderTerminal(entries)
	if !strings.Contains(terminal, `Created "Q2 goals" in Docs.`) {
		t.Fatal(terminal)
	}
}

func TestDefaultNameUsesLastCommand(t *testing.T) {
	if got := defaultName([]string{"npx", "-y", "@modelcontextprotocol/server-everything"}); got != "server-everything" {
		t.Fatal(got)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
