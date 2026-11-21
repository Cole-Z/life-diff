// Package proxy wraps one stdio MCP server and records tools/call pairs.
package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Entry is one forwarded tools/call.
type Entry struct {
	Time       string `json:"time"`
	Upstream   string `json:"upstream"`
	Tool       string `json:"tool"`
	Arguments  any    `json:"arguments,omitempty"`
	OK         bool   `json:"ok"`
	Status     string `json:"status"`
	Summary    string `json:"summary"`
	Effect     string `json:"effect"`
	Tone       string `json:"tone"`
	Verb       string `json:"verb,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	Result     string `json:"result,omitempty"`
	Source     string `json:"source"`
}

// Log is the action log for one proxy process.
type Log struct {
	ID      string
	Path    string
	Entries []Entry
}

// Options controls a proxy run.
type Options struct {
	LogPath  string
	Upstream string
	Now      func() time.Time
}

// Run starts argv, copies JSON-RPC between stdin/stdout and the child, and appends tools/call records.
// The JSON lines are forwarded unchanged. A log write failure is reported on stderr and does not drop the response.
func Run(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer, opt Options) error {
	if len(argv) == 0 || argv[0] == "" {
		return errors.New("missing command")
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Upstream == "" {
		opt.Upstream = filepath.Base(argv[0])
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stderr = stderr
	childIn, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	childOut, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	bridge := &bridge{opt: opt, stderr: stderr, pending: map[string]pendingCall{}}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		defer childIn.Close()
		bridge.copy(stdin, childIn, bridge.onRequest)
	}()
	go func() {
		defer wg.Done()
		bridge.copy(childOut, stdout, bridge.onResponse)
	}()
	wg.Wait()
	return cmd.Wait()
}

// Prepare creates the action directory and points "latest" at a new log file.
func Prepare(home string, now time.Time) (string, error) {
	dir := filepath.Join(home, "actions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	id := "act_" + now.UTC().Format("20060102T150405Z")
	path := filepath.Join(dir, id+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "latest"), []byte(id+"\n"), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// Load reads the latest action log. A missing log is an error.
func Load(home string) (Log, error) {
	dir := filepath.Join(home, "actions")
	raw, err := os.ReadFile(filepath.Join(dir, "latest"))
	if err != nil {
		return Log{}, err
	}
	id := strings.TrimSpace(string(raw))
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "..") {
		return Log{}, errors.New("action log pointer is not valid")
	}
	path := filepath.Join(dir, id+".jsonl")
	entries, err := readEntries(path)
	if err != nil {
		return Log{}, err
	}
	return Log{ID: id, Path: path, Entries: entries}, nil
}

type pendingCall struct {
	tool string
	args json.RawMessage
	at   time.Time
}

type bridge struct {
	opt     Options
	stderr  io.Writer
	mu      sync.Mutex
	pending map[string]pendingCall
	warned  bool
}

func (b *bridge) copy(in io.Reader, out io.Writer, observe func(string)) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if observe != nil {
			observe(line)
		}
		if _, err := io.WriteString(out, line+"\n"); err != nil {
			return
		}
	}
}

func (b *bridge) onRequest(line string) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"params"`
	}
	if json.Unmarshal([]byte(line), &msg) != nil || msg.Method != "tools/call" || len(msg.ID) == 0 {
		return
	}
	b.mu.Lock()
	b.pending[string(msg.ID)] = pendingCall{tool: msg.Params.Name, args: append(json.RawMessage(nil), msg.Params.Arguments...), at: time.Now()}
	b.mu.Unlock()
}

func (b *bridge) onResponse(line string) {
	var msg struct {
		ID    json.RawMessage `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal([]byte(line), &msg) != nil || len(msg.ID) == 0 {
		return
	}
	b.mu.Lock()
	call, ok := b.pending[string(msg.ID)]
	if ok {
		delete(b.pending, string(msg.ID))
	}
	b.mu.Unlock()
	if !ok || b.opt.LogPath == "" {
		return
	}
	entry := b.entry(call, msg.Error, msg.Result)
	if err := appendEntry(b.opt.LogPath, entry); err != nil {
		b.warn(err)
	}
}

func (b *bridge) entry(call pendingCall, rpcErr *struct {
	Message string `json:"message"`
}, result json.RawMessage) Entry {
	class := classifyTool(call.tool)
	ok := rpcErr == nil
	var text string
	if len(result) > 0 {
		var parsed struct {
			IsError bool `json:"isError"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(result, &parsed) == nil {
			if parsed.IsError {
				ok = false
			}
			for _, block := range parsed.Content {
				if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
					text = clip(redactText(block.Text), 400)
					break
				}
			}
		}
	}
	args := redactRaw(call.args)
	summary := plainAction(b.opt.Upstream, class, subject(args), ok, call.tool)
	status := "ok"
	errText := ""
	if !ok {
		status = "error"
		if rpcErr != nil {
			errText = clip(redactText(rpcErr.Message), 500)
		} else if text != "" {
			errText = text
		} else {
			errText = "The tool reported an error."
		}
	}
	entry := Entry{
		Time:       b.opt.Now().UTC().Format(time.RFC3339),
		Upstream:   b.opt.Upstream,
		Tool:       call.tool,
		Arguments:  args,
		OK:         ok,
		Status:     status,
		Summary:    summary,
		Effect:     class.effect,
		Tone:       class.tone,
		Verb:       class.verb,
		DurationMs: time.Since(call.at).Milliseconds(),
		Source:     "proxy",
	}
	if errText != "" {
		entry.Error = errText
	}
	if text != "" && ok {
		entry.Result = text
	}
	return entry
}

func (b *bridge) warn(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.warned {
		return
	}
	b.warned = true
	fmt.Fprintf(b.stderr, "lifediff proxy could not write the action log: %s\n", err)
}

func appendEntry(path string, entry Entry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(raw, '\n'))
	return err
}

func readEntries(path string) ([]Entry, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var entries []Entry
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry Entry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, scanner.Err()
}

type classification struct {
	effect string
	tone   string
	verb   string
}

func classifyTool(name string) classification {
	tokens := strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return r < 'a' || r > 'z' })
	if verb := firstToken(tokens, "delete", "remove", "send"); verb != "" {
		return classification{effect: "write", tone: "removed", verb: verb}
	}
	if verb := firstToken(tokens, "create", "add", "insert"); verb != "" {
		return classification{effect: "write", tone: "created", verb: verb}
	}
	if verb := firstToken(tokens, "update", "move", "write", "post", "edit", "patch", "set", "rename"); verb != "" {
		return classification{effect: "write", tone: "changed", verb: verb}
	}
	if verb := firstToken(tokens, "get", "list", "search", "read", "fetch", "query", "ask", "describe", "lookup", "check"); verb != "" {
		return classification{effect: "read", tone: "read", verb: verb}
	}
	return classification{effect: "unknown", tone: "unknown"}
}

func firstToken(tokens []string, words ...string) string {
	for _, token := range tokens {
		for _, word := range words {
			if token == word {
				return token
			}
		}
	}
	return ""
}

func plainAction(service string, class classification, subject string, ok bool, tool string) string {
	label := displayName(service)
	lower := strings.ToLower(tool)
	if strings.Contains(lower, "read_wiki_structure") {
		return wikiLine("the docs outline", subject, label, ok)
	}
	if strings.Contains(lower, "read_wiki_contents") {
		return wikiLine("the docs", subject, label, ok)
	}
	if !ok {
		if subject != "" {
			return fmt.Sprintf("Could not use %s for '%s'.", label, subject)
		}
		return fmt.Sprintf("Could not use %s.", label)
	}
	switch class.tone {
	case "created":
		if subject != "" {
			return fmt.Sprintf("Created '%s' in %s.", subject, label)
		}
		return fmt.Sprintf("Created something in %s.", label)
	case "changed":
		if subject != "" {
			return fmt.Sprintf("Changed '%s' in %s.", subject, label)
		}
		return fmt.Sprintf("Changed something in %s.", label)
	case "removed":
		if class.verb == "send" {
			if subject != "" {
				return fmt.Sprintf("Sent '%s' from %s.", subject, label)
			}
			return fmt.Sprintf("Sent something from %s.", label)
		}
		if subject != "" {
			return fmt.Sprintf("Deleted '%s' in %s.", subject, label)
		}
		return fmt.Sprintf("Deleted something in %s.", label)
	case "read":
		if class.verb == "ask" {
			if subject != "" {
				return fmt.Sprintf("Asked %s about '%s'.", label, subject)
			}
			return fmt.Sprintf("Asked %s a question.", label)
		}
		if subject != "" {
			return fmt.Sprintf("Looked up '%s' in %s.", subject, label)
		}
		return fmt.Sprintf("Looked something up in %s.", label)
	default:
		if subject != "" {
			return fmt.Sprintf("Looked up '%s' in %s.", subject, label)
		}
		return fmt.Sprintf("Looked something up in %s.", label)
	}
}

func wikiLine(what, subject, label string, ok bool) string {
	topic := subject
	if topic == "" {
		topic = "a repository"
	}
	if ok {
		return fmt.Sprintf("Looked up %s for %s in %s.", what, topic, label)
	}
	return fmt.Sprintf("Could not look up %s for %s in %s.", what, topic, label)
}

func displayName(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "Service"
	}
	compact := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(trimmed))
	switch compact {
	case "deepwiki":
		return "DeepWiki"
	case "github":
		return "GitHub"
	case "googlecalendar", "calendar":
		return "Google Calendar"
	case "googledrive", "drive":
		return "Google Drive"
	case "gmail":
		return "Gmail"
	case "slack":
		return "Slack"
	case "notion":
		return "Notion"
	case "linear":
		return "Linear"
	}
	parts := strings.FieldsFunc(trimmed, func(r rune) bool { return r == ' ' || r == '_' || r == '-' })
	for i, part := range parts {
		r, size := utf8.DecodeRuneInString(part)
		if r == utf8.RuneError || size == 0 {
			continue
		}
		parts[i] = strings.ToUpper(string(r)) + part[size:]
	}
	if len(parts) == 0 {
		return "Service"
	}
	return strings.Join(parts, " ")
}

func subject(value any) string {
	record, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"title", "name", "query", "q", "text", "message", "subject", "path", "repo", "reponame", "url", "question"} {
		if text, ok := stringField(record, key); ok {
			return clip(text, 80)
		}
	}
	for key, item := range record {
		if secretKey(key) {
			continue
		}
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" && text != "[redacted]" {
			return clip(text, 80)
		}
	}
	return ""
}

func stringField(record map[string]any, wanted string) (string, bool) {
	for key, item := range record {
		if strings.EqualFold(key, wanted) {
			text, ok := item.(string)
			if ok && strings.TrimSpace(text) != "" && text != "[redacted]" {
				return text, true
			}
		}
	}
	return "", false
}

var (
	privateKeyRE = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	assignRE     = regexp.MustCompile(`(?i)\b(access[_-]?token|private[_-]?key|client[_-]?secret|api[_-]?key|password|passwd|authorization|cookie|token|secret|pwd)\b(\s*[:=]\s*)("[^"\n]{0,400}"|'[^'\n]{0,400}'|bearer\s+\S+|\S+)`)
	assignParse  = regexp.MustCompile(`(?i)\b(access[_-]?token|private[_-]?key|client[_-]?secret|api[_-]?key|password|passwd|authorization|cookie|token|secret|pwd)\b(\s*[:=]\s*)("[^"\n]{0,400}"|'[^'\n]{0,400}'|bearer\s+\S+|\S+)`)
	bearerValue  = regexp.MustCompile(`(?i)^(bearer\s+)\S+`)
	bearerRE     = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`)
	tokenShapes  = []*regexp.Regexp{
		regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{16,}\b`),
		regexp.MustCompile(`\bgh[pos]_[A-Za-z0-9_]{16,}\b`),
		regexp.MustCompile(`\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b`),
		regexp.MustCompile(`\brk_[A-Za-z0-9_]{16,}\b`),
		regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}\b`),
		regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
		regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{20,}\b`),
		regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`),
	}
)

// redactText hides secret values written inside ordinary text. It keeps the key, the separator, and a Bearer scheme.
func redactText(value string) string {
	value = privateKeyRE.ReplaceAllString(value, "[redacted]")
	value = assignRE.ReplaceAllStringFunc(value, func(match string) string {
		parts := assignParse.FindStringSubmatch(match)
		if len(parts) < 4 {
			return "[redacted]"
		}
		return parts[1] + parts[2] + redactAssigned(parts[3])
	})
	value = bearerRE.ReplaceAllString(value, "Bearer [redacted]")
	for _, pattern := range tokenShapes {
		value = pattern.ReplaceAllString(value, "[redacted]")
	}
	return value
}

func redactAssigned(value string) string {
	if len(value) >= 2 {
		quote := value[0]
		if (quote == '"' || quote == '\'') && value[len(value)-1] == quote {
			return string(quote) + redactAssignedBody(value[1:len(value)-1]) + string(quote)
		}
	}
	return redactAssignedBody(value)
}

func redactAssignedBody(value string) string {
	if parts := bearerValue.FindStringSubmatch(value); len(parts) == 2 {
		return parts[1] + "[redacted]"
	}
	return "[redacted]"
}

func redactRaw(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	redacted := redactValue(value, 0)
	encoded, err := json.Marshal(redacted)
	if err != nil || len(encoded) > 4000 {
		return map[string]any{"note": "arguments were too large to store"}
	}
	return redacted
}

func redactValue(value any, depth int) any {
	if depth > 6 {
		return "[truncated]"
	}
	switch typed := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range typed {
			if secretKey(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = redactValue(item, depth+1)
		}
		return out
	case []any:
		if len(typed) > 40 {
			typed = typed[:40]
		}
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = redactValue(item, depth+1)
		}
		return out
	case string:
		cleaned := redactText(typed)
		if len(cleaned) > 2000 {
			return fmt.Sprintf("[%d characters]", len(cleaned))
		}
		return cleaned
	default:
		return value
	}
}

func secretKey(key string) bool {
	folded := strings.ToLower(key)
	for _, word := range []string{"token", "secret", "password", "authorization", "cookie", "key"} {
		if strings.Contains(folded, word) {
			return true
		}
	}
	return false
}

func clip(value string, max int) string {
	one := strings.Join(strings.Fields(value), " ")
	if len(one) <= max {
		return one
	}
	return one[:max-1] + "…"
}
