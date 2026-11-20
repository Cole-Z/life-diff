package proxy

import (
	"regexp"
	"strings"
)

var bearerPattern = regexp.MustCompile(`(?i)bearer\s+\S+`)

func redact(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if secretKey(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = redact(child)
		}
		return out
	case []any:
		limit := len(typed)
		if limit > 40 {
			limit = 40
		}
		out := make([]any, limit)
		for i := 0; i < limit; i++ {
			out[i] = redact(typed[i])
		}
		return out
	case string:
		if len(typed) > 2000 {
			return "[" + itoa(len(typed)) + " characters]"
		}
		return bearerPattern.ReplaceAllString(typed, "Bearer [redacted]")
	default:
		return value
	}
}

func secretKey(key string) bool {
	for _, word := range toolWords(key) {
		switch word {
		case "token", "secret", "password", "authorization", "key":
			return true
		}
		if strings.HasSuffix(word, "token") || strings.HasSuffix(word, "secret") || strings.HasSuffix(word, "password") {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits[i:])
}
