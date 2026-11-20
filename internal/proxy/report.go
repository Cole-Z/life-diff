package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"
)

func LoadLatest(home string) ([]Entry, error) {
	latest, err := os.ReadFile(filepath.Join(home, "actions", "latest"))
	if err != nil {
		return nil, err
	}
	id := strings.TrimSpace(string(latest))
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "..") {
		return nil, fmt.Errorf("action log pointer is empty")
	}
	data, err := os.ReadFile(filepath.Join(home, "actions", id+".jsonl"))
	if err != nil {
		return nil, err
	}
	var entries []Entry
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var entry Entry
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.Tool == "" {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func RenderTerminal(entries []Entry) string {
	var b strings.Builder
	b.WriteString("Reported by proxy\n")
	writes, reads := splitEntries(entries)
	for _, entry := range writes {
		fmt.Fprintf(&b, "%s %s\n", toneWord(entry), entry.Summary)
	}
	if len(reads) > 0 {
		fmt.Fprintf(&b, "%d lookups\n", len(reads))
		for _, entry := range reads {
			fmt.Fprintf(&b, "Read %s\n", entry.Summary)
		}
	}
	return b.String()
}

func RenderHTML(entries []Entry) []byte {
	var b strings.Builder
	b.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Life Diff receipt</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: #f3efe6; --ink: #1c1915; --muted: #5c564c; --card: #fffdf8; --line: #e4dccd;
    --mast: #1e3a32; --mast-ink: #f6f1e7;
    --added: #0f5c32; --added-bg: #e7f6ec;
    --removed: #8d1c1c; --removed-bg: #fdeeee;
    --modified: #6b4300; --modified-bg: #fff6e4;
    --read: #5c564c; --read-bg: #ece7de;
    --neutral: #3f3a33; --neutral-bg: #efeae1;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #161310; --ink: #f4efe6; --muted: #c2b8a8; --card: #221e1a; --line: #3a332c;
      --mast: #10241e; --added: #9ddec0; --added-bg: #143226; --removed: #f3b4ae; --removed-bg: #3a1717;
      --modified: #f0cb86; --modified-bg: #3a2c14; --read: #c2b8a8; --read-bg: #2a251f; --neutral: #f4efe6; --neutral-bg: #2a251f;
    }
  }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 "Segoe UI", Helvetica, Arial, sans-serif; }
  header { background: var(--mast); color: var(--mast-ink); padding: 28px 20px; }
  header p { font-family: Georgia, Palatino, serif; font-size: 34px; margin: 0; }
  main { max-width: 880px; margin: 0 auto; padding: 20px 20px 64px; }
  article { background: var(--card); border: 1px solid var(--line); border-left-width: 8px; border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
  .added { border-left-color: var(--added); } .removed { border-left-color: var(--removed); }
  .modified { border-left-color: var(--modified); } .read { border-left-color: var(--read); } .unknown { border-left-color: var(--neutral); }
  .badge { display: inline-block; border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 650; margin-right: 6px; }
  .badge-added { background: var(--added-bg); color: var(--added); }
  .badge-removed { background: var(--removed-bg); color: var(--removed); }
  .badge-modified { background: var(--modified-bg); color: var(--modified); }
  .badge-read { background: var(--read-bg); color: var(--read); }
  .badge-unknown { background: var(--neutral-bg); color: var(--neutral); }
  .tag { display: inline-block; border-radius: 999px; padding: 3px 10px; font-size: 13px; background: var(--neutral-bg); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--neutral-bg); border-radius: 8px; padding: 8px; }
  .intro { color: var(--muted); }
</style>
</head>
<body>
<header><p>Life Diff</p></header>
<main>
<p class="intro">One receipt of what the agent did. Gray is a lookup. Green, amber, and red are changes. These lines are reported by the proxy, not verified from service history.</p>
`)
	groups := map[string][]Entry{}
	var order []string
	for _, entry := range entries {
		if _, ok := groups[entry.Upstream]; !ok {
			order = append(order, entry.Upstream)
		}
		groups[entry.Upstream] = append(groups[entry.Upstream], entry)
	}
	for _, name := range order {
		items := groups[name]
		writes, reads := splitEntries(items)
		fmt.Fprintf(&b, "<section><h2>%s</h2><p class=\"intro\">Reported by the proxy.</p>", html.EscapeString(serviceLabel(name)))
		if len(writes) == 0 {
			b.WriteString("<p>No changes recorded.</p>")
		}
		for _, entry := range writes {
			b.WriteString(renderEntry(entry))
		}
		if len(reads) > 0 {
			fmt.Fprintf(&b, "<details><summary>%d lookups</summary>", len(reads))
			for _, entry := range reads {
				b.WriteString(renderEntry(entry))
			}
			b.WriteString("</details>")
		}
		b.WriteString("</section>")
	}
	b.WriteString("\n</main>\n</body>\n</html>\n")
	return []byte(b.String())
}

func renderEntry(entry Entry) string {
	class := toneClass(entry.Tone)
	args, _ := json.MarshalIndent(entry.Arguments, "", "  ")
	status := "Finished"
	if !entry.OK {
		status = "Error"
	}
	var b strings.Builder
	fmt.Fprintf(&b, `<article class="%s"><p><span class="badge badge-%s">%s</span> <span class="tag">Reported by proxy</span> <span class="tag">%s</span></p><h3>%s</h3><details><summary>Details</summary><p>%s · %d ms</p>`,
		class, class, html.EscapeString(toneWord(entry)), status, html.EscapeString(entry.Summary), html.EscapeString(entry.Tool), entry.DurationMs)
	if entry.Error != "" {
		fmt.Fprintf(&b, "<p>%s</p>", html.EscapeString(entry.Error))
	}
	if entry.ResultSummary != "" {
		fmt.Fprintf(&b, "<p>%s</p>", html.EscapeString(entry.ResultSummary))
	}
	fmt.Fprintf(&b, "<pre>%s</pre></details></article>", html.EscapeString(string(args)))
	return b.String()
}

func splitEntries(entries []Entry) (writes, reads []Entry) {
	for _, entry := range entries {
		if entry.Tone == string(toneRead) {
			reads = append(reads, entry)
			continue
		}
		writes = append(writes, entry)
	}
	return writes, reads
}

func toneClass(value string) string {
	switch tone(value) {
	case toneAdded:
		return "added"
	case toneChanged:
		return "modified"
	case toneRemoved:
		return "removed"
	case toneRead:
		return "read"
	default:
		return "unknown"
	}
}

func toneWord(entry Entry) string {
	switch tone(entry.Tone) {
	case toneAdded:
		return "Created"
	case toneChanged:
		return "Changed"
	case toneRemoved:
		if containsWord(entry.Tool, "send") {
			return "Sent"
		}
		return "Deleted"
	case toneRead:
		return "Read"
	default:
		return "Unknown"
	}
}
