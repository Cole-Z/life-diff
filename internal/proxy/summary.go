package proxy

import (
	"encoding/json"
	"strings"
)

var targetKeys = []string{"title", "name", "summary", "subject", "query", "q", "text", "message", "path", "url", "id", "prompt"}

func serviceLabel(name string) string {
	parts := strings.FieldsFunc(name, func(r rune) bool {
		return r == '-' || r == '_' || r == ' '
	})
	if len(parts) == 0 {
		return "the service"
	}
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func plainAction(upstream, tool string, args any, ok bool) string {
	service := serviceLabel(upstream)
	target := argumentTarget(args)
	_, kind := classify(tool)
	quoted := ""
	if target != "" {
		encoded, _ := json.Marshal(target)
		quoted = " " + string(encoded)
	}
	if !ok {
		verb := failureVerb(kind, tool)
		if target != "" {
			return "Tried to " + verb + " " + jsonString(target) + " in " + service + ", and " + service + " reported an error."
		}
		return "Tried to " + verb + " something in " + service + ", and " + service + " reported an error."
	}
	switch kind {
	case toneAdded:
		if target == "" {
			return "Created something in " + service + "."
		}
		return "Created" + quoted + " in " + service + "."
	case toneChanged:
		if target == "" {
			return "Changed something in " + service + "."
		}
		return "Changed" + quoted + " in " + service + "."
	case toneRemoved:
		verb := "Deleted"
		if containsWord(tool, "send") {
			verb = "Sent"
		}
		if target == "" {
			return verb + " something in " + service + "."
		}
		return verb + quoted + " in " + service + "."
	case toneRead:
		if target == "" {
			return "Looked something up in " + service + "."
		}
		return "Looked up" + quoted + " in " + service + "."
	default:
		if target == "" {
			return "Used a tool in " + service + "."
		}
		return "Used " + service + " on" + quoted + "."
	}
}

func failureVerb(kind tone, tool string) string {
	switch kind {
	case toneAdded:
		return "create"
	case toneChanged:
		return "change"
	case toneRemoved:
		if containsWord(tool, "send") {
			return "send"
		}
		return "delete"
	case toneRead:
		return "look up"
	default:
		return "use"
	}
}

func containsWord(tool, word string) bool {
	for _, item := range toolWords(tool) {
		if item == word {
			return true
		}
	}
	return false
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return value
	}
	return string(encoded)
}

func argumentTarget(args any) string {
	record, ok := args.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range targetKeys {
		if text, ok := record[key].(string); ok && strings.TrimSpace(text) != "" {
			return clip(strings.TrimSpace(text), 80)
		}
	}
	for _, value := range record {
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return clip(strings.TrimSpace(text), 80)
		}
	}
	return ""
}

func clip(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max-1] + "…"
}
