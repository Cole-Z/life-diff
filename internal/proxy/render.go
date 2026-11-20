package proxy

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"strings"
)

// Print writes one plain-language line per recorded call.
func Print(w io.Writer, log Log, color bool) {
	fmt.Fprintf(w, "Life Diff action log %s\n", log.ID)
	if len(log.Entries) == 0 {
		fmt.Fprintln(w, "No tool calls were recorded.")
		return
	}
	for _, entry := range log.Entries {
		label := toneLabel(entry)
		line := fmt.Sprintf("%-8s %s  reported by proxy", label, entry.Summary)
		if color {
			line = paint(entry.Tone, line)
		}
		fmt.Fprintln(w, line)
	}
}

func paint(tone, text string) string {
	code := "37"
	switch tone {
	case "created":
		code = "32"
	case "changed":
		code = "33"
	case "removed":
		code = "31"
	case "read":
		code = "90"
	}
	return "\033[" + code + "m" + text + "\033[0m"
}

func toneLabel(entry Entry) string {
	switch entry.Tone {
	case "created":
		return "Added"
	case "changed":
		return "Changed"
	case "removed":
		if entry.Verb == "send" {
			return "Sent"
		}
		return "Deleted"
	case "read":
		return "Read"
	default:
		return "Unknown"
	}
}

// RenderHTML writes a self-contained receipt for the action log.
// Green is added, amber is changed, red is deleted or sent, and gray is read-only.
func RenderHTML(log Log) []byte {
	var b strings.Builder
	b.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Life Diff receipt ` + html.EscapeString(log.ID) + `</title>
<style>
  :root { color-scheme: light dark; --paper:#f3efe6; --ink:#1c1915; --muted:#5c564c; --card:#fffdf8; --line:#e4dccd; --mast:#1e3a32; --mast-ink:#f6f1e7; --added:#0f5c32; --added-bg:#e7f6ec; --removed:#8d1c1c; --removed-bg:#fdeeee; --modified:#6b4300; --modified-bg:#fff6e4; --read:#5c564c; --read-bg:#efeae1; }
  @media (prefers-color-scheme: dark) {
    :root { --paper:#161310; --ink:#f4efe6; --muted:#c2b8a8; --card:#221e1a; --line:#3a332c; --mast:#10241e; --added:#9ddec0; --added-bg:#143226; --removed:#f3b4ae; --removed-bg:#3a1717; --modified:#f0cb86; --modified-bg:#3a2c14; --read:#c2b8a8; --read-bg:#2a251f; }
  }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.5 "Segoe UI", Helvetica, Arial, sans-serif; }
  header { background:var(--mast); color:var(--mast-ink); padding:28px 20px; }
  header p { font-family:Georgia, Palatino, serif; font-size:34px; margin:0; }
  main { max-width:880px; margin:0 auto; padding:24px 20px 64px; }
  article { background:var(--card); border:1px solid var(--line); border-left-width:8px; border-radius:12px; padding:14px 16px; margin:12px 0; }
  .added { border-left-color:var(--added); } .changed { border-left-color:var(--modified); } .removed { border-left-color:var(--removed); } .read, .unknown { border-left-color:var(--read); }
  .badge { display:inline-block; border-radius:999px; padding:3px 10px; font-size:13px; font-weight:650; margin-right:6px; }
  .added .badge { background:var(--added-bg); color:var(--added); }
  .changed .badge { background:var(--modified-bg); color:var(--modified); }
  .removed .badge { background:var(--removed-bg); color:var(--removed); }
  .read .badge, .unknown .badge { background:var(--read-bg); color:var(--read); }
  .tag { color:var(--muted); font-size:13px; }
  h2 { font-family:Georgia, Palatino, serif; }
  pre { white-space:pre-wrap; word-break:break-word; background:var(--read-bg); border-radius:8px; padding:8px; }
</style>
</head>
<body>
<header><p>Life Diff</p></header>
<main>
<p>One receipt of what your agent did. These lines are reported by the proxy. They are not a verified history of the service.</p>
`)
	if len(log.Entries) == 0 {
		b.WriteString("<p>No tool calls were recorded.</p>")
	}
	groups := map[string][]Entry{}
	var order []string
	for _, entry := range log.Entries {
		if _, ok := groups[entry.Upstream]; !ok {
			order = append(order, entry.Upstream)
		}
		groups[entry.Upstream] = append(groups[entry.Upstream], entry)
	}
	for _, name := range order {
		entries := groups[name]
		var writes, reads []Entry
		for _, entry := range entries {
			if entry.Effect == "read" {
				reads = append(reads, entry)
			} else {
				writes = append(writes, entry)
			}
		}
		b.WriteString("<section><h2>" + html.EscapeString(name) + "</h2>")
		b.WriteString("<p class=\"tag\">Reported by proxy</p>")
		if len(writes) == 0 {
			b.WriteString("<p>No changes recorded.</p>")
		}
		for _, entry := range writes {
			b.WriteString(renderEntry(entry))
		}
		if len(reads) > 0 {
			fmt.Fprintf(&b, "<details><summary>%d read-only</summary>", len(reads))
			for _, entry := range reads {
				b.WriteString(renderEntry(entry))
			}
			b.WriteString("</details>")
		}
		b.WriteString("</section>")
	}
	b.WriteString("</main></body></html>\n")
	return []byte(b.String())
}

func renderEntry(entry Entry) string {
	class := entry.Tone
	switch class {
	case "created":
		class = "added"
	case "changed":
		class = "changed"
	case "removed":
		class = "removed"
	case "read":
		class = "read"
	default:
		class = "unknown"
	}
	details, _ := json.MarshalIndent(map[string]any{
		"tool":       entry.Tool,
		"status":     entry.Status,
		"durationMs": entry.DurationMs,
		"arguments":  entry.Arguments,
		"result":     entry.Result,
		"error":      entry.Error,
	}, "", "  ")
	return `<article class="` + class + `"><span class="badge">` + html.EscapeString(toneLabel(entry)) + `</span><span class="tag">Reported by proxy</span><h3>` + html.EscapeString(entry.Summary) + `</h3><details><summary>Details</summary><pre>` + html.EscapeString(string(details)) + `</pre></details></article>`
}
