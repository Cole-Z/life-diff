package proxy

import "strings"

type effect string

const (
	effectRead    effect = "read"
	effectWrite   effect = "write"
	effectUnknown effect = "unknown"
)

type tone string

const (
	toneAdded   tone = "added"
	toneChanged tone = "changed"
	toneRemoved tone = "removed"
	toneRead    tone = "read"
	toneUnknown tone = "unknown"
)

var writeVerbs = map[string]tone{
	"create": toneAdded,
	"add":    toneAdded,
	"delete": toneRemoved,
	"remove": toneRemoved,
	"send":   toneRemoved,
	"update": toneChanged,
	"move":   toneChanged,
	"write":  toneChanged,
	"post":   toneChanged,
	"edit":   toneChanged,
	"patch":  toneChanged,
}

var readVerbs = map[string]bool{
	"get": true, "list": true, "search": true, "read": true, "fetch": true,
}

func classify(name string) (effect, tone) {
	words := toolWords(name)
	for _, word := range words {
		if tone, ok := writeVerbs[word]; ok {
			return effectWrite, tone
		}
	}
	for _, word := range words {
		if readVerbs[word] {
			return effectRead, toneRead
		}
	}
	return effectUnknown, toneUnknown
}

func toolWords(name string) []string {
	var b strings.Builder
	for i, r := range name {
		if i > 0 && r >= 'A' && r <= 'Z' {
			prev := rune(name[i-1])
			if (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
				b.WriteByte(' ')
			}
		}
		b.WriteRune(r)
	}
	return strings.FieldsFunc(strings.ToLower(b.String()), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9')
	})
}
