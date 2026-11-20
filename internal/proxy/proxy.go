package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxMessage = 8 << 20

type Config struct {
	Command []string
	Name    string
	Dir     string
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer
	Now     func() time.Time
}

type Entry struct {
	Time          string `json:"time"`
	Upstream      string `json:"upstream"`
	Tool          string `json:"tool"`
	Arguments     any    `json:"arguments"`
	OK            bool   `json:"ok"`
	Summary       string `json:"summary"`
	Error         string `json:"error,omitempty"`
	DurationMs    int64  `json:"durationMs"`
	Effect        string `json:"effect"`
	Tone          string `json:"tone"`
	Source        string `json:"source"`
	ResultSummary string `json:"resultSummary,omitempty"`
}

func Serve(ctx context.Context, cfg Config) error {
	if len(cfg.Command) == 0 || cfg.Command[0] == "" {
		return errors.New("usage: lifediff proxy [--name service] -- <command> [args]")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Stdin == nil {
		cfg.Stdin = bytes.NewReader(nil)
	}
	if cfg.Stdout == nil {
		cfg.Stdout = io.Discard
	}
	if cfg.Stderr == nil {
		cfg.Stderr = io.Discard
	}
	name := cfg.Name
	if name == "" {
		name = defaultName(cfg.Command)
	}
	logFile, err := openLog(cfg.Dir, cfg.Now)
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.CommandContext(ctx, cfg.Command[0], cfg.Command[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cfg.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}

	track := &tracker{pending: map[string]pendingCall{}, log: logFile, upstream: name, now: cfg.Now, stderr: cfg.Stderr}
	var reqErr, respErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer stdin.Close()
		reqErr = copyLines(cfg.Stdin, stdin, track.noteRequest)
	}()
	go func() {
		defer wg.Done()
		respErr = copyLines(stdout, cfg.Stdout, track.noteResponse)
	}()
	wg.Wait()
	waitErr := cmd.Wait()
	if reqErr != nil && !errors.Is(reqErr, io.EOF) {
		return reqErr
	}
	if respErr != nil && !errors.Is(respErr, io.EOF) {
		return respErr
	}
	if waitErr != nil && ctx.Err() == nil {
		return waitErr
	}
	return nil
}

func defaultName(command []string) string {
	for i := len(command) - 1; i >= 0; i-- {
		if command[i] == "" || strings.HasPrefix(command[i], "-") {
			continue
		}
		base := filepath.Base(command[i])
		base = strings.TrimPrefix(base, "@")
		if base != "" && base != "." && base != string(filepath.Separator) {
			return base
		}
	}
	return "tool"
}

func openLog(dir string, now func() time.Time) (*os.File, error) {
	actions := filepath.Join(dir, "actions")
	if err := os.MkdirAll(actions, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(actions, 0o700); err != nil {
		return nil, err
	}
	id := sessionID(now())
	path := filepath.Join(actions, id+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	latest := filepath.Join(actions, "latest")
	if err := os.WriteFile(latest, []byte(id+"\n"), 0o600); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func sessionID(now time.Time) string {
	var extra [3]byte
	_, _ = rand.Read(extra[:])
	return now.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(extra[:])
}

type pendingCall struct {
	tool  string
	args  any
	start time.Time
}

type tracker struct {
	mu       sync.Mutex
	pending  map[string]pendingCall
	log      *os.File
	upstream string
	now      func() time.Time
	stderr   io.Writer
}

func (t *tracker) noteRequest(line []byte) {
	id, tool, args, ok := inspectRequest(line)
	if !ok {
		return
	}
	t.mu.Lock()
	t.pending[id] = pendingCall{tool: tool, args: redact(args), start: t.now()}
	t.mu.Unlock()
}

func (t *tracker) noteResponse(line []byte) {
	id, result, rpcErr, ok := inspectResponse(line)
	if !ok {
		return
	}
	t.mu.Lock()
	call, found := t.pending[id]
	if found {
		delete(t.pending, id)
	}
	t.mu.Unlock()
	if !found {
		return
	}
	finished := t.now()
	success, summaryText, errText := interpretResult(result, rpcErr)
	effect, kind := classify(call.tool)
	entry := Entry{
		Time:          finished.UTC().Format(time.RFC3339),
		Upstream:      t.upstream,
		Tool:          call.tool,
		Arguments:     call.args,
		OK:            success,
		Summary:       plainAction(t.upstream, call.tool, call.args, success),
		DurationMs:    finished.Sub(call.start).Milliseconds(),
		Effect:        string(effect),
		Tone:          string(kind),
		Source:        "proxy",
		ResultSummary: clip(summaryText, 400),
	}
	if errText != "" {
		entry.Error = clip(errText, 400)
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		fmt.Fprintf(t.stderr, "lifediff proxy: could not write the action log\n")
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, err := t.log.Write(append(encoded, '\n')); err != nil {
		fmt.Fprintf(t.stderr, "lifediff proxy: could not write the action log\n")
	}
}

func copyLines(src io.Reader, dst io.Writer, observe func([]byte)) error {
	reader := bufio.NewReaderSize(src, 64*1024)
	for {
		line, err := readMessage(reader)
		if len(line) > 0 {
			observe(line)
			if _, writeErr := dst.Write(line); writeErr != nil {
				return writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func readMessage(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > maxMessage {
			return buf, fmt.Errorf("mcp message exceeds %d bytes", maxMessage)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return buf, err
	}
}

func inspectRequest(line []byte) (string, string, any, bool) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &msg); err != nil {
		return "", "", nil, false
	}
	if msg.Method != "tools/call" || len(msg.ID) == 0 || msg.Params.Name == "" {
		return "", "", nil, false
	}
	var args any
	if len(msg.Params.Arguments) > 0 {
		_ = json.Unmarshal(msg.Params.Arguments, &args)
	}
	if args == nil {
		args = map[string]any{}
	}
	return string(msg.ID), msg.Params.Name, args, true
}

func inspectResponse(line []byte) (string, json.RawMessage, json.RawMessage, bool) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &msg); err != nil {
		return "", nil, nil, false
	}
	if msg.Method != "" || len(msg.ID) == 0 {
		return "", nil, nil, false
	}
	return string(msg.ID), msg.Result, msg.Error, true
}

func interpretResult(result, rpcErr json.RawMessage) (bool, string, string) {
	if len(rpcErr) > 0 && string(rpcErr) != "null" {
		var payload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(rpcErr, &payload)
		if payload.Message == "" {
			payload.Message = "The tool returned an error."
		}
		return false, payload.Message, payload.Message
	}
	var payload struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	_ = json.Unmarshal(result, &payload)
	var parts []string
	for _, block := range payload.Content {
		if strings.TrimSpace(block.Text) != "" {
			parts = append(parts, strings.TrimSpace(block.Text))
		}
	}
	text := strings.Join(parts, "\n")
	if text == "" {
		if payload.IsError {
			text = "The tool reported an error."
		} else {
			text = "The tool finished."
		}
	}
	if payload.IsError {
		return false, text, text
	}
	return true, text, ""
}
